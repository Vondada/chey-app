// Optional premium voice for CHE. An explicit owner opt-in is required even if
// the key is present. This never enables paid chat/model providers.
const enabled = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

export function preferredElevenLabsReady(env = {}) {
  return enabled(env.CHE_ELEVENLABS_PREFERRED)
    && Boolean(String(env.ELEVENLABS_API_KEY || '').trim())
    && /^[a-zA-Z0-9_-]{10,80}$/.test(String(env.CHE_ELEVENLABS_VOICE_ID || '').trim());
}

// A failure pauses Mary so later clips go straight to the free voice. How long
// depends on the cause: a rate limit or server blip clears in seconds, while a
// bad key or spent credits will not clear until the owner acts. A timeout pauses
// briefly so a slow provider cannot add its wait to every clip. Each iPhone reply
// tries Mary on two routes, so this matters.
const PAUSE_RATE_LIMIT_MS = 30 * 1000;
const PAUSE_SERVER_MS = 60 * 1000;
const PAUSE_LONG_MS = 10 * 60 * 1000;
const PAUSE_AFTER_TIMEOUT_MS = 2 * 60 * 1000;
let pausedUntil = 0;
// The last outcome, for the Keys tab and the deploy check: a status word, the
// HTTP code, a time, and ElevenLabs' own reason with the key and voice removed.
let lastOutcome = null;
// ElevenLabs refuses requests above the plan's concurrency (2 on the free plan)
// with a 429. The phone prepares up to three clips of one reply at once, so
// clips wait for a free slot here instead of being refused.
const DEFAULT_CONCURRENCY = 2;
let active = 0;
const waiting = [];

export function resetPreferredElevenLabsPause() {
  pausedUntil = 0;
  lastOutcome = null;
  active = 0;
  waiting.length = 0;
}

// The last attempt, for the deploy check. Never the key or the voice ID.
export function preferredElevenLabsLastOutcome() {
  return lastOutcome ? { ...lastOutcome } : null;
}

// ElevenLabs' reason for a refusal, short, with the key and voice ID removed.
// Its errors look like {"detail":{"status":"quota_exceeded","message":"..."}}.
export function elevenLabsRefusalReason(body, env = {}) {
  let message = String(body || '');
  try {
    const parsed = JSON.parse(message);
    const detail = parsed?.detail ?? parsed;
    message = typeof detail === 'string'
      ? detail
      : [detail?.status, detail?.message].filter(Boolean).join(': ') || JSON.stringify(detail);
  } catch (_) { /* plain text */ }
  for (const hidden of [String(env.ELEVENLABS_API_KEY || '').trim(), String(env.CHE_ELEVENLABS_VOICE_ID || '').trim()]) {
    if (hidden) message = message.split(hidden).join('[hidden]');
  }
  return message.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function concurrency(env) {
  const value = Number(String(env.CHE_ELEVENLABS_CONCURRENCY ?? '').trim() || NaN);
  return Number.isInteger(value) && value >= 1 && value <= 10 ? value : DEFAULT_CONCURRENCY;
}

async function withSlot(limit, run) {
  while (active >= limit) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

// Maps a failed ElevenLabs reply to the Keys tab's words and to a pause length.
// Returns null for a refused clip (bad text), which says nothing about the key.
function classifyFailure(code, reason) {
  // Library voices need a paid plan on the API; ElevenLabs says so in a 402/401.
  if ((code === 402 || code === 401 || code === 403) && /library voice|upgrade your subscription|paid_plan_required|payment_required/i.test(reason)) {
    return { status: 'needs a paid plan', pauseMs: PAUSE_LONG_MS };
  }
  if (code === 404 || /voice_not_found/i.test(reason)) return { status: 'voice not found', pauseMs: PAUSE_LONG_MS };
  const outOfCredits = code === 402 || (code === 401 && /quota|credit/i.test(reason));
  if (outOfCredits) return { status: 'out of credits', pauseMs: PAUSE_LONG_MS };
  if (code === 401 || code === 403) return { status: 'unauthorized', pauseMs: PAUSE_LONG_MS };
  if (code === 429) return { status: 'rate-limited', pauseMs: PAUSE_RATE_LIMIT_MS };
  if (code >= 500) return { status: 'network', pauseMs: PAUSE_SERVER_MS };
  return null;
}

function recordFailure(code, status, pauseMs, now = Date.now(), reason = '') {
  pausedUntil = now + pauseMs;
  lastOutcome = { status, code, at: now, reason };
}

// Mary's state for the Keys tab. The status words are the ones the Keys screens
// already show ("healthy", "rate-limited", "unauthorized", "network"); the
// others are read as plain text. Only the last four characters of the key leave
// this module, the same as the other key rows.
export function preferredElevenLabsKeyStatus(env = {}, now = Date.now()) {
  if (!preferredElevenLabsReady(env)) return { status: 'not set up', last4: '', detail: '' };
  const last4 = String(env.ELEVENLABS_API_KEY).trim().slice(-4);
  if (!lastOutcome) return { status: 'not tried yet', last4, detail: 'Mary has not spoken since the last restart.' };
  const at = new Date(lastOutcome.at).toISOString();
  const waiting = pausedUntil > now ? ` Mary waits until ${new Date(pausedUntil).toISOString()} before trying again.` : '';
  const code = lastOutcome.code ? ` (HTTP ${lastOutcome.code})` : '';
  const said = lastOutcome.reason ? ` ElevenLabs said: "${lastOutcome.reason}"` : '';
  return {
    status: lastOutcome.status,
    last4,
    detail: `Last attempt ${at}${code}.${said}${waiting}`,
  };
}

// The Mary settings, copied from the Worker's live env on each voice request. The
// Durable Object keeps the env it was created with, so a secret set or changed
// later would otherwise stay invisible to it until the object restarts.
export const MARY_SECRET_NAMES = ['ELEVENLABS_API_KEY', 'CHE_ELEVENLABS_VOICE_ID', 'CHE_ELEVENLABS_PREFERRED', 'CHE_ELEVENLABS_MODEL', 'CHE_ELEVENLABS_CONCURRENCY', 'CHE_VOICE_SPEED', 'CHE_VOICE_STABILITY', 'CHE_VOICE_SIMILARITY', 'CHE_VOICE_STYLE', 'CHE_VOICE_SPEAKER_BOOST'];

// An absent setting is sent as an empty value, not left out. A removed secret
// then overrides the stale captured env instead of being inherited from it.
export function marySecretsFrom(env = {}) {
  const out = {};
  for (const name of MARY_SECRET_NAMES) {
    out[name] = env[name] === undefined || env[name] === null ? '' : String(env[name]);
  }
  return out;
}

export function withMarySecrets(env = {}, secrets = {}) {
  if (!secrets || !Object.keys(secrets).length) return env;
  const merged = Object.create(env);
  for (const [name, value] of Object.entries(secrets)) merged[name] = value;
  return merged;
}

// Booleans and status words only, never a key or a voice ID. The owner's voice
// diagnostics and the deploy check read this.
export function preferredElevenLabsDiagnostics(env = {}, now = Date.now()) {
  const keyStatus = preferredElevenLabsKeyStatus(env, now);
  return {
    preferred: enabled(env.CHE_ELEVENLABS_PREFERRED),
    key_present: Boolean(String(env.ELEVENLABS_API_KEY || '').trim()),
    voice_id_format_ok: /^[a-zA-Z0-9_-]{10,80}$/.test(String(env.CHE_ELEVENLABS_VOICE_ID || '').trim()),
    ready: preferredElevenLabsReady(env),
    status: keyStatus.status,
    paused: pausedUntil > now,
  };
}

// Null means CHE's backup voice (Fish) speaks; do not speak a partial clip.
// This helper is shared by both iOS voice routes. `force` skips a rest; only
// the deploy check uses it, so one real call is made after every deploy.
export async function preferredElevenLabsSpeech(env = {}, text, fetcher = fetch, { force = false } = {}) {
  if (!preferredElevenLabsReady(env)) return null;
  const said = String(text || '').replace(/\s+/g, ' ').trim();
  // Cap each synthesis to avoid runaway paid generation; longer text uses the
  // backup voice without truncating the user's spoken reply.
  if (!said || said.length > 800) return null;
  if (!force && Date.now() < pausedUntil) return null;
  return withSlot(concurrency(env), () => speakOnce(env, said, fetcher));
}

// The owner's voice controls for Mary. An unset control keeps the default CHE has
// always used, so nothing changes until the owner chooses different settings.
export function elevenVoiceSettings(env = {}) {
  const unit = (value, fallback) => {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    const number = Number(raw);
    return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
  };
  const boost = String(env.CHE_VOICE_SPEAKER_BOOST ?? '').trim().toLowerCase();
  return {
    stability: unit(env.CHE_VOICE_STABILITY, 0.6),
    similarity_boost: unit(env.CHE_VOICE_SIMILARITY, 0.82),
    style: unit(env.CHE_VOICE_STYLE, 0.15),
    use_speaker_boost: boost === '' ? true : !['0', 'false', 'no'].includes(boost),
  };
}

async function speakOnce(env, said, fetcher) {
  const voice = encodeURIComponent(String(env.CHE_ELEVENLABS_VOICE_ID).trim());
  const configuredSpeed = Number(env.CHE_VOICE_SPEED);
  const speed = Number.isFinite(configuredSpeed) && configuredSpeed > 0
    ? Math.min(1.2, Math.max(0.7, configuredSpeed)) : 1.04;
  try {
    const response = await fetcher(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': String(env.ELEVENLABS_API_KEY),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: said,
          model_id: String(env.CHE_ELEVENLABS_MODEL || 'eleven_flash_v2_5'),
          voice_settings: { ...elevenVoiceSettings(env), speed },
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) {
      // ElevenLabs' reason tells "out of credits" from a bad key. It is kept
      // short, with the key and voice ID removed, for Keys and the deploy check.
      const reason = (await response.text().catch(() => '')).slice(0, 600);
      const failure = classifyFailure(response.status, reason);
      const said = elevenLabsRefusalReason(reason, env);
      if (failure) recordFailure(response.status, failure.status, failure.pauseMs, Date.now(), said);
      else lastOutcome = { status: 'refused text', code: response.status, at: Date.now(), reason: said };
      return null;
    }
    if (!/^audio\//i.test(response.headers.get('content-type') || '')) {
      lastOutcome = { status: 'network', code: response.status, at: Date.now(), reason: 'ElevenLabs answered without audio.' };
      return null;
    }
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 6 * 1024 * 1024) {
      lastOutcome = { status: 'network', code: response.status, at: Date.now(), reason: 'ElevenLabs sent an empty or oversized clip.' };
      return null;
    }
    lastOutcome = { status: 'healthy', code: 200, at: Date.now() };
    return new Response(bytes, {
      headers: {
        'Content-Type': response.headers.get('content-type') || 'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-CHE-Voice': 'elevenlabs-mary',
        // A successful Mary clip is her status too, so the phone can clear an
        // earlier rate-limit or error in its diagnostics.
        'X-CHE-Mary': 'healthy',
      },
    });
  } catch (error) {
    // Timeouts and network errors fall back to the backup voice. Never log keys.
    const reason = error?.name === 'TimeoutError' ? 'No answer within 8 seconds.' : 'Could not reach ElevenLabs.';
    recordFailure(0, 'network', PAUSE_AFTER_TIMEOUT_MS, Date.now(), reason);
    return null;
  }
}
