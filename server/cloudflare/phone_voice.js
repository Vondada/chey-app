// CHE's voice on the owner's iPhone (owner, 2026-10-14): her ElevenLabs voice
// (Mary) speaks every reply and Read This; Fish speaks only when ElevenLabs
// gives no audio. The phone asks for exactly this with `premium_only`, and then
// gets no free server voice: when both fail it stays silent and shows why.
//
// A short voice log in Durable Object storage records each attempt and what
// the phone reported hearing: status words, sizes and times, never the text.
// The deploy check reads it, so a failure on the phone leaves evidence.

import { preferredElevenLabsKeyStatus, preferredElevenLabsSpeech } from './preferred_elevenlabs_voice.js';
import { fishAudioKeyStatus, fishAudioSpeech } from './fish_audio_voice.js';

const VOICE_LOG_KEY = 'voice_log_v1';
const VOICE_LOG_MAX = 40;

// One voice per response (owner, 2026-10-18). The phone names each spoken
// reply with a turn id. The first clip may use the backup voice when the
// chosen one fails before anything played; after that the phone sends `lock`
// with the provider that spoke, and a locked clip uses only that provider: one
// short retry only when a second call cannot pay twice for one clip (a server
// error, a refused connection, or a short rest that made no call), then
// silence with the reason, never the other voice. A timeout, a rate limit,
// credits or a refused key are never retried.
export const VOICE_LOCKS = ['elevenlabs', 'fish'];
const TURN_TTL_MS = 20 * 60 * 1000;
const TURN_MAX = 16;

/** 'elevenlabs' or 'fish' for an X-CHE-Voice engine label, else ''. */
export function voiceProviderOf(engine) {
  const label = String(engine || '');
  if (label.startsWith('elevenlabs')) return 'elevenlabs';
  if (label.startsWith('fish')) return 'fish';
  return '';
}

// A short one-way fingerprint (FNV-1a), so logs and the phone can compare
// voices without holding a voice ID or anything secret.
function fingerprint(value) {
  let hash = 0x811c9dc5;
  for (const ch of String(value)) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The voice that spoke, as provider:fingerprint of voice, model, speed and settings. */
export function voiceTag(env = {}, provider, model = '') {
  if (provider === 'elevenlabs') {
    return `elevenlabs:${fingerprint([env.CHE_ELEVENLABS_VOICE_ID, env.CHE_ELEVENLABS_MODEL || 'eleven_flash_v2_5',
      env.CHE_VOICE_SPEED, env.CHE_VOICE_STABILITY, env.CHE_VOICE_SIMILARITY, env.CHE_VOICE_STYLE,
      env.CHE_VOICE_SPEAKER_BOOST].map((v) => String(v ?? '')).join('|'))}`;
  }
  if (provider === 'fish') {
    return `fish:${fingerprint([env.CHE_FISH_VOICE_ID, model, env.CHE_FISH_SPEED].map((v) => String(v ?? '')).join('|'))}`;
  }
  return '';
}

/**
 * The voice settings of one spoken reply, kept from its first clip: a voice
 * change saved while CHE is speaking applies from the next reply. Bounded and
 * in memory only; a lost entry falls back to the current choice.
 */
export function voiceTurnFor(turns, id, current, now = Date.now()) {
  if (!turns || !/^[A-Za-z0-9_-]{8,64}$/.test(String(id || ''))) return null;
  for (const [key, turn] of turns) if (now - turn.at > TURN_TTL_MS) turns.delete(key);
  let turn = turns.get(id);
  if (turn) turn.at = now; // a long Read This keeps its turn while it is still speaking
  if (!turn) {
    turn = { at: now, choice: current ? JSON.parse(JSON.stringify(current)) : null, fishModel: '' };
    turns.set(id, turn);
    while (turns.size > TURN_MAX) turns.delete(turns.keys().next().value);
  }
  return turn;
}

function labelled(response, env, provider, extra = {}) {
  const model = provider === 'fish' ? response.headers.get('X-CHE-Fish-Model') || '' : '';
  response.headers.set('X-CHE-Voice-Tag', voiceTag(env, provider, model));
  for (const [name, value] of Object.entries(extra)) response.headers.set(name, String(value));
  if (provider === 'fish') response.headers.set('X-CHE-Mary', preferredElevenLabsKeyStatus(env).status);
  else response.headers.set('X-CHE-Fish', fishAudioKeyStatus(env).status);
  return response;
}

/**
 * ElevenLabs, then Fish (or Fish first when the owner chose a Fish voice).
 * Returns the audio Response, or null when nothing spoke. With `lock`, only
 * that provider is tried. Each response carries both voices' status words, the
 * voice tag, and X-CHE-Voice-Fallback when the backup voice answered.
 */
// Owner rule (2026-10-22): CHE's assistant speech is ElevenLabs only. Fish speaks only for the purposes the owner
// authorized for expressive narration (stories and narration, as fish_audio_voice.js defines them). Conversation
// and Read This never reach Fish: not as the chosen voice, not as a backup, not for a saved Fish preference.
const FISH_AUTHORIZED_PURPOSES = new Set(['story', 'narration', 'expressive']);

export async function premiumVoiceSpeech(env = {}, text, {
  purpose, character, storage, selectedProvider, lock = '', turn = null,
  retryDelayMs = 400, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const fishAuthorized = FISH_AUTHORIZED_PURPOSES.has(String(purpose || '').toLowerCase());
  // Under the strict rule, a Fish lock on assistant speech is silence: no Fish call is made.
  if (lock === 'fish' && !fishAuthorized) return null;
  const primary = fishAuthorized && selectedProvider === 'fish' ? 'fish' : 'elevenlabs';
  const backup = fishAuthorized && primary === 'elevenlabs' ? 'fish' : null;
  // Each attempt reports its own outcome, so a clip running alongside cannot decide this one's retry.
  let outcome = null;
  const onOutcome = (o) => { outcome = o; };
  const attempt = (provider, retry = false) => {
    outcome = null;
    return provider === 'fish'
      ? fishAudioSpeech(env, text, { purpose, character, storage, force: retry, onOutcome,
        ...(lock && turn?.fishModel ? { model: turn.fishModel, locked: true } : lock ? { locked: true } : {}) })
      : preferredElevenLabsSpeech(env, text, undefined, { retry, onOutcome });
  };
  if (VOICE_LOCKS.includes(lock)) {
    let audio = await attempt(lock);
    let attempts = 1;
    if (!audio && outcome?.retryable === true) {
      await sleep(retryDelayMs);
      audio = await attempt(lock, true);
      attempts = 2;
    }
    return audio ? labelled(audio, env, lock, { 'X-CHE-Voice-Attempts': attempts }) : null;
  }
  const first = await attempt(primary);
  if (first) return labelled(first, env, primary);
  if (!backup) return null;
  const second = await attempt(backup);
  return second ? labelled(second, env, backup, { 'X-CHE-Voice-Fallback': '1' }) : null;
}

/** Both voices' status words, for a reply with no audio. */
export function premiumVoiceStatuses(env = {}) {
  return { mary: preferredElevenLabsKeyStatus(env).status, fish: fishAudioKeyStatus(env).status };
}

// A short word or phrase: letters, digits and simple punctuation only, so the
// log never holds anything that looks like text the owner said.
function word(value, max = 60) {
  return String(value ?? '').replace(/[^\w .:;,'()/+-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 1_000_000) : 0;
}

/** Cleans one log entry; unknown fields are dropped. */
export function voiceLogEntry(entry = {}, now = Date.now()) {
  const out = { at: new Date(now).toISOString(), route: word(entry.route, 20) || 'unknown' };
  for (const name of ['engine', 'mary', 'fish', 'lock', 'tag', 'provider']) if (entry[name] !== undefined) out[name] = word(entry[name], 40);
  for (const name of ['chars', 'ms', 'bytes', 'chunks', 'played', 'silent', 'index', 'attempts', 'retries',
    'interrupted', 'fallback', 'stopped', 'switches', 'tag_changes', 'gaps', 'gap_max_ms', 'gap_avg_ms',
    'first_audio_ms', 'synth_max_ms', 'overhead_max_ms', 'overhead_avg_ms']) {
    if (entry[name] !== undefined) out[name] = count(entry[name]);
  }
  for (const map of ['engines', 'tags']) {
    if (entry[map] && typeof entry[map] === 'object') {
      out[map] = Object.fromEntries(Object.entries(entry[map]).slice(0, 6).map(([k, v]) => [word(k, 40), count(v)]));
    }
  }
  if (Array.isArray(entry.reasons)) out.reasons = entry.reasons.slice(0, 6).map((r) => word(r, 160)).filter(Boolean);
  return out;
}

export async function recordVoiceLog(storage, entry, now = Date.now()) {
  if (!storage) return;
  try {
    const log = (await storage.get(VOICE_LOG_KEY)) || [];
    log.push(voiceLogEntry(entry, now));
    await storage.put(VOICE_LOG_KEY, log.slice(-VOICE_LOG_MAX));
  } catch (_) { /* the log must never break speech */ }
}

export async function readVoiceLog(storage, limit = 20) {
  try {
    const log = (await storage?.get(VOICE_LOG_KEY)) || [];
    return log.slice(-limit);
  } catch (_) {
    return [];
  }
}

/**
 * The deploy check's token: a fresh random value each deploy, set as the
 * CHE_VOICE_PROBE_TOKEN Worker secret. Without it the check route does not exist.
 */
export function voiceProbeAuthorized(request, env = {}) {
  const expected = String(env.CHE_VOICE_PROBE_TOKEN || '').trim();
  if (expected.length < 32) return false;
  const match = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '');
  const given = match ? match[1] : '';
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
