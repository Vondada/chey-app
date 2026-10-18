// CHE Brain store: the one logical Brain, kept in CHE's own Durable Object
// (SQLite) and replicated to the phone.
//
// Every memory, conversation, note, lesson, task and library page is one
// record here with one stable id, one region (folder), its provenance, its
// verification state, its relationships and a revision number. The phone
// keeps a replica of the same records (lib/memory/che_brain_replica.dart) and
// the two reconcile through /api/brain/changes and /api/brain/push with the
// rules in apply(): a duplicate op returns its stored outcome, a delete always
// wins, a concurrent edit that differs only in links is merged, and anything
// else is kept on both sides as a conflict. Nothing is ever silently dropped.
//
// There is no retention ceiling here. The only caps are physical: a record
// body is clipped at MAX_BODY_CHARS because a SQLite row in a Durable Object
// is limited to about two megabytes, and the clip is recorded in its source.

import { SENSITIVE_RE } from './research_memory.js';
import { classifyItem } from './privacy_policy.js';

export const MAX_BODY_CHARS = 1_500_000;
const MAX_TITLE_CHARS = 200;
const MAX_LINKS = 64;
const MAX_PLACES = 8;

/** The sixteen folder regions of the Brain. A record lives in one, and may be shown in others. */
export const BRAIN_REGIONS = Object.freeze({
  conversations: 'Conversations and Corrections',
  personal: 'Personal Memory',
  learned: 'Learned Knowledge',
  coding: 'Coding and Development',
  trading: 'Trading and Market Research',
  media: 'YouTube and Media',
  business: 'Business and Finance',
  rea: 'REA Investigations',
  agents: 'Office Agents',
  skills: 'Skills and Tools',
  experiments: 'Experiments and Lessons',
  self: 'CHE Self-Knowledge',
  problems: 'Problems and Opportunities',
  projects: 'Projects and Proposals',
  audits: 'Daily Audits and Conclusions',
  tasks: 'Active and Historical Tasks',
});
const REGION_NAMES = new Set(Object.values(BRAIN_REGIONS));

/** How two records relate. Every link names one of these, so the orb map can draw and explain it. */
export const RELATIONSHIP_TYPES = Object.freeze([
  'learned_from', 'related_to', 'builds_upon', 'verified_by', 'contradicts', 'corrected_by',
  'produced_by_agent', 'implemented_in_code', 'result_of_experiment', 'superseded_by', 'relevant_to',
  'solves', 'tests', 'inspired_by', 'requires_verification', 'escalated_to', 'used_by_project',
  'discovered_by_audit',
]);
const RELATIONSHIPS = new Set(RELATIONSHIP_TYPES);

/** What a record's content is: the labels che-fact-check uses, so nothing unverified reads as fact. */
export const VERIFICATION_STATES = Object.freeze([
  'owner_attested', 'verified_source', 'unverified_reference', 'unverified_research_lead',
  'model_opinion', 'hypothesis', 'unknown',
]);
const VERIFICATIONS = new Set(VERIFICATION_STATES);

/** 32-bit FNV-1a. The phone computes the same number (che_brain_replica.dart), so digests can be compared. */
export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function clip(value, max) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

/**
 * The same secret gate as /api/memory/add (the sensitive words and the privacy policy's secret
 * class), run over the whole text at once, so one password anywhere refuses the record and a
 * clean text is never refused because a window cut through a word.
 */
export function isSafeText(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  if (SENSITIVE_RE.test(value)) return false;
  return classifyItem(value) !== 'secret';
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseJson(text, fallback) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

/** Links as stored: unique, typed, pointing at a record id. Unknown types become related_to. */
export function normalizeLinks(links) {
  const out = [];
  const seen = new Set();
  for (const link of Array.isArray(links) ? links : []) {
    const item = typeof link === 'string' ? { to: link } : asObject(link);
    const to = clip(item.to || item.id || item.target, 160);
    if (!to) continue;
    const type = RELATIONSHIPS.has(item.type) ? item.type : 'related_to';
    const key = `${type}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, to });
    if (out.length >= MAX_LINKS) break;
  }
  return out.sort((a, b) => (a.type + a.to).localeCompare(b.type + b.to));
}

function normalizePlaces(record) {
  const places = [];
  const seen = new Set();
  const add = (region, path) => {
    const r = REGION_NAMES.has(region) ? region : '';
    if (!r) return;
    const p = clip(path, 160);
    const key = `${r}/${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    places.push({ region: r, path: p });
  };
  add(record.region, record.path);
  for (const place of Array.isArray(record.places) ? record.places : []) {
    const item = asObject(place);
    add(item.region, item.path);
    if (places.length >= MAX_PLACES) break;
  }
  return places;
}

/**
 * Rule-based significance, so every score can be explained and corrected.
 * No model is asked; the reasons are the record's own properties. An owner
 * correction (significance.owner_score) always wins over the rules.
 */
export function assessSignificance(record) {
  const reasons = [];
  let score = 0.3;
  const verification = record.verification || 'unknown';
  if (verification === 'owner_attested') { score += 0.3; reasons.push('the owner said it himself'); }
  else if (verification === 'verified_source') { score += 0.2; reasons.push('backed by a checked source'); }
  else if (verification === 'model_opinion' || verification === 'hypothesis') { score -= 0.1; reasons.push(`a ${verification.replace('_', ' ')}, not a fact`); }
  const kind = record.kind || '';
  if (kind === 'correction') { score += 0.25; reasons.push('a correction of something CHE got wrong'); }
  if (kind === 'decision' || kind === 'lesson') { score += 0.15; reasons.push(`a ${kind}`); }
  const links = Array.isArray(record.links) ? record.links : [];
  if (links.length) { score += Math.min(0.15, links.length * 0.03); reasons.push(`${links.length} relationship${links.length === 1 ? '' : 's'}`); }
  if (links.some((l) => l.type === 'contradicts')) { score += 0.1; reasons.push('contradicts another record'); }
  if (links.some((l) => l.type === 'superseded_by')) { score -= 0.2; reasons.push('superseded by a newer record'); }
  const body = String(record.body || '');
  if (body.length < 24) { score -= 0.1; reasons.push('very short'); }
  const current = asObject(record.significance);
  const ownerScore = Number(current.owner_score);
  if (Number.isFinite(ownerScore)) {
    reasons.push('set by the owner');
    return { score: Math.max(0, Math.min(1, ownerScore)), owner_score: ownerScore, reasons, auditor: 'owner' };
  }
  return { score: Math.round(Math.max(0, Math.min(1, score)) * 100) / 100, reasons, auditor: 'rules_v1' };
}

/** One record as the store keeps it. Unknown fields are dropped; nothing sensitive is kept. */
export function normalizeRecord(input) {
  const record = asObject(input);
  const id = clip(record.id, 160);
  if (!id) return { error: 'A record needs an id.' };
  const region = REGION_NAMES.has(record.region) ? record.region : BRAIN_REGIONS.learned;
  const rawBody = String(record.body ?? '').replace(/\u0000/g, '');
  const body = rawBody.slice(0, MAX_BODY_CHARS);
  const source = asObject(record.source);
  const out = {
    id,
    kind: clip(record.kind, 40) || 'note',
    region,
    path: clip(record.path, 160),
    places: normalizePlaces({ ...record, region }),
    title: clip(record.title, MAX_TITLE_CHARS) || clip(body.split('\n')[0], 90) || id,
    body,
    source: { ...source, ...(rawBody.length > MAX_BODY_CHARS ? { clipped_from_chars: rawBody.length } : {}) },
    verification: VERIFICATIONS.has(record.verification) ? record.verification : 'unknown',
    significance: asObject(record.significance),
    links: normalizeLinks(record.links),
    created_at: clip(record.created_at, 40) || new Date().toISOString(),
  };
  out.significance = assessSignificance(out);
  return out;
}

/** Hash of what a record says. Links, places and significance are merged, not compared, so they stay out. */
export function contentHash(record) {
  return fnv1a32(JSON.stringify([record.kind, record.region, record.path, record.title, record.body, record.verification, record.source || {}])).toString(16).padStart(8, '0');
}

function sameLinks(a, b) {
  return JSON.stringify(normalizeLinks(a)) === JSON.stringify(normalizeLinks(b));
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    region: row.region,
    path: row.path || '',
    title: row.title || '',
    body: row.body || '',
    source: parseJson(row.source, {}),
    verification: row.verification || 'unknown',
    significance: parseJson(row.significance, {}),
    links: parseJson(row.links, []),
    rev: Number(row.rev) || 0,
    hash: row.hash || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    origin: row.origin || '',
    deleted: Number(row.deleted) === 1,
    seq: Number(row.seq) || 0,
  };
}

export class CheBrainStore {
  constructor(storage) {
    this.sql = storage?.sql || null;
    this.ready = false;
    this.fts = false;
  }

  init() {
    if (this.ready || !this.sql) return Boolean(this.sql);
    this.sql.exec('CREATE TABLE IF NOT EXISTS brain_records (id TEXT PRIMARY KEY, kind TEXT, region TEXT, path TEXT, title TEXT, body TEXT, source TEXT, verification TEXT, significance TEXT, links TEXT, rev INTEGER, hash TEXT, created_at TEXT, updated_at TEXT, origin TEXT, deleted INTEGER DEFAULT 0, seq INTEGER)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS brain_records_seq ON brain_records (seq)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS brain_records_kind ON brain_records (kind, deleted)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS brain_places (record_id TEXT, region TEXT, path TEXT, PRIMARY KEY (record_id, region, path))');
    this.sql.exec('CREATE INDEX IF NOT EXISTS brain_places_region ON brain_places (region, path)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS brain_ops (op_id TEXT PRIMARY KEY, outcome TEXT, at TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS brain_conflicts (id TEXT PRIMARY KEY, record_id TEXT, current TEXT, incoming TEXT, at TEXT, resolved TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS brain_meta (key TEXT PRIMARY KEY, value TEXT)');
    try {
      this.sql.exec('CREATE VIRTUAL TABLE IF NOT EXISTS brain_fts USING fts5(title, body, id UNINDEXED)');
      this.fts = true;
    } catch (_) { this.fts = false; }
    this.ready = true;
    return true;
  }

  rows(query, ...params) {
    return [...this.sql.exec(query, ...params)];
  }

  meta(key, fallback = null) {
    const row = this.rows('SELECT value FROM brain_meta WHERE key = ?', key)[0];
    return row ? parseJson(row.value, fallback) : fallback;
  }

  setMeta(key, value) {
    this.sql.exec('INSERT INTO brain_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  nextSeq() {
    const seq = (Number(this.meta('seq', 0)) || 0) + 1;
    this.setMeta('seq', seq);
    return seq;
  }

  get(id) {
    if (!this.init()) return null;
    return rowToRecord(this.rows('SELECT * FROM brain_records WHERE id = ?', String(id || ''))[0]);
  }

  write(record, { rev, origin, deleted = false, now }) {
    const at = now || new Date().toISOString();
    const seq = this.nextSeq();
    const hash = deleted ? '' : contentHash(record);
    const existing = this.rows('SELECT id FROM brain_records WHERE id = ?', record.id).length > 0;
    const values = [
      record.kind, record.region, record.path, deleted ? '' : record.title, deleted ? '' : record.body,
      JSON.stringify(deleted ? { deleted_at: at } : record.source || {}), record.verification,
      JSON.stringify(deleted ? {} : record.significance || {}), JSON.stringify(deleted ? [] : record.links || []),
      rev, hash, record.created_at || at, at, clip(origin, 40) || 'cloud', deleted ? 1 : 0, seq,
    ];
    if (existing) {
      this.sql.exec('UPDATE brain_records SET kind = ?, region = ?, path = ?, title = ?, body = ?, source = ?, verification = ?, significance = ?, links = ?, rev = ?, hash = ?, created_at = ?, updated_at = ?, origin = ?, deleted = ?, seq = ? WHERE id = ?', ...values, record.id);
    } else {
      this.sql.exec('INSERT INTO brain_records (kind, region, path, title, body, source, verification, significance, links, rev, hash, created_at, updated_at, origin, deleted, seq, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...values, record.id);
    }
    this.sql.exec('DELETE FROM brain_places WHERE record_id = ?', record.id);
    if (this.fts) this.sql.exec('DELETE FROM brain_fts WHERE id = ?', record.id);
    if (!deleted) {
      for (const place of record.places || [{ region: record.region, path: record.path }]) {
        this.sql.exec('INSERT OR IGNORE INTO brain_places (record_id, region, path) VALUES (?, ?, ?)', record.id, place.region, place.path || '');
      }
      if (this.fts) this.sql.exec('INSERT INTO brain_fts (title, body, id) VALUES (?, ?, ?)', record.title, record.body.slice(0, 200_000), record.id);
    }
    return { rev, seq, hash, updated_at: at };
  }

  /**
   * One synchronization operation: { op_id, type: 'put' | 'delete', record, base_rev }.
   * Returns { outcome, record, rev, seq } where outcome is one of created, updated,
   * unchanged, merged, conflict, deleted, duplicate, rejected.
   */
  apply(op, { origin = 'cloud', now } = {}) {
    if (!this.init()) return { outcome: 'rejected', reason: 'Brain storage is not available.' };
    const input = asObject(op);
    const opId = clip(input.op_id, 120);
    if (opId) {
      const seen = this.rows('SELECT outcome FROM brain_ops WHERE op_id = ?', opId)[0];
      if (seen) {
        const stored = parseJson(seen.outcome, {});
        return { ...stored, outcome: 'duplicate', first_outcome: stored.outcome, record: this.get(stored.id) };
      }
    }
    const result = this.reconcile(input, { origin, now });
    if (opId) {
      const { record, ...summary } = result;
      this.sql.exec('INSERT OR IGNORE INTO brain_ops (op_id, outcome, at) VALUES (?, ?, ?)', opId, JSON.stringify({ ...summary, id: record?.id || input.record?.id || input.id || '' }), now || new Date().toISOString());
    }
    return result;
  }

  reconcile(input, { origin, now }) {
    const type = input.type === 'delete' ? 'delete' : 'put';
    if (type === 'delete') {
      const id = clip(input.id || input.record?.id, 160);
      if (!id) return { outcome: 'rejected', reason: 'A delete needs an id.' };
      const current = this.get(id);
      // A delete always wins: it is the owner's privacy decision, so no revision check.
      if (current?.deleted) return { outcome: 'deleted', record: current, rev: current.rev };
      const base = current || { id, kind: 'note', region: BRAIN_REGIONS.learned, path: '', verification: 'unknown', created_at: now };
      const written = this.write(base, { rev: (current?.rev || 0) + 1, origin, deleted: true, now });
      return { outcome: 'deleted', record: this.get(id), rev: written.rev };
    }
    const normalized = normalizeRecord(input.record);
    if (normalized.error) return { outcome: 'rejected', reason: normalized.error };
    // Passwords and other secrets never enter the Brain, from either side.
    if (!isSafeText(`${normalized.title}\n${normalized.body}\n${normalized.path}\n${normalized.kind}\n${JSON.stringify(normalized.source)}\n${JSON.stringify(normalized.links)}`)) {
      return { outcome: 'rejected', reason: 'rejected_sensitive_or_empty', id: normalized.id };
    }
    const current = this.get(normalized.id);
    const baseRev = Number.isFinite(Number(input.base_rev)) ? Number(input.base_rev) : null;
    if (!current) {
      const { content_rev, ...source } = normalized.source;
      const written = this.write({ ...normalized, source }, { rev: 1, origin, now });
      return { outcome: 'created', record: this.get(normalized.id), rev: written.rev };
    }
    if (current.deleted) {
      // Only a client that has seen the tombstone (base_rev equal) recreates a deleted record.
      if (baseRev !== current.rev) return { outcome: 'deleted', record: current, rev: current.rev, reason: 'deleted_here' };
      const written = this.write({ ...normalized, created_at: normalized.created_at }, { rev: current.rev + 1, origin, now });
      return { outcome: 'created', record: this.get(normalized.id), rev: written.rev };
    }
    const hash = contentHash(normalized);
    const mergedLinks = normalizeLinks([...(current.links || []), ...normalized.links]);
    const linksChanged = !sameLinks(current.links, normalized.links);
    if (hash === current.hash) {
      // Links the record already has (the same set, or a subset) change nothing.
      if (!linksChanged || sameLinks(current.links, mergedLinks)) return { outcome: 'unchanged', record: current, rev: current.rev };
      // Same content, more relationships: the union, from either side.
      const written = this.write({ ...normalized, links: mergedLinks, created_at: current.created_at }, { rev: current.rev + 1, origin, now });
      return { outcome: 'merged', record: this.get(normalized.id), rev: written.rev };
    }
    // A client whose base is the current revision, or any revision since the content last changed
    // (later revisions only amended flags or links), edits the content it saw.
    const contentRev = Number.isFinite(Number(current.source?.content_rev)) ? Number(current.source.content_rev) : current.rev;
    if (baseRev === current.rev || (baseRev != null && baseRev >= contentRev)) {
      const { content_rev, ...source } = normalized.source;
      const written = this.write({ ...normalized, source, links: mergedLinks, created_at: current.created_at }, { rev: current.rev + 1, origin, now });
      return { outcome: 'updated', record: this.get(normalized.id), rev: written.rev };
    }
    // Both sides changed the content since the client last saw it: keep the current copy,
    // keep the incoming copy beside it, and tell the client so it keeps its own too.
    const conflictId = `${normalized.id}@${baseRev ?? 'none'}>${current.rev}:${hash}`;
    this.sql.exec('INSERT OR IGNORE INTO brain_conflicts (id, record_id, current, incoming, at, resolved) VALUES (?, ?, ?, ?, ?, ?)',
      conflictId, normalized.id, JSON.stringify(current), JSON.stringify({ ...normalized, hash, base_rev: baseRev, origin }), now || new Date().toISOString(), '');
    return { outcome: 'conflict', record: current, rev: current.rev, conflict_id: conflictId };
  }

  /** A change to a record's source metadata only (active flag, supersession): content untouched, revision moved. */
  amendSource(id, patch, { origin = 'cloud', now } = {}) {
    const current = this.get(id);
    if (!current || current.deleted) return { outcome: 'missing', id };
    const source = { ...(current.source || {}), ...asObject(patch) };
    if (JSON.stringify(source) === JSON.stringify(current.source || {})) return { outcome: 'unchanged', record: current, rev: current.rev };
    // The content is the same as at content_rev, so a client that saw that revision is not behind.
    source.content_rev = Number.isFinite(Number(current.source?.content_rev)) ? Number(current.source.content_rev) : current.rev;
    const written = this.write({ ...current, source, places: this.rows('SELECT region, path FROM brain_places WHERE record_id = ?', id) }, { rev: current.rev + 1, origin: current.origin || origin, now });
    return { outcome: 'amended', record: this.get(id), rev: written.rev };
  }

  /**
   * The owner deleted a memory on the Memory screen: every live memory record whose display copy
   * is that text becomes a tombstone, including a twin the phone pushed under its own id.
   */
  deleteMemoriesShowing(text, { origin = 'owner', now } = {}) {
    if (!this.init()) return 0;
    const wanted = displayCopy(text);
    if (!wanted) return 0;
    let deleted = 0;
    for (const row of this.rows("SELECT id, body FROM brain_records WHERE kind = 'memory' AND deleted = 0")) {
      if (displayCopy(row.body) !== wanted) continue;
      if (this.delete(row.id, { origin, now }).outcome === 'deleted') deleted += 1;
    }
    return deleted;
  }

  /** "Clear all memories": every live memory record, whatever its origin. */
  deleteAllMemories({ origin = 'owner', now } = {}) {
    if (!this.init()) return 0;
    let deleted = 0;
    for (const row of this.rows("SELECT id FROM brain_records WHERE kind = 'memory' AND deleted = 0")) {
      if (this.delete(row.id, { origin, now }).outcome === 'deleted') deleted += 1;
    }
    return deleted;
  }

  /** A record written by CHE herself (not a sync op): created or updated, with the current revision as base. */
  put(record, { origin = 'cloud', now } = {}) {
    const current = this.get(asObject(record).id);
    // A deleted record stays deleted: only a sync op that saw the tombstone (apply with its rev) recreates one.
    return this.apply({ type: 'put', record, base_rev: current && !current.deleted ? current.rev : null }, { origin, now });
  }

  /** Writes only when the id is new: a fuller live record is never replaced by a legacy projection. */
  putIfAbsent(record, opts = {}) {
    if (!this.init()) return { outcome: 'rejected', reason: 'Brain storage is not available.' };
    if (this.get(asObject(record).id)) return { outcome: 'present' };
    return this.put(record, opts);
  }

  delete(id, { origin = 'cloud', now } = {}) {
    return this.apply({ type: 'delete', id }, { origin, now });
  }

  /** Records changed after [since] (a seq), oldest first; tombstones included so deletes reach the phone. */
  changes({ since = 0, limit = 200 } = {}) {
    if (!this.init()) return { records: [], next: 0, more: false, seq: 0 };
    const from = Math.max(0, Number(since) || 0);
    const size = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const rows = this.rows('SELECT * FROM brain_records WHERE seq > ? ORDER BY seq ASC LIMIT ?', from, size + 1);
    const more = rows.length > size;
    const records = rows.slice(0, size).map(rowToRecord);
    return { records, next: records.length ? records[records.length - 1].seq : from, more, seq: Number(this.meta('seq', 0)) || 0 };
  }

  /**
   * Integrity digest: the count of records and the sum of fnv1a32("id:rev") over all of them,
   * tombstones included, modulo 2^32. The phone computes the same from its replica.
   */
  digest() {
    if (!this.init()) return { count: 0, sum: 0 };
    let sum = 0;
    let count = 0;
    for (const row of this.sql.exec('SELECT id, rev FROM brain_records')) {
      sum = (sum + fnv1a32(`${row.id}:${row.rev}`)) % 4294967296;
      count += 1;
    }
    return { count, sum };
  }

  search(question, { limit = 8, region = '' } = {}) {
    if (!this.init()) return [];
    const terms = [...new Set(String(question || '').toLowerCase().match(/[a-z0-9']{3,}/g) || [])].slice(0, 12);
    if (!terms.length) return [];
    const size = Math.max(1, Math.min(Number(limit) || 8, 50));
    let ids = [];
    if (this.fts) {
      try {
        const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
        ids = this.rows('SELECT id FROM brain_fts WHERE brain_fts MATCH ? ORDER BY bm25(brain_fts) LIMIT ?', match, size * 3).map((r) => r.id);
      } catch (_) { ids = []; }
    }
    if (!ids.length) {
      const scored = new Map();
      for (const term of terms) {
        for (const row of this.sql.exec('SELECT id FROM brain_records WHERE deleted = 0 AND (lower(title) LIKE ? OR lower(body) LIKE ?) LIMIT 300', `%${term}%`, `%${term}%`)) {
          scored.set(row.id, (scored.get(row.id) || 0) + 1);
        }
      }
      ids = [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    }
    const out = [];
    for (const id of ids) {
      const record = this.get(id);
      if (!record || record.deleted) continue;
      if (region && record.region !== region && !this.rows('SELECT 1 AS x FROM brain_places WHERE record_id = ? AND region = ?', id, region).length) continue;
      out.push({ ...record, body: record.body.slice(0, 1200) });
      if (out.length >= size) break;
    }
    return out;
  }

  /** Every region with its subfolders and live record counts. Regions with nothing still appear. */
  folders() {
    if (!this.init()) return [];
    const counts = new Map();
    for (const row of this.sql.exec('SELECT p.region AS region, p.path AS path, COUNT(*) AS n FROM brain_places p JOIN brain_records r ON r.id = p.record_id WHERE r.deleted = 0 GROUP BY p.region, p.path')) {
      if (!counts.has(row.region)) counts.set(row.region, { total: 0, paths: [] });
      const entry = counts.get(row.region);
      entry.total += Number(row.n) || 0;
      if (row.path) entry.paths.push({ path: row.path, count: Number(row.n) || 0 });
    }
    return Object.values(BRAIN_REGIONS).map((region) => {
      const entry = counts.get(region) || { total: 0, paths: [] };
      return { region, count: entry.total, folders: entry.paths.sort((a, b) => b.count - a.count) };
    });
  }

  /** Records in one folder, newest first, paged by seq for the orb map. */
  list({ region = '', path = null, before = null, limit = 100 } = {}) {
    if (!this.init()) return { records: [], more: false };
    const size = Math.max(1, Math.min(Number(limit) || 100, 500));
    const params = [];
    let where = 'r.deleted = 0';
    if (region) { where += ' AND p.region = ?'; params.push(region); }
    if (path != null && path !== '') { where += ' AND p.path = ?'; params.push(path); }
    if (before != null && Number.isFinite(Number(before))) { where += ' AND r.seq < ?'; params.push(Number(before)); }
    const rows = this.rows(`SELECT DISTINCT r.* FROM brain_records r JOIN brain_places p ON p.record_id = r.id WHERE ${where} ORDER BY r.seq DESC LIMIT ?`, ...params, size + 1);
    const more = rows.length > size;
    return { records: rows.slice(0, size).map(rowToRecord).map((r) => ({ ...r, body: r.body.slice(0, 600) })), more };
  }

  conflicts({ open = true } = {}) {
    if (!this.init()) return [];
    const rows = open ? this.rows("SELECT * FROM brain_conflicts WHERE resolved = '' ORDER BY at DESC LIMIT 200") : this.rows('SELECT * FROM brain_conflicts ORDER BY at DESC LIMIT 200');
    return rows.map((row) => ({ id: row.id, record_id: row.record_id, current: parseJson(row.current, null), incoming: parseJson(row.incoming, null), at: row.at, resolved: row.resolved || '' }));
  }

  /** The owner picks a side: 'current' keeps what is stored, 'incoming' makes the other copy the record. */
  resolveConflict(conflictId, choice, { origin = 'owner', now } = {}) {
    if (!this.init()) return { ok: false, reason: 'Brain storage is not available.' };
    const row = this.rows('SELECT * FROM brain_conflicts WHERE id = ?', String(conflictId || ''))[0];
    if (!row) return { ok: false, reason: 'No such conflict.' };
    if (row.resolved) return { ok: true, already: row.resolved };
    const pick = choice === 'incoming' ? 'incoming' : 'current';
    let result = { outcome: 'unchanged' };
    if (pick === 'incoming') {
      const incoming = parseJson(row.incoming, null);
      const current = this.get(row.record_id);
      if (incoming) result = this.apply({ type: 'put', record: incoming, base_rev: current?.rev ?? null }, { origin, now });
    }
    this.sql.exec('UPDATE brain_conflicts SET resolved = ? WHERE id = ?', pick, row.id);
    return { ok: true, resolved: pick, ...result };
  }

  /** Real counts for the Brain Status dashboard; nothing here is estimated. */
  status() {
    if (!this.init()) return { available: false };
    const total = this.rows('SELECT COUNT(*) AS n FROM brain_records')[0]?.n || 0;
    const deleted = this.rows('SELECT COUNT(*) AS n FROM brain_records WHERE deleted = 1')[0]?.n || 0;
    const byKind = {};
    for (const row of this.sql.exec('SELECT kind, COUNT(*) AS n FROM brain_records WHERE deleted = 0 GROUP BY kind')) byKind[row.kind] = Number(row.n) || 0;
    const byVerification = {};
    for (const row of this.sql.exec('SELECT verification, COUNT(*) AS n FROM brain_records WHERE deleted = 0 GROUP BY verification')) byVerification[row.verification || 'unknown'] = Number(row.n) || 0;
    const openConflicts = this.rows("SELECT COUNT(*) AS n FROM brain_conflicts WHERE resolved = ''")[0]?.n || 0;
    const chars = this.rows('SELECT COALESCE(SUM(length(body)), 0) AS n FROM brain_records WHERE deleted = 0')[0]?.n || 0;
    return {
      available: true,
      records: Number(total) - Number(deleted),
      tombstones: Number(deleted),
      by_kind: byKind,
      by_verification: byVerification,
      regions: this.folders(),
      open_conflicts: Number(openConflicts),
      seq: Number(this.meta('seq', 0)) || 0,
      digest: this.digest(),
      body_chars: Number(chars),
      full_text_search: this.fts,
      legacy_projection: this.meta('legacy_projection', null),
      conversation_backfill: this.meta('brainmem_cursor', null),
    };
  }
}

// ─── Live hooks and legacy projection ──────────────────────────────────────

/** A whole exchange, word for word, in Conversations and Corrections. Same id as its brainmem record. */
export function rememberExchange(store, { id, message, reply, at, correction = false } = {}) {
  const said = String(message || '').trim();
  const answered = String(reply || '').trim();
  if (!id || !said) return { outcome: 'rejected', reason: 'empty' };
  const day = (at || new Date().toISOString()).slice(0, 10);
  return store.putIfAbsent({
    id: `conv:${id}`,
    kind: correction ? 'correction' : 'conversation',
    region: BRAIN_REGIONS.conversations,
    path: correction ? 'Corrections' : `Chat/${day}`,
    title: said.slice(0, 90),
    body: answered ? `You said: ${said}\nCHE answered: ${answered}` : `You said: ${said}`,
    source: { kind: 'owner_chat', brainmem_id: id, full_text: true },
    verification: 'owner_attested',
    created_at: at,
  }, { origin: 'cloud' });
}

/** Owner memory rows (data.memory_records) as Personal Memory records with stable ids. */
/** What data.memories keeps of a memory: its first 500 characters, whitespace collapsed (research_memory clip). */
export function displayCopy(body) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** An owner memory as a Brain record with its whole text; the memory list keeps only the display copy. */
export function ownerMemoryRecord(record, fullText) {
  return { ...memoryRecordToBrain(record), body: String(fullText || record.text || '') };
}

function memoryRecordToBrain(record) {
  const links = [];
  if (record.superseded_by && record.superseded_by_id) links.push({ type: 'superseded_by', to: `mem:${record.superseded_by_id}` });
  return {
    id: `mem:${record.id}`,
    kind: 'memory',
    region: BRAIN_REGIONS.personal,
    path: clip(record.category, 60) || 'Memory',
    title: clip(record.title || record.text, 160),
    body: String(record.text || ''),
    source: { kind: 'memory_record', legacy_source: record.source || '', scope: record.scope || 'owner', confidence: record.confidence ?? null, active: record.active !== false, superseded_at: record.superseded_at || '' },
    verification: VERIFICATIONS.has(record.verification_status) ? record.verification_status : 'unknown',
    links,
    created_at: record.created_at,
  };
}

// The region a research note belongs to: the one whose words it uses most; ties go to the first.
const NOTE_REGION = [
  [/\b(?:trade|trades|trading|market|stocks?|crypto|forex|portfolio|backtest)\b/gi, BRAIN_REGIONS.trading],
  [/\b(?:fiverr|clients?|invoices?|business|revenue|deals?|offers?|gigs?)\b/gi, BRAIN_REGIONS.business],
  [/\b(?:youtube|videos?|thumbnails?|channels?|podcasts?)\b/gi, BRAIN_REGIONS.media],
  [/\b(?:rea|investigations?|investigate)\b/gi, BRAIN_REGIONS.rea],
  [/\b(?:code|coding|repo|bugs?|github|deploy|worker|flutter)\b/gi, BRAIN_REGIONS.coding],
];
function regionForNote(note) {
  const bullets = Array.isArray(note.bullets) ? note.bullets.join(' ') : '';
  const text = `${note.title || ''} ${note.kind || ''} ${note.category || ''} ${bullets}`;
  let best = null;
  let bestCount = 0;
  for (const [re, region] of NOTE_REGION) {
    const count = (text.match(re) || []).length;
    if (count > bestCount) { best = region; bestCount = count; }
  }
  if (best) return best;
  return note.kind === 'opportunity' ? BRAIN_REGIONS.problems : BRAIN_REGIONS.learned;
}

function memoryNoteToBrain(note) {
  const bullets = Array.isArray(note.bullets) ? note.bullets : [];
  const sources = Array.isArray(note.sources) ? note.sources : [];
  return {
    id: `note:${note.id}`,
    kind: note.kind === 'opportunity' ? 'opportunity' : 'research_note',
    region: regionForNote(note),
    path: note.kind === 'opportunity' ? 'Opportunities' : 'Research notes',
    places: note.kind === 'opportunity' ? [{ region: BRAIN_REGIONS.learned, path: 'Research notes' }] : [],
    title: clip(note.title, 160),
    body: [...bullets.map((b) => `- ${b}`), ...(sources.length ? ['', `Sources: ${sources.join(' ')}`] : [])].join('\n'),
    source: { kind: 'memory_note', agent: note.agent || note.agent_name || '', task_id: note.task_id || '', urls: sources.slice(0, 10) },
    verification: VERIFICATIONS.has(note.verification_status) ? note.verification_status : 'unverified_research_lead',
    created_at: note.created_at,
  };
}

function lessonToBrain(text) {
  const lesson = String(text || '');
  return {
    id: `know:${fnv1a32(lesson).toString(16)}`,
    kind: 'lesson',
    region: BRAIN_REGIONS.experiments,
    path: 'Lessons',
    title: clip(lesson, 120),
    body: lesson,
    source: { kind: 'learned_knowledge' },
    verification: /^unverified/i.test(lesson) ? 'unverified_research_lead' : 'unverified_reference',
  };
}

function taskToBrain(task) {
  const status = clip(task.status, 30) || 'unknown';
  const live = ['queued', 'running', 'reviewing'].includes(status);
  return {
    id: `task:${task.id}`,
    kind: 'task',
    region: BRAIN_REGIONS.tasks,
    path: live ? 'Active' : 'Historical',
    places: [{ region: BRAIN_REGIONS.agents, path: clip(task.agent_name || task.agent || task.agent_id, 60) || 'Office' }],
    title: clip(task.task || task.title, 160),
    body: [`Status: ${status}`, task.result ? `Result: ${String(task.result).slice(0, 20_000)}` : '', task.error ? `Error: ${task.error}` : ''].filter(Boolean).join('\n'),
    source: { kind: 'team_task', agent: task.agent_name || task.agent || '', status, kind_label: task.kind || '' },
    verification: 'unverified_reference',
    links: task.agent_id ? [{ type: 'produced_by_agent', to: `agent:${task.agent_id}` }] : [],
    created_at: task.created_at || task.at,
  };
}

function reviewToBrain(review, index) {
  const at = clip(review.at || review.date || review.created_at, 40);
  const body = typeof review === 'string' ? review : String(review.review || review.summary || review.text || JSON.stringify(review));
  return {
    id: `review:${at || index}`,
    kind: 'daily_review',
    region: BRAIN_REGIONS.audits,
    path: 'Nightly reviews',
    title: `Nightly review ${at.slice(0, 10) || `#${index}`}`,
    body,
    source: { kind: 'nightly_review' },
    verification: 'model_opinion',
    created_at: at,
  };
}

/**
 * Projects the legacy stores in CHE's state blob into Brain records with stable ids. Cheap to
 * repeat: a record whose legacy content has not changed is skipped by hash, so the state blob
 * and the Brain never ping-pong. Returns what it did.
 */
function libraryDocToBrain(doc) {
  return {
    id: `lib:${doc.id}`,
    kind: 'library_doc',
    region: BRAIN_REGIONS.learned,
    path: 'Library',
    title: clip(doc.title, 160) || 'Untitled',
    // The text itself stays in the library tables (and the phone's offline library); this is its index card.
    body: `${doc.title || 'Untitled'}
Source: ${doc.source || 'owner'}
${Number(doc.chars) || 0} characters in ${Number(doc.chunks) || 0} parts, saved ${doc.added || 'unknown'}.`,
    source: { kind: 'library', library_id: doc.id, url: /^https?:/i.test(String(doc.source || '')) ? doc.source : '', chars: Number(doc.chars) || 0 },
    verification: /^https?:/i.test(String(doc.source || '')) ? 'unverified_reference' : 'owner_attested',
    created_at: doc.added,
  };
}

export function projectLegacyState(store, data = {}, { now, library = [] } = {}) {
  if (!store.init()) return { projected: 0, skipped: 0, available: false };
  const seen = store.meta('legacy_hashes', {});
  const hashes = seen && typeof seen === 'object' ? seen : {};
  let projected = 0;
  let skipped = 0;
  const consider = (record) => {
    const candidate = normalizeRecord(record);
    if (candidate.error) return;
    const hash = contentHash(candidate);
    if (hashes[candidate.id] === hash) { skipped += 1; return; }
    const current = store.get(candidate.id);
    // The owner deleted it: the legacy row may linger a little, the deletion wins.
    if (current?.deleted) { hashes[candidate.id] = hash; skipped += 1; return; }
    // data.memories holds a 500-character, single-line display copy of each memory. When the Brain's
    // record came from the phone, or is simply the fuller text that copy was cut from, the copy never
    // overwrites it; only its active and supersession flags are carried over.
    if (current && candidate.kind === 'memory' && current.kind === 'memory'
      && (current.origin !== 'cloud' || displayCopy(current.body) === displayCopy(candidate.body))) {
      const sameFlags = (current.source?.active !== false) === (candidate.source.active !== false)
        && (current.source?.superseded_at || '') === (candidate.source.superseded_at || '');
      const result = sameFlags ? { outcome: 'unchanged' } : store.amendSource(candidate.id, { active: candidate.source.active !== false, superseded_at: candidate.source.superseded_at || '' }, { origin: 'cloud', now });
      hashes[candidate.id] = hash;
      if (result.outcome === 'amended') projected += 1; else skipped += 1;
      return;
    }
    const result = store.put(record, { origin: 'cloud', now });
    if (['created', 'updated', 'merged', 'unchanged'].includes(result.outcome)) {
      hashes[candidate.id] = hash;
      if (result.outcome !== 'unchanged') projected += 1; else skipped += 1;
    }
  };
  for (const record of Array.isArray(data.memory_records) ? data.memory_records : []) if (record?.id && record.text) consider(memoryRecordToBrain(record));
  for (const note of Array.isArray(data.memory_notes) ? data.memory_notes : []) if (note?.id && note.title) consider(memoryNoteToBrain(note));
  for (const lesson of Array.isArray(data.learned_knowledge) ? data.learned_knowledge : []) if (String(lesson || '').trim()) consider(lessonToBrain(lesson));
  for (const task of Array.isArray(data.team_tasks) ? data.team_tasks : []) if (task?.id && (task.task || task.title)) consider(taskToBrain(task));
  (Array.isArray(data.nightly_reviews) ? data.nightly_reviews : []).forEach((review, index) => { if (review) consider(reviewToBrain(review, index)); });
  for (const doc of Array.isArray(library) ? library : []) if (doc?.id) consider(libraryDocToBrain(doc));
  store.setMeta('legacy_hashes', hashes);
  const summary = { at: now || new Date().toISOString(), projected, skipped };
  store.setMeta('legacy_projection', summary);
  return { ...summary, available: true };
}

/**
 * Brings the older brainmem conversation records (brain_memory.js) into the Brain, a batch at a
 * time, resuming from a cursor. Those records hold the owner's words and only the first sentences
 * of CHE's answer, and are marked so; a full live record for the same exchange is never replaced.
 */
export async function backfillConversations(store, storage, { batch = 100, now } = {}) {
  if (!store.init() || !storage?.list) return { done: true, added: 0 };
  const cursor = store.meta('brainmem_cursor', { key: '', done: false, added: 0 });
  if (cursor.done) return { ...cursor, added: 0 };
  const opts = { prefix: 'brainmem:', limit: Math.max(1, Math.min(Number(batch) || 100, 500)) };
  if (cursor.key) opts.startAfter = cursor.key;
  const rows = await storage.list(opts);
  let added = 0;
  let last = cursor.key;
  for (const [key, memory] of rows) {
    last = key;
    if (!memory?.id || !memory.body) continue;
    const result = store.putIfAbsent({
      id: `conv:${memory.id}`,
      kind: memory.kind && memory.kind !== 'conversation' ? clip(memory.kind, 40) : 'conversation',
      region: BRAIN_REGIONS.conversations,
      path: memory.kind && memory.kind !== 'conversation' ? clip(memory.kind, 60) : `Chat/${String(memory.at || '').slice(0, 10)}`,
      title: memory.title,
      body: memory.body,
      source: { kind: 'brainmem', brainmem_id: memory.id, full_text: false, note: 'legacy record: the owner’s words and the first sentences of CHE’s answer' },
      verification: 'owner_attested',
      links: (Array.isArray(memory.links) ? memory.links : []).map((to) => ({ type: 'related_to', to: `conv:${to}` })),
      created_at: memory.at,
    }, { origin: 'cloud', now });
    if (result.outcome === 'created') added += 1;
  }
  const done = rows.size < opts.limit;
  const next = { key: last, done, added: (Number(cursor.added) || 0) + added, at: now || new Date().toISOString() };
  store.setMeta('brainmem_cursor', next);
  return { ...next, added };
}
