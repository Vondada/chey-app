// CHE Cloud Computer Manager (owner, 2026-10-24): one manager over CHE's existing compute. Offline: GitHub is a fake
// that records every request, so these tests prove what WOULD be sent and that nothing is sent without approval.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { EXECUTION } from './capability_registry.js';
import { commandById } from './command_catalog.js';
import { APP_BUILD_KEY } from './app_builds.js';
import {
  CLOUD_JOB_KIND, MISSING, PROVIDERS, TEMPLATES, approveCloudJob, cancelCloudJob, cloudIntent, cloudJobs, explainGithubError, inspectFile,
  parseControl, requestCloudWork, retryCloudJob, runCloudTask, selectProvider, startCloudTask, stopCloudJob,
} from './cloud_computer.js';

// ─── A fake GitHub: records every call; answers like the REST API ───────────
const calls = [];
let github = { runStatus: 'in_progress', conclusion: null, cancel: 202, dispatch: 204 };
const RUN = { id: 777, html_url: 'https://github.com/Vondada/chey-app/actions/runs/777' };
// Like GitHub, every accepted dispatch creates a new run (777, 778, ...); `hidden` runs are not listed yet.
let ghRuns = [];
let nextRunId = 777;
const resetGithub = () => { github = { runStatus: 'in_progress', conclusion: null, cancel: 202, dispatch: 204 }; ghRuns = []; nextRunId = 777; };
const addRun = (id, extra = {}) => { const run = { id, html_url: `https://github.com/Vondada/chey-app/actions/runs/${id}`, created_at: new Date().toISOString(), ...extra }; ghRuns.push(run); return run; };
async function fakeFetch(input, init = {}) {
  const url = new URL(String(input?.url || input));
  const method = init.method || 'GET';
  if (url.host !== 'api.github.com') throw new TypeError(`fetch failed (offline test: ${url.host})`);
  calls.push({ method, path: url.pathname + url.search, body: init.body ? JSON.parse(init.body) : null });
  const reply = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const runPath = url.pathname.match(/\/actions\/runs\/(\d+)(\/jobs|\/cancel)?$/);
  const run = runPath && ghRuns.find((r) => String(r.id) === runPath[1]);
  if (method === 'POST' && url.pathname.endsWith('/actions/workflows/flutter-check.yml/dispatches')) {
    // flutter-check.yml's run-name titles a run with the dispatch's che_dispatch_id; without one GitHub uses the workflow name.
    const tag = JSON.parse(init.body || '{}')?.inputs?.che_dispatch_id;
    if (github.dispatch === 204) addRun(nextRunId++, { hidden: Boolean(github.hideNewRuns), display_title: tag ? `CHE cloud tests ${tag}` : 'Check CHE Flutter client' });
    return reply(github.dispatch, github.dispatch === 204 ? null : { message: 'Resource not accessible by integration' });
  }
  if (method === 'POST' && /\/actions\/workflows\/che-(?:shorebird|iphone-ipa)\.yml\/dispatches$/.test(url.pathname)) return reply(204, null);
  if (method === 'GET' && url.pathname.endsWith('/actions/workflows/flutter-check.yml/runs')) {
    return reply(200, { workflow_runs: ghRuns.filter((r) => !r.hidden).sort((a, b) => b.id - a.id).map(({ hidden, ...r }) => r) });
  }
  if (method === 'GET' && run && !runPath[2]) return reply(200, { ...run, status: github.runStatus, conclusion: github.conclusion });
  if (method === 'GET' && run && runPath[2] === '/jobs') return reply(200, { jobs: [{ name: 'analyze', steps: [{ name: 'flutter analyze', conclusion: 'success' }, { name: 'flutter test', conclusion: 'failure' }] }] });
  if (method === 'POST' && run && runPath[2] === '/cancel') return reply(github.cancel, {});
  if (method === 'GET' && url.pathname.endsWith('/pulls')) return reply(200, [{ number: 512, title: 'Truth receipts', html_url: 'https://github.com/Vondada/chey-app/pull/512', draft: false, head: { ref: 'x' } }]);
  return reply(404, { message: 'Not Found' });
}
globalThis.fetch = fakeFetch;
const GH_ENV = { CHE_GITHUB_TOKEN: 'ghp_test_only', CHE_GITHUB_REPO: 'Vondada/chey-app' };

// The real Worker, like command_center.test.mjs.
const generated = new URL('./.cloud_computer.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState, enqueueJob } = mod;

function storageFor(saved) {
  return {
    get: async (key) => Array.isArray(key) ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))])) : saved.has(key) ? structuredClone(saved.get(key)) : undefined,
    put: async (key, value) => {
      if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; }
      saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ env: extra = {} } = {}) {
  const saved = new Map();
  const inputs = [];
  const pending = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extra, AI: { run: async (_m, input) => { inputs.push(input); return { response: 'model answer' }; } } };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  const say = async (message) => {
    const before = inputs.length;
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    await settle();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    return { done, route: held?.held_for_owner ? 'held' : done.source || 'none', reply: held?.message || replyFromNdjson(raw), modelCalls: inputs.length - before };
  };
  const get = async (path, tok = token) => { const r = await send(path, null, tok, 'GET'); return { status: r.status, body: await r.json() }; };
  const post = async (path, body, tok = token) => { const r = await send(path, body, tok); return { status: r.status, body: await r.json() }; };
  const jobs = () => saved.get('che')?.jobs || [];
  return { say, get, post, state, saved, jobs };
}

const newData = () => ({ jobs: [] });

// ─── Providers ───────────────────────────────────────────────────────────────

test('every provider declares id, capabilities, cost tier, billing, approval and an availability check; none is paid', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.id && p.label && Array.isArray(p.capabilities) && p.tier && p.billing && typeof p.needs_approval === 'boolean' && p.limits, p.id);
    assert.notEqual(p.tier, EXECUTION.EXTERNAL_PAID, `${p.id} is not paid`);
  }
  assert.ok(!PROVIDERS.some((p) => p.capabilities.includes('blender')), 'no provider claims Blender');
  for (const id of ['github_ubuntu', 'browser_isolated', 'github_macos']) {
    const p = PROVIDERS.find((x) => x.id === id);
    assert.equal(p.billing, 'requires_verified_free_usage', `${id}: GitHub minutes are not verified as free`);
    assert.equal(p.needs_approval, true, id);
  }
  // Cheapest capable provider: file work stays on the Worker even though the GitHub runner can also do it.
  assert.equal(selectProvider('file_processing', { env: GH_ENV }).provider, 'worker_internal');
  assert.equal(selectProvider('repo_tests', { env: GH_ENV }).provider, 'github_ubuntu');
  assert.equal(selectProvider('repo_tests', { env: GH_ENV }).approval_required, true, 'a NEW GitHub dispatch needs approval');
  assert.equal(selectProvider('repo_tests', { env: {} }).blocked, true, 'no GitHub token: needs setup, honestly');
  assert.match(selectProvider('repo_tests', { env: {} }).smallest_addition, /CHE_GITHUB_TOKEN/);
});

test('chat text never becomes a shell command: only allowlisted templates exist', () => {
  for (const kind of ['rm -rf /', 'shell', 'bash -c "curl evil"', '']) {
    const out = requestCloudWork(newData(), { kind }, { env: GH_ENV, enqueue: enqueueJob });
    assert.equal(out.ok, false, kind);
    assert.match(out.plan.reason, /not one of my job templates/, kind);
  }
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ['blender_render', 'browser', 'coding', 'file_processing', 'gpu_animation', 'ios_build', 'ios_patch', 'media_transcode', 'repo_tests', 'research', 'video_render']);
  // Agents on CHE's roster can ask; anyone else cannot.
  assert.equal(requestCloudWork(newData(), { agent: 'Vale', kind: 'repo_tests' }, { env: GH_ENV, enqueue: enqueueJob }).ok, true);
  assert.match(requestCloudWork(newData(), { agent: 'Mallory', kind: 'repo_tests' }, { env: GH_ENV, enqueue: enqueueJob }).reason, /not on CHE's roster/);
});

// ─── A. Blender → MP4 ───────────────────────────────────────────────────────

test('A. "create a Blender animation" checks existing resources first, then names the smallest addition; nothing starts', async () => {
  const plan = selectProvider('blender_render', { env: GH_ENV });
  assert.equal(plan.blocked, true);
  assert.equal(plan.missing_capability, 'blender');
  assert.match(plan.reason, /No provider has Blender/);
  assert.match(plan.existing, /tools\/character_pipeline\/build_che_character\.py[\s\S]*bpy==5\.0\.1/);
  assert.match(plan.smallest_addition, /new workflow on ubuntu-latest[\s\S]*bpy==5\.0\.1[\s\S]*ffmpeg[\s\S]*pull request/);
  assert.equal(MISSING.blender.smallest_addition, plan.smallest_addition);

  const che = await owner({ env: GH_ENV });
  calls.length = 0;
  const before = che.jobs().length;
  const out = await che.say('Create a Blender animation of a spinning CHE logo');
  assert.equal(out.route, 'che_cloud_computer');
  assert.equal(out.modelCalls, 0);
  assert.equal(out.done.blocked, true);
  assert.match(out.reply, /No provider has Blender[\s\S]*Smallest addition:[\s\S]*Nothing was started\./);
  assert.equal(calls.length, 0, 'nothing reached GitHub');
  assert.equal(che.jobs().length, before, 'no job was invented');
});

// ─── B. Repository tests ────────────────────────────────────────────────────

test('B. "run your coding tests" prepares a flutter-check.yml job that waits for approval; approval dispatches it and GitHub decides pass or fail', async () => {
  const che = await owner({ env: GH_ENV });
  resetGithub();
  calls.length = 0;
  const asked = await che.say('Run your coding tests');
  assert.equal(asked.route, 'che_cloud_computer');
  assert.equal(asked.modelCalls, 0);
  assert.equal(asked.done.needs_approval, true);
  assert.match(asked.reply, /have not verified that its minutes are free[\s\S]*Say "approve cloud job [0-9a-f]{8}"[\s\S]*Nothing was dispatched\./);
  assert.equal(calls.length, 0, 'nothing is dispatched before approval');
  const job = che.jobs().find((j) => j.kind === CLOUD_JOB_KIND);
  assert.equal(job.status, 'awaiting_approval');
  assert.equal(job.requesting_agent, 'CHE');
  assert.equal(job.environment, 'github_ubuntu');
  assert.deepEqual(job.params, { ref: 'main' });
  assert.equal(job.approval.required, true);

  // Saying it twice does not stack a second approval request.
  await che.say('Run your coding tests');
  assert.equal(che.jobs().filter((j) => j.kind === CLOUD_JOB_KIND).length, 1);

  // The job queue never runs an unapproved job, and the runner refuses one in code.
  await che.state.processJobs();
  assert.equal(calls.length, 0);
  assert.match((await runCloudTask(job, { env: GH_ENV, fetcher: fakeFetch })).error, /never approved/);
  assert.equal(calls.length, 0);

  const approved = await che.say('Approve the cloud job');
  assert.equal(approved.route, 'che_cloud_computer');
  assert.match(approved.reply, /^Approved, sir\. Cloud job [0-9a-f]{8} is queued/);
  github = { runStatus: 'in_progress', conclusion: null, cancel: 202, dispatch: 204 };
  await che.state.processJobs();
  const dispatch = calls.find((c) => c.method === 'POST');
  assert.equal(dispatch.path, '/repos/Vondada/chey-app/actions/workflows/flutter-check.yml/dispatches');
  assert.equal(dispatch.body.ref, 'main');
  assert.match(dispatch.body.inputs.che_dispatch_id, /^[A-Za-z0-9_-]+-[0-9a-z]+$/, 'each dispatch carries its own correlation id');
  let stored = che.jobs().find((j) => j.id === job.id);
  assert.equal(stored.status, 'queued', 'waiting on GitHub');
  assert.equal(stored.cloud.run_id, 777);
  assert.ok(stored.cloud.dispatched_at && stored.cloud.started_at);

  // The ledger shows the run, its tools and that it can be stopped now (not cancelled).
  const view = (await che.get('/api/cloud-computer')).body;
  const row = view.jobs.find((r) => r.id === job.id);
  assert.equal(row.provider, 'github_ubuntu');
  assert.deepEqual(row.controls, { approve: false, cancel: false, stop: true, retry: false });
  assert.ok(row.created_at && row.started_at && row.finished_at === null);

  // GitHub says success → complete, with the run link as its evidence.
  github.runStatus = 'completed'; github.conclusion = 'success';
  stored.retry_at = 0;
  che.saved.set('che', { ...che.saved.get('che'), jobs: che.jobs().map((j) => (j.id === job.id ? { ...j, retry_at: 0 } : j)) });
  await che.state.processJobs();
  stored = che.jobs().find((j) => j.id === job.id);
  assert.equal(stored.status, 'complete');
  assert.match(stored.result, /passed: GitHub run 777 of flutter-check\.yml finished with success/);
  assert.equal(stored.verification, 'run conclusion "success" read from GitHub');
  assert.equal(stored.cloud.outputs[0].url, RUN.html_url);
});

// ─── C. Browser / research through REA ──────────────────────────────────────

test('C. a browser job goes to the isolated browser through the existing REA starter; research stays on the Worker', async () => {
  const browser = selectProvider('browser', { env: GH_ENV });
  assert.equal(browser.provider, 'browser_isolated');
  assert.equal(browser.run, 'handoff');
  assert.equal(browser.existing_path, 'handleReaRequest');
  assert.equal(browser.approval_required, false, 'REA keeps its own existing gates');
  assert.equal(selectProvider('research', { env: GH_ENV }).provider, 'worker_internal', 'cheapest capable provider');
  const asked = [];
  const out = await startCloudTask('browser', { url: 'https://example.com/pricing' }, { env: GH_ENV, rea: async (text) => { asked.push(text); return { ok: true, text: 'REA queued an isolated browser run.', investigation_id: 'inv_1' }; } });
  assert.deepEqual(asked, ['REA inspect: https://example.com/pricing']);
  assert.equal(out.ok, true);
  assert.equal(out.job_id, 'inv_1');
  const empty = await startCloudTask('browser', {}, { env: GH_ENV, rea: async () => assert.fail('no target, no run') });
  assert.match(empty.reason, /needs a target/);
});

// ─── D. File processing ─────────────────────────────────────────────────────

test('D. a file job runs on the Worker, records size, SHA-256 and type in the queue, and never stores the bytes', async () => {
  const che = await owner({ env: GH_ENV });
  const res = await che.post('/api/cloud-computer/start', { kind: 'file_processing', params: { name: 'notes.txt', text: 'hello' } });
  assert.equal(res.status, 202);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.facts.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(res.body.facts.bytes, 5);
  assert.equal(res.body.facts.type, 'text/plain');
  assert.match(res.body.spoken, /^notes\.txt: 5 bytes, type text\/plain, SHA-256 2cf24dba5fb0\./);
  const job = che.jobs().find((j) => j.cloud_kind === 'file_processing');
  assert.equal(job.status, 'complete');
  assert.equal(job.environment, 'worker_internal');
  assert.ok(!JSON.stringify(che.saved.get('che')).includes('"hello"'), 'the file itself is not kept');
  // A fake MP4 header is reported as not playable, from the bytes.
  const fake = new Uint8Array(64); fake.set([0x66, 0x74, 0x79, 0x70], 4);
  const facts = await inspectFile(fake, 'clip.mp4');
  assert.equal(facts.type, 'video/mp4');
  assert.equal(facts.mp4.ok, false);
  // ffmpeg exists on the runner, but no workflow takes an arbitrary file: said plainly, nothing queued.
  const transcode = requestCloudWork(newData(), { kind: 'media_transcode' }, { env: GH_ENV, enqueue: enqueueJob });
  assert.equal(transcode.ok, false);
  assert.match(transcode.reason, /no workflow takes an arbitrary file/);
});

// ─── E. Progress, stop, retry ───────────────────────────────────────────────

test('E. the job state machine: approve, cancel, stop, retry, failure explained in plain language', async () => {
  const data = newData();
  const env = GH_ENV;
  const a = requestCloudWork(data, { agent: 'Vale', kind: 'repo_tests' }, { env, enqueue: enqueueJob }).job;
  assert.equal(a.status, 'awaiting_approval');
  // Cancel before approval.
  assert.equal(cancelCloudJob(data, a.id).ok, true);
  assert.equal(a.status, 'cancelled');
  assert.equal(approveCloudJob(data, a.id).ok, false, 'a cancelled job cannot be approved');
  // Retry is the owner's approval for one new dispatch.
  const b = retryCloudJob(data, a.id, enqueueJob).job;
  assert.equal(b.status, 'queued');
  assert.equal(b.retried_from, a.id);
  assert.equal(b.approval.approved_via, 'owner_retry');

  calls.length = 0;
  resetGithub();
  const first = await runCloudTask(b, { env, fetcher: fakeFetch });
  assert.equal(first.status, 'queued');
  b.cloud = { ...b.cloud, ...first.cloud };
  // A dispatched run is stopped on GitHub, not "cancelled" in the queue.
  assert.match(cancelCloudJob(data, b.id).reason, /already on GitHub[\s\S]*stop cloud job/);
  const stopped = await stopCloudJob(data, b.id, { env, fetcher: fakeFetch });
  assert.equal(stopped.ok, true);
  assert.equal(b.status, 'cancelled');
  assert.equal(b.cancelled_via, 'cloud_stop');
  assert.ok(calls.some((c) => c.method === 'POST' && c.path.endsWith('/actions/runs/777/cancel')));

  // A failing run names the failed step.
  const c = retryCloudJob(data, b.id, enqueueJob).job;
  const d1 = await runCloudTask(c, { env, fetcher: fakeFetch });
  c.cloud = { ...c.cloud, ...d1.cloud };
  github.runStatus = 'completed'; github.conclusion = 'failure';
  const done = await runCloudTask(c, { env, fetcher: fakeFetch });
  assert.equal(done.status, 'failed');
  // The retry is its own dispatch, so it is GitHub's next run, not the stopped 777.
  assert.equal(c.cloud.run_id, 778);
  assert.match(done.error, /did not pass: GitHub run 778 finished with "failure"; failed steps: analyze: flutter test\./);
  c.status = done.status;
  assert.equal(retryCloudJob(data, 'nope', enqueueJob).ok, false);

  // GitHub refusals are explained so the owner can act on them.
  github.dispatch = 403;
  const retried = retryCloudJob(data, c.id, enqueueJob);
  assert.equal(retried.ok, true);
  const e = retried.job;
  assert.notEqual(e.id, c.id);
  const refused = await runCloudTask(e, { env, fetcher: fakeFetch });
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /lacks the Actions permission/);
  e.status = refused.status;
  assert.match(explainGithubError(401), /token: it is missing, expired or revoked/);
  assert.match(explainGithubError(0), /could not reach GitHub/);
  github.dispatch = 204;
  // Stop on a run GitHub refuses to cancel is reported, not assumed.
  const f = retryCloudJob(data, e.id, enqueueJob).job;
  const f1 = await runCloudTask(f, { env, fetcher: fakeFetch });
  f.cloud = { ...f.cloud, ...f1.cloud };
  github.cancel = 409;
  const notStopped = await stopCloudJob(data, f.id, { env, fetcher: fakeFetch });
  assert.equal(notStopped.ok, false);
  assert.match(notStopped.reason, /The run was not stopped\./);
  assert.notEqual(f.status, 'cancelled');
  github.cancel = 202;
});

// ─── Codex follow-ups (#514): run correlation, app-build receipts, media ids ───

test('a test job takes the run titled with its own dispatch id, never an older or concurrent run', async () => {
  const data = newData();
  resetGithub();
  // Someone else's manual run, created seconds ago (inside the old one-minute window).
  addRun(776, { display_title: 'Check CHE Flutter client' });
  nextRunId = 777;
  const job = requestCloudWork(data, { kind: 'repo_tests' }, { env: GH_ENV, enqueue: enqueueJob }).job;
  approveCloudJob(data, job.id);
  calls.length = 0;
  const first = await runCloudTask(job, { env: GH_ENV, fetcher: fakeFetch });
  assert.deepEqual(calls.map((c) => c.method).slice(0, 1), ['POST'], 'no pre-dispatch snapshot is needed');
  assert.ok(first.cloud.dispatch_id);
  assert.equal(first.cloud.run_id, 777, 'run 776 does not carry this dispatch id, so it is not this job');

  // The reviewer's case: nothing existed before the dispatch, a concurrent dispatch created run 101, and ours is 102.
  // Oldest-new-run picking would take 101 and stopCloudJob could cancel someone else's run.
  resetGithub();
  github.hideNewRuns = true;
  nextRunId = 102;
  const later = requestCloudWork(newData(), { kind: 'repo_tests' }, { env: GH_ENV, enqueue: enqueueJob }).job;
  approveCloudJob({ jobs: [later] }, later.id);
  const d = await runCloudTask(later, { env: GH_ENV, fetcher: fakeFetch });
  assert.equal(d.cloud.run_id, null, 'no visible run yet: nothing is guessed');
  later.cloud = { ...later.cloud, ...d.cloud };
  addRun(101, { display_title: 'CHE cloud tests some-other-job-1x', created_at: new Date(Date.now() - 5_000).toISOString() });
  const waiting = await runCloudTask(later, { env: GH_ENV, fetcher: fakeFetch });
  assert.equal(waiting.cloud.phase, 'waiting_for_runner', 'the concurrent run 101 is visible but is not ours');
  later.cloud = { ...later.cloud, ...waiting.cloud };
  assert.equal(later.cloud.dispatch_id, d.cloud.dispatch_id, 'the dispatch id survives the waiting polls');
  for (const r of ghRuns) r.hidden = false;
  github.runStatus = 'completed'; github.conclusion = 'success';
  const done = await runCloudTask(later, { env: GH_ENV, fetcher: fakeFetch });
  assert.equal(done.status, 'complete');
  assert.match(done.result, /GitHub run 102 of flutter-check\.yml finished with success/, 'run 102 carries this dispatch id; 101 is never taken');

  // Two runs with the same title is ambiguous: the job stays unassociated rather than guessing.
  resetGithub();
  const twin = requestCloudWork(newData(), { kind: 'repo_tests' }, { env: GH_ENV, enqueue: enqueueJob }).job;
  approveCloudJob({ jobs: [twin] }, twin.id);
  const t1 = await runCloudTask(twin, { env: GH_ENV, fetcher: fakeFetch });
  addRun(900, { display_title: `CHE cloud tests ${t1.cloud.dispatch_id}` });
  twin.cloud = { ...twin.cloud, ...t1.cloud, run_id: null };
  const t2 = await runCloudTask(twin, { env: GH_ENV, fetcher: fakeFetch });
  assert.equal(t2.cloud.phase, 'waiting_for_runner');
  assert.equal(t2.cloud.run_id, undefined, 'no run id is recorded while two runs share the title');

  // A job dispatched before dispatch ids existed takes a new run only when exactly one appeared.
  resetGithub();
  addRun(500, { display_title: 'Check CHE Flutter client' });
  addRun(501, { display_title: 'Check CHE Flutter client' });
  const legacy = { ...later, status: 'queued', cloud: { phase: 'dispatched', dispatched_at: new Date(Date.now() - 10_000).toISOString(), known_run_ids: [], run_id: null } };
  const l1 = await runCloudTask(legacy, { env: GH_ENV, fetcher: fakeFetch });
  assert.equal(l1.cloud.phase, 'waiting_for_runner', 'two new runs and no dispatch id: unassociated');
  legacy.cloud.known_run_ids = [500];
  const l2 = await runCloudTask(legacy, { env: GH_ENV, fetcher: fakeFetch });
  assert.equal(l2.cloud.run_id, 501);
  resetGithub();
});

test('an app build started from the Cloud Computer is recorded and verified like the chat path', async () => {
  const hooked = [];
  const refused = await startCloudTask('ios_patch', {}, { env: GH_ENV, fetcher: fakeFetch, onAppBuildDispatched: async () => assert.fail('no yes, no build') });
  assert.equal(refused.needs_confirmation, true);
  const out = await startCloudTask('ios_patch', {}, { env: GH_ENV, fetcher: fakeFetch, confirmed: true, onAppBuildDispatched: async (mode, at) => { hooked.push({ mode, at }); } });
  assert.equal(out.ok, true);
  assert.equal(out.tracked, true);
  assert.deepEqual(hooked.map((h) => h.mode), ['patch']);
  assert.equal(hooked[0].at, out.dispatched_at);
  const release = await startCloudTask('ios_build', {}, { env: GH_ENV, fetcher: fakeFetch, confirmed: true, onAppBuildDispatched: async (mode) => { hooked.push({ mode }); } });
  assert.equal(release.ok, true);
  assert.equal(hooked.at(-1).mode, 'release');

  // Through the real Worker route: APP_BUILD_KEY is stored and verify_app_build is queued, as "update my phone" does.
  const che = await owner({ env: GH_ENV });
  const res = await che.post('/api/cloud-computer/start', { kind: 'ios_patch', confirmed: true });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.tracked, true);
  assert.match(res.body.spoken, /I will tell you when GitHub reports it shipped or failed\./);
  const build = che.saved.get(APP_BUILD_KEY);
  assert.equal(build.mode, 'patch');
  assert.equal(build.state, 'dispatched');
  assert.equal(build.dispatched_at, res.body.dispatched_at);
  const verify = che.jobs().find((j) => j.kind === 'verify_app_build');
  assert.ok(verify, 'verify_app_build is queued');
  assert.equal(verify.build_mode, 'patch');
  assert.equal(verify.dispatched_at, res.body.dispatched_at);
});

test('a finished GitHub video matches its dispatch by render_task_id, so it is listed once as complete', async () => {
  const saved = new Map([
    ['media_index', [{ id: 'media-uuid-1', root_id: 'media-uuid-1', blob: 'github-artifact', kind: 'video', mode: 'render', title: 'Gold explainer', render_task_id: 'gha_abc123', verified: true, width: 1080, height: 1920, duration_seconds: 15, created_at: '2026-10-24T10:00:00.000Z' }]],
    ['che_video_dispatched:gha_abc123', { at: Date.parse('2026-10-24T09:50:00Z'), topic: 'Gold explainer' }],
    ['che_video_dispatched:gha_still_running', { at: Date.parse('2026-10-24T09:55:00Z'), topic: 'Silver' }],
  ]);
  const ledger = await cloudJobs(storageFor(saved), GH_ENV);
  const rows = (Array.isArray(ledger) ? ledger : ledger.jobs).filter((r) => String(r.id).startsWith('gha_'));
  const done = rows.filter((r) => r.id === 'gha_abc123');
  assert.equal(done.length, 1, 'no second "no finished file" row for a finished video');
  assert.equal(done[0].status, 'complete');
  assert.equal(rows.find((r) => r.id === 'gha_still_running').status, 'unverified');
});

// ─── Routes, voice and the catalog ──────────────────────────────────────────

test('GET /api/cloud-computer is owner-only and holds environments, software, jobs, approvals, costs and missing capabilities', async () => {
  const che = await owner({ env: GH_ENV });
  const view = await che.get('/api/cloud-computer');
  assert.equal(view.status, 200);
  assert.ok(view.body.environments.length >= 5);
  assert.ok(view.body.software.includes('ffmpeg and ffprobe'));
  assert.ok(Array.isArray(view.body.jobs));
  assert.match(view.body.costs.summary, /not verified as free/);
  assert.equal(view.body.missing.find((m) => m.capability === 'blender').reason, MISSING.blender.reason);
  assert.match(view.body.spoken, /No environment has Blender/);
  const stranger = await che.get('/api/cloud-computer', 'not-a-token');
  assert.ok(stranger.status >= 400);
  // Controls by route read back the real result.
  await che.say('Run your coding tests');
  const id = che.jobs().find((j) => j.kind === CLOUD_JOB_KIND).id;
  const cancelled = await che.post('/api/cloud-computer/cancel', { id });
  assert.equal(cancelled.status, 200);
  assert.match(cancelled.body.spoken, /^Cancelled job [0-9a-f]{8}, sir\. Nothing was dispatched\./);
  const again = await che.post('/api/cloud-computer/approve', { id });
  assert.equal(again.status, 409);
});

test('the seven spoken requests reach their catalog commands with no model; questions and other sentences do not', async () => {
  const che = await owner({ env: GH_ENV });
  for (const [said, command] of [
    ['Open your cloud computer', 'cloud-open'], ['Create a Blender animation', 'cloud-blender'], ['Render my YouTube video', 'cloud-render'],
    ['Run your coding tests', 'cloud-tests'], ['Check your open pull requests', 'cloud-prs'], ['Install a compatible free tool for image resizing', 'cloud-install'],
    ['Show me what your agents are working on', 'cloud-agents'], ['Stop cloud job 1a2b3c4d', 'cloud-control'],
  ]) {
    assert.equal(cloudIntent(said)?.command, command, said);
    assert.equal(commandById(command).route, 'che_cloud_computer', command);
    const out = await che.say(said);
    assert.equal(out.route, 'che_cloud_computer', `${said} → ${out.route}: ${out.reply.slice(0, 100)}`);
    assert.equal(out.modelCalls, 0, said);
  }
  assert.equal((await che.say('Open your cloud computer')).done.open_screen, 'cloud_computer');
  assert.match((await che.say('Check your open pull requests')).reply, /1 open pull request, sir\. 1\. Pull request 512: Truth receipts/);
  assert.match((await che.say('Install ImageMagick on your cloud computer')).reply, /You asked for ImageMagick\.[\s\S]*1\. CHE Worker[\s\S]*Nothing was installed\./);
  for (const s of ['What is a cloud computer?', 'Add a tool to the office', 'Set up the software for my client', 'cancel coding job c2987a73']) assert.equal(cloudIntent(s), null, s);
  assert.notEqual((await che.say('cancel coding job c2987a73')).route, 'che_cloud_computer');
  assert.deepEqual(parseControl('stop 1a2b3c4d'), { action: 'stop', id: '1a2b3c4d' });
  assert.equal(parseControl('rm -rf /'), null);
});
