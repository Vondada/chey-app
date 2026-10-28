// "CHE, connect Modal. Verify the deployed service with a real authenticated health check and a small test render."
// The owner's explicit Modal command. It is answered by its own route, before any GitHub or deployment matcher, and each
// step reports a receipt or a named blocker. Nothing is reported as connected or rendered without execution evidence:
//   1. workflows   the repository has the Modal check and deploy workflows (GitHub contents API)
//   2. credential  CHE has a Modal credential saved (presence only; the value is never read into a reply)
//   3. health      an authenticated GET /health to the deployed che-gpu app (modalHealth, the same probe as Check Connection)
//   4. render      the existing "CHE Modal check" workflow runs one short T4 render (gpu_test=true) on GitHub's runner
// Owner-only. Deterministic: no model call.

import { gh } from './coding_runtime.js';
import { modalCredential, modalHealth } from './modal_gpu.js';
import { onboardingIntent } from './service_onboarding.js';

export const MODAL_CHECK_WORKFLOW = 'che-modal-check.yml';
export const MODAL_DEPLOY_WORKFLOW = 'che-modal-deploy.yml';

// "modal" as a service, not the UI word ("the modal dialog", "a modal window").
const UI_MODAL = /\bmodal\s+(?:dialog|window|sheet|popup|screen|view)\b/;
const CONNECT = /\b(?:connect|hook up|link|onboard|reconnect)\b/;
const VERIFY = /\b(?:verify|verifying|test|check|health|render|rendering|connection|working|deployed service|deployed)\b/;
const RENDER = /\b(?:render|rendering|test render|small render|gpu test|gpu render)\b/;

/**
 * The Modal verification command: "connect Modal and verify it", "test the Modal render". Null for a plain connect, for any
 * other message, and for a mention of Modal as a UI word.
 */
export function modalServiceIntent(message = '') {
  const t = String(message || '').toLowerCase().replace(/^(?:hey |ok |okay )?(?:che|chay)[,:]?\s+/, '').trim();
  if (!t || t.length > 600 || !/\bmodal\b/.test(t) || UI_MODAL.test(t)) return null;
  const connect = CONNECT.test(t);
  const verify = VERIFY.test(t);
  // A plain "connect Modal" keeps the guided connect flow (service_onboarding.js). This report is for a verify or render ask.
  if (!verify) return null;
  return { provider: 'modal', connect, verify, render: RENDER.test(t) };
}

/** Whether the two Modal workflows are in the repository, by GitHub's contents API. Never reads a secret. */
export async function modalWorkflowState(env, fetcher = fetch) {
  if (!env?.CHE_GITHUB_TOKEN || !env?.CHE_GITHUB_REPO) return { known: false, reason: 'GitHub is not connected to CHE (no CHE_GITHUB_TOKEN or CHE_GITHUB_REPO), so the workflows cannot be checked.' };
  const look = async (file) => {
    const r = await gh(env, 'GET', `/contents/.github/workflows/${file}?ref=main`, null, fetcher);
    return r.ok ? true : (r.status === 404 ? false : null);
  };
  const [check, deploy] = [await look(MODAL_CHECK_WORKFLOW), await look(MODAL_DEPLOY_WORKFLOW)];
  if (check === null || deploy === null) return { known: false, reason: 'GitHub did not answer about the Modal workflows, so they cannot be confirmed.' };
  return { known: true, check, deploy };
}

/**
 * Starts the Modal check workflow on main with one short GPU render. GitHub answers 204 with no run id, so the run is
 * looked up separately; until it appears, the render is reported as started, not as rendered.
 */
export async function dispatchModalRender(env, fetcher = fetch) {
  const sent = await gh(env, 'POST', `/actions/workflows/${MODAL_CHECK_WORKFLOW}/dispatches`, { ref: 'main', inputs: { gpu_test: 'true' } }, fetcher);
  if (sent.status === 204 || sent.ok) return { ok: true, started_at: new Date().toISOString() };
  return { ok: false, status: sent.status || 0, detail: `GitHub refused the render workflow (${sent.status || 'network'}${sent.data?.message ? `: ${String(sent.data.message).slice(0, 120)}` : ''}).` };
}

/** The newest run of the Modal check started since `since`, with its real state and conclusion. */
export async function modalRenderRun(env, since, fetcher = fetch) {
  const runs = await gh(env, 'GET', `/actions/workflows/${MODAL_CHECK_WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=5`, null, fetcher);
  if (!runs.ok) return { state: 'unknown', detail: `GitHub did not answer about the render run (${runs.status || 'network'}).` };
  const sinceMs = Date.parse(since || 0) - 60_000;
  const run = (runs.data?.workflow_runs || []).find((r) => Date.parse(r.created_at || 0) >= sinceMs);
  if (!run) return { state: 'waiting' };
  const base = { run_id: run.id, html_url: run.html_url || '' };
  if (run.status !== 'completed') return { ...base, state: 'running' };
  return { ...base, state: run.conclusion === 'success' ? 'passed' : 'failed', conclusion: run.conclusion };
}

/**
 * The reply for the Modal command, with a receipt for each step. `connected` is true only when the authenticated health
 * check passed in this turn. `rendered` is never claimed here: it needs the workflow run to conclude successfully.
 */
export async function modalConnectReply(env, storage, intent, { fetcher = fetch, now = Date.now() } = {}) {
  const lines = [];
  const steps = {};
  const at = new Date(now).toISOString();

  // 1. Workflows.
  const wf = await modalWorkflowState(env, fetcher);
  steps.workflows = wf.known ? { check: wf.check, deploy: wf.deploy } : { blocked: wf.reason };
  if (!wf.known) lines.push(`Workflows: not checked. ${wf.reason}`);
  else if (!wf.check) lines.push(`Workflows: the Modal check workflow (${MODAL_CHECK_WORKFLOW}) is missing from the repository, so no render can run.`);
  else lines.push(`Workflows: ${MODAL_CHECK_WORKFLOW} and ${MODAL_DEPLOY_WORKFLOW} ${wf.deploy ? 'are present' : `are present, but ${MODAL_DEPLOY_WORKFLOW} is missing`} on main.`);

  // 2. Credential (presence only).
  const cred = await modalCredential(env, storage);
  steps.credential = { configured: cred.exists };
  lines.push(cred.exists
    ? 'Credential: a Modal connection is saved in CHE (value not shown).'
    : 'Credential: no Modal connection is saved in CHE, so the authenticated health check cannot run. The GitHub deploy workflow (or the Modal proxy token, saved through CHE\'s secure field) connects it.');

  // 3. Authenticated health check.
  let connected = false;
  if (cred.exists) {
    const h = await modalHealth(cred.cred, fetcher);
    connected = h.ok === true;
    steps.health = { ok: h.ok, auth: h.auth, http_status: h.http_status ?? null, ...(h.upstream_id ? { upstream_id: h.upstream_id } : {}), at };
    lines.push(connected
      ? `Health: passed. ${h.detail} Checked at ${at}.`
      : `Health: failed (${h.auth || 'unknown'}). ${h.detail || 'Modal did not answer'}.`);
  } else {
    steps.health = { ok: null, blocked: 'no credential' };
    lines.push('Health: not run, because there is no credential.');
  }

  // 4. Render (only when asked): the existing check workflow, one short T4 render.
  if (intent.render) {
    if (!wf.known || !wf.check) {
      steps.render = { started: false, blocked: wf.known ? 'the check workflow is missing' : wf.reason };
      lines.push(`Render: not started. ${steps.render.blocked}`);
    } else {
      const sent = await dispatchModalRender(env, fetcher);
      if (!sent.ok) {
        steps.render = { started: false, blocked: sent.detail };
        lines.push(`Render: not started. ${sent.detail}`);
      } else {
        const run = await modalRenderRun(env, sent.started_at, fetcher);
        steps.render = { started: true, ...run };
        const url = run.html_url ? ` ${run.html_url}` : '';
        if (run.state === 'passed') lines.push(`Render: passed (run ${run.run_id}).${url}`);
        else if (run.state === 'failed') lines.push(`Render: failed (run ${run.run_id}, ${run.conclusion}).${url} Open the run for the failed step.`);
        else if (run.state === 'running') lines.push(`Render: running (run ${run.run_id}).${url} It is not finished, so it is not claimed as rendered.`);
        else lines.push(`Render: started on main at ${sent.started_at}. The run has not appeared yet, so it is not claimed as rendered. Actions: https://github.com/${env.CHE_GITHUB_REPO}/actions/workflows/${MODAL_CHECK_WORKFLOW}`);
      }
    }
  }

  const headline = connected
    ? 'Modal is connected: the authenticated health check passed in this turn.'
    : 'Modal is not connected yet: the authenticated health check did not pass, so I do not claim it.';
  return { text: [headline, ...lines].join('\n'), connected, steps, at };
}

/** The chat response for the Modal verification command: the report, its source and its receipt. */
export async function modalServiceReply(env, storage, intent, ndjsonReply) {
  const reply = await modalConnectReply(env, storage, intent);
  return ndjsonReply(reply.text, { source: 'che_modal_connect', ok: reply.connected, model_calls: 0, steps: reply.steps });
}

/**
 * The explicit service command that runs before the GitHub and deployment matchers: a Modal verify ask ({kind:'modal'}),
 * or a connect command for any provider ({kind:'connect'}, the guided connect flow). Null for everything else.
 */
export function serviceCommandIntent(message) {
  const modal = modalServiceIntent(message);
  if (modal) return { kind: 'modal', intent: modal };
  const onboard = onboardingIntent(message);
  return onboard?.kind === 'connect' ? { kind: 'connect', onboard } : null;
}
