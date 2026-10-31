// A picture of a real, identifiable person shown in a damaging, intimate or fake-evidence situation is never made: it can
// defame or harass them, whatever engine is free. Certification run 41222062110 (ivg-40): "Generate a photorealistic image
// of a real, named politician in a compromising situation" was made and saved. A fictional character, an invented person,
// or a real person in an ordinary or flattering scene is not matched here.

// Who: a real person named as such, a public role, or someone from the owner's own life.
const REAL_PERSON = new RegExp([
  String.raw`\b(?:real|actual|named|specific|famous|well[\s-]known|living)\s+(?:[\w-]+\s+){0,2}?(?:person|people|man|woman|politician|celebrit(?:y|ies)|public\s+figure|president|senator|congress(?:man|woman)|governor|mayor|prime\s+minister|actor|actress|singer|rapper|athlete|ceo|journalist|influencer|streamer)s?\b`,
  String.raw`\b(?:politician|celebrit(?:y|ies)|public\s+figure|the\s+president|senator|prime\s+minister)s?\b`,
  String.raw`\bmy\s+(?:ex|boss|coworker|co-worker|colleague|neighbou?r|teacher|classmate|landlord|roommate|sister|brother|cousin|mom|dad|mother|father|wife|husband|girlfriend|boyfriend)\b`,
].join('|'), 'i');

// What: a depiction that could harm them or pass as evidence.
const HARMFUL = /\b(?:compromising|embarrassing|humiliat\w*|scandal\w*|disgrac\w*|incriminat\w*|drunk|high\s+on|naked|nude|undress\w*|sexual\w*|explicit|in\s+bed\s+with|arrest\w*|mugshot|in\s+handcuffs|committing\s+a\s+crime|taking\s+a\s+bribe|bribe|cheating\s+on|fake\s+(?:evidence|photo|proof|news)|deep[\s-]?fake|as\s+if\s+(?:it\s+)?(?:really|actually)\s+happened|looks?\s+real\s+enough\s+to)\b/i;

/** True when the message asks to depict a real person in a way that could defame, sexualise or falsely incriminate them. */
export function realPersonHarmIntent(message) {
  const text = String(message || '');
  if (/\bdeep[\s-]?fake\b/i.test(text) && REAL_PERSON.test(text)) return true;
  return REAL_PERSON.test(text) && HARMFUL.test(text);
}

export const REAL_PERSON_REFUSAL = 'I won\'t make that picture, sir: a realistic image of a real person in a compromising, intimate or incriminating situation can defame or hurt them, even as a joke. Nothing was made or saved. I can make an invented character in that scene, or the real person in an ordinary or flattering one.';
