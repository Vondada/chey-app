// CHE builds and ships her own iPhone app through the repository's existing
// GitHub Actions workflows (no new build system):
//   patch   -> che-shorebird.yml (mode patch): Dart changes reach the phone
//              the next time the owner closes and reopens CHE.
//   release -> che-iphone-ipa.yml: a full unsigned IPA to install with
//              SideStore (needed for native/package changes).
// Owner-only. Deterministic: no model calls. A build is only reported as
// shipped when the workflow run and its real ship step succeeded.

import { gh } from './coding_runtime.js';

export const APP_BUILD_KEY = 'che_app_build';
export const APP_BUILD_WORKFLOWS = Object.freeze({
  patch: { file: 'che-shorebird.yml', inputs: { mode: 'patch' }, ship_step: 'Shorebird patch', label: 'app update' },
  release: { file: 'che-iphone-ipa.yml', inputs: null, ship_step: 'Upload CHE IPA', label: 'new iPhone app build' },
});

/** "update my phone" / "build a new iPhone app" / "app build status". */
export function appBuildIntent(message) {
  const text = String(message || '').trim().replace(/^(?:che|chay|chey|shay)[,:]?\s*/i, '').replace(/[.!?]+$/, '');
  if (!text || text.length > 120) return null;
  if (/\b(?:don'?t|do\s+not|never|without)\b/i.test(text)) return null;
  if (/^(?:what(?:'s| is)\s+the\s+)?(?:app|iphone|phone)\s+build\s+status$|^(?:is|did)\s+(?:the|my)\s+(?:app|iphone|phone)\s+(?:build|update)\s+(?:done|ready|finished|finish|work)(?:\s+yet)?$|^how(?:'s| is)\s+(?:the|my)\s+(?:app|iphone|phone)\s+(?:build|update)(?:\s+going)?$/i.test(text)) return { mode: 'status' };
  if (/^(?:please\s+)?(?:(?:build|make|create)\s+(?:me\s+)?(?:a\s+)?(?:new|fresh|full)\s+(?:iphone|ios|phone)\s+(?:app|build|ipa)|(?:build|rebuild)\s+(?:the|my)\s+(?:iphone|ios|phone)\s+app|(?:start|run)\s+(?:a|the)\s+(?:new\s+|full\s+)?(?:iphone|ios|ipa)\s+build)$/i.test(text)) return { mode: 'release' };
  if (/^(?:please\s+)?(?:(?:send|push|ship|deliver)\s+(?:the|my|an?)\s+(?:latest\s+)?(?:app|phone|iphone)\s+(?:update|patch)(?:\s+to\s+my\s+phone)?|update\s+(?:the\s+app\s+on\s+)?my\s+(?:phone|iphone)|patch\s+my\s+(?:app|phone|iphone)|update\s+my\s+app)$/i.test(text)) return { mode: 'patch' };
  return null;
}

/** Starts the workflow on main. GitHub answers 204 with no run id. */
export async function dispatchAppBuild(env, mode, fetcher = fetch) {
  const spec = APP_BUILD_WORKFLOWS[mode];
  if (!spec) return { ok: false, detail: 'Unknown build type.' };
  if (!env?.CHE_GITHUB_TOKEN || !env?.CHE_GITHUB_REPO) return { ok: false, detail: 'GitHub is not connected, so I cannot start builds.' };
  const sent = await gh(env, 'POST', `/actions/workflows/${spec.file}/dispatches`, { ref: 'main', ...(spec.inputs ? { inputs: spec.inputs } : {}) }, fetcher);
  if (sent.status === 204 || sent.ok) return { ok: true, workflow: spec.file };
  return { ok: false, status: sent.status, detail: `GitHub refused the build (${sent.status || 'network'}${sent.data?.message ? `: ${String(sent.data.message).slice(0, 120)}` : ''}).` };
}

/**
 * The run for a build CHE started: the newest dispatch run of that workflow
 * created at or after `since`. Reads the jobs so a run that skipped its ship
 * step (Shorebird not configured) is never reported as shipped.
 */
export async function appBuildRun(env, mode, since, fetcher = fetch) {
  const spec = APP_BUILD_WORKFLOWS[mode];
  const runs = await gh(env, 'GET', `/actions/workflows/${spec.file}/runs?event=workflow_dispatch&branch=main&per_page=5`, null, fetcher);
  if (!runs.ok) return { state: 'unknown', detail: `GitHub did not answer (${runs.status || 'network'}).` };
  const sinceMs = Date.parse(since || 0) - 60_000;
  const run = (runs.data?.workflow_runs || []).find((r) => Date.parse(r.created_at || 0) >= sinceMs);
  if (!run) return { state: 'waiting' };
  const base = { run_id: run.id, html_url: run.html_url || '', sha: String(run.head_sha || '').slice(0, 7) };
  if (run.status !== 'completed') return { ...base, state: 'running' };
  if (run.conclusion !== 'success') {
    const jobs = await gh(env, 'GET', `/actions/runs/${run.id}/jobs`, null, fetcher);
    const failed = (jobs.data?.jobs || []).flatMap((j) => (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name));
    return { ...base, state: 'failed', conclusion: run.conclusion, failed_steps: failed.slice(0, 3) };
  }
  const jobs = await gh(env, 'GET', `/actions/runs/${run.id}/jobs`, null, fetcher);
  const steps = (jobs.data?.jobs || []).flatMap((j) => j.steps || []);
  const ship = steps.find((s) => s.name === spec.ship_step || (mode === 'release' && /^Upload CHE IPA/.test(s.name)));
  if (!ship || ship.conclusion !== 'success') return { ...base, state: 'not_shipped' };
  // A full build is patchable only when it was built as a Shorebird release.
  const patchable = mode === 'release' ? steps.some((s) => /Shorebird release/.test(s.name) && s.conclusion === 'success') : true;
  return { ...base, state: 'shipped', patchable };
}

const SETUP = 'Shorebird is not set up yet: the SHOREBIRD_TOKEN repository secret is missing. That secret is yours to add in GitHub; until then app changes need a full iPhone build.';

export function speakAppBuild(mode, result) {
  const spec = APP_BUILD_WORKFLOWS[mode] || APP_BUILD_WORKFLOWS.patch;
  switch (result?.state) {
    case 'shipped':
      return mode === 'patch'
        ? 'Your app update is ready, sir. Close and reopen me to get it.'
        : `The new iPhone app build finished, sir. Install CHE from the latest "CHE iPhone IPA" run with SideStore.${result.patchable ? '' : ' This build cannot receive patches, because Shorebird is not set up.'}`;
    case 'not_shipped':
      return mode === 'patch' ? `The update run finished but nothing was shipped, sir. ${SETUP}` : 'The iPhone build finished, but no app file was produced, sir.';
    case 'failed':
      return `The ${spec.label} failed, sir${result.failed_steps?.length ? `, at: ${result.failed_steps.join(', ')}` : ''}. Your phone keeps the version it has.`;
    case 'running':
      return `The ${spec.label} is still building, sir.`;
    case 'waiting':
      return `The ${spec.label} is queued on GitHub, sir.`;
    default:
      return `I could not check the ${spec.label} right now, sir.`;
  }
}
