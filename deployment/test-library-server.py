import base64
import hashlib
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("library_server", os.path.join(os.path.dirname(__file__), "library-server.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="xq-cloud-test-")
        self.auth = os.path.join(self.directory.name, "auth.json")
        with open(self.auth, "w") as stream:
            json.dump({"writers": [hashlib.sha256(b"writer-token-for-tests-only").hexdigest()], "readers": [hashlib.sha256(b"reader-token-for-tests-only").hexdigest()]}, stream)
        self.library = module.Library(os.path.join(self.directory.name, "data"), self.auth)
        self.content = b"music-byte-fixture" * 100
        self.identifier = hashlib.sha256(self.content).hexdigest()
        self.value = {"metadata": {"id": self.identifier, "title": "Song", "artist": "Artist", "album": "Album", "format": "wav", "duration": 1, "lyrics": [{"time": 0, "text": "Light", "translation": "光"}], "apiKey": "never-save"}, "audio": {"size": len(self.content), "type": "audio/wav", "sha256": self.identifier}, "expectedRevision": 0}

    def tearDown(self):
        self.directory.cleanup()

    def call(self, method, path, body=None, query=None):
        return self.library.dispatch(method, path, query or {}, body or {}, True)

    def upload(self):
        task = self.call("POST", "/uploads", self.value)
        self.call("POST", "/uploads/" + task["id"] + "/chunk", {"kind": "audio", "offset": 0, "data": base64.b64encode(self.content).decode()})
        return task

    def test_auth_permissions_and_token_hashes(self):
        self.assertTrue(self.library.authorize("Bearer writer-token-for-tests-only", True))
        self.assertFalse(self.library.authorize("Bearer reader-token-for-tests-only"))
        for header, write, code in ((None, False, 401), ("Bearer wrong-token-for-tests-only", False, 401), ("Bearer reader-token-for-tests-only", True, 403)):
            with self.assertRaises(module.ApiError) as error:
                self.library.authorize(header, write)
            self.assertEqual(error.exception.status, code)

    def test_resume_atomic_visibility_bilingual_persistence_and_deduplication(self):
        task = self.call("POST", "/uploads", self.value)
        self.assertEqual(self.call("GET", "/tracks")["total"], 0)
        first = self.content[:100]
        self.call("POST", "/uploads/" + task["id"] + "/chunk", {"kind": "audio", "offset": 0, "data": base64.b64encode(first).decode()})
        restored = module.Library(self.library.directory, self.auth)
        self.assertEqual(restored.dispatch("GET", "/uploads/" + task["id"], {}, {}, True)["offsets"]["audio"], 100)
        self.call("POST", "/uploads/" + task["id"] + "/chunk", {"kind": "audio", "offset": 100, "data": base64.b64encode(self.content[100:]).decode()})
        record = self.call("POST", "/uploads/" + task["id"] + "/finish")
        self.assertEqual(record["metadata"]["lyrics"][0]["translation"], "光")
        self.assertNotIn("apiKey", record["metadata"])
        self.assertEqual(self.call("POST", "/uploads/" + task["id"] + "/finish"), record)
        self.value["expectedRevision"] = 1
        second = self.call("POST", "/uploads", self.value)
        self.assertEqual(second["offsets"]["audio"], len(self.content))
        self.assertEqual(self.call("POST", "/uploads/" + second["id"] + "/finish")["revision"], 2)
        with self.library.connection() as database:
            self.assertEqual(database.execute("SELECT COUNT(*) FROM history").fetchone()[0], 2)
        media = self.call("GET", "/tracks/" + self.identifier + "/media/audio", query={"offset": ["2"], "length": ["5"]})
        self.assertEqual(base64.b64decode(media["data"]), self.content[2:7])

    def test_conflicts_incomplete_and_tampered_audio_never_replace_committed_song(self):
        first = self.upload()
        rival = self.call("POST", "/uploads", self.value)
        self.call("POST", "/uploads/" + first["id"] + "/finish")
        with self.assertRaises(module.ApiError) as conflict:
            self.call("POST", "/uploads/" + rival["id"] + "/finish")
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(self.library.track(self.identifier)["revision"], 1)
        other = dict(self.value, expectedRevision=1, audio=dict(self.value["audio"], sha256="a" * 64))
        with self.assertRaises(module.ApiError):
            self.call("POST", "/uploads", other)
        self.value["expectedRevision"] = 1
        os.unlink(self.library.blob(self.identifier))
        task = self.call("POST", "/uploads", self.value)
        with self.assertRaises(module.ApiError):
            self.call("POST", "/uploads/" + task["id"] + "/finish")
        self.call("POST", "/uploads/" + task["id"] + "/chunk", {"kind": "audio", "offset": 0, "data": base64.b64encode(b"x" * len(self.content)).decode()})
        with self.assertRaises(module.ApiError) as tampered:
            self.call("POST", "/uploads/" + task["id"] + "/finish")
        self.assertEqual(tampered.exception.status, 422)
        self.assertEqual(self.library.track(self.identifier)["revision"], 1)

    def test_path_traversal_and_invalid_offsets_are_rejected(self):
        for value in ("../secret", "/etc/passwd", "a" * 63):
            with self.assertRaises(module.ApiError):
                self.library.blob(value)
        task = self.call("POST", "/uploads", self.value)
        for offset in (True, -1, 2.5, 9007199254740992):
            with self.assertRaises(module.ApiError):
                self.call("POST", "/uploads/" + task["id"] + "/chunk", {"kind": "audio", "offset": offset, "data": "YQ=="})

    def test_verification_detects_same_size_corruption_and_allows_verified_repair(self):
        task = self.upload()
        self.call("POST", "/uploads/" + task["id"] + "/finish")
        route = "/tracks/" + self.identifier + "/verify"
        self.assertTrue(self.call("GET", route)["ok"])
        self.assertTrue(self.call("GET", route)["ok"])
        with open(self.library.blob(self.identifier), "wb") as stream:
            stream.write(b"x" * len(self.content))
        self.assertFalse(self.call("GET", route)["ok"])
        self.value["expectedRevision"] = 1
        repair = self.call("POST", "/uploads", self.value)
        self.assertEqual(repair["offsets"]["audio"], 0)
        self.call("POST", "/uploads/" + repair["id"] + "/chunk", {"kind": "audio", "offset": 0, "data": base64.b64encode(self.content).decode()})
        self.call("POST", "/uploads/" + repair["id"] + "/finish")
        self.assertTrue(self.call("GET", route)["ok"])
        os.unlink(self.library.blob(self.identifier))
        self.assertFalse(self.call("GET", route)["ok"])

    def test_supplement_keeps_online_lyrics_when_local_source_is_missing(self):
        task = self.upload()
        self.call("POST", "/uploads/" + task["id"] + "/finish")
        self.value["metadata"]["lyrics"] = []
        self.value["expectedRevision"] = 1
        second = self.call("POST", "/uploads", self.value)
        record = self.call("POST", "/uploads/" + second["id"] + "/finish")
        self.assertEqual(record["metadata"]["lyrics"][0]["translation"], "光")
        self.value["metadata"]["lyrics"] = [{"time": 0, "text": "Light"}]
        self.value["expectedRevision"] = 2
        third = self.call("POST", "/uploads", self.value)
        record = self.call("POST", "/uploads/" + third["id"] + "/finish")
        self.assertEqual(record["metadata"]["lyrics"][0]["translation"], "光")

    def test_real_http_auth_upload_and_restart_read(self):
        server = module.Server(("127.0.0.1", 0), module.Handler)
        server.library = self.library
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = "http://127.0.0.1:" + str(server.server_port)
        try:
            with self.assertRaises(HTTPError) as unauthorized:
                urlopen(base + "/info")
            self.assertEqual(unauthorized.exception.code, 401)
            request = Request(base + "/info", headers={"Authorization": "Bearer reader-token-for-tests-only"})
            with urlopen(request) as response:
                self.assertFalse(json.load(response)["canWrite"])
            data = json.dumps(self.value).encode()
            request = Request(base + "/uploads", data=data, headers={"Authorization": "Bearer writer-token-for-tests-only", "Content-Type": "application/json"})
            with urlopen(request) as response:
                self.assertIn("id", json.load(response))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
