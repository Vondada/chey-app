// CHE character registry: one persistent identity per named character, with versioned references to its assets.
//
// A character is referenced by ID everywhere (Office, videos, Music Studio, Theater, Gallery). Each version records
// the canonical GLB model, rig, facial data, materials, voice, animation library and appearance. Publishing a change
// appends a new version and never edits an earlier one, so a saved scene or video keeps pointing at the version it was
// built with. Scenes pin { character_id, version }; "latest" is only used when a caller asks for it.
//
// Pure functions over a plain registry object. Storage is an injected { get, put } (Durable Object storage in the
// Worker). A missing model is reported as missing, never replaced with a flat image.

export const CHARACTER_REGISTRY_KEY = 'characters:registry';
export const CHARACTER_IDS = Object.freeze(['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris', 'orion', 'vale']);
const BUNDLED_IDS = new Set(['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris']);
const MODEL_FORMATS = new Set(['glb']);
const MAX_VERSIONS = 200;
const DISPLAY = { che: 'CHE', nova: 'Nova', atlas: 'Atlas', mira: 'Mira', knox: 'Knox', sage: 'Sage', lyra: 'Lyra', iris: 'Iris', orion: 'Orion', vale: 'Vale' };
const FIELDS = ['model', 'rig', 'face', 'materials', 'hair_clothing', 'voice', 'animations', 'appearance', 'note'];

/** The bundled GLB for a character, or null when none exists yet. */
export function bundledModel(id) {
  return BUNDLED_IDS.has(id) ? { format: 'glb', path: `assets/characters/crew/${id}.glb` } : null;
}

function versionOne(id, now) {
  return {
    version: 1,
    created_ms: now,
    model: bundledModel(id),
    rig: bundledModel(id) ? 'skeleton in the bundled GLB' : null,
    face: null,
    materials: null,
    hair_clothing: null,
    voice: null,
    animations: bundledModel(id) ? ['idle', 'walk', 'wave', 'talk'] : [],
    appearance: null,
    note: bundledModel(id) ? 'Bundled crew model.' : 'No model yet. Create it with the creation engine; nothing is substituted with a flat image.',
  };
}

/** A registry with every named character present, each at version 1. Idempotent for a given registry. */
export function defaultRegistry(now = Date.now()) {
  const characters = {};
  for (const id of CHARACTER_IDS) {
    characters[id] = { id, name: DISPLAY[id], versions: [versionOne(id, now)] };
  }
  return { schema: 1, characters };
}

/** Load the registry from storage, filling in any named character that is missing. Never drops stored versions. */
export async function loadRegistry(storage, now = Date.now()) {
  const stored = (await storage.get(CHARACTER_REGISTRY_KEY)) || null;
  const base = defaultRegistry(now);
  if (!stored?.characters) return base;
  const characters = { ...base.characters };
  for (const [id, record] of Object.entries(stored.characters)) {
    if (CHARACTER_IDS.includes(id) && Array.isArray(record.versions) && record.versions.length) characters[id] = record;
  }
  return { schema: 1, characters };
}

export async function saveRegistry(storage, registry) {
  await storage.put(CHARACTER_REGISTRY_KEY, registry);
  return registry;
}

export function latestVersion(registry, id) {
  const record = registry?.characters?.[id];
  if (!record) return null;
  return record.versions[record.versions.length - 1];
}

/** One saved version by number, or null. Scenes and videos use this, so they keep their own version. */
export function versionOf(registry, id, version) {
  const record = registry?.characters?.[id];
  return record?.versions.find((v) => v.version === version) || null;
}

/**
 * Publish a change as a new version. Returns a new registry: earlier versions are untouched and the input is not
 * mutated. Only the fields listed in FIELDS may change, and a model must be a supported format.
 */
export function publishVersion(registry, id, change = {}, now = Date.now()) {
  const record = registry?.characters?.[id];
  if (!record) throw new Error(`Unknown character "${id}". Named characters: ${CHARACTER_IDS.join(', ')}.`);
  const previous = latestVersion(registry, id);
  const unknown = Object.keys(change).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new Error(`Unknown field(s) for a character version: ${unknown.join(', ')}.`);
  if (change.model && !MODEL_FORMATS.has(change.model.format)) throw new Error(`Unsupported model format "${change.model.format}". Use GLB (glTF binary).`);
  if (record.versions.length >= MAX_VERSIONS) throw new Error(`Character "${id}" has ${MAX_VERSIONS} versions; keep the saved ones and start a new character to continue.`);
  const next = { ...previous, ...change, version: previous.version + 1, created_ms: now };
  return {
    schema: registry.schema,
    characters: { ...registry.characters, [id]: { ...record, versions: [...record.versions, next] } },
  };
}

/** The asset references one version needs, for a scene or video that pins it. Missing pieces are null, never invented. */
export function assetRefs(registry, id, version) {
  const v = version == null ? latestVersion(registry, id) : versionOf(registry, id, version);
  if (!v) return null;
  return { character_id: id, version: v.version, model: v.model, rig: v.rig, face: v.face, materials: v.materials, hair_clothing: v.hair_clothing, voice: v.voice, animations: v.animations, appearance: v.appearance };
}

/** Which named characters have a usable model, and which are still missing one. */
export function modelStatus(registry) {
  const ready = [];
  const missing = [];
  for (const id of CHARACTER_IDS) {
    (latestVersion(registry, id)?.model ? ready : missing).push(id);
  }
  return { ready, missing };
}
