// CHE's Cloud Computer Manager (owner, 2026-10-24): ONE view and one set of controls over the compute CHE already
// has. It adds no second job queue, router or agent system:
//  - every job lives in the existing Durable Object job queue (`data.jobs`, worker.js enqueueJob/processJobs) as kind
//    `cloud_task`, or is read from an existing record (OpenCode coding stamps, the REA log, video/edit renders in the
//    media index, the Film Studio index, the app-build record);
//  - every start goes through an EXISTING starter (queueSelfDevelopment, handleReaRequest, the GitHub video renderer,
//    dispatchAppBuild) or through gh() from coding_runtime.js for one allowlisted workflow (flutter-check.yml);
//  - chat reaches it only through the command catalog (command_catalog.js `cloud-*` entries).
// Chat text never becomes a shell command: a job is one of TEMPLATES, with typed parameters.
//
// Providers are modular: each declares its capabilities, cost tier, billing state, whether it needs approval, and an
// availability check. Selection is deterministic: the cheapest capable provider. A provider whose billing is not
// verified, an outside service, or a paid tier needs an approval record on the job before anything is dispatched, and
// the runner refuses an unapproved job in execution code, not only in words. Nothing here is ever auto-run on a paid
// tier: EXTERNAL_PAID providers are refused outright.
import { cancelQueuedJob } from './coding_cancel.js';
import { codingRuntimeEnabled, gh } from './coding_runtime.js';
import { APP_BUILD_KEY, APP_BUILD_WORKFLOWS, dispatchAppBuild } from './app_builds.js';
import { REA_JOBS_KEY } from './rea_runner.js';
import { FILM_INDEX_KEY } from './film_studio.js';
import { EXECUTION, EXECUTION_ORDER } from './capability_registry.js';
import { noteJobActivity } from './job_activity.js';
import { LA_AGENCIA_ROLES } from './office_company.js';
import { mp4Facts } from './github_video_renderer.js';
import { sha256Hex } from './che_media_store.js';
import { CREATION_PROVIDERS } from './creation_orchestrator.js';
import { GpuQueue } from './gpu_queue.js';

export const CLOUD_SOURCE = 'che_cloud_computer';
export const CLOUD_JOB_KIND = 'cloud_task';
export const TESTS_WORKFLOW = 'flutter-check.yml';
const VIDEO_DISPATCHED_PREFIX = 'che_video_dispatched:';
const MEDIA_INDEX_KEY = 'media_index';
const LEDGER_LIMIT = 120;
const POLL_MS = 120_000;
const NEVER_STARTED_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 60 * 60_000;
export const FILE_INSPECT_MAX_BYTES = 512 * 1024;

// What the GitHub-hosted runners cost is NOT verified from this Worker: GitHub-hosted minutes are free for public
// repositories, while a private repository spends the account's included minutes and can bill past them. CHE has not
// read the repository's visibility or the account's billing, so every NEW dispatch on these runners needs the owner's
// approval first. Paths that already dispatch them under the owner's existing rules (coding jobs, REA browser runs,
// video renders, app builds) keep their own gates and are handed off unchanged.
const GITHUB_BILLING = 'requires_verified_free_usage';
const GITHUB_APPROVAL = 'This runs on GitHub Actions, and I have not verified that its minutes are free for this repository: they are free for a public repository, and a private one spends the account\'s included minutes and can be billed past them.';

// ─── Providers ───────────────────────────────────────────────────────────────
// Capabilities are read from the workflow steps (cited in `evidence`), so a tool is listed only when a step installs
// or uses it. Blender comes from the Creation Engine's own providers (creation_orchestrator.js CREATION_PROVIDERS),
// listed here as they are, so CHE has one registry of cloud computers: the free GitHub CPU Blender worker, which the
// Creation Engine starts itself after verifying the repository is public, and the owner's Colab T4 notebook.
export const CAPABILITIES = Object.freeze(['api', 'document', 'file', 'research', 'tests', 'coding', 'browser', 'ffmpeg', 'video_render', 'ios_build', 'gpu', 'blender']);

export const PROVIDERS = Object.freeze([
  {
    id: 'worker_internal', label: 'CHE Worker (Cloudflare)', tier: EXECUTION.INTERNAL, runner: 'Cloudflare Worker and Durable Object',
    software: ['Workers AI', 'internal renderer (internal_renderer.js, pure JavaScript)', 'job queue (worker.js enqueueJob and processJobs)', 'Durable Object storage', 'SHA-256 and MP4 box reader'],
    capabilities: ['api', 'document', 'file', 'research'], cost: 'included', billing: 'existing Worker; no new charge', needs_approval: false,
    evidence: ['server/cloudflare/worker.js', 'server/cloudflare/internal_renderer.js'],
    limits: 'No shell, no GPU, no ffmpeg, no browser; Worker CPU and memory limits apply.',
  },
  {
    id: 'github_ubuntu', label: 'GitHub runner (ubuntu-latest)', tier: EXECUTION.OWNER_COMPUTE, runner: 'GitHub-hosted ubuntu-latest',
    software: ['Node 22', 'Python', 'Flutter (flutter-check.yml)', 'ffmpeg and ffprobe', 'piper-tts and espeak-ng', 'Pillow', 'opencode-ai'],
    capabilities: ['tests', 'coding', 'ffmpeg', 'file', 'video_render'], cost: 'unverified', billing: GITHUB_BILLING, needs_approval: true, approval_reason: GITHUB_APPROVAL,
    evidence: ['.github/workflows/flutter-check.yml', '.github/workflows/che-opencode-runtime.yml', '.github/workflows/che-video-render.yml', '.github/workflows/che-edit-render.yml', '.github/workflows/che-film-render.yml'],
    limits: 'CPU only (no GPU). Time limits are set per workflow (flutter-check.yml: 20 minutes per job).',
  },
  {
    id: 'browser_isolated', label: 'Isolated browser (che-rea-web)', tier: EXECUTION.OWNER_COMPUTE, runner: 'GitHub-hosted ubuntu-latest with Playwright Chromium; no sign-in, no form submitted',
    software: ['Playwright 1.56.1', 'Chromium headless shell'],
    capabilities: ['browser'], cost: 'unverified', billing: GITHUB_BILLING, needs_approval: true, approval_reason: GITHUB_APPROVAL,
    evidence: ['.github/workflows/che-rea-web.yml', 'server/cloudflare/rea_runner.js'],
    limits: 'Public pages only; hosts the runner network blocks cannot be opened.',
  },
  {
    id: 'github_macos', label: 'GitHub runner (macOS)', tier: EXECUTION.OWNER_COMPUTE, runner: 'GitHub-hosted macOS',
    software: ['Xcode', 'Flutter', 'Shorebird (only with SHOREBIRD_TOKEN)'],
    capabilities: ['ios_build'], cost: 'unverified', billing: GITHUB_BILLING, needs_approval: true, approval_reason: 'An app build changes what is on your phone, and macOS minutes are not verified as free for this repository.',
    evidence: ['.github/workflows/che-iphone-ipa.yml', '.github/workflows/che-shorebird.yml'],
    limits: 'macOS minutes count ten times on private repositories.',
  },
  {
    // agent_runtime.js runComputerWorkspace: an Office agent task with use_computer and owner_approved_computer posts
    // to this endpoint. Its software is whatever the owner's endpoint runs; CHE is never told, so it declares none
    // and selection never picks it for a template.
    id: 'owner_computer', label: 'Persistent cloud computer (CHE_COMPUTER_URL)', tier: EXECUTION.OWNER_COMPUTE, runner: 'the owner\'s own HTTPS endpoint',
    software: [], capabilities: [], cost: 'unknown', billing: 'the owner\'s own endpoint; its cost is not known to CHE', needs_approval: true,
    approval_reason: 'Each Office task that uses this computer needs your approval (agent_runtime.js).',
    evidence: ['server/cloudflare/agent_runtime.js'],
    limits: 'Only Office agent tasks with your approval use it; what it can run is not reported to CHE.',
  },
  {
    id: 'film_farm', label: 'Film farm (Kaggle or Hugging Face GPU)', tier: EXECUTION.EXTERNAL_FREE, runner: 'Kaggle kernel or Hugging Face Space started by film_farm.js',
    software: ['GPU render worker (film_farm.js KAGGLE_WORKER_PY)'],
    capabilities: ['gpu'], cost: 'free outside service', billing: 'free tier of an outside service; quotas apply', needs_approval: true, approval_reason: 'This uses an outside service, so it needs your approval for that dependency.',
    evidence: ['server/cloudflare/film_farm.js'],
    limits: 'Outside free quotas; never verified from this Worker.',
  },
  ...CREATION_PROVIDERS.map(({ automatic, manual_step, device, ...p }) => p),
]);

// Capabilities no provider has, with the smallest addition that would add them. Permanent rule: first check the
// resources CHE already has, then explain the smallest addition; never pretend.
export const MISSING = Object.freeze({
  blender: {
    reason: 'Blender builds 3D models automatically: Create, then Generate, queues the job and the Creation Engine starts che-creation-worker.yml on a free GitHub-hosted CPU runner (this repository is public). No workflow renders a Blender animation to MP4 yet.',
    existing: 'che-creation-worker.yml already installs Blender (bpy) on a GitHub CPU runner for Create Person jobs, and tools/character_pipeline/build_che_character.py drives Blender through its Python module (bpy==5.0.1 on Python 3.11).',
    smallest_addition: 'Add an animation-to-MP4 job beside che-creation-worker.yml, which already installs Blender: render the frames on the CPU (no GPU there), then encode the MP4 with ffmpeg. It is a pull request for your review; GitHub-hosted runners are free while this repository stays public.',
  },
  gpu: {
    reason: 'No GPU is attached to the Worker or to the GitHub-hosted runners.',
    existing: 'film_farm.js can start a Kaggle or Hugging Face GPU worker when one of their tokens is saved.',
    smallest_addition: 'A free Kaggle or Hugging Face token saved on the Worker, and your approval for that outside service.',
  },
});

// ─── Allowlisted job templates ───────────────────────────────────────────────
// `run`: queue = a cloud_task job in the Durable Object queue; inline = finished inside the request (Worker only);
// handoff = an existing starter that keeps its own record and gates. Nothing else can run.
export const TEMPLATES = Object.freeze({
  repo_tests: { label: 'Repository tests (flutter analyze and flutter test)', requires: ['tests'], run: 'queue', agent: 'Vale', tools: ['flutter-check.yml', 'Flutter', 'dart analyze'] },
  coding: { label: 'Coding job (draft pull request)', requires: ['coding'], run: 'handoff', existing_path: 'queueSelfDevelopment', agent: 'Atlas', tools: ['coding team', 'che-opencode-runtime.yml'] },
  browser: { label: 'Browser inspection (REA)', requires: ['browser'], run: 'handoff', existing_path: 'handleReaRequest', agent: 'Mira', tools: ['Playwright', 'Chromium'] },
  research: { label: 'Research (REA)', requires: ['research'], run: 'handoff', existing_path: 'handleReaRequest', agent: 'Mira', tools: ['Worker fetch', 'REA'] },
  video_render: { label: 'Video render', requires: ['video_render'], run: 'handoff', existing_path: 'startGithubVideo', agent: 'Lyra', tools: ['che-video-render.yml', 'ffmpeg', 'piper-tts'] },
  file_processing: { label: 'File inspection (size, SHA-256, type, MP4 facts)', requires: ['file'], run: 'inline', agent: 'CHE', tools: ['SHA-256', 'MP4 box reader'] },
  media_transcode: { label: 'Media transcode', requires: ['ffmpeg', 'file'], run: 'none', agent: 'Lyra', tools: ['ffmpeg'],
    no_starter: 'ffmpeg is on the GitHub runner, but no workflow takes an arbitrary file to transcode. The Creation Room edit render (che-edit-render.yml) edits media CHE already stored.' },
  blender_model: { label: 'Blender 3D model (Create, then Generate)', requires: ['blender'], run: 'handoff', existing_path: 'CreationStudio.generate', agent: 'Lyra', tools: ['che-creation-worker.yml', 'Blender', 'MPFB2'] },
  blender_render: { label: 'Blender animation to MP4', requires: ['blender', 'ffmpeg'], run: 'none', agent: 'Lyra', tools: ['Blender', 'ffmpeg'] },
  gpu_animation: { label: 'GPU animation', requires: ['gpu'], run: 'none', agent: 'Lyra', tools: ['GPU'],
    no_starter: 'Film Studio starts the film farm itself; say "make a film about …" there.' },
  ios_build: { label: 'iPhone app build', requires: ['ios_build'], run: 'handoff', existing_path: 'dispatchAppBuild', agent: 'CHE', tools: ['Xcode', 'Flutter'] },
  ios_patch: { label: 'iPhone app patch (Shorebird)', requires: ['ios_build'], run: 'handoff', existing_path: 'dispatchAppBuild', agent: 'CHE', tools: ['Xcode', 'Flutter', 'Shorebird'] },
});
export const TASK_KINDS = Object.freeze(Object.keys(TEMPLATES));

const provider = (id) => PROVIDERS.find((p) => p.id === id);
const hasGithub = (env = {}) => Boolean(env?.CHE_GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(String(env?.CHE_GITHUB_REPO || '')));
const farmKeysOf = (env = {}) => ({ kaggle: Boolean(env?.KAGGLE_KEY || env?.KAGGLE_API_TOKEN || env?.CHE_KAGGLE_KEY), hf: Boolean(env?.HF_TOKEN || env?.CHE_HF_TOKEN) });
const TIER_RANK = Object.fromEntries(EXECUTION_ORDER.map((t, i) => [t, i]));
const short = (id) => String(id || '').slice(0, 8);

/** Availability check for one provider. `runs` ({workflowFile: {conclusion, html_url, updated_at}}) is optional. */
export function checkProvider(p, env = {}, { runs = null } = {}) {
  if (p.tier === EXECUTION.EXTERNAL_PAID) return { status: 'refused', detail: 'Paid providers are never used by the Cloud Computer.' };
  if (p.id === 'worker_internal') return { status: 'operational', verified_by: 'this Worker is answering' };
  if (p.id === 'owner_computer') {
    return String(env?.CHE_COMPUTER_URL || '').trim()
      ? { status: 'unverified', detail: 'CHE_COMPUTER_URL is set; the Cloud Computer has not checked it.' }
      : { status: 'needs_setup', detail: 'CHE_COMPUTER_URL is not set, so Office agents have no persistent computer.' };
  }
  if (p.id === 'film_farm') {
    const keys = farmKeysOf(env);
    return keys.kaggle || keys.hf
      ? { status: 'unverified', detail: 'A token is saved; a GPU session has not been verified from this Worker.' }
      : { status: 'needs_setup', detail: 'No Kaggle or Hugging Face token is saved on the Worker.' };
  }
  if (p.id === 'colab_t4') return { status: 'unverified', detail: 'Online only while your Colab notebook runs; the Creation Engine shows its last heartbeat.' };
  if (!hasGithub(env)) return { status: 'needs_setup', detail: 'CHE_GITHUB_TOKEN and CHE_GITHUB_REPO are not set on the Worker, so CHE cannot start or read workflow runs.' };
  const files = p.evidence.filter((f) => f.endsWith('.yml')).map((f) => f.replace('.github/workflows/', ''));
  const last = files.map((f) => runs?.[f]).find((r) => r && r.conclusion === 'success');
  if (last) return { status: 'operational', verified_by: `last successful run ${last.updated_at || ''} ${last.html_url || ''}`.trim() };
  return { status: 'unverified', detail: 'GitHub is connected; no successful run was read in this check.' };
}

/** Each provider with its live status. Offline: reads only the Worker's own configuration. */
export function providerStatuses(env = {}, opts = {}) {
  return PROVIDERS.map((p) => {
    const live = checkProvider(p, env, opts);
    return {
      id: p.id, label: p.label, tier: p.tier, runner: p.runner, software: p.software, capabilities: p.capabilities, cost: p.cost, billing: p.billing,
      needs_approval: p.needs_approval, limits: p.limits, evidence: p.evidence, status: live.status, verified_by: live.verified_by || '', detail: live.detail || '',
    };
  });
}

/**
 * Deterministic: the cheapest provider that has every capability the template needs, or an honest block naming the
 * missing capability, what CHE already has toward it and the smallest addition that would unblock it.
 */
export function selectProvider(kind, { env = {}, statuses = null } = {}) {
  const k = String(kind || '').trim();
  const t = TEMPLATES[k];
  if (!t) return { blocked: true, kind: k, reason: `"${k}" is not one of my job templates, and I never run commands typed in chat.`, smallest_addition: `Use one of: ${TASK_KINDS.join(', ')}.` };
  const missing = t.requires.find((cap) => !PROVIDERS.some((p) => p.capabilities.includes(cap)));
  if (missing) {
    const m = MISSING[missing] || { reason: `No provider has ${missing}.`, existing: '', smallest_addition: 'A workflow change (pull request) that installs it on a GitHub-hosted runner.' };
    return { blocked: true, kind: k, missing_capability: missing, reason: m.reason, existing: m.existing, smallest_addition: m.smallest_addition };
  }
  const list = statuses || providerStatuses(env);
  const capable = PROVIDERS
    .filter((p) => p.tier !== EXECUTION.EXTERNAL_PAID && t.requires.every((cap) => p.capabilities.includes(cap)))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  if (!capable.length) {
    // Each capability exists somewhere, but not together on one runner (Blender + ffmpeg): name the known gap.
    const gap = t.requires.find((cap) => MISSING[cap]);
    if (gap) return { blocked: true, kind: k, missing_capability: gap, reason: MISSING[gap].reason, existing: MISSING[gap].existing, smallest_addition: MISSING[gap].smallest_addition };
    return { blocked: true, kind: k, reason: `No single provider has all of ${t.requires.join(', ')}.`, smallest_addition: 'A workflow change (pull request) adding the missing software to one runner.' };
  }
  const chosen = capable[0];
  const live = list.find((s) => s.id === chosen.id) || {};
  if (live.status === 'needs_setup') {
    return { blocked: true, kind: k, provider: chosen.id, reason: live.detail || `${chosen.label} is not set up.`,
      smallest_addition: chosen.id === 'film_farm' ? MISSING.gpu.smallest_addition : 'CHE_GITHUB_TOKEN and CHE_GITHUB_REPO saved on the Worker.' };
  }
  // An existing path keeps its own gates; a NEW dispatch on an unverified-billing or outside provider needs approval.
  const approval = !t.existing_path && chosen.needs_approval;
  return {
    blocked: false, kind: k, template: t.label, provider: chosen.id, label: chosen.label, tier: chosen.tier, cost: chosen.cost, billing: chosen.billing,
    status: live.status || 'unverified', run: t.run, existing_path: t.existing_path || '', no_starter: t.no_starter || '',
    approval_required: approval || ['ios_build', 'ios_patch'].includes(k),
    approval_reason: ['ios_build', 'ios_patch'].includes(k) ? provider('github_macos').approval_reason : approval ? chosen.approval_reason : '',
    tools: t.tools, alternatives: capable.slice(1).map((p) => p.id),
  };
}

// ─── Plain-language errors ───────────────────────────────────────────────────
/** What a GitHub answer means, in words the owner can act on. */
export function explainGithubError(status, message = '') {
  const m = String(message || '').slice(0, 160);
  if (!status) return 'I could not reach GitHub from the Worker (network error). Nothing ran.';
  if (status === 401) return 'GitHub refused CHE\'s token: it is missing, expired or revoked. A new CHE_GITHUB_TOKEN fixes it.';
  if (status === 403) return `GitHub refused the request: the token lacks the Actions permission, or Actions are disabled or blocked for the account${m ? ` (${m})` : ''}.`;
  if (status === 404) return 'GitHub could not find the repository or the workflow file. CHE_GITHUB_REPO may be wrong, or the token cannot see the repository.';
  if (status === 422) return `GitHub rejected the run: the workflow cannot be started on that branch${m ? ` (${m})` : ''}.`;
  if (status === 503) return 'GitHub is not configured on the Worker (CHE_GITHUB_TOKEN and CHE_GITHUB_REPO).';
  if (status >= 500) return `GitHub had a server error (${status}). It is temporary; retrying later usually works.`;
  return `GitHub answered ${status}${m ? `: ${m}` : ''}.`;
}

// ─── Agents request work here ────────────────────────────────────────────────
const AGENTS = new Set(['CHE', ...Object.keys(LA_AGENCIA_ROLES)]);

/**
 * The one entry point for agents and the owner: request a job on the Cloud Computer. `enqueue` is worker.js enqueueJob.
 * Returns { ok, job?, plan, needs_approval?, blocked?, handoff? }. It never dispatches anything itself: a queued job
 * runs in processJobs, a job needing approval waits for approveCloudJob, and a handoff kind is started by the caller
 * through its existing starter (startCloudTask).
 */
export function requestCloudWork(data, { agent = 'CHE', kind = '', params = {}, title = '' } = {}, { env = {}, enqueue } = {}) {
  const who = AGENTS.has(String(agent)) ? String(agent) : null;
  if (!who) return { ok: false, reason: `"${String(agent).slice(0, 40)}" is not on CHE's roster, so it cannot request cloud work.` };
  const plan = selectProvider(kind, { env });
  if (plan.blocked) return { ok: false, blocked: true, plan };
  if (plan.run === 'none') return { ok: false, plan, reason: plan.no_starter || `${plan.template} has no starter on the Cloud Computer yet.` };
  if (plan.run === 'handoff') return { ok: true, handoff: true, plan };
  if (typeof enqueue !== 'function') return { ok: false, plan, reason: 'The job queue is not wired in this context.' };
  if (plan.approval_required) {
    const waiting = (data.jobs || []).find((j) => j.kind === CLOUD_JOB_KIND && j.cloud_kind === plan.kind && j.status === 'awaiting_approval');
    if (waiting) return { ok: true, job: waiting, plan, needs_approval: true, deduplicated: true };
  }
  const now = new Date().toISOString();
  const { job, deduplicated } = enqueue(data, {
    kind: CLOUD_JOB_KIND, cloud_kind: plan.kind, title: String(title || plan.template).slice(0, 100), prompt: `${plan.kind} on ${plan.provider}`,
    idempotency_key: `cloud:${plan.kind}:${now}`, requesting_agent: who, environment: plan.provider, tools: plan.tools,
    params: sanitizeParams(plan.kind, params), cloud: { phase: 'requested', log: [] },
    approval: { required: plan.approval_required, reason: plan.approval_reason, requested_at: now, approved_at: null, approved_via: '' },
  });
  if (!deduplicated && plan.approval_required) {
    job.status = 'awaiting_approval';
    noteJobActivity(job, `Requested by ${who}; waiting for the owner's approval before anything is dispatched.`);
  } else if (!deduplicated) noteJobActivity(job, `Requested by ${who}; queued on ${plan.label}.`);
  return { ok: true, job, plan, needs_approval: plan.approval_required, deduplicated };
}

// Template parameters are typed and bounded; nothing from chat reaches a shell.
function sanitizeParams(kind, params = {}) {
  if (kind === 'repo_tests') return { ref: 'main' };
  return {};
}

// ─── Controls (the state machine) ────────────────────────────────────────────
// awaiting_approval --approve--> queued --processJobs--> running --dispatch--> queued (waiting on GitHub)
//   --poll--> running --> complete | failed.  queued/awaiting_approval --cancel--> cancelled.
//   dispatched run --stop--> GitHub cancel --> cancelled.  failed | cancelled --retry--> a new job (approved by the retry).
const findJob = (data, id) => {
  const want = String(id || '').trim().toLowerCase();
  if (!want) return null;
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.find((j) => j.id === want) || (want.length >= 6 ? jobs.find((j) => String(j.id).startsWith(want)) : null) || null;
};

/** The newest cloud job in one of `states`, for "approve the cloud job" with no id. */
export function latestCloudJob(data, states) {
  return (Array.isArray(data?.jobs) ? data.jobs : []).find((j) => j.kind === CLOUD_JOB_KIND && states.includes(j.status)) || null;
}

export function approveCloudJob(data, id, { via = 'owner' } = {}) {
  const job = findJob(data, id);
  if (!job || job.kind !== CLOUD_JOB_KIND) return { ok: false, reason: 'That is not a Cloud Computer job waiting for approval. Nothing was approved.' };
  if (job.status !== 'awaiting_approval') return { ok: false, job, reason: `Cloud job ${short(job.id)} is ${statusWords(job.status)}, not waiting for approval. Nothing changed.` };
  const at = new Date().toISOString();
  job.approval = { ...(job.approval || {}), approved_at: at, approved_via: via };
  job.status = 'queued';
  job.retry_at = 0;
  job.updated_at = at;
  noteJobActivity(job, 'Approved by the owner; queued to dispatch.');
  return { ok: true, job };
}

/** Cancel a job that has not been dispatched. A dispatched run is stopped with stopCloudJob instead. */
export function cancelCloudJob(data, id) {
  const job = findJob(data, id);
  if (!job) return { ok: false, changed: false, reason: 'That job is not in my Worker queue, so I cannot cancel it from here. Runs already on GitHub finish or fail on their own.' };
  if (job.kind === CLOUD_JOB_KIND && job.cloud?.dispatched_at && !['complete', 'failed', 'cancelled'].includes(job.status)) {
    return { ok: false, changed: false, job, reason: `Cloud job ${short(job.id)} is already on GitHub, so cancelling it means stopping the run. Say "stop cloud job ${short(job.id)}".` };
  }
  if (job.status === 'awaiting_approval') {
    const at = new Date().toISOString();
    Object.assign(job, { status: 'cancelled', updated_at: at, cancelled_at: at, cancelled_by: 'owner', cancelled_via: 'cloud_computer' });
    noteJobActivity(job, 'Cancelled by the owner before it was approved. Nothing was dispatched.');
    return { ok: true, changed: true, job };
  }
  if (job.status !== 'queued') return { ok: false, changed: false, job, reason: `Job ${short(job.id)} is ${statusWords(job.status)}, not queued, so I did not cancel it. I can only cancel a job that has not started.` };
  const changed = cancelQueuedJob(job, { via: 'cloud_computer' });
  return { ok: changed, changed, job };
}

/** Stop a dispatched GitHub run through gh() (POST /actions/runs/{id}/cancel), then mark the job cancelled. */
export async function stopCloudJob(data, id, { env = {}, fetcher = fetch } = {}) {
  const job = findJob(data, id);
  if (!job || job.kind !== CLOUD_JOB_KIND) return { ok: false, reason: 'That is not a Cloud Computer job, so I cannot stop it from here. Nothing changed.' };
  if (['complete', 'failed', 'cancelled'].includes(job.status)) return { ok: false, job, reason: `Cloud job ${short(job.id)} already ${statusWords(job.status)}. Nothing to stop.` };
  if (!job.cloud?.dispatched_at) {
    const out = cancelCloudJob(data, job.id);
    return { ...out, stopped: false };
  }
  const runId = job.cloud.run_id || null;
  if (!runId) return { ok: false, job, reason: `GitHub has not shown the run for cloud job ${short(job.id)} yet, so there is nothing I can stop. I will see it on the next check.` };
  const res = await gh(env, 'POST', `/actions/runs/${runId}/cancel`, null, fetcher);
  if (!(res.ok || res.status === 202)) return { ok: false, job, reason: `${explainGithubError(res.status, res.data?.message)} The run was not stopped.` };
  const at = new Date().toISOString();
  Object.assign(job, { status: 'cancelled', updated_at: at, cancelled_at: at, cancelled_by: 'owner', cancelled_via: 'cloud_stop' });
  job.cloud = { ...job.cloud, phase: 'stopped' };
  noteJobActivity(job, `Stopped by the owner: GitHub accepted the cancel for run ${runId}.`);
  return { ok: true, stopped: true, job };
}

/** Retry a failed or cancelled job as a new job. The owner's retry is his approval for that new dispatch. */
export function retryCloudJob(data, id, enqueue) {
  const job = findJob(data, id);
  if (!job) return { ok: false, reason: 'That job is not in my Worker queue, so I cannot retry it from here.' };
  if (!(['failed', 'cancelled'].includes(job.status) || job.dead_letter)) return { ok: false, job, reason: `Job ${short(job.id)} is ${statusWords(job.status)}; only a failed or cancelled job can be retried.` };
  const fields = { ...job };
  for (const k of ['id', 'status', 'attempts', 'retry_count', 'retry_at', 'result', 'error', 'dead_letter', 'dead_letter_at', 'created_at', 'updated_at', 'activity', 'cancelled_at', 'cancelled_by', 'cancelled_via', 'started_at', 'owner_message', 'failure_class', 'verification', 'checkpoint']) delete fields[k];
  fields.idempotency_key = `retry:${job.id}:${Date.now()}`;
  fields.retried_from = job.id;
  if (job.kind === CLOUD_JOB_KIND) {
    fields.cloud = { phase: 'requested', log: [] };
    fields.approval = { ...(job.approval || {}), approved_at: new Date().toISOString(), approved_via: 'owner_retry' };
  }
  const { job: next } = enqueue(data, fields);
  noteJobActivity(next, `Retry of job ${short(job.id)} requested by the owner from the Cloud Computer.`);
  return { ok: true, job: next };
}

// ─── The runner (called by processJobs for kind cloud_task) ──────────────────
const logLine = (job, text) => [...(Array.isArray(job.cloud?.log) ? job.cloud.log : []), `${new Date().toISOString().slice(11, 19)} ${text}`].slice(-12);

/**
 * One step of a cloud_task job. Returns a processJobs outcome; `cloud` is merged into job.cloud. An unapproved job is
 * refused here, in execution code, whatever the record says elsewhere.
 */
export async function runCloudTask(job, { env = {}, fetcher = fetch, now = Date.now() } = {}) {
  const fail = (error, extra = {}) => ({ id: job.id, status: 'failed', result: '', error, cloud: { ...(extra.cloud || {}), log: logLine(job, error) }, owner_message: error });
  if (job.approval?.required && !job.approval?.approved_at) return fail('This job was never approved, so nothing was dispatched.');
  const plan = selectProvider(job.cloud_kind, { env });
  if (plan.blocked) return fail(`${plan.reason} Smallest addition: ${plan.smallest_addition}`);
  if (job.cloud_kind !== 'repo_tests') return fail(`${plan.template} does not run from the job queue.`);
  const cloud = job.cloud || {};
  if (!cloud.dispatched_at) {
    const at = new Date(now).toISOString();
    // GitHub answers a dispatch with 204 and no run id. This dispatch carries its own id, which flutter-check.yml puts
    // in the run's title (run-name), so the run is found by that title alone; a concurrent dispatch never matches.
    const dispatchId = testsDispatchId(job.id, now);
    const sent = await gh(env, 'POST', `/actions/workflows/${TESTS_WORKFLOW}/dispatches`, { ref: 'main', inputs: { che_dispatch_id: dispatchId } }, fetcher);
    if (!(sent.status === 204 || sent.ok)) return fail(explainGithubError(sent.status, sent.data?.message), { cloud: { phase: 'dispatch_failed' } });
    const run = await findDispatchedRun(env, { dispatchId }, fetcher);
    const note = run ? `Dispatched ${TESTS_WORKFLOW}; GitHub run ${run.id}.` : `Dispatched ${TESTS_WORKFLOW}; GitHub accepted it (204) and the run id is not visible yet.`;
    return {
      id: job.id, status: 'queued', attempts: 0, retry_at: now + POLL_MS, result: '', error: '',
      cloud: { phase: 'dispatched', started_at: at, dispatched_at: at, dispatch_id: dispatchId, run_id: run?.id || null, html_url: run?.html_url || '', log: logLine(job, note) },
    };
  }
  let runId = cloud.run_id;
  let htmlUrl = cloud.html_url || '';
  if (!runId) {
    const run = await findDispatchedRun(env, { dispatchId: cloud.dispatch_id, at: cloud.dispatched_at, known: cloud.known_run_ids }, fetcher);
    if (!run) {
      if (now - Date.parse(cloud.dispatched_at) > NEVER_STARTED_MS) return fail('GitHub never started the test run: no run appeared 15 minutes after the dispatch. Nothing was tested.', { cloud: { phase: 'never_started' } });
      return { id: job.id, status: 'queued', attempts: 0, retry_at: now + POLL_MS, result: '', error: '', cloud: { phase: 'waiting_for_runner', log: logLine(job, 'Waiting for GitHub to show the run.') } };
    }
    runId = run.id; htmlUrl = run.html_url || '';
  }
  const res = await gh(env, 'GET', `/actions/runs/${runId}`, null, fetcher);
  if (!res.ok) {
    if (res.status >= 500 || !res.status) return { id: job.id, status: 'queued', attempts: 0, retry_at: now + POLL_MS, result: '', error: '', cloud: { run_id: runId, html_url: htmlUrl, log: logLine(job, explainGithubError(res.status)) } };
    return fail(explainGithubError(res.status, res.data?.message), { cloud: { run_id: runId, html_url: htmlUrl } });
  }
  const run = res.data || {};
  htmlUrl = run.html_url || htmlUrl;
  if (run.status !== 'completed') {
    if (now - Date.parse(cloud.dispatched_at) > RUN_TIMEOUT_MS) return fail('The test run did not finish within 60 minutes, so I am not calling it passed. Stop it or wait for GitHub.', { cloud: { run_id: runId, html_url: htmlUrl, phase: 'timed_out' } });
    return { id: job.id, status: 'queued', attempts: 0, retry_at: now + POLL_MS, result: '', error: '', cloud: { run_id: runId, html_url: htmlUrl, phase: String(run.status || 'queued'), log: logLine(job, `GitHub run ${runId} is ${String(run.status || 'queued').replace(/_/g, ' ')}.`) } };
  }
  if (run.conclusion === 'success') {
    const text = `The repository tests passed: GitHub run ${runId} of ${TESTS_WORKFLOW} finished with success.`;
    return { id: job.id, status: 'complete', result: text, error: '', verification: 'run conclusion "success" read from GitHub', owner_message: text,
      cloud: { run_id: runId, html_url: htmlUrl, phase: 'completed', finished_at: new Date(now).toISOString(), outputs: [{ kind: 'url', url: htmlUrl, label: `GitHub run ${runId}` }], log: logLine(job, 'Finished: success.') } };
  }
  const steps = await failedSteps(env, runId, fetcher);
  const why = run.conclusion === 'cancelled' ? 'was cancelled on GitHub' : run.conclusion === 'timed_out' ? 'hit its time limit on GitHub' : `finished with "${run.conclusion || 'unknown'}"`;
  return fail(`The repository tests did not pass: GitHub run ${runId} ${why}${steps.length ? `; failed steps: ${steps.join(', ')}` : ''}.`, {
    cloud: { run_id: runId, html_url: htmlUrl, phase: 'completed', finished_at: new Date(now).toISOString(), failed_steps: steps, outputs: htmlUrl ? [{ kind: 'url', url: htmlUrl, label: `GitHub run ${runId}` }] : [] },
  });
}

/** The workflow's recent dispatch runs, newest first as GitHub lists them; null when GitHub did not answer. */
async function listDispatchRuns(env, fetcher) {
  const runs = await gh(env, 'GET', `/actions/workflows/${TESTS_WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=20`, null, fetcher);
  return runs.ok ? (Array.isArray(runs.data?.workflow_runs) ? runs.data.workflow_runs : []) : null;
}

/** The title flutter-check.yml gives a run dispatched with `che_dispatch_id` (its run-name). */
export const TESTS_RUN_TITLE_PREFIX = 'CHE cloud tests ';

/** A dispatch-specific id: the job id plus the dispatch time, so a retried job's new run never matches an old title. */
export function testsDispatchId(jobId, now = Date.now()) {
  return `${String(jobId || 'job').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'job'}-${Number(now).toString(36)}`;
}

/**
 * This job's run, or null while it cannot be told apart. With a dispatch id, only the one run titled with it counts:
 * none (not listed yet) or more than one (ambiguous) leaves the job unassociated instead of guessing. A job dispatched
 * before dispatch ids existed has only its pre-dispatch snapshot: it takes a new run only when exactly one appeared.
 */
async function findDispatchedRun(env, { dispatchId = '', at = '', known = [] } = {}, fetcher) {
  const runs = await listDispatchRuns(env, fetcher);
  if (!runs) return null;
  if (dispatchId) {
    const title = `${TESTS_RUN_TITLE_PREFIX}${dispatchId}`;
    const own = runs.filter((r) => r?.id != null && String(r.display_title || r.name || '') === title);
    return own.length === 1 ? own[0] : null;
  }
  const skip = new Set((Array.isArray(known) ? known : []).map(String));
  const since = Date.parse(at) - 60_000;
  const fresh = runs.filter((r) => r?.id != null && !skip.has(String(r.id)) && Date.parse(r.created_at || 0) >= since);
  return fresh.length === 1 ? fresh[0] : null;
}

async function failedSteps(env, runId, fetcher) {
  const res = await gh(env, 'GET', `/actions/runs/${runId}/jobs`, null, fetcher);
  if (!res.ok) return [];
  return (res.data?.jobs || []).flatMap((j) => (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => `${j.name}: ${s.name}`)).slice(0, 6);
}

// ─── Inline file inspection (Worker only) ────────────────────────────────────
const MAGIC = [
  [(b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70, 'video/mp4'],
  [(b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, 'image/png'],
  [(b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, 'image/jpeg'],
  [(b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46, 'application/pdf'],
  [(b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04, 'application/zip'],
];

/** Facts read from the bytes themselves: size, SHA-256, detected type and, for an MP4, its length and codecs. */
export async function inspectFile(bytes, name = '') {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return { ok: false, error: 'The file is empty, so there is nothing to inspect.' };
  if (bytes.length > FILE_INSPECT_MAX_BYTES) return { ok: false, error: `The file is ${bytes.length} bytes; the Worker inspects files up to ${FILE_INSPECT_MAX_BYTES} bytes.` };
  const type = (MAGIC.find(([test]) => bytes.length >= 8 && test(bytes)) || [null, ''])[1]
    || (/^[\t\n\r\x20-\x7e -￿]*$/u.test(new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048))) ? 'text/plain' : 'application/octet-stream');
  const facts = { ok: true, name: String(name || '').slice(0, 120), bytes: bytes.length, sha256: await sha256Hex(bytes), type };
  if (type === 'video/mp4') facts.mp4 = mp4Facts(bytes);
  return facts;
}

/** Run a file_processing job inside the request and record it in the queue as finished. The bytes are never stored. */
export async function runFileJob(data, { agent = 'CHE', name = '', base64 = '', text = '' } = {}, { env = {}, enqueue } = {}) {
  const asked = requestCloudWork(data, { agent, kind: 'file_processing', title: `Inspect ${String(name || 'file').slice(0, 60)}` }, { env, enqueue: (d, f) => enqueue(d, f) });
  if (!asked.ok) return asked;
  // An inline job is created and finished here; processJobs never sees it queued.
  const job = asked.job;
  let bytes = null;
  try {
    if (base64) bytes = Uint8Array.from(atob(String(base64).replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    else if (text) bytes = new TextEncoder().encode(String(text));
  } catch (_) { bytes = null; }
  const facts = bytes ? await inspectFile(bytes, name) : { ok: false, error: 'The file could not be read: send it as base64 or text.' };
  const at = new Date().toISOString();
  job.cloud = { ...(job.cloud || {}), phase: 'completed', started_at: at, finished_at: at, outputs: facts.ok ? [{ kind: 'facts', ...facts }] : [], log: logLine(job, facts.ok ? `Inspected ${facts.bytes} bytes.` : facts.error) };
  Object.assign(job, { status: facts.ok ? 'complete' : 'failed', updated_at: at, result: facts.ok ? speakFacts(facts) : '', error: facts.ok ? '' : facts.error, verification: facts.ok ? 'facts computed from the bytes on the Worker' : '' });
  noteJobActivity(job, facts.ok ? 'Finished on the Worker.' : `Problem: ${facts.error}`);
  return { ok: facts.ok, job, facts, plan: asked.plan };
}

export function speakFacts(f) {
  const mp4 = f.mp4 ? (f.mp4.ok ? ` It is a playable MP4: ${Math.round(f.mp4.seconds * 10) / 10} seconds, video ${f.mp4.video || 'none'}, audio ${f.mp4.audio || 'none'}.` : ' It has an MP4 header but no playable H.264 and AAC tracks.') : '';
  return `${f.name || 'The file'}: ${f.bytes} bytes, type ${f.type}, SHA-256 ${f.sha256.slice(0, 12)}.${mp4}`;
}

/**
 * Start a handoff kind through its EXISTING starter. `ctx`: { env, fetcher, queueSelfDevelopment, rea, startVideo,
 * onAppBuildDispatched, confirmed }. App builds need ctx.confirmed === true. Nothing paid is ever started.
 */
export async function startCloudTask(kind, params = {}, ctx = {}) {
  const env = ctx.env || {};
  const pick = selectProvider(kind, { env });
  if (pick.blocked) return { ok: false, started: false, kind, ...pick };
  if (pick.run !== 'handoff') return { ok: false, started: false, kind, provider: pick.provider, reason: pick.no_starter || `${pick.template} is started with requestCloudWork, not here.` };
  if (pick.approval_required && ctx.confirmed !== true) return { ok: false, started: false, kind, needs_confirmation: true, provider: pick.provider, reason: pick.approval_reason || 'This needs your yes first.' };
  const fetcher = ctx.fetcher || fetch;
  switch (kind) {
    case 'coding': {
      if (typeof ctx.queueSelfDevelopment !== 'function') return { ok: false, started: false, kind, reason: 'The coding starter is not wired in this context.' };
      const request = String(params.request || '').trim();
      if (request.length < 8) return { ok: false, started: false, kind, reason: 'A coding task needs a request of at least a sentence.' };
      const queued = await ctx.queueSelfDevelopment({ request, groundedRequest: request, immediate: true });
      return { ok: true, started: !queued.deduplicated, kind, provider: pick.provider, job_id: queued.job?.id || null, deduplicated: Boolean(queued.deduplicated), verification: 'job record in the Worker queue' };
    }
    case 'browser': case 'research': {
      if (typeof ctx.rea !== 'function') return { ok: false, started: false, kind, reason: 'The REA runner is not wired in this context.' };
      const target = String(params.url || params.target || '').trim();
      if (!target || target.length > 300) return { ok: false, started: false, kind, reason: 'A browser or research task needs a target: a web address or a name.' };
      const result = await ctx.rea(`REA inspect: ${target}`);
      return { ok: Boolean(result?.ok), started: Boolean(result?.ok), kind, provider: pick.provider, text: String(result?.text || '').slice(0, 400), job_id: result?.job_id || result?.investigation_id || null, reason: result?.ok ? '' : String(result?.text || 'REA did not start.').slice(0, 300) };
    }
    case 'video_render': {
      if (typeof ctx.startVideo !== 'function') return { ok: false, started: false, kind, reason: 'The video renderer is not wired in this context.' };
      const topic = String(params.topic || '').trim();
      if (!topic) return { ok: false, started: false, kind, reason: 'A video render needs a topic.' };
      const result = await ctx.startVideo(topic, Number(params.seconds) || 15);
      return { ok: Boolean(result?.ok), started: Boolean(result?.ok), kind, provider: pick.provider, task_id: result?.task_id || null, reason: result?.ok ? '' : String(result?.error || 'The renderer refused.').slice(0, 300) };
    }
    case 'ios_build': case 'ios_patch': {
      const mode = kind === 'ios_patch' ? 'patch' : 'release';
      const dispatchedAt = new Date().toISOString();
      const result = await dispatchAppBuild(env, mode, fetcher);
      // The same receipt as the chat path: the Worker records the build and queues verify_app_build, so the owner
      // hears "shipped" or "failed" from GitHub's result, not only "started".
      let tracked = false;
      if (result.ok && typeof ctx.onAppBuildDispatched === 'function') {
        try { await ctx.onAppBuildDispatched(mode, dispatchedAt); tracked = true; } catch (_) { tracked = false; }
      }
      return { ok: result.ok, started: result.ok, kind, provider: pick.provider, workflow: result.workflow || '', dispatched_at: result.ok ? dispatchedAt : null, tracked, reason: result.ok ? '' : result.detail };
    }
    case 'blender_model': {
      // The same call as the app's Generate button: the Creation Engine queues it and starts the worker itself.
      if (typeof ctx.generateCreation !== 'function') return { ok: false, started: false, kind, reason: 'Blender models start from Create, then Generate, in the Creation Room.' };
      const id = String(params.project_id || '').trim();
      if (!/^cr_[a-f0-9]{12}$/.test(id)) return { ok: false, started: false, kind, reason: 'Say which creation to build, or open it in the Creation Room and say generate.' };
      const out = await ctx.generateCreation(id);
      return { ok: Boolean(out?.ok), started: Boolean(out?.ok) && !out.duplicate, kind, provider: pick.provider, job_id: out?.job?.id || null,
        text: String(out?.spoken || '').slice(0, 400), reason: out?.ok ? '' : String(out?.detail || 'The Creation Engine refused.').slice(0, 300) };
    }
    default:
      return { ok: false, started: false, kind, provider: pick.provider, reason: `${kind} has no starter in the Cloud Computer.` };
  }
}

// ─── Unified ledger ──────────────────────────────────────────────────────────
const STATUS_WORDS = { awaiting_approval: 'waiting for your approval', queued: 'queued', running: 'running', complete: 'complete', failed: 'failed', cancelled: 'cancelled', dead_letter: 'stopped after repeated failures', unverified: 'unverified' };
export const statusWords = (s) => STATUS_WORDS[s] || String(s || 'unknown').replace(/_/g, ' ');
const DONE = new Set(['complete', 'failed', 'cancelled', 'dead_letter']);

const row = (r) => ({
  id: String(r.id || ''), kind: String(r.kind || ''), title: String(r.title || '').slice(0, 120), agent: String(r.agent || 'CHE'),
  provider: String(r.provider || 'worker_internal'), tools: Array.isArray(r.tools) ? r.tools : [],
  created_at: r.created_at || null, started_at: r.started_at || null, finished_at: r.finished_at || null,
  status: String(r.status || 'unverified'), logs: Array.isArray(r.logs) ? r.logs.slice(-8).map(String) : [], outputs: Array.isArray(r.outputs) ? r.outputs : [],
  evidence: String(r.evidence || 'unverified'), approval: r.approval || null, controls: { approve: false, cancel: false, stop: false, retry: false, ...(r.controls || {}) },
  error: r.error ? String(r.error).slice(0, 400) : '', source: String(r.source || 'jobs'),
});

function queueRow(job, env) {
  const cloud = job.kind === CLOUD_JOB_KIND;
  const kind = cloud ? String(job.cloud_kind || 'cloud') : job.kind === 'self_development' ? 'coding' : job.kind === 'verify_app_build' ? 'ios_build' : String(job.kind || 'api');
  const activity = Array.isArray(job.activity) ? job.activity.map((a) => a.text || String(a)) : [];
  const status = job.dead_letter ? 'dead_letter' : String(job.status || 'unverified');
  const dispatched = Boolean(job.cloud?.dispatched_at);
  const outputs = cloud ? (job.cloud?.outputs || (job.cloud?.html_url ? [{ kind: 'url', url: job.cloud.html_url, label: 'GitHub run' }] : []))
    : [job.pr_url ? { kind: 'pr', url: job.pr_url, label: `PR #${job.pr_number || ''}`.trim() } : null, job.result && status === 'complete' ? { kind: 'text', text: String(job.result).slice(0, 400) } : null].filter(Boolean);
  return row({
    id: job.id, kind, title: job.title, agent: job.requesting_agent || job.agent || 'CHE',
    provider: cloud ? job.environment : job.kind === 'self_development' && codingRuntimeEnabled(env) ? 'github_ubuntu' : 'worker_internal',
    tools: cloud ? job.tools : job.kind === 'self_development' ? ['coding team', ...(codingRuntimeEnabled(env) ? ['opencode runner'] : [])] : ['Worker'],
    created_at: job.created_at || null, started_at: job.cloud?.started_at || job.started_at || null, finished_at: DONE.has(status) ? job.cloud?.finished_at || job.updated_at || null : null,
    status, logs: [...activity, ...(job.cloud?.log || [])], outputs,
    evidence: job.verification || (job.sha || job.pr_number ? 'pull request or commit in the job record' : status === 'complete' ? 'finished by the Worker; no outside receipt' : 'unverified'),
    approval: cloud ? job.approval || null : null,
    controls: {
      approve: status === 'awaiting_approval',
      cancel: status === 'awaiting_approval' || (status === 'queued' && !dispatched),
      stop: cloud && dispatched && !DONE.has(status),
      retry: ['failed', 'cancelled', 'dead_letter'].includes(status),
    },
    error: job.error, source: cloud ? 'cloud_task' : 'jobs',
  });
}

/** One list over every backend. A backend with no record contributes nothing; a record without a result is `unverified`. */
export async function cloudJobs(storage, env = {}) {
  const get = async (k, d) => { try { return (await storage.get(k)) ?? d; } catch (_) { return d; } };
  const rows = [];
  const data = await get('che', {});
  for (const job of Array.isArray(data?.jobs) ? data.jobs : []) rows.push(queueRow(job, env));

  // Office agent tasks that used the persistent computer (agent_runtime.js, CHE_COMPUTER_URL).
  for (const task of Array.isArray(data?.team_tasks) ? data.team_tasks : []) {
    if (!task?.use_computer) continue;
    const status = ['done', 'complete', 'completed'].includes(task.status) ? 'complete' : ['failed', 'cancelled', 'queued', 'running'].includes(task.status) ? task.status : 'unverified';
    rows.push(row({
      id: task.id, kind: 'agent_task', title: String(task.task || 'Office task'), agent: task.partner_name || 'Office', provider: 'owner_computer', tools: task.computer_permissions || [],
      created_at: task.created_at || null, started_at: task.computer_started_at || task.run_started_at || null, finished_at: ['complete', 'failed', 'cancelled'].includes(status) ? task.updated_at || null : null,
      status, evidence: task.owner_approved_computer ? 'owner-approved computer task; its result is the endpoint\'s answer' : 'not approved for the computer', error: task.error || '', source: 'team_tasks',
    }));
  }

  // OpenCode coding runtime: the Worker keeps the last accepted session; its run lives on GitHub (not read here).
  const session = String(await get('che_runtime_last_session', '') || '').trim();
  if (session) {
    rows.push(row({
      id: session, kind: 'coding', title: String(await get('che_runtime_last_request_summary', '') || await get('che_runtime_last_request', '') || 'OpenCode coding session'),
      agent: 'Atlas', provider: 'github_ubuntu', tools: ['opencode-ai', 'che-opencode-runtime.yml'], started_at: await get('che_runtime_last_session_at', null),
      status: 'unverified', evidence: 'the run record is on GitHub; say "coding status" to read it', source: 'coding_runtime',
    }));
  }

  for (const job of await get(REA_JOBS_KEY, [])) {
    const state = String(job.state || '');
    rows.push(row({
      id: job.id, kind: job.kind === 'investigation' ? 'research' : 'browser', title: `REA ${job.command || 'inspect'}: ${job.target?.name || job.target?.url || (typeof job.target === 'string' ? job.target : '')}`,
      agent: 'Mira', provider: job.browser ? 'browser_isolated' : 'worker_internal', tools: job.browser ? ['Playwright', 'Chromium'] : ['Worker fetch'],
      created_at: job.created_at || null, started_at: job.created_at || null, finished_at: ['complete', 'failed'].includes(state) ? job.updated_at || null : null,
      status: state === 'complete' ? 'complete' : state === 'failed' ? 'failed' : state ? 'running' : 'unverified', logs: job.stage ? [`stage: ${job.stage}`] : [],
      evidence: state === 'complete' ? 'investigation record stored' : 'unverified', error: state === 'failed' ? job.error || job.reason || '' : '', source: 'rea',
    }));
  }

  // Free GitHub video renders: the dispatch stamp says only that CHE asked; the finished file lives in the media index.
  let dispatched = new Map();
  try { dispatched = await storage.list({ prefix: VIDEO_DISPATCHED_PREFIX }); } catch (_) { dispatched = new Map(); }
  const media = await get(MEDIA_INDEX_KEY, []);
  const finished = new Set();
  for (const item of Array.isArray(media) ? media : []) {
    if (item?.blob !== 'github-artifact') continue;
    const kind = item.mode === 'edit' ? 'edit_render' : 'video_render';
    // media.js stores the GitHub dispatch id (gha_…) as render_task_id; the dispatch stamps are keyed by that id.
    const id = String(item.render_task_id || item.task_id || item.root_id || item.id);
    finished.add(id);
    rows.push(row({
      id, kind, title: item.title || kind, agent: 'Lyra', provider: 'github_ubuntu', tools: ['ffmpeg', ...(kind === 'video_render' ? ['piper-tts', 'espeak-ng'] : ['Pillow'])],
      created_at: item.created_at || null, started_at: item.created_at || null, finished_at: item.created_at || null, status: 'complete',
      outputs: [{ kind: item.kind === 'image' ? 'image' : 'video', media_id: item.id, label: item.title || kind }],
      evidence: item.verified ? `verified file (${item.width || '?'}x${item.height || '?'}${item.duration_seconds ? `, ${item.duration_seconds}s` : ''})` : 'unverified', source: 'media',
    }));
  }
  for (const [key, value] of dispatched instanceof Map ? dispatched : new Map(Object.entries(dispatched || {}))) {
    const id = key.slice(VIDEO_DISPATCHED_PREFIX.length);
    if (finished.has(id)) continue;
    const at = value?.at ? new Date(Number(value.at)).toISOString() : null;
    rows.push(row({
      id, kind: 'video_render', title: `Video: ${value?.topic || ''}`.trim(), agent: 'Lyra', provider: 'github_ubuntu', tools: ['che-video-render.yml'],
      created_at: at, started_at: at, status: value?.failed ? 'failed' : 'unverified',
      evidence: value?.failed ? 'the run reported failure' : 'dispatched; no finished file in the media index yet', source: 'video',
    }));
  }

  for (const film of await get(FILM_INDEX_KEY, [])) {
    const state = String(film.state || '');
    rows.push(row({
      id: film.id, kind: 'film_render', title: film.title || 'Film', agent: 'Lyra', provider: state === 'assembling' ? 'github_ubuntu' : 'worker_internal', tools: ['Workers AI stills', 'MeloTTS', 'ffmpeg (che-film-render.yml)'],
      created_at: film.created_at || null, started_at: film.created_at || null, status: state === 'done' ? 'complete' : state === 'failed' ? 'failed' : state ? 'running' : 'unverified', logs: state ? [`state: ${state}`] : [],
      evidence: state === 'done' ? 'MP4 verified in storage (Film Studio)' : 'unverified', source: 'film',
    }));
  }

  // Creation Engine jobs (gpu_queue.js): the 3D model builds the Generate button queues, on the worker that holds them.
  let creationJobs = [];
  try { creationJobs = await new GpuQueue(storage).jobs(); } catch (_) { creationJobs = []; }
  for (const j of creationJobs) {
    const hist = j.history || [];
    const at = (state) => hist.find((h) => h.state === state)?.at || null;
    const status = j.state === 'completed' ? 'complete' : j.state === 'rendering' ? 'running' : ['failed', 'cancelled'].includes(j.state) ? j.state : 'queued';
    // A finished job has no lease; completion records the worker in rendered_on (gpu_queue.js complete()).
    const cls = j.lease?.class || j.rendered_on?.class || null;
    const provider = !cls || cls === 'github_cpu' ? 'github_creation' : 'colab_t4';
    rows.push(row({
      id: j.id, kind: 'blender_model', title: j.title || j.kind, agent: 'Lyra', provider, tools: ['Blender', 'MPFB2'],
      created_at: j.created_at || null, started_at: at('rendering'), finished_at: ['complete', 'failed', 'cancelled'].includes(status) ? hist.at(-1)?.at || null : null,
      status, logs: hist.slice(-6).map((h) => `${h.state}${h.note ? `: ${h.note}` : ''}`),
      outputs: j.model ? [{ kind: 'model', url: `/api/gpu/jobs/${j.id}/model.glb`, label: `3D model (${j.model.bytes} bytes)` }] : [],
      evidence: j.model?.sha256 ? `GLB stored, SHA-256 ${String(j.model.sha256).slice(0, 12)}…` : 'unverified', error: j.error || '', source: 'creation_engine',
    }));
  }

  const build = await get(APP_BUILD_KEY, null);
  if (build?.mode) {
    const spec = APP_BUILD_WORKFLOWS[build.mode];
    const state = String(build.state || 'dispatched');
    rows.push(row({
      id: `app-build:${build.dispatched_at || ''}`, kind: build.mode === 'patch' ? 'ios_patch' : 'ios_build', title: spec?.label || 'app build', agent: 'CHE', provider: 'github_macos',
      tools: ['Xcode', 'Flutter', ...(build.mode === 'patch' ? ['Shorebird'] : [])], created_at: build.dispatched_at || null, started_at: build.dispatched_at || null,
      finished_at: ['shipped', 'failed', 'not_shipped'].includes(state) ? build.checked_at || null : null,
      status: state === 'shipped' ? 'complete' : ['failed', 'not_shipped'].includes(state) ? 'failed' : state === 'running' ? 'running' : 'unverified',
      outputs: build.html_url ? [{ kind: 'url', url: build.html_url, label: 'workflow run' }] : [], logs: Array.isArray(build.failed_steps) && build.failed_steps.length ? [`failed steps: ${build.failed_steps.join(', ')}`] : [],
      evidence: state === 'shipped' ? 'ship step succeeded on GitHub' : state === 'dispatched' ? 'dispatched; GitHub answered 204 with no run id' : 'unverified', source: 'app_build',
    }));
  }

  rows.sort((a, b) => String(b.started_at || b.created_at || '').localeCompare(String(a.started_at || a.created_at || '')));
  return rows.slice(0, LEDGER_LIMIT);
}

/** The view behind GET /api/cloud-computer. */
export async function cloudView(storage, env = {}, opts = {}) {
  const environments = providerStatuses(env, opts);
  const jobs = await cloudJobs(storage, env);
  const selection = Object.fromEntries(TASK_KINDS.map((k) => [k, selectProvider(k, { env, statuses: environments })]));
  const software = [...new Set(environments.flatMap((e) => e.software))];
  return {
    environments, software, jobs, selection, templates: TASK_KINDS.map((k) => ({ kind: k, label: TEMPLATES[k].label, requires: TEMPLATES[k].requires, run: TEMPLATES[k].run })),
    approvals: jobs.filter((j) => j.status === 'awaiting_approval').map((j) => ({ id: j.id, title: j.title, reason: j.approval?.reason || '' })),
    missing: Object.entries(MISSING).map(([capability, m]) => ({ capability, ...m })),
    costs: {
      summary: 'Nothing paid is ever started. The Worker is CHE\'s existing Cloudflare service. GitHub Actions minutes are not verified as free for these templates, so each new GitHub dispatch asks you first; the Creation Engine\'s Blender worker is the exception, because it re-checks the repository is public before every start. The film farm uses outside free tiers only with your approval.',
      providers: environments.map((e) => ({ id: e.id, cost: e.cost, billing: e.billing })),
    },
    resources: environments.map((e) => ({ id: e.id, limits: e.limits })),
    at: new Date().toISOString(),
  };
}

// ─── Speech (every reply is spoken and shown as large text by the app) ───────
export function speakCloudSummary(view) {
  const ok = view.environments.filter((e) => e.status === 'operational').length;
  const setup = view.environments.filter((e) => e.status === 'needs_setup').map((e) => e.label);
  const unverified = view.environments.filter((e) => e.status === 'unverified').length;
  const active = view.jobs.filter((j) => ['queued', 'running'].includes(j.status)).length;
  const waiting = view.approvals.length;
  return `My cloud computer has ${view.environments.length} environments: ${ok} operational, ${unverified} unverified${setup.length ? `, ${setup.length} needing setup (${setup.join(', ')})` : ''}. Blender runs only for Create Person, on the free GitHub cloud CPU creation worker; no environment has a GPU of its own. ${active} ${active === 1 ? 'job is' : 'jobs are'} active${waiting ? `, ${waiting} waiting for your approval` : ''}. Nothing paid runs; GitHub minutes are not verified as free, so I ask before each new GitHub run.`;
}

export function speakEnvironments(statuses) {
  return statuses.map((s, i) => `${i + 1}. ${s.label}: ${statusWords(s.status === 'needs_setup' ? 'needs setup' : s.status)}; software: ${s.software.length ? s.software.join(', ') : 'none'}.`).join(' ');
}

export function speakAgentWork(rows) {
  const active = rows.filter((r) => ['awaiting_approval', 'queued', 'running'].includes(r.status));
  if (!active.length) return 'No job is waiting, queued or running on my cloud computer right now, sir. For the Office board, say "what\'s happening in the office".';
  const groups = {};
  for (const r of active) (groups[r.agent] ||= []).push(r);
  const parts = Object.entries(groups).map(([agent, list], i) => `${i + 1}. ${agent}: ${list.slice(0, 3).map((r) => `${r.title || r.kind}, ${statusWords(r.status)}`).join('; ')}`);
  return `${active.length} cloud ${active.length === 1 ? 'job' : 'jobs'}, sir. ${parts.join('. ')}.`;
}

export function speakInstall(statuses, what = '') {
  const named = String(what || '').trim();
  return `${named ? `You asked for ${named}. ` : ''}I never install software quietly, and I never run a command typed in chat, sir. Here is what each environment already has: ${speakEnvironments(statuses)} Adding a tool means a change to a workflow file in .github/workflows, opened as a pull request for your review; it would run on GitHub Actions, whose free usage for this repository is not verified. Nothing was installed.`;
}

export function speakBlocked(plan) {
  return `I cannot do that yet, sir. ${plan.reason}${plan.existing ? ` What I already have: ${plan.existing}` : ''} Smallest addition: ${plan.smallest_addition} Nothing was started.`;
}

export function speakRequest(out) {
  if (out.blocked) return speakBlocked(out.plan);
  if (!out.ok) return `${out.reason || 'That did not start.'} Nothing was started.`;
  const id = short(out.job?.id);
  if (out.needs_approval) return `I prepared cloud job ${id}: ${out.plan.template} on ${out.plan.label}. ${out.plan.approval_reason} Say "approve cloud job ${id}" to dispatch it, or "cancel cloud job ${id}". Nothing was dispatched.`;
  return `Cloud job ${id} is queued: ${out.plan.template} on ${out.plan.label}. I will report the real result.`;
}

/** The result of a handoff start (startCloudTask). */
export function speakStartResult(r) {
  if (r.blocked) return speakBlocked(r);
  if (r.needs_confirmation) return `${r.reason} Confirm it to start; nothing was started.`;
  if (!r.ok) return `${r.reason || 'That did not start.'} Nothing was started.`;
  const where = provider(r.provider)?.label || r.provider;
  if (r.kind === 'coding') return r.deduplicated ? `That coding job is already queued, sir (${short(r.job_id)}).` : `Coding job ${short(r.job_id)} is queued for the coding team on ${where}, sir.`;
  if (r.kind === 'video_render') return `The video render ${r.task_id || ''} was dispatched on ${where}, sir. I will call it done only when a verified MP4 comes back.`;
  if (r.kind === 'browser' || r.kind === 'research') return r.text || `REA started on ${where}, sir.`;
  if (r.kind === 'ios_build' || r.kind === 'ios_patch') {
    return `Started the ${r.kind === 'ios_patch' ? 'app update' : 'iPhone build'} on ${where}, sir.${r.tracked ? ' I will tell you when GitHub reports it shipped or failed.' : ' I could not set up the finish report, so check the run on GitHub.'}`;
  }
  return `Started ${String(r.kind).replace(/_/g, ' ')} on ${where}, sir.`;
}

export function speakControl(action, out) {
  if (!out.ok) return out.reason || 'Nothing changed.';
  const id = short(out.job?.id);
  if (action === 'approve') return `Approved, sir. Cloud job ${id} is queued and will dispatch on GitHub shortly. I will not call the tests passed until GitHub says so.`;
  if (action === 'stop') return out.stopped ? `Stopped, sir. GitHub accepted the cancel for cloud job ${id}.` : `Cancelled cloud job ${id}, sir. It had not been dispatched.`;
  if (action === 'cancel') return `Cancelled job ${id}, sir. Nothing was dispatched.`;
  if (action === 'retry') return `Retrying, sir: job ${id} is queued as a retry${out.job?.retried_from ? ` of ${short(out.job.retried_from)}` : ''}.${out.job?.kind === CLOUD_JOB_KIND ? ' Your retry approves this one GitHub run.' : ''}`;
  return 'Done.';
}

export function speakRender(rows, plan) {
  const renders = rows.filter((r) => r.kind === 'video_render');
  const last = renders[0];
  const lastLine = last ? `My latest video render, "${last.title}", is ${statusWords(last.status)} (${last.evidence}).` : 'I have no video render on record yet.';
  if (plan.blocked) return `${lastLine} ${speakBlocked(plan)}`;
  return `${lastLine} Videos render on ${plan.label} through che-video-render.yml, the free renderer path CHE already uses. To render a new one, say "make a faceless video about" and the topic. Nothing was started.`;
}

export function speakPullRequests(result) {
  if (!result.ok) return `${result.reason} Nothing was checked.`;
  if (!result.prs.length) return 'There are no open pull requests, sir.';
  const list = result.prs.slice(0, 9).map((pr, i) => `${i + 1}. Pull request ${pr.number}: ${pr.title}${pr.draft ? ' (draft)' : ''}`).join(' ');
  return `${result.prs.length} open pull ${result.prs.length === 1 ? 'request' : 'requests'}, sir. ${list}`;
}

/** Open pull requests, through the same gh() helper the coding runtime uses. Read-only. */
export async function openPullRequests(env, fetcher = fetch) {
  if (!hasGithub(env)) return { ok: false, reason: 'GitHub is not connected on the Worker (CHE_GITHUB_TOKEN and CHE_GITHUB_REPO), so I cannot read pull requests.' };
  const list = await gh(env, 'GET', '/pulls?state=open&per_page=20&sort=updated&direction=desc', null, fetcher);
  if (!list.ok) return { ok: false, reason: explainGithubError(list.status, list.data?.message) };
  const prs = (Array.isArray(list.data) ? list.data : []).map((pr) => ({ number: pr.number, title: String(pr.title || '').slice(0, 120), url: pr.html_url || '', draft: Boolean(pr.draft), head: pr.head?.ref || '', updated_at: pr.updated_at || '' }));
  return { ok: true, prs };
}

// ─── Spoken requests (owner device only, no model) ───────────────────────────
// Each maps to one catalog command (command_catalog.js `cloud-*`); this is not a router of its own.
const plain = (m) => String(m || '').trim().replace(/[’‘]/g, "'").replace(/^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chey|chay|shay)(?![a-z'])[\s,.:;!?-]*/i, '').replace(/^(?:please|can you|could you|would you)\s+/i, '').replace(/[,\s]+(?:please|sir|now)\s*[.!?]?$/i, '').replace(/[.!?]+$/, '').trim();
const OPEN = /^(?:open|show(?: me)?|go to|take me to|bring up)\s+(?:the\s+|your\s+|my\s+)?cloud\s+computer(?:\s+(?:room|screen|page|manager))?$/i;
const BLENDER = /^(?:create|make|render|build|animate)\s+(?:a\s+|an\s+|me\s+a\s+)?(?:\d+[- ]second\s+)?blender\s+(?:animation|render|video|scene|film)(?:\s+(?:of|about|with|showing)\s+.{1,120})?$/i;
const RENDER = /^render\s+(?:my|the|our)\s+(?:latest\s+|last\s+|new\s+)?(?:youtube|yt)\s+video$/i;
const TESTS = /^(?:run|start|kick off|launch)\s+(?:the\s+|your\s+|my\s+)?(?:coding|repo(?:sitory)?|unit|flutter|app)\s+tests(?:\s+(?:on|in)\s+(?:the\s+|your\s+)?cloud(?:\s+computer)?)?$/i;
const PRS = /^(?:check|show(?: me)?|list|read(?: me)?)\s+(?:the\s+|your\s+|my\s+|our\s+)?open\s+(?:pull\s+requests|prs|pull-requests)$/i;
const AGENT_WORK = /^(?:show(?: me)?|tell me|list|read(?: me)?)\s+what\s+(?:your|the|my)\s+agents\s+are\s+(?:working on|doing)(?:\s+(?:on|in)\s+(?:the\s+|your\s+)?cloud(?:\s+computer)?)?$/i;
const INSTALL = /^(?:install|add|set up)\s+(?:a\s+|an\s+|some\s+)?(?:(?:compatible|free|open[- ]source)\s+){1,3}(?:[a-z][a-z0-9.+-]{0,30}\s+)?(?:tool|tools|software|program|package)(?:\s+.{1,80})?$/i;
const INSTALL_ON = /^(?:install|add|put|set up)\s+(.{1,60}?)\s+(?:on|onto|to|in)\s+(?:your|the|my)\s+cloud\s+computer$/i;
const GPU_JOBS = /^(?:(?:what|how)(?:'s| are| is)\s+(?:my|the|your)\s+(?:gpu|colab)\s+(?:jobs?|queue|renders?|worker)(?:\s+doing)?|(?:show|read|check|open|list)(?: me)?\s+(?:my|the|your)\s+(?:gpu|colab)\s+(?:jobs?|queue|renders?|worker)|(?:is|are)\s+(?:my|the|your)\s+(?:gpu|colab)(?:\s+(?:worker|session))?\s+(?:online|on|running|working))$/i;
// The compute pool (compute_pool.js): which computers can build characters, and why a character waits. Asked as a
// question too; answered by /cloud-gpu with input "pool".
const POOL = /^(?:(?:which|what)\s+(?:computers?|machines?|gpus?|workers?)\s+(?:can|could)\s+(?:build|make|create|render)\s+(?:my\s+|the\s+)?(?:characters?|people|persons?|avatars?)|why\s+(?:is|are)\s+(?:my|the)\s+(?:characters?|avatars?|person|people|character jobs?)\s+(?:still\s+)?(?:waiting|queued|stuck|not (?:started|building))|(?:show|read|check)(?: me)?\s+(?:my|the|your)\s+compute\s+pool|(?:what(?:'s| is)\s+)?(?:my|the|your)\s+compute\s+pool(?:\s+status)?)$/i;
// Connect GPU (owner, 2026-10-25): the app runs the flow (lib/create/che_gpu_connect.dart); here it only opens it.
const CONNECT_GPU = /^(?:connect|start|turn on|reconnect)\s+(?:(?:my|the|your)\s+)?(?:colab\s+)?gpu(?:\s+(?:runtime|worker|now))?$/i;
const CONTROL = /^(approve|cancel|stop|retry)\s+(?:the\s+|that\s+|my\s+|your\s+)?cloud\s+job(?:\s+([0-9a-f]{6,36}))?$/i;

/** The owner's spoken request to the Cloud Computer as { command, input }, or null. Questions never match. */
export function cloudIntent(message) {
  const t = plain(message);
  if (t && t.length <= 160 && GPU_JOBS.test(t)) return { command: 'cloud-gpu', input: '' };   // asked as a question too
  if (t && t.length <= 160 && POOL.test(t.replace(/\?+$/, ''))) return { command: 'cloud-gpu', input: 'pool' };
  if (!t || t.length > 160 || /\?\s*$/.test(String(message || ''))) return null;
  if (CONNECT_GPU.test(t)) return { command: 'cloud-gpu', input: 'connect' };
  if (OPEN.test(t)) return { command: 'cloud-open', input: '' };
  if (BLENDER.test(t)) return { command: 'cloud-blender', input: t };
  if (RENDER.test(t)) return { command: 'cloud-render', input: '' };
  if (TESTS.test(t)) return { command: 'cloud-tests', input: '' };
  if (PRS.test(t)) return { command: 'cloud-prs', input: '' };
  if (AGENT_WORK.test(t)) return { command: 'cloud-agents', input: '' };
  const on = INSTALL_ON.exec(t);
  if (on) return { command: 'cloud-install', input: on[1] };
  if (INSTALL.test(t)) return { command: 'cloud-install', input: t.replace(/^(?:install|add|set up)\s+/i, '') };
  const ctl = CONTROL.exec(t);
  if (ctl) return { command: 'cloud-control', input: `${ctl[1].toLowerCase()}${ctl[2] ? ` ${ctl[2].toLowerCase()}` : ''}` };
  return null;
}

/** "approve 1a2b3c4d" → { action, id }. Only the four controls; anything else is refused. */
export function parseControl(input) {
  const m = /^\s*(approve|cancel|stop|retry)(?:\s+(?:cloud\s+job\s+)?([0-9a-f-]{6,36}))?\s*$/i.exec(String(input || ''));
  return m ? { action: m[1].toLowerCase(), id: (m[2] || '').toLowerCase() } : null;
}
