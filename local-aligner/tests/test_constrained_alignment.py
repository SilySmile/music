import sys
from pathlib import Path
import unittest
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from core import constrained_timestamps, decode_scored_predictions


class ConstrainedAlignmentTests(unittest.TestCase):
    def scores(self, raw, count=80):
        values = np.full((len(raw), count), -20, dtype=np.float32)
        values[np.arange(len(raw)), raw] = 0
        return values

    def test_retains_real_pause_and_tail_in_valid_model_output(self):
        bins = [0, 8, 30, 40]
        words, changed = decode_scored_predictions(['你', '好'], self.scores(bins), bins, 80, 1, 7)
        self.assertFalse(changed)
        self.assertEqual(words[-1]['end'], 4.2)
        self.assertEqual(words[1]['start'], 3.4)

    def test_uses_model_second_choice_to_resolve_crossed_endpoints(self):
        bins = [1, 12, 10, 20]
        values = self.scores(bins)
        values[1, 9] = -.2
        words, changed = decode_scored_predictions(['你', '好'], values, bins, 80, 0, 4)
        self.assertTrue(changed)
        self.assertEqual(words[0]['end'], .72)
        self.assertEqual(words[1]['start'], .8)

    def test_zero_duration_uses_supported_neighbor_bin(self):
        bins = [1, 1, 9, 12]
        values = self.scores(bins)
        values[1, 2] = -.1
        words, changed = decode_scored_predictions(['你', '好'], values, bins, 80, 0, 3)
        self.assertTrue(changed)
        self.assertEqual(words[0]['end'], .16)

    def test_quantized_last_bin_can_end_at_actual_cut_without_stretching(self):
        bins = [0, 8]
        words, changed = decode_scored_predictions(['好'], self.scores(bins), bins, 80, 1, 1.6)
        self.assertTrue(changed)
        self.assertEqual(words[-1]['end'], 1.6)

    def test_rejects_unsupported_or_large_changes_and_out_of_clip_predictions(self):
        for raw, duration in [([10, 1], 4), ([1, 30, 4, 8], 4), ([70, 71], 1)]:
            with self.assertRaises(ValueError):
                constrained_timestamps(self.scores(raw), raw, 80, duration)

    def test_rejects_path_with_low_average_model_support(self):
        values = self.scores([1, 1]); values[1, 2] = -2
        with self.assertRaises(ValueError):
            constrained_timestamps(values, [1, 1], 80, 3)

    def test_rejects_missing_timestamp_pairs_before_constrained_decode(self):
        with self.assertRaisesRegex(ValueError, '标记数'):
            decode_scored_predictions(['你', '好'], self.scores([0, 0]), [0, 0], 80, 1, 7)


if __name__ == '__main__': unittest.main()
