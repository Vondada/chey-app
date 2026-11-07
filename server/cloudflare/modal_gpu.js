// Modal GPU provider for the compute pool (owner spec docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md, Stages 2 and 3).
//
// Part of compute_pool.js (state lives in `pool:state` as `pool.modal`), not a second pool, queue or vault. CHE's
// Modal app (tools/modal/che_modal_app.py, deployed by .github/workflows/che-modal-deploy.yml) exposes one endpoint
// protected by a bearer token the deploy workflow issues to both sides (or a pasted Proxy Auth Token):
//   GET /health  POST /blender_preview  POST /status  POST /cancel
// The GPU call runs CHE's existing worker (scripts/che_gpu_worker.py) against CHE's existing queue with a scoped pool
// token, so artifacts land in CHE's media store through the existing worker routes and are SHA-256 checked there.
//
// Facts this module is built on (read 2026-10-25, cited in the doc):
// - Web functions with requires_proxy_auth=True need the Modal-Key / Modal-Secret headers of a workspace Proxy Auth
//   Token (wk-… / ws-…); requests without them get 401 and start no container (modal.com/docs/guide/webhook-proxy-auth).
// - Programmatic billing reports are Team/Enterprise only and show costs before credits (modal.com/docs/guide/billing),
//   so on Starter the credit LEFT is not observable by CHE: it is always UNAVAILABLE here.
// - Modal's workspace spend limit caps net charges after credits and stops workloads past it
//   (modal.com/docs/guide/budgets). The owner setting it to $0 is what makes included-credit use free; CHE's own
//   estimate is only an earlier, conservative stop.
// - "$30/month of compute on Starter" comes from third-party listings (not confirmed on modal.com from here), so CHE
//   never assumes it: the owner states the credit his Modal Usage page shows.
//
// Rules held in code (dispatch refuses otherwise, not only words):
// - No credential, an unverified connection, the owner's opt-in missing, his $0 spend-limit confirmation missing, the
//   credit amount unknown, or CHE's monthly estimate at the stop line → no dispatch; the job waits with the reason.
// - Only GPU-required jobs go to Modal; CPU-capable work never does.
// - One idempotency key per job attempt; an uncertain dispatch is checked by key before anything else happens, and an
//   open call is cancelled (or confirmed ended) before its job goes to any other provider: never billed twice.
// - The proxy token is read from the owner's key store, sent only in those two headers to *.modal.run, and never put
//   in a view, a log, a letter or a reply.
import { MODAL_PASTE_REFUSAL, storedKeys } from './resilience.js';
import { PAID_GPU_PRICES } from './compute_budget.js';
import { testBudgetMonthOf } from './gpu_test_budget.js';

export const MODAL_APP_VERSION = 'che-modal-3';          // tools/modal/che_modal_app.py APP_VERSION
export const MODAL_ENV = 'MODAL_TOKEN';                  // the key-store slot "CHE, connect Modal" saves into
// Modal serves endpoints at <workspace>--che-gpu.modal.run or with one region label (…--che-gpu.us-east.modal.run, which
// the deploy workflow wrote on 2026-10-25); nothing else, so the token can only ever go to CHE's own app.
export const MODAL_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}--che-gpu(?:-[a-z0-9-]{1,30})?(?:\.[a-z0-9-]{1,30})?\.modal\.run$/;
export const MODAL_GPU = 'T4';
export const MODAL_USD_HR = PAID_GPU_PRICES.modal.gpus.find((g) => g.id === MODAL_GPU).usd_hr;
export const MODAL_PRICE_SOURCE = PAID_GPU_PRICES.modal.source;
export const MODAL_CALL_S = 45 * 60;                     // the app's per-call timeout (MAX_CALL_S)
export const MODAL_SCALEDOWN_S = 60;                     // idle container time Modal bills after a call (SCALEDOWN_S)
export const MODAL_STARTUP_S = 60;                       // cold start allowance counted in every estimate
export const MODAL_JOB_RESERVE_S = 30 * 60;              // what one more job is assumed to use before it starts
export const MODAL_RESERVE_MS = 12 * 60_000;             // a started call must claim its job within 12 minutes
export const MODAL_STATUS_GRACE_MS = 15 * 60_000;        // past the call deadline, an unreachable call is closed as lost
export const MAX_CALLS_KEPT = 300;
export const PROVENANCE = Object.freeze(['OBSERVED', 'ESTIMATED', 'USER-ENTERED', 'UNAVAILABLE']);
export const THIRD_PARTY_CREDIT_USD = 30;                // only quoted, never used as the credit

const iso = (ms) => new Date(ms).toISOString();
const r4 = (n) => Math.round(Number(n || 0) * 10000) / 10000;
const money = (n) => `$${(Math.round(Number(n || 0) * 100) / 100).toFixed(2)}`;
const short = (v, n = 160) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
const monthOf = (ms) => iso(ms).slice(0, 7);
/** CHE stops auto-dispatch this far below the stated credit: 15% of it, at least $5 ($25 of $30). */
export const creditStopUsd = (credit) => Math.max(0, Math.round((Number(credit || 0) - Math.max(5, Number(credit || 0) * 0.15)) * 100) / 100);

// ─── The owner's monthly Modal cap (Creative Studio stage 5) ──────────────────────────────────────────────────────
// Asked "should Modal be capped at $10 a month, for when a paid GPU is needed?", the owner answered "Yes cap 10 a month"
// (2026-11-06 22:29 UTC, Claude Code session), then "Done, set to $10" (22:30 UTC: he set Modal's own workspace spend
// limit to $10). So CHE may use Modal past its included credit, but its own estimate of ALL Modal use in a calendar
// month (UTC) — Blender GPU calls, GPU pictures, open calls at their worst case — stays at least marginUsd(cap) under
// the cap. MODAL_MONTHLY_CAP_USD is the ceiling: the owner can lower it by voice ("cap Modal at 5 dollars a month"),
// and raising it is a code change he approves. Modal's own $10 spend limit is the backstop behind CHE's stop line.
export const MODAL_MONTHLY_CAP_USD = 10;
export const MODAL_POOL_KEY = 'pool:state';              // compute_pool.POOL_KEY (the pool holds the Modal ledger)
export const OWNER_MODAL_CAP = Object.freeze({ usd: MODAL_MONTHLY_CAP_USD, at: '2026-11-06T22:29:41.139Z', words: 'Yes cap 10 a month', provenance: 'OWNER-APPROVED', via: 'Claude Code session' });
export const OWNER_MODAL_SPEND_LIMIT = Object.freeze({ usd: 10, at: '2026-11-06T22:30:59.623Z', words: 'Done, set to $10', provenance: 'OWNER-APPROVED', via: 'Claude Code session' });
/** The money kept back under the monthly cap: 5% of it, at least 25 cents (compute_budget.marginUsd). */
export const capMarginUsd = (cap) => (cap > 0 ? Math.max(0.25, Math.round(Number(cap) * 5) / 100) : 0);
/** Worst case of one Blender GPU call: its whole timeout plus cold start and idle time, at the T4 price. */
export const MODAL_CALL_WORST_USD = Math.round((MODAL_CALL_S + MODAL_STARTUP_S + MODAL_SCALEDOWN_S) * MODAL_USD_HR / 3600 * 10000) / 10000;

// ─── Credential: wk-ID:ws-SECRET@<endpoint> ──────────────────────────────────────────────────────────────────────
/**
 * The saved credential, parsed: a workflow-issued bearer token or a Proxy Auth Token (id + secret), and the endpoint base URL of CHE's deployed app,
 * pasted as `wk-…:ws-…@https://<workspace>--che-gpu.modal.run` (or `@<workspace>`). Only *.modal.run hosts of the
 * che-gpu label are accepted, so the token can never be sent anywhere else. Returns null when malformed.
 */
/** The Keys row for Modal: connected by the deploy workflow, so there is no key to paste (owner, 2026-10-25). */
export async function modalKeyRowFor(env, storage) { return modalKeyRow({ exists: (await modalCredential(env, storage)).exists }); }
export function modalKeyRow({ exists = false, page = 'https://modal.com/settings' } = {}) {
  return {
    id: 'modal', name: 'Modal (CHE GPU app)', page,
    status: exists ? 'not tried yet' : 'not set up',
    last4: '',
    detail: MODAL_PASTE_REFUSAL,
    readonly: true,
    check: 'modal',
  };
}

export function parseModalCredential(raw) {
  const text = String(raw || '').trim();
  // `bearer:<token>@<endpoint>`: the form the "CHE Modal deploy" workflow writes into the Worker secret MODAL_TOKEN
  // itself (a random token it also stores as the Modal secret che-gpu-auth), so no person handles it.
  const b = /^bearer:([A-Za-z0-9_-]{32,128})@(\S{1,200})$/.exec(text);
  const m = b ? [text, '', '', b[2]] : /^(wk-[A-Za-z0-9_-]{6,128}):(ws-[A-Za-z0-9_-]{6,128})@(\S{1,200})$/.exec(text);
  if (!m) return null;
  let base = m[3];
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(base)) base = `https://${base}--che-gpu.modal.run`;
  let u;
  try { u = new URL(base); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.port || u.search || u.hash || u.username || (u.pathname && u.pathname !== '/') || !MODAL_HOST_RE.test(u.hostname)) return null;
  return b ? { bearer: b[1], base: `https://${u.hostname}`, host: u.hostname } : { id: m[1], secret: m[2], base: `https://${u.hostname}`, host: u.hostname };
}
/** A Modal API token (ak-…:as-…) is the DEPLOY credential: it belongs in GitHub secrets, never in CHE's Worker. */
export const isModalDeployToken = (raw) => /^ak-[A-Za-z0-9_-]{6,}:as-[A-Za-z0-9_-]{6,}$/.test(String(raw || '').trim());
export const MODAL_FORMAT_HELP = 'Nothing needs pasting: the "CHE Modal deploy" GitHub workflow connects me itself (it needs the GitHub Actions secrets MODAL_TOKEN_ID and MODAL_TOKEN_SECRET). A Modal Proxy Auth Token also works, pasted as wk-ID:ws-SECRET@https://your-workspace--che-gpu.modal.run. An ak-…:as-… API token is the deploy key: it belongs in GitHub secrets, not in CHE.';

/** { exists, cred, deploy_token } from the owner's key store, else the Worker env. Never the value outward. */
export async function modalCredential(env = {}, storage) {
  let keys = {};
  try { keys = await storedKeys(storage); } catch (_) { keys = {}; }
  const raw = String(keys[MODAL_ENV] || env[MODAL_ENV] || '').trim();
  return { exists: Boolean(raw), cred: parseModalCredential(raw), deploy_token: isModalDeployToken(raw) };
}

/** One authenticated call to CHE's Modal app. Never throws; never returns the headers. */
export async function modalCall(cred, method, path, body = null, fetcher = fetch, timeout = 20000) {
  if (!cred?.base || !MODAL_HOST_RE.test(new URL(cred.base).hostname)) return { ok: false, status: 0, data: null, error: 'no valid Modal endpoint' };
  try {
    const r = await fetcher(`${cred.base}${path}`, { method, headers: { ...(cred.bearer ? { Authorization: `Bearer ${cred.bearer}` } : { 'Modal-Key': cred.id, 'Modal-Secret': cred.secret }), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
    // The body is read once as text, so a refusal that is not JSON (or JSON in another shape) keeps its words too.
    // A response that can only be read as JSON (a test stand-in) is read that way, as before.
    let text = '';
    let data = null;
    if (typeof r.text === 'function') {
      text = await r.text().catch(() => '');
      try { data = JSON.parse(text); } catch { data = null; }
    } else {
      data = await r.json().catch(() => null);
    }
    // Modal's own call ID, when its proxy sends one, so a failure can be found in Modal's logs. Never a secret.
    const upstream = short(r.headers?.get?.('modal-function-call-id') || '', 64).replace(/[^A-Za-z0-9_-]/g, '');
    // A refusal's body, short and printable, for the reason only (the handler's own message, never a secret).
    // Kept only for a body that is not JSON at all: a JSON answer already says its reason in `error` or `detail`.
    const plain = text.trim();
    const refusalText = r.ok || data !== null || !plain || plain === 'null' ? '' : plain.replace(/[^\x20-\x7E]/g, '').slice(0, 300);
    return { ok: r.ok, status: r.status, data, ...(refusalText ? { refusal_text: refusalText } : {}), ...(upstream ? { upstream_id: upstream } : {}) };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: short(e?.message || e, 80) };
  }
}

/**
 * The verification probe: an authenticated GET /health that must answer the expected app and version. Only this makes
 * Modal "Connected". { ok, auth: ok|invalid|not_deployed|version_mismatch|rate_limited|network|refused|credential_unreadable,
 * detail, upstream_id? }.
 */
export async function modalHealth(cred, fetcher = fetch) {
  if (!cred) return { ok: false, auth: 'credential_unreadable', detail: `CHE has a saved Modal connection, but it is not a che-gpu *.modal.run endpoint with a bearer token CHE can read, so nothing was sent. Run the "CHE Modal deploy" workflow again to rewrite it` };
  const r = await modalCall(cred, 'GET', '/health', null, fetcher, 30000);
  const up = r.upstream_id ? { upstream_id: r.upstream_id } : {};
  const h = modalHealthAnswer(cred, r);
  return { ...h, http_status: r.status || null, ...up };
}

function modalHealthAnswer(cred, r) {
  if (r.status === 401 || r.status === 403) return { ok: false, auth: 'invalid', detail: `CHE's Modal app rejected the access token (HTTP ${r.status}); token rejected. Run the "CHE Modal deploy" workflow again to issue a new one, then connect again` };
  if (r.status === 404) return { ok: false, auth: 'not_deployed', detail: `Nothing answers at ${cred.host} (HTTP 404): CHE's Modal app is not deployed there. Run the "CHE Modal deploy" GitHub workflow first (it needs the MODAL_TOKEN_ID and MODAL_TOKEN_SECRET repository secrets), then connect again` };
  if (r.status === 429) return { ok: false, auth: 'rate_limited', detail: 'Modal answered 429 (rate limit); try again in a minute' };
  if (r.status === 0) return { ok: false, auth: 'network', detail: `Modal could not be reached (${r.error || 'network'})` };
  if (!r.ok) return { ok: false, auth: 'refused', detail: `Modal answered HTTP ${r.status}` };
  if (r.data?.app !== 'che-gpu' || r.data?.version !== MODAL_APP_VERSION) {
    return { ok: false, auth: 'version_mismatch', detail: `The app at ${cred.host} is ${short(r.data?.app || 'unknown', 30)} version ${short(r.data?.version || 'unknown', 30)}, not che-gpu ${MODAL_APP_VERSION}. Run the "CHE Modal deploy" workflow again, then connect again` };
  }
  return { ok: true, auth: 'ok', version: r.data.version, gpu: short(r.data.gpu || MODAL_GPU, 20),
    detail: `CHE's Modal app accepted the access token and answered at ${cred.host} (che-gpu ${MODAL_APP_VERSION}, ${short(r.data.gpu || MODAL_GPU, 20)} GPU, scales to zero). The check ran one short CPU call, a fraction of a cent of Modal time` };
}

/**
 * The deploy's Modal check (owner, 2026-10-27): the Worker's POST /api/probe/modal, which exists only for that deploy's
 * random probe token, asks the owner's object to run the same authenticated GET /health as Check Connection with the
 * real MODAL_TOKEN. The answer holds the category, a check ID, the time, the HTTP status, whether the credential is
 * readable, the host, and on success the app version and GPU. Read-only: no onboarding state changes, no GPU starts,
 * no secret or reason text in the reply.
 */
export async function modalProbe(env, storage, fetcher = fetch, now = Date.now()) {
  const base = { request_id: `chk_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, at: new Date(now).toISOString() };
  const c = await modalCredential(env, storage);
  if (!c.exists) return { ok: false, category: 'missing_credential', ...base, http_status: null, credential: 'absent' };
  const h = await modalHealth(c.cred, fetcher);
  return { ok: h.ok, category: h.auth === 'invalid' ? 'unauthorized' : h.auth, ...base, http_status: h.http_status ?? null, credential: c.cred ? 'readable' : 'unreadable',
    host: c.cred?.host || null, ...(h.ok ? { version: h.version, gpu: h.gpu } : {}), ...(h.upstream_id ? { upstream_id: h.upstream_id } : {}) };
}

// ─── The owner's included-credit policy (USER-ENTERED, with time and exact words) ────────────────────────────────
export function modalStateOf(pool) {
  // Normalized in place: every caller holds the same object.
  if (!pool.modal || typeof pool.modal !== 'object') pool.modal = {};
  const m = pool.modal;
  for (const k of ['opt_in', 'opt_out', 'spend_limit_zero', 'spend_limit', 'paid_cap', 'stated_credit', 'approve_next']) if (m[k] === undefined) m[k] = null;
  if (!Array.isArray(m.history)) m.history = [];
  if (!m.calls || typeof m.calls !== 'object') m.calls = {};
  return m;
}
const entered = (words, t, extra = {}) => ({ at: iso(t), words: short(words, 200), provenance: 'USER-ENTERED', ...extra });
function remember(m, what, words, t) { m.history = [...(m.history || []), { at: iso(t), what, words: short(words, 200) }].slice(-30); }

export const openCalls = (pool) => Object.values(modalStateOf(pool).calls).filter((c) => ['dispatching', 'unknown', 'started', 'running', 'reserving'].includes(c.state));

/** Estimated cost of one call: measured (or wall) seconds + cold start + idle scale-down, at the published T4 price. */
export function callSeconds(c, t = Date.now()) {
  if (c.state === 'not_started') return { seconds: 0, provenance: 'OBSERVED' };
  if (Number.isFinite(c.gpu_seconds)) return { seconds: c.gpu_seconds, provenance: c.gpu_seconds_provenance || 'OBSERVED' };
  return { seconds: Math.max(0, ((c.ended_ms || t) - c.dispatched_ms) / 1000), provenance: 'ESTIMATED' };
}
export function callCostUsd(c, t = Date.now()) {
  if (c.state === 'not_started') return 0;
  const s = callSeconds(c, t).seconds + MODAL_STARTUP_S + MODAL_SCALEDOWN_S;
  return r4(s * (Number(c.usd_hr) || MODAL_USD_HR) / 3600);
}
/** CHE's own ESTIMATE of Modal use in a calendar month (UTC), open calls included. */
export function modalMonthUsd(pool, t = Date.now(), month = monthOf(t)) {
  return r4(Object.values(modalStateOf(pool).calls).filter((c) => monthOf(c.dispatched_ms) === month).reduce((s, c) => s + callCostUsd(c, t), 0));
}
const reserveUsd = () => r4((MODAL_JOB_RESERVE_S + MODAL_STARTUP_S + MODAL_SCALEDOWN_S) * MODAL_USD_HR / 3600);
const OPEN = ['dispatching', 'unknown', 'started', 'running', 'reserving'];
/** The month's Blender GPU calls for the cap: an open call counts at its worst case (it may still run to its timeout). */
export function modalMonthWorstUsd(pool, t = Date.now(), month = monthOf(t)) {
  return r4(Object.values(modalStateOf(pool).calls).filter((c) => monthOf(c.dispatched_ms) === month)
    .reduce((s, c) => s + (OPEN.includes(c.state) ? Math.max(callCostUsd(c, t), MODAL_CALL_WORST_USD) : callCostUsd(c, t)), 0));
}
/** The owner's monthly cap in force: his own lower figure if he gave one, else his $10 approval; never above the ceiling. */
export function modalPaidCap(pool) {
  const m = modalStateOf(pool);
  const rec = m.paid_cap || OWNER_MODAL_CAP;
  return { ...rec, usd: Math.max(0, Math.min(MODAL_MONTHLY_CAP_USD, Number(rec.usd) || 0)) };
}
/** Modal's spend limit as the owner stated it: $0, a dollar figure, or (by default) his "set to $10". */
export function modalSpendLimit(pool) {
  const m = modalStateOf(pool);
  if (m.spend_limit) return m.spend_limit;
  if (m.spend_limit_zero) return { ...m.spend_limit_zero, usd: 0 };
  return OWNER_MODAL_SPEND_LIMIT;
}
/**
 * CHE's stop line for ALL Modal use this month: the included credit's stop line (when the owner stated his credit and
 * his spend limit allows paid use, the credit is spent first) plus the paid cap less its margin. With paid use at $0
 * the credit stop line alone (null when the credit is unknown).
 */
export function modalMonthStop(pool) {
  const m = modalStateOf(pool);
  const paid = Math.min(modalPaidCap(pool).usd, Number(modalSpendLimit(pool).usd) || 0);
  const credit = m.stated_credit ? creditStopUsd(m.stated_credit.usd) : 0;
  if (!(paid > 0)) return m.stated_credit ? credit : null;
  return r4(credit + paid - capMarginUsd(paid));
}
/**
 * The ONE monthly cap check every Modal caller makes before it sends anything: CHE's estimate of this month's Modal
 * use (Blender calls at worst case while open, plus `otherUsd`: GPU pictures from gpu_test_budget), plus this call's
 * worst case, must stay at or under the stop line. Returns { ok, used_usd, stop_usd, cap_usd, left_usd, reason }.
 */
export function modalMonthCheck(pool, worstUsd, { otherUsd = 0, t = Date.now() } = {}) {
  const used = r4(modalMonthWorstUsd(pool, t) + Number(otherUsd || 0));
  const stop = modalMonthStop(pool);
  const cap = modalPaidCap(pool);
  const base = { used_usd: used, stop_usd: stop, cap_usd: cap.usd, cap_words: cap.words, left_usd: stop == null ? null : r4(Math.max(0, stop - used)), month: monthOf(t) };
  // Paid use at $0 and the credit unknown: no money can be spent past Modal's own $0 limit, so the caller's own rules
  // decide (the Blender gate asks for the credit; a picture keeps its $5 test budget).
  if (stop == null) return { ...base, ok: true, kind: 'credit_only' };
  if (used + Number(worstUsd || 0) > stop + 1e-9) {
    return { ...base, ok: false, kind: 'month_cap', reason: `Modal's monthly cap is reached: my estimate of Modal use this month (${monthOf(t)}) is ${money(used)}, and this job could cost up to ${money(worstUsd)}, past my ${money(stop)} stop line under your ${money(cap.usd)} a month ("${short(cap.words, 60)}"). I send nothing more to Modal until next month; free computers still work.` };
  }
  return { ...base, ok: true };
}
/** This month's GPU-picture spend on Modal (gpu_test_budget), the other half of the one monthly Modal ledger. */
export const modalPicturesUsd = (storage, t = Date.now()) => (storage ? testBudgetMonthOf(storage, monthOf(t)).catch(() => 0) : 0);
/**
 * The monthly cap check for a caller outside the pool (a GPU picture): reads the pool's Modal calls and the picture
 * ledger from storage, then modalMonthCheck. The picture's own $5 test budget still applies on top.
 */
export async function modalMonthCheckFor(storage, worstUsd, t = Date.now()) {
  const pool = (await storage.get(MODAL_POOL_KEY)) || {};
  return modalMonthCheck(pool, worstUsd, { otherUsd: await modalPicturesUsd(storage, t), t });
}

/**
 * Whether a Blender GPU dispatch to Modal is allowed now. { ok, kind, reason, used_usd, stop_usd, credit_usd, cap_usd }.
 * kind: off | month_cap | credit_unknown | approval (estimate at the stop line). Use is on when the owner opted in, or
 * by his $10-a-month approval (OWNER_MODAL_CAP) unless he said "stop using Modal". With paid use allowed (his cap and
 * his stated spend limit both above $0), the monthly cap check (modalMonthCheck, this call at its worst case) decides
 * and is never passed, not even by a one-shot approval. With paid use at $0 (he said the spend limit is zero, or capped
 * Modal at $0) the included-credit rules apply as before: `approved_once` lets one job past CHE's credit stop line
 * (Modal's $0 limit still holds). `otherUsd` is this month's GPU-picture spend from gpu_test_budget.
 */
export function modalCreditGate(pool, t = Date.now(), { otherUsd = 0 } = {}) {
  const m = modalStateOf(pool);
  const used = r4(modalMonthUsd(pool, t) + Number(otherUsd || 0));
  const cap = modalPaidCap(pool);
  const paid = Math.min(cap.usd, Number(modalSpendLimit(pool).usd) || 0);
  const base = { used_usd: used, credit_usd: m.stated_credit?.usd ?? null, stop_usd: modalMonthStop(pool), cap_usd: cap.usd, paid_usd: paid };
  const on = Boolean(m.opt_in) || (cap.usd > 0 && !m.opt_out);
  if (!on) return { ...base, ok: false, kind: 'off', reason: 'Using Modal is off. Say "use Modal\'s free credit" to allow it.' };
  if (paid > 0) {
    const month = modalMonthCheck(pool, MODAL_CALL_WORST_USD, { otherUsd, t });
    if (!month.ok) return { ...base, used_usd: month.used_usd, ok: false, kind: month.kind, reason: month.reason, worst_usd: MODAL_CALL_WORST_USD };
    return { ...base, used_usd: month.used_usd, ok: true, paid: true, worst_usd: MODAL_CALL_WORST_USD, left_before_stop_usd: month.left_usd };
  }
  if (!m.spend_limit_zero) return { ...base, ok: false, kind: 'off', reason: `You capped Modal at ${money(cap.usd)} a month and have not confirmed a $0 Modal spend limit, so I send nothing to Modal.` };
  const once = Boolean(m.approve_next);
  if (!m.stated_credit) {
    return once ? { ...base, ok: true, approved_once: true } : { ...base, ok: false, kind: 'credit_unknown', reason: `Waiting for approval: Modal does not let CHE read your remaining credit, and you have not told me your monthly credit (third-party listings say about ${money(THIRD_PARTY_CREDIT_USD)} on Starter; not confirmed on modal.com). Say "my Modal credit is 30 dollars" with the amount your Modal Usage page shows, or "approve the next Modal job".` };
  }
  if (used + reserveUsd() > base.stop_usd) {
    return once ? { ...base, ok: true, approved_once: true } : { ...base, ok: false, kind: 'approval', reason: `Waiting for approval: my estimate of Modal use this month is ${money(used)} of your stated ${money(base.credit_usd)} credit, and one more job could pass my ${money(base.stop_usd)} stop line. Modal does not let me read the credit left, so I wait. Say "approve the next Modal job" to run one anyway (your $0 spend limit still stops Modal at the credit), or wait for the new month.` };
  }
  return { ...base, ok: true, left_before_stop_usd: r4(base.stop_usd - used) };
}

// ─── Calls: dispatch, status, cancel (one job per call, one idempotency key per attempt) ─────────────────────────
export function nextKey(pool, jobId) {
  const n = Object.values(modalStateOf(pool).calls).filter((c) => c.job_ids.includes(jobId) && c.state !== 'not_started').length + 1;
  return `job:${jobId}:modal:${n}`;
}
function keepCalls(m) {
  const all = Object.values(m.calls);
  if (all.length <= MAX_CALLS_KEPT) return;
  const drop = all.filter((c) => !['dispatching', 'unknown', 'started', 'running', 'reserving'].includes(c.state)).sort((a, b) => a.dispatched_ms - b.dispatched_ms).slice(0, all.length - MAX_CALLS_KEPT);
  for (const c of drop) delete m.calls[c.key];
}

/**
 * Starts one GPU call for `job` (its key from nextKey unless a not-started attempt is being retried). `issueToken`
 * makes the scoped pool token (compute_pool.issuePoolToken). Returns { ok, call, error, cooldown? }:
 * - ok: Modal accepted (dispatch new or existing for that key);
 * - an HTTP 401/403/404/422 answer: the call never started (state not_started, no cost) and the error says why;
 * - no answer (timeout, 5xx): state unknown. Nothing else is dispatched for that job until /status settles it.
 */
export async function modalDispatch({ cred, pool, job, base, t, fetcher = fetch, issueToken, approval = null }) {
  const m = modalStateOf(pool);
  const key = nextKey(pool, job.id);
  const token = await issueToken(pool, 'modal', [job.id], MODAL_CALL_S * 1000, t);
  const call = m.calls[key] = { key, provider: 'modal', job_ids: [job.id], state: 'dispatching', dispatched_ms: t, dispatched_at: iso(t), gpu: MODAL_GPU, usd_hr: MODAL_USD_HR,
    call_id: null, ended_ms: null, ended_at: null, gpu_seconds: null, gpu_seconds_provenance: null, error: '', http_tries: (m.calls[key]?.http_tries || 0) + 1,
    approval: approval ? { ...approval } : null };
  keepCalls(m);
  const r = await modalCall(cred, 'POST', '/blender_preview', { idempotency_key: key, che_base: base, worker_token: token, job_ids: [job.id], deadline_s: MODAL_CALL_S }, fetcher, 30000);
  if (r.ok && r.data?.ok !== false) {
    call.state = ['started', 'running', 'done', 'failed', 'cancelled'].includes(r.data?.state) ? r.data.state : 'started';
    call.call_id = short(r.data?.call_id || '', 80) || null;
    call.dispatch = r.data?.dispatch === 'existing' ? 'existing' : 'new';
    return { ok: true, call };
  }
  if ([401, 403, 404, 422].includes(r.status)) {
    call.state = 'not_started'; call.ended_ms = t; call.ended_at = iso(t);
    call.error = r.status === 404 ? 'CHE\'s Modal app is not deployed at the saved endpoint (HTTP 404); run the "CHE Modal deploy" workflow'
      : r.status === 422 ? `Modal refused the job arguments (${short(r.data?.error || 'HTTP 422', 120)})` : `CHE's Modal app rejected the access token (HTTP ${r.status})`;
    if (pool.tokens?.modal) pool.tokens.modal.revoked = true;
    return { ok: false, call, error: call.error, cooldown: true };
  }
  call.state = 'unknown';
  call.error = r.status ? `Modal answered HTTP ${r.status}; checking by key before anything else` : `no answer from Modal (${r.error || 'network'}); checking by key before anything else`;
  return { ok: false, call, error: call.error, uncertain: true };
}

/** Applies a /status or /cancel answer to a call. Returns whether the call is now closed. */
function applyAnswer(call, data, t) {
  const st = String(data?.state || '');
  if (Number.isFinite(Number(data?.gpu_seconds)) && data?.gpu_seconds !== null) { call.gpu_seconds = Math.max(0, Number(data.gpu_seconds)); call.gpu_seconds_provenance = 'OBSERVED'; }
  if (data?.call_id && !call.call_id) call.call_id = short(data.call_id, 80);
  if (data?.gpu) call.gpu = short(data.gpu, 60);
  if (data?.error) call.error = short(data.error, 300);
  if (st === 'not_found') {
    if (call.state === 'dispatching' || call.state === 'unknown') { call.state = 'not_started'; call.ended_ms = t; call.ended_at = iso(t); return true; }
    call.state = 'lost'; call.ended_ms = t; call.ended_at = iso(t); call.error = call.error || 'Modal has no record of this call'; return true;
  }
  if (['done', 'failed', 'cancelled'].includes(st)) { call.state = st; call.ended_ms = t; call.ended_at = iso(t); return true; }
  if (['started', 'running', 'reserving'].includes(st)) call.state = st === 'reserving' ? 'started' : st;
  return false;
}

/** GET the call's state by its idempotency key. { ok, closed, call }. A network failure changes nothing. */
export async function modalStatus(cred, call, t, fetcher = fetch) {
  const r = await modalCall(cred, 'POST', '/status', { idempotency_key: call.key }, fetcher);
  call.checked_at = iso(t);
  if (!r.ok) {
    call.status_failures = (call.status_failures || 0) + 1;
    if (t > call.dispatched_ms + MODAL_CALL_S * 1000 + MODAL_STATUS_GRACE_MS) {
      // Past the app's own hard timeout the call cannot still be running; closed with the full time ESTIMATED.
      call.state = 'lost'; call.ended_ms = Math.min(t, call.dispatched_ms + MODAL_CALL_S * 1000); call.ended_at = iso(call.ended_ms);
      call.error = call.error || `Modal status could not be read (${r.status ? `HTTP ${r.status}` : r.error || 'network'}); counted at its full time limit`;
      return { ok: false, closed: true, call };
    }
    return { ok: false, closed: false, call };
  }
  return { ok: true, closed: applyAnswer(call, r.data, t), call };
}

/** Cancels the call by its key (or confirms it already ended). { ok, call }: ok means nothing can bill any more. */
export async function modalCancel(cred, call, t, fetcher = fetch) {
  const r = await modalCall(cred, 'POST', '/cancel', { idempotency_key: call.key }, fetcher);
  if (!r.ok) { call.cancel_error = short(r.error || `HTTP ${r.status}`, 80); return { ok: false, call }; }
  const closed = applyAnswer(call, r.data, t);
  if (!closed) return { ok: false, call };
  call.cancelled_at = iso(t);
  return { ok: true, call };
}

/** The per-job compute receipt for a closed call (stamped on the job and listed by computeUsageLedger). */
export function callReceipt(c, t = Date.now()) {
  const secs = callSeconds(c, t);
  return { provider: 'modal', idempotency_key: c.key, state: c.state, gpu: c.gpu, gpu_seconds: Math.round(secs.seconds * 10) / 10, gpu_seconds_provenance: secs.provenance,
    estimated_cost_usd: callCostUsd(c, t), cost_provenance: 'ESTIMATED', billed_cost_usd: null, billed_provenance: 'UNAVAILABLE',
    price: { usd_hr: c.usd_hr, source: MODAL_PRICE_SOURCE, includes_s: MODAL_STARTUP_S + MODAL_SCALEDOWN_S }, error: c.error || '', approval: c.approval || null };
}

// ─── Owner words ─────────────────────────────────────────────────────────────────────────────────────────────────
const MODAL = "modal(?:'s|s)?";
const CREDIT = '(?:free |included )?(?:credits?|compute|gpu credit)';
const ZERO = "(?:zero|0|\\$0|\\$ 0|0 dollars|zero dollars|nothing)";
const SPEND = `(?:i(?:'ve| have)? set|i put|i changed) (?:the |my )?(?:${MODAL} )?spend(?:ing)? limit (?:to|at) ${ZERO}|(?:the |my )?(?:${MODAL} )?spend(?:ing)? limit is (?:set to |now )?${ZERO}`;
const WORDN = { zero: 0, five: 5, ten: 10, fifteen: 15, twenty: 20, 'twenty five': 25, thirty: 30, forty: 40, fifty: 50 };

/** The owner's Modal request as { action, ... }, or null. */
export function modalIntent(message) {
  const t = String(message || '').toLowerCase().replace(/[’‘]/g, "'").replace(/^(?:(?:hey|ok|okay)\s+)?(?:che|chey|chay|shay)[\s,.:;!-]+/, '').replace(/^(?:please|can you|could you)\s+/, '').replace(/[.!?]+$/, '').trim();
  if (!t || t.length > 200 || !/\bmodal/.test(t)) return null;
  const enable = new RegExp(`^(?:use|allow|turn on|enable|start using)(?: using)? ${MODAL} ${CREDIT}(?: for (?:gpus?|gpu jobs|characters))?(?:[,;]? (?:and )?(${SPEND}))?$`).exec(t);
  if (enable) return { action: 'enable', spend_limit_zero: Boolean(enable[1]) };
  if (new RegExp(`^(?:stop|don't|do not|turn off|disable)(?: using)? ${MODAL}(?: ${CREDIT}| gpus?)?$`).test(t)) return { action: 'disable' };
  if (new RegExp(`^(?:yes,? )?(?:${SPEND})$`).test(t)) return { action: 'spend_limit_zero' };
  const amt = new RegExp(`^(?:my |the )?${MODAL} (?:monthly |free |included )?credit is \\$?\\s*(\\d{1,3}(?:\\.\\d{1,2})?|[a-z]+(?: [a-z]+)?)(?: dollars?)?(?: a month| per month| monthly)?$`).exec(t);
  if (amt) { const usd = /^\d/.test(amt[1]) ? Number(amt[1]) : WORDN[amt[1].replace(/ dollars?$/, '')] ?? null; return usd == null ? null : { action: 'credit', usd }; }
  const lim = new RegExp(`^(?:(?:i(?:'ve| have)? set|i put|i changed) (?:the |my )?(?:${MODAL} )?spend(?:ing)? limit (?:to|at)|(?:the |my )?(?:${MODAL} )?spend(?:ing)? limit is (?:set to |now )?)\\s*\\$?\\s*(\\d{1,3}(?:\\.\\d{1,2})?|[a-z]+(?: [a-z]+)?)(?: dollars?)?(?: a month| per month| monthly)?$`).exec(t);
  if (lim && /\bmodal/.test(t)) { const usd = /^\d/.test(lim[1]) ? Number(lim[1]) : WORDN[lim[1]] ?? null; if (usd != null) return usd === 0 ? { action: 'spend_limit_zero' } : { action: 'spend_limit', usd }; }
  const capm = new RegExp(`^(?:cap|limit) ${MODAL}(?: gpus?| spending| use)? (?:at|to) \\$?\\s*(\\d{1,3}(?:\\.\\d{1,2})?|[a-z]+(?: [a-z]+)?)(?: dollars?)? (?:a|per|each) month$`).exec(t);
  if (capm) { const usd = /^\d/.test(capm[1]) ? Number(capm[1]) : WORDN[capm[1]] ?? null; return usd == null ? null : { action: 'cap', usd }; }
  if (/^(?:approve|allow) (?:the )?next modal (?:gpu )?job$/.test(t)) return { action: 'approve_next' };
  if (new RegExp(`^(?:how much (?:of )?(?:my )?${MODAL} credit (?:have i|has che|did i|is) (?:used|left)|${MODAL} (?:credit|usage)(?: status)?|(?:show|read|check)(?: me)? (?:my )?${MODAL} (?:credit|usage|status))$`).test(t)) return { action: 'status' };
  return null;
}

/** Applies the owner's words to the policy. Returns { ok, spoken }. Persisting is the caller's (pool save). */
export function applyModalIntent(pool, intent, words, t = Date.now()) {
  const m = modalStateOf(pool);
  if (intent.action === 'enable') {
    m.opt_in = entered(words, t); m.opt_out = null;
    if (intent.spend_limit_zero) { m.spend_limit_zero = entered(words, t); m.spend_limit = null; }
    remember(m, 'opt_in', words, t);
    const gate = modalCreditGate(pool, t);
    return { ok: true, spoken: `Recorded at ${iso(t).slice(11, 16)} UTC, in your words: "${short(words, 120)}". I may use Modal${gate.paid ? `, within your ${money(gate.cap_usd)} a month,` : '\'s included credit'} for GPU-only jobs, after free GPUs (Colab, Kaggle) and never for CPU work.${gate.ok ? ` My estimate of Modal use this month is ${money(gate.used_usd)}; I stop at ${money(gate.stop_usd)}.` : ` Before I dispatch anything: ${gate.reason}`}` };
  }
  if (intent.action === 'disable') {
    m.opt_in = null; m.approve_next = null; m.opt_out = entered(words, t); remember(m, 'opt_out', words, t);
    return { ok: true, spoken: 'Modal\'s included credit is off: I send no new jobs to Modal, and I cancel any Modal call still running.' };
  }
  if (intent.action === 'spend_limit') {
    if (!(intent.usd > 0) || intent.usd > 1000) return { ok: false, spoken: 'I need Modal\'s spend limit in dollars, as you set it on Modal\'s Usage and Billing page. Nothing changed.' };
    m.spend_limit = entered(words, t, { usd: Math.round(intent.usd * 100) / 100 }); m.spend_limit_zero = null; remember(m, 'spend_limit', words, t);
    const cap = modalPaidCap(pool);
    return { ok: true, spoken: `Recorded at ${iso(t).slice(11, 16)} UTC: you said Modal's spend limit is ${money(intent.usd)} ("${short(words, 120)}"). That is your word; CHE cannot read Modal's settings. My own stop line stays under your ${money(cap.usd)} a month cap: ${money(modalMonthStop(pool))}.` };
  }
  if (intent.action === 'cap') {
    if (!(intent.usd >= 0)) return { ok: false, spoken: 'I need the monthly Modal cap in dollars. Nothing changed.' };
    if (intent.usd > MODAL_MONTHLY_CAP_USD) return { ok: false, spoken: `Modal's monthly cap is ${money(MODAL_MONTHLY_CAP_USD)}, your approval ("${OWNER_MODAL_CAP.words}"). I can lower it by voice; raising it is a code change you approve. Nothing changed.` };
    m.paid_cap = entered(words, t, { usd: Math.round(intent.usd * 100) / 100 }); remember(m, 'cap', words, t);
    return { ok: true, spoken: `Recorded: Modal may use at most ${money(intent.usd)} a month${intent.usd > 0 ? `; I stop at ${money(modalMonthStop(pool) ?? 0)}, my estimate including a safety margin` : ', so I send nothing past your included credit'}.` };
  }
  if (intent.action === 'spend_limit_zero') {
    m.spend_limit_zero = entered(words, t); m.spend_limit = null; remember(m, 'spend_limit_zero', words, t);
    return { ok: true, spoken: `Recorded at ${iso(t).slice(11, 16)} UTC: you said Modal's spend limit is $0 ("${short(words, 120)}"). That is your word; CHE cannot read Modal's settings.${m.opt_in ? '' : ' Included-credit use is still off until you say "use Modal\'s free credit".'}` };
  }
  if (intent.action === 'credit') {
    if (!(intent.usd > 0) || intent.usd > 500) return { ok: false, spoken: 'I need the monthly credit in dollars, between 1 and 500, as your Modal Usage page shows it. Nothing changed.' };
    m.stated_credit = entered(words, t, { usd: Math.round(intent.usd * 100) / 100 }); remember(m, 'credit', words, t);
    return { ok: true, spoken: `Recorded: your Modal credit is ${money(intent.usd)} a month (your figure). I stop sending jobs when my estimate reaches ${money(creditStopUsd(intent.usd))}.` };
  }
  if (intent.action === 'approve_next') {
    m.approve_next = entered(words, t); remember(m, 'approve_next', words, t);
    return { ok: true, spoken: 'Recorded: the next GPU job may run on Modal even past my estimate stop line. Your Modal spend limit still applies. Only one job; then I ask again.' };
  }
  return { ok: true, spoken: speakModal(pool, t) };
}

/** "How much Modal credit have I used", in plain sentences, with what is known and what is not. */
export function speakModal(pool, t = Date.now(), { connected = null, otherUsd = 0 } = {}) {
  const m = modalStateOf(pool);
  const gate = modalCreditGate(pool, t, { otherUsd });
  const open = openCalls(pool);
  const cap = modalPaidCap(pool); const lim = modalSpendLimit(pool);
  const when = (r) => `${String(r.at).slice(0, 16).replace('T', ' ')} UTC`;
  return [connected === null ? '' : connected ? 'Modal is connected and verified.' : 'Modal is not connected.',
    `Modal use is ${m.opt_in ? `on (you said so at ${when(m.opt_in)})` : gate.kind === 'off' ? 'off' : `on, within your ${money(cap.usd)} a month ("${short(cap.words, 60)}", ${when(cap)})`}.`,
    m.spend_limit_zero ? `You confirmed a $0 Modal spend limit at ${when(m.spend_limit_zero)}.` : `Modal's spend limit, in your words: ${money(lim.usd)} ("${short(lim.words, 60)}", ${when(lim)}).`,
    gate.stop_usd != null ? `My stop line this month: ${money(gate.stop_usd)}.` : '',
    m.stated_credit ? `Your stated credit: ${money(m.stated_credit.usd)} a month; my stop line: ${money(creditStopUsd(m.stated_credit.usd))}.` : 'Your monthly credit is not known to me.',
    `My estimate of Modal use this month: ${money(gate.used_usd)} (measured GPU seconds plus start and idle time, times Modal's published T4 price). Modal's own credit balance is not available to CHE on the Starter plan.`,
    open.length ? `${open.length} Modal call${open.length === 1 ? ' is' : 's are'} open.` : 'No Modal call is running.',
    gate.ok ? '' : gate.reason].filter(Boolean).join(' ');
}

// ─── The ledger the Usage Center reads ───────────────────────────────────────────────────────────────────────────
/**
 * Per-provider, per-job compute receipts for one calendar month (UTC, 'YYYY-MM'; default: this month), from the
 * existing records only: Modal calls (pool.modal.calls), paid sessions (pool.budget.sessions) and completed queue jobs
 * (gpu:jobs receipts). Every number carries its provenance (OBSERVED, ESTIMATED, USER-ENTERED, UNAVAILABLE).
 * Read-only: never calls a provider, never writes.
 */
export async function computeUsageLedger(storage, { month = null, now = Date.now() } = {}) {
  const t = typeof now === 'function' ? now() : now;
  const want = month && /^\d{4}-\d{2}$/.test(month) ? month : monthOf(t);
  const pool = (await storage.get('pool:state')) || {};
  const jobs = (await storage.get('gpu:jobs')) || [];
  const m = modalStateOf({ modal: structuredClone(pool.modal || {}) });
  const receipts = [];
  const jobOf = (id) => jobs.find((j) => j.id === id) || null;
  for (const c of Object.values(m.calls)) {
    if (monthOf(c.dispatched_ms) !== want) continue;
    const j = jobOf(c.job_ids[0]);
    const r = callReceipt(c, t);
    receipts.push({ job_id: c.job_ids[0], job_title: short(j?.title || '', 80), job_state: j?.state || 'unknown', ...r, started_at: c.dispatched_at, ended_at: c.ended_at,
      attempts: j?.receipt?.attempts ?? j?.pool?.total ?? null, artifact_sha256: j?.receipt?.provider === 'modal' ? j?.model?.sha256 || null : null,
      data_provenance: { gpu_seconds: r.gpu_seconds_provenance, cost: 'ESTIMATED', billed: 'UNAVAILABLE' } });
  }
  for (const s of Array.isArray(pool.budget?.sessions) ? pool.budget.sessions : []) {
    if (monthOf(s.started_ms) !== want) continue;
    const secs = Math.max(0, ((s.ended_ms || t) - s.started_ms) / 1000);
    const billed = Number.isFinite(s.usd_billed);
    for (const id of s.job_ids?.length ? s.job_ids : [null]) {
      const j = id ? jobOf(id) : null; const share = 1 / Math.max(1, s.job_ids?.length || 1);
      receipts.push({ job_id: id, job_title: short(j?.title || '', 80), job_state: j?.state || 'unknown', provider: s.provider, idempotency_key: s.id, state: s.ended_ms ? 'ended' : 'running', gpu: s.gpu,
        gpu_seconds: Math.round(secs * share * 10) / 10, gpu_seconds_provenance: 'ESTIMATED', estimated_cost_usd: r4(s.usd_hr * secs / 3600 * share), cost_provenance: 'ESTIMATED',
        billed_cost_usd: billed ? r4(s.usd_billed * share) : null, billed_provenance: billed ? 'OBSERVED' : 'UNAVAILABLE', started_at: s.started_at, ended_at: s.ended_at || null,
        attempts: j?.receipt?.attempts ?? null, artifact_sha256: j?.receipt?.provider === s.provider ? j?.model?.sha256 || null : null, error: s.terminate?.error || '',
        data_provenance: { gpu_seconds: 'ESTIMATED', cost: 'ESTIMATED', billed: billed ? 'OBSERVED' : 'UNAVAILABLE' } });
    }
  }
  const FREE = { github_actions_cpu: 'free standard runner (public repository)', colab_gpu: "owner's free Colab session", kaggle: 'Kaggle weekly free GPU quota' };
  for (const j of jobs) {
    const p = j.receipt?.provider;
    if (j.state !== 'completed' || !FREE[p]) continue;
    const at = Date.parse(j.history?.at?.(-1)?.at || j.updated_at || j.created_at || '') || 0;
    if (!at || monthOf(at) !== want) continue;
    const secs = Number(j.receipt?.process_seconds);
    const has = Number.isFinite(secs) && secs > 0;
    const gpu = p !== 'github_actions_cpu';
    receipts.push({ job_id: j.id, job_title: short(j.title || '', 80), job_state: j.state, provider: p, idempotency_key: null, state: 'completed', gpu: gpu ? short(j.rendered_on?.device || 'GPU', 60) : null,
      gpu_seconds: gpu && has ? secs : gpu ? null : 0, gpu_seconds_provenance: gpu ? (has ? 'OBSERVED' : 'UNAVAILABLE') : 'OBSERVED', cpu_seconds: !gpu && has ? secs : null,
      estimated_cost_usd: 0, cost_provenance: 'ESTIMATED', cost_basis: FREE[p], billed_cost_usd: null, billed_provenance: 'UNAVAILABLE', started_at: null, ended_at: iso(at),
      attempts: j.receipt?.attempts ?? null, artifact_sha256: j.model?.sha256 || null, error: '', data_provenance: { gpu_seconds: gpu ? (has ? 'OBSERVED' : 'UNAVAILABLE') : 'OBSERVED', cost: 'ESTIMATED', billed: 'UNAVAILABLE' } });
  }
  const providers = {};
  for (const r of receipts) {
    const p = providers[r.provider] || (providers[r.provider] = { jobs: 0, gpu_seconds: 0, cpu_seconds: 0, estimated_cost_usd: 0, billed_cost_usd: null, receipts: [] });
    p.jobs += 1; p.gpu_seconds = Math.round((p.gpu_seconds + (Number(r.gpu_seconds) || 0)) * 10) / 10; p.cpu_seconds += Number(r.cpu_seconds) || 0;
    p.estimated_cost_usd = r4(p.estimated_cost_usd + (r.estimated_cost_usd || 0));
    if (r.billed_cost_usd != null) p.billed_cost_usd = r4((p.billed_cost_usd || 0) + r.billed_cost_usd);
    p.receipts.push(r);
  }
  const est = modalMonthUsd({ modal: m }, t, want);
  return {
    month: want, generated_at: iso(t), provenance_values: PROVENANCE, providers, receipts,
    totals: { estimated_cost_usd: r4(receipts.reduce((s, r) => s + (r.estimated_cost_usd || 0), 0)), billed_cost_usd: receipts.some((r) => r.billed_cost_usd != null) ? r4(receipts.reduce((s, r) => s + (r.billed_cost_usd || 0), 0)) : null },
    modal_credit: {
      opt_in: m.opt_in, spend_limit_zero: m.spend_limit_zero,
      stated_credit_usd: m.stated_credit?.usd ?? null, stated_credit_provenance: m.stated_credit ? 'USER-ENTERED' : 'UNAVAILABLE',
      third_party_listing_usd: THIRD_PARTY_CREDIT_USD, stop_at_usd: m.stated_credit ? creditStopUsd(m.stated_credit.usd) : null,
      used_estimate_usd: est, used_estimate_provenance: 'ESTIMATED',
      remaining_credit_usd: null, remaining_credit_provenance: 'UNAVAILABLE', remaining_credit_why: 'Modal billing reports are Team/Enterprise only and show costs before credits (modal.com/docs/guide/billing).',
    },
  };
}
