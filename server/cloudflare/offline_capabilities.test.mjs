// Offline capability proof for the deterministic layer (owner, 2026-10-28). Network access is blocked for this whole
// file: any fetch fails the test. The pure scene model on main must still build, edit and read back a saved scene.
// This proves only what runs with no network; it does not prove any on-device model or device behaviour
// (see docs/CHE_OFFLINE_BRAIN_AUDIT.md). Arithmetic offline proof lives with PR #737, which is not on main yet.
import assert from 'node:assert/strict';
import test from 'node:test';

const netCalls = [];
globalThis.fetch = async (input) => { netCalls.push(String(input?.url || input)); throw new TypeError('network is off for this test'); };

const { newScene, newHistory, addObject, setProperty, identityTransform, validateScene, toJSON } = await import('./scene_document.js');

test('a saved scene is built, edited and read back with no network', () => {
  let history = newHistory(newScene({ id: 'scene_offline', name: 'Offline check', now: '2026-10-28T00:00:00Z' }));
  history = addObject(history, { id: 'chair_1', kind: 'object', name: 'Chair', asset_ref: 'object_chair', transform: identityTransform(), properties: { roughness: 0.6 } });
  history = setProperty(history, 'chair_1', 'roughness', 0.9);
  const saved = JSON.parse(JSON.stringify(toJSON(history.present)));
  assert.equal(validateScene(saved).objects[0].properties.roughness, 0.9);
  assert.equal(netCalls.length, 0, 'no network call was attempted');
});

test('the blocked network is really blocked: a fetch here fails', async () => {
  await assert.rejects(() => fetch('https://example.invalid/'), /network is off/);
  assert.equal(netCalls.length, 1);
});
