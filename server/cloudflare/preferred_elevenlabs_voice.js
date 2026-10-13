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
// The last outcome, for the Keys tab. It holds a status word and a time only,
// never the key or the provider's error text.
let lastOutcome = null;

export function resetPreferredElevenLabsPause() {
  pausedUntil = 0;
  lastOutcome = null;
}

// Maps a failed ElevenLabs reply to the Keys tab's words and to a pause length.
// Returns null for a refused clip (bad text), which says nothing about the key.
function classifyFailure(code, reason) {
  const outOfCredits = code === 402 || (code === 401 && /quota|credit/i.test(reason));
  if (outOfCredits) return { status: 'out of credits', pauseMs: PAUSE_LONG_MS };
  if (code === 401 || code === 403) return { status: 'unauthorized', pauseMs: PAUSE_LONG_MS };
  if (code === 429) return { status: 'rate-limited', pauseMs: PAUSE_RATE_LIMIT_MS };
  if (code >= 500) return { status: 'network', pauseMs: PAUSE_SERVER_MS };
  return null;
}

function recordFailure(code, status, pauseMs, now = Date.now()) {
  pausedUntil = now + pauseMs;
  lastOutcome = { status, code, at: now };
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
  return {
    status: lastOutcome.status,
    last4,
    detail: `Last attempt ${at}${code}.${waiting}`,
  };
}

// Null means use CHE's existing free/iPhone voice; do not speak a partial clip.
// This helper is shared by both iOS voice routes because the app normally tries
// /api/voice/edge before /api/voice/synthesize.
export async function preferredElevenLabsSpeech(env = {}, text, fetcher = fetch) {
  if (!preferredElevenLabsReady(env)) return null;
  const said = String(text || '').replace(/\s+/g, ' ').trim();
  // Cap each synthesis to avoid runaway paid generation; longer text uses the
  // original free voice path without truncating the user's spoken reply.
  if (!said || said.length > 800) return null;
  if (Date.now() < pausedUntil) return null;
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
          voice_settings: {
            stability: 0.6,
            similarity_boost: 0.82,
            style: 0.15,
            use_speaker_boost: true,
            speed,
          },
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) {
      // The reason is read only to tell "out of credits" from a bad key; it is
      // never logged or returned.
      const reason = (await response.text().catch(() => '')).slice(0, 300);
      const failure = classifyFailure(response.status, reason);
      if (failure) recordFailure(response.status, failure.status, failure.pauseMs);
      return null;
    }
    if (!/^audio\//i.test(response.headers.get('content-type') || '')) return null;
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 6 * 1024 * 1024) return null;
    lastOutcome = { status: 'healthy', code: 200, at: Date.now() };
    return new Response(bytes, {
      headers: {
        'Content-Type': response.headers.get('content-type') || 'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-CHE-Voice': 'elevenlabs-mary',
      },
    });
  } catch (_) {
    // Credentials/quota/timeouts fall back to the existing voice. Never log keys.
    recordFailure(0, 'network', PAUSE_AFTER_TIMEOUT_MS);
    return null;
  }
}
