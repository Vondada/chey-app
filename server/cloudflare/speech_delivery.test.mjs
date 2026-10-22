import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseEngine, cloningAllowed, deliveryCacheKey, makeVoiceProfile, planDelivery, sentenceKind } from './speech_delivery.js';

const consented = { owner_confirmed: true };

test('a cloning reference needs the owner\'s consent; ElevenLabs output needs its own explicit permission', () => {
  assert.equal(cloningAllowed({ reference_source: 'owner_recording' }).allowed, false, 'no consent recorded');
  assert.equal(cloningAllowed({ reference_source: 'owner_recording', consent: consented }).allowed, true);
  const eleven = { reference_source: 'elevenlabs_generated', consent: consented };
  assert.equal(cloningAllowed(eleven).allowed, false, 'ElevenLabs audio is never training material by default');
  assert.match(cloningAllowed(eleven).reason, /explicit permission/);
  assert.equal(cloningAllowed({ reference_source: 'elevenlabs_generated', consent: { ...consented, explicit_permission_to_train_on_elevenlabs: true } }).allowed, true);
  assert.equal(cloningAllowed({ reference_source: 'unknown', consent: consented }).allowed, false, 'an unrecorded source is refused');
});

test('a Fish profile that names a reference voice is refused without consent, and saved with it', () => {
  const refused = makeVoiceProfile({ id: 'chey-main', provider: 'fish', provider_voice_id: 'abc123', reference_source: 'owner_recording' });
  assert.equal(refused.ok, false);
  const saved = makeVoiceProfile({ id: 'chey-main', provider: 'fish', provider_voice_id: 'abc123', reference_source: 'owner_recording', consent: consented, pronunciation: { CHE: 'chay' } });
  assert.equal(saved.ok, true);
  assert.equal(saved.profile.pronunciation.CHE, 'chay');
  assert.equal(makeVoiceProfile({ id: 'Bad Id!' }).ok, false, 'an invalid id is refused');
});

test('questions rise at the end and keep their pace; serious and empathetic lines slow down; excitement is quicker', () => {
  const q = planDelivery('Should I place the trade now?');
  assert.equal(q.kind, 'question');
  assert.equal(q.final_pitch, 'rise');
  assert.equal(q.speed, 1);
  const serious = planDelivery('Careful, this trade carries a real risk of loss.');
  assert.equal(serious.kind, 'serious');
  assert.ok(serious.speed < planDelivery('The trade is open.').speed, 'serious speech is slower');
  assert.equal(sentenceKind('I\'m sorry, that sounds hard.'), 'empathy');
  assert.equal(sentenceKind('Haha, that was a good one.'), 'humor');
  assert.equal(sentenceKind('I am not sure that is right.'), 'uncertain');
  assert.ok(planDelivery('That worked perfectly!').speed > planDelivery('That worked perfectly.').speed, 'excitement is quicker');
});

test('pauses fall after commas, semicolons, dashes and sentence ends, with the longest at the end', () => {
  const plan = planDelivery('First, we check the level; then we wait... Done.');
  const ms = plan.pauses.map((p) => p.ms);
  assert.deepEqual(ms, [180, 260, 320, 420]);
  assert.ok(plan.pauses.every((p, i, all) => i === 0 || p.at > all[i - 1].at), 'pauses are in reading order');
});

test('emphasis lands on negations and capitalised words, and the plan says the engine cannot yet take it', () => {
  const plan = planDelivery('Do NOT enter before the open.');
  assert.deepEqual(plan.emphasis.map((e) => e.word), ['NOT'], 'only the stressed negation, not the auxiliary');
  assert.equal(plan.controls.emphasis.startsWith('planned only'), true, 'emphasis is not claimed as delivered');
  assert.equal(plan.controls.pitch_contour.startsWith('planned only'), true);
});

test('a plan never asks for a faster voice than the engine allows', () => {
  assert.ok(planDelivery('Wow!', { base_speed: 1.2 }).speed <= 1.2);
  assert.ok(planDelivery('Slow.', { base_speed: 0.5 }).speed >= 0.7);
});

test('the engine chain keeps the saved voice when it can; a fallback is named, never silent', () => {
  const profile = makeVoiceProfile({ id: 'chey-main', provider: 'fish', provider_voice_id: 'abc123', reference_source: 'owner_recording', consent: consented }).profile;
  const both = chooseEngine(profile, { fish: { ready: true }, kokoro: { ready: true } });
  assert.equal(both[0].engine, 'fish');
  assert.equal(both[0].preserves_voice_identity, true);
  assert.equal(both[1].engine, 'kokoro');
  assert.equal(both[1].preserves_voice_identity, false, 'the local voice is not the saved profile');
  assert.match(both[1].warning, /not your saved voice profile/);

  const fishDown = chooseEngine(profile, { fish: { ready: false }, kokoro: { ready: true } });
  assert.equal(fishDown[0].engine, 'kokoro', 'a down provider falls back to the local voice, with the warning');
});

test('with no engine ready, nothing is invented: the chain is empty', () => {
  const profile = makeVoiceProfile({ id: 'chey-main', provider: 'fish', provider_voice_id: 'abc123', reference_source: 'owner_recording', consent: consented }).profile;
  assert.deepEqual(chooseEngine(profile, {}), []);
});

test('a cache entry is the same audio only for the same profile, engine, voice, speed and text', () => {
  const profile = { id: 'chey-main', provider_voice_id: 'abc123' };
  const base = deliveryCacheKey({ profile, engine: 'fish', text: 'Hello.', speed: 1 });
  assert.equal(base, deliveryCacheKey({ profile, engine: 'fish', text: 'Hello.', speed: 1 }));
  assert.notEqual(base, deliveryCacheKey({ profile, engine: 'fish', text: 'Hello.', speed: 1.06 }), 'speed changes the audio');
  assert.notEqual(base, deliveryCacheKey({ profile: { ...profile, id: 'other' }, engine: 'fish', text: 'Hello.', speed: 1 }));
  assert.notEqual(base, deliveryCacheKey({ profile, engine: 'kokoro', text: 'Hello.', speed: 1 }));
});
