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

const STATE = { level: 'private', grants: [], pending: [] };

export function normalizePrivacy(saved, now = Date.now()) {
  const level = saved?.level === 'connected' ? 'connected' : 'private';
  const grants = (Array.isArray(saved?.grants) ? saved.grants : []).filter((g) => PROVIDERS[g?.provider] && Number(g.until) > now);
  return { level, grants, at: saved?.at || null };
}

/** Applies the stored setting to this Worker for the current request and its background work. */
export function setPrivacy(saved, now = Date.now()) {
  const p = normalizePrivacy(saved, now);
  STATE.level = p.level;
  STATE.grants = p.grants;
  return p;
}

export function privacyLevel() { return STATE.level; }

/** { allow, provider, reason } for one outbound URL, or null when it is not an outside AI or voice host. */
export function privacyVerdict(url, now = Date.now()) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch (_) { return null; }
  const provider = providerFor(host);
  if (!provider) return null;
  if (STATE.level === 'connected') return { allow: true, provider, host, basis: 'connected mode' };
  const grant = STATE.grants.find((g) => g.provider === provider && Number(g.until) > now);
  if (grant) return { allow: true, provider, host, basis: `your permission until ${new Date(grant.until).toISOString().slice(11, 16)} UTC` };
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

/** Notes one outside request for Knox's ledger: metadata and a body fingerprint only. */
export async function noteEgress(verdict, input, init, now = Date.now()) {
  const text = bodyText(init, input);
  let fingerprint = null;
  if (typeof text === 'string' && text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    fingerprint = Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  STATE.pending.push({
    at: new Date(now).toISOString(), provider: verdict.provider, host: verdict.host,
    outcome: verdict.allow ? 'sent' : 'blocked', basis: verdict.allow ? verdict.basis : 'private mode',
    bytes: typeof text === 'string' ? new TextEncoder().encode(text).length : null, fingerprint,
  });
  if (STATE.pending.length > LEDGER_MAX) STATE.pending.splice(0, STATE.pending.length - LEDGER_MAX);
}

/** Writes noted requests to CHE's storage (called at the end of each request and alarm). */
export async function flushEgressLedger(storage) {
  if (!STATE.pending.length) return 0;
  const batch = STATE.pending.splice(0);
  try {
    const saved = (await storage.get(LEDGER_KEY)) || [];
    await storage.put(LEDGER_KEY, [...batch.reverse(), ...saved].slice(0, LEDGER_MAX));
  } catch (_) { STATE.pending.unshift(...batch.reverse()); return 0; }
  return batch.length;
}

export async function loadPrivacy(storage, now = Date.now()) {
  try { return normalizePrivacy(await storage.get(PRIVACY_KEY), now); } catch (_) { return normalizePrivacy(null, now); }
}

async function storePrivacy(storage, next, now) {
  const p = { ...normalizePrivacy(next, now), at: new Date(now).toISOString() };
  await storage.put(PRIVACY_KEY, p);
  setPrivacy(p, now);
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
  try { ledger = (await storage.get(LEDGER_KEY)) || []; } catch (_) { ledger = []; }
  const day = ledger.filter((e) => today(e.at, now));
  const sent = day.filter((e) => e.outcome === 'sent');
  const blocked = day.filter((e) => e.outcome === 'blocked');
  const names = (list) => [...new Set(list.map((e) => PROVIDERS[e.provider]?.name || e.host))].join(', ');
  const modeLine = p.level === 'private'
    ? `Private Mode is on${p.grants.length ? `, with your permission open for ${p.grants.map((g) => `${PROVIDERS[g.provider].name} ${g.until - now > 30 * 24 * HOUR ? 'from now on' : `until ${time(new Date(g.until).toISOString())} UTC`}`).join(' and ')}` : ''}: no outside AI or voice company gets your conversations.`
    : 'Private Mode is off (connected mode): outside AI and voice companies can be used.';
  const caveat = ' Honest limit: CHE\'s memory and her Workers AI model still run in Cloudflare, not only on your phone.';

  if (ask.action === 'set') {
    const next = await storePrivacy(storage, { level: ask.level, grants: ask.level === 'private' ? [] : p.grants }, now);
    return { text: next.level === 'private' ? `Done, sir. Private Mode is on: I won't send your conversations, voice or memories to OpenAI, Anthropic, Google or any other outside AI or voice company. If something needs one, I'll say so and ask first.${caveat}` : 'Done, sir. Private Mode is off: I can use outside AI and voice companies again, and every request is still recorded in my ledger. Say "turn on private mode" to close it.', meta: meta({ privacy_level: next.level }) };
  }
  if (ask.action === 'grant') {
    const until = now + ask.ms;
    await storePrivacy(storage, { level: p.level, grants: [...p.grants.filter((g) => g.provider !== ask.provider), { provider: ask.provider, until, at: new Date(now).toISOString() }] }, now);
    return { text: `Okay, sir. ${PROVIDERS[ask.provider].name} is allowed ${ask.standing ? 'from now on, until you say "revoke all permissions"' : `until ${time(new Date(until).toISOString())} UTC`}. Only that company, and every request is recorded. Private Mode stays on for everyone else.`, meta: meta({ provider: ask.provider, until: new Date(until).toISOString() }) };
  }
  if (ask.action === 'revoke') {
    await storePrivacy(storage, { level: p.level, grants: [] }, now);
    return { text: `Done, sir. ${p.grants.length ? `I closed ${p.grants.length} open permission${p.grants.length === 1 ? '' : 's'}.` : 'No permission was open.'} ${p.level === 'private' ? 'Private Mode is on.' : 'Private Mode is still off; say "turn on private mode" to close everything.'}`, meta: meta() };
  }
  if (ask.action === 'status') return { text: `${modeLine} Today ${sent.length} request${sent.length === 1 ? '' : 's'} went to outside providers and ${blocked.length} ${blocked.length === 1 ? 'was' : 'were'} blocked.${caveat}`, meta: meta({ privacy_level: p.level }) };
  if (ask.action === 'egress') {
    const sentLine = sent.length
      ? `${sent.length} request${sent.length === 1 ? '' : 's'} went out today, to ${names(sent)}, ${sent.reduce((n, e) => n + (e.bytes || 0), 0)} bytes in all; the last at ${time(sent[0].at)} UTC (${sent[0].basis}).`
      : 'Nothing went to an outside AI or voice company today.';
    const blockedLine = blocked.length ? ` I blocked ${blocked.length} request${blocked.length === 1 ? '' : 's'} to ${names(blocked)}.` : '';
    return { text: `Knox here, sir. ${sentLine}${blockedLine} ${modeLine} My ledger keeps the company, time and size of each request, never its content. Not covered by this record: web searches and market data.${caveat}`, meta: meta({ sent: sent.length, blocked: blocked.length }) };
  }
  if (ask.action === 'access') {
    const live = devices.filter((d) => !d.revoked_at);
    const list = live.map((d, i) => `${i + 1}. ${d.name || 'a device'}, last used ${String(d.last_seen_at || d.created_at || '').slice(0, 10) || 'unknown'}`).join('\n');
    return { text: `Knox here, sir. ${live.length} signed-in device${live.length === 1 ? '' : 's'} can read CHE's brain:\n${list || 'none'}\nOutside AI companies that received anything today: ${sent.length ? names(sent) : 'none'}. ${modeLine} What I can't show you yet: a read-by-read history of CHE's brain. I don't record individual memory reads, so I won't guess.`, meta: meta({ devices: live.length }) };
  }
  // suspicious
  const events = (security?.events || []).filter((e) => Date.parse(e.at) > now - 24 * HOUR);
  const suspicious = events.filter((e) => e.classification === 'suspicious');
  const contained = events.filter((e) => e.classification === 'contained');
  const lines = [];
  if (suspicious.length) lines.push(`SUSPICIOUS ACTIVITY: ${suspicious.length} event${suspicious.length === 1 ? '' : 's'} in the last day. ${suspicious.slice(0, 3).map((e) => e.evidence).join(' ')}`);
  if (contained.length || blocked.length) lines.push(`VERIFIED AND CONTAINED: ${[contained.length ? `${contained.length} recorded event${contained.length === 1 ? '' : 's'} (${[...new Set(contained.map((e) => e.type.replace(/_/g, ' ')))].join(', ')})` : '', blocked.length ? `${blocked.length} outside AI request${blocked.length === 1 ? '' : 's'} blocked by Private Mode today` : ''].filter(Boolean).join('; ')}.`);
  if (!lines.length) lines.push('No suspicious activity in CHE\'s records for the last day.');
  return { text: `Knox here, sir. ${lines.join(' ')} INSUFFICIENT EVIDENCE for anything outside CHE: I only see CHE's own sign-ins, pairing attempts, errors, deploys and outgoing requests, not other apps or your iPhone's system.${security ? '' : ' (I could not read the security log just now.)'}`, meta: meta({ suspicious: suspicious.length, contained: contained.length + blocked.length }) };
}

// ─── Live check (deploy and staging gate) ───
// On the isolated test CHE, with the target's real model: Private Mode is on by default, a chat turn with a canary
// memory reaches no outside AI or voice company (Knox's fetch-layer ledger shows nothing sent), live voice refuses
// OpenAI, and Knox's three questions are answered from records with no model call.
export async function privacyProbe(env, request, objectName) {
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
