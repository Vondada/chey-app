// CHE's verified knowledge cache: answers CHE already verified, kept with
// their source, verification time, confidence and expiry, so she never pays
// an AI engine (or repeats research) for something she already knows.
//
// Two kinds of entries:
//   owner facts  "remember that my X is Y"  → "what is my X?" (no expiry;
//                a newer statement replaces the older one)
//   verified research results for a question (expire: 7 days, or 30 minutes
//                for volatile topics such as prices, news, weather, scores)
// Volatile questions are never answered from an expired entry: CHE checks
// the authoritative source again and the fresh result replaces the old one.

import { isSafeMemoryText } from './research_memory.js';

const MAX = 300;
export const DAY = 86400000;
export const RESEARCH_TTL_MS = 7 * DAY;
export const VOLATILE_TTL_MS = 30 * 60_000;
const VOLATILE = /\b(?:latest|current(?:ly)?|today|tonight|yesterday|last night|this (?:morning|week|month|year)|right now|now|news|price|prices|quote|weather|forecast|scores?|won|winners?|results?|election|standings|live|breaking|stock|bitcoin|btc|eth|market|rates?|traffic|recent(?:ly)?)\b/i;
const SECRET = /\b(?:password|passcode|pin|security code|social security|ssn|credit card|card number|cvv|api[_ -]?key|secret|token|private key|seed phrase)\b/i;

// isSafeMemoryText inspects at most 500 characters, so a long answer is
// checked in overlapping windows: the WHOLE value that is stored is checked.
export function isSafeToStore(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  for (let at = 0; at < value.length; at += 400) {
    if (!isSafeMemoryText(value.slice(at, at + 500))) return false;
  }
  return true;
}

export function isVolatile(text) {
  return VOLATILE.test(String(text || ''));
}

// Lower-case words without filler, so "What's my Worker URL?" and
// "what is my worker url" are the same question.
export function normalizeQuestion(text) {
  return String(text || '').toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\b(?:hey |ok |okay )?(?:che|chay|chey|shay)\b[,:]?/g, ' ')
    .replace(/\b(?:please|sir|again|exactly|real quick|quickly)\b/g, ' ')
    .replace(/what's/g, 'what is').replace(/where's/g, 'where is').replace(/who's/g, 'who is')
    .replace(/[^a-z0-9 .:/@-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// "remember that my Worker URL is https://x" → { subject: 'worker url', value }
export function ownerFactFromStatement(text) {
  const m = /^(?:that\s+)?my\s+([a-z0-9][a-z0-9 '\-]{1,60}?)\s+(?:is|are|=)\s+(.{1,300})$/i.exec(String(text || '').trim());
  if (!m) return null;
  const subject = normalizeQuestion(m[1]);
  const value = m[2].trim().replace(/[.!]+$/, '');
  if (!subject || !value || SECRET.test(subject) || SECRET.test(value) || !isSafeToStore(value)) return null;
  return { subject, value };
}

// "what is my Worker URL?", "do you know my wifi name", "tell me my locker number"
export function ownerFactQuestion(text) {
  const m = /^(?:what\s+is|what\s+are|do\s+you\s+know|tell\s+me|remind\s+me\s+(?:of|what)|whats)\s+my\s+([a-z0-9][a-z0-9 '\-]{1,60}?)\s*\??$/i.exec(normalizeQuestion(text));
  return m ? normalizeQuestion(m[1]) : null;
}

// One storage value per entry (kc:<key>) plus a small index used only for
// pruning, so no single value grows toward the Durable Object size limit.
const INDEX = 'che_knowledge_index';
const entryKey = (key) => `kc:${key}`;

/** Saves a verified answer. Secrets are never stored. Newest verification wins. */
export async function rememberKnowledge(storage, entry, now = Date.now()) {
  if (!storage?.put) return null;
  const key = String(entry.key || '').slice(0, 220);
  const answer = String(entry.answer || '').trim().slice(0, 12000);
  if (!key || !answer || SECRET.test(key) || !isSafeToStore(answer) || !isSafeToStore(entry.limitation || 'ok')) return null;
  const source = String(entry.source || 'knowledge_cache').slice(0, 40);
  const sources = (Array.isArray(entry.sources) ? entry.sources : [])
    .map(String).filter((url) => /^https:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(url)).slice(0, 5);
  // Only owner-attested facts or source-backed research become known answers.
  // A fluent model answer and an unsourced research summary are NOT evidence.
  const ownerAttested = source === 'owner_memory';
  if (!ownerAttested && !(entry.verified === true && sources.length > 0)) return null;
  const prior = await storage.get(entryKey(key));
  const superseded = prior && prior.answer !== answer
    ? [...(Array.isArray(prior.superseded) ? prior.superseded : []), {
        answer: String(prior.answer || '').slice(0, 2000),
        source: prior.source, sources: prior.sources || [],
        verified_at: prior.verified_at, superseded_at: now,
      }].slice(-5)
    : Array.isArray(prior?.superseded) ? prior.superseded.slice(-5) : [];
  const record = {
    key,
    answer,
    source,
    sources,
    verification_status: ownerAttested ? 'owner_attested' : 'source_backed',
    superseded,
    limitation: String(entry.limitation || '').slice(0, 300),
    confidence: Math.max(0, Math.min(1, Number.isFinite(entry.confidence) ? entry.confidence : 0.9)),
    verified_at: now,
    expires_at: Number.isFinite(entry.ttl_ms) ? now + entry.ttl_ms : null,
    volatile: entry.volatile === true,
  };
  await storage.put(entryKey(key), record);
  const index = (await storage.get(INDEX)) || {};
  index[key] = now;
  const keys = Object.keys(index);
  if (keys.length > MAX) {
    keys.sort((a, b) => index[a] - index[b]);
    for (const old of keys.slice(0, keys.length - MAX)) {
      delete index[old];
      await storage.delete?.(entryKey(old));
    }
  }
  await storage.put(INDEX, index);
  return record;
}

/** Forgets what CHE knows for this key (owner said "don't reuse that answer"). */
export async function forgetKnowledge(storage, key) {
  if (!key || !storage?.delete) return;
  await storage.delete(entryKey(key));
  const index = (await storage.get(INDEX)) || {};
  if (key in index) { delete index[key]; await storage.put(INDEX, index); }
}

/** A trustworthy cached answer for this exact key, or null. */
export async function recallKnowledge(storage, key, { now = Date.now(), minConfidence = 0.8 } = {}) {
  if (!key || !storage?.get) return null;
  const record = await storage.get(entryKey(key));
  if (!record) return null;
  // Legacy unsourced model/research cache entries must never be promoted to
  // verified merely because they carry a high numeric confidence value.
  if (record.verification_status !== 'owner_attested' &&
      record.verification_status !== 'source_backed' &&
      record.verification_status !== 'source_verified' &&
      record.source !== 'owner_memory') return null;
  if (['source_backed', 'source_verified'].includes(record.verification_status) && !record.sources?.length) return null;
  if (record.confidence < minConfidence) return null;
  if (Number.isFinite(record.expires_at) && now > record.expires_at) return null;
  if (record.volatile && now - record.verified_at > VOLATILE_TTL_MS) return null;
  return record;
}

export function factKey(subject) { return `fact:${subject}`; }
export function researchKey(question) { return `research:${normalizeQuestion(question)}`; }

/**
 * The research result for a question: a still-valid verified result from the
 * cache, otherwise one fresh call to `research()` whose result replaces the
 * cache. `cached` says which happened; a failed call never erases the cache.
 */
/** A still-valid verified research result for exactly this question, or null. */
export async function researchHit(storage, question, now = Date.now()) {
  return recallKnowledge(storage, researchKey(question), { now });
}

/** Marks a cached research result as a pure answer (no action rode on that turn). */
export async function markPureResearch(storage, question) {
  if (!storage?.get || !storage?.put) return;
  const key = entryKey(researchKey(question));
  const record = await storage.get(key);
  if (record && !record.pure) await storage.put(key, { ...record, pure: true });
}

export async function cachedResearch(storage, question, research, now = Date.now()) {
  const key = researchKey(question);
  const hit = await recallKnowledge(storage, key, { now });
  if (hit && ['source_backed', 'source_verified'].includes(hit.verification_status)) return { summary: hit.answer, sources: hit.sources, limitation: hit.limitation || undefined, cached: true, verified_at: hit.verified_at };
  const fresh = await research();
  if (fresh?.summary && Array.isArray(fresh.sources) && fresh.sources.some((s) => /^https:\/\//i.test(String(s)))) {
    const volatile = isVolatile(question);
    await rememberKnowledge(storage, {
      key,
      answer: fresh.summary,
      sources: fresh.sources,
      limitation: fresh.limitation,
      source: 'research_library',
      verified: true,
      confidence: 0.85,
      ttl_ms: volatile ? VOLATILE_TTL_MS : RESEARCH_TTL_MS,
      volatile,
    }, now).catch(() => null);
  }
  return fresh;
}

/**
 * Memory-first: a question CHE can answer from a verified owner fact, with no
 * AI engine. The owner's memory list stays the authority: the newest memory
 * that mentions the subject must still say the stored value, so a fact the
 * owner corrected some other way ("my locker changed to 40") or deleted is
 * never spoken again; such questions fall through to the normal path.
 * Returns { answer, source, verified_at } or null.
 */
export async function knownAnswer(storage, message, { now = Date.now(), memories = [] } = {}) {
  const subject = ownerFactQuestion(message);
  if (!subject) return null;
  const record = await recallKnowledge(storage, factKey(subject), { now });
  if (!record) return null;
  const words = subject.split(' ').filter((w) => w.length > 1);
  const mentions = (Array.isArray(memories) ? memories : []).map((m) => String(m?.text ?? m ?? '').toLowerCase())
    .filter((text) => words.every((w) => text.includes(w)));
  const newest = mentions[mentions.length - 1];
  if (!newest || !newest.includes(record.answer.toLowerCase())) return null;
  return { answer: `Your ${subject} is ${record.answer}, sir.`, source: record.source, verified_at: record.verified_at };
}

/** "remember that my X is Y" also becomes a verified owner fact. */
export async function rememberOwnerFact(storage, statement, now = Date.now()) {
  const fact = ownerFactFromStatement(statement);
  if (!fact) return null;
  return rememberKnowledge(storage, { key: factKey(fact.subject), answer: fact.value, source: 'owner_memory', confidence: 1 }, now);
}

// These receipts describe what was ACTUALLY available during the prior reply;
// they are not post-hoc model-generated citations. No private answer text is
// persisted, only bounded provenance and time.
export const LAST_ANSWER_EVIDENCE_KEY = 'che_last_answer_evidence';

export function evidenceFollowup(message) {
  const q = normalizeQuestion(message).replace(/[.?!]+$/, '').trim();
  // The owner may dictate "that's correct" as "that s correct", or quote a
  // generic instruction from a prior test in the same turn. No specific new
  // research subject is specified in "research a fact".
  const genericResearch = /(?: research a fact check (?:your |the )?sources and explain what you verified)?/;
  if (new RegExp('^how do you know(?: that| this| it| that s correct| that is correct| it s correct| whether that is true)?' + genericResearch.source + '$').test(q)) return true;
  return /^(?:where did you get (?:that|this|the information)|what(?: is| are)? (?:your|the) sources?(?: for that)?|can you (?:cite|verify|fact check) (?:that|this|your answer)|show (?:me )?(?:the )?(?:sources?|evidence)(?: for that)?)$/i.test(q);
}

// "The last one" refers to the preceding fact-check discussion, not to an
// imaginary completed web search. Require explicit nearby dialog grounding.
export function evidenceReferenceFollowup(message, history = []) {
  if (evidenceFollowup(message)) return true;
  const q = normalizeQuestion(message);
  if (!/^(?:the last one(?: we were just talking about)?|that last one|the one we were just talking about)$/.test(q)) return false;
  return (Array.isArray(history) ? history.slice(-10) : []).some((turn) =>
    turn?.role === 'user' && (evidenceFollowup(turn.content || turn.text || '') ||
      /how do you know|check (?:your |the )?sources/i.test(String(turn.content || turn.text || ''))));
}

export function confirmedOwnerMemoryExample(records = []) {
  const record = (Array.isArray(records) ? records : []).slice().reverse().find((item) =>
    item?.active !== false && item?.verification_status === 'owner_attested' &&
    ['owner', 'owner_chat', 'explicit_memory'].includes(String(item.source || '')) &&
    isSafeMemoryText(item.text) && String(item.text || '').length <= 300);
  if (!record) return null;
  return { answer: `You told me: "${String(record.text).trim()}" I have it recorded as your statement, sir—not independently verified outside our conversation.`,
    verified_at: record.last_verified_at || record.created_at || null };
}

export function evidenceReferenceLabel(history = []) {
  const assistantTurns = (Array.isArray(history) ? history : []).filter((turn) => turn?.role === 'assistant').slice(-8).reverse();
  if (assistantTurns.some((turn) => /you prefer short, friendly replies|prefer short friendly replies/i.test(String(turn.content || turn.text || ''))))
    return 'the claim I made about your preference for short, friendly replies';
  return 'the earlier answer';
}

export function answerEvidenceReceipt({ research = null, tools = [], ownerAttested = false, at = Date.now() } = {}) {
  const urls = (Array.isArray(research?.sources) ? research.sources : [])
    .map(String).filter((s) => /^https:\/\/[^\s/]+/i.test(s)).slice(0, 5);
  const usedTools = (Array.isArray(tools) ? tools : []).filter((t) => t?.ok === true)
    .map((t) => `${String(t.plugin || 'tool').slice(0, 50)}/${String(t.tool || 'read').slice(0, 50)}`).slice(0, 5);
  return {
    kind: ownerAttested ? 'owner_attested' : urls.length ? 'source_backed' : usedTools.length ? 'tool_result' : 'unverified',
    at, sources: urls, tools: usedTools,
  };
}

export function explainAnswerEvidence(receipt, now = Date.now()) {
  if (!receipt || !Number.isFinite(receipt.at) || now - receipt.at > DAY || receipt.at > now + 60000) {
    return 'I do not have a recent evidence record for that answer, sir. I cannot honestly claim it was fact-checked.';
  }
  if (receipt.kind === 'owner_attested') {
    return 'That was something you told me, sir. I treated it as your stated information, not as an independently verified external fact.';
  }
  if (receipt.kind === 'source_backed' && receipt.sources?.length) {
    return `The research tools returned these source links: ${receipt.sources.join(', ')}. A link is not proof that every claim in my answer was independently fact-checked.`;
  }
  if (receipt.kind === 'tool_result' && receipt.tools?.length) {
    return `The answer used these successful tools: ${receipt.tools.join(', ')}. I do not have a source URL for independent confirmation, sir.`;
  }
  return 'That answer was not independently verified, sir. I have no source receipt for it and should not present it as a confirmed fact.';
}
