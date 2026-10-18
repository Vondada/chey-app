// CHE's Fish Audio voice. Fish speaks first when the owner has set it up; the
// existing voices stay as the fallback, so a Fish outage never silences CHE.
//
// Cost rules:
// - Only the final text meant to be heard is sent. No history, no reasoning.
// - Everyday speech uses the free developer model. The expressive model (used
//   for stories and YouTube narration) is never chosen for ordinary replies,
//   and it has a daily character cap.
// - Finished audio is cached in Durable Object storage, and an identical
//   request already in flight is shared, so the same words are paid for once.
// - A slow Fish is measured and rested, so latency never grows unnoticed.
//
// The API key never leaves this module: it is not logged, returned or cached.

import { encodeMsgpack } from './msgpack_encode.js';

const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
export const FISH_DEFAULT_MODEL = 's2.1-pro-free';
export const FISH_DEFAULT_EXPRESSIVE_MODEL = 'drama-3';

// Settings the Worker hands the Durable Object on each voice request, so a
// secret set after the object started is seen at once (see withMarySecrets).
export const FISH_SECRET_NAMES = [
  'FISH_API_KEY',
  'CHE_FISH_VOICE_ID',
  'CHE_FISH_PREFERRED',
  'CHE_FISH_MODEL',
  'CHE_FISH_EXPRESSIVE_MODEL',
  'CHE_FISH_SPEED',
  'CHE_FISH_CHARACTER_VOICES',
  'CHE_FISH_MAX_RTF',
  'CHE_FISH_EXPRESSIVE_DAILY_CHARS',
];

const enabled = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
const VOICE_ID = /^[A-Za-z0-9_-]{8,80}$/;
const MODEL_NAME = /^[A-Za-z0-9._-]{1,40}$/;
const EXPRESSIVE_PURPOSES = new Set(['story', 'narration', 'expressive']);

// One conversational clip. The phone splits Read This into 640-character
// parts, so every part fits.
const MAX_CONVERSATION_CHARS = 800;
const MAX_EXPRESSIVE_CHARS = 6000;
const EXPRESSIVE_TIMEOUT_MS = 60000;
// Fish's measured speed on the owner's account (deploy 38501693260): about
// 0.6 s plus 33 ms per character, i.e. 0.57 s of work per second of audio.
// So the wait grows with the clip; a fixed 7 s cut off ordinary 240-character
// reply chunks. The phone waits a little longer than this (cheVoiceWait).
const conversationTimeoutMs = (chars) => Math.min(25000, Math.max(7000, 4000 + 40 * chars));
// Slower than this many seconds of work per second of audio is too slow to
// keep ahead of playback.
const DEFAULT_MAX_RTF = 1.0;
const DEFAULT_EXPRESSIVE_DAILY_CHARS = 20000;

const PAUSE_RATE_LIMIT_MS = 30 * 1000;
const PAUSE_SERVER_MS = 60 * 1000;
const PAUSE_TIMEOUT_MS = 2 * 60 * 1000;
const PAUSE_SLOW_MS = 10 * 60 * 1000;
const PAUSE_LONG_MS = 10 * 60 * 1000;
const REFUSED_TEXT_MS = 60 * 1000;
const LATENCY_WINDOW = 5;

// Storage for finished audio. Values stay well under Durable Object storage's
// 2 MB value limit; a long narration is split into parts.
const CACHE_PREFIX = 'fish_tts:';
const CACHE_INDEX_KEY = 'fish_tts_index';
const CACHE_PART_BYTES = 1_000_000;
const CACHE_MAX_ENTRIES = 80;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;
const USAGE_KEY = 'fish_tts_usage';

// In-memory state for this isolate. It holds status words, times and numbers,
// never the key or the provider's error text.
const state = {
  pausedUntil: new Map(), // model ('*' = every model) → epoch ms
  pauseWhy: new Map(), // model → the status word that rested it
  lastOutcome: null, // { status, code, model, at }
  latencies: [], // recent conversational latencies (ms), cache misses only
  rtfs: [], // recent seconds of work per second of audio, cache misses only
  refused: new Map(), // cache key → epoch ms, for text Fish refused
  refusals: new Map(), // model → { count, at, key }: refusals of different words in a row
  inflight: new Map(), // cache key → Promise<{ bytes, type } | null>
  // Expressive characters used or reserved today, per model. See reserveExpressive.
  ledger: { date: '', chars: new Map(), seeded: new Set() },
};

export function resetFishAudioState() {
  state.pausedUntil.clear();
  state.pauseWhy.clear();
  state.lastOutcome = null;
  state.latencies = [];
  state.rtfs = [];
  state.refused.clear();
  state.refusals.clear();
  state.inflight.clear();
  state.ledger = { date: '', chars: new Map(), seeded: new Set() };
}

export function fishSecretsFrom(env = {}) {
  const out = {};
  for (const name of FISH_SECRET_NAMES) {
    out[name] = env[name] === undefined || env[name] === null ? '' : String(env[name]);
  }
  return out;
}

const keyOf = (env) => String(env.FISH_API_KEY || '').trim();
const voiceOf = (env) => String(env.CHE_FISH_VOICE_ID || '').trim();

export function fishModels(env = {}) {
  const pick = (value, fallback) => {
    const name = String(value || '').trim();
    return MODEL_NAME.test(name) ? name : fallback;
  };
  return {
    everyday: pick(env.CHE_FISH_MODEL, FISH_DEFAULT_MODEL),
    expressive: pick(env.CHE_FISH_EXPRESSIVE_MODEL, FISH_DEFAULT_EXPRESSIVE_MODEL),
  };
}

// Stories and narration get the expressive model; everything else is everyday.
export function fishModelFor(env = {}, purpose = 'conversation') {
  const models = fishModels(env);
  return EXPRESSIVE_PURPOSES.has(String(purpose || '').toLowerCase()) ? models.expressive : models.everyday;
}

export function fishAudioConfigured(env = {}) {
  return Boolean(keyOf(env)) && VOICE_ID.test(voiceOf(env));
}

// Fish speaks only when the key and voice are set and the owner setting is on.
export function fishAudioReady(env = {}) {
  return enabled(env.CHE_FISH_PREFERRED) && fishAudioConfigured(env);
}

// Character voices the owner authorized, by name. The phone and the renderer
// name a character; they never send a raw voice ID.
export function fishCharacterVoices(env = {}) {
  let parsed = {};
  try { parsed = JSON.parse(String(env.CHE_FISH_CHARACTER_VOICES || '{}')); } catch (_) { parsed = {}; }
  const out = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [name, id] of Object.entries(parsed)) {
      const key = String(name).trim().toLowerCase();
      if (/^[a-z0-9 _-]{1,40}$/.test(key) && VOICE_ID.test(String(id || '').trim())) out[key] = String(id).trim();
    }
  }
  return out;
}

function voiceFor(env, character) {
  const name = String(character || '').trim().toLowerCase();
  if (!name || name === 'che') return voiceOf(env);
  return fishCharacterVoices(env)[name] || null;
}

function paused(model, now) {
  return Math.max(state.pausedUntil.get('*') || 0, state.pausedUntil.get(model) || 0) > now;
}

// `why` is the Keys status word for the rest; it decides whether a story may
// fall back to the everyday model (see EXPRESSIVE_BLOCKED).
function pause(model, ms, now, why) {
  // The longest rest wins, with its own reason: a short timeout rest during a
  // longer out-of-credits rest does not hide why the model is resting.
  if (now + ms < (state.pausedUntil.get(model) || 0)) return;
  state.pausedUntil.set(model, now + ms);
  state.pauseWhy.set(model, why);
}

// Maps a failed Fish reply to the Keys tab's words and a pause. A refused clip
// (bad text) returns { refused: true }: it says nothing about the key.
export function classifyFishFailure(code, reason = '') {
  const text = String(reason || '').toLowerCase();
  const aboutModel = /model|plan|tier|eligib|not available|unsupported|permission/.test(text);
  if (code === 401) return { status: 'unauthorized', scope: 'key', pauseMs: PAUSE_LONG_MS };
  if (code === 402 || /credit|balance|quota|insufficient/.test(text)) {
    return { status: 'out of credits', scope: 'model', pauseMs: PAUSE_LONG_MS };
  }
  if (code === 403) {
    return aboutModel
      ? { status: 'model not available', scope: 'model', pauseMs: PAUSE_LONG_MS }
      : { status: 'unauthorized', scope: 'key', pauseMs: PAUSE_LONG_MS };
  }
  if (code === 429) return { status: 'rate-limited', scope: 'key', pauseMs: PAUSE_RATE_LIMIT_MS };
  if (code >= 500) return { status: 'network', scope: 'key', pauseMs: PAUSE_SERVER_MS };
  if ([400, 404, 422].includes(code) && aboutModel) {
    return { status: 'model not available', scope: 'model', pauseMs: PAUSE_LONG_MS };
  }
  return { refused: true };
}

function record(status, code, model, now, reason = '') {
  state.lastOutcome = { status, code, model, at: now, reason };
}

// Fish's own words for a refusal, for the owner's Keys row and the deploy log:
// at most 160 characters, with the key and the voice ID removed.
export function fishRefusalReason(body, env = {}) {
  let message = String(body || '');
  try {
    const parsed = JSON.parse(message);
    const picked = parsed?.message ?? parsed?.detail ?? parsed?.error ?? parsed;
    message = typeof picked === 'string' ? picked : JSON.stringify(picked);
  } catch (_) { /* plain text */ }
  for (const hidden of [keyOf(env), voiceOf(env)]) {
    if (hidden) message = message.split(hidden).join('[hidden]');
  }
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [hidden]').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// The same request body as Fish's official SDK (TTSConfig defaults), sent as
// MessagePack like the SDK does.
export function fishRequestBody({ text, voice, bitrate, expressive, speed = 1 }) {
  return {
    text,
    chunk_length: 200,
    format: 'mp3',
    mp3_bitrate: bitrate,
    opus_bitrate: 32,
    references: [],
    reference_id: voice,
    normalize: true,
    latency: expressive ? 'normal' : 'balanced',
    ...(speed !== 1 ? { prosody: { speed, volume: 0 } } : {}),
    top_p: 0.7,
    temperature: 0.7,
    max_new_tokens: 1024,
    repetition_penalty: 1.2,
    min_chunk_length: 50,
    condition_on_previous_chunks: true,
    early_stop_threshold: 1.0,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

// A number setting, or null when it is unset. The live settings arrive with
// absent values as empty strings, and Number('') is 0, so empty means unset.
function numberSetting(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function maxRtf(env) {
  const value = numberSetting(env.CHE_FISH_MAX_RTF);
  return value !== null && value > 0 ? value : DEFAULT_MAX_RTF;
}

// Fish is measured against the audio it makes: a long clip may take longer,
// but if Fish needs more time than the audio lasts (median of the last few
// clips), it cannot keep ahead of playback, and it rests for ten minutes so
// the faster existing voice answers meanwhile.
function noteLatency(env, model, ms, audioSeconds, now) {
  state.latencies = [...state.latencies, ms].slice(-LATENCY_WINDOW);
  const rtf = audioSeconds > 0 ? ms / (audioSeconds * 1000) : Infinity;
  state.rtfs = [...state.rtfs, rtf].slice(-LATENCY_WINDOW);
  if (state.rtfs.length >= 3 && median(state.rtfs) > maxRtf(env)) {
    pause(model, PAUSE_SLOW_MS, now, 'slow');
    record('slow', 200, model, now);
    state.rtfs = [];
  }
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The cache key covers everything that changes the audio, and nothing secret
// in readable form.
export async function fishCacheKey({ model, voice, text, bitrate, speed }) {
  return CACHE_PREFIX + (await sha256Hex(JSON.stringify([model, voice, bitrate, speed, text]))).slice(0, 40);
}

async function cacheRead(storage, key) {
  if (!storage) return null;
  try {
    const index = (await storage.get(CACHE_INDEX_KEY)) || [];
    const entry = index.find((item) => item.key === key);
    if (!entry) return null;
    const parts = [];
    for (let i = 0; i < entry.parts; i += 1) {
      const part = await storage.get(`${key}:${i}`);
      if (!part) return null;
      parts.push(new Uint8Array(part));
    }
    const bytes = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    // Most recently used goes last; eviction takes from the front.
    await storage.put(CACHE_INDEX_KEY, [...index.filter((item) => item.key !== key), { ...entry, at: Date.now() }]);
    return { bytes, type: entry.type || 'audio/mpeg' };
  } catch (_) {
    return null;
  }
}

async function cacheWrite(storage, key, bytes, type, model) {
  if (!storage || !bytes?.byteLength || bytes.byteLength > CACHE_MAX_BYTES) return;
  try {
    const parts = Math.ceil(bytes.byteLength / CACHE_PART_BYTES);
    for (let i = 0; i < parts; i += 1) {
      await storage.put(`${key}:${i}`, bytes.slice(i * CACHE_PART_BYTES, (i + 1) * CACHE_PART_BYTES));
    }
    let index = ((await storage.get(CACHE_INDEX_KEY)) || []).filter((item) => item.key !== key);
    index.push({ key, bytes: bytes.byteLength, parts, type, model, at: Date.now() });
    let total = index.reduce((sum, item) => sum + item.bytes, 0);
    while (index.length > CACHE_MAX_ENTRIES || total > CACHE_MAX_BYTES) {
      const [oldest, ...rest] = index;
      for (let i = 0; i < oldest.parts; i += 1) await storage.delete(`${oldest.key}:${i}`);
      total -= oldest.bytes;
      index = rest;
    }
    await storage.put(CACHE_INDEX_KEY, index);
  } catch (_) { /* a cache write never blocks speech */ }
}

const today = (now) => new Date(now).toISOString().slice(0, 10);

// Daily counts per model: requests, characters sent, cache hits, failures and
// latency. Characters are what Fish bills, so this is the cost measurement.
export async function readFishUsage(storage, now = Date.now()) {
  const usage = storage ? await storage.get(USAGE_KEY).catch(() => null) : null;
  return usage && usage.date === today(now) ? usage : { date: today(now), models: {} };
}

async function addUsage(storage, model, change, now) {
  if (!storage) return;
  try {
    const usage = await readFishUsage(storage, now);
    const row = usage.models[model] || { requests: 0, chars: 0, cache_hits: 0, failures: 0, total_ms: 0, last_ms: 0 };
    for (const [field, value] of Object.entries(change)) {
      row[field] = field === 'last_ms' ? value : (row[field] || 0) + value;
    }
    usage.models[model] = row;
    await storage.put(USAGE_KEY, usage);
  } catch (_) { /* usage is a measurement, never a blocker */ }
}

// The day's expressive characters are kept in memory, seeded once per day from
// storage. A request reserves its characters before Fish is called, with no
// await between the check and the reservation, so requests running at the same
// time cannot all pass the cap. A failed request gives its reservation back.
async function reserveExpressive(env, storage, model, chars, now) {
  const date = today(now);
  if (state.ledger.date !== date) state.ledger = { date, chars: new Map(), seeded: new Set() };
  if (!state.ledger.seeded.has(model)) {
    const usage = await readFishUsage(storage, now);
    if (state.ledger.date === date && !state.ledger.seeded.has(model)) {
      state.ledger.chars.set(model, (state.ledger.chars.get(model) || 0) + (usage.models[model]?.chars || 0));
      state.ledger.seeded.add(model);
    }
  }
  const used = state.ledger.chars.get(model) || 0;
  if (used + chars > expressiveDailyChars(env)) return false;
  state.ledger.chars.set(model, used + chars);
  return true;
}

function releaseExpressive(model, chars, now) {
  if (state.ledger.date !== today(now)) return;
  state.ledger.chars.set(model, Math.max(0, (state.ledger.chars.get(model) || 0) - chars));
}

function expressiveDailyChars(env) {
  const value = numberSetting(env.CHE_FISH_EXPRESSIVE_DAILY_CHARS);
  return value !== null && value >= 0 ? value : DEFAULT_EXPRESSIVE_DAILY_CHARS;
}

function audioResponse(bytes, type, model, cache) {
  return new Response(bytes, {
    headers: {
      'Content-Type': type || 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-CHE-Voice': 'fish-audio',
      'X-CHE-Fish': 'healthy',
      'X-CHE-Fish-Model': model,
      'X-CHE-Cache': cache,
    },
  });
}

/**
 * Speaks `text` with Fish Audio, or returns null so the caller uses the
 * existing voice. `purpose` picks the model: 'conversation' (default) and
 * 'read' use the everyday model; 'story' and 'narration' use the expressive one.
 * `character` names an owner-authorized character voice; CHE's own voice is the
 * default. `storage` is the Durable Object storage used for the audio cache.
 */
export async function fishAudioSpeech(env = {}, text, options = {}) {
  const first = await fishSpeakOnce(env, text, options);
  if (first.response) return first.response;
  // A story falls back to CHE's everyday Fish voice when the expressive model
  // cannot be used here (no API credit, not on this account, today's cap
  // reached), so she still sounds like herself. The reason is this request's
  // own, never another chunk's. A timeout does not fall back: that would make
  // the owner wait twice. The story keeps its length limit and quality; only
  // the model changes, and the free model is not counted against the cap.
  // A reply locked to one model (owner, 2026-10-18: one voice per response)
  // never changes model halfway; the phone reports the interruption instead.
  if (options.locked) return null;
  if (!EXPRESSIVE_PURPOSES.has(String(options.purpose || '').toLowerCase())) return null;
  if (!EXPRESSIVE_BLOCKED.has(first.why)) return null;
  const fallback = await fishSpeakOnce(env, text, { ...options, model: fishModels(env).everyday });
  return fallback.response;
}

// Outcomes that mean the expressive model cannot be used right now, but the
// everyday model may still speak.
const EXPRESSIVE_BLOCKED = new Set(['out of credits', 'model not available', 'daily limit reached']);

// One attempt with one model. Returns { response } with audio, or { why } with
// the status word for why this attempt did not speak.
async function fishSpeakOnce(env = {}, text, {
  purpose = 'conversation',
  character = '',
  storage = null,
  fetcher = fetch,
  now = Date.now(),
  model: modelOverride = '',
  force = false,
} = {}) {
  const none = (why) => ({ response: null, why });
  if (!fishAudioReady(env)) return none('not set up');
  const said = String(text || '').replace(/\s+/g, ' ').trim();
  const expressive = EXPRESSIVE_PURPOSES.has(String(purpose || '').toLowerCase());
  if (!said || said.length > (expressive ? MAX_EXPRESSIVE_CHARS : MAX_CONVERSATION_CHARS)) return none('too long');
  const model = modelOverride || fishModelFor(env, purpose);
  // Only the expressive model costs credits, so only it counts against the cap.
  const capped = expressive && model === fishModels(env).expressive;
  const voice = voiceFor(env, character);
  if (!voice) return none('voice not authorized');
  const configuredSpeed = numberSetting(env.CHE_FISH_SPEED);
  const speed = configuredSpeed !== null && configuredSpeed > 0
    ? Math.min(1.3, Math.max(0.8, configuredSpeed)) : 1;
  // Speech at 64 kbps is clear and half the bytes of 128, so it reaches the
  // phone sooner. Narration is kept at 128 for the finished video.
  const bitrate = expressive ? 128 : 64;
  const key = await fishCacheKey({ model, voice, text: said, bitrate, speed });

  const cached = await cacheRead(storage, key);
  if (cached) {
    await addUsage(storage, model, { cache_hits: 1 }, now);
    return { response: audioResponse(cached.bytes, cached.type, model, 'hit') };
  }
  // [force] is one bounded retry for a reply already speaking in Fish: a
  // rest after a slow or failed clip must not switch the voice mid-reply.
  if (!force && paused(model, now)) {
    return none((state.pausedUntil.get(model) || 0) > now ? state.pauseWhy.get(model) : state.pauseWhy.get('*'));
  }
  if ((state.refused.get(key) || 0) > now) return none('refused text');

  // The same words requested twice at once (the phone's two voice routes, or a
  // retry) share one synthesis and one reservation against the daily cap.
  let pending = state.inflight.get(key);
  if (!pending && capped) {
    if (!(await reserveExpressive(env, storage, model, said.length, now))) {
      record('daily limit reached', 0, model, now);
      return none('daily limit reached');
    }
    // Another request for the same words may have started while this one
    // waited; share it and give this reservation back.
    pending = state.inflight.get(key);
    if (pending) releaseExpressive(model, said.length, now);
  }
  const owner = !pending;
  if (owner) {
    pending = synthesize(env, { said, model, voice, bitrate, speed, expressive, storage, fetcher, key, now })
      .then((result) => {
        if (!result.bytes && capped) releaseExpressive(model, said.length, now);
        return result;
      });
    state.inflight.set(key, pending);
  }
  let result;
  try {
    result = await pending;
  } finally {
    if (owner) state.inflight.delete(key);
  }
  return result.bytes
    ? { response: audioResponse(result.bytes, result.type, model, owner ? 'miss' : 'shared') }
    : none(result.failed);
}

async function synthesize(env, { said, model, voice, bitrate, speed, expressive, storage, fetcher, key, now }) {
  const started = Date.now();
  try {
    const response = await fetcher(FISH_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keyOf(env)}`,
        'Content-Type': 'application/msgpack',
        model,
      },
      body: encodeMsgpack(fishRequestBody({ text: said, voice, bitrate, expressive, speed })),
      signal: AbortSignal.timeout(expressive ? EXPRESSIVE_TIMEOUT_MS : conversationTimeoutMs(said.length)),
    });
    const ms = Date.now() - started;
    if (!response.ok) {
      // The body classifies the failure. Only Fish's own short message, with
      // the key and voice removed, is kept for the owner's Keys row.
      const body = (await response.text().catch(() => '')).slice(0, 400);
      const failure = classifyFishFailure(response.status, body);
      const reason = fishRefusalReason(body, env);
      await addUsage(storage, model, { failures: 1 }, now);
      if (failure.refused) {
        state.refused.set(key, now + REFUSED_TEXT_MS);
        // Fish refusing different words in a row is a setup problem, not the
        // text: rest that model so every clip does not wait for a refusal.
        // The same words refused again count once; only different words do.
        const last = state.refusals.get(model);
        const recent = last && now - last.at < PAUSE_LONG_MS;
        const count = recent ? (last.key === key ? last.count : last.count + 1) : 1;
        state.refusals.set(model, { count, at: now, key });
        if (count >= 2) {
          pause(model, PAUSE_LONG_MS, now, 'request refused');
          record('request refused', response.status, model, now, reason);
          return { failed: 'request refused' };
        }
        record('refused text', response.status, model, now, reason);
        return { failed: 'refused text' };
      }
      pause(failure.scope === 'key' ? '*' : model, failure.pauseMs, now, failure.status);
      record(failure.status, response.status, model, now, reason);
      return { failed: failure.status };
    }
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (!/^audio\/|^application\/octet-stream/.test(type)) {
      record('network', response.status, model, now);
      pause(model, PAUSE_SERVER_MS, now, 'network');
      return { failed: 'network' };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > CACHE_MAX_BYTES) {
      record('network', response.status, model, now);
      return { failed: 'network' };
    }
    record('healthy', 200, model, now);
    state.refusals.delete(model);
    await addUsage(storage, model, { requests: 1, chars: said.length, total_ms: ms, last_ms: ms }, now);
    if (!expressive) noteLatency(env, model, ms, (bytes.byteLength * 8) / (bitrate * 1000), now);
    const audioType = type.startsWith('audio/') ? type.split(';')[0] : 'audio/mpeg';
    await cacheWrite(storage, key, bytes, audioType, model);
    return { bytes, type: audioType };
  } catch (_) {
    // A timeout or network error rests Fish briefly so a slow provider cannot
    // add its wait to every clip. Never log the key.
    pause(model, PAUSE_TIMEOUT_MS, now, 'network');
    record('network', 0, model, now);
    await addUsage(storage, model, { failures: 1 }, now);
    return { failed: 'network' };
  }
}

// Fish's row in the Keys tab. Status words match the other rows; only the last
// four characters of the key leave this module.
export function fishAudioKeyStatus(env = {}, now = Date.now()) {
  const models = fishModels(env);
  const modelLine = `Everyday voice ${models.everyday}; stories and narration ${models.expressive}.`;
  if (!keyOf(env)) return { status: 'not set up', last4: '', detail: 'Add FISH_API_KEY as a GitHub Actions secret, then deploy.' };
  const last4 = keyOf(env).slice(-4);
  if (!VOICE_ID.test(voiceOf(env))) {
    return { status: 'needs a voice', last4, detail: 'Add CHE_FISH_VOICE_ID (the Fish voice for CHE) as a GitHub Actions secret, then deploy.' };
  }
  if (!enabled(env.CHE_FISH_PREFERRED)) return { status: 'off', last4, detail: `Fish is switched off by CHE_FISH_PREFERRED. ${modelLine}` };
  if (!state.lastOutcome) return { status: 'not tried yet', last4, detail: `Fish has not spoken since the last restart. ${modelLine}` };
  const { status, code, model, at, reason } = state.lastOutcome;
  const resting = Math.max(state.pausedUntil.get('*') || 0, state.pausedUntil.get(model) || 0);
  const waiting = resting > now ? ` Fish waits until ${new Date(resting).toISOString()} before trying ${model} again.` : '';
  const last = state.latencies.length ? ` Last reply took ${state.latencies[state.latencies.length - 1]} ms.` : '';
  return {
    status,
    last4,
    detail: `Last attempt ${new Date(at).toISOString()} with ${model}${code ? ` (HTTP ${code})` : ''}.${reason ? ` Fish said: "${reason}".` : ''}${last}${waiting} ${modelLine}`,
  };
}

// Booleans, model names and status words only, never a key or a voice ID.
export function fishAudioDiagnostics(env = {}, now = Date.now()) {
  const models = fishModels(env);
  return {
    preferred: enabled(env.CHE_FISH_PREFERRED),
    key_present: Boolean(keyOf(env)),
    voice_id_format_ok: VOICE_ID.test(voiceOf(env)),
    ready: fishAudioReady(env),
    everyday_model: models.everyday,
    expressive_model: models.expressive,
    status: fishAudioKeyStatus(env, now).status,
    paused: paused(models.everyday, now),
    median_latency_ms: state.latencies.length ? median(state.latencies) : null,
  };
}
