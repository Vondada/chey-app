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

test('a character whose meshes are not in the active scene would render blank, so it fails', () => {
  assert.throws(() => validateGlb(changedModel((m) => { m.scenes[m.scene ?? 0].nodes = []; })), /active scene has no root nodes/);
  assert.throws(() => validateGlb(changedModel((m) => { for (const node of m.nodes) delete node.mesh; })), /no triangles/);
});

// The 3D crew shows real work only (owner, 2026-10-22). The page starts everyone idle, takes each character's clip
// from the app (CHE.setStates), tells the app when every model has really loaded, and does no GPU work while hidden.
test('the crew page starts idle, takes real states, reports real readiness and stops rendering when hidden', () => {
  const page = readFileSync(new URL('../../assets/characters/app/index.html', import.meta.url), 'utf8');
  const script = page.slice(page.lastIndexOf('<script>') + 8, page.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(script), 'the page script parses');
  const crew = script.slice(script.indexOf('const CREW = ['), script.indexOf('];', script.indexOf('const CREW = [')));
  assert.equal((crew.match(/clip: '([a-z]+)'/g) || []).length, 7, 'seven crew members');
  assert.doesNotMatch(crew, /clip: '(?!idle')/, 'no member starts on a working clip');
  assert.match(script, /setStates: \(states\) => setStates\(states\)/);
  assert.match(script, /pause: \(p\) =>/);
  assert.match(script, /tellApp\(\{ type: 'ready', loaded: loadedIds\.size \}\)/);
  assert.match(script, /tellApp\(\{ type: 'error', id/);
  assert.match(script, /if \(paused \|\| document\.hidden\) \{ running = false; return; \}/);
  assert.match(script, /addEventListener\('visibilitychange', resume\)/);
  assert.match(script, /for \(const c of crew\) if \(!c\.still\) c\.mixer\.update\(dt\)/, 'offline agents stand still');
});
