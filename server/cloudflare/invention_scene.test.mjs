import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sceneFor, resolvePart, placedParts, visibleBoxParts, explode, reassemble, openCasing,
  setPartHidden, setPartSize, scalePart, saveScene, loadScene,
} from './invention_scene.js';
import { buildGlb, paletteFor } from './invention_visuals.js';

const byName = (scene, name) => placedParts(scene).find((p) => p.name === name);

test('the jet engine has at least 12 individually identifiable parts with stages and groups', () => {
  const scene = sceneFor('jet_engine');
  assert.ok(scene.parts.length >= 12, `only ${scene.parts.length} parts`);
  assert.equal(new Set(scene.parts.map((p) => p.name)).size, scene.parts.length, 'names must be unique');
  assert.equal(new Set(scene.parts.map((p) => p.id)).size, scene.parts.length, 'ids must be unique');
  for (const p of scene.parts) {
    assert.ok(p.stage >= 0 && p.stage <= 4, `${p.name} has stage ${p.stage}`);
    assert.ok(p.group, `${p.name} has no group`);
  }
});

test('explode separates later stages further along the axis and reports only the parts it moved', () => {
  const scene = sceneFor('jet_engine');
  const { scene: next, receipt } = explode(scene, 0.2);
  const turbine = byName(scene, 'low pressure turbine');
  const movedTurbine = byName(next, 'low pressure turbine');
  assert.equal(round(movedTurbine.c[2]), round(turbine.c[2] - 3 * 0.2));
  assert.equal(byName(next, 'front fan blades').c[2], byName(scene, 'front fan blades').c[2], 'stage 0 does not move');
  assert.ok(receipt.changed.includes('low pressure turbine'));
  assert.ok(!receipt.changed.includes('front fan blades'));
  assert.equal(receipt.verified, true);
});

test('reassemble returns every placement to exactly where it was', () => {
  const scene = sceneFor('jet_engine');
  const apart = openCasing(explode(scene, 0.35).scene, 0.2).scene;
  const back = reassemble(apart).scene;
  assert.deepEqual(placedParts(back), placedParts(scene));
});

test('opening the casing lifts the upper half and drops the lower, and nothing else moves', () => {
  const scene = sceneFor('jet_engine');
  const { scene: open, receipt } = openCasing(scene, 0.25);
  assert.equal(round(byName(open, 'casing upper').c[1]), round(byName(scene, 'casing upper').c[1] + 0.25));
  assert.equal(round(byName(open, 'casing lower').c[1]), round(byName(scene, 'casing lower').c[1] - 0.25));
  assert.deepEqual(receipt.changed.sort(), ['casing lower', 'casing upper']);
  assert.equal(receipt.unchanged, scene.parts.length - 2);
});

test('a spoken part name resolves to one part, and an ambiguous or unknown one is refused', () => {
  const scene = sceneFor('jet_engine');
  assert.equal(resolvePart(scene, 'exhaust nozzle').part.name, 'exhaust nozzle');
  assert.equal(resolvePart(scene, 'front fan').part.name, 'front fan blades');
  const ambiguous = resolvePart(scene, 'fan');
  assert.equal(ambiguous.part, null);
  assert.deepEqual(ambiguous.ambiguous.sort(), ['fan hub', 'front fan blades']);
  assert.equal(resolvePart(scene, 'afterburner').part, null);
});

test('a dimension change edits only the named part, and is refused when out of range', () => {
  const scene = sceneFor('jet_engine');
  const { scene: next, receipt } = setPartSize(scene, 'front fan blades', { x: 0.5 });
  assert.equal(byName(next, 'front fan blades').s[0], 0.5);
  assert.equal(byName(next, 'front fan blades').s[1], byName(scene, 'front fan blades').s[1]);
  assert.deepEqual(receipt.changed, ['front fan blades']);

  const refused = setPartSize(scene, 'front fan blades', { x: 9 });
  assert.equal(refused.scene, scene, 'a refused edit returns the same scene');
  assert.equal(refused.receipt.verified, false);
  assert.match(refused.receipt.error, /metres/);
  assert.equal(setPartSize(scene, 'nothing here', { x: 0.5 }).receipt.verified, false);
});

test('scaling makes a part bigger on every axis and clamps to the allowed range', () => {
  const scene = sceneFor('jet_engine');
  const { scene: next } = scalePart(scene, 'front fan blades', 1.5);
  const before = byName(scene, 'front fan blades').s; const after = byName(next, 'front fan blades').s;
  assert.deepEqual(after.map((v) => round(v)), before.map((v) => round(v * 1.5)));
  assert.equal(scalePart(scene, 'front fan blades', 10).receipt.verified, false);
});

test('a hidden part leaves the exported set and comes back when shown', () => {
  const scene = sceneFor('jet_engine');
  const { scene: hidden, receipt } = setPartHidden(scene, 'fuel line', true);
  assert.ok(!visibleBoxParts(hidden).some((p) => p.name === 'fuel line'));
  assert.deepEqual(receipt.changed, ['fuel line']);
  assert.ok(visibleBoxParts(setPartHidden(hidden, 'fuel line', false).scene).some((p) => p.name === 'fuel line'));
});

test('an edited dimension survives export: the GLB file itself holds the new size', () => {
  const scene = sceneFor('jet_engine');
  const edited = setPartSize(scene, 'front fan blades', { x: 0.5 }).scene;
  const glb = buildGlb(visibleBoxParts(edited), paletteFor('jet_engine', 'silver'));
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
  const mesh = json.meshes.find((m) => m.name === 'front fan blades');
  const pos = json.accessors[mesh.primitives[0].attributes.POSITION];
  assert.ok(Math.abs((pos.max[0] - pos.min[0]) - 0.5) < 1e-9, `x extent ${pos.max[0] - pos.min[0]}`);
  assert.ok(json.nodes.length === visibleBoxParts(edited).length);
});

test('a scene saves to JSON and reopens unchanged; a damaged save is not read as a scene', () => {
  const scene = openCasing(explode(setPartSize(sceneFor('jet_engine'), 'front fan blades', { x: 0.5 }).scene, 0.1).scene, 0.2).scene;
  const reopened = loadScene(saveScene(scene));
  assert.deepEqual(reopened, scene);
  assert.deepEqual(placedParts(reopened), placedParts(scene));
  assert.equal(loadScene('not json'), null);
  assert.equal(loadScene(JSON.stringify({ template: 'jet_engine', version: 1, parts: [{ id: 'p01' }] })), null);
});

function round(v) { return Math.round(v * 1e6) / 1e6; }
