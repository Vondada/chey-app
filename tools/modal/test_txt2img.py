# The Modal text-to-image request: validation refuses what it should, the pipeline call is SDXL-Turbo's, and only a real PNG is
# accepted. No GPU and no model download: this tests the pure functions that run in the container.
import base64
import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import txt2img as t  # noqa: E402

PNG = t.PNG_SIGNATURE + b"\x00\x00\x00\rIHDR-test-bytes"


class Validation(unittest.TestCase):
    def test_a_minimal_request_gets_the_defaults(self):
        args = t.validate_txt2img_args({"prompt": "  a red kite over a field  "})
        self.assertEqual(args, {"prompt": "a red kite over a field", "width": 512, "height": 512, "steps": 4, "seed": 0})

    def test_unknown_arguments_are_refused_not_ignored(self):
        with self.assertRaisesRegex(ValueError, "unknown argument: guidance"):
            t.validate_txt2img_args({"prompt": "a kite", "guidance": 7})

    def test_the_prompt_is_required_and_bounded(self):
        for bad in ({}, {"prompt": ""}, {"prompt": "   "}, {"prompt": 5}):
            with self.assertRaises(ValueError, msg=str(bad)):
                t.validate_txt2img_args(bad)
        with self.assertRaisesRegex(ValueError, "longer than 500"):
            t.validate_txt2img_args({"prompt": "x" * 501})

    def test_only_the_supported_sizes_and_steps_are_accepted(self):
        with self.assertRaises(ValueError):
            t.validate_txt2img_args({"prompt": "a", "width": 1024})
        with self.assertRaises(ValueError):
            t.validate_txt2img_args({"prompt": "a", "width": 384, "height": 384})
        self.assertEqual(t.validate_txt2img_args({"prompt": "a", "width": 256, "height": 256})["width"], 256)
        with self.assertRaises(ValueError):
            t.validate_txt2img_args({"prompt": "a", "steps": 0})
        with self.assertRaises(ValueError):
            t.validate_txt2img_args({"prompt": "a", "steps": 5})
        with self.assertRaises(ValueError):
            t.validate_txt2img_args({"prompt": "a", "steps": True})

    def test_the_seed_is_a_non_negative_whole_number(self):
        for bad in (-1, 2**31, 1.5, "7", True):
            with self.assertRaises(ValueError, msg=str(bad)):
                t.validate_txt2img_args({"prompt": "a", "seed": bad})

    def test_a_body_that_is_not_an_object_is_refused(self):
        with self.assertRaises(ValueError):
            t.validate_txt2img_args(["prompt"])


class PipelineCall(unittest.TestCase):
    def test_sdxl_turbo_gets_no_guidance_and_the_requested_steps(self):
        kwargs = t.pipeline_kwargs(t.validate_txt2img_args({"prompt": "a lighthouse", "steps": 2, "seed": 9}))
        self.assertEqual(kwargs, {"prompt": "a lighthouse", "width": 512, "height": 512, "num_inference_steps": 2, "guidance_scale": 0.0})

    def test_the_model_id_is_the_sdxl_turbo_repository(self):
        self.assertEqual(t.MODEL_ID, "stabilityai/sdxl-turbo")


class Result(unittest.TestCase):
    def test_only_a_real_png_is_accepted_and_hashed(self):
        self.assertEqual(t.check_png(PNG), hashlib.sha256(PNG).hexdigest())
        with self.assertRaisesRegex(ValueError, "not a PNG"):
            t.check_png(b"<html>not a picture</html>")
        with self.assertRaisesRegex(ValueError, "not a PNG"):
            t.check_png("text")

    def test_the_receipt_carries_the_picture_and_what_ran_and_no_secret(self):
        args = t.validate_txt2img_args({"prompt": "a kite", "steps": 4, "seed": 3})
        receipt = t.result_receipt(args, PNG, 12.34, "Tesla T4")
        self.assertEqual(base64.b64decode(receipt["png_base64"]), PNG)
        self.assertEqual(receipt["png_sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertEqual(receipt["model"], "stabilityai/sdxl-turbo")
        self.assertEqual(receipt["gpu"], "Tesla T4")
        self.assertEqual(receipt["gpu_seconds"], 12.3)
        self.assertNotIn("token", str(receipt).lower())

    def test_a_non_png_never_becomes_a_receipt(self):
        args = t.validate_txt2img_args({"prompt": "a kite"})
        with self.assertRaises(ValueError):
            t.result_receipt(args, b"not an image", 1.0, "T4")


if __name__ == "__main__":
    unittest.main()
