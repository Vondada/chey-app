// Story mode: how CHE behaves when the owner asks for fiction, a roleplay or casual drama talk.
// Pure functions only. The Worker adds storyModeBlock() to the chat prompt and leaves out the
// summary lines (atlas cards, "made across rooms", next-step offers) that turn a story into a report.

// What the owner is asking for. "ordinary" is every other turn, and it keeps the normal Soul rules.
export const STORY_MODES = Object.freeze(['story', 'roleplay', 'drama_talk', 'ordinary']);

// A request for a story: "tell me a story", "write a short story", "continue the story", "a scene where".
const STORY_ASK = /\b(?:tell|write|make up|create|continue|keep going on|give)\b[^.?!]{0,30}\b(?:story|stories|scene|episode|chapter|tale|fanfic)\b|\b(?:short story|bedtime story|story about|story where|story with|a scene (?:where|with|in which))\b/;
// Playing a character with the owner: "roleplay", "pretend you're my cousin", "be my neighbor", "you are my ex".
const ROLEPLAY_ASK = /\b(?:role ?play|in character|stay in character|pretend (?:you(?:'re| are)|to be)|be my|you are (?:now )?my|act like (?:my|a|an))\b/;
// Hood-drama talk, in any register: gossip, cheating, betrayal, neighbors, secrets, twists.
const DRAMA_TOPIC = /\b(?:gossip|tea|beef|cheat(?:ed|ing|s)?|cheater|betray(?:ed|al|s)?|side ?chick|baby ?mama|snitch(?:ed|ing)?|messing with (?:my|his|her)|neighbou?rs?|the block|on the block|block drama|secret|twist|she said|he said|they said|pulled up|showed out|ran (?:up|off) on|found out)\b/;
// A factual, technical or money ask keeps the ordinary rules, even when the words look like drama.
const FACTUAL_ASK = /\b(?:fact ?check|research|verify|look up|search for|news|sources?|citations?|code|bug|api|tokens?|passwords?|keys?|trade|trading|invoice|budget|price|legal advice|medical)\b/;

/**
 * The turn's mode, from the owner's message alone (history only breaks a tie; it is not read here).
 *   story      : "tell me a story about ..." or "continue the story": dialogue-led fiction.
 *   roleplay   : CHE plays a character with the owner, in the moment.
 *   drama_talk : the owner is chatting about drama in real life or in a show; short, natural replies.
 *   ordinary   : everything else.
 */
export function storyMode(message) {
  const text = String(message || '').toLowerCase().replace(/[’‘`]/g, "'").trim();
  if (!text) return 'ordinary';
  if (FACTUAL_ASK.test(text)) return 'ordinary';
  if (ROLEPLAY_ASK.test(text)) return 'roleplay';
  if (STORY_ASK.test(text)) return 'story';
  if (DRAMA_TOPIC.test(text)) return 'drama_talk';
  return 'ordinary';
}

// The rules a story turn follows. They sit after the Soul, so they are the specific genre rules for this turn.
const COMMON = [
  'DIALOGUE FIRST: the story is told through what the characters say and do. Let them talk over each other, interrupt, joke, dodge, argue, and react in their own words. Keep narration to a line or two of stage direction when a scene needs it.',
  'NO SPEECHES, NO LESSONS: no character gives a speech about what the moment means, and no moral, lesson, "in the end", or "what this teaches us". Let the twist land and stop. Do not explain the emotion after showing it.',
  'NO REPORT FORMAT: no headings, no bullet lists, no "Summary", "People", "Projects", "Key points", and no closing recap. Do not list what the characters know; show it in the scene.',
  'REAL PEOPLE, NOT TYPES: each character has a name, an age-appropriate voice, one clear want, one thing they hide, and a way of talking that is theirs (word choice, rhythm, how they start and end sentences). Dialect or regional speech only where it fits who the character is. No forced slang, no caricature, no assumptions about race, class or place from a name.',
  'CURSING: only when the character would actually say it in that moment, never in every line, and never to fill a space.',
  'EMOTIONS: reactions are specific and human: a laugh cut short, a long pause, "okay.", a door, a change of subject. Not a paragraph about how someone feels.',
  'CONTINUITY: keep every character\'s history, relationships, and what they already know. A secret stays hidden until a scene reveals it, and a revealed secret stays revealed. If the conversation above has a scene in progress, pick it up where it stopped.',
  'Stay inside the owner\'s request. Adult themes are fine in fiction; sexual content with real people, and any content that targets a real person, is not.',
];

const MODE_RULES = {
  story: [
    'MODE: STORY. Write one scene, about 120 to 300 words, ending on a line of dialogue or a beat that invites the owner to continue. Give the scene a neighborhood setting only if the owner\'s request asks for one.',
  ],
  roleplay: [
    'MODE: ROLEPLAY. Speak as the character in first person, one turn at a time: a few lines, then stop and let the owner answer. No narrator voice. Break character only if the owner asks, or if the request is harmful.',
  ],
  drama_talk: [
    'MODE: DRAMA TALK. The owner is chatting. Reply like a friend who has an opinion: one to three short sentences, one reaction, one question back if it helps. No story unless the owner asks for one. Never switch into a summary.',
  ],
};

/**
 * The prompt block for a story-style turn, or '' for an ordinary turn. The Worker appends it after the Soul.
 */
export function storyModeBlock(mode) {
  if (!MODE_RULES[mode]) return '';
  return [
    'STORY AND DRAMA CRAFT (this turn only; these rules outrank the general reply style above):',
    ...MODE_RULES[mode],
    ...COMMON,
  ].join('\n');
}

// True when this turn is fiction or drama talk: the Worker then leaves out the summary lines.
export function isStoryTurn(mode) {
  return mode === 'story' || mode === 'roleplay' || mode === 'drama_talk';
}
