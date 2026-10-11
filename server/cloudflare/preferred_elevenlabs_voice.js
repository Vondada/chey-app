// Optional premium voice for CHE. An explicit owner opt-in is required even if
// the key is present. This never enables paid chat/model providers.
const enabled = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

export function preferredElevenLabsReady(env = {}) {
  return enabled(env.CHE_ELEVENLABS_PREFERRED)
    && Boolean(String(env.ELEVENLABS_API_KEY || '').trim())
    && /^[a-zA-Z0-9_-]{10,80}$/.test(String(env.CHE_ELEVENLABS_VOICE_ID || '').trim());
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
    if (!response.ok || !/^audio\//i.test(response.headers.get('content-type') || '')) return null;
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 6 * 1024 * 1024) return null;
    return new Response(bytes, {
      headers: {
        'Content-Type': response.headers.get('content-type') || 'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-CHE-Voice': 'elevenlabs-mary',
      },
    });
  } catch (_) {
    // Credentials/quota/timeouts fall back to the existing voice. Never log keys.
    return null;
  }
}
