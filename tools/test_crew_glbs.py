"""The crew models as they ship: every crew member (Orion and Vale included) has the shared 31-bone rig, the eleven
original clips plus the Stage 4 clips, viseme mouth shapes and blink as glTF morph targets resting at weight 0, and a
reasonable size. Read from the GLB files themselves; no glTF package needed.

The USDZ check runs Blender's exporter and re-opens the file, so it runs only where the bpy module is installed
(tools/character_pipeline/README.md); CI without bpy skips it and says so.
"""
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "character_pipeline"))
import crew_glb_facts as crew  # noqa: E402

CREW_DIR = ROOT / "assets" / "characters" / "crew"
MAX_BYTES = 3_500_000


class CrewModels(unittest.TestCase):
    def test_every_crew_member_has_a_model_orion_and_vale_included(self):
        self.assertEqual(sorted(p.stem for p in CREW_DIR.glob("*.glb")), sorted(crew.CREW))

    def test_rig_clips_face_shapes_and_size(self):
        for cid in crew.CREW:
            with self.subTest(cid):
                f = crew.facts(CREW_DIR / f"{cid}.glb")
                self.assertEqual(f["bones"], crew.BONES)
                self.assertEqual(sorted(f["clips"]), sorted(crew.CLIPS), "the 11 original clips plus the Stage 4 clips")
                self.assertEqual(f["morphs"].get("mouth"), list(crew.VISEMES), "the mouth carries every viseme, in order")
                for part in ("eye.L", "eye.R", "lash.L", "lash.R"):
                    self.assertEqual(f["morphs"].get(part), [crew.BLINK], part)
                for mesh, weights in f["default_weights"].items():
                    self.assertTrue(all(w == 0 for w in weights), f"{mesh} rests at weight 0, so the face is neutral until driven")
                self.assertLessEqual(f["bytes"], MAX_BYTES)
                self.assertGreater(f["triangles"], 10_000)


@unittest.skipUnless(importlib.util.find_spec("bpy"), "needs Blender's bpy module (pip install bpy==5.0.1 on Python 3.11)")
class Usdz(unittest.TestCase):
    def test_a_crew_glb_converts_to_usdz_that_opens_with_its_rig_and_face_shapes(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "orion.usdz"
            done = subprocess.run([sys.executable, str(ROOT / "tools" / "character_pipeline" / "glb_to_usdz.py"), "--",
                                   str(CREW_DIR / "orion.glb"), str(out)], capture_output=True, text=True, timeout=600)
            self.assertEqual(done.returncode, 0, done.stdout[-2000:] + done.stderr[-2000:])
            line = next(l for l in done.stdout.splitlines() if l.startswith("CHE_USDZ "))
            import json
            got = json.loads(line[len("CHE_USDZ "):])
            self.assertTrue(out.exists() and got["first_entry"].endswith(".usdc"))
            self.assertEqual(got["bones"], crew.BONES)
            for v in crew.VISEMES:
                self.assertIn(v, got["shapes"])


if __name__ == "__main__":
    unittest.main()
