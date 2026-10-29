// Tests for scene_document.js (M2a). Each test changes real data and checks the result, not a label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newScene, newHistory, addObject, setProperty, setTransform, removeObject, undo, redo,
  validateScene, validateProperty, validateTransform, identityTransform, toJSON, SceneError, MAX_OBJECTS, MAX_HISTORY,
} from './scene_document.js';

const chair = (id = 'chair_1') => ({
  id, kind: 'object', name: 'Oak chair', asset_ref: 'object_chair_oak',
  transform: identityTransform(), properties: { color: '#8b5a2b', roughness: 0.6 },
});

const fresh = () => newHistory(newScene({ id: 'scene_office', name: 'Office', now: '2026-10-28T00:00:00Z' }));

test('a new scene is empty and holds the schema number', () => {
  const s = newScene({ id: 'scene_a', name: 'A' });
  assert.equal(s.schema, 1);
  assert.deepEqual(s.objects, []);
});

test('adding an object stores it with its asset reference and transform', () => {
  const h = addObject(fresh(), chair());
  assert.equal(h.present.objects.length, 1);
  assert.equal(h.present.objects[0].asset_ref, 'object_chair_oak');
  assert.deepEqual(h.present.objects[0].transform.position, { x: 0, y: 0, z: 0 });
});

test('a character is an object that points at its creation record, not a copy of it', () => {
  const h = addObject(fresh(), {
    id: 'char_ada', kind: 'character', name: 'Ada', asset_ref: 'person_9f2c',
    transform: identityTransform(), properties: { height_m: 1.7, pore_detail: 0.4 },
  });
  const ada = h.present.objects[0];
  assert.equal(ada.asset_ref, 'person_9f2c');
  assert.equal(ada.properties.pore_detail, 0.4);
  assert.equal(Object.keys(ada).includes('geometry'), false);
});

test('a duplicate object ID is refused, and the scene does not change', () => {
  const h = addObject(fresh(), chair());
  assert.throws(() => addObject(h, chair()), (e) => e instanceof SceneError && /already exists/.test(e.message));
  assert.equal(h.present.objects.length, 1);
});

test('an unknown kind, a bad asset reference and a bad ID are refused', () => {
  assert.throws(() => addObject(fresh(), { ...chair(), kind: 'dragon_pet' }), /Kind must be one of/);
  assert.throws(() => addObject(fresh(), { ...chair(), asset_ref: 'x/../../etc' }), /asset reference/);
  assert.throws(() => addObject(fresh(), { ...chair(), id: 'has space' }), /needs an ID/);
});

test('a property is changed only when it is declared for that kind and in range', () => {
  const h = addObject(fresh(), chair());
  const h2 = setProperty(h, 'chair_1', 'roughness', 0.9);
  assert.equal(h2.present.objects[0].properties.roughness, 0.9);
  assert.throws(() => setProperty(h, 'chair_1', 'roughness', 1.5), /from 0 to 1/);
  assert.throws(() => setProperty(h, 'chair_1', 'pore_detail', 0.5), /not an editable property of this kind/);
  assert.throws(() => setProperty(h, 'chair_1', 'color', 'red'), /colour like/);
});

test('a colour is stored in lower case and a choice must be listed', () => {
  assert.equal(validateProperty('object', 'color', '#AABBCC'), '#aabbcc');
  assert.equal(validateProperty('room', 'light', 'cool'), 'cool');
  assert.throws(() => validateProperty('room', 'light', 'purple'), /one of: warm, neutral, cool/);
});

test('transform values outside their limits are refused', () => {
  assert.throws(() => validateTransform({ ...identityTransform(), scale: { x: 0, y: 1, z: 1 } }), /Scale x/);
  assert.throws(() => validateTransform({ ...identityTransform(), rotation: { x: 400, y: 0, z: 0 } }), /Rotation x/);
  assert.throws(() => validateTransform({ ...identityTransform(), position: { x: NaN, y: 0, z: 0 } }), /Position x/);
});

test('moving an object changes only its transform', () => {
  const h = addObject(fresh(), chair());
  const moved = { ...identityTransform(), position: { x: 2, y: 0, z: -1 } };
  const h2 = setTransform(h, 'chair_1', moved);
  assert.deepEqual(h2.present.objects[0].transform.position, { x: 2, y: 0, z: -1 });
  assert.equal(h2.present.objects[0].properties.roughness, 0.6);
});

test('undo and redo walk the history in both directions, and a new change clears redo', () => {
  let h = addObject(fresh(), chair());
  h = setProperty(h, 'chair_1', 'roughness', 0.9);
  h = setProperty(h, 'chair_1', 'roughness', 0.2);
  h = undo(h);
  assert.equal(h.present.objects[0].properties.roughness, 0.9);
  h = undo(h);
  assert.equal(h.present.objects[0].properties.roughness, 0.6);
  h = redo(h);
  assert.equal(h.present.objects[0].properties.roughness, 0.9);
  h = setProperty(h, 'chair_1', 'roughness', 0.5);
  assert.deepEqual(h.future, []);
});

test('undo on an empty history changes nothing', () => {
  const h = fresh();
  assert.equal(undo(h), h);
});

test('history keeps at most MAX_HISTORY steps', () => {
  let h = addObject(fresh(), chair());
  for (let i = 0; i < MAX_HISTORY + 20; i += 1) h = setProperty(h, 'chair_1', 'roughness', (i % 100) / 100);
  assert.equal(h.past.length, MAX_HISTORY);
});

test('removing an object drops it from the scene', () => {
  const h = removeObject(addObject(fresh(), chair()), 'chair_1');
  assert.deepEqual(h.present.objects, []);
});

test('a saved scene is read back the same way, and a broken one is refused on load', () => {
  let h = addObject(fresh(), chair());
  h = setProperty(h, 'chair_1', 'color', '#112233');
  const saved = JSON.parse(JSON.stringify(toJSON(h.present)));
  const loaded = validateScene(saved);
  assert.deepEqual(loaded, h.present);
  assert.throws(() => validateScene({ ...saved, schema: 2 }), /Unsupported scene schema/);
  assert.throws(() => validateScene({ ...saved, objects: [chair(), chair()] }), /used twice/);
});

test('a scene over the object limit is refused', () => {
  const many = Array.from({ length: MAX_OBJECTS + 1 }, (_, i) => ({ ...chair(`c_${i}`) }));
  assert.throws(() => validateScene({ ...newScene({ id: 's', name: 'S' }), objects: many }), /at most/);
});
