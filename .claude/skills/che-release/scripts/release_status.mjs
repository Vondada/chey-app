#!/usr/bin/env node
// Read-only release status for Vondada/chey-app: a PR or commit's checks, the
// merge, the Worker deploy and what it verified live, the Shorebird patch and
// the newest iPhone IPA release. One command, compact output. It never
// merges, deploys, dispatches or publishes anything.
//
//   release_status.mjs [--pr N | --sha SHA] [--json]
//
// Anything it could not read is printed as UNKNOWN, never as success.
const REPO = 'Vondada/chey-app';
const API = 'https://api.github.com';
const LIVE = 'https://chey-app.henryjavoni.workers.dev/health';
// Fails on every PR branch by design; the owner skips it (2026-10-08).
const NON_GATING = new Set(['Workers Builds: chey-app']);
const DEPLOY_STEPS = {
  live_commit: /^Verify live deployed commit$/,
  memory_probe: /memory truth/i,
  voice_probe: /ElevenLabs voice through the live Worker/i,
};

async function getJson(fetcher, url, headers = {}, as = 'json') {
  try {
    let response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', ...headers }, signal: AbortSignal.timeout(15000) });
    // A stale or placeholder token: public data is still readable without it.
    if (response.status === 401 && headers.Authorization) {
      const { Authorization, ...rest } = headers;
      response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', ...rest }, signal: AbortSignal.timeout(15000) });
    }
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return { data: as === 'text' ? await response.text() : await response.json() };
  } catch (error) {
    return { error: error?.name === 'TimeoutError' ? 'timed out' : (error?.message || 'network error') };
  }
}

export async function releaseStatus({ pr = null, sha = null, fetcher = fetch, token = process.env.GITHUB_TOKEN || '' } = {}) {
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const gh = (path) => getJson(fetcher, `${API}/repos/${REPO}${path}`, auth);
  const out = { repo: REPO, unknown: [] };
  const unknown = (what, why) => out.unknown.push(`${what}: ${why}`);

  // The "sha" media type returns the bare SHA instead of the whole commit diff.
  const main = await getJson(fetcher, `${API}/repos/${REPO}/commits/main`, { ...auth, Accept: 'application/vnd.github.sha' }, 'text');
  if (main.error) unknown('main head', main.error);
  out.main_sha = /^[0-9a-f]{40}$/.test(String(main.data || '').trim()) ? String(main.data).trim() : null;
  if (!main.error && !out.main_sha) unknown('main head', 'unexpected response');

  // Workflow runs are looked up by full SHA, and /health reports 12 characters:
  // expand an abbreviation first, or a live match reads as a mismatch.
  if (sha && sha.length < 40) {
    const full = await getJson(fetcher, `${API}/repos/${REPO}/commits/${sha}`, { ...auth, Accept: 'application/vnd.github.sha' }, 'text');
    const value = String(full.data || '').trim();
    if (!full.error && /^[0-9a-f]{40}$/.test(value)) sha = value;
    else { unknown(`commit ${sha}`, full.error || 'not found'); sha = null; }
  }

  if (pr) {
    const p = await gh(`/pulls/${pr}`);
    if (p.error) unknown(`PR #${pr}`, p.error);
    else out.pr = {
      number: pr, title: p.data.title, state: p.data.state, merged: Boolean(p.data.merged), draft: Boolean(p.data.draft),
      head_sha: p.data.head?.sha, merge_sha: p.data.merge_commit_sha, mergeable_state: p.data.mergeable_state,
    };
  }
  const head = out.pr?.head_sha || sha || out.main_sha;
  if (head) {
    const checks = await gh(`/commits/${head}/check-runs?per_page=100`);
    if (checks.error) unknown('checks', checks.error);
    else {
      const runs = checks.data.check_runs || [];
      out.checks = {
        sha: head,
        gating: runs.filter((r) => !NON_GATING.has(r.name)).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })),
        non_gating: runs.filter((r) => NON_GATING.has(r.name)).map((r) => ({ name: r.name, conclusion: r.conclusion })),
      };
      const gating = out.checks.gating;
      out.checks.verdict = !gating.length ? 'NONE'
        : gating.some((r) => r.status !== 'completed') ? 'PENDING'
          : gating.every((r) => ['success', 'skipped', 'neutral'].includes(r.conclusion)) ? 'GREEN' : 'RED';
    }
  }

  // What production should run: the PR's merge commit, else the given SHA, else main.
  const target = (out.pr?.merged && out.pr.merge_sha) || sha || out.main_sha;
  out.target_sha = target;
  if (target) {
    const runs = await gh(`/actions/runs?head_sha=${target}&per_page=50`);
    if (runs.error) unknown('workflow runs', runs.error);
    else {
      const byName = (name) => (runs.data.workflow_runs || []).find((r) => r.name === name);
      const brief = (r) => (r ? { id: r.id, status: r.status, conclusion: r.conclusion, url: r.html_url } : null);
      out.runs = {
        deploy: brief(byName('Deploy CHE Worker')),
        shorebird: brief(byName('CHE Shorebird')),
        ipa: brief(byName('CHE iPhone IPA')),
        ipa_release: brief(byName('CHE IPA public release')),
      };
      const deploy = out.runs.deploy;
      if (deploy && deploy.status === 'completed') {
        const jobs = await gh(`/actions/runs/${deploy.id}/jobs`);
        if (jobs.error) unknown('deploy steps', jobs.error);
        else {
          const steps = (jobs.data.jobs || []).flatMap((j) => j.steps || []);
          const step = (re) => steps.find((s) => re.test(s.name))?.conclusion || null;
          out.deploy = Object.fromEntries(Object.entries(DEPLOY_STEPS).map(([k, re]) => [k, step(re)]));
          const job = (jobs.data.jobs || [])[0];
          if (job) {
            const notes = await gh(`/check-runs/${job.id}/annotations`);
            if (!notes.error) {
              // Only CHE's own notices (the deploy writes them); runner and
              // action-version notices are noise here.
              out.deploy.notices = (notes.data || [])
                .filter((a) => a.annotation_level === 'notice' && /^(?:Live CHE commit|Memory truth|CHE voice)/i.test(a.title || ''))
                .map((a) => `${a.title ? `${a.title}: ` : ''}${a.message}`.slice(0, 300));
              out.deploy.errors = (notes.data || []).filter((a) => a.annotation_level === 'failure').map((a) => `${a.title}: ${a.message}`.slice(0, 300));
            }
          }
        }
      }
    }
  }

  const releases = await gh('/releases?per_page=30');
  if (releases.error) unknown('releases', releases.error);
  else {
    // Newest published iPhone release (drafts and pre-publish uploads skipped).
    const ios = (releases.data || [])
      .filter((r) => /^che-ios-v/.test(r.tag_name || '') && !r.draft && r.published_at)
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
    const ipa = ios?.assets?.find((a) => /\.ipa$/i.test(a.name));
    out.ipa = ios ? {
      tag: ios.tag_name, published_at: ios.published_at, draft: ios.draft,
      asset: ipa ? { name: ipa.name, bytes: ipa.size, sha256: String(ipa.digest || '').replace(/^sha256:/, '') || null } : null,
    } : null;
  }

  // The live Worker itself; dev sandboxes may not be allowed to reach it.
  const live = await getJson(fetcher, LIVE);
  out.live = live.error ? { reachable: false, reason: live.error } : { reachable: true, ok: live.data?.ok === true, version_tag: live.data?.version_tag || null };
  return out;
}

export function formatStatus(s) {
  const short = (x) => (x ? String(x).slice(0, 12) : 'UNKNOWN');
  const run = (r) => (r ? `${r.status === 'completed' ? r.conclusion : r.status} (run ${r.id})` : 'no run for this commit');
  const lines = [];
  if (s.pr) lines.push(`PR #${s.pr.number} "${s.pr.title}": ${s.pr.merged ? `MERGED as ${short(s.pr.merge_sha)}` : `${s.pr.state}${s.pr.draft ? ', draft' : ''}, mergeable_state=${s.pr.mergeable_state}`}`);
  if (s.checks) {
    lines.push(`checks on ${short(s.checks.sha)}: ${s.checks.verdict}`);
    for (const c of s.checks.gating.filter((c) => !['success', 'skipped', 'neutral'].includes(c.conclusion))) lines.push(`  - ${c.name}: ${c.status === 'completed' ? c.conclusion : c.status}`);
    if (s.checks.non_gating.length) lines.push(`  (non-gating: ${s.checks.non_gating.map((c) => `${c.name}=${c.conclusion}`).join(', ')})`);
  }
  lines.push(`main: ${short(s.main_sha)}${s.target_sha && s.main_sha && s.target_sha !== s.main_sha ? ` (target ${short(s.target_sha)})` : ''}`);
  if (s.runs) {
    lines.push(`deploy: ${run(s.runs.deploy)}`);
    if (s.deploy) {
      const v = s.deploy.live_commit;
      lines.push(`  live commit check: ${v === 'success' ? `VERIFIED ${short(s.target_sha)} is live` : v ? `${v.toUpperCase()} (not verified)` : 'UNKNOWN'}`);
      lines.push(`  memory probe: ${s.deploy.memory_probe || 'UNKNOWN'}; voice probe: ${s.deploy.voice_probe || 'UNKNOWN'}`);
      for (const n of s.deploy.notices || []) lines.push(`  note: ${n}`);
      for (const e of s.deploy.errors || []) lines.push(`  error: ${e}`);
    } else if (s.runs.deploy?.status === 'completed') lines.push('  live commit check: UNKNOWN (steps unreadable)');
    lines.push(`shorebird: ${run(s.runs.shorebird)}; ipa build: ${run(s.runs.ipa)}; ipa release: ${run(s.runs.ipa_release)}`);
  }
  if (s.ipa) lines.push(`newest IPA release: ${s.ipa.tag} (${s.ipa.published_at || 'unpublished'})${s.ipa.asset ? ` ${s.ipa.asset.name} ${s.ipa.asset.bytes} bytes sha256 ${s.ipa.asset.sha256 || 'UNKNOWN'}` : ' — no .ipa asset'}`);
  lines.push(`/health from here: ${s.live.reachable ? `version_tag ${s.live.version_tag || 'UNKNOWN'}${s.live.version_tag && s.target_sha ? (s.target_sha.startsWith(s.live.version_tag) ? ' (matches target)' : ' (DOES NOT match target)') : ''}` : `not reachable (${s.live.reason}); rely on the deploy's live commit check`}`);
  for (const u of s.unknown) lines.push(`UNKNOWN ${u}`);
  lines.push('iPhone: not verifiable from here; only the owner\'s device can confirm installed behavior.');
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Behind an HTTPS proxy (Claude Code cloud sandboxes), Node's fetch only
  // uses it when NODE_USE_ENV_PROXY is set at start-up: run again with it.
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    const { spawnSync } = await import('node:child_process');
    const again = spawnSync(process.execPath, ['--no-warnings', ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
    process.exit(again.status ?? 2);
  }
  const argv = process.argv.slice(2);
  const val = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const pr = val('--pr') ? Number(val('--pr')) : null;
  const sha = val('--sha');
  if ((val('--pr') && !Number.isInteger(pr)) || (sha && !/^[0-9a-f]{7,40}$/i.test(sha))) {
    console.error('usage: release_status.mjs [--pr N | --sha SHA] [--json]');
    process.exit(2);
  }
  const status = await releaseStatus({ pr, sha });
  console.log(argv.includes('--json') ? JSON.stringify(status, null, 2) : formatStatus(status));
  process.exit(status.unknown.some((u) => /^main head/.test(u)) ? 2 : 0);
}
