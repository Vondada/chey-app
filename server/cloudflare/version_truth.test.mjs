// iPhone version truth (reliability lane rel-infra-app, 2026-10-25). "What version am I running?" and "is the new build
// installed?" are answered from the phone's own iOS bundle report, the Shorebird patch it read, the Worker's runtime
// metadata and the newest verified IPA release, and never from a model or a guess. The handoff's real case: the phone
// ran 1.4.1025342820 while the newest build was 1.4.1025652491, and a Shorebird patch for another release could not
// reach it; nothing told the owner that his phone was behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { appStatusIntent, appStatusReport } from './self_update.js';
import { latestVerifiedRelease } from './mobile_update.js';
import { replyFromNdjson } from './brain_memory.js';

const phrases = JSON.parse(readFileSync(new URL('../../test/fixtures/app_status_phrases.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-10-25T12:00:00Z');
const runtime = { version_id: '22362764-d908-4966-900a-3a6f7938b6af', version_tag: 'afb8de155d3a' };
const device = (version, build, patch) => ({ source: 'ios_bundle', version, build, checked_at: new Date(now - 1000).toISOString(), ...(patch === undefined ? {} : { patch }) });
const latest = { tag: 'che-ios-v1.4.1025652491-b4013508846901', version: '1.4.1025652491', build_number: '4013508846901', commit_sha: 'afb8de155d3a1111111111111111111111111111' };

test('the phone and the Worker agree on which phrases are version questions (shared fixture)', () => {
  for (const p of phrases.runtime) assert.ok(appStatusIntent(p), p);
  for (const p of phrases.neither) assert.equal(appStatusIntent(p), null, p);
});

test('a phone behind the newest verified build is told so, with both versions', () => {
  const out = appStatusReport({ runtime, client: device('1.4.1025342820', '3956317271501', '9'), latest, now });
  assert.equal(out.comparison.installed_vs_latest, 'behind');
  assert.match(out.text, /1\.4\.1025342820, build 3956317271501/);
  assert.match(out.text, /Shorebird patch 9/);
  assert.match(out.text, /newest verified iPhone build is CHE 1\.4\.1025652491, build 4013508846901/);
  assert.match(out.text, /behind/);
  assert.doesNotMatch(out.text, /does not identify a Shorebird patch/);
});

test('a phone on the newest build hears that, and which commit built it beside the backend commit', () => {
  const out = appStatusReport({ runtime, client: device(latest.version, latest.build_number, 'none'), latest, now });
  assert.equal(out.comparison.installed_vs_latest, 'current');
  assert.equal(out.comparison.same_commit, true);
  assert.match(out.text, /no Shorebird patch/);
  assert.match(out.text, /newest verified iPhone build/);
  assert.match(out.text, /same commit/);
  const other = appStatusReport({ runtime: { ...runtime, version_tag: '9ae2a1bb0000' }, client: device(latest.version, latest.build_number), latest, now });
  assert.equal(other.comparison.same_commit, false);
  assert.match(other.text, /built from commit afb8de155d3a; the backend runs 9ae2a1bb0000/);
  assert.match(other.text, /does not identify a Shorebird patch/, 'an unread patch is never guessed');
});

test('a phone ahead of every published release is not called out of date', () => {
  const out = appStatusReport({ runtime, client: device('1.4.1025999999', '1'), latest, now });
  assert.equal(out.comparison.installed_vs_latest, 'ahead');
  assert.match(out.text, /newer than the newest published release/);
});

test('without a readable release or device report there is no comparison, and it says so', () => {
  const noLatest = appStatusReport({ runtime, client: device('1.4.1', '2'), latest: null, now });
  assert.equal(noLatest.comparison.installed_vs_latest, 'unknown');
  assert.match(noLatest.text, /could not read the newest verified iPhone build/);
  const noDevice = appStatusReport({ runtime, client: null, latest, now });
  assert.equal(noDevice.comparison.installed_vs_latest, 'unknown');
  assert.doesNotMatch(noDevice.text, /behind|newest verified iPhone build is/, 'a release listing never stands in for the phone');
  for (const patch of ['12a', '-1', 'patch 3', '9999999']) {
    assert.doesNotMatch(appStatusReport({ runtime, client: device('1.4.1', '2', patch), now }).text, /Shorebird patch \S+\./, patch);
  }
});

function release(version, build, extra = {}) {
  return {
    tag_name: `che-ios-v${version}-b${build}`, draft: false, prerelease: false, published_at: '2026-10-21T00:00:00Z', target_commitish: 'main',
    body: '', assets: [{ name: 'CHE-unsigned.ipa', state: 'uploaded', size: 100, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: `https://github.com/Vondada/chey-app/releases/download/che-ios-v${version}-b${build}/CHE-unsigned.ipa` }],
    ...extra,
  };
}

test('the newest verified release is read by version order, and a failed read is null, never a guess', async () => {
  const fetcher = async () => Response.json([release('1.4.1025342820', '3956317271501'), release('1.4.1025652491', '4013508846901'), { ...release('1.4.9', '1'), draft: true }]);
  const got = await latestVerifiedRelease({}, fetcher, 'https://che.example');
  assert.equal(got.version, '1.4.1025652491');
  assert.equal(got.build_number, '4013508846901');
  assert.equal(await latestVerifiedRelease({}, async () => new Response('no', { status: 503 })), null);
  assert.equal(await latestVerifiedRelease({}, async () => { throw new TypeError('offline'); }), null);
});

test('through /api/chat: "Is the new build installed on my phone?" compares the phone with the newest release, no model', async () => {
  const generated = new URL('./.version_truth.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  ));
  let mod;
  try { mod = await import(`${generated.href}?t=${Date.now()}`); } finally { try { unlinkSync(generated); } catch (_) {} }
  const { default: worker, CheState } = mod;
  const saved = new Map();
  const storage = {
    get: async (k) => (saved.has(k) ? structuredClone(saved.get(k)) : undefined), put: async (k, v) => saved.set(k, structuredClone(v)),
    delete: async (k) => saved.delete(k), deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))), setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CF_VERSION_METADATA: { id: runtime.version_id, tag: runtime.version_tag }, AI: { run: async () => { modelCalls += 1; return { response: 'Yes, everything is installed.' }; } } };
  const state = new CheState({ storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/releases')
    ? Response.json([release('1.4.1025652491', '4013508846901'), release('1.4.1025342820', '3956317271501')])
    : new Response('{}', { status: 503 }));
  try {
    const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env);
    const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
    const raw = await (await send('/api/chat', { message: 'Is the new build installed on my phone?', history: [], client_app: { ...device('1.4.1025342820', '3956317271501', '9'), checked_at: new Date().toISOString() } }, token)).text();
    const done = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'done') || {};
    const reply = replyFromNdjson(raw);
    assert.equal(done.source, 'che_runtime_status');
    assert.equal(modelCalls, 0);
    assert.match(reply, /1\.4\.1025342820/);
    assert.match(reply, /newest verified iPhone build is CHE 1\.4\.1025652491/);
    assert.match(reply, /behind/);
    assert.equal(done.status_receipt.comparison.installed_vs_latest, 'behind');
  } finally {
    globalThis.fetch = original;
  }
});
