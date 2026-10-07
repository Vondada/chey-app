// The five most-starred voice repos. Only edge-tts speaks with no server of ours.
// The other four speak only when their CHE_*_URL returns audio.

export const TOP_VOICES = [
  { id: 'gpt-sovits', name: 'GPT-SoVITS', repo: 'https://github.com/RVC-Boss/GPT-SoVITS', env: 'CHE_GPT_SOVITS_URL', local: true },
  { id: 'rtvc', name: 'Real-Time-Voice-Cloning', repo: 'https://github.com/CorentinJ/Real-Time-Voice-Cloning', env: 'CHE_RTVC_URL', local: true },
  { id: 'voicebox', name: 'Voicebox', repo: 'https://github.com/jamiepine/voicebox', env: 'CHE_VOICEBOX_URL', local: true },
  { id: 'voicestudio', name: 'VoiceStudio', repo: 'https://github.com/debpalash/VoiceStudio', env: 'CHE_VOICESTUDIO_URL', local: true },
  { id: 'coqui', name: 'Coqui TTS', repo: 'https://github.com/coqui-ai/TTS', env: 'CHE_COQUI_URL', local: true },
  { id: 'edge', name: 'Edge neural', repo: 'https://github.com/rany2/edge-tts', env: '', local: false },
];

export function voiceStatus(env = {}) {
  return TOP_VOICES.map((voice) => ({
    id: voice.id,
    name: voice.name,
    repo: voice.repo,
    ready: voice.id === 'edge' || Boolean(String(env[voice.env] || '').trim()),
    reason: voice.id === 'edge' ? 'Microsoft neural voice, no key' : (env[voice.env] ? 'Server URL set' : `Needs ${voice.env}`),
  }));
}

export async function speakWithVoice(env, { voice = 'edge', text, voiceName = 'en-US-AvaNeural' } = {}, fetcher = fetch) {
  const said = String(text || '').trim();
  if (!said) return { ok: false, error: 'Nothing to say.' };
  const picked = TOP_VOICES.find((item) => item.id === voice) || TOP_VOICES[5];
  if (picked.id !== 'edge') {
    const url = String(env[picked.env] || '').trim();
    if (!url) return { ok: false, error: `${picked.name} is not connected. Set ${picked.env}.`, voice: picked.id };
    const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: said }) });
    if (!response.ok) return { ok: false, error: `${picked.name} did not return audio.`, voice: picked.id };
    return { ok: true, voice: picked.id, audio: true };
  }
  return { ok: true, voice: 'edge', voice_name: voiceName, note: 'Call edge-tts on the worker with this voice name. No audio was invented here.' };
}
