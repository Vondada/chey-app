// Privacy Center, Worker side (owner, 2026-10-25; docs/CHE_PRIVACY_CENTER.md). The SSN guard is checked through
// the real /api/chat route: a Social Security number never reaches storage, memory, the Brain or a model.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { commandById } from './command_catalog.js';
import { containsSsn, findSsns, redactSsn, SSN_REDACTION } from './security_core/ssn.js';
import { looksSecret, redact, guardModelInput } from './security_core/secrets.js';
import { hasSecretShape, isSafeMemoryText } from './research_memory.js';
import { sendMail } from './mailbox.js';
import { guardSsnBody, privacyCommand, privacyIntent, privacyServiceNames, SSN_REPLY } from './privacy_center.js';

const generated = new URL('./.privacy_center.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (privacy_center tests are offline: ${new URL(String(input?.url || input)).host})`);
};

const SSN = '123-45-6789';
const SSN_DIGITS = '123456789';

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ saved = new Map(), model = () => 'Understood, sir.' } = {}) {
  const counter = { calls: 0, inputs: [] };
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { counter.calls += 1; counter.inputs.push(JSON.stringify(input)); return { response: model(input) }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, extra = {}) => {
    const before = counter.calls;
    const res = await send('/api/chat', { message, history: [], ...extra }, token);
    const raw = await res.text();
    const done = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return {}; } }).find((e) => e.type === 'done') || {};
    await Promise.allSettled(pending.splice(0));
    return { reply: replyFromNdjson(raw), meta: done, modelCalls: counter.calls - before, status: res.status };
  };
  return { say, send, token, saved, counter };
}

const dump = (saved) => JSON.stringify([...saved.entries()]);

// ─── Detection ───────────────────────────────────────────────────────────
test('SSN detection: formatted, spaced, bare and spoken forms with an SSN word', () => {
  for (const text of [
    `My SSN is ${SSN}`,
    'my social security number is 123 45 6789',
    'ssn 123456789',
    'my social is one two three four five six seven eight nine',
    'Social security: 1 2 3 dash 4 5 dash 6 7 8 9',
    '123-45-6789 is my social',
    'ITIN 912-70-1234',
  ]) assert.ok(containsSsn(text), text);
  assert.equal(redactSsn(`My SSN is ${SSN}, thanks`).text, `My SSN is ${SSN_REDACTION}, thanks`);
  assert.equal(redactSsn('my social is one two three four five six seven eight nine').text, `my social is ${SSN_REDACTION}`);
});

test('SSN detection leaves phone numbers, last four, dates and plain nine-digit numbers alone', () => {
  for (const text of [
    'Call me at 555-123-4567',
    'my phone is 555 123 4567',
    'the last four of my social are 6789',
    'order number 123456789 shipped',
    'meeting on 2026-10-25 at 10:30',
    'invalid shape 000-12-3456',
    'tracking 666-12-3456',
    'my social media has 123,456,789 views',
    'my social security office is on Main Street',
  ]) assert.equal(findSsns(text).length, 0, text);
});

test('every shared redaction layer removes an SSN: secrets scan, model guard, memory gate', () => {
  assert.ok(looksSecret(`ssn ${SSN}`));
  assert.doesNotMatch(redact(`My SSN is ${SSN}`).text, /6789/);
  const guarded = guardModelInput({ messages: [{ role: 'user', content: `my social is ${SSN_DIGITS}` }] });
  assert.doesNotMatch(JSON.stringify(guarded.input), /123456789/);
  assert.ok(hasSecretShape(`remember my social security number ${SSN}`));
  assert.equal(isSafeMemoryText(`note: ${SSN}`), false);
});

test('the mailbox never carries an SSN to GitHub', async () => {
  const puts = [];
  const fetcher = async (url, init = {}) => {
    if ((init.method || 'GET') === 'PUT') { puts.push(JSON.parse(init.body)); return new Response('{}', { status: 201 }); }
    if (/\/git\/ref/.test(String(url))) return new Response(JSON.stringify({ object: { sha: 'a' } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const out = await sendMail({ CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' }, { from: 'che', to: 'claude', text: `The owner said his SSN is ${SSN}` }, fetcher);
  assert.equal(out.status, 200, JSON.stringify(out));
  const written = Buffer.from(puts.at(-1).content, 'base64').toString('utf8');
  assert.doesNotMatch(written, /6789/);
  assert.match(written, /SSN removed/);
});

test('guardSsnBody cleans every string in a body and flags the chat message', () => {
  const g = guardSsnBody({ message: `ssn ${SSN}`, history: [{ role: 'user', content: `my social is ${SSN_DIGITS}` }] });
  assert.equal(g.inMessage, true);
  assert.equal(g.removed, 2);
  assert.doesNotMatch(JSON.stringify(g.body), /6789/);
  const clean = { message: 'hello' };
  assert.equal(guardSsnBody(clean).body, clean, 'a clean body is returned untouched');
});

// ─── /api/chat replay ────────────────────────────────────────────────────
test('/api/chat: an SSN in a message gets the fixed reply, no model call, and is never stored', async () => {
  const che = await owner();
  for (const said of [`My SSN is ${SSN}, remember it`, 'my social security number is one two three four five six seven eight nine', `remember ssn ${SSN_DIGITS}`]) {
    const out = await che.say(said);
    assert.equal(out.status, 200);
    assert.equal(out.reply.trim(), SSN_REPLY, said);
    assert.equal(out.meta.source, 'che_ssn_guard');
    assert.equal(out.modelCalls, 0, said);
  }
  assert.doesNotMatch(dump(che.saved), /6789|123456789/, 'nothing stored holds the SSN');
});

test('/api/chat: an SSN in earlier history never reaches the model or memory', async () => {
  const che = await owner({ model: () => 'Here is a short poem about the sea.' });
  const out = await che.say('Write me a short poem about the sea.', { history: [{ role: 'user', content: `my social is ${SSN}` }, { role: 'assistant', content: 'ok' }] });
  assert.notEqual(out.meta.source, 'che_ssn_guard');
  for (const input of che.counter.inputs) assert.doesNotMatch(input, /6789/);
  assert.doesNotMatch(dump(che.saved), /6789/);
});

test('/api/chat: a guest device gets the same SSN guard', async () => {
  const che = await owner();
  const family = await (await che.send('/api/platform/tenants', { name: 'Guest', role: 'family' }, che.token)).json();
  const invite = await (await che.send('/api/platform/enrollments', { access: 'private', tenant_id: family.tenant.id }, che.token)).json();
  const guest = (await (await che.send('/api/enroll', { enrollment_token: invite.enrollment.token, device_name: 'guest' })).json()).device_token;
  assert.ok(guest, 'guest enrolled');
  const before = che.counter.calls;
  const res = await che.send('/api/chat', { message: `ssn ${SSN}`, history: [] }, guest);
  assert.match(replyFromNdjson(await res.text()), /never stores a Social Security number/);
  assert.equal(che.counter.calls, before, 'no model call for a guest either');
  assert.doesNotMatch(dump(che.saved), /6789/);
});

// ─── Voice routing ───────────────────────────────────────────────────────
test('privacyIntent reads the owner\'s Privacy Center phrases and nothing else', () => {
  assert.deepEqual(privacyIntent('CHE, open Privacy Center.'), { kind: 'open' });
  assert.deepEqual(privacyIntent('turn on the privacy center'), { kind: 'turn_on' });
  assert.deepEqual(privacyIntent('Turn off Privacy Center'), { kind: 'turn_off' });
  assert.deepEqual(privacyIntent('check my passwords for breaches'), { kind: 'passwords' });
  assert.deepEqual(privacyIntent('show me the data brokers'), { kind: 'brokers' });
  assert.deepEqual(privacyIntent('freeze my credit'), { kind: 'credit' });
  assert.deepEqual(privacyIntent('has my email been in a breach'), { kind: 'email' });
  for (const other of ['what is your privacy policy', 'open the security room', 'turn on the lights']) assert.equal(privacyIntent(other), null, other);
  assert.equal(privacyCommand('turn on').fields.privacy_action, 'turn_on');
  assert.equal(privacyCommand('').fields.privacy_action, 'open');
});

test('"open Privacy Center" and /privacy-center open the room on the phone with no model call', async () => {
  const che = await owner();
  const said = await che.say('Open Privacy Center');
  assert.equal(said.meta.source, 'che_privacy_center');
  assert.equal(said.meta.open_screen, 'privacy_center');
  assert.equal(said.meta.privacy_action, 'open');
  assert.equal(said.modelCalls, 0);
  assert.equal(commandById('privacy-center').route, 'che_privacy_center');
  const slash = await che.say('/privacy-center check my passwords for breaches', { command_confirmed: true });
  assert.equal(slash.meta.open_screen, 'privacy_center');
  assert.equal(slash.meta.privacy_action, 'passwords');
  assert.match(slash.reply, /only the first five characters/);
  const email = await che.say('Has my email been in a breach?');
  assert.match(email.reply, /paid API key/);
});

test('GET /api/privacy/services lists connected service names only', async () => {
  const saved = new Map([['onboarding:huggingface:inference', { provider: 'huggingface', capability: 'inference', state: 'verified', token: { fingerprint: 'sha256:abcdefabcdef', last4: 'wxyz' } }]]);
  const che = await owner({ saved });
  const res = await che.send('/api/privacy/services', null, che.token, 'GET');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.services));
  assert.ok(body.services.some((s) => s.name === 'Huggingface' || s.name === 'Hugging Face'), JSON.stringify(body));
  assert.doesNotMatch(JSON.stringify(body), /sha256|wxyz|fingerprint|token/i);
  assert.deepEqual(privacyServiceNames({ gmail: { state: 'ready' }, github: { state: 'not_connected' }, memory: { state: 'ready' } }, []), [{ name: 'Gmail', source: 'Connected in CHE' }]);
});
