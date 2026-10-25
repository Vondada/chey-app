"""CHE's Modal app: two allowlisted web routes on one token-protected endpoint (owner spec
docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md, Stage 2).

What it runs, and nothing else:
  GET  /health           CPU. Returns the app name and APP_VERSION. CHE's Worker calls it to verify the connection.
  POST /blender_preview  Starts ONE GPU (T4) call of `render`, which runs CHE's existing Blender worker
                         (scripts/che_gpu_worker.py at a pinned commit, Blender 5.0.1 checked against blender.org's
                         SHA-256, MPFB2 at the same pinned commit as .github/workflows/che-creation-worker.yml) against
                         CHE's existing GPU queue with a scoped, expiring pool token. The worker uploads the GLB and
                         previews through CHE's own worker routes, which store them in CHE's media store and check the
                         SHA-256 before a job can be COMPLETE. Arguments are JSON-schema validated (PREVIEW_SCHEMA);
                         no user text ever becomes code, a shell command or a file path.
  POST /status           The state of the call for an idempotency key (and its measured GPU seconds when finished).
  POST /cancel           Cancels the call for an idempotency key (CHE does this before handing a job elsewhere).

GPU check (not a web route): the function `gpu_check` renders Blender's default cube once with Cycles on the T4
(256x256, 32 samples, no input) and returns the GPU name, the Cycles device used, render seconds and the PNG's SHA-256.
The deploy workflow calls it by name with the deploy token when asked (input gpu_test), as the low-cost GPU test.

Idempotency: one Modal Dict entry per idempotency key. A second /blender_preview with the same key returns the first
call instead of starting another container, so a retried or duplicated request is billed once.

Security: every route needs `Authorization: Bearer <token>`. The deploy workflow generates a random 256-bit token,
stores it as the Modal secret `che-gpu-auth` and, in the same run, as the Worker secret CHE_MODAL_ENDPOINT_TOKEN
(through the existing CLOUDFLARE_API_TOKEN), so no person ever sees or pastes it. The comparison is constant time and
a missing or empty server token refuses everything. (Modal's proxy-auth tokens would also work, but they are created
by hand in Modal's dashboard; this keeps setup to the two deploy secrets.) Containers scale to zero; SCALEDOWN_S keeps
an idle container for at most a minute, and every GPU call has a hard timeout.

Deploy: .github/workflows/che-modal-deploy.yml (workflow_dispatch, needs MODAL_TOKEN_ID / MODAL_TOKEN_SECRET).
Tests: python3 -m unittest discover -s tools -p test_che_modal_app.py (no `modal` package needed).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

import hmac

AUTH_SECRET_NAME = "che-gpu-auth"
AUTH_ENV = "CHE_GPU_ENDPOINT_TOKEN"


def bearer_ok(header: str | None, expected: str | None) -> bool:
    """True only for `Bearer <expected>` with a non-trivial expected token, compared in constant time."""
    expected = (expected or "").strip()
    if len(expected) < 32 or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[7:].strip().encode(), expected.encode())


try:  # The pure logic below is importable (and tested) without the Modal SDK.
    import modal  # type: ignore
    if not hasattr(modal, "App"):  # tools/ on sys.path makes this folder itself importable as "modal"
        modal = None
except ImportError:  # pragma: no cover - exercised by the unit test environment
    modal = None

APP_NAME = "che-gpu"
APP_VERSION = "che-modal-1"            # server/cloudflare/modal_gpu.js MODAL_APP_VERSION must match
ENDPOINT_LABEL = "che-gpu"             # URL: https://<workspace>--che-gpu.modal.run
GPU = "T4"
MAX_CALL_S = 45 * 60                   # hard timeout of one GPU call
SCALEDOWN_S = 60                       # an idle container stops after a minute (scale to zero)
MAX_JOBS_PER_CALL = 3
DICT_NAME = "che-gpu-jobs"

# Pins: the same ones compute_pool.js and che-creation-worker.yml use (the unit test checks they match).
BLENDER_VERSION = os.environ.get("CHE_BLENDER_VERSION", "5.0.1")
MPFB_COMMIT = os.environ.get("CHE_MPFB_COMMIT", "b1a2dc98776da9d1eea751b159d42cf61778fe2e")
POOL_COMMIT = os.environ.get("CHE_POOL_COMMIT", "afb8de155d3a6a2a892fe7e561c46924bcf7bcbb")
ASSETS_COMMIT = os.environ.get("CHE_ASSETS_COMMIT", "2f64f91edc9c7021e647311a677a5621f2afec94")
REPO = "Vondada/chey-app"
# The only CHE Worker hosts a GPU call may work for (comma-separated, set at deploy time).
ALLOWED_BASES = [b.strip() for b in os.environ.get("CHE_ALLOWED_BASES", "https://chey-app.henryjavoni.workers.dev").split(",") if b.strip()]

ROOT = "/opt/che"
KEY_RE = r"^[A-Za-z0-9_.:-]{8,96}$"
JOB_RE = r"^gpu_[a-f0-9]{12}$"
TOKEN_RE = r"^[a-f0-9]{64}$"
BASE_RE = r"^https://[A-Za-z0-9.-]+(?::\d{2,5})?$"

PREVIEW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["idempotency_key", "che_base", "worker_token", "job_ids", "deadline_s"],
    "properties": {
        "idempotency_key": {"type": "string", "pattern": KEY_RE},
        "che_base": {"type": "string", "pattern": BASE_RE},
        "worker_token": {"type": "string", "pattern": TOKEN_RE},
        "job_ids": {"type": "array", "minItems": 1, "maxItems": MAX_JOBS_PER_CALL, "items": {"type": "string", "pattern": JOB_RE}},
        "deadline_s": {"type": "integer", "minimum": 120, "maximum": MAX_CALL_S},
    },
}
KEY_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["idempotency_key"],
    "properties": {"idempotency_key": {"type": "string", "pattern": KEY_RE}},
}


class ArgError(ValueError):
    """A request that does not match its schema. The message names the field, never echoes its value."""


def _check(value, schema, where):
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            raise ArgError(f"{where}: must be an object")
        props = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                raise ArgError(f"{where}.{name}: required")
        if schema.get("additionalProperties") is False:
            extra = sorted(k for k in value if k not in props)
            if extra:
                raise ArgError(f"{where}: unknown field(s) {', '.join(str(e)[:40] for e in extra[:5])}")
        for name, sub in props.items():
            if name in value:
                _check(value[name], sub, f"{where}.{name}")
    elif kind == "array":
        if not isinstance(value, list):
            raise ArgError(f"{where}: must be a list")
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", 1 << 30):
            raise ArgError(f"{where}: must have {schema.get('minItems', 0)} to {schema.get('maxItems')} items")
        if len(set(map(str, value))) != len(value):
            raise ArgError(f"{where}: items must be unique")
        for i, item in enumerate(value):
            _check(item, schema.get("items", {}), f"{where}[{i}]")
    elif kind == "string":
        if not isinstance(value, str):
            raise ArgError(f"{where}: must be a string")
        if "pattern" in schema and not re.fullmatch(schema["pattern"], value):
            raise ArgError(f"{where}: has the wrong format")
    elif kind == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ArgError(f"{where}: must be an integer")
        if value < schema.get("minimum", -(1 << 62)) or value > schema.get("maximum", 1 << 62):
            raise ArgError(f"{where}: must be between {schema.get('minimum')} and {schema.get('maximum')}")
    return value


def validate_preview_args(body, allowed_bases=None):
    """The /blender_preview body, schema-checked, with che_base on the deploy-time allowlist. Raises ArgError."""
    _check(body, PREVIEW_SCHEMA, "args")
    allowed = ALLOWED_BASES if allowed_bases is None else allowed_bases
    if body["che_base"].rstrip("/") not in [a.rstrip("/") for a in allowed]:
        raise ArgError("args.che_base: not an allowed CHE Worker")
    return {k: body[k] for k in PREVIEW_SCHEMA["properties"]}


def validate_key_args(body):
    _check(body, KEY_SCHEMA, "args")
    return body["idempotency_key"]


def worker_argv(args, python=sys.executable, root=ROOT):
    """The exact argv for CHE's existing worker. Every value comes from the validated args or constants; no shell."""
    return [python, f"{root}/repo/scripts/che_gpu_worker.py", "--worker-class", "colab_t4", "--che-url", args["che_base"].rstrip("/"),
            "--blender", f"{root}/blender/blender", "--project", f"{root}/assets/project", "--out", "/tmp/che-jobs",
            "--poll", "10", "--idle-minutes", "2"]


def worker_env(args, base_env=None, root=ROOT):
    env = dict(os.environ if base_env is None else base_env)
    env.update({"CHE_GPU_TOKEN": args["worker_token"], "MPFB": f"{root}/mpfb2/src/mpfb/data", "CHE_JOB_IDS": ",".join(args["job_ids"])})
    return env


GPU_CHECK_SCRIPT = """
import bpy, time, hashlib, json, sys
prefs = bpy.context.preferences.addons['cycles'].preferences
device = 'NONE'
for kind in ('OPTIX', 'CUDA'):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == kind
            device = kind
            break
    except Exception:
        pass
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'GPU' if device != 'NONE' else 'CPU'
scene.cycles.samples = 32
scene.render.resolution_x = scene.render.resolution_y = 256
scene.render.filepath = '/tmp/che_gpu_check.png'
t = time.time()
bpy.ops.render.render(write_still=True)
secs = round(time.time() - t, 2)
data = open('/tmp/che_gpu_check.png', 'rb').read()
print('CHE_GPU_CHECK ' + json.dumps({'device': device, 'render_seconds': secs, 'png_bytes': len(data), 'png_sha256': hashlib.sha256(data).hexdigest()}))
"""


def gpu_check_argv(root=ROOT):
    """A fixed Cycles render of Blender's default cube on the GPU (no user input reaches it)."""
    return [f"{root}/blender/blender", "-b", "--factory-startup", "--python-expr", GPU_CHECK_SCRIPT]


def parse_gpu_check(stdout: str):
    for line in (stdout or "").splitlines():
        if line.startswith("CHE_GPU_CHECK "):
            try:
                return json.loads(line[len("CHE_GPU_CHECK "):])
            except ValueError:
                return None
    return None


def plan_dispatch(existing):
    """'existing' when the key already has a call (the request is a repeat: never a second container), else 'new'."""
    return "existing" if isinstance(existing, dict) and existing.get("state") not in (None, "") else "new"


def entry_view(key, entry, live_state=None):
    """What /status and /blender_preview answer for a key (no token, no arguments echoed)."""
    if not isinstance(entry, dict):
        return {"ok": True, "idempotency_key": key, "state": "not_found"}
    state = entry.get("state", "unknown")
    if live_state and state in ("started", "running"):
        state = live_state
    out = {"ok": True, "app": APP_NAME, "version": APP_VERSION, "idempotency_key": key, "state": state,
           "call_id": entry.get("call_id"), "job_ids": entry.get("job_ids", []), "started_at": entry.get("started_at"),
           "ended_at": entry.get("ended_at"), "gpu": entry.get("gpu"), "gpu_seconds": entry.get("gpu_seconds"),
           "exit_code": entry.get("exit_code"), "error": str(entry.get("error") or "")[:300]}
    return out


def outcome_of(exit_code):
    # che_gpu_worker.py exits 0 when it worked and went idle, 3 when there was nothing (more) to claim.
    return "done" if exit_code in (0, 3) else "failed"


# ─── The Modal app (only when the SDK is installed: the deploy workflow) ──────────────────────────────────────────
if modal is not None:  # pragma: no cover - runs on Modal, not in unit tests
    def _install():
        """Image build: Blender (SHA-256 checked), CHE's scripts and project files, MPFB2, all at pinned versions."""
        import hashlib
        import shutil
        import tarfile
        import urllib.request

        ua = {"User-Agent": "CHE-modal-image/1.0 (+https://github.com/Vondada/chey-app)"}

        def get(url, dest):
            with urllib.request.urlopen(urllib.request.Request(url, headers=ua), timeout=900) as res, open(dest, "wb") as out:
                shutil.copyfileobj(res, out)

        def untar(path, dest):
            os.makedirs(dest, exist_ok=True)
            with tarfile.open(path) as t:
                for m in t.getmembers():
                    parts = m.name.split("/")[1:]
                    if not parts or ".." in parts or m.name.startswith("/"):
                        continue
                    m.name = "/".join(parts)
                    t.extract(m, dest)

        os.makedirs(ROOT, exist_ok=True)
        name = f"blender-{BLENDER_VERSION}-linux-x64"
        base = f"https://download.blender.org/release/Blender{BLENDER_VERSION.rsplit('.', 1)[0]}"
        get(f"{base}/{name}.tar.xz", "/tmp/blender.tar.xz")
        get(f"{base}/blender-{BLENDER_VERSION}.sha256", "/tmp/blender.sha256")
        want = next((l.split()[0] for l in open("/tmp/blender.sha256") if l.strip().endswith(f"{name}.tar.xz")), "")
        h = hashlib.sha256()
        with open("/tmp/blender.tar.xz", "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if not want or want != h.hexdigest():
            raise SystemExit("BLENDER SHA-256 MISMATCH")
        untar("/tmp/blender.tar.xz", f"{ROOT}/blender")
        for url, dest in [(f"https://codeload.github.com/{REPO}/tar.gz/{POOL_COMMIT}", "repo"),
                          (f"https://codeload.github.com/{REPO}/tar.gz/{ASSETS_COMMIT}", "assets"),
                          (f"https://codeload.github.com/makehumancommunity/mpfb2/tar.gz/{MPFB_COMMIT}", "mpfb2")]:
            get(url, f"/tmp/{dest}.tar.gz")
            untar(f"/tmp/{dest}.tar.gz", f"{ROOT}/{dest}")

    pins = {"CHE_BLENDER_VERSION": BLENDER_VERSION, "CHE_MPFB_COMMIT": MPFB_COMMIT, "CHE_POOL_COMMIT": POOL_COMMIT,
            "CHE_ASSETS_COMMIT": ASSETS_COMMIT, "CHE_ALLOWED_BASES": ",".join(ALLOWED_BASES)}
    web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]==0.115.12").env(pins)
    gpu_image = (modal.Image.debian_slim(python_version="3.11")
                 .apt_install("xz-utils", "ca-certificates", "libxi6", "libxkbcommon0", "libsm6", "libxrender1", "libgl1", "libegl1", "libxxf86vm1", "libxfixes3")
                 .env(pins).run_function(_install))
    app = modal.App(APP_NAME)
    jobs = modal.Dict.from_name(DICT_NAME, create_if_missing=True)

    @app.function(image=gpu_image, gpu=GPU, timeout=MAX_CALL_S, scaledown_window=SCALEDOWN_S, max_containers=1, retries=0)
    def render(args: dict, key: str) -> dict:
        args = validate_preview_args(args)          # validated again inside the GPU container
        started = time.time()
        gpu = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()[:80]
        entry = dict(jobs.get(key) or {})
        entry.update({"state": "running", "gpu": gpu, "running_at": started})
        jobs[key] = entry
        try:
            code = subprocess.run(worker_argv(args), cwd=f"{ROOT}/repo", env=worker_env(args), timeout=max(60, args["deadline_s"] - 30)).returncode
            error = "" if outcome_of(code) == "done" else f"CHE's worker exited with code {code}"
        except subprocess.TimeoutExpired:
            code, error = 124, "the GPU call reached its deadline"
        ended = time.time()
        entry.update({"state": outcome_of(code), "exit_code": code, "error": error, "ended_at": ended, "gpu_seconds": round(ended - started, 1)})
        jobs[key] = entry
        return {"exit_code": code, "gpu_seconds": entry["gpu_seconds"], "gpu": gpu}

    @app.function(image=gpu_image, gpu=GPU, timeout=600, scaledown_window=SCALEDOWN_S, max_containers=1, retries=0)
    def gpu_check() -> dict:
        """The low-cost connection test: one 256x256 Cycles render of the default cube on the T4 (about a minute)."""
        started = time.time()
        gpu = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()[:120]
        r = subprocess.run(gpu_check_argv(), capture_output=True, text=True, timeout=540)
        out = parse_gpu_check(r.stdout) or {}
        return {"ok": r.returncode == 0 and bool(out) and out.get("device") != "NONE", "gpu": gpu, "exit_code": r.returncode,
                "container_seconds": round(time.time() - started, 1), **out}

    @app.function(image=web_image, scaledown_window=SCALEDOWN_S, timeout=60, secrets=[modal.Secret.from_name(AUTH_SECRET_NAME)])
    @modal.asgi_app(label=ENDPOINT_LABEL)
    def api():
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse

        web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

        @web.middleware("http")
        async def require_bearer(request, call_next):
            if not bearer_ok(request.headers.get("authorization"), os.environ.get(AUTH_ENV)):
                return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
            return await call_next(request)

        async def body_of(request):
            try:
                return await request.json()
            except Exception:
                return None

        def bad(e):
            return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=422)

        @web.get("/health")
        def health():
            return {"ok": True, "app": APP_NAME, "version": APP_VERSION, "functions": ["health", "blender_preview"], "gpu": GPU,
                    "blender": BLENDER_VERSION, "mpfb_commit": MPFB_COMMIT, "pool_commit": POOL_COMMIT, "max_call_s": MAX_CALL_S, "scaledown_s": SCALEDOWN_S}

        @web.post("/blender_preview")
        async def blender_preview(request: Request):
            body = await body_of(request)
            try:
                args = validate_preview_args(body)
            except ArgError as e:
                return bad(e)
            key = args["idempotency_key"]
            reserved = {"state": "reserving", "job_ids": args["job_ids"], "started_at": time.time()}
            try:
                fresh = jobs.put(key, reserved, skip_if_exists=True)   # atomic: only one request wins a key
            except TypeError:                                             # an SDK without skip_if_exists
                fresh = plan_dispatch(jobs.get(key)) == "new"
                if fresh:
                    jobs[key] = reserved
            if not fresh:
                return {**entry_view(key, jobs.get(key)), "dispatch": "existing"}
            try:
                call = render.spawn(args, key)
            except Exception as e:
                jobs.pop(key, None)                                       # nothing started: the key may be retried
                return JSONResponse({"ok": False, "error": f"spawn failed: {type(e).__name__}"}, status_code=502)
            entry = {**reserved, "state": "started", "call_id": call.object_id}
            jobs[key] = entry
            return {**entry_view(key, entry), "dispatch": "new"}

        @web.post("/status")
        async def status(request: Request):
            try:
                key = validate_key_args(await body_of(request))
            except ArgError as e:
                return bad(e)
            entry = jobs.get(key)
            live = None
            if isinstance(entry, dict) and entry.get("call_id") and entry.get("state") in ("started", "running"):
                try:
                    modal.FunctionCall.from_id(entry["call_id"]).get(timeout=0)
                    live = "done"
                except TimeoutError:
                    live = None
                except Exception as e:  # the call itself failed (image, OOM, preemption): visible to CHE
                    entry = {**entry, "state": "failed", "error": f"{type(e).__name__}: {str(e)[:200]}", "ended_at": time.time()}
                    jobs[key] = entry
            return entry_view(key, entry, live)

        @web.post("/cancel")
        async def cancel(request: Request):
            try:
                key = validate_key_args(await body_of(request))
            except ArgError as e:
                return bad(e)
            entry = jobs.get(key)
            if not isinstance(entry, dict):
                return entry_view(key, None)
            if entry.get("call_id") and entry.get("state") in ("started", "running", "reserving"):
                try:
                    modal.FunctionCall.from_id(entry["call_id"]).cancel()
                except Exception as e:
                    return JSONResponse({"ok": False, "error": f"cancel failed: {type(e).__name__}"}, status_code=502)
                entry = {**entry, "state": "cancelled", "ended_at": time.time()}
                jobs[key] = entry
            return entry_view(key, entry)

        return web
