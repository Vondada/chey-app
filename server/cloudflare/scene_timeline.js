// Scene timeline: turn one request into a checked, render-ready plan.
//
// "Create Nova in a realistic recording studio, make her walk to the microphone, speak, and render a 15-second
// video" becomes: a pinned character version from the registry, a shot list that fills the requested length exactly,
// the frames it needs, and the render routes that can honestly make it. Nothing is rendered here, and nothing is
// invented: an action CHE does not know is listed as unsupported, a character with no model is blocked, and a route
// that cannot keep a rigged character is marked not eligible with the reason.
//
// Pure functions. Inputs are the request text (or a structured request) and the character registry.

import { CHARACTER_IDS, assetRefs, latestVersion } from './character_registry.js';

export const FPS = 24;
export const MAX_SECONDS = 120;
export const ACTIONS = Object.freeze({
  walk: { seconds: 4, needs: ['rig', 'animations'], clip: 'walk' },
  speak: { seconds: 3, needs: ['rig', 'face', 'voice'], clip: 'talk' },
  turn: { seconds: 1, needs: ['rig'], clip: 'idle' },
  wave: { seconds: 2, needs: ['rig', 'animations'], clip: 'wave' },
  sit: { seconds: 2, needs: ['rig', 'animations'], clip: 'sit' },
  wait: { seconds: 2, needs: ['rig'], clip: 'idle' },
});
const WORDS_PER_SECOND = 2.5;

// Render routes CHE may use, with what each can truthfully do today. A route is only eligible for a rigged character
// if it keeps the canonical model; a generative image-to-video route cannot.
export const RENDER_ROUTES = Object.freeze([
  { id: 'blender_gpu_kaggle', label: 'Blender Cycles on a free Kaggle T4', keeps_rig: true, gpu: true, built: false, note: 'Not built yet: the Kaggle kernel runs LTX-Video only.' },
  { id: 'blender_cpu_actions', label: 'Blender CPU on GitHub Actions (free)', keeps_rig: true, gpu: false, built: false, note: 'Not built yet: needs a Blender render workflow.' },
  { id: 'ltx_kaggle', label: 'LTX-Video image-to-video on a free Kaggle T4', keeps_rig: false, gpu: true, built: true, note: 'Built and used by Film Studio. Makes a clip from a picture; it cannot keep the exact rig, so it is not used for a rigged character.' },
]);

const NAME_TO_ID = new Map(CHARACTER_IDS.map((id) => [id, id]));

/** Parse a request into { character_id, seconds, setting, steps, unsupported }. Unknown verbs are listed, never guessed. */
export function parseRequest(text = '') {
  // "CHE, ..." addresses her; the character to make is named after that.
  const src = String(text || '').replace(/^\s*che\s*[,:!]\s*/i, '');
  // Quoted dialogue is masked before the clauses are split, so commas, "and" and "then" inside it stay in one step.
  const quotes = [];
  const masked = src.replace(/"([^"]*)"/g, (_, q) => { quotes.push(q); return `QUOTE${quotes.length - 1}`; });
  const lower = masked.toLowerCase();
  const character = [...NAME_TO_ID.keys()].find((id) => new RegExp(`\\b${id}\\b`, 'i').test(src)) || null;
  const secs = lower.match(/(\d+)\s*[- ]?\s*seconds?\b/);
  const setting = (lower.match(/\bin (?:an? |the )?([a-z][a-z -]{2,40}?)(?=,| and | make | render |$)/) || [])[1]?.trim() || null;
  const steps = [];
  const unsupported = [];
  const clauses = lower.split(/,| and |;|\bthen\b/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    const quote = clause.match(/quote(\d+)/);
    const walk = clause.match(/\bwalk(?:s|ing)? (?:over )?to (?:the |a |an )?([a-z ]+)$/);
    if (walk) { steps.push({ action: 'walk', target: walk[1].trim() }); continue; }
    if (/\bspeak(?:s|ing)?\b|\bsay(?:s|ing)?\b/.test(clause)) {
      steps.push({ action: 'speak', text: quote ? quotes[Number(quote[1])] : null });
      continue;
    }
    const named = Object.keys(ACTIONS).find((a) => new RegExp(`\\b${a}s?\\b`).test(clause));
    if (named) { steps.push({ action: named }); continue; }
    // Setup only: creating or rendering the video, the character or the setting. Any other "make ..." is an action.
    const setup = /^(?:create|make|render|generate|add)\b/.test(clause) && /\b(?:video|clip|film|scene|studio|room|second|seconds|character)\b/.test(clause)
      || new RegExp(`^(?:create|make|render|generate)\\s+(?:${CHARACTER_IDS.join('|')})\\b`).test(clause)
      || /^in (?:an? |the )/.test(clause);
    if (setup) continue;
    if (clause.length > 2) unsupported.push(clause);
  }
  return { character_id: character, seconds: secs ? Number(secs[1]) : null, setting, steps, unsupported };
}

function stepSeconds(step) {
  if (step.action === 'speak' && step.text) return Math.max(ACTIONS.speak.seconds, Math.ceil(step.text.split(/\s+/).length / WORDS_PER_SECOND));
  return ACTIONS[step.action]?.seconds || 0;
}

/**
 * Lay the steps end to end, fill the rest with idle, and check the total is exactly the requested length.
 * Fails when the steps are longer than the requested length (it never silently cuts a step).
 */
export function buildShots(steps, seconds) {
  const shots = [];
  let t = 0;
  for (const step of steps) {
    const len = stepSeconds(step);
    shots.push({ id: `s${shots.length + 1}`, action: step.action, clip: ACTIONS[step.action]?.clip || 'idle', target: step.target || null, text: step.text || null, t0: t, t1: t + len });
    t += len;
  }
  if (t > seconds) throw new Error(`The steps need ${t}s but the video is ${seconds}s. Make the video longer or remove a step.`);
  if (t < seconds) shots.push({ id: `s${shots.length + 1}`, action: 'wait', clip: 'idle', target: null, text: null, t0: t, t1: seconds });
  return shots;
}

/** Which routes can make this plan, and why the others cannot. */
export function routesFor(plan, routes = RENDER_ROUTES) {
  const needsRig = plan.shots.some((s) => s.action !== 'wait') || plan.character?.model != null;
  return routes.map((r) => {
    const reasons = [];
    if (needsRig && !r.keeps_rig) reasons.push('cannot keep the rigged character');
    if (!r.built) reasons.push(r.note);
    return { id: r.id, label: r.label, eligible: reasons.length === 0, reasons };
  });
}

/** What each step needs from the pinned version that the version does not have. Empty when every step is supported. */
export function assetGaps(shots, version) {
  const gaps = new Set();
  for (const shot of shots) {
    const need = ACTIONS[shot.action]?.needs || [];
    for (const n of need) {
      if (n === 'animations') {
        if (shot.clip !== 'idle' && !(version?.animations || []).includes(shot.clip)) gaps.add(`no "${shot.clip}" animation saved for this version`);
      } else if (!version?.[n]) {
        gaps.add(`no ${n} asset saved for this version (needed for ${shot.action})`);
      }
    }
  }
  return [...gaps];
}

/**
 * Plan one video. `registry` is the character registry (character_registry.js). Returns the plan with an honest status:
 * 'ready' only when the character has a model and every step is supported; otherwise 'blocked' with the reasons.
 */
export function planScene(text, registry, { seconds: override = null, now = Date.now(), routes = RENDER_ROUTES } = {}) {
  const parsed = parseRequest(text);
  const reasons = [];
  if (!parsed.character_id) reasons.push('No named character was found. Name one of: ' + CHARACTER_IDS.join(', ') + '.');
  const seconds = override ?? parsed.seconds ?? 15;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS) reasons.push(`A video must be 1 to ${MAX_SECONDS} seconds.`);
  if (parsed.unsupported.length) reasons.push(`Not supported yet: ${parsed.unsupported.join('; ')}.`);
  if (reasons.length || !parsed.character_id) return { status: 'blocked', reasons, parsed, now };

  const latest = latestVersion(registry, parsed.character_id);
  const refs = assetRefs(registry, parsed.character_id);
  if (!refs?.model) reasons.push(`${latest?.note || 'This character has no model yet.'}`);
  let shots;
  try { shots = buildShots(parsed.steps.length ? parsed.steps : [{ action: 'wait' }], seconds); } catch (error) { reasons.push(error.message); }
  if (reasons.length || !shots) return { status: 'blocked', reasons, parsed, now };
  const gaps = assetGaps(shots, latest);
  if (gaps.length) return { status: 'blocked', reasons: gaps, parsed, character: { id: parsed.character_id, version: refs.version }, seconds, shots, now };

  const plan = {
    status: 'ready',
    reasons: [],
    character: { id: parsed.character_id, version: refs.version, model: refs.model },
    setting: parsed.setting,
    seconds,
    fps: FPS,
    frames: seconds * FPS,
    shots,
    now,
  };
  const options = routesFor(plan, routes);
  if (!options.some((r) => r.eligible)) {
    const why = options.map((r) => `${r.label}: ${r.reasons.join('; ')}`);
    return { status: 'blocked', reasons: [`No render route can make this yet. ${why.join(' | ')}`], parsed, character: plan.character, seconds, shots, routes: options, now };
  }
  return { ...plan, routes: options };
}
