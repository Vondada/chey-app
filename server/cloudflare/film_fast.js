// Fast films on Modal (owner, 2026-11-07: "I need to be able to create like at least a 1-minute video in 5 minutes";
// asked which way, he chose Modal for speed inside his $10-a-month cap; then: "do everything to make that happen for
// free, or just use what I already gave you permission to use — the closest thing possible to free").
//
// So fast mode is OPT-IN per film: only when the owner says so for this film ("make it fast with Modal", "use Modal
// for this film"). The default stays free (the Kaggle farm). Rules held in code here:
// - CHE says the estimated cost and the money left this month BEFORE anything starts (fastQuote, in the film's plan).
// - The one monthly Modal check (modal_gpu.modalMonthCheckFor) is made with this film's WORST case (every container
//   running to its hard timeout), when the film is planned and again at dispatch. Over the cap: nothing goes to Modal,
//   the film runs free, and CHE says why.
// - The farm is recorded in the same Modal ledger as Blender calls (pool:state, kind 'film') at its worst case while
//   open, then reconciled with the containers' measured seconds; the finished film says its real cost.
// - The Modal app's film workers are the same farm worker the Kaggle session runs (tools/modal/film_worker.py): they
//   claim jobs through CHE's existing /api/film/farm routes with the film's scoped farm token, so CHE's own checks still
//   decide what counts as a clip.
import { MODAL_POOL_KEY, modalCall, modalCredential, modalMonthCheckFor, modalStateOf } from './modal_gpu.js';
import { routeWork } from './compute_pool.js';

// Modal's published per-second GPU prices, read from search snapshots of modal.com/pricing (usagepricing.com's Modal
// rate-card capture of 2026-07-14 and hostfleet's April 2026 serverless matrix, both listing L40S $0.000542/s, A10G
// $0.000306/s, L4 $0.000222/s, H100 $0.001097/s). modal.com itself was not reachable from the build container.
export const FILM_MODAL_GPU = 'L40S';
export const FILM_MODAL_USD_S = 0.000542;
export const FILM_MODAL_PRICE_SOURCE = 'Modal rate card as captured by usagepricing.com (2026-07-14) and hostfleet.pages.dev (April 2026): L40S $0.000542/s; not read on modal.com itself.';
export const FILM_WORKER_TIMEOUT_S = 420;   // tools/modal/che_modal_app.py FILM_WORKER_TIMEOUT_S
export const MAX_CLIP_WORKERS = 10;         // film_worker.MAX_CLIP_WORKERS
export const MAX_LIP_WORKERS = 6;           // film_worker.MAX_LIP_WORKERS
export const FAST_SEGMENTS = 6;             // assembly runners for a fast film (one dispatch, all at once)

// Starting numbers, ESTIMATED (no fast film has run yet); measured values replace them in the film's rates.
export const FAST_RATES = Object.freeze({
  modal_cold_s: 75,       // container start + loading the 13B clip model from the image's disk onto the GPU
  modal_clip_s: 40,       // one 121-frame 768x448 clip with the distilled model's 8 steps on an L40S
  modal_lip_cold_s: 45,   // container start for lip sync (LatentSync is preinstalled in its image)
  modal_lipsync_s: 60,    // one talking shot through LatentSync 1.5 (20 steps, DeepCache) on an L40S
  script_s: 30, pictures_s: 60, assemble_s: 120,
});

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const r4 = (n) => Math.round(Number(n || 0) * 10000) / 10000;
const money = (n) => `$${r2(n).toFixed(2)}`;
const minutes = (s) => (s < 90 ? `${Math.round(s)} seconds` : `${Math.round(s / 60)} minutes`);

export { fastAsked } from './film_fast_words.js';

/** The farm for `clips` moving shots and `lips` lip syncs: how many containers, how long, and what it costs. */
export function fastEstimate({ clips = 0, lips = 0, rates = {} } = {}) {
  const r = { ...FAST_RATES, ...rates };
  const clipWorkers = Math.min(MAX_CLIP_WORKERS, Math.max(0, clips));
  const lipWorkers = Math.min(MAX_LIP_WORKERS, Math.max(0, lips));
  const clipRounds = clipWorkers ? Math.ceil(clips / clipWorkers) : 0;
  const lipRounds = lipWorkers ? Math.ceil(lips / lipWorkers) : 0;
  const clipPhase = clipWorkers ? r.modal_cold_s + clipRounds * r.modal_clip_s : 0;
  // A talking shot is lip-synced on its moving clip, so lip sync waits for the clip phase (that wait is billed).
  const lipStart = Math.max(r.modal_lip_cold_s, clipPhase);
  const farmWall = Math.max(clipPhase, lipWorkers ? lipStart + lipRounds * r.modal_lipsync_s : 0);
  const gpuSeconds = clipWorkers * (clipPhase + 5) + lipWorkers * (lipStart + lipRounds * r.modal_lipsync_s + 5);
  const workers = clipWorkers + lipWorkers;
  // The farm is dispatched while the pictures are drawn, so its cold start overlaps them.
  const wall = r.script_s + Math.max(r.pictures_s, farmWall) + r.assemble_s;
  return {
    clips, lips, clip_workers: clipWorkers, lip_workers: lipWorkers, workers,
    gpu: FILM_MODAL_GPU, usd_s: FILM_MODAL_USD_S, gpu_seconds: Math.round(gpuSeconds),
    usd: r4(gpuSeconds * FILM_MODAL_USD_S),
    worst_usd: r4(workers * FILM_WORKER_TIMEOUT_S * FILM_MODAL_USD_S),
    wall_s: Math.round(wall), farm_s: Math.round(farmWall), provenance: 'ESTIMATED',
  };
}

/**
 * Whether this film may run fast on Modal, and the sentence CHE says first. Uses the one monthly cap check with the
 * film's worst case. { ok, est, check, said }.
 */
export async function fastQuote(storage, { clips, lips, rates } = {}, t = Date.now()) {
  const est = fastEstimate({ clips, lips, rates });
  if (!est.workers) return { ok: false, est, said: 'Fast mode only speeds up moving shots and lip sync, and this film has none, so it runs as planned.' };
  const check = await modalMonthCheckFor(storage, est.worst_usd, t);
  const route = routeWork('film_clip_fast', [], { modal: check });
  if (!route.route) return { ok: false, est, check, said: `Fast mode is not available, so this film runs free: ${check.reason || route.why}` };
  const left = check.left_usd == null ? '' : ` ${money(Math.max(0, check.left_usd - est.worst_usd))} of this month's Modal money stays free even if every GPU runs to its limit.`;
  return { ok: true, est, check, said: `Fast mode on Modal: about ${money(est.usd)} for this film (${est.workers} ${FILM_MODAL_GPU} GPUs at once, at most ${money(est.worst_usd)} if every one runs to its time limit), inside your ${money(check.cap_usd)} a month.${left} About ${minutes(est.wall_s)} from now, by my starting numbers.` };
}

const filmKey = (film, n = 1) => `film:${film.id}:modal:${n}`;
// Answers from the app itself that mean nothing is running: a refusal, or its own 500 (/film_farm cancels every copy it
// spawned and frees the key before answering 500, or failed before spawning; a missing import fails the same way).
// Only no answer at all (a timeout, a network error, a gateway 502/503/504) leaves the farm uncertain.
const DEFINITE = [400, 401, 403, 404, 422, 500];

async function editPool(storage, fn) {
  const pool = (await storage.get(MODAL_POOL_KEY)) || {};
  const out = fn(modalStateOf(pool), pool);
  await storage.put(MODAL_POOL_KEY, pool);
  return out;
}

/**
 * Starts the fast farm for `film` (called from film_pipeline.dispatchFarm when film.fast is set). Checks the cap again
 * with the worst case, records the farm in the Modal ledger, then POSTs /film_farm. Returns { ok, farm } or
 * { ok: false, why } (the caller then runs the free farm and the film's notes say why).
 */
export async function startFastFarm(ctx, film, { token, record, clips, lips }) {
  const t = ctx.now || Date.now();
  const quote = await fastQuote(ctx.storage, { clips, lips, rates: film.fast?.rates }, t);
  if (!quote.ok) return { ok: false, why: quote.said.replace(/^Fast mode is not available, so this film runs free: /, '') };
  const { cred } = await modalCredential(ctx.env, ctx.storage);
  if (!cred) return { ok: false, why: 'Modal is not connected (run the "CHE Modal deploy" workflow)' };
  const health = await modalCall(cred, 'GET', '/health', null, ctx.fetcher || fetch, 20000);
  if (!health.ok || !(health.data?.functions || []).includes('film_farm')) return { ok: false, why: 'the Modal app does not have the fast film workers yet (run the "CHE Modal deploy" workflow)' };
  const n = Number(film.fast?.attempt || 0) + 1;
  const key = filmKey(film, n);
  const est = quote.est;
  await editPool(ctx.storage, (m) => {
    m.calls[key] = { key, kind: 'film', provider: 'modal', film_id: film.id, job_ids: [], state: 'dispatching', dispatched_ms: t, dispatched_at: new Date(t).toISOString(),
      gpu: FILM_MODAL_GPU, usd_hr: FILM_MODAL_USD_S * 3600, estimate_s: est.gpu_seconds, worst_usd: est.worst_usd, gpu_seconds: null, ended_ms: null, error: '' };
  });
  const r = await modalCall(cred, 'POST', '/film_farm', { idempotency_key: key.replace(/:/g, '-').slice(0, 96), che_base: ctx.base, film_id: film.id, farm_token: token,
    clips: est.clip_workers, lips: est.lip_workers, deadline_s: FILM_WORKER_TIMEOUT_S }, ctx.fetcher || fetch, 30000);
  const started = r.ok && r.data?.ok !== false;
  await editPool(ctx.storage, (m) => {
    const c = m.calls[key];
    if (started) { c.state = 'started'; c.calls = (r.data?.calls || []).map((x) => ({ kind: x.kind, call_id: String(x.call_id || '').slice(0, 80) })); }
    else if (DEFINITE.includes(r.status)) { c.state = 'not_started'; c.ended_ms = t; c.error = `Modal refused the fast film (HTTP ${r.status})`; }
    else { c.state = 'unknown'; c.error = r.status ? `Modal answered HTTP ${r.status}` : `no answer from Modal (${r.error || 'network'})`; }
  });
  film.fast = { ...(film.fast || {}), attempt: n, key, estimate_usd: est.usd, worst_usd: est.worst_usd, workers: est.workers, started_ms: t };
  if (!started && DEFINITE.includes(r.status)) return { ok: false, why: `Modal refused the fast film (HTTP ${r.status}${r.data?.error ? `: ${String(r.data.error).slice(0, 120)}` : ''}); nothing was charged` };
  // An unknown answer may still have started containers: the farm is kept open (and counted at its worst case) and
  // its status is read by key, so nothing is started twice.
  return { ok: true, farm: { ...record, provider: 'modal', key, started_ms: t, workers: est.workers } };
}

/**
 * One look at the fast farm. Reconciles the ledger with the measured seconds once every container has returned.
 * Returns '' while it runs or when it finished with every clip; otherwise the reason shots stay stills.
 */
export async function settleFastFarm(ctx, film) {
  const t = ctx.now || Date.now();
  const { cred } = await modalCredential(ctx.env, ctx.storage);
  const key = film.farm?.key;
  if (!cred || !key) return 'Modal is no longer connected';
  const r = await modalCall(cred, 'POST', '/film_farm/status', { idempotency_key: key.replace(/:/g, '-').slice(0, 96) }, ctx.fetcher || fetch, 20000);
  const tooLate = t > Number(film.farm.started_ms || t) + (FILM_WORKER_TIMEOUT_S + 180) * 1000;
  if (!r.ok || r.data?.state === 'running' || r.data?.state === 'unknown') {
    if (!tooLate) return '';
    await editPool(ctx.storage, (m) => { const c = m.calls[key]; if (c && !c.ended_ms) { c.state = 'lost'; c.ended_ms = t; c.gpu_seconds = Number(c.worst_usd) / FILM_MODAL_USD_S; c.error = 'status not read; counted at its worst case'; } });
    film.fast = { ...(film.fast || {}), cost_usd: film.fast?.worst_usd, cost_provenance: 'ESTIMATED' };
    return 'the Modal GPUs ran past their time limit';
  }
  const rows = Array.isArray(r.data?.calls) ? r.data.calls : [];
  // Each container's measured seconds, plus a 20 s allowance for the image start before the function body ran.
  const seconds = rows.reduce((s, c) => s + (Number(c.gpu_seconds) > 0 ? Number(c.gpu_seconds) + 20 : FILM_WORKER_TIMEOUT_S), 0);
  const failed = rows.filter((c) => c.state === 'failed');
  await editPool(ctx.storage, (m) => {
    const c = m.calls[key];
    if (!c) return;
    c.state = failed.length === rows.length && rows.length ? 'failed' : 'done'; c.ended_ms = t; c.ended_at = new Date(t).toISOString();
    c.gpu_seconds = Math.round(seconds); c.gpu_seconds_provenance = 'OBSERVED';
    if (failed.length) c.error = String(failed[0].error || 'a GPU worker failed').slice(0, 200);
  });
  film.fast = { ...(film.fast || {}), cost_usd: r4(seconds * FILM_MODAL_USD_S), gpu_seconds: Math.round(seconds), cost_provenance: 'OBSERVED', ended_ms: t };
  return failed.length ? `a Modal GPU worker failed (${String(failed[0].error || 'no reason given').slice(0, 120)})` : 'the Modal GPUs finished';
}

export { fastDoneLine } from './film_fast_words.js';

/**
 * Fast mode for a film being planned (startFilm, rerenderFilm): when the owner asked, the cost quote CHE says first,
 * and the film's fast record; the assembly gets more runners at once. { fast, said }: fast is null when not asked.
 */
export async function planFast(ctx, plan, asked, { talking = null } = {}) {
  if (!asked) return { fast: null, said: '' };
  // Modal's own plan, never the free farm's: with Kaggle and Hugging Face both unavailable the free plan has no moving
  // shots and no lip sync, which is exactly when the owner asks for Modal.
  const fp = fastReplan(plan, { talking });
  const quote = await fastQuote(ctx.storage, { clips: fp.tier_a, lips: fp.lip_sync }, ctx.now || Date.now());
  if (!quote.ok) return { fast: { on: false, declined: quote.said.replace(/^Fast mode is not available, so this film runs free: /, '') }, said: quote.said };
  Object.assign(plan, fp);
  return { fast: { on: true, estimate_usd: quote.est.usd, worst_usd: quote.est.worst_usd, workers: quote.est.workers, wall_s: quote.est.wall_s, quoted_at: new Date(ctx.now || Date.now()).toISOString() }, said: quote.said };
}

// Notes from the free plan about what the free GPUs could not do; a fast film is not limited by them.
const FREE_FARM_NOTE = /\b(?:free GPU|Kaggle|GPU farm|shots move;|No shot can move|lip sync)\b/i;

/**
 * The plan of a fast film from Modal's capabilities: every shot moves, every talking shot is lip-synced (about half
 * until the screenplay says), the assembly runs on FAST_SEGMENTS runners at once, and the ETA is the fast estimate.
 * Applied when the film is planned and again after the screenplay's replan (film_pipeline.writeStep), which would
 * otherwise put back the free farm's numbers. Pure: returns a new plan.
 */
export function fastReplan(plan, { talking = null } = {}) {
  if (!plan?.ok) return plan;
  const shots = Math.max(0, Number(plan.shots) || 0);
  const lips = Math.min(shots, Math.max(0, Math.round(talking == null ? shots / 2 : Number(talking))));
  const est = fastEstimate({ clips: shots, lips });
  const deadline = Number(plan.deadline_s) || 0;
  return {
    ...plan, fast: true, tier_a: shots, tier_b: 0, lip_sync: lips,
    segments: Math.max(Number(plan.segments) || 1, Math.min(FAST_SEGMENTS, shots || 1)),
    eta_s: est.wall_s, meets_deadline: deadline === 0 || est.wall_s <= deadline,
    parts: { ...(plan.parts || {}), clips_s: est.farm_s, lip_sync_s: 0 },
    providers_used: [...new Set([...(plan.providers_used || []).filter((id) => !['kaggle', 'hf_zerogpu'].includes(id)), 'modal'])],
    notes: (plan.notes || []).filter((n) => !FREE_FARM_NOTE.test(n)),
  };
}
