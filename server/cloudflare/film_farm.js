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

/** "username:token" (or a bare token). New API tokens use Bearer; a legacy 32-hex key uses Basic with the username. */
export function kaggleAuth(raw = '') {
  const value = String(raw || '').trim();
  const at = value.indexOf(':');
  const username = at > 0 ? value.slice(0, at).trim() : '';
  const secret = at > 0 ? value.slice(at + 1).trim() : value;
  if (!secret) return null;
  const legacy = /^[a-f0-9]{32}$/i.test(secret);
  if (legacy && !username) return null;
  return { username, header: legacy ? `Basic ${btoa(`${username}:${secret}`)}` : `Bearer ${secret}` };
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

/** Validates the token with a real call that needs auth and reads the real weekly GPU quota. */
export async function validateKaggle(raw, fetcher = fetch) {
  const auth = kaggleAuth(raw);
  if (!auth) return { ok: false, status: 'invalid', error: 'That is not a Kaggle token. Paste it as username:token.' };
  let r;
  try { r = await kaggleCall(auth, 'GetAcceleratorQuotaStatistics', {}, fetcher); } catch (e) { return { ok: false, status: 'network', error: `Kaggle could not be reached (${String(e?.message || e).slice(0, 60)}).` }; }
  if (r.status === 401 || r.status === 403) return { ok: false, status: 'unauthorized', error: 'Kaggle rejected that token.' };
  if (!r.ok) return { ok: false, status: 'unknown', error: `Kaggle answered ${r.status}.` };
  const q = r.data.gpuQuota || r.data.gpu_quota || {};
  return {
    ok: true, status: 'healthy', username: auth.username,
    allowed_s: durationSeconds(q.totalTimeAllowed ?? q.total_time_allowed), used_s: durationSeconds(q.timeUsed ?? q.time_used),
    reserved_s: durationSeconds(q.timeReserved ?? q.time_reserved), refresh: r.data.quotaRefreshTime || r.data.quota_refresh_time || '',
    pay_to_scale: Boolean(q.isPayToScaleEnabled ?? q.is_pay_to_scale_enabled),
  };
}

export const KAGGLE_WORKER_PY = String.raw`# CHE render farm worker for a Kaggle GPU session (Film Studio, 2026-10-22).
# CHE pushes this script as a private Kaggle kernel with a T4 GPU and internet on, and fills in the three values
# below. It asks CHE for one moving-clip job at a time, makes it with LTX-Video image-to-video from the shot's
# picture, uploads the MP4 to CHE, and exits when CHE has no more work or before the session time runs out.
# The token is a film-scoped farm token: it opens only this film's farm jobs, expires, and CHE can revoke it.
# It is never the owner's device token. Model weights download from Hugging Face inside the session.
import json, os, subprocess, sys, time, urllib.request

CHE_BASE = "__CHE_BASE__"
FILM_ID = "__FILM_ID__"
FARM_TOKEN = "__FARM_TOKEN__"
DEADLINE_S = int("__DEADLINE_S__")
STARTED = time.time()
MODEL = "Lightricks/LTX-Video"  # LTXV open-weights license; see server/renderfarm/LICENSES.md


def che(method, path, body=None, raw=None, timeout=120):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"{CHE_BASE}/api/film/farm/{FILM_ID}{path}", data=data, method=method)
    req.add_header("X-CHE-Farm-Token", FARM_TOKEN)
    req.add_header("Content-Type", "video/mp4" if raw is not None else "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        text = res.read()
        return json.loads(text) if text[:1] in (b"{", b"[") else {}


def fetch(url, dest):
    req = urllib.request.Request(url)
    req.add_header("X-CHE-Farm-Token", FARM_TOKEN)
    with urllib.request.urlopen(req, timeout=300) as res, open(dest, "wb") as out:
        out.write(res.read())


def time_left():
    return DEADLINE_S - (time.time() - STARTED)


def main():
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "diffusers>=0.32", "transformers", "accelerate", "sentencepiece", "imageio[ffmpeg]"], check=True)
    import torch
    from diffusers import LTXImageToVideoPipeline
    from diffusers.utils import export_to_video, load_image

    pipe = LTXImageToVideoPipeline.from_pretrained(MODEL, torch_dtype=torch.float16)
    pipe.enable_model_cpu_offload()
    made = 0
    while time_left() > 900:
        job = che("GET", "/next")
        if not job or job.get("done"):
            break
        started = time.time()
        fetch(job["image_url"], "frame.jpg")
        image = load_image("frame.jpg").resize((768, 432))
        frames = pipe(image=image, prompt=job["prompt"], negative_prompt="worst quality, blurry, distorted, text, watermark",
                      width=768, height=432, num_frames=int(job.get("frames", 121)), num_inference_steps=int(job.get("steps", 30))).frames[0]
        export_to_video(frames, "clip.mp4", fps=int(job.get("fps", 24)))
        with open("clip.mp4", "rb") as f:
            che("PUT", f"/result?shot={int(job['shot'])}&seconds={time.time() - started:.1f}", raw=f.read(), timeout=300)
        made += 1
    che("POST", "/done", body={"made": made, "seconds": round(time.time() - STARTED)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Report the failure to CHE so the owner hears what happened.
        try:
            che("POST", "/done", body={"error": str(error)[:400], "seconds": round(time.time() - STARTED)})
        finally:
            raise
`;

export function kaggleWorkerScript({ base, filmId, token, deadlineS }) {
  return KAGGLE_WORKER_PY.replace('__CHE_BASE__', base).replace('__FILM_ID__', filmId).replace('__FARM_TOKEN__', token).replace('"__DEADLINE_S__"', `"${Math.floor(deadlineS)}"`);
}

/**
 * Starts one private Kaggle GPU session for a film. Kaggle itself stops it at `seconds` (sessionTimeoutSeconds), so
 * the free weekly quota cannot be overrun even if CHE never hears back. Never uses paid scale-up.
 */
export async function startKaggleSession(raw, { base, film, token, seconds }, fetcher = fetch) {
  const auth = kaggleAuth(raw);
  if (!auth?.username) return { ok: false, error: 'Kaggle needs your username in Keys (username:token) to start a session.' };
  const slug = `${auth.username}/che-film-${film.id.slice(5, 15)}`;
  const body = {
    slug, newTitle: `che film ${film.id.slice(5, 15)}`, text: kaggleWorkerScript({ base, filmId: film.id, token, deadlineS: seconds - 300 }),
    language: 'python', kernelType: 'script', isPrivate: true, enableGpu: true, enableInternet: true, enableTpu: false,
    machineShape: 'NvidiaTeslaT4', sessionTimeoutSeconds: Math.floor(seconds),
  };
  let r;
  try { r = await kaggleCall(auth, 'SaveKernel', body, fetcher, 30000); } catch (e) { return { ok: false, error: `Kaggle could not be reached (${String(e?.message || e).slice(0, 60)}). No session started.` }; }
  if (!r.ok || r.data.error) return { ok: false, error: `Kaggle did not start the session: ${String(r.data.error || r.status).slice(0, 200)}.` };
  return { ok: true, ref: r.data.ref || slug, url: r.data.url || '', version: r.data.versionNumber || null, username: auth.username, slug: slug.split('/')[1] };
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
