// CHE Usage Center (Stage 4 of docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md): ONE evidence-backed view of providers,
// subscriptions, credits, quotas, AI tokens, GPU seconds / CPU hours, jobs, and estimated vs invoiced cost.
//
// This is a read-side view over the records CHE already keeps. It is not a second ledger:
//   AI engines      resilience.js KEY_PROVIDERS + key_health (key tests), ai_router.js ai_health (successful calls) and
//                   ai_usage:<id> (per-provider daily token count), usage_tracker.js tok_day:* (daily totals)
//   compute         compute_pool.js providerStatuses (credential, Kaggle quota, prepaid balances, cooldowns), the
//                   gpu:jobs attempt records (claim → result wall time) and compute_budget.js (paid sessions, the
//                   owner's GPU budget). Per-job receipts are read through computeReceipts(): when compute_pool.js or
//                   compute_budget.js exports computeUsageLedger(storage, { month }) it is used as is.
//   subscriptions   only what the owner said (stored here with his exact words and the time) or what a connected
//                   provider API returns (none of the connected providers has a subscription API today).
//
// Every number carries a provenance:
//   OBSERVED       read from a provider API or measured by CHE itself (with the source and the time)
//   ESTIMATED      measured usage × a published price (with the price source), or a count CHE approximates
//   USER_ENTERED   the owner said it (with the time and his exact words)
//   UNAVAILABLE    not known, with why. Never replaced by a guess.
// Status is "connected" only when the existing verification says so (a passing key test, a successful call, an
// authenticated quota or balance read, a fresh heartbeat). Purchases, cancellations and account changes are never
// performed here; removing a subscription record asks the owner first (AGENTS.md delete rule).
// Secrets never leave: rows carry at most a key's last four characters, as key_health already stores them.

import * as computePool from './compute_pool.js';
import * as computeBudget from './compute_budget.js';
import { KEY_PROVIDERS, storedKeys } from './resilience.js';
import { PENDING_OWNER_ACTION_KEY } from './owner_action_gate.js';

const { POOL_PROVIDERS, loadPool, providerStatuses } = computePool;
const { PAID_GPU_PRICES, budgetOf, sessionCost, remainingUsd } = computeBudget;

export const SUBS_KEY = 'usage:subscriptions';
export const MARKS_KEY = 'usage:balance_marks';
export const ALERTS_KEY = 'usage:alerts';
export const PROVENANCE = Object.freeze({ OBSERVED: 'OBSERVED', ESTIMATED: 'ESTIMATED', USER_ENTERED: 'USER_ENTERED', UNAVAILABLE: 'UNAVAILABLE' });
export const STATUS = Object.freeze({ connected: 'connected', not_connected: 'not connected', needs_owner_sign_in: 'needs owner sign-in', unverified: 'key saved, not verified', unknown: 'unknown: records unreadable' });
export const ALERT_RATIO = 0.8;               // warn at 80% of a quota or a spending cap
export const RENEWAL_ALERT_DAYS = 3;
export const MAX_SUBSCRIPTIONS = 60;
const MAX_ALERTS_KEPT = 20;
const ALERT_KEEP_MS = 30 * 86400_000;

const iso = (ms) => new Date(ms).toISOString();
const money = (usd) => `$${(Math.round(Number(usd || 0) * 100) / 100).toFixed(2)}`;
const hours = (s) => Math.round((Number(s || 0) / 3600) * 100) / 100;
const clip = (v, n = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clock = (now) => (typeof now === 'function' ? now : typeof now === 'number' ? () => now : () => Date.now());
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const get = async (storage, key, d) => { try { const v = await storage?.get?.(key); return v ?? d; } catch (_) { return d; } };
const monthOf = (ms) => iso(ms).slice(0, 7);

/** One labelled number. `value` is null only for UNAVAILABLE. */
export function metric(id, label, value, unit, provenance, extra = {}) {
  const m = { id, label, value: provenance === PROVENANCE.UNAVAILABLE ? null : value, unit: unit || '', provenance };
  for (const k of ['source', 'at', 'why', 'words', 'price_source']) if (extra[k]) m[k] = clip(extra[k], 300);
  m.text = metricText(m);
  return m;
}
const unavailable = (id, label, why) => metric(id, label, null, '', PROVENANCE.UNAVAILABLE, { why });

function metricText(m) {
  const tag = { OBSERVED: 'observed', ESTIMATED: 'estimated', USER_ENTERED: 'you told me', UNAVAILABLE: 'unavailable' }[m.provenance];
  if (m.provenance === PROVENANCE.UNAVAILABLE) return `${m.label}: unavailable. ${m.why || ''}`.trim();
  const v = m.unit === 'usd' ? money(m.value) : typeof m.value === 'number' ? `${Number(m.value).toLocaleString('en-US')}${m.unit ? ` ${m.unit}` : ''}` : `${m.value}${m.unit ? ` ${m.unit}` : ''}`;
  return `${m.label}: ${v} (${tag}${m.source ? `; ${m.source}` : ''}${m.price_source ? `; price: ${m.price_source}` : ''}).`;
}

// ─── Compute receipts (adapter) ────────────────────────────────────────────────────────────────────────────────
const poolGpu = Object.fromEntries(POOL_PROVIDERS.map((p) => [p.id, p.gpu]));

/**
 * Normalized per-job compute receipts for one month: { provider, job, kind, gpu_seconds, cpu_seconds, estimated_cost,
 * billed_cost, provenance, source }. The ledger is lane/modal-gpu's modal_gpu.js computeUsageLedger(storage, { month, now })
 * ({ receipts: [...], modal_credit, totals }); integrating it is one line: import it here and make it the default.
 */
export async function computeReceipts(storage, { month, now = Date.now(), ledger = computePool.computeUsageLedger || computeBudget.computeUsageLedger } = {}) {
  const m = month || monthOf(now);
  if (typeof ledger === 'function') {
    try {
      const out = await ledger(storage, { month: m, now });
      const rows = Array.isArray(out) ? out : Array.isArray(out?.receipts) ? out.receipts : Array.isArray(out?.rows) ? out.rows : null;
      if (rows) return { source: 'computeUsageLedger', rows: rows.map((r) => normalizeReceipt(r)), modal_credit: out?.modal_credit || null };
    } catch (_) { /* fall back to the job records below */ }
  }
  const jobs = (await storage.get('gpu:jobs')) ?? [];
  const rows = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    for (const a of j?.pool?.attempts || []) {
      const start = Date.parse(a.started_at || ''); const end = Date.parse(a.ended_at || '');
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || monthOf(end) !== m) continue;
      const s = Math.round((end - start) / 1000);
      const gpu = poolGpu[a.provider] === true || (poolGpu[a.provider] == null && j.receipt?.device_summary?.kind === 'GPU');
      rows.push(normalizeReceipt({ provider: a.provider, job: j.id, kind: j.kind, outcome: a.outcome, gpu_seconds: gpu ? s : 0, cpu_seconds: gpu ? 0 : s,
        estimated_cost: null, provenance: 'observed', source: "CHE's job record: wall time from claim to result" }));
    }
  }
  return { source: 'gpu:jobs attempts', rows };
}

function normalizeReceipt(r = {}) {
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const prov = (v) => String(v || '').toUpperCase().replace('-', '_');
  // A ledger row's time can be unknown (gpu_seconds null, provenance UNAVAILABLE): it is counted as unmeasured, never as 0.
  const timed = !(r.gpu_seconds == null && r.cpu_seconds == null && 'gpu_seconds' in r) && prov(r.gpu_seconds_provenance) !== 'UNAVAILABLE';
  return { provider: clip(r.provider || 'unknown', 40), job: clip(r.job || r.job_id || r.idempotency_key || '', 64), kind: clip(r.kind || r.job_title || '', 80), outcome: clip(r.outcome || r.state || r.job_state || '', 30),
    gpu_seconds: num(r.gpu_seconds) || 0, cpu_seconds: num(r.cpu_seconds) || 0, measured: timed, estimated_cost: num(r.estimated_cost ?? r.estimated_cost_usd), billed_cost: num(r.billed_cost_usd),
    provenance: prov(r.gpu_seconds_provenance || r.provenance || 'observed'), source: clip(r.source || r.cost_basis || '', 160) };
}

// ─── Subscriptions the owner tells CHE ──────────────────────────────────────────────────────────────────────────
const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function wordNumber(words) {
  const w = String(words || '').toLowerCase().replace(/-/g, ' ').trim().split(/\s+/);
  let n = 0; let seen = false;
  for (const x of w) {
    if (x === 'a' && !seen) { n = 1; seen = true; continue; }
    if (x === 'hundred' && seen) { n *= 100; continue; }
    if (x === 'and') continue;
    if (x in SMALL) { n += SMALL[x]; seen = true; } else if (x in TENS) { n += TENS[x]; seen = true; } else return null;
  }
  return seen ? n : null;
}
function ordinalDay(text) {
  const m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(text);
  if (m) return Number(m[1]);
  const parts = text.replace(/-/g, ' ').split(/\s+/);
  if (parts.length === 1) return ORD[parts[0]] ?? null;
  if (parts.length === 2 && TENS[parts[0]] && ORD[parts[1]] && ORD[parts[1]] < 10) return TENS[parts[0]] + ORD[parts[1]];
  return null;
}

/**
 * "my ChatGPT subscription is $20 a month, renews on the 3rd" → { ok, sub } or { ok: false, missing, detail }.
 * Only what was said is stored; nothing is looked up or filled in.
 */
export function parseSubscription(text, now = Date.now()) {
  const words = clip(text, 300);
  const t = words.toLowerCase().replace(/[’‘]/g, "'").replace(/^(?:(?:hey|ok|okay)\s+)?(?:che|chey|chay|shay)[\s,.:;!-]+/, '').replace(/[.!?]+$/, '').trim();
  const name = (/^(?:add|record|save|note|remember)\s+(?:a\s+|my\s+|the\s+)?subscription\s+(?:to|for|called)\s+(.+?)(?:[,:;]|\s+(?:at|for|is|costs?|of)\s|\s+\$|\s+\d|$)/.exec(t)
    || /^(?:(?:add|record|save|note|remember)\s+)?(?:a\s+|my\s+|the\s+)?(.+?)\s+subscription\b/.exec(t)
    || /^(?:i\s+(?:pay|spend)\s+.+?\s+(?:a|per|each|every)\s+(?:month|year|week)\s+(?:for|on)\s+)(.+?)(?:[,;]|$)/.exec(t))?.[1]
    ?.replace(/^(?:add|record|save|note|remember)\s+(?:a\s+|my\s+|the\s+)?/, '').replace(/^(?:my|the|a)\s+/, '').trim();
  const pos = name ? words.toLowerCase().replace(/[’‘]/g, "'").indexOf(name) : -1;
  const cased = pos >= 0 ? words.slice(pos, pos + name.length) : name;
  const cleanName = name && name.length <= 60 && !/^(?:a|my|the|new|subscription)$/.test(name)
    ? (cased === cased.toLowerCase() ? cased.replace(/\b\w/g, (c) => c.toUpperCase()) : cased) : '';
  let amount = null;
  const dollarsM = /\$\s?(\d{1,5}(?:\.\d{1,2})?)|(\d{1,5}(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd)\b(?:\s+and\s+(\d{1,2})\s+cents?)?/.exec(t);
  if (dollarsM) amount = Number(dollarsM[1] || dollarsM[2]) + (dollarsM[3] ? Number(dollarsM[3]) / 100 : 0);
  else {
    const w = /((?:(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|and)[\s-]*)+)\s*(?:dollars?|bucks)\b/.exec(t);
    if (w) amount = wordNumber(w[1].trim());
  }
  const period = /\b(?:a|per|each|every|\/)\s*(month|year|week)\b|\b(monthly|yearly|annually|annual|weekly)\b/.exec(t);
  const per = period ? ({ monthly: 'month', yearly: 'year', annually: 'year', annual: 'year', weekly: 'week' }[period[2]] || period[1]) : null;
  let renews = null;
  const onDate = new RegExp(`\\brenew(?:s|ed|ing|al)?(?:\\s+date)?(?:\\s+is)?\\s+(?:on\\s+)?(${MONTHS.join('|')})\\s+(?:the\\s+)?([a-z0-9-]+(?:\\s[a-z]+)?)`).exec(t);
  const onDay = /\brenew(?:s|ed|ing|al)?(?:\s+date)?(?:\s+is)?\s+(?:on\s+)?(?:the\s+)?([a-z0-9-]+(?:\s[a-z]+)?)(?:\s+of\s+(?:each|every|the)\s+month)?/.exec(t);
  const day = (s) => { const two = ordinalDay(s); if (two != null) return [two, s]; const one = s.split(' ')[0]; const d = ordinalDay(one); return d != null ? [d, one] : [null, '']; };
  if (onDate) { const [d, w] = day(onDate[2]); if (d && d <= 31) renews = { month: MONTHS.indexOf(onDate[1]) + 1, day: d, said: `${onDate[1][0].toUpperCase()}${onDate[1].slice(1)} ${w}` }; }
  if (!renews && onDay) { const [d, w] = day(onDay[1]); if (d && d <= 31) renews = { day: d, said: `the ${w}` }; }
  const missing = [!cleanName && 'name', amount == null && 'price'].filter(Boolean);
  if (missing.length) {
    return { ok: false, missing, detail: `I need the ${missing.join(' and the ')} to record it, for example: "my ChatGPT subscription is 20 dollars a month, renews on the 3rd". Nothing was saved.` };
  }
  if (amount > 100000) return { ok: false, missing: ['price'], detail: `${money(amount)} is more than I accept by voice, in case I misheard. Nothing was saved.` };
  return { ok: true, sub: { id: `sub_${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, name: cleanName, amount_usd: Math.round(amount * 100) / 100, period: per,
    renews, words, at: iso(now), provenance: PROVENANCE.USER_ENTERED } };
}

export async function loadSubscriptions(storage, { strict = false } = {}) {
  const list = strict ? ((await storage.get(SUBS_KEY)) ?? []) : await get(storage, SUBS_KEY, []);
  return Array.isArray(list) ? list.filter((s) => s && s.id && s.name) : [];
}

export async function addSubscription(storage, text, now = Date.now()) {
  const p = parseSubscription(text, now);
  if (!p.ok) return p;
  const list = await loadSubscriptions(storage);
  const same = list.find((s) => s.name.toLowerCase() === p.sub.name.toLowerCase());
  const next = same ? list.map((s) => (s === same ? { ...p.sub, id: same.id, replaced: { words: same.words, at: same.at } } : s)) : [...list, p.sub];
  if (next.length > MAX_SUBSCRIPTIONS) return { ok: false, detail: `I keep at most ${MAX_SUBSCRIPTIONS} subscriptions. Nothing was saved.` };
  await storage.put(SUBS_KEY, next);
  const saved = (await loadSubscriptions(storage)).find((s) => s.id === (same ? same.id : p.sub.id));
  if (!saved) return { ok: false, detail: 'I could not read the subscription back after saving, so I do not count it as saved.' };
  return { ok: true, sub: saved, updated: Boolean(same) };
}

/** Subscriptions whose name matches the words ("ChatGPT", "my netflix"). */
export async function findSubscriptions(storage, name) {
  const n = String(name || '').toLowerCase().replace(/^(?:my|the|a)\s+/, '').replace(/\s+subscription$/, '').trim();
  const list = await loadSubscriptions(storage);
  if (!n) return list;
  return list.filter((s) => s.name.toLowerCase() === n || s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase()));
}

export async function removeSubscription(storage, id) {
  const list = await loadSubscriptions(storage);
  const gone = list.find((s) => s.id === id);
  if (!gone) return { ok: false, detail: 'That subscription record is no longer there, so nothing was removed.' };
  await storage.put(SUBS_KEY, list.filter((s) => s.id !== id));
  const still = (await loadSubscriptions(storage)).some((s) => s.id === id);
  return still ? { ok: false, detail: `I could not remove the ${gone.name} record; it is still saved.` } : { ok: true, sub: gone };
}

/** The next renewal date implied by the owner's words, or null when he gave no day. */
export function nextRenewal(sub, now = Date.now()) {
  const r = sub?.renews;
  if (!r?.day) return null;
  const d = new Date(now); const y = d.getUTCFullYear(); const mo = d.getUTCMonth();
  const at = (yy, mm) => { const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate(); return Date.UTC(yy, mm, Math.min(r.day, last)); };
  const today = Date.UTC(y, mo, d.getUTCDate());
  if (r.month) { let t = at(y, r.month - 1); if (t < today) t = at(y + 1, r.month - 1); return t; }
  if (sub.period && sub.period !== 'month') return null;
  let t = at(y, mo); if (t < today) t = at(y, mo + 1);
  return t;
}
const monthlyEquivalent = (s) => (s.period === 'year' ? s.amount_usd / 12 : s.period === 'week' ? (s.amount_usd * 52) / 12 : s.period === 'month' ? s.amount_usd : null);

function subscriptionRow(s, now) {
  const nr = nextRenewal(s, now);
  const said = `You said at ${s.at.slice(0, 16).replace('T', ' ')} UTC: "${s.words}"`;
  return {
    id: `subscription:${s.id}`, sub_id: s.id, group: 'subscription', name: s.name, status: 'user entered', status_id: 'user_entered',
    purpose: 'A subscription you told CHE about. CHE did not check it with the provider and never changes or cancels it.', scopes: 'none (no account access)',
    metrics: [
      metric('price', 'Price', s.amount_usd, 'usd', PROVENANCE.USER_ENTERED, { words: s.words, at: s.at, source: s.period ? `per ${s.period}` : 'how often was not said' }),
      s.renews ? metric('renews', 'Renews', s.renews.said, '', PROVENANCE.USER_ENTERED, { words: s.words, at: s.at, source: nr ? `next: ${iso(nr).slice(0, 10)}, worked out from your words` : '' })
        : unavailable('renews', 'Renewal date', 'You did not say a renewal day, and no connected provider reports it.'),
      unavailable('invoiced', 'Invoiced cost', 'No connected provider API returns this subscription\'s invoices.'),
    ],
    said, updated_at: s.at,
  };
}

// ─── Rows ───────────────────────────────────────────────────────────────────────────────────────────────────────
const AI_IDS = ['groq', 'gemini', 'cerebras', 'mistral', 'openrouter', 'github', 'sambanova', 'huggingface', 'openai', 'xai'];
const PAID_AI = new Set(['openai', 'xai']);
const paidAiOn = (env) => ['1', 'true', 'yes'].includes(String(env?.CHE_ALLOW_PAID_AI || '').toLowerCase());
const limitOf = (env, id) => { const v = Number(env[`CHE_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_DAILY_TOKEN_LIMIT`] || 0); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; };

async function aiRows(env, storage, t) {
  let keys; let health; let calls;
  try {
    keys = (await storage.get('provider_keys')) || {}; health = (await storage.get('key_health')) || {}; calls = (await storage.get('ai_health')) || {};
  } catch (_) {
    // Unreadable records: say so instead of reporting "not connected" or zero tokens.
    return [...AI_IDS.filter((id) => KEY_PROVIDERS[id]).map((id) => KEY_PROVIDERS[id].name), 'Cloudflare Workers AI'].map((name) => ({
      id: `ai:${name}`, group: 'ai', name, status: STATUS.unknown, status_id: 'unknown', evidence: 'CHE could not read her key and call records just now.', purpose: 'Language engine', scopes: '',
      metrics: [unavailable('tokens_today', 'Tokens today', 'CHE could not read her token records just now.')], tokens_today: null, token_limit: null }));
  }
  if (!keys || typeof keys !== 'object') keys = await storedKeys(storage).catch(() => ({}));
  const rows = [];
  const tokensMetric = async (id, label) => {
    let rec;
    try { rec = (await storage.get(`ai_usage:${id}`)) ?? null; } catch (_) {
      return { used: null, reset: null, m: unavailable('tokens_today', `${label} tokens today`, 'CHE could not read this engine\'s token record just now.') };
    }
    const live = rec && t < Number(rec.reset_at || 0);
    const used = live ? Math.max(0, Number(rec.estimated_tokens) || 0) : 0;
    return { used, reset: live ? Number(rec.reset_at) : null, m: metric('tokens_today', `${label} tokens today`, used, 'tokens', PROVENANCE.ESTIMATED,
      { source: `CHE's router count${live ? ` (resets ${iso(rec.reset_at).slice(0, 16).replace('T', ' ')} UTC)` : ', no calls recorded since the last daily reset'}: the provider's own total when it reports one, otherwise characters ÷ 4` }) };
  };
  for (const id of AI_IDS) {
    const p = KEY_PROVIDERS[id];
    if (!p) continue;
    const key = String(env?.[p.env] || keys[p.env] || '');
    const h = health[id] || null; const call = calls[id] || null;
    let status = 'not_connected'; let evidence = `No key is saved. Say "connect ${p.name.split(' (')[0]}" and CHE opens her secure field; never paste a key into chat.`;
    if (key && h?.status === 'unauthorized') { status = 'needs_owner_sign_in'; evidence = `${p.name} refused the saved key${h.last4 ? ` ending ${h.last4}` : ''} (HTTP ${h.code || '401'}) at ${iso(h.at).slice(0, 16).replace('T', ' ')} UTC. A new key from your account is needed.`; }
    else if (key && (h?.status === 'healthy' || h?.status === 'rate-limited')) { status = 'connected'; evidence = `Key test passed at ${iso(h.at).slice(0, 16).replace('T', ' ')} UTC${h.status === 'rate-limited' ? ' (rate limited then, not refused)' : ''}.`; }
    else if (key && call?.last_ok_at) { status = 'connected'; evidence = `Last successful call at ${iso(call.last_ok_at).slice(0, 16).replace('T', ' ')} UTC.`; }
    else if (key) { status = 'unverified'; evidence = h ? `The last key test was inconclusive (${h.status}).` : 'A key is saved but has not passed a test or a call yet. Say "check my keys".'; }
    const paidOff = PAID_AI.has(id) && !paidAiOn(env);
    const tk = await tokensMetric(id, p.name.split(' (')[0]);
    const limit = limitOf(env, id);
    const metrics = [tk.m,
      unavailable('tokens_split', 'Tokens in and out', 'CHE\'s router keeps one total per call; the input and output split is not stored.'),
      limit ? metric('daily_cap', 'Daily token cap CHE applies', limit, 'tokens', PROVENANCE.OBSERVED, { source: 'Worker setting; CHE holds this engine back near it' })
        : unavailable('provider_quota', 'Provider quota left', `${p.name.split(' (')[0]} gives CHE no remaining-quota read; its free-tier limits are on its own site.`),
      paidOff ? metric('che_spend', 'Spent through CHE', 0, 'usd', PROVENANCE.OBSERVED, { source: 'paid engines are off in CHE\'s router (CHE_ALLOW_PAID_AI is not set), so CHE made no paid calls' })
        : unavailable('token_charge', 'Token charge', `CHE reads no billing data from ${p.name.split(' (')[0]}; any charge is set by your plan there.`),
      unavailable('invoiced', 'Invoiced cost', 'No invoice API is connected for this provider.'),
    ];
    rows.push({ id: `ai:${id}`, group: 'ai', name: p.name, status: STATUS[status], status_id: status, evidence,
      purpose: paidOff ? 'Language engine (paid; switched off unless you turn paid AI on)' : 'Language engine for chat, research and coding',
      scopes: key ? `API key${h?.last4 ? ` ending ${h.last4}` : ''}; the provider reports no scopes` : 'none', metrics,
      tokens_today: tk.used, token_limit: limit || null });
  }
  // Cloudflare Workers AI: the Worker's own binding.
  const cf = calls.cloudflare || {};
  const tk = await tokensMetric('cloudflare', 'Workers AI');
  const cfStatus = !env?.AI ? 'not_connected' : cf.last_ok_at ? 'connected' : 'unverified';
  rows.push({ id: 'ai:cloudflare', group: 'ai', name: 'Cloudflare Workers AI', status: STATUS[cfStatus], status_id: cfStatus,
    evidence: !env?.AI ? 'The Worker has no AI binding.' : cf.last_ok_at ? `Last successful call at ${iso(cf.last_ok_at).slice(0, 16).replace('T', ' ')} UTC.` : 'Bound, but no successful call is recorded yet.',
    purpose: 'CHE\'s built-in language engine', scopes: 'Worker AI binding', tokens_today: tk.used, token_limit: limitOf(env, 'cloudflare') || null,
    metrics: [tk.m, unavailable('neurons', 'Daily free allowance left', 'Cloudflare reports Workers AI usage in its dashboard; CHE has no API read of it.'),
      unavailable('invoiced', 'Invoiced cost', 'CHE does not read Cloudflare billing.')] });
  return rows;
}

const COMPUTE_IDS = ['github_actions_cpu', 'colab_gpu', 'kaggle', 'runpod', 'vast', 'modal'];
const PURPOSE = {
  github_actions_cpu: 'Free CPU worker for character builds and renders', colab_gpu: 'Your Colab GPU while the notebook is open',
  kaggle: 'Free weekly Kaggle GPU quota', runpod: 'Prepaid GPUs, only within your GPU budget', vast: 'Prepaid GPUs, only within your GPU budget', modal: 'GPU functions (not wired yet)',
};

async function computeRows(env, storage, t, receipts) {
  let statuses = [];
  try { statuses = await providerStatuses(env, { storage, now: () => t, refreshQuota: false, fetcher: async () => { throw new Error('the Usage Center reads stored records only'); } }); }
  catch (_) { statuses = []; }
  const pool = await loadPool(storage).catch(() => null);
  const budget = pool ? budgetOf(pool) : null;
  const byId = Object.fromEntries(statuses.map((s) => [s.id, s]));
  const rows = [];
  for (const id of COMPUTE_IDS) {
    const s = byId[id];
    const label = s?.label || POOL_PROVIDERS.find((p) => p.id === id)?.label || id;
    if (!s) { rows.push({ id: `compute:${id}`, group: 'compute', name: label, status: STATUS.unknown, status_id: 'unknown', evidence: 'The compute pool status could not be read just now.', purpose: PURPOSE[id], scopes: '', metrics: [unavailable('status', 'Status', 'The compute pool record could not be read.')] }); continue; }
    const has = s.credential?.exists === true;
    const q = s.quota || {};
    let status = has ? 'unverified' : 'not_connected'; let evidence = s.reason || '';
    const metrics = [];
    const mine = receipts.rows.filter((r) => r.provider === id);
    const gpuS = mine.reduce((a, r) => a + r.gpu_seconds, 0); const cpuS = mine.reduce((a, r) => a + r.cpu_seconds, 0);
    const jobsN = new Set(mine.map((r) => r.job)).size;
    const measured = { source: receipts.source === 'computeUsageLedger' ? 'compute ledger receipts' : "CHE's job records (claim to result wall time)" };
    if (receipts.source === 'unavailable') metrics.push(unavailable('jobs_month', 'Jobs and compute time this month', 'CHE could not read her job records just now.'));
    else {
      metrics.push(metric('jobs_month', 'Jobs this month', jobsN, 'jobs', PROVENANCE.OBSERVED, measured));
      const timed = mine.filter((r) => r.measured !== false);
      const timeProv = timed.some((r) => r.provenance === PROVENANCE.ESTIMATED) ? PROVENANCE.ESTIMATED : PROVENANCE.OBSERVED;
      const timeSrc = { source: `${measured.source}${timed.length < mine.length ? `; ${mine.length - timed.length} of ${mine.length} jobs have no measured time and are not counted` : ''}` };
      if (mine.length && !timed.length) metrics.push(unavailable(s.gpu === true ? 'gpu_seconds' : 'cpu_hours', s.gpu === true ? 'GPU seconds this month' : 'CPU hours this month', 'No job this month has a measured run time.'));
      else if (s.gpu === true) metrics.push(metric('gpu_seconds', 'GPU seconds this month', Math.round(gpuS * 10) / 10, 's', timeProv, timeSrc));
      else metrics.push(metric('cpu_hours', 'CPU hours this month', hours(cpuS), 'h', timeProv, timeSrc));
    }
    if (id === 'github_actions_cpu') {
      if (s.status === 'ready' || s.status === 'cooling_down') status = 'connected';
      metrics.push(q.public_repository === true
        ? metric('cost', 'Cost this month', 0, 'usd', PROVENANCE.ESTIMATED, { source: `${hours(cpuS)} CPU hours × $0`, price_source: `GitHub: standard runners are free for public repositories; repository checked public${q.checked_at ? ` at ${String(q.checked_at).slice(0, 16).replace('T', ' ')} UTC` : ''}` })
        : unavailable('cost', 'Cost this month', 'The repository is not verified public, so free runner minutes are not confirmed.'));
    } else if (id === 'colab_gpu') {
      if (s.online > 0) { status = 'connected'; } else status = 'not_connected';
      if (has && !s.online) evidence = `Paired, but the notebook is closed. ${s.reason || ''}`.trim();
      metrics.push(unavailable('quota', 'GPU quota left', 'Colab publishes no quota or usage API.'));
      metrics.push(unavailable('cost', 'Cost', 'Colab has no billing API. If you pay for Colab Pro, add it as a subscription.'));
    } else if (id === 'kaggle') {
      if (has && q.ok === true) status = 'connected';
      else if (has && /unauthori[sz]ed|401|403/.test(String(s.reason))) status = 'needs_owner_sign_in';
      if (q.ok === true) {
        const at = { source: `Kaggle API (${q.source || 'GetAcceleratorQuotaStatistics'})`, at: q.checked_at || '' };
        metrics.push(metric('quota_used', 'GPU hours used this week', hours(q.used_s), 'h', PROVENANCE.OBSERVED, at));
        metrics.push(metric('quota_left', 'GPU hours left this week', hours(q.left_s), 'h', PROVENANCE.OBSERVED, at));
        if (q.refresh) metrics.push(metric('quota_reset', 'Quota resets', String(q.refresh).slice(0, 16).replace('T', ' '), 'UTC', PROVENANCE.OBSERVED, at));
        metrics.push(metric('cost', 'Cost', 0, 'usd', PROVENANCE.ESTIMATED, { source: `${hours(gpuS / 1)} h of free weekly quota × $0`, price_source: 'Kaggle free GPU quota; pay-to-scale was off at the last quota read' }));
      } else metrics.push(unavailable('quota', 'GPU quota', has ? `Kaggle's quota has not been read successfully${q.checked_at ? ` (last try ${String(q.checked_at).slice(0, 16).replace('T', ' ')} UTC)` : ''}.` : 'No Kaggle token is saved.'));
    } else if (id === 'runpod' || id === 'vast') {
      const bal = budget?.balances?.[id] || null;
      if (has && bal?.ok === true) status = 'connected';
      else if (has && bal && bal.ok === false) status = 'needs_owner_sign_in';
      if (bal?.ok === true && bal.usd != null) metrics.push(metric('balance', 'Prepaid balance', bal.usd, 'usd', PROVENANCE.OBSERVED, { source: `${id === 'runpod' ? 'RunPod' : 'Vast.ai'} API balance read`, at: bal.checked_at }));
      else metrics.push(unavailable('balance', 'Prepaid balance', has ? 'No successful balance read is stored yet.' : 'No key is saved.'));
      const month = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1);
      const sessions = (budget?.sessions || []).filter((x) => x.provider === id && (x.ended_ms || t) >= month);
      const billed = sessions.filter((x) => Number.isFinite(x.usd_billed)).reduce((a, x) => a + x.usd_billed, 0);
      const est = sessions.filter((x) => !Number.isFinite(x.usd_billed));
      const estUsd = est.reduce((a, x) => a + sessionCost(x, t), 0);
      const estH = est.reduce((a, x) => a + Math.max(0, ((x.ended_ms || t) - x.started_ms) / 3600_000), 0);
      if (sessions.some((x) => Number.isFinite(x.usd_billed))) metrics.push(metric('invoiced', 'Billed by the provider this month', Math.round(billed * 100) / 100, 'usd', PROVENANCE.OBSERVED, { source: `${id === 'runpod' ? 'RunPod billing API' : 'provider billing'} per session` }));
      else metrics.push(unavailable('invoiced', 'Billed by the provider this month', sessions.length ? 'The provider has not reported billing for these sessions yet.' : 'No paid session ran this month.'));
      metrics.push(est.length
        ? metric('estimated', 'Estimated, not yet billed', Math.round(estUsd * 100) / 100, 'usd', PROVENANCE.ESTIMATED, { source: `${Math.round(estH * 100) / 100} GPU hours × the hourly price`, price_source: `the live price the provider returned at start, else ${PAID_GPU_PRICES[id]?.source || 'the published price'}` })
        : metric('estimated', 'Estimated, not yet billed', 0, 'usd', PROVENANCE.OBSERVED, { source: 'no unbilled paid session this month in CHE\'s session records' }));
    } else if (id === 'modal') {
      status = has ? 'unverified' : 'not_connected';
      evidence = has ? 'A Modal key is saved, but Modal has no plain HTTP check CHE can call, and no Modal route is wired yet.' : 'No Modal key is saved. Modal stays off until you set it up and approve it.';
      const mc = receipts.modal_credit;
      if (mc?.stated_credit_usd != null) metrics.push(metric('stated_credit', 'Monthly credit you stated', mc.stated_credit_usd, 'usd', PROVENANCE.USER_ENTERED, { source: 'Modal lane record' }));
      if (mc && Number.isFinite(Number(mc.used_estimate_usd))) metrics.push(metric('used_estimate', 'Used this month', Number(mc.used_estimate_usd), 'usd', PROVENANCE.ESTIMATED, { source: 'CHE\'s Modal call records × Modal\'s published per-second price' }));
      metrics.push(unavailable('credits', 'Free credits left', mc?.remaining_credit_why || 'CHE has no Modal API read; Modal shows credits in its dashboard.'));
      if (!mc) metrics.push(unavailable('cost', 'Cost', 'Modal is not wired, so CHE has run nothing there.'));
    }
    rows.push({ id: `compute:${id}`, group: 'compute', name: label, status: STATUS[status], status_id: status, evidence: clip(evidence, 400), purpose: PURPOSE[id],
      scopes: has ? s.credential.source : 'none', metrics, paid: Boolean(s.paid), cooling_until: s.cooling_until || null, quota: q });
  }
  // The owner's GPU budget (compute_budget.js): his own words and time, CHE's spend against it.
  if (pool) {
    const b = budget; const metrics = [];
    if (b.total_cap_usd > 0) {
      metrics.push(metric('cap', 'GPU budget you set', b.total_cap_usd, 'usd', PROVENANCE.USER_ENTERED, { words: b.approval_text, at: b.approved_at }));
      if (b.monthly_cap_usd > 0 && b.monthly_cap_usd < b.total_cap_usd) metrics.push(metric('monthly_cap', 'Monthly GPU limit you set', b.monthly_cap_usd, 'usd', PROVENANCE.USER_ENTERED, { words: b.approval_text, at: b.approved_at }));
    } else metrics.push(metric('cap', 'GPU budget', 0, 'usd', PROVENANCE.OBSERVED, { source: 'paid GPUs are off: no budget has been set' }));
    const all = b.sessions || [];
    const spent = all.reduce((a, x) => a + sessionCost(x, t), 0);
    const anyEst = all.some((x) => !Number.isFinite(x.usd_billed));
    metrics.push(metric('spent', 'Paid GPU spend so far', Math.round(spent * 100) / 100, 'usd', anyEst ? PROVENANCE.ESTIMATED : PROVENANCE.OBSERVED,
      { source: anyEst ? 'session wall time × hourly price, provider billing where reported' : all.length ? 'provider billing per session' : 'no paid session recorded' }));
    if (b.total_cap_usd > 0) metrics.push(metric('left', 'GPU money left after the safety margin', remainingUsd(pool, t), 'usd', anyEst ? PROVENANCE.ESTIMATED : PROVENANCE.OBSERVED, { source: 'your budget minus the spend above minus the safety margin' }));
    rows.push({ id: 'budget:gpu', group: 'budget', name: 'Your paid GPU budget', status: b.total_cap_usd > 0 ? 'set' : 'off', status_id: b.total_cap_usd > 0 ? 'connected' : 'not_connected',
      evidence: b.total_cap_usd > 0 ? `You set it at ${String(b.approved_at).slice(0, 16).replace('T', ' ')} UTC.` : 'Paid GPUs are off; CHE spends nothing on GPUs.', purpose: 'Caps what CHE may spend on paid GPUs', scopes: 'CHE never pays or adds credit', metrics,
      total_cap_usd: b.total_cap_usd, monthly_cap_usd: b.monthly_cap_usd, spent_usd: Math.round(spent * 100) / 100 });
  }
  return { rows, pool };
}

// ─── Alerts ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Unknown charges: a prepaid balance that fell more than CHE's own recorded GPU use explains. Updates the marks. */
async function balanceAlerts(storage, pool, t) {
  if (!pool) return [];
  const b = budgetOf(pool);
  const marks = await get(storage, MARKS_KEY, {});
  const log = (await get(storage, ALERTS_KEY, [])).filter((a) => t - Date.parse(a.at) < ALERT_KEEP_MS);
  let changed = false;
  for (const id of ['runpod', 'vast']) {
    const bal = b.balances?.[id];
    if (!bal?.ok || bal.usd == null || !bal.checked_at) continue;
    const spent = (b.sessions || []).filter((x) => x.provider === id).reduce((a, x) => a + sessionCost(x, t), 0);
    const mark = marks[id];
    if (mark && mark.checked_at === bal.checked_at) continue;
    if (mark) {
      const drop = mark.usd - bal.usd; const explained = Math.max(0, spent - mark.spent_usd); const extra = drop - explained;
      if (extra > Math.max(0.25, 0.1 * Math.max(drop, 0))) {
        log.push({ id: `unknown:${id}:${bal.checked_at}`, kind: 'unknown_charge', severity: 'warning', provider: id, at: iso(t),
          text: `Unknown charge on ${id === 'runpod' ? 'RunPod' : 'Vast.ai'}: the prepaid balance fell ${money(drop)} between ${mark.checked_at.slice(0, 16).replace('T', ' ')} and ${bal.checked_at.slice(0, 16).replace('T', ' ')} UTC, but CHE's own GPU sessions account for ${money(explained)}. ${money(extra)} is not from CHE's recorded use; please check that provider's billing page.`,
          provenance: PROVENANCE.OBSERVED });
      }
    }
    marks[id] = { usd: bal.usd, checked_at: bal.checked_at, spent_usd: Math.round(spent * 10000) / 10000 };
    changed = true;
  }
  if (changed) { await storage.put(MARKS_KEY, marks); await storage.put(ALERTS_KEY, log.slice(-MAX_ALERTS_KEPT)); }
  return log.slice(-MAX_ALERTS_KEPT);
}

function liveAlerts(rows, subs, pool, t) {
  const out = [];
  for (const r of rows.filter((x) => x.group === 'ai' && x.token_limit)) {
    if (r.tokens_today >= ALERT_RATIO * r.token_limit) out.push({ id: `quota:${r.id}`, kind: 'quota', severity: 'warning', provenance: PROVENANCE.ESTIMATED, text: `${r.name} is at ${Math.round((100 * r.tokens_today) / r.token_limit)}% of its daily token cap (${r.tokens_today.toLocaleString('en-US')} of ${r.token_limit.toLocaleString('en-US')}, estimated). CHE holds it back near the cap.` });
  }
  const k = rows.find((x) => x.id === 'compute:kaggle')?.quota;
  if (k?.ok === true && k.allowed_s > 0 && (k.used_s + (k.reserved_s || 0)) >= ALERT_RATIO * k.allowed_s) {
    out.push({ id: 'quota:kaggle', kind: 'quota', severity: 'warning', provenance: PROVENANCE.OBSERVED, text: `Kaggle's free GPU quota is ${Math.round((100 * (k.used_s + (k.reserved_s || 0))) / k.allowed_s)}% used this week (${hours(k.left_s)} hours left${k.refresh ? `, resets ${String(k.refresh).slice(0, 16).replace('T', ' ')} UTC` : ''}).` });
  }
  if (pool) {
    const b = budgetOf(pool);
    const spent = (b.sessions || []).reduce((a, x) => a + sessionCost(x, t), 0);
    if (b.total_cap_usd > 0 && spent >= ALERT_RATIO * b.total_cap_usd) out.push({ id: 'spend:gpu_total', kind: 'spending', severity: 'warning', provenance: PROVENANCE.ESTIMATED, text: `Paid GPU spend is ${money(spent)}, ${Math.round((100 * spent) / b.total_cap_usd)}% of the ${money(b.total_cap_usd)} budget you set. CHE stops before the limit.` });
    const month = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1);
    const monthSpent = (b.sessions || []).filter((x) => x.started_ms >= month).reduce((a, x) => a + sessionCost(x, t), 0);
    if (b.monthly_cap_usd > 0 && b.monthly_cap_usd < b.total_cap_usd && monthSpent >= ALERT_RATIO * b.monthly_cap_usd) out.push({ id: 'spend:gpu_month', kind: 'spending', severity: 'warning', provenance: PROVENANCE.ESTIMATED, text: `Paid GPU spend this month is ${money(monthSpent)}, ${Math.round((100 * monthSpent) / b.monthly_cap_usd)}% of your ${money(b.monthly_cap_usd)} monthly limit.` });
    for (const x of b.sessions || []) {
      if (!Number.isFinite(x.usd_billed) || !x.ended_ms) continue;
      const est = Math.max(0, (x.ended_ms - x.started_ms) / 3600_000) * (Number(x.usd_hr) || 0);
      if (x.usd_billed > est * 1.25 + 0.1) out.push({ id: `billed:${x.id}`, kind: 'unknown_charge', severity: 'warning', provenance: PROVENANCE.OBSERVED, text: `${x.provider === 'runpod' ? 'RunPod' : x.provider} billed ${money(x.usd_billed)} for a session CHE measured at about ${money(est)} (${x.gpu || 'GPU'}, ${x.started_at?.slice(0, 16).replace('T', ' ')} UTC). Please check the provider's billing page.` });
    }
  }
  for (const s of subs) {
    const nr = nextRenewal(s, t);
    if (nr != null && nr - Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate()) <= RENEWAL_ALERT_DAYS * 86400_000) {
      out.push({ id: `renewal:${s.id}`, kind: 'renewal', severity: 'info', provenance: PROVENANCE.USER_ENTERED, text: `${s.name} renews on ${iso(nr).slice(0, 10)} for ${money(s.amount_usd)}${s.period ? ` a ${s.period}` : ''}, from what you told me. CHE does not renew or cancel it.` });
    }
  }
  return out;
}

/** Today and the last 30 days from usage_tracker.js's tok_day:YYYY-MM-DD records (the same keys it writes). */
async function tokenTotals(storage, t) {
  let today = 0; let month = 0;
  for (let i = 0; i < 30; i++) {
    const n = Number(await storage.get(`tok_day:${iso(t - i * 86400_000).slice(0, 10)}`)) || 0;
    if (i === 0) today = n;
    month += n;
  }
  return { today, month };
}

// ─── The view ───────────────────────────────────────────────────────────────────────────────────────────────────
/** The whole Usage Center: rows, subscriptions, alerts and totals. Reads stored records only (no provider calls). */
export async function usageView(env = {}, { storage, now, ledger } = {}) {
  const t = clock(now)();
  const receipts = await computeReceipts(storage, { month: monthOf(t), now: t, ...(ledger !== undefined ? { ledger } : {}) }).catch(() => ({ source: 'unavailable', rows: [] }));
  const noReceipts = receipts.source === 'unavailable';
  const ai = await aiRows(env, storage, t).catch(() => []);
  const { rows: compute, pool } = await computeRows(env, storage, t, receipts).catch(() => ({ rows: [], pool: null }));
  const read = await loadSubscriptions(storage, { strict: true }).catch(() => null);
  const subs = read || [];
  const tokens = await tokenTotals(storage, t).catch(() => null);
  const rows = [...ai, ...compute, ...subs.map((s) => subscriptionRow(s, t))];
  const stored = await balanceAlerts(storage, pool, t).catch(() => []);
  const alerts = [...liveAlerts(rows, subs, pool, t), ...stored];
  const monthly = subs.map(monthlyEquivalent);
  const totals = [
    tokens ? metric('tokens_today', 'CHE tokens today, all engines', tokens.today, 'tokens', PROVENANCE.ESTIMATED, { source: "CHE's router count (provider totals where reported, else characters ÷ 4)" })
      : unavailable('tokens_today', 'CHE tokens today', 'The token record could not be read.'),
    tokens ? metric('tokens_month', 'CHE tokens, last 30 days', tokens.month, 'tokens', PROVENANCE.ESTIMATED, { source: "CHE's router count" }) : unavailable('tokens_month', 'CHE tokens, last 30 days', 'The token record could not be read.'),
    noReceipts ? unavailable('gpu_seconds', 'GPU seconds this month', 'CHE could not read her job records just now.')
      : metric('gpu_seconds', 'GPU seconds this month, all providers', receipts.rows.reduce((a, r) => a + r.gpu_seconds, 0), 's', PROVENANCE.OBSERVED, { source: 'CHE\'s job records' }),
    noReceipts ? unavailable('cpu_hours', 'Cloud CPU hours this month', 'CHE could not read her job records just now.')
      : metric('cpu_hours', 'Cloud CPU hours this month', hours(receipts.rows.reduce((a, r) => a + r.cpu_seconds, 0)), 'h', PROVENANCE.OBSERVED, { source: 'CHE\'s job records' }),
    !read ? unavailable('subscriptions_month', 'Subscriptions per month', 'CHE could not read the subscriptions you told her just now.')
      : subs.length
      ? metric('subscriptions_month', 'Subscriptions you told me, per month', Math.round(monthly.filter((v) => v != null).reduce((a, v) => a + v, 0) * 100) / 100, 'usd', PROVENANCE.USER_ENTERED,
        { source: `sum of your ${monthly.filter((v) => v != null).length} entr${monthly.filter((v) => v != null).length === 1 ? 'y' : 'ies'} with a period; yearly ones ÷ 12${monthly.some((v) => v == null) ? `; ${monthly.filter((v) => v == null).length} without a period not counted` : ''}` })
      : unavailable('subscriptions_month', 'Subscriptions per month', 'You have not told me any subscriptions, and no connected provider reports them.'),
  ];
  const view = { at: iso(t), rows, subscriptions_readable: Boolean(read), subscriptions: subs.map((s) => ({ id: s.id, name: s.name, amount_usd: s.amount_usd, period: s.period, renews: s.renews, words: s.words, at: s.at })),
    alerts, totals, receipts: { source: receipts.source, count: receipts.rows.length },
    legend: { OBSERVED: 'read from a provider or measured by CHE', ESTIMATED: 'measured use × a published price, or CHE\'s own approximate count', USER_ENTERED: 'you told CHE (with your words and the time)', UNAVAILABLE: 'not known; the reason is given' } };
  view.spoken = speakUsageCenter(view);
  return view;
}

/** The spoken summary, read only when the owner asks. `focus`: '' | 'subscriptions' | 'alerts'. */
export function speakUsageCenter(view, focus = '') {
  const svc = view.rows.filter((r) => r.group === 'ai' || r.group === 'compute');
  const count = (id) => svc.filter((r) => r.status_id === id);
  const subs = view.subscriptions || [];
  const subLine = view.subscriptions_readable === false ? 'I could not read the subscriptions you told me just now, so I list none rather than guess.' : subs.length
    ? `Subscriptions you told me: ${subs.map((s, i) => `${i + 1}. ${s.name}, ${money(s.amount_usd)}${s.period ? ` a ${s.period}` : ', period not said'}${s.renews?.said ? `, renews ${s.renews.said}` : ''}`).join('. ')}. I have not checked these with the providers.`
    : 'You have not told me any subscriptions, and none of your connected providers reports subscriptions, so I list none. Say "add a subscription" to record one.';
  const alertLine = view.alerts.length ? `${view.alerts.length} alert${view.alerts.length === 1 ? '' : 's'}: ${view.alerts.map((a, i) => `${i + 1}. ${a.text}`).join(' ')}` : 'No usage alerts.';
  if (focus === 'subscriptions') return subLine;
  if (focus === 'alerts') return alertLine;
  const tk = view.totals.find((m) => m.id === 'tokens_today');
  const gpu = view.rows.find((r) => r.id === 'budget:gpu');
  const left = gpu?.metrics.find((m) => m.id === 'left');
  const named = (list) => list.map((r) => r.name.split(' (')[0]).join(', ');
  return [
    `Usage Center. ${count('connected').length} service${count('connected').length === 1 ? '' : 's'} connected${count('connected').length ? `: ${named(count('connected'))}` : ''}.`,
    count('needs_owner_sign_in').length ? `Needs your sign-in: ${named(count('needs_owner_sign_in'))}.` : '',
    count('unverified').length ? `Key saved but not verified: ${named(count('unverified'))}.` : '',
    count('unknown').length ? `I could not read the records for ${count('unknown').length} service${count('unknown').length === 1 ? '' : 's'} just now.` : '',
    `${count('not_connected').length} not connected.`,
    alertLine,
    tk?.value != null ? `CHE used about ${Number(tk.value).toLocaleString('en-US')} tokens today; that count is an estimate.` : '',
    gpu ? (gpu.total_cap_usd > 0 ? `Paid GPU budget ${money(gpu.total_cap_usd)}, spent ${money(gpu.spent_usd)}${left ? `, ${money(left.value)} left after the safety margin` : ''}.` : 'Paid GPUs are off, so CHE spends nothing on GPUs.') : '',
    subLine,
    view.rows.some((r) => r.metrics?.some((m) => m.id === 'invoiced' && m.provenance === PROVENANCE.OBSERVED)) ? '' : 'Provider invoices are unavailable: no connected provider reports invoices to CHE.',
  ].filter(Boolean).join(' ');
}

// ─── Voice and typing ───────────────────────────────────────────────────────────────────────────────────────────
const plain = (m) => String(m || '').trim().replace(/[’‘]/g, "'").replace(/^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chey|chay|shay)(?![a-z'])[\s,.:;!?-]*/i, '')
  .replace(/^(?:please|can you|could you|would you)\s+/i, '').replace(/[,\s]+(?:please|sir|now)\s*[.!?]?$/i, '').replace(/[.!?]+$/, '').trim();
const OPEN = /^(?:open|show(?: me)?|go to|take me to|bring up|read(?: me)?|check)\s+(?:the\s+|my\s+|your\s+)?usage(?:\s+(?:center|centre|screen|page|room|summary|report))?$/i;
const WHAT = /^(?:what(?:'s| is| are)|tell me|give me|how(?:'s| is))\s+(?:my|our|the|che'?s|your)\s+usage(?:\s+(?:center|centre|summary|report|today|this month|looking))?$|^usage(?:\s+(?:center|centre|summary|report))?$/i;
const ALERTS = /^(?:(?:what|which) (?:are|is) )?(?:my |the |any )?usage alerts?$|^(?:do i have|are there) any (?:usage|spending|quota) alerts?$|^(?:read|show)(?: me)? (?:my |the )?(?:usage|spending|quota) alerts?$/i;
const SUBS = /^(?:what|which) subscriptions (?:do i have|have i got|am i paying for)$|^(?:list|show|read|tell me)(?: me)? (?:all )?(?:of )?my subscriptions$|^what are my subscriptions$|^my subscriptions$/i;
const ADD_BARE = /^(?:add|record|save|note)\s+(?:a|another|a new)\s+subscription$/i;
const ADD = /^(?:add|record|save|note)\s+(?:a\s+|my\s+|the\s+)?(?:subscription\s+(?:to|for|called)\s+.+|.+?\s+subscription\b.*)$|^my\s+.+?\s+subscription\s+(?:is|costs?|=)\s+.+$/i;
const REMOVE_BARE = /^(?:remove|delete|take off)\s+(?:a|one|the)\s+subscription$/i;
const REMOVE = /^(?:remove|delete|forget|take off|drop)\s+(?:my|the)\s+(.+?)\s+subscription(?:\s+(?:record|entry))?(?:\s+from\s+(?:my\s+|the\s+)?(?:usage(?:\s+center)?|list))?$/i;

/** The owner's words as { command, input } for the Usage Center commands, or null. */
export function usageCenterIntent(message) {
  const t = plain(message).replace(/\?+$/, '');
  if (!t || t.length > 240) return null;
  if (OPEN.test(t) || WHAT.test(t)) return { command: 'usage-center', input: '' };
  if (ALERTS.test(t)) return { command: 'usage-center', input: 'alerts' };
  if (SUBS.test(t)) return { command: 'usage-center', input: 'subscriptions' };
  if (REMOVE_BARE.test(t)) return { command: 'usage-subscription-remove', input: '' };
  const rm = REMOVE.exec(t);
  if (rm) return { command: 'usage-subscription-remove', input: rm[1] };
  if (ADD_BARE.test(t)) return { command: 'usage-subscription-add', input: '' };
  if (ADD.test(t)) return { command: 'usage-subscription-add', input: t };
  return null;
}

/**
 * Runs one Usage Center command (command_catalog.js usage-*). Returns { ok, spoken, ...done fields }, or
 * { held: true, spoken } when it asked the owner to confirm a removal (the pending action is stored with the
 * record id as its pin; only his plain yes on the next turn releases it).
 */
export async function usageCommand(ctx, local, input = '', { pin = null, owner = false } = {}) {
  const t = clock(ctx.now)();
  const storage = ctx.storage;
  const words = String(input || '').trim();
  if (!owner) return { ok: false, spoken: 'Only the CHE owner can read or change the Usage Center. Nothing was read or changed.' };
  if (local === 'usage_center') {
    const cancel = /^cancel\s+(.+)$/i.exec(words);
    if (cancel) {
      return { ok: false, spoken: `I don't cancel subscriptions or change accounts myself: that is your decision, done on ${clip(cancel[1], 60)}'s own site with your sign-in. Nothing was cancelled. If you only want it off your Usage Center list, say "remove my ${clip(cancel[1], 60)} subscription" and I'll ask you to confirm.`, account_change: 'not_performed' };
    }
    const view = await usageView(ctx.env || {}, { storage, now: () => t });
    const focus = /^subscriptions?$/i.test(words) ? 'subscriptions' : /^alerts?$/i.test(words) ? 'alerts' : '';
    return { ok: true, spoken: speakUsageCenter(view, focus), alerts: view.alerts.length, rows: view.rows.length, open_screen: 'usage_center' };
  }
  if (local === 'usage_sub_add') {
    if (!words || ADD_BARE.test(words)) return { ok: false, needs_input: true, spoken: 'Tell me the name, the price and how often, and the renewal day if you know it. For example: "my ChatGPT subscription is 20 dollars a month, renews on the 3rd". I record only what you say; I don\'t look anything up.' };
    const out = await addSubscription(storage, words, t);
    if (!out.ok) return { ok: false, spoken: out.detail };
    const s = out.sub;
    return { ok: true, subscription: { id: s.id, name: s.name, amount_usd: s.amount_usd, period: s.period, renews: s.renews, at: s.at },
      spoken: `${out.updated ? 'Updated' : 'Saved'} at ${s.at.slice(11, 16)} UTC, as you said it: ${s.name}, ${money(s.amount_usd)}${s.period ? ` a ${s.period}` : ', how often not said'}${s.renews?.said ? `, renews ${s.renews.said}` : ', no renewal day said'}. It is marked "you told me" in the Usage Center; I did not check it with ${s.name}, and I never renew or cancel it.` };
  }
  if (local === 'usage_sub_remove') {
    if (pin) {
      const out = await removeSubscription(storage, String(pin));
      return out.ok ? { ok: true, spoken: `Removed the ${out.sub.name} record from your Usage Center. That only changes CHE's list; the subscription itself is untouched at ${out.sub.name}.` } : { ok: false, spoken: out.detail };
    }
    const matches = await findSubscriptions(storage, words);
    if (!matches.length) return { ok: false, spoken: words ? `I have no subscription called ${clip(words, 60)} in your Usage Center. Nothing was removed.` : 'You have no subscriptions in your Usage Center, so there is nothing to remove.' };
    if (!words || matches.length > 1) return { ok: false, spoken: `Which one? ${matches.map((s, i) => `${i + 1}. ${s.name}, ${money(s.amount_usd)}${s.period ? ` a ${s.period}` : ''}`).join('. ')}. Say "remove my" and its name. Nothing was removed.` };
    const s = matches[0];
    await storage.put(PENDING_OWNER_ACTION_KEY, { kinds: ['command'], command: 'usage-subscription-remove', input: s.name, pin: s.id, text: `/usage-subscription-remove ${s.name}`, at: t });
    return { held: true, ok: false, spoken: `Should I remove your ${s.name} subscription record (${money(s.amount_usd)}${s.period ? ` a ${s.period}` : ''}) from the Usage Center? This only deletes CHE's note; it does not cancel anything at ${s.name}. Say yes to remove it.` };
  }
  return { ok: false, spoken: 'That Usage Center command has no runner. Nothing was run.' };
}

/** usageCommand as the chat reply: CHE's NDJSON (delta + done), or the held-for-owner JSON for a removal question. */
export async function usageReply(ctx, command, input, opts = {}) {
  const { spoken, held, ...done } = await usageCommand(ctx, command.local, input, opts);
  if (held) return json({ message: spoken, reply: spoken, held_for_owner: true, owner_action_kind: 'delete', command: command.id, owner_approval_required: true });
  return new Response(`${JSON.stringify({ type: 'delta', delta: spoken })}\n${JSON.stringify({ type: 'done', source: 'che_usage_center', command: command.id, model_calls: 0, ...done })}\n`,
    { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ─── Routes: GET /api/usage, POST /api/usage/subscriptions, POST /api/usage/subscriptions/remove (owner only) ────
export async function usageRoute(ctx, path, request, body = null, { owner = false } = {}) {
  if (!owner) return json({ detail: 'Only the CHE owner can read the Usage Center.' }, 403);
  if (path === '/api/usage') {
    if (request.method !== 'GET') return json({ detail: 'Use GET.' }, 405);
    return json(await usageView(ctx.env || {}, ctx));
  }
  if (path === '/api/usage/subscriptions') {
    if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
    const out = await usageCommand(ctx, 'usage_sub_add', String(body?.text || ''), { owner: true });
    return json(out, out.ok ? 200 : 422);
  }
  if (path === '/api/usage/subscriptions/remove') {
    if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
    const subs = await loadSubscriptions(ctx.storage);
    const s = subs.find((x) => x.id === String(body?.id || ''));
    if (!s) return json({ ok: false, spoken: 'That subscription record is not there. Nothing was removed.' }, 404);
    // The screen's own confirmation (a spoken and visible question) must come first: AGENTS.md delete rule.
    if (body?.confirm !== true) return json({ ok: false, needs_confirmation: true, spoken: `Remove your ${s.name} subscription record from the Usage Center? It does not cancel anything at ${s.name}. Confirm to remove it.` }, 409);
    const out = await usageCommand(ctx, 'usage_sub_remove', s.name, { owner: true, pin: s.id });
    return json(out, out.ok ? 200 : 422);
  }
  return json({ detail: 'Not found.' }, 404);
}
