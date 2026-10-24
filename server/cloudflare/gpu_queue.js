// GPU on demand (owner, 2026-10-24; strict $0): a persistent render queue in CHE's own Durable Object, worked by the
// owner's Google Colab T4 notebook while he has a session open (notebooks/CHE_GPU_Face_Preview.ipynb, cell 7, running
// scripts/che_gpu_worker.py). Nothing here buys GPU time or falls back to a paid service, and Colab is never described
// as running unattended: it works only while a session the owner opened in his browser is alive.
//
// Jobs: queued -> rendering -> completed | failed, plus paused (the worker stopped heartbeating, e.g. Colab
// disconnected; the next session resumes it first) and cancelled. A worker claims one job at a time under a lease
// that its heartbeats extend; a lapsed lease pauses the job instead of failing it, and the job runner on Colab reuses
// every view already verified in Drive, so resuming never renders finished work again.
// A job completes only when the worker's receipt says complete, every view names a GPU device, and every view's
// preview picture has been uploaded into CHE's media library (so the Creation Room shows the real pictures).
//
// The worker token is the owner's to create (POST /api/gpu/worker-token from his device); it is shown once, stored
// only as a SHA-256 hash, opens only /api/gpu/worker/* and is revoked by creating a new one or by /revoke.
import { BUILT_IN, STYLES, STYLE_LABELS, identityRoute, toSettings } from './avatar_identity.js';
import { saveRenderedImage } from './media.js';
import { mediaStore, sha256Hex } from './che_media_store.js';

export const LEASE_MS = 3 * 60_000;           // a claimed job pauses after 3 minutes without a heartbeat
export const ONLINE_MS = 90_000;              // a worker counts as online for 90 s after its last heartbeat
export const MAX_FAILURES = 2;                // reported render failures before a job is marked failed
export const MAX_JOBS = 200;
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
export const MAX_MODEL_BYTES = 16 * 1024 * 1024;
// face_preview: pictures only. person_model (Live Studio, creation_studio.js): the same pictures plus the 3D model
// (a GLB the worker exports from the same Blender build, uploaded the moment it exists, before the renders finish).
export const JOB_KINDS = ['face_preview', 'person_model'];
export const VIEW_NAMES = { 0: 'front', 45: 'three-quarter', 90: 'side' };
const GPU_DEVICE = /^DEVICE (OPTIX|CUDA) \[.+\]/;
const JOBS_KEY = 'gpu:jobs';
const WORKERS_KEY = 'gpu:workers';
const TOKEN_KEY = 'gpu:token';
const SEEDED_KEY = 'gpu:seeded';

// The first jobs, queued once when the queue is first read: CHE's face in three looks from one model and rig (STYLE in
// tools/avatar_face/mpfb_dress.py), built from her identity preset (avatar_identity.js), so the identity and look are
// part of the settings and each look is its own content-named job that never reuses another look's pictures.
// Face only until the owner approves body work.
const CHE = BUILT_IN.find((p) => p.id === 'che');
export const SEED_JOBS = STYLES.map((style) => ({
  title: `CHE's face, ${STYLE_LABELS[style]}: front, three-quarter and side`,
  kind: 'face_preview', views: [0, 45, 90], samples: 64, res: 480,
  settings: toSettings(CHE, style),
  queued_by: 'Claude (PR #517)',
}));

/** A GPU model name as nvidia-smi prints it ("Tesla T4, 550.54, 15360 MiB"); an error message is not one. */
export function isGpuName(name) {
  const s = String(name || '');
  return !/unavailable|not found|no devices|failed|error/i.test(s) && /\b(Tesla|GeForce|RTX|Quadro|NVIDIA [A-Z]\w*|A100|A10G?|L4|T4|V100|P100|H100)\b/.test(s);
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const iso = (ms) => new Date(ms).toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function cleanSettings(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const [k, v] of Object.entries(s)) {
    if (/^[A-Z][A-Z0-9_]{0,31}$/.test(k) && ['string', 'number'].includes(typeof v) && String(v).length <= (k === 'FACE' ? 1200 : 400)) out[k] = String(v);
  }
  return out;
}

function cleanViews(v) {
  const views = (Array.isArray(v) ? v : String(v || '0,45,90').split(',')).map(Number).filter((n) => Number.isInteger(n) && n >= -180 && n <= 180);
  return [...new Set(views)].slice(0, 8);
}

/** A GLB v2 file: magic "glTF", version 2, and the header's total length equal to the bytes received. */
export function isGlb(bytes) {
  if (!bytes || bytes.length < 20) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(4, true) === 2 && dv.getUint32(8, true) === bytes.length;
}

const modelKey = (id) => `gpu/models/${id}.glb`;

function note(job, now, state, text) {
  job.state = state; job.updated_at = iso(now);
  job.history = [...(job.history || []), { at: iso(now), state, note: String(text).slice(0, 300) }].slice(-20);
}

/** A rendering job whose worker stopped heartbeating is paused, not failed: the next session resumes it. */
function settle(jobs, now) {
  let changed = false;
  for (const j of jobs) {
    if (j.state === 'rendering' && (!j.lease || j.lease.expires_ms <= now)) {
      note(j, now, 'paused', `The Colab session stopped answering (last heartbeat ${j.lease ? iso(j.lease.expires_ms - LEASE_MS) : 'unknown'}). It resumes in your next Colab session; finished views are kept.`);
      j.lease = null; changed = true;
    }
  }
  return changed;
}

export class GpuQueue {
  constructor(storage, now = () => Date.now()) { this.storage = storage; this.now = now; }

  async jobs() {
    let jobs = (await this.storage.get(JOBS_KEY)) || [];
    if (!(await this.storage.get(SEEDED_KEY))) {
      const t = this.now();
      for (const seed of SEED_JOBS) jobs.push(this.newJob(seed, t));
      await this.storage.put(SEEDED_KEY, iso(t));
      await this.storage.put(JOBS_KEY, jobs);
    }
    if (settle(jobs, this.now())) await this.save(jobs);
    return jobs;
  }

  async save(jobs) { await this.storage.put(JOBS_KEY, jobs.slice(-MAX_JOBS)); }

  newJob(spec, t) {
    const id = `gpu_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const job = {
      id, kind: JOB_KINDS.includes(spec.kind) ? spec.kind : 'face_preview', title: String(spec.title || 'Face preview').slice(0, 120), views: cleanViews(spec.views),
      settings: cleanSettings(spec.settings), samples: Math.min(Math.max(Number(spec.samples) || 64, 1), 1024),
      res: Math.min(Math.max(Number(spec.res) || 480, 64), 2048), queued_by: String(spec.queued_by || 'owner').slice(0, 60),
      created_at: iso(t), updated_at: iso(t), state: 'queued', failures: 0, sessions: 0, lease: null,
      progress: { views_done: [], message: 'Waiting for your Colab GPU session.' }, previews: {}, model: null, receipt: null, history: [],
    };
    note(job, t, 'queued', 'Queued. It renders the next time your Colab T4 notebook runs.');
    return job;
  }

  /** Owner: queue a face preview. The same settings and views already waiting or rendering are not queued twice. */
  async enqueue(spec) {
    const jobs = await this.jobs();
    const probe = this.newJob(spec, this.now());
    if (!probe.views.length) return { ok: false, detail: 'Name at least one view (0 front, 45 three-quarter, 90 side).' };
    const same = jobs.find((j) => ['queued', 'paused', 'rendering'].includes(j.state)
      && (j.kind || 'face_preview') === probe.kind && JSON.stringify(j.settings) === JSON.stringify(probe.settings) && j.views.join() === probe.views.join() && j.samples === probe.samples && j.res === probe.res);
    if (same) return { ok: true, job: same, duplicate: true };
    jobs.push(probe); await this.save(jobs);
    return { ok: true, job: probe };
  }

  async control(action, id) {
    const jobs = await this.jobs(); const j = jobs.find((x) => x.id === id);
    if (!j) return { ok: false, detail: 'No such GPU job.' };
    const t = this.now();
    if (action === 'cancel') {
      if (['completed', 'failed', 'cancelled'].includes(j.state)) return { ok: false, detail: `That job is already ${j.state}.` };
      note(j, t, 'cancelled', 'Cancelled by the owner.'); j.lease = null;
    } else if (action === 'retry') {
      if (!['failed', 'cancelled'].includes(j.state)) return { ok: false, detail: `Only a failed or cancelled job can be retried; this one is ${j.state}.` };
      j.failures = 0; note(j, t, 'queued', 'Queued again by the owner. Finished views in Drive are reused.');
    } else return { ok: false, detail: 'Unknown action.' };
    await this.save(jobs);
    return { ok: true, job: j };
  }

  async workers() { return (await this.storage.get(WORKERS_KEY)) || {}; }

  /** What the Creation Room shows. */
  async view() {
    const jobs = await this.jobs(); const workers = await this.workers(); const t = this.now();
    const list = Object.entries(workers).map(([id, w]) => ({ id, ...w, online: t - (w.last_seen_ms || 0) < ONLINE_MS, last_seen: w.last_seen_ms ? iso(w.last_seen_ms) : null }));
    const counts = {};
    for (const j of jobs) counts[j.state] = (counts[j.state] || 0) + 1;
    const token = await this.storage.get(TOKEN_KEY);
    return { jobs: [...jobs].reverse().map(publicJob), workers: list, counts, worker_paired: Boolean(token && !token.revoked), cost: '$0: your own Google Colab free T4 session; nothing is bought.' };
  }

  async createToken() {
    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    await this.storage.put(TOKEN_KEY, { token_hash: await sha256(token), created_at: iso(this.now()), revoked: false });
    return token;
  }

  async revokeToken() {
    const rec = await this.storage.get(TOKEN_KEY);
    if (rec) await this.storage.put(TOKEN_KEY, { ...rec, revoked: true });
    return Boolean(rec);
  }

  async tokenOpens(token) {
    const rec = await this.storage.get(TOKEN_KEY);
    return Boolean(rec && !rec.revoked && token && (await sha256(token)) === rec.token_hash);
  }

  async touchWorker(workerId, info = {}) {
    const workers = await this.workers(); const t = this.now();
    const w = workers[workerId] || { first_seen: iso(t) };
    workers[workerId] = { ...w, gpu: String(info.gpu || w.gpu || '').slice(0, 120), blender: String(info.blender || w.blender || '').slice(0, 60),
      state: String(info.state || 'idle').slice(0, 40), last_seen_ms: t };
    const ids = Object.keys(workers).sort((a, b) => workers[b].last_seen_ms - workers[a].last_seen_ms);
    for (const old of ids.slice(10)) delete workers[old];
    await this.storage.put(WORKERS_KEY, workers);
  }

  /** Worker: the next job: paused ones first (resume), then the oldest queued. Requires a GPU name from nvidia-smi. */
  async claim(workerId, info = {}) {
    if (!isGpuName(info.gpu)) return { ok: false, detail: 'No GPU reported; nothing is handed to a CPU.' };
    await this.touchWorker(workerId, { ...info, state: 'claiming' });
    const jobs = await this.jobs(); const t = this.now();
    const mine = jobs.find((j) => j.state === 'rendering' && j.lease?.worker_id === workerId);
    const next = mine || jobs.find((j) => j.state === 'paused') || jobs.find((j) => j.state === 'queued');
    if (!next) return { ok: true, job: null };
    const resumed = next.state === 'paused';
    next.lease = { worker_id: workerId, expires_ms: t + LEASE_MS }; next.sessions = (next.sessions || 0) + (mine ? 0 : 1);
    next.progress = { ...(next.progress || {}), message: resumed ? 'Resuming: views already verified in Drive are reused.' : 'Starting on the GPU.' };
    if (!mine) note(next, t, 'rendering', `${resumed ? 'Resumed' : 'Claimed'} by the Colab worker on ${String(info.gpu).slice(0, 60)}.`);
    await this.save(jobs);
    return { ok: true, job: publicJob(next), resumed };
  }

  async held(workerId, id) {
    const jobs = await this.jobs(); const j = jobs.find((x) => x.id === id);
    return { jobs, j: j && j.state === 'rendering' && j.lease?.worker_id === workerId ? j : null, gone: j?.state === 'cancelled' };
  }

  /** Worker: alive. Extends the lease on the job it holds; tells it to stop if the owner cancelled it. */
  async heartbeat(workerId, info = {}) {
    await this.touchWorker(workerId, info);
    if (!info.job_id) return { ok: true };
    const { jobs, j, gone } = await this.held(workerId, info.job_id);
    if (!j) return { ok: true, stop: true, reason: gone ? 'cancelled by the owner' : 'this worker no longer holds the job' };
    j.lease.expires_ms = this.now() + LEASE_MS; await this.save(jobs);
    return { ok: true, stop: false };
  }

  async progress(workerId, body = {}) {
    const { jobs, j } = await this.held(workerId, String(body.job_id || ''));
    if (!j) return { ok: false, detail: 'This worker does not hold that job.' };
    const done = cleanViews(body.views_done || []).filter((v) => j.views.includes(v));
    j.progress = { views_done: done, current_view: Number.isInteger(body.current_view) ? body.current_view : null,
      message: String(body.message || '').slice(0, 200), pct: Math.round((100 * done.length) / j.views.length) };
    j.lease.expires_ms = this.now() + LEASE_MS; j.updated_at = iso(this.now());
    await this.save(jobs);
    return { ok: true };
  }

  /** Worker: one view's picture, stored in CHE's media library (Creation Room) with its GPU provenance. */
  async preview(env, workerId, id, view, bytes) {
    const { jobs, j } = await this.held(workerId, id);
    if (!j) return { ok: false, detail: 'This worker does not hold that job.' };
    if (!j.views.includes(view)) return { ok: false, detail: 'That view is not part of this job.' };
    if (!bytes?.length || bytes.length > MAX_PREVIEW_BYTES) return { ok: false, detail: 'The picture is empty or larger than 4 MB.' };
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return { ok: false, detail: 'Only PNG pictures are accepted.' };
    const name = VIEW_NAMES[view] || `${view} degrees`;
    const item = await saveRenderedImage(env, this.storage, {
      bytes, title: `${j.title.replace(/:.*$/, '')}: ${name} (Colab T4 GPU)`, prompt: `GPU face preview ${j.id}, view ${view}`,
      provenance: `Rendered with Blender Cycles on the owner's Colab GPU, job ${j.id}`, engine: 'blender-cycles-gpu', source: 'colab_gpu', mode: 'gpu_render',
    });
    j.previews = { ...(j.previews || {}), [view]: item.id };
    note(j, this.now(), j.state, `Preview ${name} arrived.`);
    await this.save(jobs);
    return { ok: true, media_id: item.id };
  }

  /** Worker: the job's 3D model (GLB v2, at most 16 MB), stored in CHE's media store as soon as Blender exported it. */
  async model(env, workerId, id, bytes) {
    const { jobs, j } = await this.held(workerId, id);
    if (!j) return { ok: false, detail: 'This worker does not hold that job.' };
    if (!bytes?.length || bytes.length > MAX_MODEL_BYTES) return { ok: false, detail: 'The model is empty or larger than 16 MB.' };
    if (!isGlb(bytes)) return { ok: false, detail: 'Only GLB (glTF 2.0 binary) models are accepted.' };
    const key = modelKey(j.id);
    const saved = await mediaStore(env, this.storage).put(key, bytes, { contentType: 'model/gltf-binary' });
    if (!saved.ok) return { ok: false, detail: saved.error || 'The model could not be stored.' };
    const t = this.now(); const kb = Math.round(bytes.length / 1024);
    j.model = { key, bytes: bytes.length, sha256: await sha256Hex(bytes), uploaded_at: iso(t) };
    j.progress = { ...(j.progress || {}), message: `Geometry ready: the 3D model arrived (${kb} KB). Renders continue.` };
    j.lease.expires_ms = t + LEASE_MS;
    note(j, t, j.state, `Geometry ready: the 3D model arrived (${kb} KB). Renders continue.`);
    await this.save(jobs);
    return { ok: true, bytes: bytes.length, sha256: j.model.sha256 };
  }

  /** Owner: the stored GLB bytes of a job, or null. */
  async modelBytes(env, id) {
    const j = (await this.jobs()).find((x) => x.id === id);
    if (!j?.model?.key) return null;
    const got = await mediaStore(env, this.storage).get(j.model.key);
    return got?.body?.length ? got.body : null;
  }

  /** Worker: the job's outcome. "completed" only with a complete GPU receipt and every preview uploaded. */
  async complete(workerId, body = {}) {
    const { jobs, j } = await this.held(workerId, String(body.job_id || ''));
    if (!j) return { ok: false, detail: 'This worker does not hold that job.' };
    const t = this.now(); const r = body.receipt && typeof body.receipt === 'object' ? body.receipt : null;
    j.lease = null; j.drive_path = String(body.drive_path || '').slice(0, 300) || j.drive_path || null;
    if (r) j.receipt = trimReceipt(r);
    const status = String(body.status || '');
    if (status === 'gpu_unavailable') {
      note(j, t, 'queued', 'The Colab session had no GPU; waiting for a session with the T4. Nothing rendered on a CPU.');
    } else if (status === 'complete') {
      const views = r?.views || {};
      const bad = j.views.filter((v) => views[v]?.status !== 'ok' || !GPU_DEVICE.test(String(views[v]?.device || '')) || !j.previews?.[v]);
      // A person model is complete only with its 3D model uploaded and named in the receipt with the same hash.
      const modelBad = j.kind === 'person_model' && !(j.model && r?.model?.status === 'ok' && r.model.sha256 === j.model.sha256);
      if (r?.status !== 'complete' || bad.length || modelBad) {
        j.failures += 1;
        const why = [bad.length || r?.status !== 'complete' ? `view${bad.length === 1 ? '' : 's'} ${bad.join(', ') || '?'} lack a GPU receipt or an uploaded picture` : '',
          modelBad ? 'the 3D model was not uploaded or does not match the receipt' : ''].filter(Boolean).join('; ');
        note(j, t, j.failures >= MAX_FAILURES ? 'failed' : 'queued', `Not accepted as complete: ${why}.`);
      } else {
        j.progress = { views_done: [...j.views], message: 'All views rendered on the GPU.', pct: 100 };
        note(j, t, 'completed', `Rendered on ${String(r.nvidia_smi || r.cycles_gpus || 'the GPU').slice(0, 80)} with ${String(r.blender_version || 'Blender').slice(0, 40)}.`);
      }
    } else {
      j.failures += 1; j.error = String(body.error || status || 'render failed').slice(0, 300);
      const final = status === 'checks_failed' || j.failures >= MAX_FAILURES;
      note(j, t, final ? 'failed' : 'queued', `${status === 'checks_failed' ? 'A face check failed before rendering' : 'The render failed'}: ${j.error}${final ? '' : ' Trying once more next time.'}`);
    }
    await this.save(jobs);
    return { ok: true, job: publicJob(j) };
  }
}

function trimReceipt(r) {
  const keep = ['job_id', 'status', 'nvidia_smi', 'device', 'cycles_gpus', 'render_device_line', 'blender_version', 'samples', 'long_edge_px', 'face_code_sha256', 'created_at', 'finished_at', 'process_seconds', 'last_run'];
  const out = {};
  for (const k of keep) if (r[k] !== undefined) out[k] = typeof r[k] === 'string' ? r[k].slice(0, 300) : r[k];
  if (r.model && typeof r.model === 'object') {
    const m = r.model;
    out.model = { status: String(m.status || ''), file: String(m.file || '').slice(0, 120), sha256: String(m.sha256 || '').slice(0, 64), bytes: Number(m.bytes) || 0,
      vertices: Number(m.vertices) || 0, exported_at: String(m.exported_at || '').slice(0, 40), contents: String(m.contents || '').slice(0, 200) };
  }
  out.views = {};
  for (const [v, info] of Object.entries(r.views || {}).slice(0, 8)) {
    out.views[v] = { status: String(info?.status || ''), name: String(info?.name || ''), device: String(info?.device || '').slice(0, 200),
      render_seconds: Number(info?.render_seconds) || 0, sha256: String(info?.sha256 || '').slice(0, 64), rendered_at: String(info?.rendered_at || '') };
  }
  return out;
}

export function publicJob(j) {
  const { lease, ...rest } = j;
  const model = j.model ? { bytes: j.model.bytes, sha256: j.model.sha256, uploaded_at: j.model.uploaded_at, url: `/api/gpu/jobs/${j.id}/model.glb` } : null;
  return { ...rest, kind: j.kind || 'face_preview', model, worker_id: lease?.worker_id || null, lease_expires: lease ? iso(lease.expires_ms) : null };
}

/** One sentence for the Creation Room's Read button and for chat. */
export function speakGpuSummary(view) {
  const c = view.counts || {};
  const online = view.workers.filter((w) => w.online);
  const parts = [];
  for (const [state, word] of [['rendering', 'rendering'], ['queued', 'queued'], ['paused', 'paused until your next Colab session'], ['completed', 'completed'], ['failed', 'failed']]) {
    if (c[state]) parts.push(`${c[state]} ${word}`);
  }
  const gpu = online.length ? `Your Colab GPU worker is online on ${online[0].gpu || 'a GPU'}.` : 'No Colab GPU session is open right now; jobs wait until you run the notebook.';
  return `GPU jobs: ${parts.length ? parts.join(', ') : 'none yet'}. ${gpu}${view.worker_paired ? '' : ' The Colab worker is not paired yet.'} It costs nothing.`;
}

/**
 * The worker's routes (/api/gpu/worker/*), opened only by the paired worker token in X-CHE-GPU-Token. Reads its own
 * body (previews are binary), so it runs before the JSON body is parsed. Returns null for other paths.
 */
export async function gpuWorkerRoute({ storage, env, now }, path, request) {
  const m = /^\/api\/gpu\/worker\/(heartbeat|claim|progress|preview|model|complete)$/.exec(path);
  if (!m) return null;
  const q = new GpuQueue(storage, now);
  if (!(await q.tokenOpens(request.headers.get('X-CHE-GPU-Token')))) return json({ detail: 'Not found.' }, 404);
  const url = new URL(request.url);
  if (m[1] === 'preview') {
    if (request.method !== 'PUT') return json({ detail: 'Use PUT.' }, 405);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const out = await q.preview(env, String(url.searchParams.get('worker') || ''), String(url.searchParams.get('job') || ''), Number(url.searchParams.get('view')), bytes);
    return json(out, out.ok ? 200 : 409);
  }
  if (m[1] === 'model') {
    if (request.method !== 'PUT') return json({ detail: 'Use PUT.' }, 405);
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_MODEL_BYTES) return json({ ok: false, detail: 'The model is larger than 16 MB.' }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const out = await q.model(env, String(url.searchParams.get('worker') || ''), String(url.searchParams.get('job') || ''), bytes);
    return json(out, out.ok ? 200 : 409);
  }
  if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
  const body = await request.json().catch(() => ({}));
  const worker = String(body.worker_id || '').slice(0, 64);
  if (!/^[\w.-]{4,64}$/.test(worker)) return json({ detail: 'worker_id is required.' }, 400);
  const out = m[1] === 'heartbeat' ? await q.heartbeat(worker, body)
    : m[1] === 'claim' ? await q.claim(worker, body)
      : m[1] === 'progress' ? await q.progress(worker, body)
        : await q.complete(worker, body);
  return json(out, out.ok ? 200 : 409);
}

/** The owner's routes (/api/gpu, /api/gpu/jobs, /api/gpu/jobs/cancel|retry, /api/gpu/jobs/<id>/model.glb, /api/gpu/worker-token[/revoke], /api/gpu/identities*). */
export async function gpuOwnerRoute({ storage, env = {}, now }, path, request, body) {
  if (path !== '/api/gpu' && !path.startsWith('/api/gpu/')) return null;
  const q = new GpuQueue(storage, now);
  const glb = /^\/api\/gpu\/jobs\/(gpu_[a-f0-9]{12})\/model\.glb$/.exec(path);
  if (glb && request.method === 'GET') {
    const bytes = await q.modelBytes(env, glb[1]);
    if (!bytes) return json({ detail: 'No 3D model for that job yet.' }, 404);
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, max-age=3600' } });
  }
  if (path === '/api/gpu' && request.method === 'GET') { const v = await q.view(); return json({ ...v, spoken: speakGpuSummary(v) }); }
  const ident = await identityRoute(storage, q, path, request, body);
  if (ident) return ident;
  if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
  if (path === '/api/gpu/jobs') { const out = await q.enqueue(body || {}); return json(out, out.ok ? 202 : 422); }
  const act = /^\/api\/gpu\/jobs\/(cancel|retry)$/.exec(path);
  if (act) { const out = await q.control(act[1], String(body?.id || '')); return json(out, out.ok ? 200 : 409); }
  if (path === '/api/gpu/worker-token') {
    return json({ ok: true, token: await q.createToken(), note: 'Shown once. Save it in Colab as the secret CHE_GPU_TOKEN. Creating a new one replaces it.' });
  }
  if (path === '/api/gpu/worker-token/revoke') return json({ ok: await q.revokeToken() });
  return json({ detail: 'Unknown GPU route.' }, 404);
}
