// Notes and lists CHE really keeps (owner, 2026-10-31: "make CHE execute authorized actions reliably").
// "Add milk to my shopping list", "create a note saying: buy stamps", "what's on my grocery list?", "remove eggs from the
// list", "show my notes". Each list is a record in this Durable Object's storage. Every change is written, then read back
// from storage, and the reply carries an execution receipt built from the read-back (what changed, the counts before and
// after, and what is stored now), so the receipt is evidence and not a claim. Nothing here calls a model or the network.
//
// Removing an item or clearing a list deletes the owner's data, so it runs only with his yes (owner_action_gate.js): the
// gate usually holds it first; a removal it did not hold ("cross eggs off my list") is held here the same way.
// Certification probe turns run as the owner on his own Durable Object; their lists live under their own key and never
// reach his lists, his receipt log or his held actions' results.
import { PENDING_OWNER_ACTION_KEY } from './owner_action_gate.js';
import { recordReceipt } from './truth_layer.js';

export const LISTS_KEY = 'owner_lists';
export const PROBE_LISTS_KEY = 'owner_lists:probe';
const MAX_LISTS = 50;
const MAX_ITEMS = 200;
const MAX_ITEM = 200;
const MAX_NOTE = 1000;

// "Hey CHE, can you please ...". Request lead-ins only; the action verb must follow.
const LEAD = /^(?:(?:hey|hi|ok|okay)\s+)?(?:(?:chey|che|chay)\b[,:\s]*)?(?:(?:please|pls|now|also|just|ok|okay|go\s+ahead\s+and|can\s+you|could\s+you|would\s+you|will\s+you|i\s+want\s+you\s+to|i\s+need\s+you\s+to)\s+)*/i;
// The list a request names: "my shopping list", "our to-do list", "the grocery list", "my notes". Up to three name words,
// none a preposition: "my last note in notes" asks about the Notes app (owner_action_gate.js), not CHE's notes.
const TARGET = String.raw`(my|our|the)\s+((?:(?!(?:in|on|of|from|to|at|for|with|into|onto)\s)[a-z][\w'’-]*\s+){0,3}?)(list|notes|notepad)`;
// Nothing may follow the list but politeness: "the list of supported models" or "my to-do list in the README" is not one
// of the owner's lists.
const TAIL = String.raw`(?:,?\s+(?:please|for\s+me|now|sir|thanks|thank\s+you|che|chey))*\s*[.!?]*$`;
const ADD = new RegExp(String.raw`^(?:add|put|throw|stick|pop|include|save|jot\s+down)\s+(.+?)\s+(?:to|on|onto|in|into)\s+${TARGET}${TAIL}`, 'i');
const ADD_COLON = new RegExp(String.raw`^add\s+to\s+${TARGET}\s*[:,–-]\s*(.+?)[.!]*$`, 'i');
const NOTE = [
  // "Create a note saying: buy stamps", "make a note: call the bank", "take a note that the meeting moved".
  /^(?:create|make|take|add|save|leave|start|jot\s+down)\s+(?:me\s+)?(?:an?\s+|one\s+)?(?:new\s+|quick\s+|short\s+)?note(?:\s+(?:for\s+me|to\s+(?:my)?self))?\s*(?:[:–-]\s*|\s+(?:saying|that\s+says|that\s+reads|reading|which\s+says|with\s+the\s+text|that)\s*:?\s*)(.+?)[.!]*$/i,
  // "Make a note to call Sam", "leave me a note to water the plants".
  /^(?:make|take|leave)\s+(?:me\s+)?an?\s+(?:quick\s+)?note\s+to\s+(?!(?:the|my|your|this|that|a|an|him|her|them|it|self|myself)\b)(.+?)[.!]*$/i,
  // "Jot down: buy stamps", "note down the gate code is on the fridge".
  /^(?:jot|note)\s+down\s*:?\s+(.+?)[.!]*$/i,
];
const READ = [
  new RegExp(String.raw`^(?:what(?:['’]s|\s+is|\s+are|s)|whats)\s+(?:on|in)\s+${TARGET}${TAIL}`, 'i'),
  new RegExp(String.raw`^(?:show|read|list|tell|give|open|display|pull\s+up|check)\s+(?:me\s+|out\s+)?(?:what(?:['’]s|\s+is)\s+(?:on|in)\s+)?${TARGET}${TAIL}`, 'i'),
  new RegExp(String.raw`^(?:do\s+i\s+have|is\s+there)\s+anything\s+(?:on|in)\s+${TARGET}${TAIL}`, 'i'),
];
const READ_NOTES = /^(?:what|which)\s+notes\s+(?:do\s+i\s+have|have\s+i\s+(?:got|saved|made))\b[^.?!]*[.?!]*$/i;
const READ_LISTS = /^(?:what|which)\s+lists\s+(?:do\s+i\s+have|have\s+i\s+(?:got|made))\b[^.?!]*[.?!]*$/i;
const REMOVE = new RegExp(String.raw`^(?:remove|delete|take|cross|strike|scratch|tick|erase|drop)\s+(.+?)\s+(?:off|from|out\s+of)\s+(?:of\s+)?${TARGET}${TAIL}`, 'i');
const REMOVE_OFF = new RegExp(String.raw`^(?:cross|strike|tick|scratch)\s+off\s+(.+?)\s+(?:from|on)\s+${TARGET}${TAIL}`, 'i');
const REMOVE_NOTE = /^(?:delete|remove|erase)\s+(?:the|my)\s+note\s+(?:about|saying|that\s+says|with|on|for)\s+(.+?)[.!]*$/i;
const CLEAR = new RegExp(String.raw`^(?:clear|empty|wipe|erase|reset|delete|remove|purge)\s+(?:out\s+)?(?:all\s+(?:of\s+)?|everything\s+(?:on|in|from)\s+)?${TARGET}${TAIL}`, 'i');
const EVERYTHING = /^(?:everything|all|all\s+(?:the\s+)?items|all\s+of\s+it|every\s+item)$/i;
// "Add it to my list" names nothing CHE could store.
const NO_ITEM = /^(?:it|this|that|these|those|them|something|anything|stuff|things?)$/i;
// Lists that belong to someone else's system: adding Bob to "the mailing list" would send nothing from here.
const FOREIGN = /\b(?:mailing|distribution|e-?mail|contacts?|guest|block|allow|white|black|deny|wait|waiting|play)\b/i;

function clean(text) {
  return String(text || '').replace(/^["'“‘]+|["'”’]+$/g, '').replace(/\s+/g, ' ').trim();
}

/** The list a request names, as its stored name: shopping and grocery are one list, and so are to-do and todo. '' = unnamed. */
export function listName(name = '', kind = 'list') {
  if (/^note/i.test(kind)) return 'notes';
  const n = String(name || '').toLowerCase().replace(/['’]s\s*$/, '').replace(/\s+/g, ' ').trim();
  if (/^(?:shopping|grocery|groceries|food|food\s+shopping|supermarket)$/.test(n)) return 'shopping';
  if (/^(?:to[\s-]?do|todo|task|tasks|to\s+do)$/.test(n)) return 'to-do';
  return n;
}

function target(determiner, name, kind) {
  const list = listName(name, kind);
  if (FOREIGN.test(name)) return null;
  return { list, unnamed: !list, mine: !/^the$/i.test(determiner) };
}

function items(text) {
  return clean(text).split(/\s*,\s*(?:and\s+)?|\s*;\s*|\s+and\s+|\s*&\s*/i).map(clean).filter(Boolean).map((t) => t.slice(0, MAX_ITEM));
}

/** What a message asks of the lists: add, note, read, remove or clear, with its list and items. Null when it asks none. */
export function listIntent(message = '') {
  const text = String(message || '').replace(/\s+/g, ' ').trim().replace(LEAD, '');
  if (!text || text.length > 600) return null;
  let m;
  if ((m = ADD.exec(text))) {
    const t = target(m[2], m[3], m[4]);
    const add = items(m[1]);
    if (!t || !add.length || add.some((i) => NO_ITEM.test(i))) return null;
    return { action: t.list === 'notes' ? 'note' : 'add', ...t, items: t.list === 'notes' ? [clean(m[1]).slice(0, MAX_NOTE)] : add };
  }
  if ((m = ADD_COLON.exec(text))) {
    const t = target(m[1], m[2], m[3]);
    const add = items(m[4]);
    if (!t || !add.length || add.some((i) => NO_ITEM.test(i))) return null;
    return { action: t.list === 'notes' ? 'note' : 'add', ...t, items: t.list === 'notes' ? [clean(m[4]).slice(0, MAX_NOTE)] : add };
  }
  for (const re of NOTE) {
    if ((m = re.exec(text))) {
      const note = clean(m[1]).slice(0, MAX_NOTE);
      if (!note || NO_ITEM.test(note)) return null;
      return { action: 'note', list: 'notes', unnamed: false, mine: true, items: [note] };
    }
  }
  if (READ_NOTES.test(text)) return { action: 'read', list: 'notes', unnamed: false, mine: true };
  if (READ_LISTS.test(text)) return { action: 'lists' };
  for (const re of READ) {
    if ((m = re.exec(text))) {
      const t = target(m[1], m[2], m[3]);
      return t ? { action: 'read', ...t } : null;
    }
  }
  if ((m = REMOVE_NOTE.exec(text))) return { action: 'remove', list: 'notes', unnamed: false, mine: true, items: [clean(m[1])] };
  if ((m = CLEAR.exec(text))) {
    const t = target(m[1], m[2], m[3]);
    return t ? { action: 'clear', ...t } : null;
  }
  if ((m = REMOVE.exec(text) || REMOVE_OFF.exec(text))) {
    const t = target(m[2], m[3], m[4]);
    if (!t) return null;
    if (EVERYTHING.test(clean(m[1]))) return { action: 'clear', ...t };
    const drop = items(m[1]);
    if (!drop.length || drop.some((i) => NO_ITEM.test(i))) return null;
    return { action: 'remove', ...t, items: drop };
  }
  return null;
}

async function load(storage, key) {
  const value = await storage.get(key);
  return value && typeof value === 'object' && value.lists && typeof value.lists === 'object' ? value : { lists: {} };
}

// Probe items expire after six hours, so each certification run starts from empty lists and its "add milk" is a real add,
// not "already on your list". The owner's items never expire.
const PROBE_TTL_MS = 6 * 3600_000;
async function loadFor(storage, key, now) {
  const store = await load(storage, key);
  if (key !== PROBE_LISTS_KEY) return store;
  for (const [name, list] of Object.entries(store.lists)) {
    list.items = (list.items || []).filter((i) => now - Date.parse(i.added_at) < PROBE_TTL_MS);
    if (!list.items.length) delete store.lists[name];
  }
  return store;
}

function makeId(now) {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 6) : Math.random().toString(16).slice(2, 8);
  return `i-${now.toString(36)}-${rand}`;
}

const norm = (s) => String(s || '').toLowerCase().replace(/^(?:the|a|an|some|my)\s+/, '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const singular = (s) => s.replace(/(?:es|s)$/, '');

/** The stored items a named item means: an exact match first, then a plural or a word-bounded part ("eggs" -> "a dozen eggs"). */
function matching(list, wanted) {
  const w = norm(wanted);
  if (!w) return [];
  const exact = list.filter((i) => norm(i.text) === w || singular(norm(i.text)) === singular(w));
  if (exact.length) return exact;
  const word = new RegExp(`(?:^|\\s)${singular(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:e?s)?(?:\\s|$)`);
  return list.filter((i) => word.test(norm(i.text)));
}

// The unnamed list ("the list", "my list"): the one that holds the item, else the one changed last.
function resolve(store, intent) {
  if (!intent.unnamed) return intent.list;
  const names = Object.keys(store.lists).filter((n) => n !== 'notes');
  if (intent.items?.length) {
    const holder = names.find((n) => intent.items.some((i) => matching(store.lists[n].items || [], i).length));
    if (holder) return holder;
  }
  const latest = names.sort((a, b) => String(store.lists[b].updated_at).localeCompare(String(store.lists[a].updated_at)))[0];
  if (latest) return latest;
  // "Add milk to the list" with no list yet names no list of the owner's; "my list" is his general list.
  return intent.mine ? 'general' : '';
}

const called = (name) => (name === 'notes' ? 'notes' : `${name} list`);
function preview(list, n = 10) {
  const shown = list.slice(0, n).map((i) => i.text);
  if (list.length > n) return `${shown.join(', ')}, and ${list.length - n} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown.join('');
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function readText(name, list) {
  if (name === 'notes') {
    if (!list.length) return 'You have no notes saved, sir.';
    return `You have ${plural(list.length, 'note')}, sir: ${list.slice(-10).map((i, k) => `${k + 1}. ${i.text}`).join(' ')}${list.length > 10 ? ` (the latest 10 of ${list.length})` : ''}`;
  }
  if (!list.length) return `Your ${called(name)} is empty, sir.`;
  return `Your ${called(name)} has ${plural(list.length, 'item')}, sir: ${preview(list, 25)}.`;
}

/**
 * Writes the change, reads the list back and builds the receipt from what storage now holds. Returns { ok, receipt, after }.
 * A storage error or a read-back that does not show the change gives a failed receipt, and the reply says nothing changed.
 */
async function commit(storage, key, store, name, change, operation, now) {
  const before = (store.lists[name]?.items || []).slice();
  const next = change(before.slice());
  const at = new Date(now).toISOString();
  const base = { tool: 'che_lists', operation, list: name, before_count: before.length, at };
  try {
    // A cleared list is gone; a list emptied one item at a time stays, empty.
    if (next.length || name === 'notes' || operation !== 'clear') store.lists[name] = { items: next, created_at: store.lists[name]?.created_at || at, updated_at: at };
    else delete store.lists[name];
    await storage.put(key, store);
    const back = (await load(storage, key)).lists[name]?.items || [];
    const same = back.length === next.length && back.every((i, k) => i.id === next[k].id && i.text === next[k].text);
    if (!same) return { ok: false, receipt: { ...base, status: 'failed', error: 'not_verified', id: `${name}:${now}` } };
    return { ok: true, after: back, receipt: { ...base, status: 'success', id: `${name}:${now}`, after_count: back.length, verified: 'read_back', stored: back.slice(0, 50).map((i) => i.text) } };
  } catch (error) {
    return { ok: false, receipt: { ...base, status: 'failed', error: 'write_failed', detail: String(error?.message || error).slice(0, 120), id: `${name}:${now}` } };
  }
}

/**
 * CHE's answer for a notes or list request, from the stored lists (no model). Null when the message asks none.
 * `probe`: a certification turn (its own key). `grant`: the owner's yes this turn (grant.delete releases a removal).
 * `owner`: the paired owner device; anyone else is told the lists are the owner's.
 */
export async function listChatTurn(storage, message, { probe = false, grant = {}, owner = true, now = Date.now() } = {}) {
  const intent = listIntent(message);
  if (!intent) return null;
  const meta = (extra = {}) => ({ source: 'che_lists', model_calls: 0, ...extra });
  if (!owner && !probe) return { text: 'Notes and lists are the owner\'s, sir. Nothing was read or saved.', meta: meta({ ok: false }) };
  const key = probe ? PROBE_LISTS_KEY : LISTS_KEY;
  let store;
  try { store = await loadFor(storage, key, now); } catch (_) {
    return { text: 'I could not read your lists from CHE\'s server just now, sir, so nothing was read or changed.', meta: meta({ ok: false, execution_receipt: { tool: 'che_lists', operation: intent.action, status: 'failed', error: 'read_failed', id: `lists:${now}` } }) };
  }

  if (intent.action === 'lists') {
    const names = Object.keys(store.lists);
    const text = names.length ? `Your lists, sir: ${names.map((n) => `${called(n)} (${plural(store.lists[n].items.length, n === 'notes' ? 'note' : 'item')})`).join(', ')}.` : 'You have no lists or notes saved yet, sir.';
    return { text, meta: meta({ ok: true, lists: names, execution_receipt: { tool: 'che_lists', operation: 'read', status: 'success', id: `lists:${now}`, lists: names } }) };
  }

  const name = resolve(store, intent);
  if (!name) return null;

  if (intent.action === 'read') {
    const list = store.lists[name]?.items || [];
    if (!store.lists[name] && name !== 'notes') return { text: `You have no ${called(name)} yet, sir. Nothing is saved under that name.${Object.keys(store.lists).length ? ` Your lists: ${Object.keys(store.lists).map(called).join(', ')}.` : ''}`, meta: meta({ ok: true, list: name, items: [] }) };
    return { text: readText(name, list), meta: meta({ ok: true, list: name, items: list.map((i) => i.text), execution_receipt: { tool: 'che_lists', operation: 'read', status: 'success', id: `${name}:${now}`, list: name, count: list.length, stored: list.slice(0, 50).map((i) => i.text) } }) };
  }

  if (intent.action === 'add' || intent.action === 'note') {
    if (!store.lists[name] && Object.keys(store.lists).length >= MAX_LISTS) return { text: `I did not add it, sir: you already have ${MAX_LISTS} lists. Nothing was saved.`, meta: meta({ ok: false }) };
    const existing = store.lists[name]?.items || [];
    const fresh = intent.action === 'note' ? intent.items : intent.items.filter((i) => !existing.some((e) => norm(e.text) === norm(i)));
    const already = intent.items.filter((i) => !fresh.includes(i));
    if (!fresh.length) return { text: `${preview(already.map((text) => ({ text })))} ${already.length === 1 ? 'is' : 'are'} already on your ${called(name)}, sir. Nothing changed.`, meta: meta({ ok: true, list: name, unchanged: true }) };
    if (existing.length + fresh.length > MAX_ITEMS) return { text: `I did not add it, sir: your ${called(name)} would pass ${MAX_ITEMS} items. Nothing was saved.`, meta: meta({ ok: false }) };
    const added = fresh.map((text, k) => ({ id: makeId(now + k), text, added_at: new Date(now).toISOString() }));
    const done = await commit(storage, key, store, name, (list) => [...list, ...added], intent.action, now);
    done.receipt.items = added.map((i) => i.text);
    if (!done.ok) return { text: `I did not save it, sir: ${done.receipt.error === 'write_failed' ? 'the write to CHE\'s server failed' : 'I could not read it back from CHE\'s server'}. Nothing was added to your ${called(name)}.`, meta: meta({ ok: false, list: name, execution_receipt: done.receipt }) };
    if (!probe) await recordReceipt(storage, { kind: 'list_changed', key: `list_changed:${done.receipt.id}`, list: name, operation: intent.action, items: done.receipt.items, after_count: done.receipt.after_count }).catch(() => null);
    const also = already.length ? ` ${preview(already.map((text) => ({ text })))} ${already.length === 1 ? 'was' : 'were'} already on it.` : '';
    const text = intent.action === 'note'
      ? `Note saved, sir: "${added[0].text}". It is stored on CHE's server and I read it back; you have ${plural(done.after.length, 'note')}.`
      : `Added ${preview(added)} to your ${called(name)}, sir. It is stored on CHE's server and I read it back: the list now has ${plural(done.after.length, 'item')} (${preview(done.after)}).${also}`;
    return { text, meta: meta({ ok: true, list: name, execution_receipt: done.receipt }) };
  }

  // Removing and clearing delete the owner's data: only with his yes this turn.
  const list = store.lists[name]?.items || [];
  const picked = intent.action === 'clear' ? list : intent.items.flatMap((i) => matching(list, i));
  if (!picked.length) {
    const what = intent.action === 'clear' ? `Your ${called(name)} is already empty` : `I found ${preview(intent.items.map((text) => ({ text })))} nowhere on your ${called(name)}`;
    return { text: `${what}, sir. Nothing was removed.${list.length ? ` It holds: ${preview(list)}.` : ''}`, meta: meta({ ok: false, list: name, removed: [] }) };
  }
  if (grant?.delete !== true) {
    const ask = intent.action === 'clear' ? `clear your ${called(name)} (${plural(list.length, name === 'notes' ? 'note' : 'item')})` : `remove ${preview(picked)} from your ${called(name)}`;
    try { await storage.put(PENDING_OWNER_ACTION_KEY, { kinds: ['delete'], text: String(message), at: now }); } catch (_) {
      return { text: 'I could not record that safely, so I did not act, sir. Nothing was removed.', meta: meta({ ok: false }) };
    }
    return { text: `Before I delete or remove anything, I need your yes. Please confirm: ${ask}. Should I go ahead?`, meta: meta({ held_for_owner: true, owner_approval_required: true, owner_action_kinds: ['delete'] }) };
  }
  const ids = new Set(picked.map((i) => i.id));
  const done = await commit(storage, key, store, name, (items) => items.filter((i) => !ids.has(i.id)), intent.action === 'clear' ? 'clear' : 'remove', now);
  done.receipt.items = picked.map((i) => i.text);
  if (!done.ok) return { text: `I did not remove it, sir: ${done.receipt.error === 'write_failed' ? 'the write to CHE\'s server failed' : 'I could not read the list back from CHE\'s server'}. Your ${called(name)} is unchanged.`, meta: meta({ ok: false, list: name, execution_receipt: done.receipt }) };
  if (!probe) await recordReceipt(storage, { kind: 'list_changed', key: `list_changed:${done.receipt.id}`, list: name, operation: done.receipt.operation, items: done.receipt.items, after_count: done.receipt.after_count }).catch(() => null);
  const left = done.after.length ? `${plural(done.after.length, name === 'notes' ? 'note' : 'item')} left (${preview(done.after)})` : 'it is empty now';
  const text = intent.action === 'clear'
    ? `Cleared your ${called(name)}, sir: ${plural(picked.length, name === 'notes' ? 'note' : 'item')} removed. I read it back and it is empty.`
    : `Removed ${preview(picked)} from your ${called(name)}, sir. I read it back: ${left}.`;
  return { text, meta: meta({ ok: true, list: name, execution_receipt: done.receipt }) };
}
