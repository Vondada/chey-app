import { stableHash } from './recovery_policy.js';

const DEFAULT_WORKFLOW = 'che-opencode-runtime.yml';
const DEFAULT_RESULTS_REF = 'che-mailbox';
const RESULT_PREFIX = 'mailbox/runtime';
const MAX_REQUEST_CHARS = 16000;
const RUNTIME_STALE_MS = 35 * 60_000;

const SECRET_LIKE = [
  /\bBEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY\b/i,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bxai-[A-Za-z0-9]{20,}\b/,
];

export function codingRuntimeMode(env = {}) {
  return String(env.CHE_CODING_RUNTIME || '').trim().toLowerCase() === 'opencode' ? 'opencode' : 'builtin';
}

export function codingRuntimeEnabled(env = {}) {
  return codingRuntimeMode(env) === 'opencode';
}

// The current OpenCode workflow feeds auto-merge. A delivery hold must use
// the built-in reviewed-PR lane, where merge is a separate owner command.
export function ownerRequiresMergeApproval(request) {
  const text = String(request || '');
  const hold = /\b(?:do\s+not|don['’]t|never|must\s+not)\s+(?:auto(?:matically)?[- ]?)?(?:merge|ship|deploy)\b/i.test(text)
    || /\b(?:merge|ship|deploy)\b[^.!?\n]{0,80}\b(?:only\s+(?:after|with)|without|await|wait\s+for)\b[^.!?\n]{0,50}\b(?:authoriz\w*|approv\w*|permission|confirmation)\b/i.test(text)
    || /\b(?:wait|stop|hold)\b[^.!?\n]{0,120}\b(?:merg(?:e|ing)|ship(?:ping)?|deploy(?:ing)?)\b/i.test(text)
    || /\b(?:approv\w*|authoriz\w*|permission|confirmation)\b[^.!?\n]{0,80}\b(?:before|prior\s+to)\s+(?:you\s+)?(?:merg(?:e|ing)|ship(?:ping)?|deploy(?:ing)?)\b/i.test(text)
    || /\b(?:unmerged|pr[- ]only|pull[- ]request[- ]only)\b/i.test(text)
    || /\bno\s+(?:automatic\s+|auto[- ]?)?merg(?:e|ing)\b/i.test(text)
    || /\b(?:merg(?:e|ing)|ship(?:ping)?|deploy(?:ing)?)\b[^.!?\n]{0,80}\b(?:to\s+me|only\s+(?:when|if)\s+i)\b/i.test(text)
    || /\b(?:only\s+)?(?:merge|ship|deploy)\b[^\.\!\?\n]{0,100}\b(?:after|until|once)\b[^\.\!\?\n]{0,50}\b(?:i\s+)?(?:approv\w*|authoriz\w*|permission|confirmation)\b/i.test(text)
    || /\b(?:ask|check\s+with)\s+me\b[^\.\!\?\n]{0,60}\b(?:before|prior\s+to)\s+(?:you\s+)?(?:merg(?:e|ing)|ship(?:ping)?|deploy(?:ing)?)\b/i.test(text)
    || /\bno\s+(?:automatic\s+|auto[- ]?)?(?:merg(?:e|ing)|ship(?:ping)?|deploy(?:ment|ing)?)\b[^\.\!\?\n]{0,80}\b(?:until|unless)\b[^\.\!\?\n]{0,50}\b(?:approv\w*|authoriz\w*|permission|confirmation)\b/i.test(text)
    || /\bi(?:\s+(?:will|want\s+to|am\s+going\s+to)|['’]ll)\s+(?:merg(?:e|ing)|ship(?:ping)?|deploy(?:ing)?)\b[^\.\!\?\n]{0,40}\bmyself\b/i.test(text)
    || /\bi(?:\s+(?:will|want\s+to|am\s+going\s+to)|['’]ll)\s+merg(?:e|ing)\b/i.test(text);
  if (hold) return true;
  const authorizedMerge = /(?:\b(?:and|then|also)\s+|[.!?,]\s*)(?:automatically\s+)?(?:merge|ship|deploy)\s+(?:it|(?:the|that|this)\s+(?:pr|pull\s+request|change|update))\b/i.test(text);
  return !authorizedMerge && /\b(?:prepare|open|create|draft)\b[^.!?\n]{0,80}\b(?:pr|pull\s+request)\b/i.test(text);
}

function repoOf(env) {
  const repo = String(env?.CHE_GITHUB_REPO || '').trim();
  return env?.CHE_GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '';
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const binary = atob(String(value || '').replace(/\s+/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

export function validateRuntimeRequest(value) {
  const text = String(value || '').trim();
  if (text.length < 8) return { error: 'Coding runtime request is too short.' };
  if (text.length > MAX_REQUEST_CHARS) return { error: `Coding runtime request exceeds ${MAX_REQUEST_CHARS} characters.` };
  if (SECRET_LIKE.some((pattern) => pattern.test(text))) return { error: 'Coding runtime request looks like it contains a secret; refusing to send it to an external model runtime.' };
  return { text };
}

export function runtimeSessionId({ repo = '', baseSha = '', targetBranch = '', ownerRequest = '', jobId = '', model = '' } = {}) {
  const fingerprint = stableHash(JSON.stringify({
    repo: String(repo).toLowerCase(),
    base_sha: String(baseSha).toLowerCase(),
    target_branch: String(targetBranch).toLowerCase(),
    request: String(ownerRequest).replace(/\s+/g, ' ').trim(),
    job_id: String(jobId).trim(),
    model: String(model).trim().toLowerCase(),
  }));
  return `ocr-${fingerprint}`;
}

export async function gh(env, method, path, body, fetcher = fetch) {
  const repo = repoOf(env);
  if (!repo) return { ok: false, status: 503, data: { message: 'GitHub runtime is not configured.' } };
  let response;
  try {
    response = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CHE-Coding-Runtime',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    return { ok: false, status: 0, data: { message: String(error?.message || error).slice(0, 200) } };
  }
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  return { ok: response.ok, status: response.status, data };
}

function validBranch(value) {
  const branch = String(value || '').trim();
  return branch && branch.length <= 160 && !branch.includes('..') && !branch.startsWith('/') && !branch.endsWith('/') && /^[A-Za-z0-9._\/-]+$/.test(branch) ? branch : '';
}

function validSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : '';
}

export class CheCodingRuntime {
  constructor(env, { fetcher = fetch, workflow = DEFAULT_WORKFLOW, resultsRef = DEFAULT_RESULTS_REF } = {}) {
    this.env = env || {};
    this.fetcher = fetcher;
    this.workflow = workflow;
    this.resultsRef = resultsRef;
  }

  get enabled() {
    return codingRuntimeEnabled(this.env);
  }

  async createSession({ jobId = '', ownerRequest = '', baseSha = '', targetBranch = '', model = '', workflowRef = 'main', executionMode = 'BUILD' } = {}) {
    if (String(executionMode || '').toUpperCase() !== 'BUILD') {
      return { status: 403, denied: true, runtime: 'opencode', detail: 'OpenCode mutation runtime accepts BUILD-authorized turns only.' };
    }
    if (!this.enabled) {
      return { status: 409, disabled: true, runtime: 'builtin', detail: 'OpenCode runtime is disabled; CHE keeps using the current coding path.' };
    }
    const repo = repoOf(this.env);
    if (!repo) return { status: 503, detail: 'OpenCode runtime needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the Worker.' };
    const request = validateRuntimeRequest(ownerRequest);
    if (request.error) return { status: 400, detail: request.error };
    if (ownerRequiresMergeApproval(request.text)) return { status: 409, detail: 'This request requires a separate owner merge decision; use the built-in reviewed-PR lane.' };
    // "auto" lets the runner pick the first provider whose key is configured.
    const resolvedModel = String(model || this.env.CHE_OPENCODE_MODEL || 'auto').trim();
    if (resolvedModel !== 'auto' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@\/-]+$/.test(resolvedModel)) {
      return { status: 503, detail: 'OpenCode runtime needs CHE_OPENCODE_MODEL in provider/model form.' };
    }
    const head = validSha(baseSha);
    if (!head) return { status: 400, detail: 'OpenCode runtime needs the inspected base commit SHA.' };
    const branch = validBranch(targetBranch);
    if (!branch) return { status: 400, detail: 'OpenCode runtime needs a safe target branch name.' };
    const dispatchRef = validBranch(workflowRef) || 'main';
    const sessionId = runtimeSessionId({ repo, baseSha: head, targetBranch: branch, ownerRequest: request.text, jobId, model: resolvedModel });
    const sent = await gh(this.env, 'POST', `/actions/workflows/${encodeURIComponent(this.workflow)}/dispatches`, {
      ref: dispatchRef,
      inputs: {
        job_id: sessionId,
        request_b64: encodeBase64Utf8(request.text),
        base_sha: head,
        target_branch: branch,
        model: resolvedModel,
      },
    }, this.fetcher);
    if (!sent.ok) {
      return {
        status: sent.status || 502,
        detail: `Could not start the OpenCode runtime (${sent.status || 'network'}).`,
        retryable: !sent.status || sent.status >= 500 || sent.status === 429,
      };
    }
    return {
      status: 202,
      runtime: 'opencode',
      job_id: String(jobId || sessionId),
      session_id: sessionId,
      state: 'queued',
      accepted_at: new Date().toISOString(),
      workflow: this.workflow,
      result_path: `${RESULT_PREFIX}/${sessionId}.json`,
    };
  }

  // Exact commit of the default branch, so the runner refuses stale source.
  async headSha(branch = 'main') {
    const found = await gh(this.env, 'GET', `/commits/${encodeURIComponent(branch)}`, null, this.fetcher);
    return found.ok ? validSha(found.data?.sha) : '';
  }

  // The mailbox result file only updates at claim and at publish, so an old
  // heartbeat is not proof the run died: a queued or in-progress workflow run
  // for this session is still live work. GitHub's own run state is the
  // authority, checked before any stale-failure claim so a silent-but-alive
  // run is never reported dead and never triggers a duplicate recovery job.
  async workflowRunAlive({ runId = 0, acceptedAt = '' } = {}) {
    if (Number(runId) > 0) {
      const run = await gh(this.env, 'GET', `/actions/runs/${Number(runId)}`, null, this.fetcher);
      if (!run.ok) return 'unknown';
      return String(run.data?.status || '') === 'completed' ? 'dead' : 'alive';
    }
    const since = Date.parse(String(acceptedAt || ''));
    if (!Number.isFinite(since)) return 'unknown';
    const listed = await gh(this.env, 'GET', `/actions/workflows/${encodeURIComponent(this.workflow)}/runs?per_page=20`, null, this.fetcher);
    if (!listed.ok) return 'unknown';
    const runs = Array.isArray(listed.data?.workflow_runs) ? listed.data.workflow_runs : [];
    // Only an uncompleted run created at/after this session was accepted can
    // be its still-pending dispatch (60s of clock-skew slack).
    const alive = runs.some((run) => String(run?.status || '') !== 'completed'
      && Number.isFinite(Date.parse(String(run?.created_at || '')))
      && Date.parse(run.created_at) >= since - 60_000);
    return alive ? 'alive' : 'dead';
  }

  async getStatus(sessionId, { acceptedAt = '', now = Date.now() } = {}) {
    const id = String(sessionId || '').trim();
    if (!/^ocr-[0-9a-f]{8}$/.test(id)) return { status: 400, detail: 'Invalid coding runtime session id.' };
    const path = `${RESULT_PREFIX}/${id}.json`;
    const found = await gh(this.env, 'GET', `/contents/${path}?ref=${encodeURIComponent(this.resultsRef)}`, null, this.fetcher);
    if (found.status === 404) {
      const accepted = Date.parse(String(acceptedAt || ''));
      if (Number.isFinite(accepted) && now - accepted > RUNTIME_STALE_MS) {
        if (await this.workflowRunAlive({ acceptedAt }) === 'alive') {
          // The dispatch is real but the runner has not claimed it yet.
          return { status: 200, runtime: 'opencode', session_id: id, state: 'dispatching' };
        }
        return { status: 200, runtime: 'opencode', session_id: id, state: 'failed', failure: 'dispatch_stale', error: 'The workflow never published an execution record.' };
      }
      return { status: 200, runtime: 'opencode', session_id: id, state: 'queued' };
    }
    if (!found.ok) return { status: found.status || 502, detail: `Could not read OpenCode runtime status (${found.status || 'network'}).` };
    try {
      const parsed = JSON.parse(decodeBase64Utf8(found.data?.content));
      if (parsed?.session_id !== id) throw new Error('session mismatch');
       if (parsed.state === 'running' && (parsed.status === 'complete' || parsed.status === 'failed' || (typeof parsed.progress === 'number' && Number.isFinite(parsed.progress) && parsed.progress >= 100))) parsed.state = parsed.status === 'failed' ? 'failed' : 'complete';
       if (parsed.status === 'stopped') parsed.state = 'stopped';
       const heartbeat = Date.parse(String(parsed.updated_at || parsed.started_at || parsed.claimed_at || acceptedAt || ''));
       if (parsed.state === 'running' && Number.isFinite(heartbeat) && now - heartbeat > RUNTIME_STALE_MS) {
         if (await this.workflowRunAlive({ runId: Number(parsed.run_id) || 0, acceptedAt }) === 'alive') {
           return { status: 200, runtime: 'opencode', ...parsed, heartbeat: 'stale' };
         }
         parsed.state = 'failed';
         parsed.failure = 'runtime_stale';
         parsed.error = 'The runtime stopped publishing progress before its workflow could finish.';
       }
       return { status: 200, runtime: 'opencode', ...parsed };
    } catch (_) {
      return { status: 502, detail: 'OpenCode runtime result is not valid compact JSON.' };
    }
  }
}

// Short spoken summary of a runtime session: found, changed, tests, review,
// what remains. Never reads logs aloud.
export function runtimeState(result = {}) {
  const raw = String(result.state || 'queued').trim().toLowerCase();
  // Older runtime publishers stored the lifecycle in failure while leaving
  // state as the generic "blocked". Normalize both shapes in one place.
  const failure = String(result.failure || '').trim().toLowerCase();
  if (raw === 'blocked' && failure === 'opencode_failed') return 'opencode_failed';
  if (raw === 'blocked' && failure === 'deliver_failed') return 'deliver_failed';
  return raw || 'queued';
}

export function runtimeStateClass(result = {}) {
  const state = runtimeState(result);
  if (['queued', 'dispatching', 'running', 'retrying', 'recovering'].includes(state)) return 'active';
  if (['implemented', 'pr_open', 'reviewing', 'approved_waiting_owner'].includes(state)) return 'progress';
  if (['complete', 'merged', 'no_change', 'rolled_back'].includes(state)) return 'complete';
  if (['opencode_failed', 'deliver_failed', 'tests_failed', 'review_rejected', 'failed', 'cancelled', 'dead_letter'].includes(state)) return 'failed';
  return 'unknown';
}

export function recoverableRuntimeFailure(result = {}) {
  const state = runtimeState(result);
  // Unsafe-file guards and authorization failures are deliberately excluded:
  // they need policy/owner handling, not an automatic coding retry.
  return ['opencode_failed', 'deliver_failed', 'tests_failed', 'review_rejected'].includes(state)
    || ['dispatch_stale', 'runtime_stale'].includes(String(result.failure || ''));
}

export function speakRuntimeStatus(result = {}) {
  const state = runtimeState(result);
  const files = Number(result.changed_files || 0);
  const changed = files ? `changed ${files} file${files === 1 ? '' : 's'} (+${Number(result.additions || 0)}/-${Number(result.deletions || 0)})` : 'no files changed yet';
  const parts = [];
  switch (state) {
    case 'queued': parts.push('The coding job is queued on my OpenCode runner.'); break;
    case 'dispatching': parts.push('The coding job is being dispatched to my OpenCode runner.'); break;
    case 'running': parts.push('The coding job is currently running on my OpenCode runner.'); break;
    case 'retrying': parts.push('The coding job is retrying automatically.'); break;
    case 'recovering': parts.push('The coding job is recovering automatically.'); break;
    case 'implemented': parts.push(`My coding runner ${changed}.`); break;
    case 'pr_open': parts.push(`I ${changed} and opened pull request ${result.pr_number || ''}. Tests are running.`); break;
    case 'reviewing': parts.push(`Tests passed. My reviewer is checking pull request ${result.pr_number || ''}.`); break;
    case 'approved_waiting_owner': parts.push(`Tests and independent review passed for pull request ${result.pr_number || ''}. It is waiting for your approval, sir; I have not merged or deployed it.`); break;
    case 'merged': parts.push(`Done. I ${changed}, tests passed, my reviewer approved, and I merged pull request ${result.pr_number || ''}.`); break;
    case 'review_rejected': parts.push(`Tests passed but my reviewer rejected it: ${String(result.review || '').slice(0, 200)}. I did not merge.`); break;
    case 'tests_failed': parts.push(`Tests failed on pull request ${result.pr_number || ''}, so I did not merge it.`); break;
    case 'rolled_back': parts.push('A merged change broke main, so I rolled it back automatically.'); break;
    case 'no_change': parts.push('My runner found nothing that needed changing.'); break;
    case 'opencode_failed': parts.push('The OpenCode attempt failed. I am recovering the coding job automatically.'); break;
    case 'deliver_failed': parts.push('The coding change could not be delivered. I am recovering the coding job automatically.'); break;
    case 'failed': case 'cancelled': case 'dead_letter':
      parts.push(result.failure === 'dispatch_stale'
        ? 'The coding workflow never started, so I am not reporting it as running.'
        : result.failure === 'runtime_stale'
          ? 'The coding workflow stopped reporting progress and is no longer considered running.'
          : `The coding job stopped: ${state.replace(/_/g, ' ')}.`); break;
    default: parts.push(`The coding job status is ${state.replace(/_/g, ' ')}.`);
  }
  if (result.remaining) parts.push(`Still remaining: ${String(result.remaining).slice(0, 200)}.`);
  return parts.join(' ');
}
