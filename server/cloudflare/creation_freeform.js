// Create Object from a description (creation-gaps, 2026-10-25: "free-form objects"). The owner says or types what he
// wants ("a snowman", "a red ball on top of a blue box", "a wooden crate", "a rocket 2 metres tall") and CHE composes
// it from parametric primitives (box, cylinder, sphere, cone, torus) that the Blender builder makes exactly
// (tools/avatar_body/objects.py `custom`). It is honest about its reach: it knows a list of shape words and a list of
// recipes (things it can compose from those shapes), and anything else is said plainly, never approximated in silence.
// It is not text-to-3D: no model guesses a mesh. Every part is a measured box in metres, so the Worker, the builder and
// verify_glb.py --static agree on the size the exported GLB must measure (creation_params.py validate_custom).
//
// Spec (object family "custom"): { family: 'custom', description, size, color, roughness, metallic, style,
//   parts: [{ name, shape, c: [x, y, z], s: [w, h, d], axis?, sides?, flip?, color?, metallic?, roughness?, texture? }] }
// c and s are the part's centre and full extents in metres in glTF axes (x right, y up, z front), standing on y = 0.
// A part without its own colour takes the object's colour, so "make it red" recolours the main parts.
// texture names a CC0 material the job fetches at build time (tools/avatar_body/cc0_textures.py: Poly Haven, CC0).

export const SHAPES = ['box', 'cylinder', 'sphere', 'cone', 'torus'];
export const AXES = ['x', 'y', 'z'];
export const TEXTURES = ['wood', 'stone', 'metal', 'fabric', 'brick', 'concrete', 'tile'];
export const MAX_PARTS = 40;
export const EXTENT = [0.005, 5];
export const DESCRIPTION_MAX = 200;
const HEX = /^#[0-9a-f]{6}$/;

const COLOURS = {
  red: '#b0302a', orange: '#e8732e', yellow: '#d8b030', green: '#3c7a4a', 'dark green': '#1f4a2a', 'light green': '#7fc27a',
  teal: '#1f6f78', blue: '#3a6ec8', 'light blue': '#7aa6d6', 'dark blue': '#1d2b4a', navy: '#1d2b4a', purple: '#8d64d6', pink: '#d67ea8',
  white: '#e8e6e0', black: '#16110e', grey: '#8a8580', gray: '#8a8580', brown: '#5a3a22', gold: '#c8a040', silver: '#b8b8b8',
  copper: '#b87333', beige: '#d8c4a0', cream: '#e9dcc8',
};
const METALS = new Set(['gold', 'silver', 'copper']);
const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

// Shape words → [shape, base extents in metres (w, h, d), extra]. "pyramid" is a four-sided cone; "disc" a flat cylinder.
const SHAPE_WORDS = [
  [/^(?:cube|box|block|brick|crate)$/, 'box', [0.4, 0.4, 0.4]],
  [/^(?:plank|slab|board|plate)$/, 'box', [0.8, 0.05, 0.3]],
  [/^(?:ball|sphere|orb|globe|marble)$/, 'sphere', [0.4, 0.4, 0.4]],
  [/^(?:cylinder|tube|pipe|column|pillar|can|post|pole|rod)$/, 'cylinder', [0.25, 0.6, 0.25]],
  [/^(?:disc|disk|coin|puck)$/, 'cylinder', [0.4, 0.05, 0.4]],
  [/^(?:cone|spike)$/, 'cone', [0.35, 0.5, 0.35]],
  [/^(?:pyramid)$/, 'cone', [0.5, 0.4, 0.5], { sides: 4 }],
  [/^(?:ring|donut|doughnut|torus|hoop)$/, 'torus', [0.45, 0.12, 0.45]],
];
const shapeOf = (w) => SHAPE_WORDS.find(([re]) => re.test(w) || re.test(w.replace(/s$/, '')) || re.test(w.replace(/es$/, ''))) || null;

// ── recipes: things composed from the shapes (each part in metres, standing on y = 0) ────────────────────────────────
const P = (name, shape, c, s, extra = {}) => ({ name, shape, c, s, ...extra });
const C = (hex) => ({ color: hex });
const BLACK = C('#16110e'); const WHITE = C('#e8e6e0');
export const RECIPES = {
  snowman: { words: ['snowman', 'snow man'], color: '#e8e6e0', parts: () => [
    P('snow_base', 'sphere', [0, 0.25, 0], [0.5, 0.5, 0.5]), P('snow_middle', 'sphere', [0, 0.66, 0], [0.36, 0.36, 0.36]),
    P('snow_head', 'sphere', [0, 0.95, 0], [0.26, 0.26, 0.26]), P('nose', 'cone', [0, 0.95, 0.17], [0.04, 0.04, 0.12], { axis: 'z', ...C('#e8732e') }),
    P('eye_l', 'sphere', [-0.05, 1.0, 0.115], [0.03, 0.03, 0.03], BLACK), P('eye_r', 'sphere', [0.05, 1.0, 0.115], [0.03, 0.03, 0.03], BLACK),
    P('hat_brim', 'cylinder', [0, 1.075, 0], [0.26, 0.015, 0.26], BLACK), P('hat_top', 'cylinder', [0, 1.155, 0], [0.17, 0.15, 0.17], BLACK)] },
  tree: { words: ['tree', 'pine tree', 'pine', 'christmas tree', 'fir tree'], color: '#2f6b3a', parts: () => [
    P('trunk', 'cylinder', [0, 0.3, 0], [0.16, 0.6, 0.16], { ...C('#5a3a22'), texture: 'wood' }),
    P('foliage_low', 'cone', [0, 0.85, 0], [0.9, 0.7, 0.9]), P('foliage_mid', 'cone', [0, 1.25, 0], [0.7, 0.6, 0.7]),
    P('foliage_top', 'cone', [0, 1.6, 0], [0.48, 0.5, 0.48])] },
  rocket: { words: ['rocket', 'spaceship', 'rocket ship'], color: '#e8e6e0', parts: () => [
    P('body', 'cylinder', [0, 0.75, 0], [0.3, 1.1, 0.3]), P('nose', 'cone', [0, 1.5, 0], [0.3, 0.4, 0.3], C('#b0302a')),
    P('window', 'sphere', [0, 1.0, 0.14], [0.12, 0.12, 0.04], C('#7aa6d6')),
    P('fin_l', 'box', [-0.2, 0.3, 0], [0.12, 0.4, 0.03], C('#b0302a')), P('fin_r', 'box', [0.2, 0.3, 0], [0.12, 0.4, 0.03], C('#b0302a')),
    P('fin_b', 'box', [0, 0.3, -0.2], [0.03, 0.4, 0.12], C('#b0302a')), P('nozzle', 'cone', [0, 0.12, 0], [0.22, 0.24, 0.22], { flip: true, ...C('#3a3a3c'), metallic: 1 })] },
  house: { words: ['house', 'cottage', 'hut', 'cabin'], color: '#d8c4a0', parts: () => [
    P('walls', 'box', [0, 0.6, 0], [2, 1.2, 1.6]), P('roof', 'cone', [0, 1.6, 0], [2.3, 0.8, 1.9], { sides: 4, ...C('#7a1e1a') }),
    P('door', 'box', [0, 0.4, 0.805], [0.4, 0.8, 0.02], { ...C('#5a3a22'), texture: 'wood' }),
    P('window_l', 'box', [-0.6, 0.75, 0.805], [0.35, 0.35, 0.02], C('#7aa6d6')), P('window_r', 'box', [0.6, 0.75, 0.805], [0.35, 0.35, 0.02], C('#7aa6d6')),
    P('chimney', 'box', [0.55, 1.85, -0.3], [0.2, 0.5, 0.2], { ...C('#8a4a3a'), texture: 'brick' })] },
  car: { words: ['car', 'toy car', 'truck', 'van'], color: '#b0302a', parts: () => [
    P('body', 'box', [0, 0.32, 0], [0.9, 0.26, 2.0]), P('cabin', 'box', [0, 0.58, -0.1], [0.8, 0.26, 1.0], C('#7aa6d6')),
    ...[[-0.45, 0.65], [0.45, 0.65], [-0.45, -0.65], [0.45, -0.65]].map(([x, z], i) => P(`wheel_${i}`, 'cylinder', [x, 0.18, z], [0.12, 0.36, 0.36], { axis: 'x', ...BLACK })),
    P('light_l', 'sphere', [-0.3, 0.36, 1.0], [0.1, 0.1, 0.03], C('#f4eec0')), P('light_r', 'sphere', [0.3, 0.36, 1.0], [0.1, 0.1, 0.03], C('#f4eec0'))] },
  robot: { words: ['robot', 'droid', 'android robot'], color: '#8a8580', parts: () => [
    P('leg_l', 'box', [-0.12, 0.25, 0], [0.12, 0.5, 0.14]), P('leg_r', 'box', [0.12, 0.25, 0], [0.12, 0.5, 0.14]),
    P('body', 'box', [0, 0.8, 0], [0.5, 0.6, 0.3]), P('arm_l', 'box', [-0.33, 0.8, 0], [0.1, 0.5, 0.1]), P('arm_r', 'box', [0.33, 0.8, 0], [0.1, 0.5, 0.1]),
    P('head', 'box', [0, 1.28, 0], [0.32, 0.28, 0.28]), P('eye_l', 'sphere', [-0.07, 1.3, 0.14], [0.06, 0.06, 0.02], C('#2fb0a8')),
    P('eye_r', 'sphere', [0.07, 1.3, 0.14], [0.06, 0.06, 0.02], C('#2fb0a8')), P('antenna', 'cylinder', [0, 1.5, 0], [0.02, 0.16, 0.02], C('#3a3a3c')),
    P('antenna_tip', 'sphere', [0, 1.6, 0], [0.05, 0.05, 0.05], C('#b0302a'))], metallic: 1, roughness: 0.35 },
  lollipop: { words: ['lollipop', 'lolly'], color: '#d67ea8', parts: () => [
    P('stick', 'cylinder', [0, 0.15, 0], [0.012, 0.3, 0.012], WHITE), P('candy', 'cylinder', [0, 0.36, 0], [0.14, 0.14, 0.03], { axis: 'z' })] },
  mushroom: { words: ['mushroom', 'toadstool'], color: '#b0302a', parts: () => [
    P('stem', 'cylinder', [0, 0.12, 0], [0.1, 0.24, 0.1], C('#e9dcc8')), P('cap', 'sphere', [0, 0.26, 0], [0.32, 0.16, 0.32]),
    P('spot_1', 'sphere', [0.06, 0.33, 0.06], [0.04, 0.02, 0.04], WHITE), P('spot_2', 'sphere', [-0.07, 0.32, 0.03], [0.035, 0.02, 0.035], WHITE)] },
  dumbbell: { words: ['dumbbell', 'weight', 'barbell'], color: '#3a3a3c', parts: () => [
    P('bar', 'cylinder', [0, 0.06, 0], [0.4, 0.03, 0.03], { axis: 'x', ...C('#b8b8b8'), metallic: 1 }),
    P('weight_l', 'cylinder', [-0.16, 0.06, 0], [0.06, 0.12, 0.12], { axis: 'x' }), P('weight_r', 'cylinder', [0.16, 0.06, 0], [0.06, 0.12, 0.12], { axis: 'x' })] },
  hammer: { words: ['hammer', 'mallet'], color: '#5a3a22', parts: () => [
    P('handle', 'cylinder', [0, 0.15, 0], [0.03, 0.3, 0.03], { texture: 'wood' }),
    P('head', 'box', [0, 0.32, 0], [0.13, 0.05, 0.05], { ...C('#3a3a3c'), metallic: 1, roughness: 0.3 })] },
  bottle: { words: ['bottle', 'water bottle'], color: '#3c7a4a', parts: () => [
    P('body', 'cylinder', [0, 0.1, 0], [0.08, 0.2, 0.08]), P('shoulder', 'cone', [0, 0.225, 0], [0.08, 0.05, 0.08]),
    P('neck', 'cylinder', [0, 0.27, 0], [0.028, 0.06, 0.028]), P('cap', 'cylinder', [0, 0.31, 0], [0.032, 0.02, 0.032], C('#c8a040'))] },
  barrel: { words: ['barrel', 'keg'], color: '#6b4226', parts: () => [
    P('staves', 'cylinder', [0, 0.45, 0], [0.6, 0.9, 0.6], { texture: 'wood' }),
    P('band_low', 'torus', [0, 0.2, 0], [0.62, 0.03, 0.62], { ...C('#3a3a3c'), metallic: 1 }), P('band_high', 'torus', [0, 0.7, 0], [0.62, 0.03, 0.62], { ...C('#3a3a3c'), metallic: 1 })] },
  tower: { words: ['tower', 'castle tower', 'turret', 'lighthouse'], color: '#8a8580', parts: () => [
    P('wall', 'cylinder', [0, 1, 0], [0.8, 2, 0.8], { texture: 'stone' }), P('roof', 'cone', [0, 2.35, 0], [1, 0.7, 1], C('#3a6ec8')),
    P('door', 'box', [0, 0.3, 0.4], [0.25, 0.6, 0.02], C('#5a3a22'))] },
  pencil: { words: ['pencil', 'crayon'], color: '#d8b030', parts: () => [
    P('eraser', 'cylinder', [0, 0.01, 0], [0.012, 0.02, 0.012], C('#d67ea8')), P('ferrule', 'cylinder', [0, 0.027, 0], [0.012, 0.014, 0.012], { ...C('#b8b8b8'), metallic: 1 }),
    P('body', 'cylinder', [0, 0.1, 0], [0.012, 0.132, 0.012], { sides: 6 }), P('tip', 'cone', [0, 0.18, 0], [0.012, 0.028, 0.012], C('#d8c4a0'))] },
  trophy: { words: ['trophy', 'cup trophy'], color: '#c8a040', metallic: 1, roughness: 0.25, parts: () => [
    P('base', 'box', [0, 0.04, 0], [0.18, 0.08, 0.18], BLACK), P('stem', 'cylinder', [0, 0.13, 0], [0.04, 0.1, 0.04]),
    P('cup', 'cone', [0, 0.27, 0], [0.2, 0.18, 0.2], { flip: true }), P('handle_l', 'torus', [-0.11, 0.28, 0], [0.08, 0.08, 0.015], { axis: 'z' }),
    P('handle_r', 'torus', [0.11, 0.28, 0], [0.08, 0.08, 0.015], { axis: 'z' })] },
  ice_cream: { words: ['ice cream', 'ice cream cone', 'icecream'], color: '#e9dcc8', parts: () => [
    P('cone', 'cone', [0, 0.08, 0], [0.08, 0.16, 0.08], { flip: true, ...C('#c09a5a') }), P('scoop', 'sphere', [0, 0.19, 0], [0.09, 0.09, 0.09]),
    P('cherry', 'sphere', [0, 0.245, 0], [0.025, 0.025, 0.025], C('#b0302a'))] },
  cake: { words: ['cake', 'birthday cake'], color: '#e9dcc8', parts: () => [
    P('tier_low', 'cylinder', [0, 0.06, 0], [0.3, 0.12, 0.3]), P('tier_high', 'cylinder', [0, 0.17, 0], [0.2, 0.1, 0.2], C('#d67ea8')),
    ...[-0.05, 0, 0.05].map((x, i) => P(`candle_${i}`, 'cylinder', [x, 0.25, 0], [0.012, 0.06, 0.012], C('#7aa6d6'))),
    ...[-0.05, 0, 0.05].map((x, i) => P(`flame_${i}`, 'cone', [x, 0.295, 0], [0.014, 0.03, 0.014], C('#f4c040')))] },
  sword: { words: ['sword', 'blade'], color: '#b8b8b8', metallic: 1, roughness: 0.25, parts: () => [
    P('pommel', 'sphere', [0, 0.02, 0], [0.04, 0.04, 0.04], C('#c8a040')), P('grip', 'cylinder', [0, 0.1, 0], [0.03, 0.14, 0.03], { ...C('#3a2416'), metallic: 0, roughness: 0.7 }),
    P('guard', 'box', [0, 0.185, 0], [0.2, 0.03, 0.04], C('#c8a040')), P('blade', 'box', [0, 0.6, 0], [0.05, 0.8, 0.008]),
    P('tip', 'cone', [0, 1.04, 0], [0.05, 0.08, 0.008], { sides: 4 })] },
  planet: { words: ['planet', 'saturn', 'ringed planet'], color: '#d8b030', parts: () => [
    P('globe', 'sphere', [0, 0.5, 0], [0.6, 0.6, 0.6]), P('ring', 'torus', [0, 0.5, 0], [1.0, 0.03, 1.0], C('#d8c4a0'))] },
  traffic_cone: { words: ['traffic cone', 'road cone', 'safety cone'], color: '#e8732e', parts: () => [
    P('base', 'box', [0, 0.015, 0], [0.4, 0.03, 0.4], BLACK), P('cone', 'cone', [0, 0.38, 0], [0.3, 0.7, 0.3]),
    P('stripe', 'torus', [0, 0.45, 0], [0.18, 0.04, 0.18], WHITE)] },
  crate: { words: ['crate', 'wooden crate', 'wooden box', 'chest'], color: '#8a5a36', parts: () => [
    P('box', 'box', [0, 0.25, 0], [0.5, 0.5, 0.5], { texture: 'wood' }),
    ...[0.03, 0.47].map((y, i) => P(`band_${i}`, 'box', [0, y, 0], [0.52, 0.04, 0.52], { ...C('#5a3a22'), texture: 'wood' }))] },
  table_lamp_globe: { words: ['globe lamp', 'orb lamp'], color: '#f4eec0', parts: () => [
    P('base', 'cylinder', [0, 0.02, 0], [0.16, 0.04, 0.16], { ...C('#3a3a3c'), metallic: 1 }), P('globe', 'sphere', [0, 0.17, 0], [0.26, 0.26, 0.26])] },
};
const RECIPE_LIST = Object.entries(RECIPES).flatMap(([id, r]) => r.words.map((w) => [w, id])).sort((a, b) => b[0].length - a[0].length);
export const RECIPE_NAMES = Object.keys(RECIPES).filter((k) => k !== 'table_lamp_globe').map((k) => k.replace(/_/g, ' '));

const STOP = new Set(['a', 'an', 'the', 'and', 'with', 'of', 'on', 'top', 'in', 'to', 'it', 'its', 'some', 'me', 'that', 'is', 'made', 'make', 'create',
  'build', 'please', 'object', 'thing', 'model', 'new', 'next', 'beside', 'above', 'under', 'below', 'over', 'stacked', 'stack', 'pile', 'row', 'by',
  'small', 'little', 'tiny', 'big', 'large', 'huge', 'giant', 'tall', 'short', 'wide', 'thin', 'flat', 'long', 'round', 'shiny', 'glossy', 'matte',
  'metal', 'metallic', 'steel', 'chrome', 'iron', 'wooden', 'wood', 'stone', 'brick', 'concrete', 'fabric', 'cloth', 'plastic', 'ceramic', 'glass',
  'one', 'two', 'three', 'four', 'five', 'six', 'cm', 'centimetres', 'centimeters', 'metre', 'metres', 'meter', 'meters', 'm', 'tall', 'high', 'wide',
  'for', 'my', 'desk', 'side', 'each', 'other', 'together', 'standing', 'sitting', 'light', 'dark']);

function normal(text) {
  return String(text || '').toLowerCase().replace(/[’']/g, '').replace(/[.!?]+$/g, '').replace(/^(?:che|chey|chay)[,:]?\s+/, '')
    .replace(/^(?:please\s+)?(?:create|make|build|model|design)(?: me)?\s+(?:an?\s+)?(?:object\s+(?:of\s+)?(?:an?\s+)?)?/, '').replace(/\s+/g, ' ').trim();
}

const colourIn = (t) => Object.keys(COLOURS).sort((a, b) => b.length - a.length).find((w) => new RegExp(`\\b${w}\\b`).test(t)) || null;
function materialIn(t) {
  if (/\b(?:wood(?:en)?|timber|oak)\b/.test(t)) return { texture: 'wood' };
  if (/\b(?:stone|marble|granite|rock)\b/.test(t)) return { texture: 'stone' };
  if (/\bbrick\b/.test(t) && !/\bbricks?$/.test(t)) return { texture: 'brick' };
  if (/\bconcrete\b/.test(t)) return { texture: 'concrete' };
  if (/\b(?:fabric|cloth|woollen|knitted)\b/.test(t)) return { texture: 'fabric' };
  if (/\b(?:metal(?:lic)?|steel|chrome|iron|aluminium|aluminum)\b/.test(t)) return { metallic: 1, roughness: 0.3 };
  if (/\b(?:shiny|glossy|polished|glass|plastic|ceramic)\b/.test(t)) return { roughness: 0.15 };
  if (/\bmatte?\b/.test(t)) return { roughness: 0.8 };
  return {};
}
function scaleWord(t) {
  if (/\b(?:huge|giant|enormous)\b/.test(t)) return 2;
  if (/\b(?:big|large)\b/.test(t)) return 1.5;
  if (/\b(?:tiny)\b/.test(t)) return 0.4;
  if (/\b(?:small|little|mini)\b/.test(t)) return 0.6;
  return 1;
}
/** "2 metres tall", "50 cm high", "1.5 m" → the height in metres asked for, or null. */
function heightIn(t) {
  const m = /(\d+(?:\.\d+)?)\s?(cm|centimet(?:re|er)s?|m|met(?:re|er)s?)\b(?:\s+(?:tall|high|long|wide|across))?/.exec(t);
  if (!m) return null;
  return Number(m[1]) / (/^c/.test(m[2]) ? 100 : 1);
}

export function bboxOf(parts) {
  const lo = [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.c[k] - p.s[k] / 2)));
  const hi = [0, 1, 2].map((k) => Math.max(...parts.map((p) => p.c[k] + p.s[k] / 2)));
  return { lo, hi, size: hi.map((h, k) => h - lo[k]) };
}
const r4 = (v) => Math.round(v * 10000) / 10000;

/** Scales the parts about the ground centre so the whole stands on y = 0, centred in x and z. */
function settle(parts, factor) {
  const b = bboxOf(parts); const cx = (b.lo[0] + b.hi[0]) / 2; const cz = (b.lo[2] + b.hi[2]) / 2;
  return parts.map((p) => ({ ...p, c: [r4((p.c[0] - cx) * factor), r4((p.c[1] - b.lo[1]) * factor), r4((p.c[2] - cz) * factor)], s: p.s.map((x) => r4(Math.max(EXTENT[0], x * factor))) }));
}

/** Generic shape phrases: "a red ball on top of a blue box", "three blue cubes", "a small gold ring". */
function shapePhrases(t) {
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  const found = [];
  words.forEach((w, i) => {
    const sh = shapeOf(w);
    if (!sh) return;
    // Up to four words before it, back to the previous shape or a relation word, are its number and adjectives.
    const before = [];
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      if (shapeOf(words[j]) || /^(?:on|of|top|above|under|below|beneath|next|beside|and|with|by|over)$/.test(words[j])) break;
      before.unshift(words[j]);
    }
    const num = before.find((x) => NUMBERS[x] || /^[1-6]$/.test(x));
    const adj = before.filter((x) => x !== num).join(' ');
    found.push({ n: Math.min(6, NUMBERS[num] || Number(num) || 1), adj, shape: sh, text: [...before, w].join(' ') });
  });
  return found;
}

/**
 * The owner's description → { ok, spec, made, unused, detail }. made is one plain sentence of what will be built;
 * unused lists words CHE did not use (said back to the owner); detail says plainly why nothing could be made.
 */
export function composeFreeform(description) {
  const raw = String(description || '').trim().slice(0, DESCRIPTION_MAX);
  const t = normal(raw);
  if (!t) return { ok: false, detail: 'Say what the object should be, for example: a snowman, a wooden crate, or a red ball on top of a blue box.' };
  const mat = materialIn(t); const colour = colourIn(t);
  const want = heightIn(t); const factor = scaleWord(t);
  let parts; let color; let made; let used = new Set();
  let base = { metallic: 0, roughness: 0.45 };
  const hit = RECIPE_LIST.find(([w]) => new RegExp(`\\b${w}s?\\b`).test(t));
  if (hit) {
    const r = RECIPES[hit[1]];
    parts = r.parts(); color = colour ? COLOURS[colour] : r.color;
    base = { metallic: r.metallic ?? 0, roughness: r.roughness ?? 0.45 };
    hit[0].split(' ').forEach((w) => used.add(w));
    made = `a ${hit[1].replace(/_/g, ' ')} composed of ${parts.length} parts (${[...new Set(parts.map((p) => p.shape))].join(', ')})`;
  } else {
    const phrases = shapePhrases(t);
    if (!phrases.length) {
      const words = t.split(/[^a-z]+/).filter((w) => w && !STOP.has(w) && !COLOURS[w]);
      return { ok: false, unused: words,
        detail: `I can't build ${words.length ? `a ${words.slice(0, 4).join(' ')}` : 'that'} yet. Create Object composes things from boxes, balls, cylinders, cones, pyramids and rings, `
          + `and knows these: ${RECIPE_NAMES.join(', ')}; plus the lamp, chair, table, desk, mug, vase and shelf families. It is not free-form text-to-3D, so nothing was made.` };
    }
    const stacked = /\b(?:on top of|on|above|stacked|over)\b/.test(t) && !/\b(?:next to|beside|by)\b/.test(t);
    const below = /\b(?:under|below|beneath)\b/.test(t);
    let list = [];
    for (const ph of phrases) {
      const c = colourIn(ph.adj); const m = materialIn(ph.adj); const k = scaleWord(ph.adj);
      for (let i = 0; i < ph.n; i++) list.push({ ...ph, colour: c, mat: m, k });
      ph.text.split(' ').forEach((w) => used.add(w));
    }
    list = list.slice(0, 12);
    // "A on top of B" names the top first; "A under B" names the bottom first; "A and B" stands them side by side.
    const order = stacked && !below ? [...list].reverse() : list;
    parts = []; let y = 0; let x = 0;
    order.forEach((it, i) => {
      const [, shape, ext, extra = {}] = it.shape;
      const s = ext.map((v) => v * it.k * (/\b(?:tall|long)\b/.test(it.adj) && v === ext[1] ? 1.8 : 1) * (/\bflat\b/.test(it.adj) && v === ext[1] ? 0.3 : 1));
      const own = { ...(it.colour ? { color: COLOURS[it.colour] } : {}), ...it.mat, ...(it.colour && METALS.has(it.colour) ? { metallic: 1, roughness: 0.25 } : {}) };
      if (stacked || below) { parts.push(P(`${shape}_${i}`, shape, [0, y + s[1] / 2, 0], s, { ...extra, ...own })); y += s[1]; }
      else { parts.push(P(`${shape}_${i}`, shape, [x + s[0] / 2, s[1] / 2, 0], s, { ...extra, ...own })); x += s[0] + 0.05; }
    });
    color = colour && !phrases.some((p) => colourIn(p.adj)) ? COLOURS[colour] : '#8a8580';
    made = `${parts.length} shape${parts.length === 1 ? '' : 's'} (${list.map((p) => `${p.colour ? `${p.colour} ` : ''}${p.shape[1] === 'cone' && p.shape[3]?.sides === 4 ? 'pyramid' : p.shape[1]}`).join(', ')})${parts.length > 1 ? (stacked || below ? ', stacked' : ', side by side') : ''}`;
  }
  // Whole-object material words apply to the parts that have no texture or finish of their own.
  if (mat.texture) parts = parts.map((p) => (p.color || p.texture ? p : { ...p, texture: mat.texture }));
  if (mat.metallic != null) base.metallic = mat.metallic;
  if (mat.roughness != null) base.roughness = mat.roughness;
  if (colour && METALS.has(colour)) { base.metallic = 1; base.roughness = 0.25; }
  // Size: an asked height wins; else small / big words scale it.
  const h = bboxOf(parts).size[1];
  let k = want ? want / h : factor;
  const big = Math.max(...bboxOf(parts).size) * k;
  if (big > EXTENT[1]) k *= EXTENT[1] / big;
  parts = settle(parts, k);
  const size = bboxOf(parts).size.map((v) => Math.round(v * 100) / 100);
  const unused = t.split(/[^a-z0-9.]+/).filter((w) => w && !used.has(w) && !used.has(w.replace(/s$/, '')) && !STOP.has(w) && !COLOURS[w] && !/^\d/.test(w)
    && !shapeOf(w) && !RECIPE_LIST.some(([r]) => r.split(' ').includes(w)));
  const spec = { family: 'custom', description: raw, size: 1, color: color || '#8a8580', roughness: base.roughness, metallic: base.metallic, style: 'modern', parts };
  const textured = [...new Set(parts.map((p) => p.texture).filter(Boolean))];
  return { ok: true, spec, unused,
    made: `${made}, ${size.join(' x ')} m (width x height x depth)${textured.length ? `, with CC0 ${textured.join(' and ')} texture${textured.length === 1 ? '' : 's'} fetched when it builds` : ''}` };
}

/** Every reason the builder would refuse a custom spec (empty when it builds); the same limits as creation_params.py. */
export function customErrors(s) {
  const bad = [];
  if (typeof s.description !== 'string' || s.description.length > DESCRIPTION_MAX) bad.push(`description must be text up to ${DESCRIPTION_MAX} characters`);
  if (!Array.isArray(s.parts) || !s.parts.length) return [...bad, 'parts must be a non-empty list'];
  if (s.parts.length > MAX_PARTS) return [...bad, `${s.parts.length} parts, more than the ${MAX_PARTS} CHE builds`];
  const vec = (v, lo, hi) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi);
  s.parts.forEach((p, i) => {
    const n = p?.name || i;
    if (!p || typeof p !== 'object') { bad.push(`part ${i} is not an object`); return; }
    if (!/^[a-z0-9_]{1,40}$/.test(String(p.name))) bad.push(`part ${i} needs a short lower-case name`);
    if (!SHAPES.includes(p.shape)) bad.push(`part ${n}: shape must be one of ${SHAPES.join(', ')}`);
    if (!vec(p.c, -5, 5)) bad.push(`part ${n}: c must be three numbers within 5 m`);
    if (!vec(p.s, ...EXTENT)) bad.push(`part ${n}: s must be three sizes from ${EXTENT[0]} to ${EXTENT[1]} m`);
    if (p.axis !== undefined && !AXES.includes(p.axis)) bad.push(`part ${n}: axis must be x, y or z`);
    if (p.sides !== undefined && !(Number.isInteger(p.sides) && p.sides >= 3 && p.sides <= 64)) bad.push(`part ${n}: sides must be 3 to 64`);
    if (p.flip !== undefined && typeof p.flip !== 'boolean') bad.push(`part ${n}: flip must be true or false`);
    if (p.color !== undefined && !HEX.test(String(p.color))) bad.push(`part ${n}: color must be #rrggbb`);
    for (const k of ['metallic', 'roughness']) if (p[k] !== undefined && !(typeof p[k] === 'number' && p[k] >= 0 && p[k] <= 1)) bad.push(`part ${n}: ${k} must be 0 to 1`);
    if (p.texture !== undefined && !TEXTURES.includes(p.texture)) bad.push(`part ${n}: texture must be one of ${TEXTURES.join(', ')}`);
  });
  return bad;
}
