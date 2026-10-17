import concurrent.futures
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import numpy as np
from fastapi.testclient import TestClient
from server import create_app


class FakeBackend:
    def __init__(self):
        self.batches = []
        self.lock = threading.Lock()

    def align(self, jobs):
        with self.lock:
            self.batches.append(len(jobs))
        time.sleep(.05)
        return [{"id": job["line"]["id"], "text": job["line"]["text"], "words": [{"text": "你", "start": 1, "end": 2}, {"text": "好", "start": 3, "end": 4}]} for job in jobs]


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = {"api_key": "fixture-local-key-never-real", "model_name": "fixture", "temp_dir": self.temp.name}
        self.manifest = {"trackId": "fixture-id", "duration": 12, "lines": [{"id": 0, "text": "你好", "units": ["你", "好"], "start": 1, "end": 7}]}
        self.backend = FakeBackend()
        self.reason = ""
        self.client = TestClient(create_app(self.config, self.backend, monitor=lambda: self.reason))
        self.client.__enter__()
        self.audio = patch("server.read_audio", return_value=np.zeros(16000 * 12, dtype=np.float32))
        self.audio.start()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.audio.stop()
        self.temp.cleanup()

    def post(self, manifest=None, key=None):
        return self.client.post("/v1/alignments", headers={"Authorization": "Bearer " + (key or self.config["api_key"])}, data={"model": "fixture", "alignment": json.dumps(manifest or self.manifest)}, files={"file": ("song.wav", io.BytesIO(b"fixture-wave"), "audio/wav")})

    def test_connection_model_and_auth(self):
        self.assertEqual(self.client.get("/v1/health").status_code, 401)
        headers = {"Authorization": "Bearer " + self.config["api_key"]}
        self.assertEqual(self.client.get("/v1/health", headers=headers).json()["model"], "fixture")
        self.assertEqual(self.client.get("/v1/models", headers=headers).json()["data"][0]["id"], "fixture")
        self.assertEqual(self.post(key="wrong").status_code, 401)
        self.assertEqual(self.backend.batches, [])

    def test_instrumental_gap_and_cleanup(self):
        response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["lines"][0]["words"][-1]["end"], 4)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_pressure_stops_before_decode_or_gpu(self):
        self.reason = "显存不足"
        response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.backend.batches, [])

    def test_invalid_source_and_oversized_interval(self):
        bad = {**self.manifest, "lines": [{**self.manifest["lines"][0], "units": ["错误"]}]}
        self.assertEqual(self.post(bad).status_code, 400)
        long = {**self.manifest, "lines": [{**self.manifest["lines"][0], "start": 20, "end": 120}]}
        self.assertIn("error", self.post(long).json()["lines"][0])
        self.assertEqual(self.backend.batches, [])

    def test_concurrent_requests_use_bounded_microbatches(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.post(), range(2)))
        self.assertTrue(all(response.status_code == 200 for response in responses))
        self.assertTrue(all(1 <= size <= 2 for size in self.backend.batches))
        self.assertEqual(sum(self.backend.batches), 2)


if __name__ == "__main__":
    unittest.main()
