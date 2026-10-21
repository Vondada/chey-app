// CHE answers "what is my favorite food?" from the owner's own stored statements, and nothing else.
//
// The bug this fixes (owner, 2026-10-21): "What is my favorite food…" matched no memory route, so the language model
// answered it with every stored memory in its prompt. It gave "favorite drink" for a food question and an invented
// date. Here the subject must match a stored statement exactly (every content word of it), the answer quotes that
// statement with the date it was stored, and with no match CHE says so and asks the owner to tell her.
//
// groundedReply is the last check on every model reply: a date the stored records do not contain is never shown.
import { ownerAttestedRecords } from './memory_provenance.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const STOP = new Set(['the', 'a', 'an', 'my', 'your', 'of', 'to', 'in', 'is', 'are', 'and', 'or', 'it', 'that', 'this', 'me', 'you', 'i', 'do', 'did', 'know', 'what', 'which', 'whats', 'where']);
const PERSONAL = /^(?:what(?:'s| is| are)?|which(?: one is)?|do you (?:know|remember)|tell me|remind me|what do you know about)\s+(?:is |are |was |about )?(?:my|the owner'?s?|your owner'?s?)\s+(.{2,60})$/i;
const WAKE = /^(?:(?:hey|ok|okay)\s+)?(?:(?:che|chey|chay|shay)\b[,:]?\s*)/i;
const LEARN = /\b(?:where|how) did you (?:learn|get|hear)\b/i;
// Trading, market, system and measurement words belong to their own routes: "what is my MAE" is not a personal fact.
const NOT_PERSONAL = /\b(?:trad(?:e|es|ing)|paper|performance|volume|probability|mae|mfe|win|loss|streak|session|hour|price|market|portfolio|orders?|balance|chart|strateg(?:y|ies)|positions?|accounts?|rate|expectancy|drawdown|pnl|profit|eth|btc|nq|mnq|es)\b/i;

// British and American spellings of the same word match: a stored "favourite food" answers "favorite food".
const SPELLING = { favourite: 'favorite', colour: 'color', flavour: 'flavor', honour: 'honor', organise: 'organize', centre: 'center' };

function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).map((w) => SPELLING[w] || w).filter((w) => w && !STOP.has(w));
}

/** The subject of a personal question, or null when the words are not asking for a personal fact. */
export function personalFactQuestion(message) {
  // The wake word ("CHE," / "Hey CHE,") is not part of the question. Left in, its comma split the sentence at once.
  const text = String(message || '').replace(/\s+/g, ' ').trim().replace(WAKE, '').replace(/[?.!]+$/, '');
  if (!text || /\b(?:story|fiction|pretend|imagine|hypothetical|poem|joke)\b/i.test(text)) return null;
  const learn = LEARN.test(text);
  const [head] = text.split(/,|\band\b|\bwhere\b/i);
  const match = PERSONAL.exec(head.trim());
  if (!match) return null;
  const subject = match[1].replace(/\b(?:and|please)\b.*$/i, '').trim();
  if (!words(subject).length || NOT_PERSONAL.test(subject)) return null;
  return { subject, learn, words: words(subject) };
}

/** The date a record was stored, spoken as "October 21, 2026", from its ISO stamp or its recorded day. */
export function spokenStoredDate(record = {}) {
  const at = new Date(String(record.created_at || record.recorded || ''));
  if (!Number.isFinite(at.getTime())) return '';
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}`;
}

/**
 * The owner's own statement that matches the subject: every content word of the subject appears in it.
 * "food" never matches "my favorite drink is Sprite".
 */
export function recallPersonalFact(data = {}, question = {}, brainRecords = []) {
  const records = [...ownerAttestedRecords(data), ...statementsFromBrain(brainRecords)].filter((r) => r.text);
  const matches = records.filter((r) => {
    const body = new Set(words(r.text));
    return question.words.every((w) => body.has(w));
  });
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

/** The reply and the records it rests on. A miss says so and never guesses; a hit quotes the stored statement. */
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
  const statement = String(record.text).replace(/[.!]+$/, '');
  const quoted = `You told me "${statement.charAt(0).toUpperCase()}${statement.slice(1)}"${when ? ` on ${when}` : ''}.`;
  const source = question.learn ? ' I learned it from you in this chat.' : '';
  return { kind: 'owner_attested', records: [record.id].filter(Boolean), answer: `${quoted}${source}` };
}

// Dates and attributions a reply may show: only what a stored record holds. Anything else is removed.
const DATE_RE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g;

function storedDates(records = []) {
  const out = new Set();
  for (const r of records) {
    for (const raw of [r?.created_at, r?.recorded, r?.superseded_at]) {
      const at = new Date(String(raw || ''));
      if (!Number.isFinite(at.getTime())) continue;
      out.add(`${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}`);
      out.add(`${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()} ${at.getUTCFullYear()}`);
      out.add(at.toISOString().slice(0, 10));
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
