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
// Verdicts per question:
//   pass     the reply met every check for the question (see grade()).
//   fail     the endpoint answered, and the reply broke a check.
//   blocked  the question could not be asked: endpoint unreachable, not configured, timed out, refused (401/403),
//            or a gateway error (502-504, 520-527). A blocked question is never a pass.
//   not_run  the question was left out by --category or --limit.
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

const BLOCKED_STATUS = new Set([401, 403, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527]);
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
    };
  } catch (_) {
    let reply = '';
    const receipts = [];
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
    }
    if (!sawLine) return { reply: raw.trim(), receipts: [] };
    return { reply, receipts };
  }
}

const lower = (s) => String(s).toLowerCase();

// Whether a term appears in the reply, case-insensitively. A term that is only digits must not sit inside a longer
// number, so "6" does not pass on "16" or "2026". Other terms match as substrings.
export function termFound(text, term) {
  const t = lower(term).trim();
  if (!t) return false;
  const s = lower(text);
  if (/^\d+$/.test(t)) return new RegExp(`(?<!\\d)${t}(?!\\d)`).test(s);
  return s.includes(t);
}

// Grades one reply. status is the HTTP status, or null when no response arrived.
// A pass needs all of: every required term group satisfied, no must_not_contain term, and (when receipt_required) at
// least one execution receipt. A reply that claims an action with no receipt fails too.
export function grade(item, { status, reply = '', receipts = [], networkError = null }) {
  if (networkError) return { verdict: 'blocked', reason: `endpoint unreachable: ${networkError}` };
  if (status === null || status === undefined) return { verdict: 'blocked', reason: 'no HTTP response' };
  // The probe route answers 404 when the token does not match (it is closed to anyone else). That is a refused probe,
  // not a CHE answer: it is not graded as a failure. A deploy rotates the token, which caused 393 of these in run 40942525092.
  if (status === 404) return { verdict: 'blocked', reason: 'HTTP 404: the probe route refused the token (rotated during the run, or route closed); not graded' };
  if (BLOCKED_STATUS.has(status)) {
    const why = status === 401 || status === 403 ? 'token refused' : 'gateway or origin error';
    return { verdict: 'blocked', reason: `HTTP ${status}: ${why}` };
  }
  if (status < 200 || status > 299) return { verdict: 'fail', reason: `HTTP ${status}` };
  if (!reply.trim()) return { verdict: 'fail', reason: 'empty reply' };
  const receiptCount = Array.isArray(receipts) ? receipts.filter((r) => r && typeof r === 'object').length : 0;
  if (item.receipt_required && receiptCount === 0) {
    return { verdict: 'fail', reason: 'receipt required but no execution receipt returned' };
  }
  const exp = item.expected || {};
  const groups = termGroups(exp.must_contain_any);
  const missing = groups.findIndex((group) => !group.some((term) => termFound(reply, term)));
  if (missing !== -1) {
    return { verdict: 'fail', reason: `reply lacks every term of required group ${missing + 1} of ${groups.length}` };
  }
  const forbidden = (exp.must_not_contain || []).find((term) => termFound(reply, term));
  if (forbidden !== undefined) return { verdict: 'fail', reason: `reply contains forbidden text: ${forbidden}` };
  const text = lower(reply);
  if (receiptCount === 0) {
    const claim = CLAIM_PHRASES.find((p) => text.includes(p));
    if (claim) return { verdict: 'fail', reason: `claims an action with no receipt: "${claim}"` };
  }
  return { verdict: 'pass', reason: 'all checks met' };
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

function summarise(results) {
  const summary = { total: results.length, pass: 0, fail: 0, blocked: 0, not_run: 0, by_category: {} };
  for (const r of results) {
    summary[r.verdict] += 1;
    const c = (summary.by_category[r.category] ??= { pass: 0, fail: 0, blocked: 0, not_run: 0 });
    c[r.verdict] += 1;
  }
  return summary;
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
      results.push({ ...base, verdict: 'not_run', reason: 'not selected', http_status: null, latency_ms: 0, reply: '', receipts: [] });
      continue;
    }
    // A question already graded by an earlier run is kept as it was (no second paid turn for it).
    if (reuse.has(item.id)) {
      results.push({ ...reuse.get(item.id), reused_from_earlier_run: true });
      continue;
    }
    if (notConfigured.length) {
      results.push({ ...base, verdict: 'blocked', reason: notConfigured.join('; '), http_status: null, latency_ms: 0, reply: '', receipts: [] });
      continue;
    }
    if (consecutiveUnreachable >= CONSECUTIVE_UNREACHABLE_LIMIT) {
      results.push({ ...base, verdict: 'blocked', reason: 'endpoint unreachable; skipped after repeated failures', http_status: null, latency_ms: 0, reply: '', receipts: [] });
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
    const parsed = networkError ? { reply: '', receipts: [] } : parseReplyBody(body);    const reply = scrub(parsed.reply);
    const receipts = JSON.parse(scrub(parsed.receipts));
    const verdict = grade(item, { status, reply, receipts, networkError });
    const row = { ...base, verdict: verdict.verdict, reason: verdict.reason, http_status: status, latency_ms: latency, reply, receipts };
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
  const opts = { out: null, category: null, limit: null, resume: null };
  for (const arg of argv) {
    if (arg.startsWith('--category=')) opts.category = arg.slice('--category='.length);
    else if (arg.startsWith('--resume=')) opts.resume = arg.slice('--resume='.length);
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
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(opts.error);
    return 2;
  }
  const questions = await loadQuestions();
  const problems = validateQuestions(questions);
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
  const reuse = new Map();
  if (opts.resume) {
    const earlier = JSON.parse(await readFile(opts.resume, 'utf8'));
    for (const row of earlier.results || []) {
      if ((row.verdict === 'pass' || row.verdict === 'fail') && row.http_status !== 404) reuse.set(row.id, row);
    }
    console.log(`resuming: ${reuse.size} graded answers kept from ${opts.resume}`);
  }
  const report = await runCertification({
    url, token, questions, select, reuse,
    onProgress: (row) => console.log(`${row.id} ${row.verdict}${row.verdict === 'pass' ? '' : ` (${row.reason})`}`),
  });
  const out = opts.out;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  const s = report.summary;
  console.log(`pass ${s.pass}  fail ${s.fail}  blocked ${s.blocked}  not_run ${s.not_run}  of ${s.total}`);
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
