// The office crew as a film cast (owner, 2026-11-06: "a short story of something that happens in the office using
// realistic characters for each of the office members").
//
// A story about the office is played by the real crew: CHE and the team members in the Office, each with the look the
// Office already keeps for them (agent_runtime.agentAppearance: the core profile, then the owner's Workshop choices and
// description). The writer picks who appears and cannot change anyone's look, so a person looks the same in every film.

import { agentAppearance } from './agent_runtime.js';

const HAIR = { close: 'close-cropped hair', fade: 'a fade haircut', waves: 'wavy hair', curls: 'curly hair', braids: 'braided hair', locs: 'locs', bun: 'hair in a bun', bald: 'a shaved head' };
const OUTFIT = { che: 'a sleek dark outfit with teal accents', suit: 'a tailored suit', 'jacket-red': 'a red jacket', 'jacket-teal': 'a teal jacket', hoodie: 'a hoodie', studio: 'a relaxed creative-studio outfit', tech: 'a smart technical jacket' };
const EXTRA = { glasses: ' and glasses', headset: ' and a headset', chain: ' and a thin chain necklace', hat: ' and a hat' };
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// The owner's CHE WORLD character sheets (2026-11-06: "Use this as reference to what everyone looks like", then the
// CHE WORLD headquarters poster and agent sheets, which replace the first poster where they differ).
// A description the owner saves in the Workshop wins over these.
export const CREW_LOOKS = Object.freeze({
  che: 'Black woman in her late 20s, brown skin, long voluminous black wavy hair, gold hoop earrings, white blazer and white trousers over a black top, gold belt',
  nova: 'Black woman in her late 20s, brown skin, long sleek black high ponytail, black leather track jacket with white stripes, white crop top, black pants',
  atlas: 'Black man in his 30s, dark brown skin, short black curly hair, full trimmed beard, black hoodie with ATLAS on the chest',
  mira: 'Woman in her late 20s, light brown skin, platinum blonde hair in a high bun, gold hoop earrings, sleek black outfit, gold jewelry',
  knox: 'Black man in his 30s, dark brown skin, dark sunglasses, short hair, trimmed beard, black tactical jacket with patches',
  sage: 'Woman in her late 20s, brown skin, long dark wavy hair, clear glasses, black turtleneck under a black jacket',
  lyra: 'Black woman in her late 20s, brown skin, long wavy crimson-red hair, headphones around her neck, black crop top and black outfit',
  iris: 'Woman in her late 20s, light brown skin, long silver-white hair in a high ponytail, hoop earrings, sleek black outfit',
  orion: 'Man in his 30s, olive skin, wavy dark hair swept back, short beard, black leather jacket',
  vale: 'Woman in her late 20s, light brown skin, long black hair with blunt bangs, black leather jacket over a white crop top',
});

/** A fixed visual description from the Office's look fields, led by the owner's own words when there are any. */
export function lookText(look = {}) {
  return [
    clip(look.description, 160),
    `${look.body_type || 'standard'} build`,
    `${look.face || 'oval'} face`,
    `${look.skin_tone || 'warm'} skin tone`,
    HAIR[look.hair] || 'short hair',
    `${look.eyes || 'brown'} eyes`,
    `wearing ${OUTFIT[look.outfit] || 'smart office clothes'}${EXTRA[look.accessory] || ''}`,
  ].filter(Boolean).join(', ');
}

/** The crew as a cast: CHE first, then the active team members, each with a fixed look and role. */
export function officeCast(data = {}) {
  const che = { id: 'che', name: 'CHE', role: 'Office Boss' };
  const team = (Array.isArray(data.team) ? data.team : []).filter((a) => a && !a.retired && a.id && a.name);
  return [che, ...team].slice(0, 12).map((a) => {
    const id = clip(a.id === 'che' ? 'che' : a.name, 24).toLowerCase().replace(/[^a-z0-9_]/g, '') || 'crew'; // names, not the Office's UUIDs
    const look = agentAppearance(data, a);
    return { id, name: a.id === 'che' ? 'CHE' : clip(a.name, 60), role: clip(a.role, 80), look: look.description || !CREW_LOOKS[id] ? lookText(look) : CREW_LOOKS[id] };
  }).filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i);
}
