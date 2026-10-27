// Character registry: one persistent ID per named character, versions never edited, scenes pin their version,
// and missing models are reported as missing rather than replaced.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHARACTER_IDS, CHARACTER_REGISTRY_KEY, assetRefs, bundledModel, defaultRegistry, loadRegistry, modelStatus, publishVersion, saveRegistry, versionOf } from './character_registry.js';

const memStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed));
  return { get: async (k) => data.get(k), put: async (k, v) => { data.set(k, v); }, data };
};

test('all ten named characters exist with their bundled GLBs; Orion and Vale are reported missing', () => {
  const registry = defaultRegistry(1000);
  assert.deepEqual(Object.keys(registry.characters), [...CHARACTER_IDS]);
  assert.equal(CHARACTER_IDS.length, 10);
  const { ready, missing } = modelStatus(registry);
  assert.deepEqual(missing, ['orion', 'vale']);
  assert.equal(ready.length, 8);
  assert.deepEqual(bundledModel('nova'), { format: 'glb', path: 'assets/characters/crew/nova.glb' });
  assert.equal(bundledModel('orion'), null);
});

test('publishing a change appends a version, keeps the earlier one, and does not mutate the input', () => {
  const before = defaultRegistry(1000);
  const snapshot = JSON.stringify(before);
  const after = publishVersion(before, 'nova', { appearance: { hair: 'short auburn' }, note: 'New hair.' }, 2000);
  assert.equal(JSON.stringify(before), snapshot, 'input registry is not mutated');
  assert.equal(after.characters.nova.versions.length, 2);
  assert.equal(versionOf(after, 'nova', 1).appearance, null, 'version 1 keeps its original appearance');
  assert.equal(versionOf(after, 'nova', 2).appearance.hair, 'short auburn');
  assert.equal(versionOf(after, 'nova', 2).model.path, 'assets/characters/crew/nova.glb', 'unchanged model carries forward');
});

test('a scene pinned to version 1 still resolves version 1 after Nova is updated', () => {
  const v1 = defaultRegistry(1000);
  const pinned = assetRefs(v1, 'nova', 1);
  const updated = publishVersion(v1, 'nova', { appearance: { hair: 'short auburn' } }, 2000);
  assert.equal(assetRefs(updated, 'nova', 1).version, 1);
  assert.equal(assetRefs(updated, 'nova', 1).appearance, null);
  assert.deepEqual(pinned, assetRefs(updated, 'nova', 1));
  assert.equal(assetRefs(updated, 'nova').version, 2, 'latest is used only when no version is pinned');
});

test('unknown characters, unknown fields and non-GLB models are refused', () => {
  const registry = defaultRegistry(1000);
  assert.throws(() => publishVersion(registry, 'zed', {}), /Unknown character/);
  assert.throws(() => publishVersion(registry, 'nova', { hair_colour: 'red' }), /Unknown field/);
  assert.throws(() => publishVersion(registry, 'nova', { model: { format: 'fbx', path: 'x.fbx' } }), /Unsupported model format/);
});

test('an orphaned model gets a real GLB reference when one is published; no flat image is accepted', () => {
  const registry = defaultRegistry(1000);
  const vale = publishVersion(registry, 'vale', { model: { format: 'glb', path: 'characters/vale/v2.glb' }, rig: 'skeleton in the GLB' }, 2000);
  assert.equal(modelStatus(vale).missing.includes('vale'), false);
  assert.throws(() => publishVersion(registry, 'vale', { model: { format: 'png', path: 'vale.png' } }), /Unsupported model format/);
});

test('storage round trip keeps every stored version and fills missing named characters', async () => {
  const storage = memStorage();
  const saved = publishVersion(defaultRegistry(1000), 'nova', { appearance: { eyes: 'green' } }, 2000);
  await saveRegistry(storage, saved);
  assert.ok(storage.data.has(CHARACTER_REGISTRY_KEY));
  const loaded = await loadRegistry(storage, 3000);
  assert.equal(loaded.characters.nova.versions.length, 2);
  assert.equal(loaded.characters.orion.versions.length, 1, 'a named character missing from storage is filled in');
  const empty = await loadRegistry(memStorage(), 3000);
  assert.equal(empty.characters.che.versions[0].version, 1);
});
