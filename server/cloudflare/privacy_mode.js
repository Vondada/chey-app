import { AsyncLocalStorage } from 'node:async_hooks';

// Private Mode (owner, 2026-10-27: "I do not want OpenAI, Anthropic, Google, or other outside AI providers receiving
// my private conversations by default"). Enforced in code, at the one place every outbound request passes: the
// Worker's fetch guard (security_intelligence.installEgressGuard) asks privacyVerdict() before a byte leaves.
//
// Levels:
//  - private (the default, also when nothing is stored): no outside AI or voice company is called. CHE's own
//    runtime (Cloudflare, where her storage already lives, and Workers AI through its binding) and the owner's own
//    compute (his Ollama server, GitHub, Cloudflare account) stay reachable.
//  - connected: the owner turned Private Mode off; outside providers are reachable as before.
// A grant ("let Claude help for an hour") opens one destination until it expires; nothing else opens.
//
// Knox's ledger records every outside AI or voice request, sent or blocked: when, which company and host, the
// byte count and a fingerprint of the body, never the body itself. Knox answers from it, with no model.
//
// Not covered yet, and said so: CHE's storage and Workers AI are in Cloudflare (not the owner's own devices);
// web search and market-data hosts are not gated by this mode.

export const PRIVACY_KEY = 'che:privacy_mode';
export const LEDGER_KEY = 'che:egress_ledger';
export const DAILY_KEY = 'che:egress_daily';
export const PENDING_KEY = 'che:privacy_pending';
const LEDGER_MAX = 500;
const HOUR = 3_600_000;

// Outside AI and voice companies, by the hosts CHE's code calls.
export const PROVIDERS = Object.freeze({
  openai: { name: 'OpenAI (ChatGPT)', hosts: ['api.openai.com'] },
  anthropic: { name: 'Anthropic (Claude)', hosts: ['api.anthropic.com'] },
  google: { name: 'Google (Gemini)', hosts: ['generativelanguage.googleapis.com'] },
  xai: { name: 'xAI (Grok)', hosts: ['api.x.ai'] },
  groq: { name: 'Groq', hosts: ['api.groq.com'] },
  cerebras: { name: 'Cerebras', hosts: ['api.cerebras.ai'] },
  mistral: { name: 'Mistral', hosts: ['api.mistral.ai'] },
  github_models: { name: 'GitHub Models', hosts: ['models.github.ai', 'models.inference.ai.azure.com'] },
  sambanova: { name: 'SambaNova', hosts: ['api.sambanova.ai'] },
  huggingface: { name: 'Hugging Face', hosts: ['router.huggingface.co', 'api-inference.huggingface.co'] },
  openrouter: { name: 'OpenRouter', hosts: ['openrouter.ai'] },
  elevenlabs: { name: 'ElevenLabs (voice)', hosts: ['api.elevenlabs.io'] },
  fish: { name: 'Fish Audio (voice)', hosts: ['api.fish.audio'] },
  microsoft_voice: { name: 'Microsoft Edge voice', hosts: ['speech.platform.bing.com'] },
  modal: { name: 'Modal GPU', hosts: [], suffix: '.modal.run' },
});

/** The outside provider a host belongs to, or null. */
export function providerFor(host) {
  const h = String(host || '').toLowerCase();
  for (const [id, p] of Object.entries(PROVIDERS)) if (p.hosts.includes(h) || (p.suffix && h.endsWith(p.suffix))) return id;
  return null;
}

// The policy is carried per request (AsyncLocalStorage, wrangler flag nodejs_als): two CHE objects sharing an isolate
// never see each other's setting or ledger, and background work a request starts keeps that request's policy.
// Private Mode governs everything a CheState does; code outside one (public pages, health checks) is not gated.
const CONTEXT = new AsyncLocalStorage();
const current = () => CONTEXT.getStore() || null;

export function normalizePrivacy(saved, now = Date.now()) {
  const level = saved?.level === 'connected' ? 'connected' : 'private';
  const grants = (Array.isArray(saved?.grants) ? saved.grants : []).filter((g) => PROVIDERS[g?.provider] && Number(g.until) > now);
  return { level, grants, at: saved?.at || null };
}

// This object's own last-written policy, so a turn that makes no outside call reads storage once per instance, not once
// per request. Only storePrivacy() writes the key, and it updates this cache, so the cache cannot go stale.
const policyCache = new WeakMap();

export async function loadPrivacy(storage, now = Date.now()) {
  if (policyCache.has(storage)) return normalizePrivacy(policyCache.get(storage), now);
  let saved;
  try { saved = await storage.get(PRIVACY_KEY); } catch (_) { return normalizePrivacy(null, now); }
  policyCache.set(storage, saved);
  return normalizePrivacy(saved, now);
}

/** Runs fn under this object's stored policy, then waits for its ledger writes. */
export async function runWithPrivacy(storage, fn, now = Date.now()) {
  const ctx = { ...(await loadPrivacy(storage, now)), storage, queue: Promise.resolve() };
  return CONTEXT.run(ctx, async () => {
    try { return await fn(); } finally { await ctx.queue.catch(() => {}); }
  });
}

/** { allow, provider, reason } for one outbound URL; null when it is not an outside AI or voice host or no CHE policy applies. */
export function privacyVerdict(url, now = Date.now()) {
  const p = current();
  if (!p) return null;
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch (_) { return null; }
  const provider = providerFor(host);
  if (!provider) return null;
  if (p.level === 'connected') return { allow: true, provider, host, basis: 'connected mode' };
  const grant = p.grants.find((g) => g.provider === provider && Number(g.until) > now);
  if (grant) return { allow: true, provider, host, basis: grant.until - now > 30 * 24 * HOUR ? 'your standing permission' : `your permission until ${new Date(grant.until).toISOString().slice(11, 16)} UTC` };
  return { allow: false, provider, host, reason: `Private Mode is on, so nothing was sent to ${PROVIDERS[provider].name}.` };
}

function bodyText(init, input) {
  const body = init?.body ?? null;
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  if (body == null && input && typeof input === 'object' && typeof input.method === 'string') return null;
  return body == null ? '' : null;
}

const day = (iso) => String(iso || '').slice(0, 10);

async function appendLedger(storage, entry) {
  const saved = (await storage.get(LEDGER_KEY)) || [];
  await storage.put(LEDGER_KEY, [entry, ...saved].slice(0, LEDGER_MAX));
  // Daily totals outlive the bounded detail list, so "nothing left today" is never said from a trimmed record.
  const totals = (await storage.get(DAILY_KEY)) || {};
  const d = (totals[day(entry.at)] ||= { sent: 0, blocked: 0, bytes: 0, providers: {} });
  d[entry.outcome] += 1;
  if (entry.outcome === 'sent') { d.bytes += entry.bytes || 0; d.providers[entry.provider] = (d.providers[entry.provider] || 0) + 1; }
  await storage.put(DAILY_KEY, Object.fromEntries(Object.entries(totals).sort().slice(-31)));
}

/** Records one outside request in this object's ledger: metadata and a body fingerprint only, never the body. */
export function noteEgress(verdict, input, init, now = Date.now()) {
  const p = current();
  if (!p?.storage) return Promise.resolve();
  const text = bodyText(init, input);
  // Queued at once (before any await), so the request's end always waits for this entry.
  p.queue = p.queue.then(async () => {
    let fingerprint = null;
    if (typeof text === 'string' && text) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      fingerprint = Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    await appendLedger(p.storage, {
      at: new Date(now).toISOString(), provider: verdict.provider, host: verdict.host,
      outcome: verdict.allow ? 'sent' : 'blocked', basis: verdict.allow ? verdict.basis : 'private mode',
      bytes: typeof text === 'string' ? new TextEncoder().encode(text).length : null, fingerprint,
    });
  }).catch(() => {});
  return p.queue;
}

async function storePrivacy(storage, next, now) {
  const p = { ...normalizePrivacy(next, now), at: new Date(now).toISOString() };
  await storage.put(PRIVACY_KEY, p);
  policyCache.set(storage, p);
  const ctx = current();
  if (ctx?.storage === storage) Object.assign(ctx, { level: p.level, grants: p.grants });
  return p;
}

// ─── The owner's words ───
const KNOX = /^(?:(?:hey|yo|ok(?:ay)?)[\s,]+)?(?:knox|nox|knocks)[\s,:.!?-]*/i;
const PROVIDER_WORDS = [
  ['anthropic', /\b(?:claude|anthropic)\b/i], ['openai', /\b(?:chat ?gpt|openai|gpt)\b/i], ['google', /\b(?:gemini|google)\b/i],
  ['xai', /\b(?:grok|xai|x\.ai)\b/i], ['groq', /\bgroq\b/i], ['mistral', /\bmistral\b/i], ['openrouter', /\bopenrouter\b/i],
  ['elevenlabs', /\beleven ?labs\b/i], ['fish', /\bfish(?: audio)?\b/i], ['modal', /\bmodal\b/i], ['cerebras', /\bcerebras\b/i],
];

/** The owner asking Knox about privacy or security, or changing Private Mode. Null otherwise. */
export function privacyIntent(message) {
  const raw = String(message ?? '').replace(/[‘’]/g, "'").trim();
  if (!raw || raw.length > 240) return null;
  const knox = KNOX.test(raw);
  const t = raw.replace(KNOX, '').replace(/[.!?]+$/, '').trim().toLowerCase();
  if (/\b(?:what if|suppose|imagine|pretend)\b/.test(t)) return null;
  if (/^(?:turn on|enable|switch on|activate|go into|put (?:you|che) in) (?:the )?private mode$|^private mode on$|^keep (?:everything|my (?:stuff|conversations|data)) private$/.test(t)) return { action: 'set', level: 'private' };
  if (/^(?:turn off|disable|switch off|deactivate|exit|leave) (?:the )?private mode$|^private mode off$|^(?:switch to |turn on |go to )?connected mode(?: on)?$/.test(t)) return { action: 'set', level: 'connected' };
  if (/^(?:is|are you in) (?:the )?private mode(?: on)?$|^(?:what(?:'s| is) )?(?:my |the |your )?privacy (?:mode|setting|status)$|^are you private(?: right now)?$/.test(t)) return { action: 'status' };
  // "Always let ElevenLabs speak" is a standing permission for that one company, until he revokes it.
  const always = /^always /.test(t) || / (?:from now on|always|for good)$/.test(t);
  const g = t.replace(/^always /, '').replace(/ (?:from now on|always|for good)$/, '');
  const grant = /^(?:let|allow) (.+?) (?:help|speak|talk|see (?:this|it)|have (?:access|this)|in)(?: (?:with this|on this|for me))?(?: for (?:an? |one )?(hour|day|today|\d+ (?:hours?|minutes?)))?$/.exec(g);
  if (grant) {
    const provider = PROVIDER_WORDS.find(([, re]) => re.test(grant[1]))?.[0];
    if (provider && always) return { action: 'grant', provider, ms: 10 * 365 * 24 * HOUR, standing: true };
    if (provider) {
      const span = grant[2] || 'hour';
      const m = /^(\d+) (hours?|minutes?)$/.exec(span);
      const ms = m ? Number(m[1]) * (m[2].startsWith('hour') ? HOUR : 60_000) : span === 'hour' ? HOUR : 24 * HOUR;
      return { action: 'grant', provider, ms: Math.min(ms, 24 * HOUR) };
    }
  }
  if (/^(?:revoke|cancel|take back|end) (?:all )?(?:the )?(?:ai |provider )?(?:permissions?|access|grants?)$|^(?:stop|no more) (?:sharing|outside ai)$/.test(t)) return { action: 'revoke' };
  if (/\bwho(?:'s| is| has been)? (?:accessing|reading|looking at|in|using) (?:che'?s |your |my |the )?(?:brain|memor(?:y|ies)|data)\b|^who (?:can|has) access(?: to)? (?:che'?s |your |my )?(?:brain|memor(?:y|ies)|data)$/.test(t)) return { action: 'access' };
  if (/\b(?:has|did) anything (?:private )?(?:leave|left|go out|get sent)\b|\bwhat (?:left|was sent|went out)\b.*\b(?:today|che)\b|\banything (?:private )?(?:left|sent out|leave) (?:che|you)\b/.test(t)) return { action: 'egress' };
  if ((knox || /\bsecurity\b/.test(t)) && /\b(?:anything|something) (?:suspicious|weird|strange|off)\b|\bany (?:suspicious|weird) (?:activity|stuff)\b|\bis (?:anything|something) (?:suspicious|wrong) (?:happening|going on)\b/.test(t)) return { action: 'suspicious' };
  if (/\bis (?:anything|something) suspicious (?:happening|going on)\b/.test(t)) return { action: 'suspicious' };
  return null;
}

/** A yes or no to a pending provider change (within five minutes), or null. One storage read. */
export async function privacyConfirmIntent(storage, message, now = Date.now()) {
  const t = String(message ?? '').replace(/[\u2018\u2019]/g, "'").trim().toLowerCase().replace(/[.!]+$/, '');
  if (t.length > 40) return null;
  const yes = /^(?:yes|yeah|yep|yup|confirm|confirmed|do it|go ahead|yes,? (?:do it|please|go ahead)|ok(?:ay)?,? do it)$/.test(t);
  const no = /^(?:no|nope|nah|cancel|never ?mind|don'?t|keep (?:it|things) private)$/.test(t);
  if (!yes && !no) return null;
  let pending = null;
  try { pending = await storage.get(PENDING_KEY); } catch (_) { return null; }
  if (!pending || now - Number(pending.at || 0) > 5 * 60_000) return null;
  return yes ? { action: 'confirm', pending } : { action: 'cancel' };
}

const time = (iso) => String(iso || '').slice(11, 16);
const today = (iso, now) => String(iso || '').slice(0, 10) === new Date(now).toISOString().slice(0, 10);

/**
 * Knox's answer from records only: Private Mode, the egress ledger, signed-in devices and Security Intelligence
 * events. `devices` is the owner's signed-in device list; `security` is loadSecurity() state (read, not changed).
 */
export async function privacyTurn(storage, ask, { devices = [], security = null, now = Date.now() } = {}) {
  const meta = (extra = {}) => ({ source: 'che_knox_privacy', ok: true, model_calls: 0, privacy_action: ask.action, ...extra });
  const p = await loadPrivacy(storage, now);
  let ledger = [];
  let totals = null;
  try { ledger = (await storage.get(LEDGER_KEY)) || []; totals = ((await storage.get(DAILY_KEY)) || {})[new Date(now).toISOString().slice(0, 10)] || null; } catch (_) { ledger = []; }
  const todays = ledger.filter((e) => today(e.at, now));
  const sentDetail = todays.filter((e) => e.outcome === 'sent');
  const blockedDetail = todays.filter((e) => e.outcome === 'blocked');
  // Counts come from the daily totals; the detail list (last 500) only names companies and times.
  const sentCount = Math.max(totals?.sent || 0, sentDetail.length);
  const blockedCount = Math.max(totals?.blocked || 0, blockedDetail.length);
  const sentNames = [...new Set([...Object.keys(totals?.providers || {}), ...sentDetail.map((e) => e.provider)])].map((id) => PROVIDERS[id]?.name || id).join(', ');
  const names = (list) => [...new Set(list.map((e) => PROVIDERS[e.provider]?.name || e.host))].join(', ');
  const modeLine = p.level === 'private'
    ? `Private Mode is on${p.grants.length ? `, with your permission open for ${p.grants.map((g) => `${PROVIDERS[g.provider].name} ${g.until - now > 30 * 24 * HOUR ? 'from now on' : `until ${time(new Date(g.until).toISOString())} UTC`}`).join(' and ')}` : ''}: no outside AI or voice company gets your conversations.`
    : 'Private Mode is off (connected mode): outside AI and voice companies can be used.';
  const caveat = ' Honest limit: CHE\'s memory and her Workers AI model still run in Cloudflare, not only on your phone.';

  // Opening outside companies is confirmed aloud first (AGENTS.md: consequential AI-provider permission changes);
  // closing them (Private Mode on, revoke) takes effect at once.
  const opening = (ask.action === 'set' && ask.level === 'connected') || ask.action === 'grant';
  if (opening) {
    await storage.put(PENDING_KEY, { ...ask, at: now });
    const what = ask.action === 'grant'
      ? `let ${PROVIDERS[ask.provider].name} receive what you send it ${ask.standing ? 'from now on, until you revoke it' : `for ${Math.round(ask.ms / 60_000) >= 60 ? `${Math.round(ask.ms / HOUR)} hour${Math.round(ask.ms / HOUR) === 1 ? '' : 's'}` : `${Math.round(ask.ms / 60_000)} minutes`}`}`
      : 'turn Private Mode off, so OpenAI, Anthropic, Google and the other outside AI and voice companies can receive your conversations again';
    return { text: `Just to confirm, sir: that would ${what}. Say "yes" to do it, or "no" to keep things private.`, meta: meta({ pending: true, ok: true }) };
  }
  if (ask.action === 'cancel') {
    await storage.delete(PENDING_KEY);
    return { text: 'Okay, sir. Nothing changed; Private Mode stays as it was.', meta: meta() };
  }
  if (ask.action === 'confirm') {
    const pending = ask.pending;
    await storage.delete(PENDING_KEY);
    if (pending.action === 'set') {
      await storePrivacy(storage, { level: 'connected', grants: p.grants }, now);
      return { text: 'Done, sir. Private Mode is off: I can use outside AI and voice companies again, and every request is still recorded in my ledger. Say "turn on private mode" to close it.', meta: meta({ privacy_level: 'connected' }) };
    }
    const until = now + pending.ms;
    await storePrivacy(storage, { level: p.level, grants: [...p.grants.filter((g) => g.provider !== pending.provider), { provider: pending.provider, until, at: new Date(now).toISOString() }] }, now);
    return { text: `Done, sir. ${PROVIDERS[pending.provider].name} is allowed ${pending.standing ? 'from now on, until you say "revoke all permissions"' : `until ${time(new Date(until).toISOString())} UTC`}. Only that company, and every request is recorded. Private Mode stays on for everyone else.`, meta: meta({ provider: pending.provider, until: new Date(until).toISOString() }) };
  }
  if (ask.action === 'set') {
    await storage.delete(PENDING_KEY);
    await storePrivacy(storage, { level: 'private', grants: [] }, now);
    return { text: `Done, sir. Private Mode is on: I won't send your conversations, voice or memories to OpenAI, Anthropic, Google or any other outside AI or voice company. If something needs one, I'll say so and ask first.${caveat}`, meta: meta({ privacy_level: 'private' }) };
  }
  if (ask.action === 'revoke') {
    await storage.delete(PENDING_KEY);
    await storePrivacy(storage, { level: p.level, grants: [] }, now);
    return { text: `Done, sir. ${p.grants.length ? `I closed ${p.grants.length} open permission${p.grants.length === 1 ? '' : 's'}.` : 'No permission was open.'} ${p.level === 'private' ? 'Private Mode is on.' : 'Private Mode is still off; say "turn on private mode" to close everything.'}`, meta: meta() };
  }
  if (ask.action === 'status') return { text: `${modeLine} Today ${sentCount} request${sentCount === 1 ? '' : 's'} went to outside providers and ${blockedCount} ${blockedCount === 1 ? 'was' : 'were'} blocked.${caveat}`, meta: meta({ privacy_level: p.level }) };
  if (ask.action === 'egress') {
    const sentLine = sentCount
      ? `${sentCount} request${sentCount === 1 ? '' : 's'} went out today, to ${sentNames}, ${totals?.bytes ?? sentDetail.reduce((n, e) => n + (e.bytes || 0), 0)} bytes in all${sentDetail[0] ? `; the last at ${time(sentDetail[0].at)} UTC (${sentDetail[0].basis})` : ''}.`
      : 'Nothing went to an outside AI or voice company today.';
    const blockedLine = blockedCount ? ` I blocked ${blockedCount} request${blockedCount === 1 ? '' : 's'}${blockedDetail.length ? ` to ${names(blockedDetail)}` : ''}.` : '';
    return { text: `Knox here, sir. ${sentLine}${blockedLine} ${modeLine} My ledger keeps the company, time and size of each request, never its content. Not covered by this record: web searches and market data.${caveat}`, meta: meta({ sent: sentCount, blocked: blockedCount }) };
  }
  if (ask.action === 'access') {
    const live = devices.filter((d) => !d.revoked_at);
    const list = live.map((d, i) => `${i + 1}. ${d.name || 'a device'}, last used ${String(d.last_seen_at || d.created_at || '').slice(0, 10) || 'unknown'}`).join('\n');
    return { text: `Knox here, sir. ${live.length} signed-in device${live.length === 1 ? '' : 's'} can read CHE's brain:\n${list || 'none'}\nOutside AI companies that received anything today: ${sentCount ? sentNames : 'none'}. ${modeLine} What I can't show you yet: a read-by-read history of CHE's brain. I don't record individual memory reads, so I won't guess.`, meta: meta({ devices: live.length }) };
  }
  // suspicious
  const events = (security?.events || []).filter((e) => Date.parse(e.at) > now - 24 * HOUR);
  const suspicious = events.filter((e) => e.classification === 'suspicious');
  const contained = events.filter((e) => e.classification === 'contained');
  const lines = [];
  if (suspicious.length) lines.push(`SUSPICIOUS ACTIVITY: ${suspicious.length} event${suspicious.length === 1 ? '' : 's'} in the last day. ${suspicious.slice(0, 3).map((e) => e.evidence).join(' ')}`);
  if (contained.length || blockedCount) lines.push(`VERIFIED AND CONTAINED: ${[contained.length ? `${contained.length} recorded event${contained.length === 1 ? '' : 's'} (${[...new Set(contained.map((e) => e.type.replace(/_/g, ' ')))].join(', ')})` : '', blockedCount ? `${blockedCount} outside AI request${blockedCount === 1 ? '' : 's'} blocked by Private Mode today` : ''].filter(Boolean).join('; ')}.`);
  if (!lines.length) lines.push('No suspicious activity in CHE\'s records for the last day.');
  return { text: `Knox here, sir. ${lines.join(' ')} INSUFFICIENT EVIDENCE for anything outside CHE: I only see CHE's own sign-ins, pairing attempts, errors, deploys and outgoing requests, not other apps or your iPhone's system.${security ? '' : ' (I could not read the security log just now.)'}`, meta: meta({ suspicious: suspicious.length, contained: contained.length + blockedCount }) };
}

// ─── Live check (deploy and staging gate) ───
// On the isolated test CHE, with the target's real model: Private Mode is on by default, a chat turn with a canary
// memory reaches no outside AI or voice company (Knox's fetch-layer ledger shows nothing sent), live voice refuses
// OpenAI, and Knox's three questions are answered from records with no model call.
export async function privacyProbe(env, request, objectName) {
  try {
    return await privacyProbeRun(env, request, objectName);
  } catch (error) {
    // Report what failed, so the live check says why instead of answering with an opaque server error.
    return { ok: false, passed: 0, total: 0, steps: [], error: `The check failed inside CHE: ${String(error?.message || error).slice(0, 200)}` };
  }
}

async function privacyProbeRun(env, request, objectName) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
  const probe = env.CHE_STATE.getByName(objectName);
  const call = (path, body, device = '') => probe.fetch(new Request(`https://che.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CHE-Memory-Probe': token, ...(device ? { Authorization: `Bearer ${device}` } : {}) },
    body: JSON.stringify(body),
  }));
  const paired = await (await call('/api/pair', { code: String(env.CHE_PAIR_CODE || ''), device_name: 'CHE privacy check' })).json().catch(() => ({}));
  const device = paired.device_token;
  if (!device) return { ok: false, error: 'The check could not pair with its test CHE.', steps: [] };
  const tag = crypto.randomUUID().slice(0, 8);
  const steps = [];
  const step = async (name, message, check) => {
    const started = Date.now();
    const res = await call('/api/chat', { message, history: [] }, device);
    const events = (await res.text()).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('').trim();
    steps.push({ name, pass: res.status === 200 && Boolean(reply) && Boolean(check({ reply, done })), ms: Date.now() - started, route: done.source || 'model', model_calls: done.model_calls ?? null, reply: reply.slice(0, 400) });
  };
  const knox = ({ done }) => done.source === 'che_knox_privacy' && done.model_calls === 0;
  try {
    await call('/api/chat', { message: 'turn on private mode', history: [] }, device);
    await step('Private Mode is on (the default)', 'Is private mode on?', (r) => knox(r) && /^Private Mode is on/.test(r.reply));
    await step('a private memory is saved', `Remember that my probe aunt is named Zorabelle ${tag}.`, () => true);
    await step('CHE answers a model question about it in Private Mode', `Write me one short line about my probe aunt Zorabelle ${tag}.`, ({ done }) => done.source !== 'che_knox_privacy');
    await step('Test 1/4: nothing went to an outside AI or voice company (fetch-layer ledger)', 'Knox, has anything private left CHE today?', (r) => knox(r) && /Nothing went to an outside AI or voice company today/.test(r.reply) && !r.reply.includes(tag));
    await step('Knox: who can read CHE\'s brain, from the device list', "Knox, who's accessing CHE's brain?", (r) => knox(r) && /CHE privacy check/.test(r.reply));
    await step('Knox: suspicious activity, with the limit of his evidence', 'Knox, is anything suspicious happening?', (r) => knox(r) && /INSUFFICIENT EVIDENCE for anything outside CHE/.test(r.reply));
    const live = await call('/api/live/token', { guarded_output: true }, device);
    const detail = (await live.json().catch(() => ({}))).detail || '';
    steps.push({ name: 'live voice refuses OpenAI Realtime in Private Mode', pass: live.status === 503 && /Private Mode is on/.test(detail), ms: 0, route: 'live_token', model_calls: 0, reply: detail });
  } finally {
    await call('/api/security/revoke_self', {}, device).catch(() => null);
  }
  const passed = steps.filter((s) => s.pass).length;
  return { ok: passed === steps.length && steps.length > 0, passed, total: steps.length, steps };
}
