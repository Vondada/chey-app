// Live Creation Studio (owner, 2026-10-24): Create Person -> generate the model -> watch real progress -> inspect it in
// 3D -> edit by voice or typing -> save. A creation project is a list of versions of one identity preset (the same
// parameters avatar_identity.js maps for tools/avatar_face/mpfb_dress.py), with a pointer for undo and redo. Generating
// queues a `person_model` job on the existing GPU queue (gpu_queue.js): the owner's Colab T4 worker builds the head
// in Blender, uploads the GLB the moment it is exported, then each preview picture as it renders. Nothing here renders,
// simulates progress or claims a result: stages come only from the job's own timestamped history, and a model or picture
// is shown only once the worker has really uploaded it.
//
// Edits are deterministic (no model call): a small vocabulary of plain sentences ("make the hair longer", "bigger
// eyes", "make it photorealistic"). Each change becomes a new version, validated with the same rules the renderer uses;
// a change the renderer would refuse is refused here. View commands ("rotate the model") only move the 3D viewport.
//
// Body & Movement (owner, 2026-10-24): every version also carries render settings beside the identity: MODEL_MODE
// (full_body, the default: head to feet, clothed, rigged and animated; or bust), QUALITY (draft, standard, high, ultra,
// custom) and LIGHTING (studio or cinematic). They go to the Creation Engine as extra job settings, so the identity
// mapping (avatar_identity.js / identity.py) is untouched. Movement words ("show the skeleton", "animate walking",
// "pause", "skip ahead 10 seconds") drive the viewport only. A full-body job completes only when the runner re-imported
// the exported GLB and verified its skeleton, clips and face shapes (gpu_queue.js), so CHE never says a model moves
// until it was measured moving.
import { ASSUMPTIONS, PROFILES, estimateVideo, scenarios } from './capacity_model.js';
import { r2Status } from './object_storage.js';
import { BUILT_IN, HAIR_BUILT, STYLES, STYLE_LABELS, listIdentities, skinOk, toSettings, validate } from './avatar_identity.js';
import { GpuQueue, VIEW_NAMES, engineRecord, engineSettingsOf, gpuOwnerRoute, rigLine } from './gpu_queue.js';
import { cloudUsable, engineRoute, ensureCapacity } from './creation_orchestrator.js';
import * as OBJ from './creation_objects.js';

export const PROJECTS_KEY = 'creations:projects';
export const MAX_PROJECTS = 100;
export const MAX_VERSIONS = 60;
export const NOTEBOOK_URL = 'https://colab.research.google.com/github/Vondada/chey-app/blob/main/notebooks/CHE_GPU_Face_Preview.ipynb';
export const VIEWS = [0, 45, 90];

export const CAPABILITIES = [
  { id: 'person', title: 'Create Person', status: 'available',
    detail: 'Start from CHE or a crew preset, edit by voice or typing, and build a clothed full-body 3D character on your Creation Engine: skeleton, face shapes, idle, walk, wave and talk clips, each verified before it is shown as working.' },
  { id: 'object', title: 'Create Object', status: 'available', choices: OBJ.FAMILIES,
    detail: `Choose a lamp, chair, table, desk, mug, vase or shelf, then change its size, colour, finish and style by voice or typing; your Creation Engine builds it in Blender, measures the file and renders previews. ${OBJ.CAPABILITY_NOTE[0].toUpperCase()}${OBJ.CAPABILITY_NOTE.slice(1)}.` },
  { id: 'room', title: 'Create Room', status: 'available', choices: OBJ.ROOM_TYPES,
    detail: `Choose a living room, bedroom, office or studio, then change its size in metres, walls, floor, furniture and light by voice or typing; your Creation Engine builds it in Blender, measures it and renders previews. ${OBJ.CAPABILITY_NOTE[0].toUpperCase()}${OBJ.CAPABILITY_NOTE.slice(1)}.` },
  { id: 'animation', title: 'Create Animation', status: 'partial',
    detail: 'Play, pause, slow down and skip through clips with the skeleton showing: the bundled crew models now, and each generated character once its rig is verified. Motion capture from video and new animation renders are not built yet.' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── Render settings ──────────────────────────────────────────────────────────────────────────────────────────────
export const MODEL_MODES = { full_body: 'full body', bust: 'head and shoulders' };
export const LIGHTINGS = { studio: 'studio', cinematic: 'cinematic' };
// Detail presets. The times are rough estimates (a Colab T4, and the free 4-core GitHub cloud CPU, whose target for
// Draft and Standard is the whole job in under 25 minutes), not measurements: the job receipt has the real time.
export const QUALITY = {
  draft: { label: 'Draft', samples: 16, res: 360, subdiv: 0, strands: 40, texture_px: 512, estimate: 'about 1 to 3 minutes', cpu_estimate: 'about 10 to 20 minutes' },
  standard: { label: 'Standard', samples: 64, res: 480, subdiv: 1, strands: 90, texture_px: 1024, estimate: 'about 3 to 6 minutes', cpu_estimate: 'about 15 to 25 minutes' },
  high: { label: 'High Detail', samples: 128, res: 720, subdiv: 1, strands: 140, texture_px: 2048, estimate: 'about 6 to 12 minutes', cpu_estimate: 'more than 30 minutes' },
  ultra: { label: 'Ultra Detail', samples: 256, res: 1080, subdiv: 2, strands: 200, texture_px: 4096, estimate: 'about 15 to 30 minutes', cpu_estimate: 'more than an hour' },
};
const CUSTOM_LIMITS = { samples: [4, 1024], res: [240, 2048], subdiv: [0, 2], strands: [20, 300], texture_px: [256, 4096] };
export const DEFAULT_RENDER = { mode: 'full_body', quality: 'standard', lighting: 'studio' };

/** A version's render settings, with the defaults for versions made before they existed. */
export function renderOf(v) {
  const r = { ...DEFAULT_RENDER, ...(v?.render || {}) };
  if (!MODEL_MODES[r.mode]) r.mode = DEFAULT_RENDER.mode;
  if (!QUALITY[r.quality] && r.quality !== 'custom') r.quality = DEFAULT_RENDER.quality;
  if (!LIGHTINGS[r.lighting]) r.lighting = DEFAULT_RENDER.lighting;
  if (r.quality !== 'custom') delete r.custom;
  return r;
}

/** The numbers a quality setting stands for (custom: the owner's numbers, kept inside safe limits). */
export function qualityOf(r) {
  if (r.quality !== 'custom') return { ...QUALITY[r.quality], id: r.quality };
  const c = r.custom || {}; const base = QUALITY.standard; const out = { id: 'custom', label: 'Custom' };
  for (const [k, [lo, hi]] of Object.entries(CUSTOM_LIMITS)) out[k] = Math.round(clamp(Number(c[k] ?? base[k]) || base[k], lo, hi));
  const heavy = out.samples * (out.res / 480) ** 2 > 400;
  out.estimate = heavy ? 'more than 15 minutes' : 'a few minutes'; out.cpu_estimate = heavy ? 'more than an hour' : 'about 15 to 30 minutes';
  return out;
}

/** One sentence on what a render will take, said as an estimate. */
export function resourceLine(r) {
  const q = qualityOf(r);
  return `${q.label} detail: ${q.samples} samples, ${q.res} pixels on the long edge, subdivision ${q.subdiv}, ${q.texture_px} pixel textures. `
    + `Rough estimate on a Colab T4: ${q.estimate}; on the free cloud CPU: ${q.cpu_estimate} (estimates, not measured yet; the job receipt records the real time).`;
}

/** The extra job settings the Creation Engine reads beside the identity (strings, as cleanSettings keeps them). */
export function renderSettings(r) {
  const q = qualityOf(r);
  return { MODEL_MODE: r.mode, QUALITY: q.id, LIGHTING: r.lighting, SUBDIV: String(q.subdiv), TEXTURE_PX: String(q.texture_px), STRANDS: String(q.strands) };
}

const iso = (ms) => new Date(ms).toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const clone = (x) => JSON.parse(JSON.stringify(x));
const round3 = (v) => Math.round(v * 1000) / 1000;

// ── Edit vocabulary ──────────────────────────────────────────────────────────────────────────────────────────────
const HAIR_LADDER = ['close_crop', 'curly_short', 'wavy_medium', 'long_wavy'];
const HAIR_WORDS = { close_crop: 'close-cropped', curly_short: 'short curly', wavy_medium: 'shoulder-length wavy', long_wavy: 'long wavy',
  bun_high: 'high bun', bun_low: 'low bun', afro: 'afro', beanie: 'under a beanie' };
const COLOURS = {
  black: '#16110e', 'jet black': '#0e0b0a', 'dark brown': '#2a1a12', brown: '#4a2c1c', 'light brown': '#7a5236', chestnut: '#5a2e1a',
  auburn: '#6a2e1a', red: '#8a2a16', ginger: '#b0521e', blonde: '#d8b46a', blond: '#d8b46a', 'platinum blonde': '#e6d6b0', grey: '#8a8580',
  gray: '#8a8580', silver: '#b8b8b8', white: '#e8e6e0', purple: '#8d64d6', violet: '#8d64d6', pink: '#d67ea8', blue: '#3a6ec8',
  green: '#3c7a4a', teal: '#1f6f78', navy: '#1d2b4a', orange: '#e8732e', yellow: '#d8b030', gold: '#c8a040', beige: '#d8c4a0', cream: '#e9dcc8',
};
const EYE_COLOURS = { brown: '#5a3a22', 'dark brown': '#3e2616', 'light brown': '#7a5232', hazel: '#7a6a3a', amber: '#a8742a', green: '#4f7a4a',
  blue: '#4f7fb5', 'light blue': '#7aa6d6', grey: '#6f7a80', gray: '#6f7a80', black: '#241812' };
const OUTFIT_PALETTE = ['#1f6f78', '#1d2b4a', '#4a525c', '#e8732e', '#d89a2a', '#56603e', '#b79be6', '#e9dcc8', '#3e5f86', '#7a2a2a'];
const colourName = (hex) => Object.entries(COLOURS).find(([, h]) => h === hex)?.[0] || hex;
// Longest names first, so "dark brown" wins over "brown".
const colourIn = (t, table) => Object.keys(table).sort((a, b) => b.length - a.length).find((w) => new RegExp(`\\b${w}\\b`).test(t));

/** A tone moved toward darker (f < 1) or lighter (f > 1) in linear light, kept a human skin albedo. */
function shiftTone(hex, f) {
  const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const enc = (x) => { const v = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055; return clamp(Math.round(v * 255), 0, 255); };
  const out = '#' + [1, 3, 5].map((i) => enc(clamp(lin(parseInt(hex.slice(i, i + 2), 16)) * f, 0, 1)).toString(16).padStart(2, '0')).join('');
  return skinOk(out) ? out : null;
}

const SLIDER_EDITS = [
  [/\b(?:bigger|larger|wider) eyes\b|\beyes? (?:bigger|larger)\b/, 'eye_size', 0.2, 'eyes larger'],
  [/\bsmaller eyes\b|\beyes? smaller\b/, 'eye_size', -0.2, 'eyes smaller'],
  [/\b(?:wider|broader) nose\b|\bnose (?:wider|broader)\b/, 'nose_width', 0.2, 'nose wider'],
  [/\b(?:narrower|thinner|slimmer|smaller) nose\b|\bnose (?:narrower|thinner|smaller)\b/, 'nose_width', -0.2, 'nose narrower'],
  [/\blonger nose\b/, 'nose_length', 0.2, 'nose longer'],
  [/\bshorter nose\b/, 'nose_length', -0.2, 'nose shorter'],
  [/\b(?:fuller|bigger|plumper|thicker) lips\b|\blips (?:fuller|bigger)\b/, ['lip_upper', 'lip_lower'], 0.2, 'lips fuller'],
  [/\b(?:thinner|smaller) lips\b|\blips (?:thinner|smaller)\b/, ['lip_upper', 'lip_lower'], -0.2, 'lips thinner'],
  [/\bwider (?:mouth|smile)\b/, 'mouth_width', 0.2, 'mouth wider'],
  [/\bnarrower mouth\b|\bsmaller mouth\b/, 'mouth_width', -0.2, 'mouth narrower'],
  [/\brounder face\b|\bface rounder\b|\bround(?:er)? cheeks\b/, 'face_round', 0.2, 'face rounder'],
  [/\b(?:more )?oval face\b/, 'face_oval', 0.2, 'face more oval'],
  [/\bwider face\b|\bface wider\b/, 'face_width', 0.15, 'face wider'],
  [/\b(?:narrower|thinner|slimmer) face\b|\bface (?:narrower|thinner|slimmer)\b/, 'face_width', -0.15, 'face narrower'],
  [/\bhigher cheekbones\b|\b(?:stronger|sharper) cheekbones\b/, 'cheekbones', 0.2, 'cheekbones higher'],
  [/\bfuller cheeks\b/, 'cheek_volume', 0.2, 'cheeks fuller'],
  [/\b(?:stronger|wider) (?:chin|jaw)\b/, 'chin_width', 0.2, 'chin wider'],
  [/\b(?:smaller|narrower|softer) (?:chin|jaw)\b/, 'chin_width', -0.2, 'chin narrower'],
  [/\bhigher (?:brows|eyebrows)\b|\braise (?:the )?(?:brows|eyebrows)\b/, 'brow_height', 0.2, 'brows higher'],
  [/\blower (?:brows|eyebrows)\b/, 'brow_height', -0.2, 'brows lower'],
];

const CLIP_WORDS = [['walk', /\bwalk(?:s|ing)?\b/], ['run', /\brun(?:s|ning)?\b|\bjog(?:s|ging)?\b/], ['wave', /\bwav(?:e|es|ing)\b/],
  ['talk', /\btalk(?:s|ing)?\b|\bspeak(?:s|ing)?\b/], ['idle', /\bidle\b|\bstand(?:s|ing)? still\b|\bbreath(?:e|es|ing)\b/],
  ['dance', /\bdanc(?:e|es|ing)\b/], ['sit', /\bsit(?:s|ting)?\b/]];
const CLIPS_NOTE = 'Generated characters carry idle, walk, wave and talk once their skeleton is verified; the bundled crew models also sit, think, nod and celebrate.';

/** Viewport-only words (skeleton, clips, timeline, camera): { viewport, sentence } or null. Never a new version. */
export function viewportIntent(t) {
  let m;
  const say = (viewport, sentence) => ({ viewport, sentence });
  if (/\b(?:skeleton|bones|joints|rig)\b/.test(t) && !/\b(?:add|build|generate|make|create)\b/.test(t)) {
    const off = /\b(?:hide|off|remove|without)\b/.test(t);
    return say({ action: 'skeleton', on: !off }, off ? 'Skeleton hidden.' : 'Showing the skeleton: the joints the model really has, moving with it.');
  }
  if ((m = /\b(?:skip|jump|go|fast[- ]?forward|rewind)\b(?: (ahead|forward|back(?:wards?)?))?(?: (?:by )?(\d{1,3}) ?sec(?:ond)?s?)?/.exec(t))
    && /\b(?:skip|jump|rewind|fast[- ]?forward|sec(?:ond)?s?)\b/.test(t)) {
    const back = /\bback|\brewind/.test(t); const n = m[2] ? Number(m[2]) : 10;
    return say({ action: 'seek', delta: back ? -n : n }, `Skipping ${back ? 'back' : 'ahead'} ${n} seconds.`);
  }
  if (/^(?:pause|stop|freeze)(?: (?:it|the animation|the clip|playback|the playback))?$/.test(t)) return say({ action: 'pause' }, 'Paused.');
  if (/^(?:play|resume|continue|unpause)(?: (?:it|the animation|the clip|playback))?$/.test(t)) return say({ action: 'play' }, 'Playing.');
  if (/^(?:replay|restart|play (?:it |that )?again|start (?:it )?over)\b/.test(t)) return say({ action: 'replay' }, 'Playing again from the start.');
  if ((m = /\b(half|quarter|normal|regular|full|double) speed\b|\b(\d(?:\.\d+)?) ?(?:x|times)(?: speed)?\b/.exec(t)) && /\bspeed\b|\d ?x\b|\btimes\b/.test(t)) {
    const rate = m[2] ? clamp(Number(m[2]), 0.25, 2) : { half: 0.5, quarter: 0.25, normal: 1, regular: 1, full: 1, double: 2 }[m[1]];
    return say({ action: 'speed', rate }, `Playback speed ${rate} times.`);
  }
  if (/\b(?:faster|speed (?:it )?up)\b/.test(t)) return say({ action: 'speed', mul: 1.5 }, 'Playing faster.');
  if (/\b(?:slower|slow (?:it )?down|slow motion)\b/.test(t)) return say({ action: 'speed', mul: 0.67 }, 'Playing slower.');
  const clip = CLIP_WORDS.find(([, re]) => re.test(t))?.[0] || null;
  if (/\banimate\b|\bmake (?:it|her|him|the (?:character|model|person)) (?:move|\w+)\b|^play (?:the )?\w+(?: animation| clip)?$|\bstart (?:walking|running|waving|talking|dancing)\b/.test(t)
    && (clip || /\banimate\b|\bmove\b/.test(t))) {
    return say(clip ? { action: 'animate', clip } : { action: 'animate' },
      `${clip ? `Playing the ${clip} clip` : 'Playing an animation'} if the model in the viewport has ${clip ? 'it' : 'clips'}. ${CLIPS_NOTE}`);
  }
  if ((m = /\b(?:rotate|turn|spin)\b(?: (?:the )?(?:model|character|head|it|her|him))?(?: (left|right))?(?: (?:by )?(-?\d{1,3}) ?(?:degrees?|°))?/.exec(t))) {
    const deg = m[2] ? Number(m[2]) : 45; const v = { action: 'rotate', deg: m[1] === 'left' ? -Math.abs(deg) : deg };
    return say(v, `Rotating the view ${Math.abs(v.deg)} degrees ${v.deg < 0 ? 'left' : 'right'}.`);
  }
  if (/\bzoom in\b|\bcloser\b/.test(t)) return say({ action: 'zoom', factor: 0.8 }, 'Zooming in.');
  if (/\bzoom out\b|\bfurther\b|\bfarther\b/.test(t)) return say({ action: 'zoom', factor: 1.25 }, 'Zooming out.');
  if (/\breset (?:the )?(?:view|camera)\b/.test(t)) return say({ action: 'reset' }, 'View reset.');
  if ((m = /\b(front|side|profile|three[- ]quarters?|back) view\b|\bshow (?:me )?the (front|side|back)\b/.exec(t))) {
    const w = m[1] || m[2]; const deg = /front/.test(w) ? 0 : /three/.test(w) ? 45 : /back/.test(w) ? 180 : 90;
    return say({ action: 'view', deg }, `Showing the ${w.replace('-', ' ')} view.`);
  }
  return null;
}

/** Render-setting words (full body or bust, detail, lighting): the new render settings and their plain sentences. */
function renderIntent(t, render, applied, unsupported) {
  const r = { ...render }; let m;
  if (/\bfull[- ]?body\b|\bwhole body\b|\bhead to (?:toe|feet)\b/.test(t)) r.mode = 'full_body';
  else if (/\bbust\b|\bhead and shoulders\b|\b(?:head|face) only\b|\bjust the (?:head|face)\b|\bonly the (?:head|face)\b/.test(t)) r.mode = 'bust';
  if (r.mode !== render.mode) applied.push(`Model changed to ${MODEL_MODES[r.mode]}${r.mode === 'full_body' ? ', with a skeleton and clips' : ''}.`);
  const lowPoly = /\blow[- ]?poly\b/.test(t);
  let q = null;
  if (lowPoly || /\bdraft\b|\bquick preview\b|\blow detail\b/.test(t)) q = 'draft';
  else if (/\bultra\b|\bmax(?:imum)? detail\b/.test(t)) q = 'ultra';
  else if (/\bhigh(?:er)? (?:detail|quality)\b|\bhighly detailed\b|\bmore detail(?:ed)?\b|\bvery detailed\b/.test(t)) q = 'high';
  else if (/\bstandard (?:detail|quality)\b|\bnormal (?:detail|quality)\b/.test(t)) q = 'standard';
  else if (/\bcustom\b/.test(t)) {
    const custom = {};
    if ((m = /(\d{1,4}) samples\b/.exec(t))) custom.samples = Number(m[1]);
    if ((m = /(\d{3,4}) ?(?:p\b|pixels?\b|resolution\b)|resolution (?:of )?(\d{3,4})/.exec(t))) custom.res = Number(m[1] || m[2]);
    if ((m = /subdivi(?:sion|de)s? (?:level )?(\d)/.exec(t))) custom.subdiv = Number(m[1]);
    if ((m = /(\d{2,3}) (?:hair )?strands\b/.exec(t))) custom.strands = Number(m[1]);
    if ((m = /(\d{3,4}) ?(?:pixel |px )?textures?\b/.exec(t))) custom.texture_px = Number(m[1]);
    if (Object.keys(custom).length) { r.quality = 'custom'; r.custom = { ...(render.custom || {}), ...custom }; }
    else unsupported.push('Custom detail needs numbers, for example: custom, 200 samples, 1080 resolution, subdivision 2.');
  }
  if (q) { r.quality = q; delete r.custom; }
  if (r.quality !== render.quality || JSON.stringify(r.custom || null) !== JSON.stringify(render.custom || null)) applied.push(`Detail set. ${resourceLine(r)}`);
  if (lowPoly) unsupported.push('A faceted low-poly look is not built in the Blender pipeline yet, so this uses Draft detail, the fewest polygons, with smooth shading.');
  if (/\bcinematic\b/.test(t)) r.lighting = 'cinematic';
  else if (/\b(?:studio|neutral|even) (?:light|lighting)\b/.test(t)) r.lighting = 'studio';
  if (r.lighting !== render.lighting) applied.push(`Lighting changed to ${r.lighting}${r.lighting === 'cinematic' ? ': a stronger key, deeper shadows and a rim light' : ': soft, even light'}.`);
  return r;
}

/**
 * One sentence of owner words against a preset, look and render settings. Returns
 * { params, style, render, applied, unsupported, viewport, critique }: params, style and render are edited copies
 * (unchanged when nothing applied), applied and unsupported are plain sentences, critique says one was asked for.
 */
export function parseEdit(text, params, style, render = DEFAULT_RENDER) {
  const t = String(text || '').toLowerCase().replace(/[.!?]+$/g, '').replace(/^(?:che|chey|chay)[,:]?\s+/, '').trim();
  const p = clone(params); let s = style;
  const applied = []; const unsupported = []; let viewport = null;
  p.face = p.face || {}; p.hair = p.hair || {}; p.outfit = p.outfit || {}; p.eyes = p.eyes || {}; p.skin = p.skin || {}; p.body = p.body || {};
  const critique = /\bcritique\b|\breview (?:the |this |my )?(?:design|character|model)\b|\bwhat (?:could|should|can) (?:be )?(?:better|improved)\b|\bhow (?:can|could) (?:it|this|she|he) (?:look )?better\b/.test(t);

  // View and movement commands: the viewport only, never a new version.
  const vi = viewportIntent(t);
  if (vi) { viewport = vi.viewport; applied.push(vi.sentence); }
  const r = renderIntent(t, renderOf({ render }), applied, unsupported);
  if (/\b(?:put|place|add|move) (?:this|it|her|him|the (?:model|character|person))?\s*(?:in|into|to) (?:my |the )?office\b/.test(t)) {
    unsupported.push('Placing creations in the Office is not built yet; the project is saved here in the studio.');
  }

  // Look.
  if (/\bphoto ?-?realistic\b|\bphotoreal\b|\brealistic\b|\breal(?:-| )life\b/.test(t) && !/\bhybrid\b/.test(t)) s = 'photoreal';
  else if (/\bhybrid\b|\bgame (?:character|look)\b/.test(t)) s = 'hybrid';
  else if (/\bstyli[sz]ed\b|\bcartoon\b|\banimated look\b|\banime\b|\bpixar\b/.test(t)) s = 'stylized';
  if (s !== style) applied.push(`Look changed to ${STYLE_LABELS[s]}.`);

  // Hair length and colour.
  if (/\bhair\b/.test(t)) {
    const cur = p.hair.style; const i = HAIR_LADDER.indexOf(cur);
    const step = /\blonger\b|\bgrow\b/.test(t) ? 1 : /\bshorter\b|\bcut\b|\btrim\b/.test(t) ? -1 : 0;
    if (step) {
      const from = i < 0 ? (step > 0 ? 1 : 2) : i; const to = clamp(from + step, 0, HAIR_LADDER.length - 1);
      if (i >= 0 && to === i) unsupported.push(`The hair is already as ${step > 0 ? 'long' : 'short'} as the hair styles go (${HAIR_WORDS[cur]}).`);
      else {
        p.hair.style = HAIR_LADDER[to];
        applied.push(`Hair changed to ${HAIR_WORDS[p.hair.style]}.${HAIR_BUILT.includes(p.hair.style) ? '' : ' Its strands are not built yet, so the model and previews show it close-cropped.'}`);
      }
    }
    const c = colourIn(t, COLOURS);
    if (c && !/\beyes?\b|\bjacket|outfit|shirt|top|hoodie|sweater|clothes\b/.test(t)) { p.hair.color = COLOURS[c]; applied.push(`Hair colour changed to ${c}.`); }
    if (!step && !c && /\bcurly\b/.test(t)) { p.hair.style = 'curly_short'; applied.push('Hair changed to short curly. Its strands are not built yet, so the model and previews show it close-cropped.'); }
  }
  // Eyes.
  if (/\beyes?\b/.test(t)) {
    const c = colourIn(t, EYE_COLOURS);
    if (c) { p.eyes.iris = EYE_COLOURS[c]; applied.push(`Eye colour changed to ${c}.`); }
  }
  // Outfit.
  if (/\b(?:outfit|clothes|jacket|shirt|top|hoodie|sweater)\b/.test(t)) {
    const c = colourIn(t, COLOURS);
    const next = c ? COLOURS[c] : OUTFIT_PALETTE[(OUTFIT_PALETTE.indexOf(p.outfit.color) + 1) % OUTFIT_PALETTE.length];
    for (const top of ['jacket', 'hoodie', 'sweater']) if (new RegExp(`\\b${top}\\b`).test(t) && !/\bcolou?r\b/.test(t) && !c) p.outfit.top = top;
    if (next !== p.outfit.color || c) {
      p.outfit.color = next;
      applied.push(`Outfit colour changed to ${colourName(next)}. The head model and previews do not show clothes yet; the outfit is saved with the project.`);
    }
  }
  // Skin.
  if (/\bskin\b|\bcomplexion\b|\bskin tone\b/.test(t)) {
    const f = /\bdarker\b|\bdeeper\b/.test(t) ? 0.8 : /\blighter\b|\bfairer\b|\bpaler\b/.test(t) ? 1.25 : 0;
    if (f && p.skin.tone) {
      const tone = shiftTone(p.skin.tone, f);
      if (tone) { p.skin.tone = tone; applied.push(`Skin tone made ${f < 1 ? 'deeper' : 'lighter'}.`); }
      else unsupported.push(`The skin tone cannot go any ${f < 1 ? 'deeper' : 'lighter'} and stay a realistic human skin colour.`);
    }
  }
  // Age.
  if (/\bolder\b/.test(t)) { p.body.age = round3(clamp(Number(p.body.age || 0) + 0.1, 0, 0.3)); applied.push('Made older (about 5 years).'); }
  else if (/\byounger\b/.test(t)) { p.body.age = round3(clamp(Number(p.body.age || 0) - 0.1, 0, 0.3)); applied.push('Made younger (about 5 years).'); }
  // Face sliders.
  for (const [re, keys, d, words] of SLIDER_EDITS) {
    if (!re.test(t)) continue;
    for (const k of [].concat(keys)) p.face[k] = round3(clamp(Number(p.face[k] || 0) + d, k === 'face_round' || k === 'face_oval' ? 0 : -1, 1));
    applied.push(`Face: ${words}.`);
  }
  for (const k of Object.keys(p.face)) if (!p.face[k]) delete p.face[k];
  if (!applied.length && !unsupported.length && !critique) {
    unsupported.push(`I can't change that yet. Try: make the hair longer, change the outfit, bigger eyes, make it photorealistic, high detail, cinematic lighting, show the skeleton, or animate walking.`);
  }
  return { params: p, style: s, render: r, applied, unsupported, viewport, critique };
}

const luminance = (hex) => {
  const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(String(hex).slice(i, i + 2), 16) || 0));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

/**
 * "Critique this design". Looking at a design needs a finished render, so until this version has one CHE says so.
 * With one, she gives a parameter review: points read from the settings and the build receipt (strong sliders, colour
 * contrast that blurs the silhouette or hairline, hair strands not built, detail, lighting, the verified skeleton),
 * labelled as such: never a visual judgement and never a beauty score. Each point names a change she can make.
 */
export function critiqueOf(v, job) {
  if (!job || job.state !== 'completed') {
    return { points: [], spoken: 'A critique needs a finished render to look at, and this version has none yet. Say generate to build one, then ask again.' };
  }
  const p = v.params || {}; const r = renderOf(v); const points = [];
  for (const [k, w] of Object.entries(p.face || {})) {
    if (Math.abs(Number(w)) >= 0.6) points.push(`The ${k.replace(/_/g, ' ')} setting is strong (${w}); in the ${STYLE_LABELS[v.style]} look that can read as exaggerated. A smaller change may sit better.`);
  }
  if (p.outfit?.color && p.skin?.tone && contrast(p.outfit.color, p.skin.tone) < 1.4) {
    points.push('The outfit and skin are close in brightness, so the body silhouette blurs. A darker or lighter outfit colour would separate them.');
  }
  if (p.hair?.color && p.skin?.tone && contrast(p.hair.color, p.skin.tone) < 1.3) points.push('The hair and skin are close in brightness, so the hairline is hard to read. A darker or lighter hair colour would help.');
  if (p.hair?.style && !HAIR_BUILT.includes(p.hair.style)) points.push(`The ${HAIR_WORDS[p.hair.style] || p.hair.style} hair has no strands built yet, so the renders show it close-cropped.`);
  if (r.quality === 'draft') points.push('This was a Draft build: right for checking shape, not for final pictures. Say high detail for the next build.');
  if (r.lighting === 'studio') points.push('Studio light is even, good for checking the model; cinematic lighting adds a rim and deeper shadows for presentation.');
  if (r.mode === 'bust') points.push('This is a head-and-shoulders model; say full body to build the whole character with its skeleton.');
  const rig = job.rig;
  if (r.mode === 'full_body' && rig?.ok) points.push(`The skeleton was verified: ${rigLine({ bones: rig.bones, clips: (rig.clips || []).map((name) => ({ name })), morphs: rig.morphs })}.`);
  const head = 'Parameter review, from the settings and the build receipt: not a visual judgement of the picture, and not a beauty score.';
  return { points, spoken: `${head} ${points.length ? points.join(' ') : 'Nothing in the settings stands out as a problem.'}` };
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function load(storage) { return (await storage.get(PROJECTS_KEY)) || []; }
// Never evicts: at MAX_PROJECTS a new creation is refused (create below), so no saved work is dropped without the owner
// asking (AGENTS.md: deleting needs his yes; review of #520).
async function store(storage, list) { await storage.put(PROJECTS_KEY, list); }

async function engineOf(queue, env = {}) {
  const v = await queue.view();
  const rec = await engineRecord(queue.storage); const settings = engineSettingsOf(rec);
  const on = v.workers.filter((w) => w.online).sort((a, b) => (b.last_seen_ms || 0) - (a.last_seen_ms || 0));
  const gpuOn = on.filter((w) => w.class !== 'github_cpu');
  const last = v.workers.map((w) => w.last_seen).filter(Boolean).sort().pop() || null;
  // automatic: CHE can start a free cloud CPU worker herself right now (auto_cloud on, GitHub token, repo verified public).
  const automatic = cloudUsable(env, rec);
  const status = gpuOn.length ? 'online' : automatic ? 'cloud' : on.length ? 'online' : v.worker_paired ? 'offline' : 'not_paired';
  return { online: Boolean(on.length), gpu: gpuOn[0]?.gpu || (on.length ? 'CPU (GitHub cloud worker)' : null), paired: v.worker_paired, last_seen: last, notebook_url: NOTEBOOK_URL, status,
    automatic, workers_online: on.length, max_concurrent: settings.max_cloud_workers + gpuOn.length, waiting_reason: rec.waiting_reason || '',
    label: { online: 'Creation Engine Online', cloud: 'Creation Engine ready: free cloud CPU', offline: 'Creation Engine Offline', not_paired: 'Creation Engine not connected' }[status], jobs: v.jobs };
}

const CLOUD_LINE = 'CHE is starting a free cloud worker; it builds on the CPU, slower than the GPU.';

const cur = (p) => p.versions[p.current];
/** Create Object and Create Room projects (creation_objects.js): a spec in place of an identity preset. */
const isThing = (p) => p.kind === 'object' || p.kind === 'room';
const renderView = (p, v) => {
  if (!isThing(p)) return { ...renderOf(v), quality_label: qualityOf(renderOf(v)).label };
  const q = OBJ.qualityOf(v.render); return { quality: q.id, quality_label: q.label };
};

function summary(p, jobs) {
  const v = cur(p); const j = v.job_id ? jobs.find((x) => x.id === v.job_id) : null;
  return {
    id: p.id, kind: p.kind, title: p.title, base_id: p.base_id, version: v.n, versions: p.versions.length,
    can_undo: p.current > 0, can_redo: p.current < p.versions.length - 1, saved_at: p.saved_at, updated_at: p.updated_at, style: v.style,
    job: j ? { id: j.id, state: j.state, pct: j.progress?.pct ?? 0, message: j.progress?.message || '', updated_at: j.updated_at,
      owner_paused: Boolean(j.owner_paused), display_state: j.display_state || null, status_line: j.status_line || null } : null,
    previews: j ? { ...(j.previews || {}) } : {}, model_url: j?.model?.url || null,
    render: renderView(p, v), rig: j?.rig || null,
    ...(isThing(p) ? { described: OBJ.describeSpec(p.kind, v.params), measured: j?.measured || null } : {}),
  };
}

// The claim note names the worker ("… GitHub cloud CPU …" / "CPU (4 cores)"); a CPU start is never labelled GPU.
const cpuNote = (n) => /\bCPU\b|github cloud|cloud worker/i.test(n);

/** Real stages from the job's own history, newest last: nothing here is inferred or simulated. */
function stagesOf(job) {
  if (!job) return [];
  return (job.history || []).map((h) => {
    const n = String(h.note || '');
    const label = /^Geometry ready/.test(n) ? 'Geometry ready' : /^(?:Skeleton|Model) verified/.test(n) ? n.replace(/\.$/, '') : /^Preview .* arrived/.test(n) ? n.replace(/\.$/, '')
      : h.state === 'queued' ? 'Queued' : h.state === 'rendering' ? `${/^Resumed/.test(n) ? 'Resumed' : 'Started'} on ${cpuNote(n) ? 'a free cloud CPU worker' : 'the GPU'}`
        : h.state === 'completed' ? 'Completed' : h.state === 'failed' ? 'Failed' : h.state === 'paused' ? 'Paused' : h.state === 'cancelled' ? 'Cancelled' : h.state;
    return { at: h.at, label, state: h.state, note: n };
  });
}

function detail(p, jobs, engine) {
  const v = cur(p); const raw = v.job_id ? jobs.find((x) => x.id === v.job_id) : null;
  const { jobs: _all, ...eng } = engine;
  const sum = summary(p, jobs);
  // detail.versions is the version list (the summary's count stays as versions_count).
  return { ...sum, versions_count: sum.versions, params: v.params, resources: isThing(p) ? OBJ.resourceLine(v.render) : resourceLine(renderOf(v)),
    versions: p.versions.map((x) => ({ n: x.n, at: x.at, note: x.note, style: x.style, render: isThing(p) ? renderView(p, x) : renderOf(x), job_id: x.job_id })),
    job: raw || null, stages: stagesOf(raw), engine: eng };
}

function speakProject(p, jobs, engine) {
  const s = summary(p, jobs); const j = s.job;
  const job = !j ? 'No model built yet for this version. Say: generate the model.'
    : j.state === 'completed' ? 'The 3D model and previews for this version are ready.'
      : j.state === 'rendering' ? `Building now: ${j.message || 'on your Creation Engine'}.`
        : j.state === 'queued' || j.state === 'paused' ? (engine.automatic ? `Waiting for the Creation Engine. ${CLOUD_LINE}`
          : `Waiting for the Creation Engine${engine.online ? '' : `, which is offline. ${engine.waiting_reason ? `${engine.waiting_reason} ` : ''}Open Colab to start it`}.`)
          : `The last build ${j.state}.`;
  if (isThing(p)) {
    const m = s.measured?.ok ? ` Measured: ${s.measured.line}.` : '';
    return `${p.title}, version ${s.version} of ${s.versions}: ${s.described}. ${job}${m}`;
  }
  return `${p.title}, version ${s.version} of ${s.versions}, ${STYLE_LABELS[s.style]} look. ${job}`;
}

export class CreationStudio {
  constructor(storage, now = () => Date.now(), { env = {}, fetcher } = {}) {
    this.storage = storage; this.now = now; this.env = env; this.fetcher = fetcher; this.queue = new GpuQueue(storage, now);
  }

  /** The app polled or queued: make sure a waiting job has a worker on its way (creation_orchestrator.js). */
  async capacity() {
    return ensureCapacity(this.env, { storage: this.storage, now: this.now, fetcher: this.fetcher, queue: this.queue }).catch(() => ({ dispatched: 0, waiting_reason: '' }));
  }

  async engine() { return engineOf(this.queue, this.env); }

  async list() {
    await this.capacity();
    const [projects, engine] = [await load(this.storage), await this.engine()];
    const { jobs, ...eng } = engine;
    const out = [...projects].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).map((p) => summary(p, jobs));
    const active = out.filter((p) => p.job && ['queued', 'rendering', 'paused'].includes(p.job.state)).length;
    return { projects: out, engine: eng, capabilities: CAPABILITIES,
      spoken: `${out.length} creation${out.length === 1 ? '' : 's'}${active ? `, ${active} building or waiting` : ''}. ${eng.label}.` };
  }

  async create(body = {}) {
    const kind = body.kind || 'person';
    if (kind === 'object' || kind === 'room') return this.createThing(kind, body);
    if (kind !== 'person') {
      const cap = CAPABILITIES.find((c) => c.id === kind);
      return { ok: false, detail: cap ? `${cap.title} is ${cap.status === 'partial' ? 'a preview only' : 'not built'} as a project: ${cap.detail}` : 'CHE creates people, objects and rooms.' };
    }
    const baseId = String(body.base || 'che');
    const base = (await listIdentities(this.storage)).presets.find((x) => x.id === baseId);
    if (!base) return { ok: false, detail: `No preset named ${baseId}. Try one of: ${BUILT_IN.map((x) => x.id).join(', ')}.` };
    const style = STYLES.includes(body.style) ? body.style : 'photoreal';
    const t = this.now(); const id = `cr_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const params = clone(base); delete params.built_in;
    const p = { id, kind: 'person', title: String(body.title || `${base.name || base.id} (new person)`).slice(0, 80), base_id: base.id,
      created_at: iso(t), updated_at: iso(t), saved_at: null, current: 0,
      versions: [{ n: 1, at: iso(t), note: `Started from ${base.name || base.id}.`, params, style, job_id: null }] };
    const list = await load(this.storage);
    if (list.length >= MAX_PROJECTS) {
      return { ok: false, full: true, detail: `You have ${list.length} creations, the most CHE keeps. Nothing was removed; delete one you no longer need (CHE asks you first), then create again.` };
    }
    list.push(p); await store(this.storage, list);
    return { ok: true, project: await this.detailOf(p) };
  }

  /** Create Object / Create Room: base is a family (lamp, chair, table, desk, mug, vase, shelf) or a room type. */
  async createThing(kind, body) {
    const base = String(body.base || (kind === 'object' ? 'lamp' : 'living_room')).toLowerCase();
    const spec = OBJ.defaultSpec(kind, base);
    if (!spec) {
      return { ok: false, detail: kind === 'object'
        ? `CHE builds only these objects: ${[...OBJ.FAMILIES, 'desk'].join(', ')}. ${OBJ.CAPABILITY_NOTE[0].toUpperCase()}${OBJ.CAPABILITY_NOTE.slice(1)}.`
        : `CHE builds only these rooms: ${OBJ.ROOM_TYPES.map((x) => OBJ.ROOM_LABELS[x]).join(', ')}.` };
    }
    const list = await load(this.storage);
    if (list.length >= MAX_PROJECTS) {
      return { ok: false, full: true, detail: `You have ${list.length} creations, the most CHE keeps. Nothing was removed; delete one you no longer need (CHE asks you first), then create again.` };
    }
    const t = this.now(); const id = `cr_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const p = { id, kind, title: String(body.title || OBJ.titleOf(kind, spec)).slice(0, 80), base_id: kind === 'object' ? (base === 'desk' ? 'desk' : spec.family) : spec.type,
      created_at: iso(t), updated_at: iso(t), saved_at: null, current: 0,
      versions: [{ n: 1, at: iso(t), note: `Started from the ${kind === 'object' ? (base === 'desk' ? 'desk' : spec.family) : OBJ.ROOM_LABELS[spec.type]} defaults.`,
        params: spec, style: spec.style, render: { quality: 'standard' }, job_id: null }] };
    list.push(p); await store(this.storage, list);
    const project = await this.detailOf(p);
    return { ok: true, project, spoken: `${p.title} started: ${OBJ.describeSpec(kind, spec)}. Say a change, or say generate to build it.` };
  }

  async find(id) { const list = await load(this.storage); return { list, p: list.find((x) => x.id === id) || null }; }

  async detailOf(p) { const engine = await this.engine(); return detail(p, engine.jobs, engine); }

  async get(id) {
    const { p } = await this.find(id);
    if (!p) return { ok: false, status: 404, detail: 'No such creation.' };
    await this.capacity();
    const engine = await this.engine();
    return { ok: true, project: detail(p, engine.jobs, engine), spoken: speakProject(p, engine.jobs, engine) };
  }

  async generate(id) {
    const { list, p } = await this.find(id);
    if (!p) return { ok: false, status: 404, detail: 'No such creation.' };
    const v = cur(p);
    let out;
    if (isThing(p)) {
      // Objects and rooms are light procedural builds: any worker takes them, a free cloud CPU included.
      const bad = OBJ.specErrors(p.kind, v.params);
      if (bad.length) return { ok: false, detail: `This version cannot be built: ${bad.join('; ')}.` };
      const q = OBJ.qualityOf(v.render);
      out = await this.queue.enqueue({ kind: OBJ.KIND_JOB[p.kind], title: `${p.title} v${v.n}: 3D model and previews`, views: VIEWS, samples: q.samples, res: q.res,
        settings: OBJ.specSettings(v.params), queued_by: 'Live Studio', priority: 'high', requires: { gpu: 'none' } });
    } else {
      const r = renderOf(v); const q = qualityOf(r);
      // Owner-interactive: high priority; a GPU is preferred, and a free cloud CPU worker takes it when none is online.
      out = await this.queue.enqueue({ kind: 'person_model', title: `${p.title} v${v.n}: 3D model and previews`, views: VIEWS, samples: q.samples, res: q.res,
        settings: { ...toSettings(v.params, v.style), ...renderSettings(r) }, queued_by: 'Live Studio', priority: 'high', requires: { gpu: 'preferred' } });
    }
    if (!out.ok) return { ok: false, detail: out.detail };
    v.job_id = out.job.id; p.updated_at = iso(this.now()); await store(this.storage, list);
    const cap = await this.capacity();
    const engine = await this.engine();
    const gpuOn = engine.online && engine.gpu && !/^CPU/.test(engine.gpu);
    const spoken = out.duplicate ? 'This version is already queued or building.'
      : gpuOn ? `Queued. Your Creation Engine on ${engine.gpu} will build the 3D model, then front, three-quarter and side previews.`
        : cap.dispatched || engine.automatic ? `Queued. ${CLOUD_LINE} It builds the 3D model, then front, three-quarter and side previews.`
          : engine.online ? 'Queued. A cloud worker is online and takes it next.'
            : `Queued. It builds when the Creation Engine is running; it is ${engine.status === 'not_paired' ? 'not connected yet' : 'offline now'}.${cap.waiting_reason ? ` ${cap.waiting_reason}` : ''} Open Colab to start it.`;
    return { ok: true, job: engine.jobs.find((x) => x.id === out.job.id) || out.job, duplicate: Boolean(out.duplicate), spoken, project: detail(p, engine.jobs, engine) };
  }

  async edit(id, text) {
    const { list, p } = await this.find(id);
    if (!p) return { ok: false, status: 404, detail: 'No such creation.' };
    const v = cur(p);
    if (isThing(p)) return this.editThing(list, p, v, text);
    const r = parseEdit(text, v.params, v.style, renderOf(v));
    const changed = JSON.stringify(r.params) !== JSON.stringify(v.params) || r.style !== v.style || JSON.stringify(r.render) !== JSON.stringify(renderOf(v));
    // "Critique this design": a parameter review of this version once it has a finished build, else an honest no.
    let critique = null;
    if (r.critique) {
      const engine = await this.engine();
      critique = critiqueOf(v, v.job_id ? engine.jobs.find((x) => x.id === v.job_id) : null);
    }
    if (changed) {
      const bad = validate(r.params);
      if (bad.length) return { ok: true, changed: false, applied: [], unsupported: [`That change was not saved: ${bad.join('; ')}.`], viewport: r.viewport, spoken: `That change was not saved: ${bad.join('; ')}.`, project: await this.detailOf(p) };
      const t = this.now();
      p.versions = p.versions.slice(0, p.current + 1);
      p.versions.push({ n: Math.max(...p.versions.map((x) => x.n)) + 1, at: iso(t), note: String(text).slice(0, 200), params: r.params, style: r.style, render: r.render, job_id: null });
      if (p.versions.length > MAX_VERSIONS) p.versions = p.versions.slice(-MAX_VERSIONS);
      p.current = p.versions.length - 1; p.updated_at = iso(t);
      await store(this.storage, list);
    }
    const n = cur(p).n;
    const spoken = [...r.applied, ...r.unsupported, ...(critique ? [critique.spoken] : [])].join(' ') + (changed ? ` Saved as version ${n}. Say generate to build it.` : '');
    return { ok: true, changed, applied: r.applied, unsupported: r.unsupported, viewport: r.viewport, critique, spoken: spoken.trim(), project: await this.detailOf(p) };
  }

  /** An object or room edit: viewport words first, then the spec words (creation_objects.js); a change is a version. */
  async editThing(list, p, v, text) {
    const t = String(text || '').toLowerCase().replace(/[.!?]+$/g, '').replace(/^(?:che|chey|chay)[,:]?\s+/, '').trim();
    const vi = /\bturn (?:it |this |the \w+ )?into\b/.test(t) ? null : viewportIntent(t);
    // A pure view command ("rotate it", "zoom in") moves the viewport only; "rotate the chair and make it red" does both.
    const r = vi && !/\b(?:make|add|remove|paint|change|turn it into|bigger|smaller|colou?r|floor|wall|light)\b/.test(t)
      ? { spec: v.params, quality: null, applied: [], unsupported: [] }
      : (p.kind === 'object' ? OBJ.parseObjectEdit(t, v.params) : OBJ.parseRoomEdit(t, v.params));
    const applied = [...(vi ? [vi.sentence] : []), ...r.applied];
    const unsupported = vi ? r.unsupported.filter((x) => !/^I can't change that/.test(x)) : r.unsupported;
    const render = r.quality ? { quality: r.quality } : { ...(v.render || { quality: 'standard' }) };
    const changed = JSON.stringify(r.spec) !== JSON.stringify(v.params) || JSON.stringify(render) !== JSON.stringify(v.render || { quality: 'standard' });
    if (changed) {
      const bad = OBJ.specErrors(p.kind, r.spec);
      if (bad.length) {
        const said = `That change was not saved: ${bad.join('; ')}.`;
        return { ok: true, changed: false, applied: [], unsupported: [said], viewport: vi?.viewport || null, spoken: said, project: await this.detailOf(p) };
      }
      const now = this.now();
      p.versions = p.versions.slice(0, p.current + 1);
      p.versions.push({ n: Math.max(...p.versions.map((x) => x.n)) + 1, at: iso(now), note: String(text).slice(0, 200), params: r.spec, style: r.spec.style, render, job_id: null });
      if (p.versions.length > MAX_VERSIONS) p.versions = p.versions.slice(-MAX_VERSIONS);
      p.current = p.versions.length - 1; p.updated_at = iso(now);
      await store(this.storage, list);
    }
    const spoken = [...applied, ...unsupported].join(' ') + (changed ? ` Saved as version ${cur(p).n}. Say generate to build it.` : '');
    return { ok: true, changed, applied, unsupported, viewport: vi?.viewport || null, critique: null, spoken: spoken.trim(), project: await this.detailOf(p) };
  }

  async step(id, action) {
    const { list, p } = await this.find(id);
    if (!p) return { ok: false, status: 404, detail: 'No such creation.' };
    const t = this.now(); let spoken;
    if (action === 'undo') {
      if (p.current === 0) return { ok: false, detail: 'Nothing to undo: this is the first version.', project: await this.detailOf(p) };
      p.current -= 1; spoken = `Undone. Back to version ${cur(p).n}.`;
    } else if (action === 'redo') {
      if (p.current >= p.versions.length - 1) return { ok: false, detail: 'Nothing to redo.', project: await this.detailOf(p) };
      p.current += 1; spoken = `Redone. Version ${cur(p).n}.`;
    } else if (action === 'save') {
      p.saved_at = iso(t); spoken = `Saved ${p.title}, version ${cur(p).n}.`;
    } else return { ok: false, detail: 'Unknown action.' };
    p.updated_at = iso(t); await store(this.storage, list);
    return { ok: true, spoken, project: await this.detailOf(p) };
  }
}

/** Spoken name of a GPU view (for the app's stage labels). */
export const viewName = (v) => VIEW_NAMES[v] || `${v} degrees`;

/** The owner's routes: /api/creations[/<id>[/generate|edit|undo|redo|save]] and /api/creations/engine[/settings]. Null for other paths. */
export async function creationRoute(ctx, path, request, body = {}) {
  const { storage, now, env = {}, fetcher } = ctx;
  if (path !== '/api/creations' && !path.startsWith('/api/creations/')) return null;
  const engine = await engineRoute(ctx, path, request, body);
  if (engine) return engine;
  if (path === '/api/creations/estimate' || path === '/api/creations/capacity') return planningRoute(path, request, env);
  const studio = new CreationStudio(storage, now, { env, fetcher });
  const send = (out, okStatus = 200) => json(out, out.ok === false ? (out.status || (/^No such/.test(out.detail || '') ? 404 : 409)) : okStatus);
  if (path === '/api/creations') {
    if (request.method === 'GET') return json(await studio.list());
    if (request.method === 'POST') { const out = await studio.create(body || {}); return json(out, out.ok ? 201 : 422); }
    return json({ detail: 'Use GET or POST.' }, 405);
  }
  const m = /^\/api\/creations\/(cr_[a-f0-9]{12})(?:\/(generate|edit|undo|redo|save))?$/.exec(path);
  if (!m) return json({ detail: 'Unknown creation route.' }, 404);
  if (!m[2]) return request.method === 'GET' ? send(await studio.get(m[1])) : json({ detail: 'Use GET.' }, 405);
  if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
  if (m[2] === 'generate') return send(await studio.generate(m[1]), 202);
  if (m[2] === 'edit') {
    const text = String(body?.text || '').trim();
    if (!text) return json({ ok: false, detail: 'Say what to change.' }, 400);
    return send(await studio.edit(m[1], text.slice(0, 300)));
  }
  return send(await studio.step(m[1], m[2]));
}

/**
 * Planning, read-only (capacity_model.js): GET /api/creations/estimate?minutes=30&profile=hybrid&gpu=h100&gpus=20 is
 * the pre-job estimate (GPU-hours, wall time, storage, the $0 free path and the paid figure); GET
 * /api/creations/capacity is the five scale scenarios with their assumptions. Nothing is queued, bought or started.
 */
function planningRoute(path, request, env) {
  if (request.method !== 'GET') return json({ detail: 'Use GET.' }, 405);
  if (path === '/api/creations/capacity') return json({ ok: true, scenarios: scenarios(), assumptions: ASSUMPTIONS, storage: r2Status(env) });
  const q = new URL(request.url).searchParams;
  const minutes = Math.min(Math.max(Number(q.get('minutes')) || 1, 0.1), 120);
  const profile = PROFILES[q.get('profile')] ? q.get('profile') : 'hybrid';
  const gpu = ['h100', 'l4', 't4'].includes(q.get('gpu')) ? q.get('gpu') : 'h100';
  const e = estimateVideo({ minutes, profile, gpu, gpus: Math.min(Math.max(Number(q.get('gpus')) || 1, 1), 1000) });
  return json({ ok: true, estimate: e, spoken: `A ${e.minutes}-minute ${profile} video is about ${e.gpu_hours} ${gpu.toUpperCase()} GPU-hours and ${Math.round(e.storage_mb.final)} MB when finished. On ${e.gpus} GPU${e.gpus === 1 ? '' : 's'} it takes about ${e.wall_minutes} minutes. On free capacity it costs nothing; paid capacity would be about $${e.cost_usd.paid}, which needs your approval. This is an estimate; the job's receipt has the real numbers.` });
}

/** worker.js's one owner entry for the studio and the GPU queue under it (/api/creations*, then /api/gpu*). */
export async function studioOwnerRoute(ctx, path, request, body) {
  return (await creationRoute(ctx, path, request, body)) || gpuOwnerRoute(ctx, path, request, body);
}
