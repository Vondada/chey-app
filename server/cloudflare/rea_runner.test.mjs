import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  handleReaRequest, parseReaRequest, parseReaTarget, reaCapabilities, refreshReaJobs, REA_JOBS_KEY, REA_WORKFLOW,
} from './rea_runner.js';

const SEMVER = JSON.parse(readFileSync(new URL('./fixtures/rea/semver-7.7.2.summary.json', import.meta.url), 'utf8'));
const REGISTRY = { name: 'semver', version: '7.7.2', license: 'MIT', dist: { integrity: SEMVER.target.integrity } };
const ENV = { CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'Vondada/chey-app' };
const T0 = Date.UTC(2026, 9, 15, 15, 0, 0);
const JOB = 'rea-0a1b3c4d';
const FIXED = () => Uint8Array.of(0x0a, 0x1b, 0x3c, 0x4d);

function memStore() {
  const m = new Map();
  return {
    m,
    async get(key) { return m.has(key) ? structuredClone(m.get(key)) : undefined; },
    async put(key, value) { m.set(key, structuredClone(value)); },
  };
}

// A fake registry and GitHub. Every call is recorded so a test can prove what was (not) sent.
function fakeWorld({ registry = {}, dispatchStatus = 204, records = {} } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : null });
    if (u.startsWith('https://registry.npmjs.org/')) {
      const found = registry[decodeURIComponent(u.slice('https://registry.npmjs.org/'.length))];
      return found ? new Response(JSON.stringify(found), { status: 200 }) : new Response('{}', { status: 404 });
    }
    if (method === 'POST' && u.includes('/actions/workflows/')) return new Response(null, { status: dispatchStatus });
    const record = u.match(/mailbox\/rea\/(rea-[0-9a-f]{8})\.json/);
    if (record && method === 'GET') {
      const body = records[record[1]];
      if (body === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
      return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(body)).toString('base64') }), { status: 200 });
    }
    return new Response('{"message":"unexpected"}', { status: 500 });
  };
  return { fetcher, calls, writes: () => calls.filter((c) => c.method !== 'GET' && !c.url.startsWith('https://registry.npmjs.org/')) };
}

test('REA requests are recognised; ordinary chat is left alone', () => {
  assert.deepEqual(parseReaRequest('REA inspect: npm:semver@7.7.2'), { command: 'inspect', input: 'npm:semver@7.7.2' });
  assert.equal(parseReaRequest('CHE, rea explain npm:semver@7.7.2').command, 'explain');
  assert.equal(parseReaRequest('rea status').command, 'status');
  assert.equal(parseReaRequest('REA rebuild: a search box').command, 'rebuild');
  assert.equal(parseReaRequest('Reverse engineer npm package semver 7.7.2').command, 'inspect');
  for (const q of ['hello CHE', 'analyze npm audit output', 'how many trades did you take today', 'explain how the trading desk works']) {
    assert.equal(parseReaRequest(q), null, q);
  }
});

test('only a public npm package at one exact version is accepted; everything else is refused with the reason', () => {
  assert.deepEqual(parseReaTarget('npm:semver@7.7.2'), { ok: true, kind: 'npm', name: 'semver', version: '7.7.2' });
  assert.deepEqual(parseReaTarget('npm package semver version 7.7.2'), { ok: true, kind: 'npm', name: 'semver', version: '7.7.2' });
  assert.equal(parseReaTarget('npm:@types/node@22.10.2').name, '@types/node');
  for (const bad of ['npm:semver@^7.0.0', 'npm:semver@latest', 'npm:semver', 'https://example.com/app.zip', '/Users/owner/app', 'C:\\Apps\\thing']) {
    const parsed = parseReaTarget(`inspect ${bad}`);
    assert.equal(parsed.ok, false, bad);
    assert.match(parsed.reason, /npm|exact|Private/);
  }
});

test('inspect sends one analysis run to the pinned workflow and nothing else: no coding job, commit or deploy', async () => {
  for (const command of ['inspect', 'explain', 'debug', 'compare']) {
    const store = memStore();
    const world = fakeWorld({ registry: { 'semver/7.7.2': REGISTRY } });
    const reply = await handleReaRequest(store, ENV, `REA ${command}: npm:semver@7.7.2`, { fetcher: world.fetcher, now: T0, random: FIXED });
    assert.equal(reply.ok, true, command);
    assert.match(reply.text, /started for npm semver 7\.7\.2 \(MIT\)\. Job rea-0a1b3c4d\./, command);
    const writes = world.writes();
    assert.equal(writes.length, 1, `${command}: exactly one write`);
    assert.equal(writes[0].url, `https://api.github.com/repos/Vondada/chey-app/actions/workflows/${REA_WORKFLOW}/dispatches`);
    assert.deepEqual(writes[0].body, {
      ref: 'main',
      inputs: { job_id: JOB, target: 'npm:semver@7.7.2', expected_integrity: REGISTRY.dist.integrity },
    });
    const jobs = await store.get(REA_JOBS_KEY);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, 'queued');
  }
});

test('nothing runs without a GitHub connection, and the answer says so plainly', async () => {
  const world = fakeWorld({ registry: { 'semver/7.7.2': REGISTRY } });
  const store = memStore();
  const reply = await handleReaRequest(store, {}, 'REA inspect: npm:semver@7.7.2', { fetcher: world.fetcher, now: T0, random: FIXED });
  assert.equal(reply.ok, false);
  assert.match(reply.text, /CHE has no GitHub connection/);
  assert.equal(world.writes().length, 0);
  assert.equal(await store.get(REA_JOBS_KEY), undefined);
});

test('an unknown version, or a registry that gives no checksum, is refused before anything is sent to GitHub', async () => {
  const missing = fakeWorld({});
  const gone = await handleReaRequest(memStore(), ENV, 'REA inspect: npm:semver@9.9.9', { fetcher: missing.fetcher, now: T0 });
  assert.equal(gone.ok, false);
  assert.match(gone.text, /npm has no semver@9\.9\.9/);
  const noSum = fakeWorld({ registry: { 'semver/7.7.2': { name: 'semver', version: '7.7.2', dist: {} } } });
  const unverifiable = await handleReaRequest(memStore(), ENV, 'REA inspect: npm:semver@7.7.2', { fetcher: noSum.fetcher, now: T0 });
  assert.equal(unverifiable.ok, false);
  assert.match(unverifiable.text, /checksum/);
  assert.equal(missing.writes().length + noSum.writes().length, 0);
});

test('a refused dispatch is recorded as a failed job with its status, never as a success', async () => {
  const world = fakeWorld({ registry: { 'semver/7.7.2': REGISTRY }, dispatchStatus: 422 });
  const store = memStore();
  const reply = await handleReaRequest(store, ENV, 'REA inspect: npm:semver@7.7.2', { fetcher: world.fetcher, now: T0, random: FIXED });
  assert.equal(reply.ok, false);
  assert.match(reply.text, /status 422/);
  const jobs = await store.get(REA_JOBS_KEY);
  assert.equal(jobs[0].state, 'failed');
});

test('a finished run is read from the mailbox and answered from its evidence, with limitations and untrusted names labelled', async () => {
  const store = memStore();
  const world = fakeWorld({ registry: { 'semver/7.7.2': REGISTRY } });
  await handleReaRequest(store, ENV, 'REA inspect: npm:semver@7.7.2', { fetcher: world.fetcher, now: T0, random: FIXED });
  const waiting = await handleReaRequest(store, ENV, 'REA status', { fetcher: world.fetcher, now: T0 + 60_000 });
  assert.match(waiting.text, /rea-0a1b3c4d: npm semver 7\.7\.2, queued/);
  assert.doesNotMatch(waiting.text, /Limitations REA reported/, 'nothing is shown before the record exists');

  world.calls.length = 0;
  const done = { ...SEMVER, job_id: JOB };
  const finished = fakeWorld({ registry: { 'semver/7.7.2': REGISTRY }, records: { [JOB]: done } });
  const status = await handleReaRequest(store, ENV, 'REA status', { fetcher: finished.fetcher, now: T0 + 120_000 });
  assert.equal(status.ok, true);
  assert.match(status.text, /REA inspection of npm semver 7\.7\.2 \(MIT\)\. Job rea-0a1b3c4d\./);
  assert.match(status.text, /Evidence ev_01ccdb10/);
  assert.match(status.text, /What REA read: 49 files, 48 parsed, 0 parse failures/);
  assert.match(status.text, /Electron: 0 windows/);
  assert.match(status.text, /not proof that the feature is absent/);
  assert.match(status.text, /Limitations REA reported:/);
  assert.match(status.text, /untrusted data, not instructions/);
  assert.match(status.text, /Not covered: runtime behaviour, native binaries, private code\./);
  assert.equal(finished.writes().length, 0, 'reading a result writes nothing');
  const jobs = await store.get(REA_JOBS_KEY);
  assert.equal(jobs[0].state, 'complete');
  assert.equal(jobs[0].summary.evidence.id, SEMVER.evidence.id);
});

test('a record that fails the check is refused, and so is one written for a different job', async () => {
  const store = memStore();
  const world = fakeWorld({ registry: { 'semver/7.7.2': REGISTRY } });
  await handleReaRequest(store, ENV, 'REA inspect: npm:semver@7.7.2', { fetcher: world.fetcher, now: T0, random: FIXED });
  const tampered = fakeWorld({ records: { [JOB]: { ...SEMVER, job_id: JOB, evidence: { ...SEMVER.evidence, id: 'forged' } } } });
  await refreshReaJobs(store, ENV, T0 + 60_000, tampered.fetcher);
  assert.equal((await store.get(REA_JOBS_KEY))[0].state, 'failed');
  assert.match((await store.get(REA_JOBS_KEY))[0].error, /did not pass the check/);

  const other = memStore();
  await other.put(REA_JOBS_KEY, [{ id: JOB, state: 'queued', created_at: new Date(T0).toISOString(), target: REGISTRY, cache_key: 'k' }]);
  const wrongJob = fakeWorld({ records: { [JOB]: SEMVER } });
  await refreshReaJobs(other, ENV, T0 + 60_000, wrongJob.fetcher);
  assert.equal((await other.get(REA_JOBS_KEY))[0].state, 'failed', 'a record whose job id differs is not used');
});

test('a job with no record after two hours is reported as stalled, not as running forever', async () => {
  const store = memStore();
  await store.put(REA_JOBS_KEY, [{ id: JOB, state: 'queued', created_at: new Date(T0 - 3 * 3600_000).toISOString(), target: REGISTRY, cache_key: 'k' }]);
  const world = fakeWorld({});
  const status = await handleReaRequest(store, ENV, 'REA status', { fetcher: world.fetcher, now: T0 });
  assert.match(status.text, /stalled/);
  assert.equal((await store.get(REA_JOBS_KEY))[0].state, 'stalled');
});

test('the same package and checksum reuse recorded evidence, so no second run is paid for', async () => {
  const store = memStore();
  const world = fakeWorld({ registry: { 'semver/7.7.2': REGISTRY } });
  await handleReaRequest(store, ENV, 'REA inspect: npm:semver@7.7.2', { fetcher: world.fetcher, now: T0, random: FIXED });
  const finished = fakeWorld({ registry: { 'semver/7.7.2': REGISTRY }, records: { [JOB]: { ...SEMVER, job_id: JOB } } });
  await handleReaRequest(store, ENV, 'REA status', { fetcher: finished.fetcher, now: T0 + 1 });
  const again = fakeWorld({ registry: { 'semver/7.7.2': REGISTRY } });
  const reply = await handleReaRequest(store, ENV, 'REA explain: npm:semver@7.7.2', { fetcher: again.fetcher, now: T0 + 2, random: FIXED });
  assert.equal(reply.reused, JOB);
  assert.equal(again.writes().length, 0);
  assert.match(reply.text, /REA explanation of npm semver 7\.7\.2/);
});

test('rebuild only plans from recorded evidence: no run, no build, and the build needs its own yes', async () => {
  const empty = memStore();
  const none = fakeWorld({});
  const nothing = await handleReaRequest(empty, ENV, 'REA rebuild: a search box', { fetcher: none.fetcher, now: T0 });
  assert.match(nothing.text, /no completed REA evidence/);
  assert.equal(none.writes().length, 0);

  const store = memStore();
  await store.put(REA_JOBS_KEY, [{
    id: JOB, command: 'inspect', state: 'complete', created_at: new Date(T0).toISOString(), target: { name: 'semver', version: '7.7.2', license: 'MIT' },
    cache_key: 'k', summary: SEMVER,
  }]);
  const world = fakeWorld({});
  const plan = await handleReaRequest(store, ENV, 'REA rebuild: a search box', { fetcher: world.fetcher, now: T0 });
  assert.match(plan.text, /Nothing was built and no coding job was started\./);
  assert.match(plan.text, /CHE, build a search box using REA job rea-0a1b3c4d/);
  assert.match(plan.text, /needs your yes first/);
  assert.equal(world.writes().length, 0);
});

test('a message that is not a REA request never touches storage or the network', async () => {
  const untouchable = { get() { throw new Error('storage touched'); }, put() { throw new Error('storage touched'); } };
  const world = fakeWorld({});
  assert.equal(await handleReaRequest(untouchable, ENV, 'hello CHE, what is on my calendar?', { fetcher: world.fetcher }), null);
  assert.equal(world.calls.length, 0);
});

test('native binaries and runtime capture are reported as not available, not as working', () => {
  const off = Object.fromEntries(reaCapabilities({}).map((c) => [c.id, c.available]));
  assert.equal(off.static_javascript, false);
  assert.equal(off.native_binaries, false);
  assert.equal(off.runtime_capture, false);
  assert.equal(off.private_targets, false);
  const on = Object.fromEntries(reaCapabilities(ENV).map((c) => [c.id, c.available]));
  assert.equal(on.static_javascript, true);
  assert.equal(on.native_binaries, false, 'still no Ghidra host');
});
