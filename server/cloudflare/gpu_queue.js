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
//
// Creation Engine (owner, 2026-10-24: "she carries out the entire job"): a second worker class, `github_cpu`, is the
// che-creation-worker.yml run CHE starts herself (creation_orchestrator.js) on a free GitHub-hosted CPU runner (the
// repository is public). It proves itself with GitHub's OIDC ID token (gpu_oidc.js), never a stored secret, and its
// worker_id is gha-<run_id>-<n> from that token. Jobs say what compute they need (requires.gpu: required for face
// previews, preferred for person models, none): a CPU worker takes a preferred job only while no GPU worker is online,
// and its output is labelled CPU everywhere, never GPU. Progress carries stage checkpoints (model, rig, animate,
// verify, render, save); a resuming worker downloads the uploaded GLB and skips finished stages. A lapsed lease
// pauses the job for ANY compatible worker; a failed attempt re-queues it (3 attempts) with its checkpoints kept.
import { admit, fairOrder } from './job_quota.js';
import { BUILT_IN, STYLES, STYLE_LABELS, identityRoute, toSettings } from './avatar_identity.js';
import { saveRenderedImage } from './media.js';
import { mediaStore, sha256Hex } from './che_media_store.js';
import { verifyGithubOidc } from './gpu_oidc.js';
import { ensureCapacity } from './creation_orchestrator.js';
import { verifyLine } from './creation_objects.js';

const RATE_KEY = 'gpu:rate';            // per-tenant token buckets for new jobs (job_quota.js rateLimit)
export const LEASE_MS = 3 * 60_000;           // a claimed job pauses after 3 minutes without a heartbeat
export const ONLINE_MS = 90_000;              // a worker counts as online for 90 s after its last heartbeat
export const MAX_FAILURES = 3;                // attempts: a failed run re-queues the job until the third failure
export const MAX_JOBS = 200;
export const MAX_WAITING = 500;         // queued + paused jobs one queue shard holds; beyond it new jobs are refused
const LIVE_STATES = new Set(['queued', 'paused', 'rendering']);
/** Never drops a job that is waiting or running: only finished ones beyond MAX_JOBS, oldest first. */
export function keepJobs(jobs) {
  const finished = jobs.filter((j) => !LIVE_STATES.has(j.state));
  const drop = new Set(finished.slice(0, Math.max(0, jobs.length - MAX_JOBS)).map((j) => j.id));
  return drop.size ? jobs.filter((j) => !drop.has(j.id)) : jobs;
}
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
export const MAX_MODEL_BYTES = 16 * 1024 * 1024;
// face_preview: pictures only. person_model (Live Studio, creation_studio.js): the same pictures plus the 3D model
// (a GLB the worker exports from the same Blender build, uploaded the moment it exists, before the renders finish).
// object_model and room_model (Create Object, Create Room; creation_objects.js): a procedural GLB any worker may build,
// CPU included (requires.gpu none), complete only with the model uploaded and its measurement (receipt.model.verify).
// invention_model (invention_visuals.js): an invention's refined Blender model from the same named parts as the
// Worker's instant box-parts placeholder; built, measured and rendered like an object (scripts/che_creation_job.py).
export const JOB_KINDS = ['face_preview', 'person_model', 'object_model', 'room_model', 'invention_model'];
export const MODEL_KINDS = ['person_model', 'object_model', 'room_model', 'invention_model'];
// The kinds built by scripts/che_creation_job.py: a measured procedural GLB (receipt.model.verify) and previews.
export const THING_KINDS = ['object_model', 'room_model', 'invention_model'];
const DEFAULT_NEED = { person_model: 'preferred', object_model: 'none', room_model: 'none', invention_model: 'none' };
/** What compute a job needs: its own requires.gpu, else its kind's default (face previews need a GPU). */
export const needOf = (j) => j?.requires?.gpu || DEFAULT_NEED[j?.kind] || 'required';
export const VIEW_NAMES = { 0: 'front', 45: 'three-quarter', 90: 'side' };
const GPU_DEVICE = /^DEVICE (OPTIX|CUDA) \[.+\]/;
const CPU_DEVICE = /^DEVICE CPU\b/;
export const STAGES = ['model', 'rig', 'animate', 'verify', 'render', 'save'];
export const PRIORITIES = { high: 0, normal: 1, low: 2 };
export const GPU_NEEDS = ['required', 'preferred', 'none'];
export const WORKER_CLASSES = ['colab', 'github_cpu'];
export const ENGINE_KEY = 'gpu:engine';
export const DEFAULT_ENGINE_SETTINGS = Object.freeze({ auto_cloud: true, max_cloud_workers: 3, spend_limit_usd: 0 });
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
    if (/^[A-Z][A-Z0-9_]{0,31}$/.test(k) && ['string', 'number'].includes(typeof v) && String(v).length <= (k === 'FACE' ? 1200 : k === 'SPEC' ? 12000 : 400)) out[k] = String(v);
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
// Files a job exports beside its GLB (tools/avatar_body/roblox_export.py): the Roblox R15 character and its walk clip.
export const EXPORT_FORMATS = { fbx_r15: 'Roblox R15 character (FBX)', fbx_r15_walk: 'Roblox R15 walk animation (FBX)' };
const exportKey = (id, format) => `gpu/exports/${id}/${format}.fbx`;
const FBX_MAGIC = 'Kaydara FBX Binary';
export function isFbx(bytes) { return bytes?.length > 27 && new TextDecoder().decode(bytes.subarray(0, FBX_MAGIC.length)) === FBX_MAGIC; }

function note(job, now, state, text) {
  job.state = state; job.updated_at = iso(now);
  job.history = [...(job.history || []), { at: iso(now), state, note: String(text).slice(0, 300) }].slice(-20);
}

/** A rendering job whose worker stopped heartbeating is paused, not failed: any compatible worker resumes it. */
function settle(jobs, now) {
  let changed = false;
  for (const j of jobs) {
    if (j.state === 'rendering' && (!j.lease || j.lease.expires_ms <= now)) {
      const who = j.lease?.class === 'github_cpu' ? 'The GitHub cloud worker' : 'The Colab session';
      note(j, now, 'paused', `${who} stopped answering (last heartbeat ${j.lease ? iso(j.lease.expires_ms - LEASE_MS) : 'unknown'}). The next compatible worker resumes it; finished views and checkpoints are kept.`);
      j.lease = null; changed = true;
    }
  }
  return changed;
}

/** The Creation Engine settings (owner): automatic cloud workers, how many at once, and the spending limit ($0, fixed). */
export async function engineRecord(storage) { return (await storage.get(ENGINE_KEY)) || {}; }
export function engineSettingsOf(rec) {
  const s = { ...DEFAULT_ENGINE_SETTINGS, ...(rec?.settings || {}) };
  const n = Math.round(Number(s.max_cloud_workers));
  return { auto_cloud: s.auto_cloud !== false, max_cloud_workers: Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 3, spend_limit_usd: 0 };
}

const isGpuWorker = (w) => w?.class !== 'github_cpu' && isGpuName(w?.gpu);
/** Whether a worker of this kind may take the job now (a CPU worker takes a GPU-preferred job only with no GPU online). */
export function compatible(j, gpuWorker, gpuOnline) {
  const need = needOf(j);
  return need === 'none' || gpuWorker || (need === 'preferred' && !gpuOnline);
}
const waiting = (j) => (j.state === 'queued' || j.state === 'paused') && !j.owner_paused;
/** Claim order: owner priority first, then a paused job (it has finished work to keep), then the oldest. */
export function claimOrder(a, b) {
  return (PRIORITIES[a.priority] ?? 1) - (PRIORITIES[b.priority] ?? 1) || (a.state === 'paused' ? 0 : 1) - (b.state === 'paused' ? 0 : 1)
    || String(a.created_at).localeCompare(String(b.created_at));
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
    if (settle(jobs, this.now())) { this.paused = true; await this.save(jobs); }
    return jobs;
  }

  /** Keeps every queued, paused and rendering job; only the oldest finished jobs are trimmed past MAX_JOBS. */
  async save(jobs) { await this.storage.put(JOBS_KEY, keepJobs(jobs)); }

  newJob(spec, t) {
    const id = `gpu_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const job = {
      id, kind: JOB_KINDS.includes(spec.kind) ? spec.kind : 'face_preview', title: String(spec.title || 'Face preview').slice(0, 120), views: cleanViews(spec.views),
      settings: cleanSettings(spec.settings), samples: Math.min(Math.max(Number(spec.samples) || 64, 1), 1024),
      res: Math.min(Math.max(Number(spec.res) || 480, 64), 2048), queued_by: String(spec.queued_by || 'owner').slice(0, 60),
      tenant_id: /^[a-z0-9_-]{1,64}$/i.test(String(spec.tenant_id || '')) ? String(spec.tenant_id) : 'owner',
      created_at: iso(t), updated_at: iso(t), state: 'queued', failures: 0, sessions: 0, lease: null,
      priority: PRIORITIES[spec.priority] !== undefined ? spec.priority : 'normal',
      requires: { gpu: GPU_NEEDS.includes(spec.requires?.gpu) ? spec.requires.gpu : needOf({ kind: spec.kind }) },
      progress: { views_done: [], message: MODEL_KINDS.includes(spec.kind) ? 'Waiting for a Creation Engine worker.' : 'Waiting for your Colab GPU session.' },
      previews: {}, model: null, receipt: null, checkpoints: {}, cloud: null, history: [],
    };
    note(job, t, 'queued', job.requires.gpu === 'required' ? 'Queued. It renders the next time your Colab T4 notebook runs.'
      : 'Queued for the Creation Engine: a GPU worker if one is online, otherwise a free GitHub cloud CPU worker.');
    return job;
  }

  /** Owner: queue a face preview. The same settings and views already waiting or rendering are not queued twice. */
  async enqueue(spec) {
    const jobs = await this.jobs();
    const probe = this.newJob(spec, this.now());
    if (!probe.views.length) return { ok: false, detail: 'Name at least one view (0 front, 45 three-quarter, 90 side).' };
    const same = jobs.find((j) => ['queued', 'paused', 'rendering'].includes(j.state)
      && (j.kind || 'face_preview') === probe.kind && (j.requires?.gpu || probe.requires.gpu) === probe.requires.gpu && JSON.stringify(j.settings) === JSON.stringify(probe.settings) && j.views.join() === probe.views.join() && j.samples === probe.samples && j.res === probe.res);
    if (same) return { ok: true, job: same, duplicate: true };
    const live = jobs.filter((j) => j.state === 'queued' || j.state === 'paused').length;
    if (live >= MAX_WAITING) return { ok: false, limited: true, detail: `The Creation Engine already has ${live} jobs waiting, the most it holds. Nothing was queued and nothing was removed; try again when some finish.` };
    // Per-tenant limits before anything is queued (job_quota.js): queued jobs, rate, spending gate.
    const gate = admit({ minutes: 0 }, { jobs, tenant: probe.tenant_id, bucket: (await this.storage.get(RATE_KEY))?.[probe.tenant_id], now: this.now() });
    if (!gate.ok) return { ok: false, detail: gate.reason, limited: true };
    await this.storage.put(RATE_KEY, { ...((await this.storage.get(RATE_KEY)) || {}), [probe.tenant_id]: gate.bucket });
    jobs.push(probe); await this.save(jobs);
    return { ok: true, job: probe };
  }

  async control(action, id) {
    const jobs = await this.jobs(); const j = jobs.find((x) => x.id === id);
    if (!j) return { ok: false, detail: 'No such GPU job.' };
    const t = this.now();
    if (action === 'cancel') {
      if (['completed', 'failed', 'cancelled'].includes(j.state)) return { ok: false, detail: `That job is already ${j.state}.` };
      // A running job: its worker reads the cancel at its next heartbeat and stops Blender (che_gpu_worker.py stop_group).
      const was = j.state === 'rendering' && j.lease ? workerName(j) : '';
      note(j, t, 'cancelled', was ? `Cancelled by the owner while the ${was} was building it; that worker is told to stop at its next heartbeat.` : 'Cancelled by the owner.');
      j.cancelled_worker = was || null; j.lease = null;
    } else if (action === 'retry') {
      if (!['failed', 'cancelled'].includes(j.state)) return { ok: false, detail: `Only a failed or cancelled job can be retried; this one is ${j.state}.` };
      j.failures = 0; note(j, t, 'queued', 'Queued again by the owner. Finished views in Drive are reused.');
    } else if (action === 'pause') {
      // Owner pause: no worker claims it until resume; a rendering worker is told to stop at its next heartbeat and the
      // finished stages stay as checkpoints.
      if (!['queued', 'paused', 'rendering'].includes(j.state)) return { ok: false, detail: `Only a waiting or running job can be paused; this one is ${j.state}.` };
      if (j.owner_paused) return { ok: false, detail: 'That job is already paused.' };
      j.owner_paused = true; j.lease = null; j.cloud = null; note(j, t, 'paused', 'Paused by the owner. Finished stages are kept; say resume to continue.');
    } else if (action === 'resume') {
      if (!j.owner_paused) return { ok: false, detail: `That job is not paused; it is ${j.state}.` };
      j.owner_paused = false; note(j, t, 'queued', 'Resumed by the owner. Finished stages are reused.');
    } else return { ok: false, detail: 'Unknown action.' };
    await this.save(jobs);
    return { ok: true, job: j };
  }

  async workers() { return (await this.storage.get(WORKERS_KEY)) || {}; }

  /** What the Creation Room shows. */
  async view() {
    const jobs = await this.jobs(); const workers = await this.workers(); const t = this.now();
    const list = Object.entries(workers).map(([id, w]) => ({ id, ...w, class: w.class || 'colab', device: w.device || w.gpu || null,
      job_id: jobs.find((j) => j.state === 'rendering' && j.lease?.worker_id === id)?.id || null,
      online: t - (w.last_seen_ms || 0) < ONLINE_MS, last_seen: w.last_seen_ms ? iso(w.last_seen_ms) : null }));
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
    const cls = WORKER_CLASSES.includes(info.class) ? info.class : (w.class || 'colab');
    const num = (x, d) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.min(Number(x), 4096) : d);
    workers[workerId] = { ...w, class: cls, gpu: String(info.gpu || w.gpu || '').slice(0, 120), blender: String(info.blender || w.blender || '').slice(0, 60),
      device: cls === 'github_cpu' ? 'cpu' : String(info.gpu || w.gpu || info.device || '').slice(0, 120),
      cores: num(info.cores, w.cores || null), ram_gb: num(info.ram_gb, w.ram_gb || null),
      job_id: info.job_id !== undefined ? (String(info.job_id || '').slice(0, 40) || null) : (w.job_id || null),
      state: String(info.state || 'idle').slice(0, 40), last_seen_ms: t };
    const ids = Object.keys(workers).sort((a, b) => workers[b].last_seen_ms - workers[a].last_seen_ms);
    for (const old of ids.slice(10)) delete workers[old];
    await this.storage.put(WORKERS_KEY, workers);
  }

  /**
   * Worker: the next job it may take (one at a time): owner priority, then paused (resume), then the oldest.
   * A Colab worker must name a GPU (nvidia-smi); a github_cpu worker (OIDC) takes only jobs that allow a CPU, and at
   * most max_cloud_workers of them work at once. The reply carries the job's checkpoints and, when a model was
   * uploaded, model_url for the resuming worker to download it and skip the finished stages.
   */
  async claim(workerId, info = {}, auth = { class: 'colab' }) {
    const cls = auth.class === 'github_cpu' ? 'github_cpu' : 'colab';
    if (cls === 'colab' && !isGpuName(info.gpu)) return { ok: false, detail: 'No GPU reported; a Colab worker without a GPU is handed nothing.' };
    await this.touchWorker(workerId, { ...info, class: cls, state: 'claiming' });
    const jobs = await this.jobs(); const t = this.now(); const workers = await this.workers();
    const mine = jobs.find((j) => j.state === 'rendering' && j.lease?.worker_id === workerId);
    let next = mine;
    if (!next) {
      if (cls === 'github_cpu') {
        const max = engineSettingsOf(await engineRecord(this.storage)).max_cloud_workers;
        const busy = jobs.filter((j) => j.state === 'rendering' && j.lease?.class === 'github_cpu').length;
        if (busy >= max) return { ok: true, job: null, detail: `${busy} cloud workers are already busy (the limit is ${max}).` };
      }
      const gpuOnline = Object.entries(workers).some(([id, w]) => id !== workerId && isGpuWorker(w) && t - (w.last_seen_ms || 0) < ONLINE_MS);
      // Fair across tenants (job_quota.js): priority, then least recent use per plan weight, then paused, then oldest.
      next = jobs.filter((j) => waiting(j) && compatible(j, cls === 'colab', gpuOnline)).sort(fairOrder(jobs, t))[0];
    }
    if (!next) return { ok: true, job: null };
    const resumed = next.state === 'paused' || Boolean(!mine && Object.keys(next.checkpoints || {}).length);
    const device = cls === 'github_cpu' ? 'cpu' : String(info.gpu).slice(0, 60);
    next.lease = { worker_id: workerId, expires_ms: t + LEASE_MS, class: cls, device }; next.sessions = (next.sessions || 0) + (mine ? 0 : 1);
    next.cloud = null;
    next.progress = { ...(next.progress || {}), message: resumed ? 'Resuming: finished views and stages are reused.' : cls === 'github_cpu' ? 'Starting on a GitHub cloud CPU.' : 'Starting on the GPU.' };
    if (!mine) {
      const on = cls === 'github_cpu' ? `the GitHub cloud CPU worker${info.cores ? ` (${Number(info.cores)} cores${info.ram_gb ? `, ${Number(info.ram_gb)} GB` : ''})` : ''}`
        : `the Colab worker on ${String(info.gpu).slice(0, 60)}`;
      note(next, t, 'rendering', `${resumed ? 'Resumed' : 'Claimed'} by ${on}.`);
    }
    await this.save(jobs);
    await this.touchWorker(workerId, { class: cls, state: 'working', job_id: next.id });
    const job = publicJob(next);
    job.checkpoints = { ...(next.checkpoints || {}) };
    job.model_url = next.model ? `/api/gpu/worker/model?worker=${encodeURIComponent(workerId)}&job=${next.id}` : null;
    return { ok: true, job, resumed };
  }

  async held(workerId, id) {
    const jobs = await this.jobs(); const j = jobs.find((x) => x.id === id);
    return { jobs, j: j && j.state === 'rendering' && j.lease?.worker_id === workerId ? j : null, gone: j?.state === 'cancelled', paused: Boolean(j?.owner_paused) };
  }

  /** Worker: alive. Extends the lease on the job it holds; tells it to stop if the owner cancelled it. */
  async heartbeat(workerId, info = {}) {
    await this.touchWorker(workerId, info);
    if (!info.job_id) return { ok: true };
    const { jobs, j, gone, paused } = await this.held(workerId, info.job_id);
    if (!j && gone) {
      // The worker heard the cancel: recorded once, so "stop the job" can report that the worker really stopped.
      const c = jobs.find((x) => x.id === info.job_id);
      if (c && !c.stop_confirmed_at) {
        c.stop_confirmed_at = iso(this.now());
        c.history = [...(c.history || []), { at: c.stop_confirmed_at, state: 'cancelled', note: `Worker ${String(workerId).slice(0, 64)} received the stop and is ending its Blender process.` }].slice(-20);
        await this.save(jobs);
      }
    }
    if (!j) return { ok: true, stop: true, reason: gone ? 'cancelled by the owner' : paused ? 'paused by the owner' : 'this worker no longer holds the job' };
    j.lease.expires_ms = this.now() + LEASE_MS; await this.save(jobs);
    return { ok: true, stop: false };
  }

  async progress(workerId, body = {}) {
    const { jobs, j } = await this.held(workerId, String(body.job_id || ''));
    if (!j) return { ok: false, detail: 'This worker does not hold that job.' };
    const done = cleanViews(body.views_done || []).filter((v) => j.views.includes(v));
    const stage = STAGES.includes(body.stage) ? body.stage : (j.progress?.stage || null);
    const pct = Number.isFinite(Number(body.pct)) && body.pct !== null && body.pct !== '' ? Math.round(Math.min(100, Math.max(0, Number(body.pct)))) : Math.round((100 * done.length) / j.views.length);
    j.progress = { views_done: done, current_view: Number.isInteger(body.current_view) ? body.current_view : null,
      message: String(body.message || '').slice(0, 200), pct, stage };
    // A finished stage's artifact (the GLB for model, rig and animate): kept per stage, newest wins, so a resuming
    // worker can skip what is done. Only the hash and size are stored; the bytes are the uploaded model.
    const c = body.checkpoint;
    if (c && typeof c === 'object' && STAGES.includes(c.stage) && /^[a-f0-9]{64}$/.test(String(c.sha256 || ''))) {
      j.checkpoints = { ...(j.checkpoints || {}), [c.stage]: { sha256: String(c.sha256), bytes: Math.max(0, Number(c.bytes) || 0), at: iso(this.now()) } };
      note(j, this.now(), j.state, `Checkpoint: ${c.stage} finished.`);
    }
    j.lease.expires_ms = this.now() + LEASE_MS; j.updated_at = iso(this.now());
    await this.save(jobs);
    return { ok: true };
  }

  /** Worker: one view's picture, stored in CHE's media library (Creation Room) with its GPU provenance. A quick look
   * (quick: the fast preview rendered before the final view) is kept apart in quick_previews: it is shown while the
   * final view renders and never counts as that view. */
  async preview(env, workerId, id, view, bytes, { quick = false } = {}) {
    const { jobs, j } = await this.held(workerId, id);
    if (!j) return { ok: false, detail: 'This worker does not hold that job.' };
    if (!j.views.includes(view)) return { ok: false, detail: 'That view is not part of this job.' };
    if (!bytes?.length || bytes.length > MAX_PREVIEW_BYTES) return { ok: false, detail: 'The picture is empty or larger than 4 MB.' };
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return { ok: false, detail: 'Only PNG pictures are accepted.' };
    const name = VIEW_NAMES[view] || `${view} degrees`;
    // Labelled by the compute that holds the job: CPU output is never called GPU.
    const cpu = j.lease?.class === 'github_cpu';
    if (quick) {
      const on = cpu ? 'GitHub cloud CPU' : 'Colab GPU';
      const item = await saveRenderedImage(env, this.storage, {
        bytes, title: `${j.title.replace(/:.*$/, '')}: ${name} quick look (${on})`, prompt: `Quick look ${j.id}, view ${view}`,
        provenance: `Quick low-sample preview rendered with Blender on the ${on} while the final view renders, job ${j.id}`,
        engine: cpu ? 'blender-preview-cpu' : 'blender-preview-gpu', source: cpu ? 'github_cpu' : 'colab_gpu', mode: 'quick_preview',
      });
      j.quick_previews = { ...(j.quick_previews || {}), [view]: item.id };
      note(j, this.now(), j.state, `Quick look ${name} arrived; the final render continues.`);
      j.lease.expires_ms = this.now() + LEASE_MS;
      await this.save(jobs);
      return { ok: true, media_id: item.id, quick: true };
    }
    const item = await saveRenderedImage(env, this.storage, cpu ? {
      bytes, title: `${j.title.replace(/:.*$/, '')}: ${name} (GitHub cloud CPU)`, prompt: `CPU preview ${j.id}, view ${view}`,
      provenance: `Rendered with Blender Cycles on a GitHub-hosted CPU runner (che-creation-worker.yml), job ${j.id}`, engine: 'blender-cycles-cpu', source: 'github_cpu', mode: 'cpu_render',
    } : {
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

  /** Worker: an exported file (EXPORT_FORMATS: a binary FBX, at most 16 MB) for the job it holds, stored beside the GLB. */
  async exportFile(env, workerId, id, format, bytes) {
    const { jobs, j } = await this.held(workerId, id);
    if (!j) return { ok: false, detail: 'This worker does not hold that job.' };
    if (!EXPORT_FORMATS[format]) return { ok: false, detail: `Unknown export format; known: ${Object.keys(EXPORT_FORMATS).join(', ')}.` };
    if (!bytes?.length || bytes.length > MAX_MODEL_BYTES) return { ok: false, detail: 'The file is empty or larger than 16 MB.' };
    if (!isFbx(bytes)) return { ok: false, detail: 'Only binary FBX files are accepted.' };
    const key = exportKey(j.id, format);
    const saved = await mediaStore(env, this.storage).put(key, bytes, { contentType: 'application/octet-stream' });
    if (!saved.ok) return { ok: false, detail: saved.error || 'The file could not be stored.' };
    const t = this.now();
    j.exports = { ...(j.exports || {}), [format]: { key, bytes: bytes.length, sha256: await sha256Hex(bytes), uploaded_at: iso(t) } };
    j.lease.expires_ms = t + LEASE_MS;
    note(j, t, j.state, `${EXPORT_FORMATS[format]} saved (${Math.round(bytes.length / 1024)} KB).`);
    await this.save(jobs);
    return { ok: true, bytes: bytes.length, sha256: j.exports[format].sha256 };
  }

  /** Owner: an exported file's bytes, or null. */
  async exportBytes(env, id, format) {
    const j = (await this.jobs()).find((x) => x.id === id);
    const e = j?.exports?.[format];
    if (!e?.key) return null;
    const got = await mediaStore(env, this.storage).get(e.key);
    return got?.body?.length ? got.body : null;
  }

  /** Worker: the GLB it uploaded earlier for the job it now holds (a resume), or null. */
  async workerModel(env, workerId, id) {
    const { j } = await this.held(workerId, id);
    if (!j?.model?.key) return null;
    const got = await mediaStore(env, this.storage).get(j.model.key);
    return got?.body?.length ? got.body : null;
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
    const cpu = j.lease?.class === 'github_cpu'; const lease = j.lease;
    j.lease = null; j.drive_path = String(body.drive_path || '').slice(0, 300) || j.drive_path || null;
    if (r) j.receipt = trimReceipt(r);
    const status = String(body.status || '');
    if (status === 'gpu_unavailable') {
      note(j, t, 'queued', 'The Colab session had no GPU; waiting for a session with the T4. Nothing rendered on a CPU.');
    } else if (status === 'complete') {
      const views = r?.views || {};
      // Each view must name the device class of the worker that held the job: a GPU line from a Colab worker, a CPU
      // line from a cloud CPU worker (and a GPU-required job never reaches a CPU worker).
      const DEV = cpu ? CPU_DEVICE : GPU_DEVICE;
      const bad = j.views.filter((v) => views[v]?.status !== 'ok' || !DEV.test(String(views[v]?.device || '')) || !j.previews?.[v]);
      // A model job is complete only with its 3D model uploaded and named in the receipt with the same hash.
      const modelBad = MODEL_KINDS.includes(j.kind) && !(j.model && r?.model?.status === 'ok' && r.model.sha256 === j.model.sha256);
      // An object or room is complete only once the runner re-read the GLB and measured it (verify_glb.py --static):
      // meshes, triangles, materials and a bounding box matching the size asked for, of this very file.
      const v = j.receipt?.model?.verify;
      const measureBad = THING_KINDS.includes(j.kind) && !modelBad && !(v?.ok === true && v.sha256 === j.model.sha256);
      // A full-body person model also needs its skeleton verified: the runner re-imported the GLB and measured its
      // bones, weights, clips and morphs (verify_glb.py). A model that only claims to move is not accepted.
      const rigBad = j.kind === 'person_model' && wantsRig(j) && !modelBad && j.receipt?.model?.rig?.ok !== true;
      if (r?.status !== 'complete' || bad.length || modelBad || rigBad || measureBad) {
        j.failures += 1;
        const why = [bad.length || r?.status !== 'complete' ? `view${bad.length === 1 ? '' : 's'} ${bad.join(', ') || '?'} lack a ${cpu ? 'CPU' : 'GPU'} receipt or an uploaded picture` : '',
          modelBad ? 'the 3D model was not uploaded or does not match the receipt' : '',
          rigBad ? 'the full-body model has no verified skeleton and animation check' : '',
          measureBad ? 'the model was not re-read and measured (meshes, triangles, size) or did not pass' : ''].filter(Boolean).join('; ');
        note(j, t, j.failures >= MAX_FAILURES ? 'failed' : 'queued', `Not accepted as complete: ${why}.${j.failures >= MAX_FAILURES ? '' : ` Attempt ${j.failures} of ${MAX_FAILURES}; queued again.`}`);
      } else {
        const rig = j.receipt?.model?.rig;
        if (rig?.ok) {
          j.history = [...(j.history || []), { at: iso(t), state: j.state, note: `Skeleton verified: ${rigLine(rig)}.` }].slice(-20);
        }
        if (v?.ok && THING_KINDS.includes(j.kind)) {
          j.history = [...(j.history || []), { at: iso(t), state: j.state, note: `Model verified: ${verifyLine(v)}.` }].slice(-20);
        }
        const tex = texturesLine(j.receipt?.textures);
        if (tex) j.history = [...(j.history || []), { at: iso(t), state: j.state, note: tex }].slice(-20);
        const suit = j.receipt?.model?.suit;
        if (suit?.garment_vertices_after) {
          j.history = [...(j.history || []), { at: iso(t), state: j.state, note: `Suit smoothed: ${suit.garment_vertices_before} to ${suit.garment_vertices_after} garment vertices (${suit.method}).` }].slice(-20);
        }
        j.progress = { views_done: [...j.views], message: `All views rendered on the ${cpu ? 'CPU' : 'GPU'}.`, pct: 100, stage: 'save' };
        j.rendered_on = { class: cpu ? 'github_cpu' : 'colab', device: cpu ? 'CPU' : String(r.nvidia_smi || r.cycles_gpus || lease?.device || 'GPU').slice(0, 80), worker_id: lease?.worker_id || null };
        note(j, t, 'completed', cpu
          ? `Rendered on the CPU of a GitHub cloud runner${r.cores ? ` (${Number(r.cores)} cores)` : ''} with ${String(r.blender_version || 'Blender').slice(0, 40)}; worker: ${workerName(j)}.`
          : `Rendered on ${String(r.nvidia_smi || r.cycles_gpus || 'the GPU').slice(0, 80)} with ${String(r.blender_version || 'Blender').slice(0, 40)}; worker: ${workerName(j)}.`);
      }
    } else {
      // A failed run (not a failed check, not an owner cancel) re-queues the job with its checkpoints and finished
      // views kept, up to MAX_FAILURES attempts; then it fails with the real reason.
      j.failures += 1; j.error = String(body.error || status || 'render failed').slice(0, 300);
      const final = status === 'checks_failed' || j.failures >= MAX_FAILURES;
      note(j, t, final ? 'failed' : 'queued', `${status === 'checks_failed' ? (THING_KINDS.includes(j.kind) ? 'The spec or model check failed' : 'A face check failed before rendering') : 'The render failed'}: ${j.error}${final ? '' : ` Attempt ${j.failures} of ${MAX_FAILURES}; queued again with finished work kept.`}`);
    }
    await this.save(jobs);
    return { ok: true, job: publicJob(j) };
  }
}

function trimReceipt(r) {
  const keep = ['job_id', 'status', 'nvidia_smi', 'device', 'cores', 'threads', 'cycles_gpus', 'render_device_line', 'blender_version', 'samples', 'long_edge_px', 'face_code_sha256', 'created_at', 'finished_at', 'process_seconds', 'last_run', 'stage_seconds', 'render_profile'];
  const out = {};
  for (const k of keep) if (r[k] !== undefined) out[k] = typeof r[k] === 'string' ? r[k].slice(0, 300) : r[k];
  if (r.model && typeof r.model === 'object') {
    const m = r.model;
    out.model = { status: String(m.status || ''), file: String(m.file || '').slice(0, 120), sha256: String(m.sha256 || '').slice(0, 64), bytes: Number(m.bytes) || 0,
      vertices: Number(m.vertices) || 0, exported_at: String(m.exported_at || '').slice(0, 40), contents: String(m.contents || '').slice(0, 200),
      mode: ['bust', 'full_body', 'object', 'room', 'invention'].includes(m.mode) ? m.mode : '' };
    if (m.rig && typeof m.rig === 'object') out.model.rig = trimRig(m.rig);
    if (m.verify && typeof m.verify === 'object') out.model.verify = trimVerify(m.verify);
    // The suit's measured smoothing (mpfb_body.py SUIT line): garment vertices before and after, never a description.
    if (m.suit && typeof m.suit === 'object') {
      const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
      out.model.suit = { garment_vertices_before: n(m.suit.garment_vertices_before), garment_vertices_after: n(m.suit.garment_vertices_after),
        garment_faces_before: n(m.suit.garment_faces_before), garment_faces_after: n(m.suit.garment_faces_after), method: String(m.suit.method || '').slice(0, 160) };
    }
    if (m.layout && typeof m.layout === 'object') {
      const item = (x) => ({ item: String(x?.item || '').slice(0, 20), ...(x?.on ? { on: String(x.on).slice(0, 20) } : {}), ...(x?.reason ? { reason: String(x.reason).slice(0, 120) } : {}) });
      out.model.layout = { placed: (Array.isArray(m.layout.placed) ? m.layout.placed : []).slice(0, 12).map(item),
        skipped: (Array.isArray(m.layout.skipped) ? m.layout.skipped : []).slice(0, 12).map(item) };
    }
  }
  if (r.quick_previews && typeof r.quick_previews === 'object') {
    out.quick_previews = {};
    for (const [v, q] of Object.entries(r.quick_previews).slice(0, 8)) out.quick_previews[v] = { engine: String(q?.engine || '').slice(0, 40), seconds: Number(q?.seconds) || 0 };
  }
  if (r.roblox && typeof r.roblox === 'object') {
    const x = r.roblox; const list = (a, n, len) => (Array.isArray(a) ? a : []).slice(0, n).map((f) => String(f).slice(0, len));
    out.roblox = { ok: x.ok === true, studio_import_ready: x.studio_import_ready === true, marketplace_ready: x.marketplace_ready === true,
      triangles_total: Number(x.triangles_total) || 0, failures: list(x.failures, 8, 200), marketplace_missing: list(x.marketplace_missing, 6, 160),
      not_exported: list(x.not_exported, 6, 160) };
  }
  if (r.textures && typeof r.textures === 'object') out.textures = trimTextures(r.textures);
  out.views = {};
  for (const [v, info] of Object.entries(r.views || {}).slice(0, 8)) {
    out.views[v] = { status: String(info?.status || ''), name: String(info?.name || ''), device: String(info?.device || '').slice(0, 200),
      render_seconds: Number(info?.render_seconds) || 0, sha256: String(info?.sha256 || '').slice(0, 64), rendered_at: String(info?.rendered_at || '') };
  }
  return out;
}

/**
 * The CC0 textures a job fetched (tools/avatar_body/cc0_textures.py): per material, where it came from, its license and
 * each map's SHA-256 and size, or why none was used. Kept small and typed; the bytes are inside the GLB.
 */
export function trimTextures(t) {
  const out = {};
  for (const [k, v] of Object.entries(t || {}).slice(0, 8)) {
    if (!/^[a-z]{2,12}$/.test(k) || !v || typeof v !== 'object') continue;
    const maps = {};
    for (const [mk, mv] of Object.entries(v.maps || {}).slice(0, 4)) {
      if (/^[a-z]{2,12}$/.test(mk) && mv && typeof mv === 'object') maps[mk] = { sha256: String(mv.sha256 || '').slice(0, 64), bytes: Number(mv.bytes) || 0, url: String(mv.url || '').slice(0, 300) };
    }
    out[k] = { status: v.status === 'ok' ? 'ok' : 'unavailable', source: String(v.source || '').slice(0, 60), license: String(v.license || '').slice(0, 60),
      license_url: String(v.license_url || '').slice(0, 200), asset_id: String(v.asset_id || '').slice(0, 80), asset_page: String(v.asset_page || '').slice(0, 200),
      cached: v.cached === true, maps, reason: String(v.reason || '').slice(0, 200) };
  }
  return out;
}

/** "Textures: Poly Haven wood_planks (CC0 1.0)" for the completion note, or '' when the job used none. */
export function texturesLine(t) {
  const ok = Object.entries(t || {}).filter(([, v]) => v?.status === 'ok');
  const off = Object.entries(t || {}).filter(([, v]) => v?.status !== 'ok');
  if (!ok.length && !off.length) return '';
  return [ok.length ? `Textures: ${ok.map(([k, v]) => `${k} from ${v.source || 'unknown source'} ${v.asset_id} (${v.license || 'license not recorded'})`).join('; ')}.` : '',
    off.length ? `No ${off.map(([k]) => k).join(', ')} texture: ${off[0][1]?.reason || 'unavailable'}; plain colour used.` : ''].filter(Boolean).join(' ');
}

/** The static model check as the runner reported it (verify_glb.py --static), kept small and typed. */
function trimVerify(g) {
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const trio = (a) => (Array.isArray(a) ? a.slice(0, 3).map(num) : []);
  return {
    ok: g.ok === true, failures: (Array.isArray(g.failures) ? g.failures : []).slice(0, 8).map((x) => String(x).slice(0, 160)),
    meshes: num(g.meshes), primitives: num(g.primitives), vertices: num(g.vertices), triangles: num(g.triangles),
    materials: (Array.isArray(g.materials) ? g.materials : []).slice(0, 40).map((x) => String(x).slice(0, 40)),
    bbox_m: { min: trio(g.bbox_m?.min), max: trio(g.bbox_m?.max), size: trio(g.bbox_m?.size) }, expected_bbox_m: trio(g.expected_bbox_m),
    tolerance: num(g.tolerance), sha256: String(g.sha256 || '').slice(0, 64), bytes: num(g.bytes),
  };
}

/** Whether a person_model job asked for the full body (MODEL_MODE full_body, the default) and so needs a verified rig. */
export function wantsRig(j) { return j.kind === 'person_model' && (j.settings?.MODEL_MODE || 'full_body') !== 'bust'; }

/** The rig check as the runner reported it (verify_glb.py), kept small and typed. */
function trimRig(g) {
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const checks = {};
  for (const [k, v] of Object.entries(g.checks && typeof g.checks === 'object' ? g.checks : {}).slice(0, 16)) {
    // Numbers and booleans as sent; anything else as short text (a nested measurement is kept as JSON text).
    checks[String(k).slice(0, 40)] = typeof v === 'number' || typeof v === 'boolean' ? v : (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 200);
  }
  return {
    ok: g.ok === true, bones: num(g.bones), weighted_vertices: num(g.weighted_vertices),
    clips: rigClips(g.clips).map((c) => ({ name: c.name, seconds: num(c.seconds) })),
    morphs: (Array.isArray(g.morphs) ? g.morphs : []).slice(0, 32).map((x) => String(x).slice(0, 40)), checks,
  };
}

/** "53 bones, 4 clips (idle, walk, wave, talk), 5 face shapes". */
/** Clips as [{name, seconds}]: verify_glb.py writes them keyed by name ({walk: {duration_s, ...}}); an array is also accepted. */
export function rigClips(clips) {
  const list = Array.isArray(clips) ? clips
    : Object.entries(clips && typeof clips === 'object' ? clips : {}).map(([name, c]) => ({ name, seconds: c?.duration_s ?? c?.seconds }));
  return list.slice(0, 16).map((c) => ({ name: String(c?.name || '').slice(0, 40), seconds: c?.seconds ?? c?.duration_s }));
}

export function rigLine(rig) {
  const clips = rigClips(rig.clips);
  return `${rig.bones} bones, ${clips.length} clip${clips.length === 1 ? '' : 's'}${clips.length ? ` (${clips.map((c) => c.name).join(', ')})` : ''}`
    + `${rig.morphs?.length ? `, ${rig.morphs.length} face shape${rig.morphs.length === 1 ? '' : 's'}` : ''}`;
}

/**
 * The worker that holds or held a job, in words, for every notice and receipt (creation-gaps, 2026-10-25: the live
 * creation check named it "?"). A finished job has no lease, so completion's rendered_on is read too; a job no worker
 * ever held, or one recorded before workers were named, says "unknown worker", never a question mark.
 *   github_cpu gha-<run>-<attempt>  -> "free GitHub cloud CPU runner gha-123-1 (GitHub Actions run 123)"
 *   colab colab-<hash> on a T4      -> "Colab GPU worker colab-ab12 (Tesla T4)"
 */
export function workerName(j) {
  const id = String(j?.lease?.worker_id || j?.rendered_on?.worker_id || '').slice(0, 64);
  const cls = j?.lease?.class || j?.rendered_on?.class || (/^gha-/.test(id) ? 'github_cpu' : /^colab-/.test(id) ? 'colab' : '');
  if (!id && !cls) return 'unknown worker';
  if (cls === 'github_cpu') {
    const run = /^gha-(\d+)-/.exec(id)?.[1];
    return `free GitHub cloud CPU runner ${id || '(id not recorded)'}${run ? ` (GitHub Actions run ${run})` : ''}`;
  }
  const dev = String(j?.lease?.device || (j?.rendered_on?.device !== 'GPU' ? j?.rendered_on?.device : '') || '').split(',')[0].trim();
  return `Colab GPU worker ${id || '(id not recorded)'}${dev && !/^cpu$/i.test(dev) ? ` (${dev.slice(0, 60)})` : ''}`;
}

export function publicJob(j) {
  const { lease, ...rest } = j;
  const model = j.model ? { bytes: j.model.bytes, sha256: j.model.sha256, uploaded_at: j.model.uploaded_at, url: `/api/gpu/jobs/${j.id}/model.glb` } : null;
  const exports = Object.fromEntries(Object.entries(j.exports || {}).map(([f, e]) => [f, { label: EXPORT_FORMATS[f] || f, bytes: e.bytes, sha256: e.sha256,
    uploaded_at: e.uploaded_at, url: `/api/gpu/jobs/${j.id}/${f}.fbx` }]));
  const g = j.receipt?.model?.rig;
  // The rig only counts as verified once the job completed with it (the receipt's ok alone is the runner's claim).
  const rig = g ? { ok: g.ok === true && j.state === 'completed', bones: g.bones, clips: rigClips(g.clips).map((c) => c.name), morphs: g.morphs || [],
    mode: j.receipt.model.mode || null } : null;
  // The measured model (objects and rooms): counted as verified only once the job completed with it.
  const mv = j.receipt?.model?.verify;
  const measured = mv ? { ok: mv.ok === true && j.state === 'completed', line: verifyLine(mv), size_m: mv.bbox_m?.size || [], triangles: mv.triangles, materials: (mv.materials || []).length } : null;
  return { ...rest, kind: j.kind || 'face_preview', model, rig, exports, quick_previews: { ...(j.quick_previews || {}) }, worker_id: lease?.worker_id || j.rendered_on?.worker_id || null, worker_class: lease?.class || j.rendered_on?.class || null, worker_name: workerName(j),
    lease_expires: lease ? iso(lease.expires_ms) : null, priority: j.priority || 'normal', requires: { gpu: needOf(j) }, measured,
    checkpoints: { ...(j.checkpoints || {}) }, ...displayOf(j) };
}

export const DISPLAY_STATES = ['Creating', 'Waiting for Resources', 'Waiting for GPU', 'Starting a cloud worker', 'Paused', 'Completed', 'Failed', 'Cancelled'];
const hhmm = (at) => String(at || '').slice(11, 16);

/** The owner-facing state of a job and one plain sentence with its real numbers (nothing estimated or invented). */
export function displayOf(j) {
  const views = j.views?.length || 0; const done = j.progress?.views_done?.length || 0;
  const stage = j.progress?.stage ? `, stage ${STAGES.indexOf(j.progress.stage) + 1} of ${STAGES.length} (${j.progress.stage})` : '';
  const ck = Object.keys(j.checkpoints || {}); const kept = ck.length ? ` Finished stages kept: ${ck.join(', ')}.` : '';
  const attempt = j.failures ? ` Attempt ${Math.min(j.failures + 1, MAX_FAILURES)} of ${MAX_FAILURES}.` : '';
  const last = (j.history || []).at(-1);
  if (j.state === 'rendering') {
    const on = j.lease?.class === 'github_cpu' ? 'a free GitHub cloud CPU worker (slower than a GPU)' : `the Colab GPU${j.lease?.device ? ` (${j.lease.device})` : ''}`;
    return { display_state: 'Creating', status_line: `Creating on ${on}${stage}: ${done} of ${views} view${views === 1 ? '' : 's'} rendered, ${j.progress?.pct ?? 0} percent.` };
  }
  if (j.state === 'queued' || j.state === 'paused') {
    const c = j.cloud;
    if (c?.state === 'dispatching') {
      return { display_state: j.state === 'paused' ? 'Paused' : 'Starting a cloud worker',
        status_line: `${j.state === 'paused' ? 'Paused; ' : ''}CHE asked GitHub for a free cloud worker at ${hhmm(c.at)} UTC; it usually picks the job up within a few minutes.${kept}${attempt}` };
    }
    if (j.owner_paused) return { display_state: 'Paused', status_line: `Paused by you at ${hhmm(last?.at)} UTC after ${done} of ${views} views. Say resume to continue.${kept}` };
    if (j.state === 'paused') return { display_state: 'Paused', status_line: `Paused at ${hhmm(last?.at)} UTC after ${done} of ${views} views: the worker stopped answering. The next compatible worker resumes it.${kept}${c?.reason ? ` ${c.reason}` : ''}` };
    const need = needOf(j);
    const why = c?.reason || (need === 'required' ? 'This job needs a GPU: it runs when your Colab T4 notebook is open.' : 'Waiting for a worker.');
    if (c?.state === 'waiting_gpu') return { display_state: 'Waiting for GPU', status_line: `Waiting since ${hhmm(j.created_at)} UTC. ${why}${kept}${attempt}` };
    return { display_state: 'Waiting for Resources', status_line: `Waiting since ${hhmm(j.created_at)} UTC. ${why}${kept}${attempt}` };
  }
  if (j.state === 'completed') {
    const on = j.rendered_on ? `on the ${workerName(j)}` : 'on an unknown worker';
    return { display_state: 'Completed', status_line: `Completed at ${hhmm(last?.at)} UTC ${on}: ${views} view${views === 1 ? '' : 's'}${j.model ? `, a ${Math.round(j.model.bytes / 1024)} KB 3D model` : ''}.` };
  }
  if (j.state === 'failed') return { display_state: 'Failed', status_line: `Failed after ${j.failures || 0} attempt${j.failures === 1 ? '' : 's'}: ${String(last?.note || j.error || 'no reason recorded').slice(0, 200)}` };
  return { display_state: 'Cancelled', status_line: `Cancelled at ${hhmm(last?.at)} UTC.` };
}

/** One sentence for the Creation Room's Read button and for chat. */
export function speakGpuSummary(view) {
  const c = view.counts || {};
  const online = view.workers.filter((w) => w.online);
  const parts = [];
  for (const [state, word] of [['rendering', 'rendering'], ['queued', 'queued'], ['paused', 'paused until a worker resumes them'], ['completed', 'completed'], ['failed', 'failed']]) {
    if (c[state]) parts.push(`${c[state]} ${word}`);
  }
  const gpuOn = online.filter((w) => w.class !== 'github_cpu'); const cloud = online.length - gpuOn.length;
  const gpu = (gpuOn.length ? `Your Colab GPU worker is online on ${gpuOn[0].gpu || 'a GPU'}.` : 'No Colab GPU session is open right now; GPU-only jobs wait until you run the notebook.')
    + (cloud ? ` ${cloud} free GitHub cloud CPU worker${cloud === 1 ? ' is' : 's are'} online.` : '');
  return `GPU jobs: ${parts.length ? parts.join(', ') : 'none yet'}. ${gpu}${view.worker_paired ? '' : ' The Colab worker is not paired yet.'} It costs nothing.`;
}

/**
 * The worker's routes (/api/gpu/worker/*), opened only by the paired worker token in X-CHE-GPU-Token. Reads its own
 * body (previews are binary), so it runs before the JSON body is parsed. Returns null for other paths.
 */
/**
 * Who is calling a worker route: a GitHub Actions OIDC bearer from che-creation-worker.yml on main (class github_cpu,
 * worker ids gha-<run_id>-<n>) or the paired Colab token in X-CHE-GPU-Token (class colab). Null for anyone else.
 */
export async function workerAuth({ storage, env = {}, now, fetcher }, request, q) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  if (bearer) {
    const v = await verifyGithubOidc(bearer[1], env, { fetcher: fetcher || fetch, now: (now || Date.now)() });
    return v.ok ? { class: 'github_cpu', run_id: v.claims.run_id } : null;
  }
  return (await q.tokenOpens(request.headers.get('X-CHE-GPU-Token'))) ? { class: 'colab' } : null;
}

/** A worker id the caller may use: gha-<its own run id>-<n> for a cloud worker; any other id (not gha-) for Colab. */
export function workerIdOk(auth, id) {
  if (!/^[\w.-]{4,64}$/.test(id)) return false;
  if (auth.class === 'github_cpu') return new RegExp(`^gha-${auth.run_id}-\\d{1,3}$`).test(id);
  return !/^gha-/i.test(id);
}

export async function gpuWorkerRoute(ctx, path, request) {
  const m = /^\/api\/gpu\/worker\/(heartbeat|claim|progress|preview|model|export|complete)$/.exec(path);
  if (!m) return null;
  const out = await workerRouteInner(ctx, m[1], request);
  // A lease that lapsed while this request read the queue paused a job: find it a worker now (creation_orchestrator.js).
  if (out.paused) await ensureCapacity(ctx.env || {}, { storage: ctx.storage, now: ctx.now, fetcher: ctx.fetcher }).catch(() => null);
  return out.res;
}

async function workerRouteInner(ctx, route, request) {
  const { storage, env, now } = ctx;
  const q = new GpuQueue(storage, now);
  const done = (res) => ({ res, paused: q.paused });
  const auth = await workerAuth(ctx, request, q);
  if (!auth) return done(json({ detail: 'Not found.' }, 404));
  const url = new URL(request.url);
  const wid = String(url.searchParams.get('worker') || '');
  if (route === 'preview') {
    if (request.method !== 'PUT') return done(json({ detail: 'Use PUT.' }, 405));
    if (!workerIdOk(auth, wid)) return done(json({ detail: 'That worker id does not belong to this caller.' }, 403));
    const bytes = new Uint8Array(await request.arrayBuffer());
    const out = await q.preview(env, wid, String(url.searchParams.get('job') || ''), Number(url.searchParams.get('view')), bytes,
      { quick: url.searchParams.get('stage') === 'quick' });
    return done(json(out, out.ok ? 200 : 409));
  }
  if (route === 'export') {
    if (request.method !== 'PUT') return done(json({ detail: 'Use PUT.' }, 405));
    if (!workerIdOk(auth, wid)) return done(json({ detail: 'That worker id does not belong to this caller.' }, 403));
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_MODEL_BYTES) return done(json({ ok: false, detail: 'The file is larger than 16 MB.' }, 413));
    const bytes = new Uint8Array(await request.arrayBuffer());
    const out = await q.exportFile(env, wid, String(url.searchParams.get('job') || ''), String(url.searchParams.get('format') || ''), bytes);
    return done(json(out, out.ok ? 200 : 409));
  }
  if (route === 'model' && request.method === 'GET') {
    // A resuming worker downloads the GLB it (or an earlier worker) uploaded for the job it now holds.
    if (!workerIdOk(auth, wid)) return done(json({ detail: 'That worker id does not belong to this caller.' }, 403));
    const bytes = await q.workerModel(env, wid, String(url.searchParams.get('job') || ''));
    if (!bytes) return done(json({ detail: 'No 3D model for a job this worker holds.' }, 404));
    return done(new Response(bytes, { status: 200, headers: { 'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length) } }));
  }
  if (route === 'model') {
    if (request.method !== 'PUT') return done(json({ detail: 'Use PUT or GET.' }, 405));
    if (!workerIdOk(auth, wid)) return done(json({ detail: 'That worker id does not belong to this caller.' }, 403));
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_MODEL_BYTES) return done(json({ ok: false, detail: 'The model is larger than 16 MB.' }, 413));
    const bytes = new Uint8Array(await request.arrayBuffer());
    const out = await q.model(env, wid, String(url.searchParams.get('job') || ''), bytes);
    return done(json(out, out.ok ? 200 : 409));
  }
  if (request.method !== 'POST') return done(json({ detail: 'Use POST.' }, 405));
  const body = await request.json().catch(() => ({}));
  const worker = String(body.worker_id || '').slice(0, 64);
  if (!/^[\w.-]{4,64}$/.test(worker)) return done(json({ detail: 'worker_id is required.' }, 400));
  if (!workerIdOk(auth, worker)) return done(json({ detail: auth.class === 'github_cpu' ? 'A cloud worker id is gha-<its run id>-<n>.' : 'gha- worker ids belong to cloud workers.' }, 403));
  const info = { ...body, class: auth.class };
  const out = route === 'heartbeat' ? await q.heartbeat(worker, info)
    : route === 'claim' ? await q.claim(worker, info, auth)
      : route === 'progress' ? await q.progress(worker, body)
        : await q.complete(worker, body);
  return done(json(out, out.ok ? 200 : 409));
}

/** The owner's routes (/api/gpu, /api/gpu/jobs, /api/gpu/jobs/cancel|retry, /api/gpu/jobs/<id>/model.glb, /api/gpu/jobs/<id>/<format>.fbx, /api/gpu/worker-token[/revoke], /api/gpu/identities*). */
export async function gpuOwnerRoute(ctx, path, request, body) {
  const { storage, env = {}, now } = ctx;
  if (path !== '/api/gpu' && !path.startsWith('/api/gpu/')) return null;
  const q = new GpuQueue(storage, now);
  const glb = /^\/api\/gpu\/jobs\/(gpu_[a-f0-9]{12})\/model\.glb$/.exec(path);
  const fbx = /^\/api\/gpu\/jobs\/(gpu_[a-f0-9]{12})\/([a-z0-9_]{1,24})\.fbx$/.exec(path);
  if (fbx && request.method === 'GET') {
    const bytes = await q.exportBytes(env, fbx[1], fbx[2]);
    if (!bytes) return json({ detail: 'No such export for that job.' }, 404);
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="${fbx[1]}_${fbx[2]}.fbx"`, 'Cache-Control': 'private, max-age=3600' } });
  }
  if (glb && request.method === 'GET') {
    const bytes = await q.modelBytes(env, glb[1]);
    if (!bytes) return json({ detail: 'No 3D model for that job yet.' }, 404);
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, max-age=3600' } });
  }
  if (path === '/api/gpu' && request.method === 'GET') {
    await ensureCapacity(env, { storage, now, fetcher: ctx.fetcher, queue: q }).catch(() => null);
    const v = await q.view(); return json({ ...v, spoken: speakGpuSummary(v) });
  }
  const ident = await identityRoute(storage, q, path, request, body);
  if (ident) return ident;
  if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
  if (path === '/api/gpu/jobs') { const out = await q.enqueue(body || {}); return json(out, out.ok ? 202 : 422); }
  const act = /^\/api\/gpu\/jobs\/(cancel|retry|pause|resume)$/.exec(path);
  if (act) { const out = await q.control(act[1], String(body?.id || '')); return json(out, out.ok ? 200 : 409); }
  if (path === '/api/gpu/worker-token') {
    return json({ ok: true, token: await q.createToken(), note: 'Shown once. Save it in Colab as the secret CHE_GPU_TOKEN. Creating a new one replaces it.' });
  }
  if (path === '/api/gpu/worker-token/revoke') return json({ ok: await q.revokeToken() });
  return json({ detail: 'Unknown GPU route.' }, 404);
}
