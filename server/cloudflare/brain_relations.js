// Relationship discovery for the Brain (owner, 2026-10-20). Title words alone missed most real
// connections: a deploy receipt and the screenshot of the same pull request share no title word, and
// an REA investigation of a repository never names the coding job that changed it. Records are now
// related by what they actually share, in this order of strength:
//   1. the same exact reference: a pull request, a commit, a coding job, an REA investigation, a
//      repository, a file, an npm package, a trade record set or a market symbol (derived: both
//      records name it, so the link is checkable by reading them);
//   2. distinctive words in the title and body, not only the title (candidate: a likely connection
//      that nobody has checked).
// Every link carries its basis, the shared values and its status, so CHE can say why two records are
// connected and never presents a candidate as a fact. Deterministic: no model call, no network, a
// handful of FTS queries per new record.

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'about', 'what', 'does', 'did', 'know', 'room', 'have', 'any', 'your', 'you', 'che', 'sir', 'into', 'are', 'was', 'were', 'has', 'had', 'not', 'but', 'all', 'one', 'its', 'our', 'out', 'now',
  // Words every room event body carries (status lines, provenance), which say nothing about the subject.
  'status', 'verified', 'observed', 'evidence', 'source', 'recorded', 'read', 'record', 'records', 'none', 'derivation', 'confidence', 'owner', 'needs', 'confirmation', 'before', 'counts', 'fact', 'unknown', 'proposed', 'inferred', 'hypothesis', 'derived',
  'receipt', 'chat', 'brain', 'when', 'then', 'there', 'their', 'they', 'them', 'which', 'will', 'would', 'could', 'should', 'been', 'being', 'also', 'only', 'than', 'more', 'most', 'some', 'such', 'each', 'other', 'after', 'over', 'under', 'just', 'like', 'here', 'where', 'while', 'these', 'those', 'into', 'onto', 'upon', 'very', 'can', 'may', 'new', 'got', 'get', 'set', 'two', 'three']);

// Market symbols CHE trades or studies. A bare capitalised word is never a symbol unless it is listed
// here or written with a dollar sign ($AAPL), so ordinary words in capitals do not link records.
const SYMBOLS = new Set(['MNQ', 'NQ', 'MES', 'ES', 'YM', 'MYM', 'RTY', 'M2K', 'CL', 'MCL', 'GC', 'MGC', 'BTC', 'ETH', 'SPY', 'QQQ', 'IWM', 'DIA', 'VIX', 'TSLA', 'NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL']);

// The trade record sets by the names rooms use for them (trading_ledgers.js LEDGERS ids).
const LEDGER_NAMES = [
  ['strategy_simulation', /\bstrategy\s+simulation\b/i],
  ['forward_paper_journal', /\b(?:forward\s+)?paper\s+journal\b/i],
  ['daily_evidence', /\b(?:daily\s+)?evidence\s+pass\b/i],
  ['lab_paper_book', /\b(?:Trading\s+)?Lab\s+(?:paper\s+)?book\b/i],
  ['broker_alpaca_paper', /\bAlpaca\s+PAPER\b/],
];

// Exact identifiers: two records that name one are about the same thing, whatever else they say.
const IDENTITY = new Set(['pr', 'sha', 'job', 'inv', 'repo', 'file', 'npm']);
// Shared by many records by nature (a symbol, a record set, a website): related only across rooms, and
// dropped when too many records carry it to say anything.
const COMMON_LIMIT = 6;
// "npm install" names a command, not a package.
const NPM_VERBS = new Set(['install', 'i', 'run', 'test', 'ci', 'publish', 'package', 'packages', 'audit', 'update', 'start', 'build', 'exec', 'init', 'pack', 'view', 'outdated']);

export const RELATION_LABEL = Object.freeze({
  pr: 'the same pull request', sha: 'the same commit', job: 'the same coding job', inv: 'the same REA investigation',
  repo: 'the same repository', file: 'the same file', npm: 'the same npm package', symbol: 'the same market symbol',
  ledger: 'the same trade record set', host: 'the same website', terms: 'shared words',
});

/** Bumped when the rules change, so older records are relinked (brain_rooms.relinkRecords). */
export const RELATIONS_VERSION = 1;

const lower = (s) => String(s || '').toLowerCase();
// The subject text of a record: its title and body without the provenance lines room events append.
const subjectText = (record) => `${record?.title || ''}\n${String(record?.body || '').split('\n').filter((line) => !/^(?:Status|Evidence|Derivation|Source room|Needs the owner)\b/.test(line)).join('\n')}`;

/**
 * The exact references a record names, as normalised keys ("pr:374", "repo:vondada/chey-app",
 * "symbol:MNQ"), read from its title, body and source refs. Works on any Brain record and on a question.
 */
export function entitiesOf(recordOrText) {
  const record = typeof recordOrText === 'string' ? { title: recordOrText } : (recordOrText || {});
  const text = subjectText(record);
  const refs = record.source?.refs && typeof record.source.refs === 'object' ? record.source.refs : {};
  const out = new Set();
  const add = (type, value) => { const v = String(value || '').trim(); if (v) out.add(`${type}:${v}`); };

  // "Update #374" is CHE's own name for a pull request; a bare "update 3" is not.
  for (const m of text.matchAll(/\b(?:pull\s+request|PR)\s*#?\s*(\d{1,6})\b|\bupdate\s+#(\d{1,6})\b/gi)) add('pr', Number(m[1] || m[2]));
  if (Number(refs.number) > 0) add('pr', Number(refs.number));
  for (const m of text.matchAll(/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d{1,6})/gi)) add('pr', Number(m[1]));
  // A commit: 7 to 40 hex characters with at least one digit and one letter ("as 92a2432fcbd1").
  for (const m of text.matchAll(/\b(?:commit|sha|as|at|head)\s+`?([0-9a-f]{7,40})`?\b/gi)) {
    if (/\d/.test(m[1]) && /[a-f]/i.test(m[1])) add('sha', lower(m[1]).slice(0, 7));
  }
  if (refs.sha) add('sha', lower(refs.sha).slice(0, 7));
  for (const m of text.matchAll(/\b(?:coding\s+)?job\s+`?([a-z0-9][a-z0-9-]{5,40})`?/gi)) if (/\d/.test(m[1])) add('job', lower(m[1]));
  if (refs.job_id) add('job', lower(refs.job_id));
  for (const m of text.matchAll(/\b(?:investigation|inspection)\s+`?((?:inv|rea|job)[-_][a-z0-9-]{4,40})`?/gi)) add('inv', lower(m[1]));
  if (refs.investigation) add('inv', lower(refs.investigation));
  for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/\s)?#,;]|$)/gi)) add('repo', `${lower(m[1])}/${lower(m[2])}`);
  for (const m of text.matchAll(/\brepo(?:sitory)?\s+`?([A-Za-z0-9][\w.-]*\/[\w.-]+)`?/gi)) add('repo', lower(m[1]).replace(/[.,;]+$/, ''));
  if (refs.repo) add('repo', lower(refs.repo));
  for (const m of text.matchAll(/(?:^|[\s(`'"])((?:[\w-]+\/)*[\w-]+\.(?:js|mjs|ts|dart|swift|py|md|yml|yaml|json|kt|go|rs))\b/g)) add('file', lower(m[1].split('/').pop()));
  for (const m of text.matchAll(/\bnpm[:\s]+(@?[a-z0-9][\w./-]*?)(?:@\d[\w.-]*)?(?=[\s,;)]|$)/gi)) if (!NPM_VERBS.has(lower(m[1]))) add('npm', lower(m[1]));
  if (String(refs.target || '').startsWith('npm:')) add('npm', lower(String(refs.target).slice(4).replace(/@\d[\w.-]*$/, '')));
  for (const m of text.matchAll(/\$([A-Z]{1,5})\b|\b([A-Z][A-Z0-9]{1,4})\b/g)) {
    const sym = m[1] || m[2];
    if (m[1] || SYMBOLS.has(sym)) add('symbol', sym);
  }
  for (const [id, re] of LEDGER_NAMES) if (re.test(text)) add('ledger', id);
  if (refs.ledger) add('ledger', refs.ledger);
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/gi)) if (!/^github\.com$/i.test(m[1])) add('host', lower(m[1]));
  return [...out];
}

/** The words a search for one reference should use (FTS terms are 3+ letters or digits). */
function searchWords(entity) {
  const [type, value] = [entity.slice(0, entity.indexOf(':')), entity.slice(entity.indexOf(':') + 1)];
  if (type === 'pr') return value.length >= 3 ? value : `pull request update ${value}`;
  if (type === 'ledger') return value.replace(/_/g, ' ');
  if (type === 'file') return value.replace(/\.[a-z]+$/, '').replace(/[_-]/g, ' ');
  return value.replace(/[/@._-]+/g, ' ');
}

/** Distinctive words of a record's subject (title and body), for the weaker shared-words basis. */
export function subjectTerms(record) {
  return [...new Set(lower(subjectText(record)).match(/[a-z][a-z0-9']{3,}/g) || [])].filter((t) => !STOP.has(t));
}

/**
 * Candidate relationships for one record: [{ to, type, basis, shared, status, room, region }], strongest
 * first, at most `limit`. `store` is a CheBrainStore (search, get). Nothing is written here.
 */
export function discoverRelations(store, record, { limit = 6 } = {}) {
  if (!store?.search || !record?.id) return [];
  const mine = entitiesOf(record);
  const myRoom = record.source?.room || '';
  const found = new Map();
  const consider = (hit, link) => {
    if (!hit || hit.id === record.id || hit.deleted) return;
    const prev = found.get(hit.id);
    if (prev && prev.strength >= link.strength) { if (link.basis === prev.basis) prev.shared = [...new Set([...prev.shared, ...link.shared])].slice(0, 4); return; }
    found.set(hit.id, { ...link, to: hit.id, room: hit.source?.room || '', region: hit.region, title: hit.title, created_at: hit.created_at });
  };

  // 1. Shared exact references, checked on the hit itself (search only finds the candidates).
  for (const entity of mine.slice(0, 10)) {
    const type = entity.slice(0, entity.indexOf(':'));
    // A commit is named by any length of its hash, so it is searched as a prefix.
    const hits = store.search(searchWords(entity), { limit: 20, prefix: type === 'sha' }).filter((hit) => hit.id !== record.id && !hit.deleted && entitiesOf(hit).includes(entity));
    if (!IDENTITY.has(type) && hits.length > COMMON_LIMIT) continue;
    for (const hit of hits) {
      const hitRoom = hit.source?.room || '';
      if (!IDENTITY.has(type) && hitRoom && hitRoom === myRoom) continue; // a series in one room (every tick names MNQ) is not a relationship
      const sameThread = IDENTITY.has(type) && hitRoom && hitRoom === myRoom && ['pr', 'job', 'inv', 'sha'].includes(type);
      const linkType = sameThread && String(hit.created_at || '') <= String(record.created_at || '') ? 'builds_upon'
        : myRoom === 'screen' || hitRoom === 'screen' ? 'relevant_to' : 'related_to';
      consider(hit, { type: linkType, basis: type, shared: [entity.slice(type.length + 1)], status: 'derived', strength: IDENTITY.has(type) ? 3 : 2 });
    }
  }

  // 2. Distinctive words in title and body: three shared, or two in both titles (the earlier rule).
  const terms = subjectTerms(record);
  const titleTerms = new Set(subjectTerms({ title: record.title }));
  if (terms.length >= 2) {
    const query = [...titleTerms, ...terms.filter((t) => !titleTerms.has(t))].slice(0, 12).join(' ');
    for (const hit of store.search(query, { limit: 12 })) {
      if (hit.id === record.id || hit.deleted || found.get(hit.id)?.strength >= 2) continue;
      const theirs = new Set(subjectTerms(hit));
      const shared = terms.filter((t) => theirs.has(t));
      const sharedTitle = subjectTerms({ title: hit.title }).filter((t) => titleTerms.has(t));
      if (shared.length < 3 && sharedTitle.length < 2) continue;
      consider(hit, { type: 'related_to', basis: 'terms', shared: (sharedTitle.length >= 2 ? sharedTitle : shared).slice(0, 4), status: 'candidate', strength: 1 });
    }
  }

  return [...found.values()]
    .sort((a, b) => b.strength - a.strength || (b.room !== myRoom) - (a.room !== myRoom) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, limit)
    .map(({ strength, title, created_at, ...link }) => link);
}

/** One spoken reason for a link: "the same pull request (#374)", "shared words (deploy, ledger)". */
export function relationReason(link) {
  const shared = (link.shared || []).map((v) => (link.basis === 'pr' ? `#${v}` : v)).join(', ');
  return `${RELATION_LABEL[link.basis] || 'a shared reference'}${shared ? ` (${shared})` : ''}${link.status === 'candidate' ? ', a candidate link' : ''}`;
}

/**
 * Walks the links outward from the given records, up to `depth` steps in either direction (a link and the
 * relations CHE stored on each record), so a question reaches the notes connected to what it matched.
 * Returns [{ record, depth, via: [{ type, from }] }], nearest first, at most `limit` notes. Nothing is written.
 */
export function expandByLinks(store, hits = [], { depth = 2, limit = 20 } = {}) {
  if (!store?.get) return [];
  const seen = new Map();
  let frontier = [];
  for (const hit of hits) {
    if (!hit?.id || hit.deleted || seen.has(hit.id)) continue;
    seen.set(hit.id, { record: hit, depth: 0, via: [] });
    frontier.push(hit.id);
  }
  for (let step = 1; step <= depth && frontier.length && seen.size < limit; step++) {
    const next = [];
    for (const id of frontier) {
      const from = seen.get(id);
      const links = [
        ...(from.record.links || []),
        ...(from.record.source?.relations || []).map((r) => ({ type: r.type, to: r.to })),
        ...(from.record.source?.incoming_candidates || []).map((to) => ({ type: 'candidate', to })),
      ];
      for (const link of links) {
        if (!link?.to || seen.has(link.to) || seen.size >= limit) continue;
        const other = store.get(link.to);
        if (!other || other.deleted) continue;
        seen.set(link.to, { record: other, depth: step, via: [...from.via, { type: link.type, from: id }] });
        next.push(link.to);
      }
    }
    frontier = next;
  }
  return [...seen.values()].sort((a, b) => a.depth - b.depth);
}

/** Every record connected to [id] through links, however far, up to `limit`. Records that link together form one cluster. */
export function clusterOf(store, id, { limit = 200 } = {}) {
  const start = store?.get?.(id);
  if (!start || start.deleted) return [];
  return expandByLinks(store, [start], { depth: 50, limit }).map((item) => item.record);
}
