// Office conversation record (owner rule, 2026-10-26): exact six-state status mapping, full untruncated messages in
// order, real timestamps only, and the read route through the real Worker.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { OFFICE_STATES, officeConversation, officeTaskState } from './office_conversation.js';

const T = (m) => new Date(Date.UTC(2026, 9, 26, 10, m)).toISOString();

test('the six states are exactly Queued, Running, Waiting, Blocked, Failed, Completed', () => {
  assert.deepEqual([...OFFICE_STATES], ['Queued', 'Running', 'Waiting', 'Blocked', 'Failed', 'Completed']);
});

test('a queued task is Queued, never Running', () => {
  assert.equal(officeTaskState({ status: 'queued' }).state, 'Queued');
  assert.equal(officeTaskState({ status: 'queued', verified_by_che: true }).state, 'Queued');
});

test('every stored status maps to one of the six states, with the raw status kept', () => {
  const expect = {
    queued: 'Queued',
    running: 'Running',
    reviewing: 'Running',
    review_pending: 'Waiting',
    needs_review: 'Waiting',
    complete: 'Waiting', // not verified by CHE
    advisory: 'Waiting',
    blocked: 'Blocked',
    failed: 'Failed',
    rejected: 'Failed',
    cancelled: 'Failed',
    something_new: 'Waiting',
  };
  for (const [status, state] of Object.entries(expect)) {
    const s = officeTaskState({ status });
    assert.equal(s.state, state, status);
    assert.ok(OFFICE_STATES.includes(s.state), status);
    assert.equal(s.raw, status);
  }
  assert.equal(officeTaskState({ status: 'complete', verified_by_che: true }).state, 'Completed');
});

test('blocked and failed carry the recorded error as their reason', () => {
  assert.equal(officeTaskState({ status: 'blocked', error: 'Codex tool not configured' }).reason, 'Codex tool not configured');
  assert.match(officeTaskState({ status: 'failed' }).reason, /No reason was recorded/);
});

const team = [
  { id: 'agent-atlas-0001', name: 'Atlas', role: 'Engineering', runtime_status: 'waiting' },
  { id: 'agent-nova-00002', name: 'Nova', role: 'Research', runtime_status: 'building' },
];

test('agent view: a queued task stays Queued and shows the next step as not started', () => {
  const data = {
    team,
    team_tasks: [{ id: 'task-queued-1', partner_id: 'agent-atlas-0001', partner_name: 'Atlas', task: 'Research competitors', status: 'queued', source: 'owner', created_at: T(0), updated_at: T(0) }],
  };
  const c = officeConversation(data, { agentId: 'agent-atlas-0001' });
  assert.equal(c.agent.status, 'Queued');
  assert.equal(c.agent.active_task.state, 'Queued');
  assert.equal(c.agent.current_step, 'Queued. Not started yet.');
  assert.equal(c.agent.last_verified_at, null);
  assert.equal(c.messages[0].kind, 'request');
  assert.equal(c.messages[0].task_state, 'Queued');
});

test('a running task shows the latest recorded attempt, and says so when none is recorded', () => {
  const base = { id: 'task-run-0001', partner_id: 'agent-nova-00002', partner_name: 'Nova', task: 'Find sources', status: 'running', source: 'owner', created_at: T(1), updated_at: T(2) };
  const none = officeConversation({ team, team_tasks: [base] }, { agentId: 'agent-nova-00002' });
  assert.equal(none.agent.status, 'Running');
  assert.equal(none.agent.current_step, 'Running. No provider attempt is recorded yet.');
  const withTrail = officeConversation({ team, team_tasks: [{ ...base, provider_trail: [{ provider: 'openai', model: 'gpt-x', at: T(2) }] }] }, { agentId: 'agent-nova-00002' });
  assert.equal(withTrail.agent.current_step, 'Running. Latest recorded attempt: openai (gpt-x).');
});

test('full untruncated text, every message in time order, newest last, with real times only', () => {
  const longResult = 'Finding line. '.repeat(400); // about 5600 characters, well past 140
  const data = {
    team,
    team_tasks: [{
      id: 'task-done-0001', partner_id: 'agent-atlas-0001', partner_name: 'Atlas', task: 'Write the report',
      status: 'complete', verified_by_che: true, source: 'owner', created_at: T(0), updated_at: T(9),
      result: longResult, che_review: 'Checked against the brief.', steering: [{ text: 'Keep it short', at: T(3) }],
      provider_trail: [{ provider: 'openai', model: 'm1', at: T(4) }],
    }],
    agent_work_log: [{ agent_id: 'agent-atlas-0001', verified_by_che: true, at: T(9) }],
  };
  const c = officeConversation(data, { agentId: 'agent-atlas-0001' });
  const result = c.messages.find((m) => m.kind === 'result');
  assert.equal(result.text.length, longResult.length, 'the result is not truncated');
  assert.equal(result.text, longResult);
  assert.deepEqual(c.messages.map((m) => m.kind), ['request', 'steering', 'result', 'review']);
  assert.deepEqual(c.messages.map((m) => m.seq), [1, 2, 3, 4]);
  assert.equal(c.messages[0].speaker, 'Owner');
  assert.equal(c.messages[0].to, 'Atlas');
  assert.equal(c.agent.status, 'Completed');
  assert.equal(c.agent.last_verified_at, T(9));
  assert.equal(c.messages[2].details.provider_trail[0].provider, 'openai');
});

test('a message with no recorded time is null, not invented, and sorts after the timed ones', () => {
  const data = {
    team,
    team_tasks: [{ id: 'task-meta-0001', partner_id: 'agent-atlas-0001', partner_name: 'Atlas', task: 'Plan it', status: 'running', source: 'owner', created_at: T(5), updated_at: T(6) }],
    meetings: [{
      id: 'meeting-0001', objective: 'Launch plan', status: 'drafting', created_at: T(0), updated_at: T(1),
      participants: [{ agent_id: 'agent-atlas-0001', name: 'Atlas' }],
      board: [{ from: 'Atlas', kind: 'draft', text: 'Undated draft' }, { from: 'Atlas', kind: 'draft', text: 'Dated draft', at: T(2) }],
    }],
  };
  const c = officeConversation(data, { agentId: 'agent-atlas-0001' });
  const meeting = c.messages.filter((m) => m.kind === 'meeting');
  assert.equal(meeting[0].text, 'Dated draft');
  assert.equal(meeting[1].text, 'Undated draft');
  assert.equal(meeting[1].at, null);
  assert.equal(c.messages.at(-1).text, 'Undated draft');
});

test('the request flags when the stored text itself was cut at queue time', () => {
  const cut = 'x'.repeat(3000);
  const c = officeConversation({ team, team_tasks: [{ id: 'task-cut-0001', partner_id: 'agent-atlas-0001', partner_name: 'Atlas', task: cut, status: 'queued', source: 'owner', created_at: T(0) }] }, { taskId: 'task-cut-0001' });
  assert.equal(c.messages[0].details.cut_when_stored, true);
  assert.equal(c.messages[0].details.stored_limit, 3000);
});

test('blockers, retry and last completed come from the records', () => {
  const data = {
    team: [{ ...team[0], runtime_status: 'offline', runtime_task: 'Codex tool not configured' }],
    team_tasks: [
      { id: 'task-blk-0001', partner_id: 'agent-atlas-0001', partner_name: 'Atlas', task: 'Ship it', status: 'blocked', error: 'Permission denied', source: 'owner', created_at: T(0), updated_at: T(1), retry_at: T(30) },
      { id: 'task-old-0001', partner_id: 'agent-atlas-0001', partner_name: 'Atlas', task: 'Old work', status: 'complete', verified_by_che: true, source: 'owner', created_at: T(-60), updated_at: T(-50) },
    ],
  };
  const c = officeConversation(data, { agentId: 'agent-atlas-0001' });
  assert.equal(c.agent.status, 'Blocked');
  assert.equal(c.agent.last_completed.title, 'Old work');
  assert.equal(c.agent.blockers.length, 2);
  assert.equal(c.agent.blockers[0].text, 'Permission denied');
  assert.equal(c.agent.blockers[1].text, 'Codex tool not configured');
  assert.equal(c.agent.next_scheduled.at, T(30));
});

test('coding job evidence comes from the linked job record and is not invented', () => {
  const data = {
    team,
    jobs: [{ id: 'job-coding-01', state: 'merged', pr_number: 712, pr_url: 'https://github.com/example/repo/pull/712', merge_commit_sha: 'abcdef1234567890', updated_at: T(8) }],
    team_tasks: [{ id: 'task-code-0001', partner_id: 'agent-atlas-0001', partner_name: 'Atlas', task: 'Fix bug', status: 'complete', verified_by_che: true, source: 'owner', job_id: 'job-coding-01', created_at: T(0), updated_at: T(8) }],
  };
  const c = officeConversation(data, { taskId: 'task-code-0001' });
  const ev = c.messages.find((m) => m.kind === 'evidence');
  assert.match(ev.text, /PR #712/);
  assert.match(ev.text, /merge commit abcdef123456/);
  assert.equal(ev.details.pr_number, 712);
});

test('unknown ids are 404 and a missing id is 400', () => {
  assert.equal(officeConversation({ team, team_tasks: [] }, { agentId: 'agent-missing-99' }).status, 404);
  assert.equal(officeConversation({ team_tasks: [] }, { taskId: 'task-missing-9' }).status, 404);
  assert.equal(officeConversation({}, {}).status, 400);
});

// Through the real Worker route, with the same pairing helper as office_wiring.test.mjs.
const generated = new URL('./.office_conversation.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
let CheState;
try {
  ({ default: worker, CheState } = await import(`${generated.href}?test=${Date.now()}`));
} finally {
  try { unlinkSync(generated); } catch (_) {}
}

async function office() {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', AI: { run: async () => ({ response: 'Done.' }) } };
  const state = new CheState({ storage: {
    get: async (key) => (saved.has(key) ? JSON.parse(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, JSON.stringify(value)),
    delete: async (key) => saved.delete(key),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } }, env);
  env.CHE_STATE = { getByName: () => state };
  const raw = (path, init) => worker.fetch(new Request(`https://che.example${path}`, init), env);
  const token = (await (await raw('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }),
  })).json()).device_token;
  const send = (path, method = 'GET', body) => raw(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { send, stored: () => JSON.parse(saved.get('che')) };
}

test('GET /api/agents/:id carries the conversation, and a queued task stays Queued through the Worker', async () => {
  const o = await office();
  await (await o.send('/api/office/today')).json(); // staffs the La Agencia roster
  const knox = o.stored().team.find((a) => a.name === 'Knox');
  const queued = await o.send(`/api/agents/${knox.id}/task`, 'POST', { task: 'Review the release checklist' });
  assert.equal(queued.status, 200);
  const r = await o.send(`/api/agents/${knox.id}`);
  assert.equal(r.status, 200);
  const { conversation } = await r.json();
  assert.equal(conversation.scope, 'agent');
  assert.ok(conversation.messages.length >= 1);
  const top = conversation.tasks[0];
  assert.equal(top.title, 'Review the release checklist');
  assert.equal(top.state, 'Queued');
  assert.notEqual(conversation.agent.status, 'Running');
  assert.equal(conversation.agent.status, 'Queued');
  assert.equal(conversation.messages[0].text, 'Review the release checklist');
});

test('an unknown agent id has no conversation: the agent route answers 404', async () => {
  const o = await office();
  assert.equal((await o.send('/api/agents/agent-nobody-0000')).status, 404);
});
