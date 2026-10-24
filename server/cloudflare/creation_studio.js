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
import { BUILT_IN, HAIR_BUILT, STYLES, STYLE_LABELS, listIdentities, skinOk, toSettings, validate } from './avatar_identity.js';
import { GpuQueue, VIEW_NAMES, gpuOwnerRoute, publicJob } from './gpu_queue.js';

export const PROJECTS_KEY = 'creations:projects';
export const MAX_PROJECTS = 100;
export const MAX_VERSIONS = 60;
export const NOTEBOOK_URL = 'https://colab.research.google.com/github/Vondada/chey-app/blob/main/notebooks/CHE_GPU_Face_Preview.ipynb';
export const VIEWS = [0, 45, 90];

export const CAPABILITIES = [
  { id: 'person', title: 'Create Person', status: 'available',
    detail: 'Start from CHE or a crew preset, edit by voice or typing, and build a real 3D head model with previews on your Creation Engine.' },
  { id: 'object', title: 'Create Object', status: 'unavailable',
    detail: 'Not built yet: CHE has no object modelling pipeline in Blender yet, so nothing is generated or simulated.' },
  { id: 'room', title: 'Create Room', status: 'unavailable',
    detail: 'Not built yet: rooms and environments have no generator yet; the Office and HQ rooms are fixed scenes.' },
  { id: 'animation', title: 'Create Animation', status: 'partial',
    detail: 'Preview the built-in clips on the bundled crew models; new animation renders are not built yet.' },
];

const iso = (ms) => new Date(ms).toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const clone = (x) => JSON.parse(JSON.stringify(x));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
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

/**
 * One sentence of owner words against a preset and look. Returns { params, style, applied, unsupported, viewport }:
 * params/style are the edited copies (unchanged when nothing applied), applied and unsupported are plain sentences.
 */
export function parseEdit(text, params, style) {
  const t = String(text || '').toLowerCase().replace(/[.!?]+$/g, '').replace(/^(?:che|chey|chay)[,:]?\s+/, '').trim();
  const p = clone(params); let s = style;
  const applied = []; const unsupported = []; let viewport = null;
  p.face = p.face || {}; p.hair = p.hair || {}; p.outfit = p.outfit || {}; p.eyes = p.eyes || {}; p.skin = p.skin || {}; p.body = p.body || {};

  // View commands: the viewport only, never a new version.
  let m;
  if ((m = /\b(?:rotate|turn|spin)\b(?: (?:the )?(?:model|character|head|it|her|him))?(?: (left|right))?(?: (?:by )?(-?\d{1,3}) ?(?:degrees?|°))?/.exec(t))) {
    const deg = m[2] ? Number(m[2]) : 45; viewport = { action: 'rotate', deg: m[1] === 'left' ? -Math.abs(deg) : deg };
    applied.push(`Rotating the view ${Math.abs(viewport.deg)} degrees ${viewport.deg < 0 ? 'left' : 'right'}.`);
  } else if (/\bzoom in\b|\bcloser\b/.test(t)) { viewport = { action: 'zoom', factor: 0.8 }; applied.push('Zooming in.'); }
  else if (/\bzoom out\b|\bfurther\b|\bfarther\b/.test(t)) { viewport = { action: 'zoom', factor: 1.25 }; applied.push('Zooming out.'); }
  else if (/\breset (?:the )?(?:view|camera)\b/.test(t)) { viewport = { action: 'reset' }; applied.push('View reset.'); }
  else if ((m = /\b(front|side|profile|three[- ]quarters?|back) view\b|\bshow (?:me )?the (front|side|back)\b/.exec(t))) {
    const w = m[1] || m[2]; const deg = /front/.test(w) ? 0 : /three/.test(w) ? 45 : /back/.test(w) ? 180 : 90;
    viewport = { action: 'view', deg }; applied.push(`Showing the ${w.replace('-', ' ')} view.`);
  } else if (/\banimate\b|\bmake (?:it|her|him|the character) (?:move|dance|wave|walk|talk)\b/.test(t)) {
    viewport = { action: 'animate' };
    applied.push('Playing an animation if the model in the viewport has clips. Generated head models have no rig yet, so only the bundled crew models animate.');
  }
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
  if (!applied.length && !unsupported.length) {
    unsupported.push(`I can't change that yet. Try: make the hair longer, change the outfit, bigger eyes, fuller lips, make it photorealistic, or rotate the model.`);
  }
  return { params: p, style: s, applied, unsupported, viewport };
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function load(storage) { return (await storage.get(PROJECTS_KEY)) || []; }
// Never evicts: at MAX_PROJECTS a new creation is refused (create below), so no saved work is dropped without the owner
// asking (AGENTS.md: deleting needs his yes; review of #520).
async function store(storage, list) { await storage.put(PROJECTS_KEY, list); }

async function engineOf(queue) {
  const v = await queue.view();
  const on = v.workers.filter((w) => w.online).sort((a, b) => (b.last_seen_ms || 0) - (a.last_seen_ms || 0));
  const last = v.workers.map((w) => w.last_seen).filter(Boolean).sort().pop() || null;
  const status = on.length ? 'online' : v.worker_paired ? 'offline' : 'not_paired';
  return { online: Boolean(on.length), gpu: on[0]?.gpu || null, paired: v.worker_paired, last_seen: last, notebook_url: NOTEBOOK_URL, status,
    label: { online: 'Creation Engine Online', offline: 'Creation Engine Offline', not_paired: 'Creation Engine not connected' }[status], jobs: v.jobs };
}

const cur = (p) => p.versions[p.current];

function summary(p, jobs) {
  const v = cur(p); const j = v.job_id ? jobs.find((x) => x.id === v.job_id) : null;
  return {
    id: p.id, kind: p.kind, title: p.title, base_id: p.base_id, version: v.n, versions: p.versions.length,
    can_undo: p.current > 0, can_redo: p.current < p.versions.length - 1, saved_at: p.saved_at, updated_at: p.updated_at, style: v.style,
    job: j ? { id: j.id, state: j.state, pct: j.progress?.pct ?? 0, message: j.progress?.message || '', updated_at: j.updated_at } : null,
    previews: j ? { ...(j.previews || {}) } : {}, model_url: j?.model?.url || null,
  };
}

/** Real stages from the job's own history, newest last: nothing here is inferred or simulated. */
function stagesOf(job) {
  if (!job) return [];
  return (job.history || []).map((h) => {
    const n = String(h.note || '');
    const label = /^Geometry ready/.test(n) ? 'Geometry ready' : /^Preview .* arrived/.test(n) ? n.replace(/\.$/, '')
      : h.state === 'queued' ? 'Queued' : h.state === 'rendering' ? (/^Resumed/.test(n) ? 'Resumed on the GPU' : 'Started on the GPU')
        : h.state === 'completed' ? 'Completed' : h.state === 'failed' ? 'Failed' : h.state === 'paused' ? 'Paused' : h.state === 'cancelled' ? 'Cancelled' : h.state;
    return { at: h.at, label, state: h.state, note: n };
  });
}

function detail(p, jobs, engine) {
  const v = cur(p); const raw = v.job_id ? jobs.find((x) => x.id === v.job_id) : null;
  const { jobs: _all, ...eng } = engine;
  const sum = summary(p, jobs);
  // detail.versions is the version list (the summary's count stays as versions_count).
  return { ...sum, versions_count: sum.versions, params: v.params, versions: p.versions.map((x) => ({ n: x.n, at: x.at, note: x.note, style: x.style, job_id: x.job_id })),
    job: raw || null, stages: stagesOf(raw), engine: eng };
}

function speakProject(p, jobs, engine) {
  const s = summary(p, jobs); const j = s.job;
  const job = !j ? 'No model built yet for this version. Say: generate the model.'
    : j.state === 'completed' ? 'The 3D model and previews for this version are ready.'
      : j.state === 'rendering' ? `Building now: ${j.message || 'on your Creation Engine'}.`
        : j.state === 'queued' || j.state === 'paused' ? `Waiting for the Creation Engine${engine.online ? '' : ', which is offline. Open Colab to start it'}.`
          : `The last build ${j.state}.`;
  return `${p.title}, version ${s.version} of ${s.versions}, ${STYLE_LABELS[s.style]} look. ${job}`;
}

export class CreationStudio {
  constructor(storage, now = () => Date.now()) { this.storage = storage; this.now = now; this.queue = new GpuQueue(storage, now); }

  async list() {
    const [projects, engine] = [await load(this.storage), await engineOf(this.queue)];
    const { jobs, ...eng } = engine;
    const out = [...projects].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).map((p) => summary(p, jobs));
    const active = out.filter((p) => p.job && ['queued', 'rendering', 'paused'].includes(p.job.state)).length;
    return { projects: out, engine: eng, capabilities: CAPABILITIES,
      spoken: `${out.length} creation${out.length === 1 ? '' : 's'}${active ? `, ${active} building or waiting` : ''}. ${eng.label}.` };
  }

  async create(body = {}) {
    if ((body.kind || 'person') !== 'person') {
      const cap = CAPABILITIES.find((c) => c.id === body.kind);
      return { ok: false, detail: cap ? cap.detail : 'Only people can be created so far.' };
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

  async find(id) { const list = await load(this.storage); return { list, p: list.find((x) => x.id === id) || null }; }

  async detailOf(p) { const engine = await engineOf(this.queue); return detail(p, engine.jobs, engine); }

  async get(id) {
    const { p } = await this.find(id);
    if (!p) return { ok: false, status: 404, detail: 'No such creation.' };
    const engine = await engineOf(this.queue);
    return { ok: true, project: detail(p, engine.jobs, engine), spoken: speakProject(p, engine.jobs, engine) };
  }

  async generate(id) {
    const { list, p } = await this.find(id);
    if (!p) return { ok: false, status: 404, detail: 'No such creation.' };
    const v = cur(p);
    const out = await this.queue.enqueue({ kind: 'person_model', title: `${p.title} v${v.n}: 3D model and previews`, views: VIEWS, samples: 64, res: 480,
      settings: toSettings(v.params, v.style), queued_by: 'Live Studio' });
    if (!out.ok) return { ok: false, detail: out.detail };
    v.job_id = out.job.id; p.updated_at = iso(this.now()); await store(this.storage, list);
    const engine = await engineOf(this.queue);
    const spoken = out.duplicate ? 'This version is already queued or building.'
      : engine.online ? `Queued. Your Creation Engine on ${engine.gpu} will build the 3D model, then front, three-quarter and side previews.`
        : `Queued. It builds when the Creation Engine is running; it is ${engine.status === 'not_paired' ? 'not connected yet' : 'offline now'}. Open Colab to start it.`;
    return { ok: true, job: publicJob(out.job), duplicate: Boolean(out.duplicate), spoken, project: detail(p, engine.jobs, engine) };
  }

  async edit(id, text) {
    const { list, p } = await this.find(id);
    if (!p) return { ok: false, status: 404, detail: 'No such creation.' };
    const v = cur(p);
    const r = parseEdit(text, v.params, v.style);
    const changed = JSON.stringify(r.params) !== JSON.stringify(v.params) || r.style !== v.style;
    if (changed) {
      const bad = validate(r.params);
      if (bad.length) return { ok: true, changed: false, applied: [], unsupported: [`That change was not saved: ${bad.join('; ')}.`], viewport: r.viewport, spoken: `That change was not saved: ${bad.join('; ')}.`, project: await this.detailOf(p) };
      const t = this.now();
      p.versions = p.versions.slice(0, p.current + 1);
      p.versions.push({ n: Math.max(...p.versions.map((x) => x.n)) + 1, at: iso(t), note: String(text).slice(0, 200), params: r.params, style: r.style, job_id: null });
      if (p.versions.length > MAX_VERSIONS) p.versions = p.versions.slice(-MAX_VERSIONS);
      p.current = p.versions.length - 1; p.updated_at = iso(t);
      await store(this.storage, list);
    }
    const n = cur(p).n;
    const spoken = [...r.applied, ...r.unsupported].join(' ') + (changed ? ` Saved as version ${n}. Say generate to build it.` : '');
    return { ok: true, changed, applied: r.applied, unsupported: r.unsupported, viewport: r.viewport, spoken: spoken.trim(), project: await this.detailOf(p) };
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

/** The owner's routes: /api/creations[/<id>[/generate|edit|undo|redo|save]]. Returns null for other paths. */
export async function creationRoute({ storage, now }, path, request, body = {}) {
  if (path !== '/api/creations' && !path.startsWith('/api/creations/')) return null;
  const studio = new CreationStudio(storage, now);
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

/** worker.js's one owner entry for the studio and the GPU queue under it (/api/creations*, then /api/gpu*). */
export async function studioOwnerRoute(ctx, path, request, body) {
  return (await creationRoute(ctx, path, request, body)) || gpuOwnerRoute(ctx, path, request, body);
}
