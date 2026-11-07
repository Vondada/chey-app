// Stage 7: the scene's look as data (lights, props, materials, actor poses, camera keys) and a voice per crew member.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIGHT_TYPES, LIMITS, PROP_KINDS, SET_TARGETS, normalizeLook } from './scene_look.js';
import { CREW_VOICES, cleanVoice, crewVoice, spokenSeconds } from './crew_voices.js';
import { CREW_MODELS, applyEdits, dispatchRender, sceneFromWords } from './scene_director.js';

const PY = readFileSync(new URL('../../tools/che_scene_look.py', import.meta.url), 'utf8');
const pyTuple = (name) => JSON.parse(`[${/^NAME = \(([^)]*)\)/m.exec(PY.replace(/^(\w+) = /gm, (m, n) => (n === name ? 'NAME = ' : m)))[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);

test('the Worker and the Blender reader agree on the schema: light types, prop kinds, material targets and limits', () => {
  assert.deepEqual(pyTuple('LIGHT_TYPES'), [...LIGHT_TYPES]);
  assert.deepEqual(pyTuple('PROP_KINDS').map(String), [...PROP_KINDS]);
  assert.deepEqual(pyTuple('SET_TARGETS'), [...SET_TARGETS]);
  const m = /MAX_LIGHTS, MAX_PROPS, MAX_MATERIALS, MAX_KEYS = (\d+), (\d+), (\d+), (\d+)/.exec(PY);
  assert.deepEqual(m.slice(1).map(Number), [LIMITS.lights, LIMITS.props, LIMITS.materials, LIMITS.keys]);
});

test('an old spec is unchanged by normalizeLook (it renders with the Stage 7 defaults)', () => {
  const { spec } = sceneFromWords('make Nova walk in and sit down');
  const out = normalizeLook(spec);
  for (const k of ['lights', 'props', 'materials']) assert.equal(k in out, false, k);
  assert.deepEqual(out.camera, spec.camera);
  assert.deepEqual(out.actors.map(({ voice, ...a }) => a), spec.actors.map(({ voice, ...a }) => a));
});

test('every look field is kept, clamped and bounded', () => {
  const spec = {
    ...sceneFromWords('make Nova walk in and sit down').spec,
    lights: [
      { id: 'sun', type: 'sun', position: [0, -3, 3], rotation: [50, 0, 20], color: '#ffd2a0', power: 99 },
      { id: 'spot', type: 'spot', position: [1, -1, 2.9], look_at: [-0.5, 0.3, 1], color: '#ff5a8a', power: 400, size: 500 },
      ...Array(20).fill({ type: 'laser', position: [99, 'x', -99], color: 'red', power: 1e9 }),
    ],
    props: [
      { id: 'crate', asset: 'box', position: [1.6, -0.8, 0], rotation: 30, scale: 0.6, material: { base_color: '#c0392b', roughness: 3 } },
      { id: 'nova-chair', asset: 'assets/characters/crew/nova.glb' },
      { id: 'evil', asset: 'assets/../../etc/passwd.glb' },
      { id: 'tea', asset: 'teapot' },
      { id: 'crate', asset: 'rug' },
    ],
    materials: { floor: { base_color: '#2b2f36', metallic: 4 }, nova: { emission: '#e2b33c', emission_strength: 999 }, 'Bad Id': { base_color: '#fff000' }, wall: { base_color: 'blue' } },
    camera: { move: 'static', keys: [{ t: 6, position: [-2, -2, 1.4], look_at: [0, 0, 1], lens: 500 }, { t: 0, position: [2, -4, 1.7], lens: 2 }] },
  };
  spec.actors = [{ ...spec.actors[0], position: [-2.6, 99], rotation: 9999 }];
  const out = normalizeLook(spec);
  assert.equal(out.lights.length, LIMITS.lights);
  assert.deepEqual(out.lights[0], { id: 'sun', type: 'sun', position: [0, -3, 3], color: '#ffd2a0', power: 20, size: 1, rotation: [50, 0, 20] });
  assert.equal(out.lights[1].size, 180, 'a spot cone is at most 180 degrees');
  assert.deepEqual(out.lights[2], { id: 'light-3', type: 'area', position: [20, -2, -20], color: '#ffffff', power: 5000, size: 1, look_at: [0, 0.4, 1] });
  assert.deepEqual(out.props.map((p) => p.id), ['crate', 'nova-chair', 'prop-5']);
  assert.deepEqual(out.props[0], { id: 'crate', asset: 'box', position: [1.6, -0.8, 0], rotation: [0, 0, 30], scale: [0.6, 0.6, 0.6], material: { base_color: '#c0392b', roughness: 1 } });
  assert.deepEqual(out.materials, { floor: { base_color: '#2b2f36', metallic: 1 }, nova: { emission: '#e2b33c', emission_strength: 50 } });
  assert.deepEqual(out.actors[0].position, [-2.6, 20]);
  assert.equal(out.actors[0].rotation, 360);
  assert.deepEqual(out.camera.keys.map((k) => [k.t, k.lens]), [[0, 12], [6, 135]]);
  assert.deepEqual(out.camera.keys[0].look_at, [0, 0.4, 1], 'a key without look_at aims at the seats');
  assert.equal(spec.lights.length, 22, 'the input is not changed');
});

test('every crew member has a distinct free voice, and talk steps are timed for that voice', () => {
  for (const id of CREW_MODELS) assert.ok(CREW_VOICES[id], `${id} has a voice`);
  const names = CREW_MODELS.map((id) => CREW_VOICES[id].voice);
  assert.equal(new Set(names).size, CREW_MODELS.length, 'no two crew members share a voice');
  assert.ok(Object.values(CREW_VOICES).every((v) => v.engine === 'piper' && cleanVoice(v)), 'all free Piper voices');
  assert.equal(crewVoice('che').voice, 'en_US-kristin-medium', 'CHE keeps the voice her scenes always had');
  assert.equal(crewVoice('stranger').voice, 'en_US-kristin-medium');
  assert.equal(cleanVoice({ engine: 'elevenlabs', voice: 'x' }), null, 'no paid provider');
  assert.equal(cleanVoice({ engine: 'piper', voice: '../../etc/passwd' }), null);
  assert.equal(cleanVoice({ engine: 'piper', voice: 'en_US-amy-medium', speed: 9 }).speed, 1.4);
  const line = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
  assert.ok(spokenSeconds(line, { speed: 1.1 }) > spokenSeconds(line, { speed: 0.95 }), 'a slower voice gets a longer talk');
  const sage = sceneFromWords(`make Sage walk in, sit down and say "${line}"`).spec;
  const talk = sage.timeline.find((s) => s.action === 'talk');
  assert.equal(sage.actors[0].voice.voice, CREW_VOICES.sage.voice);
  assert.equal(talk.t1 - talk.t0 >= spokenSeconds(talk.line, CREW_VOICES.sage) - 0.01, true);
});

test('the render request carries the clamped look and each actor\'s voice, and a voice change reuses the frames', async () => {
  const { spec } = sceneFromWords('make Knox walk in and sit down');
  const sent = [];
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app' };
  const fetcher = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); };
  const look = { ...spec, version: 1, lights: [{ type: 'point', power: 1e9 }], actors: [{ ...spec.actors[0], voice: { engine: 'piper', voice: 'bad name' } }] };
  const project = { id: 'p1', title: 't', at: 0, versions: [look], renders: [] };
  assert.equal((await dispatchRender(env, project, fetcher, 1000)).ok, true);
  const payload = JSON.parse(sent[0].inputs.spec);
  assert.equal(payload.lights[0].power, 5000, 'clamped before it leaves CHE');
  assert.equal(payload.actors[0].voice.voice, CREW_VOICES.knox.voice, 'a malformed voice becomes the crew member\'s own');
  // A ready render of version 1; version 2 only changes the voice, so its frames are reused.
  project.renders[0] = { ...project.renders[0], status: 'ready', run_id: 777 };
  project.versions.push({ ...look, version: 2, actors: [{ ...look.actors[0], voice: CREW_VOICES.atlas }] });
  project.at = 1;
  const again = await dispatchRender(env, project, fetcher, 2000);
  assert.equal(again.reused, true);
  assert.equal(sent[1].inputs.frames_run, '777');
  // Moving a light is a 3D change: a new render.
  project.versions.push({ ...look, version: 3, lights: [{ type: 'point', power: 10 }] });
  project.at = 2;
  assert.equal((await dispatchRender(env, project, fetcher, 3000)).reused, false);
  assert.equal(typeof applyEdits, 'function');
});
