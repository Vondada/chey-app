import { checkDartFiles } from './dart_check.js';
// CHE self-development: controlled engineering, not uncontrolled
// self-modification.
//
// Flow: CHE writes a ```che-update block (summary + complete Dart files under
// lib/) → the app shows an "Update ready" card → the owner taps Approve →
// POST /api/self-update opens a pull request in the owner's repo on a new
// branch (main is never touched) → CI runs → the owner merges → the Shorebird
// workflow patches Dart-only changes; anything native needs a full IPA.
// "Roll back last update" opens a PR restoring the files an update changed.
//
// The GitHub token is a Worker secret (CHE_GITHUB_TOKEN). It never reaches
// the phone.

const MAX_FILES = 6;
const MAX_FILE_BYTES = 200_000;
const BRANCH_PREFIX = 'che/update-';

// Dart files under lib/ only. Everything else (pubspec, ios/, native code,
// entitlements, Info.plist, workflows) is outside the self-update lane.
// Content is scanned so a "Dart" file cannot smuggle secrets or native config.
const SECRET_CONTENT = [
  /\bBEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\b(?:CHE_GITHUB_TOKEN|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|OLLAMA_API_KEY|CHE_OPENAI_API_KEY|XAI_API_KEY)\s*[:=]/,
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

export function scanUpdateContent(content, path = '') {
  const text = String(content || '');
  for (const re of SECRET_CONTENT) {
    if (re.test(text)) return `Refusing ${path || 'file'}: looks like a secret or private key.`;
  }
  for (const re of NATIVE_SMUGGLE) {
    if (re.test(text)) return `Refusing ${path || 'file'}: self-update cannot touch native iOS entitlements or Info.plist.`;
  }
  return null;
}

export function validateUpdateFiles(files) {
  if (!Array.isArray(files) || !files.length) return { error: 'An update needs at least one file.' };
  if (files.length > MAX_FILES) return { error: `An update may change at most ${MAX_FILES} files (keep the slice narrow).` };
  const out = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const file of files) {
    const path = String(file?.path || '').trim();
    const content = typeof file?.content === 'string' ? file.content : null;
    if (!/^lib\/[A-Za-z0-9_\/]+\.dart$/.test(path) || path.includes('..') || path.includes('//')) {
      return { error: `Only Dart files under lib/ can be self-updated (${path || 'missing path'}).` };
    }
    if (content === null) return { error: `${path} has no content.` };
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > MAX_FILE_BYTES) return { error: `${path} is too large.` };
    totalBytes += bytes;
    if (totalBytes > MAX_FILE_BYTES * 3) return { error: 'Update is too large overall; split into a narrower change.' };
    const smuggle = scanUpdateContent(content, path);
    if (smuggle) return { error: smuggle };
    const dartErr = checkDartFiles([{ path, content }]);
    if (dartErr) return { error: dartErr };
    if (seen.has(path)) return { error: `${path} appears twice.` };
    seen.add(path);
    out.push({ path, content });
  }
  return { files: out };
}

// Shorebird can patch Dart code only. Anything else needs a full rebuild.
export function classifyUpdate(paths) {
  const dartOnly = paths.every((path) => /^lib\/.+\.dart$/.test(path));
  return dartOnly
    ? { delivery: 'shorebird_patch', note: 'Dart-only change: eligible for a Shorebird patch after merge.' }
    : { delivery: 'full_rebuild', note: 'Touches native/config files: needs a new IPA build and SideStore install.' };
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
  const response = await fetcher(`https://api.github.com/repos/${repoOf(env)}${path}`, {
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
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  return { status: response.status, ok: response.ok, data };
}

async function baseBranch(env, fetcher) {
  const repo = await gh(env, 'GET', '', null, fetcher);
  return repo.ok ? String(repo.data?.default_branch || 'main') : 'main';
}

async function createBranch(env, name, fromBranch, fetcher) {
  const ref = await gh(env, 'GET', `/git/ref/heads/${encodeURIComponent(fromBranch)}`, null, fetcher);
  if (!ref.ok) return { error: `Could not read ${fromBranch} (${ref.status}).` };
  const sha = ref.data?.object?.sha;
  const made = await gh(env, 'POST', '/git/refs', { ref: `refs/heads/${name}`, sha }, fetcher);
  if (!made.ok) return { error: `Could not create branch (${made.status}).` };
  return { sha };
}

async function putFile(env, branch, path, content, message, fetcher) {
  const existing = await gh(env, 'GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`, null, fetcher);
  const put = await gh(env, 'PUT', `/contents/${path}`, {
    message,
    content: base64Utf8(content),
    branch,
    ...(existing.ok && existing.data?.sha ? { sha: existing.data.sha } : {}),
  }, fetcher);
  return put.ok ? {} : { error: `Could not write ${path} (${put.status}).` };
}

export async function openSelfUpdatePr(env, body, fetcher = fetch) {
  if (!repoOf(env)) return { status: 503, detail: 'Self-update needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the CHE server.' };
  const summary = String(body.summary || '').trim().slice(0, 2000);
  if (summary.length < 4) return { status: 400, detail: 'Describe the update in a short summary.' };
  const checked = validateUpdateFiles(body.files);
  if (checked.error) return { status: 400, detail: checked.error };
  const base = await baseBranch(env, fetcher);
  const branch = `${BRANCH_PREFIX}${Date.now().toString(36)}`;
  const made = await createBranch(env, branch, base, fetcher);
  if (made.error) return { status: 502, detail: made.error };
  for (const file of checked.files) {
    const wrote = await putFile(env, branch, file.path, file.content, `CHE update: ${file.path}`, fetcher);
    if (wrote.error) return { status: 502, detail: wrote.error };
  }
  const delivery = classifyUpdate(checked.files.map((file) => file.path));
  const pr = await gh(env, 'POST', '/pulls', {
    title: `CHE update: ${summary.split('\n')[0].slice(0, 80)}`,
    head: branch,
    base,
    body: [
      summary,
      '',
      '**Files**',
      ...checked.files.map((file) => `- \`${file.path}\``),
      '',
      `**Delivery:** ${delivery.note}`,
      `**Rollback point:** \`${made.sha}\` on \`${base}\`.`,
      '',
      'Approved in the CHE app by the owner. Merge only after CI passes.',
    ].join('\n'),
  }, fetcher);
  if (!pr.ok) return { status: 502, detail: `Could not open the pull request (${pr.status}).` };
  return {
    status: 200,
    number: pr.data.number,
    url: pr.data.html_url,
    branch,
    delivery: delivery.delivery,
    note: delivery.note,
  };
}

export async function selfUpdateStatus(env, number, fetcher = fetch) {
  if (!repoOf(env)) return { status: 503, detail: 'Self-update is not connected to GitHub.' };
  const pr = await gh(env, 'GET', `/pulls/${Number(number)}`, null, fetcher);
  if (!pr.ok) return { status: 404, detail: 'Update pull request not found.' };
  const checks = await gh(env, 'GET', `/commits/${pr.data.head.sha}/check-runs`, null, fetcher);
  const runs = Array.isArray(checks.data?.check_runs) ? checks.data.check_runs : [];
  const failed = runs.filter((run) => ['failure', 'cancelled', 'timed_out'].includes(run.conclusion));
  const pending = runs.filter((run) => run.status !== 'completed');
  return {
    status: 200,
    number: pr.data.number,
    url: pr.data.html_url,
    state: pr.data.merged ? 'merged' : pr.data.state,
    ci: !runs.length ? 'none' : failed.length ? 'failed' : pending.length ? 'running' : 'passed',
    failed_checks: failed.map((run) => run.name),
  };
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

export const CHE_UPDATE_GUIDE = `SELF-DEVELOPMENT RULE: CHE manages code changes but does not author them in owner-facing chat. Explicit requests to change CHE's code, UI, screens, layout, navigation, styling, or Flutter behavior must be delegated to the internal engineering team: architect/UI architect → implementation agent → independent code/UX reviewer → repair agent if needed. The team must inspect real repository source before changing existing files. The resulting complete Dart files under lib/ are returned as one che-update proposal for the owner's explicit approval. Never fabricate a che-update block yourself. Nothing is written until the owner approves the card; then the server opens a branch/PR, CI validates it, and merge/deploy stays reviewable and rollback-capable. Native iOS changes, entitlements, Info.plist, or new native packages require a full rebuild rather than a Shorebird-only patch.`;
