// Every page CHE reads while researching is kept in the Brain for another day, as a research lead. It is
// never presented as an answer on its own: a research record says where it came from and that it is unverified,
// and a page she used to answer is cited in that answer. Unsafe text (secrets) is never stored.
import { BRAIN_REGIONS, fnv1a32, isSafeText } from './brain_store.js';
import { linkRelated } from './brain_rooms.js';

export const RESEARCH_PATH = 'Research/Pages';
const MAX_BODY = 1500;

/**
 * Stores each page the loop actually read. Returns what was kept and what was skipped, with the reason.
 * store: a CheBrainStore. observations: the loop's observations (only read pages count).
 */
export function storeLoopReads(store, { question = '', observations = [], now = new Date().toISOString() } = {}) {
  const kept = [];
  const skipped = [];
  for (const o of observations) {
    if (!o?.read || !o.ok || !o.url) continue;
    const body = String(o.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_BODY);
    if (!body) { skipped.push({ url: o.url, reason: 'no text was read' }); continue; }
    if (!isSafeText(body)) { skipped.push({ url: o.url, reason: 'the page held text that must not be stored' }); continue; }
    const id = `web:${fnv1a32(`${o.url}|${body.slice(0, 300)}`)}`;
    const record = {
      id, kind: 'research', region: BRAIN_REGIONS.learned, path: RESEARCH_PATH,
      title: `Page: ${String(o.url).slice(0, 160)}`,
      body: `Question: ${String(question).slice(0, 300)}\n\n${body}`,
      verification: 'unverified_research_lead',
      source: { kind: 'web_read', url: String(o.url), question: String(question).slice(0, 300), retrieved_at: now },
      links: [], created_at: now,
    };
    const result = store.apply({ op_id: `research-${id}`, type: 'put', record }, { origin: 'cloud', now });
    if (result?.outcome === 'rejected') { skipped.push({ url: o.url, reason: result.reason || 'the Brain did not accept it' }); continue; }
    // Linked as it is stored: the same people, places, symbols and distinctive words connect it to older pages.
    linkRelated(store, record, { now });
    kept.push({ id, url: o.url });
  }
  return { kept, skipped };
}

function pageView(record) {
  return { id: record.id, url: record.source?.url || '', title: record.title || '', read_at: record.source?.retrieved_at || record.created_at || '' };
}

/**
 * The research pages kept in the Brain, newest first. Pages are kept until the owner asks for one to be deleted;
 * nothing expires them.
 */
export function listResearchPages(store, { limit = 50 } = {}) {
  const { records, more } = store.list({ region: BRAIN_REGIONS.learned, path: RESEARCH_PATH, limit });
  return { pages: records.map(pageView), more };
}

/**
 * Deletes the named research pages. Only research pages are deleted: any other id is reported as missing, never removed.
 * Call this only after the owner has said yes to a delete (see browse_chat.js).
 */
export function forgetResearchPages(store, ids = [], { now = new Date().toISOString() } = {}) {
  const deleted = [];
  const missing = [];
  for (const id of [...new Set(ids.map((x) => String(x)))]) {
    const record = store.get(id);
    if (!record || record.path !== RESEARCH_PATH) { missing.push(id); continue; }
    store.delete(id, { origin: 'owner', now });
    deleted.push(id);
  }
  return { deleted, missing };
}
