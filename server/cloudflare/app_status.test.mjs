import test from 'node:test';
import assert from 'node:assert/strict';
import { appStatusIntent, appStatusReport } from './self_update.js';
import { guardExecutionClaims } from './truth_layer.js';

const now = Date.parse('2026-10-23T01:00:00Z');
const sha = 'a'.repeat(40);
const runtime = { version_id: '878a33ff-f61c-44db-8537-e0b3645462ac', version_tag: sha.slice(0, 12) };
const client = { source: 'ios_bundle', version: '1.4.5678', build: '123456', checked_at: new Date(now).toISOString() };

test('status intents are read-only and leave software changes on existing approval routes', () => {
  for (const prompt of ['What version of CHE am I running?', 'What’s my installed build number?', 'What backend version are you connected to?', 'Open Settings and show my app version.', 'What GitHub commit is deployed?']) assert.ok(appStatusIntent(prompt), prompt);
  for (const prompt of ['Deploy a new version of CHE', 'Install app version 9', 'Build a version dashboard', 'Did you successfully deploy a change?', 'What commit added the app status tests?', 'What version of the CHE app added Rithmic?', 'What version was running when Rithmic was added?', 'What deployed commit added Rithmic?']) assert.equal(appStatusIntent(prompt), null, prompt);
});

test('current runtime and native device reports remain separate from deployment success', () => {
  const out = appStatusReport({ runtime, client, now });
  assert.equal(out.backend.deployment_id, runtime.version_id);
  assert.equal(out.backend.commit_tag, sha.slice(0, 12));
  assert.equal(out.backend.commit_sha, null, 'a short tag cannot become an invented full SHA');
  assert.equal(out.installed.build, '123456');
  assert.match(out.text, /does not prove that CHE deployed/);
  assert.equal(appStatusReport({ runtime: { ...runtime, version_tag: sha }, now }).backend.commit_sha, sha);
});

test('only a matching verified deployment lookup can expand a short tag to full SHA', () => {
  const deployment = { status: 200, found: true, production_version_verified: true, commit_sha: sha, conclusion: 'success', run_id: 42, workflow_url: 'https://github.com/Vondada/chey-app/actions/runs/42' };
  assert.equal(appStatusReport({ runtime, deployment, now }).backend.commit_sha, sha);
  assert.equal(appStatusReport({ runtime, deployment: { ...deployment, commit_sha: 'b'.repeat(40) }, now }).backend.commit_sha, null);
  assert.equal(appStatusReport({ runtime, deployment: { ...deployment, production_version_verified: false }, now }).backend.commit_sha, null);
});

test('missing, stale and malformed native data never substitutes latest release metadata', () => {
  for (const bad of [null, { ...client, source: 'model' }, { ...client, checked_at: '2020-01-01T00:00:00Z' }, { ...client, checked_at: new Date(now + 60000).toISOString() }, { ...client, build: 'unknown' }]) {
    const out = appStatusReport({ client: bad, now });
    assert.equal(out.installed, null);
    assert.match(out.text, /no fresh native iOS bundle report/);
    assert.equal(out.backend.deployment_id, null);
  }
});

test('status access never turns a fabricated execution transcript into evidence', () => {
  const fake = 'I successfully executed gh api /repos/Vondada/chey-app/pulls/356. Commit 1234567890abcdef is deployed.';
  const out = guardExecutionClaims(fake, { receipts: [{ tool: 'github', status: 'success', invocation_id: 'model-invented' }] });
  assert.doesNotMatch(out.text, /1234567890abcdef|successfully executed/);
  assert.match(out.text, /cannot verify/);
});
