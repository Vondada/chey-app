import { staticRegression } from './dart_check.js';
import { classifyFailure, FAILURE_CLASS, stableHash } from './recovery_policy.js';
// CHE self-development: controlled engineering, not uncontrolled
// self-modification.
//
// Flow: CHE writes a ```che-update block (summary + complete safe source files
// under lib/ or server/cloudflare/) → the app shows an "Update ready" card → the owner taps Approve →
// POST /api/self-update opens a pull request in the owner's repo on a new
// branch (main is never touched) → CI runs → the owner merges → the Shorebird
// workflow patches Dart-only changes; anything native needs a full IPA.
// "Roll back last update" opens a PR restoring the files an update changed.
//
// The GitHub token is a Worker secret (CHE_GITHUB_TOKEN). It never reaches
// the phone.

const MAX_FILES = 12;
const MAX_FILE_BYTES = 200_000;
const BRANCH_PREFIX = 'che/update-';
const RUNTIME_BRANCH_PREFIX = 'che/auto/';

// Owner-authorized self-development can edit normal application/source/test/docs
// files on a review branch. High-risk control planes stay read-only: GitHub
// workflows, signing/entitlements, secret files, dependency manifests and
// deployment credentials are never auto-written by CHE.
const SECRET_CONTENT = [
  /\bBEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  // A named secret assigned a real-looking value; test fixtures such as
  // `CHE_GITHUB_TOKEN: 't'` and `env.CHE_GITHUB_TOKEN` are not secrets.
  /\b(?:CHE_GITHUB_TOKEN|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|OLLAMA_API_KEY|CHE_OPENAI_API_KEY|XAI_API_KEY)\s*[:=]\s*['"`]?[A-Za-z0-9_\-./+]{16,}/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bxai-[A-Za-z0-9]{20,}\b/,
];

// Structural native/config payloads only — plain comments that mention
// Info.plist are fine; embedding plist/entitlement XML is not.
const NATIVE_SMUGGLE = [
  /<\?xml[\s\S]{0,200}<(?:plist|dict)\b/i,
  /<key>com\.apple\.developer\./,
  /<key>UIBackgroundModes<\/key>/,
  /CODE_SIGN_ENTITLEMENTS\s*=/,
  /\.entitlements['"]\s*:/,
];


const EDITABLE_PATHS = [
  /^lib\/[A-Za-z0-9_./-]+\.dart$/,
  /^(?:test|integration_test)\/[A-Za-z0-9_./-]+\.dart$/,
  /^server\/cloudflare\/[A-Za-z0-9_./-]+\.(?:js|mjs)$/,
  /^assets\/office3d\/[A-Za-z0-9_./-]+\.(?:html|js|css|json)$/,
  /^web\/[A-Za-z0-9_./-]+\.(?:html|js|css|json)$/,
  /^docs\/[A-Za-z0-9_./ -]+\.(?:md|txt)$/,
  /^ios\/Runner\/[A-Za-z0-9_./-]+\.(?:swift|m|mm|h)$/,
  /^android\/app\/src\/main\/(?:kotlin|java)\/[A-Za-z0-9_./-]+\.(?:kt|java)$/,
];

const READABLE_EXTRA_PATHS = [
  /^(?:pubspec\.yaml|pubspec\.lock|analysis_options\.yaml)$/,
  /^\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/,
  /^server\/cloudflare\/(?:wrangler\.jsonc|package(?:-lock)?\.json)$/,
  /^ios\/[A-Za-z0-9_./-]+\.(?:plist|pbxproj|xcconfig|entitlements)$/,
  /^android\/[A-Za-z0-9_./-]+\.(?:xml|gradle|kts|properties)$/,
];

const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.|$)|secrets?\b|credentials?\b)|\.(?:pem|p12|mobileprovision|key|keystore|jks)$/i;
const PROTECTED_WRITE_PATH = /^(?:\.github\/|\.git\/)/i;
const READABLE_TEXT_PATH = /\.(?:dart|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|ps1|swift|m|mm|h|hpp|c|cc|cpp|java|kt|kts|gradle|xml|plist|pbxproj|xcconfig|ya?ml|jsonc?|toml|md|txt|html|css|sql|graphql|lock|properties)$/i;

export function isSelfUpdateEditablePath(path) {
  const value = String(path || '').trim();
  if (!value || value.includes('..') || value.includes('//') || SENSITIVE_PATH.test(value) || PROTECTED_WRITE_PATH.test(value)) return false;
  return EDITABLE_PATHS.some((re) => re.test(value));
}

export function isSelfUpdateReadablePath(path) {
  const value = String(path || '').trim();
  if (!value || value.includes('..') || value.includes('//') || SENSITIVE_PATH.test(value)) return false;
  return isSelfUpdateEditablePath(value)
    || READABLE_EXTRA_PATHS.some((re) => re.test(value))
    || READABLE_TEXT_PATH.test(value)
    || /^(?:README|LICENSE|CHANGELOG|CODEOWNERS)(?:\.[A-Za-z0-9_-]+)?$/i.test(value);
}

export function scanUpdateContent(content, path = '', baseline = '') {
  const text = String(content || '');
  const before = String(baseline || '');
  for (const re of SECRET_CONTENT) {
    // Baseline-relative: only a secret-looking string this edit introduces is
    // refused; one already in the file on main is not the edit's doing.
    // Counted, not just present: a second copy of an existing secret is new.
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    const count = (source) => {
      const tally = new Map();
      for (const hit of source.match(global) || []) tally.set(hit, (tally.get(hit) || 0) + 1);
      return tally;
    };
    const was = count(before);
    if ([...count(text)].some(([hit, n]) => n > (was.get(hit) || 0))) return `Refusing ${path || 'file'}: looks like a secret or private key.`;
  }
  for (const re of NATIVE_SMUGGLE) {
    if (re.test(text)) return `Refusing ${path || 'file'}: self-update cannot touch native iOS entitlements or Info.plist.`;
  }
  return null;
}

// `baseline` (optional) maps path → current source on the base branch. Static
// checks are baseline-relative: an edit is rejected only for a problem it
// introduces, never for a pre-existing quirk in a file it touches.
export function validateUpdateFiles(files, { baseline = null } = {}) {
  if (!Array.isArray(files) || !files.length) return { error: 'An update needs at least one file.' };
  if (files.length > MAX_FILES) return { error: `An update may change at most ${MAX_FILES} files (keep the slice narrow).` };
  const out = [];
  const seen = new Set();
  let totalBytes = 0;
  const before = (path) => (baseline instanceof Map ? baseline.get(path) : baseline?.[path]);
  for (const file of files) {
    const path = String(file?.path || '').trim();
    const content = typeof file?.content === 'string' ? file.content : null;
    if (!isSelfUpdateEditablePath(path)) {
      return { error: `CHE may edit normal app/source/test/docs files on a review branch, but this path is protected or unsupported: ${path || 'missing path'}.` };
    }
    if (content === null) return { error: `${path} has no content.` };
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > MAX_FILE_BYTES) return { error: `${path} is too large.` };
    totalBytes += bytes;
    if (totalBytes > MAX_FILE_BYTES * 3) return { error: 'Update is too large overall; split into a narrower change.' };
    const smuggle = scanUpdateContent(content, path, before(path));
    if (smuggle) return { error: smuggle };
    const staticError = staticRegression(path, before(path), content);
    if (staticError) return { error: staticError, static_check_failed: true };
    if (seen.has(path)) return { error: `${path} appears twice.` };
    seen.add(path);
    out.push({ path, content });
  }
  return { files: out };
}

// Delivery is based on runtime files, not tests/docs that happen to ride in the PR.
export function classifyUpdate(paths) {
  const values = (Array.isArray(paths) ? paths : []).map(String);
  const flutterRuntime = values.some((path) => /^lib\/.+\.dart$/.test(path));
  const workerRuntime = values.some((path) => /^server\/cloudflare\/.+\.js$/.test(path) && !/\.test\.m?js$/.test(path));
  const needsFullRebuild = values.some((path) =>
    /^(?:assets\/|web\/|ios\/|android\/)/.test(path),
  );
  if (needsFullRebuild && workerRuntime) {
    return { delivery: 'worker_and_full_rebuild', note: 'Touches Worker plus bundled/native app files: deploy the Worker and build a new IPA after merge.' };
  }
  if (needsFullRebuild) return { delivery: 'full_rebuild', note: 'Touches bundled/native app files: needs a new IPA build after merge.' };
  if (workerRuntime && flutterRuntime) return { delivery: 'worker_and_shorebird', note: 'Mixed Flutter + Worker change: deploy the Worker and use Shorebird for eligible Dart changes after merge.' };
  if (workerRuntime) return { delivery: 'worker_deploy', note: 'Worker change: deploy through the Cloudflare Worker pipeline after merge.' };
  if (flutterRuntime) return { delivery: 'shorebird_patch', note: 'Dart-only runtime change: eligible for a Shorebird patch after merge.' };
  return { delivery: 'source_only', note: 'Tests/docs only: no runtime deployment is required after merge.' };
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function repoOf(env) {
  const repo = String(env.CHE_GITHUB_REPO || '');
  if (!env.CHE_GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return repo;
}

async function gh(env, method, path, body, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`https://api.github.com/repos/${repoOf(env)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CHE-Agent',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    // Network failure is a temporary external condition, not a crash.
    return { status: 0, ok: false, data: { message: String(error?.message || error).slice(0, 200) } };
  }
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  return { status: response.status, ok: response.ok, data };
}

/**
 * One pull request as GitHub records it, for answering questions about it: title, state, dates, body
 * and changed file paths. Read-only. { ok:false, reason } when GitHub is not connected or the read failed.
 */
export async function readPullRequest(env, number, fetcher = fetch) {
  const n = Number(number);
  if (!Number.isSafeInteger(n) || n < 1) return { ok: false, reason: 'invalid pull request number' };
  if (!repoOf(env)) return { ok: false, reason: 'GitHub is not connected (CHE_GITHUB_TOKEN / CHE_GITHUB_REPO)' };
  const pr = await gh(env, 'GET', `/pulls/${n}`, null, fetcher);
  if (!pr.ok || pr.data?.number !== n) return { ok: false, reason: pr.status === 404 ? `pull request #${n} does not exist` : `GitHub read failed (${pr.status || 'network'}${ghReason(pr) ? `: ${ghReason(pr).slice(0, 80)}` : ''})` };
  const files = await gh(env, 'GET', `/pulls/${n}/files?per_page=100`, null, fetcher);
  return {
    ok: true, number: n, url: String(pr.data.html_url || ''), title: String(pr.data.title || ''),
    state: pr.data.merged_at ? 'merged' : String(pr.data.state || ''), merged_at: String(pr.data.merged_at || ''), created_at: String(pr.data.created_at || ''),
    body: String(pr.data.body || '').slice(0, 4000),
    files: files.ok && Array.isArray(files.data) ? files.data.map((f) => String(f.filename || '')).filter(Boolean) : [],
    files_read: files.ok,
  };
}

function ghReason(result) {
  return String(result?.data?.message || result?.data?.errors?.[0]?.message || '').trim();
}

export async function selfUpdateGitHubAccess(env, fetcher = fetch) {
  const configured = repoOf(env);
  if (!configured) {
    return {
      status: 503,
      connected: false,
      detail: 'Self-update needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the CHE server.',
    };
  }
  const repo = await gh(env, 'GET', '', null, fetcher);
  if (!repo.ok) {
    const reason = ghReason(repo);
    return {
      status: repo.status || 502,
      connected: false,
      repository: configured,
      detail: `GitHub repository access failed (${repo.status})${reason ? `: ${reason}` : '.'}`,
    };
  }
  const permissions = repo.data?.permissions || {};
  return {
    status: 200,
    connected: true,
    repository: configured,
    default_branch: String(repo.data?.default_branch || 'main'),
    can_read: true,
    can_push_reported: permissions.push === true ? true : permissions.push === false ? false : null,
    can_create_draft_pr: permissions.push === true ? true : permissions.push === false ? false : null,
    policy: 'read latest repo; write only owner-approved review branches; draft PR only; never push main directly',
  };
}

async function baseBranch(env, fetcher) {
  const repo = await gh(env, 'GET', '', null, fetcher);
  return repo.ok ? String(repo.data?.default_branch || 'main') : 'main';
}

function decodeContent(value) {
  const binary = atob(String(value || '').replace(/\s+/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

// Live identity of the files an update touches on the base commit:
// { path: { sha, content } } (sha null when the file does not exist yet).
async function liveFiles(env, ref, paths, fetcher) {
  const out = {};
  for (const path of paths) {
    const found = await gh(env, 'GET', `/contents/${path}?ref=${encodeURIComponent(ref)}`, null, fetcher);
    if (found.status === 404) { out[path] = { sha: null, content: null }; continue; }
    if (!found.ok) return { error: found };
    let content = null;
    try { content = found.data?.content ? decodeContent(found.data.content) : null; } catch (_) { content = null; }
    out[path] = { sha: String(found.data?.sha || '') || null, content };
  }
  return { files: out };
}

// Idempotency: the same approved proposal always maps to the same branch, so
// a double tap, a retried request or a replayed approval reuses one PR.
export function updateBranchName(summary, files) {
  const digest = stableHash(JSON.stringify({
    summary: String(summary || '').trim(),
    files: (files || []).map((file) => [file.path, stableHash(file.content || '')]),
  }));
  return `${BRANCH_PREFIX}${digest}`;
}

async function existingPrFor(env, branch, fetcher) {
  const owner = String(repoOf(env) || '').split('/')[0];
  const found = await gh(env, 'GET', `/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=5`, null, fetcher);
  const list = Array.isArray(found.data) ? found.data : [];
  return list.find((pr) => pr?.head?.ref === branch) || null;
}

function prReceipt(pr, branch, base, delivery, reused = false) {
  return {
    status: 200,
    number: pr.number,
    url: pr.html_url,
    branch,
    commit_sha: String(pr?.head?.sha || ''),
    base,
    delivery: delivery.delivery,
    note: delivery.note,
    ...(reused ? { reused: true } : {}),
  };
}

function failed(result, detail) {
  const reason = ghReason(result);
  const code = Number(result?.status || 0);
  const text = `${detail} (${code || 'network'})${reason ? `: ${reason}` : '.'}`;
  const { failure_class: failureClass, kind } = classifyFailure({ status: code, detail: text });
  const temporary = failureClass === FAILURE_CLASS.TEMPORARY_EXTERNAL || !code;
  return {
    status: temporary ? 503 : [401, 403].includes(code) ? code : 502,
    detail: text,
    failure_class: temporary ? FAILURE_CLASS.TEMPORARY_EXTERNAL : failureClass,
    failure_kind: kind,
    retryable: temporary,
  };
}

// Opens the owner-approved draft PR.
//
// Safety properties:
// - never writes the default branch; the branch is created from the exact base
//   commit that was verified, so a racing main cannot slip in unverified code;
// - the whole update lands as ONE commit (Git Data API), so a failure part-way
//   cannot leave a half-written branch;
// - stale source is detected per file: if main moved but none of the touched
//   files changed, the approved contents are still exactly what the owner
//   approved and are applied on the new base; if a touched file changed, the
//   write is refused (409) so the proposal is rebuilt and re-approved;
// - idempotent: replays return the existing PR instead of opening another.
export async function openSelfUpdatePr(env, body, fetcher = fetch) {
  if (!repoOf(env)) return { status: 503, detail: 'Self-update needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the CHE server.' };
  const summary = String(body.summary || '').trim().slice(0, 2000);
  if (summary.length < 4) return { status: 400, detail: 'Describe the update in a short summary.' };
  const shape = validateUpdateFiles(body.files);
  if (shape.error && !shape.static_check_failed) return { status: 400, detail: shape.error };
  const paths = (body.files || []).map((file) => String(file?.path || '').trim());

  const base = await baseBranch(env, fetcher);
  const liveRef = await gh(env, 'GET', `/git/ref/heads/${encodeURIComponent(base)}`, null, fetcher);
  const liveSha = String(liveRef.data?.object?.sha || '');
  if (!liveRef.ok || !liveSha) return failed(liveRef, `Could not verify current ${base} before writing the update`);

  const expectedBaseSha = String(body.expected_base_sha || '').trim();
  const baseFiles = body.base_files && typeof body.base_files === 'object' ? body.base_files : null;
  let live = null;
  if (expectedBaseSha && liveSha !== expectedBaseSha) {
    if (!baseFiles) {
      return {
        status: 409,
        stale_source: true,
        detail: `${base} changed after CHE inspected the source.`,
        expected_base_sha: expectedBaseSha,
        current_base_sha: liveSha,
      };
    }
    const read = await liveFiles(env, liveSha, paths, fetcher);
    if (read.error) return failed(read.error, 'Could not re-check the touched files on the current base');
    live = read.files;
    const changed = paths.filter((path) => (live[path]?.sha || null) !== (baseFiles[path] ?? null));
    if (changed.length) {
      return {
        status: 409,
        stale_source: true,
        changed_files: changed,
        detail: `${base} changed ${changed.join(', ')} after CHE inspected it.`,
        expected_base_sha: expectedBaseSha,
        current_base_sha: liveSha,
      };
    }
  }

  if (!live) {
    const read = await liveFiles(env, liveSha, paths, fetcher);
    if (read.error) return failed(read.error, 'Could not read the current versions of the touched files');
    live = read.files;
  }
  const baseline = Object.fromEntries(paths.map((path) => [path, live[path]?.content ?? null]));
  const checked = validateUpdateFiles(body.files, { baseline });
  if (checked.error) return { status: 400, detail: checked.error, failure_class: FAILURE_CLASS.INTERNAL };

  const delivery = classifyUpdate(checked.files.map((file) => file.path));
  const branch = updateBranchName(summary, checked.files);
  const priorRef = await gh(env, 'GET', `/git/ref/heads/${encodeURIComponent(branch)}`, null, fetcher);
  if (priorRef.ok && priorRef.data?.object?.sha) {
    const prior = await existingPrFor(env, branch, fetcher);
    if (prior) return prReceipt(prior, branch, base, delivery, true);
  } else {
    const baseCommit = await gh(env, 'GET', `/git/commits/${encodeURIComponent(liveSha)}`, null, fetcher);
    const baseTree = String(baseCommit.data?.tree?.sha || '');
    if (!baseCommit.ok || !baseTree) return failed(baseCommit, `Could not read the ${base} commit`);
    const tree = await gh(env, 'POST', '/git/trees', {
      base_tree: baseTree,
      tree: checked.files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
    }, fetcher);
    if (!tree.ok || !tree.data?.sha) return failed(tree, 'Could not stage the update');
    const commit = await gh(env, 'POST', '/git/commits', {
      message: `CHE update: ${summary.split('\n')[0].slice(0, 72)}`,
      tree: tree.data.sha,
      parents: [liveSha],
    }, fetcher);
    if (!commit.ok || !commit.data?.sha) return failed(commit, 'Could not commit the update');
    const made = await gh(env, 'POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.data.sha }, fetcher);
    if (!made.ok && made.status !== 422) return failed(made, 'Could not create the update branch');
  }

  const pr = await gh(env, 'POST', '/pulls', {
    title: `CHE update: ${summary.split('\n')[0].slice(0, 80)}`,
    head: branch,
    base,
    draft: true,
    body: [
      summary,
      '',
      '**Files**',
      ...checked.files.map((file) => `- \`${file.path}\``),
      '',
      `**Delivery:** ${delivery.note}`,
      `**Rollback point:** \`${liveSha}\` on \`${base}\`.`,
      '',
      'Approved in the CHE app by the owner. Merge only after CI passes.',
    ].join('\n'),
  }, fetcher);
  if (!pr.ok) {
    if (pr.status === 422) {
      const prior = await existingPrFor(env, branch, fetcher);
      if (prior) return prReceipt(prior, branch, base, delivery, true);
    }
    return failed(pr, 'Could not open the pull request');
  }
  return prReceipt(pr.data, branch, base, delivery);
}

// CI checks are classified, not just counted. A check that also fails on the
// base commit is a pre-existing/external failure, not something this change
// broke, and must not be reported as "your change failed CI".
export function classifyCheck(run) {
  const name = String(run?.name || run?.context || '').toLowerCase();
  const text = `${name} ${String(run?.output?.title || '')} ${String(run?.output?.summary || '')}`.toLowerCase();
  if (/workers builds|cloudflare|wrangler|deploy|preview/.test(name)) return 'deployment';
  if (/secret|token|credential|unauthori[sz]ed|authentication/.test(text)) return 'authentication';
  if (/analy[sz]e|lint|static/.test(name)) return 'static_analysis';
  if (/test|check|ci\b/.test(name)) return 'tests';
  return 'other';
}

async function checkRuns(env, sha, fetcher) {
  const checks = await gh(env, 'GET', `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`, null, fetcher);
  return { ok: checks.ok, runs: Array.isArray(checks.data?.check_runs) ? checks.data.check_runs : [] };
}

const FAILED = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'];

export async function selfUpdateStatus(env, number, fetcher = fetch) {
  if (!Number.isSafeInteger(Number(number)) || Number(number) < 1) return { status: 400, detail: 'Invalid pull request number.' };
  if (!repoOf(env)) return { status: 503, detail: 'Self-update is not connected to GitHub.' };
  const pr = await gh(env, 'GET', `/pulls/${Number(number)}`, null, fetcher);
  if (!pr.ok) return pr.status === 404 ? { status: 404, detail: 'Update pull request not found.' } : failed(pr, 'Could not read the pull request');
  if (pr.data?.number !== Number(number) || typeof pr.data?.merged !== 'boolean'
    || !['open', 'closed'].includes(pr.data?.state) || !/^[a-f0-9]{40}$/i.test(pr.data?.head?.sha || '')
    || (pr.data.merged && (pr.data.state !== 'closed' || !/^[a-f0-9]{40}$/i.test(pr.data.merge_commit_sha || '')))) {
    return { status: 502, detail: 'GitHub returned an invalid or contradictory pull request record.' };
  }
  const head = await checkRuns(env, pr.data.head.sha, fetcher);
  const runs = head.runs;
  const failedRuns = runs.filter((run) => FAILED.includes(run.conclusion));
  const pending = runs.filter((run) => run.status !== 'completed');
  let preexisting = [];
  if (failedRuns.length && pr.data?.base?.sha) {
    const base = await checkRuns(env, pr.data.base.sha, fetcher);
    const baseFailed = new Set(base.runs.filter((run) => FAILED.includes(run.conclusion)).map((run) => run.name));
    preexisting = failedRuns.filter((run) => baseFailed.has(run.name));
  }
  const blocking = failedRuns.filter((run) => !preexisting.includes(run));
  const ci = !head.ok ? 'unknown' : !runs.length ? 'none' : blocking.length ? 'failed' : pending.length ? 'running' : 'passed';
  return {
    status: 200,
    number: pr.data.number,
    url: pr.data.html_url,
    state: pr.data.merged ? 'merged' : pr.data.state,
    draft: pr.data.draft === true,
    head_sha: String(pr.data.head?.sha || ''),
    merge_commit_sha: pr.data.merged ? String(pr.data.merge_commit_sha || '') : '',
    mergeable: pr.data.mergeable ?? null,
    mergeable_state: String(pr.data.mergeable_state || ''),
    ci,
    failed_checks: blocking.map((run) => run.name),
    failure_classes: [...new Set(blocking.map(classifyCheck))],
    preexisting_failed_checks: preexisting.map((run) => run.name),
    pending_checks: pending.map((run) => run.name),
  };
}

// Owner-authorized merge. Refuses unless the PR is a CHE update branch, CI has
// no blocking failures and nothing is pending, GitHub reports it mergeable,
// and the head is exactly the commit CHE checked (no race with a new push).
// Worker changes carry [worker-deploy] so the repository's deploy workflow
// runs; deployment truth is then verified separately.
export async function mergeSelfUpdatePr(env, number, fetcher = fetch, { expectedHeadSha = '' } = {}) {
  const status = await selfUpdateStatus(env, number, fetcher);
  if (status.status !== 200) return status;
  // A merge bound to a reviewed commit refuses a head that moved after that review.
  if (expectedHeadSha && status.state === 'open' && status.head_sha !== expectedHeadSha) {
    return { status: 409, detail: `PR #${status.number} changed after it was reviewed (reviewed ${expectedHeadSha.slice(0, 7)}, now ${status.head_sha.slice(0, 7)}); it needs a new review before it can merge.`, failure_class: FAILURE_CLASS.INTERNAL };
  }
  if (status.state === 'merged') return { status: 200, already_merged: true, number: status.number, merge_commit_sha: status.merge_commit_sha, url: status.url };
  if (status.state !== 'open') return { status: 409, detail: `PR #${status.number} is ${status.state}.`, failure_class: FAILURE_CLASS.PERMANENT_EXTERNAL };
  const pr = await gh(env, 'GET', `/pulls/${Number(number)}`, null, fetcher);
  const branch = String(pr.data?.head?.ref || '');
  // Her built-in update branches, and her coding runner's branches (che/auto/, Build 5): both only on the owner's yes.
  if (!branch.startsWith(BRANCH_PREFIX) && !branch.startsWith(RUNTIME_BRANCH_PREFIX)) return { status: 403, detail: 'CHE only merges her own owner-approved update branches.', failure_class: FAILURE_CLASS.AUTHORIZATION };
  if (status.ci === 'failed') return { status: 409, detail: `CI failed: ${status.failed_checks.join(', ')}.`, ci: status, failure_class: FAILURE_CLASS.INTERNAL };
  if (status.ci === 'running') return { status: 409, detail: 'CI is still running.', ci: status, retryable: true, failure_class: FAILURE_CLASS.TEMPORARY_EXTERNAL };
  // No check has reported yet (GitHub creates them seconds after a push). Every
  // PR to main runs CI here, so zero checks is "not started", never "passed".
  if (status.ci === 'none') return { status: 409, detail: 'CI is still running: no check has reported yet.', retryable: true, failure_class: FAILURE_CLASS.TEMPORARY_EXTERNAL };
  if (status.mergeable === false || status.mergeable_state === 'dirty') {
    return { status: 409, detail: 'The pull request has a merge conflict with the base branch.', merge_conflict: true, failure_class: FAILURE_CLASS.INTERNAL };
  }
  if (status.draft) {
    const ready = await fetcher('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'CHE-Agent' },
      body: JSON.stringify({
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
        variables: { id: pr.data?.node_id },
      }),
    }).catch(() => null);
    if (!ready?.ok) return { status: 502, detail: 'GitHub did not mark the draft ready for merge.', retryable: true, failure_class: FAILURE_CLASS.TEMPORARY_EXTERNAL };
  }
  const files = await gh(env, 'GET', `/pulls/${Number(number)}/files?per_page=100`, null, fetcher);
  if (!files.ok) return failed(files, 'Could not read the pull request files');
  const route = classifyUpdate((Array.isArray(files.data) ? files.data : []).map((file) => String(file.filename || '')));
  const workerDeploy = /worker/.test(route.delivery);
  const merged = await gh(env, 'PUT', `/pulls/${Number(number)}/merge`, {
    sha: status.head_sha,
    merge_method: 'squash',
    commit_title: `${String(pr.data?.title || `CHE update #${number}`).slice(0, 200)}${workerDeploy ? ' [worker-deploy]' : ''}`,
  }, fetcher);
  if (!merged.ok) {
    if (merged.status === 409) return { status: 409, detail: 'The pull request changed after CHE checked it; re-checking is required.', failure_class: FAILURE_CLASS.INTERNAL };
    return failed(merged, 'GitHub did not merge the pull request');
  }
  return {
    status: 200,
    number: Number(number),
    url: status.url,
    merge_commit_sha: String(merged.data?.sha || ''),
    delivery: route.delivery,
    worker_deploy: workerDeploy,
  };
}

// Deployment truth for a merged Worker change: the deploy workflow run for the
// merge commit, plus the version the running Worker reports about itself.
export async function workerDeploymentStatus(env, mergeSha, fetcher = fetch, runtime = {}) {
  if (!repoOf(env)) return { status: 503, detail: 'Self-update is not connected to GitHub.' };
  const sha = String(mergeSha || '');
  const runs = await gh(env, 'GET', `/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`, null, fetcher);
  const list = (Array.isArray(runs.data?.workflow_runs) ? runs.data.workflow_runs : [])
    .filter((run) => /deploy che worker|che-worker-deploy/i.test(`${run.name} ${run.path || ''}`));
  const run = list[0] || null;
  const workflow = !runs.ok ? 'unknown'
    : !run ? 'not_started'
      : run.status !== 'completed' ? 'running'
        : run.conclusion === 'success' ? 'succeeded'
          : 'failed';
  const runningTag = String(runtime?.version_tag || '');
  const live = Boolean(runningTag && sha && (sha.startsWith(runningTag) || runningTag.startsWith(sha.slice(0, 7))));
  return {
    status: 200,
    merge_commit_sha: sha,
    workflow,
    workflow_url: run?.html_url || '',
    running_version_tag: runningTag,
    running_version_id: String(runtime?.version_id || ''),
    production_matches_merge: live,
    deployed: workflow === 'succeeded' && (live || !runningTag),
  };
}

// GitHub's workflow history, not last_self_update_deploy (only CHE-initiated merges).
export function latestWorkerDeploymentIntent(message) {
  const text = String(message || '').trim();
  if (!text || /^\/|(?:^|[.!?\n]\s*)(?:fix|repair|implement|deploy|start|trigger|launch)\b/i.test(text)) return false;
  return /\b(?:check|show|find|look up|verify|report|tell|give|what(?:'s| is| was)|latest|last|recent)\b/i.test(text)
    && /\b(?:deploy che worker|worker deploy(?:ment)?|che worker deploy(?:ment)?|github actions[\s\S]{0,120}deploy|deploy[\s\S]{0,120}github actions)\b/i.test(text)
    && !/\b(?:how|why)\s+(?:do|does|would|could)\s+(?:i|you|che)\s+(?:build|deploy|implement)\b/i.test(text);
}

/** Query the real newest Deploy CHE Worker run; no guessing from files or memory. */
export async function latestWorkerDeploymentStatus(env, fetcher = fetch, runtime = {}) {
  const repository = repoOf(env);
  if (!repository) {
    return { status: 503, detail: 'CHE GitHub access is not configured. The Worker needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO; no live deployment lookup ran.' };
  }
  const result = await gh(env, 'GET', '/actions/workflows/che-worker-deploy.yml/runs?per_page=10', null, fetcher);
  if (!result.ok || !Array.isArray(result.data?.workflow_runs)) {
    return { status: result.status || 503, detail: 'GitHub Actions did not return deployment runs (HTTP ' + (result.status || 'network failure') + '). Current deployment state is unverified.' };
  }
  const run = result.data.workflow_runs
    .filter((item) => /deploy che worker|che-worker-deploy/i.test(String(item.name || '') + ' ' + String(item.path || '')))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
  if (!run) {
    return { status: 200, found: false, repository, detail: 'GitHub Actions returned no Deploy CHE Worker runs in the latest ten executions. No deployment is verified by this lookup.' };
  }
  const conclusion = run.status === 'completed' ? String(run.conclusion || 'unknown') : 'in_progress';
  const sha = String(run.head_sha || '');
  const versionTag = String(runtime?.version_tag || '');
  const matches = Boolean(sha && versionTag && (sha.startsWith(versionTag) || versionTag.startsWith(sha.slice(0, 7))));
  return {
    status: 200, found: true, repository,
    run_id: Number(run.id) || null, workflow: conclusion,
    conclusion, commit_sha: sha, workflow_url: String(run.html_url || ''),
    created_at: String(run.created_at || ''), completed_at: String(run.updated_at || ''),
    running_version_tag: versionTag,
    production_version_verified: Boolean(conclusion === 'success' && matches),
    production_version_checked: Boolean(versionTag),
  };
}

export function speakLatestWorkerDeployment(result) {
  if (result?.status !== 200) return 'Sir, I could not verify the Worker deployment from GitHub. ' + (result?.detail || 'GitHub did not respond.');
  if (!result.found) return 'Sir, ' + result.detail;
  const resultText = result.conclusion === 'in_progress' ? 'still running'
    : result.conclusion === 'success' ? 'completed successfully'
      : 'completed with conclusion ' + result.conclusion;
  const versionText = result.production_version_verified ? ' The Worker version matches this commit.'
    : result.production_version_checked ? ' The running Worker version was not verified as this commit.'
      : ' Production version match was not checked by this lookup.';
  return 'Sir, GitHub Actions reports the latest Deploy CHE Worker run ' + (result.run_id || 'unknown')
    + ' ' + resultText + '. Commit: ' + (result.commit_sha || 'unavailable') + '. Run: '
    + (result.workflow_url || 'GitHub did not supply a link') + '.' + versionText;
}

// Opens a real git revert of the last merged CHE update (GitHub's
// revertPullRequest). Only that update's changes are undone; later edits to
// the same files are kept, and a revert that would conflict is refused
// instead of overwriting newer work.
export async function rollbackLastUpdate(env, fetcher = fetch) {
  if (!repoOf(env)) return { status: 503, detail: 'Self-update is not connected to GitHub.' };
  const list = await gh(env, 'GET', '/pulls?state=closed&per_page=50&sort=updated&direction=desc', null, fetcher);
  const last = (Array.isArray(list.data) ? list.data : [])
    .find((pr) => pr.merged_at && String(pr.head?.ref || '').startsWith(BRANCH_PREFIX));
  if (!last) return { status: 404, detail: 'No merged CHE update to roll back.' };
  if (!last.node_id) return { status: 502, detail: 'GitHub did not return the update’s id.' };
  const response = await fetcher('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'CHE-Agent',
    },
    body: JSON.stringify({
      query: 'mutation($id: ID!, $title: String!, $body: String) { revertPullRequest(input: {pullRequestId: $id, title: $title, body: $body}) { revertPullRequest { number url } } }',
      variables: {
        id: last.node_id,
        title: `Roll back CHE update #${last.number}`,
        body: `Reverts only the changes from #${last.number}. Requested from the CHE app. Merge after CI passes.`,
      },
    }),
  });
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  const pr = data?.data?.revertPullRequest?.revertPullRequest;
  if (!response.ok || !pr) {
    const reason = String(data?.errors?.[0]?.message || `GitHub returned ${response.status}`);
    return {
      status: 409,
      detail: `GitHub could not revert #${last.number} cleanly (${reason}). Later work overlaps it; revert it by hand so nothing newer is lost.`,
    };
  }
  return { status: 200, number: pr.number, url: pr.url, rolls_back: last.number };
}

export const CHE_UPDATE_GUIDE = `SELF-DEVELOPMENT RULE: CHE has a real GitHub self-development toolchain. For owner-requested engineering, read the latest repository, delegate to the internal engineering team, inspect real source, implement, independently review, and present a reviewable proposal. CHE may edit normal Flutter/Worker/test/docs/office3d/web/native-source files on a dedicated branch after owner approval. Never write credentials, signing material, entitlements, secret files, GitHub workflows, or dependency/deployment control files automatically. Never push directly to main. Owner-approved changes open a REAL DRAFT PR through CHE_GITHUB_TOKEN; report the real PR number, URL, branch and commit SHA returned by GitHub. If GitHub rejects an operation, report the exact API status/message instead of guessing that access is missing. Merge/deploy still requires the owner's explicit instruction and CI. CHE may continually research and prepare improvements, but may not silently merge them.`;

/** Read-only runtime questions. A request to change/deploy software is never a status lookup. */
export function appStatusIntent(message = '') {
  const t = String(message).replace(/[’]/g, "'").trim().toLowerCase()
    .replace(/^(?:(?:hey|hi)\s+)?(?:che|chay|chey)[, :]+/, '').replace(/[.!?]+$/, '');
  if (/^(?:fix|change|set|install|update|deploy|build|release|publish|run|start)\b/.test(t) || latestWorkerDeploymentIntent(t)) return null;
  if (/\b(?:added|introduced|was running|used to|previously|back then|at the time|when .*was)\b/.test(t)) return null;
  // "What changed in commit X and what can I test on my iPhone" asks about a commit's content (deploy_receipt.js),
  // not the running version; "my iPhone" plus "commit" once matched here and repeated the status answer.
  if (/\bwhat(?:'?s| is| was)? (?:changed|new|in)\b|\bchanged in\b|\bchanges? (?:in|from|made)\b|\bsummar(?:y|ize|ise)\b|\bwhat (?:can|should|do) i test\b|\bto test\b/.test(t)) return null;
  if (/^(?:open|show)(?: me)? (?:settings|about)(?:\s*(?:\/|and)\s*(?:about|show(?: me)?))?.*\b(?:app )?version\b/.test(t)) return { kind: 'settings' };
  // Install and update questions about the owner's phone (reliability lane, gap 10): "Is the new build installed on my
  // phone?", "Did the update go through?", "What's on my iPhone right now?". The device report answers, not the model.
  if (/^(?:is|are|did|has|have)\b/.test(t)
    && /\b(?:new|latest|last)?\s*(?:build|update|patch|version|ipa)\b/.test(t)
    && /\b(?:installed|go(?:ne)? through|went through|land(?:ed)?|arrived?|reach(?:ed)?|on my (?:phone|iphone))\b/.test(t)) return { kind: 'runtime' };
  if (/^what(?:'?s| is)\s+(?:installed\s+)?on my (?:phone|iphone)(?: right now| now)?$/.test(t)) return { kind: 'runtime' };
  if (!/^(?:what(?:'?s| is| are)?|which|tell me|show me|check|read|give me)\b/.test(t)) return null;
  // The subject must be CHE itself: "what version of Python should my project use" is not a status question.
  if (/\b(?:version|build number|deployment (?:identifier|id|status)|commit|sha)\b/.test(t)
    && /\b(?:installed|backend|worker|connected|deployed|deployment|running|che|(?:my|the|this) (?:app|build|iphone app|phone app))\b/.test(t)) return { kind: /\b(?:commit|sha|last verified deployment|deployment status)\b/.test(t) ? 'deployment' : 'runtime' };
  return null;
}

/** Installed build vs the newest verified release: numeric version parts, then the build number. */
function compareInstalled(native, latest) {
  const parts = (v) => String(v).split('.').map((x) => (/^\d+$/.test(x) ? BigInt(x) : null));
  const a = parts(native.version);
  const b = parts(latest.version);
  if (a.includes(null) || b.includes(null) || !/^\d+$/.test(String(latest.build_number || ''))) return 'unknown';
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0n;
    const y = b[i] ?? 0n;
    if (x !== y) return x > y ? 'ahead' : 'behind';
  }
  const mine = BigInt(native.build);
  const theirs = BigInt(latest.build_number);
  return mine === theirs ? 'current' : mine > theirs ? 'ahead' : 'behind';
}

/**
 * Metadata values come from the current Worker binding and paired device, never from a model or release listing.
 * `latest` is the newest verified IPA release (mobile_update.js latestVerifiedRelease); it is compared with the
 * device report and never stands in for it.
 */
export function appStatusReport({ runtime = {}, client = null, deployment = null, latest = null, now = Date.now() } = {}) {
  const deploymentId = typeof runtime.version_id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(runtime.version_id) ? runtime.version_id : null;
  const tag = typeof runtime.version_tag === 'string' && /^[a-f0-9]{7,40}$/i.test(runtime.version_tag) ? runtime.version_tag : null;
  const at = Date.parse(client?.checked_at || '');
  const native = client?.source === 'ios_bundle' && Number.isFinite(at) && now - at >= -5000 && now - at <= 300000
    && typeof client.version === 'string' && /^\d+(?:\.\d+){1,4}$/.test(client.version)
    && typeof client.build === 'string' && /^\d{1,64}$/.test(client.build) ? client : null;
  // The Shorebird patch the phone's updater read: a number, or "none" for the bare release. Anything else is unread.
  const patch = native && typeof native.patch === 'string' && /^(?:none|\d{1,6})$/.test(native.patch) ? native.patch : null;
  const full = tag?.length === 40 ? tag : deployment?.production_version_verified === true
    && /^[a-f0-9]{40}$/i.test(deployment.commit_sha || '') && tag && deployment.commit_sha.startsWith(tag) ? deployment.commit_sha : null;
  const patchText = patch === 'none' ? ' It runs no Shorebird patch (the bare release).' : patch ? ` It runs Shorebird patch ${patch}.` : ' This does not identify a Shorebird patch.';
  const parts = [native ? `This iPhone reports installed CHE version ${native.version}, build ${native.build}, from its iOS bundle at ${native.checked_at}.${patchText}`
    : 'Installed iPhone version and build are unavailable: this request has no fresh native iOS bundle report. The backend cannot infer them from the latest published app.'];
  const release = latest && typeof latest.version === 'string' && /^\d+(?:\.\d+){1,4}$/.test(latest.version) && /^\d{1,64}$/.test(String(latest.build_number || '')) ? latest : null;
  const comparison = {
    installed_vs_latest: native && release ? compareInstalled(native, release) : 'unknown',
    latest: release ? { tag: release.tag || null, version: release.version, build: String(release.build_number), commit_sha: /^[a-f0-9]{7,40}$/i.test(release.commit_sha || '') ? release.commit_sha : null } : null,
    same_commit: null,
  };
  if (native) {
    const label = release ? `CHE ${release.version}, build ${release.build_number}${release.tag ? ` (${release.tag})` : ''}` : '';
    if (!release) parts.push('I could not read the newest verified iPhone build, so I cannot say whether this iPhone is behind it.');
    else if (comparison.installed_vs_latest === 'current') {
      const appCommit = comparison.latest.commit_sha?.toLowerCase();
      const backend = tag?.toLowerCase();
      comparison.same_commit = appCommit && backend ? appCommit.startsWith(backend) || backend.startsWith(appCommit) : null;
      const commitText = !appCommit || !backend ? ''
        : comparison.same_commit ? ` It was built from the same commit the backend runs, ${tag}.`
          : ` It was built from commit ${appCommit.slice(0, 12)}; the backend runs ${tag}. A newer backend is normal; app changes after that commit need a patch or a new build.`;
      parts.push(`That is the newest verified iPhone build, ${label}.${commitText}`);
    } else if (comparison.installed_vs_latest === 'behind') parts.push(`The newest verified iPhone build is ${label}, so this iPhone is behind it. A Shorebird patch made for that newer release does not reach this one; installing the newer build does.`);
    else if (comparison.installed_vs_latest === 'ahead') parts.push(`This iPhone runs a build newer than the newest published release (${label}), so it was installed from an unpublished build.`);
    else parts.push(`The newest verified iPhone build is ${label}; its version could not be compared with this one.`);
  }
  parts.push(deploymentId ? `Connected Worker deployment identifier: ${deploymentId}.` : 'Connected Worker deployment identifier is unavailable: CF_VERSION_METADATA.id was not supplied.');
  parts.push(full ? `Backend commit SHA: ${full}.` : tag ? `Backend commit tag: ${tag}. A full commit SHA is not verified by this runtime metadata.` : 'Backend commit is unavailable: CF_VERSION_METADATA.tag was not supplied as a commit identifier.');
  if (deployment) parts.push(speakLatestWorkerDeployment(deployment));
  else parts.push('This reads the running version only; it does not prove that CHE deployed a change or that the latest deployment workflow succeeded.');
  return { status: native || deploymentId || tag ? 'available' : 'unavailable', operation: 'read_runtime_metadata', text: parts.join(' '), checked_at: new Date(now).toISOString(), source: 'current Worker CF_VERSION_METADATA; native bundle values are device-reported; newest release from GitHub releases', installed: native ? { version: native.version, build: native.build, patch, checked_at: native.checked_at, source: native.source } : null,
    backend: { deployment_id: deploymentId, commit_tag: tag, commit_sha: full }, comparison, deployment };
}
