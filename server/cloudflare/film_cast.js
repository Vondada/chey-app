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

// The crew's design (owner, 2026-11-07). The owner's CHE OFFICE "Core Team Cast" poster ("the most recent pictures
// that I sent you with the older crew, with everyone") sets each person's identity and gender. The CHE WORLD sheets
// add signature items, colours, catchphrases and styling, and the gaps are filled in ("Blend the reference pictures
// together to make everybody unique and have their own personality and look... give one of the dudes an eye patch":
// Knox). Each person has one unmistakable detail. Looks are in neutral words, because the picture model refuses
// suggestive prompts (error 3030). These are the Crew Creator's starting profiles (crew_creator.js). The owner edits
// each field there, and a Crew Creator look, then a Workshop description, wins over these.
// Follow-up: the 3D crew models (assets/characters/crew/*.glb) do not match this design yet. Sage, Atlas, Orion and
// Vale are men here, and the models build Sage and Vale as women.
export const CREW_BIBLE = Object.freeze({
  che: { look: 'Black woman in her late 20s, deep-brown skin, long voluminous black waves, gold hoops, fitted black leather jacket with a gold CHE badge',
    signature: 'a thin gold C pendant and a holographic tablet', colours: ['black', 'gold', 'warm white'],
    personality: 'calm, warm and decisive; leads by asking the one right question; dry humour; never raises her voice',
    voice: 'low, smooth, unhurried alto with a smile in it', catchphrase: 'I see it all. We make it real.',
    tells: 'tilts her head before a decision; taps the badge when she means business' },
  nova: { look: 'Black woman in her late 20s, brown skin, big crimson-red curls, gold hoops, burgundy satin bomber jacket over a black top, white sneakers',
    signature: 'a sketch stylus behind one ear', colours: ['crimson', 'burgundy', 'gold'],
    personality: 'restless idea machine, first to say what if; loud laugh; starts ten things and finishes the best three',
    voice: 'bright, fast, a little raspy', catchphrase: 'Let\'s make something nobody\'s seen.',
    tells: 'twirls a curl when thinking; talks with her hands' },
  mira: { look: 'Black woman in her late 20s, brown skin, curly dark high bun with an electric-blue streak, clear oversized glasses, crisp white shirt, loose blue tie',
    signature: 'a pen spinning between her fingers and a gold watch', colours: ['white', 'electric blue', 'black'],
    personality: 'sharp and numbers-first, sceptical in the best way; hates hype, loves a clean chart; deadpan funny',
    voice: 'crisp, precise, mid-pitch; slows down for numbers', catchphrase: 'Show me the data.',
    tells: 'pushes her glasses up before she disagrees' },
  lyra: { look: 'Black woman in her late 20s, brown skin, long platinum-blonde braids, purple-lit headphones round her neck, lavender jacket over a black tee',
    signature: 'glowing headphones that pulse to what she hears', colours: ['lavender', 'purple', 'silver'],
    personality: 'dreamy until the beat drops, then all focus; hears a soundtrack in everything; hums constantly',
    voice: 'soft, musical, sing-song mezzo', catchphrase: 'I make it feel.',
    tells: 'taps rhythms on any surface; closes her eyes when she is really listening' },
  iris: { look: 'Black woman in her late 20s, brown skin, sleek black bob with blunt bangs and blue tips, black high-collar jacket with blue piping, silver ear cuff',
    signature: 'a flip-down AR lens and a slim silver tablet', colours: ['black', 'cobalt blue', 'silver'],
    personality: 'quiet observer who notices what everyone missed; speaks rarely and always lands it',
    voice: 'cool, quiet and clear', catchphrase: 'I turn data into direction.',
    tells: 'flips the AR lens down; a long pause, then one sentence that changes the plan' },
  sage: { look: 'Black man in his 30s, dark brown skin, long locs tied up with gold cuffs, gold-rim round glasses, full beard, black hoodie under a long black coat',
    signature: 'a leather notebook and a pencil behind his ear', colours: ['black', 'gold', 'warm brown'],
    personality: 'the office memory and its calm older brother; patient and wise; remembers every birthday and every past decision',
    voice: 'deep, warm, slow baritone', catchphrase: 'I remember, so you don\'t have to.',
    tells: 'strokes his beard; quotes what someone said three weeks ago, word for word' },
  atlas: { look: 'Black man in his 30s, dark brown skin, neat braided cornrows, full beard, broad build, black tactical vest over a charcoal tee, headset on one ear',
    signature: 'a multi-tool on his belt and signal-orange tool loops', colours: ['charcoal', 'black', 'signal orange'],
    personality: 'steady builder; it is not done until it holds the load; few words, big hugs; fixes things before you notice',
    voice: 'deep, gravelly, even bass', catchphrase: 'I build what\'s next.',
    tells: 'cracks his knuckles before a big job; knocks twice on anything he just fixed' },
  orion: { look: 'Black man in his 30s, dark brown skin, dark wraparound shades, sharp short fade, trimmed beard, black jacket with glowing blue trim, silver chain',
    signature: 'shades that never come off and a star-map ring', colours: ['black', 'ice blue', 'chrome'],
    personality: 'smooth, confident navigator who finds the route through anything; a charmer with a strategist\'s brain',
    voice: 'smooth, confident mid baritone with swagger', catchphrase: 'There\'s always a way through.',
    tells: 'draws routes in the air with two fingers' },
  knox: { look: 'Black man in his 30s, dark skin, black eye patch over his left eye with a scar below it, black beanie, full beard, heavy black tactical vest',
    signature: 'the eye patch and a shield emblem on his vest', colours: ['black', 'gunmetal', 'one red accent'],
    personality: 'protector of few words and total loyalty; intimidating at first, a softie with the crew; checks every door twice',
    voice: 'low, quiet and measured; never needs to shout', catchphrase: 'I watch. I protect.',
    tells: 'stands with his back to a wall; a slow single nod means handled' },
  vale: { look: 'Black man in his 30s, dark brown skin, short fade with a part line, groomed beard, black-and-red track jacket, red-lens goggles up on his head',
    signature: 'a small robot drone that follows him around', colours: ['black', 'racing red', 'steel'],
    personality: 'hustler-engineer who automates anything done twice; competitive and funny; trash-talks the machines',
    voice: 'quick, upbeat tenor with energy', catchphrase: 'Do it once. Then automate it.',
    tells: 'flicks his goggles down before he builds; high-fives the drone' },
});
export const CREW_LOOKS = Object.freeze(Object.fromEntries(Object.entries(CREW_BIBLE).map(([id, b]) => [id, b.look])));

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

/**
 * The crew as a cast: CHE first, then the active team members, each with a fixed look and role, plus the
 * personality, tells and catchphrase the writer acts and speaks them by. `crew` holds the Crew Creator's edits
 * ({ id: { look, personality, tells, catchphrase } }, crew_creator.crewProfiles), which win over the Workshop and the
 * design above.
 */
export function officeCast(data = {}, crew = {}) {
  const che = { id: 'che', name: 'CHE', role: 'Office Boss' };
  const team = (Array.isArray(data.team) ? data.team : []).filter((a) => a && !a.retired && a.id && a.name);
  return [che, ...team].slice(0, 12).map((a) => {
    const id = clip(a.id === 'che' ? 'che' : a.name, 24).toLowerCase().replace(/[^a-z0-9_]/g, '') || 'crew'; // names, not the Office's UUIDs
    const look = agentAppearance(data, a);
    const own = crew?.[id] || {};
    const bible = CREW_BIBLE[id] || {};
    const acting = Object.fromEntries(['personality', 'tells', 'catchphrase'].map((f) => [f, clip(own[f] || bible[f], 160)]).filter(([, v]) => v));
    const base = clip(own.look, 160) || (look.description || !CREW_LOOKS[id] ? lookText(look) : CREW_LOOKS[id]);
    return { id, name: a.id === 'che' ? 'CHE' : clip(a.name, 60), role: clip(a.role, 80), look: crewLookText(base, own), ...acting };
  }).filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i);
}

/**
 * The look every picture prompt uses: the look in words, plus what the owner set in the Crew Creator for hair,
 * outfit, signature item and colours, so a saved outfit change shows in the next film.
 */
export function crewLookText(base, own = {}) {
  const extra = [
    own.hair && `hair: ${clip(own.hair, 80)}`,
    own.outfit && `now wearing ${clip(own.outfit, 120)}`,
    own.signature && `with ${clip(own.signature, 120)}`,
    Array.isArray(own.colours) && own.colours.length && `colours ${own.colours.slice(0, 6).map((c) => clip(c, 24)).join(', ')}`,
  ].filter(Boolean);
  return clip([base, ...extra].filter(Boolean).join(', '), 400);
}
