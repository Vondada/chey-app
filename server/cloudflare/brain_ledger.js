// CHE Brain Population Ledger (owner, 2026-10-22): what entered CHE's brain, when, in which category, from where, what
// it became, and whether it is usable yet. Category first; time is metadata on every item.
//
// The ledger is append-only and lives beside the Brain in the Durable Object's SQLite (one row per event, so no single
// value approaches the 128 KB limit). It is written at the choke points every persistent knowledge write goes through:
//   - CheBrainStore.write            every Brain record (memories, conversations, references, lessons, projects, ...)
//   - KnowledgeLibrary catalog/index  sources discovered / indexed / failed (NOT READ → INDEXED → INDEXED + USED)
//   - KnowledgeItems.put              capability-engine layers (source, indexed, procedure, capability, experience, project)
//   - storage.put (installBrainLedger) owner memories in `che`, the capability registry, learned workflows,
//                                      trading evidence (closed trades, evidence runs, backtest matrix)
// No silent population: a test enumerates these paths and checks each one leaves a ledger record.
//
// Privacy: titles and summaries pass Security Intelligence's scanner (looksSecret); anything credential-shaped is
// replaced by a safe label. A removal keeps metadata only and scrubs the item's earlier ledger text.
import { looksSecret } from './security_intelligence.js';
import { SYSTEM_WORKFLOWS } from './workflow_engine.js';
import { USABLE } from './capability_registry.js';

export const LEDGER_VERSION = 1;
const KV_PREFIX = 'brain_ledger_kv:';
const KV_CAP = 400;
const MAX_ROWS = 60_000;
export const DEFAULT_ZONE = 'America/Chicago';

/** The category tree. Primary navigation is by category; every event carries one category and one subcategory. */
export const CATEGORIES = Object.freeze({
  'Music': ['Mixing', 'Mastering', 'Beat Making', 'Songwriting', 'Music Business', 'Rights', 'Releases'],
  'Trading': ['EMA', 'ORB', 'Liquidity', 'RSI', 'VWAP', 'Inside Bar', 'ICT', 'Historical Research', 'Paper Learning', 'Risk', 'Markets'],
  'Coding': ['CHE Code', 'Repositories', 'REA', 'Engineering'],
  'Legal': ['Contracts', 'Copyright', 'Regulation', 'Jurisdictions'],
  'Health': ['Symptoms', 'Medications', 'Labs', 'Fitness'],
  // The last five are the Security Core's Brain categories (security_core/brain.js, mapped in security_core_che.js).
  'Security': ['Malware', 'Authentication', 'Repository Security', 'Threat Detection', 'Secrets', 'Incidents', 'Policies', 'Access', 'Devices', 'Simulations'],
  'Business': ['Clients', 'Finance', 'Marketing', 'Opportunities'],
  'Create': ['Rendering', 'Templates', 'Writing', 'Media'],
  'Video': ['Rendering', 'Editing', 'YouTube'],
  'Images': ['Generation', 'Editing'],
  'Workflows': ['Learned', 'Commands', 'Skills'],
  'Projects': ['Decisions', 'Tasks', 'Assets'],
  'Owner Preferences': ['Music', 'Trading', 'Personal', 'General'],
  'Agents': ['Office', 'CHE', 'Outside AIs'],
  'General Knowledge': ['Conversations', 'Library', 'Research', 'Audits', 'Experiments'],
});
const CATEGORY_NAMES = Object.keys(CATEGORIES);

/** Knowledge-state progression, plus the side states. */
export const STATES = Object.freeze(['PENDING', 'DISCOVERED', 'INDEXED', 'UNDERSTOOD', 'PROCEDURE', 'IMPLEMENTED', 'TESTED', 'VERIFIED', 'AVAILABLE', 'DEGRADED', 'RETIRED', 'REJECTED', 'FAILED', 'REMOVED', 'CORRECTED']);
export const PROGRESSION = Object.freeze(['DISCOVERED', 'INDEXED', 'UNDERSTOOD', 'PROCEDURE', 'IMPLEMENTED', 'TESTED', 'VERIFIED', 'AVAILABLE']);

export const EVENT_TYPES = Object.freeze([
  'SOURCE_DISCOVERED', 'SOURCE_INDEXED', 'SOURCE_FAILED', 'SOURCE_USED', 'KNOWLEDGE_EXTRACTED', 'KNOWLEDGE_SAVED', 'KNOWLEDGE_UPDATED',
  'PROCEDURE_CREATED', 'CAPABILITY_TESTED', 'CAPABILITY_VERIFIED', 'CAPABILITY_STATE', 'OWNER_PREFERENCE_SAVED', 'OWNER_MEMORY_SAVED',
  'PROJECT_KNOWLEDGE_UPDATED', 'EVIDENCE_UPDATED', 'EVIDENCE_STRENGTHENED', 'CORRECTION', 'REMOVED', 'SCOPE_CHANGED', 'PENDING',
  'REJECTED', 'WORKFLOW_PROMOTED', 'CONVERSATION_REMEMBERED', 'BATCH_RECEIPT',
]);

/** Library ingestion status, as the Knowledge Library shows it. */
export const INGESTION = Object.freeze(['NOT READ', 'PROCESSING', 'INDEXED', 'PARTIALLY INDEXED', 'FAILED', 'INDEXED + USED', 'ARCHIVED']);
export const SOURCE_TYPES = Object.freeze(['OWNER', 'CONVERSATION', 'PROJECT', 'FILE', 'BOOK', 'ARTICLE', 'VIDEO', 'WEBSITE', 'OFFICIAL DOCUMENTATION', 'GITHUB', 'AGENT RESULT', 'EXPERIMENT', 'BACKTEST', 'PAPER TRADE', 'TOOL RESULT', 'SYSTEM EVENT']);

// Words → (category, subcategory). First match wins; a write path's own hint is tried before these.
const RULES = [
  ['Security', 'Malware', /\b(malware|virus|trojan|ransomware|quarantin)/i],
  ['Security', 'Authentication', /\b(face id|passkey|mfa|2fa|biometric|authenticat|session)/i],
  ['Security', 'Repository Security', /\b(dependency|supply.chain|advisor(y|ies)|repository security|license review)/i],
  ['Security', 'Secrets', /\b(secret|credential|api key|token leak)/i],
  ['Security', 'Threat Detection', /\b(threat|intrusion|anomal|incident|security)/i],
  ['Trading', 'EMA', /\bema\b|moving average/i],
  ['Trading', 'ORB', /\b(orb|opening range)/i],
  ['Trading', 'Liquidity', /\b(liquidity|sweep|order block|fair value gap|fvg)/i],
  ['Trading', 'RSI', /\brsi\b/i],
  ['Trading', 'VWAP', /\bvwap\b/i],
  ['Trading', 'Inside Bar', /\binside bar/i],
  ['Trading', 'ICT', /\b(ict|ote|silver bullet)\b/i],
  ['Trading', 'Historical Research', /\b(backtest|walk.forward|historical)/i],
  ['Trading', 'Paper Learning', /\b(paper trade|paper journal|forward sim)/i],
  ['Trading', 'Markets', /\b(trading|stock|futures|mnq|\bnq\b|es\b|nasdaq|portfolio|strategy)/i],
  ['Music', 'Mixing', /\b(mix|mixing|eq|compression|reverb)/i],
  ['Music', 'Mastering', /\bmaster(ing)?\b|loudness|lufs/i],
  ['Music', 'Beat Making', /\b(beat|808|drum|tempo|bpm|melod)/i],
  ['Music', 'Rights', /\b(royalt|publishing|copyright split|split sheet|isrc)/i],
  ['Music', 'Music Business', /\b(label|distribution|release|artist|music business)/i],
  ['Music', 'Songwriting', /\b(song|lyric|album|ep\b|track)/i],
  ['Legal', 'Contracts', /\b(contract|agreement|clause)/i],
  ['Legal', 'Copyright', /\b(copyright|trademark|fair use)/i],
  ['Legal', 'Regulation', /\b(law|legal|statute|regulation|license)\b/i],
  ['Health', 'Medications', /\b(medication|dose|drug|prescription)/i],
  ['Health', 'Labs', /\b(lab result|cholesterol|a1c|blood test)/i],
  ['Health', 'Symptoms', /\b(symptom|pain|doctor|health|injur)/i],
  ['Video', 'Rendering', /\b(render|h\.?264|mp4|ffmpeg|encod)/i],
  ['Video', 'YouTube', /\byoutube\b/i],
  ['Video', 'Editing', /\b(video|timeline|caption|transition)/i],
  ['Images', 'Generation', /\b(image|picture|thumbnail|photo|scene)/i],
  ['Coding', 'REA', /\brea\b|reverse.engineer/i],
  ['Coding', 'CHE Code', /\b(code|pull request|repository|bug|deploy|worker\.js|flutter)/i],
  ['Business', 'Clients', /\b(client|customer)/i],
  ['Business', 'Finance', /\b(revenue|invoice|budget|pricing|finance)/i],
  ['Business', 'Marketing', /\b(marketing|ads|campaign|seo)/i],
  ['Workflows', 'Learned', /\bworkflow/i],
];

/** Brain regions (brain_store.js) → categories. */
const REGION_CATEGORY = {
  'Conversations and Corrections': ['General Knowledge', 'Conversations'],
  'Personal Memory': ['Owner Preferences', 'Personal'],
  'Learned Knowledge': ['General Knowledge', 'Library'],
  'Coding and Development': ['Coding', 'CHE Code'],
  'Trading and Market Research': ['Trading', 'Markets'],
  'YouTube and Media': ['Video', 'YouTube'],
  'Business and Finance': ['Business', 'Finance'],
  'REA Investigations': ['Coding', 'REA'],
  'Office Agents': ['Agents', 'Office'],
  'Skills and Tools': ['Workflows', 'Skills'],
  'Experiments and Lessons': ['General Knowledge', 'Experiments'],
  'CHE Self-Knowledge': ['Agents', 'CHE'],
  'Problems and Opportunities': ['Business', 'Opportunities'],
  'Projects and Proposals': ['Projects', 'Decisions'],
  'Daily Audits and Conclusions': ['General Knowledge', 'Audits'],
  'Active and Historical Tasks': ['Projects', 'Tasks'],
};
const DOMAIN_CATEGORY = { data: ['Coding', 'Engineering'], video: ['Video', 'Rendering'], rendering: ['Create', 'Rendering'], security: ['Security', 'Threat Detection'], music: ['Music', 'Songwriting'], writing: ['Create', 'Writing'], trading: ['Trading', 'Markets'], legal: ['Legal', 'Regulation'], health: ['Health', 'Symptoms'] };

/**
 * One deterministic category for a write. Order: an explicit known category, the region/domain of the write path,
 * then the words. Regions that are generic (conversations, library) still let the words refine the topic.
 */
export function categorize(text = '', { category = '', subcategory = '', region = '', domain = '' } = {}) {
  if (CATEGORY_NAMES.includes(category)) return [category, CATEGORIES[category].includes(subcategory) ? subcategory : (subcategory || CATEGORIES[category][0])];
  const generic = ['Conversations and Corrections', 'Learned Knowledge', 'Experiments and Lessons', 'Daily Audits and Conclusions'];
  if (region && REGION_CATEGORY[region] && !generic.includes(region)) return REGION_CATEGORY[region];
  if (domain && DOMAIN_CATEGORY[domain]) return DOMAIN_CATEGORY[domain];
  for (const [cat, sub, re] of RULES) if (re.test(String(text))) return [cat, sub];
  return REGION_CATEGORY[region] || ['General Knowledge', 'Research'];
}

/** The Workflow Engine workflows that use a category's knowledge. */
const CATEGORY_WORKFLOWS = {
  'Trading': ['trading_desk'], 'Music': ['music_business'], 'Legal': ['legal_check'], 'Health': ['expert_brief'],
  'Security': ['self_review', 'safety_gate'], 'Coding': ['coding_job', 'rea_investigation'], 'Create': ['media_create'],
  'Video': ['media_create'], 'Images': ['media_create'], 'Workflows': ['command_run'], 'Business': ['office_delegation'],
  'Projects': ['command_run'], 'Owner Preferences': ['memory_recall'], 'Agents': ['office_delegation'], 'General Knowledge': ['knowledge_answer', 'memory_recall'],
};
export function workflowsFor(category) {
  return (CATEGORY_WORKFLOWS[category] || []).map((id) => SYSTEM_WORKFLOWS.find((w) => w.id === id)).filter(Boolean).map((w) => ({ id: w.id, name: w.name }));
}

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Safe display text: anything credential-shaped never enters the ledger. */
export function safeText(value, n = 200, fallback = '') {
  const text = clip(value, n * 2);
  if (!text) return fallback;
  if (looksSecret(text, { broad: true })) return fallback || 'Sensitive detail withheld';
  return clip(text, n);
}

function newId() {
  try { return `be_${crypto.randomUUID()}`; } catch (_) { return `be_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }
}

/** Normalizes one event. Optional fields stay empty rather than invented. */
export function ledgerEvent(input = {}, now = new Date()) {
  const at = input.at ? new Date(input.at) : now;
  const iso = Number.isFinite(at.getTime()) ? at.toISOString() : now.toISOString();
  const [category, subcategory] = categorize(`${input.title || ''} ${input.summary || ''}`, input);
  const type = EVENT_TYPES.includes(input.event_type) ? input.event_type : 'KNOWLEDGE_SAVED';
  const safeLabel = `${category} item`;
  return {
    brain_event_id: input.brain_event_id || newId(),
    timestamp: iso,
    ms: Date.parse(iso),
    category, subcategory,
    event_type: type,
    knowledge_type: clip(input.knowledge_type || 'knowledge', 30),
    title: safeText(input.title, 160, safeLabel),
    summary: safeText(input.summary, 300, ''),
    source_type: SOURCE_TYPES.includes(input.source_type) ? input.source_type : 'SYSTEM EVENT',
    source_reference: safeText(input.source_reference, 200, ''),
    project_id: clip(input.project_id, 80),
    workflow_id: clip(input.workflow_id, 80),
    agent: clip(input.agent, 60),
    knowledge_scope: clip(input.knowledge_scope || 'owner-global', 40),
    confidence: clip(input.confidence, 40),
    freshness: clip(input.freshness, 60),
    previous_state: STATES.includes(input.previous_state) ? input.previous_state : '',
    new_state: STATES.includes(input.new_state) ? input.new_state : '',
    capability_id: clip(input.capability_id, 80),
    record_id: clip(input.record_id, 160),
    reason_saved: safeText(input.reason_saved, 200, ''),
    verification_status: clip(input.verification_status, 40),
    batch_id: clip(input.batch_id, 80),
    detail: input.detail && typeof input.detail === 'object' ? input.detail : null,
  };
}

const COLUMNS = ['brain_event_id', 'timestamp', 'ms', 'category', 'subcategory', 'event_type', 'knowledge_type', 'title', 'summary', 'source_type', 'source_reference', 'project_id', 'workflow_id', 'agent', 'knowledge_scope', 'confidence', 'freshness', 'previous_state', 'new_state', 'capability_id', 'record_id', 'reason_saved', 'verification_status', 'batch_id', 'detail'];

function fromRow(r) {
  if (!r) return null;
  let detail = null;
  try { detail = r.detail ? JSON.parse(r.detail) : null; } catch (_) { detail = null; }
  return { ...r, ms: Number(r.ms), detail };
}

/** The ledger over the Durable Object's SQLite; a small per-category key-value fallback where SQL is absent. */
export class BrainLedger {
  constructor(storage) {
    this.storage = storage && typeof storage === 'object' ? storage : null;
    this.sql = this.storage?.sql || null;
    this.ready = false;
  }

  init() {
    if (this.ready) return true;
    if (this.sql) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS brain_ledger (${COLUMNS.map((c) => `${c} ${c === 'ms' ? 'INTEGER' : 'TEXT'}${c === 'brain_event_id' ? ' PRIMARY KEY' : ''}`).join(', ')})`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS brain_ledger_cat ON brain_ledger (category, ms)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS brain_ledger_ms ON brain_ledger (ms)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS brain_ledger_rec ON brain_ledger (record_id)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS brain_ledger_batch ON brain_ledger (batch_id)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS brain_ledger_meta (key TEXT PRIMARY KEY, value TEXT)');
    }
    this.ready = true;
    return true;
  }

  rows(q, ...p) { return [...this.sql.exec(q, ...p)].map(fromRow); }

  meta(key, fallback = null) {
    if (!this.sql) return fallback;
    this.init();
    const r = [...this.sql.exec('SELECT value FROM brain_ledger_meta WHERE key = ?', key)][0];
    if (!r) return fallback;
    try { return JSON.parse(r.value); } catch (_) { return fallback; }
  }

  setMeta(key, value) {
    if (!this.sql) return;
    this.init();
    this.sql.exec('INSERT INTO brain_ledger_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  /** Appends one event. Synchronous with SQL; returns a promise only on the key-value fallback. */
  record(input, now = new Date()) {
    const e = ledgerEvent(input, now);
    if (this.sql) {
      this.init();
      this.sql.exec(`INSERT OR REPLACE INTO brain_ledger (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
        ...COLUMNS.map((c) => (c === 'detail' ? (e.detail ? JSON.stringify(e.detail) : '') : c === 'ms' ? e.ms : e[c] ?? '')));
      const n = Number(this.meta('count', 0)) + 1;
      this.setMeta('count', n);
      if (n > MAX_ROWS) {
        this.sql.exec('DELETE FROM brain_ledger WHERE brain_event_id IN (SELECT brain_event_id FROM brain_ledger ORDER BY ms ASC LIMIT ?)', n - MAX_ROWS);
        this.setMeta('count', MAX_ROWS);
      }
      return e;
    }
    if (!this.storage?.get) return e;
    return (async () => {
      const key = `${KV_PREFIX}${e.category}`;
      const list = (await this.storage.get(key)) || [];
      list.unshift(e);
      await this.storage.__ledgerRawPut?.(key, list.slice(0, KV_CAP)) ?? this.storage.put(key, list.slice(0, KV_CAP));
      return e;
    })();
  }

  /** All events (key-value fallback only reads what it keeps). */
  async all() {
    if (this.sql) { this.init(); return this.rows('SELECT * FROM brain_ledger ORDER BY ms DESC, rowid DESC'); }
    const out = [];
    for (const c of CATEGORY_NAMES) out.push(...((await this.storage?.get?.(`${KV_PREFIX}${c}`)) || []));
    return out.sort((a, b) => b.ms - a.ms);
  }

  async query({ category = '', subcategory = '', since = 0, record_id = '', batch_id = '', limit = 100, text = '', types = null } = {}) {
    let list;
    if (this.sql) {
      this.init();
      const where = ['1=1'];
      const params = [];
      if (category) { where.push('category = ?'); params.push(category); }
      if (subcategory) { where.push('subcategory = ?'); params.push(subcategory); }
      if (since) { where.push('ms >= ?'); params.push(since); }
      if (record_id) { where.push('record_id = ?'); params.push(record_id); }
      if (batch_id) { where.push('batch_id = ?'); params.push(batch_id); }
      if (types?.length) { where.push(`event_type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
      if (text) { where.push('(title LIKE ? OR summary LIKE ? OR subcategory LIKE ? OR category LIKE ? OR source_reference LIKE ?)'); const t = `%${text}%`; params.push(t, t, t, t, t); }
      list = this.rows(`SELECT * FROM brain_ledger WHERE ${where.join(' AND ')} ORDER BY ms DESC, rowid DESC LIMIT ?`, ...params, Math.max(1, Math.min(Number(limit) || 100, 2000)));
    } else {
      list = (await this.all()).filter((e) => (!category || e.category === category) && (!subcategory || e.subcategory === subcategory) && (!since || e.ms >= since)
        && (!record_id || e.record_id === record_id) && (!batch_id || e.batch_id === batch_id) && (!types?.length || types.includes(e.event_type))
        && (!text || `${e.title} ${e.summary} ${e.subcategory} ${e.category} ${e.source_reference}`.toLowerCase().includes(text.toLowerCase()))).slice(0, limit);
    }
    return list;
  }

  /** Removal: metadata only. Earlier ledger text about the item is scrubbed, so deleted content is not preserved. */
  async scrub(record_id, now = new Date()) {
    if (!record_id) return 0;
    if (this.sql) {
      this.init();
      const n = this.rows('SELECT brain_event_id FROM brain_ledger WHERE record_id = ?', record_id).length;
      this.sql.exec("UPDATE brain_ledger SET title = 'Removed item', summary = '', source_reference = '', detail = '' WHERE record_id = ?", record_id);
      return n;
    }
    let n = 0;
    for (const c of CATEGORY_NAMES) {
      const key = `${KV_PREFIX}${c}`;
      const list = (await this.storage?.get?.(key)) || [];
      let changed = false;
      for (const e of list) if (e.record_id === record_id) { e.title = 'Removed item'; e.summary = ''; e.source_reference = ''; e.detail = null; changed = true; n++; }
      if (changed) await (this.storage.__ledgerRawPut?.(key, list) ?? this.storage.put(key, list));
    }
    return n;
  }
}

// ─── Views ──────────────────────────────────────────────────────────────────

const PROCEDURE_TYPES = new Set(['procedure']);
const CAP_STATES = new Set(['VERIFIED', 'AVAILABLE']);

/** Category cards: item, procedure and verified-capability counts, and the last population time. */
export async function categoryCards(storage, { zone = DEFAULT_ZONE, now = Date.now() } = {}) {
  const ledger = new BrainLedger(storage);
  const all = await ledger.all();
  const cards = {};
  for (const c of CATEGORY_NAMES) cards[c] = { category: c, items: new Set(), procedures: new Set(), capabilities: new Set(), last_ms: 0, pending: 0, failed: 0, subcategories: {} };
  const latestByItem = new Map();
  for (const e of all) {
    const card = cards[e.category];
    if (!card) continue;
    const key = e.record_id || e.capability_id || e.brain_event_id;
    if (!latestByItem.has(`${e.category}|${key}`)) latestByItem.set(`${e.category}|${key}`, e);
    if (e.event_type === 'BATCH_RECEIPT') continue;
    card.last_ms = Math.max(card.last_ms, e.ms);
    card.subcategories[e.subcategory] = (card.subcategories[e.subcategory] || 0) + 1;
  }
  for (const [k, e] of latestByItem) {
    const card = cards[e.category];
    if (e.event_type === 'REMOVED' || e.event_type === 'BATCH_RECEIPT') continue;
    if (e.new_state === 'PENDING' || e.event_type === 'PENDING') { card.pending++; continue; }
    if (e.new_state === 'FAILED' || e.event_type === 'SOURCE_FAILED') { card.failed++; continue; }
    if (e.knowledge_type === 'capability') { if (CAP_STATES.has(e.new_state)) card.capabilities.add(k); continue; }
    if (PROCEDURE_TYPES.has(e.knowledge_type)) card.procedures.add(k);
    else card.items.add(k);
  }
  return CATEGORY_NAMES.map((c) => {
    const card = cards[c];
    return {
      category: c, items: card.items.size, procedures: card.procedures.size, capabilities: card.capabilities.size, pending: card.pending, failed: card.failed,
      last_populated: card.last_ms ? new Date(card.last_ms).toISOString() : null,
      last_populated_label: card.last_ms ? displayTime(card.last_ms, zone, now) : 'Nothing yet',
      subcategories: Object.entries(card.subcategories).sort((a, b) => b[1] - a[1]).map(([name, events]) => ({ name, events })),
    };
  }).sort((a, b) => (b.last_populated || '').localeCompare(a.last_populated || ''));
}

/** "Today · 4:31 PM", "Yesterday · 9:05 AM", "Oct 20 · 2:14 PM" in the owner's zone. */
export function displayTime(ms, zone = DEFAULT_ZONE, now = Date.now()) {
  const fmt = (d, o) => new Intl.DateTimeFormat('en-US', { timeZone: zone, ...o }).format(d);
  const day = (d) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const d = new Date(ms);
  const time = fmt(d, { hour: 'numeric', minute: '2-digit' });
  if (day(d) === day(new Date(now))) return `Today · ${time}`;
  if (day(d) === day(new Date(now - 86_400_000))) return `Yesterday · ${time}`;
  return `${fmt(d, { month: 'short', day: 'numeric' })} · ${time}`;
}

/** "October 22, 2026 · 4:31:18 PM Central" */
export function fullTime(ms, zone = DEFAULT_ZONE) {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(d);
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || zone;
  return `${date} · ${time} ${tz.replace(/ (Standard|Daylight) Time$/, '')}`;
}

/** A category's events, newest first; a batch shows as one grouped entry whose records stay reachable. */
export async function categoryView(storage, category, { subcategory = '', limit = 60, zone = DEFAULT_ZONE, now = Date.now() } = {}) {
  const ledger = new BrainLedger(storage);
  const events = await ledger.query({ category, subcategory, limit: 2000 });
  const out = [];
  const batches = new Map();
  for (const e of events) {
    if (e.batch_id) {
      if (!batches.has(e.batch_id)) {
        const entry = { kind: 'batch', batch_id: e.batch_id, items: 0, groups: {}, receipt: null, ms: e.ms };
        batches.set(e.batch_id, entry);
        out.push(entry);
      }
      const b = batches.get(e.batch_id);
      if (e.event_type === 'BATCH_RECEIPT') { b.receipt = view(e, zone, now); continue; }
      b.items++;
      b.groups[e.subcategory] = (b.groups[e.subcategory] || 0) + 1;
      continue;
    }
    out.push({ kind: 'event', ...view(e, zone, now) });
  }
  return out.slice(0, limit).map((x) => (x.kind === 'batch' ? { ...x, title: x.receipt?.title || `${category} batch`, time: x.receipt?.time || displayTime(x.ms, zone, now), groups: Object.entries(x.groups).map(([name, count]) => ({ name, count })) } : x));
}

/** One event as the phone shows it; VoiceOver reads `spoken`. */
export function view(e, zone = DEFAULT_ZONE, now = Date.now()) {
  const time = displayTime(e.ms, zone, now);
  const status = statusWord(e);
  return {
    ...e, time, full_time: fullTime(e.ms, zone), status,
    spoken: `${e.category}. ${e.title}. ${eventWords(e)} at ${time.replace(/^Today · /, '').replace(' · ', ' at ')}. ${sourceWords(e.source_type)}. ${status}.`,
  };
}

const EVENT_WORDS = {
  SOURCE_DISCOVERED: 'Source discovered', SOURCE_INDEXED: 'Source indexed', SOURCE_FAILED: 'Indexing failed', SOURCE_USED: 'Source used',
  KNOWLEDGE_EXTRACTED: 'Knowledge extracted', KNOWLEDGE_SAVED: 'Knowledge saved', KNOWLEDGE_UPDATED: 'Knowledge updated', PROCEDURE_CREATED: 'Procedure created',
  CAPABILITY_TESTED: 'Capability tested', CAPABILITY_VERIFIED: 'Capability verified', CAPABILITY_STATE: 'Capability state changed',
  OWNER_PREFERENCE_SAVED: 'Owner preference saved', OWNER_MEMORY_SAVED: 'Owner memory saved', PROJECT_KNOWLEDGE_UPDATED: 'Project knowledge updated',
  EVIDENCE_UPDATED: 'Evidence updated', EVIDENCE_STRENGTHENED: 'Evidence strengthened', CORRECTION: 'Corrected', REMOVED: 'Removed', SCOPE_CHANGED: 'Scope changed',
  PENDING: 'Pending', REJECTED: 'Not retained', WORKFLOW_PROMOTED: 'Workflow promoted', CONVERSATION_REMEMBERED: 'Conversation remembered', BATCH_RECEIPT: 'Batch completed',
};
export const eventWords = (e) => EVENT_WORDS[e.event_type] || 'Updated';
const sourceWords = (s) => ({ OWNER: 'From you', CONVERSATION: 'From conversation', 'PAPER TRADE': 'Paper trade', BACKTEST: 'Backtest', 'SYSTEM EVENT': 'System event' }[s] || String(s || '').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()));

/** Is this information, knowledge, a procedure or a real capability? */
export function statusWord(e) {
  if (e.event_type === 'REMOVED') return 'Removed';
  if (e.event_type === 'REJECTED') return 'Not retained';
  if (e.new_state === 'PENDING' || e.event_type === 'PENDING') return 'Pending';
  if (e.new_state === 'FAILED' || e.event_type === 'SOURCE_FAILED') return 'Failed';
  if (e.knowledge_type === 'capability') return CAP_STATES.has(e.new_state) ? 'Verified capability' : `Capability ${String(e.new_state || 'candidate').toLowerCase()}, not available`;
  if (e.knowledge_type === 'procedure') return 'Procedure';
  if (e.knowledge_type === 'source') return e.new_state === 'INDEXED' ? 'Indexed information' : 'Information';
  if (e.verification_status === 'verified' || e.new_state === 'VERIFIED') return 'Verified';
  return 'Knowledge';
}

/** One event with its full history (state progression), batch members, capability and workflow links. */
export async function eventDetail(storage, id, { zone = DEFAULT_ZONE, now = Date.now(), registry = null } = {}) {
  const ledger = new BrainLedger(storage);
  const all = ledger.sql ? (ledger.init(), ledger.rows('SELECT * FROM brain_ledger WHERE brain_event_id = ?', id)) : (await ledger.all()).filter((e) => e.brain_event_id === id);
  const e = all[0];
  if (!e) return null;
  const history = e.record_id ? (await ledger.query({ record_id: e.record_id, limit: 200 })).reverse().map((h) => ({ time: displayTime(h.ms, zone, now), full_time: fullTime(h.ms, zone), event: eventWords(h), state: h.new_state || '', previous_state: h.previous_state || '' })) : [];
  const members = e.batch_id ? (await ledger.query({ batch_id: e.batch_id, limit: 2000 })).filter((m) => m.event_type !== 'BATCH_RECEIPT').map((m) => view(m, zone, now)) : [];
  const cap = e.capability_id && registry?.capabilities?.[e.capability_id];
  return {
    ...view(e, zone, now), history, batch_members: members,
    capability: cap ? { id: cap.capability_id, name: cap.name, status: cap.status, usable: USABLE.has(cap.status), last_verified: cap.last_verified || null } : null,
    used_by: workflowsFor(e.category),
  };
}

// ─── Questions the owner asks ───────────────────────────────────────────────

const CAT_WORD = new Map([
  ...CATEGORY_NAMES.map((c) => [c.toLowerCase(), c]),
  ['coding', 'Coding'], ['code', 'Coding'], ['trading', 'Trading'], ['trade', 'Trading'], ['music', 'Music'], ['security', 'Security'], ['legal', 'Legal'], ['law', 'Legal'],
  ['health', 'Health'], ['business', 'Business'], ['video', 'Video'], ['videos', 'Video'], ['images', 'Images'], ['image', 'Images'], ['create', 'Create'],
  ['workflows', 'Workflows'], ['projects', 'Projects'], ['preferences', 'Owner Preferences'], ['agents', 'Agents'], ['general', 'General Knowledge'],
]);

/** The owner's questions about what entered the Brain. Deterministic. */
export function ledgerIntent(message = '') {
  const t = String(message || '').trim().toLowerCase().replace(/[’]/g, "'").replace(/^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chay|chey|shay)\b[\s,.:;!?-]*/, '').replace(/[?.!]+$/, '').trim();
  let m;
  if (/\b(?:how many|counts?|inventory|totals?)\b/.test(t) && /\b(?:your|you|brain|knowledge|library)\b/.test(t)
    && /\b(?:indexed|understood|verified|sources?|knowledge|capabilities|brain|library)\b/.test(t)) return { kind: 'inventory' };
  if (/^(?:show me )?what (?:entered|populated|went into) your brain(?: today)?$|^what populated your brain today$|^what did you learn today$|^show me what entered your brain$/.test(t)) return { kind: 'today' };
  if ((m = /^what (?:entered|populated) your ([a-z ]+?) brain$/.exec(t)) && CAT_WORD.has(m[1].trim())) return { kind: 'category', category: CAT_WORD.get(m[1].trim()) };
  if ((m = /^what did you learn (?:about|in) ([a-z ]+?)$/.exec(t)) && CAT_WORD.has(m[1].trim())) return { kind: 'category', category: CAT_WORD.get(m[1].trim()) };
  // "What did you learn about <topic>" for anything but a category stays with the Capability Engine (layer-aware).
  if ((m = /^what (?:entered|went into) your brain about (.{2,80})$/.exec(t))) return { kind: 'search', text: m[1] };
  if ((m = /^what did you learn from (?:that|the|my) (book|article|video|document|source|file)(?: (.{2,80}))?$/.exec(t))) return { kind: 'from_source', source: m[1], title: m[2] || '' };
  if (/^(?:show me )?(?:everything )?what did you learn from (?:my|this|the) (?:last )?project$|^show me everything you learned from (?:this|my last) project$/.test(t)) return { kind: 'project' };
  if (/^what knowledge is (?:still )?pending$|^what is still pending in your brain$/.test(t)) return { kind: 'pending' };
  if (/^what failed to index$|^what did not index$/.test(t)) return { kind: 'failed' };
  if (/^when did you learn (?:this|that|it)$/.test(t)) return { kind: 'when' };
  if (/^(?:where did you learn (?:this|that|it)|where did (?:this|that) fact come from|why do you know (?:this|that))$/.test(t)) return { kind: 'where' };
  if ((m = /^when did you learn (?:about )?(.{2,80})$/.exec(t))) return { kind: 'when', text: m[1] };
  if ((m = /^do you know (?:how to |about |anything about )(.{2,80})$/.exec(t))) return { kind: 'know', text: m[1] };
  return null;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The spoken/visible answer for a ledger question, from the actual ledger (and the capability registry). Never guesses. */
export async function answerLedger(storage, ask, { zone = DEFAULT_ZONE, now = Date.now(), registry = null, lastSubject = null } = {}) {
  const ledger = new BrainLedger(storage);
  const line = (e) => `${displayTime(e.ms, zone, now)} · ${e.category}: ${e.title} (${eventWords(e).toLowerCase()}, ${statusWord(e).toLowerCase()})`;
  if (ask.kind === 'today') {
    const startOfDay = startOfDayMs(now, zone);
    const events = (await ledger.query({ since: startOfDay, limit: 500 })).filter((e) => e.event_type !== 'BATCH_RECEIPT');
    if (!events.length) return { text: 'Nothing entered my brain today, sir.', events: [] };
    const byCat = {};
    for (const e of events) byCat[e.category] = (byCat[e.category] || 0) + 1;
    const top = events.slice(0, 5);
    return { text: `Today ${plural(events.length, 'item')} entered my brain: ${Object.entries(byCat).map(([c, n]) => `${c} ${n}`).join(', ')}. Newest: ${top.map(line).join('; ')}.`, events: top };
  }
  if (ask.kind === 'category') {
    const events = (await ledger.query({ category: ask.category, limit: 200 })).filter((e) => e.event_type !== 'BATCH_RECEIPT');
    if (!events.length) return { text: `Nothing has entered my ${ask.category} brain yet, sir.`, events: [] };
    return { text: `My ${ask.category} brain has ${plural(events.length, 'recorded event')}. Newest: ${events.slice(0, 5).map(line).join('; ')}.`, events: events.slice(0, 5) };
  }
  if (ask.kind === 'search' || ask.kind === 'from_source') {
    const text = ask.kind === 'search' ? ask.text : ask.title || '';
    let events = text ? await ledger.query({ text, limit: 50 }) : await ledger.query({ limit: 200 });
    if (ask.kind === 'from_source') {
      const kinds = { book: ['BOOK'], article: ['ARTICLE'], video: ['VIDEO'], document: ['OFFICIAL DOCUMENTATION', 'FILE'], file: ['FILE'], source: null }[ask.source];
      const src = events.filter((e) => e.event_type.startsWith('SOURCE_') && (!kinds || kinds.includes(e.source_type)))[0];
      if (!src) return { text: `I have no record of a ${ask.source}${text ? ` called ${text}` : ''} entering my brain, sir.`, events: [] };
      const related = (await ledger.query({ record_id: src.record_id, limit: 50 }));
      const extracted = related.filter((e) => ['KNOWLEDGE_EXTRACTED', 'PROCEDURE_CREATED'].includes(e.event_type));
      return { text: `${src.title} entered my brain ${displayTime(src.ms, zone, now)} under ${src.category} → ${src.subcategory}. Status: ${statusWord(src)}. ${extracted.length ? `From it: ${extracted.map((e) => e.title).slice(0, 5).join('; ')}.` : 'No procedures or capabilities have come from it yet.'}`, events: [src, ...extracted] };
    }
    events = events.filter((e) => e.event_type !== 'BATCH_RECEIPT');
    if (!events.length) return { text: `I have nothing in my brain about ${text}, sir.`, events: [] };
    return { text: `About ${text}: ${events.slice(0, 5).map(line).join('; ')}.`, events: events.slice(0, 5) };
  }
  if (ask.kind === 'project') {
    const events = (await ledger.query({ limit: 500 })).filter((e) => e.project_id || e.category === 'Projects');
    if (!events.length) return { text: 'Nothing from a project has entered my brain yet, sir.', events: [] };
    const pid = events[0].project_id;
    const mine = pid ? events.filter((e) => e.project_id === pid) : events;
    return { text: `From your latest project: ${mine.slice(0, 6).map(line).join('; ')}.`, events: mine.slice(0, 6) };
  }
  if (ask.kind === 'pending' || ask.kind === 'failed') {
    const cards = await categoryCards(storage, { zone, now });
    const all = await ledger.query({ limit: 2000 });
    const latest = new Map();
    for (const e of all) { const k = e.record_id || e.brain_event_id; if (!latest.has(k)) latest.set(k, e); }
    const want = [...latest.values()].filter((e) => (ask.kind === 'pending' ? e.new_state === 'PENDING' || e.event_type === 'PENDING' : e.new_state === 'FAILED' || e.event_type === 'SOURCE_FAILED'));
    if (!want.length) return { text: ask.kind === 'pending' ? 'Nothing is pending, sir: everything selected has been committed or set aside.' : 'Nothing has failed to index, sir.', events: [], cards };
    const verb = ask.kind === 'pending' ? `${want.length === 1 ? 'is' : 'are'} still pending, not yet learned` : 'failed to index';
    return { text: `${plural(want.length, 'item')} ${verb}: ${want.slice(0, 6).map(line).join('; ')}.`, events: want.slice(0, 6) };
  }
  if (ask.kind === 'when' || ask.kind === 'where') {
    let e = null;
    if (ask.text) e = (await ledger.query({ text: ask.text, limit: 20 })).filter((x) => x.event_type !== 'BATCH_RECEIPT').pop() || null;
    else if (lastSubject) e = (await ledger.query({ text: lastSubject, limit: 20 })).filter((x) => x.event_type !== 'BATCH_RECEIPT').pop() || null;
    if (!e) return { text: `I have no ledger record for ${ask.text || 'that'}, sir, so I can't say when or where I learned it.`, events: [] };
    if (ask.kind === 'when') return { text: `${e.title} first entered my brain ${fullTime(e.ms, zone)}, under ${e.category} → ${e.subcategory}.`, events: [e] };
    return { text: `${e.title}: source ${sourceWords(e.source_type).toLowerCase()}${e.source_reference ? ` (${e.source_reference})` : ''}; saved because ${e.reason_saved || 'it was written to my brain by that path'}; ${statusWord(e).toLowerCase()}.`, events: [e] };
  }
  if (ask.kind === 'know') return knowAbout(storage, ask.text, { registry, zone, now });
  return { text: '', events: [] };
}

/** "Do you know X": information vs indexed knowledge vs procedure vs verified capability, from ledger + registry. */
export async function knowAbout(storage, text, { registry = null, zone = DEFAULT_ZONE, now = Date.now() } = {}) {
  const ledger = new BrainLedger(storage);
  const words = String(text || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const caps = Object.values(registry?.capabilities || {}).filter((c) => words.some((w) => `${c.name} ${c.description} ${c.capability_id}`.toLowerCase().includes(w)));
  const usable = caps.find((c) => USABLE.has(c.status));
  if (usable) return { level: 'capability', text: `Yes, sir: I have a verified capability, ${usable.name}${usable.last_verified ? `, verified ${displayTime(Date.parse(usable.last_verified), zone, now)}` : ''}.`, events: [] };
  let events = [];
  for (const w of words.slice(0, 4)) events.push(...await ledger.query({ text: w, limit: 30 }));
  events = events.filter((e) => e.event_type !== 'REMOVED' && e.event_type !== 'BATCH_RECEIPT');
  const procedure = events.find((e) => e.knowledge_type === 'procedure');
  const candidate = caps[0];
  if (procedure) return { level: 'procedure', text: `I have a procedure for it, sir (${procedure.title}, ${displayTime(procedure.ms, zone, now)}), but no verified capability${candidate ? `: ${candidate.name} is ${candidate.status.toLowerCase()}` : ''}.`, events: [procedure] };
  const indexed = events.find((e) => ['SOURCE_INDEXED', 'KNOWLEDGE_EXTRACTED', 'KNOWLEDGE_SAVED', 'KNOWLEDGE_UPDATED', 'OWNER_MEMORY_SAVED', 'OWNER_PREFERENCE_SAVED', 'EVIDENCE_UPDATED'].includes(e.event_type));
  if (indexed) return { level: 'knowledge', text: `I have indexed knowledge about it, sir (${indexed.title}, ${indexed.category} → ${indexed.subcategory}), not a procedure or a capability.`, events: [indexed] };
  const info = events.find((e) => e.event_type === 'SOURCE_DISCOVERED' || e.event_type === 'CONVERSATION_REMEMBERED');
  if (info) return { level: 'information', text: `I only have information about it, sir: ${info.title} (${eventWords(info).toLowerCase()}), not indexed knowledge.`, events: [info] };
  return { level: 'none', text: `I have nothing about ${text} in my brain, sir.`, events: [] };
}

function startOfDayMs(now, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const sinceMidnight = ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return now - sinceMidnight - (now % 1000);
}

// ─── Write-path hooks ───────────────────────────────────────────────────────

const VERIFY_TO_STATE = { verified_source: 'INDEXED', owner_attested: 'VERIFIED', verified: 'VERIFIED', unverified_reference: 'DISCOVERED', unknown: 'UNDERSTOOD' };

/** A Brain record write (CheBrainStore.write). previous is the stored record before the write, or null. */
export function fromBrainWrite(storage, previous, record, { deleted = false, origin = '', now } = {}) {
  if (!storage?.sql) return null;
  const ledger = new BrainLedger(storage);
  const at = now ? new Date(now) : new Date();
  const region = record.region || '';
  const [category, subcategory] = categorize(`${record.title || ''} ${record.path || ''} ${String(record.body || '').slice(0, 400)}`, { region });
  const base = {
    category, subcategory, record_id: record.id, source_type: sourceTypeOf(record, origin), source_reference: record.source?.source_url || record.source?.kind || '',
    knowledge_scope: record.source?.scope || (record.kind === 'project' ? 'project-only' : 'owner-global'), verification_status: record.verification || '',
    project_id: record.source?.project_id || '', agent: record.source?.agent || '',
  };
  if (deleted) {
    ledger.scrub(record.id, at);
    return ledger.record({ ...base, event_type: 'REMOVED', title: 'Removed item', summary: '', source_reference: '', reason_saved: origin === 'owner' ? 'Owner request' : 'Removed', previous_state: previous ? stateOf(previous) : '', new_state: 'REMOVED', knowledge_type: kindType(record) }, at);
  }
  const corrected = record.kind === 'correction' || /correct/i.test(String(record.source?.kind || '')) || Boolean(record.source?.corrects);
  let type;
  if (!previous || previous.deleted) type = corrected ? 'CORRECTION' : record.kind === 'conversation' ? 'CONVERSATION_REMEMBERED' : record.kind === 'memory' ? (/prefer|favorite|like|love|hate|always|never/i.test(record.body || '') ? 'OWNER_PREFERENCE_SAVED' : 'OWNER_MEMORY_SAVED') : record.kind === 'reference' ? 'SOURCE_DISCOVERED' : region === 'Projects and Proposals' ? 'PROJECT_KNOWLEDGE_UPDATED' : 'KNOWLEDGE_SAVED';
  else if (previous.hash && previous.hash === record.hash) type = 'EVIDENCE_STRENGTHENED';
  else if (corrected) type = 'CORRECTION';
  else if (previous.source?.active !== false && record.source?.active === false) type = 'CORRECTION';
  else type = region === 'Projects and Proposals' ? 'PROJECT_KNOWLEDGE_UPDATED' : 'KNOWLEDGE_UPDATED';
  // References are logged by the Knowledge Library itself, with their ingestion status.
  if (record.kind === 'reference' && record.source?.kind === 'knowledge_reference') return null;
  return ledger.record({
    ...base, event_type: type, knowledge_type: kindType(record), title: record.title, summary: String(record.body || '').slice(0, 240),
    previous_state: previous && !previous.deleted ? stateOf(previous) : '', new_state: stateOf(record), confidence: record.source?.confidence ?? '',
    reason_saved: reasonFor(record, type), detail: corrected && previous ? { original: safeText(previous.title, 120), corrected: safeText(record.title, 120) } : null,
  }, at);
}

const kindType = (r) => ({ memory: /prefer|favorite|like|love|always|never/i.test(r.body || '') ? 'preference' : 'knowledge', conversation: 'conversation', reference: 'source', lesson: 'knowledge', project: 'project', task: 'project', skill: 'procedure', procedure: 'procedure' }[r.kind] || 'knowledge');
const stateOf = (r) => VERIFY_TO_STATE[r.verification] || 'UNDERSTOOD';
function sourceTypeOf(r, origin) {
  if (r.kind === 'conversation') return 'CONVERSATION';
  if (r.kind === 'memory' && ['owner', 'owner_attested'].includes(r.verification === 'owner_attested' ? 'owner' : origin)) return 'OWNER';
  if (r.source?.kind === 'agent' || r.source?.agent) return 'AGENT RESULT';
  if (r.source?.kind === 'experiment') return 'EXPERIMENT';
  if (/github/i.test(r.source?.source_url || '')) return 'GITHUB';
  if (r.source?.source_url) return 'WEBSITE';
  return origin === 'owner' ? 'OWNER' : 'SYSTEM EVENT';
}
function reasonFor(r, type) {
  if (type === 'OWNER_PREFERENCE_SAVED') return 'You stated it';
  if (type === 'OWNER_MEMORY_SAVED') return r.verification === 'owner_attested' ? 'You asked me to remember it' : 'Recorded by CHE';
  if (type === 'CONVERSATION_REMEMBERED') return 'Kept from our conversation';
  if (type === 'EVIDENCE_STRENGTHENED') return 'The same knowledge arrived again';
  if (type === 'CORRECTION') return 'Corrected';
  return 'Written to my brain';
}

/** Knowledge Library ingestion status changes (catalog → NOT READ, index → INDEXED, failure → FAILED, use → INDEXED + USED). */
export function fromLibrary(storage, ref, status, { reason = '', now } = {}) {
  if (!storage?.sql || !ref) return null;
  const state = { 'NOT READ': 'DISCOVERED', PROCESSING: 'PENDING', INDEXED: 'INDEXED', 'PARTIALLY INDEXED': 'INDEXED', FAILED: 'FAILED', 'INDEXED + USED': 'INDEXED', ARCHIVED: 'RETIRED' }[status] || 'DISCOVERED';
  const type = { 'NOT READ': 'SOURCE_DISCOVERED', PROCESSING: 'PENDING', INDEXED: 'SOURCE_INDEXED', 'PARTIALLY INDEXED': 'SOURCE_INDEXED', FAILED: 'SOURCE_FAILED', 'INDEXED + USED': 'SOURCE_USED', ARCHIVED: 'REMOVED' }[status] || 'SOURCE_DISCOVERED';
  const kindSource = { book: 'BOOK', article: 'ARTICLE', video: 'VIDEO', documentation: 'OFFICIAL DOCUMENTATION', paper: 'ARTICLE', course: 'VIDEO', repository: 'GITHUB', note: 'FILE' }[ref.kind] || 'FILE';
  return new BrainLedger(storage).record({
    event_type: type, knowledge_type: 'source', title: ref.title, summary: `${status}${reason ? `: ${reason}` : ''}${ref.creator ? ` · ${ref.creator}` : ''}`,
    source_type: kindSource, source_reference: ref.source_url || ref.license || '', record_id: ref.key || ref.id, new_state: state,
    verification_status: status, reason_saved: status === 'FAILED' ? '' : 'Added to the Knowledge Library',
    category: '', region: '', domain: ref.category?.startsWith?.('expert_') ? ref.category.slice(7) : '', detail: { ingestion: status },
  }, now ? new Date(now) : new Date());
}

/** A capability-engine knowledge item write (KnowledgeItems.put). */
export function fromKnowledgeItem(storage, previous, item, { now } = {}) {
  if (!storage?.sql) return null;
  const layerType = { source: 'SOURCE_INDEXED', indexed: 'KNOWLEDGE_EXTRACTED', procedure: 'PROCEDURE_CREATED', capability: 'CAPABILITY_STATE', experience: 'EVIDENCE_UPDATED', project: 'PROJECT_KNOWLEDGE_UPDATED' };
  const layerState = { source: 'INDEXED', indexed: 'UNDERSTOOD', procedure: 'PROCEDURE', capability: 'IMPLEMENTED', experience: 'VERIFIED', project: 'UNDERSTOOD' };
  let type = layerType[item.layer] || 'KNOWLEDGE_SAVED';
  if (previous) {
    if (previous.body === item.body && previous.layer === item.layer && previous.status === item.status) type = 'EVIDENCE_STRENGTHENED';
    else if (previous.layer === item.layer && type !== 'PROCEDURE_CREATED') type = item.layer === 'project' ? 'PROJECT_KNOWLEDGE_UPDATED' : 'KNOWLEDGE_UPDATED';
  }
  const scope = item.scope || 'owner-global';
  const [category, subcategory] = item.project_id || scope === 'project-only' ? ['Projects', 'Decisions'] : categorize(`${item.title} ${item.body}`, { domain: item.domain });
  return new BrainLedger(storage).record({
    event_type: type, knowledge_type: item.layer === 'procedure' ? 'procedure' : item.layer === 'source' ? 'source' : item.layer === 'project' ? 'project' : 'knowledge',
    title: item.title, summary: String(item.body || '').slice(0, 240), category, subcategory, record_id: item.id, project_id: item.project_id || '',
    knowledge_scope: scope, confidence: item.confidence != null ? String(item.confidence) : '', source_type: item.provenance?.owner ? 'OWNER' : item.provenance?.source_url ? 'WEBSITE' : item.provenance?.trust === 'official' ? 'OFFICIAL DOCUMENTATION' : 'TOOL RESULT',
    source_reference: item.provenance?.source_url || item.provenance?.title || '', previous_state: previous ? layerState[previous.layer] || '' : '', new_state: layerState[item.layer] || 'UNDERSTOOD',
    reason_saved: type === 'EVIDENCE_STRENGTHENED' ? 'The same knowledge arrived again' : 'Extracted from a permitted source', verification_status: item.status || '',
  }, now ? new Date(now) : new Date());
}

// ─── Key-value write paths: one wrapper on storage.put ──────────────────────

const WATCHED = {
  che: diffOwnerMemories,
  'che:capabilities_v1': diffRegistry,
  'che:workflow_engine': diffWorkflowEngine,
  evidence_runs: diffEvidenceRuns,
  backtest_matrix: diffMatrix,
};
const SNAPSHOT = new WeakMap();

/**
 * Wraps storage.put so every write to a watched key is diffed against the last written value and its new knowledge
 * recorded, and every batch of closed trade records (evr:*) becomes a grouped trading batch. Idempotent.
 */
export function installBrainLedger(storage) {
  if (!storage || typeof storage.put !== 'function' || storage.__brainLedger) return storage;
  const rawPut = storage.put.bind(storage);
  Object.defineProperty(storage, '__brainLedger', { value: true });
  Object.defineProperty(storage, '__ledgerRawPut', { value: rawPut });
  storage.put = async function ledgeredPut(key, value, ...rest) {
    const result = await rawPut(key, value, ...rest);
    try {
      if (key && typeof key === 'object') {
        const trades = Object.entries(key).filter(([k]) => k.startsWith('evr:'));
        if (trades.length) await tradesBatch(storage, trades.map(([, v]) => v));
        for (const [k, v] of Object.entries(key)) if (WATCHED[k]) await diffKey(storage, k, v);
      } else if (typeof key === 'string' && WATCHED[key]) await diffKey(storage, key, value);
    } catch (_) { /* the ledger never breaks a write */ }
    return result;
  };
  return storage;
}

async function diffKey(storage, key, value) {
  let snaps = SNAPSHOT.get(storage);
  if (!snaps) { snaps = new Map(); SNAPSHOT.set(storage, snaps); }
  const ledger = new BrainLedger(storage);
  let prev = snaps.get(key);
  if (prev === undefined) prev = ledger.sql ? ledger.meta(`snap:${key}`, null) : null;
  const { next, events } = WATCHED[key](prev, value);
  for (const e of events) await ledger.record(e);
  snaps.set(key, next);
  if (ledger.sql) ledger.setMeta(`snap:${key}`, next);
}

/** Owner memories in `che`: new, superseded (correction), removed — metadata only for removals. */
function diffOwnerMemories(prev, data) {
  const records = Array.isArray(data?.memory_records) ? data.memory_records : [];
  const next = Object.fromEntries(records.map((r) => [r.id, { a: r.active !== false, h: String(r.text || '').length + ':' + (r.superseded_by ? 1 : 0) }]));
  const events = [];
  if (!prev) return { next, events }; // first sight: a baseline, never a flood of invented "new" events
  for (const r of records) {
    const before = prev[r.id];
    const explicit = ['owner', 'owner_chat', 'explicit_memory', 'owner_approved'].includes(String(r.source || ''));
    const pref = /\b(prefer|favorite|like|love|hate|always|never)\b/i.test(r.text || '');
    const [topic, topicSub] = categorize(r.text);
    const category = pref ? 'Owner Preferences' : topic;
    const subcategory = pref ? (['Music', 'Trading'].includes(topic) ? topic : 'General') : topicSub;
    if (!before) {
      events.push({ event_type: pref ? 'OWNER_PREFERENCE_SAVED' : explicit ? 'OWNER_MEMORY_SAVED' : 'KNOWLEDGE_SAVED', knowledge_type: pref ? 'preference' : 'knowledge', title: r.title || r.text, summary: r.text,
        category, subcategory, record_id: `mem:${r.id}`, source_type: explicit ? 'OWNER' : 'SYSTEM EVENT', source_reference: r.source,
        knowledge_scope: r.scope === 'general' ? 'owner-global' : 'owner-global', confidence: explicit ? 'Explicit' : 'Inferred', new_state: explicit ? 'VERIFIED' : 'UNDERSTOOD',
        verification_status: r.verification_status, reason_saved: explicit ? 'You stated it' : 'Inferred by CHE, not stated by you' });
    } else if (before.a && r.active === false) {
      events.push({ event_type: 'CORRECTION', knowledge_type: pref ? 'preference' : 'knowledge', title: r.title || r.text, summary: r.superseded_by ? `Replaced by: ${r.superseded_by}` : 'No longer active',
        category, subcategory, record_id: `mem:${r.id}`, source_type: 'OWNER', previous_state: 'VERIFIED', new_state: 'CORRECTED', reason_saved: 'Superseded by a newer statement',
        detail: { original: safeText(r.text, 160), corrected: safeText(r.superseded_by || '', 160) } });
    }
  }
  for (const id of Object.keys(prev)) if (!next[id]) events.push({ event_type: 'REMOVED', knowledge_type: 'knowledge', title: 'Removed item', category: 'Owner Preferences', subcategory: 'General', record_id: `mem:${id}`, source_type: 'OWNER', new_state: 'REMOVED', reason_saved: 'Owner request' });
  return { next, events, removed: Object.keys(prev).filter((id) => !next[id]) };
}

/** Capability registry: every status change is a state event; VERIFIED and AVAILABLE are the only usable ones. */
function diffRegistry(prev, registry) {
  const caps = registry?.capabilities || {};
  const next = Object.fromEntries(Object.values(caps).map((c) => [c.capability_id, `${c.status}:${c.version}`]));
  const events = [];
  for (const c of Object.values(caps)) {
    const before = prev?.[c.capability_id];
    if (before === `${c.status}:${c.version}`) continue;
    const prevStatus = before ? before.split(':')[0] : '';
    const state = c.status === 'PROTOTYPED' ? 'IMPLEMENTED' : c.status === 'TESTING' ? 'TESTED' : c.status;
    const type = c.status === 'TESTING' ? 'CAPABILITY_TESTED' : USABLE.has(c.status) ? 'CAPABILITY_VERIFIED' : 'CAPABILITY_STATE';
    const [category, subcategory] = categorize(`${c.name} ${c.description} ${c.category}`, {});
    events.push({ event_type: type, knowledge_type: 'capability', title: c.name, summary: `${c.status.toLowerCase()} v${c.version}${c.known_limitations?.length ? ` · limits: ${c.known_limitations.join('; ')}` : ''}`,
      category, subcategory, capability_id: c.capability_id, record_id: `cap:${c.capability_id}`, source_type: 'TOOL RESULT', source_reference: c.implementation_location,
      previous_state: STATES.includes(prevStatus) ? prevStatus : prevStatus === 'PROTOTYPED' ? 'IMPLEMENTED' : prevStatus === 'TESTING' ? 'TESTED' : '', new_state: STATES.includes(state) ? state : 'IMPLEMENTED',
      verification_status: c.test_status, reason_saved: USABLE.has(c.status) ? 'Passed every promotion check' : c.status === 'REJECTED' ? 'Failed a promotion check; not available' : 'Candidate under test' });
  }
  return { next, events };
}

/** Workflow Engine: new candidates are PENDING; promoted learned workflows are procedures. */
function diffWorkflowEngine(prev, state) {
  const learned = (state?.learned || []).map((w) => w.id);
  const cands = (state?.candidates || []).map((c) => c.id);
  const next = { learned, cands };
  const events = [];
  if (!prev) return { next, events };
  for (const w of state.learned || []) if (!prev.learned?.includes(w.id)) events.push({ event_type: 'WORKFLOW_PROMOTED', knowledge_type: 'procedure', title: w.name, summary: w.summary, category: 'Workflows', subcategory: 'Learned', workflow_id: w.id, record_id: `wf:${w.id}`, source_type: 'EXPERIMENT', new_state: 'VERIFIED', reason_saved: 'You promoted a tested candidate' });
  for (const c of state.candidates || []) if (!prev.cands?.includes(c.id)) events.push({ event_type: 'PENDING', knowledge_type: 'procedure', title: c.name, summary: c.reason, category: 'Workflows', subcategory: 'Learned', record_id: `wf:${c.id}`, source_type: 'SYSTEM EVENT', new_state: 'PENDING', reason_saved: 'Waiting for your review' });
  return { next, events };
}

function diffEvidenceRuns(prev, runs) {
  const list = Array.isArray(runs) ? runs : [];
  const next = list.length ? String(list[list.length - 1].at || list[list.length - 1].started_at || list.length) : '';
  const events = [];
  if (prev === null || prev === next || !list.length) return { next, events };
  const run = list[list.length - 1];
  if (!run.ok) return { next, events: [{ event_type: 'SOURCE_FAILED', knowledge_type: 'evidence', title: 'Trading evidence run failed', summary: run.error || '', category: 'Trading', subcategory: 'Paper Learning', source_type: 'PAPER TRADE', new_state: 'FAILED' }] };
  events.push({ event_type: 'EVIDENCE_UPDATED', knowledge_type: 'evidence', title: `Paper evidence run: ${run.closed || 0} closed, ${run.open_positions || 0} open`, summary: `${run.bars || 0} bars read${run.rejected ? `, ${run.rejected} signals rejected` : ''}`, category: 'Trading', subcategory: 'Paper Learning', source_type: 'PAPER TRADE', new_state: 'VERIFIED', reason_saved: 'A forward paper evidence run completed' });
  return { next, events };
}

function diffMatrix(prev, matrix) {
  const next = String(matrix?.built_at || '');
  if (prev === null || !next || prev === next) return { next, events: [] };
  const batch = `bt_${next}`;
  const ranking = Array.isArray(matrix.ranking) ? matrix.ranking : [];
  return { next, events: [
    ...ranking.slice(0, 40).map((r) => ({ event_type: 'EVIDENCE_UPDATED', knowledge_type: 'evidence', title: `${r.strategy || r.id || 'Strategy'} · ${r.timeframe || ''}`.trim(), summary: `${r.trades ?? '?'} trades${r.expectancy != null ? `, expectancy ${r.expectancy}` : ''}`, category: 'Trading', subcategory: 'Historical Research', source_type: 'BACKTEST', batch_id: batch, new_state: 'VERIFIED' })),
    { event_type: 'BATCH_RECEIPT', knowledge_type: 'evidence', title: 'Trading Backtest Batch', summary: `${(matrix.timeframes || []).length} timeframes, ${ranking.length} ranked results`, category: 'Trading', subcategory: 'Historical Research', source_type: 'BACKTEST', batch_id: batch, reason_saved: 'Backtest matrix rebuilt' },
  ] };
}

/** Closed trade records written together become one grouped batch; each trade stays reachable. */
async function tradesBatch(storage, trades) {
  const ledger = new BrainLedger(storage);
  const batch = `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const groups = {};
  for (const t of trades) {
    const name = String(t.strategy || t.portfolio || 'Strategy');
    groups[name] = (groups[name] || 0) + 1;
    const [category, subcategory] = categorize(name, { category: 'Trading', subcategory: categorize(name)[0] === 'Trading' ? categorize(name)[1] : 'Paper Learning' });
    await ledger.record({ event_type: 'EVIDENCE_UPDATED', knowledge_type: 'evidence', title: `${name}${t.timeframe ? ` · ${t.timeframe}` : ''} trade closed`, summary: `${t.environment || 'paper'} · ${t.exit?.reason || 'closed'}${t.r_multiple != null ? ` · ${t.r_multiple}R` : ''}`, category, subcategory, record_id: `evr:${t.environment}:${t.portfolio}:${t.entry?.time}`, source_type: t.environment === 'backtest' ? 'BACKTEST' : 'PAPER TRADE', source_reference: 'CHE Paper Journal', batch_id: batch, new_state: 'VERIFIED', reason_saved: '+1 verified trade' });
  }
  await ledger.record({ event_type: 'BATCH_RECEIPT', knowledge_type: 'evidence', title: trades.length === 1 ? 'Trade evidence recorded' : 'Trading evidence batch', summary: Object.entries(groups).map(([n, c]) => `${n}: ${c}`).join(', '), category: 'Trading', subcategory: 'Paper Learning', source_type: 'PAPER TRADE', batch_id: batch, reason_saved: `${trades.length} closed trade records` });
}

/**
 * The owner's decision on a pending item: commit makes it knowledge (UNDERSTOOD), reject keeps metadata only
 * ("Not retained") and scrubs its earlier text. Only an item whose latest state is PENDING can be decided.
 */
export async function decidePending(storage, recordId, decision, { now = new Date() } = {}) {
  const ledger = new BrainLedger(storage);
  const latest = (await ledger.query({ record_id: String(recordId || ''), limit: 1 }))[0];
  if (!latest) return { ok: false, said: 'There is no ledger record with that id.' };
  if (latest.new_state !== 'PENDING' && latest.event_type !== 'PENDING') return { ok: false, said: `${latest.title} is not pending; it is ${statusWord(latest).toLowerCase()}.` };
  const base = { category: latest.category, subcategory: latest.subcategory, record_id: latest.record_id, knowledge_type: latest.knowledge_type, source_type: 'OWNER', previous_state: 'PENDING', project_id: latest.project_id, workflow_id: latest.workflow_id, capability_id: latest.capability_id, knowledge_scope: latest.knowledge_scope };
  if (decision === 'reject') {
    await ledger.scrub(latest.record_id, now);
    const e = await ledger.record({ ...base, event_type: 'REJECTED', title: 'Not retained', new_state: 'REJECTED', reason_saved: 'You chose not to keep it' }, now);
    return { ok: true, event: e, said: 'Not retained, sir. Only the fact that it was set aside stays in the ledger.' };
  }
  const e = await ledger.record({ ...base, event_type: 'KNOWLEDGE_SAVED', title: latest.title, summary: latest.summary, new_state: 'UNDERSTOOD', reason_saved: 'You committed it' }, now);
  return { ok: true, event: e, said: `Committed, sir: ${latest.title} is now in my ${latest.category} brain as knowledge, not yet a capability.` };
}

/** All write paths the ledger covers; the coverage test walks this list. */
export const WRITE_PATHS = Object.freeze(['brain_store.write', 'knowledge_library.catalog', 'knowledge_library.index', 'knowledge_library.index_failed', 'capability_engine.KnowledgeItems.put', 'storage.put:che.memory_records', 'storage.put:che:capabilities_v1', 'storage.put:che:workflow_engine', 'storage.put:evr:*', 'storage.put:evidence_runs', 'storage.put:backtest_matrix']);

/** The /api/brain/ledger payload. */
export async function ledgerApi(storage, query = new URLSearchParams(), { zone = DEFAULT_ZONE, now = Date.now(), registry = null } = {}) {
  const ledger = new BrainLedger(storage);
  if (query.get('event')) return eventDetail(storage, query.get('event'), { zone, now, registry });
  if (query.get('batch')) return { batch_id: query.get('batch'), events: (await ledger.query({ batch_id: query.get('batch'), limit: 2000 })).map((e) => view(e, zone, now)) };
  if (query.get('category')) return { category: query.get('category'), subcategories: CATEGORIES[query.get('category')] || [], events: await categoryView(storage, query.get('category'), { subcategory: query.get('subcategory') || '', zone, now }) };
  if (query.get('q')) return { query: query.get('q'), events: (await ledger.query({ text: query.get('q'), limit: 100 })).map((e) => view(e, zone, now)) };
  const cards = await categoryCards(storage, { zone, now });
  const recent = (await ledger.query({ limit: 25 })).filter((e) => !e.batch_id || e.event_type === 'BATCH_RECEIPT').slice(0, 12).map((e) => view(e, zone, now));
  const totals = cards.reduce((t, c) => ({ knowledge: t.knowledge + c.items, procedures: t.procedures + c.procedures, capabilities: t.capabilities + c.capabilities, pending: t.pending + c.pending, failed: t.failed + c.failed }), { knowledge: 0, procedures: 0, capabilities: 0, pending: 0, failed: 0 });
  return { version: LEDGER_VERSION, zone, totals, categories: cards, recent, write_paths: WRITE_PATHS };
}
