"""Scene Director finish step: retiming, voice placement after the retime, and a real ffmpeg encode checked by ffprobe."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import che_scene_finish as finish  # noqa: E402


class Retime(unittest.TestCase):
    def test_slow_last_five_seconds(self):
        parts = finish.spans(11.0, [{"from": 6.0, "to": 11.0, "speed": 0.5}])
        self.assertEqual(parts, [(0.0, 6.0, 1.0), (6.0, 11.0, 0.5)])
        self.assertAlmostEqual(finish.remap_time(11.0, parts), 16.0)
        self.assertAlmostEqual(finish.remap_time(7.0, parts), 8.0, msg="a voice 1 s into the slow part lands 2 s in")

    def test_speeds_are_bounded(self):
        parts = finish.spans(4.0, [{"from": 0, "to": 4, "speed": 100}])
        self.assertEqual(parts[0][2], 4.0)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
class RealEncode(unittest.TestCase):
    def test_frames_to_checked_mp4(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            frames = tmp / "frames"
            frames.mkdir()
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=270x480:rate=24", "-frames:v", "48",
                            str(frames / "frame_%05d.png")], check=True)
            # ffmpeg numbers from 1, as the renderer does.
            spec = {"v": 1, "fps": 24, "seconds": 2, "width": 270, "height": 480,
                    "timeline": [{"actor": "nova", "action": "talk", "t0": 0.5, "t1": 2, "line": "Hi there"}],
                    "time_remap": [{"from": 1, "to": 2, "speed": 0.5}], "audio": {"music": {"kind": "pad", "mood": "warm"}}, "job": "scj_test"}
            (tmp / "spec.json").write_text(json.dumps(spec))
            subprocess.run([sys.executable, str(Path(finish.__file__)), "--spec", str(tmp / "spec.json"), "--frames", str(frames),
                            "--out", str(tmp / "out"), "--voice", "tone"], check=True)
            manifest = json.loads((tmp / "out" / "manifest.json").read_text())
            self.assertEqual(manifest["status"], "verified", manifest["problems"])
            self.assertAlmostEqual(manifest["duration_seconds"], 3.0, delta=0.1)
            self.assertTrue(manifest["music"])
            self.assertAlmostEqual(manifest["voices"][0]["at"], 0.8, delta=0.01)


if __name__ == "__main__":
    unittest.main()
