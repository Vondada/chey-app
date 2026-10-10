// The bundled viewer's offline asset contract, using Node's standard library.
// This is a packaging check, not a full glTF conformance or GPU performance test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const crewIds = ['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris'];
export const requiredClips = ['idle', 'walk', 'run', 'wave', 'sit', 'stand', 'talk', 'think', 'celebrate', 'nod', 'shake'];

export function validateGlb(bytes) {
  assert.ok(bytes.length >= 20, 'GLB header is truncated');
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF', 'Expected binary glTF');
  assert.equal(bytes.readUInt32LE(4), 2, 'Expected GLB version 2');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length differs from the file');
  const chunks = [];
  for (let offset = 12; offset < bytes.length;) {
    assert.ok(offset + 8 <= bytes.length, 'Truncated chunk header');
    const size = bytes.readUInt32LE(offset);
    assert.equal(size % 4, 0, 'Chunk length must be four-byte aligned');
    assert.ok(offset + 8 + size <= bytes.length, 'Chunk exceeds file');
    chunks.push({ type: bytes.readUInt32LE(offset + 4), data: bytes.subarray(offset + 8, offset + 8 + size) });
    offset += 8 + size;
  }
  assert.equal(chunks.length, 2, 'Bundled models need JSON and embedded BIN chunks');
  assert.equal(chunks[0].type, 0x4e4f534a, 'First chunk must be JSON');
  assert.equal(chunks[1].type, 0x004e4942, 'Second chunk must be BIN');
  const model = JSON.parse(chunks[0].data.toString('utf8'));
  assert.equal(model.asset?.version, '2.0');
  assert.equal(model.buffers?.length, 1, 'Expected one embedded buffer');
  assert.ok(!model.buffers[0].uri, 'External buffers cannot load from the offline viewer');
  const length = model.buffers[0].byteLength;
  assert.ok(Number.isSafeInteger(length) && length > 0 && length <= chunks[1].data.length && chunks[1].data.length - length <= 3, 'Invalid BIN length');
  for (const view of model.bufferViews || []) {
    assert.equal(view.buffer, 0, 'Buffer view must use the embedded buffer');
    const start = view.byteOffset ?? 0;
    assert.ok(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(view.byteLength) && view.byteLength > 0 && start + view.byteLength <= length, 'Buffer view exceeds BIN');
  }
  for (const image of model.images || []) {
    assert.ok(!image.uri && model.bufferViews?.[image.bufferView], 'Textures must be embedded');
  }
  assert.ok(model.skins?.length > 0, 'A crew character needs a skeleton');
  for (const skin of model.skins) {
    assert.ok(skin.joints?.length > 0 && skin.joints.every((i) => Number.isInteger(i) && model.nodes?.[i]), 'Invalid skeleton joints');
  }
  const clips = (model.animations || []).map((a) => a.name);
  for (const name of requiredClips) assert.ok(clips.includes(name), `Missing viewer animation: ${name}`);
  assert.equal(new Set(clips).size, clips.length, 'Duplicate animation names');
  for (const animation of model.animations) {
    assert.ok(animation.channels?.length > 0, `Empty animation: ${animation.name}`);
    for (const channel of animation.channels) {
      const sampler = animation.samplers?.[channel.sampler];
      assert.ok(sampler && model.accessors?.[sampler.input] && model.accessors?.[sampler.output] && model.nodes?.[channel.target?.node], 'Invalid animation target or sampler');
    }
  }
  let triangles = 0;
  for (const mesh of model.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      assert.equal(primitive.mode ?? 4, 4, 'Crew meshes must use triangles');
      assert.ok(model.accessors?.[primitive.attributes?.POSITION], 'Mesh has no positions');
      const count = model.accessors?.[primitive.indices ?? primitive.attributes.POSITION]?.count;
      assert.ok(Number.isSafeInteger(count) && count > 0 && count % 3 === 0, 'Invalid triangle accessor count');
      triangles += count / 3;
    }
  }
  assert.ok(triangles > 0, 'Character has no triangles');
  return { bytes: bytes.length, triangles, clips: clips.length, joints: model.skins.map((s) => s.joints.length) };
}

export function validateCrew(root = new URL('../../', import.meta.url)) {
  const manifest = readFileSync(new URL('pubspec.yaml', root), 'utf8');
  for (const folder of ['assets/characters/crew/', 'assets/characters/app/', 'assets/office3d/']) {
    assert.ok(manifest.split(/\r?\n/).some((line) => line.trim() === `- ${folder}`), `${folder} is not bundled by Flutter`);
  }
  // All script dependencies of both scenes must resolve locally in the bundle.
  for (const page of ['assets/characters/app/index.html', 'assets/office3d/index.html']) {
    const url = new URL(page, root);
    for (const match of readFileSync(url, 'utf8').matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
      assert.ok(!/^(?:[a-z]+:|\/\/)/i.test(match[1]), `Remote scene dependency: ${match[1]}`);
      assert.ok(readFileSync(new URL(match[1], url)).length > 0, 'Empty scene dependency');
    }
  }
  return crewIds.map((id) => ({ id, ...validateGlb(readFileSync(new URL(`assets/characters/crew/${id}.glb`, root))) }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const results = validateCrew();
    console.log(JSON.stringify({ models: results, totalBytes: results.reduce((sum, r) => sum + r.bytes, 0), totalTriangles: results.reduce((sum, r) => sum + r.triangles, 0) }, null, 2));
  } catch (error) {
    console.error(`${fileURLToPath(import.meta.url)}: ${error.message}`);
    process.exitCode = 1;
  }
}
