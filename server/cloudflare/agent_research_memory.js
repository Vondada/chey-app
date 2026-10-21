// Every page CHE reads while researching is kept in the Brain for another day, as a research lead. It is
// never presented as an answer on its own: a research record says where it came from and that it is unverified,
// and a page she used to answer is cited in that answer. Unsafe text (secrets) is never stored.
import { BRAIN_REGIONS, fnv1a32, isSafeText } from './brain_store.js';

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
    kept.push({ id, url: o.url });
  }
  return { kept, skipped };
}
