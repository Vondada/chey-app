// What CHE can retrieve of the owner's own words, and from where (owner request, 2026-10-23: "what is my favorite
// drink" answered "I don't have a record" although he had said it; "what did I tell ChatGPT …" got a status reply).
//
// Three things live here, all reads of real records and none of them a model:
//   - ownerStatementCandidates: the Brain turns personal recall looks through. It used to read only the newest 500
//     Brain records, so anything the owner said before them could never be found again.
//   - "search my memory for Sprite": every store, its count, and the raw matching records with id, source and date,
//     so the owner can see whether a record exists at all.
//   - the owner's ChatGPT history: there is no API for a person's ChatGPT.com chats, so it arrives only as the
//     official export (Settings → Data controls → Export data → conversations.json), parsed on the phone with secrets
//     removed there, and stored here as Brain records with source chatgpt_export. "What did I tell ChatGPT about X"
//     quotes those records with their conversation title and date, or says the history is not connected.
import { BRAIN_REGIONS } from './brain_store.js';
import { stripWake } from './personal_recall.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const day = (iso) => {
  const at = new Date(String(iso || ''));
  if (!Number.isFinite(at.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${MONTHS[Number(p.month) - 1]} ${Number(p.day)}, ${p.year}`;
};
const clip = (text, n) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The Brain records personal recall reads: the newest 500 plus up to 50 that mention the asked words, by id. */
export function ownerStatementCandidates(store, message) {
  if (!store) return [];
  const byId = new Map();
  try { for (const r of store.list({ limit: 500 }).records || []) byId.set(r.id, r); } catch (_) { /* no Brain */ }
  try { for (const r of store.search(stripWake(message), { limit: 50 }) || []) byId.set(r.id, r); } catch (_) { /* no Brain */ }
  return [...byId.values()];
}

// ─── "Search my memory for Sprite" ──────────────────────────────────────────────────────────────────────────────────

export function ownerMemorySearchIntent(message) {
  const t = stripWake(message).replace(/[?.!]+$/, '').trim();
  const m = /^(?:please\s+)?(?:search|look through|check|scan)\s+(?:my|your|che'?s)\s+(?:memory|memories|brain|records)\s+(?:for|about)\s+(.{1,80})$/i.exec(t);
  if (!m) return null;
  const term = m[1].replace(/^["']|["']$/g, '').trim();
  return term.length >= 2 ? { term } : null;
}

/**
 * Every store CHE keeps of the owner's words, with its count, and each record that contains the term. Counts are of
 * real rows; a store CHE cannot read from here (the phone's own replica) is named as such, never counted.
 */
export function searchOwnerMemory(data = {}, store = null, term = '') {
  const needle = String(term || '').toLowerCase();
  const hit = (text) => String(text || '').toLowerCase().includes(needle);
  const records = Array.isArray(data.memory_records) ? data.memory_records.filter((r) => r && r.active !== false) : [];
  const legacy = Array.isArray(data.memories) ? data.memories.map(String) : [];
  const prefs = Array.isArray(data.preference_memory) ? data.preference_memory : [];
  const stores = [];
  const matches = [];
  stores.push({ store: 'memory records', count: records.length });
  for (const r of records) if (hit(r.text)) matches.push({ store: 'memory records', id: r.id || null, source: r.source || null, verification: r.verification_status || null, at: r.created_at || null, text: clip(r.text, 240) });
  stores.push({ store: 'saved preferences', count: legacy.length });
  for (const text of legacy) {
    if (!hit(text)) continue;
    const pref = prefs.find((p) => String(p?.text || '').toLowerCase() === text.toLowerCase());
    matches.push({ store: 'saved preferences', id: pref?.id || null, source: pref?.source || 'chat (inferred)', verification: 'inferred', at: pref?.created_at || null, text: clip(text, 240) });
  }
  let brainCount = null;
  let gptCount = 0;
  if (store?.init?.()) {
    try {
      brainCount = Number(store.rows('SELECT COUNT(*) AS n FROM brain_records WHERE deleted = 0')[0]?.n) || 0;
      gptCount = Number(store.rows("SELECT COUNT(*) AS n FROM brain_records WHERE deleted = 0 AND source LIKE '%\"chatgpt_export\"%'")[0]?.n) || 0;
      for (const row of store.rows('SELECT id FROM brain_records WHERE deleted = 0 AND (lower(title) LIKE ? OR lower(body) LIKE ?) ORDER BY seq DESC LIMIT 25', `%${needle}%`, `%${needle}%`)) {
        const r = store.get(row.id);
        if (!r) continue;
        const said = /You said:\s*([\s\S]*?)(?:\n(?:CHE|ChatGPT) answered:|$)/.exec(String(r.body || ''));
        const text = said ? said[1] : r.body;
        if (!hit(text) && !hit(r.title)) continue;
        matches.push({ store: r.source?.kind === 'chatgpt_export' ? 'ChatGPT import' : 'Brain', id: r.id, source: r.source?.kind || null, verification: r.verification || null, at: r.source?.message_at || r.created_at || null, text: clip(text, 240), title: r.source?.conversation_title || null });
      }
    } catch (_) { brainCount = null; }
  }
  stores.push({ store: 'Brain (synced from the phone)', count: brainCount });
  stores.push({ store: 'ChatGPT import', count: gptCount, connected: gptCount > 0 });
  return { term, stores, matches, checked_at: new Date().toISOString() };
}

export function speakMemorySearch(found) {
  const counts = found.stores.map((s) => (s.count == null ? `${s.store}: not readable right now` : s.store === 'ChatGPT import' && !s.connected ? 'ChatGPT import: not connected' : `${s.store}: ${s.count}`)).join('; ');
  if (!found.matches.length) {
    return `I searched every store I keep for "${found.term}" and found no record of it, sir. Searched: ${counts}. ${found.stores.find((s) => s.store === 'ChatGPT import')?.connected ? '' : 'If you said it to ChatGPT, I can\'t see that until you import your ChatGPT export.'}`.trim();
  }
  const lines = found.matches.slice(0, 6).map((m, i) => `${i + 1}. ${m.store}${m.title ? ` ("${m.title}")` : ''}, ${m.at ? day(m.at) : 'no date'}${m.id ? `, record ${String(m.id).slice(0, 18)}` : ''}: "${m.text}"`);
  return `I found ${found.matches.length} record${found.matches.length === 1 ? '' : 's'} with "${found.term}", sir. ${lines.join(' ')}${found.matches.length > 6 ? ` And ${found.matches.length - 6} more.` : ''} Searched: ${counts}.`;
}

// ─── The owner's ChatGPT history ────────────────────────────────────────────────────────────────────────────────────

export const NOT_CONNECTED = 'Your ChatGPT history isn\'t connected to me, sir, so I can\'t see what you told ChatGPT. ChatGPT gives me no way to read it directly, and the iPhone screen that imports a ChatGPT data export isn\'t built yet, so nothing from ChatGPT is in my memory. I won\'t guess what you said there.';

/** "What did I tell ChatGPT about my trading rules?", "Did I ask ChatGPT about Sprite?": the owner's words to ChatGPT. */
export function chatgptHistoryIntent(message) {
  const t = stripWake(message).replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  const gpt = '(?:chat\\s*gpt|chatgpt|chat g p t|gpt)';
  const m = new RegExp(`^(?:what|which|when)\\b.*?\\b(?:did|have|had) i (?:ever )?(?:tell|told|say|said|ask|asked|write|wrote|mention|mentioned)(?: to)? ${gpt}\\b(.*)$`, 'i').exec(t)
    || new RegExp(`^(?:did|have) i (?:ever )?(?:tell|told|say|said|ask|asked|mention|mentioned)(?: to)? ${gpt}\\b(.*)$`, 'i').exec(t)
    || new RegExp(`^(?:search|look through|check) my ${gpt} (?:history|chats?|conversations?)(?: for| about)?(.*)$`, 'i').exec(t);
  if (!m) return null;
  const topic = String(m[1] || '').replace(/[?.!]+$/, '').replace(/^\s*(?:about|regarding|on|that)\s+/i, '').replace(/\b(?:last|this) (?:week|month|year)\b|\byesterday\b|\brecently\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { topic };
}

/** The imported ChatGPT turns that mention the topic, newest first, quoted with title and date. */
export function speakChatgptHistory(store, ask = {}) {
  let total = 0;
  try { total = store?.init?.() ? Number(store.rows("SELECT COUNT(*) AS n FROM brain_records WHERE deleted = 0 AND source LIKE '%\"chatgpt_export\"%'")[0]?.n) || 0 : 0; } catch (_) { total = 0; }
  if (!total) return NOT_CONNECTED;
  const words = [...new Set(String(ask.topic || '').toLowerCase().match(/[a-z0-9']{3,}/g) || [])].filter((w) => !['my', 'the', 'and', 'about', 'what', 'that'].includes(w)).slice(0, 8);
  if (!words.length) return `I have ${total} of your ChatGPT messages imported, sir. Tell me the topic and I'll quote what you said.`;
  const hits = [];
  for (const row of store.rows("SELECT id FROM brain_records WHERE deleted = 0 AND source LIKE '%\"chatgpt_export\"%' ORDER BY seq DESC LIMIT 5000")) {
    const r = store.get(row.id);
    const said = /You said:\s*([\s\S]*?)(?:\nChatGPT answered:|$)/.exec(String(r?.body || ''));
    const text = said ? said[1] : '';
    const low = text.toLowerCase();
    const score = words.filter((w) => low.includes(w)).length;
    if (score >= Math.min(2, words.length)) hits.push({ r, text, score, at: r.source?.message_at || r.created_at });
  }
  if (!hits.length) return `I searched your ${total} imported ChatGPT messages and found nothing you said about ${ask.topic}, sir.`;
  hits.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)));
  const quoted = hits.slice(0, 3).map((h, i) => `${i + 1}. In "${clip(h.r.source?.conversation_title || 'untitled chat', 60)}" on ${day(h.at) || 'an unknown date'}, you wrote: "${clip(h.text, 220)}"`).join(' ');
  return `From your imported ChatGPT history, sir: ${quoted}${hits.length > 3 ? ` There are ${hits.length - 3} more matches.` : ''} These are your own words in ChatGPT, not something I checked.`;
}

/**
 * Stores one batch of ChatGPT export turns the phone parsed and redacted. Each turn becomes one Brain record keyed by
 * its export message id, so a repeated import adds nothing twice. Text that still looks like a secret is refused by
 * the Brain store's own gate and counted, never stored.
 */
export function importChatgptBatch(store, turns = [], { now = new Date().toISOString() } = {}) {
  const out = { received: 0, stored: 0, duplicates: 0, refused: 0 };
  for (const t of Array.isArray(turns) ? turns.slice(0, 500) : []) {
    out.received += 1;
    const said = String(t?.text || '').trim().slice(0, 20000);
    const id = String(t?.message_id || '').replace(/[^\w-]/g, '').slice(0, 80);
    if (!said || !id) { out.refused += 1; continue; }
    const reply = String(t?.reply || '').trim().slice(0, 4000);
    const at = Number.isFinite(Date.parse(String(t?.created_at || ''))) ? new Date(t.created_at).toISOString() : null;
    const res = store.putIfAbsent({
      id: `gpt:${id}`,
      kind: 'conversation',
      region: BRAIN_REGIONS.conversations,
      path: `ChatGPT/${(at || now).slice(0, 7)}`,
      title: clip(t?.conversation_title || said, 90),
      body: reply ? `You said: ${said}\nChatGPT answered: ${reply}` : `You said: ${said}`,
      source: { kind: 'chatgpt_export', conversation_id: String(t?.conversation_id || '').slice(0, 80), conversation_title: clip(t?.conversation_title, 120), message_at: at, imported_at: now },
      verification: 'owner_attested',
      created_at: now,
    }, { origin: 'phone' });
    if (res?.outcome === 'rejected') out.refused += 1;
    else if (res?.outcome === 'present') out.duplicates += 1;
    else out.stored += 1;
  }
  return out;
}

// ─── The phone's Brain notes ────────────────────────────────────────────────────────────────────────────────────────
// Owner report (2026-10-23, after #491): "What's my favorite drink?" → "no record exists", with Sprite in his Brain.
// Facts in the phone's Brain (facts.json: the ones he types in the Brain and the ```che-remember lines CHE saves) never
// reach the Worker's stores; they arrive only inside each request's brain_context, under "[CHE BRAIN — what you know,
// by category]". Recall read every Worker store and none of those lines, so a fact kept only on the phone was "no
// record". These are the notes, as statements recall can match ("[People] The owner's favorite drink is Sprite" →
// "my favorite drink is Sprite"), each keeping the note's own words.

const FACTS_HEADER = /^\[CHE BRAIN — what you know, by category\]/;

/** The phone's Brain notes sent with this request: [{ text, note, phone: true }]. Anything else in brain_context is skipped. */
export function phoneBrainNotes(brainContext) {
  const blocks = Array.isArray(brainContext) ? brainContext.map(String) : [];
  const notes = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (!FACTS_HEADER.test(lines[0] || '')) continue;
    for (const line of lines.slice(1)) {
      const m = /^\s*-\s+(.{2,400})$/.exec(line);
      if (!m) continue;
      const note = m[1].trim();
      const text = noteAsStatement(note);
      // A note about someone else ("His favorite drink is Coke") is not the owner's fact: it is never recalled as one.
      if (text == null) continue;
      notes.push({ text, note: note.replace(/^\[[A-Za-z]+\]\s*/, ''), phone: true });
    }
  }
  return notes;
}

// A note that starts with another person: "His …", "Her …", "Their …", "Sam's …", "The team's …".
const OTHER_PERSON = /^(?:his|her|their|its|(?:the\s+)?[A-Za-z][\w-]*['’]s)\b/i;

/**
 * A Brain note in the owner's own grammar: the category tag dropped, and only "The owner's" / "The user's" read as "My".
 * Returns null for a note about someone else, so it is never recalled as the owner's fact.
 */
export function noteAsStatement(note) {
  const text = String(note || '').replace(/^\s*\[[A-Za-z]+\]\s*/, '').trim();
  if (/^(?:the\s+)?(?:owner|user)(?:['’]s)\s+/i.test(text)) return text.replace(/^(?:the\s+)?(?:owner|user)(?:['’]s)\s+/i, 'My ');
  if (OTHER_PERSON.test(text)) return null;
  return text;
}

// ─── "Show a saved Brain record" ────────────────────────────────────────────────────────────────────────────────────
// Owner report (2026-10-23): "Show a saved Brain record" and "Inspect your memory system" went to the language model,
// so a busy engine gave "I couldn't finish that answer". Both are reads of CHE's own stores and never need a model.

/** "Show a saved Brain record", "open my latest brain record", "show me a memory record about Sprite". */
export function brainRecordIntent(message) {
  const t = stripWake(message).replace(/[?.!]+$/, '').replace(/\s+/g, ' ').trim();
  const m = /^(?:can you |could you |please )?(?:show|open|read|give|pull up|bring up)(?: me| up)? (?:a|one|the|my|your|any|the latest|the newest|the most recent|my latest|your latest|a recent)? ?(?:saved |stored |latest |newest |recent |random )?(?:brain|memory) (?:record|entry|note)s?(?: (?:about|on|for|with) (.{2,60}))?$/i.exec(t);
  if (!m) return null;
  return { term: (m[1] || '').trim() };
}

/** One real Brain record, newest first (or the newest that mentions the term), with its id, kind, source and status. */
export function speakBrainRecord(store, ask = {}) {
  if (!store?.init?.()) {
    return { text: "I can't open the Brain store right now, sir, so I can't show a record. Nothing was changed. Ask me again in a minute; if it keeps failing, the Brain store on the Worker is down.", record: null, available: false };
  }
  let record = null;
  try {
    if (ask.term) {
      const needle = ask.term.toLowerCase();
      const row = store.rows('SELECT id FROM brain_records WHERE deleted = 0 AND (lower(title) LIKE ? OR lower(body) LIKE ?) ORDER BY seq DESC LIMIT 1', `%${needle}%`, `%${needle}%`)[0];
      record = row ? store.get(row.id) : null;
    } else {
      record = (store.list({ limit: 1 }).records || [])[0] || null;
    }
  } catch (_) {
    return { text: "I couldn't read a record from the Brain store just now, sir. The store answered with an error, so I have no record to show. Nothing was changed.", record: null, available: false };
  }
  if (!record) {
    return {
      text: ask.term ? `There's no saved Brain record that mentions "${ask.term}", sir. Say "search my memory for ${ask.term}" and I'll check every store, not just the Brain.` : 'Your Brain on the Worker has no saved records yet, sir, so there is nothing to show.',
      record: null, available: true,
    };
  }
  const said = /You said:\s*([\s\S]*?)(?:\n(?:CHE|ChatGPT) answered:|$)/.exec(String(record.body || ''));
  const body = clip(said ? `You said: ${said[1]}` : record.body, 280);
  const when = day(record.updated_at || record.created_at);
  const source = String(record.source?.kind || 'unknown source').replace(/_/g, ' ');
  const status = String(record.verification || 'unverified').replace(/_/g, ' ');
  const title = clip(record.title || '', 90).replace(/[.!?]+$/, '');
  const text = `Here's ${ask.term ? `the newest Brain record about "${ask.term}"` : 'the newest saved Brain record'}, sir. ${title ? `"${title}". ` : ''}It's a ${String(record.kind || 'record').replace(/_/g, ' ')} from ${source}${when ? `, saved ${when}` : ''}, status ${status}. It says: "${body}" Record ${String(record.id).slice(0, 24)}. It's linked below to open in the Brain.`;
  return { text, record, available: true };
}

// ─── "Inspect your memory system" ───────────────────────────────────────────────────────────────────────────────────

/** "Inspect your memory system", "check your memory", "how is your memory doing", "memory status", "brain status". */
export function memoryInspectIntent(message) {
  const t = stripWake(message).replace(/[?.!]+$/, '').replace(/\s+/g, ' ').trim();
  if (t.length > 120) return false;
  if (/\b(?:build|fix|change|delete|remove|clear|wipe|reset|code|repo|pull request)\b/i.test(t)) return false;
  return /^(?:can you |could you |please )?(?:inspect|check|audit|diagnose|test|examine|review|scan) (?:your|che'?s|the|my) (?:memory|brain)(?: (?:system|stores?|status|health))?$/i.test(t)
    || /^(?:what(?:'s| is) )?(?:your|che'?s|the) (?:memory|brain) (?:status|health)$/i.test(t)
    || /^(?:memory|brain) (?:status|health|system status)$/i.test(t)
    || /^how(?:'s| is) your (?:memory|brain)(?: system)?(?: doing| working)?$/i.test(t);
}

/** Every memory store with a real count, the Brain's own status, and what was not readable. No model, no guesses. */
export function inspectMemory(data = {}, store = null, { phoneNotes = [] } = {}) {
  const records = Array.isArray(data.memory_records) ? data.memory_records.filter((r) => r && r.active !== false) : [];
  const ownerAttested = records.filter((r) => r.verification_status === 'owner_attested').length;
  const legacy = Array.isArray(data.memories) ? data.memories.length : 0;
  let brain = null;
  try { brain = store?.status?.() || null; } catch (_) { brain = null; }
  return {
    memory_records: records.length,
    owner_attested: ownerAttested,
    saved_preferences: legacy,
    brain: brain && brain.available ? {
      records: brain.records, by_kind: brain.by_kind || {}, by_verification: brain.by_verification || {},
      open_conflicts: brain.open_conflicts || 0, full_text_search: Boolean(brain.full_text_search),
    } : null,
    phone_notes_sent: phoneNotes.length,
    checked_at: new Date().toISOString(),
  };
}

export function speakMemoryInspection(r) {
  const parts = [
    `Memory records: ${r.memory_records}, ${r.owner_attested} of them in your own words.`,
    `Saved preferences: ${r.saved_preferences}.`,
  ];
  if (r.brain) {
    const kinds = Object.entries(r.brain.by_kind).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ');
    parts.push(`Brain on the Worker: ${r.brain.records} records${kinds ? ` (${kinds})` : ''}, ${r.brain.open_conflicts} open conflict${r.brain.open_conflicts === 1 ? '' : 's'}, search ${r.brain.full_text_search ? 'indexed' : 'without the full-text index'}.`);
  } else {
    parts.push('Brain on the Worker: not readable right now, so I have no count for it.');
  }
  parts.push(r.phone_notes_sent ? `Your phone sent ${r.phone_notes_sent} Brain note${r.phone_notes_sent === 1 ? '' : 's'} with this message; those live only on the phone.` : 'Your phone sent no Brain notes with this message.');
  return `I checked my memory stores just now, sir. ${parts.join(' ')} Ask "search my memory for" a word to see the records themselves.`;
}
