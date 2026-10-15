// Named voices the owner pastes in: an ElevenLabs or Fish Audio voice ID. Each ID is
// checked with the provider before it is saved, and the key stays on the Worker. A voice
// the account cannot use says why: not found, a paid plan, or a key problem.
import { ELEVEN_API, FISH_API, elevenDiagnosis, isVoiceId } from './voice_library.js';

export const SAVED_LIMIT = 20;
export const PRESETS = [
  { name: 'Connie', provider: 'elevenlabs', id: 'GO6k0TLODKW6FuTZ6xO5' },
  { name: 'Mike', provider: 'elevenlabs', id: 'zfc8CJQpe8Kqyl0vvCzo' },
];
const FISH_ID = /^[a-f0-9]{32}$/i;
const PROVIDERS = ['elevenlabs', 'fish'];

const clean = (value, max = 40) => String(value ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

async function bodyOf(reply) {
  if (typeof reply?.text !== 'function') return '';
  return reply.text().catch(() => '');
}

// Fish's IDs are 32 hex characters; ElevenLabs' are shorter letters and numbers.
export function suggestProvider(id) {
  return FISH_ID.test(String(id || '').trim()) ? 'fish' : 'elevenlabs';
}

export function validVoiceEntry(provider, id) {
  if (!PROVIDERS.includes(provider)) return false;
  if (provider === 'fish') return FISH_ID.test(String(id || ''));
  return isVoiceId(id);
}

// A paid plan is named by the provider. CHE says so and does not upgrade anything.
function paidPlan(status, body) {
  if (status === 402 || (status >= 400 && status < 500 && /paid_plan_required|payment_required|upgrade your subscription|library voice/i.test(body))) {
    return { ok: false, state: 'paid_plan', reason: 'This voice needs a paid ElevenLabs plan before it can speak through the API. Choose a voice you own, or upgrade your ElevenLabs plan yourself.' };
  }
  return null;
}

async function testElevenVoice(env, id, fetcher) {
  // One short sentence, to confirm speech. This is the only step that spends credits.
  const key = String(env.ELEVENLABS_API_KEY || '').trim();
  const reply = await fetcher(`${ELEVEN_API}/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Check.', model_id: String(env.CHE_ELEVENLABS_MODEL || 'eleven_flash_v2_5') }),
    signal: AbortSignal.timeout(8000),
  });
  if (reply.ok) {
    await reply.arrayBuffer().catch(() => null);
    return { ok: true, state: 'verified', name: '' };
  }
  const body = await bodyOf(reply);
  const paid = paidPlan(reply.status, body);
  if (paid) return paid;
  if (reply.status === 404) return { ok: false, state: 'not_found', reason: 'ElevenLabs has no voice with this ID that your account can use. Check the ID.' };
  const diagnosis = elevenDiagnosis(reply.status, body, env);
  return { ok: false, state: diagnosis.state === 'Needs Reconnect' ? 'needs_reconnect' : 'unavailable', reason: diagnosis.reason };
}

// ElevenLabs: the voice's own details first (no credits). If the key cannot read them, the
// check is "needs check" unless the owner has agreed to spend a few credits on a test sentence.
export async function verifyElevenVoice(env = {}, id, { fetcher = fetch, allowSpend = false } = {}) {
  const key = String(env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return { ok: false, state: 'needs_setup', reason: 'No ElevenLabs key is set on the Worker.' };
  let reply;
  try {
    reply = await fetcher(`${ELEVEN_API}/v1/voices/${encodeURIComponent(id)}`, {
      headers: { 'xi-api-key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    return { ok: false, state: 'unavailable', reason: error?.name === 'TimeoutError' ? 'ElevenLabs did not answer within 8 seconds.' : 'Could not reach ElevenLabs.' };
  }
  const body = await bodyOf(reply);
  if (reply.ok) {
    let name = '';
    try { name = clean(JSON.parse(body)?.name); } catch (_) { /* no name given */ }
    return { ok: true, state: 'verified', name };
  }
  if ((reply.status === 401 || reply.status === 403) && /missing_permissions|missing the permission/i.test(body)) {
    if (!allowSpend) {
      return { ok: false, state: 'needs_check', reason: 'CHE cannot read voice details with this ElevenLabs key. Saving sends one short test sentence (a few credits) to confirm the voice.' };
    }
    return testElevenVoice(env, id, fetcher);
  }
  const paid = paidPlan(reply.status, body);
  if (paid) return paid;
  if (reply.status === 404) return { ok: false, state: 'not_found', reason: 'ElevenLabs has no voice with this ID on your account. Check the ID, or add the voice to My Voices first.' };
  const diagnosis = elevenDiagnosis(reply.status, body, env);
  return { ok: false, state: diagnosis.state === 'Needs Reconnect' ? 'needs_reconnect' : 'unavailable', reason: diagnosis.reason };
}

// Fish Audio: the model's own details, read with the key. Fish speech needs no credit for this.
export async function verifyFishVoice(env = {}, id, { fetcher = fetch } = {}) {
  const key = String(env.FISH_API_KEY || '').trim();
  if (!key) return { ok: false, state: 'needs_setup', reason: 'No Fish Audio key is set on the Worker.' };
  let reply;
  try {
    reply = await fetcher(`${FISH_API}/model/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    return { ok: false, state: 'unavailable', reason: error?.name === 'TimeoutError' ? 'Fish Audio did not answer within 8 seconds.' : 'Could not reach Fish Audio.' };
  }
  if (reply.ok) {
    let name = '';
    try { name = clean(JSON.parse(await bodyOf(reply))?.title); } catch (_) { /* no title */ }
    return { ok: true, state: 'verified', name };
  }
  if (reply.status === 404) return { ok: false, state: 'not_found', reason: 'Fish Audio has no voice model with this ID on your account. Check the ID.' };
  if (reply.status === 401 || reply.status === 403) return { ok: false, state: 'needs_reconnect', reason: 'Fish Audio does not accept this key. Check FISH_API_KEY on the Worker.' };
  return { ok: false, state: 'unavailable', reason: `Fish Audio answered HTTP ${reply.status}.` };
}

export async function verifyVoice(env = {}, provider, id, options = {}) {
  if (!validVoiceEntry(provider, id)) {
    return { ok: false, state: 'invalid', reason: 'That is not a voice ID CHE can use. ElevenLabs IDs are letters and numbers; Fish Audio IDs are 32 letters and numbers.' };
  }
  return provider === 'fish' ? verifyFishVoice(env, id, options) : verifyElevenVoice(env, id, options);
}

// The saved list: the presets first on a new store, then the owner's own voices.
export function seedSaved(data = {}) {
  if (Array.isArray(data.voice_saved)) return data.voice_saved;
  return PRESETS.map((p) => ({ ...p, state: 'unverified', reason: '', verified_at: null, preset: true }));
}

export function upsertSaved(saved = [], entry) {
  const others = saved.filter((s) => !(s.provider === entry.provider && s.id === entry.id));
  return [entry, ...others].slice(0, SAVED_LIMIT);
}

export function findSaved(saved = [], provider, id) {
  return saved.find((s) => s.provider === provider && s.id === id) || null;
}

// A saved voice can be used when the provider has confirmed it or it has not been able to
// be checked yet. A voice found missing or on a paid plan cannot be used until it is fixed.
export function usableSaved(entry) {
  return Boolean(entry) && (entry.state === 'verified' || entry.state === 'needs_check');
}

export { clean as cleanVoiceName };

// The voice in use now, for the Voice IDs page. Null means CHE's built-in voice.
export function activeVoice(data = {}) {
  const choice = data.voice_choice;
  return choice?.provider && choice?.id ? { provider: choice.provider, id: choice.id, name: choice.name || '' } : null;
}
