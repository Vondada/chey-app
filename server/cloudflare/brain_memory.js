// Conversation memories: every owner ↔ CHE exchange becomes a memory.
//
// Each memory lives under its own Durable Object storage key, so the brain
// has no size cap (the 'che' blob is never touched). A new memory links to
// the earlier memories it shares topics with and strengthens them, so
// memories build on each other. Deterministic: no AI tokens are spent.
// Sensitive text (passwords, codes, keys) is never stored.

import { isSafeMemoryText } from './research_memory.js';

const PREFIX = 'brainmem:';
const COUNT_KEY = 'brainmem_count';
const LINK_SCAN = 300; // recent memories compared for links
const MAX_LINKS = 3;
const MIN_SIMILARITY = 0.12;

const STOP = new Set(('the and for you are was with that this have from your what can will just not but they them she her his him its our out who how why when where which would could should about into than then there their been were also please okay yeah sir che chay chey').split(' '));

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function memoryTokens(text) {
  const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/);
  return [...new Set(words.filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 32);
}

function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  let shared = 0;
  for (const t of a) if (sb.has(t)) shared++;
  return shared / (a.length + b.length - shared);
}

function firstSentences(text, max) {
  const clean = clip(text, 4000);
  const parts = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  let out = '';
  for (const p of parts) {
    if ((out + p).length > max) break;
    out += p;
  }
  return clip(out || clean, max);
}

/** Reassembles the spoken reply from CHE's NDJSON chat response. */
export function replyFromNdjson(text) {
  let reply = '';
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.type === 'delta' && typeof item.delta === 'string') reply += item.delta;
    } catch {
      // Not a JSON line; ignore.
    }
  }
  return reply.trim();
}

function keyFor(at, id) {
  return `${PREFIX}${String(at).padStart(15, '0')}:${id}`;
}

/**
 * Stores one exchange as a memory and links it to related earlier ones.
 * Returns the stored memory, or null when nothing safe was there to keep.
 */
export async function recordConversationMemory(storage, { message, reply, now = Date.now(), id } = {}) {
  const said = clip(message, 1200);
  const answered = clip(reply, 4000);
  if (!said || !isSafeMemoryText(said)) return null;
  const answerSafe = answered && isSafeMemoryText(answered) ? firstSentences(answered, 600) : '';
  const tokens = memoryTokens(`${said} ${answerSafe}`);
  const memory = {
    id: id || `conv_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: new Date(now).toISOString(),
    title: clip(said, 90),
    body: answerSafe ? `You said: ${said}\nCHE answered: ${answerSafe}` : `You said: ${said}`,
    tokens,
    links: [],
    strength: 1,
  };

  // Build on earlier memories: link to the most related recent ones and
  // strengthen them (each link is a real shared topic, never invented).
  const recent = await storage.list({ prefix: PREFIX, reverse: true, limit: LINK_SCAN });
  const scored = [];
  for (const [key, value] of recent) {
    const s = similarity(tokens, Array.isArray(value?.tokens) ? value.tokens : []);
    if (s >= MIN_SIMILARITY) scored.push({ key, value, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const updates = {};
  for (const { key, value } of scored.slice(0, MAX_LINKS)) {
    memory.links.push(value.id);
    updates[key] = {
      ...value,
      strength: (Number(value.strength) || 1) + 1,
      links: [...new Set([...(value.links || []), memory.id])].slice(-24),
    };
  }
  updates[keyFor(now, memory.id)] = memory;
  await storage.put(updates);
  const count = Number(await storage.get(COUNT_KEY)) || 0;
  await storage.put(COUNT_KEY, count + 1);
  return memory;
}

/** Newest first. [before] is an ISO time for paging back through history. */
export async function listConversationMemories(storage, { limit = 2000, before } = {}) {
  const opts = { prefix: PREFIX, reverse: true, limit: Math.max(1, Math.min(Number(limit) || 2000, 5000)) };
  if (before) {
    const ms = Date.parse(before);
    if (Number.isFinite(ms)) opts.end = `${PREFIX}${String(ms).padStart(15, '0')}`;
  }
  const rows = await storage.list(opts);
  return [...rows.values()].map(({ tokens, ...rest }) => rest);
}

export async function conversationMemoryCount(storage) {
  return Number(await storage.get(COUNT_KEY)) || 0;
}
