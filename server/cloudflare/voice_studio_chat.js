// Voice Studio in chat: the owner's spoken requests about his voice library. Each
// action runs against the provider's account and reports its real result. No speech
// model is called and no credits are spent: previews are the provider's free samples,
// and a voice is saved only after the account confirms it.
import { VOICE_PREF_KEY, availableVoiceChoices, saveVoiceChoice, validateVoiceChoice } from './voice_choices.js';
import { VOICE_NAMED, fetchElevenLibrary, fetchElevenModels, fetchFishModels, filterLibrary, mightBeVoiceRequest, normalizeVoiceRequest, voiceStudioIntent } from './voice_library.js';

export const STUDIO_LAST_KEY = 'voice_studio_last';
const DEFAULT_MODEL = 'eleven_flash_v2_5';
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
    if (ctx.library.state !== 'Connected' && VOICE_NAMED.test(normalizeVoiceRequest(message))) {
      return { ok: false, reply: `I cannot read your voice library right now, sir. ${ctx.library.reason} Nothing changed.` };
    }
    // Names come from both accounts, so "use <Fish name>" works as it does for ElevenLabs.
    ctx.fish = await fetchFishModels(env, { fetcher, own: true });
    const names = [
      ...(ctx.data.voice_saved || []).map((s) => s.name),
      ...ctx.library.voices.map((v) => v.name),
      ...ctx.fish.models.map((m) => m.name),
    ];
    intent = voiceStudioIntent(message, { last, names });
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
  await saveVoiceChoice(ctx.storage, ctx.data);
}

const PROVIDER_NAME = { elevenlabs: 'ElevenLabs', fish: 'Fish Audio' };
const voiceName = (v) => `${v.name || 'an unnamed voice'} (${PROVIDER_NAME[v.provider] || v.provider || 'unknown provider'})`;
const dateOf = (ms) => (Number(ms) > 1e12 ? new Date(Number(ms)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

// The saved choice and what it replaced, from CHE's own voice record only: no provider call, no guess.
async function currentVoice(ctx) {
  let pref = null;
  try { pref = await ctx.storage.get(VOICE_PREF_KEY); } catch (_) { pref = null; }
  const choice = pref?.choice || ctx.data.voice_choice || null;
  const source = 'Where I found it: my saved voice setting on the Worker. I did not call ElevenLabs or search conversation memories for this.';
  if (!choice) return { ok: true, reply: `No voice choice is saved, sir, so I speak with my default voice. ${source}` };
  const changed = dateOf(pref?.at || ctx.data.voice_choice_at);
  const parts = [`My saved voice is ${voiceName(choice)}${changed ? `; the setting was last changed ${changed}` : ''}.`];
  const before = pref?.before_fish ?? ctx.data.voice_choice_before_fish ?? null;
  if (choice.provider === 'fish' && before?.provider === 'elevenlabs') parts.push(`The ElevenLabs voice kept for when you switch back is ${voiceName(before)}.`);
  parts.push(pref?.previous
    ? `It replaced ${voiceName(pref.previous)}${dateOf(pref.replaced_at) ? ` on ${dateOf(pref.replaced_at)}` : ''}.`
    : 'My saved setting does not record which voice it replaced, so I will not guess.');
  return { ok: true, reply: `${parts.join(' ')} ${source}` };
}

async function act(intent, ctx) {
  switch (intent.kind) {
    case 'current': return currentVoice(ctx);
    case 'list': return listVoices(intent.provider, ctx);
    case 'refresh': return refreshVoices(ctx);
    case 'provider': return switchProvider(intent.provider, ctx);
    case 'save': return saveSelected(ctx);
    case 'control': return changeSetting(intent, ctx);
    case 'boost': return changeSetting(intent, ctx);
    case 'model': return changeModel(intent.spoken, ctx);
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
  // The owner's saved voices are named first, so "use Mike" works without the library list.
  const saved = (ctx.data.voice_saved || []).find((s) => s.name === name);
  if (saved) return { provider: saved.provider, id: saved.id, name: saved.name };
  const library = await libraryFor(ctx);
  const eleven = library.voices.find((v) => v.name === name);
  if (eleven) return { provider: 'elevenlabs', id: eleven.id, name: eleven.name };
  const fish = (ctx.fish?.models || []).find((m) => m.name === name);
  return fish ? { provider: 'fish', id: fish.id, name: fish.name } : null;
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
    // The ElevenLabs voice the owner had before Fish is restored, not left unset.
    const before = ctx.data.voice_choice_before_fish ?? null;
    if (before) ctx.data.voice_choice = before;
    else delete ctx.data.voice_choice;
    delete ctx.data.voice_choice_before_fish;
    await saveVoiceChoice(ctx.storage, ctx.data);
    return { ok: true, reply: 'Switched back to ElevenLabs, sir. Fish Audio is no longer first.' };
  }
  const choices = await availableVoiceChoices(ctx.env, ctx.fetcher, ctx.data.voice_saved);
  if (choices.fish !== 'Connected') return { ok: false, reply: 'Fish Audio is not set up for CHE, sir. Nothing changed.' };
  const fish = choices.options.find((o) => o.provider === 'fish');
  if (!fish) return { ok: false, reply: 'Fish Audio has no voice on this account yet, sir. Nothing changed.' };
  const chosen = validateVoiceChoice({ provider: 'fish', id: fish.id, speed: ctx.data.voice_choice?.speed ?? 1 }, choices);
  if (!chosen) return { ok: false, reply: 'That Fish Audio voice is not available, sir. Nothing changed.' };
  // The ElevenLabs voice is kept, so switching back to ElevenLabs restores it.
  if (ctx.data.voice_choice?.provider !== 'fish') ctx.data.voice_choice_before_fish = ctx.data.voice_choice ?? null;
  await setChoice(ctx, { ...chosen, name: fish.name });
  return { ok: true, reply: `Switched to Fish Audio, sir: ${fish.name}. Fish is first now, with ElevenLabs as backup.` };
}

// The voice is saved as CHE's choice after the account confirms it. Speed, model and
// settings the owner already chose are kept when the provider stays ElevenLabs.
async function useVoice(voice, ctx) {
  if (!voice) return { ok: false, reply: 'I did not find that voice in your library, sir. Nothing changed.' };
  const choices = await availableVoiceChoices(ctx.env, ctx.fetcher, ctx.data.voice_saved);
  const current = ctx.data.voice_choice || {};
  const carry = voice.provider === 'elevenlabs' && current.provider === 'elevenlabs'
    ? { model_id: current.model_id, settings: current.settings } : {};
  const chosen = validateVoiceChoice({ provider: voice.provider, id: voice.id, speed: current.speed ?? 1, ...carry }, choices);
  if (!chosen) {
    // A library voice CHE has not saved can be used only after it is saved by its ID.
    const saved = (ctx.data.voice_saved || []).some((s) => s.id === voice.id);
    if (voice.provider === 'elevenlabs' && !saved) {
      return { ok: false, reply: `${voice.name} is in your library, sir, but CHE can use it only once it is saved. Paste its voice ID in Voice IDs and press Save and Use Voice. Nothing changed.` };
    }
    return { ok: false, reply: `${voice.name} is not available on your account right now, sir. Nothing changed.` };
  }
  await setChoice(ctx, { ...chosen, name: voice.name });
  await remember(ctx, { selected: { provider: voice.provider, id: voice.id, name: voice.name } });
  return { ok: true, reply: `${voice.name} is now CHE's voice for Chat, voice conversations and Read This, sir.` };
}

// A free sample only. Nothing is generated, so no credits are used. A voice without a
// published sample is said so, and nothing else is played in its place.
async function previewVoice(voice, ctx) {
  if (!voice) return { ok: false, reply: 'I did not find that voice in your library, sir. Nothing was played.' };
  if (voice.provider === 'fish') {
    return { ok: false, reply: `Fish Audio has no free sample for ${voice.name} here, sir. Say use ${voice.name} to choose it. Nothing was played.` };
  }
  const library = await libraryFor(ctx);
  const entry = library.voices.find((v) => v.id === voice.id) || null;
  if (!entry) return { ok: false, reply: `${voice.name} is not on your account any more, sir. Nothing was played.` };
  await remember(ctx, { selected: { provider: voice.provider, id: voice.id, name: voice.name } });
  if (!entry.preview) {
    return { ok: false, reply: `ElevenLabs publishes no free sample for ${voice.name}, sir. Nothing was played and no credits were used.` };
  }
  return { ok: true, reply: `Here is the free sample of ${voice.name}, sir. Say save this as your voice to keep it.`, preview: { provider: 'elevenlabs', voice_id: entry.id } };
}

// The owner's spoken settings. Each change goes through the same validator the panel uses,
// against the chosen model's own flags; nothing is saved when a check fails.
async function changeSetting(intent, ctx) {
  const current = ctx.data.voice_choice;
  if (!current || current.provider !== 'elevenlabs') {
    return { ok: false, reply: 'Choose an ElevenLabs voice first, sir, so I know which settings to change. Nothing changed.' };
  }
  const models = await fetchElevenModels(ctx.env, { fetcher: ctx.fetcher });
  if (models.state !== 'Connected') return { ok: false, reply: `I cannot read the speech models right now, sir. ${models.reason} Nothing changed.` };
  const model = models.models.find((m) => m.id === (current.model_id || DEFAULT_MODEL)) || models.models[0];
  if (!model) return { ok: false, reply: 'I cannot find a speech model for this voice, sir. Nothing changed.' };
  const label = current.name || 'this voice';
  const next = { speed: current.speed ?? 1, settings: { ...(current.settings || {}) } };
  if (intent.kind === 'boost') {
    next.settings.use_speaker_boost = intent.on;
  } else if (intent.name === 'speed') {
    const speed = intent.percent ? intent.value / 100 : intent.value;
    if (speed < 0.7 || speed > 1.2) return { ok: false, reply: 'Speaking speed must be between 0.7 and 1.2, sir. Nothing changed.' };
    next.speed = speed;
  } else {
    // "60 percent" or "0.6": a number above 1 is read as a percentage.
    const fraction = intent.percent || intent.value > 1 ? intent.value / 100 : intent.value;
    next.settings[intent.name === 'similarity' ? 'similarity_boost' : intent.name] = fraction;
  }
  const choices = await availableVoiceChoices(ctx.env, ctx.fetcher, ctx.data.voice_saved);
  const chosen = validateVoiceChoice({ provider: 'elevenlabs', id: current.id, speed: next.speed, model_id: model.id, settings: next.settings }, choices);
  if (!chosen) return { ok: false, reply: `That setting is not allowed for ${model.name}, sir. Nothing changed.` };
  await setChoice(ctx, { ...chosen, name: current.name });
  if (intent.kind === 'boost') return { ok: true, reply: `Speaker boost is ${intent.on ? 'on' : 'off'} for ${label}, sir.` };
  if (intent.name === 'speed') return { ok: true, reply: `Speaking speed is ${chosen.speed.toFixed(2)} for ${label}, sir.` };
  const key = intent.name === 'similarity' ? 'similarity_boost' : intent.name;
  return { ok: true, reply: `${intent.name[0].toUpperCase()}${intent.name.slice(1)} is ${Math.round(chosen.settings[key] * 100)} percent for ${label}, sir.` };
}

// A speech model the account lists. A name it does not match is not a voice request, so null
// goes on to chat. The settings the new model cannot use are dropped, and the rest are checked.
async function changeModel(spoken, ctx) {
  const models = await fetchElevenModels(ctx.env, { fetcher: ctx.fetcher });
  if (models.state !== 'Connected') return { ok: false, reply: `I cannot read the speech models right now, sir. ${models.reason} Nothing changed.` };
  const wanted = spoken.toLowerCase();
  const model = models.models.find((m) => m.name.toLowerCase() === wanted)
    || models.models.find((m) => m.name.toLowerCase().includes(wanted) || m.id.toLowerCase().includes(wanted.replace(/\s+/g, '_')));
  if (!model) return null;
  const current = ctx.data.voice_choice;
  if (!current || current.provider !== 'elevenlabs') {
    return { ok: false, reply: 'Choose an ElevenLabs voice first, sir, then choose its speech model. Nothing changed.' };
  }
  const settings = { ...(current.settings || {}) };
  if (!model.controls.style) delete settings.style;
  if (!model.controls.use_speaker_boost) delete settings.use_speaker_boost;
  const choices = await availableVoiceChoices(ctx.env, ctx.fetcher, ctx.data.voice_saved);
  const chosen = validateVoiceChoice({ provider: 'elevenlabs', id: current.id, speed: current.speed ?? 1, model_id: model.id, settings }, choices);
  if (!chosen) return { ok: false, reply: `${current.name || 'That voice'} cannot use ${model.name} right now, sir. Nothing changed.` };
  await setChoice(ctx, { ...chosen, name: current.name });
  return { ok: true, reply: `${current.name || 'This voice'} will speak with ${model.name}, sir. ${model.explanation}` };
}

async function saveSelected(ctx) {
  const selected = ctx.last?.selected;
  if (!selected) return { ok: false, reply: 'Preview or use a voice first, sir, then say save this as your voice. Nothing changed.' };
  const result = await useVoice({ provider: selected.provider, id: selected.id, name: selected.name }, ctx);
  if (!result.ok) return result;
  return { ok: true, reply: `Saved ${selected.name} as CHE's voice, sir. Chat, voice conversations and Read This will use it now.` };
}
