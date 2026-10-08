// CHE's brain, in scopes. Every office agent (Nova, Atlas, Mira, Knox, Sage,
// Lyra, Iris) has its own brain, scope "agent:<name>", for what it learns in its
// own work. CHE's shared brain, scope "shared", is the one every agent reads.
// An agent entry moves into the shared brain only when promoted, and only with
// evidence or a review. Facts and fixes always need evidence.
// Storage: the Durable Object's SQLite table when available, otherwise a capped
// list under one key (used by tests and older storage).

const KV_KEY = 'che_brain';
const KV_CAP = 800;
const SHARED = 'shared';
const KINDS = new Set(['lesson', 'technique', 'location', 'mistake', 'fact', 'fix']);
const NEEDS_EVIDENCE = new Set(['fact', 'fix']);
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it', 'be', 'that', 'this', 'with', 'my', 'me', 'i', 'you', 'how', 'what', 'do', 'does', 'was', 'at']);

function sqlOf(storage) {
  return storage?.sql && typeof storage.sql.exec === 'function' ? storage.sql : null;
}

function tokens(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9_.$]+/).filter((w) => w.length > 1 && !STOP.has(w)));
}

export function agentScope(agent) {
  const name = String(agent || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return name ? `agent:${name}` : '';
}

function ensureTable(storage) {
  const sql = sqlOf(storage);
  if (!sql) return null;
  sql.exec(`CREATE TABLE IF NOT EXISTS che_brain (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
    agent TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT NOT NULL,
    reviewed INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL)`);
  return sql;
}

async function readAll(storage) {
  const sql = ensureTable(storage);
  if (sql) return [...sql.exec('SELECT * FROM che_brain ORDER BY at DESC LIMIT 4000')];
  if (typeof storage?.get !== 'function') return [];
  return (await storage.get(KV_KEY)) || [];
}

async function writeRow(storage, row) {
  const sql = ensureTable(storage);
  if (sql) {
    const dup = [...sql.exec('SELECT id FROM che_brain WHERE scope = ? AND kind = ? AND text = ? LIMIT 1', row.scope, row.kind, row.text)];
    if (dup.length) return { saved: false, reason: 'duplicate' };
    sql.exec(
      'INSERT INTO che_brain (id, scope, kind, text, agent, source, evidence, reviewed, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.scope, row.kind, row.text, row.agent, row.source, row.evidence, row.reviewed, row.at,
    );
    return { saved: true, id: row.id };
  }
  if (typeof storage?.get !== 'function' || typeof storage?.put !== 'function') return { saved: false, reason: 'no_storage' };
  const list = await readAll(storage);
  if (list.some((item) => item.scope === row.scope && item.kind === row.kind && item.text === row.text)) return { saved: false, reason: 'duplicate' };
  list.push(row);
  await storage.put(KV_KEY, list.slice(-KV_CAP));
  return { saved: true, id: row.id };
}

// Writes one entry into an agent's own brain (entry.agent) or the shared brain
// (entry.scope === 'shared'). Returns { saved, id } or { saved: false, reason }.
export async function remember(storage, entry = {}) {
  const kind = String(entry.kind || '').trim();
  const text = String(entry.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const evidence = String(entry.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!KINDS.has(kind)) return { saved: false, reason: 'unknown_kind' };
  if (text.length < 4) return { saved: false, reason: 'too_short' };
  if (NEEDS_EVIDENCE.has(kind) && !evidence) return { saved: false, reason: 'evidence_required' };
  const scope = entry.scope === SHARED ? SHARED : agentScope(entry.agent || 'CHE');
  if (!scope) return { saved: false, reason: 'no_agent' };
  const row = {
    id: crypto.randomUUID(), scope, kind, text,
    agent: String(entry.agent || 'CHE').slice(0, 60),
    source: String(entry.source || '').slice(0, 120),
    evidence, reviewed: entry.reviewed === true ? 1 : 0,
    at: new Date().toISOString(),
  };
  return writeRow(storage, row);
}

// Copies an agent's entry into the shared brain. Refused unless the entry has
// evidence or was reviewed, so the shared brain only gets checked knowledge.
export async function promote(storage, agent, id) {
  const scope = agentScope(agent);
  const rows = (await readAll(storage)).filter((r) => r.id === id && r.scope === scope);
  if (!rows.length) return { promoted: false, reason: 'not_found' };
  const r = rows[0];
  if (!r.evidence && !r.reviewed) return { promoted: false, reason: 'needs_evidence_or_review' };
  const result = await writeRow(storage, { ...r, id: crypto.randomUUID(), scope: SHARED, agent: r.agent, at: new Date().toISOString() });
  return result.saved ? { promoted: true, id: result.id } : { promoted: false, reason: result.reason };
}

// Returns the entries a question matches: the agent's own brain and the shared
// brain. Most shared words first; reviewed entries and the agent's own entries
// win ties; newest after that.
export async function recall(storage, query, { agent = '', limit = 8 } = {}) {
  const words = tokens(query);
  if (!words.size) return [];
  const own = agentScope(agent);
  const rows = (await readAll(storage)).filter((r) => r.scope === SHARED || (own && r.scope === own));
  return rows
    .map((r) => {
      const hits = [...tokens(`${r.text} ${r.evidence || ''}`)].filter((w) => words.has(w)).length;
      return { ...r, score: hits + (r.reviewed ? 0.5 : 0) + (own && r.scope === own ? 0.25 : 0) };
    })
    .filter((r) => r.score >= 1)
    .sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

export async function brainSize(storage, scope = null) {
  const rows = await readAll(storage);
  return scope ? rows.filter((r) => r.scope === scope).length : rows.length;
}
