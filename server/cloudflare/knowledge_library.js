// CHE Knowledge Library: the owner's reference catalog on top of the existing full-text library (library.js).
//
// One store, not a second Brain: the text lives in CheLibrary (lib_docs, lib_chunks, lib_fts) and this module
// adds one metadata table (kl_refs) for each reference: category, creator, source, licence, trust and status.
//
// Two states, kept apart on purpose:
//   - cataloged: the title, creator, source and notes are known; no text is stored. It is never evidence.
//   - indexed: approved text is stored word-for-word and every answer cites its title and part.
// Text is stored only when the licence or the owner's permission allows it (TEXT_LICENSES). Anything else stays
// cataloged. Fiction is stored with kind "fiction" and is never returned for a technical question.
import { CheLibrary, queryTerms } from './library.js';
import { fnv1a32 } from './brain_store.js';

export const KNOWLEDGE_CATEGORIES = Object.freeze([
  { id: 'ai_agents', name: 'AI and Autonomous Agents' },
  { id: 'software_engineering', name: 'Software Engineering' },
  { id: 'planning_decisions', name: 'Planning and Decision-Making' },
  { id: 'machine_learning', name: 'Machine Learning and Neural Networks' },
  { id: 'memory_cognition', name: 'Memory and Cognitive Science' },
  { id: 'search_rag', name: 'Search and Retrieval-Augmented Generation' },
  { id: 'reasoning_fact_checking', name: 'Reasoning and Fact-Checking' },
  { id: 'debugging_reliability', name: 'Debugging and Reliability' },
  { id: 'natural_language_speech', name: 'Natural Language and Speech' },
  { id: 'psychology_emotion', name: 'Psychology and Emotional Intelligence' },
  { id: 'communication_accessibility', name: 'Communication and Accessibility' },
  { id: 'cybersecurity', name: 'Cybersecurity' },
  { id: 'math_statistics', name: 'Mathematics and Statistics' },
  { id: 'trading_risk', name: 'Trading and Risk Management' },
  { id: 'financial_markets', name: 'Financial Markets and Execution' },
  { id: 'business_management', name: 'Business and Management' },
  { id: 'robotics_automation', name: 'Robotics and Automation' },
  { id: 'creative_writing', name: 'Creative Writing' },
  { id: 'animation_games', name: 'Animation and Game Design' },
  { id: 'marketing_video', name: 'Marketing and Video Production' },
]);

export const KINDS = Object.freeze(['book', 'paper', 'documentation', 'comic', 'movie', 'transcript', 'note', 'fiction']);

// Licences under which the full text may be stored: the owner's own text, public domain, and open licences.
// Anything not listed (including "all rights reserved" and unknown) is catalogued only.
export const TEXT_LICENSES = Object.freeze({
  owner: 'Owner-supplied text',
  public_domain: 'Public domain',
  cc0: 'CC0',
  cc_by: 'CC BY',
  cc_by_sa: 'CC BY-SA',
  licensed_with_permission: 'Licensed, with the owner\'s written permission',
});

// Fiction and comics/movies are examples for creative design, never engineering instructions.
const TECHNICAL_KINDS = new Set(['book', 'paper', 'documentation', 'transcript', 'note']);
const CATEGORY_IDS = new Set(KNOWLEDGE_CATEGORIES.map((c) => c.id));

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The reference's identity, used to refuse a duplicate: same title, creator and edition. */
export function referenceKey({ title = '', creator = '', edition = '' } = {}) {
  return `kl:${fnv1a32([title, creator, edition].map((v) => clip(v, 300).toLowerCase()).join('|'))}`;
}

export function textAllowed(license = '') {
  return Object.prototype.hasOwnProperty.call(TEXT_LICENSES, String(license || ''));
}

export class KnowledgeLibrary {
  constructor(storage) {
    this.storage = storage;
    this.lib = new CheLibrary(storage);
    this.sql = storage?.sql || null;
    this.ready = false;
  }

  init() {
    if (this.ready) return Boolean(this.sql);
    if (!this.sql) return false;
    this.lib.init();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kl_refs (
      id TEXT PRIMARY KEY, key TEXT UNIQUE, doc_id TEXT, category TEXT, subcategory TEXT, kind TEXT,
      title TEXT, creator TEXT, source_url TEXT, published TEXT, edition TEXT, license TEXT,
      access TEXT, topics TEXT, trust TEXT, note TEXT, indexed_at TEXT, revision INTEGER, added TEXT)`);
    this.ready = true;
    return true;
  }

  /**
   * Catalogs a reference (no text). Returns the stored reference; a duplicate returns the existing one with
   * duplicate: true, so nothing is catalogued twice.
   */
  catalog(input = {}, { now = new Date().toISOString() } = {}) {
    if (!this.init()) return { error: 'Knowledge storage is not available.' };
    const title = clip(input.title, 200);
    if (!title) return { error: 'A reference needs a title.' };
    const category = CATEGORY_IDS.has(input.category) ? input.category : '';
    if (!category) return { error: 'Pick one of the 20 categories, or request a new one.' };
    const kind = KINDS.includes(input.kind) ? input.kind : 'note';
    const key = referenceKey({ title, creator: input.creator, edition: input.edition });
    const existing = this.get(key, { byKey: true });
    if (existing) return { ...existing, duplicate: true };
    const ref = {
      id: crypto.randomUUID(),
      key,
      doc_id: null,
      category,
      subcategory: clip(input.subcategory, 120),
      kind,
      title,
      creator: clip(input.creator, 200),
      source_url: clip(input.source_url, 500),
      published: clip(input.published, 40),
      edition: clip(input.edition, 120),
      license: clip(input.license, 60) || 'unknown',
      access: 'cataloged',
      topics: [...new Set((input.topics || []).map((t) => clip(t, 60)).filter(Boolean))].slice(0, 30).join(', '),
      trust: 'catalog_only',
      note: clip(input.note, 1000),
      indexed_at: '',
      revision: 0,
      added: now,
    };
    this.sql.exec(`INSERT INTO kl_refs (id, key, doc_id, category, subcategory, kind, title, creator, source_url, published, edition, license, access, topics, trust, note, indexed_at, revision, added)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?)`,
    ref.id, ref.key, ref.category, ref.subcategory, ref.kind, ref.title, ref.creator, ref.source_url, ref.published,
    ref.edition, ref.license, ref.access, ref.topics, ref.trust, ref.note, ref.added);
    return ref;
  }

  /**
   * Stores the approved text of a catalogued reference. Refused unless its licence allows the text. A reference
   * indexed again is a new revision with the old text replaced, so search never returns both.
   */
  index(id, text, { now = new Date().toISOString() } = {}) {
    if (!this.init()) return { error: 'Knowledge storage is not available.' };
    const ref = this.get(id);
    if (!ref) return { error: 'That reference is not in the library.' };
    if (!textAllowed(ref.license)) {
      return { error: `Only the text of owner, public-domain or openly licensed references is stored. "${ref.title}" stays catalogued (licence: ${ref.license}).` };
    }
    const body = String(text || '');
    if (body.trim().length < 20) return { error: 'There was nothing readable to index.' };
    if (ref.doc_id) this.lib.remove(ref.doc_id);
    const saved = this.lib.add({ title: ref.title, text: body, source: ref.source_url || ref.license });
    if (saved.error) return saved;
    this.sql.exec(`UPDATE kl_refs SET doc_id = ?, access = 'indexed', trust = ?, indexed_at = ?, revision = revision + 1 WHERE id = ?`,
      saved.id, trustOf(ref), now, ref.id);
    return { ...this.get(ref.id), chunks: saved.chunks, chars: saved.chars };
  }

  get(idOrKey, { byKey = false } = {}) {
    if (!this.init()) return null;
    const rows = [...this.sql.exec(`SELECT * FROM kl_refs WHERE ${byKey ? 'key' : 'id'} = ?`, String(idOrKey || ''))];
    return rows[0] || null;
  }

  /** The library's references, newest first, optionally one category. */
  list({ category = '', limit = 200 } = {}) {
    if (!this.init()) return [];
    const rows = category
      ? [...this.sql.exec('SELECT * FROM kl_refs WHERE category = ? ORDER BY added DESC LIMIT ?', category, limit)]
      : [...this.sql.exec('SELECT * FROM kl_refs ORDER BY added DESC LIMIT ?', limit)];
    return rows;
  }

  /** Per category: how many references are indexed and how many are only catalogued. */
  status() {
    const refs = this.list({ limit: 5000 });
    return KNOWLEDGE_CATEGORIES.map((cat) => {
      const mine = refs.filter((r) => r.category === cat.id);
      return { ...cat, indexed: mine.filter((r) => r.access === 'indexed').length, cataloged: mine.filter((r) => r.access === 'cataloged').length };
    });
  }

  /**
   * Retrieval with citations. Only indexed references can answer; a cataloged reference is listed as a lead, never
   * as evidence. Technical questions skip fiction. A category narrows the search.
   */
  search(question, { category = '', technical = true, limit = 5 } = {}) {
    if (!this.init()) return { hits: [], leads: [] };
    const terms = queryTerms(question);
    const byDoc = new Map(this.list({ limit: 5000 }).filter((r) => r.doc_id).map((r) => [r.doc_id, r]));
    const hits = this.lib.search(question, limit * 4)
      .map((hit) => {
        const ref = byDoc.get(hit.doc_id) || null;
        return ref ? { ref, part: hit.part, text: hit.text } : null;
      })
      .filter(Boolean)
      .filter((h) => (!category || h.ref.category === category) && (!technical || TECHNICAL_KINDS.has(h.ref.kind)))
      .slice(0, limit)
      .map((h) => citation(h.ref, h.part, h.text));
    const leads = terms.length
      ? this.list({ limit: 5000 })
        .filter((r) => r.access === 'cataloged' && (!category || r.category === category))
        .filter((r) => terms.some((t) => `${r.title} ${r.topics} ${r.note}`.toLowerCase().includes(t)))
        .slice(0, limit)
        .map((r) => ({ id: r.id, title: r.title, creator: r.creator, category: r.category, access: 'cataloged' }))
      : [];
    return { hits, leads };
  }

  /** The reply for an owner's question: the cited passages, or an honest statement of what is missing. */
  answer(question, opts = {}) {
    const { hits, leads } = this.search(question, opts);
    if (hits.length) {
      return {
        status: 'answered',
        text: hits.map((h) => `${h.citation}\n${h.text}`).join('\n\n'),
        citations: hits.map((h) => h.citation),
      };
    }
    if (leads.length) {
      return {
        status: 'cataloged_only',
        text: `I have ${leads.length === 1 ? 'one reference' : `${leads.length} references`} on this, but ${leads.length === 1 ? 'its text is' : 'their text is'} not indexed, so I have not read it and cannot quote it: ${leads.map((l) => `${l.title}${l.creator ? ` (${l.creator})` : ''}`).join('; ')}.`,
        citations: [],
      };
    }
    return { status: 'not_found', text: 'Nothing in the indexed library answers this, so I have no source for it.', citations: [] };
  }
}

function trustOf(ref) {
  return ref.license === 'owner' ? 'owner_text' : ref.license === 'public_domain' || ref.license === 'cc0' ? 'public_domain' : 'licensed_text';
}

export function citation(ref, part, text) {
  const who = ref.creator ? ` by ${ref.creator}` : '';
  const edition = ref.edition ? `, ${ref.edition}` : '';
  return {
    citation: `[${ref.title}${who}${edition}, part ${part}; ${ref.category}; trust: ${ref.trust}]`,
    title: ref.title,
    creator: ref.creator,
    category: ref.category,
    kind: ref.kind,
    part,
    trust: ref.trust,
    source_url: ref.source_url,
    text: String(text || '').slice(0, 1200),
  };
}
