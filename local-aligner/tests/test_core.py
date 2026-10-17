import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from core import decode_predictions, linux_path, pressure_reason, validate_manifest


class CoreTests(unittest.TestCase):
    def test_existing_windows_model_path(self):
        self.assertEqual(linux_path(r"E:\work\model\Qwen3-ForcedAligner-0.6B"), "/mnt/e/work/model/Qwen3-ForcedAligner-0.6B")
        self.assertEqual(linux_path("/opt/model"), "/opt/model")

    def test_original_units_required(self):
        value = {"trackId": "fixture", "lines": [{"id": 0, "text": "你好", "units": ["你", "好"], "start": 1, "end": 7}]}
        self.assertEqual(validate_manifest(value, "fixture")[0]["text"], "你好")
        for patch in ({"units": ["改", "文"]}, {"start": float("nan")}, {"end": .5}, {"units": ["<timestamp>"]}):
            with self.assertRaises(ValueError):
                validate_manifest({"trackId": "fixture", "lines": [{**value["lines"][0], **patch}]}, "fixture")
        with self.assertRaises(ValueError):
            validate_manifest({**value, "lines": value["lines"] * 2}, "fixture")

    def test_actual_bins_preserve_rest_and_instrumental_tail(self):
        words = decode_predictions(["你", "好"], [0, 10, 25, 37], 80, 1, 7)
        self.assertEqual(words, [{"text": "你", "start": 1, "end": 1.8}, {"text": "好", "start": 3, "end": 3.96}])

    def test_invalid_predictions_are_never_uniformly_repaired(self):
        for bins in ([0], [0, 0, 2, 3], [0, 3, 2, 4], [0, 1, 2, 100]):
            with self.assertRaises(ValueError):
                decode_predictions(["你", "好"], bins, 80, 1, 7)

    def test_each_resource_guard(self):
        self.assertEqual(pressure_reason({}, 10000, 20, 4000, 50), "")
        for metrics in ((1000, 20, 4000, 50), (10000, 90, 4000, 50), (10000, 20, 1000, 50), (10000, 20, 4000, 85)):
            self.assertTrue(pressure_reason({}, *metrics))


if __name__ == "__main__":
    unittest.main()
