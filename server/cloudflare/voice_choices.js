// CHE voice choices. Every selected ElevenLabs voice is verified against the
// account's own API before it may be saved. No keys, fake voices or arbitrary
// paid-provider IDs are sent to the phone.
const VOICE_ID = /^[A-Za-z0-9_-]{10,80}$/;
const name = (x) => String(x || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 75);

export function parseElevenVoices(payload) {
  return (Array.isArray(payload?.voices) ? payload.voices : [])
    .filter((v) => VOICE_ID.test(String(v?.voice_id || '')))
    .slice(0, 80)
    .map((v) => ({ id: String(v.voice_id), name: name(v.name) || 'Unnamed voice', provider: 'elevenlabs' }));
}

export async function availableVoiceChoices(env = {}, fetcher = fetch) {
  const options = [];
  let elevenStatus = 'Needs Setup';
  if (String(env.ELEVENLABS_API_KEY || '').trim()) {
    try {
      const reply = await fetcher('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': String(env.ELEVENLABS_API_KEY), Accept: 'application/json' },
        signal: AbortSignal.timeout(7000),
      });
      if (!reply.ok) {
        elevenStatus = reply.status === 401 ? 'Needs Reconnect' : 'Unavailable';
      } else {
        options.push(...parseElevenVoices(await reply.json()));
        elevenStatus = options.length ? 'Connected' : 'Unavailable';
      }
    } catch (_) {
      elevenStatus = 'Unavailable';
    }
  }
  // Fish's one configured voice is supported; do not invent or expose a list.
  const fishReady = Boolean(String(env.FISH_API_KEY || '').trim())
    && /^[A-Za-z0-9_-]{8,80}$/.test(String(env.CHE_FISH_VOICE_ID || '').trim())
    && ['1', 'true', 'yes'].includes(String(env.CHE_FISH_PREFERRED || '').toLowerCase());
  if (fishReady) options.push({ id: 'configured', name: 'CHE Fish voice (configured)', provider: 'fish' });
  return { options, elevenlabs: elevenStatus, fish: fishReady ? 'Connected' : 'Needs Setup' };
}

export function validateVoiceChoice(requested, available) {
  const provider = String(requested?.provider || '');
  const id = String(requested?.id || '');
  const speed = Number(requested?.speed ?? 1);
  if (!Number.isFinite(speed) || speed < 0.7 || speed > 1.2) return null;
  if (!available?.options?.some((v) => v.provider === provider && v.id === id)) return null;
  return { provider, id, speed: Math.round(speed * 100) / 100 };
}

export function voiceEnvForSelection(env, selected) {
  if (!selected || selected.provider !== 'elevenlabs' || !VOICE_ID.test(selected.id)) return env;
  const overlay = Object.create(env);
  overlay.CHE_ELEVENLABS_VOICE_ID = selected.id;
  overlay.CHE_VOICE_SPEED = String(selected.speed || 1);
  return overlay;
}
