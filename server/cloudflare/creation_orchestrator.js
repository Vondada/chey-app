// Creation Engine orchestrator (owner, 2026-10-24: "I tell CHE to create something and she carries out the entire job
// with as little intervention as possible"). Compute is discovered, not assumed. When a Create Person job is waiting
// and no worker can take it, CHE starts one herself: she dispatches .github/workflows/che-creation-worker.yml on main
// (inputs: reason only, never identity settings or prompts) through the existing gh() helper. That run is a free
// GitHub-hosted CPU runner because this repository is public; CHE re-checks the visibility (cached one hour) before
// every dispatch and refuses if it is private, so the spending limit stays $0. A Colab T4 worker is still the owner's
// manual choice (free Colab has no remote start). No cron: this runs when a job is created, when the app polls the
// job or engine status, and when a lapsed lease pauses a job.
//
// Every refusal is recorded as a plain waiting_reason on the engine and on the waiting jobs (gpu_queue displayOf), and
// every dispatch attempt (with GitHub's status) in gpu:dispatches (last 20).
import { gh } from './coding_runtime.js';
import { CREATION_REPO, CREATION_WORKFLOW } from './gpu_oidc.js';
import {
  ENGINE_KEY, GpuQueue, ONLINE_MS, compatible, engineRecord, engineSettingsOf, isGpuName,
} from './gpu_queue.js';

export const DISPATCHES_KEY = 'gpu:dispatches';
export const DISPATCH_WINDOW_MS = 8 * 60_000;     // a dispatch counts as a worker on its way for 8 minutes
export const VISIBILITY_TTL_MS = 60 * 60_000;     // the repository's visibility is re-read at most hourly
export const VISIBILITY_RETRY_MS = 5 * 60_000;    // ... and 5 minutes after GitHub could not answer
export const MAX_DISPATCH_LOG = 20;

const iso = (ms) => new Date(ms).toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const clock = (now) => (typeof now === 'function' ? now : typeof now === 'number' ? () => now : () => Date.now());
const isGpuWorker = (w) => w?.class !== 'github_cpu' && isGpuName(w?.gpu);

/** The repository GitHub runs the creation workflow in (the Worker's CHE_GITHUB_REPO, which must be CHE's own). */
function repoState(env) {
  const repo = String(env?.CHE_GITHUB_REPO || '').trim();
  if (!env?.CHE_GITHUB_TOKEN || !repo) return { ok: false, reason: 'CHE has no GitHub token and repository saved on the Worker, so she cannot start a cloud worker.' };
  if (repo.toLowerCase() !== CREATION_REPO.toLowerCase()) return { ok: false, reason: `The Worker's GitHub repository is ${repo}, not ${CREATION_REPO}, so CHE does not start the creation workflow there.` };
  return { ok: true, repo };
}

/** Public or not, from GitHub (cached). { public: true|false|null, status, checked_at }. */
async function visibility(env, rec, t, fetcher) {
  const v = rec.visibility;
  if (v && t - (v.checked_ms || 0) < (v.public === null ? VISIBILITY_RETRY_MS : VISIBILITY_TTL_MS)) return { v, changed: false };
  const got = await gh(env, 'GET', '', null, fetcher);
  const pub = got.ok && typeof got.data?.private === 'boolean' ? !got.data.private : null;
  return { v: { public: pub, status: got.status, checked_ms: t, checked_at: iso(t) }, changed: true };
}

async function dispatchLog(storage) { return (await storage.get(DISPATCHES_KEY)) || []; }

/** The state of the compute: who is online, what is waiting, and what a CPU cloud worker could take. */
function capacityOf(jobs, workers, t, settings) {
  const online = Object.entries(workers).filter(([, w]) => t - (w.last_seen_ms || 0) < ONLINE_MS);
  const gpuOnline = online.filter(([, w]) => isGpuWorker(w)).length;
  const cloud = online.filter(([, w]) => w.class === 'github_cpu');
  const busy = (id) => jobs.some((j) => j.state === 'rendering' && j.lease?.worker_id === id);
  const waitingJobs = jobs.filter((j) => j.state === 'queued' || j.state === 'paused');
  const cpuRunnable = waitingJobs.filter((j) => compatible(j, false, gpuOnline > 0));
  const cloudBusy = jobs.filter((j) => j.state === 'rendering' && j.lease?.class === 'github_cpu').length;
  return {
    gpu_online: gpuOnline, cpu_online: cloud.length, cloud_idle: cloud.filter(([id]) => !busy(id)).length, cloud_busy: cloudBusy,
    running: jobs.filter((j) => j.state === 'rendering').length, runnable: waitingJobs.length, cpu_runnable: cpuRunnable,
    max_concurrent: settings.max_cloud_workers + gpuOnline,
  };
}

/**
 * Make sure a waiting job has a worker on its way. If CPU-runnable jobs exist and (idle cloud workers + dispatches in
 * the last 8 minutes) < min(max_cloud_workers - busy cloud workers, runnable jobs), dispatch the creation workflow.
 * Gates, each refused with a plain waiting_reason: auto_cloud on, a GitHub token for CHE's repository, the repository
 * verified public, the spending limit $0. Returns { dispatched, waiting_reason, ... }; never throws on GitHub errors.
 */
export async function ensureCapacity(env = {}, { storage, now, fetcher = fetch, queue } = {}) {
  const tnow = clock(now);
  const q = queue || new GpuQueue(storage, tnow);
  const jobs = await q.jobs(); const workers = await q.workers(); const t = tnow();
  const rec = await engineRecord(storage);
  const settings = engineSettingsOf(rec);
  const cap = capacityOf(jobs, workers, t, settings);
  let recChanged = false; let reason = ''; let dispatched = 0; let cloudState = null;
  const log = await dispatchLog(storage);
  const recent = log.filter((d) => t - Date.parse(d.at) < DISPATCH_WINDOW_MS);
  const want = Math.min(Math.max(0, settings.max_cloud_workers - cap.cloud_busy), cap.cpu_runnable.length);
  const have = cap.cloud_idle + recent.length;
  if (cap.cpu_runnable.length) {
    const repo = repoState(env);
    if (!settings.auto_cloud) reason = 'Automatic cloud workers are off (Settings, Creation Engine), so this waits for a worker you start.';
    else if (settings.spend_limit_usd !== 0) reason = 'The spending limit is not $0, which CHE never accepts; nothing was started.';
    else if (!repo.ok) reason = repo.reason;
    else {
      const vis = await visibility(env, rec, t, fetcher);
      if (vis.changed) { rec.visibility = vis.v; recChanged = true; }
      if (vis.v.public === false) reason = `${CREATION_REPO} is private, so GitHub runners could cost money; CHE does not start them.`;
      else if (vis.v.public !== true) reason = `CHE could not confirm ${CREATION_REPO} is public (GitHub answered ${vis.v.status || 'nothing'}), so she did not start a cloud worker; she checks again in a few minutes.`;
      else if (want === 0) reason = `All ${settings.max_cloud_workers} cloud worker${settings.max_cloud_workers === 1 ? ' is' : 's are'} busy; the next one free takes it.`;
      else if (have < want) {
        const n = Math.min(want - have, settings.max_cloud_workers);
        for (let i = 0; i < n; i++) {
          const why = `${cap.cpu_runnable.length} creation job${cap.cpu_runnable.length === 1 ? '' : 's'} waiting`;
          const sent = await gh(env, 'POST', `/actions/workflows/${encodeURIComponent(CREATION_WORKFLOW)}/dispatches`, { ref: 'main', inputs: { reason: why } }, fetcher);
          const entry = { at: iso(t), ok: Boolean(sent.ok), status: sent.status, reason: why };
          if (!sent.ok) entry.error = String(sent.data?.message || 'GitHub refused the dispatch').slice(0, 160);
          log.push(entry); recent.push(entry);
          if (!sent.ok) break;
          dispatched += 1;
        }
        await storage.put(DISPATCHES_KEY, log.slice(-MAX_DISPATCH_LOG));
      }
      if (!reason) {
        const lastFail = [...recent].reverse().find((d) => !d.ok);
        const anyOk = recent.some((d) => d.ok);
        if (anyOk || cap.cloud_idle) cloudState = 'dispatching';
        else if (lastFail) reason = `GitHub did not start the cloud worker (status ${lastFail.status}: ${lastFail.error}). CHE tries again after ${Math.round(DISPATCH_WINDOW_MS / 60_000)} minutes.`;
      }
    }
  }
  // Waiting jobs carry what they wait for (display_state / status_line); written only when it changed.
  let jobsChanged = false;
  const cpuIds = new Set(cap.cpu_runnable.map((j) => j.id));
  for (const j of jobs) {
    if (j.state !== 'queued' && j.state !== 'paused') continue;
    const next = cpuIds.has(j.id) ? (cloudState ? { state: cloudState, reason: '', at: recent.filter((d) => d.ok).at(-1)?.at || iso(t) } : reason ? { state: 'waiting', reason, at: iso(t) } : null)
      : (j.requires?.gpu === 'preferred' && cap.gpu_online ? { state: 'waiting', reason: 'A GPU worker is online and takes it next.', at: iso(t) } : null);
    const same = JSON.stringify({ ...(j.cloud || {}), at: 0 }) === JSON.stringify({ ...(next || {}), at: 0 }) && Boolean(j.cloud) === Boolean(next);
    if (!same) { j.cloud = next; jobsChanged = true; }
  }
  if (jobsChanged) await q.save(jobs);
  if ((rec.waiting_reason || '') !== reason) { rec.waiting_reason = reason; rec.waiting_at = iso(t); recChanged = true; }
  if (recChanged) await storage.put(ENGINE_KEY, rec);
  return { ok: true, dispatched, waiting_reason: reason, runnable: cap.cpu_runnable.length, have: have + dispatched, want };
}

/** Whether the GitHub path is usable right now (for the app's engine banner): settings, token, verified public. */
export function cloudUsable(env, rec) {
  const s = engineSettingsOf(rec);
  return Boolean(s.auto_cloud && repoState(env).ok && rec?.visibility?.public === true);
}

// The Creation Engine's compute, declared once: the Cloud Computer Manager (cloud_computer.js PROVIDERS) lists these same
// entries, so there is one registry of CHE's cloud computers. Live state (verified public, last heartbeat) is added below.
export const CREATION_PROVIDERS = Object.freeze([
  { id: 'github_creation', label: 'GitHub cloud CPU Blender worker (che-creation-worker.yml)', tier: 'owner_compute', automatic: true,
    runner: 'GitHub-hosted ubuntu-latest, started by the Creation Engine', software: ['Blender 5.0.1 (SHA-256 checked)', 'MPFB2 (CC0, pinned)', 'Python 3'],
    capabilities: ['blender'], cost: `$0: ${CREATION_REPO} is public, and GitHub-hosted standard runners are free for public repositories.`,
    billing: 'verified_public_repository', needs_approval: false, manual_step: null,
    device: 'CPU, 4 cores and 16 GB on a standard runner; slower than a GPU.',
    evidence: ['.github/workflows/che-creation-worker.yml', 'server/cloudflare/creation_orchestrator.js'],
    limits: 'CPU only. CHE re-reads the repository visibility (at most hourly) before every start and never starts it if the repository is private.' },
  { id: 'colab_t4', label: 'Google Colab T4 GPU (your notebook)', tier: 'external_free', automatic: false,
    runner: 'your own Colab notebook (notebooks/CHE_GPU_Face_Preview.ipynb)', software: ['Blender (CUDA/OptiX)', 'MPFB2'],
    capabilities: ['blender', 'gpu'], cost: '$0: your own free Colab session.', billing: 'owner_free_session', needs_approval: false,
    manual_step: 'Open the CHE GPU notebook in Colab and run all cells; free Colab cannot be started remotely and stops when idle.',
    device: 'NVIDIA T4 GPU.', evidence: ['notebooks/CHE_GPU_Face_Preview.ipynb', 'scripts/che_gpu_worker.py'],
    limits: 'Runs only while you have the notebook open; Google stops idle free sessions.' },
]);

const PROVIDERS = (rec, workers) => CREATION_PROVIDERS.map((p) => ({
  id: p.id === 'github_creation' ? 'github_cpu' : p.id, label: p.label, automatic: p.automatic, cost: p.cost, manual_step: p.manual_step, device: p.device,
  verified_at: p.id === 'github_creation' ? (rec.visibility?.public === true ? rec.visibility.checked_at : null)
    : Object.values(workers).filter((w) => w.class !== 'github_cpu' && w.last_seen_ms).map((w) => iso(w.last_seen_ms)).sort().pop() || null,
}));

/** GET /api/creations/engine: the whole Creation Engine in one view. */
export async function engineView(env, { storage, now, fetcher } = {}) {
  const tnow = clock(now);
  const q = new GpuQueue(storage, tnow);
  await ensureCapacity(env, { storage, now: tnow, fetcher, queue: q }).catch(() => null);
  const jobs = await q.jobs(); const workers = await q.workers(); const t = tnow();
  const rec = await engineRecord(storage); const settings = engineSettingsOf(rec);
  const cap = capacityOf(jobs, workers, t, settings);
  const list = Object.entries(workers).map(([id, w]) => ({ id, class: w.class || 'colab', device: w.class === 'github_cpu' ? 'cpu' : (w.gpu || w.device || null),
    cores: w.cores || null, ram_gb: w.ram_gb || null, online: t - (w.last_seen_ms || 0) < ONLINE_MS,
    job_id: jobs.find((j) => j.state === 'rendering' && j.lease?.worker_id === id)?.id || null, last_seen: w.last_seen_ms ? iso(w.last_seen_ms) : null }));
  const dispatches = (await dispatchLog(storage)).slice().reverse();
  const automatic = cloudUsable(env, rec);
  const capacity = { gpu_online: cap.gpu_online, cpu_online: cap.cpu_online, running: cap.running, max_concurrent: cap.max_concurrent, runnable: cap.runnable };
  const spoken = [
    `Creation Engine: ${cap.running} job${cap.running === 1 ? '' : 's'} creating, ${cap.runnable} waiting.`,
    `${cap.gpu_online} GPU worker${cap.gpu_online === 1 ? '' : 's'} and ${cap.cpu_online} cloud CPU worker${cap.cpu_online === 1 ? '' : 's'} online.`,
    automatic ? `Automatic cloud workers are on, up to ${settings.max_cloud_workers} at once, free on this public repository.`
      : settings.auto_cloud ? 'Automatic cloud workers are on but cannot start right now.' : 'Automatic cloud workers are off.',
    rec.waiting_reason ? rec.waiting_reason : '',
    'Spending limit: zero dollars.',
  ].filter(Boolean).join(' ');
  return { settings, automatic, waiting_reason: rec.waiting_reason || '', workers: list, capacity, providers: PROVIDERS(rec, workers), dispatches, spoken };
}

/** POST /api/creations/engine/settings {auto_cloud, max_cloud_workers}. spend_limit_usd is refused unless 0. */
export async function setEngineSettings(storage, body = {}) {
  if (body.spend_limit_usd !== undefined && Number(body.spend_limit_usd) !== 0) {
    return { ok: false, detail: 'The spending limit stays at $0: CHE has no paid provider and never buys compute.' };
  }
  const rec = await engineRecord(storage); const s = engineSettingsOf(rec);
  const changes = [];
  if (body.auto_cloud !== undefined) { s.auto_cloud = body.auto_cloud === true || body.auto_cloud === 'true'; changes.push(`automatic cloud workers ${s.auto_cloud ? 'on' : 'off'}`); }
  if (body.max_cloud_workers !== undefined) {
    const n = Math.round(Number(body.max_cloud_workers));
    if (!Number.isFinite(n) || n < 1 || n > 10) return { ok: false, detail: 'Cloud workers at once must be a number from 1 to 10.' };
    s.max_cloud_workers = n; changes.push(`up to ${n} cloud worker${n === 1 ? '' : 's'} at once`);
  }
  rec.settings = s; await storage.put(ENGINE_KEY, rec);
  return { ok: true, settings: s, spoken: changes.length ? `Creation Engine set: ${changes.join(', ')}. Spending limit stays at zero dollars.` : 'Nothing changed.' };
}

/** Owner routes /api/creations/engine and /api/creations/engine/settings. Null for other paths. */
export async function engineRoute(ctx, path, request, body) {
  if (path === '/api/creations/engine') {
    if (request.method !== 'GET') return json({ detail: 'Use GET.' }, 405);
    return json(await engineView(ctx.env || {}, ctx));
  }
  if (path === '/api/creations/engine/settings') {
    if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
    const out = await setEngineSettings(ctx.storage, body || {});
    return json(out, out.ok ? 200 : 422);
  }
  return null;
}
