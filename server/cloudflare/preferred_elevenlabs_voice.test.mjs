import assert from 'node:assert/strict';
import test from 'node:test';
import {
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

test('a quota or auth error pauses Mary, so later clips go straight to the free voice', async () => {
  resetPreferredElevenLabsPause();
  let calls = 0;
  const quota = async () => { calls++; return new Response('quota', { status: 429 }); };
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi', quota), null);
  assert.equal(await preferredElevenLabsSpeech(env, 'Hi again', quota), null);
  assert.equal(calls, 1);
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
