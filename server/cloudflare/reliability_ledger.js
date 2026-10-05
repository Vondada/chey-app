// CHE Reliability Ledger: private operational telemetry. It records HOW work
// went (workflow, engines, token estimates, time, failovers, retries,
// recovery classes, test/review/final outcome) and never WHAT was said: no
// prompts, replies, owner content, URLs or secrets. Every field is
// whitelisted, typed and length-limited before it is stored.

const KEY = 'che_reliability_ledger';
const MAX_ROWS = 200;
const KINDS = new Set(['route', 'job', 'retrieval']);
const OUTCOMES = new Set(['completed', 'failed', 'recovered', 'retrying', 'answered_from_memory', 'skipped', 'unknown']);
const ID = /^[a-z0-9][a-z0-9:_.\-/]{0,47}$/i;

const word = (value, allowed, fallback) => (allowed.has(String(value)) ? String(value) : fallback);
const id = (value) => (ID.test(String(value || '')) ? String(value).toLowerCase().slice(0, 48) : '');
const count = (value, max = 1e9) => Math.max(0, Math.min(max, Math.round(Number(value) || 0)));

/** A row with only safe, bounded fields. Anything else in `event` is dropped. */
export function sanitizeEvent(event = {}) {
  const engines = (Array.isArray(event.engines) ? event.engines : [event.engine]).map(id).filter(Boolean).slice(0, 6);
  const classes = (Array.isArray(event.recovery_classes) ? event.recovery_classes : []).map(id).filter(Boolean).slice(0, 6);
  return {
    at: new Date(Number.isFinite(event.now) ? event.now : Date.now()).toISOString(),
    kind: word(event.kind, KINDS, 'route'),
    workflow: id(event.workflow) || 'unknown',
    outcome: word(event.outcome, OUTCOMES, 'unknown'),
    engines,
    est_tokens: count(event.est_tokens),
    tokens_saved: count(event.tokens_saved),
    latency_ms: count(event.latency_ms, 3_600_000),
    failovers: count(event.failovers, 50),
    retries: count(event.retries, 50),
    recovery_classes: classes,
    tests: word(event.tests, new Set(['passed', 'failed', 'not_run']), 'not_run'),
    review: word(event.review, new Set(['approved', 'rejected', 'not_run']), 'not_run'),
    owner_visible_failure: event.owner_visible_failure === true,
  };
}

function emptyTotals() {
  return { routes: 0, jobs_completed: 0, jobs_failed: 0, recoveries: 0, failovers: 0, retries: 0, owner_visible_failures: 0, memory_answers: 0, tokens_saved: 0, est_tokens: 0, since: new Date().toISOString() };
}

async function read(storage) {
  const saved = await storage.get(KEY);
  if (Array.isArray(saved)) return { totals: emptyTotals(), rows: [] }; // early draft format: start clean
  return saved && typeof saved === 'object' && saved.totals ? saved : { totals: emptyTotals(), rows: [] };
}

/** Adds one event (one storage read and one write). Never throws. */
export async function recordReliability(storage, event = {}) {
  if (!storage?.get || !storage?.put) return null;
  try {
    const row = sanitizeEvent(event);
    // Several engine calls can run in parallel inside one request: update
    // inside a storage transaction when available so no count is lost.
    if (typeof storage.transaction === 'function') {
      await storage.transaction(async (txn) => { await apply(txn, row); });
      return row;
    }
    await apply(storage, row);
    return row;
  } catch (_) {
    return null; // telemetry never breaks owner work
  }
}

async function apply(storage, row) {
  {
    const ledger = await read(storage);
    const t = { ...emptyTotals(), ...ledger.totals };
    if (row.kind === 'route') t.routes += 1;
    if (row.kind === 'job' && ['completed', 'recovered'].includes(row.outcome)) t.jobs_completed += 1;
    if (row.kind === 'job' && row.outcome === 'failed') t.jobs_failed += 1;
    if (row.outcome === 'recovered' || (row.outcome === 'completed' && (row.failovers || row.retries))) t.recoveries += 1;
    if (row.outcome === 'answered_from_memory') t.memory_answers += 1;
    t.failovers += row.failovers;
    t.retries += row.retries;
    t.tokens_saved += row.tokens_saved;
    t.est_tokens += row.est_tokens;
    if (row.owner_visible_failure) t.owner_visible_failures += 1;
    await storage.put(KEY, { totals: t, rows: [row, ...ledger.rows].slice(0, MAX_ROWS) });
  }
}

export async function reliabilitySummary(storage) {
  if (!storage?.get) return emptyTotals();
  try { return { ...emptyTotals(), ...(await read(storage)).totals }; } catch (_) { return emptyTotals(); }
}

/** "47 jobs completed • 6 automatic recoveries • ..." for voice and screen. */
export function speakReliability(t) {
  const n = (x) => Number(x || 0).toLocaleString('en-US');
  return [
    `${n(t.jobs_completed)} jobs completed`,
    `${n(t.recoveries)} automatic recoveries`,
    `${n(t.failovers)} provider failovers`,
    `${n(t.owner_visible_failures)} owner-visible failures`,
    `${n(t.memory_answers)} answers from memory with no AI call`,
    `about ${n(t.tokens_saved)} tokens saved through retrieval and cache`,
  ].join(' • ');
}

// "how reliable have you been", "reliability report", "reliability ledger".
export function reliabilityIntent(message) {
  return /\b(?:reliability (?:report|ledger|stats|summary)|how reliable (?:have you been|are you)|your (?:uptime|track record))\b/i.test(String(message || ''));
}
