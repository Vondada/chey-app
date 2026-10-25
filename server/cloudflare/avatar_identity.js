// CHE's identity presets for the GPU face renderer (owner, 2026-10-24: one reusable, parametric generator instead of a
// new face each time). A preset holds a character's parameters in words (body, face sliders, skin, eyes, brows, lashes,
// hair, outfit); toSettings() turns a preset and a look (photoreal, hybrid, stylized) into the environment that
// tools/avatar_face/mpfb_dress.py reads, so the GPU job id names the identity and look. This is the same mapping as
// tools/avatar_face/identity.py; tools/test_avatar_identity.py checks both agree on every preset and look.
// Faces are original parameters. No preset is traced, measured or fitted from a photograph of a real person.
import { IDENTITIES } from './avatar_identity_presets.js';

export const STYLES = ['photoreal', 'hybrid', 'stylized'];
export const STYLE_LABELS = { photoreal: 'photorealistic', hybrid: 'hybrid game', stylized: 'stylized animated' };

// Face slider -> MakeHuman target pair [positive, negative]; "lr:" applies the l- and r- versions. Order matters: it
// fixes the FACE string, so the same preset always gives the same job id.
export const FACE_TARGETS = [
  ['eye_size', 'lr:eyes/eye-scale-incr', 'lr:eyes/eye-scale-decr'],
  ['eye_tilt', 'lr:eyes/eye-corner2-up', 'lr:eyes/eye-corner2-down'],
  ['eyefold', 'lr:eyes/eye-eyefold-down', 'lr:eyes/eye-eyefold-up'],
  ['nose_tip_width', 'nose/nose-point-width-incr', 'nose/nose-point-width-decr'],
  ['nose_width', 'nose/nose-scale-horiz-incr', 'nose/nose-scale-horiz-decr'],
  ['nose_length', 'nose/nose-scale-vert-incr', 'nose/nose-scale-vert-decr'],
  ['lip_upper', 'mouth/mouth-upperlip-volume-incr', 'mouth/mouth-upperlip-volume-decr'],
  ['lip_lower', 'mouth/mouth-lowerlip-volume-incr', 'mouth/mouth-lowerlip-volume-decr'],
  ['cupids_bow', 'mouth/mouth-cupidsbow-incr', 'mouth/mouth-cupidsbow-decr'],
  ['mouth_width', 'mouth/mouth-scale-horiz-incr', 'mouth/mouth-scale-horiz-decr'],
  ['cheek_volume', 'lr:cheek/cheek-volume-incr', 'lr:cheek/cheek-volume-decr'],
  ['cheekbones', 'lr:cheek/cheek-bones-incr', 'lr:cheek/cheek-bones-decr'],
  ['chin_width', 'chin/chin-width-incr', 'chin/chin-width-decr'],
  ['chin_height', 'chin/chin-height-incr', 'chin/chin-height-decr'],
  ['face_width', 'head/head-scale-horiz-incr', 'head/head-scale-horiz-decr'],
  ['face_round', 'head/head-round', null],
  ['face_oval', 'head/head-oval', null],
  ['brow_height', 'eyebrows/eyebrows-trans-up', 'eyebrows/eyebrows-trans-down'],
];
const SLIDERS = new Map(FACE_TARGETS.map(([k, p, n]) => [k, [p, n]]));
export const RACES = ['african', 'asian', 'caucasian'];
// Only long_wavy has strands today (CHE's own hair cards); the others render close-cropped until their strands exist.
export const HAIR_STYLES = ['long_wavy', 'wavy_medium', 'bun_high', 'bun_low', 'curly_short', 'afro', 'beanie', 'close_crop'];
export const HAIR_BUILT = ['long_wavy'];
export const MAX_CUSTOM = 50;
const HEX = /^#[0-9a-fA-F]{6}$/;
const IDENT_KEY = 'gpu:identities';

export const BUILT_IN = IDENTITIES.presets;
const BUILT_IN_IDS = new Set(BUILT_IN.map((p) => p.id));

/** A weight as identity.py prints it: at most 3 decimals, no trailing zeros ("0.3", "1"). */
export function num(w) {
  const r = Math.round(Number(w) * 1000) / 1000 + 0;
  return Number.isInteger(r) ? String(r) : r.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

const rgb = (h) => [1, 3, 5].map((i) => String(parseInt(h.slice(i, i + 2), 16))).join(',');

/** Problems with one preset, as plain sentences (empty when it is valid). */
// The same rule as mpfb_dress.py's skin check (linear albedo mean 0.008..0.6, red >= green >= blue), so the app cannot
// save or queue a tone the renderer would refuse.
const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
export function skinOk(h) {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16)));
  const m = (r + g + b) / 3;
  return m > 0.008 && m < 0.6 && r >= g && g >= b;
}

export function validate(p) {
  const out = [];
  if (!p || typeof p !== 'object') return ['preset must be an object'];
  if (!/^[a-z][a-z0-9_]{1,23}$/.test(String(p.id ?? ''))) out.push('id must be 2-24 lowercase letters, digits or _');
  const b = p.body || {};
  for (const [k, lo, hi] of [['sex', 0, 1], ['age', 0, 0.3], ['fit', 0, 1]]) {
    const v = Number(b[k] ?? 0);
    if (!(v >= lo && v <= hi)) out.push(`body.${k} must be ${lo}..${hi}`);
  }
  const race = b.race || {};
  const entries = Object.entries(race);
  if (!entries.length || entries.some(([r, w]) => !RACES.includes(r) || !(Number(w) >= 0 && Number(w) <= 1))) out.push('body.race mixes african, asian, caucasian (0..1)');
  for (const [k, w] of Object.entries(p.face || {})) {
    const v = Number(w);
    if (!SLIDERS.has(k)) out.push(`unknown face slider ${k}`);
    else if (!(v >= -1 && v <= 1)) out.push(`face.${k} must be -1..1`);
    else if (SLIDERS.get(k)[1] === null && v < 0) out.push(`face.${k} is 0..1`);
  }
  for (const path of ['skin.tone', 'eyes.iris', 'hair.color']) {
    const [a, c] = path.split('.');
    if (!HEX.test(String((p[a] || {})[c] ?? ''))) out.push(`${path} must be #rrggbb`);
  }
  const tone = String((p.skin || {}).tone ?? '');
  if (HEX.test(tone) && !skinOk(tone)) out.push('skin.tone must be a human skin albedo (red >= green >= blue, not lighter than about #e8c0a0)');
  if (!HAIR_STYLES.includes((p.hair || {}).style)) out.push(`hair.style must be one of ${HAIR_STYLES.join(', ')}`);
  return out;
}

/** The mpfb_dress.py environment for one preset and look. Keys are sorted, values are strings. */
export function toSettings(p, style = 'photoreal') {
  if (!STYLES.includes(style)) throw new Error(`style must be one of ${STYLES.join(', ')}`);
  const bad = validate(p);
  if (bad.length) throw new Error(bad.join('; '));
  const [b, f, sk, ey, br, la, ha] = ['body', 'face', 'skin', 'eyes', 'brows', 'lashes', 'hair'].map((k) => p[k] || {});
  const face = [];
  for (const [k, pos, neg] of FACE_TARGETS) {
    const w = Number(f[k] ?? 0);
    if (!w) continue;
    face.push(`${w > 0 ? pos : neg}=${num(Math.abs(w))}`);
  }
  const s = {
    IDENTITY: p.id, STYLE: style,
    RACE: RACES.filter((r) => r in b.race).map((r) => `${r}=${num(b.race[r])}`).join(','),
    SEX: num(b.sex ?? 0), MATURE: num(b.age ?? 0), FACE: face.join(','),
    TARGET_SRGB: rgb(sk.tone), PORES: num(sk.pores ?? 0.2),
    IRIS: num(ey.brightness ?? 2.0), IRIS_SRGB: rgb(ey.iris),
    BROW_N: String(Math.trunc(Number(br.density ?? 800))), BROW_W: num(br.width ?? 1.4), LASH_LEN: num(la.length ?? 0.55),
    HAIR_STYLE: ha.style, HAIR_SRGB: rgb(ha.color), STRANDS: String(Math.trunc(Number(ha.density ?? 90))),
  };
  // FIT_W: how strongly CHE's own landmark fit (fit.json) shapes the head; only presets that set body.fit use it.
  if (Number(b.fit ?? 0)) s.FIT_W = num(b.fit);
  if (!HAIR_BUILT.includes(ha.style)) s.NOHAIR = '1';
  return Object.fromEntries(Object.entries(s).sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0)));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate: a deterministic variation of a preset. Every face slider moves by up to ±amount, within its range. */
export function generateVariant(base, { seed = 1, amount = 0.25 } = {}) {
  const s = Math.abs(Math.trunc(Number(seed))) || 1;
  const amt = Math.min(Math.max(Number(amount) || 0.25, 0), 1);
  const rand = mulberry32(s);
  const face = {};
  for (const [k, , neg] of FACE_TARGETS) {
    const v = Number((base.face || {})[k] ?? 0) + (rand() * 2 - 1) * amt;
    const c = Math.min(Math.max(v, neg === null ? 0 : -1), 1);
    const r = Math.round(c * 100) / 100;
    if (r) face[k] = r;
  }
  const id = `${base.id}_v${s}`.slice(0, 24);
  return {
    ...structuredClone(base), id, name: `${base.name} variant ${s}`, base_id: base.id, base: base.base || base.id, seed: s, face,
    references: `A parameter variation of ${base.name} (seed ${s}, up to ±${amt} per face slider); never a photo fit.`,
  };
}

// ── Storage: saved custom presets and which preset each agent uses ──────────────────────────────────────────────
async function stored(storage) { return (await storage.get(IDENT_KEY)) || { custom: [], active: {} }; }

export async function listIdentities(storage) {
  const st = await stored(storage);
  const active = Object.fromEntries(BUILT_IN.map((p) => [p.id, st.active[p.id] || p.id]));
  return { presets: [...BUILT_IN.map((p) => ({ ...p, built_in: true })), ...st.custom.map((p) => ({ ...p, built_in: false }))], active };
}

async function findPreset(storage, id) {
  return BUILT_IN.find((p) => p.id === id) || (await stored(storage)).custom.find((p) => p.id === id) || null;
}

export async function savePreset(storage, preset) {
  const bad = validate(preset);
  if (bad.length) return { ok: false, detail: bad.join('; ') };
  if (BUILT_IN_IDS.has(preset.id)) return { ok: false, detail: `${preset.id} is a built-in preset; save the change under a new id.` };
  const st = await stored(storage);
  const rest = st.custom.filter((p) => p.id !== preset.id);
  if (rest.length >= MAX_CUSTOM) return { ok: false, detail: `At most ${MAX_CUSTOM} saved presets.` };
  const clean = JSON.parse(JSON.stringify(preset));
  delete clean.built_in;
  st.custom = [...rest, clean];
  await storage.put(IDENT_KEY, st);
  return { ok: true, preset: clean, replaced: rest.length !== st.custom.length - 1 };
}

export async function applyPreset(storage, agent, presetId) {
  if (!BUILT_IN_IDS.has(agent)) return { ok: false, detail: `Unknown agent ${agent}.` };
  const p = await findPreset(storage, presetId);
  if (!p) return { ok: false, detail: `No preset ${presetId}.` };
  const st = await stored(storage);
  st.active = { ...st.active, [agent]: p.id };
  await storage.put(IDENT_KEY, st);
  const who = BUILT_IN.find((x) => x.id === agent).name;
  return { ok: true, agent, preset_id: p.id, spoken: `${who} now uses the ${p.name} preset for new renders.` };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * /api/gpu/identities[/generate|/apply|/preview]. Called from gpuOwnerRoute, so the Worker's owner-device gate on
 * /api/gpu/* already applies. `queue` is the GpuQueue; previews go through its enqueue (same dedupe and job identity).
 */
export async function identityRoute(storage, queue, path, request, body) {
  if (path !== '/api/gpu/identities' && !path.startsWith('/api/gpu/identities/')) return null;
  if (path === '/api/gpu/identities' && request.method === 'GET') {
    const v = await listIdentities(storage);
    const custom = v.presets.length - BUILT_IN.length;
    return json({
      ...v, styles: STYLES, face_sliders: FACE_TARGETS.map(([k, , neg]) => ({ id: k, min: neg === null ? 0 : -1, max: 1 })),
      hair_styles: HAIR_STYLES, hair_built: HAIR_BUILT,
      spoken: `${BUILT_IN.length} built-in character presets and ${custom} saved preset${custom === 1 ? '' : 's'}. Each renders in three looks: photorealistic, hybrid and stylized.`,
    });
  }
  if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
  const b = body || {};
  if (path === '/api/gpu/identities') {
    const out = await savePreset(storage, b.preset);
    return json(out.ok ? { ...out, spoken: `Saved the ${out.preset.name || out.preset.id} preset on your CHE server.` } : out, out.ok ? 200 : 422);
  }
  if (path === '/api/gpu/identities/generate') {
    const base = await findPreset(storage, String(b.base_id || 'che'));
    if (!base) return json({ ok: false, detail: `No preset ${b.base_id}.` }, 404);
    const preset = generateVariant(base, { seed: b.seed ?? Math.floor(Math.random() * 1e6) + 1, amount: b.amount });
    return json({ ok: true, preset, saved: false, spoken: `Generated ${preset.name}. It is not saved yet.` });
  }
  if (path === '/api/gpu/identities/apply') {
    const out = await applyPreset(storage, String(b.agent || ''), String(b.preset_id || ''));
    return json(out, out.ok ? 200 : 422);
  }
  if (path === '/api/gpu/identities/preview') {
    const preset = b.preset && typeof b.preset === 'object' ? b.preset : await findPreset(storage, String(b.preset_id || ''));
    if (!preset) return json({ ok: false, detail: `No preset ${b.preset_id}.` }, 404);
    const bad = validate(preset);
    if (bad.length) return json({ ok: false, detail: bad.join('; ') }, 422);
    const styles = Array.isArray(b.styles) && b.styles.length ? b.styles : STYLES;
    if (styles.some((s) => !STYLES.includes(s))) return json({ ok: false, detail: `styles must be from ${STYLES.join(', ')}` }, 422);
    const jobs = [];
    for (const style of [...new Set(styles)]) {
      const out = await queue.enqueue({
        title: `${preset.name || preset.id}, ${STYLE_LABELS[style]}: front, three-quarter and side`, kind: 'face_preview',
        views: b.views || [0, 45, 90], samples: b.samples ?? 64, res: b.res ?? 480, settings: toSettings(preset, style), queued_by: 'Character Generator',
        priority: b.priority,   // Connect GPU's test job goes first (gpu_queue validates it; unknown values fall back to normal)
      });
      if (!out.ok) return json(out, 422);
      jobs.push({ style, job: out.job, duplicate: Boolean(out.duplicate) });
    }
    const fresh = jobs.filter((j) => !j.duplicate).length;
    return json({
      ok: true, preset_id: preset.id, jobs,
      spoken: `Queued ${fresh} preview job${fresh === 1 ? '' : 's'} for ${preset.name || preset.id}${fresh < jobs.length ? `; ${jobs.length - fresh} already waiting` : ''}. They render when your Colab T4 session runs the worker; nothing has rendered yet.`,
    }, 202);
  }
  return json({ detail: 'Unknown identity route.' }, 404);
}
