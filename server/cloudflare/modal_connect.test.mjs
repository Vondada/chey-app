// The Modal command: "check Modal connection", "check the previous GPU render" and "start a new test render" are three
// different asks. A status check starts nothing, a repeated new-run message starts one GPU check, and every reply names
// the real run and its state. Fake GitHub and Modal endpoints only: no network, no GPU, nothing billed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkRunLabel, dispatchModalRender, modalConnectReply, modalJobStatusReply, modalRenderRun, modalServiceIntent,
  modalWorkflowState, pictureJobLabel, serviceCommandIntent, startModalCheckOnce,
} from './modal_connect.js';
import { MODAL_IMAGE_KEY } from './media.js';

const TOKEN = `bearer:${'a'.repeat(40)}@https://vondada--che-gpu.modal.run`;
const NOW = Date.parse('2026-10-28T09:00:00Z');
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body });
const env = (extra = {}) => ({ CHE_GITHUB_TOKEN: 'ghp_test', CHE_GITHUB_REPO: 'Vondada/chey-app', ...extra });

// An in-memory Durable Object storage: get/put/list, as the Worker uses it.
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    put: async (k, v) => { map.set(k, structuredClone(v)); },
    list: async () => new Map(map),
  };
}

// A fake GitHub. `checkRuns` and `deployRuns` are what each workflow's runs listing returns. Dispatch answers 204.
// `gpuSteps` maps a check run id to its GPU step ({status, conclusion}). A run not listed is connection-only (step skipped).
function githubFake({ checkRuns = [], deployRuns = [], files = { check: true, deploy: true }, dispatchFails = false, gpuSteps = {} } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${url}`);
    if (/\/contents\/\.github\/workflows\/che-modal-check\.yml/.test(url)) return json(files.check ? 200 : 404, {});
    if (/\/contents\/\.github\/workflows\/che-modal-deploy\.yml/.test(url)) return json(files.deploy ? 200 : 404, {});
    if (/\/dispatches$/.test(url)) return dispatchFails ? json(422, { message: 'Workflow does not have workflow_dispatch' }) : json(204, {});
    if (/\/actions\/runs\/(\d+)\/jobs/.test(url)) {
      const id = Number(url.match(/\/actions\/runs\/(\d+)\/jobs/)[1]);
      const step = gpuSteps[id] || { status: 'completed', conclusion: 'skipped' };
      return json(200, { jobs: [{ steps: [{ name: 'Endpoint answers and refuses an unauthenticated request', status: 'completed', conclusion: 'success' }, { name: 'GPU test (gpu_check once on the deployed app)', ...step }] }] });
    }
    if (/che-modal-check\.yml\/runs\?/.test(url)) return json(200, { workflow_runs: checkRuns });
    if (/che-modal-deploy\.yml\/runs\?/.test(url)) return json(200, { workflow_runs: deployRuns });
    throw new Error(`unexpected ${url}`);
  };
  return { fetcher, calls, dispatches: () => calls.filter((c) => /\/dispatches$/.test(c)).length };
}
// A fake Modal endpoint for the authenticated /health probe.
function modalFake({ status = 200, body = { app: 'che-gpu', version: 'che-modal-3', gpu: 'T4' } } = {}) {
  return async (url) => { if (!/\/health$/.test(String(url))) throw new Error(`unexpected ${url}`); return json(status, body); };
}
const runAt = (id, extra = {}) => ({ id, created_at: new Date(NOW + 5000).toISOString(), html_url: `https://github.com/Vondada/chey-app/actions/runs/${id}`, ...extra });

// The owner's repeated messages, each as its own test case (wording as the owner sent it, where it was recorded).
const STATUS_ASKS = [
  'CHE, check my previous Modal GPU render.',
  'check the previous Modal render',
  'check the last Modal GPU render again',
  'did the Modal GPU render finish',
  "what's the status of the Modal GPU render",
];
const CONNECTION_ASKS = ['check modal connection', 'is modal connected', 'verify modal'];
const NEW_RUN_ASKS = ['start a new GPU test render', 'run a GPU test'];

test('each status ask is recognised as a status check, and never as a new run', () => {
  for (const msg of STATUS_ASKS) assert.equal(modalServiceIntent(msg)?.kind, 'job_status', msg);
});

test('each connection ask is recognised as a connection check, and never as a new run', () => {
  for (const msg of CONNECTION_ASKS) {
    const m = modalServiceIntent(msg);
    assert.equal(m?.kind, 'connection', msg);
    assert.equal(m.render, false, msg);
  }
});

test('an explicit start is the only new-run ask', () => {
  for (const msg of NEW_RUN_ASKS) {
    const m = modalServiceIntent(msg);
    assert.equal(m?.kind, 'new_render', msg);
    assert.equal(m.render, true, msg);
  }
});

test('the connect-and-verify command no longer starts a GPU check by itself', () => {
  const m = modalServiceIntent('CHE, connect Modal. Verify the deployed service with a real authenticated health check and a small test render.');
  assert.equal(m.kind, 'connection');
  assert.equal(m.render, false);
});

test('a plain connect keeps the guided connect flow; a non-Modal message is not claimed', () => {
  assert.equal(modalServiceIntent('connect modal'), null, 'a plain connect keeps the guided connect flow');
  assert.equal(modalServiceIntent('Is PR #743 merged and is the Worker deployment live?'), null);
  assert.equal(modalServiceIntent('Open the modal dialog and verify the form'), null);
  assert.equal(modalServiceIntent('Summarize this modal article'), null);
  assert.equal(modalServiceIntent('connect Hugging Face'), null);
});

test('questions and negations never start a run, even when they name a new run', () => {
  const asks = [
    'did you run that GPU test again?',
    'Do not start another Modal GPU render',
    'could you start a new GPU test render?',
    'please do not run a GPU test',
  ];
  for (const msg of asks) assert.equal(modalServiceIntent(msg)?.kind, 'job_status', msg);
});

test('a plain GPU question stays with the GPU job queue, and is not a Modal route', () => {
  assert.equal(modalServiceIntent('What are my GPU jobs?'), null);
  assert.equal(modalServiceIntent('check my previous GPU render'), null, 'no Modal word and no GPU test: the job queue answers it');
});

test('a picture request is never a GPU self-test, even when it mentions a GPU', () => {
  assert.equal(modalServiceIntent('Create a picture of a GPU'), null);
  assert.equal(modalServiceIntent('create a picture with modal'), null, 'the picture route answers it');
  assert.equal(modalServiceIntent('make a picture on the GPU'), null);
  assert.equal(modalServiceIntent('check the previous Modal picture')?.kind, 'job_status');
});

test('a connection-only check run is never reported as a GPU test', async () => {
  const gh = githubFake({ checkRuns: [runAt(9010, { status: 'completed', conclusion: 'success' })] });
  const r = await modalJobStatusReply(env(), memoryStorage(), { fetcher: gh.fetcher, now: NOW });
  assert.match(r.text, /GPU check: no GPU test on record/);
  assert.match(r.text, /Connection check: run 9010 is success, connection only \(no GPU test ran\)\./);
  assert.doesNotMatch(r.text, /GPU check: run 9010 is completed/);
});

test('the newest GPU test is reported from its own GPU step, past a newer connection-only run', async () => {
  const gh = githubFake({
    checkRuns: [runAt(9011, { status: 'completed', conclusion: 'success' }), runAt(9012, { status: 'completed', conclusion: 'success' })],
    gpuSteps: { 9012: { status: 'completed', conclusion: 'success' } },
  });
  const r = await modalJobStatusReply(env(), memoryStorage(), { fetcher: gh.fetcher, now: NOW });
  assert.match(r.text, /GPU check: run 9012 is completed\./);
  assert.match(r.text, /Connection check: run 9011 is success, connection only/);
});

test('the repeated status asks start nothing, however many times they are sent', async () => {
  const gh = githubFake({ checkRuns: [runAt(9001, { status: 'in_progress', conclusion: null })], gpuSteps: { 9001: { status: 'in_progress', conclusion: null } } });
  const modal = modalFake();
  const fetcher = async (url, init) => (/modal\.run/.test(String(url)) ? modal(url, init) : gh.fetcher(url, init));
  const storage = memoryStorage({ [MODAL_IMAGE_KEY]: [] });
  for (const msg of STATUS_ASKS) {
    const intent = modalServiceIntent(msg);
    const r = await modalJobStatusReply(env({ MODAL_TOKEN: TOKEN }), storage, { fetcher, now: NOW });
    assert.match(r.text, /^Status of the existing jobs\. Nothing was started\./, msg);
  }
  assert.equal(gh.dispatches(), 0, 'no status ask dispatches a workflow');
});

test('the status reply names the real GPU check run and its state, and calls it a check, not an image', async () => {
  const gh = githubFake({ checkRuns: [runAt(9001, { status: 'in_progress', conclusion: null })], gpuSteps: { 9001: { status: 'in_progress', conclusion: null } } });
  const r = await modalJobStatusReply(env(), memoryStorage(), { fetcher: gh.fetcher, now: NOW });
  assert.match(r.text, /GPU check: run 9001 is running the GPU check \(a T4 self-test, not an image\)\./);
  assert.match(r.text, /https:\/\/github\.com\/Vondada\/chey-app\/actions\/runs\/9001/);
  assert.doesNotMatch(r.text, /GPU check: run 9001 is [^.]*render/i, 'a health check is never described as a render');
});

test('deployed, queued, completed and failed are told apart; a saved picture shows its Gallery asset', async () => {
  assert.equal(checkRunLabel({ status: 'queued' }), 'queued');
  assert.equal(checkRunLabel({ status: 'completed', conclusion: 'success' }), 'completed');
  assert.equal(checkRunLabel({ status: 'completed', conclusion: 'failure' }), 'failed');
  assert.equal(pictureJobLabel({ state: 'saved', item: { id: 'pic-7' } }), 'completed and saved to Gallery as asset pic-7');
  assert.match(pictureJobLabel({ state: 'failed', error: 'CUDA out of memory' }), /failed: CUDA out of memory/);
  const gh = githubFake({ checkRuns: [runAt(9002, { status: 'completed', conclusion: 'success' })], gpuSteps: { 9002: { status: 'completed', conclusion: 'success' } }, deployRuns: [runAt(9100, { status: 'completed', conclusion: 'success' })] });
  const storage = memoryStorage({ [MODAL_IMAGE_KEY]: [{ call_id: 'fc-abcdef123456', title: 'a kite', state: 'saved', item: { id: 'pic-7' } }] });
  const r = await modalJobStatusReply(env(), storage, { fetcher: gh.fetcher, now: NOW });
  assert.match(r.text, /GPU check: run 9002 is completed\./);
  assert.match(r.text, /Deployed: deployed \(run 9100\)\./);
  assert.match(r.text, /Picture job fc-abcdef123456 \(a kite\): completed and saved to Gallery as asset pic-7\./);
});

test('a status ask with no record says so, rather than inventing a job', async () => {
  const gh = githubFake({ checkRuns: [], deployRuns: [] });
  const r = await modalJobStatusReply(env(), memoryStorage(), { fetcher: gh.fetcher, now: NOW });
  assert.match(r.text, /GPU check: no run on record\./);
  assert.match(r.text, /Deployed: no Modal deploy run on record\./);
  assert.match(r.text, /Picture jobs: none on record\./);
});

test('a new GPU check starts once; a repeated voice command within the window is refused, with no second dispatch', async () => {
  const gh = githubFake({ checkRuns: [] });
  const storage = memoryStorage();
  const first = await modalConnectReply(env(), storage, modalServiceIntent('start a new GPU test render'), { fetcher: gh.fetcher, now: NOW });
  assert.equal(gh.dispatches(), 1);
  assert.match(first.text, /GPU check: queued on main|GPU check: (completed|running|failed)/);
  for (const msg of NEW_RUN_ASKS) {
    const again = await modalConnectReply(env(), storage, modalServiceIntent(msg), { fetcher: gh.fetcher, now: NOW + 30_000 });
    assert.match(again.text, /GPU check: not started\. A GPU check was already started at/);
  }
  assert.equal(gh.dispatches(), 1, 'the repeated new-run commands dispatched nothing more');
});

test('a new GPU check is refused while another check run is still queued or running on GitHub', async () => {
  const gh = githubFake({ checkRuns: [runAt(9003, { status: 'in_progress', conclusion: null })] });
  const r = await modalConnectReply(env(), memoryStorage(), modalServiceIntent('run a GPU test'), { fetcher: gh.fetcher, now: NOW });
  assert.equal(gh.dispatches(), 0);
  assert.match(r.text, /GPU check: not started\. GPU check run 9003 is already running\. I did not start another\./);
});

test('after the window passes, a deliberate new GPU check is allowed again', async () => {
  const gh = githubFake({ checkRuns: [] });
  const storage = memoryStorage();
  await modalConnectReply(env(), storage, modalServiceIntent('start a new GPU test render'), { fetcher: gh.fetcher, now: NOW });
  await modalConnectReply(env(), storage, modalServiceIntent('start a new GPU test render'), { fetcher: gh.fetcher, now: NOW + 5 * 60_000 });
  assert.equal(gh.dispatches(), 2);
});

test('a status ask never reads as a start, so a status ask after a start still starts nothing', async () => {
  const gh = githubFake({ checkRuns: [runAt(9004, { status: 'queued', conclusion: null })] });
  const storage = memoryStorage();
  await modalConnectReply(env(), storage, modalServiceIntent('start a new GPU test render'), { fetcher: gh.fetcher, now: NOW - 10 * 60_000 });
  const before = gh.dispatches();
  await modalJobStatusReply(env(), storage, { fetcher: gh.fetcher, now: NOW });
  assert.equal(gh.dispatches(), before);
});

test('with no GitHub access and no credential, every step names its blocker and nothing is claimed', async () => {
  const r = await modalConnectReply({}, memoryStorage(), modalServiceIntent('check modal connection'), { now: NOW });
  assert.equal(r.connected, false);
  assert.match(r.text, /^Modal is not connected yet/);
  assert.match(r.text, /Workflows: not checked\. GitHub is not connected/);
  assert.match(r.text, /Credential: no Modal connection is saved/);
  assert.match(r.text, /Health: not run, because there is no credential/);
  assert.doesNotMatch(r.text, /GPU check/, 'a connection check does not mention a GPU check');
});

test('the authenticated health check passes against a fake Modal app, and the credential value is never shown', async () => {
  const gh = githubFake();
  const modal = modalFake();
  const fetcher = async (url, init) => (/modal\.run/.test(String(url)) ? modal(url, init) : gh.fetcher(url, init));
  const r = await modalConnectReply(env({ MODAL_TOKEN: TOKEN }), memoryStorage(), modalServiceIntent('check modal connection'), { fetcher, now: NOW });
  assert.equal(r.connected, true);
  assert.match(r.text, /^Modal is connected: the authenticated health check passed in this turn/);
  assert.match(r.text, /Credential: a Modal connection is saved in CHE \(value not shown\)/);
  assert.doesNotMatch(r.text, /a{40}|bearer:/);
  assert.equal(gh.dispatches(), 0);
});

test('a Modal endpoint that rejects the token is reported as a failed health check, not as connected', async () => {
  const gh = githubFake();
  const fetcher = async (url, init) => (/modal\.run/.test(String(url)) ? json(401, {}) : gh.fetcher(url, init));
  const r = await modalConnectReply(env({ MODAL_TOKEN: TOKEN }), memoryStorage(), modalServiceIntent('verify modal'), { fetcher, now: NOW });
  assert.equal(r.connected, false);
  assert.match(r.text, /Health: failed \(invalid\)/);
});

test('a missing GPU check workflow is named, and no run is started', async () => {
  const gh = githubFake({ files: { check: false, deploy: true } });
  const r = await modalConnectReply(env(), memoryStorage(), modalServiceIntent('start a new GPU test render'), { fetcher: gh.fetcher, now: NOW });
  assert.match(r.text, /the GPU check workflow \(che-modal-check\.yml\) is missing/);
  assert.match(r.text, /GPU check: not started\. the check workflow is missing/);
  assert.equal(gh.dispatches(), 0);
});

test('a new GPU check is reported as completed only when its run succeeds', async () => {
  const gh = githubFake({ checkRuns: [runAt(4242, { status: 'completed', conclusion: 'success' })] });
  const r = await modalConnectReply(env(), memoryStorage(), modalServiceIntent('start a new GPU test render'), { fetcher: gh.fetcher, now: NOW });
  assert.equal(gh.dispatches(), 1);
  assert.match(r.text, /GPU check: completed \(run 4242\)\./);
});

test('a GPU check run that failed is reported as failed, never as completed', async () => {
  const gh = githubFake({ checkRuns: [runAt(7, { status: 'completed', conclusion: 'failure' })] });
  const r = await modalConnectReply(env(), memoryStorage(), modalServiceIntent('start a new GPU test render'), { fetcher: gh.fetcher, now: NOW });
  assert.match(r.text, /GPU check: failed \(run 7, failure\)/);
  assert.doesNotMatch(r.text, /GPU check: completed/);
});

test('a refused dispatch is reported with GitHub\'s own message, and nothing is recorded as started', async () => {
  const gh = githubFake({ dispatchFails: true });
  const storage = memoryStorage();
  const d = await dispatchModalRender(env(), gh.fetcher);
  assert.equal(d.ok, false);
  assert.match(d.detail, /GitHub refused the GPU check workflow \(422: Workflow does not have workflow_dispatch\)/);
  const once = await startModalCheckOnce(env(), storage, gh.fetcher, NOW);
  assert.equal(once.started, false);
  assert.equal(await storage.get('che:modal_check_dispatch'), undefined);
});

test('the workflow state is unknown, not false, when GitHub does not answer', async () => {
  const s = await modalWorkflowState(env(), async () => json(503, {}));
  assert.equal(s.known, false);
  assert.match(s.reason, /GitHub did not answer/);
  const run = await modalRenderRun(env(), NOW, async () => json(503, {}));
  assert.equal(run.state, 'unknown');
});

test('the dispatch: a Modal ask goes to the Modal report; a plain connect goes to the guided connect flow', () => {
  assert.equal(serviceCommandIntent('CHE, check my previous Modal GPU render.').kind, 'modal');
  const plain = serviceCommandIntent('connect modal');
  assert.equal(plain.kind, 'connect');
  assert.equal(plain.onboard.provider, 'modal');
  assert.equal(serviceCommandIntent('Is PR #743 merged and is the Worker deployment live?'), null);
});

test('GPU health questions read the authenticated connection check (Q-25); GPU job and picture asks keep their routes', () => {
  for (const msg of ["Why isn't my GPU working?", 'why is my gpu not working', 'Is my GPU connected?', 'are the GPUs online', 'GPU health check'])
    assert.deepEqual(modalServiceIntent(msg), { provider: 'modal', kind: 'connection', connect: false, verify: true, render: false }, msg);
  for (const msg of ['what are my GPU jobs?', 'make a picture of a GPU', 'which GPU should I buy for gaming'])
    assert.notEqual(modalServiceIntent(msg)?.kind, 'connection', msg);
});
