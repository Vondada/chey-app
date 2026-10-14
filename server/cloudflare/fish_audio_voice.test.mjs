import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FISH_DEFAULT_EXPRESSIVE_MODEL,
  FISH_DEFAULT_MODEL,
  FISH_SECRET_NAMES,
  classifyFishFailure,
  fishAudioDiagnostics,
  fishAudioKeyStatus,
  fishAudioReady,
  fishAudioSpeech,
  fishCharacterVoices,
  fishModelFor,
  fishSecretsFrom,
  readFishUsage,
  resetFishAudioState,
} from './fish_audio_voice.js';
import { cheSpokenText } from './che_pronunciation.js';

const KEY = 'fish-test-key-ABCD';
const VOICE = '802e3bc2b27e49c2995d23ef70e6ac89';
const env = (extra = {}) => ({ FISH_API_KEY: KEY, CHE_FISH_VOICE_ID: VOICE, CHE_FISH_PREFERRED: '1', ...extra });
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

function memoryStorage() {
  const saved = new Map();
  return {
    saved,
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
  };
}

// A fake Fish endpoint that records every request.
function fakeFish(reply = () => new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg' } })) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return reply(calls.length, calls[calls.length - 1]);
  };
  return { calls, fetcher };
}

test.beforeEach(() => resetFishAudioState());

test('Fish speaks only when the key, the voice and the owner setting are all present', () => {
  assert.equal(fishAudioReady(env()), true);
  assert.equal(fishAudioReady(env({ FISH_API_KEY: '' })), false);
  assert.equal(fishAudioReady(env({ CHE_FISH_VOICE_ID: 'bad id!' })), false);
  assert.equal(fishAudioReady(env({ CHE_FISH_PREFERRED: '0' })), false);
  assert.equal(fishAudioReady(env({ CHE_FISH_PREFERRED: '' })), false);
});

test('everyday speech uses the free model; stories and narration use Drama 3', () => {
  assert.equal(FISH_DEFAULT_MODEL, 's2.1-pro-free');
  assert.equal(FISH_DEFAULT_EXPRESSIVE_MODEL, 'drama-3');
  assert.equal(fishModelFor(env()), 's2.1-pro-free');
  assert.equal(fishModelFor(env(), 'read'), 's2.1-pro-free');
  assert.equal(fishModelFor(env(), 'story'), 'drama-3');
  assert.equal(fishModelFor(env(), 'narration'), 'drama-3');
  assert.equal(fishModelFor(env({ CHE_FISH_MODEL: 's2-pro' })), 's2-pro');
  assert.equal(fishModelFor(env({ CHE_FISH_EXPRESSIVE_MODEL: 'drama-3-preview' }), 'story'), 'drama-3-preview');
  // A malformed setting never reaches the header; the default is used.
  assert.equal(fishModelFor(env({ CHE_FISH_MODEL: 'x\r\nInjected: 1' })), 's2.1-pro-free');
});

test('the request carries only the final speech text, the voice and the model header', async () => {
  const storage = memoryStorage();
  const { calls, fetcher } = fakeFish();
  const response = await fishAudioSpeech(env(), '  Good morning,   sir.  ', { storage, fetcher });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-CHE-Voice'), 'fish-audio');
  assert.equal(response.headers.get('X-CHE-Fish-Model'), 's2.1-pro-free');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), MP3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.fish.audio/v1/tts');
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].headers.model, 's2.1-pro-free');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['format', 'latency', 'mp3_bitrate', 'normalize', 'reference_id', 'text']);
  assert.equal(calls[0].body.text, 'Good morning, sir.');
  assert.equal(calls[0].body.reference_id, VOICE);
  assert.equal(calls[0].body.format, 'mp3');
  assert.equal(calls[0].body.latency, 'balanced');
});

test('a story goes to Drama 3 at narration quality', async () => {
  const { calls, fetcher } = fakeFish();
  const response = await fishAudioSpeech(env(), 'Once upon a time, a lighthouse keeper heard a knock.', { purpose: 'story', storage: memoryStorage(), fetcher });
  assert.equal(response.headers.get('X-CHE-Fish-Model'), 'drama-3');
  assert.equal(calls[0].headers.model, 'drama-3');
  assert.equal(calls[0].body.mp3_bitrate, 128);
  assert.equal(calls[0].body.latency, 'normal');
});

test('the same words are synthesized once: the second time comes from the cache', async () => {
  const storage = memoryStorage();
  const { calls, fetcher } = fakeFish();
  await fishAudioSpeech(env(), 'Your meeting starts at ten.', { storage, fetcher });
  const again = await fishAudioSpeech(env(), 'Your meeting starts at ten.', { storage, fetcher });
  assert.equal(calls.length, 1);
  assert.equal(again.headers.get('X-CHE-Cache'), 'hit');
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), MP3);
  await fishAudioSpeech(env(), 'Your meeting starts at eleven.', { storage, fetcher });
  assert.equal(calls.length, 2, 'different words are new audio');
  const usage = await readFishUsage(storage);
  assert.equal(usage.models['s2.1-pro-free'].requests, 2);
  assert.equal(usage.models['s2.1-pro-free'].cache_hits, 1);
  assert.equal(usage.models['s2.1-pro-free'].chars, 'Your meeting starts at ten.'.length + 'Your meeting starts at eleven.'.length);
});

test('two identical requests at once share one synthesis', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { calls, fetcher } = fakeFish(async () => { await gate; return new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg' } }); });
  const storage = memoryStorage();
  const first = fishAudioSpeech(env(), 'Hello sir.', { storage, fetcher });
  const second = fishAudioSpeech(env(), 'Hello sir.', { storage, fetcher });
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('X-CHE-Cache'), 'shared');
});

test('long narration is stored in parts and comes back whole', async () => {
  const big = new Uint8Array(2_500_000).map((_, i) => i % 251);
  const storage = memoryStorage();
  const { calls, fetcher } = fakeFish(() => new Response(big, { headers: { 'Content-Type': 'audio/mpeg' } }));
  await fishAudioSpeech(env(), 'A long narration.', { purpose: 'narration', storage, fetcher });
  const parts = [...storage.saved.keys()].filter((key) => key.startsWith('fish_tts:'));
  assert.equal(parts.length, 3, '2.5 MB is three parts under the 2 MB value limit');
  assert.ok(parts.every((key) => storage.saved.get(key).byteLength <= 1_000_000));
  const again = await fishAudioSpeech(env(), 'A long narration.', { purpose: 'narration', storage, fetcher });
  assert.equal(calls.length, 1);
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), big);
});

test('the cache is bounded: the oldest clips are evicted', async () => {
  const storage = memoryStorage();
  const { fetcher } = fakeFish();
  for (let i = 0; i < 85; i += 1) await fishAudioSpeech(env(), `Clip number ${i}.`, { storage, fetcher });
  const index = storage.saved.get('fish_tts_index');
  assert.equal(index.length, 80);
  assert.ok(!index.some((entry) => entry.model !== 's2.1-pro-free'));
  const parts = [...storage.saved.keys()].filter((key) => /^fish_tts:[0-9a-f]+:\d+$/.test(key));
  assert.equal(parts.length, 80, 'evicted clips leave no parts behind');
});

test('a refused key falls back at once and rests every model; the key is never exposed', async () => {
  const { calls, fetcher } = fakeFish(() => new Response('{"message":"Invalid API key fish-test-key-ABCD"}', { status: 401 }));
  const storage = memoryStorage();
  assert.equal(await fishAudioSpeech(env(), 'Hello.', { storage, fetcher }), null);
  assert.equal(await fishAudioSpeech(env(), 'A story.', { purpose: 'story', storage, fetcher }), null);
  assert.equal(calls.length, 1, 'no second call while the key is refused');
  const status = fishAudioKeyStatus(env());
  assert.equal(status.status, 'unauthorized');
  assert.equal(status.last4, 'ABCD');
  const exposed = JSON.stringify({ status, diagnostics: fishAudioDiagnostics(env()) });
  assert.doesNotMatch(exposed, /fish-test-key|802e3bc2/);
});

test('a model the account cannot use rests only that model', async () => {
  const { calls, fetcher } = fakeFish((n, call) => (call.headers.model === 's2.1-pro-free'
    ? new Response('{"message":"Model not available on your plan"}', { status: 403 })
    : new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg' } })));
  const storage = memoryStorage();
  assert.equal(await fishAudioSpeech(env(), 'Hello.', { storage, fetcher }), null);
  assert.equal(fishAudioKeyStatus(env()).status, 'model not available');
  assert.equal(await fishAudioSpeech(env(), 'Hello again.', { storage, fetcher }), null);
  assert.equal(calls.length, 1, 'the unavailable model is not retried');
  const story = await fishAudioSpeech(env(), 'Once upon a time.', { purpose: 'story', storage, fetcher });
  assert.equal(story.status, 200, 'the expressive model still works');
});

test('out of credits, rate limits and server errors map to the Keys words', () => {
  assert.equal(classifyFishFailure(402, '').status, 'out of credits');
  assert.equal(classifyFishFailure(400, 'Insufficient balance').status, 'out of credits');
  assert.equal(classifyFishFailure(429, '').status, 'rate-limited');
  assert.equal(classifyFishFailure(503, '').status, 'network');
  assert.equal(classifyFishFailure(403, 'forbidden').status, 'unauthorized');
  assert.equal(classifyFishFailure(422, 'unknown model drama-9').status, 'model not available');
  assert.equal(classifyFishFailure(400, 'text is empty').refused, true);
});

test('a rate limit rests Fish for seconds, then Fish is tried again', async () => {
  let limited = true;
  const { calls, fetcher } = fakeFish(() => (limited
    ? new Response('slow down', { status: 429 })
    : new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg' } })));
  const storage = memoryStorage();
  const now = Date.now();
  assert.equal(await fishAudioSpeech(env(), 'One.', { storage, fetcher, now }), null);
  assert.equal(await fishAudioSpeech(env(), 'Two.', { storage, fetcher, now: now + 10_000 }), null);
  assert.equal(calls.length, 1);
  limited = false;
  const later = await fishAudioSpeech(env(), 'Three.', { storage, fetcher, now: now + 31_000 });
  assert.equal(later.status, 200);
  assert.equal(fishAudioKeyStatus(env()).status, 'healthy');
});

test('text Fish refuses is skipped on the second voice route, other text is not', async () => {
  const { calls, fetcher } = fakeFish((n) => (n === 1
    ? new Response('{"message":"text invalid"}', { status: 400 })
    : new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg' } })));
  const storage = memoryStorage();
  assert.equal(await fishAudioSpeech(env(), 'Weird text.', { storage, fetcher }), null);
  assert.equal(await fishAudioSpeech(env(), 'Weird text.', { storage, fetcher }), null);
  assert.equal(calls.length, 1);
  assert.equal((await fishAudioSpeech(env(), 'Normal text.', { storage, fetcher })).status, 200);
});

test('a timeout rests Fish briefly so it cannot slow every clip', async () => {
  const { calls, fetcher } = fakeFish(() => { throw new DOMException('timed out', 'TimeoutError'); });
  const storage = memoryStorage();
  assert.equal(await fishAudioSpeech(env(), 'Hello.', { storage, fetcher }), null);
  assert.equal(await fishAudioSpeech(env(), 'Hello again.', { storage, fetcher }), null);
  assert.equal(calls.length, 1);
  assert.equal(fishAudioKeyStatus(env()).status, 'network');
});

test('a reply that is not audio is not played', async () => {
  const { fetcher } = fakeFish(() => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }));
  assert.equal(await fishAudioSpeech(env(), 'Hello.', { storage: memoryStorage(), fetcher }), null);
});

test('measured slowness rests Fish so the faster voice answers', async () => {
  let clock = 1_000_000;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const { calls, fetcher } = fakeFish(() => { clock += 6000; return new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg' } }); });
    const storage = memoryStorage();
    for (const said of ['One.', 'Two.', 'Three.']) {
      assert.equal((await fishAudioSpeech(env(), said, { storage, fetcher, now: clock })).status, 200);
    }
    assert.equal(fishAudioKeyStatus(env(), clock).status, 'slow');
    assert.equal(await fishAudioSpeech(env(), 'Four.', { storage, fetcher, now: clock }), null);
    assert.equal(calls.length, 3);
  } finally {
    Date.now = realNow;
  }
});

test('Drama 3 stops at the daily character cap', async () => {
  const { calls, fetcher } = fakeFish();
  const storage = memoryStorage();
  const capped = env({ CHE_FISH_EXPRESSIVE_DAILY_CHARS: '30' });
  assert.equal((await fishAudioSpeech(capped, 'Twenty characters ok', { purpose: 'story', storage, fetcher })).status, 200);
  assert.equal(await fishAudioSpeech(capped, 'Another twenty chars', { purpose: 'story', storage, fetcher }), null);
  assert.equal(calls.length, 1);
  assert.equal(fishAudioKeyStatus(capped).status, 'daily limit reached');
  assert.equal((await fishAudioSpeech(capped, 'Everyday speech is not capped.', { storage, fetcher })).status, 200);
});

test('settings that arrive empty use the defaults, not zero', async () => {
  // The Worker hands live settings to the Durable Object with absent values as
  // empty strings. An empty daily cap must not become a cap of zero.
  const live = { ...fishSecretsFrom(env()) };
  assert.equal(live.CHE_FISH_EXPRESSIVE_DAILY_CHARS, '');
  const { calls, fetcher } = fakeFish();
  const story = await fishAudioSpeech(live, 'Once upon a time.', { purpose: 'story', storage: memoryStorage(), fetcher });
  assert.equal(story.status, 200);
  assert.equal(calls[0].headers.model, 'drama-3');
  assert.equal('prosody' in calls[0].body, false, 'an empty speed is the natural speed');
});

test('a conversational clip over 800 characters is left to the other voices', async () => {
  const { calls, fetcher } = fakeFish();
  assert.equal(await fishAudioSpeech(env(), 'x'.repeat(801), { storage: memoryStorage(), fetcher }), null);
  assert.equal(calls.length, 0);
});

test('only character voices the owner authorized by name can be used', async () => {
  const characters = env({ CHE_FISH_CHARACTER_VOICES: JSON.stringify({ Narrator: 'aaaaaaaa11111111', 'bad name!': 'bbbbbbbb22222222', villain: 'x' }) });
  assert.deepEqual(fishCharacterVoices(characters), { narrator: 'aaaaaaaa11111111' });
  const { calls, fetcher } = fakeFish();
  const storage = memoryStorage();
  assert.equal((await fishAudioSpeech(characters, 'The night was cold.', { purpose: 'story', character: 'narrator', storage, fetcher })).status, 200);
  assert.equal(calls[0].body.reference_id, 'aaaaaaaa11111111');
  assert.equal(await fishAudioSpeech(characters, 'Hi.', { character: VOICE, storage, fetcher }), null, 'a raw voice ID is not a character');
  assert.equal(await fishAudioSpeech(characters, 'Hi.', { character: 'villain', storage, fetcher }), null);
  assert.equal(calls.length, 1);
});

test('the Keys row explains each setup step without the key', () => {
  assert.equal(fishAudioKeyStatus({}).status, 'not set up');
  assert.match(fishAudioKeyStatus({}).detail, /FISH_API_KEY/);
  assert.equal(fishAudioKeyStatus({ FISH_API_KEY: KEY }).status, 'needs a voice');
  assert.equal(fishAudioKeyStatus(env({ CHE_FISH_PREFERRED: '0' })).status, 'off');
  const fresh = fishAudioKeyStatus(env());
  assert.equal(fresh.status, 'not tried yet');
  assert.match(fresh.detail, /s2\.1-pro-free/);
  assert.match(fresh.detail, /drama-3/);
  assert.doesNotMatch(JSON.stringify(fresh), new RegExp(KEY));
});

test('the live settings copy only Fish settings and send absent ones empty', () => {
  const copied = fishSecretsFrom({ FISH_API_KEY: KEY, GROQ_API_KEY: 'do-not-copy' });
  assert.deepEqual(Object.keys(copied).sort(), [...FISH_SECRET_NAMES].sort());
  assert.equal(copied.FISH_API_KEY, KEY);
  assert.equal(copied.CHE_FISH_VOICE_ID, '');
});

test('CHE is spoken as "Chay"; other words are untouched', () => {
  assert.equal(cheSpokenText("I'm CHE. CHE's update is ready."), "I'm Chay. Chay's update is ready.");
  assert.equal(cheSpokenText('Che here.'), 'Chay here.');
  assert.equal(cheSpokenText('Check the cheese, CHEF.'), 'Check the cheese, CHEF.');
});
