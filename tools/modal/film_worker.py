"""Fast films on Modal: the same farm worker the free Kaggle session runs, as many copies at once as the film has shots.

Owner, 2026-11-07: "I need to be able to create like at least a 1-minute video in 5 minutes", then chose Modal for speed,
inside his $10-a-month cap, with the default staying free. CHE starts fast mode only when the owner asks for it
("make it fast with Modal") and has said the cost first (server/cloudflare/film_fast.js).

How a fast film runs: CHE's Worker POSTs /film_farm to CHE's Modal app with the film's scoped farm token. The app spawns
`clips` copies of film_clip_worker and `lips` copies of film_lipsync_worker at once (FunctionCall.spawn, one container
each, capped by MAX_CLIP_WORKERS / MAX_LIP_WORKERS). Every copy runs `work_loop`: it asks CHE for the next job of its
kind (/api/film/farm/<film>/next, the routes the Kaggle worker already uses), makes it, uploads the MP4 to /result, and
stops when CHE says done, when its deadline is near, or when it has waited too long without work. So clips and lip
syncs are made in parallel, and CHE's existing checks (a real H.264 MP4 of the right length) still decide what counts.

Everything here except the two model loaders is pure and runs in the unit tests without a GPU or the Modal SDK.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

# The clip model. Lightricks' distilled LTX-Video 0.9.7 (13B), published for diffusers' LTXConditionPipeline. It needs
# far fewer denoising steps than the base model, which is what makes a clip take well under a minute on one GPU.
# Repo id read from Mixpeek's model listing (diffusers:LTXConditionPipeline tag) and Replicate's
# lightricks/ltx-video-0.9.7-distilled page (2026-11-07); huggingface.co itself was not reachable from the build
# container, so the revision is not pinned yet (FILM_CLIP_REVISION stays "main" until the deploy workflow's model
# revision lookup records the commit, as it did for SDXL-Turbo).
FILM_CLIP_MODEL = "Lightricks/LTX-Video-0.9.7-distilled"
FILM_CLIP_REVISION = "main"
FILM_CLIP_STEPS = 8                   # the distilled model's few-step schedule (assumed from its card; not measured yet)
CLIP_W, CLIP_H = 768, 448             # LTX-Video needs both divisible by 32 (768x432 stopped every Kaggle session)
CLIP_MAX_FRAMES = 121                 # 8n+1 frames, about 5 s at 24 fps

# Lip sync: LatentSync 1.5, the same pins as the Kaggle worker (server/cloudflare/film_farm.js), baked into the image.
LATENTSYNC_REPO = "https://github.com/bytedance/LatentSync.git"
LATENTSYNC_COMMIT = "a229c3948406bc2cf6eaf4873e662e70c6a04746"
LATENTSYNC_WEIGHTS = "ByteDance/LatentSync-1.5"
LATENTSYNC_ROOT = "/opt/latentsync"
LATENTSYNC_PY = "/opt/lsenv/bin/python"

FILM_GPU = "L40S"                     # 48 GB holds the 13B clip model in bf16 without CPU offload
MAX_CLIP_WORKERS = 10                 # one container per moving shot, at most this many at once
MAX_LIP_WORKERS = 6
WORKER_TIMEOUT_S = 420                # hard timeout of one container: the most a single copy can ever bill
IDLE_STOP_S = 90                      # a copy that has waited this long with nothing to do stops (CHE may still be drawing)
AGENT = "che-film-farm/1.0 (+modal)"

FILM_RE = r"^film_[a-f0-9]{16}$"
FARM_TOKEN_RE = r"^[a-f0-9]{64}$"
BASE_RE = r"^https://[A-Za-z0-9.-]+(?::\d{2,5})?$"
KEY_RE = r"^[A-Za-z0-9_.:-]{8,96}$"


class FilmArgError(ValueError):
    """A /film_farm request that does not match its schema. The message names the field, never echoes its value."""


def validate_film_farm_args(body, allowed_bases):
    """The /film_farm body: which film, the farm token, how many copies of each kind, and the deadline. Raises FilmArgError."""
    if not isinstance(body, dict):
        raise FilmArgError("body: must be an object")
    allowed = {"idempotency_key", "che_base", "film_id", "farm_token", "clips", "lips", "deadline_s"}
    extra = sorted(k for k in body if k not in allowed)
    if extra:
        raise FilmArgError(f"body: unknown field(s) {', '.join(str(e)[:40] for e in extra[:5])}")
    for name, pattern in (("idempotency_key", KEY_RE), ("che_base", BASE_RE), ("film_id", FILM_RE), ("farm_token", FARM_TOKEN_RE)):
        value = body.get(name)
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise FilmArgError(f"body.{name}: required and must match its pattern")
    if body["che_base"] not in allowed_bases:
        raise FilmArgError("body.che_base: not an allowed CHE host")
    out = {k: body[k] for k in ("idempotency_key", "che_base", "film_id", "farm_token")}
    for name, top in (("clips", MAX_CLIP_WORKERS), ("lips", MAX_LIP_WORKERS)):
        n = body.get(name, 0)
        if not isinstance(n, int) or isinstance(n, bool) or not 0 <= n <= top:
            raise FilmArgError(f"body.{name}: a whole number from 0 to {top}")
        out[name] = n
    if out["clips"] + out["lips"] == 0:
        raise FilmArgError("body: nothing to make (clips and lips are both 0)")
    deadline = body.get("deadline_s")
    if not isinstance(deadline, int) or isinstance(deadline, bool) or not 60 <= deadline <= WORKER_TIMEOUT_S:
        raise FilmArgError(f"body.deadline_s: a whole number from 60 to {WORKER_TIMEOUT_S}")
    out["deadline_s"] = deadline
    return out


def worker_args(args, kind, index):
    """What one spawned copy gets: its kind, its index (for logs only), and the film's routes and token."""
    return {"kind": kind, "index": index, "che_base": args["che_base"], "film_id": args["film_id"], "farm_token": args["farm_token"], "deadline_s": args["deadline_s"]}


def spawn_plan(args):
    """The copies to start: `clips` clip workers then `lips` lip-sync workers. Pure, so the test sees the fan-out."""
    return [worker_args(args, "clip", i) for i in range(args["clips"])] + [worker_args(args, "lipsync", i) for i in range(args["lips"])]


def che_call(base, film_id, token, method, path, body=None, raw=None, timeout=120, opener=urllib.request.urlopen):
    """One call to CHE's farm routes with the film's farm token. JSON in and out, or raw MP4 bytes up."""
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"{base}/api/film/farm/{film_id}{path}", data=data, method=method)
    req.add_header("X-CHE-Farm-Token", token)
    req.add_header("User-Agent", AGENT)
    req.add_header("Content-Type", "video/mp4" if raw is not None else "application/json")
    with opener(req, timeout=timeout) as res:
        text = res.read()
        return json.loads(text) if text[:1] in (b"{", b"[") else {}


def work_loop(kind, che, make, deadline_s, clock=time.monotonic, sleep=time.sleep, idle_stop_s=IDLE_STOP_S, margin_s=45):
    """
    One copy's whole life: ask CHE for a job of `kind`, make it, upload it, repeat. `che(method, path, body=None, raw=None)`
    talks to CHE; `make(job)` returns (mp4_bytes, query) for the upload, or raises (a lip-sync failure is reported to
    /lipfail and the loop goes on; a clip failure stops this copy, and CHE's own checks re-queue the shot).
    Returns {"made": n, "failed": n, "seconds": s, "stopped": why}.
    """
    started = clock()
    made = failed = 0
    idle_since = None
    left = lambda: deadline_s - (clock() - started)
    while True:
        if left() < margin_s:
            return {"made": made, "failed": failed, "seconds": round(clock() - started, 1), "stopped": "deadline"}
        job = che("GET", f"/next?kind={kind}&gpus=1")
        if not job or job.get("done"):
            return {"made": made, "failed": failed, "seconds": round(clock() - started, 1), "stopped": "done"}
        if job.get("wait"):
            idle_since = idle_since if idle_since is not None else clock()
            if clock() - idle_since >= idle_stop_s:
                return {"made": made, "failed": failed, "seconds": round(clock() - started, 1), "stopped": "idle"}
            sleep(min(10, int(job["wait"])))  # short waits: a picture or a clip is about to arrive
            continue
        idle_since = None
        began = clock()
        try:
            data, query = make(job)
        except Exception as error:  # noqa: BLE001 - reported, never swallowed silently
            failed += 1
            if job.get("kind") == "lipsync":
                che("POST", "/lipfail", body={"shot": int(job["shot"]), "error": f"{type(error).__name__}: {str(error)[:260]}"})
                continue
            raise
        took = round(clock() - began, 1)
        che("PUT", f"/result?shot={int(job['shot'])}{query}&seconds={took}", raw=data)
        made += 1


def clip_call_kwargs(job, image):
    """The LTXConditionPipeline call for one clip: the shot's picture as the first-frame condition, at 768x448."""
    frames = min(CLIP_MAX_FRAMES, int(job.get("frames", CLIP_MAX_FRAMES)))
    frames = frames - ((frames - 1) % 8)          # keep 8n+1
    return {
        "prompt": str(job.get("prompt", ""))[:1200],
        "negative_prompt": "worst quality, blurry, distorted, text, watermark",
        "width": CLIP_W, "height": CLIP_H, "num_frames": frames,
        "num_inference_steps": FILM_CLIP_STEPS,
        "guidance_scale": 1.0,
        "decode_timestep": 0.05,
        "image_cond_noise_scale": 0.025,
        "_image": image,
    }


def load_clip_pipeline():
    """The distilled LTX-Video pipeline on the GPU (inside the Modal container only; weights are in the image)."""
    import torch
    from diffusers import LTXConditionPipeline
    pipe = LTXConditionPipeline.from_pretrained(FILM_CLIP_MODEL, revision=FILM_CLIP_REVISION, torch_dtype=torch.bfloat16)
    return pipe.to("cuda")


def make_clip(pipe, job, fetch):
    """One moving clip from the shot's picture: (mp4 bytes, extra query)."""
    import tempfile
    from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXVideoCondition
    from diffusers.utils import export_to_video, load_image
    from PIL import ImageOps
    work = tempfile.mkdtemp()
    fetch(job["image_url"], os.path.join(work, "frame.jpg"))
    image = ImageOps.fit(load_image(os.path.join(work, "frame.jpg")), (CLIP_W, CLIP_H))
    kwargs = clip_call_kwargs(job, image)
    kwargs.pop("_image")
    frames = pipe(conditions=[LTXVideoCondition(image=image, frame_index=0)], **kwargs).frames[0]
    out = os.path.join(work, "clip.mp4")
    export_to_video(frames, out, fps=int(job.get("fps", 24)))
    with open(out, "rb") as f:
        return f.read(), ""


def lipsync_argv(work, root=LATENTSYNC_ROOT, py=LATENTSYNC_PY):
    """LatentSync 1.5's own inference command with DeepCache, as the Kaggle worker runs it."""
    return [py, "-m", "scripts.inference", "--unet_config_path", "configs/unet/stage2.yaml", "--inference_ckpt_path", "checkpoints/latentsync_unet.pt",
            "--inference_steps", "20", "--guidance_scale", "1.5", "--enable_deepcache", "--video_path", os.path.join(work, "face.mp4"),
            "--audio_path", os.path.join(work, "voice.wav"), "--video_out_path", os.path.join(work, "synced.mp4"), "--temp_dir", os.path.join(work, "temp")]


def make_lipsync(job, fetch, ff="ffmpeg", run=subprocess.run):
    """One lip-synced clip: the voice lines at their times, the shot's clip (or picture), LatentSync, then silent H.264."""
    import tempfile
    work = tempfile.mkdtemp()
    at = lambda name: os.path.join(work, name)
    seconds = float(job["seconds"])
    inputs, chains = [], []
    for i, line in enumerate(job["audio"]):
        fetch(line["url"], at(f"line{i}.mp3"))
        inputs += ["-i", at(f"line{i}.mp3")]
        chains.append(f"[{i}:a]adelay={int(float(line['at']) * 1000)}:all=1[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(job["audio"]))) + f"amix=inputs={len(job['audio'])}:normalize=0,apad,atrim=0:{seconds}[voice]"
    run([ff, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(chains + [mix]), "-map", "[voice]", "-ar", "16000", "-ac", "1", at("voice.wav")], check=True)
    if job.get("video_url"):
        fetch(job["video_url"], at("base.mp4"))
        source = ["-stream_loop", "-1", "-i", at("base.mp4")]
    else:
        fetch(job["image_url"], at("base.jpg"))
        source = ["-loop", "1", "-i", at("base.jpg")]
    run([ff, "-y", "-loglevel", "error", *source, "-t", str(seconds), "-r", str(int(job.get("fps", 25))),
         "-vf", f"scale={CLIP_W}:{CLIP_H}:force_original_aspect_ratio=increase,crop={CLIP_W}:{CLIP_H}", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-an", at("face.mp4")], check=True)
    run(lipsync_argv(work), check=True, cwd=LATENTSYNC_ROOT)
    run([ff, "-y", "-loglevel", "error", "-i", at("synced.mp4"), "-t", str(seconds), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", at("lipsync.mp4")], check=True)
    with open(at("lipsync.mp4"), "rb") as f:
        return f.read(), "&kind=lipsync"


def latentsync_image_setup():
    """Image build only: LatentSync at its pinned commit in its own venv (uv venv --seed, so pip exists), plus its weights."""
    subprocess.run(["git", "clone", "-q", LATENTSYNC_REPO, LATENTSYNC_ROOT], check=True)
    subprocess.run(["git", "-C", LATENTSYNC_ROOT, "checkout", "-q", LATENTSYNC_COMMIT], check=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "uv"], check=True)
    subprocess.run([sys.executable, "-m", "uv", "venv", "--seed", "-q", "--python", sys.executable, os.path.dirname(os.path.dirname(LATENTSYNC_PY))], check=True)
    subprocess.run([sys.executable, "-m", "uv", "pip", "install", "-q", "--python", LATENTSYNC_PY, "-r", os.path.join(LATENTSYNC_ROOT, "requirements.txt")], check=True)
    get = "from huggingface_hub import hf_hub_download as d; [d('%s', f, local_dir='checkpoints') for f in ('latentsync_unet.pt', 'whisper/tiny.pt')]" % LATENTSYNC_WEIGHTS
    subprocess.run([LATENTSYNC_PY, "-c", get], check=True, cwd=LATENTSYNC_ROOT)


def clip_image_setup():
    """Image build only: the distilled clip model's weights, so a cold start loads from disk instead of downloading."""
    from huggingface_hub import snapshot_download
    snapshot_download(FILM_CLIP_MODEL, revision=FILM_CLIP_REVISION)
