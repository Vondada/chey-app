import assert from 'node:assert/strict';
import test from 'node:test';
import {
  preferredElevenLabsKeyStatus,
  preferredElevenLabsReady,
  preferredElevenLabsSpeech,
  resetPreferredElevenLabsPause,
} from './preferred_elevenlabs_voice.js';

const env = {
  CHE_ELEVENLABS_PREFERRED: '1',
  CHE_ELEVENLABS_VOICE_ID: 'GgMNbwMsOI1mIBUkirnu',
  ELEVENLABS_API_KEY: 'test-secret-never-real',
};

test('paid voice is off by default even when the key and voice ID exist', async () => {
  let calls = 0;
  const noOptIn = { ...env, CHE_ELEVENLABS_PREFERRED: '' };
  assert.equal(preferredElevenLabsReady(noOptIn), false);
  assert.equal(await preferredElevenLabsSpeech(noOptIn, 'Hi', async () => { calls++; }), null);
  assert.equal(calls, 0);
});

test('configured opt-in uses Mary and Flash v2.5 without enabling paid AI', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x01]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  };
  const result = await preferredElevenLabsSpeech(env, 'Hi sir', fetcher);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('X-CHE-Voice'), 'elevenlabs-mary');
  assert.match(calls[0].url, /GgMNbwMsOI1mIBUkirnu/);
  assert.equal(calls[0].init.headers['xi-api-key'], env.ELEVENLABS_API_KEY);
  assert.equal(JSON.parse(calls[0].init.body).model_id, 'eleven_flash_v2_5');
  assert.equal(JSON.parse(calls[0].init.body).text, 'Hi sir');
  assert.equal(calls.length, 1);
});

test('bad voice ID, missing credentials, or overly long clips never incur a request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('bad'); };
  for (const overrides of [{ ELEVENLABS_API_KEY: '' }, { CHE_ELEVENLABS_VOICE_ID: 'bad!' }]) {
    assert.equal(await preferredElevenLabsSpeech({ ...env, ...overrides }, 'Hello', fetcher), null);
  }
  assert.equal(await preferredElevenLabsSpeech(env, 'a'.repeat(801), fetcher), null);
  assert.equal(calls, 0);
});

test('provider errors, JSON response, and empty clips fall back to free voice', async () => {
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', async () => new Response('quota', { status: 429 })), null);
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })), null);
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', async () => new Response(null, { headers: { 'Content-Type': 'audio/mpeg' } })), null);
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', async () => { throw Error('unavailable'); }), null);
});

test('a rate limit pauses Mary for half a minute, so a busy moment does not silence the voice for ten', async (t) => {
  resetPreferredElevenLabsPause();
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const limited = async () => { calls++; return new Response('slow down', { status: 429 }); };
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', limited), null);
  now += 10_000;
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi again', limited), null);
  assert.equal(calls, 1, 'paused during the short backoff');
  now += 31_000;
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi later', limited), null);
  assert.equal(calls, 2, 'tried again once the backoff ends');
  resetPreferredElevenLabsPause();
});

test('a bad key or spent credits stays paused for minutes, so later clips go straight to the free voice', async (t) => {
  resetPreferredElevenLabsPause();
  let now = 2_000_000;
  t.mock.method(Date, 'now', () => now);
  let denied = 0;
  const denial = async () => { denied++; return new Response('{"detail":{"status":"invalid_api_key"}}', { status: 401 }); };
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', denial), null);
  now += 5 * 60 * 1000;
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', denial), null);
  assert.equal(denied, 1, 'a bad key is not retried for minutes');
  now += 6 * 60 * 1000;
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', denial), null);
  assert.equal(denied, 2, 'retried after the long pause');
  resetPreferredElevenLabsPause();
});

test('a server error pauses Mary for a minute, and a 402 pauses it for the long time', async (t) => {
  resetPreferredElevenLabsPause();
  let now = 3_000_000;
  t.mock.method(Date, 'now', () => now);
  let serverErrors = 0;
  const broken = async () => { serverErrors++; return new Response('oops', { status: 503 }); };
  await preferredElevenLabsSpeech(env, 'Hi', broken);
  now += 61_000;
  await preferredElevenLabsSpeech(env, 'Hi', broken);
  assert.equal(serverErrors, 2, 'a server blip clears within a minute');
  resetPreferredElevenLabsPause();
  now += 1;
  let payment = 0;
  const unpaid = async () => { payment++; return new Response('pay', { status: 402 }); };
  await preferredElevenLabsSpeech(env, 'Hi', unpaid);
  now += 5 * 60 * 1000;
  await preferredElevenLabsSpeech(env, 'Hi', unpaid);
  assert.equal(payment, 1, 'out of credits waits for the owner, not seconds');
  resetPreferredElevenLabsPause();
});

test('a quota message on a 401 is reported as out of credits, not as a dead key', async () => {
  resetPreferredElevenLabsPause();
  await preferredElevenLabsSpeech(env, 'Hi', async () => new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 }));
  assert.equal(preferredElevenLabsKeyStatus(env).status, 'out of credits');
  resetPreferredElevenLabsPause();
});

test('the Keys tab sees Mary\'s state in plain words, and never the key itself', async (t) => {
  resetPreferredElevenLabsPause();
  let now = 4_000_000;
  t.mock.method(Date, 'now', () => now);
  assert.equal(preferredElevenLabsKeyStatus({ ...env, CHE_ELEVENLABS_PREFERRED: '' }).status, 'not set up');
  assert.equal(preferredElevenLabsKeyStatus(env).status, 'not tried yet');
  await preferredElevenLabsSpeech(env, 'Hi', async () => new Response('slow', { status: 429 }));
  const limited = preferredElevenLabsKeyStatus(env, now);
  assert.equal(limited.status, 'rate-limited');
  assert.equal(limited.last4, 'real', 'only the last four characters of the key');
  assert.match(limited.detail, /HTTP 429/);
  assert.match(limited.detail, /waits until/);
  assert.equal(JSON.stringify(limited).includes(env.ELEVENLABS_API_KEY), false);
  now += 31_000;
  await preferredElevenLabsSpeech(env, 'Hi', async () => new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/mpeg' } }));
  assert.equal(preferredElevenLabsKeyStatus(env, now).status, 'healthy');
  resetPreferredElevenLabsPause();
});

test('a timeout pauses Mary briefly, while one rejected clip does not', async () => {
  resetPreferredElevenLabsPause();
  let timeouts = 0;
  const slow = async () => { timeouts++; throw new DOMException('timed out', 'TimeoutError'); };
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', slow), null);
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', slow), null);
  assert.equal(timeouts, 1);
  resetPreferredElevenLabsPause();
  let rejected = 0;
  const badClip = async () => { rejected++; return new Response('bad text', { status: 422 }); };
  await preferredElevenLabsSpeech(env, 'Hi', badClip);
  await preferredElevenLabsSpeech(env, 'Hi', badClip);
  assert.equal(rejected, 2);
  resetPreferredElevenLabsPause();
});

test('after a pause, Mary is tried again and returns the real audio bytes', async () => {
  resetPreferredElevenLabsPause();
  await preferredElevenLabsSpeech(env, 'Hi', async () => new Response('quota', { status: 429 }));
  resetPreferredElevenLabsPause();
  const clip = new Uint8Array([9, 8, 7]);
  const audio = await preferredElevenLabsSpeech(env, 'Hi', async () => new Response(clip, {
    headers: { 'Content-Type': 'audio/mpeg' },
  }));
  assert.equal(audio.headers.get('X-CHE-Voice'), 'elevenlabs-mary');
  assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [9, 8, 7]);
  resetPreferredElevenLabsPause();
});
