// CHE scene store (M2b of the Create Studio, owner 2026-10-28). Saves, loads and lists editable scenes on the Worker's
// durable storage, using the scene document format (scene_document.js) and the person presets of avatar_identity.js.
//
// Rules held in code:
// - Every save is checked against the version the editor loaded. A save from an older copy is refused (409) and the
//   stored scene is returned, so an edit is never silently overwritten.
// - A saved scene is always re-validated; a broken one is refused, not repaired.
// - A template only starts with real references: a character template uses a built-in person preset ID, and nothing is
//   created that does not point at a record that exists.
// - Undo and redo live in the editor (scene_document.js history). The store keeps the saved present only.
// - Deleting a scene is not offered here. Removing anything needs the owner's confirmation in the app first.

import { validateScene, newScene, SceneError, toJSON, identityTransform } from './scene_document.js';
import { BUILT_IN } from './avatar_identity.js';

export const SCENES_KEY = 'scenes:docs';
export const MAX_SCENES = 200;

export const TEMPLATES = Object.freeze({
  blank: { label: 'Blank Canvas', objects: [] },
  person: { label: 'Person / Character', objects: 'character' },
  room: { label: 'Room / Building', objects: 'room' },
  landscape: { label: 'Landscape / Environment', objects: 'terrain' },
  object: { label: 'Object / Vehicle', objects: 'object' },
  game: { label: 'Game World', objects: 'terrain' },
});

const clock = (now) => (typeof now === 'function' ? now() : new Date().toISOString());

async function loadAll(storage) {
  const map = await storage.get(SCENES_KEY);
  return map && typeof map === 'object' ? map : {};
}

async function saveAll(storage, map) {
  await storage.put(SCENES_KEY, map);
}

const summary = (rec) => ({
  id: rec.scene.id,
  name: rec.scene.name,
  version: rec.version,
  objects: rec.scene.objects.length,
  updated_at: rec.updated_at,
});

/** Every scene, newest first, as summaries (no full objects). */
export async function listScenes(storage) {
  const map = await loadAll(storage);
  return Object.values(map).map(summary).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

export async function getScene(storage, id) {
  const map = await loadAll(storage);
  const rec = map[id];
  if (!rec) return { ok: false, status: 404, detail: `No scene with ID "${id}".` };
  return { ok: true, version: rec.version, scene: toJSON(rec.scene) };
}

/** Builds the starting objects for a template from real references, never placeholders. */
export function templateObjects(template) {
  if (template === 'person') {
    return BUILT_IN.slice(0, 1).map((preset) => ({
      id: `character_${preset.id}`,
      kind: 'character',
      name: preset.label || preset.id,
      asset_ref: preset.id,
      transform: identityTransform(),
      properties: { height_m: 1.7 },
    }));
  }
  return [];
}

export async function createScene(storage, { name, template = 'blank', id, now } = {}) {
  if (!TEMPLATES[template]) return { ok: false, status: 422, detail: `Template must be one of: ${Object.keys(TEMPLATES).join(', ')}.` };
  const map = await loadAll(storage);
  if (Object.keys(map).length >= MAX_SCENES) return { ok: false, status: 409, detail: `CHE keeps at most ${MAX_SCENES} scenes.` };
  const sceneId = id || `scene_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let scene;
  try {
    scene = newScene({ id: sceneId, name: name || TEMPLATES[template].label, now: clock(now) });
    scene.objects = templateObjects(template);
    scene = validateScene(scene);
  } catch (e) {
    if (e instanceof SceneError) return { ok: false, status: 422, detail: e.message, field: e.field };
    throw e;
  }
  const rec = { version: 1, scene, updated_at: clock(now) };
  map[sceneId] = rec;
  await saveAll(storage, map);
  return { ok: true, status: 201, version: 1, scene: toJSON(scene) };
}

/**
 * Saves the editor's present scene. `expected_version` must equal the stored version; otherwise the save is refused and
 * the current stored scene comes back, so the editor can show the conflict instead of overwriting.
 */
export async function saveScene(storage, id, { scene, expected_version, now } = {}) {
  const map = await loadAll(storage);
  const rec = map[id];
  if (!rec) return { ok: false, status: 404, detail: `No scene with ID "${id}".` };
  if (!Number.isInteger(expected_version)) return { ok: false, status: 422, detail: 'A save needs the version it was loaded at.', field: 'expected_version' };
  if (expected_version !== rec.version) {
    return { ok: false, status: 409, detail: 'This scene was changed elsewhere. Reload it before saving.', version: rec.version, scene: toJSON(rec.scene) };
  }
  let clean;
  try {
    clean = validateScene(scene);
  } catch (e) {
    if (e instanceof SceneError) return { ok: false, status: 422, detail: e.message, field: e.field };
    throw e;
  }
  if (clean.id !== id) return { ok: false, status: 422, detail: 'The scene ID cannot change.', field: 'id' };
  const next = { version: rec.version + 1, scene: clean, updated_at: clock(now) };
  map[id] = next;
  await saveAll(storage, map);
  return { ok: true, status: 200, version: next.version, scene: toJSON(clean) };
}

/** The routes worker.js mounts: /api/scenes (GET list, POST create) and /api/scenes/{id} (GET load, PUT save). */
export async function sceneRoute({ storage, now }, path, method, body = {}) {
  const json = (out, status = out.status || 200) => ({ status, body: out });
  if (path === '/api/scenes') {
    if (method === 'GET') return { status: 200, body: { ok: true, scenes: await listScenes(storage) } };
    if (method === 'POST') return json(await createScene(storage, { ...(body || {}), now }));
    return { status: 405, body: { detail: 'Use GET or POST.' } };
  }
  const m = /^\/api\/scenes\/(scene_[a-f0-9]{12})$/.exec(path);
  if (!m) return null;
  if (method === 'GET') return json(await getScene(storage, m[1]));
  if (method === 'PUT') return json(await saveScene(storage, m[1], { ...(body || {}), now }));
  return { status: 405, body: { detail: 'Use GET or PUT.' } };
}

/**
 * The live backend check (deploy probe). It pairs with the isolated test CHE, then calls the real owner routes with the
 * paired device token, the same way the phone does: create a character from a template, save an edit, refuse a stale
 * save, and reopen to read back the saved value. Only the probe's own test object is written, never the owner's scenes.
 */
export async function sceneProbe(env, request, objectName) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
  const probe = env.CHE_STATE.getByName(objectName);
  const call = (path, body, device = '', method = 'POST') => probe.fetch(new Request(`https://che.internal${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CHE-Memory-Probe': token, ...(device ? { Authorization: `Bearer ${device}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  }));
  const paired = await (await call('/api/pair', { code: String(env.CHE_PAIR_CODE || ''), device_name: 'CHE scene check' })).json().catch(() => ({}));
  const device = paired.device_token;
  if (!device) return { ok: false, error: 'The check could not pair with its test CHE.', steps: [] };
  const steps = [];
  const step = (name, ok, detail = '') => steps.push({ name, ok: Boolean(ok), detail });
  const read = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

  const made = await read(await call('/api/scenes', { name: `Probe ${crypto.randomUUID().slice(0, 8)}`, template: 'person' }, device));
  const sceneId = made.body.scene?.id;
  const height = (scene) => scene?.objects?.[0]?.properties?.height_m;
  step('create a character from the person template', made.status === 201 && made.body.version === 1 && height(made.body.scene) === 1.7, `status ${made.status}`);

  const edited = structuredClone(made.body.scene || {});
  if (edited.objects?.[0]) edited.objects[0].properties.height_m = 1.9;
  const saved = await read(await call(`/api/scenes/${sceneId}`, { scene: edited, expected_version: 1 }, device, 'PUT'));
  step('save an edit at the loaded version', saved.status === 200 && saved.body.version === 2, `status ${saved.status}`);

  const stale = await read(await call(`/api/scenes/${sceneId}`, { scene: edited, expected_version: 1 }, device, 'PUT'));
  step('refuse a save from an older copy', stale.status === 409 && stale.body.version === 2, `status ${stale.status}`);

  const reopened = await read(await call(`/api/scenes/${sceneId}`, undefined, device, 'GET'));
  step('reopen and read back the saved height', reopened.status === 200 && reopened.body.version === 2 && height(reopened.body.scene) === 1.9, `status ${reopened.status}`);

  return { ok: steps.every((s) => s.ok), steps };
}
