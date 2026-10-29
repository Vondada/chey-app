// "CHE, connect Modal ..." is answered by its own report, with a receipt for each step. Three different asks, and only one
// starts work:
//   connection  "check Modal connection": the authenticated health check. Starts nothing.
//   job_status  "check the previous GPU render": reads the existing GitHub runs and Modal picture jobs. Starts nothing.
//   new_render  "start a new test render": the only route that dispatches the GPU check, and it refuses a duplicate.
// The GPU check (che-modal-check.yml) is a one-off T4 self-test (a Blender cube), not an image. It is never called a render.
// Owner-only. Deterministic: no model call.

import { gh } from './coding_runtime.js';
import { MODAL_IMAGE_KEY } from './media.js';
import { modalCredential, modalHealth } from './modal_gpu.js';
import { onboardingIntent } from './service_onboarding.js';

export const MODAL_CHECK_WORKFLOW = 'che-modal-check.yml';
export const MODAL_DEPLOY_WORKFLOW = 'che-modal-deploy.yml';
// A second new GPU check inside this window is refused: a repeated voice command must not start a second run.
export const MODAL_CHECK_DEDUPE_MS = 120_000;
const MODAL_CHECK_DISPATCH_KEY = 'che:modal_check_dispatch';

// "modal" as a service, not the UI word ("the modal dialog", "a modal window").
const UI_MODAL = /\bmodal\s+(?:dialog|window|sheet|popup|screen|view)\b/;
const MODAL_WORD = /\bmodal\b/;
const GPU_TEST_WORDS = /\bgpu (?:test|check)\b/;
// Words that point at a job that already exists.
const JOB_REF = /\b(?:previous|prior|last|latest|earlier|existing|old|that|this|status|progress|finished|finish|done|result|results|did it|is it|where is|check on|what happened)\b/;
// Words that ask for a new job. Only an explicit start verb with a render, picture or GPU noun starts one.
const START_VERB = /\b(?:start|launch|trigger|queue|kick off|make|create|generate|send|run|do)\b/;
const NEW_QUALIFIER = /\b(?:new|another|again|fresh|one more)\b/;
// Nouns that can start a GPU check. Pictures and images are never a GPU check: their requests belong to the picture route.
const START_NOUN = /\b(?:render|renders|rendering|gpu test|gpu check|gpu render|job|jobs)\b/;
// Nouns a status question can ask about: the same, plus Modal's picture jobs.
const STATUS_NOUN = /\b(?:render|renders|rendering|gpu test|gpu check|gpu render|job|jobs|picture|pictures|image|images)\b/;
// A question or a negation never starts work: "did you run that GPU test again?", "do not start another GPU render".
const QUESTION = /^(?:did|do|does|is|are|was|were|has|have|had|can|could|would|will|what|where|how|why|when|which)\b|\?\s*$/;
const NEGATION = /\b(?:not|no|never|don't|dont|stop|cancel|without)\b/;
const CHECK_WORD = /\b(?:check|verify|verifying|test|health|connection|connected|working|deployed|deployment)\b/;
const CONNECT = /\b(?:connect|hook up|link|onboard|reconnect)\b/;

/**
 * The Modal command: which of the three asks it is. Null for a plain connect (the guided connect flow), for any other
 * message, and for a mention of Modal as a UI word.
 *   connection: "check Modal connection", "verify modal", "is modal connected"
 *   job_status: "check the previous GPU render", "did the render finish", "status of the last picture"
 *   new_render: "start a new test render", "run a GPU test"
 */
export function modalServiceIntent(message = '') {
  const t = String(message || '').toLowerCase().replace(/^(?:hey |ok |okay )?(?:che|chay)[,:]?\s+/, '').trim();
  if (!t || t.length > 600 || UI_MODAL.test(t)) return null;
  // Only Modal, or an explicit GPU test or check, is this route. A plain GPU question ("what are my GPU jobs?") belongs to the
  // GPU job queue, and a picture is never this route.
  if (!MODAL_WORD.test(t) && !(GPU_TEST_WORDS.test(t) && START_NOUN.test(t))) return null;
  const asks = QUESTION.test(t) || NEGATION.test(t);
  const startsNew = !asks && START_VERB.test(t) && START_NOUN.test(t);
  const refsExisting = JOB_REF.test(t) && STATUS_NOUN.test(t);
  let kind = null;
  if (asks && STATUS_NOUN.test(t)) kind = 'job_status';
  else if (startsNew && NEW_QUALIFIER.test(t)) kind = 'new_render';
  else if (refsExisting) kind = 'job_status';
  else if (startsNew) kind = 'new_render';
  else if (CHECK_WORD.test(t) || CONNECT.test(t)) kind = 'connection';
  if (!kind) return null;
  // A plain "connect Modal" with no check word keeps the guided connect flow.
  if (kind === 'connection' && !CHECK_WORD.test(t)) return null;
  return { provider: 'modal', kind, connect: CONNECT.test(t), verify: kind !== 'new_render' && CHECK_WORD.test(t), render: kind === 'new_render' };
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
export async function dispatchModalRender(env, fetcher = fetch, now = Date.now()) {
  const sent = await gh(env, 'POST', `/actions/workflows/${MODAL_CHECK_WORKFLOW}/dispatches`, { ref: 'main', inputs: { gpu_test: 'true' } }, fetcher);
  if (sent.status === 204 || sent.ok) return { ok: true, started_at: new Date(now).toISOString() };
  return { ok: false, status: sent.status || 0, detail: `GitHub refused the GPU check workflow (${sent.status || 'network'}${sent.data?.message ? `: ${String(sent.data.message).slice(0, 120)}` : ''}).` };
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

/** The state of one GPU check run, in CHE's words. The check is a self-test, so it is never called a render. */
export function checkRunLabel(run) {
  if (!run) return 'no GPU check run on record';
  if (run.status === 'queued' || run.status === 'waiting' || run.status === 'requested' || run.status === 'pending') return 'queued';
  if (run.status === 'in_progress') return 'running the GPU check (a T4 self-test, not an image)';
  if (run.conclusion === 'success') return 'completed';
  if (run.conclusion === 'cancelled') return 'cancelled';
  return 'failed';
}

/** The state of one Modal picture job from CHE's own record. Modal gives the Worker no queued/rendering split. */
export function pictureJobLabel(record) {
  if (record.state === 'saved') return `completed and saved to Gallery as asset ${record.item?.id || 'unknown'}`;
  if (record.state === 'failed') return `failed: ${record.error || 'no reason recorded'}`;
  return 'running or queued on Modal (not finished; the Worker cannot tell which)';
}

// The GPU step of che-modal-check.yml. It is skipped on a connection-only run (gpu_test off), so only a step that ran is a GPU test.
const GPU_STEP = /^GPU test\b/;

/** One check run's GPU step: { ran, status, conclusion }. ran is false for a connection-only run. Null when GitHub does not answer. */
export async function gpuTestStep(env, runId, fetcher = fetch) {
  const r = await gh(env, 'GET', `/actions/runs/${runId}/jobs?per_page=10`, null, fetcher);
  if (!r.ok) return null;
  const step = (r.data?.jobs || []).flatMap((j) => j.steps || []).find((st) => GPU_STEP.test(st.name || ''));
  if (!step) return { ran: false, status: null, conclusion: null };
  // Not started yet: unknown, so the run is neither a GPU test nor a connection-only check yet.
  if (step.status === 'queued' || step.status === 'pending' || step.status === 'waiting') return { ran: null, status: step.status, conclusion: null };
  return { ran: step.conclusion !== 'skipped', status: step.status, conclusion: step.conclusion ?? null };
}

/** The newest runs of one workflow on main, newest first. Empty when GitHub does not answer (the caller says so). */
async function recentRuns(env, workflow, fetcher) {
  const r = await gh(env, 'GET', `/actions/workflows/${workflow}/runs?branch=main&per_page=5`, null, fetcher);
  if (!r.ok) return { known: false, runs: [], status: r.status || 0 };
  return { known: true, runs: r.data?.workflow_runs || [] };
}

/**
 * Starts the GPU check once. Refused when one was started in the last MODAL_CHECK_DEDUPE_MS, or when a check run is still
 * queued or running on GitHub. Nothing is started by a refusal.
 */
export async function startModalCheckOnce(env, storage, fetcher = fetch, now = Date.now()) {
  const last = await storage.get(MODAL_CHECK_DISPATCH_KEY).catch(() => undefined);
  if (last?.at && now - Date.parse(last.at) < MODAL_CHECK_DEDUPE_MS) {
    return { started: false, duplicate: true, detail: `A GPU check was already started at ${last.at}. I did not start another.` };
  }
  const list = await recentRuns(env, MODAL_CHECK_WORKFLOW, fetcher);
  if (!list.known) return { started: false, detail: `GitHub did not answer about the GPU check runs (${list.status || 'network'}), so I did not start one.` };
  const inFlight = list.runs.find((r) => r.status === 'queued' || r.status === 'in_progress' || r.status === 'waiting');
  if (inFlight) {
    return { started: false, duplicate: true, detail: `GPU check run ${inFlight.id} is already ${inFlight.status === 'in_progress' ? 'running' : 'queued'}. I did not start another.`, run_id: inFlight.id, html_url: inFlight.html_url || '' };
  }
  const sent = await dispatchModalRender(env, fetcher, now);
  if (!sent.ok) return { started: false, detail: sent.detail };
  await storage.put(MODAL_CHECK_DISPATCH_KEY, { at: sent.started_at });
  return { started: true, started_at: sent.started_at };
}

/**
 * The status of existing jobs, read only: the latest GPU check run, the latest deploy, the connection, and the Modal
 * picture jobs on record. It starts nothing, whatever the message says.
 */
export async function modalJobStatusReply(env, storage, { fetcher = fetch, now = Date.now() } = {}) {
  const lines = [];
  const steps = {};
  const at = new Date(now).toISOString();

  // The newest GPU test and the newest connection-only check, each from its own step. A connection-only run is never a GPU test.
  const checks = await recentRuns(env, MODAL_CHECK_WORKFLOW, fetcher);
  if (!checks.known) lines.push('GPU check: not read, because GitHub did not answer.');
  else if (!checks.runs.length) lines.push('GPU check: no run on record.');
  else {
    let gpuRun = null;
    let connectionRun = null;
    for (const run of checks.runs.slice(0, 3)) {
      const step = await gpuTestStep(env, run.id, fetcher);
      if (!step || step.ran === null) continue;
      if (step.ran && !gpuRun) gpuRun = { run, step };
      if (!step.ran && !connectionRun) connectionRun = { run };
      if (gpuRun && connectionRun) break;
    }
    if (gpuRun) {
      const { run } = gpuRun;
      steps.gpu_check = { run_id: run.id, status: run.status, conclusion: run.conclusion ?? null, html_url: run.html_url || '' };
      lines.push(`GPU check: run ${run.id} is ${checkRunLabel(run)}.${run.html_url ? ` ${run.html_url}` : ''}`);
    } else lines.push('GPU check: no GPU test on record (no check run ran the GPU step).');
    if (connectionRun) {
      const { run } = connectionRun;
      steps.connection_check = { run_id: run.id, status: run.status, conclusion: run.conclusion ?? null };
      lines.push(`Connection check: run ${run.id} is ${run.status === 'completed' ? (run.conclusion || 'completed') : run.status}, connection only (no GPU test ran).`);
    }
  }

  const deploys = await recentRuns(env, MODAL_DEPLOY_WORKFLOW, fetcher);
  if (!deploys.known) lines.push('Deployed: not read, because GitHub did not answer.');
  else if (!deploys.runs.length) lines.push('Deployed: no Modal deploy run on record.');
  else {
    const run = deploys.runs[0];
    const label = run.status !== 'completed' ? 'deploying' : run.conclusion === 'success' ? 'deployed' : 'deploy failed';
    steps.deploy = { run_id: run.id, status: run.status, conclusion: run.conclusion ?? null, html_url: run.html_url || '' };
    lines.push(`Deployed: ${label} (run ${run.id}).${run.html_url ? ` ${run.html_url}` : ''}`);
  }

  const cred = await modalCredential(env, storage);
  if (!cred.exists) lines.push('Connected: no Modal connection is saved in CHE.');
  else {
    const h = await modalHealth(cred.cred, fetcher);
    steps.health = { ok: h.ok, auth: h.auth, at };
    lines.push(h.ok === true ? `Connected: the authenticated health check passed just now (${at}).` : `Connected: no. The health check failed (${h.auth || 'unknown'}).`);
  }

  const records = ((await storage.get(MODAL_IMAGE_KEY).catch(() => undefined)) || []).filter((r) => r.call_id).slice(-3);
  if (!records.length) lines.push('Picture jobs: none on record.');
  for (const r of records) {
    steps.pictures = [...(steps.pictures || []), { call_id: r.call_id, state: r.state || 'started', asset_id: r.item?.id || null }];
    lines.push(`Picture job ${r.call_id} (${r.title || 'untitled'}): ${pictureJobLabel(r)}.`);
  }

  return { text: ['Status of the existing jobs. Nothing was started.', ...lines].join('\n'), steps, at };
}

/**
 * The reply for the Modal command, with a receipt for each step. `connected` is true only when the authenticated health
 * check passed in this turn. A GPU check is started only for a `new_render` ask, and only through startModalCheckOnce.
 */
export async function modalConnectReply(env, storage, intent, { fetcher = fetch, now = Date.now() } = {}) {
  const lines = [];
  const steps = {};
  const at = new Date(now).toISOString();

  // 1. Workflows.
  const wf = await modalWorkflowState(env, fetcher);
  steps.workflows = wf.known ? { check: wf.check, deploy: wf.deploy } : { blocked: wf.reason };
  if (!wf.known) lines.push(`Workflows: not checked. ${wf.reason}`);
  else if (!wf.check) lines.push(`Workflows: the GPU check workflow (${MODAL_CHECK_WORKFLOW}) is missing from the repository, so no GPU check can run.`);
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

  // 4. GPU check: only for an explicit new-run ask, once.
  if (intent.kind === 'new_render') {
    if (!wf.known || !wf.check) {
      steps.gpu_check = { started: false, blocked: wf.known ? 'the check workflow is missing' : wf.reason };
      lines.push(`GPU check: not started. ${steps.gpu_check.blocked}`);
    } else {
      const sent = await startModalCheckOnce(env, storage, fetcher, now);
      if (!sent.started) {
        steps.gpu_check = { started: false, duplicate: sent.duplicate === true, run_id: sent.run_id ?? null, blocked: sent.detail };
        lines.push(`GPU check: not started. ${sent.detail}${sent.html_url ? ` ${sent.html_url}` : ''}`);
      } else {
        const run = await modalRenderRun(env, sent.started_at, fetcher);
        steps.gpu_check = { started: true, ...run };
        const url = run.html_url ? ` ${run.html_url}` : '';
        if (run.state === 'passed') lines.push(`GPU check: completed (run ${run.run_id}).${url}`);
        else if (run.state === 'failed') lines.push(`GPU check: failed (run ${run.run_id}, ${run.conclusion}).${url} Open the run for the failed step.`);
        else if (run.state === 'running') lines.push(`GPU check: running (run ${run.run_id}).${url} It is not finished yet.`);
        else lines.push(`GPU check: queued on main at ${sent.started_at}. The run has not appeared yet. Actions: https://github.com/${env.CHE_GITHUB_REPO}/actions/workflows/${MODAL_CHECK_WORKFLOW}`);
      }
    }
  }

  const headline = connected
    ? 'Modal is connected: the authenticated health check passed in this turn.'
    : 'Modal is not connected yet: the authenticated health check did not pass, so I do not claim it.';
  return { text: [headline, ...lines].join('\n'), connected, steps, at };
}

/** The chat response for the Modal command: its report, its source and its receipt. Only a new_render ask can start work. */
export async function modalServiceReply(env, storage, intent, ndjsonReply) {
  if (intent.kind === 'job_status') {
    const status = await modalJobStatusReply(env, storage);
    return ndjsonReply(status.text, { source: 'che_modal_status', ok: true, model_calls: 0, steps: status.steps });
  }
  const reply = await modalConnectReply(env, storage, intent);
  return ndjsonReply(reply.text, { source: 'che_modal_connect', ok: reply.connected, model_calls: 0, steps: reply.steps });
}

/**
 * The explicit service command that runs before the GitHub and deployment matchers: a Modal ask ({kind:'modal'}),
 * or a connect command for any provider ({kind:'connect'}, the guided connect flow). Null for everything else.
 */
export function serviceCommandIntent(message) {
  const modal = modalServiceIntent(message);
  if (modal) return { kind: 'modal', intent: modal };
  const onboard = onboardingIntent(message);
  return onboard?.kind === 'connect' ? { kind: 'connect', onboard } : null;
}
