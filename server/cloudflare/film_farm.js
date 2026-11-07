// Film Studio GPU farm (2026-10-22): free GPU sessions that make the moving clips (tier A). Kaggle runs CHE's worker
// script (server/renderfarm/kaggle_worker.py) as a private kernel; a Hugging Face ZeroGPU Space in the owner's
// account makes a few clips a day. Both are outside services: internal-only mode and per-project no-export keep work
// off them (film_studio.farmProviders), and Security Intelligence's egress guard refuses the request anyway.
//
// Mechanics checked 2026-10-22 against the official clients (kagglesdk 0.1.38, huggingface_hub):
//   Kaggle: POST https://api.kaggle.com/v1/kernels.KernelsApiService/<Method> with Bearer (API token) or Basic
//   (legacy key) auth. GetAcceleratorQuotaStatistics returns the real weekly GPU quota; SaveKernel pushes and runs a
//   kernel (enableGpu, enableInternet, machineShape, sessionTimeoutSeconds); GetKernelSessionStatus reports it.
//   Internet in a GPU kernel needs a phone-verified Kaggle account.
//   Hugging Face: POST /api/repos/create (type space), POST /api/spaces/<id>/commit/main (NDJSON),
//   POST /api/spaces/<id>/hardware {flavor:"zero-a10g"}; free accounts may host up to two ZeroGPU Spaces.
//
// The farm token a session carries opens only that film's farm routes, expires with the session, and is revoked
// when the film ends. It is never the owner's device token, and it is stored only as a hash.

import { publicOrigin } from './film_render.js';

export const KAGGLE_API = 'https://api.kaggle.com/v1/kernels.KernelsApiService';
export const HF_API = 'https://huggingface.co/api';
export const FARM_TOKEN_MS = 12 * 3600_000;

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function newFarmToken(now = Date.now()) {
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  return { token, record: { token_hash: await sha256(token), expires: now + FARM_TOKEN_MS, revoked: false } };
}

export async function farmTokenOpens(record, token, now = Date.now()) {
  return Boolean(record && !record.revoked && token && now < record.expires && (await sha256(String(token))) === record.token_hash);
}

// ─── Kaggle ──────────────────────────────────────────────────────────────────

/**
 * Reads the stored Kaggle credential. Two formats exist:
 *  - modern: an API token (KGAT_…, or any token Kaggle issues now). Sent alone as Bearer. The account name is not part
 *    of the credential, so it is read from Kaggle (kaggleIdentity), never concatenated into the token.
 *  - legacy: a 32-hex key that needs its username. Sent as Basic username:key, the one format that joins them.
 * "username:token" is accepted for both. The username prefix is used only for a legacy key, or as the name when Kaggle
 * does not return one. The token value is returned for the call and must never be logged or shown.
 */
export function kaggleAuth(raw = '') {
  const value = String(raw || '').trim();
  const at = value.indexOf(':');
  const username = at > 0 ? value.slice(0, at).trim() : '';
  const secret = at > 0 ? value.slice(at + 1).trim() : value;
  if (!secret) return null;
  const legacy = /^[a-f0-9]{32}$/i.test(secret);
  if (legacy && !username) return null;
  return {
    method: legacy ? 'legacy' : 'modern',
    username,
    token: secret,
    header: legacy ? `Basic ${btoa(`${username}:${secret}`)}` : `Bearer ${secret}`,
  };
}

export const KAGGLE_OAUTH = 'https://api.kaggle.com/v1/security.OAuthService';
const IDENTITY_TRIES = 3;

/**
 * The account name a modern token belongs to: Kaggle's IntrospectToken call, the same one its official SDK makes.
 * Retries only transient failures (network, 5xx, 429) with a short backoff. Never retries a rejected token.
 */
export async function kaggleIdentity(auth, fetcher = fetch, timeout = 15000, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  if (!auth?.token) return { ok: false, status: 'invalid' };
  for (let attempt = 1; attempt <= IDENTITY_TRIES; attempt += 1) {
    let res;
    try {
      res = await fetcher(`${KAGGLE_OAUTH}/IntrospectToken`, {
        method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token: auth.token }), signal: AbortSignal.timeout(timeout),
      });
    } catch (_) {
      if (attempt < IDENTITY_TRIES) { await sleep(500 * 2 ** (attempt - 1)); continue; }
      return { ok: false, status: 'network' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, status: 'unauthorized' };
    if (res.status === 429 || res.status >= 500) {
      if (attempt < IDENTITY_TRIES) { await sleep(500 * 2 ** (attempt - 1)); continue; }
      return { ok: false, status: 'network' };
    }
    if (!res.ok) return { ok: false, status: 'unknown' };
    let data = {};
    try { data = await res.json(); } catch (_) { data = {}; }
    if (data.active === false) return { ok: false, status: 'unauthorized' };
    const username = typeof data.username === 'string' ? data.username.trim() : '';
    return username ? { ok: true, username, user_id: data.userId ?? null } : { ok: false, status: 'no_name' };
  }
  return { ok: false, status: 'network' };
}

/** An error message with the token removed, so a failure can never show the credential. */
export function scrubbed(text, auth) {
  const t = String(text ?? '');
  return auth?.token ? t.split(auth.token).join('[hidden]').slice(0, 60) : t.slice(0, 60);
}

export async function kaggleCall(auth, method, body = {}, fetcher = fetch, timeout = 15000) {
  const res = await fetcher(`${KAGGLE_API}/${method}`, {
    method: 'POST', headers: { Authorization: auth.header, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  let data = {};
  try { data = await res.json(); } catch (_) { data = {}; }
  return { status: res.status, ok: res.ok, data };
}

/** "151.500s" → 151.5 (protobuf duration as kagglesdk serializes it). */
export function durationSeconds(v) {
  if (typeof v === 'number') return v;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(String(v || '').trim());
  return m ? Number(m[1]) : 0;
}

/**
 * Validates the stored credential with a real call that needs auth and reads the real weekly GPU quota. A modern token
 * that Kaggle accepts is "healthy" even when its account name cannot be read right now; the reason is returned so the
 * app can say exactly what is missing.
 */
export async function validateKaggle(raw, fetcher = fetch) {
  const auth = kaggleAuth(raw);
  if (!auth) return { ok: false, status: 'invalid', error: 'That is not a Kaggle token. Paste your Kaggle API token in Keys (an old key also needs your username).' };
  let r;
  try { r = await kaggleCall(auth, 'GetAcceleratorQuotaStatistics', {}, fetcher); } catch (e) { return { ok: false, status: 'network', error: `Kaggle could not be reached (${scrubbed(e?.message || e, auth)}).` }; }
  if (r.status === 401 || r.status === 403) return { ok: false, status: 'unauthorized', error: 'Kaggle rejected that token.' };
  if (!r.ok) return { ok: false, status: 'unknown', error: `Kaggle answered ${r.status}.` };
  const q = r.data.gpuQuota || r.data.gpu_quota || {};
  let username = auth.username;
  let username_source = username ? 'typed' : null;
  let username_error = null;
  if (!username && auth.method === 'modern') {
    const identity = await kaggleIdentity(auth, fetcher);
    if (identity.ok) { username = identity.username; username_source = 'kaggle'; } else username_error = identity.status;
  }
  return {
    ok: true, status: 'healthy', method: auth.method, username: username || null, username_source, username_error,
    allowed_s: durationSeconds(q.totalTimeAllowed ?? q.total_time_allowed), used_s: durationSeconds(q.timeUsed ?? q.time_used),
    reserved_s: durationSeconds(q.timeReserved ?? q.time_reserved), refresh: r.data.quotaRefreshTime || r.data.quota_refresh_time || '',
    pay_to_scale: Boolean(q.isPayToScaleEnabled ?? q.is_pay_to_scale_enabled),
  };
}

export const KAGGLE_WORKER_PY = String.raw`# CHE render farm worker for a Kaggle GPU session (Film Studio, 2026-10-22).
# CHE pushes this script as a private Kaggle kernel with a T4 GPU and internet on, and fills in the three values
# below. It asks CHE for one moving-clip job at a time, makes it with LTX-Video image-to-video from the shot's
# picture, uploads the MP4 to CHE, and exits when CHE has no more work or before the session time runs out. Talking
# shots are then lip-synced to their voice lines (LatentSync 1.5) and uploaded the same way.
# The token is a film-scoped farm token: it opens only this film's farm jobs, expires, and CHE can revoke it.
# It is never the owner's device token. Model weights download from Hugging Face inside the session.
import json, os, subprocess, sys, threading, time, traceback, urllib.request

CHE_BASE = "__CHE_BASE__"
FILM_ID = "__FILM_ID__"
FARM_TOKEN = "__FARM_TOKEN__"
DEADLINE_S = int("__DEADLINE_S__")
LIPSYNC = "__LIPSYNC__" == "1"  # this film has talking shots to lip-sync
STARTED = time.time()
MODEL = "Lightricks/LTX-Video"  # LTXV open-weights license; see server/renderfarm/LICENSES.md
# A named client: Python's default "Python-urllib/x.y" agent is one that Cloudflare's bot checks may refuse.
AGENT = "che-film-farm/1.0 (+kaggle)"


def che(method, path, body=None, raw=None, timeout=120):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"{CHE_BASE}/api/film/farm/{FILM_ID}{path}", data=data, method=method)
    req.add_header("X-CHE-Farm-Token", FARM_TOKEN)
    req.add_header("User-Agent", AGENT)
    req.add_header("Content-Type", "video/mp4" if raw is not None else "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        text = res.read()
        return json.loads(text) if text[:1] in (b"{", b"[") else {}


def fetch(url, dest):
    req = urllib.request.Request(url)
    req.add_header("X-CHE-Farm-Token", FARM_TOKEN)
    req.add_header("User-Agent", AGENT)
    with urllib.request.urlopen(req, timeout=300) as res, open(dest, "wb") as out:
        out.write(res.read())


def time_left():
    return DEADLINE_S - (time.time() - STARTED)


def ltx():
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "diffusers>=0.32", "transformers", "accelerate", "sentencepiece", "imageio[ffmpeg]"], check=True)
    import torch
    from diffusers import LTXImageToVideoPipeline
    pipe = LTXImageToVideoPipeline.from_pretrained(MODEL, torch_dtype=torch.float16)
    pipe.enable_model_cpu_offload()
    return pipe


def make_clip(pipe, job):
    from diffusers.utils import export_to_video, load_image
    fetch(job["image_url"], "frame.jpg")
    image = load_image("frame.jpg").resize((768, 432))
    frames = pipe(image=image, prompt=job["prompt"], negative_prompt="worst quality, blurry, distorted, text, watermark",
                  width=768, height=432, num_frames=int(job.get("frames", 121)), num_inference_steps=int(job.get("steps", 30))).frames[0]
    export_to_video(frames, "clip.mp4", fps=int(job.get("fps", 24)))
    return "clip.mp4"


# Lip sync: LatentSync 1.5 (Apache-2.0, ByteDance), pinned, in its own environment so its pinned packages never touch
# the clip model's. 1.5 needs about 8 GB of GPU memory, inside a T4; 1.6 needs 18 GB and does not fit.
LATENTSYNC_REPO = "https://github.com/bytedance/LatentSync.git"
LATENTSYNC_COMMIT = "a229c3948406bc2cf6eaf4873e662e70c6a04746"
LATENTSYNC_WEIGHTS = "ByteDance/LatentSync-1.5"


def ffmpeg():
    import shutil
    found = shutil.which("ffmpeg")
    if found:
        return found
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "imageio-ffmpeg"], check=True)
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def lipsync_setup():
    root, env = os.path.abspath("LatentSync"), os.path.abspath("lsenv")
    if not os.path.isdir(root):
        subprocess.run(["git", "clone", "-q", LATENTSYNC_REPO, root], check=True)
    subprocess.run(["git", "-C", root, "checkout", "-q", LATENTSYNC_COMMIT], check=True)
    # uv installs the pinned packages in parallel, several times faster than pip; pip stays the fallback.
    py = os.path.join(env, "bin", "python")
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "uv"], check=True)
        subprocess.run([sys.executable, "-m", "uv", "venv", "-q", "--python", sys.executable, env], check=True)
        subprocess.run([sys.executable, "-m", "uv", "pip", "install", "-q", "--python", py, "-r", os.path.join(root, "requirements.txt")], check=True)
    except Exception:
        subprocess.run([sys.executable, "-m", "venv", "--clear", env], check=True)
        subprocess.run([py, "-m", "pip", "install", "-q", "-r", os.path.join(root, "requirements.txt")], check=True)
    get = "from huggingface_hub import hf_hub_download as d; [d('%s', f, local_dir='checkpoints') for f in ('latentsync_unet.pt', 'whisper/tiny.pt')]" % LATENTSYNC_WEIGHTS
    subprocess.run([py, "-c", get], check=True, cwd=root)
    return root, py


def lipsync(job, setup, gpu=None):
    root, py = setup
    ff = ffmpeg()
    seconds = float(job["seconds"])
    work = os.path.abspath(f"lip{int(job['shot'])}")  # each shot in its own folder: two GPUs may work at once
    os.makedirs(work, exist_ok=True)
    at = lambda name: os.path.join(work, name)
    # The voice track at the same times the film's edit puts each line (film_studio.voiceTimes), silence elsewhere.
    inputs, chains = [], []
    for i, line in enumerate(job["audio"]):
        fetch(line["url"], at(f"line{i}.mp3"))
        inputs += ["-i", at(f"line{i}.mp3")]
        chains.append(f"[{i}:a]adelay={int(float(line['at']) * 1000)}:all=1[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(job["audio"]))) + f"amix=inputs={len(job['audio'])}:normalize=0,apad,atrim=0:{seconds}[voice]"
    subprocess.run([ff, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(chains + [mix]), "-map", "[voice]", "-ar", "16000", "-ac", "1", at("voice.wav")], check=True)
    # The picture: the shot's moving clip looped to the shot's length, or its still held for it.
    if job.get("video_url"):
        fetch(job["video_url"], at("base.mp4"))
        source = ["-stream_loop", "-1", "-i", at("base.mp4")]
    else:
        fetch(job["image_url"], at("base.jpg"))
        source = ["-loop", "1", "-i", at("base.jpg")]
    subprocess.run([ff, "-y", "-loglevel", "error", *source, "-t", str(seconds), "-r", str(int(job.get("fps", 25))),
                    "-vf", "scale=768:432:force_original_aspect_ratio=increase,crop=768:432", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-an", at("face.mp4")], check=True)
    # DeepCache reuses work between denoising steps (about twice as fast), as LatentSync's own inference.sh does.
    run_env = dict(os.environ, **({"CUDA_VISIBLE_DEVICES": str(gpu)} if gpu is not None else {}))
    subprocess.run([py, "-m", "scripts.inference", "--unet_config_path", "configs/unet/stage2.yaml", "--inference_ckpt_path", "checkpoints/latentsync_unet.pt",
                    "--inference_steps", "20", "--guidance_scale", "1.5", "--enable_deepcache", "--video_path", at("face.mp4"),
                    "--audio_path", at("voice.wav"), "--video_out_path", at("synced.mp4"), "--temp_dir", at("temp")], check=True, cwd=root, env=run_env)
    # Voices are mixed by the edit, so the clip goes back silent, H.264, exactly the shot's length.
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", at("synced.mp4"), "-t", str(seconds), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", at("lipsync.mp4")], check=True)
    return at("lipsync.mp4")


def gpu_count():
    try:
        import torch
        return torch.cuda.device_count()
    except Exception:
        return 1


# Lip sync's own install starts with the session, in the background, while the clip model loads: it is never waited
# for on the way to the first clip.
SETUP = {}


def prepare():
    began = time.time()
    try:
        SETUP["ready"] = lipsync_setup()
    except Exception as error:
        SETUP["error"] = error
    SETUP["seconds"] = time.time() - began


PREPARING = threading.Thread(target=prepare, daemon=True)
TOTALS = {"made": 0, "lip_synced": 0}
LOCK = threading.Lock()
STOP = threading.Event()  # set when either GPU loop fails, so the other stops too
FAILED = []


def work(kind, gpu):
    """Asks CHE for jobs of one kind ("clip", "lipsync" or "any") and does them on one GPU until there are none."""
    pipe = None
    reported = False
    while time_left() > 600 and not STOP.is_set():
        job = che("GET", f"/next?kind={kind}&gpus={gpu_count()}")
        if not job or job.get("done"):
            break
        if job.get("wait"):  # pictures or voices are still being made, or the other GPU holds the last job
            time.sleep(min(60, int(job["wait"])))
            continue
        started = time.time()
        if job.get("kind") == "lipsync":
            if pipe is not None:  # one GPU only: free it for LatentSync
                import torch
                pipe = None
                torch.cuda.empty_cache()
            try:
                if not PREPARING.is_alive() and "seconds" not in SETUP:
                    PREPARING.start()
                PREPARING.join()
                if "error" in SETUP:
                    raise SETUP["error"]
                setup_s = "" if reported else f"&setup={SETUP['seconds']:.1f}"
                with open(lipsync(job, SETUP["ready"], gpu), "rb") as f:
                    che("PUT", f"/result?shot={int(job['shot'])}&kind=lipsync&seconds={time.time() - started:.1f}{setup_s}", raw=f.read(), timeout=300)
                reported = True
                with LOCK:
                    TOTALS["lip_synced"] += 1
            except Exception as error:  # that shot keeps its picture; the rest of the film goes on
                che("POST", "/lipfail", body={"shot": int(job["shot"]), "error": str(error)[:300]})
            continue
        if pipe is None:  # the clip model runs on the first GPU (LatentSync gets the second when there are two)
            pipe = ltx()
        with open(make_clip(pipe, job), "rb") as f:
            che("PUT", f"/result?shot={int(job['shot'])}&seconds={time.time() - started:.1f}", raw=f.read(), timeout=300)
        with LOCK:
            TOTALS["made"] += 1


def guarded(kind, gpu):
    """One GPU loop on its own thread: its failure is kept for main() and stops the other loop (join() drops it)."""
    try:
        work(kind, gpu)
    except Exception as error:
        FAILED.append(error)
        STOP.set()


def main():
    che("GET", f"/next?kind=hello&gpus={gpu_count()}&boot={time.time() - STARTED:.1f}")
    if LIPSYNC:
        PREPARING.start()
    if LIPSYNC and gpu_count() >= 2:
        # Two GPUs (Kaggle's T4 x2): moving clips on the first, lip sync on the second, at the same time.
        loops = [threading.Thread(target=guarded, args=("clip", 0)), threading.Thread(target=guarded, args=("lipsync", 1))]
        for t in loops:
            t.start()
        for t in loops:
            t.join()
        if FAILED:  # reported to CHE by the handler below, so the farm's fallback starts at once
            raise FAILED[0]
    else:
        work("any", None)
    che("POST", "/done", body={**TOTALS, "gpus": gpu_count(), "seconds": round(time.time() - STARTED)})


def failure_line(error):
    """The exception as one line a person can read, e.g. "HTTPError: HTTP Error 403: Forbidden"."""
    return f"{type(error).__name__}: {error}".strip()[:400]


if __name__ == "__main__":
    if not CHE_BASE.startswith("https://"):
        print(f"CHE farm: no public address for CHE ({CHE_BASE!r}); nothing to do.", flush=True)
        sys.exit(2)
    try:
        main()
    except BaseException as error:  # Report the failure to CHE so the owner hears what happened.
        traceback.print_exc()  # the full trace goes to the session log, which CHE reads when the session ends in error
        try:
            che("POST", "/done", body={"error": failure_line(error), "seconds": round(time.time() - STARTED)}, timeout=30)
        except BaseException as report_error:  # CHE unreachable: the log above still says why
            print(f"CHE farm: could not report the failure to CHE: {failure_line(report_error)}", flush=True)
        raise
`;

export function kaggleWorkerScript({ base, filmId, token, deadlineS, lipsync = false }) {
  return KAGGLE_WORKER_PY.replace('__CHE_BASE__', base).replace('__FILM_ID__', filmId).replace('__FARM_TOKEN__', token).replace('"__DEADLINE_S__"', `"${Math.floor(deadlineS)}"`).replace('"__LIPSYNC__"', lipsync ? '"1"' : '"0"');
}

/**
 * Starts one private Kaggle GPU session for a film. Kaggle itself stops it at `seconds` (sessionTimeoutSeconds), so
 * the free weekly quota cannot be overrun even if CHE never hears back. Never uses paid scale-up.
 */
export async function startKaggleSession(raw, { base, film, token, seconds, username: knownName = '', lipsync = false }, fetcher = fetch) {
  const auth = kaggleAuth(raw);
  if (!auth) return { ok: false, error: 'That is not a Kaggle token. Paste your Kaggle API token in Keys.' };
  // The session fetches its pictures from CHE and uploads its clips to her: without a public address it would only burn
  // GPU time and end in error, so none is started (film_render.publicOrigin).
  if (!publicOrigin(base)) return { ok: false, retryable: true, error: 'CHE does not know her public address yet, so a Kaggle GPU session could not reach her. No session started.' };
  // The name a session is filed under: the typed prefix (legacy), or the name Kaggle returned for this token.
  const name = auth.username || String(knownName || '').trim();
  if (!name) return { ok: false, error: 'CHE has not read your Kaggle account name yet. Your token is saved; the session starts once Kaggle returns it.' };
  const slug = `${name}/che-film-${film.id.slice(5, 15)}`;
  const body = {
    slug, newTitle: `che film ${film.id.slice(5, 15)}`, text: kaggleWorkerScript({ base, filmId: film.id, token, deadlineS: seconds - 300, lipsync }),
    language: 'python', kernelType: 'script', isPrivate: true, enableGpu: true, enableInternet: true, enableTpu: false,
    machineShape: 'NvidiaTeslaT4', sessionTimeoutSeconds: Math.floor(seconds),
  };
  let r;
  try { r = await kaggleCall(auth, 'SaveKernel', body, fetcher, 30000); } catch (e) { return { ok: false, error: `Kaggle could not be reached (${String(e?.message || e).slice(0, 60)}). No session started.` }; }
  if (!r.ok || r.data.error) return { ok: false, error: `Kaggle did not start the session: ${String(r.data.error || r.status).slice(0, 200)}.` };
  return { ok: true, ref: r.data.ref || slug, url: r.data.url || '', version: r.data.versionNumber || null, username: name, slug: slug.split('/')[1] };
}

export async function kaggleSessionStatus(raw, session, fetcher = fetch) {
  const auth = kaggleAuth(raw);
  if (!auth) return { ok: false, error: 'No Kaggle token.' };
  try {
    const r = await kaggleCall(auth, 'GetKernelSessionStatus', { userName: session.username, kernelSlug: session.slug }, fetcher);
    if (!r.ok) return { ok: false, error: `Kaggle answered ${r.status}.` };
    const s = String(r.data.status || '').toUpperCase();
    const state = /COMPLETE/.test(s) ? 'complete' : /ERROR/.test(s) ? 'error' : /CANCEL/.test(s) ? 'cancelled' : /RUNNING/.test(s) ? 'running' : 'queued';
    return { ok: true, state, failure: r.data.failureMessage || '' };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

/**
 * The text of a session's own log (what the script printed, and Python's traceback when it failed). Kaggle returns it
 * from ListKernelSessionOutput (kagglesdk 0.1.38 KernelsApiService: {userName, kernelSlug} -> {files, log}); the log
 * is a JSON list of {stream_name, time, data} entries, or plain text.
 */
export function sessionLogText(log) {
  const raw = String(log ?? '');
  try {
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) return entries.map((e) => String(e?.data ?? '')).join('');
  } catch (_) { /* plain text */ }
  return raw;
}

/** Why a script ended, from its log: the last exception line ("Name: message"), else CHE's own line, else the last lines. */
export function logReason(text, secrets = []) {
  let t = String(text || '');
  for (const secret of secrets) if (secret && String(secret).length >= 8) t = t.split(String(secret)).join('[hidden]');
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const exception = [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt)(?::|$)/.test(l));
  const farm = [...lines].reverse().find((l) => /^CHE farm:/.test(l));
  const pick = exception || farm || lines.slice(-2).join(' ');
  return pick.replace(/\s+/g, ' ').slice(0, 200);
}

/** The reason a finished session failed, read from its own log; '' when Kaggle returns no log. Never throws. */
export async function kaggleSessionLog(raw, session, fetcher = fetch, secrets = []) {
  const auth = kaggleAuth(raw);
  if (!auth || !session?.username || !session?.slug) return '';
  try {
    const r = await kaggleCall(auth, 'ListKernelSessionOutput', { userName: session.username, kernelSlug: session.slug }, fetcher);
    if (!r.ok) return '';
    return logReason(sessionLogText(r.data?.log), [auth.token, ...secrets]);
  } catch (_) { return ''; }
}

// ─── Hugging Face ZeroGPU ────────────────────────────────────────────────────

export const HF_SPACE_FILES = Object.freeze([
  { path: 'app.py', content: String.raw`# CHE film farm Space (ZeroGPU). CHE creates this private Space in the owner's Hugging Face account and calls its
# "clip" endpoint with one shot at a time: the shot's picture (fetched from CHE with a film-scoped farm token), a
# prompt and a length. Each call uses the account's free daily ZeroGPU minutes; when they are used up the call fails
# and CHE plans the shot as a still with camera motion instead. Nothing here is paid.
import json, tempfile, urllib.request

import gradio as gr
import spaces
import torch
from diffusers import LTXImageToVideoPipeline
from diffusers.utils import export_to_video, load_image

pipe = LTXImageToVideoPipeline.from_pretrained("Lightricks/LTX-Video", torch_dtype=torch.bfloat16)
pipe.to("cuda")


def fetch(url, token):
    req = urllib.request.Request(url)
    req.add_header("X-CHE-Farm-Token", token)
    path = tempfile.mktemp(suffix=".jpg")
    with urllib.request.urlopen(req, timeout=120) as res, open(path, "wb") as out:
        out.write(res.read())
    return path


@spaces.GPU(duration=60)
def clip(request_json):
    job = json.loads(request_json)
    image = load_image(fetch(job["image_url"], job["farm_token"])).resize((768, 432))
    frames = pipe(image=image, prompt=job["prompt"], negative_prompt="worst quality, blurry, distorted, text, watermark",
                  width=768, height=432, num_frames=int(job.get("frames", 121)), num_inference_steps=int(job.get("steps", 30))).frames[0]
    out = tempfile.mktemp(suffix=".mp4")
    export_to_video(frames, out, fps=int(job.get("fps", 24)))
    with open(out, "rb") as f:
        data = f.read()
    req = urllib.request.Request(job["upload_url"], data=data, method="PUT")
    req.add_header("X-CHE-Farm-Token", job["farm_token"])
    req.add_header("Content-Type", "video/mp4")
    with urllib.request.urlopen(req, timeout=300) as res:
        return json.dumps({"uploaded": res.status == 200, "bytes": len(data)})


gr.Interface(fn=clip, inputs=gr.Textbox(), outputs=gr.Textbox(), api_name="clip").queue().launch()
` },
  { path: 'requirements.txt', content: String.raw`diffusers>=0.32
transformers
accelerate
sentencepiece
imageio[ffmpeg]
torch
` },
  { path: 'README.md', content: String.raw`---
title: CHE film farm
sdk: gradio
app_file: app.py
pinned: false
---
Private Space CHE creates in the owner's account to make a few moving clips a day on free ZeroGPU minutes.
` },
]);

export const HF_SPACE_NAME = 'che-film-farm';

function b64(text) { const bytes = new TextEncoder().encode(text); let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }

/** Creates (or reuses) the private ZeroGPU Space in the owner's account. Needs a write token; says so if not. */
export async function ensureHfSpace(token, owner, files, fetcher = fetch) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const id = `${owner}/${HF_SPACE_NAME}`;
  const create = await fetcher(`${HF_API}/repos/create`, { method: 'POST', headers, body: JSON.stringify({ type: 'space', name: HF_SPACE_NAME, private: true, sdk: 'gradio' }), signal: AbortSignal.timeout(20000) });
  if (!create.ok && create.status !== 409) return { ok: false, error: create.status === 403 || create.status === 401 ? 'Your Hugging Face token cannot create a Space. Paste a token with write access.' : `Hugging Face answered ${create.status} when creating the Space.` };
  const lines = [JSON.stringify({ key: 'header', value: { summary: 'CHE film farm worker' } }), ...files.map((f) => JSON.stringify({ key: 'file', value: { path: f.path, content: b64(f.content), encoding: 'base64' } }))];
  const commit = await fetcher(`${HF_API}/spaces/${id}/commit/main`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-ndjson' }, body: lines.join('\n'), signal: AbortSignal.timeout(30000) });
  if (!commit.ok) return { ok: false, error: `Hugging Face refused the Space files (${commit.status}).` };
  const hw = await fetcher(`${HF_API}/spaces/${id}/hardware`, { method: 'POST', headers, body: JSON.stringify({ flavor: 'zero-a10g' }), signal: AbortSignal.timeout(20000) });
  if (!hw.ok) return { ok: false, error: `Hugging Face did not grant ZeroGPU to the Space (${hw.status}). Free accounts need a verified email and an account older than 30 days.` };
  return { ok: true, space: id, host: `https://${owner.toLowerCase()}-${HF_SPACE_NAME}.hf.space` };
}

/** One clip through the Space's Gradio API: start a call, then read its result stream. */
export async function hfClip(token, host, payload, fetcher = fetch) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const start = await fetcher(`${host}/gradio_api/call/clip`, { method: 'POST', headers, body: JSON.stringify({ data: [JSON.stringify(payload)] }), signal: AbortSignal.timeout(30000) });
  if (!start.ok) return { ok: false, error: `The Space answered ${start.status}.` };
  const { event_id: eventId } = await start.json().catch(() => ({}));
  if (!eventId) return { ok: false, error: 'The Space returned no job id.' };
  const stream = await fetcher(`${host}/gradio_api/call/clip/${eventId}`, { headers, signal: AbortSignal.timeout(240000) });
  const text = await stream.text();
  if (/event:\s*error/.test(text)) return { ok: false, error: /quota|ZeroGPU/i.test(text) ? 'the free ZeroGPU minutes for today are used up' : 'the Space failed to make the clip' };
  const data = /event:\s*complete\s*\ndata:\s*(.+)/.exec(text)?.[1];
  try { return { ok: true, result: JSON.parse(JSON.parse(data)[0]) }; } catch (_) { return { ok: false, error: 'the Space returned no clip' }; }
}
