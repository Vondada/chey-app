// Voice Studio in chat: the owner's spoken requests about his voice library. Each
// action runs against the provider's account and reports its real result. No speech
// model is called and no credits are spent: previews are the provider's free samples,
// and a voice is saved only after the account confirms it.
import { availableVoiceChoices, validateVoiceChoice } from './voice_choices.js';
import { fetchElevenLibrary, fetchFishModels, filterLibrary, mightBeVoiceRequest, normalizeVoiceRequest, voiceStudioIntent } from './voice_library.js';

export const STUDIO_LAST_KEY = 'voice_studio_last';
const LAST_MS = 30 * 60_000;
const SPOKEN_ROWS = 12;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The turn. Returns null when the message is not a voice request, so it goes to chat.
export async function voiceStudioTurn(storage, data, env, message, { fetcher = fetch, now = Date.now() } = {}) {
  if (!mightBeVoiceRequest(message)) return null;
  const stored = await storage.get(STUDIO_LAST_KEY);
  const last = stored && now - Date.parse(stored.at) < LAST_MS ? stored : null;
  let intent = voiceStudioIntent(message, { last });
  if (!intent) return null;
  const ctx = { storage, data, env, fetcher, now, last, library: null };
  if (intent.kind === 'needs_names') {
    ctx.library = await fetchElevenLibrary(env, { fetcher });
    // With the library unreadable, a request that names a voice or a provider says why. Other
    // "switch to …" or "use …" talk (trading, the apps) is not a voice request and goes on to chat.
    if (ctx.library.state !== 'Connected' && /\b(?:voices?|elevenlabs|eleven labs|fish)\b/.test(normalizeVoiceRequest(message))) {
      return { ok: false, reply: `I cannot read your voice library right now, sir. ${ctx.library.reason} Nothing changed.` };
    }
    intent = voiceStudioIntent(message, { last, names: ctx.library.voices.map((v) => v.name) });
    if (!intent) return null;
  }
  return act(intent, ctx);
}

async function libraryFor(ctx) {
  if (!ctx.library) ctx.library = await fetchElevenLibrary(ctx.env, { fetcher: ctx.fetcher });
  return ctx.library;
}

async function remember(ctx, patch) {
  const next = { at: new Date(ctx.now).toISOString(), items: [], selected: null, ...(ctx.last || {}), ...patch };
  await ctx.storage.put(STUDIO_LAST_KEY, next);
  ctx.last = next;
}

async function setChoice(ctx, choice) {
  ctx.data.voice_choice = choice;
  await ctx.storage.put('che', ctx.data);
}

async function act(intent, ctx) {
  switch (intent.kind) {
    case 'list': return listVoices(intent.provider, ctx);
    case 'refresh': return refreshVoices(ctx);
    case 'provider': return switchProvider(intent.provider, ctx);
    case 'save': return saveSelected(ctx);
    case 'use': return useVoice(intent.voice, ctx);
    case 'use_name': return useVoice(await voiceNamed(intent.name, ctx), ctx);
    case 'preview': return previewVoice(intent.voice, ctx);
    case 'preview_name': return previewVoice(await voiceNamed(intent.name, ctx), ctx);
    case 'needs_list': return { ok: false, reply: 'Show your voice library first, sir, so I can number the voices. Say: show my ElevenLabs library.' };
    case 'bad_number': return { ok: false, reply: `There are ${plural(intent.count, 'voice')} in the list I read, sir. Choose a number from 1 to ${intent.count}.` };
    case 'unknown_name': return { ok: false, reply: `I did not find ${intent.spoken} in your voice library, sir. Nothing changed. Say show my ElevenLabs library to hear the names.` };
    default: return { ok: false, reply: 'I did not understand that voice request, sir. Nothing changed.' };
  }
}

async function voiceNamed(name, ctx) {
  const library = await libraryFor(ctx);
  return library.voices.find((v) => v.name === name) || null;
}

async function listVoices(provider, ctx) {
  if (provider === 'fish') {
    const fish = await fetchFishModels(ctx.env, { fetcher: ctx.fetcher, own: true });
    if (fish.state !== 'Connected') return { ok: false, reply: `I could not read your Fish Audio voices, sir. ${fish.reason}` };
    if (!fish.models.length) return { ok: false, reply: 'Fish Audio has no voice models on this account yet, sir. Nothing changed.' };
    const items = fish.models.map((m) => ({ provider: 'fish', id: m.id, name: m.name }));
    await remember(ctx, { kind: 'list', provider: 'fish', items: items.slice(0, 50) });
    return { ok: true, reply: spokenList(`Your Fish Audio voices`, items, fish.complete === false) };
  }
  const library = await libraryFor(ctx);
  if (library.state !== 'Connected') return { ok: false, reply: `I could not read your ElevenLabs voices, sir. ${library.reason}` };
  const ordered = filterLibrary(library.voices);
  const items = ordered.map((v) => ({ provider: 'elevenlabs', id: v.id, name: v.name, source: v.source, preview: Boolean(v.preview) }));
  await remember(ctx, { kind: 'list', provider: 'elevenlabs', items: items.slice(0, 50) });
  const head = `Your ElevenLabs library has ${plural(items.length, 'voice')}${library.complete ? '' : ', and ElevenLabs had more pages than I could read'}, sir.`;
  return { ok: true, reply: spokenList(head, items, false) };
}

// The first rows are read out and shown. The full list is still numbered in memory, so
// "preview number nine" works for any row, and a name works for every voice.
function spokenList(head, items, incomplete) {
  const groups = { mine: 'My Voices', library: 'Voice Library', default: 'Built in' };
  const rows = items.slice(0, SPOKEN_ROWS).map((v, i) => `${i + 1}, ${v.name}${v.source ? `, ${groups[v.source] || v.source}` : ''}`);
  const more = items.length > SPOKEN_ROWS ? ` I can read the first ${SPOKEN_ROWS}; ask for any voice by name.` : '';
  const partial = incomplete ? ' The list may be incomplete.' : '';
  return `${head}${partial} ${rows.join('. ')}.${more} Say preview number three, or use a name. Say save this as your voice to keep one.`;
}

async function refreshVoices(ctx) {
  ctx.library = null;
  const library = await libraryFor(ctx);
  if (library.state !== 'Connected') return { ok: false, reply: `The voice library was not refreshed, sir. ${library.reason}` };
  return { ok: true, reply: `The voice library is refreshed, sir: ${plural(library.voices.length, 'voice')}${library.complete ? '' : ', and the list may be incomplete'}.` };
}

async function switchProvider(provider, ctx) {
  if (provider === 'elevenlabs') {
    if (ctx.data.voice_choice?.provider === 'elevenlabs' || !ctx.data.voice_choice) {
      return { ok: true, reply: 'CHE already speaks with ElevenLabs, sir. Say show my ElevenLabs library to choose a voice.' };
    }
    delete ctx.data.voice_choice;
    await ctx.storage.put('che', ctx.data);
    return { ok: true, reply: 'Switched back to ElevenLabs, sir. Fish Audio is no longer first.' };
  }
  const choices = await availableVoiceChoices(ctx.env, ctx.fetcher);
  if (choices.fish !== 'Connected') return { ok: false, reply: 'Fish Audio is not set up for CHE, sir. Nothing changed.' };
  const fish = choices.options.find((o) => o.provider === 'fish');
  if (!fish) return { ok: false, reply: 'Fish Audio has no voice on this account yet, sir. Nothing changed.' };
  const chosen = validateVoiceChoice({ provider: 'fish', id: fish.id, speed: ctx.data.voice_choice?.speed ?? 1 }, choices);
  if (!chosen) return { ok: false, reply: 'That Fish Audio voice is not available, sir. Nothing changed.' };
  await setChoice(ctx, { ...chosen, name: fish.name });
  return { ok: true, reply: `Switched to Fish Audio, sir: ${fish.name}. Fish is first now, with ElevenLabs as backup.` };
}

// The voice is saved as CHE's choice after the account confirms it. Speed, model and
// settings the owner already chose are kept when the provider stays ElevenLabs.
async function useVoice(voice, ctx) {
  if (!voice) return { ok: false, reply: 'I did not find that voice in your library, sir. Nothing changed.' };
  const choices = await availableVoiceChoices(ctx.env, ctx.fetcher);
  const current = ctx.data.voice_choice || {};
  const carry = voice.provider === 'elevenlabs' && current.provider === 'elevenlabs'
    ? { model_id: current.model_id, settings: current.settings } : {};
  const chosen = validateVoiceChoice({ provider: voice.provider, id: voice.id, speed: current.speed ?? 1, ...carry }, choices);
  if (!chosen) return { ok: false, reply: `${voice.name} is not available on your account right now, sir. Nothing changed.` };
  await setChoice(ctx, { ...chosen, name: voice.name });
  await remember(ctx, { selected: { provider: voice.provider, id: voice.id, name: voice.name } });
  return { ok: true, reply: `${voice.name} is now CHE's voice for Chat, voice conversations and Read This, sir.` };
}

// A free sample only. Nothing is generated, so no credits are used. A voice without a
// published sample is said so, and nothing else is played in its place.
async function previewVoice(voice, ctx) {
  if (!voice) return { ok: false, reply: 'I did not find that voice in your library, sir. Nothing was played.' };
  const library = await libraryFor(ctx);
  const entry = library.voices.find((v) => v.id === voice.id) || null;
  if (!entry) return { ok: false, reply: `${voice.name} is not on your account any more, sir. Nothing was played.` };
  await remember(ctx, { selected: { provider: voice.provider, id: voice.id, name: voice.name } });
  if (!entry.preview) {
    return { ok: false, reply: `ElevenLabs publishes no free sample for ${voice.name}, sir. Nothing was played and no credits were used.` };
  }
  return { ok: true, reply: `Here is the free sample of ${voice.name}, sir. Say save this as your voice to keep it.`, preview: { provider: 'elevenlabs', voice_id: entry.id } };
}

async function saveSelected(ctx) {
  const selected = ctx.last?.selected;
  if (!selected) return { ok: false, reply: 'Preview or use a voice first, sir, then say save this as your voice. Nothing changed.' };
  const result = await useVoice({ provider: selected.provider, id: selected.id, name: selected.name }, ctx);
  if (!result.ok) return result;
  return { ok: true, reply: `Saved ${selected.name} as CHE's voice, sir. Chat, voice conversations and Read This will use it now.` };
}
