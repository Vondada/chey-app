// Context echo: stored text handed to the model is reference data, never the reply itself.
//
// Run 22 (Worker d9062d9d): a short or vague turn got a stored line back as the answer. "Keep going." got a
// transcript of "CHE: Sir, I have a note that the owner mentioned ..." lines, "You promised to remember a code for
// me. What was it?" got an old owner message word for word, "finish it" got an Office brief retold as a memory, and
// "Summarise our three-year history ..." got an invented history. Three general rules, checked on the reply:
//   1. A reply never carries a speaker label ("CHE:", "Owner:", "You said:") copied from a transcript.
//   2. A reply that is mostly a word-for-word copy of an injected memory line, and does not take up the message's
//      own words, is replaced with an honest "no record". Detected by overlap with the stored text, not by the
//      question's wording.
//   3. A request to summarise a long stretch of history is answered from the records: counts, dates, and what is
//      not recorded.

import { listConversationMemories, memoryTokens, recallMemories } from './brain_memory.js';
import { isOwnerAttested, storyRequested } from './memory_provenance.js';

// A label at the start of the reply or of a sentence or line. Only speaker names: "Note:" or "Step 1:" stay.
const SPEAKER_LABEL = /(^|[.!?]["”']?\s+|\n\s*)(?:CHE|Owner|The owner(?: wrote(?: then)?| said)?|User|Assistant|Human|You said|You wrote)\s*:\s*/gi;
// The owner asked for a script, a dialogue or a transcript: labelled lines are the point.
const LABELS_WANTED = /\b(?:script|screenplay|dialog(?:ue)?|transcript|conversation between|role[- ]?play|interview|scene)\b/i;
// The owner asked for his own words back.
// Or for what is stored about him: then a stored line is the answer.
const READ_BACK = /\b(?:repeat|read (?:it|that|them|this|those|my \w+)? ?back|word for word|verbatim|quote|exact words|what did i (?:say|write|type|tell you)|what do you (?:know|remember|have (?:stored|saved|noted)) (?:about|on|of) (?:me|my)|(?:list|show|read) (?:me )?(?:my|your|the) (?:memories|notes|records))\b/i;

const words = (text) => String(text || '').toLowerCase().replace(/[’‘`]/g, "'").match(/[a-z0-9']+/g) || [];

/** Rule 1: speaker labels removed. `count` is how many there were. */
export function stripSpeakerLabels(reply, { message = '', conversation = [] } = {}) {
  const text = String(reply || '');
  if (LABELS_WANTED.test(message) || storyRequested(message)) return { text, count: 0 };
  // Labelled lines the owner pasted into this conversation are his text to work on.
  if (conversation.some((line) => new RegExp(SPEAKER_LABEL.source, 'i').test(String(line || '')))) return { text, count: 0 };
  let count = 0;
  const out = text.replace(SPEAKER_LABEL, (_, lead) => { count++; return lead; }).trim();
  return { text: count ? out.replace(/^\s*[a-z]/, (c) => c.toUpperCase()) : text, count };
}

const GRAM = 4;
const grams = (list) => {
  const out = [];
  for (let i = 0; i + GRAM <= list.length; i++) out.push(list.slice(i, i + GRAM).join(' '));
  return out;
};

/** How much of [reply] is copied word for word from [lines]: share of its 4-word runs, and the longest copied run. */
export function copiedShare(reply, lines) {
  const replyWords = words(reply);
  const replyGrams = grams(replyWords);
  if (!replyGrams.length) return { share: 0, run: 0 };
  const pool = new Set();
  for (const line of lines) for (const g of grams(words(line))) pool.add(g);
  let hit = 0;
  let run = 0;
  let best = 0;
  for (const g of replyGrams) {
    if (pool.has(g)) { hit++; run = run ? run + 1 : GRAM; best = Math.max(best, run); } else run = 0;
  }
  return { share: hit / replyGrams.length, run: best };
}

/** Share of the message's content words the reply takes up (a 5-letter stem counts: "promised" ~ "promise"). */
export function messageCoverage(message, reply) {
  const asked = memoryTokens(message);
  if (!asked.length) return 0;
  const stems = new Set(words(reply).map((w) => w.slice(0, 5)));
  return asked.filter((t) => stems.has(t.slice(0, 5))).length / asked.length;
}

/** The stored text this turn's prompt carried: owner memories, CHE notes, imported context, nightly notes, Brain lines. */
export function injectedLines({ data = {}, brainContext = '' } = {}) {
  const lines = [];
  for (const r of Array.isArray(data.memory_records) ? data.memory_records : []) lines.push(r?.text);
  for (const m of Array.isArray(data.memories) ? data.memories : []) lines.push(m);
  for (const c of Array.isArray(data.owner_context) ? data.owner_context : []) lines.push(c?.title, c?.text);
  const nightly = Array.isArray(data.nightly_reviews) ? data.nightly_reviews[0] : null;
  if (nightly) lines.push(nightly.summary, ...(nightly.lessons || []), ...(nightly.open_threads || []));
  lines.push(...String(brainContext || '').split('\n'));
  return lines.map((l) => String(l ?? '')).filter((l) => l.trim());
}

export const NO_RECORD_QUESTION = 'I don\'t have a record that answers that, sir, and I won\'t guess from old notes. What should I look for?';
export const NO_RECORD_FOLLOW_UP = 'I don\'t have a record of what you want me to continue, sir. Which task do you mean?';
// A question gets "no record"; a request to go on ("do that thing", "wrap it up") gets "which one?".
const QUESTION = /\?\s*$|^\s*(?:what|which|who|when|where|why|how)\b|^\s*(?:do|did|does|is|are|was|were|can|could|have|has)\s+(?:i|you|we|it|he|she|they|my|your|the)\b/i;
const honestNoRecord = (message) => (QUESTION.test(String(message || '').trim()) ? NO_RECORD_QUESTION : NO_RECORD_FOLLOW_UP);

/**
 * Rules 1 and 2. `remembered` is an async loader for the remembered talks the prompt carried (only called when the
 * reply already looks like a copy). Returns { text, removed }.
 */
export async function guardContextEcho(reply, { message = '', data = {}, brainContext = '', ownerHistory = [], screenContext = '', remembered = null } = {}) {
  const original = String(reply || '');
  // This conversation (the message, its turns, a shared screen) is text being worked on, not stored memory: "fix the
  // typos" after a pasted essay is mostly a copy of it, and rightly so.
  const conversation = [message, screenContext, ...(Array.isArray(ownerHistory) ? ownerHistory : []).map((t) => t?.content ?? t?.text)].map((l) => String(l ?? '')).filter((l) => l.trim());
  const labels = stripSpeakerLabels(original, { message, conversation });
  const text = labels.text;
  if (READ_BACK.test(message) || words(text).length < 8 || messageCoverage(message, text) >= 0.5 || copiedShare(text, conversation).share >= 0.3) {
    return { text, removed: labels.count ? [{ rule: 'speaker_label', sentence: original.slice(0, 200) }] : [] };
  }
  // Two or more labels make a transcript, not an answer.
  const transcript = labels.count >= 2;
  let echo = false;
  if (!transcript) {
    const lines = injectedLines({ data, brainContext });
    let copy = copiedShare(text, lines);
    if (copy.share < 0.5 && copy.run < 12 && typeof remembered === 'function') {
      const extra = await Promise.resolve().then(remembered).catch(() => []);
      if (extra?.length) copy = copiedShare(text, [...lines, ...extra]);
    }
    echo = copy.share >= 0.5 || (copy.share >= 0.3 && copy.run >= 12);
  }
  if (!transcript && !echo) {
    return { text, removed: labels.count ? [{ rule: 'speaker_label', sentence: original.slice(0, 200) }] : [] };
  }
  return { text: honestNoRecord(message), removed: [{ rule: transcript ? 'transcript_echo' : 'context_echo', sentence: original.slice(0, 200) }] };
}

// ─── Rule 3: a long history, summarised from the records ─────────────────────

const SUMMARY_VERB = /\b(?:summari[sz]e|summary|recap|overview|sum up|run (?:me )?through|go over|walk me through)\b/i;
// Conversation history, not a sales or price history.
const HISTORY_NOUN = /\b(?:conversations?|talks|chats|discussions)\b|\bour\s+(?:[\w-]+\s+){0,3}history\b|\bhistory\s+(?:with you|together|of (?:our|us))\b/i;
const OURS = /\b(?:our|we|us)\b|\bwith you\b|\byou and (?:i|me)\b/i;
const LONG_SPAN = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|many)[-\s](?:years?|months?)\b|\b(?:years|months|all[- ]time|ever|since we (?:started|met)|whole|entire|long[- ]term|all (?:of )?our)\b/i;
const NUMBER = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** The request asks for a summary of a long stretch of past conversations. Returns { topic, days } or null. */
export function longHistoryRequest(message) {
  const text = String(message || '').replace(/[’‘`]/g, "'");
  if (!SUMMARY_VERB.test(text) || !HISTORY_NOUN.test(text) || !OURS.test(text) || !LONG_SPAN.test(text)) return null;
  const span = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[-\s](years?|months?)\b/i.exec(text);
  const n = span ? Number(span[1]) || NUMBER[span[1].toLowerCase()] : 0;
  const days = n ? n * (/^y/i.test(span[2]) ? 365 : 30) : 0;
  const about = /\b(?:about|on|regarding|around)\s+(?:my|our|the)?\s*([\s\S]{2,60}?)\s*(?:[.?!]|$)/i.exec(text);
  return { topic: about ? memoryTokens(about[1]) : [], days };
}

const day = (value) => String(value || '').slice(0, 10);
const clipQuote = (value) => { const s = String(value || '').replace(/\s+/g, ' ').trim(); return s.length > 140 ? `${s.slice(0, 137)}...` : s; };
const mentions = (text, topic) => { const stems = new Set(words(text).map((w) => w.slice(0, 5))); return topic.some((t) => stems.has(t.slice(0, 5))); };

/** Rule 3: what the records hold for a long-history summary, with counts and dates, and what they do not hold. */
export async function historySummaryReply(ask, { data = {}, storage = null, message = '', now = Date.now() } = {}) {
  const records = (Array.isArray(data.memory_records) ? data.memory_records : []).filter((r) => r?.text && r.active !== false && !r.superseded_at);
  let talks = [];
  try { talks = storage ? await listConversationMemories(storage, { limit: 2000 }) : []; } catch (_) { talks = []; }
  const asked = String(message || '').trim().toLowerCase();
  // This same question, asked before, is not history about the topic.
  if (asked) talks = talks.filter((t) => String(t.title || '').trim().toLowerCase() !== asked && !String(t.body || '').toLowerCase().startsWith(`you said: ${asked}`));
  const dates = [...records.map((r) => day(r.created_at)), ...talks.map((t) => day(t.at))].filter(Boolean).sort();
  const topicName = ask.topic.join(' ');
  if (!dates.length) {
    return `I don't have a record of past conversations${topicName ? ` about ${topicName}` : ''}, sir. Nothing is stored yet, so there is no history I can summarise without inventing it.`;
  }
  const parts = [`Here is what is stored, sir: ${talks.length} saved conversation${talks.length === 1 ? '' : 's'} and ${records.length} stored memor${records.length === 1 ? 'y' : 'ies'}, from ${dates[0]} to ${dates[dates.length - 1]}.`];
  if (ask.topic.length) {
    const hits = [
      ...records.filter((r) => mentions(r.text, ask.topic)).map((r) => ({ at: day(r.created_at), text: r.text, kind: isOwnerAttested(r) ? 'owner-stated' : 'CHE inference' })),
      ...talks.filter((t) => mentions(t.title, ask.topic)).map((t) => ({ at: day(t.at), text: t.title, kind: 'conversation' })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    if (hits.length) {
      parts.push(`${hits.length} mention ${topicName}: ${hits.slice(-3).map((h) => `${h.at || 'undated'} (${h.kind}) "${clipQuote(h.text)}"`).join('; ')}.`);
    } else {
      parts.push(`None of them mention ${topicName}, so I have no record of conversations about it.`);
    }
  }
  const start = Date.parse(dates[0]);
  if (ask.days && Number.isFinite(start) && now - start < ask.days * 86_400_000) {
    parts.push(`What is stored starts on ${dates[0]}; anything before that is not recorded, and I won't fill it in.`);
  } else {
    parts.push('Anything not listed here is not recorded, and I won\'t fill it in.');
  }
  return parts.join(' ');
}

/** Truth-pipeline stage for rules 1 and 2: first, on the model's own text, before any guard adds a note to it. */
export const contextEchoStage = {
  name: 'context_echo',
  async run(reply, ctx) {
    const message = ctx.rawMessage || ctx.message || '';
    const guarded = await guardContextEcho(reply, {
      message, data: ctx.data || {}, brainContext: ctx.brainContext, ownerHistory: ctx.ownerHistory, screenContext: ctx.body?.screen_context,
      remembered: ctx.ownerDevice && ctx.storage?.list
        ? async () => (await recallMemories(ctx.storage, message, { ownerWordsOnly: true })).map((m) => String(m.body || '').replace(/^You said:\s*/, ''))
        : null,
    });
    if (guarded.removed.length) console.log('CHE context echo', JSON.stringify(guarded.removed.map((r) => r.rule)));
    return guarded;
  },
};

/** Truth-pipeline stage for rule 3: after the date check, since its dates come from the records themselves. */
export const historyRecordsStage = {
  name: 'history_records',
  async run(reply, ctx) {
    const message = ctx.rawMessage || ctx.message || '';
    const ask = ctx.ownerDevice ? longHistoryRequest(message) : null;
    if (!ask) return { text: reply, removed: [] };
    const text = await historySummaryReply(ask, { data: ctx.data || {}, storage: ctx.storage, message });
    return { text, removed: [{ rule: 'history_from_records', sentence: String(reply || '').slice(0, 200) }] };
  },
};
