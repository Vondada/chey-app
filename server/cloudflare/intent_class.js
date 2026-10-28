// Context-aware intent classification for requests that name weapons, explosives or machines. A keyword is not a decision:
// "gun" in a history question, a game prop or a safety question is not the same request as a build order for a real gun.
// The classifier reads the sentence and the owner's last turn, and returns one category:
//   manufacturing        a build, assembly, disassembly, 3D-print, conversion or exploded-parts instruction for a real weapon,
//                        explosive or armed machine, or a bypass of a safety limit. Refused, and nothing is made.
//   fictional_asset      props, characters, cinematic or game assets, stylized or nonfunctional models and textures. Allowed.
//   historical_research  history, law, society and culture. Allowed (the chat model answers).
//   general_explanation  how things work in general, science, engineering concepts, safety and storage. Allowed.
//   visual_modeling      rendering, animation, rigging, textures or lighting of an ordinary subject. Allowed.
//   general              anything else. Allowed.
// Deterministic: no model is called, so the same sentence always gets the same category.

export const CATEGORIES = Object.freeze(['manufacturing', 'fictional_asset', 'historical_research', 'general_explanation', 'visual_modeling', 'general']);

const WEAPON = /\b(?:blasters?|guns?|firearms?|rifles?|pistols?|handguns?|shotguns?|revolvers?|silencers?|suppressors?|ar-?15|ak-?47|machine\s?guns?|weapons?|explosives?|bombs?|grenades?|ieds?|missiles?|munitions?|ammo|ammunition|flamethrowers?|turrets?|launchers?)\b/i;
const BYPASS = /\b(?:bypass|disable)\s+(?:the\s+)?(?:safety|limiter|interlock|governor|lockout)\b/i;
const MAKE = '(?:build|make|assemble|manufacture|convert|3d[- ]?print|design|reproduce|replicate|finish)';
// A build order aimed at the owner: "how do I build", "how to build", or a make verb whose object is a weapon noun
// (up to two words between): "build me a gun", "make a sniper rifle". "Make a picture of a gun" is not one.
const BUILD_ORDER = new RegExp(`\\b(?:how\\s+(?:do|can|should|would)\\s+(?:i|we|you)\\s+(?:to\\s+)?${MAKE}|how\\s+to\\s+${MAKE}|${MAKE}\\s+(?:me\\s+|us\\s+)?(?:(?:a|an|the|my|your|this|that|one|some|another)\\s+)?(?:[\\w-]+\\s+){0,2}?(?:guns?|rifles?|pistols?|firearms?|bombs?|explosives?|grenades?|weapons?|missiles?|launchers?)\\b)`, 'i');
// Taking a real thing apart or drawing its parts for assembly.
const TAKE_APART = /\b(?:explod\w*|exploded\s+view|disassembl\w*|take\s+(?:it\s+|the\s+\w+\s+|the\s+\w+\s+\w+\s+)?apart|piece\s+by\s+piece|parts?\s+(?:breakdown|diagram|list)|schematics?|blueprints?|dimensions?)\b/i;
// An armed machine: a weapon on a robot, vehicle, drone or suit (the machine noun and the arming phrase both appear).
const MACHINE = /\b(?:robots?|vehicles?|drones?|cars?|tanks?|trucks?|suits?|aircraft|boats?|exoskeletons?|mechs?)\b/i;
const ARMING = /\b(?:armed|mounted|mounting|mounts?|fitted|carrying|with\s+(?:a|an|two|twin)\b|on\s+(?:its|the|his|her|their)\s+arm)\b/i;
// A working or real device, or an untraceable one, even when a game or film is named: that is a real build.
const WORKING = /\b(?:working|functional|actually\s+(?:fire|shoot|work)|real\s+(?:gun|firearm|weapon|explosive|bomb)s?|untraceable|homemade|home-made|ghost\s+guns?|cannot\s+be\s+traced|live\s+ammo)\b/i;
const FICTION = /\b(?:game|video\s+games?|roblox|unreal|unity|godot|blender|3d\s+models?|low[- ]poly|assets?|props?|cosplay|films?|movies?|trailers?|cinematic|comics?|novels?|stor(?:y|ies)|screenplay|characters?|stylized|stylised|fictional|fiction|sci-?fi|fantasy|nonfunctional|non-functional|not\s+real|for\s+my\s+game|vault\s+scene|concept\s+art|textures?|shaders?|animations?|rigs?)\b/i;
const HISTORY = /\b(?:history|historical|who\s+invented|when\s+was|invented\s+in|world\s+war|civil\s+war|second\s+amendment|laws?|legal(?:ly)?|legislation|regulations?|statutes?|society|culture|museum|documentary|century)\b/i;
const SAFETY_OR_EXPLAIN = /\b(?:safe(?:ly|ty)?|store|storage|storing|lock(?:ed|ing)?|child|secure|handling|cleaning|maintenance|explain|how\s+does|how\s+do\s+they|what\s+is|what\s+are|tell\s+me\s+about|why\s+(?:does|do|is)|difference\s+between|principle|in\s+general|general\s+terms|mechanics?|physics|chemistry|calorimeters?|science)\b/i;
const RENDER = /\b(?:render\w*|animat\w*|rig\w*|texture\w*|shader\w*|lighting|3d\s+scene|camera\s+angle)\b/i;

/**
 * The category of one request. `history` is the recent chat: the owner's last turn can make a short follow-up such as
 * "show it exploded" a fictional-asset request, and nothing else in that turn is carried over.
 */
export function classifyRequest(text, { history = [] } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { category: 'general', reason: 'empty request' };
  if (BYPASS.test(t)) return { category: 'manufacturing', reason: 'a bypass of a safety limit is never planned or made' };
  const lastOwner = [...(Array.isArray(history) ? history : [])].reverse().find((h) => h?.role === 'user')?.content || '';
  const weapon = WEAPON.test(t);
  const armed = MACHINE.test(t) && ARMING.test(t);
  if (!weapon && !armed) {
    // "Show it exploded" names no weapon, so it takes the kind of the owner's last turn: fiction stays fiction, and a
    // real weapon stays a real one.
    if (TAKE_APART.test(t) && WEAPON.test(String(lastOwner))) {
      if (FICTION.test(String(lastOwner)) && !WORKING.test(t)) return { category: 'fictional_asset', reason: 'a follow-up on a fictional asset' };
      return { category: 'manufacturing', reason: 'a taking-apart follow-up on a real weapon' };
    }
    if (FICTION.test(t) && RENDER.test(t)) return { category: 'fictional_asset', reason: 'a rendered fictional asset' };
    if (FICTION.test(t)) return { category: 'fictional_asset', reason: 'a fictional or game asset' };
    if (RENDER.test(t)) return { category: 'visual_modeling', reason: 'rendering, animation or texture work' };
    if (HISTORY.test(t)) return { category: 'historical_research', reason: 'history or culture' };
    if (SAFETY_OR_EXPLAIN.test(t)) return { category: 'general_explanation', reason: 'a general explanation' };
    return { category: 'general', reason: 'no sensitive request found' };
  }
  const fictionNow = FICTION.test(t);
  // A follow-up (no build or taking-apart words of its own) inherits the fiction of the owner's last turn.
  const fictionBefore = !BUILD_ORDER.test(t) && !TAKE_APART.test(t) && FICTION.test(lastOwner);
  const fictional = (fictionNow || fictionBefore) && !WORKING.test(t);
  if (armed && !fictional) return { category: 'manufacturing', reason: 'a weapon on a real robot, vehicle, drone or suit' };
  if ((BUILD_ORDER.test(t) || TAKE_APART.test(t)) && !fictional) {
    return { category: 'manufacturing', reason: 'a build, assembly or taking-apart instruction for a real weapon or explosive' };
  }
  if (WORKING.test(t)) return { category: 'manufacturing', reason: 'a working or untraceable weapon' };
  if (fictional) return { category: 'fictional_asset', reason: 'a fictional or game asset, not a real device' };
  if (HISTORY.test(t)) return { category: 'historical_research', reason: 'history, law or culture about a weapon' };
  return { category: 'general_explanation', reason: 'a weapon named without a build or assembly request' };
}

/** Whether the request is a real manufacturing request, the one category that is refused. */
export function isManufacturing(text, options) {
  return classifyRequest(text, options).category === 'manufacturing';
}
