"""Real native process lifecycle against an isolated HTTP fixture, never a GPU."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

import psutil

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = r'''
import argparse, json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from windows_runtime import owned_runtime
p = argparse.ArgumentParser(); p.add_argument('--config'); p.add_argument('--instance'); a = p.parse_args()
c = json.loads(Path(a.config).read_text(encoding='utf-8-sig'))
if c.get('fixture_fail'): raise RuntimeError('fixture load failure')
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.headers.get('Authorization') != 'Bearer ' + c['api_key']: self.send_error(401); return
        value = dict(service='xianqiji-forced-aligner', ready=True, resource_ready=True, active=0, model=c['model_name'])
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps(value).encode())
    def do_POST(self):
        if self.headers.get('Authorization') != 'Bearer ' + c['api_key']: self.send_error(401); return
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}'); server.shutdown()
with owned_runtime(a.config, a.instance, c):
    server = ThreadingHTTPServer(('127.0.0.1', c['port']), Handler)
    timer = threading.Timer(c.get('idle_exit_seconds', 120), server.shutdown); timer.daemon=True; timer.start()
    try: server.serve_forever(poll_interval=.1)
    finally: server.server_close(); timer.cancel()
'''


@unittest.skipUnless(os.name == 'nt', 'Windows process lifecycle')
class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='native-launcher-', dir=ROOT / 'runtime')) / '部署 with spaces'
        (self.directory / 'scripts').mkdir(parents=True)
        (self.directory / 'src').mkdir()
        self.manager = self.directory / 'scripts/manager.ps1'
        source = (ROOT / 'scripts/manager.ps1').read_text(encoding='utf-8-sig')
        source = source.replace("$taskPython = Join-Path $taskRuntime 'native-env/Scripts/python.exe'", "$taskPython = '" + sys.executable.replace("'", "''") + "'")
        source = source.replace('$availableMB = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024', '$availableMB = 32768')
        source = source.replace('$gpu = & nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits', "$LASTEXITCODE=0; $gpu='8192,8192'")
        self.manager.write_text(source, encoding='utf-8-sig')
        (self.directory / 'src/server.py').write_text(FIXTURE, encoding='utf-8')
        shutil.copyfile(ROOT / 'src/windows_runtime.py', self.directory / 'src/windows_runtime.py')
        config = json.loads((ROOT / 'config.example.json').read_text(encoding='utf-8-sig'))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); config['port'] = sock.getsockname()[1]
        (self.directory / 'config.example.json').write_text(json.dumps(config), encoding='utf-8')
        self.run_manager('Configure')
        self.config_file = self.directory / 'runtime/service.json'
        self.state_file = self.directory / 'runtime/service-process.json'
        self.config = json.loads(self.config_file.read_text(encoding='utf-8'))

    def run_manager(self, action, code=0):
        # Use files: Windows descendants can retain anonymous PIPE handles after
        # the PowerShell launcher exits, making communicate() wait for the model.
        output = self.directory / ('manager-' + action + '.log')
        with output.open('wb') as log:
            result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(self.manager), '-Action', action], stdout=log, stderr=log, timeout=22)
        self.assertEqual(result.returncode, code, output.read_text(errors='replace'))
        return result

    def tearDown(self):
        self.run_manager('Stop')

    def test_stable_keys_detached_start_duplicate_and_owned_stop(self):
        self.run_manager('Configure')
        refreshed = json.loads(self.config_file.read_text(encoding='utf-8'))
        self.assertEqual(refreshed['api_key'], self.config['api_key'])
        self.assertEqual(Path(refreshed['temp_dir']), self.directory / 'runtime/tmp')
        self.run_manager('Start')
        state = json.loads(self.state_file.read_text())
        self.assertTrue(psutil.pid_exists(state['pid']), 'model must survive closing launcher')
        self.run_manager('Start')
        self.assertEqual(state, json.loads(self.state_file.read_text()))
        self.run_manager('Status')
        # A same-config second server is rejected by the real Windows mutex.
        duplicate = subprocess.run([sys.executable, str(self.directory / 'src/server.py'), '--config', str(self.config_file), '--instance', 'duplicate'], capture_output=True, timeout=8)
        self.assertNotEqual(duplicate.returncode, 0)
        control = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            self.run_manager('Stop')
            self.assertIsNone(control.poll(), 'must not stop unrelated Python')
            self.assertFalse(psutil.pid_exists(state['pid']))
            # Stale/reused PID with the wrong instance must not be terminated.
            self.state_file.write_text(json.dumps(dict(pid=control.pid, created=psutil.Process(control.pid).create_time(), instance='not-owned')))
            self.run_manager('Stop')
            self.assertIsNone(control.poll())
        finally:
            control.terminate(); control.wait(timeout=5)

    def test_idle_exit_cleans_state_and_releases_mutex(self):
        self.config['idle_exit_seconds'] = 5
        self.config_file.write_text(json.dumps(self.config), encoding='utf-8')
        self.run_manager('Start')
        state = json.loads(self.state_file.read_text())
        deadline = time.monotonic() + 9
        while time.monotonic() < deadline and psutil.pid_exists(state['pid']): time.sleep(.1)
        self.assertFalse(psutil.pid_exists(state['pid']))
        self.assertFalse(self.state_file.exists())
        self.run_manager('Start')

    def test_early_model_load_failure_is_reported(self):
        self.config['fixture_fail'] = True
        self.config_file.write_text(json.dumps(self.config), encoding='utf-8')
        self.run_manager('Start', code=1)
        self.assertFalse(self.state_file.exists())


if __name__ == '__main__': unittest.main()
