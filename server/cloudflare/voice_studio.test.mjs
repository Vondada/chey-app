// Voice Studio through the real Worker, offline: the owner's spoken library requests
// in /api/chat (no model call), the library routes, previews, favourites, confirmation
// for paid samples and the choices saved. The provider is a fake account; no request
// leaves this process. Same harness approach as google_worker.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const realFetch = globalThis.fetch;
const generated = new URL('./.voice_studio.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const KEY = 'xi-owner-secret-key-7777';
const FISH_KEY = 'fish-owner-secret-8888';
const CONNIE = 'CONNIEvoice0001';
const RACHEL = 'RACHELvoice0002';
const NARRATOR = 'NARRATORvoice03';
const NEW = 'NEWVOICE0000001';

// The provider's account, as the fake answers it. Tests change `account` and `flags`.
function fakeProvider() {
  const calls = [];
  const state = {
    calls,
    account: [
      { voice_id: CONNIE, name: 'Connie', category: 'cloned', is_owner: true, labels: { accent: 'british' }, preview_url: 'https://cdn.example.test/connie.mp3' },
      { voice_id: RACHEL, name: 'Rachel', category: 'premade', is_owner: false, preview_url: 'https://cdn.example.test/rachel.mp3' },
      { voice_id: NARRATOR, name: 'Narrator Saved', category: 'professional', is_owner: false },
    ],
    voicesStatus: 0,
    voicesBody: null,
    speechCalls: 0,
  };
  state.fetch = async (input, init = {}) => {
    const url = new URL(String(input?.url || input));
    calls.push({ host: url.host, path: url.pathname, auth: init.headers?.['xi-api-key'] || init.headers?.Authorization || '' });
    if (url.host === 'api.elevenlabs.io' && url.pathname === '/v2/voices') {
      if (state.voicesStatus) return new Response(state.voicesBody || '{"detail":{"status":"missing_permissions","message":"The API key you used is missing the permission voices_read to execute this operation."}}', { status: state.voicesStatus, headers: { 'content-type': 'application/json' } });
      const token = url.searchParams.get('next_page_token');
      const page = token === 'page-two' ? state.account.slice(2) : state.account.slice(0, 2);
      const more = !token;
      return Response.json({ voices: page, has_more: more, next_page_token: more ? 'page-two' : undefined });
    }
    if (url.host === 'api.elevenlabs.io' && url.pathname === '/v1/models') {
      return Response.json([
        { model_id: 'eleven_flash_v2_5', name: 'Flash v2.5', can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: true, token_cost_factor: 0.5 },
        { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: true, token_cost_factor: 1 },
      ]);
    }
    if (url.host === 'api.elevenlabs.io' && url.pathname.startsWith('/v1/text-to-speech/')) {
      state.speechCalls += 1;
      return new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    if (url.host === 'api.fish.audio' && url.pathname === '/model') {
      return Response.json({ items: [{ _id: 'fishmodelABCDEF12', title: 'My Fish voice', languages: ['en'] }], has_more: false });
    }
    if (url.host === 'cdn.example.test') {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    throw new TypeError(`fetch failed (offline voice test: ${url.host})`);
  };
  return state;
}

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner(provider) {
  globalThis.fetch = provider.fetch;
  const inputs = [];
  const pending = [];
  const saved = new Map();
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_TIMEZONE: 'America/Chicago',
    CHE_VOICE_PROBE_TOKEN: 'o'.repeat(40),
    ELEVENLABS_API_KEY: KEY, CHE_ELEVENLABS_PREFERRED: '1', CHE_ELEVENLABS_VOICE_ID: 'baseVoiceabcdefgh',
    FISH_API_KEY: FISH_KEY, CHE_FISH_PREFERRED: '1', CHE_FISH_VOICE_ID: 'fishVoiceabcdefgh',
    AI: { run: async (_model, input) => { inputs.push(input); return { response: 'Model answer, sir.' }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  return {
    token, saved, state,
    data: () => saved.get('che') || {},
    modelCalls: () => inputs.length,
    async say(message) {
      const before = inputs.length;
      const res = await send('/api/chat', { message, history: [] }, token);
      const raw = await res.text();
      await settle();
      const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      const done = events.find((e) => e.type === 'done') || {};
      const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('');
      return { raw, reply, done, modelCalls: inputs.length - before, status: res.status };
    },
    async get(path) { const res = await send(path, null, token, 'GET'); return { status: res.status, body: await res.json().catch(() => ({})), res }; },
    async post(path, body) { const res = await send(path, body, token); return { status: res.status, body: await res.json().catch(() => ({})) }; },
  };
}

test('"show my ElevenLabs library" lists the account\'s voices by group, with no model call', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  const r = await me.say('CHE, show my ElevenLabs library.');
  assert.equal(r.done.source, 'che_voice_studio');
  assert.equal(r.done.model_calls, 0);
  assert.equal(r.modelCalls, 0);
  assert.match(r.reply, /ElevenLabs library has 3 voices/);
  assert.match(r.reply, /1, Connie, My Voices/);
  assert.match(r.reply, /2, Narrator Saved, Voice Library/);
  assert.match(r.reply, /3, Rachel, Built in/);
  assert.equal(JSON.stringify(r).includes(KEY), false, 'the key never reaches the chat');
});

test('"preview number three" plays the free sample only; no speech is generated and no credits are used', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  await me.say('show my ElevenLabs library');
  const r = await me.say('preview number three');
  assert.equal(r.done.source, 'che_voice_studio');
  assert.deepEqual(r.done.voice_preview, { provider: 'elevenlabs', voice_id: RACHEL });
  assert.match(r.reply, /free sample of Rachel/);
  assert.equal(provider.speechCalls, 0, 'no paid speech call was made');
});

test('"use Connie" saves her as CHE\'s voice, and "save this as your voice" keeps the one just previewed', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  await me.say('show my ElevenLabs library');
  const used = await me.say('use Connie');
  assert.equal(used.done.model_calls, 0);
  assert.match(used.reply, /Connie is now CHE's voice/);
  assert.equal(me.data().voice_choice.id, CONNIE);
  assert.equal(me.data().voice_choice.provider, 'elevenlabs');
  assert.equal(me.data().voice_choice.name, 'Connie');
  await me.say('preview number three');
  const saved = await me.say('CHE, save this as your voice.');
  assert.match(saved.reply, /Saved Rachel as CHE's voice/);
  assert.equal(me.data().voice_choice.id, RACHEL);
});

test('a voice added to the account is seen on refresh and can be used at once, with no deploy', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  assert.equal((await me.say('use Brand New')).modelCalls, 1, 'before the voice exists, the name is not on the account: ordinary chat');
  provider.account.push({ voice_id: NEW, name: 'Brand New', category: 'cloned', is_owner: true });
  const refreshed = await me.say('refresh my voices');
  assert.match(refreshed.reply, /refreshed, sir: 4 voices/);
  const used = await me.say('use Brand New');
  assert.match(used.reply, /Brand New is now CHE's voice/);
  assert.equal(me.data().voice_choice.id, NEW);
});

test('a key without the voices permission is said in plain words, and nothing is saved', async () => {
  const provider = fakeProvider();
  provider.voicesStatus = 401;
  const me = await owner(provider);
  const r = await me.say('show my ElevenLabs library');
  assert.match(r.reply, /missing the voices_read permission/);
  assert.equal(JSON.stringify(r).includes(KEY), false);
  const used = await me.say('use Connie voice');
  assert.match(used.reply, /cannot read your voice library right now, sir\. .*voices_read permission/);
  assert.equal(used.modelCalls, 0, 'the model does not guess at a voice it cannot see');
  assert.equal(me.data().voice_choice, undefined);
  const trading = await me.say('switch to live trading');
  assert.equal(trading.done.source === 'che_voice_studio', false, 'a trading request is not a voice request');
});

test('a voice with no published free sample is said so, and nothing is played in its place', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  await me.say('show my ElevenLabs library');
  const r = await me.say('preview Narrator Saved');
  assert.match(r.reply, /publishes no free sample for Narrator Saved/);
  assert.equal(r.done.voice_preview, undefined);
  assert.equal(provider.speechCalls, 0);
});

test('unknown names and out-of-range numbers change nothing and say so', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  await me.say('show my ElevenLabs library');
  const bob = await me.say('use Bob voice');
  assert.match(bob.reply, /did not find bob in your voice library/i);
  assert.equal(bob.modelCalls, 0);
  const far = await me.say('preview number nine');
  assert.match(far.reply, /from 1 to 3/);
  assert.equal(me.data().voice_choice, undefined);
});

test('ordinary conversation still reaches the model; voice words in a sentence do not hijack it', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  const weather = await me.say('what is the weather like');
  assert.equal(weather.done.source === 'che_voice_studio', false);
  assert.equal(weather.modelCalls, 1);
  const music = await me.say('play some music');
  assert.equal(music.done.source === 'che_voice_studio', false);
});

test('paid samples need an explicit confirmation before any credit is spent', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  const refused = await me.post('/api/voice/preview', { provider: 'elevenlabs', id: CONNIE, speed: 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.needs_confirmation, true);
  assert.equal(provider.speechCalls, 0);
});

test('the library route lists every group, filters by search and favourites, and keeps favourites', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  const all = await me.get('/api/voice/library');
  assert.equal(all.status, 200);
  assert.equal(all.body.state, 'Connected');
  assert.deepEqual(all.body.voices.map((v) => v.source), ['mine', 'library', 'default']);
  assert.equal(JSON.stringify(all.body).includes(KEY), false);
  assert.equal(all.body.models.elevenlabs.length, 2);
  const starred = await me.post('/api/voice/favorite', { voice_id: RACHEL, on: true });
  assert.deepEqual(starred.body.favorites, [RACHEL]);
  const onlyStarred = await me.get('/api/voice/library?favorites=1');
  assert.deepEqual(onlyStarred.body.voices.map((v) => v.name), ['Rachel']);
  const searched = await me.get('/api/voice/library?query=narrator');
  assert.deepEqual(searched.body.voices.map((v) => v.name), ['Narrator Saved']);
  const bad = await me.post('/api/voice/favorite', { voice_id: '../etc', on: true });
  assert.equal(bad.status, 400);
});

test('a free preview from the library is audio bytes, and a voice not on the account is refused', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  const sample = await me.get(`/api/voice/library/preview?voice_id=${CONNIE}`);
  assert.equal(sample.status, 200);
  assert.match(sample.res.headers.get('content-type'), /audio\/mpeg/);
  assert.equal(provider.speechCalls, 0);
  const malformed = await me.get('/api/voice/library/preview?voice_id=../etc/passwd');
  assert.equal(malformed.status, 400);
  const notListed = await me.get('/api/voice/library/preview?voice_id=ABSENTvoice000001');
  assert.equal(notListed.status, 404, 'a well-formed ID that is not on the account is not previewed');
});

test('a chosen model and its settings are saved only where the model allows them', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  const ok = await me.post('/api/voice/choice', { provider: 'elevenlabs', id: CONNIE, speed: 1, model_id: 'eleven_multilingual_v2', settings: { stability: 0.35, style: 0.4 } });
  assert.equal(ok.status, 200);
  assert.equal(me.data().voice_choice.model_id, 'eleven_multilingual_v2');
  assert.equal(me.data().voice_choice.settings.style, 0.4);
  assert.equal(me.data().voice_choice.name, 'Connie');
  const refused = await me.post('/api/voice/choice', { provider: 'elevenlabs', id: CONNIE, speed: 1, model_id: 'eleven_flash_v2_5', settings: { style: 0.4 } });
  assert.equal(refused.status, 400, 'Flash cannot use style');
  assert.equal(me.data().voice_choice.model_id, 'eleven_multilingual_v2', 'a refused choice changes nothing');
});

test('"switch to Fish" makes Fish first, and "switch to ElevenLabs" puts ElevenLabs back', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  const fish = await me.say('CHE, switch to Fish.');
  assert.match(fish.reply, /Switched to Fish Audio, sir: CHE Fish voice \(configured\)/, 'the Fish voice the owner set up comes first');
  assert.equal(me.data().voice_choice.provider, 'fish');
  assert.equal(me.data().voice_choice.id, 'configured');
  const back = await me.say('switch to ElevenLabs');
  assert.match(back.reply, /Switched back to ElevenLabs/);
  assert.equal(me.data().voice_choice, undefined);
});

// The deploy check sends this deploy's probe token to the owner's object. The object was
// created with an older env, so it must take the token from the voice settings it is given.
test('the Command Center readiness check accepts this deploy\'s probe token, not only the one the object was created with', async () => {
  const provider = fakeProvider();
  const me = await owner(provider);
  const NEW_TOKEN = 'n'.repeat(40);
  const ask = () => me.state.fetch(new Request('https://che.internal/api/commands/readiness', {
    method: 'POST',
    headers: { Authorization: `Bearer ${NEW_TOKEN}`, 'Content-Type': 'application/json' },
    body: '{}',
  }));
  assert.equal((await ask()).status, 404, 'a token the object was not given is refused');
  await me.state.setVoiceSecrets({ CHE_VOICE_PROBE_TOKEN: NEW_TOKEN });
  const ok = await ask();
  assert.equal(ok.status, 200);
  assert.equal(Number.isInteger((await ok.json()).available), true);
});

test('the test harness restores the real fetch', () => {
  globalThis.fetch = realFetch;
  assert.equal(globalThis.fetch, realFetch);
});
