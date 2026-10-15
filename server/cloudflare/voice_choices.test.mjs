import assert from 'node:assert/strict';
import test from 'node:test';
import { availableVoiceChoices, parseElevenVoices, validateVoiceChoice, voiceEnvForSelection } from './voice_choices.js';
import { elevenVoiceSettings } from './preferred_elevenlabs_voice.js';

const key = { ELEVENLABS_API_KEY: 'private-key', CHE_ELEVENLABS_PREFERRED: '1', CHE_ELEVENLABS_VOICE_ID: 'baseVoiceabcdefgh', FISH_API_KEY: 'fish-secret', CHE_FISH_VOICE_ID: 'fishVoiceabcdefgh', CHE_FISH_PREFERRED: '1' };
const voices = { voices: [
  { voice_id: 'ABCdef123456789', name: 'Clara' },
  { voice_id: 'anotherABCDE12345', name: 'Sky' },
  { voice_id: '../bad', name: 'Unsafe' },
] };
const models = [
  { model_id: 'eleven_flash_v2_5', name: 'Flash v2.5', can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: true, token_cost_factor: 0.5 },
  { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: true, token_cost_factor: 1 },
];
const fakeAccount = (url) => {
  if (String(url).includes('/v1/models')) return { ok: true, json: async () => models };
  if (String(url).includes('api.fish.audio')) return { ok: true, json: async () => ({ items: [{ _id: 'fishmodelABCDEF12', title: 'My Fish' }], has_more: false }) };
  return { ok: true, json: async () => voices };
};

test('voice choice catalog is read from the current ElevenLabs voice API and never returns secrets', async () => {
  const calls = [];
  const list = await availableVoiceChoices(key, async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return fakeAccount(url);
  });
  assert.match(calls[0].url, /^https:\/\/api\.elevenlabs\.io\/v2\/voices\?page_size=100$/);
  assert.equal(calls[0].headers['xi-api-key'], 'private-key');
  assert.equal(list.elevenlabs, 'Connected');
  assert.equal(list.fish, 'Connected');
  assert.deepEqual(list.options.map((v) => v.provider), ['elevenlabs', 'elevenlabs', 'fish', 'fish']);
  assert.deepEqual(list.models.elevenlabs.map((m) => m.id), ['eleven_flash_v2_5', 'eleven_multilingual_v2']);
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

test('an account key without explicit ElevenLabs paid voice opt-in is not used', async () => {
  const urls = [];
  const disabled = { ...key, CHE_ELEVENLABS_PREFERRED: '0' };
  const list = await availableVoiceChoices(disabled, async (url) => { urls.push(String(url)); return fakeAccount(url); });
  assert.equal(urls.some((u) => u.includes('elevenlabs')), false, 'no ElevenLabs request without the opt-in');
  assert.equal(list.elevenlabs, 'Needs Setup');
  assert.equal(list.options.some((x) => x.provider === 'elevenlabs'), false);
});

test('unavailable provider and unauthorized voice are never selected', async () => {
  const list = await availableVoiceChoices(key, async () => ({ ok: false, status: 401 }));
  assert.equal(list.elevenlabs, 'Needs Reconnect');
  assert.match(list.elevenlabs_reason, /refused the key/);
  assert.equal(list.options.length, 1);
  assert.equal(validateVoiceChoice({ provider: 'elevenlabs', id: 'arbitraryABCDEFGHI', speed: 1 }, list), null);
  assert.equal(validateVoiceChoice({ provider: 'fish', id: 'fishVoiceabcdefgh', speed: 1 }, list), null);
  assert.deepEqual(validateVoiceChoice({ provider: 'fish', id: 'configured', speed: 1.1 }, list),
    { provider: 'fish', id: 'configured', speed: 1.1 });
});

test('speed and ID are validated at save time; no arbitrary voice injection', async () => {
  const list = await availableVoiceChoices(key, async (url) => fakeAccount(url));
  assert.deepEqual(validateVoiceChoice({ provider: 'elevenlabs', id: 'ABCdef123456789', speed: 1.04 }, list),
    { provider: 'elevenlabs', id: 'ABCdef123456789', speed: 1.04 });
  assert.equal(validateVoiceChoice({ provider: 'elevenlabs', id: '../bad', speed: 1 }, list), null);
  assert.equal(validateVoiceChoice({ provider: 'elevenlabs', id: 'ABCdef123456789', speed: 1.5 }, list), null);
  assert.equal(validateVoiceChoice({ provider: 'elevenlabs', id: 'ABCdef123456789', speed: Number.NaN }, list), null);
  assert.equal(validateVoiceChoice({ provider: 'elevenlabs', id: 'ABCdef123456789', speed: Infinity }, list), null);
});

test('a model is accepted only when the account lists it, and settings only where that model allows them', async () => {
  const list = await availableVoiceChoices(key, async (url) => fakeAccount(url));
  const base = { provider: 'elevenlabs', id: 'ABCdef123456789', speed: 1 };
  assert.deepEqual(validateVoiceChoice({ ...base, model_id: 'eleven_multilingual_v2', settings: { stability: 0.3, similarity_boost: 0.9, style: 0.4, use_speaker_boost: false } }, list),
    { ...base, model_id: 'eleven_multilingual_v2', settings: { stability: 0.3, similarity_boost: 0.9, style: 0.4, use_speaker_boost: false } });
  assert.equal(validateVoiceChoice({ ...base, model_id: 'eleven_made_up' }, list), null, 'a model the account does not list is refused');
  assert.equal(validateVoiceChoice({ ...base, model_id: 'eleven_flash_v2_5', settings: { style: 0.4 } }, list), null, 'Flash cannot use style');
  assert.equal(validateVoiceChoice({ ...base, settings: { stability: 2 } }, list), null, 'out-of-range settings are refused');
  assert.equal(validateVoiceChoice({ provider: 'fish', id: 'fishmodelABCDEF12', speed: 1, model_id: 'eleven_flash_v2_5' }, list), null);
});

test('selected voice, model and settings reach the speech env; original secrets are untouched', () => {
  const env = Object.create(key);
  const chosen = voiceEnvForSelection(env, { provider: 'elevenlabs', id: 'ABCdef123456789', speed: 1.1, model_id: 'eleven_multilingual_v2', settings: { stability: 0.3, style: 0.5, use_speaker_boost: false } });
  assert.equal(chosen.CHE_ELEVENLABS_VOICE_ID, 'ABCdef123456789');
  assert.equal(chosen.CHE_VOICE_SPEED, '1.1');
  assert.equal(chosen.CHE_ELEVENLABS_MODEL, 'eleven_multilingual_v2');
  assert.equal(chosen.CHE_VOICE_STABILITY, '0.3');
  assert.equal(chosen.CHE_VOICE_STYLE, '0.5');
  assert.equal(chosen.CHE_VOICE_SPEAKER_BOOST, '0');
  assert.equal(chosen.ELEVENLABS_API_KEY, key.ELEVENLABS_API_KEY);
  assert.equal(env.CHE_ELEVENLABS_VOICE_ID, key.CHE_ELEVENLABS_VOICE_ID);
  assert.equal(env.CHE_VOICE_STABILITY, undefined);
  const fish = voiceEnvForSelection(env, { provider: 'fish', id: 'configured', speed: 1.15 });
  assert.equal(fish.CHE_FISH_SPEED, '1.15');
  assert.equal(fish.FISH_API_KEY, key.FISH_API_KEY);
  assert.equal(env.CHE_FISH_SPEED, undefined);
  const fishModel = voiceEnvForSelection(env, { provider: 'fish', id: 'fishmodelABCDEF12', speed: 1 });
  assert.equal(fishModel.CHE_FISH_VOICE_ID, 'fishmodelABCDEF12');
});

test('with no owner settings, Mary keeps the defaults CHE has always used', () => {
  assert.deepEqual(elevenVoiceSettings({}), { stability: 0.6, similarity_boost: 0.82, style: 0.15, use_speaker_boost: true });
  assert.deepEqual(elevenVoiceSettings({ CHE_VOICE_STABILITY: '0.25', CHE_VOICE_SPEAKER_BOOST: 'false', CHE_VOICE_STYLE: '9' }),
    { stability: 0.25, similarity_boost: 0.82, style: 0.15, use_speaker_boost: false }, 'an out-of-range value keeps the default');
  assert.equal(parseElevenVoices(voices).length, 2);
});
