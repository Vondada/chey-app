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

const MAX_FILES = 12;
const MAX_FILE_BYTES = 200_000;
const BRANCH_PREFIX = 'che/update-';

// Dart files under lib/ only. Everything else (pubspec, ios/, native code,
// entitlements, Info.plist, workflows) is outside the self-update lane.
export function validateUpdateFiles(files) {
  if (!Array.isArray(files) || !files.length) return { error: 'An update needs at least one file.' };
  if (files.length > MAX_FILES) return { error: `An update may change at most ${MAX_FILES} files.` };
  const out = [];
  const seen = new Set();
  for (const file of files) {
    const path = String(file?.path || '').trim();
    const content = typeof file?.content === 'string' ? file.content : null;
    if (!/^lib\/[A-Za-z0-9_\/]+\.dart$/.test(path) || path.includes('..') || path.includes('//')) {
      return { error: `Only Dart files under lib/ can be self-updated (${path || 'missing path'}).` };
    }
    if (content === null) return { error: `${path} has no content.` };
    if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) return { error: `${path} is too large.` };
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

async function deleteFile(env, branch, path, message, fetcher) {
  const existing = await gh(env, 'GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`, null, fetcher);
  if (existing.status === 404) return {}; // already gone
  if (!existing.ok) return { error: `Could not read ${path} (${existing.status}).` };
  const del = await gh(env, 'DELETE', `/contents/${path}`, { message, sha: existing.data.sha, branch }, fetcher);
  return del.ok ? {} : { error: `Could not remove ${path} (${del.status}).` };
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

// Opens a PR restoring every file the last merged CHE update changed.
export async function rollbackLastUpdate(env, fetcher = fetch) {
  if (!repoOf(env)) return { status: 503, detail: 'Self-update is not connected to GitHub.' };
  const list = await gh(env, 'GET', '/pulls?state=closed&per_page=50&sort=updated&direction=desc', null, fetcher);
  const last = (Array.isArray(list.data) ? list.data : [])
    .find((pr) => pr.merged_at && String(pr.head?.ref || '').startsWith(BRANCH_PREFIX));
  if (!last) return { status: 404, detail: 'No merged CHE update to roll back.' };
  const files = await gh(env, 'GET', `/pulls/${last.number}/files?per_page=100`, null, fetcher);
  if (!files.ok) return { status: 502, detail: 'Could not read the update’s files.' };
  const base = await baseBranch(env, fetcher);
  const branch = `che/rollback-${last.number}-${Date.now().toString(36)}`;
  const made = await createBranch(env, branch, base, fetcher);
  if (made.error) return { status: 502, detail: made.error };
  const beforeSha = last.base.sha;
  for (const file of files.data) {
    const message = `Roll back CHE update #${last.number}: ${file.filename}`;
    if (file.status === 'added') {
      const removed = await deleteFile(env, branch, file.filename, message, fetcher);
      if (removed.error) return { status: 502, detail: removed.error };
      continue;
    }
    const old = await gh(env, 'GET', `/contents/${file.previous_filename || file.filename}?ref=${beforeSha}`, null, fetcher);
    if (!old.ok || typeof old.data?.content !== 'string') return { status: 502, detail: `Could not read the old ${file.filename}.` };
    const text = new TextDecoder().decode(Uint8Array.from(atob(old.data.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
    const wrote = await putFile(env, branch, file.previous_filename || file.filename, text, message, fetcher);
    if (wrote.error) return { status: 502, detail: wrote.error };
  }
  const pr = await gh(env, 'POST', '/pulls', {
    title: `Roll back CHE update #${last.number}`,
    head: branch,
    base,
    body: `Restores the files changed by #${last.number} to their state before it merged. Requested from the CHE app.`,
  }, fetcher);
  if (!pr.ok) return { status: 502, detail: `Could not open the rollback pull request (${pr.status}).` };
  return { status: 200, number: pr.data.number, url: pr.data.html_url, rolls_back: last.number };
}

export const CHE_UPDATE_GUIDE = `When the owner explicitly asks you to change your own app (a new screen, fix, or feature in CHE's Flutter code), reply with a short plain explanation and ONE fenced block tagged che-update containing strict JSON:
\`\`\`che-update
{"summary": "What changes and why, in 1-3 sentences.", "files": [{"path": "lib/some_file.dart", "content": "COMPLETE file contents"}]}
\`\`\`
Rules: only Dart files under lib/; always complete files, never partial snippets or "rest unchanged"; at most 12 files; no secrets. Native iOS changes, new packages, entitlements or Info.plist are NOT possible this way. Say they need a full rebuild. Nothing ships until the owner approves the card, CI passes and the PR is merged.`;
