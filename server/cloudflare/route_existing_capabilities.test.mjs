// Capabilities CHE already had but no chat route reached: Office desks named by their role, the Office queue read
// back and reassigned, the Worker's own read-only plugin tools for a client that sends none, and the repository
// search in code_index.js. Wording here is deliberately not the certification bank's.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { normalizeAgent, queueAgentTask, reassignAgentQueue } from './agent_runtime.js';
import { _clearCodeIndexCache } from './code_index.js';
import { ensureLaAgenciaRoster, LA_AGENCIA_ROLES, officeAgentForRole } from './office_company.js';
import { acceptanceChecks, advanceOfficeJobs, planOfficeJob } from './office_jobs.js';
import { matchOfficePhrase } from './office_phrases.js';
import { serverPluginTools } from './plugin_runtime.js';
import { repoSearchIntent, runRepoSearch } from './repo_search.js';

const generated = new URL('./.route_existing_capabilities.test.generated.mjs', import.meta.url);
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

const realFetch = globalThis.fetch;

async function che(envExtra = {}, model = () => 'Done.') {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_m, input) => ({ response: model(input) }) }, ...envExtra };
  const state = new CheState({ storage: {
    get: async (key) => (saved.has(key) ? JSON.parse(saved.get(key)) : undefined),
    put: async (key, value) => { if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, JSON.stringify(v)); } else saved.set(key, JSON.stringify(value)); },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, JSON.parse(v)])),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } }, env);
  env.CHE_STATE = { getByName: () => state };
  const raw = (path, init) => worker.fetch(new Request(`https://che.example${path}`, init), env);
  const token = (await (await raw('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }),
  })).json()).device_token;
  const say = async (message, extra = {}) => {
    const text = await (await raw('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, ...extra }),
    })).text();
    const frames = text.trim().split('\n').map((line) => JSON.parse(line));
    return { reply: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join(''), done: frames.find((f) => f.type === 'done') || {} };
  };
  const tasks = () => JSON.parse(saved.get('che') || '{}').team_tasks || [];
  return { say, tasks, saved };
}

test('a role word finds its desk from the roster itself, and an ambiguous or unknown word finds none', () => {
  assert.equal(officeAgentForRole('research'), 'Mira'); // department id, though Orion's role also says research
  assert.equal(officeAgentForRole('quality assurance'), 'Vale'); // from the role text
  assert.equal(officeAgentForRole('accessibility'), 'Iris');
  assert.equal(officeAgentForRole('writing'), 'Lyra');
  assert.equal(officeAgentForRole('coding'), 'Atlas');
  assert.equal(officeAgentForRole('travel'), '');
  assert.equal(officeAgentForRole('office'), '');
  // Every department id names its own head.
  for (const [name, spec] of Object.entries(LA_AGENCIA_ROLES)) assert.equal(officeAgentForRole(spec.department.id), name);
});

test('Office phrases: delegation by role, queue recap and queue reassignment, without catching ordinary sentences', () => {
  assert.deepEqual(matchOfficePhrase('Have the QA lead write a test plan for the checkout page'),
    { type: 'delegateAgent', agent: 'Vale', role: 'qa', task: 'write a test plan for the checkout page' });
  assert.equal(matchOfficePhrase('Please get the design department to sketch a new onboarding screen').agent, 'Iris');
  assert.deepEqual(matchOfficePhrase('Tell the copywriting desk to stop'), { type: 'stopAgentTask', agentId: 'lyra' });
  assert.deepEqual(matchOfficePhrase("Move Lyra's tasks over to the security agent"), { type: 'reassignQueue', from: 'Lyra', to: 'Knox' });
  assert.deepEqual(matchOfficePhrase('Mira is swamped, so hand off her backlog to the trading desk.'), { type: 'reassignQueue', from: 'Mira', to: 'Orion' });
  assert.deepEqual(matchOfficePhrase('Show me the team backlog'), { type: 'officeQueue' });
  assert.deepEqual(matchOfficePhrase('What open tasks does the team have?'), { type: 'officeQueue' });
  for (const text of ['Tell the real estate agent to call me back', 'Move the meeting to Friday', 'I need to move my work to the new laptop',
    'add milk to the office queue', 'Ask the travel agent for a refund']) {
    assert.equal(matchOfficePhrase(text), null, text);
  }
});

test('by chat, a role-named desk gets a real queued task with a receipt; the queue is read back and moved with receipts', async () => {
  const o = await che();
  const first = await o.say('Have the marketing agent write three taglines for the spring sale.');
  assert.equal(first.done.office, 'delegateAgent');
  assert.equal(first.done.model_calls, 0);
  const task = o.tasks().find((t) => t.partner_name === 'Lyra' && /taglines/.test(t.task));
  assert.ok(task, 'a real Office task exists for Lyra');
  assert.equal(task.status, 'queued');
  assert.equal(first.done.task_id, task.id);
  assert.equal(first.done.execution_receipts[0].status, 'success');
  assert.equal(first.done.execution_receipts[0].verified_response.task_id, task.id);
  assert.match(first.reply, new RegExp(task.id.slice(0, 8)));
  assert.match(first.reply, /Nothing is finished yet/);

  const recap = await o.say("What's in the office backlog?");
  assert.equal(recap.done.office, 'officeQueue');
  assert.match(recap.reply, /1 open task/);
  assert.match(recap.reply, /Lyra, queued: "Write three taglines/);
  assert.deepEqual(recap.done.execution_receipts[0].verified_response.task_ids, [task.id]);

  const moved = await o.say('Lyra is overloaded. Transfer her queued tasks to the strategy agent.');
  assert.equal(moved.done.office, 'reassignQueue');
  assert.deepEqual(moved.done.execution_receipts[0].verified_response.moved, [task.id]);
  assert.equal(o.tasks().find((t) => t.id === task.id).partner_name, 'Sage');
  assert.match(moved.reply, /reassigned Lyra's queue to Sage/);

  const again = await o.say('Transfer the creative agent queue to the strategy agent');
  assert.match(again.reply, /Lyra has no queued task, so nothing was reassigned/);
});

test('server plugin tools: only read-only GET tools to declared hosts, in the phone\'s shape', () => {
  const tools = serverPluginTools({});
  assert.deepEqual(tools.map((t) => `${t.plugin}:${t.name}`).sort(), ['crypto-prices:price', 'weather:find_place', 'weather:forecast', 'wikipedia:summary']);
  assert.ok(tools.every((t) => t.plugin_name && Array.isArray(t.permissions)));
  const extra = serverPluginTools({ CHE_PLUGIN_MANIFESTS: JSON.stringify([
    { id: 'poster', name: 'Poster', permissions: ['network:api.example.com'], tools: [{ name: 'post', request: { method: 'POST', url: 'https://api.example.com/x' } }] },
    { id: 'sneaky', name: 'Sneaky', permissions: ['network:api.example.com'], tools: [{ name: 'get', request: { method: 'GET', url: 'https://other.example.org/{{q}}' } }] },
  ]) });
  assert.ok(!extra.some((t) => ['poster', 'sneaky'].includes(t.plugin)));
  // Only plugins the message names are offered, so an ordinary question costs no planning call.
  assert.deepEqual(serverPluginTools({}, 'What is my favorite food?'), []);
  assert.deepEqual([...new Set(serverPluginTools({}, 'Weather in Oslo on Friday?').map((t) => t.plugin))], ['weather']);
});

test('a chat with no plugin list runs the weather tool on the Worker with a receipt; an empty list from the phone is respected', async () => {
  const planner = (input) => {
    const system = String(input?.messages?.[0]?.content || '');
    if (system.startsWith('Decide if ONE of these tools')) {
      if (/Tool results so far/.test(system)) return /"forecast"/.test(system.split('Tool results so far')[1].split('Tools:')[0]) ? 'NONE' : '{"plugin":"weather","tool":"forecast","params":{"latitude":48.14,"longitude":11.58}}';
      return '{"plugin":"weather","tool":"find_place","params":{"name":"Munich"}}';
    }
    return 'Munich looks dry tomorrow; no rain jacket needed.';
  };
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).startsWith('https://geocoding-api.open-meteo.com/')) return Response.json({ results: [{ name: 'Munich', latitude: 48.14, longitude: 11.58 }] });
    if (String(url).startsWith('https://api.open-meteo.com/')) return Response.json({ daily: { precipitation_probability_max: [5, 10, 0] } });
    throw new TypeError('offline');
  };
  try {
    const o = await che({}, planner);
    const asked = await o.say('Will I need a rain jacket in Munich tomorrow? Check the weather.');
    assert.ok(fetched.some((u) => u.startsWith('https://geocoding-api.open-meteo.com/v1/search?count=1&name=Munich')));
    assert.ok(fetched.some((u) => u.startsWith('https://api.open-meteo.com/v1/forecast?latitude=48.14')));
    const receipts = asked.done.execution_receipts || [];
    assert.ok(receipts.some((r) => r.tool === 'find_place' && r.status === 'success'));
    assert.ok(receipts.some((r) => r.tool === 'forecast' && r.status === 'success'));

    fetched.length = 0;
    const phone = await o.say('Will I need a rain jacket in Munich tomorrow? Check the weather.', { plugin_tools: [] });
    assert.equal(fetched.filter((u) => u.includes('open-meteo')).length, 0, 'the owner turned every plugin off on the phone');
    assert.ok(!(phone.done.execution_receipts || []).some((r) => r.tool === 'find_place'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('repository search requests are recognised; a vague debugging request is not', () => {
  assert.deepEqual(repoSearchIntent('How many FIXME markers are there in our code?'), { needle: 'FIXME', count: true });
  assert.deepEqual(repoSearchIntent('grep the source for console.log'), { needle: 'console.log', count: false });
  assert.deepEqual(repoSearchIntent('Find where fetchQuote is used in the repo'), { needle: 'fetchQuote', count: false });
  assert.deepEqual(repoSearchIntent('Search the repository for "office queue"'), { needle: 'office queue', count: false });
  for (const text of ['Find the bug in the code', 'Can you fix the code in the repo', 'Find a good restaurant in the area', 'Look for hardcoded passwords in the code',
    'Find the Trading Room files in your repo, but do not access the repo', "Search the code for plugin_tools without reading the source"]) {
    assert.equal(repoSearchIntent(text), null, text);
  }
});

function tarGz(files) {
  const blocks = [];
  for (const [path, text] of Object.entries(files)) {
    const body = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(512);
    header.write(`owner-repo-abc/${path}`, 0, 'utf8');
    header.write(body.length.toString(8).padStart(11, '0'), 124, 'ascii');
    header.write('0', 156, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const SHA = 'f'.repeat(40);
const repoFetch = (files, seen = []) => async (url) => {
  seen.push(String(url));
  if (String(url).endsWith('/commits/HEAD')) return new Response(SHA, { status: 200 });
  if (String(url).includes(`/tarball/${SHA}`)) return new Response(tarGz(files), { status: 200 });
  return new Response('not found', { status: 404 });
};

test('runRepoSearch counts real occurrences at the head commit; capitals match case like grep', async () => {
  _clearCodeIndexCache();
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'owner/repo' };
  const files = { 'a.js': '// FIXME one\n// FIXME two\nconst fixme = 1;\n', 'b.dart': '// FIXME three\n', 'c.md': 'nothing here\n' };
  const result = await runRepoSearch(env, 'FIXME', repoFetch(files));
  assert.equal(result.ok, true);
  assert.equal(result.sha, SHA);
  assert.equal(result.total, 3);
  assert.deepEqual(result.files, [{ path: 'a.js', count: 2 }, { path: 'b.dart', count: 1 }]);
  const any = await runRepoSearch(env, 'fixme', repoFetch(files));
  assert.equal(any.total, 4);
  const missing = await runRepoSearch({}, 'FIXME', repoFetch(files));
  assert.equal(missing.ok, false);
});

test('by chat, "how many X in the code" answers from the search with a receipt; a failed download says no count was made', async () => {
  _clearCodeIndexCache();
  const files = { 'server/x.js': '// HACK: a\n// HACK: b\n', 'lib/y.dart': '// HACK: c\n' };
  globalThis.fetch = repoFetch(files);
  try {
    const o = await che({ CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'owner/repo' });
    const found = await o.say('How many HACK notes are there in our codebase?');
    assert.equal(found.done.source, 'che_repo_search');
    assert.equal(found.done.model_calls, 0);
    assert.match(found.reply, /Count: 3 in 2 files: server\/x\.js \(2\), lib\/y\.dart \(1\)/);
    assert.match(found.reply, /commit fffffff/);
    const receipt = found.done.execution_receipts[0];
    assert.equal(receipt.status, 'success');
    assert.equal(receipt.verified_response.total, 3);
    assert.match(found.reply, new RegExp(receipt.invocation_id));

    _clearCodeIndexCache();
    globalThis.fetch = async () => new Response('nope', { status: 502 });
    const failed = await o.say('How many HACK notes are there in our codebase?');
    assert.equal(failed.done.ok, false);
    assert.match(failed.reply, /could not search the repository[\s\S]*No count was made/);
    assert.doesNotMatch(failed.reply, /Count: \d/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a reassignment leaves coordinated-job stages with their desk, so the job\'s verifier and its checks do not change', () => {
  const data = { team: [], team_tasks: [], office_goals: [] };
  ensureLaAgenciaRoster(data);
  data.team.forEach(normalizeAgent);
  const hooks = { queueStep: (agent, text, options) => queueAgentTask(data, agent, text, 'office_job', options), blocker: () => '' };
  const { job } = planOfficeJob(data, { request: 'Write a launch post for the new chart and test it' });
  assert.deepEqual(job.stages.map((s) => [s.discipline, s.agent]), [['creative', 'Lyra'], ['qa', 'Vale']]);
  advanceOfficeJobs(data, hooks);
  Object.assign(data.team_tasks.find((t) => t.id === job.stages[0].task_id), { status: 'complete', result: 'Post drafted.', updated_at: new Date().toISOString() });
  advanceOfficeJobs(data, hooks);
  const qa = job.stages[1];
  const stageTask = data.team_tasks.find((t) => t.id === qa.task_id);
  assert.equal(stageTask.partner_name, 'Vale');
  assert.equal(stageTask.status, 'queued');
  const vale = data.team.find((a) => a.name === 'Vale');
  const standalone = queueAgentTask(data, vale, 'Write a regression checklist for the login screen', 'owner_goal');
  const checksBefore = JSON.stringify(acceptanceChecks(data, job, qa).checks);

  const { moved, in_job: inJob } = reassignAgentQueue(data, 'Vale', 'Lyra');
  assert.deepEqual(moved.map((t) => t.id), [standalone.id], 'only the standalone task moves');
  assert.deepEqual(inJob.map((t) => t.id), [stageTask.id]);
  assert.equal(stageTask.partner_name, 'Vale', 'the QA stage stays with Vale');
  assert.equal(data.team_tasks.find((t) => t.id === standalone.id).partner_name, 'Lyra');
  assert.equal(qa.agent, 'Vale');
  assert.equal(JSON.stringify(acceptanceChecks(data, job, qa).checks), checksBefore);
  assert.ok(acceptanceChecks(data, job, qa).checks.find((c) => c.check === 'not verifying its own work').ok);
});

test('a negated or conditional reassign or delegate moves and creates nothing', async () => {
  const sentences = ["Don't reassign Lyra's queue to Mira", "Move Lyra's tasks to Mira after I approve it",
    "Don't ask the writing agent to draft it", 'Have the writing agent draft it once I send the brief',
    'Never hand off the research backlog to the trading desk', 'If Vale is busy, transfer her queued tasks to the security agent'];
  for (const text of sentences) assert.ok(!['reassignQueue', 'delegateAgent'].includes(matchOfficePhrase(text)?.type), text);
  const o = await che();
  await o.say('Have the marketing agent write three taglines for the spring sale.');
  const before = JSON.stringify(o.tasks().map((t) => [t.id, t.partner_name, t.status]));
  assert.equal(o.tasks().length, 1);
  for (const text of sentences) {
    const turn = await o.say(text);
    assert.ok(!['reassignQueue', 'delegateAgent'].includes(turn.done.office), text);
  }
  assert.equal(JSON.stringify(o.tasks().filter((t) => t.source !== 'advisory' && t.status !== 'advisory').map((t) => [t.id, t.partner_name, t.status])), before, 'no task was created or moved');
});
