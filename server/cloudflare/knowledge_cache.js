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

const KEY = 'che_knowledge_cache';
const MAX = 300;
export const DAY = 86400000;
export const RESEARCH_TTL_MS = 7 * DAY;
export const VOLATILE_TTL_MS = 30 * 60_000;
const VOLATILE = /\b(?:latest|current(?:ly)?|today|tonight|right now|now|this (?:week|month|year)|news|price|prices|quote|weather|forecast|score|scores|live|breaking|stock|bitcoin|btc|eth|market|rate|rates|traffic)\b/i;
const SECRET = /\b(?:password|passcode|pin|security code|social security|ssn|credit card|card number|cvv|api[_ -]?key|secret|token|private key|seed phrase)\b/i;

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
  if (!subject || !value || SECRET.test(subject) || SECRET.test(value) || !isSafeMemoryText(value)) return null;
  return { subject, value };
}

// "what is my Worker URL?", "do you know my wifi name", "tell me my locker number"
export function ownerFactQuestion(text) {
  const m = /^(?:what\s+is|what\s+are|do\s+you\s+know|tell\s+me|remind\s+me\s+(?:of|what)|whats)\s+my\s+([a-z0-9][a-z0-9 '\-]{1,60}?)\s*\??$/i.exec(normalizeQuestion(text));
  return m ? normalizeQuestion(m[1]) : null;
}

async function readAll(storage) {
  const saved = storage?.get ? await storage.get(KEY) : null;
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}

/** Saves a verified answer. Secrets are never stored. Newest verification wins. */
export async function rememberKnowledge(storage, entry, now = Date.now()) {
  if (!storage?.put) return null;
  const key = String(entry.key || '').slice(0, 220);
  const answer = String(entry.answer || '').trim().slice(0, 4000);
  if (!key || !answer || SECRET.test(key) || !isSafeMemoryText(answer)) return null;
  const all = await readAll(storage);
  const record = {
    key,
    answer,
    source: String(entry.source || 'knowledge_cache').slice(0, 40),
    sources: (Array.isArray(entry.sources) ? entry.sources : []).map(String).filter((u) => /^https:\/\//.test(u)).slice(0, 5),
    confidence: Math.max(0, Math.min(1, Number.isFinite(entry.confidence) ? entry.confidence : 0.9)),
    verified_at: now,
    expires_at: Number.isFinite(entry.ttl_ms) ? now + entry.ttl_ms : null,
    volatile: entry.volatile === true,
  };
  all[key] = record;
  const keys = Object.keys(all);
  if (keys.length > MAX) {
    keys.sort((a, b) => (all[a].verified_at || 0) - (all[b].verified_at || 0));
    for (const old of keys.slice(0, keys.length - MAX)) delete all[old];
  }
  await storage.put(KEY, all);
  return record;
}

/** A trustworthy cached answer for this exact key, or null. */
export async function recallKnowledge(storage, key, { now = Date.now(), minConfidence = 0.8 } = {}) {
  if (!key) return null;
  const record = (await readAll(storage))[key];
  if (!record) return null;
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
export async function cachedResearch(storage, question, research, now = Date.now()) {
  const key = researchKey(question);
  const hit = await recallKnowledge(storage, key, { now });
  if (hit) return { summary: hit.answer, sources: hit.sources, cached: true, verified_at: hit.verified_at };
  const fresh = await research();
  if (fresh?.summary) {
    const volatile = isVolatile(question);
    await rememberKnowledge(storage, {
      key,
      answer: fresh.summary,
      sources: fresh.sources,
      source: 'research_library',
      confidence: 0.85,
      ttl_ms: volatile ? VOLATILE_TTL_MS : RESEARCH_TTL_MS,
      volatile,
    }, now).catch(() => null);
  }
  return fresh;
}

/**
 * Memory-first: a question CHE can answer from a verified owner fact, with no
 * AI engine. Returns { answer, source, verified_at } or null.
 */
export async function knownAnswer(storage, message, now = Date.now()) {
  const subject = ownerFactQuestion(message);
  if (!subject) return null;
  const record = await recallKnowledge(storage, factKey(subject), { now });
  if (!record) return null;
  return { answer: `Your ${subject} is ${record.answer}, sir.`, source: record.source, verified_at: record.verified_at };
}

/** "remember that my X is Y" also becomes a verified owner fact. */
export async function rememberOwnerFact(storage, statement, now = Date.now()) {
  const fact = ownerFactFromStatement(statement);
  if (!fact) return null;
  return rememberKnowledge(storage, { key: factKey(fact.subject), answer: fact.value, source: 'owner_memory', confidence: 1 }, now);
}
