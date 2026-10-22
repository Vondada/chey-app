// One voice per response (owner, 2026-10-18): a spoken reply keeps the voice
// its first clip used, a locked clip never falls back to the other provider,
// and the owner's voice choice survives older copies of the shared record.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { premiumVoiceSpeech, voiceLogEntry, voiceProviderOf, voiceTag, voiceTurnFor } from './phone_voice.js';
import { resetPreferredElevenLabsPause } from './preferred_elevenlabs_voice.js';
import { resetFishAudioState } from './fish_audio_voice.js';
import { reconcileVoiceChoice, saveVoiceChoice, VOICE_PREF_KEY } from './voice_choices.js';

const MARY = 'MaryVoiceId0001';
const OTHER = 'OtherVoiceId0002';
const FISH = '802e3bc2b27e49c2995d23ef70e6ac89';
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00]);
const env = (extra = {}) => ({
  CHE_ELEVENLABS_PREFERRED: '1', ELEVENLABS_API_KEY: 'eleven-test-key', CHE_ELEVENLABS_VOICE_ID: MARY,
  FISH_API_KEY: 'fish-test-key', CHE_FISH_VOICE_ID: FISH, CHE_FISH_PREFERRED: '1', ...extra,
});

function memoryStorage(saved = new Map()) {
  return {
    saved,
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// Fake ElevenLabs and Fish: `eleven` and `fish` answer each call by number.
function fakeProviders({ eleven = () => 200, fish = () => 200 } = {}) {
  const calls = { eleven: [], fish: [] };
  const audio = () => new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg' } });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('elevenlabs.io')) {
      calls.eleven.push(target);
      const code = eleven(calls.eleven.length);
      if (code === 'timeout') { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }
      return code === 200 ? audio() : new Response('{"detail":"busy"}', { status: code });
    }
    if (target.includes('fish.audio')) {
      calls.fish.push(target);
      const code = fish(calls.fish.length);
      return code === 200 ? audio() : new Response('busy', { status: code });
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.beforeEach(() => { resetPreferredElevenLabsPause(); resetFishAudioState(); });
test.afterEach(() => { globalThis.fetch = realFetch; });
const noWait = { sleep: async () => {} };

test('strict ElevenLabs-only: a failing ElevenLabs first clip is silent and Fish is never called (owner, 2026-10-22)', async () => {
  const calls = fakeProviders({ eleven: () => 500 });
  const audio = await premiumVoiceSpeech(env(), 'Hello there.', { storage: memoryStorage(), ...noWait });
  assert.equal(audio, null);
  assert.equal(calls.eleven.length, 1, 'an unlocked first clip makes one call; the retry is for locked clips');
  assert.equal(calls.fish.length, 0, 'Fish is never a backup for conversation');
});

test('a clip locked to ElevenLabs retries a passing failure once and never uses Fish', async () => {
  const calls = fakeProviders({ eleven: (n) => (n === 1 ? 503 : 200) });
  const audio = await premiumVoiceSpeech(env(), 'Second part.', { lock: 'elevenlabs', storage: memoryStorage(), ...noWait });
  assert.equal(audio.headers.get('X-CHE-Voice'), 'elevenlabs-mary');
  assert.equal(audio.headers.get('X-CHE-Voice-Attempts'), '2');
  assert.equal(calls.eleven.length, 2);
  assert.equal(calls.fish.length, 0, 'the locked reply never switched to Fish');
});

test('a locked ElevenLabs clip that times out stays silent: no second paid call, no other voice', async () => {
  const calls = fakeProviders({ eleven: () => 'timeout' });
  const audio = await premiumVoiceSpeech(env(), 'Third part.', { lock: 'elevenlabs', storage: memoryStorage(), ...noWait });
  assert.equal(audio, null);
  // ElevenLabs may already have made and billed a timed-out clip, so it is never asked again (review of #338).
  assert.equal(calls.eleven.length, 1);
  assert.equal(calls.fish.length, 0);
});

test('a locked clip skipped by a short server rest gets its one real call; a rate-limit rest is never skipped', async () => {
  let calls = fakeProviders({ eleven: (n) => (n === 1 ? 503 : 200) });
  const next = await premiumVoiceSpeech(env(), 'Next part.', { lock: 'elevenlabs', storage: memoryStorage(), ...noWait });
  assert.equal(next.headers.get('X-CHE-Voice'), 'elevenlabs-mary', 'the server rest made no call, so the retry is the clip\'s only call');
  assert.equal(calls.eleven.length, 2);
  assert.equal(calls.fish.length, 0);
  resetPreferredElevenLabsPause();
  calls = fakeProviders({ eleven: () => 429 });
  assert.equal(await premiumVoiceSpeech(env(), 'Locked.', { lock: 'elevenlabs', storage: memoryStorage(), ...noWait }), null);
  assert.equal(await premiumVoiceSpeech(env(), 'Locked again.', { lock: 'elevenlabs', storage: memoryStorage(), ...noWait }), null);
  assert.equal(calls.eleven.length, 1, 'ElevenLabs asked CHE to wait; no clip skips that rest');
  assert.equal(calls.fish.length, 0);
});

test('a locked Fish clip that times out is not asked for again', async () => {
  const calls = fakeProviders({ fish: () => 200 });
  globalThis.fetch = async (url) => {
    if (String(url).includes('fish.audio')) { calls.fish.push(String(url)); const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }
    throw new Error(`unexpected fetch ${url}`);
  };
  assert.equal(await premiumVoiceSpeech(env(), 'Fish part.', { purpose: 'story', lock: 'fish', selectedProvider: 'fish', storage: memoryStorage(), ...noWait }), null);
  assert.equal(calls.fish.length, 1);
});

test('a refused key is not retried: only passing failures earn the one retry', async () => {
  const calls = fakeProviders({ eleven: () => 401 });
  assert.equal(await premiumVoiceSpeech(env(), 'Part.', { lock: 'elevenlabs', storage: memoryStorage(), ...noWait }), null);
  assert.equal(calls.eleven.length, 1);
  assert.equal(calls.fish.length, 0);
});

test('a clip locked to Fish never falls back to ElevenLabs (Mary)', async () => {
  const calls = fakeProviders({ fish: () => 500 });
  const audio = await premiumVoiceSpeech(env(), 'Fish part.', { purpose: 'story', lock: 'fish', selectedProvider: 'fish', storage: memoryStorage(), ...noWait });
  assert.equal(audio, null);
  assert.equal(calls.eleven.length, 0, 'Mary never spoke inside a Fish reply');
  assert.equal(calls.fish.length, 2);
});

test('the voice tag names the voice without holding its ID, and changes with the voice', () => {
  const mary = voiceTag(env(), 'elevenlabs');
  assert.match(mary, /^elevenlabs:[0-9a-f]{8}$/);
  assert.ok(!mary.includes(MARY));
  assert.equal(voiceTag(env(), 'elevenlabs'), mary, 'stable across clips');
  assert.notEqual(voiceTag(env({ CHE_ELEVENLABS_VOICE_ID: OTHER }), 'elevenlabs'), mary);
  assert.notEqual(voiceTag(env({ CHE_VOICE_SPEED: '1.1' }), 'elevenlabs'), mary, 'speed is part of the voice');
  assert.equal(voiceProviderOf('elevenlabs-mary'), 'elevenlabs');
  assert.equal(voiceProviderOf('fish-audio'), 'fish');
  assert.equal(voiceProviderOf('none'), '');
});

test('a turn keeps the voice settings its first clip saw, bounded in memory', () => {
  const turns = new Map();
  const choice = { provider: 'elevenlabs', id: OTHER, speed: 1 };
  const turn = voiceTurnFor(turns, 'turn-aaaaaaaa', choice, 1000);
  choice.id = MARY;
  assert.equal(voiceTurnFor(turns, 'turn-aaaaaaaa', { provider: 'fish', id: 'configured' }, 2000).choice.id, OTHER);
  assert.equal(turn.choice.id, OTHER, 'a copy, not the live object');
  assert.equal(voiceTurnFor(turns, 'bad id!', choice), null);
  for (let i = 0; i < 40; i += 1) voiceTurnFor(turns, `turn-${String(i).padStart(8, '0')}`, null, 3000);
  assert.ok(turns.size <= 16);
  voiceTurnFor(turns, 'turn-late0000', null, 3000 + 21 * 60 * 1000);
  assert.equal(turns.size, 1, 'old turns expire');
});

test('the voice log keeps timing and voice tags, never words', () => {
  const entry = voiceLogEntry({ route: 'phone', chunks: 4, played: 4, silent: 0, gap_max_ms: 180, gap_avg_ms: 90,
    first_audio_ms: 1200, overhead_max_ms: 140, retries: 1, interrupted: 0, fallback: 0, tags: { 'elevenlabs:1a2b3c4d': 4 },
    provider: 'elevenlabs', text: 'Tell my doctor I said hello', reasons: ['ok'] }, 0);
  assert.equal(entry.gap_max_ms, 180);
  assert.equal(entry.first_audio_ms, 1200);
  assert.deepEqual(entry.tags, { 'elevenlabs:1a2b3c4d': 4 });
  assert.equal(entry.provider, 'elevenlabs');
  assert.ok(!JSON.stringify(entry).includes('doctor'));
});

test('an older copy of the shared record never undoes the owner\'s voice choice', async () => {
  const storage = memoryStorage();
  const data = { voice_choice: { provider: 'elevenlabs', id: MARY, speed: 1 } };
  await reconcileVoiceChoice(storage, data); // migration: the key now holds Mary
  const stale = structuredClone(data); // a long chat turn loaded this copy
  data.voice_choice = { provider: 'elevenlabs', id: OTHER, speed: 1.1, name: 'Other' };
  await saveVoiceChoice(storage, data, 5000); // the owner picked another voice meanwhile
  stale.memories = ['something the chat turn added'];
  await storage.put('che', stale); // ...and the chat turn wrote its older copy back
  const loaded = await storage.get('che');
  assert.equal(await reconcileVoiceChoice(storage, loaded), true);
  assert.equal(loaded.voice_choice.id, OTHER, 'the owner keeps the voice he chose');
  assert.deepEqual(loaded.memories, ['something the chat turn added'], 'the chat turn\'s own change is kept');
  // His next change, back to Mary, is his and stays.
  loaded.voice_choice = { provider: 'elevenlabs', id: MARY, speed: 1 };
  await saveVoiceChoice(storage, loaded, 9000);
  const again = await storage.get('che');
  assert.equal(await reconcileVoiceChoice(storage, again), false);
  assert.equal(again.voice_choice.id, MARY);
  assert.equal(storage.saved.get(VOICE_PREF_KEY).choice.id, MARY);
});

// Through the real route, as the iPhone calls it.
const generated = new URL('./.phone_voice.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

async function pairedPhone(extraEnv = {}) {
  const saved = new Map();
  const workerEnv = { CHE_PAIR_CODE: '123456', ...env(), ...extraEnv };
  const state = new CheState({ storage: memoryStorage(saved) }, workerEnv);
  workerEnv.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), workerEnv);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  return { saved, state, edge: (body) => send('/api/voice/edge', { premium_only: true, ...body }, token) };
}

test('route: one reply keeps the voice it started with even when the choice changes mid-reply', async () => {
  const phone = await pairedPhone();
  const calls = fakeProviders();
  const storage = memoryStorage(phone.saved);
  const data = await phone.state.loadData();
  data.voice_choice = { provider: 'elevenlabs', id: OTHER, speed: 1, name: 'Other' };
  await saveVoiceChoice(storage, data);
  const first = await phone.edge({ text: 'First sentence.', turn: 'turn-11111111', index: 0 });
  assert.equal(first.status, 200);
  const tag = first.headers.get('X-CHE-Voice-Tag');
  // The owner switches back to Mary while CHE is still speaking.
  const later = await phone.state.loadData();
  later.voice_choice = { provider: 'elevenlabs', id: MARY, speed: 1, name: 'Mary' };
  await saveVoiceChoice(storage, later);
  const second = await phone.edge({ text: 'Second part.', turn: 'turn-11111111', index: 1, lock: 'elevenlabs' });
  assert.equal(second.headers.get('X-CHE-Voice-Tag'), tag, 'same voice for the whole reply');
  assert.ok(calls.eleven.every((url) => url.includes(OTHER)), 'every clip of the reply used the voice it started with');
  const next = await phone.edge({ text: 'A new reply.', turn: 'turn-22222222', index: 0 });
  assert.ok(calls.eleven.at(-1).includes(MARY), 'the next reply uses the newly chosen voice');
  assert.notEqual(next.headers.get('X-CHE-Voice-Tag'), tag);
});

test('route: a locked clip that cannot speak answers 204 with the lock, and Fish is never asked', async () => {
  const phone = await pairedPhone();
  const calls = fakeProviders({ eleven: () => 500 });
  const reply = await phone.edge({ text: 'Middle of the reply.', turn: 'turn-33333333', index: 2, lock: 'elevenlabs' });
  assert.equal(reply.status, 204);
  assert.equal(reply.headers.get('X-CHE-Voice'), 'none');
  assert.equal(reply.headers.get('X-CHE-Voice-Lock'), 'elevenlabs');
  assert.equal(calls.fish.length, 0);
  const log = phone.saved.get('voice_log_v1').at(-1);
  assert.equal(log.lock, 'elevenlabs');
  assert.equal(log.index, 2);
  assert.ok(!JSON.stringify(log).includes('Middle of the reply'));
});

test('route: an older copy written back by a long request never sends the next reply to Mary (review of #338)', async () => {
  const phone = await pairedPhone();
  const calls = fakeProviders();
  const storage = memoryStorage(phone.saved);
  const stale = structuredClone(phone.saved.get('che')); // a chat turn loaded this before the change
  const data = await phone.state.loadData();
  data.voice_choice = { provider: 'elevenlabs', id: OTHER, speed: 1, name: 'Other' };
  await saveVoiceChoice(storage, data);
  stale.memories = [...(stale.memories || []), 'added by the long chat turn'];
  await storage.put('che', stale); // ...and wrote its older copy back, with no voice choice
  const reply = await phone.edge({ text: 'Next reply.', turn: 'turn-44444444', index: 0 });
  assert.equal(reply.status, 200);
  assert.ok(calls.eleven.at(-1).includes(OTHER), 'the chosen voice speaks, not Mary');
  assert.ok(!calls.eleven.at(-1).includes(MARY));
});

test('a rate limit is not retried with force while ElevenLabs rests (review of #338)', async () => {
  const calls = fakeProviders({ eleven: () => 429 });
  assert.equal(await premiumVoiceSpeech(env(), 'Part.', { lock: 'elevenlabs', storage: memoryStorage(), ...noWait }), null);
  assert.equal(calls.eleven.length, 1);
});

test('a connection lost while the audio downloads is not retried: the clip was already made', async () => {
  const calls = { eleven: 0 };
  globalThis.fetch = async (url) => {
    if (!String(url).includes('elevenlabs.io')) throw new Error(`unexpected fetch ${url}`);
    calls.eleven += 1;
    const body = new ReadableStream({ start(c) { c.error(new TypeError('network connection lost')); } });
    return new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } });
  };
  assert.equal(await premiumVoiceSpeech(env(), 'Lost part.', { lock: 'elevenlabs', storage: memoryStorage(), ...noWait }), null);
  assert.equal(calls.eleven, 1);
});

// Strict ElevenLabs-only assistant speech (owner, 2026-10-22). Fish receives ZERO calls for conversation and Read This,
// including after failures and with a saved Fish preference; authorized narration keeps its Fish voice.
test('strict: a saved Fish preference never reaches Fish for conversation', async () => {
  const calls = fakeProviders({ eleven: () => 200 });
  const audio = await premiumVoiceSpeech(env(), 'Saved Fish preference.', { purpose: 'conversation', selectedProvider: 'fish', storage: memoryStorage(), ...noWait });
  assert.equal(audio.headers.get('X-CHE-Voice'), 'elevenlabs-mary');
  assert.equal(calls.fish.length, 0);
});

test('strict: every ElevenLabs failure kind stays silent and Fish is never called', async () => {
  for (const code of [401, 402, 429, 500, 503]) {
    resetPreferredElevenLabsPause();
    const calls = fakeProviders({ eleven: () => code });
    const audio = await premiumVoiceSpeech(env(), 'Failure part.', { purpose: 'read', selectedProvider: 'fish', storage: memoryStorage(), ...noWait });
    assert.equal(audio, null, `status ${code}`);
    assert.equal(calls.fish.length, 0, `status ${code}: Fish stays silent too`);
  }
  resetPreferredElevenLabsPause();
  const timed = fakeProviders({ eleven: () => 'timeout' });
  assert.equal(await premiumVoiceSpeech(env(), 'Slow part.', { purpose: 'conversation', storage: memoryStorage(), ...noWait }), null);
  assert.equal(timed.fish.length, 0, 'a timeout does not switch to Fish');
});

test('strict: a Fish lock on conversation makes no Fish call at all', async () => {
  const calls = fakeProviders({ fish: () => 200 });
  assert.equal(await premiumVoiceSpeech(env(), 'Locked Fish.', { lock: 'fish', selectedProvider: 'fish', storage: memoryStorage(), ...noWait }), null);
  assert.equal(calls.fish.length, 0);
  assert.equal(calls.eleven.length, 0);
});

test('strict: every ElevenLabs clip of one reply has the same model, format and voice tag', async () => {
  const urls = [];
  const calls = fakeProviders({ eleven: () => 200 });
  const realFake = globalThis.fetch;
  globalThis.fetch = async (url, init) => { urls.push(String(url)); return realFake(url, init); };
  const saved = memoryStorage();
  const tags = [];
  for (const part of ['One.', 'Two.', 'Three.']) {
    const audio = await premiumVoiceSpeech(env(), part, { purpose: 'conversation', lock: 'elevenlabs', storage: saved, ...noWait });
    tags.push(audio.headers.get('X-CHE-Voice-Tag'));
  }
  assert.equal(new Set(tags).size, 1, 'one voice tag for the whole reply');
  assert.ok(urls.length >= 3 && urls.every((u) => u.includes('output_format=mp3_44100_128')), 'fixed output format on every clip');
  assert.equal(calls.fish.length, 0);
});
