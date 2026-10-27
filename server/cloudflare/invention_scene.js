// Editable scene for an invention's named parts (owner, 2026-10-25: "select a component and change a dimension", "open the
// casing", "separate the turbine stages", "put everything back together"). This is the structured source that the GLB is
// built from, so an edit changes the geometry that is exported, not a picture of it.
//
// A scene is plain JSON: a template, its parts with stable ids and their rest placement, and the current explode and
// casing amounts. Every operation is a pure function that returns a new scene plus a receipt naming the parts it really
// changed. Parts it did not name must come back byte-identical; a test checks that. Nothing here draws or talks to a model.
import { partsFor } from './invention_visuals.js';

export const EXPLODE_MAX = 0.6;       // metres of separation per stage
export const CASING_MAX = 0.4;        // metres the casing halves open
export const SIZE_MIN = 0.01;         // metres
export const SIZE_MAX = 3.0;          // metres
export const FACTOR_MIN = 0.25;
export const FACTOR_MAX = 4.0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v) => Math.round(v * 1e6) / 1e6;

/** A new scene for a template, every part at its rest place, nothing exploded or hidden. */
export function sceneFor(template) {
  const parts = partsFor(template).map((p, i) => ({
    id: `p${String(i + 1).padStart(2, '0')}`,
    name: p.name,
    subsystem: p.subsystem,
    mat: p.mat,
    stage: Number.isInteger(p.stage) ? p.stage : 0,
    group: p.group || p.name,
    taper: p.taper ?? 1,
    rest: [...p.c],
    size: [...p.s],
    hidden: false,
  }));
  return { template, version: 1, explode: 0, casing: 0, parts };
}

/** The part a spoken or typed phrase names: exact name, else the one part whose name holds every word; ambiguous lists the rest. */
export function resolvePart(scene, phrase) {
  const want = String(phrase || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!want) return { part: null, ambiguous: [], reason: 'no part named' };
  const exact = scene.parts.find((p) => p.name === want);
  if (exact) return { part: exact, ambiguous: [], reason: null };
  const words = want.split(' ');
  const hits = scene.parts.filter((p) => words.every((w) => p.name.includes(w)));
  if (hits.length === 1) return { part: hits[0], ambiguous: [], reason: null };
  if (hits.length > 1) return { part: null, ambiguous: hits.map((p) => p.name), reason: 'more than one part matches' };
  return { part: null, ambiguous: [], reason: 'no part by that name' };
}

/** Each part where the scene puts it now: rest place, plus the explode and casing offsets. */
export function placedParts(scene) {
  return scene.parts.map((p) => {
    let c = [...p.rest];
    if (scene.explode) c = [c[0], c[1], round(c[2] - p.stage * scene.explode)];
    if (scene.casing && p.group === 'casing-upper') c = [c[0], round(c[1] + scene.casing), c[2]];
    if (scene.casing && p.group === 'casing-lower') c = [c[0], round(c[1] - scene.casing), c[2]];
    return { id: p.id, name: p.name, subsystem: p.subsystem, mat: p.mat, stage: p.stage, group: p.group, taper: p.taper, hidden: p.hidden, c, s: [...p.size] };
  });
}

/** The visible parts in the shape invention_visuals.buildGlb reads (name, subsystem, mat, c, s, taper). */
export function visibleBoxParts(scene) {
  return placedParts(scene).filter((p) => !p.hidden).map(({ name, subsystem, mat, c, s, taper }) => ({ name, subsystem, mat, c, s, taper }));
}

// Which parts' placement, size or visibility an operation changed, against the scene before it.
function receiptFor(op, target, before, after) {
  const was = placedParts(before); const now = placedParts(after);
  const changed = now.filter((p, i) => JSON.stringify([p.c, p.s, p.hidden]) !== JSON.stringify([was[i].c, was[i].s, was[i].hidden])).map((p) => p.name);
  return { op, target, changed, unchanged: now.length - changed.length, verified: true };
}

function bump(scene, patch) {
  return { ...scene, version: scene.version + 1, ...patch };
}

/** Separate the stages along the engine axis (amount in metres per stage). 0 puts everything back. */
export function explode(scene, amount) {
  const next = bump(scene, { explode: round(clamp(Number(amount) || 0, 0, EXPLODE_MAX)) });
  return { scene: next, receipt: receiptFor('explode', 'all stages', scene, next) };
}

/** Put everything back together: stages and casing home. Hidden parts stay hidden (use showPart for that). */
export function reassemble(scene) {
  const next = bump(scene, { explode: 0, casing: 0 });
  return { scene: next, receipt: receiptFor('reassemble', 'all parts', scene, next) };
}

/** Open (or close, with 0) the casing halves; the upper half lifts and the lower half drops by the same amount. */
export function openCasing(scene, amount = CASING_MAX) {
  const next = bump(scene, { casing: round(clamp(Number(amount) || 0, 0, CASING_MAX)) });
  return { scene: next, receipt: receiptFor('open casing', 'casing', scene, next) };
}

function editPart(scene, phrase, op, change) {
  const found = resolvePart(scene, phrase);
  if (!found.part) return { scene, receipt: { op, target: phrase, changed: [], unchanged: scene.parts.length, verified: false, error: found.reason, ambiguous: found.ambiguous } };
  const parts = scene.parts.map((p) => (p.id === found.part.id ? change(p) : p));
  const next = bump(scene, { parts });
  return { scene: next, receipt: receiptFor(op, found.part.name, scene, next) };
}

/** Hide one part (it leaves the GLB) or show it again. */
export function setPartHidden(scene, phrase, hidden) {
  return editPart(scene, phrase, hidden ? 'hide part' : 'show part', (p) => ({ ...p, hidden: Boolean(hidden) }));
}

/** Set one part's size in metres on the axes given ({x, y, z}); other axes stay as they were. Out-of-range sizes are refused. */
export function setPartSize(scene, phrase, dims) {
  const axes = { x: 0, y: 1, z: 2 };
  const given = Object.entries(dims || {}).filter(([k]) => k in axes);
  if (!given.length) return { scene, receipt: { op: 'set size', target: phrase, changed: [], unchanged: scene.parts.length, verified: false, error: 'no axis given' } };
  const bad = given.find(([, v]) => !(Number(v) >= SIZE_MIN && Number(v) <= SIZE_MAX));
  if (bad) return { scene, receipt: { op: 'set size', target: phrase, changed: [], unchanged: scene.parts.length, verified: false, error: `${bad[0]} must be ${SIZE_MIN}-${SIZE_MAX} metres` } };
  return editPart(scene, phrase, 'set size', (p) => {
    const size = [...p.size];
    for (const [k, v] of given) size[axes[k]] = round(Number(v));
    return { ...p, size };
  });
}

/** Scale one part by a factor (make the fan bigger = 1.5). Clamped to a sane range, refused outside it. */
export function scalePart(scene, phrase, factor) {
  const f = Number(factor);
  if (!(f >= FACTOR_MIN && f <= FACTOR_MAX)) return { scene, receipt: { op: 'scale', target: phrase, changed: [], unchanged: scene.parts.length, verified: false, error: `factor must be ${FACTOR_MIN}-${FACTOR_MAX}` } };
  return editPart(scene, phrase, 'scale', (p) => ({ ...p, size: p.size.map((v) => round(clamp(v * f, SIZE_MIN, SIZE_MAX))) }));
}

/** The scene as saved: JSON, read back and checked. Null when the saved text is not a scene of this shape. */
export function saveScene(scene) { return JSON.stringify(scene); }
export function loadScene(text) {
  let s;
  try { s = JSON.parse(text); } catch { return null; }
  if (!s || typeof s.template !== 'string' || !Array.isArray(s.parts) || !Number.isInteger(s.version)) return null;
  return s.parts.every((p) => typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.rest) && Array.isArray(p.size)) ? s : null;
}
