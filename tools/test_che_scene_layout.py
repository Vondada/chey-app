"""Scene Director touch edits (offset, scale) become positions and heights the renderer draws."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import che_scene_layout as layout  # noqa: E402

SPEC = {
    "seats": {"owner": [0.55, 0.3, 0], "guest": [-0.55, 0.3, 0]},
    "actors": [{"id": "nova", "start": [-4.4, 0.4, -90], "offset": [-0.5, 0], "scale": 1.15}],
    "timeline": [
        {"actor": "nova", "action": "walk", "to": [-0.55, 0.3], "t0": 0, "t1": 3.5},
        {"actor": "nova", "action": "sit", "seat": "guest", "t0": 3.5, "t1": 5},
        {"actor": "nova", "action": "talk", "line": "Hi", "t0": 5, "t1": 8},
    ],
}


class Layout(unittest.TestCase):
    def test_offset_moves_her_path_and_her_chair_not_the_door(self):
        out = layout.apply_layout(SPEC)
        self.assertEqual(out["timeline"][0]["to"], [-1.05, 0.3])
        self.assertEqual(out["seats"]["guest"], [-1.05, 0.3, 0], "the chair she sits in moves with her")
        self.assertEqual(out["seats"]["owner"], [0.55, 0.3, 0], "the owner's chair stays")
        self.assertEqual(out["actors"][0]["start"], [-4.4, 0.4, -90], "she still walks in through the door")
        self.assertEqual(SPEC["seats"]["guest"], [-0.55, 0.3, 0], "the input spec is not changed")

    def test_scale_sets_her_height_within_bounds(self):
        self.assertAlmostEqual(layout.apply_layout(SPEC)["actors"][0]["height"], 1.62 * 1.15, places=3)
        huge = {**SPEC, "actors": [{"id": "nova", "start": [0, 0, 0], "scale": 9, "offset": [9, -9]}]}
        out = layout.apply_layout(huge)
        self.assertAlmostEqual(out["actors"][0]["height"], 1.62 * 1.6, places=3)
        self.assertEqual(out["timeline"][0]["to"], [-0.55 + 1.5, 0.3 - 1.5])

    def test_no_edits_no_change(self):
        plain = {**SPEC, "actors": [{"id": "nova", "start": [0, 0, 0]}]}
        out = layout.apply_layout(plain)
        self.assertEqual(out["timeline"], plain["timeline"])
        self.assertEqual(out["actors"][0]["height"], 1.62)


if __name__ == "__main__":
    unittest.main()
