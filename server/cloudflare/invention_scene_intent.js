// Reads an owner's sentence about a 3D scene ("open the casing", "give the stages more space", "make the front fan larger")
// and runs it on invention_scene.js. It is the sentence layer only: it never draws, never calls a model and never says a
// change happened unless the scene operation returned a verified receipt. Kimi's 3D Make demo (owner, 2026-10-25) is the
// reference for the flow: one plain sentence per change, one change at a time, and the reply says what really changed.
import { sceneFor, explode, reassemble, openCasing, setPartHidden, scalePart, resolvePart, placedParts, EXPLODE_MAX, CASING_MAX } from './invention_scene.js';

const TEMPLATE_WORDS = /\b(?:jet\s+engine|turbofan|engine)\b/i;
const PART = '([a-z][a-z ]{1,40}?)';

/** The edit a sentence asks for, or null. `scene` is needed to name parts; `kind` is 'build', 'edit' or 'refused'. */
export function sceneIntent(message) {
  const text = String(message || '').replace(/^(?:che|chay|chey)[,:]?\s+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text || text.length > 300) return null;
  if (/\b(?:build|make|create|design)\b/.test(text) && TEMPLATE_WORDS.test(text)) return { kind: 'build', template: 'jet_engine' };
  if (/\b(?:open|split)\b.*\bcasing\b|\bcasing\b.*\bopen\b/.test(text) && !/\b(?:close|shut)\b/.test(text)) {
    return { kind: 'edit', op: 'openCasing', amount: /\bfurther\b/.test(text) ? CASING_MAX : CASING_MAX / 2 };
  }
  if (/\b(?:close|shut)\b.*\bcasing\b/.test(text)) return { kind: 'edit', op: 'openCasing', amount: 0 };
  if (/\b(?:put everything back|reassemble|assemble|back together|close everything)\b/.test(text)) return { kind: 'edit', op: 'reassemble' };
  if (/\bstages?\b/.test(text) && /\b(?:separate|explode|space out|more space)\b/.test(text)) {
    return { kind: 'edit', op: 'explode', amount: EXPLODE_MAX / 3 };
  }
  const hide = text.match(new RegExp(`^(hide|show) (?:the )?${PART}$`));
  if (hide) return { kind: 'edit', op: 'hide', hidden: hide[1] === 'hide', part: hide[2].trim() };
  const size = text.match(new RegExp(`^(?:make|set) (?:the )?${PART} (larger|bigger|smaller|more compact)$`));
  if (size) return { kind: 'edit', op: 'scale', part: size[1].trim(), factor: /larger|bigger/.test(size[2]) ? 1.5 : 0.7 };
  return null;
}

/**
 * Runs one sentence on a scene. Returns { scene, reply, receipt, ok }. A reply names the real change, or says why nothing
 * changed (no part named, several parts match, out of range). Unknown sentences return { ok: false, reply: null }.
 */
export function runSceneSentence(scene, message) {
  const intent = sceneIntent(message);
  if (!intent) return { ok: false, scene, reply: null, receipt: null };
  if (intent.kind === 'build') {
    const fresh = sceneFor(intent.template);
    return { ok: true, scene: fresh, receipt: { op: 'build', target: intent.template, changed: fresh.parts.map((p) => p.name), unchanged: 0, verified: true },
      reply: `Built a jet engine with ${fresh.parts.length} named parts: ${fresh.parts.map((p) => p.name).join(', ')}.` };
  }
  if (!scene) return { ok: false, scene, reply: 'There is no model open yet. Say "build a jet engine" first.', receipt: null };
  let out;
  if (intent.op === 'openCasing') out = openCasing(scene, intent.amount);
  else if (intent.op === 'explode') out = explode(scene, intent.amount);
  else if (intent.op === 'reassemble') out = reassemble(scene);
  else {
    const found = resolvePart(scene, intent.part);
    if (!found.part) return { ok: true, scene, receipt: null, reply: found.ambiguous.length ? `Which one do you mean: ${found.ambiguous.join(' or ')}?` : `I could not find a part called "${intent.part}".` };
    out = intent.op === 'hide' ? setPartHidden(scene, found.part.name, intent.hidden) : scalePart(scene, found.part.name, intent.factor);
  }
  const r = out.receipt;
  if (!r.verified) return { ok: true, scene, receipt: r, reply: `Nothing changed: ${r.error}.` };
  const reply = describe(r, out.scene);
  return { ok: true, scene: out.scene, receipt: r, reply };
}

function describe(r, scene) {
  const names = r.changed.length ? r.changed.join(', ') : 'nothing';
  return `Done: ${r.op} on ${r.target}. Changed ${r.changed.length} part${r.changed.length === 1 ? '' : 's'} (${names}); ${r.unchanged} left as they were. Scene is now version ${scene.version}.`;
}

/** The current placement of each part, for a reply or a check. */
export function placementOf(scene) { return placedParts(scene).map(({ name, c, s, hidden }) => ({ name, c, s, hidden })); }
