// CHE World population (owner, 2026-10-25: "populate CHE World with characters"). Three different things, never mixed:
//   (a) character RECORDS: a seeded description. A record is its seed (plus optional owner overrides); every field is
//       expanded on read by a fast seeded PRNG, so a population of any size is stored as one range {seed_start, count}.
//   (b) GENERATED MODELS: real rigged GLBs that Blender builds on the CPU worker through the EXISTING person_model job
//       (creation_studio.js / gpu_queue.js). Minutes each. Only BUCKETS get models: a bucket is style x body type x
//       hair x clothing (288 in all), and every record in a bucket reuses that one GLB with per-instance colour, scale
//       and face tweaks. A record never gets its own model unless the owner asks for one through Live Studio.
//   (c) ACTIVE characters: the ones on screen and animated now. Only the world viewer (assets/characters/app/
//       world_crowd.html) knows that number; the Worker never claims it.
// Identical seed + SCHEMA_VERSION always give an identical record (world_population.test.mjs). Changing any list below
// changes records, so it must bump SCHEMA_VERSION.
import { FACE_TARGETS, HAIR_BUILT, HAIR_STYLES, STYLES, STYLE_LABELS, skinOk, toSettings, validate } from './avatar_identity.js';
import { TOP_VOICES } from './voice_catalog.js';
import { DEFAULT_RENDER, VIEWS, qualityOf, renderSettings } from './creation_studio.js';

export const SCHEMA_VERSION = 1;
export const WORLD_KEY = 'world:populations';
export const BUCKETS_KEY = 'world:buckets';
export const overridesKey = (world) => `world:overrides:${world}`;
export const DEFAULT_WORLD = Object.freeze({ id: 'che_world', seed_start: 1, count: 100000 });
export const MAX_SEED = 0xffffffff;
export const MAX_PAGE = 200;
export const MAX_OVERRIDES = 1000;

// ── Bucket axes (bounded: 3 x 4 x 8 x 3 = 288 shared base models) ─────────────────────────────────────────────────
export const BODY_TYPES = Object.freeze(['feminine_slim', 'feminine_full', 'masculine_slim', 'masculine_full']);
export const CLOTHING = Object.freeze(['jacket', 'hoodie', 'sweater']);   // the tops the crew presets already use
export const BUCKET_AXES = Object.freeze({ style: STYLES, body: BODY_TYPES, hair: HAIR_STYLES, top: CLOTHING });
export const BUCKET_COUNT = STYLES.length * BODY_TYPES.length * HAIR_STYLES.length * CLOTHING.length;

// ── Per-instance palettes ─────────────────────────────────────────────────────────────────────────────────────────
// Skin tones the renderer accepts (the same list the Character Generator offers; skinOk filters any it would refuse).
export const SKIN_TONES = Object.freeze(['#e4bb9c', '#e3b597', '#e7b48e', '#e2b089', '#dca27a', '#d7a986', '#d29a72', '#c98b62',
  '#a8704a', '#8c5a3c', '#7a4a2e', '#603826', '#502e20'].filter(skinOk));
export const IRIS = Object.freeze(['#4a2e1c', '#4a3220', '#5a3a22', '#5e3e28', '#6a4a2e', '#4e3a52', '#5f6b45', '#4f7fb5', '#6f8a9a']);
export const HAIR_COLORS = Object.freeze(['#141010', '#16110e', '#1a1210', '#2a1a12', '#3b2416', '#4a2c1c', '#6a2e1a', '#8a2a16',
  '#b0521e', '#d8b46a', '#8a8580', '#8d64d6']);
export const OUTFIT_COLORS = Object.freeze(['#1f6f78', '#b79be6', '#e8732e', '#e9dcc8', '#3e5f86', '#56603e', '#d89a2a', '#3a5574',
  '#1d2b4a', '#4a525c', '#8a2a3a', '#2f6b3f', '#c8c2b4', '#202226']);
// Voices: the Edge neural voices from the existing voice catalog (voice_catalog.js, the one that needs no key or server).
const EDGE = TOP_VOICES.find((v) => v.id === 'edge');
export const VOICES = Object.freeze({
  feminine: ['en-US-AvaNeural', 'en-US-EmmaNeural', 'en-US-JennyNeural', 'en-US-AriaNeural', 'en-GB-SoniaNeural', 'en-AU-NatashaNeural'],
  masculine: ['en-US-AndrewNeural', 'en-US-BrianNeural', 'en-US-GuyNeural', 'en-US-ChristopherNeural', 'en-GB-RyanNeural', 'en-AU-WilliamNeural'],
});
// Fictional given names built from syllables (never a real person's record).
const SYL_A = ['ka', 'mi', 'lo', 'ra', 'ze', 'no', 'ta', 'vi', 'sa', 'jo', 'ne', 'ri', 'da', 'lu', 'be', 'ko'];
const SYL_B = ['ren', 'la', 'mir', 'tan', 'ya', 'vel', 'so', 'dan', 'ra', 'lin', 'ko', 'sha', 'ver', 'mo', 'ni', 'th'];

/** A 32-bit avalanche hash (lowbias32): spreads neighbouring seeds so records 1 and 2 look unrelated. */
function mix32(x) {
  x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
/** mulberry32: a fast seeded PRNG, the same one avatar_identity.generateVariant uses. */
function prng(seed) {
  let a = mix32((seed ^ Math.imul(SCHEMA_VERSION, 0x9e3779b9)) >>> 0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (v) => Math.round(v * 100) / 100;
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

export function validSeed(seed) { const s = Number(seed); return Number.isInteger(s) && s >= 0 && s <= MAX_SEED; }

export function bucketKey(style, body, hair, top) { return `${style}.${body}.${hair}.${top}`; }
/** The bucket's index 0..287 (stable for a schema version), or -1 for a key that is not a bucket. */
export function bucketIndex(key) {
  const [s, b, h, t] = String(key).split('.');
  const i = [STYLES.indexOf(s), BODY_TYPES.indexOf(b), HAIR_STYLES.indexOf(h), CLOTHING.indexOf(t)];
  if (i.some((x) => x < 0) || String(key).split('.').length !== 4) return -1;
  return ((i[0] * BODY_TYPES.length + i[1]) * HAIR_STYLES.length + i[2]) * CLOTHING.length + i[3];
}
export function bucketAt(index) {
  let n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n >= BUCKET_COUNT) return null;
  const t = CLOTHING[n % CLOTHING.length]; n = Math.floor(n / CLOTHING.length);
  const h = HAIR_STYLES[n % HAIR_STYLES.length]; n = Math.floor(n / HAIR_STYLES.length);
  const b = BODY_TYPES[n % BODY_TYPES.length]; n = Math.floor(n / BODY_TYPES.length);
  return bucketKey(STYLES[n], b, h, t);
}

/**
 * The full description of one record, expanded from its seed. Deterministic: no clock, no Math.random.
 * `overrides` (the owner's saved changes to this one record) are merged last and re-validated.
 */
export function expandRecord(seed, overrides = null) {
  if (!validSeed(seed)) throw new Error(`seed must be an integer 0..${MAX_SEED}`);
  const rand = prng(seed);
  const style = pick(rand, STYLES);
  const body = pick(rand, BODY_TYPES);
  const hair = pick(rand, HAIR_STYLES);
  const top = pick(rand, CLOTHING);
  const fem = body.startsWith('feminine');
  const full = body.endsWith('full');
  const sex = r2(fem ? rand() * 0.25 : 0.75 + rand() * 0.25);
  // MakeHuman ethnic mix: one dominant weight and a second share, always summing to 1.
  const races = ['african', 'asian', 'caucasian'];
  const main = Math.floor(rand() * 3); const second = (main + 1 + Math.floor(rand() * 2)) % 3; const share = r2(rand() * 0.5);
  const race = { [races[main]]: r2(1 - share) };
  if (share > 0) race[races[second]] = share;
  const face = {};
  for (const [k, , neg] of FACE_TARGETS) {
    const v = r2(neg === null ? rand() * 0.6 : (rand() * 2 - 1) * 0.6);
    if (v) face[k] = v;
  }
  const name = (pick(rand, SYL_A) + pick(rand, SYL_B) + (rand() < 0.4 ? pick(rand, SYL_A) : ''));
  const rec = {
    seed, schema_version: SCHEMA_VERSION, kind: 'record',
    name: name[0].toUpperCase() + name.slice(1), style,
    body: { type: body, sex, age: r2(rand() * 0.3), race, build: full ? 'full' : 'slim', height_scale: r2(0.92 + rand() * 0.16) },
    face,
    skin: { tone: pick(rand, SKIN_TONES), pores: r2(0.1 + rand() * 0.2) },
    eyes: { iris: pick(rand, IRIS), brightness: r2(2 + rand() * 0.8) },
    brows: { density: 600 + Math.floor(rand() * 600), width: r2(1 + rand()) },
    lashes: { length: r2(0.45 + rand() * 0.25) },
    hair: { style: hair, color: pick(rand, HAIR_COLORS), density: 90, built: HAIR_BUILT.includes(hair) },
    outfit: { top, color: pick(rand, OUTFIT_COLORS), ...(rand() < 0.2 ? { glasses: '#1d1a18' } : {}) },
    voice: { catalog: EDGE ? EDGE.id : 'edge', name: pick(rand, fem ? VOICES.feminine : VOICES.masculine) },
  };
  if (overrides && typeof overrides === 'object') applyOverrides(rec, overrides);
  const key = bucketKey(rec.style, rec.body.type, rec.hair.style, rec.outfit.top);
  rec.bucket = { key, index: bucketIndex(key) };
  // What the shared bucket GLB needs to look like this record (the viewer applies these per instance).
  rec.variation = { scale: rec.body.height_scale, skin: rec.skin.tone, hair: rec.hair.color, outfit: rec.outfit.color, face_sliders: Object.keys(rec.face).length };
  return rec;
}

const OVERRIDABLE = { name: 'string', style: STYLES, body: 'object', face: 'object', skin: 'object', eyes: 'object', hair: 'object', outfit: 'object', voice: 'object' };
function applyOverrides(rec, o) {
  for (const [k, v] of Object.entries(o)) {
    const rule = OVERRIDABLE[k];
    if (!rule) continue;
    if (Array.isArray(rule)) { if (rule.includes(v)) rec[k] = v; } else if (rule === 'string') { if (typeof v === 'string' && v.trim()) rec[k] = v.trim().slice(0, 40); } else if (v && typeof v === 'object') rec[k] = { ...rec[k], ...v };
  }
  if (!BODY_TYPES.includes(rec.body.type)) rec.body.type = rec.body.sex < 0.5 ? 'feminine_slim' : 'masculine_slim';
  if (!CLOTHING.includes(rec.outfit.top)) rec.outfit.top = 'jacket';
  rec.hair.built = HAIR_BUILT.includes(rec.hair.style);
}

/** A record as an identity preset (avatar_identity.validate passes), so one record can still get its own model. */
export function recordPreset(rec) {
  const p = {
    id: `w${rec.seed.toString(36)}`.slice(0, 24), name: rec.name, role: 'CHE World resident',
    body: { sex: rec.body.sex, age: rec.body.age, race: rec.body.race }, face: rec.face, skin: rec.skin, eyes: rec.eyes,
    brows: rec.brows, lashes: rec.lashes, hair: { style: rec.hair.style, color: rec.hair.color, density: rec.hair.density },
    outfit: rec.outfit, references: `CHE World record ${rec.seed} (schema ${rec.schema_version}); generated parameters, never a photo fit.`,
  };
  return p;
}

/** The neutral base preset a bucket's shared GLB is built from (average face, mid colours; instances recolour it). */
export function bucketPreset(key) {
  const i = bucketIndex(key);
  if (i < 0) return null;
  const [style, body, hair, top] = key.split('.');
  const fem = body.startsWith('feminine');
  const preset = {
    id: `wb${i}`, name: `World base ${i}`, role: 'CHE World shared base model',
    body: { sex: fem ? 0.1 : 0.9, age: 0.1, race: { african: 0.34, asian: 0.33, caucasian: 0.33 } }, face: {},
    skin: { tone: '#c98b62', pores: 0.2 }, eyes: { iris: '#5a3a22', brightness: 2.2 }, brows: { density: 800, width: 1.4 }, lashes: { length: 0.55 },
    hair: { style: hair, color: '#2a1a12', density: 90 }, outfit: { top, color: '#4a525c' },
    references: `Shared base for bucket ${key}; every CHE World record in it reuses this model with its own colours and scale.`,
  };
  return { key, index: i, style, body, hair, top, preset };
}

// ── Populations: stored as ranges ────────────────────────────────────────────────────────────────────────────────
export async function loadWorlds(storage) {
  const st = (await storage.get(WORLD_KEY)) || {};
  const worlds = { [DEFAULT_WORLD.id]: { ...DEFAULT_WORLD, default: true }, ...(st.worlds || {}) };
  return worlds;
}
export async function getWorld(storage, id = DEFAULT_WORLD.id) { return (await loadWorlds(storage))[id] || null; }

export function checkRange(seedStart, count) {
  const s = Number(seedStart); const c = Number(count);
  if (!validSeed(s)) return `seed_start must be an integer 0..${MAX_SEED}`;
  if (!Number.isInteger(c) || c < 0) return 'count must be a whole number, 0 or more';
  if (s + c - 1 > MAX_SEED) return `seed_start + count must stay within ${MAX_SEED + 1} seeds`;
  return '';
}

export async function setWorld(storage, { id = DEFAULT_WORLD.id, seed_start, count } = {}) {
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(String(id))) return { ok: false, detail: 'world must be 2-32 lowercase letters, digits or _' };
  const cur = await getWorld(storage, id);
  const s = seed_start ?? cur?.seed_start ?? 1; const c = count ?? cur?.count ?? 0;
  const bad = checkRange(s, c);
  if (bad) return { ok: false, detail: bad };
  const st = (await storage.get(WORLD_KEY)) || {};
  st.worlds = { ...(st.worlds || {}), [id]: { id, seed_start: Number(s), count: Number(c) } };
  await storage.put(WORLD_KEY, st);
  return { ok: true, world: st.worlds[id], spoken: `${id.replace(/_/g, ' ')} now holds ${Number(c).toLocaleString('en-US')} character records. Records are descriptions only; no model was built.` };
}

export async function loadOverrides(storage, world) { return (await storage.get(overridesKey(world))) || {}; }

export async function saveOverride(storage, world, seed, overrides) {
  const w = await getWorld(storage, world);
  if (!w) return { ok: false, status: 404, detail: `No world ${world}.` };
  if (!validSeed(seed) || seed < w.seed_start || seed >= w.seed_start + w.count) return { ok: false, status: 404, detail: `Seed ${seed} is not in ${world}.` };
  if (!overrides || typeof overrides !== 'object') return { ok: false, detail: 'overrides must be an object' };
  const all = await loadOverrides(storage, world);
  const merged = { ...(all[seed] || {}), ...overrides };
  const rec = expandRecord(seed, merged);
  const bad = validate(recordPreset(rec));
  if (bad.length) return { ok: false, detail: bad.join('; ') };
  if (!all[seed] && Object.keys(all).length >= MAX_OVERRIDES) return { ok: false, detail: `At most ${MAX_OVERRIDES} edited records per world.` };
  all[seed] = merged;
  await storage.put(overridesKey(world), all);
  return { ok: true, record: rec, spoken: `Saved your change to ${rec.name}.` };
}

// ── Generated models (buckets) ───────────────────────────────────────────────────────────────────────────────────
/** Bucket key -> {job_id, queued_at}, and each job's real state from the GPU queue. */
export async function bucketStates(storage, queue) {
  const map = (await storage.get(BUCKETS_KEY)) || {};
  const jobs = queue ? await queue.jobs() : [];
  const out = {};
  for (const [key, v] of Object.entries(map)) {
    const j = jobs.find((x) => x.id === v.job_id);
    out[key] = { key, index: bucketIndex(key), job_id: v.job_id, queued_at: v.queued_at, state: j ? j.state : 'unknown',
      model: j?.model ? { bytes: j.model.bytes, url: `/api/gpu/jobs/${j.id}/model.glb` } : null };
  }
  return out;
}
export function modelCounts(states) {
  const v = Object.values(states);
  return { generated: v.filter((b) => b.state === 'completed' && b.model).length,
    building: v.filter((b) => ['queued', 'rendering', 'paused'].includes(b.state)).length,
    failed: v.filter((b) => ['failed', 'cancelled'].includes(b.state)).length };
}

/**
 * Queue one bucket's shared model through the existing Creation Studio path: the same person_model job, settings and
 * capacity check that Live Studio's Generate uses (CreationStudio.queue, renderSettings, capacity()), at normal
 * priority so the owner's own creations go first. Nothing in creation_studio.js or gpu_queue.js is changed.
 */
export async function generateBucket(storage, key, { studio, render } = {}) {
  const b = bucketPreset(key);
  if (!b) return { ok: false, status: 404, detail: `${key} is not a CHE World bucket. Buckets are style.body.hair.top, for example photoreal.feminine_slim.long_wavy.jacket.` };
  const r = { ...DEFAULT_RENDER, ...(render || {}) }; const q = qualityOf(r);
  const out = await studio.queue.enqueue({ kind: 'person_model', title: `CHE World base model ${b.index}: ${STYLE_LABELS[b.style]}, ${b.body.replace('_', ' ')}, ${b.hair.replace('_', ' ')}, ${b.top}`,
    views: VIEWS, samples: q.samples, res: q.res, settings: { ...toSettings(b.preset, b.style), ...renderSettings(r) }, queued_by: 'CHE World population', priority: 'normal', requires: { gpu: 'preferred' } });
  if (!out.ok) return { ok: false, detail: out.detail, limited: Boolean(out.limited) };
  const map = (await storage.get(BUCKETS_KEY)) || {};
  map[key] = { job_id: out.job.id, queued_at: map[key]?.job_id === out.job.id ? map[key].queued_at : new Date(studio.now()).toISOString() };
  await storage.put(BUCKETS_KEY, map);
  await studio.capacity();
  const hairNote = HAIR_BUILT.includes(b.hair) ? '' : ` This hair style has no strands yet, so the model renders close-cropped.`;
  return { ok: true, bucket: key, index: b.index, job: { id: out.job.id, state: out.job.state }, duplicate: Boolean(out.duplicate),
    spoken: out.duplicate ? `Base model ${b.index} is already queued or building.` : `Queued base model ${b.index} on the Creation Engine. A CPU build takes minutes; every record in this bucket will reuse it.${hairNote}` };
}

// ── Spoken and counted views ─────────────────────────────────────────────────────────────────────────────────────
export function summarizeCounts(world, models) {
  return {
    records: world.count, seed_start: world.seed_start, seed_end: world.count ? world.seed_start + world.count - 1 : null,
    buckets_total: BUCKET_COUNT, models_generated: models.generated, models_building: models.building, models_failed: models.failed,
    // Only the world viewer knows (c); the Worker never invents it.
    active: null, active_note: 'Active characters are counted by the world viewer on the phone while it is open.',
  };
}
export function speakPopulation(world, counts) {
  const n = (x) => Number(x).toLocaleString('en-US');
  const name = world.id === DEFAULT_WORLD.id ? 'CHE World' : world.id.replace(/_/g, ' ');
  return `${name} has ${n(counts.records)} character record${counts.records === 1 ? '' : 's'}: seeded descriptions, not built models. `
    + `${n(counts.models_generated)} of ${n(counts.buckets_total)} shared base models are generated${counts.models_building ? `, ${n(counts.models_building)} building` : ''}; every record reuses one of them. `
    + 'How many are active on screen is known only while the world viewer is open.';
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const summaryOf = (r) => ({ seed: r.seed, name: r.name, style: r.style, body: r.body.type, hair: r.hair.style, top: r.outfit.top, bucket: r.bucket.key, bucket_index: r.bucket.index,
  variation: r.variation, voice: r.voice.name });

/** The spoken answer for the Command Center's /world-population (no model call). */
export async function populationAnswer(storage, queue, world = DEFAULT_WORLD.id) {
  const w = await getWorld(storage, world);
  if (!w) return { ok: false, spoken: `There is no world called ${world}.` };
  const counts = summarizeCounts(w, modelCounts(await bucketStates(storage, queue)));
  return { ok: true, world: w, counts, spoken: speakPopulation(w, counts) };
}

/**
 * Owner routes (worker.js applies the owner-device gate first):
 *   GET  /api/world/population?world=&offset=&limit=   counts + one page of expanded records (read-only)
 *   POST /api/world/population {world, seed_start, count} sets a world's range (records only; nothing is built)
 *   GET  /api/world/record/<seed>?world=               one full record
 *   POST /api/world/record/<seed> {world, overrides}   saves the owner's change to one record
 *   GET  /api/world/buckets                            the 288 buckets and which have models
 *   POST /api/world/buckets/<key>/generate             queues that bucket's shared model (person_model job)
 * `makeStudio()` returns a CreationStudio; it is only built when a route needs the queue.
 */
export async function worldRoute(ctx, path, request, body = {}) {
  if (!path.startsWith('/api/world/')) return null;
  const { storage, makeStudio } = ctx;
  const q = new URL(request.url).searchParams;
  const worldId = String(body?.world || q.get('world') || DEFAULT_WORLD.id);
  if (path === '/api/world/population') {
    if (request.method === 'POST') { const out = await setWorld(storage, { id: worldId, seed_start: body?.seed_start, count: body?.count }); return json(out, out.ok ? 200 : 422); }
    if (request.method !== 'GET') return json({ detail: 'Use GET or POST.' }, 405);
    const w = await getWorld(storage, worldId);
    if (!w) return json({ ok: false, detail: `No world ${worldId}.` }, 404);
    const offset = Math.max(0, Math.trunc(Number(q.get('offset')) || 0));
    const limit = Math.min(MAX_PAGE, Math.max(0, Math.trunc(Number(q.get('limit') ?? 20))));
    const over = await loadOverrides(storage, worldId);
    const records = [];
    for (let i = offset; i < Math.min(w.count, offset + limit); i += 1) { const s = w.seed_start + i; records.push(summaryOf(expandRecord(s, over[s] || null))); }
    const studio = makeStudio();
    const counts = summarizeCounts(w, modelCounts(await bucketStates(storage, studio.queue)));
    return json({ ok: true, world: w, schema_version: SCHEMA_VERSION, counts, offset, limit, records, spoken: speakPopulation(w, counts) });
  }
  const rm = /^\/api\/world\/record\/(\d{1,10})$/.exec(path);
  if (rm) {
    const seed = Number(rm[1]);
    const w = await getWorld(storage, worldId);
    if (!w) return json({ ok: false, detail: `No world ${worldId}.` }, 404);
    if (!validSeed(seed) || seed < w.seed_start || seed >= w.seed_start + w.count) return json({ ok: false, detail: `Seed ${seed} is not in ${worldId}.` }, 404);
    if (request.method === 'POST') { const out = await saveOverride(storage, worldId, seed, body?.overrides); return json(out, out.ok ? 200 : (out.status || 422)); }
    if (request.method !== 'GET') return json({ detail: 'Use GET or POST.' }, 405);
    const rec = expandRecord(seed, (await loadOverrides(storage, worldId))[seed] || null);
    const states = await bucketStates(storage, makeStudio().queue);
    const b = states[rec.bucket.key];
    return json({ ok: true, world: worldId, record: rec, model: b ? { state: b.state, url: b.model?.url || null } : { state: 'not_generated', url: null },
      spoken: `${rec.name}: ${STYLE_LABELS[rec.style]} look, ${rec.body.type.replace('_', ' ')}, ${rec.hair.style.replace('_', ' ')} hair, ${rec.outfit.top}. Shared base model ${rec.bucket.index}${b?.model ? ' is generated' : ' is not generated yet'}.` });
  }
  if (path === '/api/world/buckets') {
    if (request.method !== 'GET') return json({ detail: 'Use GET.' }, 405);
    const states = await bucketStates(storage, makeStudio().queue);
    return json({ ok: true, total: BUCKET_COUNT, axes: BUCKET_AXES, buckets: Object.values(states), counts: modelCounts(states) });
  }
  const gm = /^\/api\/world\/buckets\/([a-z_.]{3,80})\/generate$/.exec(path);
  if (gm) {
    if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
    const out = await generateBucket(storage, gm[1], { studio: makeStudio(), render: body?.render });
    return json(out, out.ok ? 202 : (out.status || 409));
  }
  return json({ detail: 'Unknown world route.' }, 404);
}

/** "How many characters live in CHE World", "CHE World population": the spoken form of /world-population. */
export function worldPopulationIntent(text) {
  const t = String(text || '').toLowerCase().replace(/[’']/g, "'").trim();
  if (/\b(?:che|chey|chay) world\b/.test(t) && /\b(?:how many|population|count)\b/.test(t) && /\b(?:characters?|people|residents?|population|records?|models?)\b/.test(t)) return { command: 'world-population' };
  if (/^(?:show |read |open )?(?:the )?world population$/.test(t.replace(/[.?!]+$/, ''))) return { command: 'world-population' };
  return null;
}
