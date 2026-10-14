import assert from 'node:assert/strict';
import test from 'node:test';
import { availableVoiceChoices, parseElevenVoices, validateVoiceChoice, voiceEnvForSelection } from './voice_choices.js';

const key = { ELEVENLABS_API_KEY: 'private-key', CHE_ELEVENLABS_VOICE_ID: 'baseVoiceabcdefgh', FISH_API_KEY: 'fish-secret', CHE_FISH_VOICE_ID: 'fishVoiceabcdefgh', CHE_FISH_PREFERRED: '1' };
const voices = { voices: [
  { voice_id: 'ABCdef123456789', name: 'Clara' },
  { voice_id: 'anotherABCDE12345', name: 'Sky' },
  { voice_id: '../bad', name: 'Unsafe' },
] };

test('voice choice catalog is provider-verified and never returns API secrets', async () => {
  const calls = [];
  const list = await availableVoiceChoices(key, async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { ok: true, json: async () => voices };
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/voices');
  assert.equal(list.elevenlabs, 'Connected');
  assert.equal(list.fish, 'Connected');
  assert.deepEqual(list.options.map((v) => v.provider), ['elevenlabs', 'elevenlabs', 'fish']);
  assert.equal(JSON.stringify(list).includes('private-key'), false);
  assert.equal(JSON.stringify(list).includes('fish-secret'), false);
  assert.equal(JSON.stringify(list).includes('fishVoiceabcdefgh'), false);
});

test('missing keys are setup not a fabricated catalog', async () => {
  let called = false;
  const list = await availableVoiceChoices({}, async () => { called = true; throw Error('not allowed'); });
  assert.equal(called, false);
  assert.deepEqual(list.options, []);
  assert.equal(list.elevenlabs, 'Needs Setup');
  assert.equal(list.fish, 'Needs Setup');
});

test('unavailable provider and unauthorized voice are never selected', async () => {
  const list = await availableVoiceChoices(key, async () => ({ ok: false, status: 401 }));
  assert.equal(list.elevenlabs, 'Needs Reconnect');
  assert.equal(list.options.length, 1);
  assert.equal(validateVoiceChoice({ provider: 'elevenlabs', id: 'arbitraryABCDEFGHI', speed: 1 }, list), null);
  assert.equal(validateVoiceChoice({ provider: 'fish', id: 'fishVoiceabcdefgh', speed: 1 }, list), null);
  assert.deepEqual(validateVoiceChoice({ provider: 'fish', id: 'configured', speed: 1.1 }, list),
    { provider: 'fish', id: 'configured', speed: 1.1 });
});

test('speed and ID are validated at save time; no arbitrary voice injection', async () => {
  const list = await availableVoiceChoices(key, async () => ({ ok: true, json: async () => voices }));
  assert.deepEqual(validateVoiceChoice({ provider: 'elevenlabs', id: 'ABCdef123456789', speed: 1.04 }, list),
    { provider: 'elevenlabs', id: 'ABCdef123456789', speed: 1.04 });
  assert.equal(validateVoiceChoice({ provider: 'elevenlabs', id: '../bad', speed: 1 }, list), null);
  assert.equal(validateVoiceChoice({ provider: 'elevenlabs', id: 'ABCdef123456789', speed: 1.5 }, list), null);
  assert.equal(validateVoiceChoice({ provider: 'elevenlabs', id: 'ABCdef123456789', speed: Number.NaN }, list), null);
  assert.equal(validateVoiceChoice({ provider: 'elevenlabs', id: 'ABCdef123456789', speed: Infinity }, list), null);
});

test('selected ElevenLabs voice affects speech env without changing original secrets', () => {
  const env = Object.create(key);
  const chosen = voiceEnvForSelection(env, { provider: 'elevenlabs', id: 'ABCdef123456789', speed: 1.1 });
  assert.equal(chosen.CHE_ELEVENLABS_VOICE_ID, 'ABCdef123456789');
  assert.equal(chosen.CHE_VOICE_SPEED, '1.1');
  assert.equal(chosen.ELEVENLABS_API_KEY, key.ELEVENLABS_API_KEY);
  assert.equal(env.CHE_ELEVENLABS_VOICE_ID, key.CHE_ELEVENLABS_VOICE_ID);
  assert.equal(voiceEnvForSelection(env, { provider: 'fish', id: 'configured', speed: 1 }), env);
});
