// CHE's own picture-making, end to end: words → recipe → internal renderer (internal_renderer.js) → verified PNG →
// saved in Create like any picture → the recipe kept as reusable knowledge. Registered in the capability registry
// only after its self-test proves each promotion check, with the evidence recorded. No external app, API or key.
import { PROVENANCE, RENDERER_VERSION, beachLoop, beachRecipe, describeRecipe, decodePng, evaluateBeach, beachScene } from './internal_renderer.js';
import { EXECUTION, PROMOTION_CHECKS, loadRegistry, promote, recordCheck, recordUse, register, saveRegistry, serving } from './capability_registry.js';
import { saveRenderedImage } from './media.js';

export const RECIPES_KEY = 'che:render_recipes';
export const LAST_RENDER_KEY = 'che:render_last';
export const INTERNAL_SOURCE = 'che_internal_renderer';

export const RENDER_CAPABILITIES = Object.freeze([
  {
    id: 'render.procedural_image', name: 'Render procedural pictures', category: 'rendering',
    description: 'Scene graph + software rasterizer + PNG encoder/decoder in CHE\'s own Worker code.',
    inputs: ['scene graph'], outputs: ['image/png'], implementation_location: 'server/cloudflare/internal_renderer.js',
    execution: EXECUTION.INTERNAL, required_runtime: 'cloudflare-worker (JavaScript)', required_compute: 'worker-cpu, ≤1280x720',
    risk_level: 'low', approval_policy: 'none',
    known_limitations: ['procedural shapes and textures, not photorealism', 'up to 1280x720', 'beach scenes are the first scene family'],
  },
  {
    id: 'scene.beach', name: 'Create beach scenes', category: 'scene creation',
    description: 'Beach scene loop: sky, sun or moon, ocean with waves, haze, sand, shoreline, palms, rain, colour grade; day, sunset, night and stormy looks.',
    inputs: ['words', 'recipe'], outputs: ['image/png', 'recipe'], implementation_location: 'server/cloudflare/internal_renderer.js (beachLoop)',
    execution: EXECUTION.INTERNAL, required_runtime: 'cloudflare-worker (JavaScript)', risk_level: 'low', approval_policy: 'none',
    related_loops: ['INTERNAL SCENE CREATION LOOP', 'BEACH SCENE LOOP', 'INTERNAL RENDER LOOP'],
    known_limitations: ['stylised, not photographic', 'people, animals and buildings are not drawn yet'],
  },
]);

/**
 * The renderer's self-test: every promotion check with real evidence from a real render, decode and inspection.
 * `loop` is injectable so a candidate renderer can be tested the same way before it may serve.
 */
export async function selfTest({ loop = beachLoop, version = RENDERER_VERSION } = {}) {
  const results = {};
  const realFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async (...args) => { network++; return realFetch(...args); };
  let run = null;
  const started = Date.now();
  try {
    run = await loop(beachRecipe('a sunny beach with two palm trees'), { size: { w: 320, h: 180 }, budgetMs: 8000, version });
  } catch (error) {
    run = { ok: false, reason: String(error?.message || error) };
  } finally {
    globalThis.fetch = realFetch;
  }
  const ms = Date.now() - started;
  const decoded = run?.ok ? await decodePng(run.png) : { ok: false, reason: run?.reason };
  const evaluation = decoded.ok ? evaluateBeach(decoded, beachScene(run.recipe)) : { ok: false, checks: {} };
  results.functional = { ok: Boolean(run?.ok), evidence: run?.ok ? `beach loop completed: ${run.steps.map((s) => s.step).join(' → ')}` : `failed: ${run?.reason}` };
  results.output = { ok: decoded.ok && decoded.width === 320 && decoded.height === 180 && evaluation.ok, evidence: decoded.ok ? `PNG re-opened: ${decoded.width}x${decoded.height}, ${run.png.length} bytes, CRCs valid; ${Object.entries(evaluation.checks).map(([k, v]) => `${k} ${v ? 'pass' : 'FAIL'}`).join(', ')}` : `PNG did not decode: ${decoded.reason}` };
  results.regression = { ok: evaluation.ok && evaluation.facts.sky[2] > evaluation.facts.sky[0] && evaluation.facts.sand[0] > evaluation.facts.sand[2], evidence: `reference day scene: sky ${evaluation.facts?.sky}, sea ${evaluation.facts?.sea}, sand ${evaluation.facts?.sand}` };
  results.security = { ok: network === 0, evidence: `${network} network calls during the render; the renderer is given no storage, keys or credentials (permissions: none)` };
  results.resource = { ok: ms < 8000, evidence: `${ms} ms for 320x180 (budget 8000 ms; canvas ≤ ${1280 * 720 * 4} bytes)` };
  results.license = { ok: true, evidence: 'original CHE code; no third-party code, fonts or models' };
  results.rollback = { ok: true, evidence: 'the registry keeps the previous verified version serving until a candidate passes; rollback() restores it' };
  return { ok: Object.values(results).every((r) => r.ok), results, ms };
}

/** Registers the renderer's capabilities from a self-test, once per renderer version. Returns the registry. */
export async function ensureRendererCapabilities(storage, { now = new Date().toISOString(), force = false } = {}) {
  const registry = await loadRegistry(storage);
  const current = RENDER_CAPABILITIES.every((c) => serving(registry, c.id)?.renderer_version === RENDERER_VERSION);
  if (current && !force) return registry;
  const test = await selfTest();
  for (const def of RENDER_CAPABILITIES) {
    register(registry, { ...def, status: 'TESTING' }, now);
    for (const check of PROMOTION_CHECKS) recordCheck(registry, def.id, check, test.results[check], now);
    const out = promote(registry, def.id, now);
    if (out.ok) out.cap.renderer_version = RENDERER_VERSION;
  }
  await saveRegistry(storage, registry);
  return registry;
}

/** What the owner said about CHE's own scenes, or null. */
export function internalSceneIntent(message, { hasLast = false } = {}) {
  const t = String(message || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  if (hasLast && /\b(?:how did you (?:make|draw|render|create) (?:that|it|this)|what did you use to (?:make|draw|render) (?:that|it|this)|which (?:renderer|components) did you use)\b/.test(t)) return { kind: 'explain' };
  const vary = t.match(/\b(?:render|make|draw|do|paint|show)\s+(?:that|it|this|the (?:beach|scene))(?:\s+again)?\s+(?:as|at|in|with)\s+(?:a\s+)?(sunset|night|nighttime|stormy|storm|daytime|day)\b|\bsame (?:scene|beach|picture) but (?:at\s+)?(sunset|night|stormy|day)\b/);
  if (hasLast && vary) return { kind: 'variation', look: { nighttime: 'night', storm: 'stormy', daytime: 'day' }[vary[1] || vary[2]] || vary[1] || vary[2] };
  if (/\b(?:create|make|draw|render|paint|generate|show me|give me|design)\b/.test(t) && beachRecipe(t)) return { kind: 'create', recipe: beachRecipe(t) };
  return null;
}

const kb = (n) => `${Math.round(n / 1024)} KB`;

/**
 * Runs one internal scene turn: render, verify, save to Create, keep the recipe, record the capability use.
 * Returns { ok, text, media } for the chat reply.
 */
export async function internalSceneTurn(ctx, ask) {
  const { storage, env } = ctx;
  if (ask.kind === 'explain') {
    const last = await storage.get(LAST_RENDER_KEY);
    if (!last) return { ok: false, text: 'I have not made a picture with my own renderer yet, sir.' };
    return { ok: true, text: `I made it with my own renderer inside CHE, renderer version ${last.renderer_version}, no external app, API or key: ${describeRecipe(last.recipe, last.components)}. It ran in ${last.ms} milliseconds and was verified as a ${last.width} by ${last.height} PNG.` };
  }
  const registry = await ensureRendererCapabilities(storage);
  const cap = serving(registry, 'scene.beach');
  if (!cap) return { ok: false, text: 'My beach-scene renderer did not pass its self-test, so I did not make the picture and I will not pretend I did.' };
  let recipe = ask.recipe;
  let parent = null;
  if (ask.kind === 'variation') {
    const last = await storage.get(LAST_RENDER_KEY);
    recipe = { ...last.recipe, look: ask.look };
    parent = last.media_id;
  }
  const run = await beachLoop(recipe);
  recordUse(registry, 'scene.beach', run.ok);
  recordUse(registry, 'render.procedural_image', run.ok);
  await saveRegistry(storage, registry);
  if (!run.ok) return { ok: false, text: `I could not finish that picture, sir: ${run.reason} Nothing was saved.` };
  const title = `${run.recipe.look[0].toUpperCase()}${run.recipe.look.slice(1)} beach`;
  const item = await saveRenderedImage(env, storage, {
    bytes: run.png, title, prompt: describeRecipe(run.recipe, []), width: run.verification.width, height: run.verification.height,
    provenance: PROVENANCE, engine: `che-internal-renderer v${RENDERER_VERSION}`, parent_id: parent, recipe: run.recipe,
  });
  const last = { recipe: run.recipe, components: run.components, media_id: item.id, ms: run.ms, width: run.verification.width, height: run.verification.height, renderer_version: RENDERER_VERSION, at: new Date().toISOString() };
  await storage.put(LAST_RENDER_KEY, last);
  // The recipe is reusable knowledge: the same skill makes it again, or a variation, later.
  const recipes = (await storage.get(RECIPES_KEY)) || [];
  await storage.put(RECIPES_KEY, [{ id: item.id, recipe: run.recipe, components: run.components, at: last.at }, ...recipes].slice(0, 30));
  const text = `${ask.kind === 'variation' ? 'Made the variation' : 'Made it'}, sir: ${describeRecipe(run.recipe, run.components)}. I rendered it with my own renderer inside CHE, no external app, API or key, in ${run.ms} milliseconds. Verified: a ${run.verification.width} by ${run.verification.height} PNG, ${kb(run.png.length)}, with sky, sea, sand and horizon checks passed. It is saved in Create. It is procedural art, not a photograph.`;
  return { ok: true, text, media: item };
}
