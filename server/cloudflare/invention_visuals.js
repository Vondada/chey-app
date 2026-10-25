// Invention visuals (owner, 2026-10-24: "inv-8a637dad gave me text only"). An invention project gets a real concept
// picture in chat, a real 3D model the owner can turn, zoom and recolour, and every picture and model is saved to the
// project as a version.
//
// One geometry, two outputs: each template is a list of named parts (boxes in metres). The GLB is those parts; the
// procedural concept sheet is a shaded orthographic render of the very same parts, so the picture always shows what
// "View in 3D" opens. When the owner's own image model (media.js generateImage, Workers AI) answers, its picture is the
// first concept; otherwise the procedural sheet is, and it is labelled procedural. Nothing here claims a Blender render,
// a photo or a model that was not built. The refined model is the Creation Engine's job: the same parts list goes to
// the existing queue as an invention_model job (scripts/che_creation_job.py, tools/avatar_body/inventions.py), which
// Blender builds with bevelled, subdivided parts and PBR materials, measures and renders. The box-parts GLB made here
// is only the instant placeholder, and is labelled so.
import { Canvas, disc, encodePng, polygon, text, verticalGradient } from './internal_renderer.js';
import { generateImage, saveRenderedImage } from './media.js';
import { GpuQueue, publicJob } from './gpu_queue.js';
import { ensureCapacity } from './creation_orchestrator.js';

export const MAX_VISUAL_VERSIONS = 20;
export const PROCEDURAL = 'procedural concept sheet (CHE internal renderer), not a photo or a Blender render';
export const MODEL_KIND = 'instant box-parts placeholder model (CHE Worker geometry), not the Blender build';
export const REFINED_KIND = 'refined Blender model (Creation Engine: bevelled, subdivided parts, PBR materials)';
const glbKey = (id, v) => `invention_glb:${id}:${v}`;

export const COLOURS = Object.freeze({
  red: '#9a1f1f', crimson: '#8a1426', gold: '#c8a040', yellow: '#d8b030', blue: '#2f5fb0', navy: '#1d2b4a', black: '#1a1a1e',
  white: '#e6e6e2', silver: '#b8bcc2', grey: '#6f747a', gray: '#6f747a', green: '#2f7a46', purple: '#6c4ab0', orange: '#d8662a',
  teal: '#1f6f78', pink: '#c86a98', bronze: '#8c5a2c', chrome: '#d0d4da',
});
const DEFAULT_PRIMARY = { powered_suit: 'red', exoskeleton: 'grey', robot: 'silver', device: 'navy', jet_engine: 'silver' };
const SECONDARY = { powered_suit: '#c8a040', exoskeleton: '#2a2d33', robot: '#2a2d33', device: '#b8bcc2', jet_engine: '#b8bcc2' };
const GLOW = '#9fe8ff';
const JOINT = '#2a2d33';

const box = (name, subsystem, mat, [x, y, z], [w, h, d], taper = 1) => ({ name, subsystem, mat, c: [x, y, z], s: [w, h, d], taper });
const mirror = (parts) => parts.flatMap((p) => (p.c[0] === 0 ? [p] : [p, { ...p, name: p.name.replace('left', 'right'), c: [-p.c[0], p.c[1], p.c[2]] }]));

// A jet engine (owner, 2026-10-25: "a jet-engine-inspired assembly with at least 12 individually identifiable components").
// The engine's axis runs along z (intake at +z, nozzle at -z), centred on y = 1. Every part is a box: a visual
// approximation, not an engineering model. `stage` is the explode order (0 intake and fan ... 4 nozzle), `group` names
// what a casing or core command moves, so "open the casing" and "separate the turbine stages" act on real parts.
const staged = (stage, group, p) => ({ ...p, stage, group });
export const JET_ENGINE_PARTS = 15;
function jetEngineParts() {
  return [
    staged(0, 'casing', box('intake cowl', 'intake', 'primary', [0, 1.0, 0.62], [0.42, 0.42, 0.22])),
    staged(0, 'casing-upper', box('casing upper', 'casing', 'primary', [0, 1.22, 0], [0.38, 0.14, 1.0])),
    staged(0, 'casing-lower', box('casing lower', 'casing', 'primary', [0, 0.86, 0], [0.38, 0.14, 1.0])),
    staged(0, 'rotor', box('front fan blades', 'fan', 'secondary', [0, 1.0, 0.45], [0.36, 0.36, 0.04])),
    staged(0, 'rotor', box('fan hub', 'fan', 'joint', [0, 1.0, 0.43], [0.1, 0.1, 0.1])),
    staged(1, 'core', box('low pressure compressor', 'compressor', 'secondary', [0, 1.0, 0.2], [0.3, 0.3, 0.2])),
    staged(1, 'core', box('high pressure compressor', 'compressor', 'secondary', [0, 1.0, 0], [0.26, 0.26, 0.2])),
    staged(1, 'core', box('accessory gearbox', 'accessories', 'joint', [0, 0.72, 0.05], [0.2, 0.14, 0.22])),
    staged(2, 'core', box('combustor chamber', 'combustion', 'glow', [0, 1.0, -0.2], [0.28, 0.28, 0.2])),
    staged(2, 'core', box('fuel line', 'fuel', 'joint', [0.2, 0.9, -0.2], [0.03, 0.03, 0.4])),
    staged(3, 'core', box('high pressure turbine', 'turbine', 'secondary', [0, 1.0, -0.38], [0.26, 0.26, 0.16])),
    staged(3, 'core', box('low pressure turbine', 'turbine', 'secondary', [0, 1.0, -0.54], [0.3, 0.3, 0.16])),
    staged(0, 'shaft', box('main shaft', 'shaft', 'joint', [0, 1.0, 0], [0.06, 0.06, 1.3])),
    staged(4, 'nozzle', box('exhaust nozzle', 'exhaust', 'joint', [0, 1.0, -0.7], [0.22, 0.22, 0.12], 0.8)),
    staged(0, 'pylon', box('mounting pylon', 'frame', 'primary', [0, 1.3, -0.1], [0.08, 0.22, 0.5])),
  ];
}

/** The named parts of a template, in metres, standing on y = 0 and facing +z. */
export function partsFor(template) {
  if (template === 'jet_engine') return jetEngineParts();
  if (template === 'device') {
    return [
      box('housing', 'shell', 'primary', [0, 0.12, 0], [0.34, 0.22, 0.22]),
      box('front panel', 'control', 'secondary', [0, 0.14, 0.112], [0.26, 0.14, 0.01]),
      box('status light', 'sensors', 'glow', [0.1, 0.19, 0.118], [0.03, 0.02, 0.008]),
      box('battery bay', 'power', 'joint', [0, 0.04, -0.02], [0.3, 0.05, 0.16]),
      box('cooling vent', 'cooling', 'joint', [0, 0.235, 0], [0.22, 0.012, 0.14]),
    ];
  }
  if (template === 'exoskeleton') {
    return mirror([
      box('spine strut', 'frame', 'primary', [0, 1.25, -0.16], [0.06, 0.56, 0.05]),
      box('back power pack', 'power', 'secondary', [0, 1.3, -0.24], [0.26, 0.3, 0.1]),
      box('hip belt', 'frame', 'secondary', [0, 0.98, 0], [0.42, 0.08, 0.3]),
      box('shoulder yoke', 'frame', 'primary', [0, 1.52, -0.1], [0.44, 0.05, 0.12]),
      box('left hip actuator', 'movement', 'glow', [0.21, 0.94, 0], [0.07, 0.1, 0.1]),
      box('left thigh strut', 'frame', 'primary', [0.17, 0.72, 0.06], [0.04, 0.36, 0.04]),
      box('left knee actuator', 'movement', 'glow', [0.17, 0.5, 0.07], [0.08, 0.08, 0.08]),
      box('left shin strut', 'frame', 'primary', [0.17, 0.28, 0.06], [0.04, 0.36, 0.04]),
      box('left foot plate', 'frame', 'secondary', [0.12, 0.02, 0.06], [0.11, 0.03, 0.26]),
      box('left thigh cuff', 'safety', 'joint', [0.12, 0.74, 0.03], [0.16, 0.06, 0.16]),
      box('left shin cuff', 'safety', 'joint', [0.12, 0.3, 0.03], [0.13, 0.06, 0.13]),
      box('left arm strut', 'frame', 'primary', [0.3, 1.3, -0.04], [0.04, 0.32, 0.04]),
      box('left elbow actuator', 'movement', 'glow', [0.3, 1.12, -0.04], [0.07, 0.07, 0.07]),
    ]);
  }
  if (template === 'robot') {
    return mirror([
      box('head', 'shell', 'primary', [0, 1.6, 0], [0.3, 0.24, 0.26]),
      box('visor sensor bar', 'sensors', 'glow', [0, 1.62, 0.132], [0.22, 0.04, 0.01]),
      box('antenna', 'sensors', 'secondary', [0.08, 1.77, 0], [0.02, 0.1, 0.02]),
      box('neck', 'frame', 'joint', [0, 1.45, 0], [0.1, 0.08, 0.1]),
      box('torso', 'shell', 'primary', [0, 1.2, 0], [0.5, 0.42, 0.3], 0.85),
      box('chest panel', 'control', 'secondary', [0, 1.24, 0.152], [0.24, 0.16, 0.01]),
      box('power core', 'power', 'glow', [0, 1.24, 0.16], [0.06, 0.06, 0.01]),
      box('pelvis', 'frame', 'joint', [0, 0.9, 0], [0.36, 0.14, 0.24]),
      box('left upper arm', 'movement', 'primary', [0.33, 1.2, 0], [0.12, 0.3, 0.12]),
      box('left forearm', 'movement', 'primary', [0.33, 0.9, 0], [0.11, 0.28, 0.11]),
      box('left gripper', 'accessories', 'joint', [0.33, 0.7, 0], [0.1, 0.1, 0.08]),
      box('left upper leg', 'movement', 'primary', [0.12, 0.64, 0], [0.15, 0.34, 0.15]),
      box('left lower leg', 'movement', 'primary', [0.12, 0.27, 0], [0.14, 0.34, 0.14]),
      box('left foot', 'movement', 'secondary', [0.12, 0.05, 0.04], [0.16, 0.1, 0.26]),
    ]);
  }
  // powered_suit (Iron Man-style): plated shell over a frame, a chest power core, palm emitters and eye lights.
  return mirror([
    box('helmet', 'shell', 'primary', [0, 1.73, 0], [0.24, 0.28, 0.27], 0.9),
    box('faceplate', 'shell', 'secondary', [0, 1.71, 0.137], [0.18, 0.2, 0.012]),
    box('left eye light', 'sensors', 'glow', [0.045, 1.75, 0.145], [0.05, 0.016, 0.006]),
    box('neck seal', 'frame', 'joint', [0, 1.56, 0], [0.13, 0.06, 0.13]),
    box('chest plate', 'shell', 'primary', [0, 1.38, 0], [0.48, 0.34, 0.29], 0.82),
    box('power core', 'power', 'glow', [0, 1.4, 0.148], [0.07, 0.07, 0.012]),
    box('back power pack', 'power', 'joint', [0, 1.36, -0.19], [0.32, 0.3, 0.1]),
    box('abdomen plates', 'shell', 'secondary', [0, 1.11, 0], [0.33, 0.2, 0.23]),
    box('pelvis guard', 'frame', 'primary', [0, 0.96, 0], [0.38, 0.14, 0.26], 0.85),
    box('left shoulder plate', 'shell', 'primary', [0.31, 1.5, 0], [0.17, 0.13, 0.19]),
    box('left upper arm', 'movement', 'primary', [0.33, 1.28, 0], [0.11, 0.28, 0.12]),
    box('left elbow joint', 'movement', 'joint', [0.33, 1.13, 0], [0.09, 0.05, 0.09]),
    box('left forearm', 'movement', 'secondary', [0.33, 0.98, 0], [0.12, 0.26, 0.13], 0.85),
    box('left gauntlet', 'accessories', 'primary', [0.33, 0.8, 0], [0.1, 0.11, 0.08]),
    box('left palm emitter', 'accessories', 'glow', [0.33, 0.8, 0.042], [0.04, 0.04, 0.005]),
    box('left thigh plate', 'movement', 'primary', [0.11, 0.7, 0], [0.16, 0.38, 0.17], 0.85),
    box('left knee joint', 'movement', 'joint', [0.11, 0.5, 0.01], [0.12, 0.05, 0.13]),
    box('left shin plate', 'movement', 'secondary', [0.11, 0.29, 0], [0.13, 0.38, 0.15], 0.85),
    box('left boot', 'movement', 'primary', [0.11, 0.05, 0.04], [0.14, 0.1, 0.27]),
  ]);
}

const rgb = (hex) => { const v = parseInt(String(hex).replace('#', ''), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };

/** The material colours of a project's look: primary from the owner's colour, then the template's fixed accents. */
export function paletteFor(template, colour) {
  const name = COLOURS[colour] ? colour : DEFAULT_PRIMARY[template] || 'red';
  return { name, primary: COLOURS[name], secondary: SECONDARY[template] || '#c8a040', glow: GLOW, joint: JOINT };
}

// ─── The 3D model (glTF 2.0 binary) ────────────────────────────────────────

function boxGeometry({ c, s, taper }) {
  const [hx, hy, hz] = s.map((v) => v / 2);
  // `taper` narrows the bottom face (a chest plate wider at the shoulders than at the waist).
  const corner = (sx, sy, sz) => [c[0] + sx * hx * (sy > 0 ? 1 : taper), c[1] + sy * hy, c[2] + sz * hz * (sy > 0 ? 1 : (1 + taper) / 2)];
  const faces = [
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]], [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]], [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
  ];
  const pos = [], nrm = [], idx = [];
  for (const [n, quad] of faces) {
    const base = pos.length / 3;
    for (const q of quad) { pos.push(...corner(...q)); nrm.push(...n); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nrm, idx, faces: faces.map(([n, quad]) => ({ n, pts: quad.map((q) => corner(...q)) })) };
}

/** A GLB of the parts: one mesh node per named part, four materials (primary, secondary, glow, joint). */
export function buildGlb(parts, palette) {
  const mats = ['primary', 'secondary', 'glow', 'joint'];
  const chunks = []; let offset = 0;
  const views = []; const accessors = []; const meshes = []; const nodes = [];
  const push = (arr, Type, target) => {
    const bytes = new Uint8Array(new Type(arr).buffer);
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4); padded.set(bytes);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target }); chunks.push(padded); offset += padded.length;
    return views.length - 1;
  };
  for (const p of parts) {
    const g = boxGeometry(p);
    const min = [0, 1, 2].map((k) => Math.min(...g.pos.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...g.pos.filter((_, i) => i % 3 === k)));
    const pv = push(g.pos, Float32Array, 34962); accessors.push({ bufferView: pv, componentType: 5126, count: g.pos.length / 3, type: 'VEC3', min, max });
    const nv = push(g.nrm, Float32Array, 34962); accessors.push({ bufferView: nv, componentType: 5126, count: g.nrm.length / 3, type: 'VEC3' });
    const iv = push(g.idx, Uint16Array, 34963); accessors.push({ bufferView: iv, componentType: 5123, count: g.idx.length, type: 'SCALAR' });
    const a = accessors.length;
    meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: a - 3, NORMAL: a - 2 }, indices: a - 1, material: mats.indexOf(p.mat) }] });
    nodes.push({ name: p.name, mesh: meshes.length - 1, extras: { subsystem: p.subsystem } });
  }
  const material = (name) => {
    const [r, g, b] = rgb(palette[name]).map(lin);
    return { name, pbrMetallicRoughness: { baseColorFactor: [r, g, b, 1], metallicFactor: name === 'glow' ? 0 : 0.6, roughnessFactor: name === 'glow' ? 0.4 : 0.35 },
      ...(name === 'glow' ? { emissiveFactor: [r, g, b] } : {}) };
  };
  const gltf = { asset: { version: '2.0', generator: 'CHE invention_visuals.js' }, scene: 0, scenes: [{ name: 'invention', nodes: nodes.map((_, i) => i) }],
    nodes, meshes, accessors, bufferViews: views, materials: mats.map(material), buffers: [{ byteLength: offset }] };
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLen = Math.ceil(json.length / 4) * 4;
  const total = 12 + 8 + jsonLen + 8 + offset;
  const out = new Uint8Array(total); const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true); out.fill(0x20, 20, 20 + jsonLen); out.set(json, 20);
  let o = 20 + jsonLen; dv.setUint32(o, offset, true); dv.setUint32(o + 4, 0x004e4942, true); o += 8;
  for (const ch of chunks) { out.set(ch, o); o += ch.length; }
  return out;
}

/** What a GLB really holds, read back from its own bytes (magic, version, node names). Null when it is not a GLB. */
export function readGlb(bytes) {
  if (!bytes || bytes.length < 20) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2 || dv.getUint32(16, true) !== 0x4e4f534a) return null;
  try {
    const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
    return { meshes: gltf.meshes?.length || 0, nodes: (gltf.nodes || []).map((n) => n.name), materials: (gltf.materials || []).map((m) => m.name) };
  } catch { return null; }
}

// ─── The procedural concept sheet ─────────────────────────────────────────

function shadeFace(base, n, glow) {
  if (glow) return base.map((v) => Math.min(255, v * 1.15 + 30));
  const L = [-0.45, 0.6, 0.66]; const len = Math.hypot(...L);
  const d = Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / len);
  return base.map((v) => Math.min(255, v * (0.32 + 0.78 * d) + (d > 0.85 ? 18 : 0)));
}

/** Draws the parts in one orthographic view (yaw in degrees) into a panel of the canvas, far faces first. */
function drawView(canvas, parts, palette, { x0, y0, w, h, yaw }) {
  const a = (yaw * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a), pitch = 0.12, cp = Math.cos(pitch), sp = Math.sin(pitch);
  const rot = ([x, y, z]) => { const rx = x * cos + z * sin, rz = -x * sin + z * cos; return [rx, y * cp - rz * sp, y * sp + rz * cp]; };
  const all = parts.flatMap((p) => boxGeometry(p).faces.map((f) => ({ p, n: rot(f.n), pts: f.pts.map(rot) })));
  const ys = all.flatMap((f) => f.pts.map((q) => q[1])); const xs = all.flatMap((f) => f.pts.map((q) => q[0]));
  const top = Math.max(...ys), bot = Math.min(...ys), left = Math.min(...xs), right = Math.max(...xs);
  const k = Math.min((h * 0.86) / (top - bot), (w * 0.86) / (right - left));
  const cx = x0 + w / 2 - ((left + right) / 2) * k, cy = y0 + h * 0.07 + top * k;
  const faces = all.filter((f) => f.n[2] > 0.02).sort((f, g) => f.pts.reduce((s, q) => s + q[2], 0) - g.pts.reduce((s, q) => s + q[2], 0));
  for (const f of faces) {
    const col = shadeFace(rgb(palette[f.p.mat]), f.n, f.p.mat === 'glow');
    polygon(canvas, f.pts.map((q) => [cx + q[0] * k, cy - q[1] * k]), col, 1);
  }
  for (const f of faces.filter((x) => x.p.mat === 'glow' && x.n[2] > 0.5)) {
    const m = f.pts.reduce((s, q) => [s[0] + q[0] / 4, s[1] + q[1] / 4], [0, 0]);
    disc(canvas, cx + m[0] * k, cy - m[1] * k, 2, rgb(palette.glow), { glow: 5, alpha: 0.5 });
  }
}

/** A PNG concept sheet: a large three-quarter view with front and side views, labelled as procedural. */
export async function conceptSheet(project, colour) {
  const parts = partsFor(project.template); const palette = paletteFor(project.template, colour);
  const W = 800, H = 450; const c = new Canvas(W, H, { deadline: Date.now() + 8000 });
  verticalGradient(c, 0, H, [[0, [16, 28, 44]], [1, [6, 12, 20]]]);
  for (let x = 0; x < W; x += 25) for (let y = 0; y < H; y++) c.blend(x, y, [60, 110, 150], 0.12);
  for (let y = 0; y < H; y += 25) for (let x = 0; x < W; x++) c.blend(x, y, [60, 110, 150], 0.12);
  drawView(c, parts, palette, { x0: 20, y0: 40, w: 460, h: 380, yaw: -35 });
  drawView(c, parts, palette, { x0: 500, y0: 40, w: 140, h: 380, yaw: 0 });
  drawView(c, parts, palette, { x0: 650, y0: 40, w: 140, h: 380, yaw: -90 });
  const white = [220, 236, 246];
  text(c, `${project.id} ${String(project.template).replace('_', ' ')} concept`.slice(0, 60), 20, 14, 2, white);
  text(c, 'THREE-QUARTER', 180, 428, 1, white, 0.8); text(c, 'FRONT', 552, 428, 1, white, 0.8); text(c, 'SIDE', 708, 428, 1, white, 0.8);
  text(c, `PRIMARY ${palette.name}. PROCEDURAL CONCEPT SHEET - NOT A PHOTO`, 20, 440, 1, white, 0.6);
  const png = await encodePng(c, { meta: PROCEDURAL });
  return { png, width: W, height: H, palette: palette.name, parts: parts.length };
}

// ─── Project records ──────────────────────────────────────────────────────

const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const toB64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

export function visualsOf(project) {
  const v = project.visuals || {};
  return { colour: v.colour || paletteFor(project.template).name, images: Array.isArray(v.images) ? v.images : [], models: Array.isArray(v.models) ? v.models : [] };
}

/** A new concept picture saved to the project: the owner's image model first (when asked and it answers), else procedural. */
export async function makeConcept(env, storage, project, { colour = null, tryModel = true } = {}) {
  const vis = visualsOf(project); const look = colour || vis.colour;
  if (vis.images.length >= MAX_VISUAL_VERSIONS) return { ok: false, detail: `This project already holds ${MAX_VISUAL_VERSIONS} concept pictures, the most CHE keeps per project. Nothing was removed.` };
  const steps = [];
  let item = null; let engine = ''; let provenance = '';
  if (tryModel) {
    const t0 = Date.now();
    const made = await generateImage(env, storage, { prompt: `Concept design, front three-quarter view, clean engineering concept art, ${look} primary colour: ${project.request}`.slice(0, 1800), title: project.title.slice(0, 80) })
      .catch((e) => ({ detail: String(e?.message || e).slice(0, 160) }));
    if (made?.item) { item = made.item; engine = made.item.engine || 'CHE image engine'; provenance = 'image model'; }
    steps.push({ step: 'image model', ok: Boolean(item), ms: Date.now() - t0, detail: item ? engine : (made?.detail || 'no picture returned') });
  }
  if (!item) {
    const t0 = Date.now();
    const sheet = await conceptSheet(project, look);
    item = await saveRenderedImage(env, storage, { bytes: sheet.png, title: `${project.title} (concept sheet)`, prompt: project.request, width: sheet.width, height: sheet.height, provenance: PROCEDURAL, engine: 'che_internal_renderer', source: 'che_invention_studio' });
    engine = 'che_internal_renderer'; provenance = PROCEDURAL;
    steps.push({ step: 'procedural concept sheet', ok: true, ms: Date.now() - t0, detail: `${sheet.width}x${sheet.height} PNG, ${sheet.png.length} bytes` });
  }
  const image = { v: vis.images.length + 1, media_id: item.id, engine, provenance, colour: look, at: new Date().toISOString() };
  project.visuals = { ...vis, colour: look, images: [...vis.images, image] };
  project.concept = { status: 'generated', media_id: item.id, reason: '', engine, provenance };
  return { ok: true, image, steps };
}

/** A new 3D model version saved to the project (GLB bytes in storage), read back from its own bytes before it counts. */
export async function makeModel(storage, project, { colour = null } = {}) {
  const vis = visualsOf(project); const look = colour || vis.colour;
  if (vis.models.length >= MAX_VISUAL_VERSIONS) return { ok: false, detail: `This project already holds ${MAX_VISUAL_VERSIONS} 3D model versions, the most CHE keeps per project. Nothing was removed.` };
  const parts = partsFor(project.template); const glb = buildGlb(parts, paletteFor(project.template, look));
  const facts = readGlb(glb);
  if (!facts || facts.meshes !== parts.length) return { ok: false, detail: 'The 3D model did not read back correctly, so nothing was saved.' };
  const v = vis.models.length + 1;
  await storage.put(glbKey(project.id, v), toB64(glb));
  const model = { v, kind: MODEL_KIND, colour: look, bytes: glb.length, sha256: await sha256(glb), meshes: facts.meshes, parts: parts.map((p) => ({ name: p.name, subsystem: p.subsystem })), at: new Date().toISOString() };
  project.visuals = { ...vis, colour: look, models: [...vis.models, model] };
  return { ok: true, model };
}

/** The invention_model job spec: the template's parts and palette, exactly as the placeholder uses them. */
export function refinedSpec(project, colour = null) {
  const look = colour || visualsOf(project).colour;
  return { template: project.template, parts: partsFor(project.template).map(({ name, subsystem, mat, c, s, taper }) => ({ name, subsystem, mat, c, s, taper })),
    palette: paletteFor(project.template, look) };
}

/** Queue the refined Blender model on the existing Creation Engine queue (a free cloud worker starts when none is
 * online). Records the job on the project; the same parts and colour already waiting are not queued twice. */
export async function queueRefinedModel(env, storage, project, { colour = null, now = () => Date.now(), fetcher } = {}) {
  const spec = refinedSpec(project, colour);
  const q = new GpuQueue(storage, now);
  const out = await q.enqueue({ kind: 'invention_model', title: `${project.title.slice(0, 80)}: refined 3D model`, views: [0, 45, 90], samples: 32, res: 480,
    settings: { SPEC: JSON.stringify(spec), RENDER_PROFILE: 'final' }, queued_by: 'Invention Studio', priority: 'normal', requires: { gpu: 'none' } });
  if (!out.ok) return { ok: false, detail: out.detail };
  project.visuals = { ...visualsOf(project), refined: { job_id: out.job.id, colour: spec.palette.name, kind: REFINED_KIND, queued_at: new Date(now()).toISOString() } };
  const cap = await ensureCapacity(env, { storage, now, fetcher, queue: q }).catch(() => null);
  return { ok: true, job_id: out.job.id, duplicate: Boolean(out.duplicate), dispatched: Boolean(cap?.dispatched) };
}

/** Where the refined model stands, from the queue itself: { job_id, state, display_state, status_line, model_url }. */
export async function refinedOf(storage, project, now = () => Date.now()) {
  const r = project.visuals?.refined;
  if (!r?.job_id) return null;
  const j = (await new GpuQueue(storage, now).jobs()).find((x) => x.id === r.job_id);
  if (!j) return { ...r, state: 'gone', status_line: 'The refined model job is no longer in the queue.' };
  const v = publicJob(j);
  return { ...r, state: v.state, display_state: v.display_state, status_line: v.status_line,
    model_url: v.state === 'completed' && v.model ? v.model.url : null, measured: v.measured || null, previews: v.previews || {} };
}

export async function modelBytes(storage, project, v = null) {
  const models = visualsOf(project).models; const m = v ? models.find((x) => x.v === Number(v)) : models.at(-1);
  const b64 = m ? await storage.get(glbKey(project.id, m.v)) : null;
  return b64 ? { bytes: fromB64(b64), model: m } : null;
}

// ─── Words ────────────────────────────────────────────────────────────────

const COLOUR_WORDS = new RegExp(`\\b(${Object.keys(COLOURS).join('|')})\\b`, 'i');

/** "show me", "open it in 3D", "rotate it", "zoom in", "change the color to blue": the visual ask, or null. */
export function inventionVisualIntent(message) {
  const t = String(message || '').toLowerCase().replace(/^(?:che|chay|chey)[,:]?\s+/, '').replace(/[.!?]+$/, '').trim();
  if (!t || t.length > 200) return null;
  let m;
  if (/\b(?:colou?r|paint|recolou?r)\b/.test(t) && /\b(?:change|make|paint|recolou?r|turn|set|switch)\b/.test(t)) {
    m = COLOUR_WORDS.exec(t);
    return { kind: 'colour', colour: m ? m[1].toLowerCase() : null };
  }
  if ((m = /^(?:make|paint|turn) (?:it|the (?:suit|robot|design|invention|model)) (\w+)$/.exec(t)) && COLOURS[m[1]]) return { kind: 'colour', colour: m[1] };
  if (/\b(?:in|into) 3d\b|\b3d (?:model|view|viewer|version)\b|\bview (?:it )?in 3d\b|\bmake (?:it |a )?(?:3d|model)\b/.test(t)) return { kind: 'model' };
  if ((m = /^(?:rotate|spin|turn) (?:it|the (?:suit|robot|design|invention|model))(?: (left|right))?(?: (?:by )?(\d{1,3}) ?(?:degrees?|°))?$/.exec(t))) {
    const deg = m[2] ? Number(m[2]) : 45;
    return { kind: 'viewport', viewport: { action: 'rotate', deg: m[1] === 'left' ? -deg : deg } };
  }
  if (/^zoom (?:in|closer)\b/.test(t)) return { kind: 'viewport', viewport: { action: 'zoom', factor: 1.4 } };
  if (/^zoom out\b/.test(t)) return { kind: 'viewport', viewport: { action: 'zoom', factor: 0.7 } };
  if (/^(?:show me|let me see|show it|draw it|picture it|what does it look like)(?: (?:it|the (?:suit|robot|design|invention|concept)|what it looks like))?$/.test(t)
    || /\b(?:concept (?:picture|image|art|sheet)|picture of (?:it|the (?:suit|robot|design|invention))|new (?:concept|picture))\b/.test(t)) return { kind: 'show' };
  return null;
}

/** Was the owner's previous turn the invention turn (so "show me" means this project)? Same rule as the follow-ups. */
export function continuingInvention(lastAsk, history, now = Date.now()) {
  if (!lastAsk?.text) return false;
  const prior = [...(Array.isArray(history) ? history : [])].reverse().find((h) => String(h?.role) === 'user' && String(h.content || h.text || '').trim());
  return prior ? String(prior.content || prior.text || '').trim() === lastAsk.text : now - Date.parse(lastAsk.at || 0) < 10 * 60 * 1000;
}

/**
 * One visual turn on a project: makes and saves what was asked, and says exactly what exists. Returns
 * { spoken, project, image?, model?, viewport?, open3d } and changes `project` in place (the caller saves it).
 */
export async function visualTurn(env, storage, project, ask, { tryModel = true } = {}) {
  const vis = visualsOf(project);
  if (ask.kind === 'show') {
    const out = await makeConcept(env, storage, project, { tryModel });
    if (!out.ok) return { spoken: out.detail, project };
    const how = out.image.engine === 'che_internal_renderer' ? `a procedural concept sheet from CHE's own renderer, drawn from the same parts as the 3D model${tryModel ? ', because the image model did not return a picture' : ''}` : `a concept picture from ${out.image.engine}`;
    return { spoken: `Here is ${project.title}: ${how}. Saved as concept picture ${out.image.v}. Say "open it in 3D" to turn it around.`, project, image: out.image, steps: out.steps };
  }
  if (ask.kind === 'colour') {
    if (!ask.colour) return { spoken: `Which colour? I can use ${Object.keys(COLOURS).slice(0, 10).join(', ')} and more. Nothing was changed.`, project };
    const model = await makeModel(storage, project, { colour: ask.colour });
    if (!model.ok) return { spoken: model.detail, project };
    const image = await makeConcept(env, storage, project, { colour: ask.colour, tryModel: false });
    const refined = await queueRefinedModel(env, storage, project, { colour: ask.colour }).catch((e) => ({ ok: false, detail: String(e?.message || e) }));
    return { spoken: `Changed the main colour to ${ask.colour}. Saved 3D model version ${model.model.v}${image.ok ? ` and concept sheet ${image.image.v}` : ''}.${refinedLine(refined)}`,
      project, model: model.model, image: image.ok ? image.image : null, refined, open3d: true };
  }
  // model and viewport: build the first model when there is none, then open it.
  let model = vis.models.at(-1) || null; let built = false;
  if (!model) {
    const out = await makeModel(storage, project);
    if (!out.ok) return { spoken: out.detail, project };
    model = out.model; built = true;
  }
  const refined = built ? await queueRefinedModel(env, storage, project).catch((e) => ({ ok: false, detail: String(e?.message || e) })) : null;
  const lead = built ? `Built an ${MODEL_KIND} of ${project.title} with ${model.meshes} parts and saved it as version ${model.v}.` : `Opening 3D model version ${model.v} of ${project.title}.`;
  const tail = ask.kind === 'viewport' ? ' The viewer applies your move and says what it did.' : ' You can rotate it, zoom, and change the colour.';
  return { spoken: `${lead}${tail}${refined ? refinedLine(refined) : ''}`, project, model, refined, viewport: ask.viewport || null, open3d: true };
}

function refinedLine(r) {
  if (!r) return '';
  if (!r.ok) return ` The refined Blender model was not queued: ${r.detail}`;
  return r.duplicate ? ' The refined Blender model for these parts is already queued.'
    : ` The refined Blender model is queued on the Creation Engine${r.dispatched ? ', and a free cloud worker is starting' : ''}; until it is built, this is the instant placeholder.`;
}

/** /api/inventions/:id/model.glb[?v= | ?refined=1] and POST /api/inventions/:id/visual {action, colour}. Null for other paths. */
export async function inventionVisualRoute({ env, storage }, path, request, body = {}) {
  const m = path.match(/^\/api\/inventions\/([A-Za-z0-9-]{4,64})\/(model\.glb|visual)$/);
  if (!m) return null;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const projects = (await storage.get('invention_projects')) || [];
  const project = projects.find((p) => p.id === m[1]);
  if (!project) return json({ detail: 'No invention project with that ID.' }, 404);
  if (m[2] === 'model.glb') {
    if (request.method !== 'GET') return json({ detail: 'Use GET.' }, 405);
    if (new URL(request.url).searchParams.get('refined') === '1') {
      const r = await refinedOf(storage, project);
      const bytes = r?.model_url ? await new GpuQueue(storage).modelBytes(env, r.job_id) : null;
      if (!bytes) return json({ detail: r ? `The refined Blender model is not built yet: ${r.status_line || r.state}` : 'No refined Blender model has been queued for this project.' }, 404);
      return new Response(bytes, { status: 200, headers: { 'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length), 'X-CHE-Model-Kind': 'refined' } });
    }
    const got = await modelBytes(storage, project, new URL(request.url).searchParams.get('v'));
    if (!got) return json({ detail: 'This project has no 3D model yet. Say "open it in 3D" to build one.' }, 404);
    return new Response(got.bytes, { status: 200, headers: { 'Content-Type': 'model/gltf-binary', 'Content-Length': String(got.bytes.length), 'X-CHE-Model-Sha256': got.model.sha256 } });
  }
  if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
  const action = String(body.action || '');
  const ask = action === 'concept' ? { kind: 'show' } : action === 'model' ? { kind: 'model' } : action === 'colour' || action === 'color' ? { kind: 'colour', colour: COLOURS[String(body.colour || body.color || '').toLowerCase()] ? String(body.colour || body.color).toLowerCase() : null } : null;
  if (!ask) return json({ detail: 'Unknown action. Use concept, model or colour.' }, 400);
  if (ask.kind === 'model' && visualsOf(project).models.length && body.rebuild !== true) {
    return json({ ok: true, spoken: `3D model version ${visualsOf(project).models.at(-1).v} is ready.`, project });
  }
  const out = await visualTurn(env, storage, project, ask, { tryModel: body.try_model !== false });
  await storage.put('invention_projects', projects.map((p) => (p.id === project.id ? out.project : p)));
  return json({ ok: Boolean(out.image || out.model), spoken: out.spoken, image: out.image || null, model: out.model || null, steps: out.steps || [], project: out.project });
}
