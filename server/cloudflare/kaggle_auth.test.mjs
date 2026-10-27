// Kaggle credentials: a modern token is enough on its own (the account name comes from Kaggle), a legacy key needs its
// username, a transient failure is retried with a bound, a rejected token is not retried, and the token never shows up
// in a status, an error or a request body that was not meant for Kaggle.
import assert from 'node:assert/strict';
import test from 'node:test';
import { farmProviders, FILM_VALIDATION_KEY } from './film_studio.js';
import { KAGGLE_OAUTH, kaggleAuth, kaggleIdentity, startKaggleSession, validateKaggle } from './film_farm.js';

const TOKEN = 'KGAT_0123456789abcdefTOKEN';
const NOW = Date.UTC(2026, 9, 27, 12);
const memory = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, m }; };
const quota = { gpuQuota: { totalTimeAllowed: '108000s', timeUsed: '3600s', timeReserved: '0s' } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noSleep = async () => {};

/** A fetcher that answers each Kaggle method from a table; every request is recorded for inspection. */
function kaggleFetch(table) {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization, body: init?.body ? JSON.parse(init.body) : null });
    const method = String(url).split('/').pop();
    const next = Array.isArray(table[method]) ? table[method].shift() : table[method];
    if (typeof next === 'function') return next();
    return next || json({}, 404);
  };
  return { fetcher, seen };
}

test('a modern token is sent alone as Bearer; a legacy key is the only format that joins username and key', () => {
  const modern = kaggleAuth(TOKEN);
  assert.equal(modern.method, 'modern');
  assert.equal(modern.header, `Bearer ${TOKEN}`);
  assert.equal(modern.username, '');
  const modernWithName = kaggleAuth(`alice:${TOKEN}`);
  assert.equal(modernWithName.header, `Bearer ${TOKEN}`, 'a typed name is not sent with a modern token');
  const legacy = kaggleAuth(`alice:${'a'.repeat(32)}`);
  assert.equal(legacy.method, 'legacy');
  assert.equal(legacy.header, `Basic ${btoa(`alice:${'a'.repeat(32)}`)}`);
  assert.equal(kaggleAuth('a'.repeat(32)), null, 'a legacy key without its username is refused');
});

test('a modern token alone validates, and the account name comes from Kaggle, never reported as missing', async () => {
  const { fetcher, seen } = kaggleFetch({
    GetAcceleratorQuotaStatistics: json(quota),
    IntrospectToken: json({ active: true, username: 'alice', userId: 42 }),
  });
  const out = await validateKaggle(TOKEN, fetcher);
  assert.equal(out.ok, true);
  assert.equal(out.username, 'alice');
  assert.equal(out.username_source, 'kaggle');
  assert.equal(out.username_error, null);
  const intro = seen.find((r) => r.url === `${KAGGLE_OAUTH}/IntrospectToken`);
  assert.equal(intro.auth, `Bearer ${TOKEN}`);
  assert.deepEqual(intro.body, { token: TOKEN }, 'the introspection body carries only the token');
});

test('a token Kaggle accepts but that returns no name is healthy and says the name is missing, with no invented name', async () => {
  const { fetcher } = kaggleFetch({ GetAcceleratorQuotaStatistics: json(quota), IntrospectToken: json({ active: true }) });
  const out = await validateKaggle(TOKEN, fetcher);
  assert.equal(out.ok, true);
  assert.equal(out.username, null);
  assert.equal(out.username_error, 'no_name');
});

test('a legacy key keeps its typed name and never calls introspection', async () => {
  const { fetcher, seen } = kaggleFetch({ GetAcceleratorQuotaStatistics: json(quota) });
  const out = await validateKaggle(`alice:${'a'.repeat(32)}`, fetcher);
  assert.equal(out.username, 'alice');
  assert.equal(out.username_source, 'typed');
  assert.equal(seen.some((r) => r.url.endsWith('/IntrospectToken')), false);
});

test('a transient failure is retried with a bound, then recovers; a rejected token is not retried', async () => {
  let calls = 0;
  const flaky = kaggleFetch({
    GetAcceleratorQuotaStatistics: json(quota),
    IntrospectToken: [() => { calls += 1; return json({}, 503); }, () => { calls += 1; return json({ active: true, username: 'alice' }); }],
  });
  const id = await kaggleIdentity({ token: TOKEN }, flaky.fetcher, 15000, noSleep);
  assert.deepEqual([id.ok, id.username, calls], [true, 'alice', 2]);

  let tries = 0;
  const alwaysDown = async () => { tries += 1; throw new Error('connection reset'); };
  assert.equal((await kaggleIdentity({ token: TOKEN }, alwaysDown, 15000, noSleep)).status, 'network');
  assert.equal(tries, 3, 'bounded: three tries, not endless');

  let rejected = 0;
  const rejects = async () => { rejected += 1; return json({}, 401); };
  assert.equal((await kaggleIdentity({ token: TOKEN }, rejects, 15000, noSleep)).status, 'unauthorized');
  assert.equal(rejected, 1, 'a rejected token is never retried');
});

test('the farm reads the name for a modern token and tells the owner exactly what is missing, never the token', async () => {
  const st = memory();
  const env = { AI: {}, CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app', KAGGLE_API_TOKEN: TOKEN };
  await st.put(FILM_VALIDATION_KEY, { github_actions: { ok: true, checked_ms: NOW }, kaggle: { ok: true, status: 'healthy', username: null, username_error: 'no_name', allowed_s: 30 * 3600, used_s: 0, reserved_s: 0, checked_ms: NOW } });
  const kaggle = (await farmProviders(env, st, { now: NOW })).find((p) => p.id === 'kaggle');
  assert.equal(kaggle.usable, false);
  assert.equal(kaggle.status, 'connected, account name not read');
  assert.match(kaggle.detail, /token works/);
  assert.match(kaggle.detail, /same Kaggle token as yourusername:yourtoken/, 'the recovery is the supported username:token save');
  assert.match(kaggle.detail, /No new token is needed/);
  assert.equal(JSON.stringify(kaggle).includes(TOKEN), false, 'the token is not in the status');

  await st.put(FILM_VALIDATION_KEY, { github_actions: { ok: true, checked_ms: NOW }, kaggle: { ok: true, status: 'healthy', username: 'alice', username_source: 'kaggle', allowed_s: 30 * 3600, used_s: 0, reserved_s: 0, checked_ms: NOW } });
  const named = (await farmProviders(env, st, { now: NOW })).find((p) => p.id === 'kaggle');
  assert.equal(named.status, 'connected');
  assert.equal(named.usable, true);
  assert.equal(named.username, 'alice');
});

test('a session starts with the name Kaggle returned, and refuses honestly without one (no call to Kaggle)', async () => {
  const film = { id: 'film_0123456789abcdef' };
  const ok = kaggleFetch({ SaveKernel: json({ ref: 'alice/che-film-0123456789', versionNumber: 1 }) });
  const started = await startKaggleSession(TOKEN, { base: 'https://che.example', film, token: 'farmtoken123', seconds: 3600, username: 'alice' }, ok.fetcher);
  assert.equal(started.ok, true);
  assert.equal(ok.seen[0].body.slug, 'alice/che-film-0123456789');
  assert.equal(ok.seen[0].auth, `Bearer ${TOKEN}`);

  const none = kaggleFetch({});
  const refused = await startKaggleSession(TOKEN, { base: 'https://che.example', film, token: 'farmtoken123', seconds: 3600 }, none.fetcher);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /account name/);
  assert.equal(none.seen.length, 0, 'no Kaggle call is made without a name');
  assert.equal(refused.error.includes(TOKEN), false);
});

test('validation errors never contain the token', async () => {
  const bad = await validateKaggle(TOKEN, async () => json({}, 401));
  assert.equal(bad.status, 'unauthorized');
  assert.equal(JSON.stringify(bad).includes(TOKEN), false);
  const network = await validateKaggle(TOKEN, async () => { throw new Error(`failed for ${TOKEN}`); });
  assert.equal(JSON.stringify(network).includes(TOKEN), false, 'a thrown message is trimmed and the token is not in it');
});
