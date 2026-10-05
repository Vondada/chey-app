import test from 'node:test';
import assert from 'node:assert/strict';
import { appBuildIntent, appBuildRun, dispatchAppBuild, speakAppBuild } from './app_builds.js';

const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
const reply = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });

test('app build intents: patch, full build and status; build/coding requests and negations are not builds', () => {
  for (const q of ['update my phone', 'CHE, update my app', 'send the app update to my phone', 'push the latest app update', 'patch my iPhone']) assert.equal(appBuildIntent(q)?.mode, 'patch', q);
  for (const q of ['build a new iPhone app', 'build me a new iphone build', 'rebuild the iPhone app', 'start a new iPhone build']) assert.equal(appBuildIntent(q)?.mode, 'release', q);
  for (const q of ['app build status', 'is the app build done yet?', "how's the iphone build going"]) assert.equal(appBuildIntent(q)?.mode, 'status', q);
  for (const q of ['update your app to show the time', 'build me an app for recipes', "don't update my phone", 'update my calendar', 'build a new iPhone app that tracks my runs']) assert.equal(appBuildIntent(q), null, q);
});

test('dispatch starts the existing workflow on main with the right inputs, and reports refusals honestly', async () => {
  const calls = [];
  const ok = await dispatchAppBuild(env, 'patch', async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return reply(null, 204); });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/actions/workflows/che-shorebird.yml/dispatches');
  assert.deepEqual(calls[0].body, { ref: 'main', inputs: { mode: 'patch' } });
  await dispatchAppBuild(env, 'release', async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return reply(null, 204); });
  assert.deepEqual(calls[1], { url: 'https://api.github.com/repos/o/r/actions/workflows/che-iphone-ipa.yml/dispatches', body: { ref: 'main' } });
  const refused = await dispatchAppBuild(env, 'patch', async () => reply({ message: 'Resource not accessible by integration' }, 403));
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /403: Resource not accessible/);
  assert.equal((await dispatchAppBuild({}, 'patch')).ok, false);
});

test('a build is reported shipped only when the run AND its ship step succeeded', async () => {
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const run = (extra) => ({ id: 9, html_url: 'run9', head_sha: 'abcdef1234', created_at: new Date().toISOString(), status: 'completed', conclusion: 'success', ...extra });
  const fake = (runObj, steps) => async (url) => (String(url).includes('/jobs') ? reply({ jobs: [{ steps }] }) : reply({ workflow_runs: runObj ? [runObj] : [] }));
  assert.equal((await appBuildRun(env, 'patch', since, fake(null, []))).state, 'waiting');
  assert.equal((await appBuildRun(env, 'patch', since, fake(run({ status: 'in_progress', conclusion: null }), []))).state, 'running');
  const shipped = await appBuildRun(env, 'patch', since, fake(run(), [{ name: 'Shorebird patch', conclusion: 'success' }]));
  assert.equal(shipped.state, 'shipped');
  // Shorebird not configured: the run is green but the patch step was skipped.
  const skipped = await appBuildRun(env, 'patch', since, fake(run(), [{ name: 'Check Shorebird is configured', conclusion: 'success' }, { name: 'Shorebird patch', conclusion: 'skipped' }]));
  assert.equal(skipped.state, 'not_shipped');
  assert.match(speakAppBuild('patch', skipped), /SHOREBIRD_TOKEN repository secret is missing/);
  const failed = await appBuildRun(env, 'release', since, fake(run({ conclusion: 'failure' }), [{ name: 'Flutter analyze', conclusion: 'failure' }]));
  assert.deepEqual([failed.state, failed.failed_steps], ['failed', ['Flutter analyze']]);
  const plain = await appBuildRun(env, 'release', since, fake(run(), [{ name: 'Build unsigned iPhone app (plain, not patchable)', conclusion: 'success' }, { name: 'Upload CHE IPA', conclusion: 'success' }]));
  assert.deepEqual([plain.state, plain.patchable], ['shipped', false]);
  assert.match(speakAppBuild('release', plain), /cannot receive patches/);
  // An older run is never mistaken for the one CHE just started.
  assert.equal((await appBuildRun(env, 'patch', since, fake(run({ created_at: new Date(Date.now() - 3600_000).toISOString() }), []))).state, 'waiting');
});
