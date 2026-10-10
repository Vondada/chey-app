import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateCrew, validateGlb } from './validate_assets.mjs';

const real = readFileSync(new URL('../../assets/characters/crew/che.glb', import.meta.url));
function changedModel(edit) {
  const jsonLength = real.readUInt32LE(12);
  const model = JSON.parse(real.toString('utf8', 20, 20 + jsonLength));
  edit(model);
  const json = Buffer.from(JSON.stringify(model));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const header = Buffer.from(real.subarray(0, 20));
  header.writeUInt32LE(padded.length, 12);
  const result = Buffer.concat([header, padded, real.subarray(20 + jsonLength)]);
  result.writeUInt32LE(result.length, 8);
  return result;
}

test('all eight real characters and both offline scene dependency sets are packaged', () => {
  const results = validateCrew();
  assert.equal(results.length, 8);
  for (const model of results) assert.equal(model.clips, 11);
});

test('a truncated export fails before it can be packaged', () => {
  assert.throws(() => validateGlb(real.subarray(0, real.length - 16)), /length differs/);
});

test('missing animation and skeleton references fail with a useful reason', () => {
  assert.throws(() => validateGlb(changedModel((m) => { m.animations = m.animations.filter((a) => a.name !== 'wave'); })), /Missing viewer animation: wave/);
  assert.throws(() => validateGlb(changedModel((m) => { m.skins[0].joints[0] = m.nodes.length; })), /Invalid skeleton/);
});

test('external textures and corrupt binary views cannot pass the offline contract', () => {
  assert.throws(() => validateGlb(changedModel((m) => { m.images[0].uri = 'https://example.invalid/texture.png'; })), /Textures must be embedded/);
  assert.throws(() => validateGlb(changedModel((m) => { m.bufferViews[0].byteOffset = m.buffers[0].byteLength; })), /Buffer view exceeds BIN/);
});
