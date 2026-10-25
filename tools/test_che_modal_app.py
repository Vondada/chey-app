"""Unit tests for tools/modal/che_modal_app.py without the Modal SDK: argument validation (allowlisted fields only,
no code or shell from text), idempotency decisions, the worker argv, and that the pins match compute_pool.js.

  python3 -m unittest discover -s tools -p test_che_modal_app.py
"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "modal"))
import che_modal_app as m  # noqa: E402

BASE = "https://chey-app.henryjavoni.workers.dev"


def good(**over):
    a = {"idempotency_key": "job:gpu_0123456789ab:modal:1", "che_base": BASE, "worker_token": "a" * 64,
         "job_ids": ["gpu_0123456789ab"], "deadline_s": 1800}
    a.update(over)
    return a


class Validation(unittest.TestCase):
    def test_import_works_without_modal(self):
        self.assertEqual(m.APP_NAME, "che-gpu")   # imported above with or without the Modal SDK installed
        self.assertTrue(callable(m.validate_preview_args))

    def test_good_args_pass(self):
        self.assertEqual(m.validate_preview_args(good(), [BASE])["job_ids"], ["gpu_0123456789ab"])

    def test_unknown_fields_are_refused(self):
        for extra in ({"script": "import os; os.system('rm -rf /')"}, {"command": "bash"}, {"blender_args": ["--python-expr", "x"]}):
            with self.assertRaises(m.ArgError):
                m.validate_preview_args(good(**extra), [BASE])

    def test_each_field_is_checked(self):
        bad = [
            {"idempotency_key": "x; rm -rf /"}, {"idempotency_key": "short"},
            {"che_base": "http://chey-app.henryjavoni.workers.dev"}, {"che_base": "https://evil.example"},
            {"che_base": "https://chey-app.henryjavoni.workers.dev/$(id)"},
            {"worker_token": "not-hex"}, {"worker_token": "A" * 64},
            {"job_ids": []}, {"job_ids": ["gpu_0123456789ab"] * 2}, {"job_ids": ["../../etc/passwd"]},
            {"job_ids": [f"gpu_{i:012x}" for i in range(4)]},
            {"deadline_s": 10}, {"deadline_s": 999999}, {"deadline_s": "1800"}, {"deadline_s": True},
        ]
        for over in bad:
            with self.assertRaises(m.ArgError, msg=str(over)):
                m.validate_preview_args(good(**over), [BASE])

    def test_missing_and_non_object(self):
        with self.assertRaises(m.ArgError):
            m.validate_preview_args({k: v for k, v in good().items() if k != "worker_token"}, [BASE])
        with self.assertRaises(m.ArgError):
            m.validate_preview_args("just text", [BASE])

    def test_errors_never_echo_values(self):
        try:
            m.validate_preview_args(good(worker_token="SECRET-" + "z" * 57), [BASE])
        except m.ArgError as e:
            self.assertNotIn("SECRET", str(e))

    def test_key_args(self):
        self.assertEqual(m.validate_key_args({"idempotency_key": "job:gpu_0123456789ab:modal:1"}), "job:gpu_0123456789ab:modal:1")
        for b in ({}, {"idempotency_key": "a b c d e f g h"}, {"idempotency_key": "job:x:modal:1", "more": 1}):
            with self.assertRaises(m.ArgError):
                m.validate_key_args(b)


class Behaviour(unittest.TestCase):
    def test_same_key_never_starts_a_second_call(self):
        self.assertEqual(m.plan_dispatch(None), "new")
        self.assertEqual(m.plan_dispatch({"state": "started", "call_id": "fc-1"}), "existing")
        self.assertEqual(m.plan_dispatch({"state": "done"}), "existing")

    def test_entry_view_has_no_token(self):
        v = m.entry_view("k" * 10, {"state": "done", "call_id": "fc-1", "gpu_seconds": 61.5, "worker_token": "a" * 64, "job_ids": ["gpu_0123456789ab"]})
        self.assertEqual(v["state"], "done")
        self.assertEqual(v["gpu_seconds"], 61.5)
        self.assertNotIn("a" * 64, repr(v))
        self.assertEqual(m.entry_view("k" * 10, None)["state"], "not_found")

    def test_worker_argv_is_fixed(self):
        argv = m.worker_argv(m.validate_preview_args(good(), [BASE]), python="python3")
        self.assertEqual(argv[1], f"{m.ROOT}/repo/scripts/che_gpu_worker.py")
        self.assertIn("--che-url", argv)
        self.assertEqual(argv[argv.index("--che-url") + 1], BASE)
        self.assertNotIn("a" * 64, " ".join(argv), "the token travels in the environment, not argv")
        env = m.worker_env(m.validate_preview_args(good(), [BASE]), base_env={})
        self.assertEqual(env["CHE_GPU_TOKEN"], "a" * 64)

    def test_outcomes(self):
        self.assertEqual(m.outcome_of(0), "done")
        self.assertEqual(m.outcome_of(3), "done")
        self.assertEqual(m.outcome_of(1), "failed")

    def test_pins_match_compute_pool(self):
        js = open(os.path.join(HERE, "..", "server", "cloudflare", "compute_pool.js"), encoding="utf8").read()
        for name, value in [("POOL_COMMIT", m.POOL_COMMIT), ("POOL_ASSETS_COMMIT", m.ASSETS_COMMIT), ("POOL_MPFB_COMMIT", m.MPFB_COMMIT), ("POOL_BLENDER_VERSION", m.BLENDER_VERSION)]:
            got = re.search(rf"export const {name} = '([^']+)'", js).group(1)
            self.assertEqual(got, value, name)
        wf = open(os.path.join(HERE, "..", ".github", "workflows", "che-creation-worker.yml"), encoding="utf8").read()
        self.assertIn(f"MPFB_COMMIT: {m.MPFB_COMMIT}", wf)
        self.assertIn(f"BLENDER_VERSION: '{m.BLENDER_VERSION}'", wf)

    def test_version_matches_worker(self):
        js = open(os.path.join(HERE, "..", "server", "cloudflare", "modal_gpu.js"), encoding="utf8").read()
        self.assertEqual(re.search(r"export const MODAL_APP_VERSION = '([^']+)'", js).group(1), m.APP_VERSION)


if __name__ == "__main__":
    unittest.main()
