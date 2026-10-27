// Scene timeline: the owner's sentence becomes a checked plan; unknown steps, missing models and routes that cannot keep
// the rig are reported, never invented.
import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultRegistry, publishVersion } from './character_registry.js';
import { assetGaps, buildShots, parseRequest, planScene, RENDER_ROUTES, routesFor } from './scene_timeline.js';

const REQUEST = 'CHE, create Nova in a realistic recording studio, make her walk to the microphone, speak, and render a 15-second video.';
const registry = defaultRegistry(1000);
// A Nova version with the face, voice and clips a speaking, walking shot needs (the bundled crew has none saved yet).
const withAssets = publishVersion(registry, 'nova', { face: { shapes: 'arkit-52' }, voice: { id: 'nova-voice' }, rig: 'skeleton in the bundled GLB' }, 1500);
const FAKE_BLENDER = [{ id: 'fake_blender', label: 'Test Blender route', keeps_rig: true, gpu: false, built: true, note: '' }];

test('the owner sentence parses to a character, a length, a setting and ordered steps', () => {
  const p = parseRequest(REQUEST);
  assert.equal(p.character_id, 'nova');
  assert.equal(p.seconds, 15);
  assert.equal(p.setting, 'realistic recording studio');
  assert.deepEqual(p.steps.map((s) => s.action), ['walk', 'speak']);
  assert.equal(p.steps[0].target, 'microphone');
  assert.deepEqual(p.unsupported, []);
});

test('unknown steps are listed as unsupported, never guessed into an action', () => {
  const p = parseRequest('Nova, juggle three chainsaws, then speak');
  assert.ok(p.unsupported.some((u) => /juggle/.test(u)));
  assert.deepEqual(p.steps.map((s) => s.action), ['speak']);
});

test('shots fill the requested length exactly, with idle for the rest', () => {
  const shots = buildShots([{ action: 'walk', target: 'microphone' }, { action: 'speak', text: null }], 15);
  assert.deepEqual(shots.map((s) => [s.action, s.t0, s.t1]), [['walk', 0, 4], ['speak', 4, 7], ['wait', 7, 15]]);
  assert.equal(shots.at(-1).t1, 15);
});

test('steps longer than the requested length are refused, not cut', () => {
  assert.throws(() => buildShots([{ action: 'walk' }, { action: 'walk' }], 5), /need 8s/);
});

test('a character with no model is blocked and the reason names the missing asset', () => {
  const plan = planScene('Create Orion in a studio, make him walk to the desk, render a 10-second video', registry);
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.reasons.some((r) => /no model/i.test(r)), plan.reasons.join(' | '));
});

test('a speaking step with no saved face or voice is blocked, and the reason names the missing asset', () => {
  const plan = planScene(REQUEST, registry, { routes: FAKE_BLENDER });
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.reasons.some((r) => /no face asset/.test(r)), plan.reasons.join(' | '));
  assert.ok(plan.reasons.some((r) => /no voice asset/.test(r)), plan.reasons.join(' | '));
});

test('with assets present but no built route that keeps the rig, a plan is blocked and the routes say why', () => {
  const plan = planScene(REQUEST, withAssets);
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.reasons.some((r) => /No render route can make this yet/.test(r)));
  const ltx = routesFor({ shots: [{ action: 'speak' }], character: { model: { path: 'x' } } }).find((r) => r.id === 'ltx_kaggle');
  assert.equal(ltx.eligible, false);
  assert.ok(ltx.reasons.some((r) => /rigged character/.test(r)));
});

test('a Nova plan is ready once a route that keeps the rig is available, and pins her version', () => {
  const plan = planScene(REQUEST, withAssets, { routes: FAKE_BLENDER, now: 5 });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.character.id, 'nova');
  assert.equal(plan.character.version, 2, 'the version that carries the face and voice assets');
  assert.equal(plan.frames, 15 * 24);
  assert.equal(plan.shots.at(-1).t1, 15);
  assert.equal(plan.routes[0].eligible, true);
});

test('a new Nova version pins to the version in the plan, and older versions are not touched', () => {
  const updated = publishVersion(withAssets, 'nova', { appearance: { hair: 'short auburn' } }, 2000);
  const plan = planScene(REQUEST, updated, { routes: FAKE_BLENDER });
  assert.equal(plan.character.version, 3);
  assert.equal(planScene(REQUEST, withAssets, { routes: FAKE_BLENDER }).character.version, 2, 'the earlier pinned version is unchanged');
});

test('length limits and missing names are reported', () => {
  assert.equal(planScene('Nova walks, render a 500-second video', registry, { routes: FAKE_BLENDER }).status, 'blocked');
  const noName = planScene('make a video of a person walking', registry, { routes: FAKE_BLENDER });
  assert.equal(noName.status, 'blocked');
  assert.match(noName.reasons[0], /No named character/);
});

test('the built routes list is honest: the Blender routes are not built and the LTX route is not eligible for a rig', () => {
  const byId = Object.fromEntries(RENDER_ROUTES.map((r) => [r.id, r]));
  assert.equal(byId.blender_gpu_kaggle.built, false);
  assert.equal(byId.blender_cpu_actions.built, false);
  assert.equal(byId.ltx_kaggle.keeps_rig, false);
});

test('an unknown action inside a "make" clause is reported, not dropped', () => {
  const p = parseRequest('Create Nova in a studio, make her juggle three chainsaws, render a 15-second video');
  assert.ok(p.unsupported.some((u) => /juggle/.test(u)), JSON.stringify(p.unsupported));
});

test('quoted dialogue with commas, "and" or "then" stays in its own speech step', () => {
  const p = parseRequest('Create Nova in a studio, say "Hello, world and then goodbye", render a 15-second video');
  assert.deepEqual(p.unsupported, []);
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].text, 'Hello, world and then goodbye');
});

test('each speech step keeps its own quotation', () => {
  const p = parseRequest('Create Nova in a studio, say "Hello", then say "Goodbye", render a 15-second video');
  assert.deepEqual(p.steps.map((s) => s.text), ['Hello', 'Goodbye']);
});

test('a step without its animation is blocked: sit is not in Nova\'s library', () => {
  const plan = planScene('Create Nova in a studio, make her sit down, render a 10-second video', withAssets, { routes: FAKE_BLENDER });
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.reasons.some((r) => /no "sit" animation/.test(r)), plan.reasons.join(' | '));
});

test('assetGaps returns nothing when every step is supported by the version', () => {
  assert.deepEqual(assetGaps([{ action: 'walk', clip: 'walk' }], withAssets.characters.nova.versions.at(-1)), []);
});
