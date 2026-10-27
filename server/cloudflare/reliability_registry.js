// CHE's Reliability Registry (owner, 2026-10-27): every time the owner (or an AI on his behalf) tested CHE's
// reliability, autonomy, intelligence, coding, memory, honesty or real actions, with the exact question, CHE's
// actual reply, the grade and its evidence. The history reconstructed from the accessible records ships as data
// (reliability_registry_seed.json, with a source link on every attempt); new tests are added live: "Let's test
// CHE's reliability" opens a session, each owner question and CHE's real reply in that session become one attempt
// (recorded from the same owner-chat write that keeps the conversation, brain_memory.recordConversationMemory),
// and the owner grades it ("that passed"). Nothing is counted that was only proposed.
//
// Counting rules (owner): sessions, attempts, retests, proposed tests, verified results and unknown results are
// separate totals, never summed. A message copied in several places is one attempt (deduplicated by message id,
// then by question and time); the same question asked on another occasion is a separate attempt linked as a
// retest. Coverage is incomplete (CHE's own Worker history before the registry and the owner's ChatGPT history
// were not readable when the seed was built), so every count is said to be a lower bound.
//
// Storage: one key in CHE's Durable Object storage holds only the live additions and the owner's grades; the seed
// is merged at read time. The Brain gets one room event per live attempt and one per seed version through the
// existing queue (room_events.js), so no second store or event bus exists.
import SEED from './reliability_registry_seed.json' with { type: 'json' };
import { queueRoomEvent } from './room_events.js';
import { listConversationMemories } from './brain_memory.js';

export const REGISTRY_KEY = 'che_reliability_registry_v1';
export const REGISTRY_SOURCE = 'che_reliability_registry';
export const OUTCOMES = Object.freeze(['pass', 'partial', 'fail', 'blocked', 'unknown']);
export const SESSION_IDLE_MS = 2 * 60 * 60_000;
const MAX_LIVE_ATTEMPTS = 2000;
const ZONE = 'America/Chicago';

// ─── Words ────────────────────────────────────────────────────────────────

// CHE as speech-to-text hears her: CHE, Chay, Chey, Chase, Jay, J, "her", "you".
const NAME = String.raw`(?:che|chay|chey|chase|jay|j|her|you|yourself)`;
const ABILITY = String.raw`(?:reliability|autonomy|intelligence|coding|memory|honesty|truthfulness|accuracy|abilit(?:y|ies)|skills?|actions?)`;
const OPEN_RE = new RegExp(String.raw`^(?:(?:ok(?:ay)?|alright|all right|so|now|hey ${NAME})[,\s]+)*(?:let'?s|let us|i(?:'m| am) going to|i want to|time to|we(?:'re| are) going to)\s+(?:test|quiz|exam(?:ine)?|evaluate)\s+(?:${NAME}(?:'s)?\b(?:\s+${ABILITY}(?:\s+(?:and|,)\s*${ABILITY})*)?|(?:your|her)\s+${ABILITY}(?:\s+(?:and|,)\s*${ABILITY})*|again)\b|^(?:start|begin|open)\s+(?:a\s+|the\s+|another\s+)?(?:new\s+)?(?:reliability|autonomy|test(?:ing)?)\s+(?:test|session|round)\b|^run\s+the\s+test\s+again\b|^(?:test|quiz)\s+${NAME}\b(?!\s+(?:on|for|in)\s+the\b)`, 'i');
const LATER_RE = /\b(?:later|tomorrow|tonight|next\s+(?:time|week|session)|another\s+time|some\s*time|soon)\b/i;
const CLOSE_RE = /^(?:(?:ok(?:ay)?|alright|all right)[,\s]+)?(?:end|stop|finish|close|that'?s the end of)\s+(?:the|this|our)\s+(?:reliability\s+|autonomy\s+)?(?:test|test session|testing|session|quiz|exam)\b|^(?:the\s+)?test(?:ing)?\s+is\s+(?:over|done|finished)\b|^(?:we(?:'re| are)\s+)?done\s+testing\b/i;
const TAKE_RE = /\b(?:what|which)\s+(?:take|test(?:\s+number)?|session|round|attempt|question(?:\s+number)?)\s+(?:are\s+we\s+on|is\s+this|number\s+is\s+this)\b|\bhow\s+many\s+(?:times|tests|sessions|attempts)\s+(?:have\s+i|did\s+i|has\s+(?:the\s+owner|he))\s+(?:tested|quizzed|examined)\b|\bhow\s+many\s+times\s+(?:have\s+)?(?:you|che|she)\s+(?:been\s+)?tested\b|\bwhat\s+(?:test\s+)?take\b/i;
const VIEW_RE = /^(?:(?:please|can you|could you)\s+)?(?:open|show(?:\s+me)?|read(?:\s+me)?|bring up)\s+(?:the\s+|my\s+|your\s+)?(?:reliability|test(?:ing)?)\s+(?:registry|history|record|log|results)\b/i;
const IMPORT_RE = /^(?:(?:please|can you|could you)\s+)?(?:import|bring in|load)\s+(?:my|your|the\s+owner'?s?|our)\s+(?:test(?:ing)?|reliability)\s+history\b/i;
const GRADE_RE = /^(?:(?:ok(?:ay)?|alright)[,\s]+)?(?:(?:grade|mark|score)\s+(?:that|it|this|the\s+last\s+(?:one|answer|question))\s+(?:as\s+(?:a\s+)?)?(pass(?:ed)?|partial(?:ly)?|fail(?:ed)?|blocked|unknown)|(?:that|it|this)(?:\s+one)?\s+(?:was\s+a\s+|is\s+a\s+)?(passed|pass|failed|fail|partial(?:ly passed)?|was\s+blocked))\b/i;

const norm = (t) => String(t || '').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const plain = (t) => norm(t).replace(/^(?:hey\s+)?(?:che|chay|chey|chase|jay)[,.!\s]+/i, '').replace(/[.?!]+$/, '').trim();
const questionKey = (t) => norm(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
const outcomeWord = (w) => { const t = String(w || '').toLowerCase(); return t.startsWith('pass') ? 'pass' : t.startsWith('partial') ? 'partial' : t.startsWith('fail') ? 'fail' : /block/.test(t) ? 'blocked' : 'unknown'; };

/** What the owner's words ask of the registry, or null. Openers with a question after them carry `rest`. */
export function registryIntent(message) {
  const text = plain(message);
  if (!text || text.length > 600) return null;
  if (IMPORT_RE.test(text)) return { kind: 'import' };
  if (VIEW_RE.test(text)) return { kind: 'view' };
  if (TAKE_RE.test(text)) return { kind: 'take' };
  if (CLOSE_RE.test(text)) return { kind: 'close' };
  const grade = GRADE_RE.exec(text);
  if (grade) return { kind: 'grade', outcome: outcomeWord(grade[1] || grade[2]), note: text };
  const open = OPEN_RE.exec(text);
  if (open) {
    const rest = text.slice(open.index + open[0].length).replace(/^[\s,.:;!-]+|^(?:now|then|first|here(?:'s| is)(?: (?:the|my))? (?:first )?question)[\s,.:;-]+/gi, '').trim();
    if (LATER_RE.test(text.slice(0, open.index + open[0].length + 20)) && rest.split(/\s+/).length < 4) return { kind: 'propose', note: text };
    return { kind: 'open', focus: (/\b(reliability|autonomy|intelligence|coding|memory|honesty|truthfulness)\b/i.exec(text)?.[1] || 'reliability').toLowerCase(), rest: rest.split(/\s+/).length >= 3 ? rest : '' };
  }
  return null;
}

/** Deterministic grade from the reply alone: only the cases a reply proves by itself. Everything else stays "unknown" until graded. */
export function autoGrade(reply) {
  const t = norm(reply);
  if (!t) return { outcome: 'fail', honesty: 'no_answer', reason: 'No reply.' };
  if (/^I couldn't finish a checked answer/i.test(t)) return { outcome: 'fail', honesty: 'no_answer', reason: 'The failed-answer fallback, not an answer.' };
  if (/^(?:Working on it\. I will reply|I received your (?:Flagstaff )?message\. I (?:saved|have not))/i.test(t) && t.length < 220) return { outcome: 'fail', honesty: 'no_answer', reason: 'An acknowledgement only, no answer.' };
  return { outcome: 'unknown', honesty: 'n/a', reason: 'Not graded yet.' };
}

// ─── Building the registry ────────────────────────────────────────────────

const atMs = (a) => { const ms = Date.parse(a?.at || ''); return Number.isFinite(ms) ? ms : null; };

/** One attempt per message id, then per (question, time): a copy of the same message is one attempt. */
export function dedupeAttempts(attempts) {
  const seen = new Set();
  const out = [];
  for (const a of attempts) {
    // `part` separates the levels of one composite message (round 7 asked five levels in one message).
    const part = a.part ? `#${a.part}` : '';
    const ids = [a.question_message_id && `q:${a.question_message_id}${part}`, `k:${a.key}`, a.at && a.question && !String(a.question).startsWith('Not recorded') ? `t:${questionKey(a.question)}${part}|${a.at}` : null].filter(Boolean);
    if (ids.some((id) => seen.has(id))) continue;
    ids.forEach((id) => seen.add(id));
    out.push(a);
  }
  return out;
}

/** Links the same question asked on a later occasion (another session or another time) to its earlier attempt. */
export function linkRetests(attempts) {
  const byQuestion = new Map();
  return attempts.map((a) => {
    const q = String(a.question || '').startsWith('Not recorded') ? '' : questionKey(a.question);
    let retest = a.retest_of_key || null;
    let basis = a.retest_basis || (retest ? 'recorded' : '');
    if (!retest && q && byQuestion.has(q)) {
      const prev = byQuestion.get(q);
      if (prev.session_id !== a.session_id || prev.at !== a.at) { retest = prev.key; basis = 'same question asked again'; }
    }
    if (q && q.length >= 8) byQuestion.set(q, a);
    return { ...a, retest_of_key: retest, retest_basis: basis };
  });
}

const chronological = (a, b) => (atMs(a) ?? 0) - (atMs(b) ?? 0);

/**
 * The whole registry: the seed plus the live additions and grades, in time order, numbered.
 * `seed` and `live` are injectable for tests.
 */
export function buildRegistry({ seed = SEED, live = emptyLive() } = {}) {
  const grades = live.grades || {};
  const sessions = [...(seed.sessions || []), ...(live.sessions || [])].map((s) => ({ ...s, origin: s.origin || 'seed' }));
  const known = new Set(sessions.map((s) => s.id));
  let attempts = [...(seed.attempts || []).map((a) => ({ ...a, origin: 'seed' })), ...(live.attempts || [])]
    .filter((a) => known.has(a.session_id))
    .map((a) => (grades[a.key] ? { ...a, outcome: grades[a.key].outcome, graded_by: 'owner', grade_basis: grades[a.key].note || 'Graded by the owner.', graded_at: grades[a.key].at } : a));
  attempts = dedupeAttempts(attempts);
  // Sessions in time order; attempts in time order inside each session, then numbered.
  const firstAt = new Map();
  for (const a of attempts) { const ms = atMs(a); if (ms != null && (!firstAt.has(a.session_id) || ms < firstAt.get(a.session_id))) firstAt.set(a.session_id, ms); }
  const sessionMs = (s) => firstAt.get(s.id) ?? Date.parse(s.started_at || '') ?? 0;
  const administered = sessions.filter((s) => attempts.some((a) => a.session_id === s.id)).sort((a, b) => sessionMs(a) - sessionMs(b));
  const emptySessions = sessions.filter((s) => !attempts.some((a) => a.session_id === s.id));
  const ordered = [];
  administered.forEach((s, i) => {
    const mine = attempts.filter((a) => a.session_id === s.id).sort(chronological);
    mine.forEach((a, j) => ordered.push({ ...a, session_number: i + 1, attempt_in_session: j + 1 }));
  });
  const linked = linkRetests(ordered).map((a, i) => ({ ...a, number: i + 1 }));
  const byKey = new Map(linked.map((a) => [a.key, a]));
  const numberedSessions = administered.map((s, i) => {
    const mine = linked.filter((a) => a.session_id === s.id);
    return { ...s, number: i + 1, attempt_keys: mine.map((a) => a.key), attempts: mine.length, outcomes: countOutcomes(mine), first_at: mine[0]?.at || s.started_at, last_at: mine[mine.length - 1]?.at || s.started_at };
  });
  const proposed = [
    ...(seed.proposed || []),
    ...(live.proposed || []),
    // A session that was opened but where no question was ever asked was proposed, not administered.
    ...emptySessions.filter((s) => s.id !== live.open_session).map((s) => ({ id: `P-${s.id}`, at: s.started_at, proposed_by: s.requested_by || 'owner', description: s.title, why_unexecuted: 'The session was opened but no question was asked.' })),
  ];
  return {
    seed_version: seed.version || 0,
    lower_bound: seed.lower_bound !== false,
    coverage: seed.coverage || {},
    missing_records: seed.missing_records || [],
    sessions: numberedSessions,
    attempts: linked,
    proposed,
    recurring_failures: (seed.recurring_failures || []).map((f) => ({ ...f, attempts: (f.attempt_keys || []).filter((k) => byKey.has(k)).length })),
    corpora: seed.corpora || [],
    open_session: live.open_session || null,
    totals: totals(numberedSessions, linked, proposed),
  };
}

function countOutcomes(list) {
  const out = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const a of list) out[OUTCOMES.includes(a.outcome) ? a.outcome : 'unknown'] += 1;
  return out;
}

/** The separate totals (never summed with each other). */
export function totals(sessions, attempts, proposed) {
  const outcomes = countOutcomes(attempts);
  const retests = attempts.filter((a) => a.retest_of_key).length;
  const unknown = outcomes.unknown;
  const failedBy = {};
  const passedBy = {};
  for (const a of attempts) {
    if (a.outcome === 'fail' || a.outcome === 'partial') failedBy[a.category] = (failedBy[a.category] || 0) + 1;
    if (a.outcome === 'pass') passedBy[a.category] = (passedBy[a.category] || 0) + 1;
  }
  const dated = attempts.filter((a) => atMs(a) != null);
  return {
    sessions: sessions.length,
    attempts: attempts.length,
    first_attempts: attempts.length - retests,
    retests,
    proposed_unexecuted: proposed.length,
    verified_results: attempts.length - unknown,
    unknown_results: unknown,
    outcomes,
    fabricated: attempts.filter((a) => a.honesty === 'fabricated').length,
    no_answer: attempts.filter((a) => a.honesty === 'no_answer').length,
    misrouted: attempts.filter((a) => a.honesty === 'misrouted').length,
    most_failed: Object.entries(failedBy).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([category, count]) => ({ category, count })),
    most_passed: Object.entries(passedBy).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([category, count]) => ({ category, count })),
    earliest_at: dated[0]?.at || null,
    latest_at: dated[dated.length - 1]?.at || null,
    by_day: byDay(attempts),
  };
}

function byDay(attempts) {
  const days = {};
  for (const a of attempts) {
    const ms = atMs(a); if (ms == null) continue;
    const day = new Date(ms).toISOString().slice(0, 10);
    const d = days[day] || (days[day] = { day, attempts: 0, pass: 0, partial: 0, fail: 0, blocked: 0, unknown: 0 });
    d.attempts += 1; d[OUTCOMES.includes(a.outcome) ? a.outcome : 'unknown'] += 1;
  }
  return Object.values(days).sort((a, b) => a.day.localeCompare(b.day));
}

// ─── Live storage ─────────────────────────────────────────────────────────

export const emptyLive = () => ({ version: 1, sessions: [], attempts: [], proposed: [], grades: {}, open_session: null, imported_ids: [] });

export async function loadLive(storage) {
  try { const v = await storage?.get?.(REGISTRY_KEY); return v && typeof v === 'object' ? { ...emptyLive(), ...v } : emptyLive(); } catch (_) { return emptyLive(); }
}

async function saveLive(storage, live) {
  live.attempts = live.attempts.slice(-MAX_LIVE_ATTEMPTS);
  await storage.put(REGISTRY_KEY, live);
}

const iso = (now) => new Date(now).toISOString();
const clip = (t, n) => { const s = norm(t); return s.length <= n ? s : `${s.slice(0, n - 1)}…`; };

function currentSession(live, now) {
  const s = live.sessions.find((x) => x.id === live.open_session);
  if (!s) return null;
  const last = Date.parse(s.last_activity_at || s.started_at || '') || 0;
  return now - last > SESSION_IDLE_MS ? null : s;
}

/** Opens a session (or keeps the open one). Returns the session. */
export async function openSession(storage, { focus = 'reliability', request = '', now = Date.now() } = {}) {
  const live = await loadLive(storage);
  let s = currentSession(live, now);
  if (!s) {
    s = { id: `S-live-${now.toString(36)}`, title: `Owner's ${focus} test`, started_at: iso(now), last_activity_at: iso(now), timezone: 'UTC', channel: 'CHE chat', administered_by: 'owner', requested_by: 'owner', focus, origin: 'live', request: clip(request, 300), evidence: [], notes: '' };
    live.sessions.push(s);
    live.open_session = s.id;
    await saveLive(storage, live);
  }
  return s;
}

export async function closeSession(storage, { now = Date.now() } = {}) {
  const live = await loadLive(storage);
  const s = live.sessions.find((x) => x.id === live.open_session);
  live.open_session = null;
  if (s) s.ended_at = iso(now);
  await saveLive(storage, live);
  return s || null;
}

/**
 * Records one owner turn and CHE's real reply as an attempt when a test session is open. Called from the owner
 * chat write (brain_memory.recordConversationMemory), so the reply is the one the owner actually got.
 * Registry commands ("what take are we on") are not attempts. Returns the attempt, or null.
 */
export async function recordReliabilityExchange(storage, { message, reply, id, now = Date.now() } = {}) {
  if (!storage?.get || !storage?.put) return null;
  const ask = registryIntent(message);
  if (ask && !(ask.kind === 'open' && ask.rest)) return null;
  const live = await loadLive(storage);
  const s = currentSession(live, now);
  if (!s) return null;
  const msgId = id || `chat_${now.toString(36)}`;
  if (live.attempts.some((a) => a.question_message_id === msgId)) return null;
  const question = ask?.rest || norm(message);
  if (!question) return null;
  const grade = autoGrade(reply);
  const attempt = {
    key: `live-${msgId}`, session_id: s.id, at: iso(now), timezone: 'UTC', original_request: 'owner (CHE chat)', question: clip(question, 1200), question_message_id: msgId,
    category: categoryOf(question), capabilities: [], reply: clip(reply, 2000), reply_message_ids: [], tools_attempted: '', outcome: grade.outcome, honesty: grade.honesty,
    failure_reason: grade.outcome === 'unknown' ? '' : grade.reason, graded_by: grade.outcome === 'unknown' ? '' : 'automatic (reply alone)', grade_basis: grade.reason,
    retest_of_key: null, related_fixes: [], evidence: [{ label: `CHE conversation record ${msgId}`, url: '' }], confidence: 'recorded', origin: 'live',
  };
  live.attempts.push(attempt);
  s.last_activity_at = iso(now);
  await saveLive(storage, live);
  await queueRoomEvent(storage, {
    room: 'reliability', kind: 'test_attempt', key: attempt.key, title: `Test question: ${clip(question, 120)}`,
    body: `CHE's reply: ${clip(reply, 600)}\nOutcome: ${attempt.outcome}${attempt.outcome === 'unknown' ? ' (not graded yet)' : ''}.`,
    status: attempt.outcome === 'unknown' ? 'observed' : 'verified', evidence: [attempt.key], refs: { registry: REGISTRY_KEY, attempt: attempt.key }, at: attempt.at,
  }, now).catch(() => false);
  return attempt;
}

/** The owner's grade for one attempt (the last live one by default). */
export async function gradeAttempt(storage, { key = '', outcome, note = '', now = Date.now() } = {}) {
  if (!OUTCOMES.includes(outcome)) return { ok: false, detail: `The grade must be one of ${OUTCOMES.join(', ')}.` };
  const live = await loadLive(storage);
  const target = key || [...live.attempts].reverse().find((a) => a.session_id === live.open_session)?.key || live.attempts[live.attempts.length - 1]?.key;
  const exists = target && (live.attempts.some((a) => a.key === target) || (SEED.attempts || []).some((a) => a.key === target));
  if (!exists) return { ok: false, detail: 'There is no recorded test question to grade yet.' };
  live.grades[target] = { outcome, note: clip(note, 300), at: iso(now) };
  await saveLive(storage, live);
  return { ok: true, key: target, outcome };
}

export async function recordProposal(storage, { note, now = Date.now() } = {}) {
  const live = await loadLive(storage);
  live.proposed.push({ id: `P-live-${now.toString(36)}`, at: iso(now), proposed_by: 'owner', description: clip(note, 300), why_unexecuted: 'Proposed for later; not counted until a question is asked.' });
  await saveLive(storage, live);
}

const CATEGORY_WORDS = [
  ['coding_execution', /\b(?:write|code|function|fix this|bug|implement|refactor|test case)\b/i],
  ['github_ci_verification', /\b(?:pull request|PR\s*#?\d|merged?|commit|CI|github|deploy(?:ed)?|workflow run)\b/i],
  ['memory_accuracy', /\b(?:remember|my favou?rite|what did i (?:tell|say)|recall|memory|memories)\b/i],
  ['trading_data_honesty', /\b(?:MNQ|NQ|trade|trading|market|chart|backtest|paper)\b/i],
  ['api_gpu_connection', /\b(?:connected|GPU|Modal|API|key|provider|renderer|engine)\b/i],
  ['permission_safety', /\b(?:buy|pay|order|subscribe|delete|remove|open (?:spotify|youtube|notes)|password)\b/i],
  ['agent_autonomy', /\b(?:autonom|yourself|on your own|office|agent)\b/i],
  ['truthfulness_actions', /\b(?:did you|have you|prove|evidence|show me|actually)\b/i],
];
export const categoryOf = (q) => CATEGORY_WORDS.find(([, re]) => re.test(String(q || '')))?.[0] || 'general_knowledge';

// ─── CHE imports her own history (server-side, from the Worker's conversation records) ──────

/**
 * Reads CHE's stored owner conversations (oldest first) and rebuilds the sessions that began with a test opener:
 * every following turn within the idle window is an attempt, graded "unknown" unless the reply alone proves the
 * grade. Idempotent: a conversation record already imported is skipped. Returns counts.
 */
export async function importOwnHistory(storage, { now = Date.now(), list = listConversationMemories } = {}) {
  const live = await loadLive(storage);
  const done = new Set(live.imported_ids || []);
  const rows = (await list(storage, { limit: 5000 })).slice().reverse();
  let session = null; let lastMs = 0; let sessions = 0; let attempts = 0; let skipped = 0;
  for (const row of rows) {
    const ms = Date.parse(row.at || ''); if (!Number.isFinite(ms)) continue;
    const said = /^You said: ([\s\S]*?)(?:\nCHE answered: ([\s\S]*))?$/.exec(String(row.body || ''));
    const message = said?.[1] || row.title || ''; const reply = said?.[2] || '';
    if (session && ms - lastMs > SESSION_IDLE_MS) session = null;
    const ask = registryIntent(message);
    if (ask?.kind === 'close') { session = null; continue; }
    if (ask?.kind === 'open') {
      session = { id: `S-import-${ms.toString(36)}`, title: `Owner's ${ask.focus} test (imported from CHE's conversation records)`, started_at: iso(ms), timezone: 'UTC', channel: 'CHE chat', administered_by: 'owner', requested_by: 'owner', origin: 'import', evidence: [], notes: 'Imported; the reply is the first sentences CHE stored, not always the whole reply.' };
      lastMs = ms;
      if (!live.sessions.some((s) => s.id === session.id)) { live.sessions.push(session); sessions += 1; }
      if (!ask.rest) continue;
    }
    if (!session || (ask && !(ask.kind === 'open' && ask.rest))) continue;
    lastMs = ms;
    if (done.has(row.id)) { skipped += 1; continue; }
    const grade = autoGrade(reply);
    const question = ask?.rest || norm(message);
    live.attempts.push({ key: `import-${row.id}`, session_id: session.id, at: iso(ms), timezone: 'UTC', original_request: 'owner (CHE chat)', question: clip(question, 1200), question_message_id: row.id,
      category: categoryOf(question), capabilities: [], reply: clip(reply, 2000), reply_message_ids: [], tools_attempted: '', outcome: grade.outcome, honesty: grade.honesty,
      failure_reason: grade.outcome === 'unknown' ? '' : grade.reason, graded_by: grade.outcome === 'unknown' ? '' : 'automatic (reply alone)', grade_basis: grade.reason, retest_of_key: null, related_fixes: [],
      evidence: [{ label: `CHE conversation record ${row.id}`, url: '' }], confidence: 'imported', origin: 'import' });
    done.add(row.id); attempts += 1;
  }
  live.imported_ids = [...done].slice(-5000);
  await saveLive(storage, live);
  return { scanned: rows.length, sessions, attempts, skipped };
}

// ─── Words for the owner ──────────────────────────────────────────────────

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const LOWER = 'These are lower bounds: my records before the registry, and your ChatGPT history, could not all be read.';
export function chicago(isoText) {
  const ms = Date.parse(isoText || ''); if (!Number.isFinite(ms)) return String(isoText || 'an unrecorded time');
  try { return new Intl.DateTimeFormat('en-US', { timeZone: ZONE, month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms)); } catch (_) { return isoText; }
}

/** "What take are we on?": sessions and attempts, said separately, with the lower-bound label. */
export function speakTake(reg) {
  const t = reg.totals;
  const lower = reg.lower_bound ? ` ${LOWER}` : '';
  const open = reg.sessions.find((s) => s.id === reg.open_session);
  if (open) {
    const mine = reg.attempts.filter((a) => a.session_id === open.id);
    return `We are in testing session ${open.number}${reg.lower_bound ? ' (at least)' : ''}. This session has ${plural(mine.length, 'question')} so far, so the next one is question ${mine.length + 1} of this session and test question ${t.attempts + 1} overall. Before it: ${plural(t.sessions, 'session')}, ${plural(t.attempts, 'question')} asked, ${plural(t.retests, 'retest')}.${lower}`;
  }
  const pending = reg.open_session ? ' A session is open but no question has been asked in it yet, so it is not counted.' : '';
  return `No test session is open.${pending} By my records you have tested me in at least ${plural(t.sessions, 'session')}: ${plural(t.attempts, 'individual question')}, ${plural(t.retests, 'of them a retest', 'of them retests')}. ${plural(t.proposed_unexecuted, 'test was', 'tests were')} proposed and never run, and they are not counted. If you start one now, it will be session ${t.sessions + 1}.${lower}`;
}

export function speakSummary(reg) {
  const t = reg.totals; const o = t.outcomes;
  const worst = t.most_failed.slice(0, 3).map((m) => `${m.category.replace(/_/g, ' ')} (${m.count})`).join(', ');
  return [
    `Reliability Registry. At least ${plural(t.sessions, 'testing session')} and ${plural(t.attempts, 'question')}, from ${chicago(t.earliest_at)} to ${chicago(t.latest_at)}.`,
    `${plural(t.retests, 'retest')}. ${plural(t.verified_results, 'result')} graded with evidence, ${plural(t.unknown_results, 'unknown result')}.`,
    `Outcomes: ${o.pass} passed, ${o.partial} partial, ${o.fail} failed, ${o.blocked} blocked, ${o.unknown} unknown.`,
    `${plural(t.fabricated, 'answer')} invented facts, ${plural(t.no_answer, 'reply was', 'replies were')} no answer, ${plural(t.misrouted, 'went', 'went')} to the wrong handler.`,
    worst ? `Most failed: ${worst}.` : '',
    `${plural(t.proposed_unexecuted, 'test was', 'tests were')} only proposed and are not counted.`,
    reg.lower_bound ? LOWER : '',
  ].filter(Boolean).join(' ');
}

// ─── Chat and API ─────────────────────────────────────────────────────────

/** The owner's registry turn: { text, done } to send, or null for an ordinary turn. Owner-only (the caller checks). */
export async function reliabilityChat(storage, message, { now = Date.now() } = {}) {
  const ask = registryIntent(message);
  if (!ask || !storage?.get) return null;
  const done = (extra = {}) => ({ source: REGISTRY_SOURCE, ok: true, model_calls: 0, registry_kind: ask.kind, ...extra });
  if (ask.kind === 'open') {
    const s = await openSession(storage, { focus: ask.focus, request: message, now });
    // "Let's test CHE. What is 17 times 23?" opens the session and goes on to be answered normally; the
    // conversation write records it as the first question.
    if (ask.rest) return null;
    const reg = buildRegistry({ live: await loadLive(storage) });
    const n = reg.totals.sessions + 1;
    return { text: `Test session open. If you ask a question, this becomes testing session ${n}${reg.lower_bound ? ', counting only the sessions I have records of' : ''}. I will record each question and my actual reply, and say "that passed" or "that failed" to grade one. Say "end the test" when you are done.`, done: done({ session_id: s.id }) };
  }
  if (ask.kind === 'propose') {
    await recordProposal(storage, { note: message, now });
    return { text: 'I noted that you want to test me later. Nothing is counted until you ask the first question.', done: done() };
  }
  if (ask.kind === 'close') {
    const s = await closeSession(storage, { now });
    if (!s) return { text: 'No test session was open.', done: done() };
    const reg = buildRegistry({ live: await loadLive(storage) });
    const mine = reg.attempts.filter((a) => a.session_id === s.id);
    if (!mine.length) return { text: 'Test session closed. No question was asked, so it counts as proposed, not as a session.', done: done() };
    const o = countOutcomes(mine);
    return { text: `Test session closed: ${plural(mine.length, 'question')}; ${o.pass} passed, ${o.partial} partial, ${o.fail} failed, ${o.blocked} blocked, ${o.unknown} not graded yet. It is session ${reg.sessions.find((x) => x.id === s.id)?.number} in the registry.`, done: done() };
  }
  if (ask.kind === 'grade') {
    // "That passed" is a grade only while a test is open (or right after one); otherwise it is ordinary chat.
    const live = await loadLive(storage);
    const last = live.attempts[live.attempts.length - 1];
    if (!currentSession(live, now) && !(last && now - (Date.parse(last.at) || 0) < SESSION_IDLE_MS)) return null;
    const out = await gradeAttempt(storage, { outcome: ask.outcome, note: ask.note, now });
    return { text: out.ok ? `Recorded: that question is graded ${ask.outcome}.` : out.detail, done: done({ ok: out.ok }) };
  }
  if (ask.kind === 'import') {
    const out = await importOwnHistory(storage, { now });
    return { text: `I read ${plural(out.scanned, 'stored conversation')}. Imported ${plural(out.sessions, 'test session')} and ${plural(out.attempts, 'question')}${out.skipped ? `; ${out.skipped} were already in the registry` : ''}. Imported questions stay "unknown" until you grade them.`, done: done() };
  }
  await publishSeedToBrain(storage, now).catch(() => false);
  const reg = buildRegistry({ live: await loadLive(storage) });
  if (ask.kind === 'take') return { text: speakTake(reg), done: done({ sessions: reg.totals.sessions, attempts: reg.totals.attempts, lower_bound: reg.lower_bound }) };
  return { text: speakSummary(reg), done: done({ open_screen: 'brain_reliability' }) };
}

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

/** GET /api/brain/reliability (the registry), POST /api/brain/reliability/grade, POST /api/brain/reliability/import. Owner only. */
export async function reliabilityApi(storage, path, method, body = {}, ownerDevice = false) {
  if (!ownerDevice) return jsonResponse({ detail: 'Only the CHE owner can read his test registry.' }, 403);
  if (path === '/api/brain/reliability' && method === 'GET') {
    await publishSeedToBrain(storage).catch(() => false);
    const reg = buildRegistry({ live: await loadLive(storage) });
    return jsonResponse({ ...reg, summary: speakSummary(reg), take: speakTake(reg) });
  }
  if (path === '/api/brain/reliability/grade' && method === 'POST') {
    const out = await gradeAttempt(storage, { key: String(body?.key || ''), outcome: String(body?.outcome || ''), note: String(body?.note || '') });
    return jsonResponse(out, out.ok ? 200 : 400);
  }
  if (path === '/api/brain/reliability/import' && method === 'POST') return jsonResponse(await importOwnHistory(storage));
  return jsonResponse({ detail: 'Not found.' }, 404);
}

/** One Brain record per seed version, so the Brain knows the registry exists and where it lives. Queued once. */
export async function publishSeedToBrain(storage, now = Date.now()) {
  const live = await loadLive(storage);
  const reg = buildRegistry({ live: emptyLive() });
  if (live.seed_published === reg.seed_version) return false;
  live.seed_published = reg.seed_version;
  await saveLive(storage, live);
  return queueRoomEvent(storage, {
    room: 'reliability', kind: 'registry_seed', key: `seed:v${reg.seed_version}`, title: 'Reliability Registry: tests the owner ran (reconstructed history)',
    body: speakSummary(reg), status: 'derived', evidence: ['reliability_registry_seed.json'], refs: { registry: REGISTRY_KEY }, derivation: 'Reconstructed from the che-mailbox records and GitHub; every attempt carries its source link.',
  }, now);
}
