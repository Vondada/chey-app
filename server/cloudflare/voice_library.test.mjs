import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeElevenModel, elevenDiagnosis, fetchElevenLibrary, fetchElevenModels, fetchFishModels, fetchFreePreview,
  filterLibrary, mapLibraryVoice, mightBeVoiceRequest, validateElevenSettings, voiceStudioIntent, withFavorite,
} from './voice_library.js';

const KEY = 'xi-test-secret-key-0001';
const env = { ELEVENLABS_API_KEY: KEY, FISH_API_KEY: 'fish-test-secret-0002' };
const jsonReply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers({ 'content-type': 'application/json' }) });
const textReply = (body, status) => ({ ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body), headers: new Headers() });

const PAGE_ONE = { voices: [
  { voice_id: 'CONNIEvoice0001', name: 'Connie', category: 'cloned', is_owner: true, labels: { accent: 'british', gender: 'female' }, preview_url: 'https://cdn.example.test/connie.mp3' },
  { voice_id: 'RACHELvoice0002', name: 'Rachel', category: 'premade', is_owner: false, labels: {} },
], has_more: true, next_page_token: 'page-two-token' };
const PAGE_TWO = { voices: [
  { voice_id: 'NARRATORvoice03', name: 'Narrator Saved', category: 'professional', is_owner: false, preview_url: 'http://insecure.example.test/a.mp3' },
  { voice_id: '../bad-id-here', name: 'Unsafe', category: 'cloned' },
], has_more: false };

test('the library reads every page of the current v2 endpoint with the key only in the header', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return jsonReply(String(url).includes('next_page_token') ? PAGE_TWO : PAGE_ONE);
  };
  const lib = await fetchElevenLibrary(env, { fetcher });
  assert.equal(lib.state, 'Connected');
  assert.equal(lib.complete, true);
  assert.equal(lib.pages, 2);
  assert.match(calls[0].url, /^https:\/\/api\.elevenlabs\.io\/v2\/voices\?page_size=100$/);
  assert.match(calls[1].url, /next_page_token=page-two-token/);
  assert.equal(calls[0].headers['xi-api-key'], KEY);
  assert.equal(JSON.stringify(lib).includes(KEY), false, 'the key never leaves the library reader');
  assert.deepEqual(lib.voices.map((v) => v.name), ['Connie', 'Rachel', 'Narrator Saved'], 'the unsafe ID is dropped, not shown');
  assert.equal(lib.voices.find((v) => v.name === 'Narrator Saved').preview, '', 'an http preview URL is never used');
  assert.equal(lib.voices[0].preview, 'https://cdn.example.test/connie.mp3');
});

test('each voice is placed by the provider fields: My Voices, Voice Library, then the built-ins', async () => {
  const lib = await fetchElevenLibrary(env, { fetcher: async (url) => jsonReply(String(url).includes('next_page_token') ? PAGE_TWO : PAGE_ONE) });
  const sorted = filterLibrary(lib.voices);
  assert.deepEqual(sorted.map((v) => [v.name, v.source]), [
    ['Connie', 'mine'],
    ['Narrator Saved', 'library'],
    ['Rachel', 'default'],
  ]);
});

test('a voice added to the account appears on the next read: nothing is cached or hard-coded', async () => {
  let added = false;
  const fetcher = async () => jsonReply({ voices: [
    { voice_id: 'CONNIEvoice0001', name: 'Connie', category: 'cloned', is_owner: true },
    ...(added ? [{ voice_id: 'NEWVOICE000001', name: 'Brand New', category: 'cloned', is_owner: true }] : []),
  ], has_more: false });
  assert.equal((await fetchElevenLibrary(env, { fetcher })).voices.length, 1);
  added = true;
  const again = await fetchElevenLibrary(env, { fetcher });
  assert.ok(again.voices.some((v) => v.name === 'Brand New'));
});

test('a page that cannot be continued makes the list incomplete, and the cap is honest about it', async () => {
  const stuck = await fetchElevenLibrary(env, { fetcher: async () => jsonReply({ voices: [PAGE_ONE.voices[0]], has_more: true }) });
  assert.equal(stuck.complete, false);
  let n = 0;
  const endless = await fetchElevenLibrary(env, { maxPages: 3, fetcher: async () => jsonReply({ voices: [{ voice_id: `ENDLESSvoice${n++}`, name: `Voice ${n}`, category: 'cloned' }], has_more: true, next_page_token: `t${n}` }) });
  assert.equal(endless.pages, 3);
  assert.equal(endless.complete, false);
});

test('a refused key is diagnosed from the reason ElevenLabs gives, without the key', async () => {
  const missing = await fetchElevenLibrary(env, { fetcher: async () => textReply(JSON.stringify({ detail: { status: 'missing_permissions', message: `The API key you used is missing the permission voices_read to execute this operation. key ${KEY}` } }), 401) });
  assert.equal(missing.state, 'Needs Reconnect');
  assert.match(missing.reason, /missing the voices_read permission/);
  assert.equal(JSON.stringify(missing).includes(KEY), false);
  const invalid = await fetchElevenLibrary(env, { fetcher: async () => textReply(JSON.stringify({ detail: { status: 'invalid_api_key', message: 'invalid' } }), 401) });
  assert.match(invalid.reason, /does not accept this API key/);
  const other = elevenDiagnosis(500, 'boom', env);
  assert.equal(other.state, 'Unavailable');
  assert.match(other.reason, /HTTP 500/);
});

test('no key is set-up, not a fabricated list, and no request is sent', async () => {
  let called = false;
  const lib = await fetchElevenLibrary({}, { fetcher: async () => { called = true; return jsonReply({}); } });
  assert.equal(called, false);
  assert.equal(lib.state, 'Needs Setup');
  assert.deepEqual(lib.voices, []);
});

test('search and the favourites filter narrow the list by name, label and category', async () => {
  const lib = await fetchElevenLibrary(env, { fetcher: async (url) => jsonReply(String(url).includes('next_page_token') ? PAGE_TWO : PAGE_ONE) });
  assert.deepEqual(filterLibrary(lib.voices, { query: 'connie' }).map((v) => v.name), ['Connie']);
  assert.deepEqual(filterLibrary(lib.voices, { query: 'BRITISH' }).map((v) => v.name), ['Connie']);
  assert.deepEqual(filterLibrary(lib.voices, { source: 'default' }).map((v) => v.name), ['Rachel']);
  const starred = filterLibrary(lib.voices, { favorites: ['RACHELvoice0002'], favoritesOnly: true });
  assert.deepEqual(starred.map((v) => [v.name, v.favorite]), [['Rachel', true]]);
  assert.deepEqual(withFavorite(['AAAAAAAAAAAA'], 'RACHELvoice0002', true), ['AAAAAAAAAAAA', 'RACHELvoice0002']);
  assert.deepEqual(withFavorite(['RACHELvoice0002'], 'RACHELvoice0002', false), []);
  assert.deepEqual(withFavorite(['not an id'], 'bad', true), []);
});

test('a voice from the provider is mapped only with a safe ID', () => {
  assert.equal(mapLibraryVoice({ voice_id: 'x', name: 'Short' }), null);
  assert.equal(mapLibraryVoice({ voice_id: 'CONNIEvoice0001', name: 'A'.repeat(200) }).name.length, 75);
});

test('speech models come from the provider, with the controls their own flags allow', async () => {
  const models = [
    { model_id: 'eleven_flash_v2_5', name: 'Flash v2.5', can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: true, token_cost_factor: 0.5 },
    { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: true, token_cost_factor: 1 },
    { model_id: 'eleven_sts_only', name: 'Speech to speech', can_do_text_to_speech: false },
  ];
  const result = await fetchElevenModels(env, { fetcher: async () => jsonReply(models) });
  assert.equal(result.state, 'Connected');
  assert.deepEqual(result.models.map((m) => m.id), ['eleven_flash_v2_5', 'eleven_multilingual_v2']);
  assert.match(result.models[0].explanation, /Fastest/);
  assert.equal(result.models[0].credits, '0.5 times the standard credit rate');
  assert.equal(result.models[0].controls.style, false);
  assert.equal(result.models[1].controls.style, true);
  const unknown = describeElevenModel({ model_id: 'eleven_new_thing', can_do_text_to_speech: true, description: 'Provider text.' });
  assert.equal(unknown.explanation, 'Provider text.');
  assert.equal(unknown.credits, 'not reported by ElevenLabs');
});

test('only the controls the chosen model supports are accepted; out-of-range values are refused', () => {
  const flash = { controls: { style: false, use_speaker_boost: true } };
  const multi = { controls: { style: true, use_speaker_boost: true } };
  assert.deepEqual(validateElevenSettings({ stability: 0.4, similarity_boost: 0.9, use_speaker_boost: false }, flash),
    { stability: 0.4, similarity_boost: 0.9, use_speaker_boost: false });
  assert.equal(validateElevenSettings({ style: 0.3 }, flash), null, 'style is refused where the model cannot use it');
  assert.deepEqual(validateElevenSettings({ style: 0.3 }, multi), { style: 0.3 });
  assert.equal(validateElevenSettings({ stability: 1.4 }, multi), null);
  assert.equal(validateElevenSettings({ similarity_boost: 'high' }, multi), null);
  assert.equal(validateElevenSettings({ use_speaker_boost: 'yes' }, multi), null);
});

test('a free sample is the provider preview; no speech is generated, and non-audio is refused', async () => {
  const audio = await fetchFreePreview('https://cdn.example.test/connie.mp3', { fetcher: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) });
  assert.equal(audio.ok, true);
  assert.equal(audio.bytes.byteLength, 3);
  const html = await fetchFreePreview('https://cdn.example.test/x', { fetcher: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer: async () => new ArrayBuffer(4) }) });
  assert.equal(html.ok, false);
  const none = await fetchFreePreview('', { fetcher: async () => { throw new Error('must not fetch'); } });
  assert.match(none.reason, /publishes no free sample/);
});

test('Fish Audio voices are the owner\'s own models, with speed as the only control', async () => {
  const calls = [];
  const result = await fetchFishModels(env, { fetcher: async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    return jsonReply({ items: [{ _id: 'fishmodelABCDEF12', title: 'My Fish voice', languages: ['en'] }, { _id: 'no', title: 'Bad' }], has_more: false });
  } });
  assert.match(calls[0].url, /self=true/);
  assert.equal(calls[0].auth, 'Bearer fish-test-secret-0002');
  assert.deepEqual(result.models.map((m) => [m.id, m.name]), [['fishmodelABCDEF12', 'My Fish voice']]);
  assert.deepEqual(result.models[0].controls, { speed: true, stability: false, similarity_boost: false, style: false, use_speaker_boost: false });
  assert.equal(JSON.stringify(result).includes('fish-test-secret-0002'), false);
  const refused = await fetchFishModels(env, { fetcher: async () => ({ ok: false, status: 401 }) });
  assert.equal(refused.state, 'Needs Reconnect');
});

const LIST = { items: [
  { id: 'CONNIEvoice0001', name: 'Connie', provider: 'elevenlabs' },
  { id: 'RACHELvoice0002', name: 'Rachel', provider: 'elevenlabs' },
  { id: 'NARRATORvoice03', name: 'Narrator Saved', provider: 'elevenlabs' },
] };

test('the owner\'s spoken library requests map to deterministic intents', () => {
  assert.deepEqual(voiceStudioIntent('CHE, show my ElevenLabs library.'), { kind: 'list', provider: 'elevenlabs' });
  assert.deepEqual(voiceStudioIntent('show my voices'), { kind: 'list', provider: '' });
  assert.deepEqual(voiceStudioIntent('which voices do I have?'), { kind: 'list', provider: '' });
  assert.deepEqual(voiceStudioIntent('refresh my voices'), { kind: 'refresh' });
  assert.deepEqual(voiceStudioIntent('CHE, switch to Fish.'), { kind: 'provider', provider: 'fish' });
  assert.deepEqual(voiceStudioIntent('CHE, save this as your voice.'), { kind: 'save' });
  assert.deepEqual(voiceStudioIntent('save it as my voice'), { kind: 'save' });
});

test('"preview number three" and "use number two" use the list the owner just heard', () => {
  assert.deepEqual(voiceStudioIntent('preview number three', { last: LIST }), { kind: 'preview', voice: LIST.items[2] });
  assert.deepEqual(voiceStudioIntent('use number two', { last: LIST }), { kind: 'use', voice: LIST.items[1] });
  assert.deepEqual(voiceStudioIntent('use 1', { last: LIST }), { kind: 'use', voice: LIST.items[0] });
  assert.deepEqual(voiceStudioIntent('preview number nine', { last: LIST }), { kind: 'bad_number', count: 3 });
  assert.deepEqual(voiceStudioIntent('preview number three'), { kind: 'needs_list' });
  assert.equal(voiceStudioIntent('use number three'), null, 'with no list and no voice word, it is ordinary chat');
});

test('"use Connie" is recognised by the name on the account; an unknown name is not hijacked from chat', () => {
  const names = ['Connie', 'Rachel', 'Narrator Saved'];
  assert.deepEqual(voiceStudioIntent('use Connie', { names }), { kind: 'use_name', name: 'Connie' });
  assert.deepEqual(voiceStudioIntent('CHE, use Connie voice.', { names }), { kind: 'use_name', name: 'Connie' });
  assert.deepEqual(voiceStudioIntent('preview Rachel', { names }), { kind: 'preview_name', name: 'Rachel' });
  assert.deepEqual(voiceStudioIntent('use narrator', { names }), { kind: 'use_name', name: 'Narrator Saved' });
  assert.deepEqual(voiceStudioIntent('use Bob voice', { names }), { kind: 'unknown_name', spoken: 'bob' });
  assert.equal(voiceStudioIntent('use the calculator', { names }), null);
  assert.equal(voiceStudioIntent('play my favourite song', { names }), null);
  assert.equal(voiceStudioIntent('test my microphone', { names }), null);
  assert.deepEqual(voiceStudioIntent('use Connie'), { kind: 'needs_names' }, 'names are read only for a spoken name');
});

test('ordinary conversation is never a voice request', () => {
  for (const message of [
    'read my latest unread email', 'what is the weather', 'show me the calendar', 'save this file',
    'I like the voice of the narrator in that film', 'play some music',
  ]) {
    assert.equal(voiceStudioIntent(message, { last: LIST, names: ['Connie'] }), null, message);
  }
  assert.equal(mightBeVoiceRequest('use the calculator'), true, 'a candidate, read only then');
  assert.equal(mightBeVoiceRequest('tell me a joke'), true);
  assert.equal(mightBeVoiceRequest('the weather is nice'), false);
});
