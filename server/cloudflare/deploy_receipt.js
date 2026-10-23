// Commit and deployment receipts (owner, 2026-10-23): "what changed in commit X", "what can I test on
// my iPhone", "verify the deployment", "is the latest commit live". Every claim comes from GitHub's API,
// the running Worker's own CF_VERSION_METADATA or the phone's own report, and carries the URL it came
// from. Missing evidence is named, never filled in. Three separate answers: what the commit changed,
// whether the backend runs it, and whether this iPhone has it.

import { latestWorkerDeploymentIntent } from './self_update.js';

const TTL_MS = 60_000;
const cache = new Map();
// A commit SHA token; a UUID's segments (Worker version ids) are joined by hyphens and never count.
const HEX = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/i;

const DEPLOY_WF = /che-worker-deploy\.yml$/;
const SHOREBIRD_WF = /che-shorebird\.yml$/;
const IPA_WF = /che-iphone-ipa\.yml$/;

const norm = (s) => String(s || '').replace(/[’]/g, "'").trim().toLowerCase()
  .replace(/^(?:(?:hey|hi|ok|okay)\s+)?(?:che|chay|chey)[, :]+/, '').replace(/[.!?]+$/, '');

const CHANGE_ASK = /\bwhat(?:'s| is| was)? (?:changed|new|in)\b|\bwhat did (?:it|that|this|the commit|commit \S+) change\b|\bchanges? (?:in|from|made)\b|\bchanged in\b|\bsummar(?:y|ize|ise)\b/;
const TEST_ASK = /\bwhat (?:can|should|do) i test\b|\bwhat(?:'s| is) (?:there )?to test\b|\btest(?:able)? on (?:my|the) (?:iphone|phone)\b/;
const VERIFY_ASK = /\b(?:verify|confirm|check)\b[\s\S]{0,40}\bdeploy(?:ment|ed)?\b(?![\s\S]{0,30}\b(?:website|site|vercel|netlify|app store|testflight)\b)|\bis (?:the latest |the |this |that )?(?:commit|change|sha|[0-9a-f]{7,40})\b[\s\S]{0,30}\blive\b|\bwas (?:the (?:latest |last )?commit|commit \S+|this commit|that commit|[0-9a-f]{7,40}) deployed\b|\bdeployment receipt\b/;
// "Is it live", "was it deployed": only right after a commit came up in the conversation.
const PRONOUN_VERIFY = /\b(?:is|was) (?:it|that|this) (?:deployed|live)\b/;
const COMMIT_REF = /\bcommit\b|\bsha\b|\b[0-9a-f]{7,40}\b/;
const LATEST = /\b(?:latest|last|newest|most recent|current) (?:commit|change|merge)\b/;
const THAT_STRICT = /\b(?:that|this|the same) (?:commit|change|merge|update)\b/;
const PRONOUN = /\bfrom (?:it|that)\b|\b(?:it|that|this)\b/;

const recentSha = (history) => shaFromHistory((Array.isArray(history) ? history : []).slice(-2));

/** The last full or short SHA said in the conversation, newest first (owner or CHE turns). */
export function shaFromHistory(history = []) {
  for (const turn of [...(Array.isArray(history) ? history : [])].reverse()) {
    const text = String(turn?.content ?? turn?.text ?? '');
    const all = text.match(/(?<![\w-])[0-9a-f]{7,40}(?![\w-])/gi) || [];
    const sha = all.reverse().find((s) => /[a-f]/i.test(s) && /\d/.test(s));
    if (sha) return sha.toLowerCase();
  }
  return null;
}

/**
 * { changes, test, verify, ref } when the owner asks what a commit changed, what to test, or whether it is
 * deployed/live; null otherwise. `ref` is a SHA, 'main' (latest) or null (no commit could be resolved).
 */
export function commitIntent(message, history = []) {
  const t = norm(message);
  if (!t || /^(?:fix|change|implement|deploy|revert|roll ?back|merge|build|start|run|create|open)\b/.test(t)) return null;
  // "Check GitHub Actions for the latest Worker deployment" keeps its own route (latest deploy run).
  if (latestWorkerDeploymentIntent(message)) return null;
  const hasRef = COMMIT_REF.test(t) || LATEST.test(t) || THAT_STRICT.test(t) || (PRONOUN.test(t) && Boolean(recentSha(history)));
  const changes = CHANGE_ASK.test(t) && hasRef;
  const test = TEST_ASK.test(t) && (hasRef || Boolean(recentSha(history)));
  const verify = VERIFY_ASK.test(t) || (PRONOUN_VERIFY.test(t) && Boolean(recentSha(history)));
  const latestCommit = /^(?:what(?:'s| is| was)|which|show me|tell me|give me)\b[\s\S]{0,20}\b(?:latest|last|newest|most recent) commit\b/.test(t);
  if (!changes && !test && !verify && !latestCommit) return null;
  const explicit = t.match(HEX);
  const ref = explicit && /[a-f]/.test(explicit[0]) ? explicit[0]
    : LATEST.test(t) || latestCommit ? 'main'
      : shaFromHistory(history) || (verify ? 'main' : null);
  return { changes: changes || latestCommit || (test && !verify), test, verify: verify || test, ref };
}

async function ghGet(env, path, fetcher) {
  const repo = String(env?.CHE_GITHUB_REPO || '').trim();
  if (!repo || !env?.CHE_GITHUB_TOKEN) return { ok: false, status: 0, reason: 'no_token' };
  const key = `${repo}${path}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let response;
  try {
    response = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
      headers: { Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CHE-Agent' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    return { ok: false, status: 0, reason: /timeout|abort/i.test(String(error?.name || error)) ? 'timeout' : 'network' };
  }
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  const limited = (response.status === 403 || response.status === 429) && (response.headers?.get?.('x-ratelimit-remaining') === '0' || /rate limit/i.test(String(data?.message || '')));
  const value = response.ok ? { ok: true, status: response.status, data }
    : { ok: false, status: response.status, reason: limited ? 'rate_limited' : response.status === 404 || response.status === 422 ? 'not_found' : 'http' };
  if (value.ok) cache.set(key, { at: Date.now(), value });
  return value;
}

const WHY = {
  no_token: 'CHE has no GitHub access configured (CHE_GITHUB_TOKEN / CHE_GITHUB_REPO), so nothing was read from GitHub',
  rate_limited: 'GitHub refused the request: the API rate limit is used up',
  not_found: 'GitHub has no such commit in this repository',
  timeout: 'GitHub did not answer within 8 seconds',
  network: 'the connection to GitHub failed',
  http: 'GitHub returned an error',
};
const why = (r, what) => `${what}: ${WHY[r?.reason] || WHY.http}${r?.status ? ` (HTTP ${r.status})` : ''}.`;

// Changed paths → what the owner can see on the iPhone. Derived from file paths only; labelled so.
const AREAS = [
  [/^lib\/rooms\/che_trading|^lib\/trading\//, 'Trading Room'],
  [/^lib\/rithmic\//, 'Rithmic connection screen'],
  [/^lib\/self_update\/|^lib\/che_ui\/che_response_details/, 'app version, updates and app details'],
  [/^lib\/home_state\/|^lib\/main\.dart$/, 'chat (sending, replies, voice routing)'],
  [/^lib\/brain\/|^lib\/home\/che_memory/, 'Brain'],
  [/^lib\/security\//, 'Security page'],
  [/^lib\/workflows\//, 'Workflows page'],
  [/^lib\/visual\//, 'Visual Studio'],
  [/^lib\/rooms\//, 'rooms'],
  [/^lib\//, 'app screens'],
  [/^server\/cloudflare\/(?:self_update|deploy_receipt)\.js$/, 'answers about versions, commits and deployments'],
  [/^server\/cloudflare\/.*(?:memory|recall|brain)/, 'memory answers'],
  [/^server\/cloudflare\/.*trading/, 'trading answers'],
  [/^server\/cloudflare\/(?!.*\.test\.)/, 'CHE backend answers'],
  [/^(?:ios|native)\//, 'native iPhone code'],
];
const isTest = (f) => /(?:^|\/)test\/|\.test\.|_test\.dart$|^tools\/test_/.test(f);
const isDoc = (f) => /\.md$|^docs\//.test(f);

export function testableFrom(files = []) {
  const paths = files.map((f) => String(f.filename || f));
  const code = paths.filter((f) => !isTest(f) && !isDoc(f));
  const areas = [];
  for (const f of code) {
    const hit = AREAS.find(([re]) => re.test(f));
    const label = hit ? hit[1] : null;
    if (label && !areas.includes(label)) areas.push(label);
  }
  return {
    areas,
    app: code.some((f) => /^lib\/|^pubspec|^assets\//.test(f)),
    backend: code.some((f) => /^server\/cloudflare\//.test(f)),
    native: code.some((f) => /^(?:ios|native|macos)\//.test(f)),
    tests_only: paths.length > 0 && code.length === 0 && paths.some(isTest),
    docs_only: paths.length > 0 && paths.every(isDoc),
  };
}

const shortSha = (s) => String(s || '').slice(0, 12);

/** Did the Shorebird run publish a patch? Only the step result says; a green run can skip every step. */
async function shorebirdPublished(env, run, fetcher) {
  const jobs = await ghGet(env, `/actions/runs/${run.id}/jobs?per_page=20`, fetcher);
  if (!jobs.ok) return { known: false };
  const steps = (jobs.data?.jobs || []).flatMap((j) => j.steps || []);
  const step = steps.find((s) => /^shorebird (?:patch|release)\b/i.test(String(s.name || '')) && s.conclusion === 'success');
  return { known: true, published: Boolean(step), kind: step ? (/release/i.test(step.name) ? 'release' : 'patch') : null };
}

/**
 * The receipt. `runtime` is this Worker's own CF_VERSION_METADATA ({version_id, version_tag}); the Worker
 * answering IS the live Worker, so its tag is the live commit. `client` is the phone's own report.
 */
export async function commitReceipt(env, { ref = 'main', changes = true, verify = true, runtime = {}, client = null, fetcher = fetch } = {}) {
  const evidence = [];
  const missing = [];
  const receipt = { id: null, ref, commit: null, changes: null, testable: null, backend: null, iphone: null, evidence, missing };
  if (!ref) {
    missing.push('I could not tell which commit you mean: say its SHA, or "the latest commit".');
    return receipt;
  }
  const c = await ghGet(env, `/commits/${encodeURIComponent(ref)}`, fetcher);
  if (!c.ok) {
    missing.push(why(c, ref === 'main' ? 'The latest commit on main is unknown' : `Commit ${ref} could not be read`));
    return receipt;
  }
  const sha = String(c.data?.sha || '');
  const message = String(c.data?.commit?.message || '');
  const [title, ...bodyLines] = message.split('\n');
  // Stable evidence id the Brain and Chat link to: GET /api/evidence/commit/<sha> rebuilds this receipt.
  receipt.id = `commit:${sha}`;
  receipt.commit = { sha, title: title.trim(), date: String(c.data?.commit?.committer?.date || c.data?.commit?.author?.date || ''), url: String(c.data?.html_url || '') };
  if (receipt.commit.url) evidence.push({ claim: `commit ${shortSha(sha)}`, url: receipt.commit.url });

  if (changes) {
    const files = Array.isArray(c.data?.files) ? c.data.files : [];
    const pulls = await ghGet(env, `/commits/${sha}/pulls`, fetcher);
    const pr = pulls.ok && Array.isArray(pulls.data) ? pulls.data.find((p) => p.merged_at) || pulls.data[0] : null;
    if (!pulls.ok) missing.push(why(pulls, 'The pull request behind this commit is unknown'));
    if (pr?.html_url) evidence.push({ claim: `pull request #${pr.number}`, url: pr.html_url });
    // The commit message's own bullet lines (squash merges carry each commit's subject); quoted, never rewritten.
    const points = bodyLines.map((l) => l.replace(/^\s*[*-]\s+/, '').trim())
      .filter((l) => l && !/^(?:co-authored-by|claude-session|signed-off-by|-{3,})/i.test(l)).slice(0, 8);
    receipt.changes = {
      files: files.length, truncated: files.length >= 300, additions: Number(c.data?.stats?.additions || 0), deletions: Number(c.data?.stats?.deletions || 0),
      paths: files.slice(0, 40).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
      points, pr: pr ? { number: pr.number, title: String(pr.title || ''), url: String(pr.html_url || '') } : null,
    };
    receipt.testable = testableFrom(files);
  }

  if (verify || changes) {
    const runs = await ghGet(env, `/actions/runs?head_sha=${sha}&per_page=50`, fetcher);
    const list = runs.ok && Array.isArray(runs.data?.workflow_runs) ? runs.data.workflow_runs : [];
    if (!runs.ok) missing.push(why(runs, 'Workflow runs for this commit are unknown'));
    const pick = (re) => list.filter((r) => re.test(String(r.path || ''))).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    const deploy = pick(DEPLOY_WF);
    const shorebird = pick(SHOREBIRD_WF);
    const ipa = pick(IPA_WF);
    const state = (r) => !r ? 'none' : r.status !== 'completed' ? 'running' : String(r.conclusion || 'unknown');

    // Backend: the running Worker's own tag decides "live"; the workflow alone never does.
    const tag = /^[0-9a-f]{7,40}$/i.test(String(runtime?.version_tag || '')) ? String(runtime.version_tag).toLowerCase() : '';
    let live = 'unknown';
    let liveDetail = 'This Worker did not report its commit (CF_VERSION_METADATA.tag is empty), so live status is unverified.';
    if (tag && sha.startsWith(tag)) { live = 'live'; liveDetail = `The running Worker reports commit ${tag}: this commit is live.`; }
    else if (tag) {
      const cmp = await ghGet(env, `/compare/${sha}...${tag}`, fetcher);
      if (cmp.ok && cmp.data?.status === 'ahead') { live = 'included'; liveDetail = `The running Worker reports a newer commit, ${tag}, which includes this one.`; }
      else if (cmp.ok) { live = 'not_live'; liveDetail = `The running Worker reports commit ${tag}, which does not include this commit.`; }
      else { live = 'unknown'; liveDetail = `The running Worker reports commit ${tag}; ${why(cmp, 'whether it includes this commit is unknown').replace(/^\w/, (m) => m.toLowerCase())}`; }
    }
    const t = receipt.testable || testableFrom(Array.isArray(c.data?.files) ? c.data.files : []);
    receipt.backend = {
      needed: t.backend, run: deploy ? { id: deploy.id, state: state(deploy), url: deploy.html_url, at: deploy.updated_at } : null,
      worker_version_id: String(runtime?.version_id || ''), running_tag: tag, live, detail: liveDetail,
    };
    if (deploy?.html_url) evidence.push({ claim: `Deploy CHE Worker run ${deploy.id}`, url: deploy.html_url });

    let published = { known: false };
    if (shorebird && state(shorebird) === 'success') published = await shorebirdPublished(env, shorebird, fetcher);
    if (shorebird?.html_url) evidence.push({ claim: `CHE Shorebird run ${shorebird.id}`, url: shorebird.html_url });
    if (ipa?.html_url && state(ipa) !== 'skipped') evidence.push({ claim: `CHE iPhone IPA run ${ipa.id}`, url: ipa.html_url });
    const phone = client && client.source === 'ios_bundle' ? client : null;
    const patch = phone && /^\d{1,6}$/.test(String(phone.patch ?? '')) ? Number(phone.patch) : phone && phone.patch === 'none' ? 0 : null;
    receipt.iphone = {
      needed: t.app || t.native, native: t.native,
      shorebird: shorebird ? { id: shorebird.id, state: state(shorebird), url: shorebird.html_url, published: published.known ? published.published : null, kind: published.kind || null } : null,
      ipa: ipa ? { id: ipa.id, state: state(ipa), url: ipa.html_url } : null,
      device: phone ? { version: phone.version, build: phone.build, patch, checked_at: phone.checked_at } : null,
    };
    if (!phone) missing.push('Whether this iPhone has the update is unknown: the phone did not report its installed build and patch with this question.');
    else if (patch === null) missing.push('This iPhone reported its version and build but not its Shorebird patch number.');
    if (shorebird && state(shorebird) === 'success' && !published.known) missing.push('Whether the Shorebird run actually published a patch is unknown: its job steps could not be read.');
  }
  return receipt;
}

function when(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'an unknown time';
}

/** Spoken text, three labelled parts; every number is from the receipt. */
export function speakReceipt(r, { changes = true, verify = true } = {}) {
  const out = [];
  if (!r.commit) return r.missing.join(' ') || 'I could not read that commit.';
  out.push(`Commit ${shortSha(r.commit.sha)}, "${r.commit.title}", merged ${when(r.commit.date)}.`);
  if (changes && r.changes) {
    const ch = r.changes;
    out.push(`What changed, from GitHub's file list: ${ch.files}${ch.truncated ? '+' : ''} files, ${ch.additions} lines added and ${ch.deletions} removed${ch.pr ? `, from pull request ${ch.pr.number}, "${ch.pr.title}"` : ''}.`);
    if (ch.points.length) out.push(`The commit message lists: ${ch.points.slice(0, 5).join('; ')}.`);
    const t = r.testable;
    if (t?.docs_only) out.push('It only changed documentation, so there is nothing to test on the iPhone.');
    else if (t?.tests_only) out.push('It only changed tests, so there is nothing new to try on the iPhone.');
    else if (t?.areas.length) out.push(`What you can try, judging only from the changed file paths: ${t.areas.join(', ')}.${t.backend && !t.app ? ' These are backend changes: they work on your current app once the Worker runs this commit.' : ''}${t.app ? ' The app changes need the Shorebird update on your phone, then a full close and reopen.' : ''}${t.native ? ' Native iPhone code changed too, which needs a new app install, not a patch.' : ''}`);
  }
  if (verify && r.backend) {
    const b = r.backend;
    const run = b.run ? `Deploy CHE Worker run ${b.run.id} ${b.run.state === 'success' ? 'succeeded' : b.run.state === 'running' ? 'is still running' : `ended ${b.run.state}`}.`
      : b.needed ? 'No Deploy CHE Worker run exists for this commit.' : 'This commit did not change the Worker, so no deploy run was expected.';
    out.push(`Backend: ${run} ${b.detail}${b.worker_version_id ? ` Worker version ${b.worker_version_id}.` : ''}`);
  }
  if (verify && r.iphone) {
    const p = r.iphone;
    const sb = !p.shorebird ? (p.needed ? 'No Shorebird run exists for this commit.' : 'This commit did not change app code, so no iPhone update was needed.')
      : p.shorebird.state !== 'success' ? `Shorebird run ${p.shorebird.id} is ${p.shorebird.state}.`
        : p.shorebird.published === true ? `Shorebird run ${p.shorebird.id} published a ${p.shorebird.kind}.`
          : p.shorebird.published === false ? `Shorebird run ${p.shorebird.id} finished but published nothing.` : `Shorebird run ${p.shorebird.id} succeeded.`;
    const dev = p.device ? ` This iPhone reports version ${p.device.version}, build ${p.device.build}${p.device.patch === null ? ', patch unknown' : p.device.patch === 0 ? ', no Shorebird patch' : `, Shorebird patch ${p.device.patch}`}.` : ' Whether this iPhone has it is unknown: the phone did not report its patch.';
    out.push(`iPhone: ${sb}${dev} A successful run does not prove your phone installed it.`);
  }
  const extra = r.missing.filter((m) => !/did not report its (?:installed build|patch)/.test(m));
  if (extra.length) out.push(`Not verified: ${extra.join(' ')}`);
  return `Sir, ${out.join(' ')}`;
}

export function clearReceiptCache() { cache.clear(); }
