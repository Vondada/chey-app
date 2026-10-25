// Create Object and Create Room (owner, 2026-10-24): the Live Studio's second and third project kinds, on the same
// creation projects, versions, undo/redo, Creation Engine queue and 3D viewport as Create Person (creation_studio.js).
// They are procedural and parametric, not free-form text-to-3D: an object is one of a fixed family list (lamp, chair,
// table, mug, vase, shelf) with size, colour, roughness, metallic and style; a room is one of four types (living room,
// bedroom, office, studio) with its size in metres, wall colour, floor, furniture from the same families plus sofa,
// bed, rug and plant, and warm, neutral or cool light. The Blender builders (tools/avatar_body/objects.py, rooms.py)
// validate the same spec again with the same limits (tools/avatar_body/creation_params.py; a Python test compares the
// two). Generating queues an `object_model` or `room_model` job (gpu_queue.js) that any worker may take, CPU included:
// it builds the GLB, re-reads and measures it (meshes, triangles, materials, bounding box in metres against the asked
// size) and renders front, three-quarter and side previews from the file, and completes only with that measurement.
//
// Create Object from a description (creation-gaps, 2026-10-25): the `custom` family is composed from parametric
// primitives by creation_freeform.js ("a snowman", "a red ball on top of a blue box"); what it cannot compose is said.
//
// Edits are deterministic sentences, like the person edits: "make it red", "bigger", "shinier", "make it a chair",
// "add a desk", "remove the rug", "warmer light", "5 metres wide", "tile floor", "industrial style". Anything outside
// the families and parameters is refused with the reason, never approximated in silence.

import { composeFreeform, customErrors, RECIPE_NAMES } from './creation_freeform.js';

export const FAMILIES = ['lamp', 'chair', 'table', 'mug', 'vase', 'shelf'];
/** The families a spec may name: the fixed builders plus `custom` (composed from a description). */
export const ALL_FAMILIES = [...FAMILIES, 'custom'];
export const STYLES = ['modern', 'classic', 'industrial'];
export const FORMS = { lamp: ['desk', 'floor'], table: ['dining', 'coffee', 'desk'] };
export const ROOM_TYPES = ['living_room', 'bedroom', 'office', 'studio'];
export const FLOORS = ['oak', 'walnut', 'tile', 'concrete', 'carpet'];
export const LIGHTINGS = ['warm', 'neutral', 'cool'];
export const ROOM_ITEMS = ['sofa', 'bed', 'desk', 'table', 'chair', 'lamp', 'shelf', 'vase', 'mug', 'plant', 'rug'];
export const MAX_ITEMS = 10;
export const SIZE = [0.5, 2.0];
export const ROOM_LIMITS = { width: [2.5, 8.0], depth: [2.5, 8.0], height: [2.3, 4.0] };
export const OBJECT_DEFAULTS = {
  lamp: { color: '#1f6f78', roughness: 0.35, metallic: 0, style: 'modern', form: 'desk' },
  chair: { color: '#8a5a36', roughness: 0.5, metallic: 0, style: 'modern' },
  table: { color: '#6b4226', roughness: 0.45, metallic: 0, style: 'modern', form: 'dining' },
  mug: { color: '#e8732e', roughness: 0.25, metallic: 0, style: 'modern' },
  vase: { color: '#2f5f8a', roughness: 0.2, metallic: 0, style: 'classic' },
  shelf: { color: '#5a3a22', roughness: 0.55, metallic: 0, style: 'modern' },
};
export const ROOM_DEFAULTS = {
  living_room: { width: 4.5, depth: 4.0, height: 2.7, wall_color: '#b8b2a8', floor: 'oak', lighting: 'warm', style: 'modern', furniture: ['sofa', 'table', 'rug', 'lamp', 'shelf', 'plant', 'vase'] },
  bedroom: { width: 4.0, depth: 4.0, height: 2.6, wall_color: '#a9b4b8', floor: 'walnut', lighting: 'warm', style: 'classic', furniture: ['bed', 'lamp', 'shelf', 'rug', 'plant'] },
  office: { width: 3.5, depth: 3.5, height: 2.7, wall_color: '#c9ccc8', floor: 'concrete', lighting: 'cool', style: 'industrial', furniture: ['desk', 'chair', 'lamp', 'shelf', 'plant', 'mug'] },
  studio: { width: 5.0, depth: 4.5, height: 3.2, wall_color: '#d8d4cc', floor: 'tile', lighting: 'neutral', style: 'modern', furniture: ['table', 'chair', 'lamp', 'shelf', 'rug', 'plant'] },
};
export const ROOM_LABELS = { living_room: 'living room', bedroom: 'bedroom', office: 'office', studio: 'studio' };
export const FAMILY_LABELS = { lamp: 'lamp', chair: 'chair', table: 'table', mug: 'mug', vase: 'vase', shelf: 'shelf' };

/** Owner-facing kinds: object and room; the queue's job kinds. */
export const KIND_JOB = { object: 'object_model', room: 'room_model' };

// Render detail for object and room jobs. The times are estimates, not measurements: the receipt has the real time.
export const OBJECT_QUALITY = {
  draft: { label: 'Draft', samples: 16, res: 360 },
  standard: { label: 'Standard', samples: 32, res: 480 },
  high: { label: 'High Detail', samples: 64, res: 720 },
  ultra: { label: 'Ultra Detail', samples: 128, res: 1080 },
};
export const CAPABILITY_NOTE = 'procedural parametric objects and rooms from a fixed family list, and objects composed from boxes, balls, cylinders, cones and rings from a description; not free-form text-to-3D';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (v) => Math.round(v * 100) / 100;
const HEX = /^#[0-9a-f]{6}$/;

/** Every reason a spec would be refused by the Blender builders (empty when it builds). */
export function specErrors(kind, s) {
  const bad = [];
  if (!s || typeof s !== 'object') return ['the spec must be an object'];
  const num = (k, lo, hi) => { const v = Number(s[k]); if (!Number.isFinite(v) || v < lo || v > hi) bad.push(`${k} must be ${lo} to ${hi}`); };
  if (kind === 'object') {
    if (!ALL_FAMILIES.includes(s.family)) return [`family ${s.family} is not built; only ${FAMILIES.join(', ')} or a described object`];
    num('size', ...SIZE); num('roughness', 0, 1); num('metallic', 0, 1);
    if (!HEX.test(String(s.color))) bad.push('color must be #rrggbb');
    if (!STYLES.includes(s.style)) bad.push(`style must be one of ${STYLES.join(', ')}`);
    if (FORMS[s.family] ? !FORMS[s.family].includes(s.form) : s.form !== undefined) bad.push(`form ${s.form} is not a ${s.family} form`);
    if (s.family === 'custom') bad.push(...customErrors(s));
    return bad;
  }
  if (!ROOM_TYPES.includes(s.type)) return [`room type ${s.type} is not built; only ${ROOM_TYPES.join(', ')}`];
  for (const [k, [lo, hi]] of Object.entries(ROOM_LIMITS)) num(k, lo, hi);
  if (!HEX.test(String(s.wall_color))) bad.push('wall_color must be #rrggbb');
  if (!FLOORS.includes(s.floor)) bad.push(`floor must be one of ${FLOORS.join(', ')}`);
  if (!LIGHTINGS.includes(s.lighting)) bad.push(`lighting must be one of ${LIGHTINGS.join(', ')}`);
  if (!STYLES.includes(s.style)) bad.push(`style must be one of ${STYLES.join(', ')}`);
  const f = Array.isArray(s.furniture) ? s.furniture : null;
  if (!f) bad.push('furniture must be a list');
  else {
    if (f.some((x) => !ROOM_ITEMS.includes(x))) bad.push(`furniture must come from ${ROOM_ITEMS.join(', ')}`);
    if (f.length > MAX_ITEMS) bad.push(`at most ${MAX_ITEMS} pieces of furniture`);
    if (new Set(f).size !== f.length) bad.push('each piece of furniture is listed once');
  }
  return bad;
}

/** The starting spec for a new project: base is a family (object) or a room type (room); null when not built. */
export function defaultSpec(kind, base) {
  if (kind === 'object') {
    const fam = base === 'desk' ? 'table' : base;
    if (!FAMILIES.includes(fam)) return null;
    const s = { family: fam, size: 1, ...OBJECT_DEFAULTS[fam] };
    if (base === 'desk') s.form = 'desk';
    return s;
  }
  const t = String(base || '').replace(/[\s-]+/g, '_');
  return ROOM_TYPES.includes(t) ? { type: t, ...structuredClone(ROOM_DEFAULTS[t]) } : null;
}

/** The job settings: the whole spec as SPEC (JSON text, under the queue's 400-character setting limit). */
export function specSettings(spec) { return { SPEC: JSON.stringify(spec) }; }

export function qualityOf(render) { const id = OBJECT_QUALITY[render?.quality] ? render.quality : 'standard'; return { id, ...OBJECT_QUALITY[id] }; }

export function resourceLine(render) {
  const q = qualityOf(render);
  return `${q.label}: ${q.samples} samples, ${q.res} pixels on the long edge. Rough estimate: under a few minutes of rendering on the free cloud CPU `
    + 'plus a few minutes for a cloud worker to start (an estimate, not measured on that runner; the job receipt records the real time).';
}

const NAMES = {
  red: '#b0302a', 'dark red': '#7a1e1a', burgundy: '#6a1e24', orange: '#e8732e', yellow: '#d8b030', mustard: '#c09a2a', green: '#3c7a4a',
  'dark green': '#1f4a2a', olive: '#56603e', teal: '#1f6f78', turquoise: '#2fb0a8', blue: '#3a6ec8', 'light blue': '#7aa6d6', navy: '#1d2b4a',
  purple: '#8d64d6', violet: '#8d64d6', pink: '#d67ea8', white: '#e8e6e0', cream: '#e9dcc8', beige: '#d8c4a0', tan: '#b08a5a',
  grey: '#8a8580', gray: '#8a8580', 'light grey': '#c0bcb6', 'light gray': '#c0bcb6', 'dark grey': '#3a3a3c', 'dark gray': '#3a3a3c',
  charcoal: '#2a2a2c', black: '#16110e', brown: '#5a3a22', 'dark brown': '#3a2416', gold: '#c8a040', silver: '#b8b8b8', copper: '#b87333',
  brass: '#b08d57', sage: '#9caf88', terracotta: '#c0603a', mint: '#a8dcc0', lavender: '#b8a8d8',
};
const METAL_COLOURS = new Set(['gold', 'silver', 'copper', 'brass']);
const colourWord = (t) => Object.keys(NAMES).sort((a, b) => b.length - a.length).find((w) => new RegExp(`\\b${w}\\b`).test(t)) || null;
export const colourName = (hex) => Object.entries(NAMES).find(([, h]) => h === hex)?.[0] || hex;

function styleWord(t) {
  if (/\b(?:modern|contemporary|minimal(?:ist)?|sleek)\b/.test(t)) return 'modern';
  if (/\b(?:classic(?:al)?|traditional|vintage|antique|old[- ]fashioned)\b/.test(t)) return 'classic';
  if (/\b(?:industrial|loft|factory)\b/.test(t)) return 'industrial';
  return null;
}

function qualityWord(t) {
  if (/\bdraft\b|\bquick preview\b|\blow detail\b|\blow[- ]?poly\b/.test(t)) return 'draft';
  if (/\bultra\b|\bmax(?:imum)? detail\b/.test(t)) return 'ultra';
  if (/\bhigh(?:er)? (?:detail|quality)\b|\bhighly detailed\b|\bmore detail(?:ed)?\b/.test(t)) return 'high';
  if (/\b(?:standard|normal) (?:detail|quality)\b/.test(t)) return 'standard';
  return null;
}

const FAMILY_WORDS = [['lamp', /^(?:lamp|desk lamp|floor lamp|table lamp|reading lamp)$/], ['chair', /^(?:chair|seat|dining chair)$/],
  ['table', /^(?:table|coffee table|dining table|desk|side table)$/], ['mug', /^(?:mug|cup|coffee mug)$/], ['vase', /^(?:vase|flower vase|pot)$/],
  ['shelf', /^(?:shelf|shelves|bookshelf|bookcase|shelving unit)$/]];
const familyOf = (w) => FAMILY_WORDS.find(([, re]) => re.test(w))?.[0] || null;
// Words after "make it a ..." that are not a thing: "make it a little bigger", "make it a bit shinier".
const NOT_A_THING = /^(?:little|bit|lot|touch|tad|tiny bit|lot more|shade|different|new|nicer|better|darker|lighter|bigger|smaller)\b/;

function normal(text) {
  return String(text || '').toLowerCase().replace(/[.!?]+$/g, '').replace(/^(?:che|chey|chay)[,:]?\s+/, '').replace(/\s+/g, ' ').trim();
}

/** Size words: a new factor (relative or absolute) or null. */
function sizeChange(t) {
  let m;
  if ((m = /\bsize (\d(?:\.\d+)?)\b/.exec(t))) return { set: Number(m[1]) };
  if (/\btwice (?:as )?(?:big|large)\b|\bdouble (?:the |its )?size\b/.test(t)) return { mul: 2 };
  if (/\bhalf (?:the |its )?size\b/.test(t)) return { mul: 0.5 };
  if (/\b(?:much|a lot|way) (?:bigger|larger|taller)\b/.test(t)) return { mul: 1.5 };
  if (/\b(?:much|a lot|way) (?:smaller|shorter)\b/.test(t)) return { mul: 1 / 1.5 };
  if (/\b(?:bigger|larger|taller|grow|enlarge|scale (?:it )?up)\b/.test(t)) return { mul: 1.2 };
  if (/\b(?:smaller|shorter|tinier|shrink|scale (?:it )?down)\b/.test(t)) return { mul: 1 / 1.2 };
  return null;
}

/**
 * One sentence against an object spec: { spec, quality, applied, unsupported }. spec is an edited copy; quality is a
 * new detail id or null. applied and unsupported are plain sentences.
 */
export function parseObjectEdit(text, spec) {
  const t = normal(text); const s = structuredClone(spec); const applied = []; const unsupported = [];
  let m;
  // A different family ("make it a chair", "turn it into a bookcase"), or something no family builds.
  if ((m = /\b(?:make it|turn it into|change it (?:in)?to|swap it for|replace it with)\s+(?:a|an)\s+([a-z]+(?: [a-z]+)?)/.exec(t)) && !NOT_A_THING.test(m[1])) {
    const w = m[1].replace(/ (?:instead|please)$/, ''); const fam = familyOf(w) || familyOf(w.split(' ').pop());
    if (fam) {
      const keep = { size: s.size, color: s.color, roughness: s.roughness, metallic: s.metallic, style: s.style };
      Object.keys(s).forEach((k) => delete s[k]);
      Object.assign(s, { family: fam, ...keep });
      if (FORMS[fam]) s.form = /desk/.test(w) && fam === 'table' ? 'desk' : /coffee/.test(w) ? 'coffee' : /floor/.test(w) ? 'floor' : OBJECT_DEFAULTS[fam].form;
      if (fam !== spec.family || s.form !== spec.form) applied.push(`Changed to a ${s.form && fam !== 'lamp' ? `${s.form} ` : s.form === 'floor' ? 'floor ' : ''}${fam}, keeping its colour, finish, style and size.`);
    } else if (!colourWord(w) && !styleWord(w)) {
      // Not a family: compose it from primitives (creation_freeform.js) when it can, else say so.
      const made = composeFreeform(m[0].replace(/^.*?\b(?:a|an)\s+/, 'a ') + t.slice(m.index + m[0].length));
      if (made.ok) {
        Object.keys(s).forEach((k) => delete s[k]); Object.assign(s, made.spec);
        applied.push(`Changed to ${made.made}.${made.unused?.length ? ` I did not use: ${made.unused.join(', ')}.` : ''}`);
        return { spec: s, quality: qualityWord(t), applied, unsupported };
      }
      unsupported.push(made.detail);
    }
  }
  // Forms within the family.
  if (s.family === 'lamp' && /\bfloor lamp\b|\bstanding lamp\b/.test(t) && s.form !== 'floor') { s.form = 'floor'; applied.push('Made it a floor lamp.'); }
  else if (s.family === 'lamp' && /\b(?:desk|table|reading) lamp\b/.test(t) && s.form !== 'desk') { s.form = 'desk'; applied.push('Made it a desk lamp.'); }
  if (s.family === 'table') {
    const f = /\bcoffee table\b/.test(t) ? 'coffee' : /\bdining table\b|\bkitchen table\b/.test(t) ? 'dining' : /\bdesk\b/.test(t) ? 'desk' : null;
    if (f && f !== s.form) { s.form = f; applied.push(`Made it a ${f === 'desk' ? 'desk' : `${f} table`}.`); }
  }
  // Size.
  const sz = sizeChange(t);
  if (sz) {
    const want = sz.set ?? s.size * sz.mul; const next = r2(clamp(want, ...SIZE));
    if (next === s.size) unsupported.push(`It is already as ${want > s.size ? 'big' : 'small'} as CHE builds it (size ${s.size}; the range is ${SIZE[0]} to ${SIZE[1]} times the family's real size).`);
    else { applied.push(`Size ${next > s.size ? 'up' : 'down'} to ${next} times the real ${s.family} size (every dimension).`); s.size = next; }
  }
  // Colour (gold, silver, copper and brass are metals too).
  const c = colourWord(t);
  if (c && !(m && familyOf(m[1]))) {
    s.color = NAMES[c]; applied.push(`Colour changed to ${c}.`);
    if (METAL_COLOURS.has(c) && s.metallic < 1) { s.metallic = 1; s.roughness = Math.min(s.roughness, 0.3); applied.push(`Finish made metallic, like ${c}.`); }
  }
  // Finish.
  if (/\b(?:shin(?:y|ier)|gloss(?:y|ier)|polished|glossier|more reflective)\b/.test(t)) {
    const v = r2(clamp(s.roughness - 0.25, 0.05, 1));
    if (v === s.roughness) unsupported.push('It is already as glossy as the finish goes.'); else { s.roughness = v; applied.push(`Finish made glossier (roughness ${v}).`); }
  } else if (/\b(?:matte|matt|rougher|duller|satin|less shiny|less reflective)\b/.test(t)) {
    const v = r2(clamp(s.roughness + 0.25, 0, 1));
    if (v === s.roughness) unsupported.push('It is already fully matte.'); else { s.roughness = v; applied.push(`Finish made more matte (roughness ${v}).`); }
  }
  if (/\b(?:not metal(?:lic)?|non[- ]?metal(?:lic)?|wood(?:en)?|plastic|ceramic|painted)\b/.test(t)) {
    if (s.metallic) { s.metallic = 0; applied.push('Made non-metallic.'); }
  } else if (/\b(?:metal(?:lic)?|chrome|steel|aluminium|aluminum)\b/.test(t) && s.metallic < 1) {
    s.metallic = 1; s.roughness = Math.min(s.roughness, 0.35); applied.push('Made metallic.');
  }
  // Style.
  const st = styleWord(t);
  if (st && st !== s.style && s.family === 'custom') unsupported.push(`A described object has no ${st} style; its shapes stay as composed. Describe it again to change its shape.`);
  else if (st && st !== s.style) { s.style = st; applied.push(`Style changed to ${st}: the ${s.family}'s shape and fixed parts change with it.`); }
  const quality = qualityWord(t);
  if (quality) applied.push(`Detail set. ${resourceLine({ quality })}`);
  if (!applied.length && !unsupported.length && s.family === 'custom') {
    unsupported.push('I can\'t change that on this object yet. Try: make it red, bigger, smaller, shinier, matte, metallic, or make it a snowman, a rocket, or a red ball on top of a blue box.');
  } else if (!applied.length && !unsupported.length) {
    unsupported.push(`I can't change that on a ${s.family} yet. Try: make it red, bigger, smaller, shinier, matte, metallic, modern, classic, industrial, or make it a ${FAMILIES.find((f) => f !== s.family)}.`);
  }
  return { spec: s, quality, applied, unsupported };
}

const ITEM_WORDS = [['sofa', /^(?:sofa|couch|settee)$/], ['bed', /^(?:bed|double bed)$/], ['desk', /^(?:desk|work desk|writing desk)$/],
  ['table', /^(?:table|coffee table|dining table|work table|worktable)$/], ['chair', /^(?:chair|desk chair|seat)$/],
  ['lamp', /^(?:lamp|floor lamp|desk lamp|light)$/], ['shelf', /^(?:shelf|shelves|bookshelf|bookcase)$/], ['vase', /^(?:vase|flower vase)$/],
  ['mug', /^(?:mug|cup|coffee mug)$/], ['plant', /^(?:plant|plants|houseplant|pot plant)$/], ['rug', /^(?:rug|carpet rug|mat)$/]];
const itemOf = (w) => ITEM_WORDS.find(([, re]) => re.test(w))?.[0] || null;
const itemIn = (phrase) => itemOf(phrase) || itemOf(phrase.split(' ')[0]) || itemOf(phrase.split(' ').slice(-1)[0]);
const metres = '(\\d+(?:\\.\\d+)?) ?(?:m\\b|metres?|meters?)';

/** One sentence against a room spec: { spec, quality, applied, unsupported }. */
export function parseRoomEdit(text, spec) {
  const t = normal(text); const s = structuredClone(spec); const applied = []; const unsupported = [];
  let m;
  // Room type.
  if ((m = /\b(?:make it|turn it into|change it (?:in)?to|change the room (?:in)?to|make this)\s+(?:a|an)?\s*(living room|lounge|sitting room|bedroom|office|study|studio|workshop)\b/.exec(t))) {
    const type = { 'living room': 'living_room', lounge: 'living_room', 'sitting room': 'living_room', bedroom: 'bedroom', office: 'office', study: 'office', studio: 'studio', workshop: 'studio' }[m[1]];
    if (type !== s.type) {
      s.type = type; s.furniture = [...ROOM_DEFAULTS[type].furniture];
      applied.push(`Changed to ${/^[aeiou]/.test(ROOM_LABELS[type]) ? 'an' : 'a'} ${ROOM_LABELS[type]} with its usual furniture (${s.furniture.join(', ')}); the size, walls, floor and light stay.`);
    }
  } else if ((m = /\b(?:make it|turn it into)\s+(?:a|an)\s+([a-z]+(?: [a-z]+)?)/.exec(t)) && !NOT_A_THING.test(m[1]) && !colourWord(m[1]) && !styleWord(m[1])
    && !/\b(?:room|light|lighting|floor)\b/.test(m[1])) {
    unsupported.push(`CHE builds only these rooms: ${ROOM_TYPES.map((x) => ROOM_LABELS[x]).join(', ')}. A ${m[1]} is not one of them.`);
  }
  // Size in metres.
  const dim = (key, word, v) => {
    const [lo, hi] = ROOM_LIMITS[key]; const next = r2(clamp(v, lo, hi));
    if (next === s[key]) unsupported.push(`The ${word} is already ${s[key]} metres, the ${v > s[key] ? 'most' : 'least'} CHE builds (${lo} to ${hi}).`);
    else { applied.push(`${word[0].toUpperCase()}${word.slice(1)} set to ${next} metres${next !== r2(v) ? `, the ${v > next ? 'most' : 'least'} CHE builds` : ''}.`); s[key] = next; }
  };
  if ((m = new RegExp(`${metres} wide|width (?:of |to )?${metres}`).exec(t))) dim('width', 'width', Number(m[1] || m[2]));
  if ((m = new RegExp(`${metres} (?:deep|long)|depth (?:of |to )?${metres}|length (?:of |to )?${metres}`).exec(t))) dim('depth', 'depth', Number(m[1] || m[2] || m[3]));
  if ((m = new RegExp(`${metres} (?:high|tall|ceiling)|(?:ceiling|height) (?:of |to )?${metres}`).exec(t))) dim('height', 'ceiling height', Number(m[1] || m[2]));
  if ((m = new RegExp(`${metres} by ${metres}`).exec(t))) { dim('width', 'width', Number(m[1])); dim('depth', 'depth', Number(m[2])); }
  if (/\b(?:higher|taller|raise the) ceiling\b|\bceiling (?:higher|taller)\b/.test(t)) dim('height', 'ceiling height', s.height + 0.3);
  else if (/\blower (?:the )?ceiling\b|\bceiling lower\b/.test(t)) dim('height', 'ceiling height', s.height - 0.3);
  else if (!/\bmetres?|meters?|\d ?m\b/.test(t)) {
    if (/\b(?:much|a lot) (?:bigger|larger)\b/.test(t)) { dim('width', 'width', s.width * 1.4); dim('depth', 'depth', s.depth * 1.4); }
    else if (/\b(?:bigger|larger|more spacious|more space)\b/.test(t) && !itemIn(t.replace(/.*\b(?:bigger|larger)\s+/, ''))) { dim('width', 'width', s.width * 1.2); dim('depth', 'depth', s.depth * 1.2); }
    else if (/\b(?:smaller|cosier|cozier|more compact)\b/.test(t)) { dim('width', 'width', s.width / 1.2); dim('depth', 'depth', s.depth / 1.2); }
    if (/\bwider\b/.test(t)) dim('width', 'width', s.width + 0.5); else if (/\bnarrower\b/.test(t)) dim('width', 'width', s.width - 0.5);
    if (/\b(?:deeper|longer)\b/.test(t)) dim('depth', 'depth', s.depth + 0.5); else if (/\bshallower\b/.test(t)) dim('depth', 'depth', s.depth - 0.5);
  }
  // Furniture: add and remove, one piece or a list ("add a desk and a lamp", "remove the rug, the vase").
  const pieces = (list) => list.split(/,|\band\b/).map((x) => x.trim().replace(/^(?:a|an|the|some|another|one more)\s+/, '').trim()).filter(Boolean);
  const add = /\b(?:add|put in|bring in|include)\s+(.+?)(?=$|\s(?:to|in|into|on|by|next to|near)\s)/.exec(t);
  for (const w of add ? pieces(add[1]) : []) {
    const item = itemIn(w);
    if (!item) { if (!/^(?:more|light|lighting|warmth|some)\b/.test(w)) unsupported.push(`Rooms take only: ${ROOM_ITEMS.join(', ')}. A ${w} is not built yet.`); continue; }
    if (s.furniture.includes(item)) unsupported.push(`The room already has a ${item}; each piece is built once.`);
    else if (s.furniture.length >= MAX_ITEMS) unsupported.push(`The room already has ${MAX_ITEMS} pieces, the most CHE places. Remove one first.`);
    else { s.furniture.push(item); applied.push(`Added a ${item}. If it does not fit beside the rest, the build leaves it out and says so.`); }
  }
  const del = /\b(?:remove|take out|take away|get rid of|lose)\s+(.+?)(?=$|\s(?:from|in)\s)/.exec(t);
  for (const w of del ? pieces(del[1]) : []) {
    const item = itemIn(w);
    if (!item) { unsupported.push(`There is no ${w} in the room to remove.`); continue; }
    if (!s.furniture.includes(item)) unsupported.push(`There is no ${item} in the room.`);
    else { s.furniture = s.furniture.filter((x) => x !== item); applied.push(`Removed the ${item} from this version; undo brings it back.`); }
  }
  // Floor.
  const fm = /\b(oak|walnut|wood(?:en)?|tile[sd]?|tiling|concrete|carpet(?:ed)?)\b/.exec(t);
  if (fm && (/\bfloor/.test(t) || /^carpet/.test(fm[1]) || /\b(?:make|change|use)\b/.test(t)) && !(/^carpet/.test(fm[1]) && /\brug\b/.test(t))) {
    const f = /^wood/.test(fm[1]) ? 'oak' : /^til/.test(fm[1]) ? 'tile' : /^carpet/.test(fm[1]) ? 'carpet' : fm[1];
    if (f !== s.floor) { s.floor = f; applied.push(`Floor changed to ${f}.`); }
  }
  // Walls: a colour with "wall" or "paint", or a bare colour ("make it blue"); furniture colours are not parameters.
  const c = colourWord(t);
  if (c) {
    const piece = t.split(/[^a-z]+/).map(itemOf).find((x) => x && x !== 'lamp');
    if (/\bwalls?\b|\bpaint\b/.test(t) || (!piece && !/\bfloor\b/.test(t))) { s.wall_color = NAMES[c]; applied.push(`Walls painted ${c}.`); }
    else if (piece) unsupported.push(`Only the wall colour is a room setting; the ${piece} keeps its style's colours. ${FAMILIES.includes(piece) || piece === 'desk' ? `Create Object builds a ${piece === 'desk' ? 'desk' : piece} in any colour.` : 'Sofas, beds, rugs and plants are room pieces in their style\'s colours.'}`);
    else unsupported.push('The floor colour comes from its material: say oak, walnut, tile, concrete or carpet floor.');
  }
  // Light.
  const order = ['cool', 'neutral', 'warm'];
  let light = null;
  if (/\bwarm(?:er)?\b.*\b(?:light|lighting|lights|glow)\b|\b(?:light|lighting)\b.*\bwarm(?:er)?\b|\bcosier light|\bcozier light|\bwarmer\b/.test(t)) light = /\bwarmer\b/.test(t) ? order[Math.min(2, order.indexOf(s.lighting) + 1)] : 'warm';
  else if (/\b(?:cool(?:er)?|cold(?:er)?|daylight|bluer)\b.*\b(?:light|lighting|lights)\b|\b(?:light|lighting)\b.*\b(?:cool(?:er)?|daylight)\b|\bcooler\b/.test(t)) light = /\bcooler\b|\bcolder\b/.test(t) ? order[Math.max(0, order.indexOf(s.lighting) - 1)] : 'cool';
  else if (/\b(?:neutral|white) (?:light|lighting)\b/.test(t)) light = 'neutral';
  if (light) {
    if (light === s.lighting) unsupported.push(`The light is already ${light}${light === 'warm' && /warmer/.test(t) ? ', the warmest setting' : light === 'cool' && /cooler|colder/.test(t) ? ', the coolest setting' : ''}.`);
    else { s.lighting = light; applied.push(`Light changed to ${light}.`); }
  }
  const st = styleWord(t);
  if (st && st !== s.style) { s.style = st; applied.push(`Style changed to ${st}: the furniture, frames and skirting change with it.`); }
  const quality = qualityWord(t);
  if (quality) applied.push(`Detail set. ${resourceLine({ quality })}`);
  if (!applied.length && !unsupported.length) {
    unsupported.push(`I can't change that in the room yet. Try: add a desk, remove the rug, make it bigger, 5 metres wide, higher ceiling, paint the walls green, tile floor, warmer light, or make it a bedroom.`);
  }
  return { spec: s, quality, applied, unsupported };
}

/** One plain sentence of what a spec builds (the studio's Read aloud and the project title). */
export function describeSpec(kind, s) {
  if (kind === 'object' && s.family === 'custom') {
    const shapes = [...new Set((s.parts || []).map((p) => p.shape))];
    return `${s.description} (composed of ${(s.parts || []).length} parts: ${shapes.join(', ')}), main colour ${colourName(s.color)}, ${s.metallic >= 0.5 ? 'metallic' : 'non-metallic'} with roughness ${s.roughness}, at ${s.size} times its composed size`;
  }
  if (kind === 'object') {
    const form = s.form && s.family === 'table' ? `${s.form === 'desk' ? '' : `${s.form} `}` : s.form === 'floor' ? 'floor ' : '';
    const noun = s.family === 'table' && s.form === 'desk' ? 'desk' : `${form}${s.family}`;
    return `a ${s.style} ${noun}, ${colourName(s.color)}, ${s.metallic >= 0.5 ? 'metallic' : 'non-metallic'} with roughness ${s.roughness}, at ${s.size} times real size`;
  }
  return `a ${s.style} ${ROOM_LABELS[s.type]}, ${s.width} by ${s.depth} metres with a ${s.height} metre ceiling, ${colourName(s.wall_color)} walls, ${s.floor} floor, ${s.lighting} light, furniture: ${s.furniture.join(', ') || 'none'}`;
}

/** Title for a new project. */
export function titleOf(kind, s) {
  if (kind === 'object' && s.family === 'custom') {
    const d = String(s.description || 'Object').replace(/^(?:please\s+)?(?:create|make|build)(?: me)?\s+/i, '').replace(/^(?:an?|the)\s+/i, '').trim().slice(0, 50) || 'Object';
    return `${d[0].toUpperCase()}${d.slice(1)} (new object)`;
  }
  if (kind === 'object') return `${s.family === 'table' && s.form === 'desk' ? 'Desk' : `${s.family[0].toUpperCase()}${s.family.slice(1)}`} (new object)`;
  const l = ROOM_LABELS[s.type]; return `${l[0].toUpperCase()}${l.slice(1)} (new room)`;
}

/** "Model verified: 71 meshes, 6,712 triangles, 20 materials, 4.10 x 2.71 x 3.70 m". */
export function verifyLine(v) {
  const size = (v?.bbox_m?.size || []).map((x) => Number(x).toFixed(2)).join(' x ');
  return `${v.meshes} mesh${v.meshes === 1 ? '' : 'es'}, ${Number(v.triangles || 0).toLocaleString('en-US')} triangles, ${(v.materials || []).length} material${(v.materials || []).length === 1 ? '' : 's'}${size ? `, ${size} m` : ''}`;
}

/** A described object (Create Object, free text): { ok, spec, made, unused } or { ok: false, detail }. */
export function describedObject(text) { return composeFreeform(text); }
export { RECIPE_NAMES };
