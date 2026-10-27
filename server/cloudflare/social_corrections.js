// Owner tone corrections, read from one message (owner, 2026-10-26: "Chill, I'm by my mama" means clean up the language).
// A pure classifier. It only says what the owner asked for and how long it should last; it never stores anything and
// never decides who is physically present. Questions about past instructions, quoted speech and hypotheticals are not
// corrections, so they return null.
//
// Scope: 'situational' for this conversation or setting ("I'm by my mama", "we're around company"), 'temporary' for a
// one-off reaction ("be serious for a second"), 'persistent' only when the owner says so ("from now on", "always").

const HYPOTHETICAL = /\b(?:if|suppose|what if|imagine|pretend|for example|like when|quote|said:)\b|["“”]/i;
const QUESTION_ABOUT_PAST = /\b(?:remember|remind me|do you recall|what did i|how i told you)\b/i;
const PERSISTENT = /\b(?:from now on|always|every time|going forward|in general)\b/i;

const RULES = [
  { id: 'clean_language', re: /\b(?:chill,?\s*)?i'?m (?:by|around|with) (?:my |the )?(?:mama|mom|mother|family|grandma|grandmother|dad|kids?)\b|\bwatch (?:your|the) (?:language|mouth)\b|\bclean (?:up )?(?:your|the) language\b|\bkeep (?:it )?clean\b/i, patch: { cleanLanguage: true, formality: 7 }, reply: 'Oh, my bad. Excuse my language.' },
  { id: 'around_company', re: /\b(?:we'?re|we are) (?:around|with) (?:company|people|others|guests)\b/i, patch: { cleanLanguage: true, formality: 7, playfulness: 2 }, reply: 'Got it. I will keep it clean and professional.' },
  { id: 'professional', re: /\bkeep it (?:professional|business(?:like)?|serious)\b|\bprofessional(?:ly)? please\b/i, patch: { formality: 8, playfulness: 1 }, reply: 'Understood. Professional tone.' },
  { id: 'relaxed', re: /\b(?:relax|it'?s just us|just us|chill out|we'?re good|no need to be formal)\b/i, patch: { formality: 3, playfulness: 6, cleanLanguage: false }, reply: 'Got it. Relaxed again.' },
  { id: 'less_robotic', re: /\b(?:don'?t talk to me like a robot|stop (?:sounding|talking) like a robot|you sound like a robot)\b/i, patch: { formality: 3, warmth: 8 }, reply: 'Fair. I will talk to you more naturally.' },
  { id: 'less_detail', re: /\byou'?re doing (?:too much|way too much)\b|\btoo (?:much|long)\b/i, patch: { verbosity: 2 }, reply: 'Understood. Shorter answers.' },
  { id: 'serious_moment', re: /\bbe serious (?:for a (?:second|sec|minute|moment))?\b|\bthis is serious\b/i, patch: { playfulness: 0, formality: 6 }, reply: 'Understood. Serious tone.' },
];

/**
 * Classifies one owner message as a tone correction, or returns null. Result: { id, scope, patch, reply }.
 * `patch` holds the trait changes the owner asked for; the caller decides whether to apply them (and where).
 */
export function classifySocialCorrection(message) {
  const text = String(message ?? '').trim();
  if (!text || text.length > 300) return null;
  if (QUESTION_ABOUT_PAST.test(text) || HYPOTHETICAL.test(text)) return null;
  const rule = RULES.find((r) => r.re.test(text));
  if (!rule) return null;
  const scope = PERSISTENT.test(text) ? 'persistent' : /\bfor a (?:second|sec|minute|moment)\b/i.test(text) ? 'temporary' : 'situational';
  return { id: rule.id, scope, patch: { ...rule.patch }, reply: rule.reply };
}
