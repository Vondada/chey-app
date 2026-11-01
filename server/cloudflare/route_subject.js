// Subject checks for keyword routes.
//
// A deterministic route fires on a keyword ("status", "stress test", "memory") and answers from its own records. That
// is right only when the turn is about the route's own subject. "What is the status of the last security scan?" holds
// the keyword "status", but it asks about a security scan, which the coding-job status route knows nothing about.
//
// A route lists the words of its own subject. When the words the turn attaches to the keyword name something outside
// that list, the route steps aside and the turn goes on to the normal path. Pure functions only.

// Words that carry no subject: articles, pronouns, question words, linking verbs, time and politeness words.
const GENERIC = new Set(`a an the this that these those it its my your our their his her me you we us i him them
of for on in at to with about from by into onto over and or so then
is are was were be been being am do does did has have had can could will would should shall may might must
what whats which who whom whose how where when why there here
right now currently current last latest newest recent recently most all any some every each one ones
please sir che chay chey shay hey ok okay just again still yet today tonight so far up`.split(/\s+/).filter(Boolean));

const singular = (word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

/** The words of [text] that could name a subject: lower case, without generic words and bare numbers. */
export function subjectWords(text) {
  return String(text || '').toLowerCase().replace(/[’']/g, "'").replace(/'s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !/^\d+$/.test(word) && !GENERIC.has(word));
}

/** The words after the first match of [anchor], up to the end of that clause. Empty when the anchor is absent. */
export function phraseAfter(text, anchor) {
  const source = String(text || '');
  const match = new RegExp(anchor.source, anchor.flags.replace('g', '')).exec(source);
  if (!match) return '';
  return source.slice(match.index + match[0].length).split(/[.?!;:,\n]/)[0];
}

/** A set of a route's own subject words, matched with or without a plural "s". */
export function subjectSet(words) {
  return new Set(words.flatMap((word) => [word, singular(word)]));
}

/** The words in [phrase] that name something outside [own] (a set from subjectSet). */
export function foreignWords(phrase, own) {
  return subjectWords(phrase).filter((word) => !own.has(word) && !own.has(singular(word)));
}

/** True when [phrase] names a subject outside [own]: the route should step aside. */
export function namesOtherSubject(phrase, own) {
  return foreignWords(phrase, own).length > 0;
}

/** True when [phrase] holds a word from [subjects] (a set from subjectSet). */
export function mentionsSubject(phrase, subjects) {
  return subjectWords(phrase).some((word) => subjects.has(word) || subjects.has(singular(word)));
}
