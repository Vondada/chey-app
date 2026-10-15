// CHE voice choices. Every selected voice is checked against the provider's own
// account (ElevenLabs' current voice API, Fish Audio's model list) before it may be
// saved. No keys, invented voices or arbitrary provider IDs are sent to the phone.
import { fetchElevenLibrary, fetchElevenModels, fetchFishModels, isVoiceId, validateElevenSettings } from './voice_library.js';

const VOICE_ID = /^[A-Za-z0-9_-]{10,80}$/;
const enabled = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

export function parseElevenVoices(payload) {
  return (Array.isArray(payload?.voices) ? payload.voices : [])
    .filter((v) => VOICE_ID.test(String(v?.voice_id || '')))
    .slice(0, 80)
    .map((v) => ({ id: String(v.voice_id), name: String(v.name || 'Unnamed voice').slice(0, 75), provider: 'elevenlabs' }));
}

export async function availableVoiceChoices(env = {}, fetcher = fetch, saved = []) {
  const options = [];
  let elevenStatus = 'Needs Setup';
  let elevenReason = '';
  let elevenComplete = false;
  const elevenOptedIn = enabled(env.CHE_ELEVENLABS_PREFERRED);
  const hasElevenKey = Boolean(String(env.ELEVENLABS_API_KEY || '').trim());
  let models = { elevenlabs: [], fish: [] };
  if (hasElevenKey && elevenOptedIn) {
    const library = await fetchElevenLibrary(env, { fetcher });
    elevenStatus = library.state;
    elevenReason = library.reason || '';
    elevenComplete = library.complete === true;
    for (const voice of library.voices) {
      options.push({ id: voice.id, name: voice.name, provider: 'elevenlabs', source: voice.source, category: voice.category, preview: voice.preview ? true : false });
    }
    const speech = await fetchElevenModels(env, { fetcher });
    models = { ...models, elevenlabs: speech.models };
  }
  // Fish's configured voice is always offered once set up. Fish's own models on the
  // account join it when the owner has opted in to Fish.
  const fishKey = Boolean(String(env.FISH_API_KEY || '').trim());
  const fishConfigured = fishKey
    && /^[A-Za-z0-9_-]{8,80}$/.test(String(env.CHE_FISH_VOICE_ID || '').trim())
    && enabled(env.CHE_FISH_PREFERRED);
  let fishStatus = 'Needs Setup';
  if (fishConfigured) {
    options.push({ id: 'configured', name: 'CHE Fish voice (configured)', provider: 'fish', source: 'mine', category: 'configured' });
    fishStatus = 'Connected';
  }
  if (fishKey && enabled(env.CHE_FISH_PREFERRED)) {
    const fish = await fetchFishModels(env, { fetcher, own: true });
    for (const model of fish.models) options.push({ id: model.id, name: model.name, provider: 'fish', source: 'mine', category: 'model' });
    models = { ...models, fish: fish.models };
    if (!fishConfigured) fishStatus = fish.state === 'Connected' ? 'Connected' : fish.state;
  }
  // The owner's own named voices are offered whenever their provider's key is set, even when
  // the library list cannot be read: a voice saved by its ID does not depend on that list.
  // A voice the provider has refused is not offered.
  const refused = ['not_found', 'paid_plan', 'invalid', 'needs_reconnect'];
  for (const entry of Array.isArray(saved) ? saved : []) {
    const keyed = (entry.provider === 'elevenlabs' && hasElevenKey) || (entry.provider === 'fish' && fishKey);
    if (!keyed || refused.includes(entry.state)) continue;
    if (options.some((o) => o.provider === entry.provider && o.id === entry.id)) continue;
    options.push({ id: entry.id, name: entry.name, provider: entry.provider, source: 'mine', category: 'saved' });
  }
  return {
    options,
    models,
    elevenlabs: elevenStatus,
    elevenlabs_reason: elevenReason,
    elevenlabs_complete: elevenComplete,
    fish: fishStatus,
  };
}

// The requested voice must be one the account listed, the speed in range, and any
// model and settings allowed by that model's own flags. Anything else is refused.
export function validateVoiceChoice(requested, available) {
  const provider = String(requested?.provider || '');
  const id = String(requested?.id || '');
  const speed = Number(requested?.speed ?? 1);
  if (!Number.isFinite(speed) || speed < 0.7 || speed > 1.2) return null;
  if (!available?.options?.some((v) => v.provider === provider && v.id === id)) return null;
  const choice = { provider, id, speed: Math.round(speed * 100) / 100 };
  const modelId = requested?.model_id === undefined || requested?.model_id === null ? '' : String(requested.model_id);
  // Settings belong to a model: they are checked against it, so they cannot arrive without one.
  if (!modelId && requested?.settings !== undefined && requested?.settings !== null) return null;
  if (modelId) {
    if (provider !== 'elevenlabs') return null;
    const model = (available?.models?.elevenlabs || []).find((m) => m.id === modelId);
    if (!model) return null;
    choice.model_id = model.id;
    const settings = validateElevenSettings(requested?.settings || {}, model);
    if (settings === null) return null;
    if (Object.keys(settings).length) choice.settings = settings;
  }
  return choice;
}

export function voiceEnvForSelection(env, selected) {
  if (!selected) return env;
  if (selected.provider === 'elevenlabs' && VOICE_ID.test(selected.id)) {
    const overlay = Object.create(env);
    overlay.CHE_ELEVENLABS_VOICE_ID = selected.id;
    overlay.CHE_VOICE_SPEED = String(selected.speed || 1);
    if (selected.model_id) overlay.CHE_ELEVENLABS_MODEL = String(selected.model_id);
    const settings = selected.settings || {};
    const names = { stability: 'CHE_VOICE_STABILITY', similarity_boost: 'CHE_VOICE_SIMILARITY', style: 'CHE_VOICE_STYLE' };
    for (const [key, envName] of Object.entries(names)) {
      if (settings[key] !== undefined) overlay[envName] = String(settings[key]);
    }
    if (settings.use_speaker_boost !== undefined) overlay.CHE_VOICE_SPEAKER_BOOST = settings.use_speaker_boost ? '1' : '0';
    return overlay;
  }
  if (selected.provider === 'fish' && selected.id === 'configured') {
    const overlay = Object.create(env);
    overlay.CHE_FISH_SPEED = String(selected.speed || 1);
    return overlay;
  }
  if (selected.provider === 'fish' && isVoiceId(selected.id)) {
    const overlay = Object.create(env);
    overlay.CHE_FISH_VOICE_ID = selected.id;
    overlay.CHE_FISH_SPEED = String(selected.speed || 1);
    return overlay;
  }
  return env;
}
