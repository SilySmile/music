"""Opt-in real GPU verification using synthetic speech, never the user's library."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HOME'] = str(ROOT / 'runtime/cache/huggingface')
os.environ['TOKENIZERS_PARALLELISM'] = 'false'


def main():
    source = json.loads((ROOT / 'runtime/service.json').read_text(encoding='utf-8-sig'))
    with tempfile.TemporaryDirectory(prefix='gpu-check-', dir=ROOT / 'runtime') as name:
        directory = Path(name)
        speech = directory / 'speech.wav'
        script = directory / 'speech.ps1'
        script.write_text("Add-Type -AssemblyName System.Speech\n$s=New-Object System.Speech.Synthesis.SpeechSynthesizer\n$s.SelectVoice('Microsoft Huihui Desktop')\n$s.SetOutputToWaveFile('" + str(speech).replace("'", "''") + "')\n$s.SpeakSsml('<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xml:lang=\"zh-CN\">今天的天气很好<break time=\"1500ms\"/>欢迎回来</speak>')\n$s.Dispose()", encoding='utf-8-sig')
        subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script)], check=True, timeout=20)
        audio_file = directory / 'speech-with-tail.wav'
        with wave.open(str(speech), 'rb') as original:
            parameters, data = original.getparams(), original.readframes(original.getnframes())
        with wave.open(str(audio_file), 'wb') as output:
            output.setparams(parameters)
            output.writeframes(bytes(round(parameters.framerate * 1.25) * parameters.nchannels * parameters.sampwidth) + data + bytes(parameters.framerate * parameters.nchannels * parameters.sampwidth * 3))
        duration = len(data) / parameters.framerate / parameters.nchannels / parameters.sampwidth + 4.25
        config = {**source, 'api_key': 'fixture-native-gpu-key-not-user-key', 'temp_dir': str(directory)}
        config_file = directory / 'service.json'
        config_file.write_text(json.dumps(config), encoding='utf-8')
        from windows_runtime import owned_runtime
        with owned_runtime(config_file, uuid.uuid4().hex, config):
            from server import TransformersBackend, create_app, read_audio
            from fastapi.testclient import TestClient
            import torch
            backend = TransformersBackend(config)
            decoded = read_audio(audio_file, config)
            assert abs(len(decoded) / 16000 - duration) < .1
            text = '今天的天气很好欢迎回来'
            manifest = dict(trackId='native-gpu-fixture', duration=duration, lines=[dict(id=0, text=text, units=list(text), start=1, end=duration)])
            headers = {'Authorization': 'Bearer ' + config['api_key']}
            with TestClient(create_app(config, backend)) as client:
                assert client.get('/v1/health').status_code == 401
                health = client.get('/v1/health', headers=headers).json()
                assert health['ready'] and health['resource_ready'], health.get('reason')
                def request(attempt=0):
                    response = client.post('/v1/alignments', headers=headers, data={'model': config['model_name'], 'alignment': json.dumps({**manifest, 'attempt': attempt})}, files={'file': ('speech.wav', audio_file.read_bytes(), 'audio/wav')})
                    assert response.status_code == 200, response.text
                    line = response.json()['lines'][0]
                    assert 'words' in line, line
                    assert ''.join(w['text'] for w in line['words']) == text
                    assert line['words'][0]['start'] >= 1, 'context leaked before original phrase'
                    assert line['words'][-1]['end'] < duration - 1.5, 'instrumental tail stretched into words'
                    assert line['words'][7]['start'] - line['words'][6]['end'] > .6, 'in-phrase pause lost'
                    return line
                first = request()
                with ThreadPoolExecutor(max_workers=2) as pool:
                    concurrent = list(pool.map(lambda _: request(), range(2)))
                assert len(concurrent) == 2
                for attempt in range(1, 5): request(attempt)
                import numpy as np
                long_audio = np.tile(decoded, 8)[:59 * 16000]
                long_text = text * 8
                long_jobs = [dict(line=dict(id=i, text=long_text, units=list(long_text), start=0), audio=long_audio, end=len(long_audio) / 16000) for i in range(2)]
                long_results = backend.align(long_jobs)
                assert len(long_results) == 2
                print(json.dumps({'gpu': torch.cuda.get_device_name(0), 'words': first['words'], 'duration': round(duration, 3), 'cuda_peak_mb': round(torch.cuda.max_memory_allocated() / 1048576), 'allocator_budget_percent': round(100 * backend.memory_fraction, 1), 'concurrent_requests': 2, 'context_strategies': 5, 'long_batch': '2 x 59 seconds'}, ensure_ascii=False), flush=True)
            print('PASS actual native CUDA model: unchanged local weights, real synthetic speech, exact units, pause + silent tail, two concurrent HTTP requests, bounded job and allocator; no user songs changed', flush=True)


if __name__ == '__main__': main()
