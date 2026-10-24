// Character Studio by voice: "CHE, make your walking more natural", "be more expressive", "use the professional
// preset", "Atlas, gesture less". Each request becomes a small settings patch the phone applies to that agent's
// animator (lib/studio/che_character_studio.dart) and saves as a version, with 0 model calls. Anything the runtime
// cannot change by settings (a new outfit, a new hairstyle, a new model) becomes an honest upgrade request instead
// of a pretended change. Presentation only: no patch here can grant an agent a tool, an app or a permission.

export const STUDIO_AGENTS = ['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris', 'orion', 'vale'];
const AGENT_RE = new RegExp(`\\b(${STUDIO_AGENTS.join('|')})\\b`, 'i');
const PRESETS = ['natural', 'professional', 'expressive', 'cinematic'];
const MORE = /\b(more|higher|stronger|bigger|extra|increase|up)\b/i;
const LESS = /\b(less|lower|weaker|smaller|fewer|reduce|down|calmer|calm)\b/i;

// What the sentence is about → which settings move, and in which direction for "more".
const TOPICS = [
  { re: /\bwalk(?:ing|s)?\b|\bgait\b|\bstride\b/i, keys: { fluidity: 0.15 }, walk: { natural: 'graceful', graceful: 'graceful', elegant: 'graceful', confident: 'confident', powerful: 'confident', plain: 'plain', simple: 'plain', normal: 'plain' } },
  { re: /\bgestur(?:e|es|ing)\b|\bhands?\b|\barms?\b/i, keys: { gesture: 0.2 } },
  { re: /\bexpressi(?:ve|on|ons)\b|\bface\b|\bfacial\b|\bsmile\b|\bemotion(?:al|s)?\b/i, keys: { expressiveness: 0.2 } },
  { re: /\bfluid(?:ity)?\b|\bsmooth(?:er|ly|ness)?\b|\bstiff(?:er|ness)?\b|\bjerky\b|\brobotic\b|\bmov(?:e|es|ing|ement)\b.*\bnatural/i, keys: { fluidity: 0.15 } },
  { re: /\bidle\b|\bfidget(?:ing|y)?\b|\bstill(?:ness)?\b|\bposture\b|\bbreath(?:e|ing)\b/i, keys: { idleVariety: 0.2 } },
  { re: /\beye contact\b|\blook at me\b|\beyes\b/i, keys: { eyeContact: 0.2 } },
  { re: /\bhair\b|\bcloth(?:es|ing)?\b|\bdress\b|\bsuit\b/i, keys: { hairCloth: 0.2 } },
  { re: /\bspeed\b|\bfaster\b|\bslower\b|\bquick(?:er|ly)?\b|\bslow(?:ly)?\b/i, keys: { speed: 0.1 } },
  { re: /\benerg(?:y|etic)\b|\blively\b|\banimated\b|\bexcited\b/i, keys: { gesture: 0.15, expressiveness: 0.15, idleVariety: 0.1 } },
];
// Changes the runtime cannot make from settings: these become upgrade requests, never a claimed change.
const UPGRADE = /\b(outfit|clothes|clothing|wardrobe|dress|suit colou?r|hairstyle|haircut|hair colou?r|new (?:model|body|face|look)|skin|makeup|glasses|shoes|accessor(?:y|ies))\b/i;
const STUDIO_ASK = /\b(?:make|be|act|move|walk|gesture|look|talk|speak|seem|become|get|use|switch to|set)\b.*\b(?:natural|smooth|smoother|fluid|expressive|calm|calmer|lively|energetic|professional|cinematic|confident|graceful|plain|stiff|robotic|gestures?|walk(?:ing)?|idle|eye contact|hair|cloth|faster|slower|speed|animation|preset|style)\b|\b(?:walk|gesture|animation|expression|idle|eye contact)\b.*\b(?:more|less|better|natural|smooth)\b/i;
const NOT_STUDIO = /\bwalk[- ]forward\b|\bwalk (?:me|us|him|her|them) through\b|\b(?:strategy|backtest|trading|trade|futures|report|email|document|code|test(?:ing)?)\b|^(?:is|are|does|do|why|what|how|which|should|can|could|would|will)\b/i;
const OPEN_ASK =/^(?:please\s+)?(?:open|show(?: me)?|go to|take me to|bring up)\s+(?:the\s+)?character studio(?:\s+(?:screen|page))?\s*[.!?]?$/i;
const plain = (m) => String(m || '').trim().replace(/^(?:che|chey|hey che|okay|ok|so)[,\s]+/i, '').replace(/[,\s]+(?:please|sir)\s*[.!?]?$/i, '');

/** Parses one owner sentence. Returns null when it is not about how an agent looks or moves. */
export function studioIntent(message, { activeAgent = 'che' } = {}) {
  const text = plain(message);
  if (!text) return null;
  if (OPEN_ASK.test(text)) return { kind: 'open', agent: activeAgent };
  const who = (text.match(AGENT_RE) || [])[1];
  // "your walking" / "you" names CHE herself; a named crew member names them.
  const agent = who ? who.toLowerCase() : (/\b(?:your|you|yourself)\b/i.test(text) ? 'che' : null);
  if (UPGRADE.test(text) && /\b(change|new|different|give|put|wear|switch|update|upgrade|make)\b/i.test(text)) {
    return { kind: 'upgrade', agent: agent || activeAgent, request: text };
  }
  // A question, or a walk that is a method ("walk forward testing", "walk me through"), is never about her body.
  if (NOT_STUDIO.test(text)) return null;
  if (!STUDIO_ASK.test(text) && !PRESETS.some((p) => new RegExp(`\\b${p}\\b`, 'i').test(text) && /\bpreset|style|mode|look|move\b/i.test(text))) return null;
  const patch = {};
  // A preset needs the word preset, style or mode: "be more expressive" is a nudge, "the expressive preset" a switch.
  const preset = PRESETS.find((p) => new RegExp(`\\b${p}\\b`, 'i').test(text) && /\b(preset|style|mode)\b/i.test(text));
  if (preset && !/\bwalk/i.test(text)) patch.preset = preset;
  const sign = LESS.test(text) && !MORE.test(text) ? -1 : 1;
  for (const topic of TOPICS) {
    if (!topic.re.test(text)) continue;
    for (const [k, step] of Object.entries(topic.keys)) {
      let s = sign;
      if (k === 'speed' && /\bslow/i.test(text)) s = -1;
      // "make it stiffer" lowers fluidity; "less stiff", "smoother" or "more natural" raise it.
      if (k === 'fluidity' && /\b(?:stiff|robotic|jerky)/i.test(text) && !/\bless (?:stiff|robotic|jerky)|\bsmooth|\bnatural|\bfluid/i.test(text)) s = -1;
      else if (k === 'fluidity' && /\bsmooth|\bnatural|\bfluid|\bless (?:stiff|robotic|jerky)/i.test(text)) s = 1;
      patch[k] = (patch[k] || 0) + s * step;
    }
    if (topic.walk) {
      const word = Object.keys(topic.walk).find((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
      if (word) patch.walk = topic.walk[word];
    }
  }
  if (!Object.keys(patch).length) return null;
  return { kind: 'patch', agent: agent || activeAgent, patch, request: text };
}

const say = (k, v) => ({ fluidity: 'fluidity', gesture: 'gesture intensity', expressiveness: 'facial expressiveness', idleVariety: 'idle variety', eyeContact: 'eye contact', hairCloth: 'hair and cloth motion', speed: 'speed' }[k] || k) + (v > 0 ? ' up' : ' down');

/** The reply and the fields the phone acts on. `queueUpgrade(request)` files a real upgrade job and returns its id. */
export async function handleStudio(ask, { queueUpgrade = null } = {}) {
  const name = ask.agent === 'che' ? 'my' : `${ask.agent[0].toUpperCase()}${ask.agent.slice(1)}'s`;
  if (ask.kind === 'open') return { text: 'Opening the Character Studio, sir.', fields: { source: 'che_character_studio', open_screen: 'character_studio', studio_agent: ask.agent }, ok: true };
  if (ask.kind === 'upgrade') {
    const job = queueUpgrade ? await queueUpgrade(ask) : null;
    return {
      text: job
        ? `That needs new character assets, sir, not a setting. I filed it as upgrade job ${String(job.id || '').slice(0, 8)} for ${name} look; nothing has changed yet.`
        : `That needs new character assets, sir, not a setting, and no upgrade job could be filed right now. Nothing has changed.`,
      fields: { source: 'che_character_studio', studio_agent: ask.agent, studio_upgrade: job ? { id: job.id, request: ask.request } : null },
      ok: Boolean(job),
    };
  }
  const parts = Object.entries(ask.patch).filter(([k]) => k !== 'preset' && k !== 'walk').map(([k, v]) => say(k, v));
  if (ask.patch.walk) parts.unshift(`${ask.patch.walk} walk`);
  if (ask.patch.preset) parts.unshift(`${ask.patch.preset} preset`);
  return {
    text: `Done, sir: ${name} animation now has ${parts.join(', ')}. It applies in the 3D room and is saved as a new version you can roll back in the Character Studio.`,
    fields: { source: 'che_character_studio', studio_agent: ask.agent, studio_patch: ask.patch },
    ok: true,
  };
}
