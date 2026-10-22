// CHE daily reflections: lessons, ideas, mistakes, money opportunities and
// questions for the owner, built from the owner-visible log of one day.
//
// Rules:
// - Runs only when the owner asks (GET/POST routes). No schedule, no background work.
// - The caller passes the events in. This module never reads private memory.
// - Model calls use CHE's own Cloudflare binding (env.AI) only, and the text goes
//   through guardOutbound first.
// - Items the model returns must cite a real event number from the input, use an
//   allowed category, and contain text. Anything else is dropped, so nothing is invented.
// - Owner replies are stored exactly as the owner gave them.

import { guardOutbound } from './egress_guard.js';

export const CATEGORIES = ['lesson', 'idea', 'mistake', 'money_opportunity', 'question_for_owner'];
export const REPLY_STATES = ['open', 'replied', 'skipped'];
export const REFLECTIONS_KEY = 'reflections_v1';
export const REFLECTION_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
// Every room whose owner-visible activity may feed a reflection. Anything else
// (private memory included) is dropped before a model sees it.
export const REFLECTION_ROOMS = ['chat', 'office', 'workshop', 'trading', 'create', 'brain', 'agents', 'mailbox', 'connections'];

const MAX_EVENTS = 200;
const MAX_EVENT_CHARS = 400;
const MAX_ITEM_CHARS = 400;
const MAX_ITEMS = 8;
const MAX_REPLY_CHARS = 4000;
const MAX_STORED = 400;

export function validDay(day) {
  const s = String(day ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function reflectionId(day) {
  return `reflection-${day}`;
}

// Text out of a Workers AI reply, whichever shape it comes in.
export function modelText(out) {
  if (typeof out === 'string') return out;
  return String(out?.response ?? out?.choices?.[0]?.message?.content ?? '');
}

// Owner-visible events from the allowed rooms, numbered from 1. Each keeps its
// source room. Empty entries, unknown rooms and oversized entries are dropped.
export function normalizeEvents(events) {
  if (!Array.isArray(events)) return [];
  const rows = [];
  for (const e of events) {
    const room = typeof e === 'object' && e ? String(e.room ?? '') : '';
    if (!REFLECTION_ROOMS.includes(room)) continue;
    const raw = typeof e === 'string' ? e : (e?.text ?? e?.summary ?? '');
    const text = String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_EVENT_CHARS);
    if (text) rows.push({ n: rows.length + 1, room, text });
    if (rows.length >= MAX_EVENTS) break;
  }
  return rows;
}

// Accepts only well-formed entries that cite a real event number.
export function parseItems(raw, events) {
  const eventCount = Array.isArray(events) ? events.length : Number(events) || 0;
  const text = String(raw ?? '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const items = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const category = String(row.category ?? '');
    const source = Number(row.source);
    const body = typeof row.text === 'string' ? row.text.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS) : '';
    if (!CATEGORIES.includes(category)) continue;
    if (!Number.isInteger(source) || source < 1 || source > eventCount) continue;
    if (!body) continue;
    // The room comes from the cited event, never from the model.
    const room = Array.isArray(events) ? events[source - 1].room : '';
    items.push({ category, room, text: body, reply: 'open', reply_text: '' });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

const SYSTEM_PROMPT = [
  'You write CHE\'s daily reflection for her owner from the numbered log entries.',
  'Entries come from several rooms (chat, office, workshop, trading, create, brain, agents, mailbox, connections), shown in brackets.',
  'Use only facts that appear in the entries. Do not add events, numbers, names or people that are not in them.',
  'Reply with only a JSON array. Each element: {"category": one of lesson|idea|mistake|money_opportunity|question_for_owner, "source": the entry number it comes from, "text": one short sentence}.',
  'If nothing in the entries supports an item, return [].',
].join(' ');

export async function buildDailyReflection({ day, events } = {}, env, { model = REFLECTION_MODEL } = {}) {
  if (!validDay(day)) return { status: 'invalid_day', day: String(day ?? ''), items: [] };
  const id = reflectionId(day);
  const list = normalizeEvents(events);
  if (!list.length) return { status: 'no_events', id, day, items: [] };
  if (!env?.AI || typeof env.AI.run !== 'function') return { status: 'model_unavailable', id, day, items: [] };

  const prompt = list.map((e) => `[${e.n}] (${e.room}) ${e.text}`).join('\n');
  const guarded = guardOutbound({ destination: 'cloudflare-model', payload: prompt });
  if (!guarded.allowed) return { status: 'withheld', id, day, items: [] };

  let out;
  try {
    out = await env.AI.run(model, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: String(guarded.redacted) },
      ],
      max_tokens: 700,
    });
  } catch {
    return { status: 'model_error', id, day, items: [] };
  }
  const items = parseItems(modelText(out), list);
  return { status: items.length ? 'ok' : 'no_items', id, day, items };
}

// ─── Storage (one durable list; newest records kept) ──────────────────────

function cleanItem(item) {
  return {
    category: CATEGORIES.includes(item?.category) ? item.category : 'lesson',
    room: REFLECTION_ROOMS.includes(item?.room) ? item.room : '',
    text: String(item?.text ?? ''),
    reply: REPLY_STATES.includes(item?.reply) ? item.reply : 'open',
    reply_text: typeof item?.reply_text === 'string' ? item.reply_text : '',
  };
}

async function readAll(storage) {
  const rows = await storage.get(REFLECTIONS_KEY);
  return Array.isArray(rows) ? rows : [];
}

export async function saveReflection(storage, reflection) {
  if (!validDay(reflection?.day)) return { ok: false, detail: 'Reflection day must be YYYY-MM-DD.' };
  const row = {
    id: String(reflection.id || reflectionId(reflection.day)),
    day: reflection.day,
    status: String(reflection.status || 'ok'),
    items: (Array.isArray(reflection.items) ? reflection.items : []).map(cleanItem),
    saved_at: new Date().toISOString(),
  };
  const kept = (await readAll(storage)).filter((r) => r.id !== row.id);
  kept.push(row);
  await storage.put(REFLECTIONS_KEY, kept.slice(-MAX_STORED));
  return { ok: true, reflection: structuredClone(row) };
}

export async function listReflections(storage, { day } = {}) {
  const rows = await readAll(storage);
  return rows
    .filter((r) => !day || r.day === day)
    .sort((a, b) => String(b.day).localeCompare(String(a.day)))
    .map((r) => structuredClone(r));
}

export async function setReflectionReply(storage, id, itemIndex, { reply, reply_text } = {}) {
  if (!REPLY_STATES.includes(reply)) return { ok: false, detail: 'Reply must be open, replied or skipped.' };
  const text = reply_text === undefined ? '' : reply_text;
  if (typeof text !== 'string') return { ok: false, detail: 'Reply text must be text.' };
  if (text.length > MAX_REPLY_CHARS) return { ok: false, detail: `Reply is longer than ${MAX_REPLY_CHARS} characters.` };

  const rows = await readAll(storage);
  const row = rows.find((r) => r.id === String(id ?? ''));
  if (!row) return { ok: false, detail: 'No reflection with that id.' };
  const index = Number(itemIndex);
  if (!Number.isInteger(index) || index < 0 || index >= row.items.length) return { ok: false, detail: 'No reflection item at that index.' };

  // The owner's words are stored exactly as given (no trimming).
  row.items[index] = { ...row.items[index], reply, reply_text: text };
  await storage.put(REFLECTIONS_KEY, rows);
  return { ok: true, reflection: structuredClone(row), item: structuredClone(row.items[index]) };
}
