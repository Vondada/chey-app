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

/**
 * ElevenLabs, then Fish. Returns the audio Response, or null when neither
 * spoke. Each response carries both voices' status words, so the phone can say
 * why the other one did not speak.
 */
export async function premiumVoiceSpeech(env = {}, text, { purpose, character, storage, selectedProvider } = {}) {
  // An owner-chosen Fish voice becomes primary, with ElevenLabs as fallback.
  // The default behavior stays ElevenLabs-first; selection never disables the
  // other provider or overrides its normal credit/rate-limit safeguards.
  if (selectedProvider === 'fish') {
    const fishFirst = await fishAudioSpeech(env, text, { purpose, character, storage });
    if (fishFirst) {
      fishFirst.headers.set('X-CHE-Mary', preferredElevenLabsKeyStatus(env).status);
      return fishFirst;
    }
  }
  const mary = await preferredElevenLabsSpeech(env, text);
  if (mary) {
    mary.headers.set('X-CHE-Fish', fishAudioKeyStatus(env).status);
    return mary;
  }
  if (selectedProvider !== 'fish') {
    const fish = await fishAudioSpeech(env, text, { purpose, character, storage });
    if (fish) {
      fish.headers.set('X-CHE-Mary', preferredElevenLabsKeyStatus(env).status);
      return fish;
    }
  }
  return null;
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
  for (const name of ['engine', 'mary', 'fish']) if (entry[name] !== undefined) out[name] = word(entry[name], 40);
  for (const name of ['chars', 'ms', 'bytes', 'chunks', 'played', 'silent']) {
    if (entry[name] !== undefined) out[name] = count(entry[name]);
  }
  if (entry.engines && typeof entry.engines === 'object') {
    out.engines = Object.fromEntries(Object.entries(entry.engines).slice(0, 6).map(([k, v]) => [word(k, 40), count(v)]));
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
