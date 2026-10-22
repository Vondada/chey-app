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
const SPELLING = { favourite: 'favorite', favourites: 'favorites' };

function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).map((w) => SPELLING[w] || w);
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

/**
 * The fact an owner statement asserts, or null. Only a plain statement "my <subject> is <value>" qualifies: a question,
 * request, hypothetical, guess, quote or fiction does not. The subject keeps its words; the value keeps the owner's own.
 */
export function ownerAssertion(text) {
  const body = stripWake(text).replace(/^remember(?: that)?\s+/i, '').trim();
  if (!body || isQuestionLike(text) || ASKS_OR_ORDERS.test(body) || NOT_A_FACT.test(body)) return null;
  const match = FACT.exec(body);
  if (!match) return null;
  const subject = match[1].trim();
  const value = match[2].trim();
  if (!words(subject).length || NOT_PERSONAL.test(subject) || !value) return null;
  return { subject, subjectWords: words(subject), value, text: body.replace(/[.!]+$/, '') };
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
 * The owner's stored statement of this fact: an assertion whose subject is exactly the asked subject. The newest match
 * wins. Questions and other non-assertions are skipped here even when an older record holds them.
 */
export function recallPersonalFact(data = {}, question = {}, brainRecords = []) {
  const records = [...ownerAttestedRecords(data), ...statementsFromBrain(brainRecords)].filter((r) => r.text);
  const matches = [];
  for (const r of records) {
    const fact = ownerAssertion(r.text);
    if (fact && sameSubject(fact.subjectWords, question.words)) matches.push({ ...r, subject: fact.subject, value: fact.value });
  }
  return matches.length ? matches[matches.length - 1] : null;
}

/**
 * The owner's own chat turns kept in the Brain ("You said: …"), as statements. CHE's own answer in the same record is
 * never taken, so only what the owner wrote can be quoted.
 */
export function statementsFromBrain(records = []) {
  return (Array.isArray(records) ? records : [])
    .filter((r) => r && !r.deleted && r.verification === 'owner_attested' && r.source?.kind === 'owner_chat')
    .map((r) => {
      const said = /You said:\s*([\s\S]*?)(?:\nCHE answered:|$)/.exec(String(r.body || ''));
      return { id: r.id, text: said ? said[1].replace(/\s+/g, ' ').trim() : '', created_at: r.created_at };
    })
    .filter((r) => r.text);
}

/** The reply and the records it rests on. A miss says so and never guesses; a hit gives the stored subject and value. */
export function answerPersonalFact(data = {}, question = {}, brainRecords = []) {
  const record = recallPersonalFact(data, question, brainRecords);
  if (!record) {
    return {
      kind: 'none',
      records: [],
      answer: `I don't have a record of your ${question.subject}, sir, so I don't know it. Tell me and I'll remember it.${question.learn ? ' I also don\'t know where it came from.' : ''}`,
    };
  }
  const when = spokenStoredDate(record);
  const source = question.learn ? ' I learned it from you in this chat.' : '';
  const answer = `Your ${record.subject} is ${record.value}.${when ? ` You told me that on ${when}.` : ''}${source}`;
  return { kind: 'owner_attested', records: [record.id].filter(Boolean), answer };
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
