// The owner's voice library. Every voice comes from the connected provider's own
// API, read live on each request: My Voices, saved Voice Library voices, and the
// account's built-in voices. Nothing here is a fixed list of voices, so a voice
// added to ElevenLabs shows on the next refresh, with no code change or deploy.
// Keys and raw provider text never leave this module.
import { elevenLabsRefusalReason } from './preferred_elevenlabs_voice.js';
import { withoutProhibitions } from './owner_action_gate.js';

export const ELEVEN_API = 'https://api.elevenlabs.io';
export const FISH_API = 'https://api.fish.audio';
export const LIBRARY_PAGE_SIZE = 100;
export const LIBRARY_MAX_PAGES = 20;
export const FAVORITES_LIMIT = 50;
const VOICE_ID = /^[A-Za-z0-9_-]{10,80}$/;
const MODEL_ID = /^[A-Za-z0-9_.-]{2,80}$/;
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const SOURCE_ORDER = { mine: 0, library: 1, default: 2 };

const clean = (value, max = 75) => String(value ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// A refused reply's text, or '' when the reply has no body to read.
async function readBody(reply) {
  if (typeof reply?.text !== 'function') return '';
  return reply.text().catch(() => '');
}

export function isVoiceId(value) {
  return VOICE_ID.test(String(value || ''));
}

// ElevenLabs says why a key is refused. Its 401 names a missing permission or an
// invalid key; CHE says that in plain words, with no key and no raw key text.
export function elevenDiagnosis(code, body = '', env = {}) {
  const text = String(body || '');
  let status = '';
  try { status = String(JSON.parse(text)?.detail?.status || ''); } catch (_) { /* plain text */ }
  const said = `${status} ${text}`;
  if ((code === 401 || code === 403) && /missing_permissions|missing the permission/i.test(said)) {
    const permission = (/permission\s+([a-z_]+)/i.exec(said) || [])[1] || 'voices_read';
    return { state: 'Needs Reconnect', reason: `The ElevenLabs key is missing the ${permission} permission. In ElevenLabs, edit this key, turn that permission on, then refresh here.` };
  }
  if ((code === 401 || code === 403) && /invalid_api_key|invalid api key/i.test(said)) {
    return { state: 'Needs Reconnect', reason: 'ElevenLabs does not accept this API key. Create a new key in ElevenLabs, update ELEVENLABS_API_KEY, then refresh here.' };
  }
  const reason = elevenLabsRefusalReason(text, env);
  if (code === 401 || code === 403) return { state: 'Needs Reconnect', reason: `ElevenLabs refused the key${reason ? `: ${reason}` : '.'}` };
  return { state: 'Unavailable', reason: `ElevenLabs answered HTTP ${code}${reason ? `: ${reason}` : '.'}` };
}

// Where a voice belongs on the owner's list. The provider's own fields decide;
// a voice whose category is not clear goes under Voice Library.
export function voiceSource(voice = {}) {
  const category = String(voice?.category || '');
  if (voice?.is_owner === true || category === 'cloned' || category === 'generated') return 'mine';
  if (category === 'premade') return 'default';
  return 'library';
}

export function safePreviewUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch (_) {
    return '';
  }
}

export function mapLibraryVoice(voice = {}) {
  const id = String(voice?.voice_id || '');
  if (!VOICE_ID.test(id)) return null;
  const labels = voice?.labels && typeof voice.labels === 'object' ? voice.labels : {};
  const kept = {};
  for (const key of ['accent', 'gender', 'age', 'use_case', 'descriptive']) {
    if (labels[key]) kept[key] = clean(labels[key], 40);
  }
  return {
    provider: 'elevenlabs',
    id,
    name: clean(voice.name) || 'Unnamed voice',
    source: voiceSource(voice),
    category: clean(voice.category, 30),
    description: clean(voice.description, 160),
    labels: kept,
    preview: safePreviewUrl(voice.preview_url),
  };
}

// Reads every page of the account's voices. A page that cannot be continued makes
// the list incomplete, and that is said aloud; it is never padded.
export async function fetchElevenLibrary(env = {}, { fetcher = fetch, pageSize = LIBRARY_PAGE_SIZE, maxPages = LIBRARY_MAX_PAGES } = {}) {
  const key = String(env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return { state: 'Needs Setup', reason: 'No ElevenLabs key is set.', voices: [], complete: false, pages: 0 };
  const seen = new Map();
  let token = '';
  let pages = 0;
  let incomplete = false;
  try {
    do {
      const url = new URL(`${ELEVEN_API}/v2/voices`);
      url.searchParams.set('page_size', String(pageSize));
      if (token) url.searchParams.set('next_page_token', token);
      const reply = await fetcher(url.toString(), {
        headers: { 'xi-api-key': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!reply.ok) {
        const body = await readBody(reply);
        return { ...elevenDiagnosis(reply.status, body, env), voices: [...seen.values()], complete: false, pages };
      }
      const page = await reply.json();
      for (const raw of Array.isArray(page?.voices) ? page.voices : []) {
        const voice = mapLibraryVoice(raw);
        if (voice && !seen.has(voice.id)) seen.set(voice.id, voice);
      }
      pages += 1;
      const more = page?.has_more === true;
      token = more && typeof page?.next_page_token === 'string' ? page.next_page_token : '';
      if (more && !token) incomplete = true;
    } while (token && pages < maxPages);
    if (token) incomplete = true;
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'ElevenLabs did not answer within 8 seconds.' : 'Could not reach ElevenLabs.';
    return { state: 'Unavailable', reason, voices: [...seen.values()], complete: false, pages };
  }
  return {
    state: 'Connected',
    reason: seen.size ? '' : 'ElevenLabs returned no voices for this account.',
    voices: [...seen.values()],
    complete: !incomplete,
    pages,
  };
}

// The sort the owner hears: My Voices, then Voice Library, then the account's built-ins.
export function filterLibrary(voices = [], { query = '', source = 'all', favorites = [], favoritesOnly = false } = {}) {
  const words = clean(query, 60).toLowerCase();
  const starred = new Set(favorites);
  return voices
    .filter((v) => source === 'all' || v.source === source)
    .filter((v) => !favoritesOnly || starred.has(v.id))
    .filter((v) => !words || [v.name, v.category, ...Object.values(v.labels || {})].join(' ').toLowerCase().includes(words))
    .map((v) => ({ ...v, favorite: starred.has(v.id) }))
    .sort((a, b) => (SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]) || a.name.localeCompare(b.name));
}

export function withFavorite(list = [], id, on) {
  const starred = new Set(Array.isArray(list) ? list : []);
  if (on) starred.add(id);
  else starred.delete(id);
  return [...starred].filter(isVoiceId).slice(0, FAVORITES_LIMIT);
}

// What each speech model is for, from its own flags. Quality and speed words follow
// ElevenLabs' model names; the credit line is the provider's own cost factor.
const MODEL_TEXT = [
  [/flash|turbo/i, 'Fastest replies, for live conversation. Less expressive than the top-quality models.'],
  [/multilingual/i, 'Highest everyday quality across many languages. Slower than Flash.'],
  [/v3/i, 'Most expressive, and the slowest. Best for stories and character voices.'],
];

export function describeElevenModel(model = {}) {
  const id = String(model?.model_id || '');
  if (!MODEL_ID.test(id)) return null;
  const factor = Number(model.token_cost_factor);
  const known = MODEL_TEXT.find(([pattern]) => pattern.test(id));
  const maxChars = Number(model.max_characters_request_subscribed_user);
  return {
    provider: 'elevenlabs',
    id,
    name: clean(model.name, 60) || id,
    explanation: known ? known[1] : clean(model.description, 200) || 'An ElevenLabs speech model.',
    credits: Number.isFinite(factor) && factor > 0 ? `${factor} times the standard credit rate` : 'not reported by ElevenLabs',
    max_characters: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : null,
    controls: {
      stability: true,
      similarity_boost: true,
      speed: true,
      style: model.can_use_style === true,
      use_speaker_boost: model.can_use_speaker_boost === true,
    },
  };
}

export async function fetchElevenModels(env = {}, { fetcher = fetch } = {}) {
  const key = String(env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return { state: 'Needs Setup', reason: 'No ElevenLabs key is set.', models: [] };
  try {
    const reply = await fetcher(`${ELEVEN_API}/v1/models`, {
      headers: { 'xi-api-key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!reply.ok) {
      const body = await readBody(reply);
      return { ...elevenDiagnosis(reply.status, body, env), models: [] };
    }
    const list = await reply.json();
    const rows = Array.isArray(list) ? list : (Array.isArray(list?.models) ? list.models : []);
    const models = rows
      .filter((m) => m?.can_do_text_to_speech !== false)
      .map(describeElevenModel)
      .filter(Boolean);
    return { state: 'Connected', reason: '', models };
  } catch (error) {
    return { state: 'Unavailable', reason: error?.name === 'TimeoutError' ? 'ElevenLabs did not answer within 8 seconds.' : 'Could not reach ElevenLabs.', models: [] };
  }
}

// Fish Audio's own voice models on this account. Fish's controls are speed only;
// the ElevenLabs stability, similarity and style controls are not offered for Fish.
export async function fetchFishModels(env = {}, { fetcher = fetch, own = true } = {}) {
  const key = String(env.FISH_API_KEY || '').trim();
  if (!key) return { state: 'Needs Setup', reason: 'No Fish Audio key is set.', models: [], complete: false };
  try {
    const url = new URL(`${FISH_API}/model`);
    url.searchParams.set('page_size', '100');
    url.searchParams.set('page_number', '1');
    url.searchParams.set('self', own ? 'true' : 'false');
    const reply = await fetcher(url.toString(), {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!reply.ok) {
      return { state: reply.status === 401 || reply.status === 403 ? 'Needs Reconnect' : 'Unavailable', reason: `Fish Audio answered HTTP ${reply.status}.`, models: [], complete: false };
    }
    const page = await reply.json();
    const models = (Array.isArray(page?.items) ? page.items : [])
      .filter((m) => isVoiceId(m?._id))
      .map((m) => ({
        provider: 'fish',
        id: String(m._id),
        name: clean(m.title) || 'Unnamed Fish voice',
        languages: Array.isArray(m.languages) ? m.languages.slice(0, 6).map((x) => clean(x, 12)) : [],
        controls: { speed: true, stability: false, similarity_boost: false, style: false, use_speaker_boost: false },
      }));
    return { state: 'Connected', reason: models.length ? '' : 'Fish Audio has no voice models on this account yet.', models, complete: page?.has_more !== true };
  } catch (error) {
    return { state: 'Unavailable', reason: error?.name === 'TimeoutError' ? 'Fish Audio did not answer within 8 seconds.' : 'Could not reach Fish Audio.', models: [], complete: false };
  }
}

// Only the fields the model's own flags allow. Out-of-range or unsupported values
// are refused, not clamped, so the owner hears exactly what was not accepted.
export function validateElevenSettings(input = {}, model = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  // A number, or text that is a number. null, true and blank text are refused, not read as 0 or 1.
  const number = (value) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 100) / 100 : null;
  };
  for (const name of ['stability', 'similarity_boost']) {
    const n = number(input[name]);
    if (n === null) return null;
    if (n !== undefined) out[name] = n;
  }
  if (input.style !== undefined) {
    if (!model?.controls?.style) return null;
    const n = number(input.style);
    if (n === null) return null;
    out.style = n;
  }
  if (input.use_speaker_boost !== undefined) {
    if (!model?.controls?.use_speaker_boost || typeof input.use_speaker_boost !== 'boolean') return null;
    out.use_speaker_boost = input.use_speaker_boost;
  }
  return out;
}

// A free sample from the provider's own preview URL. No speech is generated, so no
// credits are used. Absent or unusable samples are reported, never replaced.
export async function fetchFreePreview(url, { fetcher = fetch } = {}) {
  if (!url) return { ok: false, reason: 'ElevenLabs publishes no free sample for this voice.' };
  try {
    const reply = await fetcher(url, { signal: AbortSignal.timeout(8000) });
    if (!reply.ok) return { ok: false, reason: `The free sample did not download (HTTP ${reply.status}).` };
    const type = reply.headers?.get?.('content-type') || '';
    if (!/^audio\//i.test(type)) return { ok: false, reason: 'The free sample was not audio.' };
    const bytes = await reply.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > PREVIEW_MAX_BYTES) return { ok: false, reason: 'The free sample was empty or too large.' };
    return { ok: true, bytes, type };
  } catch (_) {
    return { ok: false, reason: 'The free sample could not be reached.' };
  }
}

// ─── Spoken requests about the library ────────────────────────────────────────
// Deterministic, like the Google turn: no model call. A request that is not about
// the voice library returns null and goes to chat as usual.
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// Text that names the voice library itself: "voices", ElevenLabs, Fish Audio, or "voice" at the
// end ("use Mike voice"). "voice typing" or "voice mode" do not, so they go on to chat.
export const VOICE_NAMED = /\bvoice$|\bvoices\b|\belevenlabs\b|\beleven labs\b|\bfish audio\b/;

export function normalizeVoiceRequest(message) {
  let t = String(message || '').replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
  t = t.replace(/^(?:(?:hey|ok|okay)\s+)?(?:che|chay|chey|shay)\b[,:!.]?\s*/, '');
  t = t.replace(/^(?:(?:please|pls|can you|could you|would you|will you)\s+)+/, '');
  return t.replace(/[\s?.!,]+$/, '').replace(/[\s,]+(?:please|pls|thanks|thank you)$/, '').replace(/[\s?.!,]+$/, '');
}

function matchName(spoken, names = []) {
  const wanted = clean(spoken, 60).toLowerCase().replace(/\s+voice$/, '');
  if (!wanted) return null;
  const exact = names.find((n) => String(n).toLowerCase() === wanted);
  if (exact) return exact;
  const words = names.filter((n) => new RegExp(`(^|\\s)${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`, 'i').test(String(n)));
  return words.length === 1 ? words[0] : null;
}

// `last` is the list the owner just heard (voice_studio_last); `names` are the
// voice names currently on the account, read only when a name is spoken.
export function voiceStudioIntent(message, { last = null, names = null } = {}) {
  let t = normalizeVoiceRequest(message);
  if (!t) return null;
  // "What voice are you using right now?", "Don't change anything, just tell me which voice you're on":
  // the saved choice, read only. The turn's own "don't change it" is set aside to read the question.
  const asked = normalizeVoiceRequest(withoutProhibitions(message).replace(/^[\s,.;:]+/, '')).replace(/^(?:just\s+)?tell\s+me\s+/, '');
  if (/^(?:what|which)(?:'s|s)?\s+voice\s+(?:are\s+you|you(?:'re|\s+are)|is\s+che)\s+(?:using|on|speaking\s+with|set\s+to)(?:\s+(?:now|right\s+now|currently|today))?$/.test(asked)) return { kind: 'current' };
  // "Switch your voice to Adam" is "switch to Adam", said about the voice.
  const aboutVoice = /^(?:switch|change|set)\s+(?:your|the|che's|che)\s+voice\s+to\s+/.test(t);
  if (aboutVoice) t = t.replace(/^(?:switch|change|set)\s+(?:your|the|che's|che)\s+voice\s+to\s+/, 'switch to ');
  // "What ElevenLabs voice did I choose for you, and what voice did it replace?": the saved choice, read only.
  if (/^(?:what|which)\b[\s\S]{0,40}\bvoice\b[\s\S]{0,30}\b(?:(?:did|have|had)\s+i\s+(?:\w+\s+)?(?:choose|chosen|pick|picked|select|selected|set)|i\s+(?:\w+\s+)?(?:chose|picked|selected))\b/.test(t)
    || /^(?:what|which)(?:'s|s|\s+is)\s+(?:your|che's)\s+(?:current\s+|saved\s+)?(?:(?:elevenlabs|eleven labs|fish)\s+)?voice(?:\s+(?:now|right now|currently|set to))?$/.test(t)) {
    // "Which voice did I pick? Switch to Adam instead." asks for a change too; the change routes keep it.
    if (!/(?:[.!?;,]\s*|\b(?:and|then|but)\s+)(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:switch|use|change|set|pick|choose|select|turn|go\s+back|put)\b/.test(t)) return { kind: 'current' };
  }
  if (/^(?:show|list|read|tell me|what are|which are|what)\s+(?:me\s+)?(?:my\s+|the\s+|all\s+|available\s+)?(?:(elevenlabs|eleven labs|fish)\s+)?(?:voice\s+)?(?:library|voices|voice library)(?:\s+(?:voices|library))?$/.test(t)
    || /^(?:what|which)\s+(?:(?:elevenlabs|eleven labs|fish)\s+)?voices\s+(?:do i have|can i use|are there|are available|are on my account)$/.test(t)) {
    const provider = /fish/.test(t) ? 'fish' : /eleven/.test(t) ? 'elevenlabs' : '';
    return { kind: 'list', provider };
  }
  if (/^(?:refresh|reload|check|update)\s+(?:the\s+|my\s+)?(?:(elevenlabs|eleven labs|fish)\s+)?(?:voice\s+)?(?:library|voices)$/.test(t)) {
    return { kind: 'refresh' };
  }
  const provider = /^(?:switch|change)\s+(?:to|over to)\s+(elevenlabs|eleven labs|fish)(?:\s+(?:voice|voices))?$/.exec(t);
  if (provider) return { kind: 'provider', provider: /fish/.test(provider[1]) ? 'fish' : 'elevenlabs' };
  if (/^(?:save|keep|make|set)\s+(?:this|that|it)(?:\s+(?:as|for))?\s+(?:your|my|che'?s|the)?\s*voice$/.test(t) || /^(?:save|keep)\s+(?:this|that|it)$/.test(t)) {
    return { kind: 'save' };
  }
  // The panel's controls, said aloud. Each is checked against the chosen model's own flags.
  const control = /^(?:set|make|change)\s+(?:the\s+)?(stability|similarity|style|speed)\s+(?:to\s+)?(\d{1,3}(?:\.\d+)?)\s*(percent|%)?$/.exec(t);
  if (control) return { kind: 'control', name: control[1], value: Number(control[2]), percent: Boolean(control[3]) };
  const boost = /^(?:turn|switch)\s+(?:the\s+)?speaker\s+boost\s+(on|off)$/.exec(t);
  if (boost) return { kind: 'boost', on: boost[1] === 'on' };
  const model = /^(?:use|switch to|set)\s+(?:the\s+)?(.+?)\s+model$/.exec(t);
  if (model) return { kind: 'model', spoken: model[1] };
  const number = /^(?:use|choose|pick|select|preview|play|hear|test|switch to)\s+(?:number\s+|voice\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})$/.exec(t);
  if (number) {
    const index = NUMBER_WORDS[number[1]] ?? Number(number[1]);
    const preview = /^(?:preview|hear|play|test)/.test(t);
    if (!last?.items?.length) return /\bvoices?\b/.test(t) || /^(?:preview|hear)/.test(t) ? { kind: 'needs_list' } : null;
    if (index < 1 || index > last.items.length) return { kind: 'bad_number', count: last.items.length };
    return { kind: preview ? 'preview' : 'use', voice: last.items[index - 1] };
  }
  // "play my favourite song" or "test my microphone" are not voice requests unless the
  // owner names a voice or has just heard a list. Only then are the names read.
  const named = /^(use|choose|pick|select|switch to|preview|play|hear|test)\s+(?:the\s+|voice\s+)?(.+?)(?:\s+voice)?$/.exec(t);
  if (!named) return null;
  const verb = named[1];
  const loose = /^(?:play|hear|test)$/.test(verb);
  if (loose && !last?.items?.length && !VOICE_NAMED.test(t)) return null;
  if (!names) return { kind: 'needs_names' };
  const match = matchName(named[2], names);
  if (match) return { kind: /^(?:preview|play|hear|test)$/.test(verb) ? 'preview_name' : 'use_name', name: match };
  if (VOICE_NAMED.test(t) || aboutVoice) return { kind: 'unknown_name', spoken: named[2] };
  return null;
}

// Whether the message begins like a voice request, so the library is read only then.
export function mightBeVoiceRequest(message) {
  const lead = /^(?:use|choose|pick|select|switch|preview|play|hear|test|save|keep|make|set|change|turn|show|list|read|tell|whats?|which|refresh|reload|check|update)\b/;
  // "Don't change anything, just tell me which voice you're on" leads with its prohibition.
  return lead.test(normalizeVoiceRequest(message))
    || lead.test(normalizeVoiceRequest(withoutProhibitions(message).replace(/^[\s,.;:]+/, '')).replace(/^just\s+/, ''));
}
