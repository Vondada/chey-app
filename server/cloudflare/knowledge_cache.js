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
  const record = {
    key,
    answer,
    source: String(entry.source || 'knowledge_cache').slice(0, 40),
    sources: (Array.isArray(entry.sources) ? entry.sources : []).map(String).filter((u) => /^https:\/\//.test(u)).slice(0, 5),
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
  if (hit) return { summary: hit.answer, sources: hit.sources, limitation: hit.limitation || undefined, cached: true, verified_at: hit.verified_at };
  const fresh = await research();
  if (fresh?.summary) {
    const volatile = isVolatile(question);
    await rememberKnowledge(storage, {
      key,
      answer: fresh.summary,
      sources: fresh.sources,
      limitation: fresh.limitation,
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
