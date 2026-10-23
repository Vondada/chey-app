// CHE answers "what is my favorite food?" from the owner's own stored statements, and nothing else.
//
// Bugs this fixes (owner, 2026-10-21, real iPhone test): asked "CHE, what is my favorite food, and where did you
// learn it?", CHE answered "You told me … 'CHE, what is my favorite food, and where did you learn it?' on October 21".
// Cause: the owner's own question was stored in the Brain as "You said: …", and recall took every stored owner turn as
// a statement, so the question matched its own subject words. Also, a wake prefix ("CHE,") was not stripped, so a
// prefixed question never reached this route at all.
//
// The rules now: a fact is an owner statement that asserts one ("my favorite food is pizza"). A question, request,
// hypothetical, quoted or uncertain statement is never a fact, and older records of that kind are skipped at recall,
// never deleted. The answer is the stored subject and value with the genuine date the owner gave it.
// groundedReply is the last check on every model reply: a date the stored records do not contain is never shown.
import { ownerAttestedRecords } from './memory_provenance.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const STOP = new Set(['the', 'a', 'an', 'my', 'your', 'of', 'to', 'in', 'is', 'are', 'and', 'or', 'it', 'that', 'this', 'me', 'you', 'i', 'do', 'did', 'know', 'what', 'which', 'whats', 'where']);
// "whats" without an apostrophe is how speech-to-text often writes "what's".
const PERSONAL = /^(?:what(?:'s|s| is| are)?|which(?: one is)?|do you (?:know|remember)|tell me|remind me|what do you know about)\s+(?:is |are |was |about )?(?:my|the owner'?s?|your owner'?s?)\s+(.{2,60})$/i;
// Asks where a fact came from, or whether CHE really has it stored: "how do you know that", "whether you have a memory of me saying it".
const LEARN = /\b(?:where|how) (?:did|do) you (?:learn|get|hear|know)\b|\bhow you know\b|\bwhether you (?:actually )?(?:have|remember)\b/i;
// Trading, market, system and measurement words belong to their own routes: "what is my MAE" is not a personal fact.
const NOT_PERSONAL = /\b(?:trad(?:e|es|ing)|paper|performance|volume|probability|mae|mfe|win|loss|streak|session|hour|price|market|portfolio|orders?|balance|chart|strateg(?:y|ies)|positions?|accounts?|rate|expectancy|drawdown|pnl|profit|eth|btc|nq|mnq|es)\b/i;

// The wake prefix in any spelling the owner speaks: "CHE, …", "Chay …", "chey: …", "Shay, …".
const WAKE = /^(?:(?:che|chay|chey|shay)[,:]?\s+)+/i;
// Starts like a question or a request, so it asks rather than states.
const ASKS_OR_ORDERS = /^(?:what|which|who|whom|whose|when|where|why|how|is|are|was|were|do|does|did|can|could|would|should|will|tell|remind|ask|show|list|find|search|quote|say|write|give|check|open|send|delete|remove|forget)\b/i;
// Not a statement the owner makes: a question mark, a guess, a hypothetical, a fiction, or a quote of an answer.
const NOT_A_FACT = /\?|\b(?:if|suppose|pretend|imagine|hypothetical|maybe|might|perhaps|probably|i think|i guess|i(?:'m| am) not sure|not sure|story|poem|joke|you said|you told me|che answered|che said)\b/i;
// "my favorite food is pizza", "my Worker URL is https://…": the owner's subject and value.
const FACT = /^my\s+(.{2,60}?)\s+(?:is|are)\s+(.{1,300}?)\.?$/i;

// British and American spellings are one subject: "favourite food" is the stored "favorite food".
const SPELLING = { favourite: 'favorite', favourites: 'favorites', fav: 'favorite', fave: 'favorite', favs: 'favorites' };

// Typed forms of the same word: "favfavorite" (a doubled "fav" from a typo) is "favorite"; any word that contains
// "favorite" with more letters around it is the same subject. Other typos fall through unchanged.
function canonical(w) {
  if (SPELLING[w]) return SPELLING[w];
  return w.length > 'favorite'.length && w.includes('favorite') ? 'favorite' : w;
}

function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).map(canonical);
}

/** The text with any leading wake prefix ("CHE, ", "Chay ") removed, whitespace collapsed. */
export function stripWake(text) {
  // The iPhone keyboard types curly apostrophes ("What’s"); they read as the straight one.
  return String(text || '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().replace(WAKE, '').trim();
}

/** True when the text is a question or a request, so it must never be saved or quoted as a fact. */
export function isQuestionLike(text) {
  const body = stripWake(text).replace(/^remember(?: that)?\s+/i, '');
  return body.endsWith('?') || ASKS_OR_ORDERS.test(body) || /\?/.test(String(text || ''));
}

// Values that point at something else rather than naming it: "this is my house" names no value.
const POINTER = /^(?:this|that|it|he|she|they|there|here|what|which|who|one)$/i;
// A hypothetical, a guess, a fiction or a quote of CHE's answer is never the owner's statement of fact.
const HEDGED = /\b(?:if|suppose|pretend|imagine|hypothetical|maybe|might|perhaps|probably|i think|i guess|i(?:'m| am) not sure|not sure|story|poem|joke|you said|you told me|che answered|che said)\b/i;
// "I like to drink Sprite the most": the activity names the favourite's subject.
const ACTIVITY = { drink: 'drink', eat: 'food', wear: 'clothes', watch: 'show', play: 'game', read: 'book', 'listen to': 'music' };
// "this test fact: …" is how the owner introduces a statement, never part of it.
const LEAD_IN = /^(?:(?:this|a|the following|my)\s+)?(?:test\s+)?(?:fact|note|information|detail)s?\s*[:,-]\s*/i;

/** The statement as the owner meant it, without the wake word, "remember" or a "this test fact:" lead-in. */
export function statementText(text) {
  return stripWake(text).replace(/^remember(?: that| this)?\s*[:,-]?\s*/i, '').replace(LEAD_IN, '').replace(/\s+/g, ' ').trim();
}

/**
 * Every fact one owner statement asserts, each { subject, subjectWords, value, text, confidence }. The forms (owner live
 * test, 2026-10-23, "what is my favorite drink" → "I don't have a record" although he had said it):
 *   "my favorite drink is Sprite", "my fav drink is sprite", "Sprite is my favorite drink",
 *   "I love Sprite, it's my favorite drink", "my favorite drink? Sprite.",
 *   "my favorite food is pizza, my favorite drink is Sprite, and my favorite color is red" (three facts),
 *   "I like to drink Sprite the most" (medium confidence: the owner never said the word "favorite"),
 *   and CHE's own older saved forms "Favorite drink: Sprite" and "Likes: Sprite, it's my favorite drink".
 * A question, request, hypothetical, guess, quote or fiction asserts nothing. Records are read as stored: this runs at
 * recall, so statements the owner made before this fix are found without rewriting them.
 */
export function ownerFacts(text) {
  let body = statementText(text);
  if (!body) return [];
  body = body.replace(/^favou?rite\s+([a-z][a-z ]{1,30}):\s*/i, 'my favorite $1 is ').replace(/^(?:likes|preference):\s*/i, 'I like ');
  if (HEDGED.test(body)) return [];
  const quote = body.replace(/[.!]+$/, '');
  const facts = [];
  const add = (subject, value, confidence) => {
    const subj = String(subject || '').trim();
    const val = String(value || '').trim().replace(/^(?:definitely|probably|just)\s+/i, '').replace(/[.!,;]+$/, '');
    if (!words(subj).length || NOT_PERSONAL.test(subj) || !val || POINTER.test(val) || val.split(/\s+/).length > 40) return;
    facts.push({ subject: subj, subjectWords: words(subj), value: val, text: quote, confidence });
  };
  // "my favorite drink? Sprite.": the owner answers his own question.
  const qa = /^my\s+(.{2,60}?)\s*\?\s*(.{1,100}?)\.?$/i.exec(body);
  if (qa && !/\?/.test(qa[2])) { add(qa[1], qa[2], 'high'); return facts; }
  if (/\?/.test(body) || ASKS_OR_ORDERS.test(body)) return [];
  for (const clause of body.split(/\s*;\s*|\.\s+|\s*,\s*(?:and\s+)?(?=my\s)|\s+and\s+(?=my\s)/i)) {
    let m;
    if ((m = /^my\s+(.{2,60}?)\s+(?:is|are|was|=)\s+(.{1,300}?)[.!]*$/i.exec(clause))) add(m[1], m[2], 'high');
    else if ((m = /^my\s+(.{2,60}?)'s\s+(.{1,300}?)[.!]*$/i.exec(clause))) add(m[1], m[2], 'high');
    else if ((m = /^i\s+(?:really\s+)?(?:love|like|prefer|enjoy)\s+(.{1,60}?)\s*[,;]?\s+(?:and\s+)?(?:it'?s|it is|that'?s|that is|which is|thats)\s+my\s+(.{2,60}?)[.!]*$/i.exec(clause))) add(m[2], m[1], 'high');
    else if ((m = /^i\s+(?:really\s+)?(?:like|love|prefer)\s+to\s+(drink|eat|wear|watch|play|read|listen to)\s+(.{1,60}?)\s+(?:the\s+)?(?:most|best)[.!]*$/i.exec(clause))) add(`favorite ${ACTIVITY[m[1].toLowerCase()]}`, m[2], 'medium');
    else if ((m = /^(.{1,60}?)\s+(?:is|are)\s+my\s+(.{2,60}?)[.!]*$/i.exec(clause)) && !/^my\b/i.test(m[1])) add(m[2], m[1], 'high');
  }
  return facts;
}

/** The first fact an owner statement asserts, or null (see ownerFacts). */
export function ownerAssertion(text) {
  if (isQuestionLike(text) && !/^my\s+.{2,60}?\s*\?\s*[^?]+$/i.test(statementText(text))) return null;
  return ownerFacts(text)[0] || null;
}

/** The subject of a personal question, or null when the words are not asking for a personal fact. */
export function personalFactQuestion(message) {
  const text = stripWake(message);
  if (!text || /\b(?:story|fiction|pretend|imagine|hypothetical|poem|joke)\b/i.test(text)) return null;
  const learn = LEARN.test(text);
  // The asked sentence ends at its first question mark or full stop. What follows ("Tell me how you know that…") is an
  // instruction about the answer, never part of the subject.
  const [asked] = text.split(/[?!.]/);
  const [head] = asked.split(/,|\band\b|\bwhere\b/i);
  const match = PERSONAL.exec(head.trim());
  if (!match) return null;
  const subject = match[1].replace(/\b(?:and|please)\b.*$/i, '').trim();
  if (!words(subject).length || NOT_PERSONAL.test(subject)) return null;
  return { subject, learn, words: words(subject) };
}

// The owner's calendar. Stored instants stay UTC; only the day shown or spoken is converted to America/Chicago,
// which moves between CDT and CST by itself.
const OWNER_ZONE = 'America/Chicago';
const OWNER_DAY = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_ZONE, year: 'numeric', month: 'numeric', day: 'numeric' });

/** The owner's calendar day for an instant: { year, month (1-12), day } in America/Chicago. */
export function ownerDay(at) {
  const parts = Object.fromEntries(OWNER_DAY.formatToParts(at).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** The date a record was stored, spoken as "October 21, 2026" on the owner's calendar, from its ISO stamp or recorded day. */
export function spokenStoredDate(record = {}) {
  const at = new Date(String(record.created_at || record.recorded || ''));
  if (!Number.isFinite(at.getTime())) return '';
  const day = ownerDay(at);
  return `${MONTHS[day.month - 1]} ${day.day}, ${day.year}`;
}

// Same subject, same words, in any order: "favorite food" matches "food favorite"; "favorite drink" never matches "food".
function sameSubject(a, b) {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((w) => y.has(w));
}

/**
 * CHE's own older saved preferences ("Favorite drink: Sprite"), written from the owner's chat before memory records
 * existed. They are inferred from his words, so an answer from one says it was saved from the chat.
 */
export function legacyPreferences(data = {}) {
  const dated = (Array.isArray(data.preference_memory) ? data.preference_memory : [])
    .filter((p) => p?.text).map((p) => ({ id: p.id, text: String(p.text), created_at: p.created_at, legacy: true }));
  const seen = new Set(dated.map((p) => p.text.toLowerCase()));
  const plain = (Array.isArray(data.memories) ? data.memories : [])
    .map(String).filter((t) => t && !seen.has(t.toLowerCase())).map((t) => ({ text: t, legacy: true }));
  return [...plain, ...dated];
}

/**
 * The owner's stored statement of this fact: an assertion whose subject is exactly the asked subject, from memory
 * records, the Brain's kept owner turns and CHE's older saved preferences. The newest dated match wins, so a correction
 * ("my favorite color is red", after "blue") replaces the old value. Questions and other non-assertions are skipped here
 * even when an older record holds them.
 */
export function recallPersonalFact(data = {}, question = {}, brainRecords = [], phoneNotes = []) {
  // Phone notes come first: they carry no date, so any dated or legacy record of the same fact wins over them.
  const records = [...phoneNotes, ...legacyPreferences(data), ...ownerAttestedRecords(data), ...statementsFromBrain(brainRecords)].filter((r) => r.text);
  const matches = [];
  for (const r of records) {
    for (const fact of ownerFacts(r.text)) {
      if (sameSubject(fact.subjectWords, question.words)) matches.push({ ...r, subject: fact.subject, value: fact.value, confidence: fact.confidence, quote: fact.text });
    }
  }
  if (!matches.length) return null;
  const time = (m) => { const t = Date.parse(String(m.created_at || m.recorded || '')); return Number.isFinite(t) ? t : -Infinity; };
  // Stable: equal times keep their order, so the newest of the undated legacy entries still comes last.
  return matches.map((m, i) => ({ m, i })).sort((a, b) => (time(a.m) - time(b.m)) || (a.i - b.i)).at(-1).m;
}

/**
 * The owner's own chat turns kept in the Brain ("You said: …"), as statements. CHE's own answer in the same record is
 * never taken, so only what the owner wrote can be quoted.
 */
export function statementsFromBrain(records = []) {
  return (Array.isArray(records) ? records : [])
    .filter((r) => r && !r.deleted && r.verification === 'owner_attested' && ['owner_chat', 'chatgpt_export'].includes(r.source?.kind))
    .map((r) => {
      const said = /You said:\s*([\s\S]*?)(?:\n(?:CHE|ChatGPT) answered:|$)/.exec(String(r.body || ''));
      // A ChatGPT turn keeps the time the owner wrote it there, not the import time.
      const at = r.source?.kind === 'chatgpt_export' ? (r.source.message_at || r.created_at) : r.created_at;
      return { id: r.id, text: said ? said[1].replace(/\s+/g, ' ').trim() : '', created_at: at, brain: true, origin: r.source?.kind, title: r.source?.conversation_title || '' };
    })
    .filter((r) => r.text);
}

/** The reply and the records it rests on. A miss says so and never guesses; a hit gives the stored subject and value. */
export function answerPersonalFact(data = {}, question = {}, brainRecords = [], phoneNotes = []) {
  const record = recallPersonalFact(data, question, brainRecords, phoneNotes);
  if (!record) {
    return {
      kind: 'none',
      records: [],
      answer: `I don't have a record of your ${question.subject}, sir, so I don't know it. Tell me and I'll remember it.${question.learn ? ' I also don\'t know where it came from.' : ''}`,
    };
  }
  const when = spokenStoredDate(record);
  // The owner's own words are quoted whenever they are not just "my X is Y", or he asks where it came from.
  const plain = /^my\s+.{2,60}?\s+(?:is|are)\s+[^,;]+$/i.test(record.quote || '');
  const quoted = record.quote && (question.learn || !plain || record.confidence !== 'high') ? ` In your words: "${record.quote}."` : '';
  // A note from the phone's Brain says only what it holds: the phone does not send who wrote it or when.
  if (record.phone) {
    const lead = record.confidence === 'high' ? `Your ${String(question.subject || record.subject).replace(/\bfav(?:ourite|orite|e)?\b/gi, 'favorite')} is ${record.value}.` : `Your Brain notes say your ${question.subject} is ${record.value}.`;
    return { kind: 'brain_note', records: [], record, answer: `${lead} That is from the Brain notes on your phone: "${record.note}". The note has no date, and it doesn't say whether you typed it or I saved it from a chat.` };
  }
  const told = record.legacy
    ? (when ? ` I saved it from our chat on ${when}.` : ' I saved it from our chat; that older note has no date.')
    : (when ? ` You told me that on ${when}.` : '');
  const source = question.learn ? (record.legacy ? ' It came from you in a chat, as a saved preference, not from anywhere else.' : ' I learned it from you in this chat.') : '';
  const subject = String(question.subject || record.subject).replace(/\bfav(?:ourite|orite|e)?\b/gi, 'favorite');
  const lead = record.confidence === 'high' ? `Your ${subject} is ${record.value}.` : `It sounds like your ${subject} is ${record.value}, from what you told me.`;
  return { kind: 'owner_attested', records: [record.id].filter(Boolean), record, answer: `${lead}${told}${quoted}${source}` };
}

// ─── Stored statements that are not "my X is Y" ─────────────────────────────────────────────────────────────────────
// Owner live test (2026-10-23): "Remember this test fact: The fictional project Blue Lantern uses the internal code word
// Magnolia Seven", then, in a new conversation, "What is the secret code word for the fictional Blue Lantern project?".
// The record was stored and even sat in the model's context, but no route answered from it, so the reply was whatever
// the model wrote ("I don't know" on the iPhone; an invented code word in replay). A question whose words name a stored
// statement now gets that statement, quoted with its date, and the model is never asked.

// Question and filler words that say nothing about which record is meant.
const ASK_WORDS = new Set(['who', 'whom', 'whose', 'when', 'why', 'how', 'was', 'were', 'does', 'can', 'could', 'would', 'should', 'will', 'tell', 'remind', 'remember', 'recall', 'say', 'said', 'told', 'please', 'again', 'exactly', 'actually', 'secret', 'called', 'stored', 'saved', 'about', 'for', 'with', 'from', 'on', 'at', 'by', 'have', 'has', 'had', 'be', 'been', 'any', 'there', 'thing', 'things', 'sir', 'che', 'use', 'uses', 'used', 'using']);

function keyWords(text) {
  return [...new Set(words(text).filter((w) => w.length > 1 && !ASK_WORDS.has(w)))];
}

/** The words of a question that could name a stored statement, or null. Only questions qualify. */
export function storedStatementQuestion(message) {
  const text = stripWake(message);
  if (!text || !isQuestionLike(text)) return null;
  if (/\b(?:story|pretend|imagine|hypothetical|poem|joke)\b/i.test(text)) return null;
  const asked = keyWords(text.split(/[?!]/)[0]);
  return asked.length >= 2 ? { words: asked, learn: LEARN.test(text) } : null;
}

/**
 * The owner's stored statement a question names, or the candidates when two differ. A match shares at least three of
 * the question's key words (all of them when it has fewer) and at least 60% of them, and the statement says more than
 * the question does: that remainder is the answer.
 */
export function recallStoredStatement(data = {}, question = {}, brainRecords = []) {
  const asked = new Set(question.words || []);
  if (asked.size < 2) return { kind: 'none', matches: [] };
  // The Brain's copy of a turn first, so the owner's memory record of the same words (the one its receipt named) wins.
  const records = [...statementsFromBrain(brainRecords), ...ownerAttestedRecords(data)].filter((r) => r.text && !isQuestionLike(r.text));
  const scored = [];
  for (const r of records) {
    const text = statementText(r.text);
    if (!text || HEDGED.test(text)) continue;
    const own = keyWords(text);
    const shared = own.filter((w) => asked.has(w)).length;
    const extra = own.filter((w) => !asked.has(w)).length;
    if (shared >= Math.min(3, asked.size) && shared / asked.size >= 0.6 && extra > 0) scored.push({ ...r, statement: text, score: shared / asked.size });
  }
  if (!scored.length) return { kind: 'none', matches: [] };
  const best = Math.max(...scored.map((x) => x.score));
  // The newest record of each distinct statement wins; older copies of the same words are one memory.
  const top = new Map();
  for (const x of scored.filter((y) => y.score === best)) top.set(x.statement.toLowerCase().replace(/[.!]+$/, ''), x);
  const matches = [...top.values()];
  return { kind: matches.length === 1 ? 'one' : 'several', matches };
}

/** The reply for a stored-statement question: the statement with its date, the candidates, or null to let others answer. */
export function answerStoredStatement(data = {}, question = {}, brainRecords = []) {
  const found = recallStoredStatement(data, question, brainRecords);
  if (found.kind === 'none') return null;
  const said = (r) => r.statement.replace(/[.!]+$/, '');
  if (found.kind === 'one') {
    const r = found.matches[0];
    const when = spokenStoredDate(r);
    return {
      kind: 'owner_attested', records: [r.id].filter(Boolean), record: r,
      answer: `From what you told me, sir: "${said(r)}."${when ? ` You told me that on ${when}.` : ''} That's your own statement saved in my memory, not an outside fact I checked.`,
    };
  }
  const list = found.matches.slice(0, 3).map((r, i) => `${i + 1}. "${said(r)}"`).join(' ');
  return {
    kind: 'owner_attested', records: found.matches.slice(0, 3).map((r) => r.id).filter(Boolean),
    answer: `I have ${found.matches.length} things you told me that fit, sir: ${list}. Which one do you mean?`,
  };
}

// Dates and attributions a reply may show: only what a stored record holds. Anything else is removed.
const DATE_RE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g;

function storedDates(records = []) {
  const out = new Set();
  for (const r of records) {
    for (const raw of [r?.created_at, r?.recorded, r?.superseded_at]) {
      const at = new Date(String(raw || ''));
      if (!Number.isFinite(at.getTime())) continue;
      const day = ownerDay(at);
      out.add(`${MONTHS[day.month - 1]} ${day.day}, ${day.year}`);
      out.add(`${MONTHS[day.month - 1]} ${day.day} ${day.year}`);
      out.add(`${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`);
    }
  }
  return out;
}

/**
 * Checks a model reply against the stored records. A date that no record holds is never shown: the reply is replaced
 * with an honest "I don't have that date" line. Returns { text, removed } so the caller can log what was caught.
 */
export function groundedReply(reply, { records = [], message = '' } = {}) {
  // Most replies hold no date: skip formatting every record's dates (a cost per memory, on every reply).
  if (!(String(reply || '').match(DATE_RE) || []).length) return { text: reply, removed: [] };
  const allowed = storedDates(records);
  for (const d of String(message || '').match(DATE_RE) || []) allowed.add(d);
  const invented = (String(reply || '').match(DATE_RE) || []).filter((d) => !allowed.has(d));
  if (!invented.length) return { text: reply, removed: [] };
  // Only the sentences that show an invented date go; the rest of the reply stays as the model wrote it.
  const kept = String(reply).split(/(?<=[.!?])\s+/).filter((sentence) => !(sentence.match(DATE_RE) || []).some((d) => !allowed.has(d)));
  const note = 'I don\'t have a stored date for that, sir, so I cannot verify it and won\'t give one.';
  return { text: kept.length ? `${kept.join(' ')} ${note}` : note, removed: invented };
}

// A factual or memory question (about the owner, his memories or CHE's library) is answered by the strongest engine:
// the small fast model invents details that a question like this cannot tolerate.
export function needsStrongEngine(message = '') {
  const text = String(message || '');
  const asksFact = /^\s*(?:what|which|who|when|where|how (?:many|much|long|old)|is it true|do you know|did i)\b/i.test(text)
    || /\b(?:do you remember|what do you know|have i told you|did i (?:tell|say))\b/i.test(text);
  const aboutOwner = /\b(?:my|mine|i|me|your|you)\b/i.test(text) || /\b(?:knowledge library|my library|memor(?:y|ies)|learn(?:ed|ing)?|book|books)\b/i.test(text);
  return asksFact && aboutOwner;
}
