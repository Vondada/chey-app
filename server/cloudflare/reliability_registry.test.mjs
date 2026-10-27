// The Reliability Registry (owner, 2026-10-27): reconstructed test history, separate totals, dedup, retests,
// lower bounds, proposed tests never counted, "what take are we on", and live sessions through the real /api/chat.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import {
  OUTCOMES, REGISTRY_KEY, autoGrade, buildRegistry, dedupeAttempts, emptyLive, importOwnHistory, linkRetests, registryIntent, speakTake,
} from './reliability_registry.js';
import { ROOM_EVENTS_KEY } from './room_events.js';

const SEED = JSON.parse(readFileSync(new URL('./reliability_registry_seed.json', import.meta.url), 'utf8'));

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };
const generated = new URL('./.reliability_registry.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageFor(saved) {
  return {
    get: async (key) => Array.isArray(key) ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))])) : saved.has(key) ? structuredClone(saved.get(key)) : undefined,
    put: async (key, value) => { if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; } saved.set(key, structuredClone(value)); },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '', reverse = false, limit } = {}) => {
      let rows = [...saved.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      if (reverse) rows = rows.reverse();
      return new Map(limit ? rows.slice(0, limit) : rows);
    },
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}

async function owner({ saved = new Map(), model = () => 'Three hundred ninety-one.' } = {}) {
  const inputs = []; const pending = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_m, input) => { inputs.push(input); return { response: model(input) }; } } };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const before = inputs.length;
    const res = await send('/api/chat', { message, history: [] }, token);
    const raw = await res.text();
    while (pending.length) await pending.shift();
    const done = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).find((e) => e?.type === 'done') || {};
    return { done, route: done.source || (inputs.length > before ? 'model' : 'none'), reply: replyFromNdjson(raw), modelCalls: inputs.length - before };
  };
  const get = async (path, t = token) => { const res = await send(path, null, t, 'GET'); return { status: res.status, body: await res.json() }; };
  const post = async (path, body) => { const res = await send(path, body, token); return { status: res.status, body: await res.json() }; };
  return { say, get, post, saved };
}

// ─── The seed ────────────────────────────────────────────────────────────

test('seed: every attempt has a session, a valid outcome, a source link and a known retest target', () => {
  const sessions = new Set(SEED.sessions.map((s) => s.id));
  const keys = new Set(SEED.attempts.map((a) => a.key));
  assert.equal(keys.size, SEED.attempts.length, 'attempt keys are unique');
  for (const a of SEED.attempts) {
    assert.ok(sessions.has(a.session_id), `${a.key}: session ${a.session_id}`);
    assert.ok(OUTCOMES.includes(a.outcome), `${a.key}: outcome ${a.outcome}`);
    assert.ok(a.evidence.length && a.evidence.every((e) => /^https:\/\/github\.com\/Vondada\/chey-app\//.test(e.url)), `${a.key}: evidence links`);
    if (a.retest_of_key) assert.ok(keys.has(a.retest_of_key), `${a.key}: retest of ${a.retest_of_key}`);
    assert.ok(a.at && Number.isFinite(Date.parse(a.at)), `${a.key}: time`);
  }
  assert.equal(SEED.lower_bound, true);
  assert.equal(SEED.coverage.complete, false);
  assert.ok(SEED.coverage.sources_inaccessible.some((s) => /Durable Object/.test(s)));
  assert.ok(SEED.missing_records.some((m) => m.id === 'M-reliability-test-2'), 'the unrecoverable "Reliability Test 2" is listed as missing, not invented');
});

test('seed totals are separate, non-overlapping and consistent', () => {
  const reg = buildRegistry();
  const t = reg.totals;
  assert.equal(t.attempts, SEED.attempts.length);
  assert.equal(t.sessions, SEED.sessions.length);
  assert.equal(t.first_attempts + t.retests, t.attempts, 'retests are a subset of attempts, never added to them');
  assert.equal(t.verified_results + t.unknown_results, t.attempts, 'verified and unknown split the attempts');
  assert.equal(Object.values(t.outcomes).reduce((a, b) => a + b, 0), t.attempts);
  assert.equal(t.proposed_unexecuted, SEED.proposed.length, 'proposed tests are their own total');
  assert.ok(reg.attempts.every((a, i) => a.number === i + 1), 'cumulative numbers run 1..n');
  assert.ok(reg.attempts.every((a, i, all) => i === 0 || Date.parse(all[i - 1].at) <= Date.parse(a.at) || all[i - 1].session_number < a.session_number), 'chronological by session');
  assert.equal(t.earliest_at.slice(0, 10), '2026-10-02');
});

// ─── Rules ───────────────────────────────────────────────────────────────

const A = (key, session, question, at, extra = {}) => ({ key, session_id: session, question, at, outcome: 'pass', category: 'general_knowledge', evidence: [{ url: 'x' }], ...extra });

test('dedup: the same message copied in two places is one attempt; separate parts of one message stay separate', () => {
  const copies = dedupeAttempts([
    A('a', 'S1', 'What is 17 times 23?', '2026-10-08T04:19:22Z', { question_message_id: 'm1' }),
    A('a-copy', 'S1', 'What is 17 times 23?', '2026-10-08T04:19:22Z', { question_message_id: 'm1' }),
    A('b', 'S1', 'Five levels', '2026-10-08T23:14:17Z', { question_message_id: 'm2', part: 'L1' }),
    A('c', 'S1', 'Five levels', '2026-10-08T23:14:17Z', { question_message_id: 'm2', part: 'L2' }),
  ]);
  assert.deepEqual(copies.map((a) => a.key), ['a', 'b', 'c']);
});

test('the same question asked on another occasion is a separate attempt linked as a retest', () => {
  const linked = linkRetests([
    A('first', 'S1', 'Which file defines publicResearch?', '2026-10-08T04:19:38Z'),
    A('again', 'S2', 'Which file defines publicResearch?', '2026-10-08T06:06:54Z'),
    A('other', 'S2', 'What is the boiling point of water?', '2026-10-08T06:07:00Z'),
  ]);
  assert.equal(linked.length, 3);
  assert.equal(linked[1].retest_of_key, 'first');
  assert.equal(linked[1].retest_basis, 'same question asked again');
  assert.equal(linked[2].retest_of_key, null);
});

test('missing evidence: an attempt with no recorded reply is "unknown", never a pass or a fail', () => {
  const seed = { version: 9, lower_bound: true, sessions: [{ id: 'S1', started_at: '2026-10-01T00:00:00Z' }], proposed: [], attempts: [
    A('graded', 'S1', 'q1', '2026-10-01T00:00:00Z'),
    A('unrecorded', 'S1', 'q2', '2026-10-01T00:01:00Z', { outcome: 'unknown', reply: 'No reply recorded in the mailbox.' }),
  ] };
  const t = buildRegistry({ seed }).totals;
  assert.equal(t.verified_results, 1);
  assert.equal(t.unknown_results, 1);
  assert.equal(t.outcomes.pass, 1);
  assert.equal(autoGrade('').outcome, 'fail');
  assert.equal(autoGrade("I couldn't finish a checked answer after several tries. Your message is saved, and the owner can see it.").honesty, 'no_answer');
  assert.equal(autoGrade('Working on it. I will reply here as soon as I have a checked answer.').outcome, 'fail');
  assert.equal(autoGrade('Canberra.').outcome, 'unknown', 'a real answer waits for a grade');
});

test('partial history is a lower bound and the answer says so; complete history is not', () => {
  const seed = { version: 1, lower_bound: true, sessions: [{ id: 'S1', started_at: '2026-10-01T00:00:00Z' }], proposed: [], attempts: [A('a', 'S1', 'q', '2026-10-01T00:00:00Z')] };
  assert.match(speakTake(buildRegistry({ seed })), /at least 1 session: 1 individual question[\s\S]*lower bounds/);
  assert.doesNotMatch(speakTake(buildRegistry({ seed: { ...seed, lower_bound: false } })), /lower bound/);
});

test('a proposed test, or a session opened with no question, is never counted as a session or attempt', () => {
  const seed = { version: 1, lower_bound: true, proposed: [{ id: 'P1', description: 'test later' }],
    sessions: [{ id: 'S1', started_at: '2026-10-01T00:00:00Z' }, { id: 'S-empty', started_at: '2026-10-02T00:00:00Z', title: 'opened, nothing asked' }],
    attempts: [A('a', 'S1', 'q', '2026-10-01T00:00:00Z')] };
  const reg = buildRegistry({ seed });
  assert.equal(reg.totals.sessions, 1);
  assert.equal(reg.totals.attempts, 1);
  assert.equal(reg.totals.proposed_unexecuted, 2, 'the plan and the empty session are proposed tests');
  assert.equal(registryIntent("Let's test CHE later").kind, 'propose');
});

test('words: openers in speech-to-text forms, take questions, grades, and things that are not tests', () => {
  for (const t of ["Let's test CHE's reliability", 'Lets test Chase', 'Test J', "Okay let's test her autonomy and memory", 'Run the test again', 'Start a new reliability test session']) {
    assert.equal(registryIntent(t)?.kind, 'open', t);
  }
  assert.equal(registryIntent("Let's test CHE. What is 17 times 23?").rest, 'What is 17 times 23');
  for (const t of ['What take are we on?', 'Which test number is this?', 'How many times have I tested you?']) assert.equal(registryIntent(t)?.kind, 'take', t);
  assert.equal(registryIntent('That failed').outcome, 'fail');
  assert.equal(registryIntent('Grade that as partial').outcome, 'partial');
  for (const t of ["Let's test the chart", 'I want to test the new trading chart', 'reliability report', 'How reliable are you?', 'Run the autonomy exam']) assert.equal(registryIntent(t), null, t);
});

// ─── Live, through the real /api/chat ────────────────────────────────────

test('live: "what take are we on" before any session gives sessions and attempts separately, labelled a lower bound, with no model', async () => {
  const che = await owner();
  const out = await che.say('What take are we on?');
  assert.equal(out.route, 'che_reliability_registry');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, new RegExp(`at least ${SEED.sessions.length} sessions: ${SEED.attempts.length} individual questions`));
  assert.match(out.reply, /it will be session \d+/);
  assert.match(out.reply, /lower bounds/);
});

test('live: a session records each question and the reply the owner got, grades it, and closes', async () => {
  const che = await owner();
  const before = buildRegistry().totals;
  const open = await che.say("Let's test CHE's reliability");
  assert.equal(open.route, 'che_reliability_registry');
  assert.match(open.reply, new RegExp(`testing session ${before.sessions + 1}`));
  // Opening alone counts nothing.
  assert.equal(buildRegistry({ live: che.saved.get(REGISTRY_KEY) }).totals.sessions, before.sessions);

  const q = await che.say('What is 17 times 23?');
  assert.equal(q.route, 'model', 'a test question is answered normally');
  let reg = buildRegistry({ live: che.saved.get(REGISTRY_KEY) });
  assert.equal(reg.totals.sessions, before.sessions + 1);
  assert.equal(reg.totals.attempts, before.attempts + 1);
  const mine = reg.attempts[reg.attempts.length - 1];
  assert.equal(mine.question, 'What is 17 times 23?');
  assert.equal(mine.reply, 'Three hundred ninety-one.');
  assert.equal(mine.outcome, 'unknown');
  assert.equal(mine.session_number, before.sessions + 1);

  const take = await che.say('What take are we on?');
  assert.match(take.reply, new RegExp(`testing session ${before.sessions + 1}[\\s\\S]*1 question so far[\\s\\S]*question 2 of this session`));
  // Registry commands are not attempts.
  assert.equal(buildRegistry({ live: che.saved.get(REGISTRY_KEY) }).totals.attempts, before.attempts + 1);

  const graded = await che.say('That passed');
  assert.equal(graded.route, 'che_reliability_registry');
  reg = buildRegistry({ live: che.saved.get(REGISTRY_KEY) });
  assert.equal(reg.attempts.find((a) => a.key === mine.key).outcome, 'pass');
  assert.equal(reg.attempts.find((a) => a.key === mine.key).graded_by, 'owner');

  // The same question again in this session is a separate attempt, linked as a retest.
  await che.say('What is 17 times 23?');
  reg = buildRegistry({ live: che.saved.get(REGISTRY_KEY) });
  assert.equal(reg.attempts[reg.attempts.length - 1].retest_of_key, mine.key);

  const closed = await che.say('End the test');
  assert.match(closed.reply, /2 questions; 1 passed[\s\S]*1 not graded yet/);
  const after = await che.say('What is 2 plus 2?');
  assert.equal(after.route, 'model');
  assert.equal(buildRegistry({ live: che.saved.get(REGISTRY_KEY) }).totals.attempts, before.attempts + 2, 'nothing is recorded once the session is closed');
});

test('live: an opener with a question opens the session and the question is answered and recorded', async () => {
  const che = await owner();
  const before = buildRegistry().totals.attempts;
  const out = await che.say("Let's test CHE. What is 17 times 23?");
  assert.equal(out.route, 'model');
  const reg = buildRegistry({ live: che.saved.get(REGISTRY_KEY) });
  assert.equal(reg.totals.attempts, before + 1);
  assert.equal(reg.attempts[reg.attempts.length - 1].question, 'What is 17 times 23');
});

test('live: "that passed" outside a test is ordinary chat, and a proposed test is not counted', async () => {
  const che = await owner();
  assert.notEqual((await che.say('That passed')).route, 'che_reliability_registry');
  const later = await che.say("Let's test CHE later");
  assert.equal(later.route, 'che_reliability_registry');
  assert.match(later.reply, /Nothing is counted/);
  const t = buildRegistry({ live: che.saved.get(REGISTRY_KEY) }).totals;
  assert.equal(t.sessions, SEED.sessions.length);
  assert.equal(t.proposed_unexecuted, SEED.proposed.length + 1);
});

test('API: the registry is the owner\'s only; the view carries totals, coverage and the spoken take', async () => {
  const che = await owner();
  const denied = await che.get('/api/brain/reliability', '');
  assert.ok([401, 403].includes(denied.status), 'an unpaired caller is refused');
  const view = await che.get('/api/brain/reliability');
  assert.equal(view.status, 200);
  assert.equal(view.body.totals.attempts, SEED.attempts.length);
  assert.equal(view.body.lower_bound, true);
  assert.match(view.body.take, /lower bounds/);
  assert.ok(view.body.coverage.sources_inaccessible.length);
  const bad = await che.post('/api/brain/reliability/grade', { key: 'r1-q1', outcome: 'great' });
  assert.equal(bad.status, 400);
  const ok = await che.post('/api/brain/reliability/grade', { key: 'r1-q2', outcome: 'partial', note: 'owner regrade' });
  assert.equal(ok.status, 200);
  assert.equal((await che.get('/api/brain/reliability')).body.attempts.find((a) => a.key === 'r1-q2').outcome, 'partial');
  // The seed is published to the Brain once, as one room event.
  const events = (che.saved.get(ROOM_EVENTS_KEY) || []).filter((e) => e.room === 'reliability' && e.kind === 'registry_seed');
  assert.equal(events.length, 1);
});

test('import: CHE rebuilds test sessions from her own stored conversations, once', async () => {
  const saved = new Map();
  const storage = storageFor(saved);
  const rows = [
    { id: 'c1', at: '2026-10-12T10:00:00Z', body: "You said: Let's test CHE's memory\nCHE answered: Test session open." },
    { id: 'c2', at: '2026-10-12T10:01:00Z', body: 'You said: What is my favorite food?\nCHE answered: Pizza.' },
    { id: 'c3', at: '2026-10-12T10:02:00Z', body: "You said: Which file defines publicResearch?\nCHE answered: I couldn't finish a checked answer after several tries." },
    { id: 'c4', at: '2026-10-12T15:00:00Z', body: 'You said: Unrelated later chat\nCHE answered: Sure.' },
  ];
  const list = async () => [...rows].reverse();
  const first = await importOwnHistory(storage, { list });
  assert.deepEqual({ sessions: first.sessions, attempts: first.attempts }, { sessions: 1, attempts: 2 });
  const again = await importOwnHistory(storage, { list });
  assert.equal(again.attempts, 0, 'idempotent');
  const reg = buildRegistry({ live: saved.get(REGISTRY_KEY) });
  const imported = reg.attempts.filter((a) => a.origin === 'import');
  assert.deepEqual(imported.map((a) => a.outcome), ['unknown', 'fail']);
  assert.equal(reg.totals.attempts, SEED.attempts.length + 2);
  assert.deepEqual(emptyLive().attempts, []);
});

test('each live attempt queues one Brain room event in the Reliability Registry room', async () => {
  const { openSession, recordReliabilityExchange } = await import('./reliability_registry.js');
  const saved = new Map();
  const storage = storageFor(saved);
  const now = Date.parse('2026-10-27T12:00:00Z');
  await openSession(storage, { now });
  const a = await recordReliabilityExchange(storage, { message: 'What is the capital of Australia?', reply: 'Canberra.', id: 'conv_x', now: now + 1000 });
  assert.equal(a.outcome, 'unknown');
  const again = await recordReliabilityExchange(storage, { message: 'What is the capital of Australia?', reply: 'Canberra.', id: 'conv_x', now: now + 2000 });
  assert.equal(again, null, 'the same conversation record is never recorded twice');
  const events = (saved.get(ROOM_EVENTS_KEY) || []).filter((e) => e.room === 'reliability');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'test_attempt');
  // After the idle window the session is over and nothing more is recorded.
  assert.equal(await recordReliabilityExchange(storage, { message: 'Another?', reply: 'x', id: 'conv_y', now: now + 3 * 60 * 60_000 }), null);
});
