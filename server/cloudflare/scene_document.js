// CHE scene document (M2a of the universal creation engine, owner 2026-10-28). One editable scene that holds
// references to the assets CHE already makes: a character (creation_studio.js), an object or room (creation_objects.js),
// or a terrain, light or camera. A scene never copies an asset's geometry or parameters. It holds the asset ID, a
// transform and a short list of editable properties, so one character edited anywhere is the same character everywhere.
//
// Pure: no storage, no model call, no network. The same input always gives the same output. Every change returns a new
// document and keeps the one before it, so undo and redo work the same way for every mode (Create, Sculpt, Paint,
// Animate, Build World, Game, Render, Advanced) that edits this document.
//
// Rules held in code (a change the rules refuse is refused, not only reported):
// - Only the kinds in KINDS exist; an unknown kind is refused.
// - Asset references must match ASSET_ID (letters, digits, dash, underscore, dot, colon; 1 to 120 characters).
// - Transform values must be finite numbers inside TRANSFORM_LIMITS.
// - A property must be declared for its kind in PROPERTIES; undeclared names and out-of-range values are refused.
// - Object IDs are unique inside a scene; a scene holds at most MAX_OBJECTS objects.

export const SCENE_SCHEMA = 1;
export const MAX_OBJECTS = 500;
export const MAX_HISTORY = 100;
export const ASSET_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export const KINDS = Object.freeze(['character', 'object', 'room', 'terrain', 'light', 'camera']);

export const TRANSFORM_LIMITS = Object.freeze({
  position: 10000,   // metres, either direction from the origin
  rotation: 360,     // degrees
  scale: [0.01, 100],
});

// Each editable property: its kind, and its allowed range (for numbers) or option list (for choices).
export const PROPERTIES = Object.freeze({
  character: Object.freeze({
    height_m: { type: 'number', min: 0.5, max: 3 },
    skin_tone: { type: 'number', min: 0, max: 1 },
    pore_detail: { type: 'number', min: 0, max: 1 },
    hair_length: { type: 'number', min: 0, max: 1 },
  }),
  object: Object.freeze({
    color: { type: 'color' },
    roughness: { type: 'number', min: 0, max: 1 },
    metallic: { type: 'number', min: 0, max: 1 },
  }),
  room: Object.freeze({
    wall_color: { type: 'color' },
    light: { type: 'choice', options: ['warm', 'neutral', 'cool'] },
  }),
  terrain: Object.freeze({
    roughness: { type: 'number', min: 0, max: 1 },
    gravel_density: { type: 'number', min: 0, max: 1 },
  }),
  light: Object.freeze({
    intensity: { type: 'number', min: 0, max: 100 },
  }),
  camera: Object.freeze({
    focal_length_mm: { type: 'number', min: 10, max: 200 },
  }),
});

const COLOR = /^#[0-9a-fA-F]{6}$/;

export class SceneError extends Error {
  constructor(message, field = '') {
    super(message);
    this.name = 'SceneError';
    this.field = field;
  }
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, min, max) => finite(v) && v >= min && v <= max;

export function validateTransform(t, field = 'transform') {
  if (!t || typeof t !== 'object') throw new SceneError('A transform is required.', field);
  for (const axis of ['x', 'y', 'z']) {
    if (!inRange(t.position?.[axis], -TRANSFORM_LIMITS.position, TRANSFORM_LIMITS.position)) {
      throw new SceneError(`Position ${axis} must be a number within ±${TRANSFORM_LIMITS.position} m.`, `${field}.position.${axis}`);
    }
    if (!inRange(t.rotation?.[axis], -TRANSFORM_LIMITS.rotation, TRANSFORM_LIMITS.rotation)) {
      throw new SceneError(`Rotation ${axis} must be a number within ±${TRANSFORM_LIMITS.rotation} degrees.`, `${field}.rotation.${axis}`);
    }
    if (!inRange(t.scale?.[axis], TRANSFORM_LIMITS.scale[0], TRANSFORM_LIMITS.scale[1])) {
      throw new SceneError(`Scale ${axis} must be a number from ${TRANSFORM_LIMITS.scale[0]} to ${TRANSFORM_LIMITS.scale[1]}.`, `${field}.scale.${axis}`);
    }
  }
  return {
    position: { x: t.position.x, y: t.position.y, z: t.position.z },
    rotation: { x: t.rotation.x, y: t.rotation.y, z: t.rotation.z },
    scale: { x: t.scale.x, y: t.scale.y, z: t.scale.z },
  };
}

export function identityTransform() {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
}

/** Checks one property value against its declaration. Returns the cleaned value or throws. */
export function validateProperty(kind, name, value) {
  const spec = PROPERTIES[kind]?.[name];
  if (!spec) throw new SceneError(`"${name}" is not an editable property of this kind (${kind}).`, name);
  if (spec.type === 'number') {
    if (!inRange(value, spec.min, spec.max)) throw new SceneError(`${name} must be a number from ${spec.min} to ${spec.max}.`, name);
    return value;
  }
  if (spec.type === 'color') {
    if (typeof value !== 'string' || !COLOR.test(value)) throw new SceneError(`${name} must be a colour like #aabbcc.`, name);
    return value.toLowerCase();
  }
  if (spec.type === 'choice') {
    if (!spec.options.includes(value)) throw new SceneError(`${name} must be one of: ${spec.options.join(', ')}.`, name);
    return value;
  }
  throw new SceneError(`${name} has an unknown type.`, name);
}

export function validateObject(obj, index = 0) {
  const field = `objects[${index}]`;
  if (!obj || typeof obj !== 'object') throw new SceneError('An object must be a record.', field);
  if (typeof obj.id !== 'string' || !ASSET_ID.test(obj.id)) throw new SceneError('An object needs an ID (letters, digits, dash, underscore, dot, colon).', `${field}.id`);
  if (!KINDS.includes(obj.kind)) throw new SceneError(`Kind must be one of: ${KINDS.join(', ')}.`, `${field}.kind`);
  if (typeof obj.name !== 'string' || obj.name.length < 1 || obj.name.length > 80) throw new SceneError('A name must be 1 to 80 characters.', `${field}.name`);
  if (typeof obj.asset_ref !== 'string' || !ASSET_ID.test(obj.asset_ref)) throw new SceneError('An object needs an asset reference (the ID of the record it uses).', `${field}.asset_ref`);
  const properties = {};
  for (const [name, value] of Object.entries(obj.properties || {})) {
    properties[name] = validateProperty(obj.kind, name, value);
  }
  return {
    id: obj.id,
    kind: obj.kind,
    name: obj.name,
    asset_ref: obj.asset_ref,
    transform: validateTransform(obj.transform || identityTransform(), `${field}.transform`),
    properties,
    hidden: obj.hidden === true,
  };
}

/** Builds a new, empty scene. */
export function newScene({ id, name, now = '' } = {}) {
  if (typeof id !== 'string' || !ASSET_ID.test(id)) throw new SceneError('A scene needs an ID.', 'id');
  if (typeof name !== 'string' || name.length < 1 || name.length > 80) throw new SceneError('A scene name must be 1 to 80 characters.', 'name');
  return { schema: SCENE_SCHEMA, id, name, created_at: now, objects: [] };
}

/** Checks a whole scene (for loading a saved one). Throws on the first problem; never repairs silently. */
export function validateScene(scene) {
  if (!scene || typeof scene !== 'object') throw new SceneError('A scene must be a record.');
  if (scene.schema !== SCENE_SCHEMA) throw new SceneError(`Unsupported scene schema ${scene.schema}; this build reads ${SCENE_SCHEMA}.`, 'schema');
  const base = newScene({ id: scene.id, name: scene.name, now: String(scene.created_at || '') });
  if (!Array.isArray(scene.objects)) throw new SceneError('objects must be a list.', 'objects');
  if (scene.objects.length > MAX_OBJECTS) throw new SceneError(`A scene holds at most ${MAX_OBJECTS} objects.`, 'objects');
  const ids = new Set();
  base.objects = scene.objects.map((obj, i) => {
    const clean = validateObject(obj, i);
    if (ids.has(clean.id)) throw new SceneError(`Object ID "${clean.id}" is used twice.`, `objects[${i}].id`);
    ids.add(clean.id);
    return clean;
  });
  return base;
}

/** Keeps every change with the one before it, so undo and redo work for any editing mode. */
export function newHistory(scene) {
  return { past: [], present: validateScene(scene), future: [] };
}

function commit(history, next) {
  const past = [...history.past, history.present].slice(-MAX_HISTORY);
  return { past, present: next, future: [] };
}

export function addObject(history, obj) {
  const scene = history.present;
  if (scene.objects.length >= MAX_OBJECTS) throw new SceneError(`A scene holds at most ${MAX_OBJECTS} objects.`, 'objects');
  const clean = validateObject(obj, scene.objects.length);
  if (scene.objects.some((o) => o.id === clean.id)) throw new SceneError(`Object ID "${clean.id}" already exists.`, 'id');
  return commit(history, { ...scene, objects: [...scene.objects, clean] });
}

export function setProperty(history, objectId, name, value) {
  const scene = history.present;
  const target = scene.objects.find((o) => o.id === objectId);
  if (!target) throw new SceneError(`No object with ID "${objectId}".`, 'id');
  const cleanValue = validateProperty(target.kind, name, value);
  const objects = scene.objects.map((o) => (o.id === objectId ? { ...o, properties: { ...o.properties, [name]: cleanValue } } : o));
  return commit(history, { ...scene, objects });
}

export function setTransform(history, objectId, transform) {
  const scene = history.present;
  if (!scene.objects.some((o) => o.id === objectId)) throw new SceneError(`No object with ID "${objectId}".`, 'id');
  const clean = validateTransform(transform);
  const objects = scene.objects.map((o) => (o.id === objectId ? { ...o, transform: clean } : o));
  return commit(history, { ...scene, objects });
}

export function removeObject(history, objectId) {
  const scene = history.present;
  if (!scene.objects.some((o) => o.id === objectId)) throw new SceneError(`No object with ID "${objectId}".`, 'id');
  return commit(history, { ...scene, objects: scene.objects.filter((o) => o.id !== objectId) });
}

export function undo(history) {
  if (!history.past.length) return history;
  const previous = history.past[history.past.length - 1];
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history) {
  if (!history.future.length) return history;
  const [next, ...rest] = history.future;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/** The saved form: a plain JSON object with the schema number, safe to store and read back. */
export function toJSON(scene) {
  return JSON.parse(JSON.stringify(validateScene(scene)));
}
