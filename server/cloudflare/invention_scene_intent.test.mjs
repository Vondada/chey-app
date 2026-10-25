import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneIntent, runSceneSentence } from './invention_scene_intent.js';
import { placedParts } from './invention_scene.js';

const at = (scene, name) => placedParts(scene).find((p) => p.name === name);

test('the Kimi-style sentences are recognised as the intended edits', () => {
  assert.deepEqual(sceneIntent('CHE, build a jet engine.'), { kind: 'build', template: 'jet_engine' });
  assert.equal(sceneIntent('Open the casing.').op, 'openCasing');
  assert.equal(sceneIntent('Open the casing further').amount, 0.4);
  assert.equal(sceneIntent('Close the casing').amount, 0);
  assert.equal(sceneIntent('Separate the turbine stages.').op, 'explode');
  assert.equal(sceneIntent('Give the stages more space').op, 'explode');
  assert.equal(sceneIntent('Put everything back together.').op, 'reassemble');
  assert.deepEqual(sceneIntent('Make the front fan larger'), { kind: 'edit', op: 'scale', part: 'front fan', factor: 1.5 });
  assert.deepEqual(sceneIntent('Hide the fuel line'), { kind: 'edit', op: 'hide', hidden: true, part: 'fuel line' });
});

test('ordinary chat is not read as a scene edit', () => {
  assert.equal(sceneIntent('what is the weather today'), null);
  assert.equal(sceneIntent('open the mail'), null);
  assert.equal(sceneIntent(''), null);
});

test('a build sentence creates the jet engine, and the reply lists its parts', () => {
  const r = runSceneSentence(null, 'CHE, build a jet engine.');
  assert.equal(r.ok, true);
  assert.equal(r.receipt.verified, true);
  assert.ok(r.scene.parts.length >= 12);
  assert.match(r.reply, /Built a jet engine with 15 named parts/);
});

test('an edit before any model exists is refused with the next step, not silently', () => {
  const r = runSceneSentence(null, 'Open the casing');
  assert.equal(r.receipt, null);
  assert.match(r.reply, /build a jet engine/);
});

test('opening the casing changes the real scene and the reply reports exactly which parts moved', () => {
  const built = runSceneSentence(null, 'build a jet engine').scene;
  const r = runSceneSentence(built, 'Open the casing further');
  assert.deepEqual(r.receipt.changed.sort(), ['casing lower', 'casing upper']);
  assert.ok(at(r.scene, 'casing upper').c[1] > at(built, 'casing upper').c[1]);
  assert.match(r.reply, /Changed 2 parts/);
  assert.match(r.reply, /version 2/);
});

test('"make the front fan larger" changes only the fan blades', () => {
  const built = runSceneSentence(null, 'build a jet engine').scene;
  const r = runSceneSentence(built, 'Make the front fan larger');
  assert.deepEqual(r.receipt.changed, ['front fan blades']);
  assert.ok(Math.abs(at(r.scene, 'front fan blades').s[0] - 0.36 * 1.5) < 1e-9);
});

test('an ambiguous part name asks which one, and changes nothing', () => {
  const built = runSceneSentence(null, 'build a jet engine').scene;
  const r = runSceneSentence(built, 'Hide the fan');
  assert.equal(r.receipt, null);
  assert.match(r.reply, /Which one do you mean: front fan blades or fan hub\?/);
  assert.equal(r.scene, built);
});

test('an unknown part is reported as not found, not guessed', () => {
  const built = runSceneSentence(null, 'build a jet engine').scene;
  assert.match(runSceneSentence(built, 'Hide the afterburner').reply, /could not find a part called "afterburner"/);
});
