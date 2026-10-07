// Hosted CHE voice. Microsoft Edge neural voices, no key.
// This does not invent audio. A failed call returns the error.

const TOKEN_URL = 'https://edge.microsoft.com/translate/auth';
const VOICE = 'en-US-AvaNeural';

export async function edgeVoice(env, text, fetcher = fetch) {
  const said = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!said) return { ok: false, error: 'Nothing to say.' };
  const voice = String(env.CHE_EDGE_VOICE || VOICE);
  try {
    const tokenResponse = await fetcher(TOKEN_URL);
    if (!tokenResponse.ok) return { ok: false, error: 'Edge voice token was refused.', voice };
    const token = (await tokenResponse.text()).trim();
    if (!token) return { ok: false, error: 'Edge voice token was empty.', voice };
    return {
      ok: true,
      voice,
      token_ready: true,
      note: 'Token came back. The worker still has to stream the speech socket before the phone can play Ava.',
    };
  } catch (_) {
    return { ok: false, error: 'Edge voice did not respond.', voice };
  }
}
