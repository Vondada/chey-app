// GPU budget ledger for the compute pool (owner, 2026-10-25: "I may put $20 toward GPUs. Split the money up across
// different GPUs so it lasts, using the free ones first.").
//
// This is part of compute_pool.js (it stores its state inside `pool:state` as `pool.budget`), not a second pool.
// Rules held in code here:
// - CHE never pays, never adds a payment method and never buys credit. The owner loads prepaid credit himself.
// - Paid GPUs are OFF until the owner sets a cap above $0 with an explicit command ("allow up to $20 for GPUs") or the
//   pool settings screen. The approval is recorded with its time and words; "stop paid GPUs" sets it back to $0.
// - Spend is tracked per session from real wall time x the provider's own hourly price for that machine (the price
//   the provider returned when the machine started, else the published price below). Where the provider has a
//   billing API (RunPod /billing/pods), its amount replaces the estimate. A provider's prepaid balance is a second cap.
// - Never exceed the cap: a session may start only if the money left (after a safety margin) covers at least
//   MIN_PAID_SESSION_S on that machine, and it is given a hard deadline at which the money left would reach the margin.
// - No promise of "forever": runway() answers from the recent use and the money left, in weeks.

export const MIN_PAID_SESSION_S = 20 * 60;        // a session must be able to run at least 20 min (Blender download + one build)
export const PAID_SESSION_MAX_S = 2 * 3600;       // and never more than 2 h in one go
export const MAX_PAID_SESSIONS = 1;               // one paid machine at a time
export const MAX_APPROVAL_USD = 1000;             // a guard against a misheard amount; the owner can still set less
export const RUNWAY_WINDOW_MS = 28 * 86400_000;   // "recent use" = the last 4 weeks
export const MAX_SESSIONS_KEPT = 200;

/** The money kept back from every cap: 5% of it, at least 25 cents. */
export const marginUsd = (cap) => Math.max(0.25, Math.round(Number(cap || 0) * 5) / 100);

// Published prices. Read 2026-10-25 through web search (runpod.io, modal.com and vast.ai are not reachable from CHE's
// build container); the live price a provider returns when a machine starts always replaces these.
export const PAID_GPU_PRICES = Object.freeze({
  runpod: {
    label: 'RunPod Community Cloud',
    source: 'runpod.io/gpu-instance/pricing (Community Cloud), read via web search 2026-10-25; per-second billing (docs.runpod.io/accounts-billing/billing)',
    gpus: [
      { id: 'NVIDIA RTX A4000', label: 'RTX A4000 (16 GB)', usd_hr: 0.17, vram_gb: 16 },
      { id: 'NVIDIA GeForce RTX 3090', label: 'RTX 3090 (24 GB)', usd_hr: 0.22, vram_gb: 24 },
      { id: 'NVIDIA GeForce RTX 4090', label: 'RTX 4090 (24 GB)', usd_hr: 0.34, vram_gb: 24 },
    ],
  },
  vast: {
    label: 'Vast.ai marketplace',
    source: 'Marketplace prices change per offer; ~$0.22/h for an RTX 3090 on-demand (getdeploying.com, third party, 2026-03-25). CHE reads the live offer price (dph_total) before renting.',
    gpus: [
      { id: 'RTX A4000', label: 'RTX A4000 (16 GB)', usd_hr: 0.2, vram_gb: 16 },
      { id: 'RTX 3090', label: 'RTX 3090 (24 GB)', usd_hr: 0.22, vram_gb: 24 },
      { id: 'RTX 4090', label: 'RTX 4090 (24 GB)', usd_hr: 0.4, vram_gb: 24 },
    ],
  },
  modal: {
    label: 'Modal',
    source: 'modal.com/pricing (search snippet 2026-10-25): T4 $0.000164/s, L4 $0.000222/s; Starter plan $30/month compute credit (not confirmed on the page itself).',
    gpus: [
      { id: 'T4', label: 'T4 (16 GB)', usd_hr: 0.59, vram_gb: 16 },
      { id: 'L4', label: 'L4 (24 GB)', usd_hr: 0.8, vram_gb: 24 },
    ],
  },
});
export const PAID_PROVIDERS = Object.freeze(['runpod', 'vast']);   // the ones the pool can start and stop today
export const cheapestGpu = (provider) => [...(PAID_GPU_PRICES[provider]?.gpus || [])].sort((a, b) => a.usd_hr - b.usd_hr)[0] || null;
/** The highest hourly price CHE accepts on a provider: its dearest listed GPU (a live price above it is refused). */
export const maxUsdHr = (provider) => Math.max(0, ...(PAID_GPU_PRICES[provider]?.gpus || []).map((g) => g.usd_hr));

const iso = (ms) => new Date(ms).toISOString();
const money = (usd) => `$${(Math.round(Number(usd || 0) * 100) / 100).toFixed(2)}`;
const monthStart = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

export function emptyBudget() {
  return { total_cap_usd: 0, monthly_cap_usd: 0, approved_at: null, approval_text: '', speed_opt_in: false, history: [], sessions: [], balances: {} };
}
export function budgetOf(pool) {
  const b = pool.budget && typeof pool.budget === 'object' ? pool.budget : {};
  pool.budget = { ...emptyBudget(), ...b, sessions: Array.isArray(b.sessions) ? b.sessions : [], history: Array.isArray(b.history) ? b.history : [], balances: b.balances || {} };
  return pool.budget;
}

/**
 * The owner's spending approval. `totalUsd` is the most CHE may ever spend on paid GPUs; `monthlyUsd` (optional, at
 * most the total) limits a calendar month. Both must be explicit numbers; 0 turns paid GPUs off.
 */
export function approveSpend(pool, { totalUsd, monthlyUsd = null, text = '', via = 'command' } = {}, t = Date.now()) {
  const b = budgetOf(pool);
  const total = Number(totalUsd);
  if (!Number.isFinite(total) || total < 0) return { ok: false, detail: 'I need a dollar amount, like "allow up to $20 for GPUs". Nothing changed.' };
  if (total > MAX_APPROVAL_USD) return { ok: false, detail: `${money(total)} is above the ${money(MAX_APPROVAL_USD)} I accept by voice, in case I misheard. Nothing changed.` };
  let monthly = monthlyUsd == null ? (b.monthly_cap_usd > 0 && b.monthly_cap_usd <= total ? b.monthly_cap_usd : total) : Number(monthlyUsd);
  if (!Number.isFinite(monthly) || monthly < 0) return { ok: false, detail: 'The monthly amount must be a dollar figure. Nothing changed.' };
  monthly = Math.min(monthly, total);
  b.total_cap_usd = Math.round(total * 100) / 100;
  b.monthly_cap_usd = Math.round(monthly * 100) / 100;
  b.approved_at = total > 0 ? iso(t) : null;
  b.approval_text = String(text || '').slice(0, 160);
  b.history = [...b.history, { at: iso(t), total_cap_usd: b.total_cap_usd, monthly_cap_usd: b.monthly_cap_usd, via: String(via).slice(0, 30), text: b.approval_text }].slice(-30);
  return { ok: true, budget: b };
}

/** Only the monthly limit (the total stays). Needs an approved total. */
export function setMonthlyCap(pool, monthlyUsd, text = '', t = Date.now()) {
  const b = budgetOf(pool);
  if (!(b.total_cap_usd > 0)) return { ok: false, detail: 'Paid GPUs are off, so there is no budget to spread. Say "allow up to $20 for GPUs" first. Nothing changed.' };
  return approveSpend(pool, { totalUsd: b.total_cap_usd, monthlyUsd, text, via: 'monthly' }, t);
}

/** "Stop paid GPUs": the cap goes to $0 at once; open sessions are returned so the pool terminates them. */
export function revokeSpend(pool, text = 'stop paid GPUs', t = Date.now()) {
  approveSpend(pool, { totalUsd: 0, monthlyUsd: 0, text, via: 'stop' }, t);
  return openSessions(pool);
}

export const openSessions = (pool) => budgetOf(pool).sessions.filter((s) => !s.ended_ms);

/** Cost of one session so far: the provider's billed amount when known, else wall time x its hourly price. */
export function sessionCost(s, t = Date.now()) {
  if (Number.isFinite(s.usd_billed)) return s.usd_billed;
  const end = s.ended_ms || t;
  return Math.max(0, (end - s.started_ms) / 3600_000) * (Number(s.usd_hr) || 0);
}
const sessionHours = (s, t) => Math.max(0, ((s.ended_ms || t) - s.started_ms) / 3600_000);

export function spentUsd(pool, t = Date.now(), { since = 0, provider = null } = {}) {
  return budgetOf(pool).sessions.filter((s) => (!provider || s.provider === provider) && (s.ended_ms || t) > since)
    .reduce((sum, s) => {
      if (!since || s.started_ms >= since) return sum + sessionCost(s, t);
      // A session that crossed the start of the month: only its share inside the month counts toward the month.
      const all = sessionCost(s, t); const hrs = sessionHours(s, t);
      return sum + (hrs > 0 ? all * Math.max(0, ((s.ended_ms || t) - since) / 3600_000) / hrs : 0);
    }, 0);
}

/**
 * Money CHE may still spend, after the margin: the lower of (total cap - all spend) and (monthly cap - this month's
 * spend), and, when the provider's prepaid balance is known, (balance - margin). Never below 0.
 */
export function remainingUsd(pool, t = Date.now(), provider = null) {
  const b = budgetOf(pool);
  if (!(b.total_cap_usd > 0) || !b.approved_at) return 0;
  const m = marginUsd(b.total_cap_usd);
  let left = Math.min(b.total_cap_usd - spentUsd(pool, t), (b.monthly_cap_usd || b.total_cap_usd) - spentUsd(pool, t, { since: monthStart(t) })) - m;
  const bal = provider ? b.balances?.[provider] : null;
  if (bal && Number.isFinite(bal.usd)) left = Math.min(left, bal.usd - marginUsd(0));
  return Math.max(0, Math.round(left * 10000) / 10000);
}

/** Whether a paid session may start on `provider` at `usdHr` now, and for how long at most (its hard deadline). */
export function canStartPaid(pool, provider, usdHr, t = Date.now()) {
  const b = budgetOf(pool);
  if (!(b.total_cap_usd > 0) || !b.approved_at) return { ok: false, reason: 'Paid GPUs are off: you have not set a GPU budget. Say "allow up to $20 for GPUs" to allow them.' };
  if (!(usdHr > 0)) return { ok: false, reason: 'CHE does not know this machine\'s hourly price, so it does not start it.' };
  if (usdHr > maxUsdHr(provider) + 1e-9) return { ok: false, reason: `${money(usdHr)} an hour is above the most CHE pays on ${PAID_GPU_PRICES[provider]?.label || provider} (${money(maxUsdHr(provider))}).` };
  if (openSessions(pool).length >= MAX_PAID_SESSIONS) return { ok: false, reason: 'A paid GPU is already running; CHE runs one at a time.' };
  const bal = b.balances?.[provider];
  // RunPod refuses a new Pod without one hour of credit for it (docs.runpod.io/accounts-billing/billing).
  if (provider === 'runpod' && bal && Number.isFinite(bal.usd) && bal.usd < usdHr) return { ok: false, reason: `Your RunPod balance is ${money(bal.usd)}; RunPod needs at least one hour of credit (${money(usdHr)}) to start a GPU. Add prepaid credit at runpod.io yourself if you want more.` };
  const left = remainingUsd(pool, t, provider);
  const maxS = Math.min(PAID_SESSION_MAX_S, Math.floor((left / usdHr) * 3600));
  if (maxS < MIN_PAID_SESSION_S) return { ok: false, budget_reached: true, reason: `The GPU budget is used up: ${money(left)} is left after the ${money(marginUsd(b.total_cap_usd))} safety margin, less than ${MIN_PAID_SESSION_S / 60} minutes at ${money(usdHr)} an hour. Paid GPUs stay off until you raise the cap.` };
  return { ok: true, max_s: maxS, left_usd: left };
}

export function openSession(pool, { provider, ref, gpu, usdHr, jobIds = [], maxS }, t = Date.now()) {
  const b = budgetOf(pool);
  const s = { id: `${provider}:${String(ref).slice(0, 60)}`, provider, ref: String(ref).slice(0, 80), gpu: String(gpu || '').slice(0, 60), usd_hr: Number(usdHr),
    started_ms: t, started_at: iso(t), deadline_ms: t + maxS * 1000, ended_ms: null, end_reason: '', usd_billed: null, job_ids: [...jobIds], terminate: null };
  b.sessions = [...b.sessions, s].slice(-MAX_SESSIONS_KEPT);
  return s;
}

export function closeSession(pool, id, { reason = '', usdBilled = null } = {}, t = Date.now()) {
  const s = budgetOf(pool).sessions.find((x) => x.id === id);
  if (!s || s.ended_ms) return s || null;
  s.ended_ms = t; s.ended_at = iso(t); s.end_reason = String(reason).slice(0, 120);
  if (Number.isFinite(usdBilled)) { s.usd_billed = usdBilled; s.cost_source = 'provider billing'; } else s.cost_source = 'wall time x hourly price';
  return s;
}

/** The provider's own billed amount for a session replaces the estimate (only a real, non-negative number). */
export function reconcileSession(pool, id, usdBilled) {
  const s = budgetOf(pool).sessions.find((x) => x.id === id);
  if (!s || !Number.isFinite(usdBilled) || usdBilled < 0) return null;
  s.usd_billed = Math.round(usdBilled * 10000) / 10000; s.cost_source = 'provider billing';
  return s;
}

/** Why an open session must end now, or '' (deadline, budget, owner stop). The pool adds job and idle reasons. */
export function mustEnd(pool, s, t = Date.now()) {
  const b = budgetOf(pool);
  if (!(b.total_cap_usd > 0) || !b.approved_at) return 'paid GPUs were stopped';
  if (t >= s.deadline_ms) return 'it reached its budget time limit';
  if (remainingUsd(pool, t) <= 0) return 'the GPU budget is used up';
  return '';
}

/**
 * Runway: at the recent paid use (last 4 weeks), how long the money left lasts. With no paid use yet, how many hours
 * the money left buys on the cheapest GPU. The monthly cap, when lower, slows spending and lengthens the runway.
 */
export function runway(pool, t = Date.now()) {
  const b = budgetOf(pool);
  const spent = spentUsd(pool, t);
  const left = b.total_cap_usd > 0 ? Math.max(0, b.total_cap_usd - spent - marginUsd(b.total_cap_usd)) : 0;
  const recent = b.sessions.filter((s) => (s.ended_ms || t) > t - RUNWAY_WINDOW_MS);
  const first = recent.length ? Math.min(...recent.map((s) => s.started_ms)) : t;
  const weeks = Math.max(1 / 7, Math.min(RUNWAY_WINDOW_MS, t - first) / (7 * 86400_000));
  const hours = recent.reduce((h, s) => h + sessionHours(s, t), 0);
  const usd = recent.reduce((u, s) => u + sessionCost(s, t), 0);
  const perWeekUsd = recent.length ? usd / weeks : 0;
  const monthlyWeek = b.monthly_cap_usd > 0 ? b.monthly_cap_usd / (365.25 / 12 / 7) : Infinity;
  const pace = Math.min(perWeekUsd, monthlyWeek);
  const cheap = PAID_PROVIDERS.map((p) => ({ provider: p, ...cheapestGpu(p) })).sort((a, c) => a.usd_hr - c.usd_hr)[0];
  return {
    total_cap_usd: b.total_cap_usd, monthly_cap_usd: b.monthly_cap_usd, spent_usd: Math.round(spent * 100) / 100, left_usd: Math.round(left * 100) / 100,
    margin_usd: b.total_cap_usd > 0 ? marginUsd(b.total_cap_usd) : 0, recent_gpu_hours_per_week: Math.round((hours / weeks) * 100) / 100,
    recent_usd_per_week: Math.round(perWeekUsd * 100) / 100, weeks_left: pace > 0 ? Math.round((left / pace) * 10) / 10 : null,
    hours_on_cheapest: cheap ? Math.round((left / cheap.usd_hr) * 10) / 10 : null, cheapest: cheap || null,
  };
}

/** "How long will my GPU money last", in plain sentences. Never says "forever". */
export function speakRunway(r, { kaggleLeftS = null } = {}) {
  const free = `Free GPUs always come first: your Colab notebook while it is open, then Kaggle's weekly free GPU quota${kaggleLeftS != null ? ` (${(kaggleLeftS / 3600).toFixed(1)} hours left this week)` : ' (about 30 hours a week once Kaggle is connected; Kaggle does not publish a fixed number)'}. Paid GPUs run only for jobs that need a GPU when no free one can take them.`;
  if (!(r.total_cap_usd > 0)) return `Paid GPUs are off: you have not set a GPU budget, so CHE spends nothing. ${free} To allow paid GPUs, load prepaid credit at RunPod or Vast yourself, then say "allow up to 20 dollars for GPUs".`;
  const cap = `Your GPU budget is ${money(r.total_cap_usd)}${r.monthly_cap_usd && r.monthly_cap_usd < r.total_cap_usd ? `, at most ${money(r.monthly_cap_usd)} a month` : ''}. Spent so far: ${money(r.spent_usd)}. Left to spend: ${money(r.left_usd)}, after a ${money(r.margin_usd)} safety margin CHE never touches.`;
  const use = r.weeks_left != null
    ? `At your recent use of ${r.recent_gpu_hours_per_week} paid GPU hours a week (about ${money(r.recent_usd_per_week)} a week), the money left lasts about ${r.weeks_left} weeks. More GPU work makes it shorter.`
    : r.cheapest ? `You have used no paid GPU time recently. ${money(r.left_usd)} buys about ${r.hours_on_cheapest} hours on the cheapest GPU CHE knows (${r.cheapest.label} at ${money(r.cheapest.usd_hr)} an hour on ${PAID_GPU_PRICES[r.cheapest.provider].label}). How many weeks that is depends on how much GPU work you ask for.` : '';
  return [cap, use, free].filter(Boolean).join(' ');
}

/** The ledger for the view (no secrets: refs are provider machine ids, never keys). */
export function budgetView(pool, t = Date.now()) {
  const b = budgetOf(pool);
  return {
    total_cap_usd: b.total_cap_usd, monthly_cap_usd: b.monthly_cap_usd, approved_at: b.approved_at, approval_text: b.approval_text, speed_opt_in: b.speed_opt_in,
    margin_usd: b.total_cap_usd > 0 ? marginUsd(b.total_cap_usd) : 0, spent_usd: Math.round(spentUsd(pool, t) * 100) / 100,
    spent_this_month_usd: Math.round(spentUsd(pool, t, { since: monthStart(t) }) * 100) / 100, remaining_usd: remainingUsd(pool, t),
    balances: Object.fromEntries(Object.entries(b.balances || {}).map(([k, v]) => [k, { usd: v.usd ?? null, checked_at: v.checked_at || null }])),
    open_sessions: openSessions(pool).map((s) => ({ id: s.id, provider: s.provider, gpu: s.gpu, usd_hr: s.usd_hr, started_at: s.started_at, deadline: iso(s.deadline_ms), cost_so_far_usd: Math.round(sessionCost(s, t) * 10000) / 10000, terminate: s.terminate })),
    recent_sessions: b.sessions.slice(-10).reverse().map((s) => ({ id: s.id, provider: s.provider, gpu: s.gpu, usd_hr: s.usd_hr, started_at: s.started_at, ended_at: s.ended_at || null, end_reason: s.end_reason, usd: Math.round(sessionCost(s, t) * 10000) / 10000, cost_source: s.cost_source || null })),
    history: b.history.slice(-5).reverse(), prices: PAID_GPU_PRICES, runway: runway(pool, t),
  };
}

// ─── Words: "allow up to $20 for GPUs", "stop paid GPUs", "how long will my GPU money last" ────────────────────────
const NUM = '(\\d{1,4}(?:\\.\\d{1,2})?)';
const WORD_NUMS = { five: 5, ten: 10, fifteen: 15, twenty: 20, 'twenty five': 25, thirty: 30, forty: 40, fifty: 50, hundred: 100, 'a hundred': 100, 'one hundred': 100 };
const dollars = (s) => {
  const t = String(s || '').toLowerCase().replace(/[$,]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = new RegExp(`^${NUM}(?:\\s*(?:dollars?|bucks|usd))?$`).exec(t);
  if (m) return Number(m[1]);
  const w = t.replace(/\s*(?:dollars?|bucks|usd)$/, '').trim();
  return WORD_NUMS[w] ?? null;
};
const AMOUNT = '\\$?\\s*([\\d.,]+|[a-z]+(?: [a-z]+)?)\\s*(?:dollars?|bucks|usd)?';
const GPUS = '(?:paid\\s+)?(?:gpus?|gpu\\s+(?:time|money|budget|rental)|graphics\\s+cards?|cloud\\s+gpus?)';

/** The owner's GPU budget request as { action, ... }, or null. */
export function budgetIntent(message) {
  const t = String(message || '').toLowerCase().replace(/[’‘]/g, "'").replace(/^(?:(?:hey|ok|okay)\s+)?(?:che|chey|chay|shay)[\s,.:;!-]+/, '').replace(/^(?:please|can you|could you)\s+/, '').replace(/[.!?]+$/, '').trim();
  if (!t || t.length > 160) return null;
  if (new RegExp(`^(?:how long (?:will|would|does|is) (?:my|the) (?:gpu|graphics) (?:money|budget|credit|credits)(?: going to)? last|what(?:'s| is) (?:my|the) (?:gpu )?runway|how much (?:gpu|graphics) (?:money|budget|credit) (?:do i have )?(?:is )?left|(?:show|read|check)(?: me)? (?:my|the) gpu (?:budget|money|spending))$`).test(t)) return { action: 'runway' };
  if (/^(?:what|which) (?:gpus?|graphics cards?|computers?) (?:can|could) (?:che|you|she) use$/.test(t)) return { action: 'gpus' };
  if (new RegExp(`^(?:stop|turn off|disable|cancel|no more|end) (?:all |the |my |using )?${GPUS}(?: now)?$`).test(t) && /paid|money|budget|rental|cloud/.test(t)) return { action: 'stop' };
  const month = new RegExp(`^(?:limit|cap) ${GPUS} (?:to|at) ${AMOUNT} (?:a|per|each) month$`).exec(t);
  if (month) { const usd = dollars(month[1]); return usd == null ? null : { action: 'monthly', monthly_usd: usd }; }
  const allow = new RegExp(`^(?:allow|approve|set|use|spend|budget)(?: up to| at most| a maximum of| a max of)? ${AMOUNT} (?:for|on|toward|towards) ${GPUS}(?:,? (?:and |with )?(?:at most |up to )?${AMOUNT} (?:a|per|each) month)?$`).exec(t)
    || new RegExp(`^(?:set|make) (?:my |the )?gpu budget (?:to )?${AMOUNT}(?:,? (?:and |with )?(?:at most |up to )?${AMOUNT} (?:a|per|each) month)?$`).exec(t);
  if (allow) {
    const usd = dollars(allow[1]);
    if (usd == null) return null;
    const monthly = allow[2] ? dollars(allow[2]) : null;
    return { action: 'allow', total_usd: usd, monthly_usd: monthly };
  }
  if (new RegExp(`^(?:use|allow) ${GPUS} for speed$`).test(t)) return { action: 'speed', on: true };
  if (new RegExp(`^(?:only use|use only) free ${GPUS.replace('(?:paid\\s+)?', '')}(?: for (?:speed|cpu jobs))?$|^(?:stop using|don't use) ${GPUS} for speed$`).test(t)) return { action: 'speed', on: false };
  return null;
}
