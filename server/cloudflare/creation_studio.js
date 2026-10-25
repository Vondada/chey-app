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
import { BUILT_IN, HAIR_BUILT, STYLES, STYLE_LABELS, generateVariant, listIdentities, skinOk, toSettings, validate } from './avatar_identity.js';
import { GpuQueue, VIEW_NAMES, engineRecord, engineSettingsOf, gpuOwnerRoute, referenceKey, rigLine } from './gpu_queue.js';
import { mediaStore, sha256Hex } from './che_media_store.js';
import { cloudUsable, engineRoute, ensureCapacity } from './creation_orchestrator.js';
import { CREATION_PROFILES, profileSettings } from './creation_profiles.js';
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
    detail: `Choose a lamp, chair, table, desk, mug, vase or shelf, or describe one in your own words (a snowman, a wooden crate, a red ball on top of a blue box), then change its size, colour and finish by voice or typing; your Creation Engine builds it in Blender, measures the file and renders previews. ${OBJ.CAPABILITY_NOTE[0].toUpperCase()}${OBJ.CAPABILITY_NOTE.slice(1)}.` },
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
  if (r.target !== 'roblox') delete r.target;   // target: roblox also exports the Roblox R15 FBX (creation_profiles.js)
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
  // The tools for this kind of creation (quick look, final profile, Roblox export): creation_profiles.js.
  return { ...profileSettings(r.target === 'roblox' ? 'roblox' : 'person'), MODEL_MODE: r.mode, QUALITY: q.id, LIGHTING: r.lighting,
    SUBDIV: String(q.subdiv), TEXTURE_PX: String(q.texture_px), STRANDS: String(q.strands) };
}

// ── Reference photos (character realism, Workstream B) ───────────────────────────────────────────────────────────
// A Create Person version may carry one reference photo: JPEG or PNG, at most 8 MB, stored once by SHA-256 in CHE's
// media store (che_media_store.js) and named on the version, so undo and redo bring it back with the rest. Generate
// sends it to the person job as settings.REFERENCE; the worker fetches the bytes with its own worker credential
// (gpu_queue.js /api/gpu/worker/reference), never with the owner's device token.
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
export const REFERENCE_CONSENTS = { self: 'this is me', fictional: 'fictional or generated' };
export const REFERENCE_RULE = 'CHE builds characters only from your own photo or from fictional or generated images, never from photos of other real private people or of children.';
export const REFERENCE_CHOICES = 'Who is in the photo? 1. This is me. 2. Fictional or generated.';
const ascii = (b) => String.fromCharCode(...b);

/** image/jpeg, image/png or image/heic from the file's own first bytes (never its name or a claimed type), else null. */
export function imageTypeOf(bytes) {
  if (bytes?.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes?.length >= 8 && ascii(bytes.subarray(0, 8)) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (bytes?.length >= 12 && ascii(bytes.subarray(4, 8)) === 'ftyp' && /^(?:heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(bytes.subarray(8, 12)))) return 'image/heic';
  return null;
}

function decodeBase64(text) {
  const s = String(text || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// Character voices: CHE's existing on-device Kokoro voices (lib/che_native_voice.dart localVoiceOptions, same ids and
// names; a Flutter test checks they match). No new provider: the app plays a sample through its own TTS path.
export const CHARACTER_VOICES = [
  { id: 0, name: 'Chaze — Signature (Local)', speaker: 'af' },
  { id: 1, name: 'American Feminine — Bella', speaker: 'af_bella' },
  { id: 2, name: 'American Feminine — Nicole', speaker: 'af_nicole' },
  { id: 3, name: 'American Feminine — Sarah', speaker: 'af_sarah' },
  { id: 4, name: 'American Feminine — Sky', speaker: 'af_sky' },
  { id: 5, name: 'American Masculine — Adam', speaker: 'am_adam' },
  { id: 6, name: 'American Masculine — Michael', speaker: 'am_michael' },
  { id: 7, name: 'British Feminine — Emma', speaker: 'bf_emma' },
  { id: 8, name: 'British Feminine — Isabella', speaker: 'bf_isabella' },
  { id: 9, name: 'British Masculine — George', speaker: 'bm_george' },
  { id: 10, name: 'British Masculine — Lewis', speaker: 'bm_lewis' },
];
export const REGENERATE = /^(?:make another(?: one)?|regenerate(?: it)?|another (?:one|variation|version)|make a (?:new )?variation|new variation|try another(?: one)?)$/;

/** OUTFIT_SRGB / OUTFIT_TOP from the version's outfit, and VARIATION when this version is a variation. */
export function personExtras(v) {
  const o = v.params?.outfit || {}; const out = {};
  if (/^#[0-9a-f]{6}$/i.test(String(o.color || ''))) out.OUTFIT_SRGB = [1, 3, 5].map((i) => String(parseInt(o.color.slice(i, i + 2), 16))).join(',');
  if (o.top && TOPS.some(([k]) => k === o.top)) out.OUTFIT_TOP = o.top;
  if (Number(v.variation) > 0) out.VARIATION = String(Math.trunc(Number(v.variation)));
  return out;
}

const refView = (p, r) => (r ? { sha256: r.sha256, bytes: r.bytes, content_type: r.content_type, consent: r.consent,
  consent_label: REFERENCE_CONSENTS[r.consent] || r.consent, at: r.at, url: `/api/creations/${p.id}/reference` } : null);
const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

const iso = (ms) => new Date(ms).toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const clone = (x) => JSON.parse(JSON.stringify(x));
const round3 = (v) => Math.round(v * 1000) / 1000;

// ── Edit vocabulary ──────────────────────────────────────────────────────────────────────────────────────────────
const HAIR_LADDER = ['close_crop', 'curly_short', 'wavy_medium', 'long_wavy'];
const HAIR_WORDS = { close_crop: 'close-cropped', curly_short: 'short curly', wavy_medium: 'shoulder-length wavy', long_wavy: 'long wavy',
  bun_high: 'high bun', bun_low: 'low bun', afro: 'afro', beanie: 'under a beanie' };
export const COLOURS = {
  black: '#16110e', 'jet black': '#0e0b0a', dark: '#241812', 'dark brown': '#2a1a12', brown: '#4a2c1c', 'light brown': '#7a5236', chestnut: '#5a2e1a',
  auburn: '#6a2e1a', red: '#8a2a16', ginger: '#b0521e', blonde: '#d8b46a', blond: '#d8b46a', 'platinum blonde': '#e6d6b0', grey: '#8a8580',
  gray: '#8a8580', silver: '#b8b8b8', white: '#e8e6e0', purple: '#8d64d6', violet: '#8d64d6', pink: '#d67ea8', blue: '#3a6ec8',
  green: '#3c7a4a', teal: '#1f6f78', navy: '#1d2b4a', orange: '#e8732e', yellow: '#d8b030', gold: '#c8a040', beige: '#d8c4a0', cream: '#e9dcc8',
};
export const EYE_COLOURS = { brown: '#5a3a22', 'dark brown': '#3e2616', 'light brown': '#7a5232', hazel: '#7a6a3a', amber: '#a8742a', green: '#4f7a4a',
  blue: '#4f7fb5', 'light blue': '#7aa6d6', grey: '#6f7a80', gray: '#6f7a80', black: '#241812' };
const OUTFIT_PALETTE = ['#1f6f78', '#1d2b4a', '#4a525c', '#e8732e', '#d89a2a', '#56603e', '#b79be6', '#e9dcc8', '#3e5f86', '#7a2a2a'];
const colourName = (hex) => Object.entries(COLOURS).find(([, h]) => h === hex)?.[0] || { '#3e5f86': 'denim blue' }[hex] || hex;
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
  if (/\b(?:no|not for|without|stop)(?: the)? roblox\b/.test(t)) delete r.target;
  else if (/\broblox\b/.test(t)) r.target = 'roblox';
  if ((r.target || '') !== (render.target || '')) {
    applied.push(r.target === 'roblox'
      ? `Roblox export on. Generate also makes a Roblox Studio file: ${CREATION_PROFILES.roblox.note}`
      : 'Roblox export off.');
  }
  return r;
}

// ── Person vocabulary: look, hair, outfit, skin and body (owner, 2026-10-25: one Create button, full character) ──
/** The look a sentence names, or null: photoreal (realistic, photo), hybrid (game, game-like), stylized (cartoon). */
export function styleIn(t) {
  if (/\bhybrid\b|\bgame(?:[- ]?(?:like|style|styled|character|look))?\b|\bvideo ?game\b/.test(t)) return 'hybrid';
  if (/\bstyli[sz]ed\b|\bcartoon(?:y|ish)?\b|\banimated(?: look| style)?\b|\banime\b|\bpixar\b/.test(t)) return 'stylized';
  if (/\b(?:hyper[- ]?)?realistic\b|\bphoto ?-?realistic\b|\bphotoreal\b|\bphoto\b|\blifelike\b|\breal(?:-| )life\b/.test(t)) return 'photoreal';
  return null;
}
const HAIR_PART = /\bhair\b|\bbuzz ?cut\b|\bcrew ?cut\b|\bshaved head\b|\bafro\b|\bbun\b|\bbeanie\b/;
/** A hair style named in words ("buzz cut", "short curly hair", "afro", "low bun"), or null. */
export function hairStyleIn(t) {
  if (/\bafro\b/.test(t)) return 'afro';
  if (/\blow bun\b/.test(t)) return 'bun_low';
  if (/\bbun\b/.test(t)) return 'bun_high';
  if (/\bbeanie\b/.test(t)) return 'beanie';
  if (/\bbuzz ?cut\b|\bcrew ?cut\b|\bshaved head\b|\bclose[- ]?cropped\b|\bcropped hair\b/.test(t)) return 'close_crop';
  if (/\bcurly\b|\bcurls\b/.test(t)) return 'curly_short';
  if (/\bshort hair\b|\bshort (?:black|brown|blonde?|red|grey|gray|white|dark|light) hair\b/.test(t)) return 'close_crop';
  if (/\blong\b/.test(t)) return 'long_wavy';
  if (/\bwavy\b|\bshoulder[- ]length\b|\bmedium[- ]length\b/.test(t)) return 'wavy_medium';
  return null;
}
const OUTFIT_PART = /\b(?:outfit|clothes|clothing|jacket|shirt|t-?shirt|tee|top|hoodie|sweater|jumper|coat|blazer|sweatshirt)\b/;
export const TOPS = [['hoodie', /\bhoodie\b|\bsweatshirt\b/], ['sweater', /\bsweater\b|\bjumper\b/], ['t_shirt', /\bt-?shirt\b|\btee\b/],
  ['shirt', /\bshirt\b/], ['coat', /\bcoat\b/], ['blazer', /\bblazer\b/], ['jacket', /\bjacket\b/]];
const TOP_NOTE = 'The full-body model builds a long-sleeved top and trousers in the outfit colour; the top type is saved with the project.';
// Skin tones by name, each a human skin albedo the renderer accepts (avatar_identity.js skinOk).
export const SKIN_TONES = { pale: '#e0b89a', fair: '#dcae8e', light: '#d4a07e', olive: '#b98a5e', tan: '#b07a50', medium: '#a06a44',
  brown: '#7a4a2c', 'dark brown': '#5a3420', dark: '#4a2a18', deep: '#3a2010' };
export function skinIn(t) {
  const m = /\b(dark brown|pale|fair|light|olive|tan(?:ned)?|medium|brown|dark|deep)(?:[- ]skinned|\s+(?:skin|complexion))\b/.exec(t);
  if (!m) return null;
  return m[1] === 'tanned' ? 'tan' : m[1];
}

// Body shape: MPFB macro values 0..1 sent as BODY_* job settings. 0.5 is today's look (average height, weight and
// muscle, half-way ideal proportions), and a value at its default is omitted, so a project made before body edits
// existed queues exactly the settings it did before. gender and age are set only when the owner names them (SEX and
// MATURE from the identity carry the face as before). age 0.1875..1 is 18..90 years: CHE builds adults only.
export const BODY_DEFAULTS = { height: 0.5, weight: 0.5, muscle: 0.5, proportions: 0.5 };
export const BODY_KEYS = { gender: 'BODY_GENDER', age: 'BODY_AGE', height: 'BODY_HEIGHT', weight: 'BODY_WEIGHT', muscle: 'BODY_MUSCLE', proportions: 'BODY_PROPORTIONS' };
export const ADULT_AGE = 18;
/** MPFB's age macro for an age in years (11 y = 0.1875, 25 y = 0.5, 90 y = 1). */
export const ageMacro = (years) => round3(years < 25 ? 0.1875 + ((years - 11) / 14) * 0.3125 : 0.5 + ((years - 25) / 65) * 0.5);
const AGE_MIN = ageMacro(ADULT_AGE);
/** The shape with defaults dropped and every value in range. */
export function cleanShape(sh = {}) {
  const out = {};
  for (const k of Object.keys(BODY_KEYS)) {
    if (sh[k] === undefined || sh[k] === null || !Number.isFinite(Number(sh[k]))) continue;
    const v = round3(clamp(Number(sh[k]), k === 'age' ? AGE_MIN : 0, 1));
    if (BODY_DEFAULTS[k] === undefined || v !== BODY_DEFAULTS[k]) out[k] = v;
  }
  return out;
}
/** Problems with a shape (empty when valid): every macro 0..1, age 18 years or older. */
export function shapeErrors(sh = {}) {
  const out = [];
  for (const [k, v] of Object.entries(sh || {})) {
    if (!BODY_KEYS[k]) out.push(`unknown body setting ${k}`);
    else if (!(Number(v) >= (k === 'age' ? AGE_MIN : 0) && Number(v) <= 1)) out.push(k === 'age' ? 'body age must be an adult (18 or older)' : `body ${k} must be 0..1`);
  }
  return out;
}
/** The BODY_* job settings for a shape (only values away from today's look). */
export function shapeSettings(sh = {}) {
  return Object.fromEntries(Object.entries(cleanShape(sh)).map(([k, v]) => [BODY_KEYS[k], String(v)]));
}
const BODY_WORDS = [
  [/\btaller\b|\bmake (?:her|him|them|it) tall\b/, 'height', 0.15, 'taller'],
  [/\bshorter\b|\bmake (?:her|him|them|it) short\b/, 'height', -0.15, 'shorter'],
  [/\bheavier\b|\bchubbier\b|\bbigger build\b|\bfuller figure\b|\bheavier build\b|\bmore weight\b/, 'weight', 0.15, 'heavier'],
  [/\bslimmer\b|\bleaner\b|\bskinnier\b|\bthinner\b|\blighter build\b|\blose weight\b/, 'weight', -0.15, 'slimmer'],
  [/\bmore muscular\b|\bmore muscle\b|\bmuscl(?:ier|e up)\b|\bstronger\b|\bbuff(?:er)?\b/, 'muscle', 0.2, 'more muscular'],
  [/\bless muscular\b|\bless muscle\b|\bsofter build\b/, 'muscle', -0.2, 'less muscular'],
  [/\bbroad[- ]shouldered\b|\bbroader(?: shoulders| build| frame)?\b|\bbroad shoulders\b/, 'muscle', 0.15, 'broader build'],
  [/\bheroic proportions\b|\bidealized proportions\b|\bmore ideal proportions\b/, 'proportions', 0.3, 'more idealized proportions'],
  [/\bnatural proportions\b|\brealistic proportions\b|\baverage proportions\b/, 'proportions', null, 'natural proportions'],
];
/** Body words in the clauses that do not name a face part or the hair (so "thinner lips" stays a face edit). */
function bodyIntent(clauses, p, sh, applied) {
  for (const c of clauses) {
    if (/\b(?:hair|nose|lips?|mouth|face|chin|jaw|eyes?|brows?|eyebrows|cheeks?|cheekbones|skin)\b/.test(c)) continue;
    for (const [re, k, d, words] of BODY_WORDS) {
      if (!re.test(c)) continue;
      const was = Number(sh[k] ?? BODY_DEFAULTS[k] ?? 0.5);
      const v = d === null ? 0.5 : round3(clamp(was + d, 0, 1));
      if (v === was) { applied.push(`The body is already as ${words.replace(/^more |er$/, '')} as it goes.`); continue; }
      sh[k] = v; applied.push(`Body: ${words}.`);
    }
    const m = /\bmore (masculine|feminine)\b|\b(masculine|feminine)\b/.exec(c);
    if (m) {
      const want = (m[1] || m[2]) === 'masculine' ? 0.25 : -0.25;
      const v = round3(clamp(Number(sh.gender ?? p.body.sex ?? 0) + want, 0, 1));
      sh.gender = v; p.body.sex = v; applied.push(`Body: ${want > 0 ? 'more masculine' : 'more feminine'} build.`);
    }
  }
}
// Things the Blender pipeline cannot build yet, said plainly instead of being ignored.
const NOT_BUILT = [[/\bwings?\b/, 'wings'], [/\btails?\b/, 'a tail'], [/\bhorns?\b/, 'horns'], [/\bhalo\b/, 'a halo'], [/\barmou?r\b/, 'armour'],
  [/\bcapes?\b/, 'a cape'], [/\bswords?\b|\bguns?\b|\bweapons?\b/, 'weapons'], [/\bglasses\b|\bsunglasses\b|\bspectacles\b/, 'glasses'],
  [/\bbeards?\b|\bmoustache\b|\bmustache\b|\bgoatee\b|\bstubble\b/, 'facial hair'], [/\btattoos?\b/, 'tattoos'], [/\bpiercings?\b|\bearrings?\b/, 'piercings or jewellery'],
  [/\b(?:hat|cap|crown|helmet)s?\b/, 'hats'], [/\bmasks?\b/, 'masks'], [/\bdress(?:es)?\b|\bskirts?\b|\bgowns?\b/, 'a dress or skirt (the body builds a top and trousers)'],
  [/\brobots?\b|\baliens?\b|\belf\b|\belves\b|\bpointed ears\b|\bfur\b|\bscales\b|\bclaws?\b/, 'non-human features']];
export function notBuiltIn(t) {
  return NOT_BUILT.filter(([re]) => re.test(t)).map(([, what]) => `I can't make ${what} yet.`);
}

// ── Describe a person (one Create button): deterministic, no model call ─────────────────────────────────────────
const MINOR = /\b(?:child(?:ren)?|kids?|toddlers?|bab(?:y|ies)|infants?|teen(?:ager|age)?s?|adolescents?|minors?|schoolboy|schoolgirl|pre-?teen|underage)\b/;
const DESCRIBE_BODY = [
  [/\bvery tall\b/, { height: 0.85 }, 'very tall'], [/\btall\b/, { height: 0.7 }, 'tall'], [/\bpetite\b/, { height: 0.3, weight: 0.35 }, 'petite'],
  [/\bathletic\b|\bfit\b|\btoned\b/, { muscle: 0.7, weight: 0.45 }, 'athletic'], [/\bmuscular\b|\bburly\b|\bbodybuilder\b/, { muscle: 0.8 }, 'muscular'],
  [/\bslim\b|\bslender\b|\bthin\b|\bskinny\b|\blean\b/, { weight: 0.3 }, 'slim'],
  [/\bheavy(?:set)?\b|\bchubby\b|\bplus[- ]size\b|\bstocky\b|\bcurvy\b|\bbig[- ]boned\b/, { weight: 0.7 }, 'heavier build'],
];
// Words a description may use that carry no setting (said back only if nothing else in them was understood).
const DESCRIBE_FILLER = new Set(('a an the and or of with in on his her their its he she they him them who is are has have wearing wears ' +
  'look looking looks style styled character person people adult young middle aged old year years yo build body figure ' +
  'eyes eye hair skin skinned complexion tone very quite really slightly bit little some kind sort like plus pair ' +
  'man woman men women male female lady guy gentleman girl boy nonbinary non-binary androgynous someone dude ' +
  'tall short long medium dark light make create build generate me please model 3d mid early late ' +
  'game cartoon stylized stylised animated anime pixar realistic hyperrealistic hyper photo photorealistic photoreal lifelike real life').split(/\s+/));
const KNOWN_PART = /^(?:\d{1,3}s?|\d{1,3}-year-old|twenties|thirties|forties|fifties|sixties|seventies|eighties)$/;

/**
 * A described person ("a tall athletic man in his 30s, short curly black hair, brown skin, green eyes, black hoodie,
 * game style") as a starting preset, identity edits, body shape and look. Adults only: a child or teenager is refused
 * with the reason. Returns { ok, base, params, style, shape, applied, unsupported, unused } or { ok: false, refused, detail }.
 */
export function describePerson(text, presets = BUILT_IN) {
  const raw = String(text || '').trim().slice(0, 300);
  const t = raw.toLowerCase().replace(/[.!?]+$/g, '');
  if (!t) return { ok: false, detail: 'Describe the person, for example: a tall woman in her 30s, long wavy dark hair, green eyes, a denim jacket.' };
  const n = /\b(\d{1,3})(?:-| )?(?:years?[- ]old|yo|y\/o)\b|\baged? (\d{1,3})\b|\b(?:in|during) (?:his|her|their) (?:early |mid |late )?(\d)0s\b/.exec(t);
  let years = n ? Number(n[1] || n[2] || Number(n[3]) * 10 + 5) : null;
  if (!years) {
    const word = /\b(?:in (?:his|her|their) )?(twenties|thirties|forties|fifties|sixties|seventies|eighties)\b/.exec(t)?.[1];
    years = word ? { twenties: 25, thirties: 35, forties: 45, fifties: 55, sixties: 65, seventies: 75, eighties: 85 }[word]
      : /\byoung adult\b/.test(t) ? 22 : /\bmiddle[- ]aged\b/.test(t) ? 45 : /\belderly\b|\bold (?:man|woman|person|lady)\b|\bsenior\b/.test(t) ? 70 : null;
  }
  if (MINOR.test(t) || (years !== null && years < ADULT_AGE)) {
    return { ok: false, refused: true, detail: 'CHE builds adult characters only, 18 or older. Describe an adult and I will build them.' };
  }
  const female = /\b(?:woman|women|female|lady|she|her|girl|gal)\b/.test(t); const male = /\b(?:man|men|male|guy|gentleman|he|his|him|boy|dude)\b/.test(t);
  const sex = female && !male ? 0 : male && !female ? 1 : 0.5;
  const baseId = sex === 1 ? 'orion' : 'lyra';
  const base = presets.find((x) => x.id === baseId) || presets[0];
  const params = clone(base); delete params.built_in; params.body = { ...(params.body || {}), sex };
  const applied = [`${sex === 0 ? 'A woman' : sex === 1 ? 'A man' : 'A person'}${years ? ` of about ${years}` : ''}.`];
  if (/\b(?:girl|boy)\b/.test(t)) applied.push('Built as an adult.');
  const shape = {};
  if (years) { shape.age = ageMacro(years); params.body.age = round3(clamp((years - 25) / 150, 0, 0.3)); }
  const clauses = t.split(/\s*(?:,|;|\band\b|\bwith\b|\bwearing\b|\bin an?\b)\s*/).filter(Boolean);
  for (const c of clauses) {
    if (HAIR_PART.test(c) && !/\btall\b/.test(c)) continue;
    for (const [re, set, words] of DESCRIBE_BODY) {
      if (re.test(c) && !(words === 'tall' && /\bvery tall\b/.test(c))) { Object.assign(shape, set); applied.push(`Body: ${words}.`); }
    }
  }
  // Hair, eyes, skin, outfit and look: the same edit vocabulary the studio uses, over the whole description.
  const edit = parseEdit(t.replace(/\b(?:taller|shorter)\b/g, ''), params, 'photoreal', DEFAULT_RENDER, shape);
  const style = styleIn(t) || 'photoreal';
  applied.push(...edit.applied.filter((a) => !/^Look changed|^Rotating|^Playing|^Showing|^Paused|^Zooming|^Skipping/.test(a)), `Look: ${STYLE_LABELS[style]}.`);
  const unsupported = edit.unsupported.filter((u) => !/^I can't change that yet/.test(u));
  const vocab = new Set([...DESCRIBE_FILLER, ...Object.keys(COLOURS).flatMap((k) => k.split(' ')), ...Object.keys(EYE_COLOURS).flatMap((k) => k.split(' ')),
    ...Object.keys(SKIN_TONES).flatMap((k) => k.split(' '))]);
  const understood = (w) => vocab.has(w) || KNOWN_PART.test(w) || HAIR_PART.test(w) || OUTFIT_PART.test(w) || TOPS.some(([, re]) => re.test(w))
    || DESCRIBE_BODY.some(([re]) => re.test(w)) || BODY_WORDS.some(([re]) => re.test(w)) || hairStyleIn(w) || NOT_BUILT.some(([re]) => re.test(w))
    || Boolean(styleIn(w)) || /^(?:curly|wavy|straight|buzz|cut|crew|shaved|cropped|bun|low|afro|beanie|denim|leather|athletic|muscular|broad|shouldered|masculine|feminine|tanned|olive)$/.test(w);
  const unused = [...new Set(t.replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean).filter((w) => !understood(w)))].slice(0, 8);
  return { ok: true, base: base.id, params: edit.params, style, shape: edit.shape, applied, unsupported, unused };
}

/**
 * One sentence of owner words against a preset, look and render settings. Returns
 * { params, style, render, applied, unsupported, viewport, critique }: params, style and render are edited copies
 * (unchanged when nothing applied), applied and unsupported are plain sentences, critique says one was asked for.
 */
export function parseEdit(text, params, style, render = DEFAULT_RENDER, shape = {}) {
  const t = String(text || '').toLowerCase().replace(/[.!?]+$/g, '').replace(/^(?:che|chey|chay)[,:]?\s+/, '').trim();
  const p = clone(params); let s = style; const sh = { ...(shape || {}) };
  const applied = []; const unsupported = []; let viewport = null;
  // Clauses ("short curly hair, a black hoodie and green eyes"): colours and lengths are read in the clause that names
  // the part, so "shorter" in "make her shorter" is height and "black" in "black hoodie" is the outfit's colour.
  const clauses = t.split(/\s*(?:,|;|\band\b|\bwith\b|\bwearing\b|\bin an?\b)\s*/).filter(Boolean);
  const inClause = (re) => clauses.filter((c) => re.test(c));
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
  s = styleIn(t) || s;
  if (s !== style) applied.push(`Look changed to ${STYLE_LABELS[s]}.`);

  // Hair: a named style ("buzz cut", "afro", "bun"), a length step, and a colour, each from the clause about hair.
  const hairText = inClause(HAIR_PART).join(' ');
  if (hairText) {
    const was = p.hair.style; const i = HAIR_LADDER.indexOf(was);
    const named = hairStyleIn(hairText);
    const step = named ? 0 : /\blonger\b|\bgrow\b/.test(hairText) ? 1 : /\bshorter\b|\bcut\b|\btrim\b/.test(hairText) ? -1 : 0;
    const strands = (st) => (HAIR_BUILT.includes(st) ? '' : ' Its strands are not built yet, so the model and previews show it close-cropped.');
    if (named && named !== was) { p.hair.style = named; applied.push(`Hair changed to ${HAIR_WORDS[named]}.${strands(named)}`); }
    else if (step) {
      const from = i < 0 ? (step > 0 ? 1 : 2) : i; const to = clamp(from + step, 0, HAIR_LADDER.length - 1);
      if (i >= 0 && to === i) unsupported.push(`The hair is already as ${step > 0 ? 'long' : 'short'} as the hair styles go (${HAIR_WORDS[was]}).`);
      else { p.hair.style = HAIR_LADDER[to]; applied.push(`Hair changed to ${HAIR_WORDS[p.hair.style]}.${strands(p.hair.style)}`); }
    }
    const hc = inClause(/\bhair\b/).map((c) => colourIn(c, COLOURS)).find(Boolean);
    if (hc && COLOURS[hc] !== p.hair.color) { p.hair.color = COLOURS[hc]; applied.push(`Hair colour changed to ${hc}.`); }
  }
  // Eyes.
  const ec = inClause(/\beyes?\b/).map((c) => colourIn(c, EYE_COLOURS)).find(Boolean);
  if (ec) { p.eyes.iris = EYE_COLOURS[ec]; applied.push(`Eye colour changed to ${ec}.`); }
  // Outfit: the top (hoodie, jacket, sweater, shirt) and its colour; denim and leather give a colour when none is said.
  const outfitText = inClause(OUTFIT_PART).join(' ');
  if (outfitText) {
    const c = colourIn(outfitText, COLOURS);
    const top = TOPS.find(([, re]) => re.test(outfitText))?.[0];
    const material = /\bdenim\b/.test(outfitText) ? '#3e5f86' : /\bleather\b/.test(outfitText) ? '#2a1a12' : null;
    const next = c ? COLOURS[c] : material || (top ? p.outfit.color : OUTFIT_PALETTE[(OUTFIT_PALETTE.indexOf(p.outfit.color) + 1) % OUTFIT_PALETTE.length]);
    if (top && top !== p.outfit.top) { p.outfit.top = top; applied.push(`Top changed to a ${top.replace('_', ' ')}. ${TOP_NOTE}`); }
    if (next && next !== p.outfit.color) { p.outfit.color = next; applied.push(`Outfit colour changed to ${colourName(next)}. The full-body model's top uses this colour.`); }
  }
  // Skin.
  if (/\bskin\b|\bcomplexion\b|\bskin tone\b/.test(t)) {
    const f = /\bdarker\b|\bdeeper\b/.test(t) ? 0.8 : /\blighter\b|\bfairer\b|\bpaler\b/.test(t) ? 1.25 : 0;
    const named = skinIn(t);
    if (!f && named && SKIN_TONES[named] !== p.skin.tone) { p.skin.tone = SKIN_TONES[named]; applied.push(`Skin tone set to ${named}.`); }
    if (f && p.skin.tone) {
      const tone = shiftTone(p.skin.tone, f);
      if (tone) { p.skin.tone = tone; applied.push(`Skin tone made ${f < 1 ? 'deeper' : 'lighter'}.`); }
      else unsupported.push(`The skin tone cannot go any ${f < 1 ? 'deeper' : 'lighter'} and stay a realistic human skin colour.`);
    }
  }
  // Age.
  if (/\bolder\b/.test(t)) { p.body.age = round3(clamp(Number(p.body.age || 0) + 0.1, 0, 0.3)); applied.push('Made older (about 5 years).'); }
  else if (/\byounger\b/.test(t)) { p.body.age = round3(clamp(Number(p.body.age || 0) - 0.1, 0, 0.3)); applied.push('Made younger (about 5 years).'); }
  // Body: height, weight, muscle, proportions and a masculine or feminine build (MPFB macros, the BODY_* settings).
  bodyIntent(clauses, p, sh, applied);
  // Face sliders.
  for (const [re, keys, d, words] of SLIDER_EDITS) {
    if (!re.test(t)) continue;
    for (const k of [].concat(keys)) p.face[k] = round3(clamp(Number(p.face[k] || 0) + d, k === 'face_round' || k === 'face_oval' ? 0 : -1, 1));
    applied.push(`Face: ${words}.`);
  }
  for (const k of Object.keys(p.face)) if (!p.face[k]) delete p.face[k];
  unsupported.push(...notBuiltIn(t));
  if (!applied.length && !unsupported.length && !critique) {
    unsupported.push(`I can't change that yet. Try: make the hair longer, change the outfit, bigger eyes, taller, more muscular, make it photorealistic, high detail, cinematic lighting, show the skeleton, or animate walking.`);
  }
  return { params: p, style: s, render: r, shape: cleanShape(sh), applied, unsupported, viewport, critique };
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

/**
 * The newest saved model of a project, for reopening it from My Creations: the current version's own model when it
 * has one, else the nearest earlier version's, else any later one. { version, job_id, url, sha256, current } or null.
 */
export function lastModel(p, jobs) {
  const withModel = (x) => { const j = x.job_id ? jobs.find((y) => y.id === x.job_id) : null; return j?.model?.url ? { version: x.n, job_id: j.id, url: j.model.url, sha256: j.model.sha256 } : null; };
  const order = [...p.versions.slice(0, p.current + 1).reverse(), ...p.versions.slice(p.current + 1)];
  for (const x of order) { const m = withModel(x); if (m) return { ...m, current: x.n === cur(p).n }; }
  return null;
}

function summary(p, jobs) {
  const v = cur(p); const j = v.job_id ? jobs.find((x) => x.id === v.job_id) : null;
  return {
    id: p.id, kind: p.kind, title: p.title, base_id: p.base_id, version: v.n, versions: p.versions.length,
    can_undo: p.current > 0, can_redo: p.current < p.versions.length - 1, saved_at: p.saved_at, updated_at: p.updated_at, style: v.style,
    job: j ? { id: j.id, state: j.state, pct: j.progress?.pct ?? 0, message: j.progress?.message || '', updated_at: j.updated_at,
      owner_paused: Boolean(j.owner_paused), display_state: j.display_state || null, status_line: j.status_line || null } : null,
    previews: j ? { ...(j.previews || {}) } : {}, model_url: j?.model?.url || null,
    render: renderView(p, v), rig: j?.rig || null,
    ...(isThing(p) ? {} : { reference: refView(p, v.reference), reference_line: j?.reference_line || '', device_line: j?.device_line || '',
      shape: cleanShape(v.shape || {}), voice: v.voice || null, variation: Number(v.variation) || 0, description: p.description || null }),
    last_model: lastModel(p, jobs),
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

/** Which compute would build the next model right now, in one sentence. */
export function engineDeviceLine(engine) {
  const gpu = engine?.gpu && !/^CPU/.test(engine.gpu) ? engine.gpu : null;
  if (gpu) return `A GPU worker is connected: ${gpu}. It builds the next model.`;
  if (engine?.online || engine?.automatic) return 'No GPU is connected: your Colab GPU notebook is not open, so only the free GitHub cloud CPU worker is available. It builds on the CPU, which is slower than a GPU.';
  return 'No worker is connected right now: no GPU, and no free cloud CPU worker can start.';
}

function detail(p, jobs, engine) {
  const v = cur(p); const raw = v.job_id ? jobs.find((x) => x.id === v.job_id) : null;
  const { jobs: _all, ...eng } = engine;
  const sum = summary(p, jobs);
  // Before a build finishes, the device line says which compute is there now, and never calls the CPU a GPU.
  if (!isThing(p) && !sum.device_line) sum.device_line = engineDeviceLine(engine);
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
    if (String(body.description || '').trim()) return this.createDescribed(body);
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

  /**
   * One Create button: a described person (describePerson) becomes a project and, unless body.generate is false, is
   * queued at once. Words it cannot map are said plainly ("I can't make wings yet", "I did not use these words: ...").
   */
  async createDescribed(body) {
    const said = String(body.description || '').trim().slice(0, 300);
    const d = describePerson(said, (await listIdentities(this.storage)).presets);
    if (!d.ok) return { ok: false, refused: Boolean(d.refused), detail: d.detail };
    const bad = [...validate(d.params), ...shapeErrors(d.shape)];
    if (bad.length) return { ok: false, detail: `That description could not be built: ${bad.join('; ')}.` };
    const list = await load(this.storage);
    if (list.length >= MAX_PROJECTS) {
      return { ok: false, full: true, detail: `You have ${list.length} creations, the most CHE keeps. Nothing was removed; delete one you no longer need (CHE asks you first), then create again.` };
    }
    const t = this.now(); const id = `cr_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const title = String(body.title || said.replace(/^(?:an?|the)\s+/i, '').replace(/,.*$/, '')).slice(0, 80) || 'New person';
    const p = { id, kind: 'person', title: title[0].toUpperCase() + title.slice(1), base_id: d.base, description: said,
      created_at: iso(t), updated_at: iso(t), saved_at: null, current: 0,
      versions: [{ n: 1, at: iso(t), note: `Described: "${said.slice(0, 160)}".`, params: d.params, style: d.style, job_id: null,
        ...(Object.keys(d.shape).length ? { shape: d.shape } : {}), ...(Number(body.variation) > 0 ? { variation: Math.trunc(Number(body.variation)) } : {}) }] };
    list.push(p); await store(this.storage, list);
    const notes = [...d.unsupported, ...(d.unused.length ? [`I did not use these words: ${d.unused.join(', ')}.`] : [])].join(' ');
    const head = `${p.title} started. ${d.applied.filter((a) => !/^Look:/.test(a)).map((a) => a.replace(/ (?:Its strands are not built yet|The full-body model).*$/, '')).join(' ')} Look: ${STYLE_LABELS[d.style]}.${notes ? ` ${notes}` : ''}`;
    if (body.generate === false) return { ok: true, project: await this.detailOf(p), applied: d.applied, unsupported: d.unsupported, unused: d.unused, spoken: `${head} Say generate to build it.` };
    const gen = await this.generate(id);
    if (!gen.ok) return { ok: true, project: await this.detailOf(p), applied: d.applied, unsupported: d.unsupported, unused: d.unused, generated: false, spoken: `${head} It was not queued: ${gen.detail}` };
    return { ok: true, project: gen.project, job: gen.job, generated: true, applied: d.applied, unsupported: d.unsupported, unused: d.unused, spoken: `${head} ${gen.spoken}` };
  }

  /** A described person as a new version of an existing project (no reference photo, voice or variation carried). */
  async redescribe(id, description) {
    const { list, p } = await this.find(id);
    if (!p || isThing(p)) return { ok: false, detail: 'No such person creation.' };
    const d = describePerson(description, (await listIdentities(this.storage)).presets);
    if (!d.ok) return { ok: false, detail: d.detail };
    const next = this.pushVersion(p, `Described: "${String(description).slice(0, 160)}".`, { params: d.params, style: d.style,
      shape: Object.keys(d.shape).length ? d.shape : undefined, reference: undefined, voice: undefined, variation: undefined, render: undefined });
    p.description = String(description).slice(0, 300);
    await store(this.storage, list);
    return { ok: true, version: next.n };
  }

  /**
   * Create Object / Create Room: base is a family (lamp, chair, table, desk, mug, vase, shelf) or a room type. An object
   * may instead come from `description` (free text): a family word starts that family with the description's colour and
   * finish words applied; anything else is composed from primitives (creation_freeform.js) or refused with the reason.
   */
  async createThing(kind, body) {
    const said = kind === 'object' ? String(body.description || '').trim().slice(0, 200) : '';
    let base = String(body.base || (kind === 'object' ? 'lamp' : 'living_room')).toLowerCase();
    let spec; let composed = null; let firstNote = '';
    if (said) {
      const fam = /\b(?:desk|lamp|chair|table|mug|cup|vase|shelf|bookshelf|bookcase)\b/.exec(said.toLowerCase())?.[0];
      const famBase = fam && { cup: 'mug', bookshelf: 'shelf', bookcase: 'shelf' }[fam] || fam;
      const plain = famBase && OBJ.defaultSpec('object', famBase);
      // "a red chair" starts the chair family and applies "red"; "a chair made of balls" is still a chair (said back).
      if (plain && !OBJ.describedObject(said.replace(new RegExp(`\\b${fam}\\b`, 'i'), '')).ok) {
        base = famBase; const edit = OBJ.parseObjectEdit(said, plain);
        spec = OBJ.specErrors('object', edit.spec).length ? plain : edit.spec;
        firstNote = edit.applied.join(' ');
      } else {
        composed = OBJ.describedObject(said);
        if (!composed.ok) return { ok: false, unsupported: true, detail: composed.detail };
        spec = composed.spec; base = 'custom';
      }
    } else spec = OBJ.defaultSpec(kind, base);
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
      versions: [{ n: 1, at: iso(t), note: composed ? `Composed from your description: "${said}".` : said ? `Started from the ${base === 'desk' ? 'desk' : spec.family} defaults with "${said}".`
        : `Started from the ${kind === 'object' ? (base === 'desk' ? 'desk' : spec.family) : OBJ.ROOM_LABELS[spec.type]} defaults.`,
        params: spec, style: spec.style, render: { quality: 'standard' }, job_id: null }] };
    list.push(p); await store(this.storage, list);
    const project = await this.detailOf(p);
    if (composed) {
      const unused = composed.unused?.length ? ` I did not use these words: ${composed.unused.join(', ')}.` : '';
      return { ok: true, project, composed: true, unused: composed.unused || [],
        spoken: `${p.title} started: ${composed.made}.${unused} Say a change, or say generate to build it.` };
    }
    return { ok: true, project, spoken: `${p.title} started: ${OBJ.describeSpec(kind, spec)}.${firstNote ? ` ${firstNote}` : ''} Say a change, or say generate to build it.` };
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
      // Body macros and the variation seed only when set (so earlier versions queue the same settings as before); the
      // outfit colour reaches the full-body top (tools/avatar_body/mpfb_body.py reads OUTFIT_SRGB).
      const settings = { ...toSettings(v.params, v.style), ...renderSettings(r), ...shapeSettings(v.shape || {}), ...personExtras(v) };
      if (v.reference) {
        // The photo must still be stored: a version whose photo was deleted is not built as if it had one.
        const ref = v.reference;
        if (!(await mediaStore(this.env, this.storage).head(referenceKey(ref.sha256)))) {
          return { ok: false, detail: 'The reference photo for this version is no longer stored. Say remove the reference photo, or add it again, then generate.' };
        }
        // The worker's URL is resolved when a worker claims the job (gpu_queue.js claim: worker and job in the URL).
        settings.REFERENCE = JSON.stringify({ url: `/api/gpu/worker/reference?sha256=${ref.sha256}`, sha256: ref.sha256, bytes: ref.bytes, consent: ref.consent });
      }
      // Owner-interactive: high priority; a GPU is preferred, and a free cloud CPU worker takes it when none is online.
      out = await this.queue.enqueue({ kind: 'person_model', title: `${p.title} v${v.n}: 3D model and previews`, views: VIEWS, samples: q.samples, res: q.res,
        settings, queued_by: 'Live Studio', priority: 'high', requires: { gpu: 'preferred' } });
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
    const words = String(text || '').toLowerCase().replace(/[.!?]+$/g, '').replace(/^(?:che|chey|chay)[,:]?\s+/, '').trim();
    if (REGENERATE.test(words)) return this.regenerate(id);
    const voiceOut = await this.voiceEdit(list, p, v, words);
    if (voiceOut) return voiceOut;
    const r = parseEdit(text, v.params, v.style, renderOf(v), v.shape || {});
    const changed = JSON.stringify(r.params) !== JSON.stringify(v.params) || r.style !== v.style || JSON.stringify(r.render) !== JSON.stringify(renderOf(v))
      || JSON.stringify(r.shape) !== JSON.stringify(cleanShape(v.shape || {}));
    // "Critique this design": a parameter review of this version once it has a finished build, else an honest no.
    let critique = null;
    if (r.critique) {
      const engine = await this.engine();
      critique = critiqueOf(v, v.job_id ? engine.jobs.find((x) => x.id === v.job_id) : null);
    }
    if (changed) {
      const bad = [...validate(r.params), ...shapeErrors(r.shape)];
      if (bad.length) return { ok: true, changed: false, applied: [], unsupported: [`That change was not saved: ${bad.join('; ')}.`], viewport: r.viewport, spoken: `That change was not saved: ${bad.join('; ')}.`, project: await this.detailOf(p) };
      // Everything else on the version (reference photo, voice, variation) is carried into the new one.
      this.pushVersion(p, text, { params: r.params, style: r.style, render: r.render, shape: Object.keys(r.shape).length ? r.shape : undefined });
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

  /**
   * Voice words for a character (CHE's existing on-device Kokoro voices, CHARACTER_VOICES): list them as a numbered
   * list, choose one by number (a new version, so undo works), or ask to hear it (the app plays a short sample through
   * its own TTS path, only because the owner asked). Null when the words are not about the character's voice.
   */
  async voiceEdit(list, p, v, t) {
    if (!/\bvoices?\b/.test(t)) return null;
    const numbered = CHARACTER_VOICES.map((x, i) => `${i + 1}. ${x.name}`).join(' ');
    const reply = async (spoken, extra = {}) => ({ ok: true, changed: false, applied: [], unsupported: [], viewport: null, critique: null, spoken, ...extra, project: await this.detailOf(p) });
    let m;
    if ((m = /\b(?:choose|pick|use|select|set|give (?:her|him|them|it))?\s*(?:the )?voice (?:number )?(\d{1,2})\b|\bvoice (?:number )?(\d{1,2})\b/.exec(t))) {
      const n = Number(m[1] || m[2]); const chosen = CHARACTER_VOICES[n - 1];
      if (!chosen) return reply(`There is no voice ${n}. The voices are: ${numbered}`, { ok: false });
      if (v.voice?.id === chosen.id) return reply(`This character already uses voice ${n}, ${chosen.name}.`);
      const next = this.pushVersion(p, `Voice set to ${chosen.name}.`, { voice: { id: chosen.id, name: chosen.name, speaker: chosen.speaker } });
      await store(this.storage, list);
      return { ...(await reply(`Voice set to ${n}, ${chosen.name}. Saved as version ${next.n}. Say play the voice to hear it.`)), changed: true, applied: [`Voice set to ${chosen.name}.`] };
    }
    if (/\b(?:play|hear|preview|test|sample)\b/.test(t)) {
      const chosen = v.voice ? CHARACTER_VOICES.find((x) => x.id === v.voice.id) : null;
      if (!chosen) return reply(`This character has no voice yet. Choose one by number: ${numbered}`, { ok: false });
      return reply(`Playing voice ${CHARACTER_VOICES.indexOf(chosen) + 1}, ${chosen.name}.`,
        { play_voice: { id: chosen.id, name: chosen.name, speaker: chosen.speaker, text: `Hi, I'm ${p.title.replace(/\s*\(.*\)$/, '')}. This is my voice.` } });
    }
    if (/\b(?:deeper|lower|higher|softer|squeakier|raspier)\b/.test(t)) {
      return reply(`Character voices are fixed recorded voices with no pitch control, so I can't make one deeper or higher. The masculine voices are 6, 7, 10 and 11. Choose by number: ${numbered}`);
    }
    return reply(`Character voices: ${numbered} Say choose voice and a number.${v.voice ? ` This character uses ${v.voice.name}.` : ''}`);
  }

  /**
   * "Make another one" / "regenerate": a new version that is a deterministic variation of this one (the next VARIATION
   * seed moves every face slider a little, avatar_identity.js generateVariant) and is queued at once. The previous
   * version stays in the list: undo reopens it with its own model.
   */
  async regenerate(id) {
    const { list, p } = await this.find(id);
    if (!p) return { ok: false, status: 404, detail: 'No such creation.' };
    if (isThing(p)) return this.generate(id);
    const v = cur(p); const seed = Math.max(0, ...p.versions.map((x) => Number(x.variation) || 0)) + 1;
    const varied = generateVariant({ ...v.params, name: p.title }, { seed, amount: 0.15 });
    const params = { ...clone(v.params), face: varied.face };
    if (validate(params).length) return { ok: false, detail: `That variation could not be made: ${validate(params).join('; ')}.` };
    const next = this.pushVersion(p, `Variation ${seed}.`, { params, variation: seed });
    await store(this.storage, list);
    const out = await this.generate(id);
    if (!out.ok) return out;
    return { ...out, changed: true, applied: [`Variation ${seed}.`], spoken: `Made variation ${seed} as version ${next.n}: the face settings moved a little from version ${v.n}. ${out.spoken} Say undo to go back to version ${v.n}.` };
  }

  /** A new version from the current one with `changes` applied (the redo branch is dropped, as for an edit). */
  pushVersion(p, note, changes) {
    const v = cur(p); const t = this.now();
    p.versions = p.versions.slice(0, p.current + 1);
    const next = { ...clone(v), n: Math.max(...p.versions.map((x) => x.n)) + 1, at: iso(t), note: String(note).slice(0, 200), job_id: null, ...changes };
    for (const [k, val] of Object.entries(next)) if (val === undefined) delete next[k];
    p.versions.push(next);
    if (p.versions.length > MAX_VERSIONS) p.versions = p.versions.slice(-MAX_VERSIONS);
    p.current = p.versions.length - 1; p.updated_at = iso(t);
    return next;
  }

  /**
   * Adds a reference photo to a Create Person project as a new version. body: { image_base64, consent }. Consent must be
   * self (this is me) or fictional (fictional or generated); anything else is refused with the reason. JPEG or PNG only,
   * at most 8 MB, checked from the bytes; HEIC is refused with the reason (the app converts to JPEG before sending).
   */
  async setReference(id, body = {}) {
    const { list, p } = await this.find(id);
    if (!p) return { ok: false, status: 404, detail: 'No such creation.' };
    if (isThing(p)) return { ok: false, status: 422, detail: 'Reference photos are for Create Person characters only.' };
    const consent = String(body.consent || '').toLowerCase();
    if (!REFERENCE_CONSENTS[consent]) {
      return { ok: false, status: 422, refused: true, detail: `Not added. ${REFERENCE_RULE} Choose 1, this is me, or 2, fictional or generated.` };
    }
    const raw = String(body.image_base64 || '');
    if (!raw) return { ok: false, status: 400, detail: 'No photo was sent.' };
    if (raw.length > Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 64) return { ok: false, status: 413, detail: 'Not added: the photo is larger than 8 MB. Choose a smaller photo.' };
    const bytes = decodeBase64(raw);
    if (!bytes?.length) return { ok: false, status: 400, detail: 'Not added: the photo could not be read.' };
    if (bytes.length > MAX_REFERENCE_BYTES) return { ok: false, status: 413, detail: 'Not added: the photo is larger than 8 MB. Choose a smaller photo.' };
    const type = imageTypeOf(bytes);
    if (type === 'image/heic') {
      return { ok: false, status: 415, detail: 'Not added: this photo is HEIC, which CHE\'s server cannot read. The CHE app converts photos to JPEG before sending; send a JPEG or PNG.' };
    }
    if (!type) return { ok: false, status: 415, detail: 'Not added: only JPEG or PNG photos are accepted.' };
    const sha = await sha256Hex(bytes);
    const v = cur(p);
    if (v.reference?.sha256 === sha && v.reference.consent === consent) {
      return { ok: true, changed: false, spoken: `This version already uses that reference photo (${REFERENCE_CONSENTS[consent]}).`, project: await this.detailOf(p) };
    }
    const saved = await mediaStore(this.env, this.storage).put(referenceKey(sha), bytes, { contentType: type });
    if (!saved.ok) return { ok: false, status: 507, detail: `Not added: the photo could not be stored. ${saved.error || ''}`.trim() };
    const kind = type === 'image/png' ? 'PNG' : 'JPEG';
    const next = this.pushVersion(p, `Reference photo added (${REFERENCE_CONSENTS[consent]}).`,
      { reference: { sha256: sha, bytes: bytes.length, content_type: type, consent, at: iso(this.now()) } });
    await store(this.storage, list);
    return { ok: true, changed: true, reference: refView(p, next.reference),
      spoken: `Reference photo added: ${kb(bytes.length)} ${kind}, ${REFERENCE_CONSENTS[consent]}. Saved as version ${next.n}. Say generate to build the character from it; the likeness is approximate, not an exact copy.`,
      project: await this.detailOf(p) };
  }

  /**
   * The owner asked to remove the reference photo. Default: a new version without it (undo brings it back; the stored
   * photo stays while an earlier version names it). purge: removed from every version of this project and, when no
   * other creation uses it, deleted from storage; undo cannot bring it back.
   */
  async removeReference(id, { purge = false } = {}) {
    const { list, p } = await this.find(id);
    if (!p) return { ok: false, status: 404, detail: 'No such creation.' };
    const v = cur(p);
    if (!purge) {
      if (!v.reference) return { ok: false, detail: 'This version has no reference photo, so nothing was removed.', project: await this.detailOf(p) };
      const next = this.pushVersion(p, 'Reference photo removed.', { reference: undefined });
      await store(this.storage, list);
      return { ok: true, changed: true, spoken: `Removed the reference photo from this character, as you asked. Saved as version ${next.n}; say undo to bring it back. The photo stays stored while an earlier version uses it; say delete the reference photo completely to erase it.`, project: await this.detailOf(p) };
    }
    const shas = new Set(p.versions.map((x) => x.reference?.sha256).filter(Boolean));
    if (!shas.size) return { ok: false, detail: 'No version of this character has a reference photo, so nothing was deleted.', project: await this.detailOf(p) };
    for (const x of p.versions) delete x.reference;
    p.updated_at = iso(this.now());
    await store(this.storage, list);
    const media = mediaStore(this.env, this.storage); let erased = 0;
    for (const sha of shas) {
      const used = list.some((o) => o.id !== p.id && (o.versions || []).some((x) => x.reference?.sha256 === sha));
      if (!used) { await media.delete(referenceKey(sha)); erased += 1; }
    }
    const kept = shas.size - erased;
    return { ok: true, changed: true, purged: true, erased,
      spoken: `Deleted the reference photo${shas.size === 1 ? '' : 's'} from every version of this character${erased ? ' and from CHE\'s storage' : ''}, as you asked. Undo cannot bring ${shas.size === 1 ? 'it' : 'them'} back.${kept ? ` ${kept} stay stored because another creation uses ${kept === 1 ? 'it' : 'them'}.` : ''}`,
      project: await this.detailOf(p) };
  }

  /** Owner: the current version's reference photo bytes and type, or null. */
  async referenceBytes(id) {
    const { p } = await this.find(id);
    const r = p && cur(p).reference;
    if (!r) return null;
    const got = await mediaStore(this.env, this.storage).get(referenceKey(r.sha256));
    return got?.body?.length ? { bytes: got.body, contentType: r.content_type || got.contentType } : null;
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
  const m = /^\/api\/creations\/(cr_[a-f0-9]{12})(?:\/(generate|edit|undo|redo|save|reference))?$/.exec(path);
  if (!m) return json({ detail: 'Unknown creation route.' }, 404);
  if (m[2] === 'reference') {
    if (request.method === 'GET') {
      const got = await studio.referenceBytes(m[1]);
      if (!got) return json({ detail: 'This version has no reference photo.' }, 404);
      return new Response(got.bytes, { status: 200, headers: { 'Content-Type': got.contentType, 'Content-Length': String(got.bytes.length), 'Cache-Control': 'private, no-store' } });
    }
    if (request.method === 'POST') return send(await studio.setReference(m[1], body || {}), 201);
    if (request.method === 'DELETE') {
      const purge = /^(?:1|true|yes)$/.test(new URL(request.url).searchParams.get('purge') || '');
      return send(await studio.removeReference(m[1], { purge }));
    }
    return json({ detail: 'Use GET, POST or DELETE.' }, 405);
  }
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
