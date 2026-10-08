// CHE's brain: one store every agent writes to and reads from. Office agents
// are branches of CHE, so a lesson one of them learns is available to all.
// Facts and fixes must carry evidence (a file, line, commit or test result);
// without it the entry is refused, so the brain never stores a guess as fact.
// Storage: the Durable Object's SQLite table when available, otherwise a capped
// list under one key (used by tests and older storage).

const KV_KEY = 'che_brain';
const KV_CAP = 500;
const KINDS = new Set(['lesson', 'technique', 'location', 'mistake', 'fact', 'fix']);
const NEEDS_EVIDENCE = new Set(['fact', 'fix']);
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it', 'be', 'that', 'this', 'with', 'my', 'me', 'i', 'you', 'how', 'what', 'do', 'does', 'was', 'at']);

function sqlOf(storage) {
  return storage?.sql && typeof storage.sql.exec === 'function' ? storage.sql : null;
}

function tokens(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9_.$]+/).filter((w) => w.length > 1 && !STOP.has(w)));
}

function ensureTable(storage) {
  const sql = sqlOf(storage);
  if (!sql) return null;
  sql.exec(`CREATE TABLE IF NOT EXISTS che_brain (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, agent TEXT NOT NULL,
    source TEXT NOT NULL, evidence TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL)`);
  return sql;
}

// Writes one entry. Returns { saved, id } or { saved: false, reason }.
export async function remember(storage, entry = {}) {
  const kind = String(entry.kind || '').trim();
  const text = String(entry.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const evidence = String(entry.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!KINDS.has(kind)) return { saved: false, reason: 'unknown_kind' };
  if (text.length < 4) return { saved: false, reason: 'too_short' };
  if (NEEDS_EVIDENCE.has(kind) && !evidence) return { saved: false, reason: 'evidence_required' };
  const row = {
    id: crypto.randomUUID(), kind, text,
    agent: String(entry.agent || 'CHE').slice(0, 60),
    source: String(entry.source || '').slice(0, 120),
    evidence, reviewed: entry.reviewed === true ? 1 : 0,
    at: new Date().toISOString(),
  };
  const sql = ensureTable(storage);
  if (sql) {
    const dup = [...sql.exec('SELECT id FROM che_brain WHERE kind = ? AND text = ? LIMIT 1', kind, text)];
    if (dup.length) return { saved: false, reason: 'duplicate' };
    sql.exec(
      'INSERT INTO che_brain (id, kind, text, agent, source, evidence, reviewed, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.kind, row.text, row.agent, row.source, row.evidence, row.reviewed, row.at,
    );
    return { saved: true, id: row.id };
  }
  if (typeof storage?.get !== 'function' || typeof storage?.put !== 'function') return { saved: false, reason: 'no_storage' };
  const list = (await storage.get(KV_KEY)) || [];
  if (list.some((item) => item.kind === kind && item.text === text)) return { saved: false, reason: 'duplicate' };
  list.push(row);
  await storage.put(KV_KEY, list.slice(-KV_CAP));
  return { saved: true, id: row.id };
}

async function allEntries(storage) {
  const sql = ensureTable(storage);
  if (sql) return [...sql.exec('SELECT * FROM che_brain ORDER BY at DESC LIMIT 2000')];
  if (typeof storage?.get !== 'function') return [];
  return (await storage.get(KV_KEY)) || [];
}

// Returns the entries that best match the question: the most shared words,
// reviewed entries first on a tie, newest first after that.
export async function recall(storage, query, limit = 8) {
  const words = tokens(query);
  if (!words.size) return [];
  const rows = await allEntries(storage);
  return rows
    .map((r) => {
      const hits = [...tokens(`${r.text} ${r.evidence || ''}`)].filter((w) => words.has(w)).length;
      return { ...r, score: hits + (r.reviewed ? 0.5 : 0) };
    })
    .filter((r) => r.score >= 1)
    .sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

export async function brainSize(storage) {
  return (await allEntries(storage)).length;
}
