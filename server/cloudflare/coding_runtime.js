import { stableHash } from './recovery_policy.js';

const DEFAULT_WORKFLOW = 'che-opencode-runtime.yml';
const DEFAULT_RESULTS_REF = 'che-mailbox';
const RESULT_PREFIX = 'mailbox/runtime';
const MAX_REQUEST_CHARS = 16000;

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

export function runtimeSessionId({ repo = '', baseSha = '', targetBranch = '', ownerRequest = '', jobId = '' } = {}) {
  const fingerprint = stableHash(JSON.stringify({
    repo: String(repo).toLowerCase(),
    base_sha: String(baseSha).toLowerCase(),
    target_branch: String(targetBranch).toLowerCase(),
    request: String(ownerRequest).replace(/\s+/g, ' ').trim(),
    job_id: String(jobId).trim(),
  }));
  return `ocr-${fingerprint}`;
}

async function gh(env, method, path, body, fetcher) {
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

  async createSession({ jobId = '', ownerRequest = '', baseSha = '', targetBranch = '', model = '', workflowRef = 'main' } = {}) {
    if (!this.enabled) {
      return { status: 409, disabled: true, runtime: 'builtin', detail: 'OpenCode runtime is disabled; CHE keeps using the current coding path.' };
    }
    const repo = repoOf(this.env);
    if (!repo) return { status: 503, detail: 'OpenCode runtime needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the Worker.' };
    const request = validateRuntimeRequest(ownerRequest);
    if (request.error) return { status: 400, detail: request.error };
    const resolvedModel = String(model || this.env.CHE_OPENCODE_MODEL || '').trim();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@\/-]+$/.test(resolvedModel)) {
      return { status: 503, detail: 'OpenCode runtime needs CHE_OPENCODE_MODEL in provider/model form.' };
    }
    const head = validSha(baseSha);
    if (!head) return { status: 400, detail: 'OpenCode runtime needs the inspected base commit SHA.' };
    const branch = validBranch(targetBranch);
    if (!branch) return { status: 400, detail: 'OpenCode runtime needs a safe target branch name.' };
    const dispatchRef = validBranch(workflowRef) || 'main';
    const sessionId = runtimeSessionId({ repo, baseSha: head, targetBranch: branch, ownerRequest: request.text, jobId });
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
      session_id: sessionId,
      state: 'queued',
      workflow: this.workflow,
      result_path: `${RESULT_PREFIX}/${sessionId}.json`,
    };
  }

  async getStatus(sessionId) {
    const id = String(sessionId || '').trim();
    if (!/^ocr-[0-9a-f]{8}$/.test(id)) return { status: 400, detail: 'Invalid coding runtime session id.' };
    const path = `${RESULT_PREFIX}/${id}.json`;
    const found = await gh(this.env, 'GET', `/contents/${path}?ref=${encodeURIComponent(this.resultsRef)}`, null, this.fetcher);
    if (found.status === 404) return { status: 200, runtime: 'opencode', session_id: id, state: 'queued' };
    if (!found.ok) return { status: found.status || 502, detail: `Could not read OpenCode runtime status (${found.status || 'network'}).` };
    try {
      const parsed = JSON.parse(decodeBase64Utf8(found.data?.content));
      if (parsed?.session_id !== id) throw new Error('session mismatch');
      return { status: 200, runtime: 'opencode', ...parsed };
    } catch (_) {
      return { status: 502, detail: 'OpenCode runtime result is not valid compact JSON.' };
    }
  }
}
