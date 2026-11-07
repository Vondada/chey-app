// The scene's look as data (Stage 7): lights, props, materials, actor poses and camera keys, carried in the Scene
// Director spec so a live editor can change them and a render or recording reproduces them exactly. The schema is
// documented in scene_director.js; this module validates and clamps it before a spec is stored or rendered.
// tools/che_scene_look.py reads the same fields in Blender and clamps them again (same limits, checked by
// scene_look.test.mjs against that file).

export const LIGHT_TYPES = Object.freeze(['area', 'sun', 'point', 'spot']);
export const PROP_KINDS = Object.freeze(['bookshelf', 'whiteboard', 'print', 'sideboard', 'coffee_machine', 'filing_cabinet', 'rug', 'plant', 'ceiling_panel', 'box']);
export const SET_TARGETS = Object.freeze(['floor', 'wall', 'ceiling', 'desk', 'chair', 'window', 'trim']);
export const LIMITS = Object.freeze({ lights: 8, props: 40, materials: 40, keys: 32 });
const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const GLB = /^assets\/[A-Za-z0-9_./-]{1,160}\.glb$/;

const num = (v, lo, hi, d) => { const x = Number(v); return v === null || v === '' || !Number.isFinite(x) ? d : Math.max(lo, Math.min(hi, x)); };
const vec = (v, n, lo, hi, d) => (Array.isArray(v) && v.length >= n ? Array.from({ length: n }, (_, i) => num(v[i], lo, hi, d[i])) : d.slice());
const rot3 = (v) => (Array.isArray(v) ? vec(v, 3, -360, 360, [0, 0, 0]) : [0, 0, num(v, -360, 360, 0)]);
const scale3 = (v) => (Array.isArray(v) ? vec(v, 3, 0.05, 10, [1, 1, 1]) : Array(3).fill(num(v ?? 1, 0.05, 10, 1)));
const hex = (v) => (typeof v === 'string' && HEX.test(v) ? v : null);

function material(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  if (hex(m.base_color)) out.base_color = m.base_color;
  for (const k of ['roughness', 'metallic']) if (m[k] != null) out[k] = num(m[k], 0, 1, 0.5);
  if (hex(m.emission)) { out.emission = m.emission; out.emission_strength = num(m.emission_strength ?? 1, 0, 50, 1); }
  return Object.keys(out).length ? out : null;
}

function light(l, i) {
  if (!l || typeof l !== 'object') return null;
  const type = LIGHT_TYPES.includes(l.type) ? l.type : 'area';
  const out = {
    id: typeof l.id === 'string' && ID.test(l.id) ? l.id : `light-${i + 1}`, type,
    position: vec(l.position, 3, -20, 20, [0, -2, 2.8]), color: hex(l.color) || '#ffffff',
    power: num(l.power, 0, type === 'sun' ? 20 : 5000, type === 'sun' ? 5 : 200),
    size: type === 'spot' ? num(l.size, 1, 180, 45) : num(l.size, 0.01, 10, 1),
  };
  if (l.rotation != null) out.rotation = rot3(l.rotation);
  else out.look_at = vec(l.look_at, 3, -20, 20, [0, 0.4, 1]);
  return out;
}

function prop(p, i, seen) {
  if (!p || typeof p !== 'object') return null;
  const asset = p.asset;
  if (!(PROP_KINDS.includes(asset) || (typeof asset === 'string' && GLB.test(asset) && !asset.includes('..')))) return null;
  const id = typeof p.id === 'string' && ID.test(p.id) && !seen.has(p.id) ? p.id : `prop-${i + 1}`;
  seen.add(id);
  const out = { id, asset, position: vec(p.position, 3, -20, 20, [0, 0, 0]), rotation: rot3(p.rotation ?? 0), scale: scale3(p.scale) };
  const m = material(p.material);
  if (m) out.material = m;
  return out;
}

/**
 * The spec with its look fields validated and clamped (a copy; the input is not changed). Fields a spec does not
 * carry stay absent, so an old spec renders exactly as before plus the Stage 7 defaults.
 */
export function normalizeLook(spec) {
  const out = { ...spec };
  if (Array.isArray(spec.lights)) out.lights = spec.lights.slice(0, LIMITS.lights).map(light).filter(Boolean);
  else delete out.lights;
  if (Array.isArray(spec.props)) { const seen = new Set(); out.props = spec.props.slice(0, LIMITS.props).map((p, i) => prop(p, i, seen)).filter(Boolean); }
  else delete out.props;
  if (spec.materials && typeof spec.materials === 'object' && !Array.isArray(spec.materials)) {
    out.materials = Object.fromEntries(Object.entries(spec.materials).slice(0, LIMITS.materials)
      .filter(([k]) => ID.test(k)).map(([k, m]) => [k, material(m)]).filter(([, m]) => m));
  } else delete out.materials;
  if (Array.isArray(spec.actors)) {
    out.actors = spec.actors.map((a) => {
      const b = { ...a };
      if (a.position != null) b.position = vec(a.position, 2, -20, 20, (a.start || [0, 0]).slice(0, 2));
      if (a.rotation != null) b.rotation = num(a.rotation, -360, 360, (a.start || [0, 0, 0])[2] || 0);
      return b;
    });
  }
  if (spec.camera && Array.isArray(spec.camera.keys)) {
    out.camera = { ...spec.camera, keys: spec.camera.keys.slice(0, LIMITS.keys).filter((k) => k && typeof k === 'object').map((k) => ({
      t: num(k.t, 0, 600, 0), position: vec(k.position, 3, -20, 20, [0, -4, 1.6]), look_at: vec(k.look_at, 3, -20, 20, [0, 0.4, 1]), lens: num(k.lens, 12, 135, 28),
    })).sort((a, b) => a.t - b.t) };
  }
  return out;
}
