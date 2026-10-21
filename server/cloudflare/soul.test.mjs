// CHE's Soul module: one versioned, owner-editable personality. Traits change manner only, every change is a new
// version with history, restores never rewrite history, and provenance says whether the model actually saw the Soul.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSoul, normalizeTraits, restoreSoul, saveSoul, soulHash, soulPromptBlock, soulProvenance, soulView, stripPhoneSoul, SOUL_TRAITS } from './soul.js';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    put: async (key, value) => { map.set(key, structuredClone(value)); },
  };
}

test('the built-in Soul is version 0 with the default traits, and nothing is written until the owner changes it', async () => {
  const storage = memoryStorage();
  const profile = await loadSoul(storage);
  const view = soulView(profile);
  assert.equal(view.version, 0);
  assert.equal(view.default, true);
  for (const [key, spec] of Object.entries(SOUL_TRAITS)) assert.equal(view.traits[key], spec.default, key);
  assert.equal(storage.map.size, 0);
});

test('an owner change is saved as the next version, with the previous version kept in history', async () => {
  const storage = memoryStorage();
  await saveSoul(storage, { traits: { playfulness: 9 } }, { now: '2026-10-21T12:00:00.000Z' });
  const second = await saveSoul(storage, { traits: { warmth: 2 }, text: 'Keep it short.' });
  const view = soulView(second);
  assert.equal(view.version, 2);
  assert.equal(view.traits.playfulness, 9, 'unchanged traits are kept');
  assert.equal(view.traits.warmth, 2);
  assert.equal(view.text, 'Keep it short.');
  assert.deepEqual(view.history.map((entry) => entry.version), [1, 0]);
  assert.equal(view.history[0].traits.playfulness, 9);
  assert.equal(view.history[1].traits.warmth, SOUL_TRAITS.warmth.default);
});

test('traits are whole numbers from 0 to 10, and a non-number is refused rather than guessed', () => {
  assert.equal(normalizeTraits({ warmth: 42 }).warmth, 10);
  assert.equal(normalizeTraits({ warmth: -3 }).warmth, 0);
  assert.equal(normalizeTraits({ warmth: 6.6 }).warmth, 7);
  assert.equal(normalizeTraits({ warmth: '' }).warmth, SOUL_TRAITS.warmth.default);
  assert.throws(() => normalizeTraits({ warmth: 'loud' }), /soul_trait_warmth_not_a_number/);
});

test('a restore is a new version that copies the old settings; history is never rewritten', async () => {
  const storage = memoryStorage();
  await saveSoul(storage, { traits: { formality: 9 }, text: 'Formal.' });
  await saveSoul(storage, { traits: { formality: 1 }, text: 'Casual.' });
  const restored = await restoreSoul(storage, 1);
  const view = soulView(restored);
  assert.equal(view.version, 3);
  assert.equal(view.traits.formality, 9);
  assert.equal(view.text, 'Formal.');
  assert.equal(view.reason, 'restored version 1');
  assert.deepEqual(view.history.map((entry) => entry.version), [2, 1, 0]);
  await assert.rejects(() => restoreSoul(storage, 99), /soul_version_not_found/);
  const original = soulView(await restoreSoul(storage, 0));
  assert.equal(original.traits.warmth, SOUL_TRAITS.warmth.default, 'the built-in Soul can always be restored');
});

test('the hash changes when the Soul changes and is the same for the same Soul', () => {
  const traits = normalizeTraits({});
  assert.equal(soulHash({ traits, text: '' }), soulHash({ traits: { ...traits }, text: '' }));
  assert.notEqual(soulHash({ traits, text: '' }), soulHash({ traits: { ...traits, warmth: 1 }, text: '' }));
  assert.match(soulHash({ traits, text: '' }), /^[0-9a-f]{8}$/);
});

test('the prompt block states the version, hash, the trait settings and the owner notes, and says evidence outranks it', async () => {
  const storage = memoryStorage();
  const profile = await saveSoul(storage, { traits: { playfulness: 10 }, text: 'Call me Alex.' });
  const block = soulPromptBlock(profile);
  assert.match(block, /^SOUL v1 \([0-9a-f]{8}\)/);
  assert.match(block, /Playfulness 10\/10: Playful and witty/);
  assert.match(block, /Call me Alex\./);
  assert.match(block, /never override evidence, permissions or numbers/);
});

test('provenance says applied only when the model received the Soul; otherwise it gives the reason', async () => {
  const profile = await loadSoul(memoryStorage());
  const applied = soulProvenance(profile, { applied: true, route: 'model' });
  assert.equal(applied.soul_loaded, true);
  assert.equal(applied.soul_applied, true);
  assert.equal(applied.reason, '');
  const notApplied = soulProvenance(profile, { applied: false, route: 'deterministic', reason: 'a stored record answered' });
  assert.equal(notApplied.soul_applied, false);
  assert.equal(notApplied.reason, 'a stored record answered');
  assert.equal(soulProvenance(profile, {}).soul_applied, false, 'never applied by default');
});

test('a Soul sent by the phone inside brain context is removed: the Worker Soul is the only personality', () => {
  const brain = '[CHE SOUL — who you are. Stay in this personality at all times.]\nProduct name: CHE\n\n[Facts]\n- favourite food: pasta';
  const stripped = stripPhoneSoul(brain);
  assert.doesNotMatch(stripped, /Product name/);
  assert.match(stripped, /\[Facts\]/);
  assert.equal(stripPhoneSoul(''), '');
});
