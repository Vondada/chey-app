// CHE Strategy Library (owner, 2026-10-23): "I want to see every strategy CHE knows, every strategy she
// can actually execute, and every strategy she's actively testing. I also want to add more without
// rebuilding the app each time."
//
// One registry over everything that defines a strategy or a market-context model:
//   - the research engine's written rules (trading_research.strategyDefinitions → trading_evidence.js),
//   - the minute-bar simulator (strategy_sim.SIM_STRATEGIES) and the daily lab (trading_lab.STRATEGIES),
//   - names with no written rules (trading_research.UNDEFINED_STRATEGIES and the named-only seeds),
//   - entries other lanes register (library_seeds/*.js) and the owner's own (stored here, versioned).
//
// Lifecycle (owner, 2026-10-23), from evidence only, never from a caller's say-so:
//   DISCOVERED → RULES DOCUMENTED → IMPLEMENTED → BACKTESTED → FORWARD TESTED → PAPER ACTIVE
// Live status (watching, forming, triggered, …) is separate and comes from the phone's setup engine.
//
// Executable custom strategies are `che.strategy/1` documents (lib/trading/che_strategy_dsl.dart is the
// evaluator; this file only checks their shape). A new or edited one waits for the owner's explicit yes
// before it can paper trade. Nothing here places an order: live trading stays off.

import { INTRADAY_CANDIDATES, CANDIDATES, MIN_TRADES } from './trading_evidence.js';
import { UNDEFINED_STRATEGIES, forwardEvidence, readUnits, strategyDefinitions } from './trading_research.js';
import { SIM_STRATEGIES } from './strategy_sim.js';
import { STRATEGIES as LAB_STRATEGIES } from './trading_lab.js';
import { LIBRARY_SEEDS } from './library_seeds/index.js';

export const SCHEMA = 'che.strategy/1';
export const ENTRY_SCHEMA = 'che.library_entry/1';
export const KINDS = Object.freeze(['strategy', 'market_context']);
export const LIFECYCLE = Object.freeze(['discovered', 'rules_documented', 'implemented', 'backtested', 'forward_tested', 'paper_active']);
export const LIFECYCLE_LABEL = Object.freeze({
  discovered: 'DISCOVERED', rules_documented: 'RULES DOCUMENTED', implemented: 'IMPLEMENTED',
  backtested: 'BACKTESTED', forward_tested: 'FORWARD TESTED', paper_active: 'PAPER ACTIVE',
});
export const CATEGORIES = Object.freeze(['trend', 'momentum', 'breakout', 'reversal', 'scalping', 'price_action', 'ict_smc', 'volatility', 'volume', 'other']);
export const SOURCE_TYPES = Object.freeze(['name', 'description', 'tradingview', 'authorized_script', 'research_paper', 'news', 'economic_calendar', 'market_event', 'repo_code', 'owner', 'book', 'website']);
export const ENGINES = Object.freeze(['trading_evidence', 'strategy_sim', 'trading_lab', 'dsl', 'none']);

/** Resource limits for evaluating many strategies at once (enforced on the phone and here). */
export const BUDGET = Object.freeze({
  max_active: 60,                 // strategies the phone evaluates per candle; the rest wait as "paused: budget"
  per_candle_ms: 250,             // evaluation time per candle for all active strategies together
  model_calls_per_candle: 0,      // evaluation never calls a model
  model_drafts_per_day: 10,       // plain-language drafting is the only model use
  max_paper_per_strategy_day: 5,  // a strategy's own cap may be lower, never higher
  max_paper_global_day: 60,       // across every strategy
  max_open_per_symbol: 1,         // overtrading guard: one CHE paper position per symbol
  max_entries: 2000,              // registry size
});

const ENTRY_PREFIX = 'stratlib:entry:';
const INDEX_KEY = 'stratlib:index';
const AUDIT_SEQ = 'stratlib:audit_seq';
const AUDIT_PREFIX = 'stratlib:audit:';
const DRAFTS_KEY = 'stratlib:drafts_day';
const MAX_VERSIONS = 20;
const MAX_DOC_BYTES = 24_000;

const ICT_FAMILY = (f) => /ict/i.test(f || '');
const categoryOfFamily = (family, name = '') => {
  const f = `${family} ${name}`.toLowerCase();
  if (/ict|smc|order block|fair value|sweep|silver bullet/.test(f)) return 'ict_smc';
  if (/opening range|breakout|channel|inside bar/.test(f)) return 'breakout';
  if (/mean reversion|reversal|revert|dip|rsi/.test(f)) return 'reversal';
  if (/momentum|cross|displacement/.test(f)) return 'momentum';
  if (/trend|pullback|ema/.test(f)) return 'trend';
  if (/vwap|volume/.test(f)) return 'volume';
  return 'other';
};

// ─── Shape checks (the full validator is the Dart evaluator's; this refuses what must never be stored) ──

const FORBIDDEN_KEYS = new Set(['ahead', 'future', 'offset', 'code', 'script', 'eval', 'js', 'pine', 'url', 'fetch', 'import']);

/** Problems with a `che.strategy/1` document's shape. Empty means it may be stored for the phone to validate fully. */
export function definitionProblems(doc) {
  const out = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['the definition must be a JSON object'];
  const bytes = JSON.stringify(doc).length;
  if (bytes > MAX_DOC_BYTES) out.push(`definition is ${bytes} bytes; the limit is ${MAX_DOC_BYTES}`);
  if (doc.schema !== SCHEMA) out.push(`schema must be "${SCHEMA}"`);
  if (typeof doc.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(doc.id)) out.push('id: lowercase letters, digits and dashes, 2–64 characters');
  if (typeof doc.name !== 'string' || !doc.name.trim()) out.push('name is required');
  if (!CATEGORIES.includes(doc.category)) out.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if (!Array.isArray(doc.timeframes) || !doc.timeframes.length || doc.timeframes.some((t) => !Number.isInteger(t) || t < 1 || t > 1440)) out.push('timeframes: bar sizes in minutes, e.g. [1, 5]');
  if (!doc.long && !doc.short) out.push('at least one of "long" or "short" is required');
  for (const side of ['long', 'short']) {
    const s = doc[side];
    if (s == null) continue;
    if (!Array.isArray(s.conditions) || !s.conditions.length) out.push(`${side}.conditions: at least one condition is required`);
    if (s.stop == null) out.push(`${side}.stop: a stop is required`);
    if (s.target == null) out.push(`${side}.target: a target is required`);
  }
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k)) out.push(`${path}.${k}: unsupported construct "${k}" (no code, no network, no look-ahead)`);
        if (k === 'ago' && !(Number.isInteger(x) && x >= 0)) out.push(`${path}.ago: look-ahead is not allowed ("ago" is 0 or more bars back)`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(doc, '$');
  return out;
}

function sourceProblems(sources) {
  const out = [];
  if (!Array.isArray(sources) || !sources.length) return ['at least one source is required (where the idea or rules came from)'];
  sources.forEach((s, i) => {
    if (!s || !SOURCE_TYPES.includes(s.type)) out.push(`sources[${i}].type must be one of ${SOURCE_TYPES.join(', ')}`);
    if (!s?.title && !s?.url) out.push(`sources[${i}] needs a title or a url`);
    if (s?.url && !/^https:\/\//.test(s.url)) out.push(`sources[${i}].url must be https`);
    // Never copy protected code: a TradingView or other third-party script is referenced by link and described, not stored.
    if (s && ('code' in s || 'source_code' in s || 'script' in s)) out.push(`sources[${i}]: script code is never stored; link to it and describe it`);
    if (s?.type === 'authorized_script' && !s.license) out.push(`sources[${i}].license: an authorized script names its license or permission`);
  });
  return out;
}

/** Problems with a library entry. Empty means it can be registered. */
export function entryProblems(e) {
  const out = [];
  if (!e || typeof e !== 'object') return ['an entry object is required'];
  if (typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9:-]{1,79}$/.test(e.id)) out.push('id: lowercase letters, digits, dashes and colons, 2–80 characters');
  if (!KINDS.includes(e.kind)) out.push(`kind must be ${KINDS.join(' or ')}`);
  if (typeof e.name !== 'string' || !e.name.trim()) out.push('name is required');
  if (!CATEGORIES.includes(e.category)) out.push(`category must be one of ${CATEGORIES.join(', ')}`);
  out.push(...sourceProblems(e.sources));
  if (e.definition != null) {
    if (e.kind !== 'strategy') out.push('only a strategy carries an executable definition');
    out.push(...definitionProblems(e.definition).map((p) => `definition: ${p}`));
    if (e.definition?.id && e.definition.id !== e.id.replace(/^[a-z0-9-]+:/, '') && e.definition.id !== e.id) out.push('definition.id must match the entry id');
  }
  for (const k of ['rules', 'assumptions', 'limitations', 'data_requirements', 'event_dependencies']) {
    if (e[k] != null && !Array.isArray(e[k])) out.push(`${k} must be a list of sentences`);
  }
  if (e.lifecycle_requested != null && !LIFECYCLE.includes(e.lifecycle_requested)) out.push(`lifecycle_requested must be one of ${LIFECYCLE.join(', ')}`);
  return out;
}

// ─── Lifecycle from evidence ───────────────────────────────────────────────────

/**
 * The highest stage the entry's evidence supports. A request can lower it (a lane documenting rules it has
 * not implemented), never raise it.
 *   rules_documented: written rules or documented assumptions, with a source
 *   implemented:      an engine runs it (a built-in engine, or a stored definition)
 *   backtested:       recorded backtest trades from the harness
 *   forward_tested:   at least MIN_TRADES forward paper trades after the backtest
 *   paper_active:     approved by the owner, enabled, and running in paper now
 */
export function lifecycleOf(e, { running = false } = {}) {
  const has = (k) => Array.isArray(e[k]) && e[k].length > 0;
  const steps = ['discovered'];
  if (has('rules') || has('assumptions')) steps.push('rules_documented');
  if (steps.includes('rules_documented') && (e.engine && e.engine !== 'none')) steps.push('implemented');
  if (steps.includes('implemented') && (e.results?.backtest?.trades || 0) > 0) steps.push('backtested');
  if (steps.includes('backtested') && (e.results?.forward?.trades || 0) >= MIN_TRADES) steps.push('forward_tested');
  if (steps.includes('implemented') && running && e.approval?.state === 'approved' && e.enabled !== false) steps.push('paper_active');
  let stage = steps.at(-1);
  if (e.lifecycle_requested && LIFECYCLE.indexOf(e.lifecycle_requested) < LIFECYCLE.indexOf(stage)) stage = e.lifecycle_requested;
  return stage;
}

/** Why an entry is not paper trading right now, in plain words (null when it is). */
export function notRunningReason(e, stage) {
  if (stage === 'paper_active') return null;
  if (e.engine === 'dsl' && e.approval?.state !== 'approved') return 'Waiting for the owner\'s approval before it may paper trade.';
  if (e.enabled === false) return 'Disabled by the owner.';
  if (stage === 'discovered') return 'Only a name or idea: no written rules exist in CHE yet, so it cannot be tested.';
  if (stage === 'rules_documented') return 'Rules are written down but no engine runs them yet.';
  if (e.kind === 'market_context') return 'A market-context model describes conditions; it does not place paper trades by itself.';
  if (e.engine === 'strategy_sim' || e.engine === 'trading_lab') return 'Runs in its own simulator or lab, not in the forward paper engine.';
  if (stage === 'implemented') return 'Implemented but not backtested yet.';
  return 'Not enabled for forward paper testing.';
}

// ─── Built-in entries (from the code that runs them) ───────────────────────────

const repo = (file, what) => ({ type: 'repo_code', title: `${file}: ${what}`, file });

export function builtinEntries() {
  const out = [];
  for (const d of strategyDefinitions()) {
    const intraday = Boolean(INTRADAY_CANDIDATES[d.strategy_id]);
    out.push({
      id: d.strategy_id, kind: 'strategy', name: intraday ? d.name : d.name, category: categoryOfFamily(d.family, d.name), family: d.family,
      engine: 'trading_evidence', builtin: true, ict: ICT_FAMILY(d.family),
      sources: [repo('server/cloudflare/trading_evidence.js', intraday ? `INTRADAY_CANDIDATES["${d.strategy_id}"]` : `CANDIDATES["${d.strategy_id}"]`)],
      rules: [d.entry_rule, `Stop: ${d.stop_rule}.`, `Target: ${d.target_rule}.`, `Exit: ${d.exit_rule}.`, ...(d.time_filter && d.time_filter !== 'none' ? [`Time filter: ${d.time_filter}.`] : [])],
      assumptions: [d.common_rules || '', `Costs: ${JSON.stringify(d.cost_assumptions)}`].filter(Boolean),
      timeframes: d.timeframes, data_requirements: [d.data_requirements], event_dependencies: [],
      limitations: intraday ? ['Research bars are delayed public data (Yahoo), not exchange-direct.'] : ['Daily bars only; long side only.'],
      symbols: d.markets,
    });
  }
  for (const s of SIM_STRATEGIES) {
    out.push({
      id: `sim:${s.id.replace(/\|/g, '-').replace(/\./g, '_')}`, kind: 'strategy', name: `${s.name} (simulator, ${s.target_r}R)`, category: categoryOfFamily(s.family, s.name), family: s.family,
      engine: 'strategy_sim', builtin: true, sources: [repo('server/cloudflare/strategy_sim.js', `SIM_STRATEGIES "${s.id}"`)],
      rules: [s.name, `Trend filter: ${s.trend_filter}. Target ${s.target_r}R.`], timeframes: ['1m'], data_requirements: ['minute bars (Yahoo, delayed)'], event_dependencies: [],
      limitations: ['Minute-bar simulator, paper only; separate from the forward paper engine.'], symbols: ['MNQ'],
    });
  }
  for (const [id, s] of Object.entries(LAB_STRATEGIES)) {
    out.push({
      id: `lab:${id}`, kind: 'strategy', name: `${s.name} (trading lab)`, category: categoryOfFamily('', s.name), engine: 'trading_lab', builtin: true,
      sources: [repo('server/cloudflare/trading_lab.js', `STRATEGIES["${id}"]`)], rules: [s.about || s.name], timeframes: ['1D'],
      data_requirements: ['daily bars (Stooq or Binance)'], event_dependencies: [], limitations: ['Daily lab backtests on request; not forward tested.'], symbols: ['NQ', 'ES'],
    });
  }
  for (const u of UNDEFINED_STRATEGIES) {
    out.push({ id: u.strategy_id, kind: 'strategy', name: u.name, category: /ict/i.test(u.name) ? 'ict_smc' : 'other', engine: 'none', builtin: true,
      sources: [repo('server/cloudflare/trading_research.js', 'UNDEFINED_STRATEGIES')], rules: [], assumptions: [], limitations: [u.why], timeframes: [], data_requirements: [], event_dependencies: [] });
  }
  return out;
}

// ─── Storage: one key per entry, append-only audit ─────────────────────────────

async function readIndex(storage) { return (await storage.get(INDEX_KEY)) || []; }

export async function audit(storage, record, now = Date.now()) {
  const seq = ((await storage.get(AUDIT_SEQ)) || 0) + 1;
  const row = { seq, at: new Date(now).toISOString(), ...record };
  await storage.put(`${AUDIT_PREFIX}${String(seq).padStart(9, '0')}`, row);
  await storage.put(AUDIT_SEQ, seq);
  return row;
}

export async function readAudit(storage, { limit = 100 } = {}) {
  const seq = (await storage.get(AUDIT_SEQ)) || 0;
  const rows = [];
  for (let s = seq; s > 0 && rows.length < limit; s--) {
    const r = await storage.get(`${AUDIT_PREFIX}${String(s).padStart(9, '0')}`);
    if (r) rows.push(r);
  }
  return rows;
}

/** The stored state of a code entry that the owner has not changed yet. */
function blankRecord(id, code) {
  const dsl = code.engine === 'dsl';
  return { id, versions: [], current: 0, favorite: false, enabled: Boolean(code.engine && code.engine !== 'none' && !dsl), approval: dsl ? { state: 'pending_owner', version: 0 } : { state: 'not_needed' }, results: {} };
}

async function readStored(storage, id) { return (await storage.get(`${ENTRY_PREFIX}${id}`)) || null; }

async function writeStored(storage, rec) {
  await storage.put(`${ENTRY_PREFIX}${rec.id}`, rec);
  const idx = await readIndex(storage);
  if (!idx.includes(rec.id)) { idx.push(rec.id); await storage.put(INDEX_KEY, idx); }
}

/** Seeds and built-ins are code; what the owner changes about them (enabled, favorite, approval) is stored. */
function codeEntries() {
  const seen = new Set();
  const out = [];
  for (const e of [...builtinEntries(), ...LIBRARY_SEEDS]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({ ...e, engine: e.definition ? 'dsl' : (e.engine || 'none'), origin: e.builtin ? 'built-in' : `seed:${e.lane || 'library'}` });
  }
  return out;
}

/**
 * Registers a new entry or a new version of one. The old version is kept. A definition-bearing strategy always
 * starts at approval "pending_owner": it may run in backtests, never in paper, until the owner says yes.
 */
export async function registerEntry(storage, entry, { who = 'owner', now = Date.now() } = {}) {
  const problems = entryProblems(entry);
  if (problems.length) return { ok: false, problems };
  if (codeEntries().some((e) => e.id === entry.id && e.builtin)) return { ok: false, problems: [`"${entry.id}" is a built-in strategy; duplicate it to change it`] };
  const idx = await readIndex(storage);
  if (!idx.includes(entry.id) && idx.length >= BUDGET.max_entries) return { ok: false, problems: [`the library holds at most ${BUDGET.max_entries} entries`] };
  const prev = await readStored(storage, entry.id);
  const version = (prev?.versions?.length || 0) + 1;
  const { enabled: _e, approval: _a, favorite: _f, results: _r, ...content } = entry;
  const v = { version, at: new Date(now).toISOString(), by: who, ...content, engine: entry.definition ? 'dsl' : (entry.engine || 'none') };
  const versions = [...(prev?.versions || []), v].slice(-MAX_VERSIONS);
  const rec = {
    id: entry.id, versions, current: version, favorite: prev?.favorite || false,
    // A new version of an executable strategy needs a new yes: the owner approved the old rules, not these.
    enabled: false, approval: entry.definition ? { state: 'pending_owner', version, requested_at: v.at } : (prev?.approval || { state: 'not_needed' }),
    results: prev?.results || {},
  };
  await writeStored(storage, rec);
  await audit(storage, { action: prev ? 'edit' : 'register', id: entry.id, version, who, kind: entry.kind, engine: v.engine }, now);
  return { ok: true, id: entry.id, version, approval: rec.approval.state };
}

/** The owner's yes. `confirm` must be true and comes only from the owner's own request. */
export async function approveEntry(storage, id, { confirm = false, who = 'owner', now = Date.now() } = {}) {
  const seed = codeEntries().find((e) => e.id === id && e.definition);
  const rec = (await readStored(storage, id)) || (seed ? blankRecord(id, seed) : null);
  const cur = rec?.versions?.find((v) => v.version === rec.current) || (rec?.current === 0 ? seed : null);
  if (!rec || !cur) return { ok: false, error: `No stored custom strategy called ${id}.` };
  if (!cur.definition) return { ok: false, error: `${cur.name} has no executable rules to approve.` };
  if (!confirm) return { ok: false, needs_confirmation: true, summary: `Approve ${cur.name} version ${rec.current} for paper testing? It will paper trade only; live trading stays off.` };
  rec.approval = { state: 'approved', version: rec.current, at: new Date(now).toISOString(), by: who };
  await writeStored(storage, rec);
  await audit(storage, { action: 'approve', id, version: rec.current, who }, now);
  return { ok: true, id, version: rec.current };
}

/** enable, disable, favorite, unfavorite. Enabling an executable custom strategy requires its approval. */
export async function setFlag(storage, id, flag, { who = 'owner', now = Date.now() } = {}) {
  const code = codeEntries().find((e) => e.id === id);
  const rec = (await readStored(storage, id)) || (code ? blankRecord(id, code) : null);
  if (!rec) return { ok: false, error: `No strategy called ${id}.` };
  const cur = rec.versions.find((v) => v.version === rec.current) || code;
  if (flag === 'enable') {
    if (cur.engine === 'dsl' && rec.approval?.state !== 'approved') return { ok: false, error: `${cur.name} needs your approval first. Say "approve ${cur.name}".` };
    if (cur.engine === 'none' || !cur.engine) return { ok: false, error: `${cur.name} has no executable rules, so there is nothing to enable.` };
    rec.enabled = true;
  } else if (flag === 'disable') rec.enabled = false;
  else if (flag === 'favorite') rec.favorite = true;
  else if (flag === 'unfavorite') rec.favorite = false;
  else return { ok: false, error: 'Use enable, disable, favorite or unfavorite.' };
  await writeStored(storage, rec);
  await audit(storage, { action: flag, id, who }, now);
  return { ok: true, id, enabled: rec.enabled, favorite: rec.favorite };
}

/** A copy under a new id, as the owner's own pending strategy (built-ins copy their rules as text only). */
export async function duplicateEntry(storage, id, newId, { who = 'owner', now = Date.now() } = {}) {
  const src = (await entryById(storage, id));
  if (!src) return { ok: false, problems: [`No strategy called ${id}.`] };
  const def = src.definition ? { ...src.definition, id: newId, name: `${src.definition.name} (copy)` } : undefined;
  const copy = { id: newId, kind: src.kind, name: `${src.name} (copy)`, category: src.category, sources: [...(src.sources || []), { type: 'owner', title: `Duplicated from ${src.name}` }],
    rules: src.rules || [], assumptions: src.assumptions || [], limitations: src.limitations || [], timeframes: src.timeframes || [], data_requirements: src.data_requirements || [], event_dependencies: src.event_dependencies || [],
    ...(def ? { definition: def } : {}), engine: def ? 'dsl' : 'none' };
  const out = await registerEntry(storage, copy, { who, now });
  if (out.ok) await audit(storage, { action: 'duplicate', id: newId, from: id, who }, now);
  return out;
}

/** Results from the backtest harness or the forward paper ledger. Never edits trades; it records their summary. */
export async function recordResults(storage, id, kind, summary, { source, now = Date.now() } = {}) {
  if (!['backtest', 'forward'].includes(kind)) return { ok: false, error: 'kind is backtest or forward' };
  if (!source) return { ok: false, error: 'results need their evidence source (ledger, job id or file)' };
  const code = codeEntries().find((e) => e.id === id);
  const rec = (await readStored(storage, id)) || (code ? blankRecord(id, code) : null);
  if (!rec) return { ok: false, error: `No strategy called ${id}.` };
  rec.results = { ...rec.results, [kind]: { ...summary, source, at: new Date(now).toISOString() } };
  await writeStored(storage, rec);
  await audit(storage, { action: `results:${kind}`, id, trades: summary?.trades ?? null, source }, now);
  return { ok: true };
}

async function entryById(storage, id) {
  const code = codeEntries().find((e) => e.id === id);
  const rec = await readStored(storage, id);
  const cur = rec?.versions?.find((v) => v.version === rec.current);
  if (!code && !cur) return null;
  // Built-in engines run by default; a seeded executable definition waits for the owner's yes like any custom one.
  const seededDsl = code?.engine === 'dsl';
  return { ...(code || {}), ...(cur || {}), id, enabled: rec ? rec.enabled : Boolean(code?.engine && code.engine !== 'none' && !seededDsl), favorite: rec?.favorite || false,
    approval: rec?.approval || (seededDsl ? { state: 'pending_owner', version: 0 } : code ? { state: 'not_needed' } : undefined), results: { ...(code?.results || {}), ...(rec?.results || {}) }, versions: (rec?.versions || []).map((v) => ({ version: v.version, at: v.at, by: v.by })), current: rec?.current || 0 };
}

// ─── Views ───────────────────────────────────────────────────────────────────────

/**
 * Every entry with its lifecycle stage. Backtest and forward paper evidence for the research engine's strategies
 * come from its own stored units and forward journal (trading_research.readUnits / forwardEvidence), counted here,
 * never estimated. [paperLearning] is whether the forward paper engine runs now.
 */
export async function libraryView(storage, { q = '', category = '', kind = '', lifecycle = '', paperLearning = null } = {}) {
  const ids = new Set([...codeEntries().map((e) => e.id), ...(await readIndex(storage))]);
  const [units, forward, livePaper] = await Promise.all([
    readUnits(storage).catch(() => []), forwardEvidence(storage).catch(() => []), paperLearning == null ? storage.get('live_paper_state') : null,
  ]);
  const paperOn = paperLearning ?? Boolean(livePaper?.enabled);
  const entries = [];
  for (const id of ids) {
    const e = await entryById(storage, id);
    if (!e) continue;
    if (e.engine === 'trading_evidence') {
      const mine = units.filter((u) => u.strategy_id === id && u.ok);
      const bt = mine.reduce((a, u) => a + (u.all?.trades || 0), 0);
      if (bt > 0) e.results = { ...e.results, backtest: { trades: bt, units: mine.length, timeframes: [...new Set(mine.map((u) => u.timeframe))], source: 'trading_research stored units' } };
      const fw = forward.filter((f) => f.strategy_id === id && f.mode === 'PAPER');
      const ft = fw.reduce((a, f) => a + (f.trades || 0), 0);
      if (ft > 0) e.results = { ...e.results, forward: { trades: ft, min_trades: MIN_TRADES, source: 'trading_live forward paper journal' } };
    }
    const running = e.engine === 'trading_evidence' && Boolean(INTRADAY_CANDIDATES[id]) && paperOn && e.enabled !== false;
    const approvedBuiltIn = e.builtin ? { ...e, approval: { state: 'approved' } } : e;
    const stage = lifecycleOf(approvedBuiltIn, { running });
    entries.push({
      id, kind: e.kind, name: e.name, category: e.category, family: e.family || '', origin: e.origin || 'owner', engine: e.engine || 'none',
      lifecycle: stage, lifecycle_label: LIFECYCLE_LABEL[stage], not_running: notRunningReason(approvedBuiltIn, stage),
      sources: e.sources || [], rules: e.rules || [], assumptions: e.assumptions || [], timeframes: e.timeframes || [], data_requirements: e.data_requirements || [],
      event_dependencies: e.event_dependencies || [], limitations: e.limitations || [], results: e.results || {}, symbols: e.symbols || [],
      enabled: e.enabled !== false && (e.engine || 'none') !== 'none', favorite: Boolean(e.favorite), approval: e.approval?.state || 'not_needed',
      version: e.current || 1, versions: e.versions || [], has_definition: Boolean(e.definition), ict: Boolean(e.ict) || e.category === 'ict_smc',
      ...(e.definition ? { definition: e.definition } : {}),
    });
  }
  const needle = String(q || '').toLowerCase().trim();
  const filtered = entries.filter((e) => (!category || e.category === category) && (!kind || e.kind === kind) && (!lifecycle || e.lifecycle === lifecycle)
    && (!needle || `${e.name} ${e.id} ${e.family} ${e.category} ${e.rules.join(' ')}`.toLowerCase().includes(needle)));
  filtered.sort((a, b) => Number(b.favorite) - Number(a.favorite) || LIFECYCLE.indexOf(b.lifecycle) - LIFECYCLE.indexOf(a.lifecycle) || a.name.localeCompare(b.name));
  return { schema: ENTRY_SCHEMA, lifecycle: LIFECYCLE.map((s) => ({ id: s, label: LIFECYCLE_LABEL[s] })), categories: CATEGORIES, kinds: KINDS, budget: BUDGET, counts: countsOf(entries), entries: filtered, total: entries.length, live_trading: 'off' };
}

/** The audit numbers the owner asked for, from the same entries. */
export function countsOf(entries) {
  const strategies = entries.filter((e) => e.kind === 'strategy');
  const at = (s) => strategies.filter((e) => LIFECYCLE.indexOf(e.lifecycle) >= LIFECYCLE.indexOf(s)).length;
  return {
    named: strategies.length,
    market_context_models: entries.filter((e) => e.kind === 'market_context').length,
    executable_rules: at('implemented'),
    backtested: at('backtested'),
    forward_tested: at('forward_tested'),
    paper_active: at('paper_active'),
    disabled_or_unsupported: strategies.filter((e) => !e.enabled).length,
    by_lifecycle: Object.fromEntries(LIFECYCLE.map((s) => [s, strategies.filter((e) => e.lifecycle === s).length])),
    by_category: Object.fromEntries(CATEGORIES.map((c) => [c, strategies.filter((e) => e.category === c).length])),
  };
}

/** Approved, enabled DSL documents for the phone's setup engine, capped by the budget. */
export async function activeDefinitions(storage) {
  const out = [];
  for (const id of await readIndex(storage)) {
    const rec = await readStored(storage, id);
    const cur = rec?.versions?.find((v) => v.version === rec.current);
    if (cur?.definition && rec.enabled && rec.approval?.state === 'approved' && rec.approval.version === rec.current) out.push({ id, version: rec.current, definition: cur.definition });
  }
  for (const e of LIBRARY_SEEDS) {
    if (!e.definition) continue;
    const rec = await readStored(storage, e.id);
    if (rec?.enabled && rec.approval?.state === 'approved' && rec.current === 0 && rec.approval.version === 0 && !out.some((o) => o.id === e.id)) out.push({ id: e.id, version: 0, definition: e.definition });
  }
  return { definitions: out.slice(0, BUDGET.max_active), paused_budget: out.slice(BUDGET.max_active).map((d) => d.id), budget: BUDGET };
}

// ─── Plain-language drafting (the only model use, capped per day) ─────────────────

export async function takeDraftAllowance(storage, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const cur = (await storage.get(DRAFTS_KEY)) || { day, used: 0 };
  const used = cur.day === day ? cur.used : 0;
  if (used >= BUDGET.model_drafts_per_day) return { ok: false, used, limit: BUDGET.model_drafts_per_day };
  await storage.put(DRAFTS_KEY, { day, used: used + 1 });
  return { ok: true, used: used + 1, limit: BUDGET.model_drafts_per_day };
}

/** Instructions for turning the owner's words into a draft `che.strategy/1` document. */
export const DRAFT_PROMPT = `Turn the owner's trading idea into one JSON document in the "che.strategy/1" schema. Output JSON only.
Fields: schema, id (lowercase-dashes), name, category (${CATEGORIES.join('|')}), timeframes (minutes), series (named indicators: {"fn":"ema|sma|rsi|macd|bb|atr|vol_sma|highest|lowest|vwap_band", ...}), long and/or short: {conditions:[{id,label,group,when}], stop, target:{"r":2} or operand, invalidation?}, risk {min_points,max_points}.
Operands: numbers, "open|high|low|close|volume|price", a declared series name, {"level":"prior_day_high|prior_day_low|prior_rth_high|prior_rth_low|overnight_high|overnight_low|day_high|day_low|rth_high|rth_low|or_high|or_low|swing_high|swing_low|vwap"}, {"window_high":"london","day":0|-1}, {"add|sub|mul|div":[a,b]}, {"series":"x","ago":1}.
Conditions: {"gt|lt|gte|lte|cross_above|cross_below":[a,b]}, {"all|any":[...]}, {"not":c}, {"in_window":"ny_open|overnight|london|asia|ny_am_killzone|silver_bullet_am|silver_bullet_pm|rth|ny_pm"}, {"rising":"x","bars":3}, {"sweep":"low|high","of":operand,"within":5}, {"fvg":"bull|bear","within":10,"retest":true}, {"order_block":"bull|bear","within":20}, {"structure_break":"bull|bear"}, {"bar":"bull|bear"}.
Every side needs a stop and a target. Never reference future bars. If the idea is ambiguous, choose the simplest reading and list it in "description".`;

// ─── Voice and typing (deterministic; the owner can say it or type it) ─────────────

/**
 * "Show the strategy library", "how many strategies can you execute", "compare EMA pullback and VWAP reversion",
 * "favorite Silver Bullet", "approve MACD signal cross", "yes, approve MACD signal cross", "add a strategy: …",
 * "enable the MACD strategy" (a library-only strategy; built-in research strategies go through trading_controls).
 */
export function strategyLibraryIntent(message) {
  const text = String(message || '').toLowerCase().replace(/[’']/g, "'").replace(/^\s*(?:hey\s+)?(?:che|chey|chay)[,\s]+/, '').trim();
  if (!text) return null;
  // The /trade-library command sends "Strategy library: <request>"; a request it does not recognise reads the library.
  const command = /^strategy library:\s*([\s\S]*)$/.exec(text);
  if (command) {
    const rest = String(message).replace(/^[\s\S]*?strategy library:\s*/i, '');
    return (command[1] ? strategyLibraryIntent(rest) : null) || { kind: 'list' };
  }
  const add = /^(?:please\s+)?(?:add|create|make|write|build)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+)?(?:custom\s+)?strategy\b[\s:,-]*(?:that|which|where|when|to|for)?\s*([\s\S]{8,})$/.exec(text);
  if (add) return { kind: 'draft', text: String(message).slice(String(message).length - add[1].length).trim() };
  const yes = /^(?:yes|yeah|yep|confirm(?:ed)?)[,\s]+(?:please\s+)?approve\s+(?:the\s+)?(.+?)(?:\s+strategy)?[.!]?$/.exec(text);
  if (yes) return { kind: 'approve', name: yes[1], confirm: true };
  const approve = /^(?:please\s+)?approve\s+(?:the\s+)?(.+?)(?:\s+strategy)?(?:\s+for\s+paper(?:\s+testing)?)?[.!?]?$/.exec(text);
  if (approve) return { kind: 'approve', name: approve[1], confirm: false };
  const compare = /\bcompare\s+(?:the\s+)?(.+?)\s+(?:and|with|to|vs\.?|versus)\s+(?:the\s+)?(.+?)(?:\s+strateg(?:y|ies))?[.?!]?$/.exec(text);
  if (compare && /\bstrateg|ema|vwap|rsi|macd|bollinger|orb|opening range|sweep|fvg|order block|silver bullet|breakout|pullback|revers/.test(text)) return { kind: 'compare', names: [compare[1], compare[2]] };
  const flag = /^(?:please\s+)?(favorite|favourite|unfavorite|unfavourite|star|unstar|enable|disable|turn on|turn off)\s+(?:the\s+)?(.+?)(?:\s+strategy)?[.!]?$/.exec(text);
  if (flag) {
    const f = { favorite: 'favorite', favourite: 'favorite', star: 'favorite', unfavorite: 'unfavorite', unfavourite: 'unfavorite', unstar: 'unfavorite', enable: 'enable', 'turn on': 'enable', disable: 'disable', 'turn off': 'disable' }[flag[1]];
    return { kind: 'flag', flag: f, name: flag[2] };
  }
  if (/\bstrategy library\b|\b(?:list|show|read)\s+(?:me\s+)?(?:all\s+|every\s+)?(?:of\s+)?(?:your\s+|the\s+|my\s+)?strategies\b|\bhow many strategies\b|\bevery strategy (?:you|che) (?:know|can)\b|\bwhich strategies (?:are|can) (?:you )?(?:active|testing|execut|running)/.test(text)) {
    return { kind: 'list' };
  }
  if (/\b(?:what|which|identify|find)\b[\s\S]{0,40}\b(?:86|eighty[- ]six|amd|power of three)\b[\s\S]{0,30}\b(?:strateg|model|setup)/.test(text)) return { kind: 'identify' };
  return null;
}

const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !['the', 'strategy', 'model', 'my', 'a', 'an', 'to', 'of'].includes(w));

/** The entry a spoken name means, or the candidates when it is ambiguous. Never a guess between two. */
export function resolveName(entries, name) {
  const want = tokens(name);
  if (!want.length) return { match: null, candidates: [] };
  const exact = entries.find((e) => e.id === String(name).trim() || e.name.toLowerCase() === String(name).trim().toLowerCase());
  if (exact) return { match: exact, candidates: [exact] };
  const scored = entries.map((e) => {
    const have = new Set([...tokens(e.name), ...tokens(e.id.replace(/[-:]/g, ' '))]);
    const hits = want.filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w) && w.length >= 3)).length;
    return { e, score: hits / want.length, extra: have.size };
  }).filter((x) => x.score >= 0.6).sort((a, b) => b.score - a.score || a.extra - b.extra);
  if (!scored.length) return { match: null, candidates: [] };
  const top = scored.filter((x) => x.score === scored[0].score);
  // Built-in research strategies outrank simulator and lab variants of the same words.
  const research = top.filter((x) => x.e.engine === 'trading_evidence' || x.e.engine === 'dsl');
  const pick = research.length === 1 ? research : top;
  return pick.length === 1 ? { match: pick[0].e, candidates: [pick[0].e] } : { match: null, candidates: pick.slice(0, 5).map((x) => x.e) };
}

export function speakLibrary(view) {
  const c = view.counts;
  return [
    `CHE's strategy library, sir: ${c.named} named strategies and ${c.market_context_models} market-context model${c.market_context_models === 1 ? '' : 's'}.`,
    `${c.executable_rules} have executable rules; ${c.backtested} have recorded backtests; ${c.forward_tested} have at least 30 forward paper trades; ${c.paper_active} are paper trading now.`,
    `By stage: ${LIFECYCLE.map((s) => `${LIFECYCLE_LABEL[s]} ${c.by_lifecycle[s]}`).join(', ')}.`,
    `${c.disabled_or_unsupported} are disabled or have no rules to run. Live trading is off.`,
  ].join('\n');
}

export function speakCompare(a, b) {
  const line = (e) => {
    const bt = e.results?.backtest; const fw = e.results?.forward;
    return `${e.name}: ${e.lifecycle_label}, ${e.timeframes.length ? `timeframes ${e.timeframes.join(', ')}` : 'no timeframe'}; ${bt?.trades ? `${bt.trades} backtest trades` : 'no recorded backtest'}; ${fw?.trades ? `${fw.trades} forward paper trades` : 'no forward paper trades'}.${e.not_running ? ` ${e.not_running}` : ''}`;
  };
  return `Side by side, sir, from recorded evidence only.\n${line(a)}\n${line(b)}`;
}
