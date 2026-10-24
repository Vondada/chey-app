// Per-tenant limits, fair scheduling and abuse protection for CHE's creation jobs (owner, 2026-10-24).
//
// Every creation request is checked here before it is queued: the tenant's plan (queued jobs, video minutes per day,
// job length, storage, parallel segments), a token-bucket rate limit, duplicate suppression, and the pre-job estimate
// against the spending limit. The spending limit is $0: a job that needs paid compute is refused with its estimate and
// a plain reason; it never starts. Workers then take jobs in fair order: priority first, then the tenant that has used
// the least compute recently (weighted by plan), then resumable work, then the oldest. One busy user cannot starve the
// rest, and nobody's job waits behind another tenant's 30-minute film. Pure functions: callers own storage.

export const OWNER_TENANT = 'owner';

/** Plans. `paid` exists for production planning only; nothing sells it, and its limits apply only with owner approval. */
export const PLANS = Object.freeze({
  owner: { weight: 4, max_queued: 50, max_job_minutes: 30, video_minutes_per_day: 600, storage_gb: 200, max_parallel_segments: 20, creations_per_minute: 20 },
  free: { weight: 1, max_queued: 3, max_job_minutes: 10, video_minutes_per_day: 30, storage_gb: 5, max_parallel_segments: 4, creations_per_minute: 4 },
  paid: { weight: 2, max_queued: 10, max_job_minutes: 30, video_minutes_per_day: 180, storage_gb: 100, max_parallel_segments: 10, creations_per_minute: 10 },
});

export const USAGE_WINDOW_MS = 24 * 3600_000;
const WAITING = new Set(['queued', 'paused']);
const PRIORITY = { high: 0, normal: 1, low: 2 };

export function planOf(tenant) {
  if (!tenant || tenant === OWNER_TENANT) return { id: 'owner', ...PLANS.owner };
  const id = typeof tenant === 'object' ? tenant.plan : 'free';
  return { id: PLANS[id] ? id : 'free', ...(PLANS[id] || PLANS.free) };
}

const tenantOf = (j) => String(j?.tenant_id || OWNER_TENANT);
const startedMs = (j) => {
  const s = (j.history || []).find((h) => h.state === 'rendering');
  return s ? Date.parse(s.at) : NaN;
};
const endedMs = (j) => {
  const e = [...(j.history || [])].reverse().find((h) => ['completed', 'failed', 'cancelled', 'paused', 'queued'].includes(h.state) && Date.parse(h.at) > startedMs(j));
  return e ? Date.parse(e.at) : NaN;
};

/**
 * Compute each tenant used in the last 24 h, in worker-seconds, from the jobs themselves (no second ledger):
 * finished runs count start to end; a running job counts up to `now`. Also video minutes requested today.
 */
export function tenantUsage(jobs = [], now = Date.now()) {
  const out = {};
  for (const j of jobs) {
    const t = tenantOf(j);
    const u = (out[t] ||= { worker_s: 0, queued: 0, video_minutes_today: 0 });
    if (WAITING.has(j.state)) u.queued += 1;
    const created = Date.parse(j.created_at);
    if (Number.isFinite(created) && now - created < USAGE_WINDOW_MS) u.video_minutes_today += Number(j.video_minutes) || 0;
    const s = startedMs(j);
    if (!Number.isFinite(s) || now - s > USAGE_WINDOW_MS) continue;
    const e = j.state === 'rendering' ? now : endedMs(j);
    if (Number.isFinite(e) && e > s) u.worker_s += (e - s) / 1000;
  }
  return out;
}

/** The claim comparator, fair across tenants: priority, then least weighted recent use, then paused, then oldest. */
export function fairOrder(jobs = [], now = Date.now(), tenants = {}) {
  const usage = tenantUsage(jobs, now);
  const share = (j) => (usage[tenantOf(j)]?.worker_s || 0) / planOf(tenants[tenantOf(j)] || tenantOf(j)).weight;
  return (a, b) => (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1)
    || share(a) - share(b)
    || (a.state === 'paused' ? 0 : 1) - (b.state === 'paused' ? 0 : 1)
    || Date.parse(a.created_at) - Date.parse(b.created_at);
}

/** Token bucket: `state` is the tenant's stored bucket ({tokens, at}); returns { ok, state, retry_s }. */
export function rateLimit(state, { perMinute, now = Date.now() } = {}) {
  const cap = Math.max(1, perMinute);
  const prev = state && Number.isFinite(state.tokens) ? state : { tokens: cap, at: now };
  const tokens = Math.min(cap, prev.tokens + ((now - prev.at) / 60_000) * cap);
  if (tokens < 1) return { ok: false, state: { tokens, at: now }, retry_s: Math.ceil(((1 - tokens) / cap) * 60) };
  return { ok: true, state: { tokens: tokens - 1, at: now }, retry_s: 0 };
}

/**
 * Admission: may this tenant queue this job now? `request` = { minutes, fingerprint, estimate }, `ctx` = { jobs,
 * tenant, storageGb, bucket, spendLimitUsd, freeCapacity, now }. Returns { ok, reason?, bucket, plan }.
 * Order matters: the cheapest, most specific refusal first, and every refusal is one plain sentence.
 */
export function admit(request = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const tenant = ctx.tenant || OWNER_TENANT;
  const plan = planOf(tenant);
  const id = typeof tenant === 'object' ? tenant.id : tenant;
  const jobs = ctx.jobs || [];
  const mine = jobs.filter((j) => tenantOf(j) === String(id));
  const usage = tenantUsage(mine, now)[String(id)] || { queued: 0, video_minutes_today: 0 };
  const minutes = Math.max(0, Number(request.minutes) || 0);
  const no = (reason, extra = {}) => ({ ok: false, reason, plan: plan.id, ...extra });
  if (minutes > plan.max_job_minutes) return no(`A ${minutes}-minute video is longer than this plan allows (${plan.max_job_minutes} minutes). Nothing was queued.`);
  if (usage.queued >= plan.max_queued) return no(`You already have ${usage.queued} jobs waiting, the most this plan queues at once. Nothing was queued; it starts when one finishes.`);
  if (usage.video_minutes_today + minutes > plan.video_minutes_per_day) return no(`That would make ${usage.video_minutes_today + minutes} video minutes today; this plan allows ${plan.video_minutes_per_day}. Nothing was queued.`);
  if ((ctx.storageGb || 0) >= plan.storage_gb) return no(`Your library is at its ${plan.storage_gb} GB limit. Nothing was queued; remove something you no longer need (CHE asks you first).`);
  if (request.fingerprint && mine.some((j) => j.fingerprint === request.fingerprint && WAITING.has(j.state) && now - Date.parse(j.created_at) < 60_000)) {
    return no('The same request is already waiting from a moment ago, so it was not queued twice.', { duplicate: true });
  }
  const rl = rateLimit(ctx.bucket, { perMinute: plan.creations_per_minute, now });
  if (!rl.ok) return no(`Too many requests in a minute. Try again in ${rl.retry_s} seconds; nothing was queued.`, { bucket: rl.state, retry_s: rl.retry_s });
  const spend = spendGate(request.estimate, { spendLimitUsd: ctx.spendLimitUsd ?? 0, freeCapacity: ctx.freeCapacity !== false });
  if (!spend.ok) return no(spend.reason, { bucket: rl.state });
  return { ok: true, plan: plan.id, bucket: rl.state, path: spend.path, max_parallel_segments: plan.max_parallel_segments };
}

/**
 * The spending gate for one job's estimate (capacity_model.estimateVideo). With the default $0 limit, a job runs only
 * on free capacity (slower); if it would need paid compute it is refused with the estimate. Never spends silently.
 */
export function spendGate(estimate, { spendLimitUsd = 0, freeCapacity = true } = {}) {
  const paid = Number(estimate?.cost_usd?.paid) || 0;
  if (freeCapacity) return { ok: true, path: 'free' };
  if (paid <= spendLimitUsd) return { ok: true, path: paid > 0 ? 'paid_within_limit' : 'free' };
  return { ok: false, reason: `This needs paid compute (about $${paid.toFixed(2)} by CHE's estimate) and your spending limit is $${spendLimitUsd}. Nothing was started; raising the limit needs your approval.` };
}
