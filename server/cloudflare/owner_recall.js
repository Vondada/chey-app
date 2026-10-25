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
import { latestAnswerEvidence, readOutcome, recordAnswerEvidence } from './memory_provenance.js';
import { explicitMemorySave, isQuestionLike, ownerFacts, statementsFromBrain, stripWake } from './personal_recall.js';

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
  // `unreadable` marks a Brain that could not be read at all, so a miss is reported as "could not read", never as
  // "no record" (owner live test, 2026-10-25: an unreadable store and an empty one gave the same reply).
  if (!store) return Object.assign([], { unreadable: true });
  const byId = new Map();
  let failures = 0;
  try { for (const r of store.list({ limit: 500 }).records || []) byId.set(r.id, r); } catch (_) { failures += 1; }
  try { for (const r of store.search(stripWake(message), { limit: 50 }) || []) byId.set(r.id, r); } catch (_) { failures += 1; }
  return Object.assign([...byId.values()], failures === 2 ? { unreadable: true } : {});
}

// ─── "Search my memory for Sprite" ──────────────────────────────────────────────────────────────────────────────────
// Owner report (2026-10-24): "what memories do you have about my favorite color" reached the model, which answered
// "I retrieved memory IDs 8829, 8830 and 8831 from storage" with no store read at all. Every way of asking for the
// stored records now comes here, where the stores are really read and only their real ids, dates and sources are named.
// "Show me the memory IDs you retrieved" names the records CHE's last answer actually read (its ledger entry), or says
// that it read none.

const SEARCH_VERB = String.raw`(?:search|look through|look in|check|scan|pull(?: up| out)?|show(?: me)?|list|get(?: me)?|give me|fetch|retrieve|find|bring up|read(?: me)?|look up|tell me)`;
// A bare "record" belongs to its own route ("pull the record for sim-2023-03-10-001" is a trade ledger read).
const STORE_NOUN = String.raw`(?:(?:(?:my|your|che'?s|the|all|any|all of|all the|all your|all my)\s+)*(?:stored\s+|saved\s+)?(?:memory\s+(?:records?|entries|entry|notes?)|memories|memory|brain(?:\s+records?)?|stored\s+records?|(?:stored|saved)\s+entries)|(?:my|your|che'?s)\s+records|(?:my|your|che'?s|the)\s+database(?:\s+(?:records?|entries|entry|rows))?)`;
const ABOUT = String.raw`(?:for|about|on|of|regarding|related to|that mention|mentioning|with)`;
const SEARCH_FORMS = [
  new RegExp(String.raw`^(?:please\s+|can you\s+|could you\s+|would you\s+)?${SEARCH_VERB}\s+${STORE_NOUN}\s+${ABOUT}\s+(.{1,80})$`, 'i'),
  // "What memories do you have about my favorite color?", "which records do you have on Sprite?"
  new RegExp(String.raw`^(?:what|which|any)\s+(?:memories|memory\s+records?|memory\s+entries|stored\s+records?|memory)\s+(?:do|did|have)\s+you\s+(?:have|keep|hold|store|stored|got|find|found|retrieve|retrieved|pull|pulled|read)?\s*(?:stored\s+|saved\s+|on file\s+)?${ABOUT}\s+(.{1,80})$`, 'i'),
  // "What's stored in your database about colors?"
  new RegExp(String.raw`^what(?:'s|s| is)\s+(?:stored|saved|kept)\s+in\s+(?:your|my|the|che'?s)\s+(?:database|memory|brain|records)\s+${ABOUT}\s+(.{1,80})$`, 'i'),
  // "What do you have stored about my favorite color?", "do you have any memories of my dog?"
  new RegExp(String.raw`^(?:what|do)\s+(?:do\s+)?you\s+have\s+(?:any\s+)?(?:stored|saved|on record|on file|in (?:your|my) memory|memories|memory records?|records?)\s+${ABOUT}\s+(.{1,80})$`, 'i'),
];
// "Show me the memory IDs you retrieved", "which records did you read?", "what memory ids did you use?" The whole
// question is about CHE's last answer: "which records did you use for the backtest" belongs to its own route.
const IDS_FORMS = [
  /^(?:please\s+|can you\s+|could you\s+)?(?:show|list|tell|give|read)(?:\s+me)?\s+(?:the\s+|your\s+|those\s+|my\s+)?(?:memory\s+|record\s+)?(?:ids?|record\s+(?:ids?|numbers?)|records?|memories)\s+(?:that\s+)?(?:you\s+)?(?:just\s+)?(?:retrieved|read|used|pulled|found|cited|looked up|got)(?:\s+(?:just now|earlier|before|for (?:that|this|it|that answer|your (?:last )?answer)|to answer (?:that|this|it)|in (?:that|your last) answer))?$/i,
  /^(?:what|which)\s+(?:memory\s+|record\s+)?(?:ids?|record\s+(?:ids?|numbers?)|records?|memories)\s+(?:did|have)\s+you\s+(?:just\s+)?(?:retrieve|read|use|pull|cite|look up|get|retrieved|used|pulled)(?:\s+(?:just now|earlier|before|for (?:that|this|it|that answer|your (?:last )?answer)|to answer (?:that|this|it)|in (?:that|your last) answer))?$/i,
  /^where\s+are\s+(?:the|those)\s+(?:memory\s+)?(?:ids?|records?)\s+(?:you\s+)?(?:retrieved|read|used|pulled)(?:\s+(?:just now|earlier|before|for (?:that|this|it|that answer|your (?:last )?answer)|to answer (?:that|this|it)|in (?:that|your last) answer))?$/i,
];

// "What is the record ID and timestamp for Silver Falcon 27?", "show me the storage receipt for that memory", "what's the
// source of those facts?" (owner live test, 2026-10-25: all three reached the model, which could give neither an id nor
// a time). A named term is searched in every store; "that", "it", "those facts" mean the records CHE's last answer read.
const META_NOUN = String.raw`(?:(?:memory\s+|record\s+)?ids?|record\s+(?:ids?|numbers?)|time\s*stamps?|timestamps?|times?|dates?|storage\s+receipts?|write\s+receipts?|receipts?|sources?|source\s+metadata|metadata|provenance|origin)`;
const META_FORMS = [
  new RegExp(String.raw`^(?:please\s+)?(?:what(?:'s|s| is| are| was| were)?|show(?:\s+me)?|give(?:\s+me)?|tell(?:\s+me)?|read(?:\s+me)?|list|get(?:\s+me)?|i\s+(?:want|need)|can\s+you\s+(?:show|give|tell)(?:\s+me)?)\s+(?:the\s+|its\s+|their\s+|your\s+)?${META_NOUN}(?:(?:\s*,\s*|\s+and\s+|\s*,\s*and\s+)(?:the\s+|its\s+)?${META_NOUN})*\s+(?:for|of|on|behind|about)\s+(.{1,80})$`, 'i'),
];
const POINTER_TERM = /^(?:(?:that|this|it|those|these|them|the last one|your last answer|that answer|the (?:last|previous) (?:answer|memory|record|save))(?:\s+(?:memory|memories|record|records|fact|facts|answer|answers|save|phrase|one|ones))?)$/i;

// "What are my recent memories?", "show my last five memories", "what do you remember about me?" (owner live test,
// 2026-10-25: answered "I don't have a record of your recent memories" while memory records held his statements).
// The newest stored memory records, each with id, time and source; never a personal-fact lookup of "recent memories".
const COUNT = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const RECENT_FORMS = [
  /^(?:what|which)\s+(?:are|were)\s+(?:my|your|che'?s|the)\s+(?:(?:most\s+)?(?:recent|latest|newest|last)\s+)(?:(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:memories|memory\s+records|saved\s+memories|stored\s+memories)$/i,
  /^(?:show|list|give|read|tell)(?:\s+me)?\s+(?:my|your|che'?s|the)\s+(?:(?:most\s+)?(?:recent|latest|newest|last)\s+)?(?:(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:memories|memory\s+records|saved\s+memories|stored\s+memories)$/i,
  /^what\s+(?:do|did)\s+you\s+(?:remember|know|have\s+(?:saved|stored))\s+about\s+me$/i,
  /^what\s+(?:have\s+you|did\s+you)\s+(?:saved|stored|remembered)\s+(?:about\s+me\s+)?(?:recently|lately)$/i,
];

export function ownerMemorySearchIntent(message) {
  const t = stripWake(message).replace(/[?.!]+$/, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 140) return null;
  if (IDS_FORMS.some((re) => re.test(t))) return { ids: true, term: '' };
  for (const re of RECENT_FORMS) {
    const m = re.exec(t);
    if (m) return { recent: true, term: '', limit: Math.max(1, Math.min(10, m[1] ? Number(COUNT[m[1].toLowerCase()] || m[1]) : 5)) };
  }
  for (const re of META_FORMS) {
    const m = re.exec(t);
    if (!m) continue;
    const term = m[1].replace(/^["']|["']$/g, '').replace(/\s+(?:please|sir|che)$/i, '').trim();
    if (POINTER_TERM.test(term)) return { ids: true, term: '', meta: true };
    if (/\b(?:trad(?:e|es|ing)|ledgers?|journals?|sim-|paper|positions?|orders?|fills?|strateg(?:y|ies)|commits?|deploy\w*|pr|pull requests?|jobs?|builds?)\b/i.test(term)) return null;
    if (term.length >= 2 && termWords(term).length) return { term, meta: true };
  }
  for (const re of SEARCH_FORMS) {
    const m = re.exec(t);
    if (!m) continue;
    // "… for colors and their IDs": what to show, not what to find.
    const term = m[1].replace(/^["']|["']$/g, '').replace(/\s+(?:please|sir|che)$/i, '').replace(/,?\s+(?:and|with)\s+(?:their|the|its)\s+(?:record\s+)?(?:ids?|dates?|sources?)(?:\s+and\s+(?:ids?|dates?|sources?))*$/i, '').trim();
    // Trades, ledgers and journals have their own readers (che_trading_ledgers): "show me the database records about my trades".
    if (/\b(?:trad(?:e|es|ing)|ledgers?|journals?|sim-|paper|positions?|orders?|fills?|strateg(?:y|ies))\b/i.test(term)) return null;
    if (term.length >= 2 && termWords(term).length) return { term };
  }
  return null;
}

// The words a stored record must contain: "my favorite colors" finds "My favorite color is red".
const TERM_STOP = new Set(['my', 'your', 'the', 'a', 'an', 'of', 'for', 'on', 'about', 'any', 'all', 'me', 'i', 'che', "che's", 'stored', 'saved', 'records', 'record', 'memories', 'memory']);
function termWords(term) {
  return [...new Set(String(term || '').toLowerCase().replace(/[‘’ʼ]/g, "'").split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 2 && !TERM_STOP.has(w))
    .map((w) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w)))];
}

/**
 * Every store CHE keeps of the owner's words, with its count, and each record that contains the term's words. Counts
 * are of real rows; a store CHE cannot read is named as such, never counted. Superseded memory records are listed as
 * superseded, so a correction's history shows. Returns { term, stores, matches, current, checked_at, read_receipt }.
 */
export function searchOwnerMemory(data = {}, store = null, term = '') {
  const stems = termWords(term);
  const needle = String(term || '').toLowerCase();
  const hit = (text) => { const t = String(text || '').toLowerCase(); return stems.length ? stems.every((w) => t.includes(w)) : t.includes(needle); };
  const all = Array.isArray(data.memory_records) ? data.memory_records.filter(Boolean) : [];
  const records = all.filter((r) => r.active !== false);
  const legacy = Array.isArray(data.memories) ? data.memories.map(String) : [];
  const prefs = Array.isArray(data.preference_memory) ? data.preference_memory : [];
  const stores = [];
  const matches = [];
  stores.push({ store: 'memory records', count: records.length });
  for (const r of all) {
    if (!hit(r.text)) continue;
    const superseded = r.active === false || Boolean(r.superseded_at);
    matches.push({ store: 'memory records', id: r.id || null, source: r.source || null, verification: r.verification_status || null, at: r.created_at || null, text: clip(r.text, 240), ...(superseded ? { superseded: true, superseded_at: r.superseded_at || null } : {}) });
  }
  stores.push({ store: 'saved preferences', count: legacy.length });
  for (const text of legacy) {
    if (!hit(text)) continue;
    // A saved preference that is also a memory record is the same statement; it is listed once.
    if (matches.some((m) => m.text.toLowerCase() === clip(text, 240).toLowerCase())) continue;
    const pref = prefs.find((p) => String(p?.text || '').toLowerCase() === text.toLowerCase());
    matches.push({ store: 'saved preferences', id: pref?.id || null, source: pref?.source || 'chat (inferred)', verification: 'inferred', at: pref?.created_at || null, text: clip(text, 240) });
  }
  let brainCount = null;
  let gptCount = 0;
  let brainError = null;
  try {
    if (store?.init?.()) {
      brainCount = Number(store.rows('SELECT COUNT(*) AS n FROM brain_records WHERE deleted = 0')[0]?.n) || 0;
      gptCount = Number(store.rows("SELECT COUNT(*) AS n FROM brain_records WHERE deleted = 0 AND source LIKE '%\"chatgpt_export\"%'")[0]?.n) || 0;
      const like = `%${[...stems].sort((a, b) => b.length - a.length)[0] || needle}%`;
      for (const row of store.rows('SELECT id FROM brain_records WHERE deleted = 0 AND (lower(title) LIKE ? OR lower(body) LIKE ?) ORDER BY seq DESC LIMIT 25', like, like)) {
        const r = store.get(row.id);
        if (!r) continue;
        const said = /You said:\s*([\s\S]*?)(?:\n(?:CHE|ChatGPT) answered:|$)/.exec(String(r.body || ''));
        const text = said ? said[1] : r.body;
        if (!hit(text) && !hit(r.title)) continue;
        // The owner's own question ("what memories do you have about my favorite color") is not a memory of the answer.
        // A save request's Brain turn is not a second memory: the memory record it wrote is listed with its own id.
        if (said && (isQuestionLike(text) || ownerMemorySearchIntent(text) || explicitMemorySave(text))) continue;
        matches.push({ store: r.source?.kind === 'chatgpt_export' ? 'ChatGPT import' : 'Brain', id: r.id, source: r.source?.kind || null, verification: r.verification || null, at: r.source?.message_at || r.created_at || null, text: clip(text, 240), title: r.source?.conversation_title || null });
      }
    }
  } catch (error) { brainCount = null; brainError = String(error?.message || error).slice(0, 160); }
  stores.push({ store: 'Brain (synced from the phone)', count: brainCount, ...(brainError ? { error: brainError } : {}) });
  stores.push({ store: 'ChatGPT import', count: gptCount, connected: gptCount > 0 });
  const checkedAt = new Date().toISOString();
  return {
    term, stores, matches, current: currentValues(matches), checked_at: checkedAt,
    // What this turn really read: the proof behind any record id the reply names.
    read_receipt: { kind: 'memory_store_read', at: checkedAt, stores_read: stores.filter((s) => s.count != null).map((s) => s.store), stores_unreadable: stores.filter((s) => s.count == null).map((s) => s.store), record_ids: matches.map((m) => m.id).filter(Boolean) },
  };
}

const at = (m) => { const t = Date.parse(String(m?.at || '')); return Number.isFinite(t) ? t : -Infinity; };
const OWNER_SOURCES = new Set(['owner', 'owner_chat', 'explicit_memory', 'owner_approved', 'chatgpt_export']);
const ownerConfirmed = (m) => m.verification === 'owner_attested' && (m.store !== 'memory records' || OWNER_SOURCES.has(String(m.source || '')));

/**
 * For each owner fact the matches state ("my favorite color is …"), the value of the newest owner-confirmed statement
 * that was not superseded; every other value of the same fact is listed as replaced. Deterministic: by stored date,
 * ties broken by the later record. [{ subject, value, match, replaced: [{ value, match }] }]
 */
function currentValues(matches) {
  const bySubject = new Map();
  matches.forEach((m, index) => {
    if (!ownerConfirmed(m)) return;
    for (const fact of ownerFacts(m.text)) {
      const key = [...fact.subjectWords].sort().join(' ');
      if (!bySubject.has(key)) bySubject.set(key, []);
      bySubject.get(key).push({ subject: fact.subject, value: fact.value, match: m, index });
    }
  });
  const out = [];
  for (const facts of bySubject.values()) {
    const ordered = facts.slice().sort((a, b) => (Number(!a.match.superseded) - Number(!b.match.superseded)) || (at(a.match) - at(b.match)) || (a.index - b.index));
    const winner = ordered.at(-1);
    const replaced = ordered.slice(0, -1).filter((f) => f.value.toLowerCase() !== winner.value.toLowerCase());
    if (replaced.length) out.push({ subject: winner.subject, value: winner.value, match: winner.match, replaced: replaced.map((f) => ({ value: f.value, match: f.match })) });
  }
  return out;
}

const recordName = (m) => (m.id ? `record ${String(m.id).slice(0, 36)}` : 'no record id');
// The stored instant to the minute, in UTC as stored: "stored 2026-10-25 06:03 UTC".
const stamp = (iso) => { const t = Date.parse(String(iso || '')); return Number.isFinite(t) ? `stored ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'no stored time'; };
const SOURCES = { owner_chat: 'source: your own words in chat', owner: 'source: your own words', explicit_memory: 'source: a memory you asked me to save', owner_approved: 'source: a memory you approved', chatgpt_export: 'source: your imported ChatGPT history' };
const sourceLabel = (source, verification) => `${SOURCES[String(source || '')] || (source ? `source: ${String(source).replace(/_/g, ' ')}` : 'source: not recorded')}${verification === 'owner_attested' ? ', owner-confirmed' : verification ? `, ${String(verification).replace(/_/g, ' ')}` : ''}`;

export function speakMemorySearch(found) {
  const counts = found.stores.map((s) => (s.count == null ? `${s.store}: not readable right now` : s.store === 'ChatGPT import' && !s.connected ? 'ChatGPT import: not connected' : `${s.store}: ${s.count}`)).join('; ');
  const unreadable = found.stores.filter((s) => s.count == null).map((s) => s.store);
  if (!found.matches.length) {
    const partial = unreadable.length ? ` I couldn't read ${unreadable.join(' or ')} just now, so a record there may exist that I can't see; I won't guess at it.` : '';
    return `I searched every store I keep for "${found.term}" and found no record of it, sir.${partial} Searched: ${counts}. ${found.stores.find((s) => s.store === 'ChatGPT import')?.connected ? '' : 'If you said it to ChatGPT, I can\'t see that until you import your ChatGPT export.'}`.trim();
  }
  // Newest first, so the owner hears his latest statement before older ones.
  const listed = found.matches.map((m, i) => ({ m, i })).sort((a, b) => (at(b.m) - at(a.m)) || (b.i - a.i)).map((x) => x.m);
  // Asked for ids, times or sources, each record names all three exactly as stored.
  const lines = listed.slice(0, 6).map((m, i) => `${i + 1}. ${m.store}${m.title ? ` ("${m.title}")` : ''}, ${found.meta ? stamp(m.at) : m.at ? day(m.at) : 'no date'}${m.id ? `, ${recordName(m)}` : ''}${found.meta ? `, ${sourceLabel(m.source, m.verification)}` : ''}${m.superseded ? ', superseded' : ''}: "${m.text}"`);
  const current = (found.current || []).map((c) => `Your latest confirmed ${c.subject} is ${c.value} (${recordName(c.match)}${c.match.at ? `, ${day(c.match.at)}` : ''}); it replaces ${c.replaced.map((r) => `${r.value} (${recordName(r.match)}${r.match.at ? `, ${day(r.match.at)}` : ''})`).join(' and ')}.`).join(' ');
  return `I read my memory stores just now and found ${found.matches.length} record${found.matches.length === 1 ? '' : 's'} with "${found.term}", sir.${current ? ` ${current}` : ''} ${lines.join(' ')}${found.matches.length > 6 ? ` And ${found.matches.length - 6} more.` : ''} Searched: ${counts}.`;
}

/**
 * The newest active memory records, each with its full id, stored time and source: { text, records }. An empty store
 * says it is empty (no matching record); a store that throws is reported by ownerSearchTurn as unreadable, never as empty.
 */
export function speakRecentMemories(data = {}, limit = 5, store = null) {
  if (data == null || typeof data !== 'object') throw new Error('memory records are not readable');
  const records = Array.isArray(data.memory_records) ? data.memory_records.filter((r) => r && r.active !== false && String(r.text || '').trim()) : [];
  // The owner's own statements of fact in the Brain ("My favorite drink is Strawberry Sprite" said in chat) count too:
  // they are what personal recall answers from. A Brain statement already kept as a memory record is listed once.
  const brain = ownerStatementCandidates(store, '');
  const known = new Set(records.map((r) => String(r.text).trim().toLowerCase()));
  const stated = statementsFromBrain(brain)
    .filter((r) => r.origin !== 'chatgpt_export' && ownerFacts(r.text).length && !known.has(String(r.text).trim().toLowerCase()))
    .map((r) => ({ id: r.id, text: r.text, created_at: r.created_at, source: 'owner_chat', verification_status: 'owner_attested', brain: true }));
  const all = [...records, ...stated];
  const newest = all.map((r, i) => ({ r, i, t: Date.parse(String(r.created_at || '')) }))
    .sort((a, b) => ((Number.isFinite(b.t) ? b.t : -Infinity) - (Number.isFinite(a.t) ? a.t : -Infinity)) || (b.i - a.i))
    .slice(0, limit).map((x) => x.r);
  const brainNote = brain.unreadable ? ' I couldn\'t read my Brain store just now, so statements kept only there are not included.' : '';
  if (!newest.length) {
    return brain.unreadable
      ? { text: `I read my memory records just now and there are none stored, sir, and I couldn't read my Brain store, so I can't say whether you told me anything there. That is a failed read, not an empty memory.`, records: [], unreadable: true }
      : { text: 'I read my memory records and Brain just now and there are no memories stored yet, sir. That is an empty store, not a read failure. Tell me something to remember and I will confirm it with its record ID.', records: [] };
  }
  const lines = newest.map((r, i) => `${i + 1}. "${clip(r.text, 160)}", record ${r.id || 'with no id'} in ${r.brain ? 'the Brain' : 'memory records'}, ${stamp(r.created_at)}, ${sourceLabel(r.source, r.verification_status)}${r.superseded_at ? ', superseded' : ''}.`);
  return { text: `Your ${newest.length === 1 ? 'most recent memory' : `${newest.length} most recent memories`}, newest first, sir, read from my memory records (${records.length}) and your statements in the Brain (${stated.length}) just now: ${lines.join(' ')}${brainNote}`, records: newest.map((r) => r.id).filter(Boolean), unreadable: Boolean(brain.unreadable) };
}

/**
 * The records CHE's last answer actually read, from that answer's ledger entry (memory_provenance.recordAnswerEvidence),
 * looked up again in the stores so each id shown is real. An answer that read nothing says so: no id is ever made up.
 */
export function speakLastRecordIds(last, data = {}, store = null) {
  const ids = Array.isArray(last?.records) ? last.records.filter(Boolean) : [];
  if (!ids.length) {
    return { text: 'My last answer didn\'t read any memory record, sir, so there are no memory IDs from it. If an earlier reply named record numbers without a read, they were not real. Say "search my memory for" and a topic, and I\'ll read the stores and give you the real record IDs.', records: [] };
  }
  const shown = [];
  for (const id of ids.slice(0, 5)) {
    let r = (Array.isArray(data.memory_records) ? data.memory_records : []).find((x) => x?.id === id) || null;
    let where = 'memory records';
    if (!r) { try { r = store?.init?.() ? store.get(id) : null; where = 'Brain'; } catch (_) { r = null; } }
    if (r) shown.push({ id, line: `record ${String(id).slice(0, 36)} in ${where}, ${stamp(r.created_at)}, ${sourceLabel(r.source?.kind || r.source, r.verification_status || r.verification)}: "${clip(r.text || r.title || r.body, 160)}"` });
  }
  if (!shown.length) return { text: 'My last answer named records I can no longer find in my stores, sir, so I can\'t show their IDs as real. Ask me to search my memory and I\'ll read the stores again.', records: [] };
  return { text: `My last answer read ${shown.length} record${shown.length === 1 ? '' : 's'}, sir: ${shown.map((s, i) => `${i + 1}. ${s.line}`).join(' ')}`, records: shown.map((s) => s.id) };
}

/**
 * The whole "search my memory" / "which record ids did you read" turn: a real read of the stores, its receipt in the
 * answer ledger, and a reply that names only what was read. A store that throws gives an honest failure, never content.
 * Returns { text, meta } for the chat route's done line.
 */
export async function ownerSearchTurn(storage, data, store, ask = {}) {
  let text;
  let records = [];
  let meta;
  try {
    if (ask.recent) {
      const recent = speakRecentMemories(data, ask.limit || 5, store);
      ({ text, records } = recent);
      meta = { read_receipt: { kind: 'memory_store_read', at: new Date().toISOString(), stores_read: recent.unreadable ? ['memory records'] : ['memory records', 'Brain'], stores_unreadable: recent.unreadable ? ['Brain'] : [], record_ids: records } };
    } else if (ask.ids) {
      const shown = speakLastRecordIds(await latestAnswerEvidence(storage), data, store);
      ({ text, records } = shown);
      meta = { read_receipt: { kind: 'answer_ledger_read', at: new Date().toISOString(), record_ids: records } };
    } else {
      const found = searchOwnerMemory(data, store, ask.term);
      text = speakMemorySearch(ask.meta ? { ...found, meta: true } : found);
      records = found.read_receipt.record_ids;
      meta = { memory_search: found, read_receipt: found.read_receipt };
    }
  } catch (error) {
    text = 'I couldn\'t read my memory stores just now, sir, so I have no records to show and I won\'t guess at any. Nothing was changed. Ask me again in a minute.';
    meta = { ok: false, read_receipt: { kind: 'memory_store_read', at: new Date().toISOString(), error: String(error?.message || error).slice(0, 160), record_ids: [] } };
  }
  await recordAnswerEvidence(storage, text, { kind: records.length ? 'memory_search' : 'none', tools: ['memory_records', 'brain/search'] }, { records }).catch(() => null);
  // A miss with a store that could not be read is a failed read, not "no record".
  const failed = meta?.ok === false || (!records.length && (meta?.read_receipt?.stores_unreadable || []).length > 0);
  return { text, meta: { ...meta, records: records.length, record_ids: records, outcome: readOutcome({ failed, records }) } };
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

/** "Show a saved Brain record", "open my latest brain record", "show me a memory record about Sprite". Plural "records" is a search (ownerMemorySearchIntent). */
export function brainRecordIntent(message) {
  const t = stripWake(message).replace(/[?.!]+$/, '').replace(/\s+/g, ' ').trim();
  const m = /^(?:can you |could you |please )?(?:show|open|read|give|pull up|bring up)(?: me| up)? (?:a|one|the|my|your|any|the latest|the newest|the most recent|my latest|your latest|a recent)? ?(?:saved |stored |latest |newest |recent |random )?(?:brain|memory) (?:record|entry|note)(?: (?:about|on|for|with) (.{2,60}))?$/i.exec(t);
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
