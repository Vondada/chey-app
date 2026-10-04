// CHE Resilience layer: keys, health watch, AI Mailbox letters, answer cache,
// lockdown, and the Tech Free/Paid folders + scout. Free-only, voice-first.
//
// Security: everything here treats provider replies, scraped lists and mail
// as DATA. Keys never leave the Worker (stored in the Durable Object, never
// returned to the phone, never logged, never spoken beyond the last 4).

// ─── Provider catalog: official pages only ───────────────────────────────
export const KEY_PROVIDERS = {
  groq: { name: 'Groq', env: 'GROQ_API_KEY', page: 'https://console.groq.com/keys', test: 'https://api.groq.com/openai/v1/models', accounts: 'one account per person' },
  gemini: { name: 'Google AI Studio (Gemini)', env: 'GEMINI_API_KEY', page: 'https://aistudio.google.com/apikey', test: 'https://generativelanguage.googleapis.com/v1beta/openai/models', accounts: 'uses your Google account' },
  cerebras: { name: 'Cerebras', env: 'CEREBRAS_API_KEY', page: 'https://cloud.cerebras.ai', test: 'https://api.cerebras.ai/v1/models', accounts: 'one account per person' },
  mistral: { name: 'Mistral', env: 'MISTRAL_API_KEY', page: 'https://console.mistral.ai/api-keys', test: 'https://api.mistral.ai/v1/models', accounts: 'one account per person' },
  openrouter: { name: 'OpenRouter', env: 'OPENROUTER_API_KEY', page: 'https://openrouter.ai/keys', test: 'https://openrouter.ai/api/v1/key', accounts: 'one account per person' },
  github: { name: 'GitHub Models', env: 'GITHUB_MODELS_TOKEN', page: 'https://github.com/settings/personal-access-tokens/new', test: 'https://models.github.ai/catalog/models', accounts: 'uses your GitHub account' },
  sambanova: { name: 'SambaNova', env: 'SAMBANOVA_API_KEY', page: 'https://cloud.sambanova.ai/apis', test: 'https://api.sambanova.ai/v1/models', accounts: 'one account per person' },
  openai: { name: 'OpenAI (Codex)', env: 'CHE_OPENAI_API_KEY', page: 'https://platform.openai.com/api-keys', test: 'https://api.openai.com/v1/models', accounts: 'uses your OpenAI account (paid, separate from a ChatGPT subscription)' },
  xai: { name: 'xAI (Grok)', env: 'XAI_API_KEY', page: 'https://console.x.ai', test: 'https://api.x.ai/v1/models', accounts: 'uses your X/xAI account' },
  huggingface: { name: 'Hugging Face', env: 'HF_TOKEN', page: 'https://huggingface.co/settings/tokens', test: 'https://huggingface.co/api/whoami-v2', accounts: 'one account per person' },
};

const STORED_KEYS = 'provider_keys';
const HEALTH = 'key_health';
const LETTERS = 'ai_letters';
const CACHE = 'answer_cache';
const LOCKDOWN = 'lockdown';
const TECH = 'tech_items';

const get = async (s, k, d) => { try { const v = await s?.get?.(k); return v ?? d; } catch (_) { return d; } };
const put = async (s, k, v) => { try { await s?.put?.(k, v); } catch (_) {} };
const last4 = (key) => String(key || '').slice(-4);

export function providerByName(text) {
  const t = String(text || '').toLowerCase();
  if (/\bgroq\b/.test(t)) return 'groq';
  if (/\bgemini|ai studio|google\b/.test(t)) return 'gemini';
  if (/\bcerebras\b/.test(t)) return 'cerebras';
  if (/\bmistral\b/.test(t)) return 'mistral';
  if (/\bopen ?router\b/.test(t)) return 'openrouter';
  if (/\bgithub\b/.test(t)) return 'github';
  if (/\bsamba ?nova\b/.test(t)) return 'sambanova';
  if (/\bhugging ?face\b/.test(t)) return 'huggingface';
  if (/\b(?:codex|openai|open ai|chat ?gpt)\b/.test(t)) return 'openai';
  if (/\b(?:grok|x\.?ai)\b/.test(t)) return 'xai';
  return null;
}

// Keys the owner added through CHE (Durable Object), layered over Worker secrets.
export async function storedKeys(storage) {
  const keys = await get(storage, STORED_KEYS, {});
  return keys && typeof keys === 'object' ? keys : {};
}

export function withStoredKeys(env, keys) {
  if (!keys || !Object.keys(keys).length) return env;
  const merged = Object.create(env);
  for (const [name, value] of Object.entries(keys)) {
    if (!env[name] && typeof value === 'string' && value) merged[name] = value;
  }
  return merged;
}

// Minimal authenticated request (model list / whoami): proves the key works
// without spending inference allowance.
export async function testKey(provider, key, fetcher = fetch) {
  const p = KEY_PROVIDERS[provider];
  if (!p || !key) return { status: 'missing' };
  const started = Date.now();
  try {
    const response = await fetcher(p.test, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const ms = Date.now() - started;
    if (response.ok) return { status: 'healthy', latency_ms: ms };
    if (response.status === 401 || response.status === 403) return { status: 'unauthorized', code: response.status };
    if (response.status === 429) return { status: 'rate-limited', code: 429 };
    return { status: 'unknown', code: response.status };
  } catch (error) {
    return { status: 'network', error: String(error?.message || error).slice(0, 80) };
  }
}

export async function saveKey(storage, provider, key, fetcher = fetch) {
  const p = KEY_PROVIDERS[provider];
  const clean = String(key || '').trim();
  if (!p) return { ok: false, detail: 'Unknown provider.' };
  if (clean.length < 12 || /\s/.test(clean)) return { ok: false, detail: 'That does not look like an API key.' };
  const test = await testKey(provider, clean, fetcher);
  if (test.status !== 'healthy' && test.status !== 'rate-limited') {
    await fileLetter(storage, { tray: provider, subject: `${p.name} key did not work`, body: `The key ending ${last4(clean)} failed its test (${test.status}${test.code ? ` ${test.code}` : ''}). I did not save it.`, tag: 'system', severity: 'action' });
    return { ok: false, detail: `${p.name} rejected that key (${test.status}). I did not save it.`, test };
  }
  const keys = await storedKeys(storage);
  keys[p.env] = clean;
  await put(storage, STORED_KEYS, keys);
  const health = await get(storage, HEALTH, {});
  health[provider] = { status: test.status, at: Date.now(), latency_ms: test.latency_ms || null, last4: last4(clean) };
  await put(storage, HEALTH, health);
  await fileLetter(storage, { tray: provider, subject: `${p.name} key saved and tested`, body: `Key ending ${last4(clean)} works (${test.status}${test.latency_ms ? `, ${test.latency_ms} ms` : ''}). It's now in my engine rotation.`, tag: 'free', severity: 'info' });
  return { ok: true, provider, last4: last4(clean), test };
}

// Removes a stored key; the engine rotation stops using it on the next
// request. Keys set as Worker secrets are not touched here.
export async function removeKey(storage, provider) {
  const p = KEY_PROVIDERS[provider];
  if (!p) return { ok: false, detail: 'Unknown provider.' };
  const keys = await storedKeys(storage);
  const had = Boolean(keys[p.env]);
  delete keys[p.env];
  await put(storage, STORED_KEYS, keys);
  const health = await get(storage, HEALTH, {});
  delete health[provider];
  await put(storage, HEALTH, health);
  return { ok: true, provider, removed: had };
}

export async function checkAllKeys(env, storage, fetcher = fetch) {
  const keys = await storedKeys(storage);
  const before = await get(storage, HEALTH, {});
  const health = {};
  for (const [id, p] of Object.entries(KEY_PROVIDERS)) {
    const key = env?.[p.env] || keys[p.env];
    if (!key) continue;
    const test = await testKey(id, key, fetcher);
    health[id] = { status: test.status, code: test.code || null, at: Date.now(), latency_ms: test.latency_ms || null, last4: last4(key) };
    const was = before[id]?.status;
    if (test.status === 'unauthorized' && was !== 'unauthorized') {
      await fileLetter(storage, { tray: id, subject: `${p.name} key died`, body: `The key ending ${last4(key)} is being refused (${test.code}). Say "set up ${p.name} key" and I'll walk you through replacing it.`, tag: 'system', severity: 'action' });
    } else if (test.status === 'healthy' && was && was !== 'healthy') {
      await fileLetter(storage, { tray: id, subject: `${p.name} key is working again`, body: `Key ending ${last4(key)} passed its test.`, tag: 'system', severity: 'info' });
    }
  }
  await put(storage, HEALTH, { ...health, checked_at: Date.now() });
  return health;
}

export function speakKeyHealth(health) {
  const rows = Object.entries(health || {}).filter(([k]) => KEY_PROVIDERS[k]);
  if (!rows.length) return 'I have no keys to check yet, sir.';
  const say = { healthy: 'working', 'rate-limited': 'resting (rate limited, not dead)', unauthorized: 'DEAD, it needs replacing', network: 'unreachable right now', unknown: 'unclear' };
  const missing = Object.keys(KEY_PROVIDERS).filter((k) => !health[k]).map((k) => KEY_PROVIDERS[k].name);
  return `Keys, sir:\n${rows.map(([k, h], i) => `${i + 1}. ${KEY_PROVIDERS[k].name}: ${say[h.status] || h.status}${h.last4 ? ` (ending ${h.last4})` : ''}`).join('\n')}${missing.length ? `\nNot set up yet: ${missing.join(', ')}. Say "set up" and the name to add one.` : ''}`;
}

export function setupSteps(provider) {
  const p = KEY_PROVIDERS[provider];
  if (!p) return '';
  return [
    `Setting up ${p.name}, sir. It's free, no card needed, and it's ${p.accounts}, so I'll use your real name; no extra accounts.`,
    `1. Open ${p.page} and sign in or sign up.`,
    '2. I will stop for anything only you can do: the captcha, email or phone codes, and accepting their terms. That is plain-language info, not legal advice.',
    '3. Create a key and copy it.',
    `4. Open More, then "Keys & Mailbox", choose ${p.name}, and paste it. Please don't paste keys into chat, so they never land in the conversation.`,
    '5. I test it right away and tell you if it works.',
  ].join('\n');
}

// ─── AI Mailbox letters ──────────────────────────────────────────────────
export async function fileLetter(storage, { tray = 'che-system', subject, body = '', tag = 'system', severity = 'info' }) {
  const list = await get(storage, LETTERS, []);
  const letters = Array.isArray(list) ? list : [];
  const dup = letters.find((l) => !l.read && l.subject === subject && l.tray === tray);
  if (dup) return dup;
  const letter = { id: crypto.randomUUID(), at: new Date().toISOString(), tray, subject: String(subject).slice(0, 160), body: String(body).slice(0, 1200), tag, severity, read: false };
  letters.push(letter);
  await put(storage, LETTERS, letters.slice(-300));
  return letter;
}

export async function listLetters(storage) {
  const list = await get(storage, LETTERS, []);
  return Array.isArray(list) ? list : [];
}

export async function markLetter(storage, id, changes) {
  const letters = await listLetters(storage);
  const i = letters.findIndex((l) => l.id === id);
  if (i < 0) return null;
  if (changes.delete) letters.splice(i, 1);
  else letters[i] = { ...letters[i], ...changes };
  await put(storage, LETTERS, letters);
  return true;
}

export async function nextLetter(storage, { securityFirst = false } = {}) {
  const unread = (await listLetters(storage)).filter((l) => !l.read);
  if (!unread.length) return null;
  const rank = (l) => (l.severity === 'danger' ? 0 : l.severity === 'action' ? 1 : 2);
  const pool = securityFirst ? unread.filter((l) => l.tag === 'security' || l.severity === 'danger') : [];
  const pick = (pool.length ? pool : unread).sort((a, b) => rank(a) - rank(b) || Date.parse(b.at) - Date.parse(a.at))[0];
  await markLetter(storage, pick.id, { read: true });
  return pick;
}

export function speakMailboxSummary(letters) {
  const unread = letters.filter((l) => !l.read);
  if (!unread.length) return 'Your mailbox is empty, sir. No new letters.';
  const danger = unread.filter((l) => l.severity === 'danger').length;
  const trays = [...new Set(unread.map((l) => l.tray))];
  return `${unread.length} unread letter${unread.length === 1 ? '' : 's'}${danger ? `, ${danger} marked danger` : ''}, from ${trays.join(', ')}. Say "read the next letter".`;
}

// ─── Answer cache: repeated general questions cost no allowance ──────────
const PERSONAL_OR_LIVE = /\b(?:i|me|my|mine|our|we|you|your|today|tonight|tomorrow|yesterday|now|current|latest|news|weather|price|stock|score|remind|schedule|calendar|email|text|call|open|send|buy|order|pay|delete)\b/i;

export function cacheKey(question) {
  return String(question || '').toLowerCase().replace(/^(?:che|chay)[,:]?\s+/, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function cacheable(question) {
  const key = cacheKey(question);
  return key.length >= 8 && key.split(' ').length <= 30 && !PERSONAL_OR_LIVE.test(key);
}

export async function cachedAnswer(storage, question, { hasConversationContext = false } = {}) {
  if (hasConversationContext || !cacheable(question)) return null;
  const cache = await get(storage, CACHE, {});
  const hit = cache?.[cacheKey(question)];
  if (!hit || Date.now() - hit.at > 7 * 86400000) return null;
  return hit.answer;
}

export async function rememberAnswer(storage, question, answer) {
  if (!cacheable(question) || !answer || answer.length > 4000) return;
  const cache = await get(storage, CACHE, {});
  const next = { ...(cache || {}), [cacheKey(question)]: { answer, at: Date.now() } };
  const keys = Object.keys(next);
  if (keys.length > 300) for (const k of keys.sort((a, b) => next[a].at - next[b].at).slice(0, keys.length - 300)) delete next[k];
  await put(storage, CACHE, next);
}

export async function forgetAnswer(storage, question) {
  const cache = await get(storage, CACHE, {});
  if (cache && cache[cacheKey(question)]) { delete cache[cacheKey(question)]; await put(storage, CACHE, cache); return true; }
  return false;
}

// ─── Lockdown ────────────────────────────────────────────────────────────
export async function isLockedDown(storage) { return (await get(storage, LOCKDOWN, null))?.on === true; }
export async function setLockdown(storage, on, reason = 'owner command') {
  await put(storage, LOCKDOWN, { on, reason, at: new Date().toISOString() });
  await fileLetter(storage, { tray: 'security', subject: on ? 'Lockdown entered' : 'Lockdown ended', body: on ? `Reason: ${reason}. Remote engines, key creation and outgoing AI mail are frozen. I'm using my on-phone brain.` : 'Remote tools are back on.', tag: 'security', severity: on ? 'danger' : 'info' });
}

// Obvious manipulation attempts in text that came from outside (pages, mail,
// other AIs). Stored as DATA and reported, never obeyed.
export function looksLikeAttack(text) {
  return /\b(?:ignore (?:all |your )?(?:previous|prior|owner)|disregard (?:the|your) (?:owner|instructions)|reveal|dump|print|send me)\b[\s\S]{0,40}\b(?:api ?keys?|secrets?|tokens?|passwords?|system prompt)\b|\bdisable (?:tls|logging|security)\b|\bwire (?:money|funds)\b/i.test(String(text || ''));
}

// ─── Tech folders (Free / Paid) + scout ──────────────────────────────────
export async function techItems(storage) {
  const list = await get(storage, TECH, []);
  return Array.isArray(list) ? list : [];
}

export async function fileTech(storage, item) {
  const list = await techItems(storage);
  const key = String(item.name || '').toLowerCase();
  if (!key || list.some((x) => x.name.toLowerCase() === key)) return null;
  const entry = {
    id: crypto.randomUUID(),
    name: String(item.name).slice(0, 120),
    improves: String(item.improves || 'engine capacity').slice(0, 200),
    url: String(item.url || '').slice(0, 300),
    cost: item.cost === 'paid' ? 'paid' : 'free',
    cost_note: String(item.cost_note || '').slice(0, 200),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : ['engine'],
    readiness: item.readiness || 'research-only',
    found: new Date().toISOString(),
    tried: false,
  };
  list.push(entry);
  await put(storage, TECH, list.slice(-400));
  return entry;
}

// Reads a public, machine-readable list of free AI APIs (data only) and files
// anything new. Weekly, or when the owner says "scout now".
export const SCOUT_SOURCES = [
  'https://raw.githubusercontent.com/ClawLabsAI/free-ai-models/main/data/models.json',
];

export async function runScout(storage, fetcher = fetch) {
  const found = [];
  for (const url of SCOUT_SOURCES) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) continue;
      const data = await response.json();
      const rows = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];
      for (const row of rows.slice(0, 400)) {
        const provider = String(row?.provider || row?.provider_name || row?.source || '').trim();
        if (!provider) continue;
        const text = JSON.stringify(row).toLowerCase();
        const paid = /"(?:free|is_free)":\s*false|paid|credit card required/.test(text) && !/"(?:free|is_free)":\s*true/.test(text);
        const item = await fileTech(storage, {
          name: provider,
          improves: 'more free AI engine capacity',
          url: String(row?.url || row?.signup_url || row?.website || ''),
          cost: paid ? 'paid' : 'free',
          cost_note: paid ? 'costs money or needs a card' : 'listed as free',
          tags: ['engine'],
          readiness: KEY_PROVIDERS[providerByName(provider)] ? 'ready-to-try' : 'research-only',
        });
        if (item) found.push(item);
      }
    } catch (_) { /* list unreachable: report below */ }
  }
  await put(storage, 'scout_at', Date.now());
  const free = found.filter((f) => f.cost === 'free');
  const paid = found.filter((f) => f.cost === 'paid');
  if (found.length) {
    await fileLetter(storage, { tray: 'tech-scout', subject: `Scout: ${free.length} free, ${paid.length} paid new finds`, body: `${free.slice(0, 5).map((f) => f.name).join(', ') || 'no new free ones'}${paid.length ? `. Paid (filed, never bought): ${paid.slice(0, 5).map((f) => f.name).join(', ')}` : ''}.`, tag: 'free', severity: 'info' });
  }
  return { free, paid };
}

export function speakTech(items, cost) {
  const list = items.filter((i) => i.cost === cost);
  if (!list.length) return `Nothing in ${cost} tech yet, sir.${cost === 'free' ? ' Say "scout now" and I\'ll look.' : ''}`;
  return `${cost === 'free' ? 'Free' : 'Paid'} tech, ${list.length} item${list.length === 1 ? '' : 's'}:\n${list.slice(-8).reverse().map((i, n) => `${n + 1}. ${i.name}: ${i.improves} (${i.readiness}${i.cost === 'paid' ? ', costs money' : ''})`).join('\n')}`;
}

// ─── Voice commands ──────────────────────────────────────────────────────
export function resilienceIntent(message) {
  const t = String(message || '').toLowerCase().replace(/^(?:che|chay)[,:]?\s+/, '').replace(/[.!?]+$/, '').trim();
  if (t.length > 120) return null;
  if (/^(?:lock ?down|lock it down|lockdown mode)$/.test(t)) return { kind: 'lockdown' };
  if (/^(?:end|exit|stop|lift|cancel) (?:the )?lock ?down$|^unlock (?:everything|che)$/.test(t)) return { kind: 'unlock' };
  if (/\bhow are (?:the|my) keys\b|\bkey (?:health|status)\b|\bcheck (?:the|my) keys\b/.test(t)) return { kind: 'keys' };
  const setup = /\b(?:set ?up|add|replace|new|fix)\b.*\bkey\b/.test(t) ? providerByName(t) : null;
  if (setup) return { kind: 'setup', provider: setup };
  if (/\bread (?:the )?security first\b/.test(t)) return { kind: 'next-letter', securityFirst: true };
  if (/\bread (?:the )?next letter\b|\bnext letter\b/.test(t)) return { kind: 'next-letter' };
  if (/\b(?:open (?:the )?mailbox|what'?s in (?:the |my )?mailbox|any letters)\b/.test(t)) return { kind: 'mailbox' };
  if (/\bwhat'?s in (?:the )?free tech\b|\bfree tech\b/.test(t)) return { kind: 'tech', cost: 'free' };
  if (/\bwhat'?s in (?:the )?paid tech\b|\bpaid tech\b/.test(t)) return { kind: 'tech', cost: 'paid' };
  if (/^scout now$|\bscout (?:for )?(?:new )?(?:engines|tech)\b/.test(t)) return { kind: 'scout' };
  if (/\bare we offline\b|\bwhat engines are left\b|\bengines left today\b/.test(t)) return { kind: 'engines' };
  if (/^(?:don'?t|do not) cache (?:this|that)$|^forget that answer$/.test(t)) return { kind: 'uncache' };
  if (/^use (?:your|che'?s) email$/.test(t)) return { kind: 'identity', value: 'che' };
  if (/^use my email$/.test(t)) return { kind: 'identity', value: 'owner' };
  return null;
}
