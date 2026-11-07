"""Fast films on Modal (tools/modal/film_worker.py): argument checks, the fan-out plan and the farm loop, without a GPU.

Run: python3 -m unittest discover -s tools -p 'test_*modal*.py' (the CHE Modal deploy workflow runs it before deploying).
"""
import importlib.util
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("film_worker", os.path.join(HERE, "modal", "film_worker.py"))
fw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fw)

BASE = "https://chey-app.henryjavoni.workers.dev"
GOOD = {"idempotency_key": "film-film_0123456789abcdef-modal-1", "che_base": BASE, "film_id": "film_0123456789abcdef", "farm_token": "a" * 64, "clips": 10, "lips": 6, "deadline_s": 420}


class Args(unittest.TestCase):
    def test_a_good_request_is_kept_exactly(self):
        self.assertEqual(fw.validate_film_farm_args(dict(GOOD), [BASE]), GOOD)

    def test_refusals_name_the_field_and_never_echo_the_value(self):
        cases = [({**GOOD, "che_base": "https://evil.example"}, "che_base"), ({**GOOD, "farm_token": "x"}, "farm_token"),
                 ({**GOOD, "clips": 11}, "clips"), ({**GOOD, "lips": 7}, "lips"), ({**GOOD, "clips": 0, "lips": 0}, "nothing to make"),
                 ({**GOOD, "deadline_s": 3600}, "deadline_s"), ({**GOOD, "shell": "rm -rf"}, "unknown field"), ({**GOOD, "clips": True}, "clips")]
        for body, word in cases:
            with self.assertRaises(fw.FilmArgError) as e:
                fw.validate_film_farm_args(body, [BASE])
            self.assertIn(word, str(e.exception))
            self.assertNotIn("evil", str(e.exception))

    def test_every_shot_gets_its_own_container_at_once(self):
        plan = fw.spawn_plan(fw.validate_film_farm_args(dict(GOOD), [BASE]))
        self.assertEqual([p["kind"] for p in plan], ["clip"] * 10 + ["lipsync"] * 6)
        self.assertTrue(all(p["farm_token"] == GOOD["farm_token"] and p["film_id"] == GOOD["film_id"] for p in plan))


class Loop(unittest.TestCase):
    def run_loop(self, jobs, make, kind="clip", deadline=420):
        calls = []
        queue = list(jobs)
        def che(method, path, body=None, raw=None):
            calls.append((method, path, body, len(raw) if raw else None))
            if method == "GET":
                return queue.pop(0) if queue else {"done": True}
            return {"ok": True}
        t = [0.0]
        out = fw.work_loop(kind, che, make, deadline, clock=lambda: t[0], sleep=lambda s: t.__setitem__(0, t[0] + s))
        return out, calls

    def test_claims_makes_and_uploads_until_che_says_done(self):
        out, calls = self.run_loop([{"shot": 1}, {"shot": 2}], lambda job: (b"mp4" * 10, ""))
        self.assertEqual(out["made"], 2)
        self.assertEqual(out["stopped"], "done")
        puts = [c for c in calls if c[0] == "PUT"]
        self.assertEqual([c[1].split("&")[0] for c in puts], ["/result?shot=1", "/result?shot=2"])

    def test_a_failed_lip_sync_is_reported_and_the_loop_goes_on(self):
        def make(job):
            if job["shot"] == 3:
                raise RuntimeError("face not found")
            return b"x", "&kind=lipsync"
        out, calls = self.run_loop([{"shot": 3, "kind": "lipsync"}, {"shot": 4, "kind": "lipsync"}], make, kind="lipsync")
        self.assertEqual((out["made"], out["failed"]), (1, 1))
        fail = [c for c in calls if c[1] == "/lipfail"][0]
        self.assertEqual(fail[2]["shot"], 3)
        self.assertIn("face not found", fail[2]["error"])

    def test_waiting_is_short_and_a_copy_with_nothing_to_do_stops_instead_of_billing(self):
        out, calls = self.run_loop([{"wait": 30}] * 50, lambda job: (b"", ""))
        self.assertEqual(out["stopped"], "idle")
        self.assertLessEqual(len([c for c in calls if c[0] == "GET"]), 12)

    def test_the_deadline_stops_a_copy_before_its_hard_timeout(self):
        out, _ = self.run_loop([{"shot": 1}], lambda job: (b"", ""), deadline=30)
        self.assertEqual(out["stopped"], "deadline")


class Clip(unittest.TestCase):
    def test_the_clip_call_uses_a_size_ltx_accepts_and_8n_plus_1_frames(self):
        kw = fw.clip_call_kwargs({"prompt": "Nova laughs", "frames": 100}, image=None)
        self.assertEqual((kw["width"] % 32, kw["height"] % 32), (0, 0))
        self.assertEqual((kw["num_frames"] - 1) % 8, 0)
        self.assertLessEqual(kw["num_frames"], fw.CLIP_MAX_FRAMES)
        self.assertEqual(kw["num_inference_steps"], fw.FILM_CLIP_STEPS)

    def test_lip_sync_pins_match_the_kaggle_worker(self):
        js = open(os.path.join(HERE, "..", "server", "cloudflare", "film_farm.js")).read()
        for name in ("LATENTSYNC_REPO", "LATENTSYNC_COMMIT", "LATENTSYNC_WEIGHTS"):
            self.assertIn(f'{name} = "{getattr(fw, name)}"', js)

    def test_the_app_and_the_worker_agree_on_limits(self):
        app = open(os.path.join(HERE, "modal", "che_modal_app.py")).read()
        self.assertEqual(int(re.search(r"FILM_WORKER_TIMEOUT_S = (\d+)", app).group(1)), fw.WORKER_TIMEOUT_S)
        self.assertEqual(int(re.search(r"FILM_MAX_CLIP_WORKERS = (\d+)", app).group(1)), fw.MAX_CLIP_WORKERS)
        self.assertEqual(int(re.search(r"FILM_MAX_LIP_WORKERS = (\d+)", app).group(1)), fw.MAX_LIP_WORKERS)
        self.assertEqual(re.search(r'FILM_GPU = "([^"]+)"', app).group(1), fw.FILM_GPU)
        js = open(os.path.join(HERE, "..", "server", "cloudflare", "film_fast.js")).read()
        self.assertIn(f"FILM_WORKER_TIMEOUT_S = {fw.WORKER_TIMEOUT_S};", js)
        self.assertIn(f"FILM_MODAL_GPU = '{fw.FILM_GPU}';", js)


if __name__ == "__main__":
    unittest.main()
