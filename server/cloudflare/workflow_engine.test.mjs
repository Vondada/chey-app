// Universal Workflow Engine (owner, 2026-10-22): one library over CHE's existing handlers, commands, saved
// workflows and REA; every owner request recorded against the workflow that served it; ranking with reasons;
// learning candidate → test → promote; preferences, versions, import/export without secrets; and measurement.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  SYSTEM_WORKFLOWS, BLOCKS, SECRET_RE, emptyState, library, signature, recordRun, workflowForRun, proposeCandidate,
  testCandidate, promoteCandidate, matchLearned, rankWorkflows, efficiency, setDisabled, setPreferred, feedbackOnLast,
  noteVersion, restoreVersion, exportWorkflows, importWorkflows, workflowIntent, engineView, WORKFLOW_ENGINE_KEY,
} from './workflow_engine.js';
import { COMMANDS } from './command_catalog.js';
import { replyFromNdjson } from './brain_memory.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const READY = Object.fromEntries(['model', 'office', 'github', 'research'].map((k) => [k, { state: 'ready' }]));

test('1. the library covers every existing system: built-in handlers, all commands, REA and the owner\'s saved workflows', () => {
  const data = { command_workflows: [{ id: 'wf1', name: 'client report', steps: [{ command: 'money-dashboard', input: '' }, { command: 'che-plan', input: 'next week' }] }] };
  const lib = library(data, emptyState());
  assert.equal(lib.filter((w) => w.kind === 'command').length, COMMANDS.length, 'every Command Center command');
  assert.ok(lib.some((w) => w.id === 'rea_investigation' && w.sources.includes('che_rea')), 'REA');
  assert.ok(lib.some((w) => w.id === 'owner:wf1' && w.kind === 'owner' && w.steps.length === 2), 'saved workflow migrated in place');
  const sources = SYSTEM_WORKFLOWS.flatMap((w) => w.sources);
  assert.equal(new Set(sources).size, sources.length, 'each handler route belongs to exactly one built-in workflow');
  for (const w of SYSTEM_WORKFLOWS) for (const b of w.blocks) assert.ok(BLOCKS[b], `${w.id} block ${b} exists`);
});

test('2. every workflow states its approval gate, verification and least-necessary context', () => {
  for (const w of library({}, emptyState())) {
    assert.ok(w.approval && w.verify && Array.isArray(w.context) && w.context.length, w.id);
    assert.ok(!w.context.includes('all'), `${w.id} never reads everything`);
  }
  assert.equal(SYSTEM_WORKFLOWS.find((w) => w.id === 'trading_desk').approval, 'money');
  assert.ok(SYSTEM_WORKFLOWS.find((w) => w.id === 'trading_desk').blocks.includes('money_delete_hold'));
  assert.equal(SYSTEM_WORKFLOWS.find((w) => w.id === 'mail_and_accounts').approval, 'app');
  assert.deepEqual([...SYSTEM_WORKFLOWS.find((w) => w.id === 'memory_recall').context], ['memory']);
});

test('3. a finished reply is recorded against the workflow that served it, with outcome, model calls and time', () => {
  const s = emptyState();
  const r = recordRun(s, { message: 'what are you doing', done: { source: 'che_activity_status', model_calls: 0, ok: true }, ms: 40 });
  assert.equal(r.workflow, 'status_report');
  assert.equal(r.verified, true);
  assert.equal(s.stats.status_report.runs, 1);
  assert.equal(s.runs[0].model_calls, 0);
  assert.equal(recordRun(s, { message: '/money-dashboard', slash: 'money-dashboard', done: { source: 'office', model_calls: 0 } }).workflow, 'cmd:money-dashboard');
  assert.equal(recordRun(s, { message: 'write a poem', done: {} }).workflow, 'open_conversation', 'no source = the language model answered');
  assert.equal(recordRun(s, { message: 'pay the bill', held: true }).workflow, 'safety_gate');
  assert.equal(s.runs[0].held, true);
  assert.equal(workflowForRun({ source: 'che_brand_new_handler' }), 'route:che_brand_new_handler', 'an unmapped handler is still recorded, by route');
});

test('4. privacy: a run keeps at most six content words; never the message, numbers, addresses or keys', () => {
  const s = emptyState();
  recordRun(s, { message: 'email joe@example.com my code 4417 and the key sk-abcdefghijklmnopqrstuvwxyz12 about the invoice', done: {} });
  const stored = JSON.stringify(s);
  for (const leak of ['joe@example.com', '4417', 'sk-abcdefghij', 'invoice about']) assert.ok(!stored.includes(leak), leak);
  assert.ok(s.runs[0].sig.split(' ').length <= 6);
  assert.ok(SECRET_RE.test('my password is hunter2') && SECRET_RE.test('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
});

test('5. ranking explains its choice from trigger words, measured success and the owner\'s preference', () => {
  const s = emptyState();
  for (let i = 0; i < 5; i++) recordRun(s, { message: 'show my positions', done: { source: 'che_trading_desk', model_calls: 0 } });
  const lib = library({}, s);
  const ranked = rankWorkflows('check my trading positions', lib, s);
  assert.equal(ranked[0].id, 'trading_desk');
  assert.match(ranked[0].why, /matches "trading", "position"/);
  assert.match(ranked[0].why, /100% of 5 runs succeeded; no model calls/);
  assert.ok(!ranked.some((r) => r.id === 'legal_check'), 'a generic word ("check") does not pull in an unrelated workflow');
  assert.deepEqual(rankWorkflows('tell me a joke', lib, s), [], 'nothing fits → nothing claimed');
});

test('6. preferences: "prefer X for Y" puts it first for that kind of request', () => {
  const s = emptyState();
  const lib = library({}, s);
  const before = rankWorkflows('research microphones for my studio', lib, s);
  assert.ok(setPreferred(s, lib, 'knowledge answer', 'research microphones').ok);
  const after = rankWorkflows('research microphones for my studio', library({}, s), s);
  assert.equal(after[0].id, 'knowledge_answer');
  assert.match(after[0].why, /you prefer it/);
  assert.ok(after[0].score > (before.find((r) => r.id === 'knowledge_answer')?.score || 0));
});

test('7. turning a workflow off removes it from ranking and learned routing; the safety gate cannot be turned off', () => {
  const s = emptyState();
  const lib = library({}, s);
  assert.ok(setDisabled(s, lib, 'trading desk', true).ok);
  assert.ok(!rankWorkflows('check my trading positions', library({}, s), s).some((r) => r.id === 'trading_desk'));
  assert.equal(setDisabled(s, lib, 'safety gate', true).reason, 'protected');
  assert.ok(setDisabled(s, lib, 'trading desk', false).ok);
  assert.ok(rankWorkflows('check my trading positions', library({}, s), s).some((r) => r.id === 'trading_desk'));
});

test('8. feedback: "that workflow was wrong" lowers its rank; three mark it for review', () => {
  const s = emptyState();
  recordRun(s, { message: 'show my positions', done: { source: 'che_trading_desk', model_calls: 0 } });
  const lib = library({}, s);
  const before = rankWorkflows('trading positions', lib, s)[0].score;
  feedbackOnLast(s, false); feedbackOnLast(s, false);
  const third = feedbackOnLast(s, false);
  assert.equal(third.workflow, 'trading_desk');
  assert.equal(third.needs_review, true);
  assert.ok(rankWorkflows('trading positions', library({}, s), s)[0].score < before);
});

test('9. learning: three model-answered requests of one kind that a real command covers become one candidate (deduped)', () => {
  const s = emptyState();
  for (const m of ['what did I earn today', 'what did I earn today?', 'CHE what did I earn today']) recordRun(s, { message: m, done: {} });
  assert.equal(s.candidates.length, 1);
  assert.deepEqual(s.candidates[0].steps, [{ command: 'money-dashboard', input: '{request}' }], 'parameterized with the request');
  assert.equal(s.candidates[0].benefit, 'deterministic');
  recordRun(s, { message: 'what did I earn today', done: {} });
  assert.equal(s.candidates.length, 1, 'the same kind of request never adds a duplicate');
  // A request no single command clearly covers never becomes a workflow.
  for (let i = 0; i < 4; i++) recordRun(s, { message: 'write me a short poem about rain', done: {} });
  assert.equal(s.candidates.length, 1);
  assert.equal(proposeCandidate(emptyState(), 'pay rent', 'pay my rent now'), null, 'a command that needs approval is never learned');
});

test('10. candidate → test → promote: a failing test is not promoted; promotion needs the owner and passes the test', () => {
  const s = emptyState();
  for (let i = 0; i < 3; i++) recordRun(s, { message: 'what did I earn today', done: {} });
  const id = s.candidates[0].id;
  assert.equal(testCandidate(s, id, {}).ok, false, 'without its connectors the test fails');
  assert.equal(promoteCandidate(s, id, {}).ok, false);
  assert.equal(s.learned.length, 0);
  const ok = promoteCandidate(s, id, READY);
  assert.equal(ok.ok, true);
  assert.equal(s.learned[0].kind, 'learned');
  assert.equal(s.candidates.length, 0);
  assert.ok(s.audit.some((a) => a.action === 'promote'));
});

test('11. only promoted, enabled learned workflows match; the owner\'s words fill the {request} parameter', () => {
  const s = emptyState();
  for (let i = 0; i < 3; i++) recordRun(s, { message: 'what did I earn today', done: {} });
  assert.equal(matchLearned(s, 'what did I earn today'), null, 'a candidate never runs');
  promoteCandidate(s, s.candidates[0].id, READY);
  const m = matchLearned(s, 'what did I earn today please');
  assert.equal(m.steps[0].command, 'money-dashboard');
  assert.equal(m.steps[0].input, 'what did I earn today please');
  assert.equal(matchLearned(s, 'what is the weather today'), null);
  setDisabled(s, library({}, s), s.learned[0].id, true);
  assert.equal(matchLearned(s, 'what did I earn today'), null);
});

test('12. versions: each change to a saved workflow keeps the earlier version, and a restore is itself versioned', () => {
  const s = emptyState();
  const data = { command_workflows: [{ id: 'wf1', name: 'morning', steps: [{ command: 'money-dashboard', input: '' }], created_at: 'x' }] };
  noteVersion(s, data.command_workflows[0]);
  data.command_workflows[0] = { ...data.command_workflows[0], steps: [{ command: 'che-plan', input: 'day' }] };
  assert.equal(library(data, s).find((w) => w.id === 'owner:wf1').version, 2);
  assert.ok(restoreVersion(s, data, 'wf1', 0).ok);
  assert.equal(data.command_workflows[0].steps[0].command, 'money-dashboard');
  assert.equal(s.versions['owner:wf1'][0].steps[0].command, 'che-plan', 'the replaced version is kept');
});

test('13. export carries no keys, tokens, passwords or run history', () => {
  const s = emptyState();
  recordRun(s, { message: 'what are you doing', done: { source: 'che_activity_status', model_calls: 0 } });
  const data = { command_workflows: [{ id: 'a', name: 'deploy', steps: [{ command: 'che-plan', input: 'use token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }] }] };
  const out = JSON.stringify(exportWorkflows(data, s));
  assert.ok(!out.includes('ghp_'));
  assert.ok(!out.includes('runs') && !out.includes('che_activity_status'));
});

test('14. import validates every step, refuses secret-shaped content and does not duplicate', () => {
  const s = emptyState();
  const data = { command_workflows: [{ id: 'a', name: 'x', steps: [{ command: 'che-plan', input: 'day', parallel: false }] }] };
  const out = importWorkflows(data, s, { workflows: [
    { name: 'dup', steps: [{ command: 'che-plan', input: 'day' }] },
    { name: 'secret', steps: [{ command: 'che-plan', input: 'password: hunter2' }] },
    { name: 'fake', steps: [{ command: 'not-a-command' }] },
    { name: 'good', steps: [{ command: 'money-dashboard' }, { command: 'che-plan', input: 'week' }] },
  ] });
  assert.deepEqual(out.added, ['good']);
  assert.deepEqual(out.skipped.map((k) => k.why), ['already in your library', 'contains a key, token or password', 'no real commands']);
});

test('15. measurement: workflow runs vs model path, from recorded runs only', () => {
  const s = emptyState();
  assert.equal(efficiency(s).model_calls_avoided, null, 'nothing is claimed before there is data');
  for (let i = 0; i < 6; i++) recordRun(s, { message: 'status', done: { source: 'che_activity_status', model_calls: 0 }, ms: 20 });
  for (let i = 0; i < 2; i++) recordRun(s, { message: `essay ${'abcdefgh'[i]}x`, done: { model_calls: 2 }, ms: 3000 });
  const e = efficiency(s);
  assert.equal(e.requests, 8);
  assert.equal(e.percent_via_workflow, 75);
  assert.equal(e.avg_model_calls_workflow, 0);
  assert.equal(e.avg_model_calls_model_path, 2);
  assert.equal(e.model_calls_avoided, 12);
  assert.ok(e.avg_ms_workflow < e.avg_ms_model_path);
});

test('16. the owner\'s words about workflows are read deterministically; ordinary sentences are not', () => {
  const cases = {
    'list my workflows': 'list', 'CHE, open the workflows page': 'list', 'which workflow would you use for my taxes': 'explain',
    'workflow stats': 'efficiency', 'how much did workflows save': 'efficiency', 'disable the trading desk workflow': 'disable',
    'turn on the trading desk workflow again': 'enable', 'prefer the knowledge answer workflow for research': 'prefer',
    'workflow candidates': 'candidates', 'promote candidate 1': 'promote', 'dismiss candidate two': 'dismiss',
    'that workflow was wrong': 'feedback', 'workflow history': 'audit', 'export my workflows': 'export',
    'workflow status': 'status', 'resume my client report workflow': 'resume',
  };
  for (const [words, action] of Object.entries(cases)) assert.equal(workflowIntent(words)?.action, action, words);
  for (const words of ['run my client report workflow', 'what is a workflow', 'delete my workflow', 'I like this flow']) assert.equal(workflowIntent(words), null, words);
});

// ─── Through the Worker ─────────────────────────────────────────────────────

const generated = new URL('./.workflow_engine.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => { if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; } saved.set(key, structuredClone(value)); },
    delete: async (key) => saved.delete(key), list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
  };
}
async function owner() {
  const saved = new Map();
  const pending = [];
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { modelCalls++; return { response: 'Here you go, sir.' }; } } };
  const state = new mod.CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => mod.default.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  return {
    saved, token, send, settle, calls: () => modelCalls,
    say: async (message, extra = {}) => {
      const before = modelCalls;
      const raw = await (await send('/api/chat', { message, history: [], ...extra }, token)).text();
      await settle();
      let done = {};
      try { done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || JSON.parse(raw); } catch (_) { done = {}; }
      return { reply: replyFromNdjson(raw) || done.reply, route: done.source, done, model_calls: modelCalls - before };
    },
    get: async (p) => (await send(p, null, token, 'GET')).json(),
    post: async (p, b) => { const r = await send(p, b, token); return { status: r.status, body: await r.json() }; },
  };
}

test('17. Worker: every owner reply says which workflow served it, and the run is recorded with its real model calls', async () => {
  const che = await owner();
  const status = await che.say('What are you doing?');
  assert.equal(status.done.workflow.id, 'status_report');
  assert.equal(status.done.workflow.deterministic, true);
  const poem = await che.say('write me a short poem about rain');
  assert.equal(poem.done.workflow.id, 'open_conversation');
  const engine = che.saved.get(WORKFLOW_ENGINE_KEY);
  assert.deepEqual(engine.runs.map((r) => r.wf), ['open_conversation', 'status_report']);
  assert.equal(engine.runs[1].model_calls, 0);
  assert.ok(engine.runs[0].model_calls >= 1);
  assert.ok(!JSON.stringify(engine).includes('poem about rain'), 'the message itself is not stored');
});

test('18. Worker: normal requests run through a learned workflow with no model call once the owner promotes it (measured)', async () => {
  const che = await owner();
  // Before: the language model answers this every time.
  for (let i = 0; i < 3; i++) {
    const r = await che.say('What did I earn today');
    assert.equal(r.done.workflow.id, 'open_conversation');
    assert.ok(r.model_calls >= 1);
  }
  const cands = await che.say('workflow candidates');
  assert.equal(cands.route, 'che_workflow_engine');
  assert.match(cands.reply, /1 workflow candidate: 1\. .*money-dashboard/);
  assert.equal(cands.model_calls, 0);
  assert.match((await che.say('promote candidate 1')).reply, /Promoted, sir/);
  // After: the same kind of request runs the real command, deterministically.
  const after = await che.say('what did I earn today?');
  assert.equal(after.model_calls, 0, 'no model call');
  assert.equal(after.done.engine_workflow?.startsWith('learned:'), true);
  assert.equal(after.done.workflow.kind, 'learned');
  const stats = await che.say('workflow stats');
  assert.match(stats.reply, /ran through workflows learned from your repeated requests/);
  const view = await che.get('/api/workflows');
  assert.equal(view.efficiency.learned_runs, 1);
  assert.ok(view.efficiency.avg_model_calls_workflow < view.efficiency.avg_model_calls_model_path, 'measured reduction');
});

test('19. Worker: approval gates hold inside workflows; a held request is recorded as waiting, not done', async () => {
  const che = await owner();
  const held = await che.say('Delete all my saved videos');
  assert.equal(held.done.held_for_owner, true);
  const engine = che.saved.get(WORKFLOW_ENGINE_KEY);
  assert.equal(engine.runs[0].wf, 'safety_gate');
  assert.equal(engine.runs[0].held, true);
  assert.equal(engine.stats.safety_gate.ok, 0);
  // A learned workflow never wraps a command that needs approval.
  assert.equal(proposeCandidate(emptyState(), 'buy stock', 'buy apple stock now'), null);
});

test('20. Worker: the Workflows page API (owner only), voice controls, resume of a paused workflow, and REA still routed', async () => {
  const che = await owner();
  const view = await che.get('/api/workflows');
  assert.ok(view.workflows.length >= 17 + COMMANDS.length);
  assert.ok(view.blocks.length >= 10);
  // A guest device sees nothing.
  const guest = await che.send('/api/workflows', null, '', 'GET');
  assert.notEqual(guest.status, 200);
  assert.match((await che.say('disable the trading desk workflow')).reply, /Trading desk is turned off/);
  assert.ok((await che.get('/api/workflows')).workflows.find((w) => w.id === 'trading_desk').disabled);
  assert.match((await che.say('disable the safety gate workflow')).reply, /cannot be turned off/);
  const ranked = await che.post('/api/workflows/rank', { message: 'research the best microphones' });
  assert.equal(ranked.status, 200);
  assert.ok(Array.isArray(ranked.body.ranked));
  // Resume: a paused saved workflow continues from where it stopped.
  const saved = await che.post('/api/commands/workflows/save', { name: 'client report', steps: [{ command: 'che-plan', input: 'next week' }, { command: 'che-plan', input: 'month' }] });
  assert.equal(saved.status, 200);
  const run = await che.say('run my client report workflow');
  assert.equal(run.route, 'che_command_workflow');
  const data = che.saved.get('che');
  const objective = data.objectives.find((o) => o.source === 'command_workflow');
  objective.paused = true;
  che.saved.set('che', data);
  const resumed = await che.say('resume my client report workflow');
  assert.equal(resumed.route, 'che_workflow_engine');
  assert.match(resumed.reply, /Resumed from where it stopped/);
  assert.equal(che.saved.get('che').objectives.find((o) => o.id === objective.id).paused, false);
  // Versioning through the existing save route.
  await che.post('/api/commands/workflows/save', { id: saved.body.workflow.id, name: 'client report', steps: [{ command: 'money-dashboard' }] });
  assert.equal(che.saved.get(WORKFLOW_ENGINE_KEY).versions[`owner:${saved.body.workflow.id}`].length, 1);
  // REA keeps its own route and is recorded under the REA workflow.
  const rea = await che.say('/rea-inspect https://github.com/Vondada/chey-app');
  assert.equal(che.saved.get(WORKFLOW_ENGINE_KEY).runs[0].wf, 'cmd:rea-inspect');
  assert.ok(rea.reply.length > 0);
});

test('engine view: library, efficiency, candidates, gaps and audit in one page payload', () => {
  const s = emptyState();
  recordRun(s, { message: 'write me a sonnet about rain', done: {} });
  const v = engineView({}, s);
  assert.ok(v.workflows.length && v.efficiency && Array.isArray(v.candidates) && Array.isArray(v.audit));
  assert.equal(v.gaps[0].sig, signature('write me a sonnet about rain'));
});
