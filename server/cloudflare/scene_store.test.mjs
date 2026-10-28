// Tests for scene_store.js (M2b). A fake storage stands in for the Worker's durable storage; each test checks real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScene, getScene, saveScene, listScenes, sceneRoute, SCENES_KEY, templateObjects } from './scene_store.js';
import { BUILT_IN } from './avatar_identity.js';
import { addObject, setProperty, newHistory, newScene, identityTransform, toJSON } from './scene_document.js';

const fakeStorage = () => {
  const data = new Map();
  return {
    data,
    async get(k) { return data.has(k) ? structuredClone(data.get(k)) : undefined; },
    async put(k, v) { data.set(k, structuredClone(v)); },
  };
};

const NOW = '2026-10-28T10:00:00.000Z';
const later = '2026-10-28T11:00:00.000Z';

test('a blank scene is created, stored, and read back with version 1', async () => {
  const st = fakeStorage();
  const made = await createScene(st, { name: 'Living room', template: 'blank', id: 'scene_aaaaaaaaaaaa', now: NOW });
  assert.equal(made.ok, true);
  assert.equal(made.status, 201);
  assert.equal(made.version, 1);
  const got = await getScene(st, 'scene_aaaaaaaaaaaa');
  assert.equal(got.ok, true);
  assert.equal(got.scene.name, 'Living room');
  assert.deepEqual(got.scene.objects, []);
});

test('a person template starts with a character that points at a real built-in preset', async () => {
  const st = fakeStorage();
  const made = await createScene(st, { template: 'person', id: 'scene_bbbbbbbbbbbb', now: NOW });
  assert.equal(made.ok, true);
  const character = made.scene.objects[0];
  assert.equal(character.kind, 'character');
  assert.equal(character.asset_ref, BUILT_IN[0].id, 'the reference must be an existing preset ID');
  assert.equal(character.properties.height_m, 1.7);
});

test('an unknown template is refused and nothing is stored', async () => {
  const st = fakeStorage();
  const out = await createScene(st, { template: 'dragon_world', now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.status, 422);
  assert.equal(st.data.has(SCENES_KEY), false);
});

test('a save at the loaded version stores the change and bumps the version', async () => {
  const st = fakeStorage();
  await createScene(st, { id: 'scene_cccccccccccc', template: 'blank', now: NOW });
  const loaded = await getScene(st, 'scene_cccccccccccc');
  const h = addObject(newHistory(loaded.scene), {
    id: 'lamp_1', kind: 'object', name: 'Desk lamp', asset_ref: 'object_lamp', transform: identityTransform(), properties: { color: '#ffcc00' },
  });
  const out = await saveScene(st, 'scene_cccccccccccc', { scene: toJSON(h.present), expected_version: 1, now: later });
  assert.equal(out.ok, true);
  assert.equal(out.version, 2);
  const again = await getScene(st, 'scene_cccccccccccc');
  assert.equal(again.scene.objects[0].properties.color, '#ffcc00', 'the saved edit is what loads back');
});

test('a save from an older copy is refused, and the stored scene comes back instead of being overwritten', async () => {
  const st = fakeStorage();
  await createScene(st, { id: 'scene_dddddddddddd', template: 'blank', now: NOW });
  const first = await getScene(st, 'scene_dddddddddddd');
  await saveScene(st, 'scene_dddddddddddd', { scene: first.scene, expected_version: 1, now: later });
  const stale = addObject(newHistory(first.scene), {
    id: 'rug_1', kind: 'object', name: 'Rug', asset_ref: 'object_rug', transform: identityTransform(), properties: {},
  });
  const out = await saveScene(st, 'scene_dddddddddddd', { scene: toJSON(stale.present), expected_version: 1, now: later });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.version, 2, 'the stored version is reported');
  assert.deepEqual(out.scene.objects, [], 'the stale edit did not reach storage');
});

test('a save with a broken scene is refused, and the stored scene stays as it was', async () => {
  const st = fakeStorage();
  await createScene(st, { id: 'scene_eeeeeeeeeeee', template: 'blank', now: NOW });
  const broken = { ...newScene({ id: 'scene_eeeeeeeeeeee', name: 'Bad' }), objects: [{ id: 'x', kind: 'dragon', name: 'x', asset_ref: 'x' }] };
  const out = await saveScene(st, 'scene_eeeeeeeeeeee', { scene: broken, expected_version: 1, now: later });
  assert.equal(out.ok, false);
  assert.equal(out.status, 422);
  assert.equal((await getScene(st, 'scene_eeeeeeeeeeee')).version, 1);
});

test('a property outside its range is refused at save time', async () => {
  const st = fakeStorage();
  await createScene(st, { id: 'scene_ffffffffffff', template: 'blank', now: NOW });
  const bad = addObject(newHistory((await getScene(st, 'scene_ffffffffffff')).scene), {
    id: 'o1', kind: 'object', name: 'Cup', asset_ref: 'object_cup', transform: identityTransform(), properties: { roughness: 0.4 },
  });
  const tampered = toJSON(bad.present);
  tampered.objects[0].properties.roughness = 7;
  const out = await saveScene(st, 'scene_ffffffffffff', { scene: tampered, expected_version: 1, now: later });
  assert.equal(out.ok, false);
  assert.match(out.detail, /from 0 to 1/);
});

test('the scene ID cannot be changed by a save', async () => {
  const st = fakeStorage();
  await createScene(st, { id: 'scene_111111111111', template: 'blank', now: NOW });
  const loaded = await getScene(st, 'scene_111111111111');
  const renamed = { ...loaded.scene, id: 'scene_222222222222' };
  const out = await saveScene(st, 'scene_111111111111', { scene: renamed, expected_version: 1, now: later });
  assert.equal(out.ok, false);
  assert.equal(out.field, 'id');
});

test('a save needs the version it was loaded at', async () => {
  const st = fakeStorage();
  await createScene(st, { id: 'scene_333333333333', template: 'blank', now: NOW });
  const scene = (await getScene(st, 'scene_333333333333')).scene;
  const out = await saveScene(st, 'scene_333333333333', { scene, now: later });
  assert.equal(out.ok, false);
  assert.equal(out.field, 'expected_version');
});

test('the list shows each scene newest first, as summaries', async () => {
  const st = fakeStorage();
  await createScene(st, { id: 'scene_444444444444', name: 'Older', template: 'blank', now: NOW });
  await createScene(st, { id: 'scene_555555555555', name: 'Newer', template: 'room', now: later });
  const list = await listScenes(st);
  assert.deepEqual(list.map((s) => s.name), ['Newer', 'Older']);
  assert.equal(list[0].objects, 0);
});

test('the routes map GET and POST for the list and GET and PUT for one scene', async () => {
  const st = fakeStorage();
  const created = await sceneRoute({ storage: st, now: NOW }, '/api/scenes', 'POST', { name: 'Route test', template: 'blank', id: 'scene_666666666666' });
  assert.equal(created.status, 201);
  const listed = await sceneRoute({ storage: st, now: NOW }, '/api/scenes', 'GET');
  assert.equal(listed.body.scenes.length, 1);
  const one = await sceneRoute({ storage: st, now: NOW }, '/api/scenes/scene_666666666666', 'GET');
  assert.equal(one.body.version, 1);
  const bad = await sceneRoute({ storage: st, now: NOW }, '/api/scenes', 'DELETE');
  assert.equal(bad.status, 405);
  assert.equal(await sceneRoute({ storage: st, now: NOW }, '/api/other', 'GET'), null);
});

test('templateObjects returns nothing for a blank canvas', () => {
  assert.deepEqual(templateObjects('blank'), []);
});

test('the live scene probe runs create, save, stale-refusal and reopen through the owner routes', async () => {
  const st = fakeStorage();
  // Stands in for the test CHE: pairs, then serves the same scene routes the Worker's object serves.
  const testChe = {
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/api/pair') return new Response(JSON.stringify({ device_token: 'device-test' }), { status: 200 });
      const body = req.method === 'GET' ? undefined : await req.json();
      const out = await sceneRoute({ storage: st, now: () => NOW }, url.pathname, req.method, body);
      return new Response(JSON.stringify(out.body), { status: out.status });
    },
  };
  const env = { CHE_STATE: { getByName: () => testChe }, CHE_PAIR_CODE: '123456' };
  const req = new Request('https://worker.example/api/scenes/probe', { method: 'POST', headers: { Authorization: 'Bearer probe-token' } });
  const { sceneProbe } = await import('./scene_store.js');
  const report = await sceneProbe(env, req, 'probe-object');
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.equal(report.steps.length, 4);
  assert.deepEqual(report.steps.map((s) => s.ok), [true, true, true, true]);
});
