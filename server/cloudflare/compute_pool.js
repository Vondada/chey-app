// Compute pool for the Creation Engine (owner, 2026-10-25: "use every computer I already have, never spend money").
// One registry over the computers that can work the EXISTING queue (gpu_queue.js) for the `person_model` (Blender)
// workload. It is not a second queue or orchestrator: jobs, leases, checkpoints and resume stay in gpu_queue.js, and
// the free GitHub CPU worker is still started by creation_orchestrator.ensureCapacity. This module adds, per provider:
// whether it can run Blender at all (with the evidence), whether a credential is already saved (a boolean, never the
// value), its real quota where an API exists, a status and a plain reason; plus a cooldown per provider, bounded
// provider attempts per job with a waiting reason, a record of every handoff, and one opt-in GPU route (Kaggle) that
// reuses a Kaggle token only if the owner already saved one in Keys.
//
// Rules held in code here (not only in words):
// - Spending stays $0: nothing here buys, subscribes or enables paid scale-up; Kaggle sessions run with Kaggle's own
//   sessionTimeoutSeconds and only while the real weekly quota stays above KAGGLE_MARGIN_S.
// - No new keys, accounts or manual setup: a provider without an already-saved credential is `no_credential`, and the
//   pool never asks for one on its own.
// - Never bypass login, quotas or access limits: quota answers (HTTP 429, "quota", Kaggle's own statistics) cool the
//   provider down until the reset time when known, else exponential backoff capped at BACKOFF_MAX_MS.
// - A GPU-only job never falls back to a CPU (gpu_queue.compatible decides; nothing here widens it).
// - Secrets never leave: views carry booleans for credentials; the scoped Kaggle worker token is stored only as a
//   SHA-256 hash and travels only inside the owner's private Kaggle kernel source.
import { durationSeconds, kaggleAuth, kaggleCall } from './film_farm.js';
import { storedKeys } from './resilience.js';
import { loadPolicy } from './capability_engine.js';
import { ONLINE_MS, engineRecord, engineSettingsOf, isGpuName, needOf } from './gpu_queue.js';

export const POOL_KEY = 'pool:state';
export const MAX_PROVIDER_ATTEMPTS = 3;            // provider failures per job before it waits with a reason
export const BACKOFF_BASE_MS = 5 * 60_000;          // first cooldown after a provider failure
export const BACKOFF_MAX_MS = 6 * 3600_000;         // cooldowns never exceed 6 hours without a known reset time
export const MIN_HOLD_MS = 10 * 60_000;             // a job that used its attempts waits at least this long
export const MAX_HANDOFFS = 50;
export const MAX_ATTEMPTS_KEPT = 6;               // per job; `total` keeps the full count
export const KAGGLE_MARGIN_S = 2 * 3600;            // never start a Kaggle session with less than 2 GPU hours left
export const KAGGLE_SESSION_S = 3 * 3600;           // Kaggle itself stops the kernel at this (sessionTimeoutSeconds)
export const KAGGLE_RESERVE_MS = 25 * 60_000;       // a started kernel must claim within 25 min (Blender download + setup)
export const QUOTA_TTL_MS = 3600_000;               // the real Kaggle quota is re-read at most hourly
export const POOL_REPO = 'Vondada/chey-app';
// Pinned sources for the Kaggle character kernel (the same pins the verified GitHub CPU worker uses).
export const POOL_COMMIT = 'afb8de155d3a6a2a892fe7e561c46924bcf7bcbb';        // main with scripts/che_gpu_worker.py
export const POOL_ASSETS_COMMIT = '2f64f91edc9c7021e647311a677a5621f2afec94'; // che-gpu-assets (project files)
export const POOL_MPFB_COMMIT = 'b1a2dc98776da9d1eea751b159d42cf61778fe2e';   // che-creation-worker.yml MPFB_COMMIT
export const POOL_BLENDER_VERSION = '5.0.1';
export const STATUSES = ['ready', 'cooling_down', 'no_credential', 'incompatible', 'unverified', 'offline'];
/** Outcomes that are the computer's fault, not the job's: they cool the provider down and hand the job off. */
export const PROVIDER_FAILURES = ['timeout', 'quota', 'gpu_unavailable', 'provider_error', 'start_timeout'];
// The first live CPU proof (docs/CHE_CHARACTER_REALISM_CHECKLIST.md): a rigged full-body GLB in 1.4 min.
export const GITHUB_EVIDENCE = 'GitHub Actions run 40153146586 built a full-body rigged GLB on the free CPU runner in 1.4 min (23,946 vertices, 5 clips).';

const iso = (ms) => new Date(ms).toISOString();
const hhmm = (ms) => iso(ms).slice(11, 16);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const clock = (now) => (typeof now === 'function' ? now : typeof now === 'number' ? () => now : () => Date.now());

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── The registry (static facts and evidence) ────────────────────────────────────────────────────────────────────
export const POOL_PROVIDERS = Object.freeze([
  { id: 'github_actions_cpu', label: 'Free GitHub cloud CPU worker (che-creation-worker.yml)', gpu: false, compatible: true,
    evidence: GITHUB_EVIDENCE, credential: 'none for the worker (GitHub OIDC); CHE_GITHUB_TOKEN on the Worker to start it',
    needs: 'Nothing new: the repository is public, so standard runners are free.' },
  { id: 'colab_gpu', label: "Owner's Google Colab T4 (paired notebook)", gpu: true, compatible: true,
    evidence: 'notebooks/CHE_GPU_Face_Preview.ipynb runs scripts/che_gpu_worker.py with Blender Cycles on CUDA/OptiX; it joins only while the notebook is open.',
    credential: 'the paired worker token (POST /api/gpu/worker-token), saved as the Colab secret CHE_GPU_TOKEN',
    needs: 'The owner opens the notebook each time: free Colab cannot be started remotely (manual step).' },
  { id: 'kaggle', label: 'Kaggle GPU kernel (CHE character kernel)', gpu: true, compatible: true,
    evidence: 'Only through the character kernel this module generates (Blender 5.0.1 + scripts/che_gpu_worker.py). The Film Studio farm on Kaggle runs a video model, which does not prove Blender works there.',
    credential: 'KAGGLE_API_TOKEN (username:token) already saved in the owner\'s Keys',
    needs: 'A Kaggle account with a saved API token and a phone-verified account (internet in GPU kernels). If no token is saved, this provider cannot meet "no new keys or manual setup".' },
  { id: 'hf_zerogpu', label: 'Hugging Face ZeroGPU Space', gpu: true, compatible: false,
    evidence: 'Hugging Face docs (hub-docs docs/hub/spaces-zerogpu.md, read 2026-10-25): "ZeroGPU Spaces are exclusively compatible with the Gradio SDK"; "a real GPU is only available inside @spaces.GPU functions" with "a PyTorch CUDA emulation mode" outside them; designed for "PyTorch-based GPU Spaces"; free accounts get 5 minutes of GPU a day and a 60 s default per call. Blender Cycles is not PyTorch and runs as its own process; nothing documents that a subprocess sees the GPU.',
    credential: 'HF_TOKEN (write access) saved in Keys or on the Worker', needs: 'Not usable for Blender even with a token.' },
  { id: 'workers_ai', label: 'Cloudflare Workers AI', gpu: true, compatible: false,
    evidence: 'Workers AI runs hosted inference models only; there is no way to run Blender or any custom binary on it.', credential: 'the Worker\'s AI binding',
    needs: 'Not usable for Blender.' },
  { id: 'cloud_computer', label: "Owner's computer endpoint (CHE_COMPUTER_URL)", gpu: null, compatible: null,
    evidence: 'agent_runtime.js runComputerWorkspace; the endpoint never reports its software, so CHE cannot know it runs Blender.', credential: 'CHE_COMPUTER_URL and CHE_COMPUTER_TOKEN',
    needs: 'A URL and token on the Worker, and Blender on that machine: new setup.' },
  { id: 'vmware_training', label: 'VMware training endpoint', gpu: null, compatible: null,
    evidence: 'Only a URL and token pair is known; no Blender worker exists for it.', credential: 'CHE_VMWARE_TRAINING_URL and CHE_VMWARE_TRAINING_TOKEN',
    needs: 'Credentials and a Blender worker on that machine: new setup.' },
  { id: 'hf_training', label: 'Hugging Face training endpoint', gpu: null, compatible: null,
    evidence: 'Only a URL and token pair is known; no Blender worker exists for it.', credential: 'CHE_HF_TRAINING_URL and CHE_HF_TRAINING_TOKEN',
    needs: 'Credentials and a Blender worker there: new setup.' },
]);
const byId = Object.fromEntries(POOL_PROVIDERS.map((p) => [p.id, p]));
export const providerLabel = (id) => byId[id]?.label || String(id || 'unknown computer');

/** The provider that holds a lease: the pool's own stamp, else the worker class (github_cpu or the Colab GPU). */
export function providerOf(lease) {
  if (!lease) return null;
  if (lease.provider) return lease.provider;
  return lease.class === 'github_cpu' ? 'github_actions_cpu' : 'colab_gpu';
}
export function providerOfAuth(auth) {
  if (auth?.provider) return auth.provider;
  return auth?.class === 'github_cpu' ? 'github_actions_cpu' : 'colab_gpu';
}

// ─── Pool state (Durable Object storage) ─────────────────────────────────────────────────────────────────────────
export function emptyPool() {
  return { v: 1, cooldowns: {}, handoffs: [], verified: {}, quota: {}, tokens: {}, sessions: {}, settings: { allow_unverified_gpu: false } };
}
export async function loadPool(storage) {
  const s = (await storage.get(POOL_KEY)) || null;
  const base = emptyPool();
  return s && typeof s === 'object' ? { ...base, ...s, settings: { ...base.settings, ...(s.settings || {}) } } : base;
}
export async function savePool(storage, pool) { await storage.put(POOL_KEY, pool); }

export const backoffMs = (strikes) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, strikes - 1));

/**
 * Cools a provider down. Quota answers wait for the reset time when it is known (and in the future), else they back
 * off exponentially like every other failure; nothing exceeds BACKOFF_MAX_MS unless the provider named its reset.
 * block_claims: a running worker of that provider is handed nothing either (quota is gone); otherwise the cooldown only
 * stops CHE from starting a new session, so an owner who reopens Colab is never turned away.
 */
export function coolDown(pool, id, { kind = 'provider_error', reason = '', resetMs = null, blockClaims = false } = {}, t = Date.now()) {
  const prev = pool.cooldowns[id] || { strikes: 0 };
  const strikes = (prev.strikes || 0) + 1;
  // A first lost session (timeout, no GPU) retries at once: a crashed runner says little about the provider. Repeats
  // back off; quota and start failures cool down from the first strike.
  const lost = kind === 'timeout' || kind === 'gpu_unavailable';
  const until = kind === 'quota' && Number.isFinite(resetMs) && resetMs > t ? resetMs : lost && strikes === 1 ? t : t + backoffMs(lost ? strikes - 1 : strikes);
  pool.cooldowns[id] = { until_ms: until, until: iso(until), kind, reason: String(reason).slice(0, 200), strikes, at: iso(t), block_claims: Boolean(blockClaims) };
  return pool.cooldowns[id];
}
export function cooling(pool, id, t) {
  const c = pool.cooldowns?.[id];
  return c && c.until_ms > t ? c : null;
}

/** A failure the worker reported, classified: 'quota', 'provider_error', or null (the job's own failure). */
export function classifyFailure(status, error = '') {
  const s = String(status || ''); const e = String(error || '');
  if (s === 'quota_exceeded' || /\b429\b|quota|rate.?limit|too many requests/i.test(e)) return 'quota';
  if (s === 'provider_error' || s === 'timeout' || /out of memory|CUDA error|no space left|connection reset|session (?:ended|expired)/i.test(e)) return 'provider_error';
  return null;
}

// ─── Job-level hooks (called from gpu_queue.js) ──────────────────────────────────────────────────────────────────
const poolOf = (j) => (j.pool && typeof j.pool === 'object' ? j.pool : (j.pool = { attempts: [] }));

/** A worker of `provider` now holds the job: one attempt record, and a pending reservation for someone else ends. */
export function poolOnClaim(j, provider, workerId, t) {
  const p = poolOf(j);
  p.attempts = [...(p.attempts || []), { provider, worker_id: String(workerId || '').slice(0, 64), started_at: iso(t), outcome: 'running' }].slice(-MAX_ATTEMPTS_KEPT);
  p.total = (p.total || 0) + 1;
  if (p.reserved?.provider === provider) p.reserved = null;
  p.handoff_to_pending = true;   // applyPending names the new provider on the last open handoff
}

/** How the attempt ended (completed, job_failed, or a PROVIDER_FAILURES outcome); applied later by applyPending. */
export function poolNote(j, lease, outcome, t, reason = '') {
  const p = poolOf(j);
  const provider = providerOf(lease) || 'unknown';
  const wid = lease?.worker_id || '';
  const open = [...(p.attempts || [])].reverse().find((a) => a.outcome === 'running' && a.provider === provider && (!wid || a.worker_id === wid));
  const done = { outcome, ended_at: iso(t), reason: String(reason || '').slice(0, 160), applied: false };
  if (open) Object.assign(open, done);
  else {
    p.attempts = [...(p.attempts || []), { provider, worker_id: String(wid).slice(0, 64), started_at: iso(t), ...done }].slice(-MAX_ATTEMPTS_KEPT);
    p.total = (p.total || 0) + 1;
  }
}

/** Provider failures in the current round (since the last hold ended). */
export function roundFailures(j) {
  const start = j.pool?.round_start_ms || 0;
  return (j.pool?.attempts || []).filter((a) => PROVIDER_FAILURES.includes(a.outcome) && Date.parse(a.ended_at || a.started_at) >= start);
}

/** Receipt stamp on a completed job: which provider built it and how many provider attempts it took. */
export function stampReceipt(j, lease) {
  if (!j.receipt) j.receipt = {};
  j.receipt.provider = providerOf(lease) || 'unknown';
  j.receipt.attempts = Math.max(1, j.pool?.total || (j.pool?.attempts || []).length);
  if (lease?.device) j.receipt.provider_device = String(lease.device).slice(0, 80);
}

/** Whether `provider` may claim this job now (claim filter in gpu_queue.js). scope: the job ids a scoped token opens. */
export function poolAllows(pool, j, provider, t, scope = null) {
  if (scope && !scope.includes(j.id)) return false;
  const r = j.pool?.reserved;
  if (r && r.until_ms > t && r.provider !== provider) return false;
  const c = cooling(pool, provider, t);
  if (c?.block_claims) return false;
  if ((j.pool?.hold_until_ms || 0) > t && (j.pool.held_providers || []).includes(provider)) return false;
  return true;
}

/** The plain sentence a held or reserved job waits on, or ''. */
export function heldReason(pool, j, t) {
  const p = j.pool || {};
  if ((p.hold_until_ms || 0) > t) return p.hold_reason || `Waiting until ${hhmm(p.hold_until_ms)} UTC after ${MAX_PROVIDER_ATTEMPTS} computers could not finish it. Finished stages are kept.`;
  if (p.reserved && p.reserved.until_ms > t) return `A ${providerLabel(p.reserved.provider)} session is starting for it (started ${hhmm(Date.parse(p.reserved.at))} UTC); if it does not pick the job up by ${hhmm(p.reserved.until_ms)} UTC, CHE hands it to the next computer.`;
  return '';
}

/** A worker whose provider is out of quota (cooldown with block_claims) does not count as an online GPU. */
export const workerUsable = (pool, w, t) => !cooling(pool, w?.provider || (w?.class === 'github_cpu' ? 'github_actions_cpu' : 'colab_gpu'), t)?.block_claims;

/** Whether a job is free for the CPU dispatcher (not held, not reserved for a GPU session). */
export const dispatchable = (pool, j, t) => !heldReason(pool, j, t) && poolAllows(pool, j, 'github_actions_cpu', t);

/**
 * Applies every attempt outcome not yet applied, across the jobs: provider cooldowns, the handoff log, holds after
 * MAX_PROVIDER_ATTEMPTS, verified receipts, and expired reservations (a session that never claimed is a start_timeout).
 * Mutates the jobs (caller saves them) and saves the pool. Returns whether any job changed.
 */
export async function applyPending(storage, jobs, t, pool = null) {
  const own = !pool; pool = pool || await loadPool(storage);
  let jobsChanged = false; let poolChanged = false;
  for (const j of jobs) {
    const p = j.pool;
    if (!p) continue;
    if (p.reserved && p.reserved.until_ms <= t) {
      const r = p.reserved; p.reserved = null; jobsChanged = true;
      if (j.state !== 'rendering' || providerOf(j.lease) !== r.provider) {
        p.attempts = [...(p.attempts || []), { provider: r.provider, worker_id: '', started_at: r.at, outcome: 'start_timeout', ended_at: iso(t),
          reason: `the ${providerLabel(r.provider)} session did not pick the job up within ${Math.round(KAGGLE_RESERVE_MS / 60_000)} minutes`, applied: false }].slice(-MAX_ATTEMPTS_KEPT);
        p.total = (p.total || 0) + 1;
      }
    }
    if (p.handoff_to_pending) {
      const last = p.attempts?.at(-1);
      const open = [...pool.handoffs].reverse().find((h) => h.job_id === j.id && !h.to);
      if (open && last) { open.to = last.provider; open.to_at = last.started_at; poolChanged = true; }
      p.handoff_to_pending = false; jobsChanged = true;
    }
    for (const a of p.attempts || []) {
      if (a.applied !== false) continue;
      delete a.applied; jobsChanged = true; poolChanged = true;
      const at = Date.parse(a.ended_at) || t;
      if (PROVIDER_FAILURES.includes(a.outcome)) {
        const quota = a.outcome === 'quota';
        const reset = quota ? Date.parse(pool.quota?.[a.provider]?.refresh || '') : NaN;
        coolDown(pool, a.provider, { kind: a.outcome, reason: a.reason || a.outcome, resetMs: reset, blockClaims: quota && a.provider !== 'github_actions_cpu' }, at);
        pool.handoffs = [...pool.handoffs, { at: iso(at), job_id: j.id, from: a.provider, outcome: a.outcome, reason: String(a.reason || '').slice(0, 160) }].slice(-MAX_HANDOFFS);
        const fails = roundFailures(j);
        if (fails.length >= MAX_PROVIDER_ATTEMPTS && j.state !== 'completed') {
          const ends = fails.map((f) => cooling(pool, f.provider, t)?.until_ms || 0).filter(Boolean);
          const until = Math.min(at + BACKOFF_MAX_MS, Math.max(at + MIN_HOLD_MS, ends.length ? Math.min(...ends) : 0));
          const tried = fails.map((f) => `${providerLabel(f.provider)}: ${f.outcome.replace('_', ' ')}`).join('; ');
          p.hold_until_ms = until; p.round_start_ms = until; p.held_providers = [...new Set(fails.map((f) => f.provider))];
          p.hold_reason = `Waiting until ${hhmm(until)} UTC: ${fails.length} attempts could not finish it (${tried}). It stays queued with its finished stages; another computer may still take it, and CHE tries again then.`;
        }
      } else if (a.outcome === 'completed') {
        const c = pool.cooldowns[a.provider];
        if (c && c.kind !== 'quota') delete pool.cooldowns[a.provider];
        else if (c) c.strikes = 0;
        if (j.model?.sha256) {
          pool.verified[a.provider] = { job_id: j.id, sha256: j.model.sha256, at: a.ended_at, device: String(j.receipt?.provider_device || j.rendered_on?.device || '').slice(0, 80) };
        }
        p.hold_until_ms = 0; p.hold_reason = '';
      }
    }
  }
  if (poolChanged && own) await savePool(storage, pool);
  else if (poolChanged) pool.dirty = true;
  return jobsChanged;
}

// ─── Scoped worker tokens (Kaggle) ───────────────────────────────────────────────────────────────────────────────
/** A token for one provider's session: shown once (inside the private kernel), stored as a hash, expires, job-scoped. */
export async function issuePoolToken(pool, provider, jobIds, ms, t) {
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  pool.tokens[provider] = { token_hash: await sha256(token), expires_ms: t + ms, job_ids: [...jobIds], created_at: iso(t), revoked: false };
  return token;
}

/** workerAuth hook: a valid pool token → { class: 'colab' (a GPU worker), provider, job_ids }; else null. */
export async function poolTokenAuth(storage, token, t = Date.now()) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return null;
  const pool = await loadPool(storage); const h = await sha256(token);
  for (const [provider, rec] of Object.entries(pool.tokens || {})) {
    if (rec && !rec.revoked && rec.token_hash === h && t < rec.expires_ms) return { class: 'colab', provider, job_ids: rec.job_ids || [] };
  }
  return null;
}

// ─── Credentials and quota (booleans out, never values) ──────────────────────────────────────────────────────────
/** The Kaggle token from the same sources farmProviders reads: the owner's saved Keys first, then the Worker env. */
export async function kaggleCredential(env = {}, storage) {
  let keys = {};
  try { keys = await storedKeys(storage); } catch (_) { keys = {}; }
  const raw = String(keys.KAGGLE_API_TOKEN || env.KAGGLE_API_TOKEN || '').trim();
  const auth = raw ? kaggleAuth(raw) : null;
  return { raw, exists: Boolean(raw), username: Boolean(auth?.username), auth };
}

/** The real weekly Kaggle GPU quota (GetAcceleratorQuotaStatistics), cached hourly in the pool. Never throws. */
export async function kaggleQuota(cred, pool, t, fetcher = fetch, storage = null) {
  const cached = pool.quota?.kaggle;
  if (cached && t - (cached.checked_ms || 0) < QUOTA_TTL_MS) return cached;
  // The Film Studio already validated it recently: reuse that read instead of another call.
  const film = storage ? await storage.get('film:validation').catch(() => null) : null;
  const fk = film?.kaggle;
  if (fk?.ok && fk.checked_at && t - Date.parse(fk.checked_at) < QUOTA_TTL_MS) {
    pool.quota.kaggle = { ok: true, source: 'film validation', checked_ms: Date.parse(fk.checked_at), allowed_s: Number(fk.allowed_s) || 0, used_s: Number(fk.used_s) || 0, reserved_s: Number(fk.reserved_s) || 0, refresh: fk.refresh || '' };
    return pool.quota.kaggle;
  }
  if (!cred?.auth) return { ok: false, status: 'no_credential' };
  let q;
  try {
    const r = await kaggleCall(cred.auth, 'GetAcceleratorQuotaStatistics', {}, fetcher);
    if (r.status === 401 || r.status === 403) q = { ok: false, status: 'unauthorized', http: r.status };
    else if (r.status === 429) q = { ok: false, status: 'rate_limited', http: 429 };
    else if (!r.ok) q = { ok: false, status: 'unknown', http: r.status };
    else {
      const g = r.data.gpuQuota || r.data.gpu_quota || {};
      q = { ok: true, source: 'GetAcceleratorQuotaStatistics', allowed_s: durationSeconds(g.totalTimeAllowed ?? g.total_time_allowed), used_s: durationSeconds(g.timeUsed ?? g.time_used),
        reserved_s: durationSeconds(g.timeReserved ?? g.time_reserved), refresh: r.data.quotaRefreshTime || r.data.quota_refresh_time || '',
        pay_to_scale: Boolean(g.isPayToScaleEnabled ?? g.is_pay_to_scale_enabled) };
    }
  } catch (e) { q = { ok: false, status: 'network', error: String(e?.message || e).slice(0, 80) }; }
  pool.quota.kaggle = { ...q, checked_ms: t, checked_at: iso(t) };
  return pool.quota.kaggle;
}
export const kaggleLeft = (q) => (q?.ok ? Math.max(0, (q.allowed_s || 0) - (q.used_s || 0) - (q.reserved_s || 0)) : 0);

async function egressBlock(storage) {
  try {
    const p = await loadPolicy(storage);
    if (p.internal_only) return 'internal-only mode is on, so CHE sends no work to outside computers';
    if ((p.no_export_projects || []).length) return 'a no-export rule is on, so CHE sends no project to outside computers';
  } catch (_) { /* no policy stored: nothing blocks */ }
  return '';
}

// ─── Statuses ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Every provider with: compatible (+ evidence), credential (exists: boolean), quota, status, reason, cooldown and the
 * verified receipt (a completed job with its GLB sha256) when one is recorded. `refreshQuota` reads Kaggle's real quota.
 */
export async function providerStatuses(env = {}, { storage, now, fetcher = fetch, pool = null, workers = null, jobs = null, refreshQuota = true } = {}) {
  const t = clock(now)();
  pool = pool || await loadPool(storage);
  workers = workers || (await storage.get('gpu:workers')) || {};
  jobs = jobs || (await storage.get('gpu:jobs')) || [];
  const rec = await engineRecord(storage); const settings = engineSettingsOf(rec);
  const online = (prov) => Object.values(workers).filter((w) => (w.provider || (w.class === 'github_cpu' ? 'github_actions_cpu' : 'colab_gpu')) === prov && t - (w.last_seen_ms || 0) < ONLINE_MS);
  const lastSeen = (prov) => Object.values(workers).filter((w) => (w.provider || (w.class === 'github_cpu' ? 'github_actions_cpu' : 'colab_gpu')) === prov && w.last_seen_ms).map((w) => w.last_seen_ms).sort().pop() || null;
  const out = [];
  const add = (id, o) => {
    const c = cooling(pool, id, t);
    const status = o.status === 'ready' || o.status === 'unverified' ? (c ? 'cooling_down' : o.status) : o.status;
    out.push({ id, label: byId[id].label, gpu: byId[id].gpu, compatible: byId[id].compatible, evidence: byId[id].evidence, needs: byId[id].needs,
      credential: { source: byId[id].credential, exists: Boolean(o.credential) }, quota: o.quota || null, status,
      cooling_until: status === 'cooling_down' && c ? c.until : null,
      reason: status === 'cooling_down' && c ? `Cooling down until ${hhmm(c.until_ms)} UTC after ${c.kind.replace('_', ' ')}${c.reason ? ` (${c.reason})` : ''}.` : o.reason,
      verified: pool.verified?.[id] || null, online: o.online ?? null });
  };

  // GitHub CPU: verified live; free while the repository is public; at most max_cloud_workers at once.
  const ghCred = Boolean(env.CHE_GITHUB_TOKEN && env.CHE_GITHUB_REPO);
  const pub = rec.visibility?.public;
  const busy = jobs.filter((j) => j.state === 'rendering' && j.lease?.class === 'github_cpu').length;
  add('github_actions_cpu', {
    credential: ghCred, online: online('github_actions_cpu').length,
    quota: { public_repository: pub ?? null, free_minutes: pub === true ? 'unmetered: standard runners are free for public repositories' : 'unknown until the repository is verified public',
      concurrency_cap: settings.max_cloud_workers, busy, checked_at: rec.visibility?.checked_at || null },
    status: !ghCred ? 'no_credential' : !settings.auto_cloud ? 'offline' : pub === false ? 'offline' : 'ready',
    reason: !ghCred ? 'The Worker has no CHE_GITHUB_TOKEN and repository, so CHE cannot start it.'
      : !settings.auto_cloud ? 'Automatic cloud workers are off in Creation Engine settings.'
        : pub === false ? `${POOL_REPO} is private, so runners could cost money; CHE does not start them.`
          : `Ready: CPU only, up to ${settings.max_cloud_workers} at once (${busy} busy). ${pub === true ? 'Verified public.' : 'Visibility is re-checked before every start.'}`,
  });

  // Colab: ready only with a fresh heartbeat from a GPU worker.
  const token = await storage.get('gpu:token');
  const paired = Boolean(token && !token.revoked);
  const colabOn = online('colab_gpu').filter((w) => isGpuName(w.gpu));
  const seen = lastSeen('colab_gpu');
  add('colab_gpu', {
    credential: paired, online: colabOn.length,
    quota: { kind: 'heartbeat only (Colab publishes no quota API)', last_heartbeat: seen ? iso(seen) : null, fresh_for_s: Math.round(ONLINE_MS / 1000) },
    status: colabOn.length ? 'ready' : !paired ? 'no_credential' : 'offline',
    reason: colabOn.length ? `Online on ${String(colabOn[0].gpu).split(',')[0]}.` : !paired ? 'The Colab worker is not paired.'
      : `Not open${seen ? ` (last heartbeat ${hhmm(seen)} UTC)` : ''}. It joins only while the owner has the notebook open.`,
  });

  // Kaggle: only with a token already saved, egress allowed, and real quota above the margin; unverified until a GLB.
  const cred = await kaggleCredential(env, storage);
  const block = await egressBlock(storage);
  let q = pool.quota?.kaggle || null;
  if (cred.exists && !block && refreshQuota) q = await kaggleQuota(cred, pool, t, fetcher, storage);
  const left = kaggleLeft(q);
  const kOnline = online('kaggle').length;
  const verified = Boolean(pool.verified?.kaggle?.sha256);
  let kStatus; let kReason;
  if (!cred.exists) { kStatus = 'no_credential'; kReason = 'No Kaggle token is saved in Keys. Adding one would be new setup, which the owner ruled out, so CHE does not ask.'; }
  else if (!cred.username) { kStatus = 'no_credential'; kReason = 'The saved Kaggle token has no username (username:token), so CHE cannot start a kernel.'; }
  else if (block) { kStatus = 'offline'; kReason = `Not used: ${block}.`; }
  else if (q && !q.ok) { kStatus = 'offline'; kReason = `Kaggle quota could not be read (${q.status}${q.http ? ` ${q.http}` : ''}).`; }
  else if (q?.pay_to_scale) { kStatus = 'offline'; kReason = 'Kaggle pay-to-scale is on for this account, so CHE does not start sessions there (spending stays $0).'; }
  else if (q && left < KAGGLE_MARGIN_S + 1800) {
    const reset = Date.parse(q.refresh || '');
    if (!cooling(pool, 'kaggle', t)) coolDown(pool, 'kaggle', { kind: 'quota', reason: `${(left / 3600).toFixed(1)} GPU hours left this week, under the ${KAGGLE_MARGIN_S / 3600}-hour margin`, resetMs: reset, blockClaims: true }, t);
    kStatus = 'ready'; kReason = '';
  } else { kStatus = verified ? 'ready' : 'unverified'; kReason = verified ? `Verified: job ${pool.verified.kaggle.job_id} built a GLB (sha256 ${pool.verified.kaggle.sha256.slice(0, 12)}…) on ${pool.verified.kaggle.device || 'Kaggle'}. ${(left / 3600).toFixed(1)} GPU hours left this week.`
    : `Token saved and ${(left / 3600).toFixed(1)} GPU hours left this week, but no character has been built on Kaggle yet, so it is used only for GPU-only jobs (or when the owner allows unverified GPUs).`; }
  add('kaggle', { credential: cred.exists, online: kOnline,
    quota: q ? { ok: q.ok === true, source: q.source || null, allowed_s: q.allowed_s ?? null, used_s: q.used_s ?? null, reserved_s: q.reserved_s ?? null, left_s: q.ok ? left : null, margin_s: KAGGLE_MARGIN_S, refresh: q.refresh || null, checked_at: q.checked_at || (q.checked_ms ? iso(q.checked_ms) : null) } : null,
    status: kStatus, reason: kReason });

  add('hf_zerogpu', { credential: Boolean(env.HF_TOKEN), status: 'incompatible',
    reason: 'Incompatible: ZeroGPU gives a GPU only inside @spaces.GPU Python calls in a Gradio Space (PyTorch-oriented, 5 free minutes a day); Blender as its own process is not documented to see it.' });
  add('workers_ai', { credential: Boolean(env.AI), status: 'incompatible', reason: 'Incompatible: Workers AI runs hosted models, not Blender.' });
  for (const [id, a, b] of [['cloud_computer', 'CHE_COMPUTER_URL', 'CHE_COMPUTER_TOKEN'], ['vmware_training', 'CHE_VMWARE_TRAINING_URL', 'CHE_VMWARE_TRAINING_TOKEN'], ['hf_training', 'CHE_HF_TRAINING_URL', 'CHE_HF_TRAINING_TOKEN']]) {
    const has = Boolean(env[a] && env[b]);
    add(id, { credential: has, status: has ? 'unverified' : 'no_credential',
      reason: has ? 'Credentials are set, but CHE is never told this machine runs Blender, so it is not selected.' : `Not set up (${a} and ${b} are empty); setting them up would be new manual work.` });
  }
  return out;
}

// ─── Selection ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The best computer for a job from the statuses: GPU first when one is ready, else the free CPU worker (the default).
 * A GPU-only job never gets a CPU; an unverified Kaggle is chosen only for a GPU-only job, or when the owner allowed
 * unverified GPUs. Returns { provider, why } or { provider: null, why }.
 */
export function selectProvider(statuses, job, { pool = null, t = Date.now(), allowUnverified = false } = {}) {
  const s = Object.fromEntries(statuses.map((p) => [p.id, p]));
  const need = needOf(job);
  const ok = (id) => s[id] && s[id].compatible === true && (!pool || poolAllows(pool, job, id, t));
  const ready = (id) => ok(id) && s[id].status === 'ready';
  const order = need === 'none' ? ['github_actions_cpu', 'colab_gpu', 'kaggle'] : ['colab_gpu', 'kaggle', 'github_actions_cpu'];
  for (const id of order) {
    if (need === 'required' && !s[id]?.gpu) continue;
    if (ready(id)) return { provider: id, why: s[id].reason };
    if (id === 'kaggle' && allowUnverified && ok(id) && s[id].status === 'unverified') return { provider: id, why: s[id].reason, unverified: true };
  }
  if (need === 'required' && ok('kaggle') && s.kaggle.status === 'unverified') return { provider: 'kaggle', why: s.kaggle.reason, unverified: true };
  const gpuish = statuses.filter((p) => p.compatible === true && (need !== 'required' || p.gpu));
  const why = gpuish.map((p) => `${p.label}: ${p.reason}`).join(' ');
  return { provider: null, why: need === 'required' ? `This job needs a GPU and none is ready. ${why}` : `No computer can take it now. ${why}` };
}

// ─── Kaggle character kernel ─────────────────────────────────────────────────────────────────────────────────────
export const KAGGLE_CHARACTER_PY = String.raw`# CHE character kernel for a Kaggle GPU session (compute_pool.js, 2026-10-25).
# CHE pushes this script as a PRIVATE kernel in the owner's own Kaggle account, only if a Kaggle token was already
# saved in CHE's Keys. It downloads Blender __BLENDER__ from blender.org (checked against blender.org's published
# SHA-256), CHE's scripts at a pinned commit, the pinned project files and MPFB2, then runs scripts/che_gpu_worker.py
# against CHE's existing queue. The worker token below is scoped to the listed jobs, expires with this session and is
# stored by CHE only as a hash. Blender renders on the GPU when Cycles sees one; the receipt names the device. Without a
# GPU the worker is handed nothing (no CPU fallback here). Logs print job ids and stages only, never the token.
import hashlib, os, shutil, subprocess, sys, tarfile, time, urllib.request

CHE_BASE = "__CHE_BASE__"
TOKEN = "__TOKEN__"
REPO = "__REPO__"
COMMIT = "__COMMIT__"
ASSETS_COMMIT = "__ASSETS__"
MPFB_COMMIT = "__MPFB__"
BLENDER = "__BLENDER__"
DEADLINE_S = int("__DEADLINE_S__")
STARTED = time.time()
WORK = "/kaggle/working/che"
UA = {"User-Agent": "CHE-creation-worker/1.0 (+https://github.com/Vondada/chey-app)"}


def get(url, dest):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=600) as res, open(dest, "wb") as out:
        shutil.copyfileobj(res, out)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def untar(path, dest, strip=1):
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(path) as t:
        for m in t.getmembers():
            parts = m.name.split("/")[strip:]
            if not parts or ".." in parts or m.name.startswith("/"):
                continue
            m.name = "/".join(parts)
            t.extract(m, dest)


def main():
    os.makedirs(WORK, exist_ok=True)
    name = f"blender-{BLENDER}-linux-x64"
    base = f"https://download.blender.org/release/Blender{BLENDER.rsplit('.', 1)[0]}"
    get(f"{base}/{name}.tar.xz", f"{WORK}/blender.tar.xz")
    get(f"{base}/blender-{BLENDER}.sha256", f"{WORK}/blender.sha256")
    want = next((l.split()[0] for l in open(f"{WORK}/blender.sha256") if l.strip().endswith(f"{name}.tar.xz")), "")
    got = sha256(f"{WORK}/blender.tar.xz")
    if not want or want != got:
        raise SystemExit(f"BLENDER SHA-256 MISMATCH: want {want[:16]} got {got[:16]}")
    print(f"BLENDER {BLENDER} sha256 ok {got[:16]}", flush=True)
    untar(f"{WORK}/blender.tar.xz", f"{WORK}/blender")
    for url, dest in [(f"https://codeload.github.com/{REPO}/tar.gz/{COMMIT}", "repo"), (f"https://codeload.github.com/{REPO}/tar.gz/{ASSETS_COMMIT}", "assets"),
                      (f"https://codeload.github.com/makehumancommunity/mpfb2/tar.gz/{MPFB_COMMIT}", "mpfb2")]:
        get(url, f"{WORK}/{dest}.tar.gz")
        untar(f"{WORK}/{dest}.tar.gz", f"{WORK}/{dest}")
    subprocess.run("apt-get -qq install -y libxi6 libxkbcommon0 libsm6 libxrender1 libgl1 libegl1 libxxf86vm1 libxfixes3 > /dev/null 2>&1", shell=True)
    env = dict(os.environ, CHE_GPU_TOKEN=TOKEN, MPFB=f"{WORK}/mpfb2/src/mpfb/data")
    left = DEADLINE_S - (time.time() - STARTED)
    cmd = [sys.executable, f"{WORK}/repo/scripts/che_gpu_worker.py", "--worker-class", "colab_t4", "--che-url", CHE_BASE,
           "--blender", f"{WORK}/blender/blender", "--project", f"{WORK}/assets/project", "--out", f"{WORK}/jobs", "--poll", "15", "--idle-minutes", "5"]
    try:
        code = subprocess.run(cmd, cwd=f"{WORK}/repo", env=env, timeout=max(60, left)).returncode
    except subprocess.TimeoutExpired:
        code = 124
    print(f"WORKER EXIT {code}", flush=True)
    sys.exit(0 if code in (0, 3) else code)


if __name__ == "__main__":
    main()
`;

/** The kernel text with its values filled in. The token appears only here (sent to the owner's private kernel). */
export function characterKernelScript({ base, token, deadlineS, commit = POOL_COMMIT, assets = POOL_ASSETS_COMMIT, mpfb = POOL_MPFB_COMMIT, blender = POOL_BLENDER_VERSION, repo = POOL_REPO }) {
  const safe = (v, re) => { if (!re.test(String(v))) throw new Error('unsafe kernel value'); return String(v); };
  return KAGGLE_CHARACTER_PY.replace('__CHE_BASE__', safe(base, /^https:\/\/[\w.-]+(?::\d+)?$/)).replace('__TOKEN__', safe(token, /^[a-f0-9]{64}$/))
    .replace('__REPO__', safe(repo, /^[\w.-]+\/[\w.-]+$/)).replace('__COMMIT__', safe(commit, /^[a-f0-9]{40}$/)).replace('__ASSETS__', safe(assets, /^[a-f0-9]{40}$/))
    .replace('__MPFB__', safe(mpfb, /^[a-f0-9]{40}$/)).replaceAll('__BLENDER__', safe(blender, /^\d+\.\d+\.\d+$/)).replace('"__DEADLINE_S__"', `"${Math.floor(deadlineS)}"`);
}

/** Pushes and runs the character kernel (private, GPU, internet, Kaggle stops it at sessionTimeoutSeconds). */
export async function startKaggleCharacterSession(cred, { base, token, seconds, commit }, fetcher = fetch) {
  if (!cred?.auth?.username) return { ok: false, error: 'The saved Kaggle token has no username.' };
  const slug = `${cred.auth.username}/che-character-worker`;
  const body = { slug, newTitle: 'che character worker', text: characterKernelScript({ base, token, deadlineS: seconds - 300, commit }),
    language: 'python', kernelType: 'script', isPrivate: true, enableGpu: true, enableInternet: true, enableTpu: false,
    machineShape: 'NvidiaTeslaT4', sessionTimeoutSeconds: Math.floor(seconds) };
  let r;
  try { r = await kaggleCall(cred.auth, 'SaveKernel', body, fetcher, 30000); } catch (e) { return { ok: false, error: `Kaggle could not be reached (${String(e?.message || e).slice(0, 60)}).` }; }
  if (r.status === 429) return { ok: false, quota: true, error: 'Kaggle answered 429 (rate limit or quota).' };
  if (!r.ok || r.data?.error) return { ok: false, quota: /quota/i.test(String(r.data?.error || '')), error: `Kaggle did not start the kernel: ${String(r.data?.error || r.status).slice(0, 160)}.` };
  return { ok: true, ref: String(r.data.ref || slug).slice(0, 120), version: r.data.versionNumber || null };
}

// ─── Scheduling on the existing queue (called from creation_orchestrator.ensureCapacity) ────────────────────────
/**
 * Starts a Kaggle character session when it is the best choice and allowed: a waiting GPU job (GPU-only, or any GPU job
 * once Kaggle is verified or the owner allowed unverified GPUs), no GPU worker online, a token already saved, egress
 * allowed, real quota above the margin, no cooldown, no session already running. The chosen jobs are reserved for
 * KAGGLE_RESERVE_MS so the CPU worker does not take them meanwhile; if Kaggle never claims, applyPending hands them on.
 */
export async function poolSchedule(env = {}, { storage, now, fetcher = fetch, jobs, workers, pool = null, base = '' } = {}) {
  const t = clock(now)();
  pool = pool || await loadPool(storage);
  const waitingJobs = jobs.filter((j) => (j.state === 'queued' || j.state === 'paused') && !j.owner_paused && needOf(j) !== 'none');
  if (!waitingJobs.length) return { started: null, reason: '', statuses: null };
  const statuses = await providerStatuses(env, { storage, now: () => t, fetcher, pool, workers, jobs });
  const st = Object.fromEntries(statuses.map((p) => [p.id, p]));
  let started = null; let reason = '';
  // A session counts as live while its token is valid and it is either still starting or has a worker online.
  const kWorkerOnline = Object.values(workers || {}).some((w) => w.provider === 'kaggle' && t - (w.last_seen_ms || 0) < ONLINE_MS);
  const live = pool.sessions?.kaggle && (pool.tokens?.kaggle?.expires_ms || 0) > t && !pool.tokens.kaggle.revoked
    && (t - Date.parse(pool.sessions.kaggle.started_at) < KAGGLE_RESERVE_MS || kWorkerOnline);
  const want = waitingJobs.filter((j) => selectProvider(statuses, j, { pool, t, allowUnverified: pool.settings.allow_unverified_gpu }).provider === 'kaggle');
  if (want.length && !live) {
    const cred = await kaggleCredential(env, storage);
    const chosen = want.slice(0, 3);
    const token = await issuePoolToken(pool, 'kaggle', chosen.map((j) => j.id), KAGGLE_SESSION_S * 1000, t);
    const res = await startKaggleCharacterSession(cred, { base: base || env.CHE_URL || 'https://chey-app.henryjavoni.workers.dev', token, seconds: KAGGLE_SESSION_S, commit: env.CHE_POOL_COMMIT && /^[a-f0-9]{40}$/.test(env.CHE_POOL_COMMIT) ? env.CHE_POOL_COMMIT : POOL_COMMIT }, fetcher);
    if (res.ok) {
      pool.sessions.kaggle = { started_at: iso(t), ref: res.ref, job_ids: chosen.map((j) => j.id), unverified: st.kaggle.status !== 'ready' };
      for (const j of chosen) poolOf(j).reserved = { provider: 'kaggle', at: iso(t), until_ms: t + KAGGLE_RESERVE_MS };
      started = { provider: 'kaggle', jobs: chosen.map((j) => j.id), ref: res.ref };
    } else {
      pool.tokens.kaggle.revoked = true;
      coolDown(pool, 'kaggle', { kind: res.quota ? 'quota' : 'provider_error', reason: res.error, resetMs: Date.parse(pool.quota?.kaggle?.refresh || ''), blockClaims: Boolean(res.quota) }, t);
      pool.handoffs = [...pool.handoffs, { at: iso(t), job_id: chosen[0].id, from: 'kaggle', outcome: res.quota ? 'quota' : 'provider_error', reason: res.error.slice(0, 160) }].slice(-MAX_HANDOFFS);
      reason = res.error;
    }
  }
  await savePool(storage, pool);   // quota reads, cooldowns, the session and its token hash
  return { started, reason, statuses };
}

/** A GitHub dispatch answer that means a rate limit or quota (cooldown instead of hammering GitHub). */
export const isQuotaAnswer = (status, message = '') => Number(status) === 429 || (Number(status) === 403 && /rate limit|quota|abuse/i.test(String(message)));

// ─── The view, the spoken answer, and the routes ─────────────────────────────────────────────────────────────────
export async function poolView(env = {}, { storage, now, fetcher = fetch, refreshQuota = true } = {}) {
  const t = clock(now)();
  const pool = await loadPool(storage);
  const jobs = (await storage.get('gpu:jobs')) || [];
  const workers = (await storage.get('gpu:workers')) || {};
  const providers = await providerStatuses(env, { storage, now: () => t, fetcher, pool, workers, jobs, refreshQuota });
  if (refreshQuota) await savePool(storage, pool);   // a fresh quota read and any quota cooldown are kept
  const counts = {}; for (const j of jobs) counts[j.state] = (counts[j.state] || 0) + 1;
  const waiting = jobs.filter((j) => (j.state === 'queued' || j.state === 'paused') && !j.owner_paused).map((j) => {
    const sel = selectProvider(providers, j, { pool, t, allowUnverified: pool.settings.allow_unverified_gpu });
    return { id: j.id, kind: j.kind, title: String(j.title || '').slice(0, 80), state: j.state, needs_gpu: needOf(j), attempts: j.pool?.total || 0,
      next_provider: sel.provider, waiting_reason: heldReason(pool, j, t) || j.cloud?.reason || (sel.provider ? `Next: ${providerLabel(sel.provider)}.` : sel.why),
      checkpoints: Object.keys(j.checkpoints || {}) };
  });
  const cooldowns = Object.fromEntries(Object.entries(pool.cooldowns || {}).filter(([, c]) => c.until_ms > t).map(([id, c]) => [id, { until: c.until, kind: c.kind, reason: c.reason, strikes: c.strikes }]));
  const view = {
    workload: 'person_model (Blender)', spend_limit_usd: 0, providers, cooldowns, counts, waiting,
    handoffs: [...(pool.handoffs || [])].reverse(), verified: pool.verified || {}, settings: pool.settings,
    kaggle_session: pool.sessions?.kaggle ? { started_at: pool.sessions.kaggle.started_at, jobs: pool.sessions.kaggle.job_ids, active: (pool.tokens?.kaggle?.expires_ms || 0) > t && !pool.tokens?.kaggle?.revoked } : null,
    limits: { max_provider_attempts: MAX_PROVIDER_ATTEMPTS, backoff_base_s: BACKOFF_BASE_MS / 1000, backoff_max_s: BACKOFF_MAX_MS / 1000, kaggle_margin_s: KAGGLE_MARGIN_S },
  };
  view.spoken = speakPool(view);
  return view;
}

/** "Which computers can build characters" and "why is my character waiting", in plain sentences (no screen needed). */
export function speakPool(view) {
  const ready = view.providers.filter((p) => p.compatible === true && p.status === 'ready');
  const can = view.providers.filter((p) => p.compatible === true);
  const lines = [];
  lines.push(ready.length ? `${ready.length} computer${ready.length === 1 ? ' can' : 's can'} build characters right now: ${ready.map((p) => p.label).join('; ')}.`
    : 'No computer can build a character right now.');
  const other = can.filter((p) => p.status !== 'ready');
  if (other.length) lines.push(other.map((p, i) => `${i + 1}. ${p.label}: ${p.reason}`).join(' '));
  const no = view.providers.filter((p) => p.compatible === false).map((p) => p.label);
  if (no.length) lines.push(`Cannot run Blender: ${no.join(', ')}.`);
  const w = view.waiting.filter((j) => j.kind === 'person_model');
  if (w.length) lines.push(`${w.length} character${w.length === 1 ? ' is' : 's are'} waiting. ${w.slice(0, 3).map((j) => `${j.title || j.id}: ${j.waiting_reason}`).join(' ')}`);
  else lines.push('No character is waiting.');
  lines.push('Spending limit: zero dollars.');
  return lines.join(' ');
}

/** Owner GET /api/creations/pool (+ POST /api/creations/pool/settings) and the deploy probe GET /api/creations/probe/pool. */
export async function poolRoute(ctx, path, request, body = null) {
  if (path === '/api/creations/pool' || path === '/api/creations/probe/pool') {
    if (request.method !== 'GET') return json({ detail: 'Use GET.' }, 405);
    return json(await poolView(ctx.env || {}, ctx));
  }
  if (path === '/api/creations/pool/settings') {
    if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
    const pool = await loadPool(ctx.storage);
    if (body?.allow_unverified_gpu !== undefined) pool.settings.allow_unverified_gpu = body.allow_unverified_gpu === true;
    await savePool(ctx.storage, pool);
    return json({ ok: true, settings: pool.settings, spoken: `Unverified GPU computers are ${pool.settings.allow_unverified_gpu ? 'allowed for any GPU job' : 'used only for GPU-only jobs'}. Spending stays at zero dollars.` });
  }
  return null;
}
