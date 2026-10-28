// "CHE, connect Modal ..." is answered by its own report, with a receipt per step. Each step is tested with a fake
// GitHub and a fake Modal endpoint, so no network is used. Nothing is claimed connected or rendered without evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchModalRender, modalConnectReply, modalRenderRun, modalServiceIntent, modalWorkflowState, serviceCommandIntent } from './modal_connect.js';

const TOKEN = `bearer:${'a'.repeat(40)}@https://vondada--che-gpu.modal.run`;
const NOW = Date.parse('2026-10-28T09:00:00Z');
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body });
const storage = { get: async () => undefined, put: async () => {}, list: async () => new Map() };

// A fake GitHub: `files` says which workflows exist; `runs` is what the runs listing returns; dispatch answers 204.
function githubFake({ files = { check: true, deploy: true }, runs = [], dispatch = 204, dispatchFails = false } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    if (/\/contents\/\.github\/workflows\/che-modal-check\.yml/.test(url)) return json(files.check ? 200 : 404, {});
    if (/\/contents\/\.github\/workflows\/che-modal-deploy\.yml/.test(url)) return json(files.deploy ? 200 : 404, {});
    if (/\/dispatches$/.test(url)) return dispatchFails ? json(422, { message: 'Workflow does not have workflow_dispatch' }) : json(dispatch, {});
    if (/\/runs\?/.test(url)) return json(200, { workflow_runs: runs });
    throw new Error(`unexpected ${url}`);
  };
  return { fetcher, calls };
}
// A fake Modal endpoint for the authenticated /health probe.
function modalFake({ status = 200, body = { app: 'che-gpu', version: 'che-modal-1', gpu: 'T4' } } = {}) {
  return async (url) => { if (!/\/health$/.test(String(url))) throw new Error(`unexpected ${url}`); return json(status, body); };
}
const env = (extra = {}) => ({ CHE_GITHUB_TOKEN: 'ghp_test', CHE_GITHUB_REPO: 'Vondada/chey-app', ...extra });
const RENDER_PENDING = 'Render: started on main at';

test('the owner\'s command is recognized as a Modal service action with connect, verify and render', () => {
  const m = modalServiceIntent("CHE, connect Modal. Verify the deployed service with a real authenticated health check and a small test render.");
  assert.deepEqual({ provider: m.provider, connect: m.connect, verify: m.verify, render: m.render }, { provider: 'modal', connect: true, verify: true, render: true });
  assert.equal(modalServiceIntent('connect modal'), null, 'a plain connect keeps the guided connect flow');
  assert.equal(modalServiceIntent('verify modal').connect, false);
});

test('a message that is not a Modal command is not claimed: deploy status, a PR, a UI modal', () => {
  assert.equal(modalServiceIntent('Is PR #743 merged and is the Worker deployment live?'), null);
  assert.equal(modalServiceIntent('Open the modal dialog and verify the form'), null);
  assert.equal(modalServiceIntent('Summarize this modal article'), null, 'no connect or verify verb');
  assert.equal(modalServiceIntent('connect Hugging Face'), null);
});

test('with no GitHub access and no credential, every step names its blocker and nothing is claimed', async () => {
  const r = await modalConnectReply({}, storage, modalServiceIntent('CHE, connect Modal. Verify with a health check and a small test render.'), { now: NOW });
  assert.equal(r.connected, false);
  assert.match(r.text, /^Modal is not connected yet/);
  assert.match(r.text, /Workflows: not checked\. GitHub is not connected/);
  assert.match(r.text, /Credential: no Modal connection is saved/);
  assert.match(r.text, /Health: not run, because there is no credential/);
  assert.match(r.text, /Render: not started\. GitHub is not connected/);
  assert.doesNotMatch(r.text, /PR|#743|deployment is live|Worker deployment/);
});

test('the authenticated health check passes against a fake Modal app, and the credential value is never shown', async () => {
  const gh = githubFake();
  const modal = modalFake();
  const fetcher = async (url, init) => (/modal\.run/.test(String(url)) ? modal(url, init) : gh.fetcher(url, init));
  const r = await modalConnectReply(env({ MODAL_TOKEN: TOKEN }), storage, modalServiceIntent('connect modal and verify it'), { fetcher, now: NOW });
  assert.equal(r.connected, true);
  assert.match(r.text, /^Modal is connected: the authenticated health check passed in this turn/);
  assert.match(r.text, /Health: passed\./);
  assert.match(r.text, /Credential: a Modal connection is saved in CHE \(value not shown\)/);
  assert.doesNotMatch(r.text, /a{40}|bearer:/);
});

test('a Modal endpoint that rejects the token is reported as a failed health check, not as connected', async () => {
  const gh = githubFake();
  const fetcher = async (url, init) => (/modal\.run/.test(String(url)) ? json(401, {}) : gh.fetcher(url, init));
  const r = await modalConnectReply(env({ MODAL_TOKEN: TOKEN }), storage, modalServiceIntent('verify modal'), { fetcher, now: NOW });
  assert.equal(r.connected, false);
  assert.match(r.text, /Health: failed \(invalid\)/);
});

test('a missing workflow is reported by name, and no render is started', async () => {
  const gh = githubFake({ files: { check: false, deploy: true } });
  const r = await modalConnectReply(env(), storage, modalServiceIntent('connect modal and test render'), { fetcher: gh.fetcher, now: NOW });
  assert.match(r.text, /the Modal check workflow \(che-modal-check\.yml\) is missing/);
  assert.match(r.text, /Render: not started\. the check workflow is missing/);
  assert.equal(gh.calls.some((c) => /dispatches/.test(c)), false, 'no dispatch when the workflow is missing');
});

test('the render is dispatched with gpu_test=true, and reported as passed only when its run succeeds', async () => {
  const runs = [{ id: 4242, status: 'completed', conclusion: 'success', created_at: new Date(NOW + 5000).toISOString(), html_url: 'https://github.com/Vondada/chey-app/actions/runs/4242' }];
  const gh = githubFake({ runs });
  const r = await modalConnectReply(env(), storage, modalServiceIntent('connect modal and test render'), { fetcher: gh.fetcher, now: NOW });
  assert.equal(gh.calls.filter((c) => /dispatches/.test(c)).length, 1);
  assert.match(r.text, /Render: passed \(run 4242\)\./);
  assert.equal(r.steps.render.state, 'passed');
});

test('a render run that failed is reported as failed, never as rendered', async () => {
  const runs = [{ id: 7, status: 'completed', conclusion: 'failure', created_at: new Date(NOW + 5000).toISOString(), html_url: 'https://github.com/x/y/actions/runs/7' }];
  const r = await modalConnectReply(env(), storage, modalServiceIntent('test the Modal render'), { fetcher: githubFake({ runs }).fetcher, now: NOW });
  assert.match(r.text, /Render: failed \(run 7, failure\)/);
  assert.doesNotMatch(r.text, /Render: passed/);
});

test('a render that has started but has no run yet is not claimed as rendered', async () => {
  const r = await modalConnectReply(env(), storage, modalServiceIntent('test the Modal render'), { fetcher: githubFake({ runs: [] }).fetcher, now: NOW });
  assert.match(r.text, new RegExp(RENDER_PENDING));
  assert.match(r.text, /not claimed as rendered|has not appeared yet/);
  assert.equal(r.steps.render.started, true);
});

test('a refused dispatch is reported with GitHub\'s own message', async () => {
  const d = await dispatchModalRender(env(), githubFake({ dispatchFails: true }).fetcher);
  assert.equal(d.ok, false);
  assert.match(d.detail, /GitHub refused the render workflow \(422: Workflow does not have workflow_dispatch\)/);
});

test('the workflow state is unknown, not false, when GitHub does not answer', async () => {
  const s = await modalWorkflowState(env(), async () => json(503, {}));
  assert.equal(s.known, false);
  assert.match(s.reason, /GitHub did not answer/);
  const run = await modalRenderRun(env(), NOW, async () => json(503, {}));
  assert.equal(run.state, 'unknown');
});

test('the dispatch: a Modal verify ask goes to the Modal report; a plain connect goes to the guided connect flow', () => {
  assert.equal(serviceCommandIntent('CHE, connect Modal and verify it').kind, 'modal');
  const plain = serviceCommandIntent('connect modal');
  assert.equal(plain.kind, 'connect');
  assert.equal(plain.onboard.provider, 'modal');
  assert.equal(serviceCommandIntent('Is PR #743 merged and is the Worker deployment live?'), null);
});
