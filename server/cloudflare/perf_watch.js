// Performance watch (owner, 2026-10-22: "she's lagging... make sure every time we add more features she can look out
// for that, tell me, and prevent it"). The Worker keeps a short window of real handler timings per route, compares the
// p95 against the budgets in tools/che_perf_budget.json, and reports a status the app shows as one quiet line. CHE never
// speaks it by herself; she answers "are you lagging?" or /performance with the measured numbers.
//
// Timings only: a route name and milliseconds. No message text, no owner data.

export const PERF_KEY = 'che:perf_watch_v1';
const WINDOW = 60;
const FLUSH_MS = 60_000;

// Budgets for the live watch. CI holds the same file's local budgets (perf_budget.test.mjs); these are the production ones.
export const RUNTIME_BUDGET = Object.freeze({ min_samples: 10, chat_deterministic_p95_ms: 1500, get_p95_ms: 800 });

const STATE = new WeakMap();

function memory(storage) {
  let m = STATE.get(storage);
  if (!m) { m = { routes: null, loaded: false, flushedAt: 0, dirty: false }; STATE.set(storage, m); }
  return m;
}

async function load(storage) {
  const m = memory(storage);
  if (m.loaded) return m;
  let saved = null;
  try { saved = await storage.get(PERF_KEY); } catch (_) { saved = null; }
  m.routes = saved && typeof saved.routes === 'object' ? saved.routes : {};
  m.loaded = true;
  return m;
}

/** The route a request is measured under: chat turns split by whether a model answered; GETs by path. */
export function routeKey(method, path, { modelCalls = null } = {}) {
  if (method === 'POST' && path === '/api/chat') return modelCalls === 0 ? 'chat:deterministic' : modelCalls > 0 ? 'chat:model' : 'chat:unknown';
  if (method === 'GET' && /^\/api\//.test(path)) return `GET ${path}`;
  return '';
}

/**
 * Records one request's timings: total and per stage (handler, finishing). Flushes to storage at most once a minute,
 * so measuring never adds a write to every request.
 */
export async function recordTiming(storage, key, { total = 0, stages = {} } = {}, now = Date.now()) {
  if (!storage || !key) return;
  const m = await load(storage);
  const r = m.routes[key] || (m.routes[key] = { samples: [], stages: {} });
  r.samples.push(Math.round(total));
  if (r.samples.length > WINDOW) r.samples.splice(0, r.samples.length - WINDOW);
  for (const [name, ms] of Object.entries(stages)) {
    const s = r.stages[name] || (r.stages[name] = []);
    s.push(Math.round(ms));
    if (s.length > WINDOW) s.splice(0, s.length - WINDOW);
  }
  r.at = new Date(now).toISOString();
  m.dirty = true;
  if (now - m.flushedAt >= FLUSH_MS) {
    m.flushedAt = now;
    m.dirty = false;
    try { await storage.put(PERF_KEY, { routes: m.routes, at: new Date(now).toISOString() }); } catch (_) { m.dirty = true; }
  }
}

function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function budgetFor(key, budget) {
  if (key === 'chat:deterministic') return budget.chat_deterministic_p95_ms;
  if (key.startsWith('GET ')) return budget.get_p95_ms;
  return null; // a model's own reply time is the provider's, not CHE's; it is shown, never judged against a budget
}

/** p50/p95 per route, which are over budget, and the slowest stage of each. Read from what was measured, never estimated. */
export async function performanceReport(storage, budget = RUNTIME_BUDGET) {
  const m = await load(storage);
  const routes = Object.entries(m.routes || {}).map(([key, r]) => {
    const limit = budgetFor(key, budget);
    const p95 = pct(r.samples, 0.95);
    const stages = Object.entries(r.stages || {}).map(([name, s]) => ({ name, p50: pct(s, 0.5), p95: pct(s, 0.95) })).sort((a, b) => (b.p95 || 0) - (a.p95 || 0));
    const enough = r.samples.length >= budget.min_samples;
    return { route: key, samples: r.samples.length, p50: pct(r.samples, 0.5), p95, budget_ms: limit, over: Boolean(limit && enough && p95 > limit), slowest_stage: stages[0] || null, stages, at: r.at || null };
  }).sort((a, b) => (b.p95 || 0) - (a.p95 || 0));
  const over = routes.filter((r) => r.over);
  return { status: over.length ? 'slow' : 'ok', over: over.map((r) => r.route), routes, budget };
}

/** The one quiet line the app shows (and nothing when CHE is within budget). Changes only when the status does. */
export function performanceBanner(report) {
  if (!report || report.status !== 'slow') return { status: 'ok' };
  const worst = report.routes.find((r) => r.over);
  const name = worst.route === 'chat:deterministic' ? 'replies' : worst.route.replace(/^GET \/api\//, '').replace(/\//g, ' ');
  return { status: 'slow', note: `CHE is slower than her budget on ${name}. Ask "performance report" for the numbers.` };
}

/** Spoken or typed answer to "are you lagging?" / /performance, from the measured window. */
export function speakPerformance(report) {
  const measured = report.routes.filter((r) => r.samples);
  if (!measured.length) return 'I have no timings recorded yet, sir. I measure each request as it happens, so ask again after a few.';
  const fmt = (r) => {
    const label = r.route === 'chat:deterministic' ? 'replies I answer myself' : r.route === 'chat:model' ? 'replies that use a model' : r.route.replace(/^GET \/api\//, '').replace(/\//g, ' ');
    const stage = r.slowest_stage ? `, slowest step ${r.slowest_stage.name} at ${r.slowest_stage.p95} ms` : '';
    return `${label}: typical ${r.p50} ms, slowest 5 percent ${r.p95} ms over ${r.samples} requests${r.budget_ms ? ` (budget ${r.budget_ms} ms)` : ''}${stage}`;
  };
  const head = report.status === 'slow'
    ? `Yes, sir: ${report.over.length === 1 ? 'one part is' : `${report.over.length} parts are`} over budget.`
    : 'No, sir: everything I measure is within budget.';
  const model = measured.find((r) => r.route === 'chat:model');
  const modelNote = model ? ' Model replies also wait on the AI provider, which I show but do not count against my budget.' : '';
  return `${head} ${measured.slice(0, 4).map(fmt).join('. ')}.${modelNote}`;
}

/** "are you lagging", "why are you slow", "performance report", "how fast are you". */
export function performanceIntent(message = '') {
  const t = String(message || '').trim().toLowerCase().replace(/^(?:che|chay|chey)[,\s]+/, '').replace(/[?.!]+$/, '');
  return /^(?:are you (?:lagging|slow|running slow)|why are you (?:so )?(?:slow|lagging|laggy)|(?:give me (?:a |your )?|show (?:me )?(?:your )?)?performance(?: report| status)?|how fast are you(?: running)?|are you running slow|is (?:che|the app) (?:lagging|slow))$/.test(t);
}
