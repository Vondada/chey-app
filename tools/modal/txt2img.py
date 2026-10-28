"""Text-to-image for CHE's Modal GPU path: validated arguments, one SDXL-Turbo call, and a PNG the Worker can save.

The model runs only inside the Modal GPU container (che_modal_app.py imports this module there). Everything here is
pure: it validates the request, builds the diffusers call, and checks the bytes it gets back, so it is tested without a GPU.
"""
import base64
import hashlib
import io

MODEL_ID = "stabilityai/sdxl-turbo"
# A pinned commit of MODEL_ID, set before any deploy. Empty means the Modal function refuses to load the model.
MODEL_REVISION = ""
ALLOWED_SIZES = (512,)
MAX_PROMPT = 500
MAX_STEPS = 4
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

ALLOWED_KEYS = {"prompt", "width", "height", "steps", "seed"}


def validate_txt2img_args(body):
    """The arguments for one picture. Raises ValueError with the reason; unknown keys are refused, not ignored."""
    if not isinstance(body, dict):
        raise ValueError("arguments must be an object")
    unknown = sorted(set(body) - ALLOWED_KEYS)
    if unknown:
        raise ValueError(f"unknown argument: {unknown[0]}")
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt is required")
    prompt = prompt.strip()
    if len(prompt) > MAX_PROMPT:
        raise ValueError(f"prompt is longer than {MAX_PROMPT} characters")
    width = body.get("width", 512)
    height = body.get("height", 512)
    if width not in ALLOWED_SIZES or height not in ALLOWED_SIZES:
        raise ValueError(f"width and height must be one of {list(ALLOWED_SIZES)}")
    steps = body.get("steps", MAX_STEPS)
    if not isinstance(steps, int) or isinstance(steps, bool) or not 1 <= steps <= MAX_STEPS:
        raise ValueError(f"steps must be a whole number from 1 to {MAX_STEPS}")
    seed = body.get("seed", 0)
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**31:
        raise ValueError("seed must be a whole number from 0 to 2147483647")
    return {"prompt": prompt, "width": width, "height": height, "steps": steps, "seed": seed}


def pipeline_kwargs(args):
    """The keyword arguments for the diffusers pipeline call. SDXL-Turbo takes no guidance (guidance_scale 0)."""
    return {
        "prompt": args["prompt"],
        "width": args["width"],
        "height": args["height"],
        "num_inference_steps": args["steps"],
        "guidance_scale": 0.0,
    }


def check_png(data):
    """The bytes are a PNG (checked by signature, not by what the engine said). Returns the SHA-256 for the receipt."""
    if not isinstance(data, (bytes, bytearray)) or not bytes(data).startswith(PNG_SIGNATURE):
        raise ValueError("the image is not a PNG")
    return hashlib.sha256(bytes(data)).hexdigest()


def image_to_png_bytes(image):
    """A PIL image (or anything with save) as PNG bytes."""
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def result_receipt(args, png, gpu_seconds, gpu_name):
    """What the Worker records: the picture as base64, its hash, and what was run. No secret is ever in here."""
    digest = check_png(png)
    return {
        "ok": True,
        "model": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "width": args["width"],
        "height": args["height"],
        "steps": args["steps"],
        "seed": args["seed"],
        "png_base64": base64.b64encode(bytes(png)).decode("ascii"),
        "png_sha256": digest,
        "gpu": gpu_name,
        "gpu_seconds": round(float(gpu_seconds), 1),
    }
