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

            # A line longer than the video is never cut off and called verified.
            spec["timeline"][0]["line"] = "one two three four five six seven eight nine ten eleven twelve"
            (tmp / "spec.json").write_text(json.dumps(spec))
            done = subprocess.run([sys.executable, str(Path(finish.__file__)), "--spec", str(tmp / "spec.json"), "--frames", str(frames),
                                   "--out", str(tmp / "long"), "--voice", "tone"], capture_output=True, text=True)
            self.assertNotEqual(done.returncode, 0)
            manifest = json.loads((tmp / "long" / "manifest.json").read_text())
            self.assertEqual(manifest["status"], "failed")
            self.assertIn("runs past the end", " ".join(manifest["problems"]))


class CrewVoices(unittest.TestCase):
    """Stage 7: each actor speaks with its own free Piper voice and pace (spec.actors[].voice, from crew_voices.js)."""

    SPEC = {
        "actors": [{"id": "nova", "voice": {"engine": "piper", "voice": "en_US-amy-medium", "speed": 1.0}},
                   {"id": "knox", "voice": {"engine": "piper", "voice": "en_US-joe-medium", "speed": 9}},
                   {"id": "evil", "voice": {"engine": "piper", "voice": "../../etc/passwd", "speed": 1}},
                   {"id": "che"}],
        "timeline": [{"actor": "nova", "action": "talk", "line": "Hi", "t0": 0, "t1": 3},
                     {"actor": "knox", "action": "talk", "line": "Morning", "t0": 3, "t1": 6},
                     {"actor": "che", "action": "wave", "t0": 6, "t1": 7}],
    }

    def test_each_actor_gets_its_own_voice_and_a_sane_pace(self):
        self.assertEqual(finish.actor_voice(self.SPEC, "nova"), ("en_US-amy-medium", 1.0))
        self.assertEqual(finish.actor_voice(self.SPEC, "knox"), ("en_US-joe-medium", 1.4), "the pace is clamped")
        self.assertEqual(finish.actor_voice(self.SPEC, "evil"), (finish.VOICE_MODEL, 1.0), "a malformed voice falls back to CHE's")
        self.assertEqual(finish.actor_voice(self.SPEC, "che"), (finish.VOICE_MODEL, 1.0), "an old spec keeps CHE's voice")

    def test_the_workflow_downloads_only_the_voices_that_speak(self):
        self.assertEqual(finish.spec_voices(self.SPEC), ["en_US-amy-medium", "en_US-joe-medium"])
        self.assertEqual(finish.spec_voices({"actors": [], "timeline": []}), [finish.VOICE_MODEL])
        with tempfile.TemporaryDirectory() as d:
            spec = Path(d) / "spec.json"
            spec.write_text(json.dumps(self.SPEC))
            out = subprocess.run([sys.executable, str(Path(finish.__file__)), "--spec", str(spec), "--list-voices"], check=True, capture_output=True, text=True)
            self.assertEqual(out.stdout.split(), ["en_US-amy-medium", "en_US-joe-medium"])

    def test_a_voice_that_was_not_downloaded_falls_back_and_is_recorded(self):
        finish.FALLBACKS.clear()
        calls = []
        real_run, real_duration = finish.run, finish.duration
        finish.run = lambda cmd: calls.append(cmd)
        finish.duration = lambda p: 1.0
        try:
            with tempfile.TemporaryDirectory() as d:
                lines = finish.voice_lines(self.SPEC, Path(d), "piper")
        finally:
            finish.run, finish.duration = real_run, real_duration
        self.assertEqual([c[c.index("-m", 2) + 1] for c in calls], [finish.VOICE_MODEL, finish.VOICE_MODEL], "no .onnx here, so CHE's voice")
        self.assertEqual([c[c.index("--length-scale") + 1] for c in calls], ["1.00", "1.40"])
        self.assertEqual([f["wanted"] for f in finish.FALLBACKS], ["en_US-amy-medium", "en_US-joe-medium"])
        self.assertEqual([l["actor"] for l in lines], ["nova", "knox"])
        finish.FALLBACKS.clear()


if __name__ == "__main__":
    unittest.main()
