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

// The owner's cast poster ("CHE OFFICE: core team cast", 2026-11-06: "Use this as reference to what everyone looks like").
// A description the owner saves in the Workshop wins over these.
export const CREW_LOOKS = Object.freeze({
  che: 'Black woman in her late 20s, long voluminous black wavy hair, gold hoop earrings, neck tattoos, black leather jacket with a gold CHE patch, silver chain',
  nova: 'Black woman in her late 20s, long curly crimson-red hair, gold hoop earrings, red rose tattoos down one arm, glossy burgundy outfit',
  mira: 'Black woman in her late 20s, curly dark hair in a high bun with blue streaks, clear glasses, white button-up shirt with pens in the pocket, tattoos',
  lyra: 'Black woman in her late 20s, long blonde locs in a high bun, purple headphones, purple eyeshadow, lavender crop top and purple jacket, music tattoos',
  iris: 'Black woman in her late 20s, sleek black bob with blunt bangs and blue tips, lotus tattoo on her shoulder, glossy black and blue outfit',
  sage: 'Black man in his 30s, long dreadlocks tied up with blond tips, gold-rimmed glasses, full beard, neck tattoos, black hoodie, gold chains and watch',
  atlas: 'Black man in his 30s, braided cornrows, full beard, tattooed arms, black tactical vest over a black shirt, gold chain',
  orion: 'Black man in his 30s, short dark curls, wraparound dark sunglasses, goatee, black jacket with glowing blue trim',
  knox: 'Black man in his 30s, black beanie, full beard, face and neck tattoos, black tactical vest, gold chain',
  vale: 'Black man in his 30s, short waves with a fade, full beard, neck tattoos, black and red track jacket, gold chain',
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
