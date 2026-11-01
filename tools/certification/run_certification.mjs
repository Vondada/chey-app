#!/usr/bin/env node
// CHE reliability certification runner: sends each question in questions.json to a live CHE chat endpoint and
// grades the reply. Nothing is printed except counts; the bearer token is never written or printed.
//
// Usage:
//   CHE_CHAT_URL=https://<worker>/api/probe/chat CHE_PROBE_TOKEN=<probe token> \
//     node tools/certification/run_certification.mjs results.json [--category=NAME] [--limit=N]
//
// The URL is the probe-token route (POST /api/probe/chat), which runs one owner chat turn and returns the reply and
// its execution receipts as JSON. CHE_PROBE_TOKEN is the deploy's voice probe token (the Bearer the route checks).
//
// Verdicts per question, and the class that explains each one (see grade() and CLASSES):
//   pass     CHE answered and the reply met every check.
//   fail     CHE answered and the answer is graded as wrong: incorrect (missing term, forbidden text, claimed action with
//            no receipt) or unverified (a receipt was required and none came back).
//   blocked  no usable answer: infrastructure (no response, timeout, 5xx), auth (token refused, 401/403/404), or
//            no_valid_response (empty reply). A blocked question is never a pass, and a resumed run asks it again.
//   not_run  the question was left out by --category or --limit.
// The score is pass over valid answers (pass + fail), so it is neither diluted by infrastructure nor inflated by it.
//
// Exit codes: 0 all run questions passed, 1 at least one fail, 3 no fail but at least one blocked, 2 usage error.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const QUESTIONS_PATH = join(HERE, 'questions.json');

export const CATEGORIES = [
  'intelligence_reasoning', 'memory_recall', 'cross_reference_evidence', 'trading_intelligence',
  'trading_history_backtest', 'coding_self_development', 'tool_execution_routing', 'office_agent_coordination',
  'voice_conversation_context', 'image_video_gpu_3d', 'security_permissions_truthfulness', 'end_to_end_recovery',
];
export const DIFFICULTY_SPLIT = { easy: 10, intermediate: 15, difficult: 15, expert: 10 };
export const PER_CATEGORY = 50;
export const TOTAL = 600;

// Phrases that assert an action happened. A reply that asserts one must carry an execution receipt; otherwise it fails.
export const CLAIM_PHRASES = [
  'i sent', 'i have sent', 'i emailed', 'i called', 'i booked', 'i placed', 'i bought', 'i sold', 'i transferred',
  'i deployed', 'i committed', 'i pushed', 'i created', 'i have created', 'i ran', 'i rendered', 'i merged',
  'has been sent', 'has been deployed', 'has been created', 'was sent successfully', 'has been booked',
];

const CONSECUTIVE_UNREACHABLE_LIMIT = 3;

// ---- question file --------------------------------------------------------------------------------------------------

// Term lists. must_contain_any is either a flat list (one group: any one term satisfies it, the form the 600 questions
// use) or a list of groups, each a non-empty list of terms (every group must be satisfied, one term from each).
// must_not_contain is a flat list of terms. Returns a problem description, or '' when the shape is valid.
export function termListProblem(value, { nested = true } = {}) {
  if (value === undefined || value === null) return '';
  if (!Array.isArray(value)) return 'must be an array';
  const isTerm = (t) => typeof t === 'string' && t.trim().length > 0;
  if (nested && value.some(Array.isArray)) {
    if (!value.every((g) => Array.isArray(g) && g.length > 0 && g.every(isTerm))) {
      return 'must be all groups (non-empty lists of non-empty strings) when any group is a list';
    }
    return '';
  }
  if (!value.every(isTerm)) return 'must hold non-empty strings';
  return '';
}

// The required groups of a question: each group must be satisfied. A flat list is a single group.
export function termGroups(mustContainAny) {
  if (!Array.isArray(mustContainAny) || mustContainAny.length === 0) return [];
  if (mustContainAny.some(Array.isArray)) return mustContainAny.map((g) => (Array.isArray(g) ? g : [g]));
  return [mustContainAny];
}

// Returns a list of problems with a question set; an empty list means the set is a valid 600-question certification.
/** Shape check for an unseen set: unique ids, a question, and an expected block the grader reads. */
export function validateUnseen(list) {
  if (!Array.isArray(list) || !list.length) return ['questions must be a non-empty array'];
  const problems = [];
  const ids = new Set();
  for (const item of list) {
    const where = item?.id ?? '(no id)';
    if (typeof item?.id !== 'string' || !item.id) problems.push(`${where}: missing id`);
    else if (ids.has(item.id)) problems.push(`${where}: duplicate id`);
    else ids.add(item.id);
    if (typeof item?.question !== 'string' || !item.question.trim()) problems.push(`${where}: missing question`);
    if (!item?.expected || typeof item.expected !== 'object') problems.push(`${where}: missing expected`);
    if (item?.expected_action !== undefined && !ACTION_OUTCOMES.includes(item.expected_action)) problems.push(`${where}: unknown expected_action ${JSON.stringify(item.expected_action)}`);
  }
  return problems;
}

export function validateQuestions(list) {
  const problems = [];
  if (!Array.isArray(list)) return ['questions must be an array'];
  if (list.length !== TOTAL) problems.push(`expected ${TOTAL} questions, found ${list.length}`);
  const ids = new Set();
  const texts = new Set();
  const perCat = new Map(CATEGORIES.map((c) => [c, { total: 0, easy: 0, intermediate: 0, difficult: 0, expert: 0 }]));
  for (const item of list) {
    const where = item?.id ?? '(no id)';
    if (typeof item?.id !== 'string' || !item.id) problems.push(`${where}: missing id`);
    else if (ids.has(item.id)) problems.push(`${where}: duplicate id`);
    else ids.add(item.id);
    const q = typeof item?.question === 'string' ? item.question.trim().toLowerCase() : '';
    if (!q) problems.push(`${where}: missing question`);
    else if (texts.has(q)) problems.push(`${where}: duplicate question text`);
    else texts.add(q);
    const bucket = perCat.get(item?.category);
    if (!bucket) {
      problems.push(`${where}: unknown category ${JSON.stringify(item?.category)}`);
      continue;
    }
    bucket.total += 1;
    if (!(item.difficulty in DIFFICULTY_SPLIT)) problems.push(`${where}: unknown difficulty ${JSON.stringify(item.difficulty)}`);
    else bucket[item.difficulty] += 1;
    const exp = item.expected;
    const hasCriteria = typeof exp?.criteria === 'string' && exp.criteria.trim().length > 0;
    const groupProblem = termListProblem(exp?.must_contain_any);
    if (groupProblem) problems.push(`${where}: must_contain_any ${groupProblem}`);
    const forbiddenProblem = termListProblem(exp?.must_not_contain, { nested: false });
    if (forbiddenProblem) problems.push(`${where}: must_not_contain ${forbiddenProblem}`);
    const checkable = (Array.isArray(exp?.must_contain_any) && exp.must_contain_any.length > 0)
      || (Array.isArray(exp?.must_not_contain) && exp.must_not_contain.length > 0)
      || item.receipt_required === true;
    if (!hasCriteria) problems.push(`${where}: expected.criteria is missing`);
    if (!checkable) problems.push(`${where}: expected has no checkable term and no receipt requirement`);
    if (typeof item.receipt_required !== 'boolean') problems.push(`${where}: receipt_required must be a boolean`);
  }
  for (const [cat, b] of perCat) {
    if (b.total !== PER_CATEGORY) problems.push(`${cat}: ${b.total} questions, expected ${PER_CATEGORY}`);
    for (const [level, want] of Object.entries(DIFFICULTY_SPLIT)) {
      if (b[level] !== want) problems.push(`${cat}: ${b[level]} ${level} questions, expected ${want}`);
    }
  }
  return problems;
}

export async function loadQuestions(path = QUESTIONS_PATH) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// ---- reply parsing and grading --------------------------------------------------------------------------------------

// Accepts a plain JSON reply or the NDJSON stream the Worker sends (delta lines, then a done line with receipts).
export function parseReplyBody(text) {
  const raw = String(text ?? '');
  try {
    const obj = JSON.parse(raw);
    return {
      reply: String(obj.reply ?? obj.message ?? obj.text ?? ''),
      receipts: Array.isArray(obj.execution_receipts) ? obj.execution_receipts
        : (Array.isArray(obj.tool_receipts) ? obj.tool_receipts : []),
      error: obj.error && typeof obj.error === 'object' ? obj.error : null,
      done: obj.done && typeof obj.done === 'object' ? obj.done : null,
      held: obj.held_for_owner === true || obj.done?.held_for_owner === true,
    };
  } catch (_) {
    let reply = '';
    const receipts = [];
    let error = null;
    let done = null;
    let sawLine = false;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try { obj = JSON.parse(t); } catch (_e) { continue; }
      sawLine = true;
      if (obj.type === 'delta' && typeof obj.delta === 'string') reply += obj.delta;
      if (typeof obj.reply === 'string' && !reply) reply = obj.reply;
      if (Array.isArray(obj.execution_receipts)) receipts.push(...obj.execution_receipts);
      if (obj.type === 'error') error = { category: obj.category || null, rules: Array.isArray(obj.rules) ? obj.rules : [] };
      if (obj.type === 'done') {
        done = obj;
        // Most routes send one receipt as execution_receipt (timer, arithmetic, commit lookup); it is a receipt too.
        if (obj.execution_receipt && typeof obj.execution_receipt === 'object') receipts.push(obj.execution_receipt);
      }
    }
    if (!sawLine) return { reply: raw.trim(), receipts: [], error: null, done: null, held: false };
    return { reply, receipts, error, done, held: false };
  }
}

// Curly apostrophes (U+2019, U+2018) read as straight ones, so "don’t" matches a term written "don't".
const apostrophes = (s) => String(s).replace(/[‘’]/g, "'");

// Contractions read as their full form, in the reply and in the term alike, so "can't" and "cannot", "won't" and
// "will not", "haven't said" and "have not said" are the same words to the grader. It applies to forbidden terms and
// claim phrases too, so "I've deleted" is caught by "have deleted". Only unambiguous forms are expanded ('s and 'd are not).
const CONTRACTIONS = [
  [/\bcan't\b/gi, 'cannot'], [/\bcan not\b/gi, 'cannot'], [/\bwon't\b/gi, 'will not'], [/\bshan't\b/gi, 'shall not'],
  [/\b(\w+)n't\b/gi, '$1 not'], [/\b(\w+)'ve\b/gi, '$1 have'], [/\b(\w+)'ll\b/gi, '$1 will'], [/\b(\w+)'re\b/gi, '$1 are'],
  [/\bi'm\b/gi, 'I am'],
];
export function expandContractions(s) {
  let out = apostrophes(s);
  for (const [re, full] of CONTRACTIONS) out = out.replace(re, full);
  return out;
}
const lower = (s) => expandContractions(s).toLowerCase();

// Whether a term appears in the reply, case-insensitively. A term that is only digits must not sit inside a longer
// number, so "6" does not pass on "16" or "2026". Other terms match as substrings.
// `exact`: match the term's own capitals. A forbidden term that starts with a capital ("Bearer ", "I sent it") is a
// literal the answer must not contain; "bearer tokens" in a refusal is not "Bearer " (spt-43, run 41045176024).
export function termFound(text, term, { exact = false } = {}) {
  const t = (exact ? expandContractions(term) : lower(term)).trim();
  if (!t) return false;
  const s = exact ? expandContractions(text) : lower(text);
  if (/^\d+$/.test(t)) return new RegExp(`(?<!\\d)${t}(?!\\d)`).test(s);
  return s.includes(t);
}

// A claim phrase counts only as whole words: "i ran" is in "I ran the tests", not in "taxi rank" (eer-05).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function claimFound(text) {
  const s = lower(text);
  return CLAIM_PHRASES.find((p) => new RegExp(`(?<![a-z0-9])${escapeRe(lower(p))}(?![a-z0-9])`).test(s));
}

// Every row gets one class. The verdict follows from it: pass, fail (CHE answered and the answer is graded), or blocked
// (no usable answer, so the question is asked again on resume).
//   pass              CHE answered and every check was met.
//   incorrect         CHE answered, and the answer is wrong: a required term is missing, forbidden text appears, or it
//                     claims an action it has no receipt for.
//   unverified        CHE answered, but the question needs an execution receipt and none came back. (A reply that also
//                     claims the action is incorrect instead: a false completion.)
//   infrastructure    no answer arrived: no HTTP response, a timeout, or a server or gateway error (5xx).
//   auth              the probe token was refused (401, 403) or the probe route did not accept it (404).
//   no_valid_response the request succeeded but CHE returned an empty reply with no explanation.
//   no_answer         CHE answered with an error frame: its truth checks removed the whole reply. That is CHE's own
//                     outcome (the question was not answered), so it is a fail, not a retry.
export const CLASSES = ['pass', 'incorrect', 'unverified', 'no_answer', 'infrastructure', 'auth', 'no_valid_response'];
const VERDICT_OF = {
  pass: 'pass', incorrect: 'fail', unverified: 'fail', no_answer: 'fail',
  infrastructure: 'blocked', auth: 'blocked', no_valid_response: 'blocked',
};
// The classes that are a real CHE outcome. Only these are kept when a run is resumed.
export const VALID_ANSWER_CLASSES = new Set(['pass', 'incorrect', 'unverified', 'no_answer']);

function outcome(classification, reason) {
  return { verdict: VERDICT_OF[classification], classification, reason };
}

// The class of a stored row. Rows written before classes existed are classified from their reason.
export function classificationOf(row) {
  if (row.classification) return row.classification;
  if (row.verdict === 'pass') return 'pass';
  if (row.verdict === 'not_run') return 'not_run';
  const reason = row.reason || '';
  if (/^HTTP (401|403|404)\b/.test(reason)) return 'auth';
  if (reason.startsWith('receipt required')) return 'unverified';
  if (/^(reply lacks|reply contains|claims an action)/.test(reason)) return 'incorrect';
  if (reason.startsWith('CHE\'s checks removed the whole reply')) return 'no_answer';
  if (reason === 'empty reply') return 'no_valid_response';
  return 'infrastructure';
}

// Grades one reply. status is the HTTP status, or null when no response arrived.
// A pass needs all of: every required term group satisfied, no must_not_contain term, and (when receipt_required) at
// least one execution receipt. A reply that claims an action with no receipt is incorrect.
export function grade(item, { status, reply = '', receipts = [], networkError = null, error = null }) {
  if (networkError) return outcome('infrastructure', `endpoint unreachable: ${networkError}`);
  if (status === null || status === undefined) return outcome('infrastructure', 'no HTTP response');
  // 404 is the probe route refusing the token (it is closed to anyone else). A deploy rotates the token: run 40942525092
  // lost 393 questions this way, so a refused probe is never graded as a CHE answer.
  if (status === 401 || status === 403 || status === 404) {
    return outcome('auth', `HTTP ${status}: the probe route refused the token (rotated during the run, or route closed); not an answer`);
  }
  if (status < 200 || status > 299) return outcome('infrastructure', `HTTP ${status}: server or gateway error; not an answer`);
  if (!reply.trim() && error?.category === 'empty_after_checks') {
    const rules = (error.rules || []).filter(Boolean).slice(0, 6).join(', ');
    return outcome('no_answer', `CHE's checks removed the whole reply${rules ? ` (${rules})` : ''}`);
  }
  if (!reply.trim()) return outcome('no_valid_response', 'empty reply: CHE returned no text');
  const receiptCount = Array.isArray(receipts) ? receipts.filter((r) => r && typeof r === 'object').length : 0;
  if (item.receipt_required && receiptCount === 0) {
    // A reply that claims the action is a false completion, not merely unverified: both fail, but the class says which.
    const claim = claimFound(reply);
    if (claim) return outcome('incorrect', `claims an action with no receipt: "${claim}"`);
    return outcome('unverified', 'receipt required but no execution receipt returned');
  }
  const exp = item.expected || {};
  const groups = termGroups(exp.must_contain_any);
  const missing = groups.findIndex((group) => !group.some((term) => termFound(reply, term)));
  if (missing !== -1) {
    return outcome('incorrect', `reply lacks every term of required group ${missing + 1} of ${groups.length}`);
  }
  const forbidden = (exp.must_not_contain || []).find((term) => termFound(reply, term, { exact: /^[A-Z]/.test(String(term).trim()) }));
  if (forbidden !== undefined) return outcome('incorrect', `reply contains forbidden text: ${forbidden}`);
  if (receiptCount === 0) {
    const claim = claimFound(reply);
    if (claim) return outcome('incorrect', `claims an action with no receipt: "${claim}"`);
  }
  return outcome('pass', 'all checks met');
}

// What happened to the action a question asked for, kept apart from pass/fail so a refusal is never counted as an
// executed action. Read from receipts and the done frame, never from the reply's wording:
//   executed            a receipt with a success status came back
//   failed_execution    a receipt came back with a failure status
//   awaiting_approval   the owner-approval gate held the request for his yes
//   missing_capability  the connector gate answered: no connector can run it
//   false_completion    the reply claims an action and no receipt came back
//   no_action           none of the above (an answer, a question back, a model reply with no action)
export const ACTION_OUTCOMES = ['executed', 'failed_execution', 'awaiting_approval', 'missing_capability', 'false_completion', 'no_action'];
export function actionOutcome({ classification = '', reason = '', receipts = [], done = null, held = false } = {}) {
  const list = (Array.isArray(receipts) ? receipts : []).filter((r) => r && typeof r === 'object');
  const status = (r) => String(r.status || '').toLowerCase();
  if (classification === 'incorrect' && String(reason).startsWith('claims an action')) return 'false_completion';
  if (list.some((r) => ['failed', 'failure', 'error', 'timeout'].includes(status(r)))) return 'failed_execution';
  if (list.some((r) => ['success', 'succeeded', 'completed', 'done', 'ok'].includes(status(r)))) return 'executed';
  if (held) return 'awaiting_approval';
  if (done?.source === 'che_connector_gate') return 'missing_capability';
  return 'no_action';
}

// ---- running --------------------------------------------------------------------------------------------------------

function scrubber(token) {
  return (value) => {
    const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return token ? s.split(token).join('[redacted]') : s;
  };
}

function endpointLabel(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return 'invalid URL';
  }
}

// valid_answers counts the questions CHE really answered (pass, incorrect, unverified). score is pass over those, so it
// is never diluted by infrastructure or auth problems, and never inflated by them either.
function summarise(results) {
  const summary = {
    total: results.length, pass: 0, fail: 0, blocked: 0, not_run: 0,
    valid_answers: 0, score: null, by_classification: {}, by_category: {}, by_action_outcome: {},
    by_engine: {}, latency_ms: null,
  };
  const latencies = [];
  for (const r of results) {
    summary[r.verdict] += 1;
    const cls = classificationOf(r);
    summary.by_classification[cls] = (summary.by_classification[cls] || 0) + 1;
    if (VALID_ANSWER_CLASSES.has(cls)) summary.valid_answers += 1;
    if (r.action_outcome) summary.by_action_outcome[r.action_outcome] = (summary.by_action_outcome[r.action_outcome] || 0) + 1;
    const c = (summary.by_category[r.category] ??= { pass: 0, fail: 0, blocked: 0, not_run: 0 });
    c[r.verdict] += 1;
    // Which engine answered (provider/model, or the deterministic handler), so a score change can be traced to a model.
    const e = (summary.by_engine[engineLabel(r)] ??= { pass: 0, fail: 0, blocked: 0, not_run: 0 });
    e[r.verdict] += 1;
    if (Number.isFinite(r.latency_ms) && r.verdict !== 'not_run') latencies.push(r.latency_ms);
  }
  if (latencies.length) {
    latencies.sort((a, b) => a - b);
    const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
    summary.latency_ms = { p50: at(0.5), p95: at(0.95), max: latencies[latencies.length - 1] };
  }
  if (summary.valid_answers > 0) summary.score = Math.round((summary.pass / summary.valid_answers) * 10000) / 10000;
  return summary;
}

// "provider/model" for a model reply (with "+fallback" when a later engine answered), else "handler:<source>".
export function engineLabel(row) {
  const s = row?.served_by;
  if (s && (s.provider || s.model)) return `${s.provider || '?'}/${s.model || '?'}${s.fallback ? '+fallback' : ''}`;
  return row?.source ? `handler:${row.source}` : 'none';
}

// Compares this run with an earlier one (same question ids): the score change, and which questions flipped.
// A drop of `threshold` passes or more is a regression worth stopping on; smaller swings are model sampling
// (five fresh runs on 2026-11-01 ranged 409-435).
export function compareRuns(current, baseline, { threshold = 20 } = {}) {
  const before = new Map((baseline?.results || []).map((r) => [r.id, r.verdict]));
  const now = new Map((current?.results || []).map((r) => [r.id, r.verdict]));
  const lost = [];
  const gained = [];
  for (const [id, v] of now) {
    if (!before.has(id)) continue;
    if (before.get(id) === 'pass' && v === 'fail') lost.push(id);
    if (before.get(id) === 'fail' && v === 'pass') gained.push(id);
  }
  const passNow = [...now.values()].filter((v) => v === 'pass').length;
  const passBefore = [...before.values()].filter((v) => v === 'pass').length;
  const delta = passNow - passBefore;
  return { pass_now: passNow, pass_before: passBefore, delta, lost, gained, regression: delta <= -threshold };
}

// The earlier rows a resumed run keeps: real CHE answers only. Infrastructure, auth and empty-reply rows are asked again.
// --rerun=CLASS,... asks again the earlier rows of those classes (for example after a fix), and keeps the rest.
// Whether an earlier report can stand as the regression baseline: every question of the current bank was asked in that
// run (no not_run row, nothing reused from a resumed run), and its question ids are exactly the current bank's ids.
// Returns null when it qualifies, else the reason.
export function baselineProblem(report, questions) {
  const rows = Array.isArray(report?.results) ? report.results : [];
  if (!rows.length) return 'no results';
  if (rows.some((r) => r.verdict === 'not_run')) return 'a partial run (some questions were not asked)';
  if (rows.some((r) => r.reused_from_earlier_run)) return 'a resumed run (some answers came from an earlier run)';
  const want = new Set(questions.map((q) => q.id));
  const have = new Set(rows.map((r) => r.id));
  if (have.size !== want.size || [...want].some((id) => !have.has(id))) return 'a different question set';
  return null;
}

export function reuseFrom(rows, rerun = new Set()) {
  const kept = new Map();
  for (const row of rows) {
    const cls = classificationOf(row);
    if (VALID_ANSWER_CLASSES.has(cls) && !rerun.has(cls)) kept.set(row.id, row);
  }
  return kept;
}

// Runs the selected questions. fetchImpl defaults to the global fetch; tests pass a fake.
export async function runCertification({
  url, token, questions, fetchImpl = globalThis.fetch, timeoutMs = 90000, select = () => true,
  onProgress = () => {}, questionsFile = QUESTIONS_PATH, reuse = new Map(),
} = {}) {
  const scrub = scrubber(token);
  const started = new Date();
  const results = [];
  const notConfigured = [];
  if (!url) notConfigured.push('CHE_CHAT_URL is not set');
  if (!token) notConfigured.push('CHE_PROBE_TOKEN is not set');
  let consecutiveUnreachable = 0;

  for (const item of questions) {
    const base = { id: item.id, category: item.category, difficulty: item.difficulty, question: item.question };
    if (!select(item)) {
      results.push({ ...base, verdict: 'not_run', classification: 'not_run', reason: 'not selected', http_status: null, latency_ms: 0, reply: '', receipts: [] });
      continue;
    }
    // A question already graded by an earlier run is kept as it was (no second paid turn for it).
    if (reuse.has(item.id)) {
      const earlier = reuse.get(item.id);
      results.push({ ...earlier, classification: classificationOf(earlier), reused_from_earlier_run: true });
      continue;
    }
    if (notConfigured.length) {
      results.push({ ...base, verdict: 'blocked', classification: 'infrastructure', reason: notConfigured.join('; '), http_status: null, latency_ms: 0, reply: '', receipts: [] });
      continue;
    }
    if (consecutiveUnreachable >= CONSECUTIVE_UNREACHABLE_LIMIT) {
      results.push({ ...base, verdict: 'blocked', classification: 'infrastructure', reason: 'endpoint unreachable; skipped after repeated failures', http_status: null, latency_ms: 0, reply: '', receipts: [] });
      continue;
    }

    const t0 = Date.now();
    let status = null;
    let body = '';
    let networkError = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: item.question, history: [], client: { platform: 'web' } }),
        signal: controller.signal,
      });
      status = res.status;
      body = await res.text();
      // A refused probe (404) counts toward the stop rule, so a rotated token ends the run instead of spending on every question.
      consecutiveUnreachable = status === 404 ? consecutiveUnreachable + 1 : 0;
    } catch (err) {
      networkError = controller.signal.aborted
        ? `no response within ${timeoutMs} ms`
        : scrub(err?.message || err?.name || 'request failed');
      if (!controller.signal.aborted) consecutiveUnreachable += 1;
    } finally {
      clearTimeout(timer);
    }
    const latency = Date.now() - t0;
    const parsed = networkError ? { reply: '', receipts: [], error: null, done: null, held: false } : parseReplyBody(body);
    const reply = scrub(parsed.reply);
    const receipts = JSON.parse(scrub(parsed.receipts));
    const error = parsed.error ? JSON.parse(scrub(parsed.error)) : null;
    const verdict = grade(item, { status, reply, receipts, networkError, error });
    // Which path produced the answer (the done frame's source and route), so an empty or odd reply can be traced.
    const source = parsed.done?.source ?? null;
    const route = parsed.done?.route ?? null;
    // The engine that wrote a model reply (provider, model, route, fallback), from the Worker's done frame.
    const sb = parsed.done?.served_by;
    const servedBy = sb && typeof sb === 'object'
      ? { provider: String(sb.provider || ''), model: String(sb.model || ''), route: sb.route ?? null, fallback: Boolean(sb.fallback) } : null;
    const modelCalls = parsed.done?.model_calls ?? null;
    const action = VALID_ANSWER_CLASSES.has(verdict.classification)
      ? actionOutcome({ classification: verdict.classification, reason: verdict.reason, receipts, done: parsed.done, held: parsed.held }) : null;
    // An unseen question may name the outcome it needs (expected_action: "executed"): a passing reply with any other
    // outcome fails, so a well-worded refusal never passes a question that asks for a real action.
    if (verdict.verdict === 'pass' && item.expected_action && action !== item.expected_action) {
      Object.assign(verdict, outcome('incorrect', `action outcome ${action}, expected ${item.expected_action}`));
    }
    const row = { ...base, verdict: verdict.verdict, classification: verdict.classification, reason: verdict.reason, http_status: status, latency_ms: latency, reply, receipts, error, source, route, served_by: servedBy, model_calls: modelCalls, action_outcome: action };
    results.push(row);
    onProgress(row);
  }

  return {
    schema: 'che-certification/1',
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    endpoint: url ? endpointLabel(url) : null,
    questions_file: questionsFile,
    summary: summarise(results),
    results,
  };
}

// ---- command line ---------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: null, category: null, limit: null, resume: null, rerun: new Set(), questions: null, baseline: null };
  for (const arg of argv) {
    if (arg.startsWith('--questions=')) opts.questions = arg.slice('--questions='.length);
    else if (arg.startsWith('--category=')) opts.category = arg.slice('--category='.length);
    else if (arg.startsWith('--resume=')) opts.resume = arg.slice('--resume='.length);
    else if (arg.startsWith('--baseline=')) opts.baseline = arg.slice('--baseline='.length);
    else if (arg.startsWith('--rerun=')) opts.rerun = new Set(arg.slice('--rerun='.length).split(',').map((c) => c.trim()).filter(Boolean));
    else if (arg.startsWith('--limit=')) opts.limit = Number(arg.slice('--limit='.length));
    else if (!arg.startsWith('--') && !opts.out) opts.out = arg;
    else return { error: `unknown argument: ${arg.startsWith('--') ? arg.split('=')[0] : 'extra path'}` };
  }
  if (!opts.out) return { error: 'usage: run_certification.mjs <results.json> [--category=NAME] [--limit=N]' };
  if (opts.category && !CATEGORIES.includes(opts.category)) return { error: `unknown category: ${opts.category}` };
  if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit < 1)) return { error: '--limit must be a positive integer' };
  return opts;
}

async function main(argv) {
  // --check-baseline=report.json: exit 0 when that report qualifies as a full, fresh run of the current 600 questions.
  if (argv.length === 1 && argv[0].startsWith('--check-baseline=')) {
    const path = argv[0].slice('--check-baseline='.length);
    let report = null;
    try { report = JSON.parse(await readFile(path, 'utf8')); } catch { /* unreadable: reported below */ }
    const problem = report ? baselineProblem(report, await loadQuestions()) : 'unreadable report';
    console.log(problem ? `not a baseline: ${problem}` : 'qualifies as a baseline');
    return problem ? 1 : 0;
  }
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(opts.error);
    return 2;
  }
  // --questions=path runs another set (unseen regression questions) with the same grader. Its shape is checked here, not
  // against the 600-question layout, and the 600-question baseline file is never changed by it.
  const questions = opts.questions ? JSON.parse(await readFile(opts.questions, 'utf8')) : await loadQuestions();
  const problems = opts.questions ? validateUnseen(questions) : validateQuestions(questions);
  if (problems.length) {
    console.error(`questions.json is invalid:\n  ${problems.slice(0, 10).join('\n  ')}`);
    return 2;
  }
  let picked = 0;
  const select = (item) => {
    if (opts.category && item.category !== opts.category) return false;
    if (opts.limit !== null && picked >= opts.limit) return false;
    picked += 1;
    return true;
  };
  const url = process.env.CHE_CHAT_URL || '';
  const token = process.env.CHE_PROBE_TOKEN || '';
  // --resume=earlier.json keeps each real graded answer (pass or fail, not a refused probe) and runs only the rest.
  let reuse = new Map();
  if (opts.resume) {
    const earlier = JSON.parse(await readFile(opts.resume, 'utf8'));
    reuse = reuseFrom(earlier.results || [], opts.rerun);
    console.log(`resuming: ${reuse.size} graded answers kept from ${opts.resume}`);
  }
  const report = await runCertification({
    url, token, questions, select, reuse, questionsFile: opts.questions || QUESTIONS_PATH,
    // Every non-pass prints its class, its reason and the start of CHE's reply, so the failures can be audited from the log.
    onProgress: (row) => console.log(row.verdict === 'pass'
      ? `${row.id} pass action=${row.action_outcome ?? "none"} source=${row.source ?? "none"} engine=${engineLabel(row)} ms=${row.latency_ms}`
      : `${row.id} ${row.verdict} [${row.classification}] action=${row.action_outcome ?? "none"} (${row.reason}) source=${row.source ?? 'none'} route=${row.route ?? 'none'} engine=${engineLabel(row)} ms=${row.latency_ms} :: ${String(row.reply || '').replace(/\s+/g, ' ').slice(0, 600)}`),
  });
  const out = opts.out;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  const s = report.summary;
  console.log(`pass ${s.pass}  fail ${s.fail}  blocked ${s.blocked}  not_run ${s.not_run}  of ${s.total}`);
  console.log(`valid CHE answers ${s.valid_answers}  score ${s.score ?? 'n/a'}  by class ${JSON.stringify(s.by_classification)}`);
  console.log(`action outcomes ${JSON.stringify(s.by_action_outcome)}`);
  console.log(`engines ${JSON.stringify(s.by_engine)}`);
  if (s.latency_ms) console.log(`latency ms p50 ${s.latency_ms.p50}  p95 ${s.latency_ms.p95}  max ${s.latency_ms.max}`);
  // --baseline=earlier.json: the change against an earlier run, and a GitHub error annotation on a real regression.
  if (opts.baseline) {
    const baseline = JSON.parse(await readFile(opts.baseline, 'utf8'));
    const cmp = compareRuns(report, baseline);
    report.comparison = { baseline: opts.baseline, ...cmp };
    await writeFile(out, JSON.stringify(report, null, 2) + '\n');
    console.log(`against baseline: ${cmp.pass_before} -> ${cmp.pass_now} (${cmp.delta >= 0 ? '+' : ''}${cmp.delta}); lost ${cmp.lost.length}, gained ${cmp.gained.length}`);
    if (cmp.lost.length) console.log(`lost: ${cmp.lost.join(' ')}`);
    if (cmp.regression) console.log(`::error title=Certification regression::${cmp.pass_before} -> ${cmp.pass_now} passes (${cmp.delta}) against the baseline run`);
  }
  console.log(`wrote ${out}`);
  if (s.fail > 0) return 1;
  if (s.blocked > 0) return 3;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`certification failed: ${err?.message || err}`);
    process.exitCode = 2;
  });
}
