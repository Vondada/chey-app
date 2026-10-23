import assert from 'node:assert/strict';
import test from 'node:test';
import { clearReceiptCache, commitIntent, commitReceipt, shaFromHistory, speakReceipt, testableFrom } from './deploy_receipt.js';
import { appStatusIntent } from './self_update.js';

const SHA = 'f37bc3ac9315936e8d7e31aaa898611414629e40';
const NEWER = 'b7e42325f7c4a2df1d354e20178d04a46dd75cc1';
const env = { CHE_GITHUB_REPO: 'Vondada/chey-app', CHE_GITHUB_TOKEN: 'fixture' };

const ok = (data) => ({ ok: true, status: 200, json: async () => data, headers: { get: () => null } });
const commitData = {
  sha: SHA, html_url: `https://github.com/Vondada/chey-app/commit/${SHA}`,
  commit: { message: 'Retrieve app and backend versions before model verification guards [worker-deploy] (#473)\n\n* Answer app and backend status from native and runtime metadata\n* Keep installed-skill guard first in the offline bypass\n\nCo-Authored-By: Someone <x@y>', committer: { date: '2026-10-23T03:22:50Z' } },
  stats: { additions: 120, deletions: 8 },
  files: [
    { filename: 'server/cloudflare/self_update.js', status: 'modified', additions: 60, deletions: 4 },
    { filename: 'lib/home_state/streaming.dart', status: 'modified', additions: 30, deletions: 2 },
    { filename: 'test/che_app_status_test.dart', status: 'added', additions: 30, deletions: 2 },
  ],
};
const runs = (deploy = 'success', shorebird = 'success') => ({ workflow_runs: [
  { id: 39894698904, path: '.github/workflows/che-worker-deploy.yml', status: 'completed', conclusion: deploy, html_url: 'https://github.com/Vondada/chey-app/actions/runs/39894698904', created_at: '2026-10-23T03:22:51Z', updated_at: '2026-10-23T03:30:00Z' },
  { id: 39894699015, path: '.github/workflows/che-shorebird.yml', status: 'completed', conclusion: shorebird, html_url: 'https://github.com/Vondada/chey-app/actions/runs/39894699015', created_at: '2026-10-23T03:22:51Z' },
  { id: 39894699058, path: '.github/workflows/che-iphone-ipa.yml', status: 'completed', conclusion: 'skipped', html_url: 'https://github.com/Vondada/chey-app/actions/runs/39894699058', created_at: '2026-10-23T03:22:51Z' },
] });

function fakeGitHub({ deploy = 'success', compare = 'ahead', limited = false, patchStep = 'success' } = {}) {
  const calls = [];
  const fetcher = async (url) => {
    const u = String(url);
    calls.push(u);
    if (limited) return { ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }), headers: { get: (h) => (h === 'x-ratelimit-remaining' ? '0' : null) } };
    if (u.endsWith(`/commits/${SHA}/pulls`)) return ok([{ number: 473, title: 'Retrieve app and backend versions before model verification guards', html_url: 'https://github.com/Vondada/chey-app/pull/473', merged_at: '2026-10-23T03:22:50Z' }]);
    if (/\/commits\/(?:main|f37bc3ac)/.test(u)) return ok(commitData);
    if (u.includes('/actions/runs?head_sha=')) return ok(runs(deploy));
    if (u.includes('/actions/runs/39894699015/jobs')) return ok({ jobs: [{ steps: [{ name: 'Shorebird release (unsigned)', conclusion: 'skipped' }, { name: 'Shorebird patch', conclusion: patchStep }] }] });
    if (u.includes('/compare/')) return ok({ status: compare });
    return { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } };
  };
  return { fetcher, calls };
}

test('the owner\'s exact words reach the commit route, never the status answer', () => {
  const asks = [
    'What changed in commit f37bc3ac and what can I test on my iPhone?',
    'What changed in commit f37bc3ac9315936e8d7e31aaa898611414629e40?',
    'CHE, what\'s the latest commit?',
    'Summarize the latest commit',
    'Verify the deployment',
    'Is the latest commit live?',
  ];
  for (const ask of asks) {
    assert.ok(commitIntent(ask, []), ask);
    assert.equal(appStatusIntent(ask), null, `status must not take: ${ask}`);
  }
  const combined = commitIntent('What changed in commit f37bc3ac and what can I test on my iPhone?');
  assert.deepEqual([combined.changes, combined.test, combined.verify, combined.ref], [true, true, true, 'f37bc3ac']);
  assert.equal(commitIntent('Is the latest commit live?').ref, 'main');
});

test('"that commit" and "it" follow-ups resolve the last SHA in the conversation', () => {
  const history = [{ role: 'user', content: 'What changed in commit f37bc3ac?' }, { role: 'assistant', content: `Sir, Commit ${SHA.slice(0, 12)}, "Retrieve…".` }];
  assert.equal(commitIntent('What can I test on my iPhone from that commit?', history).ref, SHA.slice(0, 12));
  assert.equal(commitIntent('Is it live?', history).ref, SHA.slice(0, 12));
  assert.equal(shaFromHistory(history), SHA.slice(0, 12));
  // CHE's own reply names the Worker version UUID after the commit; its segments are not commits.
  assert.equal(shaFromHistory([{ role: 'assistant', content: `Commit ${SHA.slice(0, 12)} is live. Worker version 662e75ae-36c3-41fc-8120-1ea8dcdb7c09.` }]), SHA.slice(0, 12));
  // With nothing to resolve, a pronoun is not a commit question.
  assert.equal(commitIntent('Is it live?', []), null);
  assert.equal(commitIntent('What changed in that?', []), null);
});

test('an article link with a numeric path is not a commit: "summarize this article" stays off the commit route', () => {
  assert.equal(commitIntent('Summarize this article: https://www.technologyreview.com/2026/10/15/1123456/google-ai-beats-human-professionals-medical-imaging/'), null);
  assert.equal(commitIntent('What changed in 1123456?'), null);
  assert.ok(commitIntent('What changed in commit f37bc3ac?'));
});

test('real status questions keep the status route; unrelated version/build/deploy sentences take neither', () => {
  for (const ask of ['What version of CHE am I running?', 'What’s my installed build number?', 'What backend version are you connected to?', 'What GitHub commit is deployed?']) {
    assert.ok(appStatusIntent(ask), ask);
  }
  for (const ask of ['What version of Python should my project use?', 'Which version of the song is on my playlist?', 'What build should my character use?', 'Explain it to me', 'Is it live on YouTube?', 'Deploy CHE now', 'Fix the deployment receipts', 'Check if my website deployment on Vercel worked', 'What did you change in my Brain today?']) {
    assert.equal(appStatusIntent(ask), null, `status: ${ask}`);
    assert.equal(commitIntent(ask, []), null, `commit: ${ask}`);
  }
  // The existing GitHub Actions deploy-status route keeps its phrases.
  assert.equal(commitIntent('CHE, check GitHub Actions for your latest Worker deployment. Tell me the run ID.'), null);
});

test('live match: the running Worker\'s own tag equals the commit, with links for every claim', async () => {
  clearReceiptCache();
  const { fetcher } = fakeGitHub();
  const r = await commitReceipt(env, { ref: 'f37bc3ac', runtime: { version_tag: SHA.slice(0, 12), version_id: '662e75ae-36c3-41fc-8120-1ea8dcdb7c09' }, client: { source: 'ios_bundle', version: '1.4.1', build: '3956', patch: '7', checked_at: '2026-10-23T03:40:00Z' }, fetcher });
  assert.equal(r.backend.live, 'live');
  assert.equal(r.changes.pr.number, 473);
  assert.deepEqual(r.changes.points, ['Answer app and backend status from native and runtime metadata', 'Keep installed-skill guard first in the offline bypass']);
  assert.equal(r.iphone.shorebird.published, true);
  assert.equal(r.iphone.device.patch, 7);
  const urls = r.evidence.map((e) => e.url);
  for (const u of [commitData.html_url, 'https://github.com/Vondada/chey-app/pull/473', 'https://github.com/Vondada/chey-app/actions/runs/39894698904', 'https://github.com/Vondada/chey-app/actions/runs/39894699015']) assert.ok(urls.includes(u), u);
  const said = speakReceipt(r);
  assert.match(said, /3 files, 120 lines added and 8 removed, from pull request 473/);
  assert.match(said, /this commit is live/);
  assert.match(said, /Worker version 662e75ae/);
  assert.match(said, /Shorebird patch 7/);
  assert.match(said, /judging only from the changed file paths/);
  assert.match(said, /does not prove your phone installed it/);
  assert.doesNotMatch(said, /Co-Authored-By/);
});

test('deployed but the live Worker runs something else: says exactly which link is missing', async () => {
  clearReceiptCache();
  const behind = await commitReceipt(env, { ref: SHA, runtime: { version_tag: 'aaaaaaa11111' }, fetcher: fakeGitHub({ compare: 'diverged' }).fetcher });
  assert.equal(behind.backend.live, 'not_live');
  assert.match(speakReceipt(behind), /does not include this commit/);
  clearReceiptCache();
  const newer = await commitReceipt(env, { ref: SHA, runtime: { version_tag: NEWER.slice(0, 12) }, fetcher: fakeGitHub({ compare: 'ahead' }).fetcher });
  assert.equal(newer.backend.live, 'included');
  clearReceiptCache();
  const untagged = await commitReceipt(env, { ref: SHA, runtime: {}, fetcher: fakeGitHub().fetcher });
  assert.equal(untagged.backend.live, 'unknown', 'a green deploy run alone never makes a commit live');
  assert.match(speakReceipt(untagged), /live status is unverified/);
});

test('a failed deploy run and an empty Shorebird run are reported as such', async () => {
  clearReceiptCache();
  const r = await commitReceipt(env, { ref: SHA, runtime: { version_tag: 'aaaaaaa11111' }, fetcher: fakeGitHub({ deploy: 'failure', compare: 'behind', patchStep: 'skipped' }).fetcher });
  const said = speakReceipt(r);
  assert.match(said, /Deploy CHE Worker run 39894698904 ended failure/);
  assert.match(said, /finished but published nothing/);
  assert.match(said, /Whether this iPhone has it is unknown: the phone did not report its patch/);
});

test('no GitHub token and a rate limit are named plainly, never "confirmed"', async () => {
  clearReceiptCache();
  const calls = [];
  const none = await commitReceipt({}, { ref: 'main', fetcher: async (u) => { calls.push(u); return ok({}); } });
  assert.equal(calls.length, 0);
  assert.match(speakReceipt(none), /no GitHub access configured/);
  clearReceiptCache();
  const limited = await commitReceipt(env, { ref: 'main', fetcher: fakeGitHub({ limited: true }).fetcher });
  assert.match(speakReceipt(limited), /rate limit is used up/);
  assert.doesNotMatch(speakReceipt(limited), /confirmed|verified live|is live/i);
});

test('changed paths map to what can be tested, labelled as derived; docs- and test-only commits say so', () => {
  const t = testableFrom(commitData.files);
  assert.deepEqual(t.areas, ['answers about versions, commits and deployments', 'chat (sending, replies, voice routing)']);
  assert.equal(t.app, true);
  assert.equal(t.backend, true);
  assert.equal(testableFrom([{ filename: 'AGENTS.md' }]).docs_only, true);
  assert.equal(testableFrom([{ filename: 'tools/test_che_edit_render.py' }]).tests_only, true);
});
