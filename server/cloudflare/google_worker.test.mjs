// Google connections through the real Worker, offline: readiness on
// /api/commands, spoken owner requests in /api/chat (no model), the shared
// callback, and the owner-only routes. Same harness approach as command_center.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { PENDING_GOOGLE_ACTION_KEY } from './google_services.js';
import { sealToken } from './youtube_connection.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const generated = new URL('./.google_worker.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const OAUTH_ENV = {
  CHE_OAUTH_SECRET: 'x'.repeat(40),
  CHE_YOUTUBE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  CHE_YOUTUBE_CLIENT_SECRET: 'client-secret-value',
};

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// A paired owner phone against the real Worker. `saved` is the owner's stored
// data, so a test can seed a grant the way a finished sign-in leaves it.
async function owner() {
  const inputs = [];
  const pending = [];
  const saved = new Map();
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_TIMEZONE: 'America/Chicago', ...OAUTH_ENV,
    AI: { run: async (_model, input) => { inputs.push(input); return { response: 'Model answer, sir.' }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  const data = () => saved.get('che');
  const setData = (mutate) => { const d = structuredClone(saved.get('che')); mutate(d); saved.set('che', d); };
  return {
    token, env, saved, data, setData,
    modelCalls: () => inputs.length,
    async say(message) {
      const before = inputs.length;
      const res = await send('/api/chat', { message, history: [] }, token);
      const raw = await res.text();
      await settle();
      const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      const done = events.find((e) => e.type === 'done') || {};
      return { raw, done, modelCalls: inputs.length - before, status: res.status };
    },
    async get(path) { const res = await send(path, null, token, 'GET'); return { status: res.status, body: await res.json().catch(() => ({})) }; },
    async post(path, body, bearer = token) { const res = await send(path, body, bearer); return { status: res.status, body: await res.json().catch(() => ({})) }; },
    send,
  };
}

// A fresh, valid grant sealed with the same secret the Worker reads.
async function liveGrant() {
  return {
    status: 'connected', account: 'owner@example.com', scopes: [], connected_at: new Date().toISOString(),
    refresh: await sealToken(OAUTH_ENV, 'live-refresh-token'),
    access: await sealToken(OAUTH_ENV, 'live-access-token'),
    access_expires_at: Date.now() + 3600_000,
  };
}

test('the Command Center lists Gmail, Drive, Calendar and Google Ads as not connected until signed in', async () => {
  const me = await owner();
  const commands = (await me.get('/api/commands')).body;
  for (const id of ['gmail', 'drive', 'calendar', 'google_ads']) {
    assert.equal(commands.connectors[id].state, 'not_connected', id);
    assert.ok(commands.connectors[id].label, `${id} has a label`);
  }
});

test('"check my email" before Gmail is connected says so, runs nothing and never reaches a model', async () => {
  const me = await owner();
  const r = await me.say('check my email');
  assert.equal(r.done.source, 'che_google');
  assert.equal(r.done.model_calls, 0);
  assert.equal(r.modelCalls, 0);
  assert.match(r.raw, /Gmail is not connected, sir/);
});

test('"check my email" with a live Gmail grant calls Google and reports its real failure, with no model', async () => {
  const me = await owner();
  // The grant needs sealing, which is async, so it is built before the turn.
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  const r = await me.say('check my email');
  assert.equal(r.done.source, 'che_google');
  assert.equal(r.modelCalls, 0);
  assert.match(r.raw, /I could not read your email, sir/, 'the failed Google call is reported, not invented');
});

test('the shared callback sends Gmail\'s sign-in to Gmail, names the service, and uses the sign-in once', async () => {
  const me = await owner();
  me.setData((d) => { d.google_oauth = { service: 'gmail', state: 'gmail-state-value', verifier: 'v'.repeat(48), created_at: Date.now() }; });
  const res = await me.send('/api/youtube/callback?state=gmail-state-value&error=access_denied', null, '', 'GET');
  const html = await res.text();
  assert.equal(res.status, 400);
  assert.match(html, /Gmail not connected/, 'the page names the service, not YouTube');
  assert.match(html, /did not approve/);
  assert.equal(me.data().google_oauth, undefined, 'the one-time sign-in is used up');
});

test('the owner-only Google routes refuse a request without the owner\'s device', async () => {
  const me = await owner();
  const status = await me.send('/api/google/status', null, '', 'GET');
  assert.equal(status.status, 401, 'no device token is not the owner');
  const start = await me.post('/api/google/connect/start', { service: 'gmail' }, '');
  assert.ok(start.status >= 400);
});

test('the owner can start a Gmail sign-in and gets a Google address with only Gmail\'s scopes', async () => {
  const me = await owner();
  const r = await me.post('/api/google/connect/start', { service: 'gmail' });
  assert.equal(r.status, 200);
  const url = new URL(r.body.url);
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.searchParams.get('scope'),
    'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');
});

test('a Google sign-in for an unknown service is refused with the owner\'s words', async () => {
  const me = await owner();
  const r = await me.post('/api/google/connect/start', { service: 'bank' });
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /cannot connect that Google service/);
});

test('Gmail shows as Connected on the Command Center once a grant is stored', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  const commands = (await me.get('/api/commands')).body;
  assert.equal(commands.connectors.gmail.state, 'ready');
  assert.equal(commands.connectors.gmail.detail, 'owner@example.com');
  const status = (await me.get('/api/google/status')).body;
  assert.equal(status.services.gmail.connected, true);
  assert.equal(JSON.stringify(status).includes('live-refresh-token'), false, 'no token in the status reply');
});

test('an email request in Chat is held for a yes, with no model call, and a no cancels it', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  const held = await me.say('send an email to ann@example.com saying lunch at noon');
  assert.equal(held.done.source, 'che_google');
  assert.equal(held.done.held, true);
  assert.equal(held.modelCalls, 0);
  assert.match(held.raw, /Say yes to send it/);
  const no = await me.say('no');
  assert.match(no.raw, /Cancelled, sir\. The email to ann@example\.com was not done\./);
  assert.equal(no.modelCalls, 0);
});

test('a yes after a held email runs the send for real, and a failure is reported as one', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  await me.say('send an email to ann@example.com saying lunch at noon');
  const yes = await me.say('yes');
  assert.equal(yes.done.source, 'che_google');
  assert.equal(yes.modelCalls, 0);
  assert.match(yes.raw, /The email was not sent, sir\. Google did not answer Gmail\./, 'the offline send is reported as not sent');
});

test('a Knowledge Atlas lesson between a held email and a yes drops the hold, so the yes sends nothing (PR #357 review)', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  const held = await me.say('send an email to bob@example.com saying the report is ready');
  assert.equal(held.done.held, true);
  const lesson = await me.say('teach me recursion');
  assert.equal(lesson.done.source, 'che_knowledge_atlas');
  assert.equal(lesson.modelCalls, 0);
  assert.equal(me.saved.get(PENDING_GOOGLE_ACTION_KEY), null, 'the lesson replaced the held email');
  const yes = await me.say('yes');
  assert.notEqual(yes.done.source, 'che_google', 'a later yes releases nothing');
  assert.doesNotMatch(yes.raw, /email|bob@example\.com/i);
});

test('FundYourEdge is reported as not connected, nothing is checked, and no order is prepared', async () => {
  const me = await owner();
  const check = await me.say('check my FundYourEdge account');
  assert.equal(check.done.source, 'che_brokerage');
  assert.equal(check.modelCalls, 0);
  assert.match(check.raw, /FundYourEdge is not connected/);
  // Owner (2026-10-22): preparing is a read-only draft that nothing sends; placing an order stays refused.
  const draft = await me.say('prepare an MNQ trade');
  assert.equal(draft.modelCalls, 0);
  assert.equal(draft.done.source, 'che_fye_draft');
  assert.equal(draft.done.order_sent, false);
  assert.match(draft.raw, /NOT SUBMITTED — NO BROKER CONNECTION/);
  const order = await me.say('place an MNQ order on FundYourEdge');
  assert.equal(order.modelCalls, 0);
  assert.match(order.raw, /cannot place or submit an order for FundYourEdge/);
  assert.match(order.raw, /Nothing was placed/);
});

test('FundYourEdge shows as Unsupported on the Command Center, with its reason', async () => {
  const me = await owner();
  const commands = (await me.get('/api/commands')).body;
  assert.equal(commands.connectors.fundyouredge.state, 'none');
  assert.match(commands.connectors.fundyouredge.detail, /Rithmic/);
});

// Google's answers for one owner account, offline. Each route matches the request URL.
// The fake records every call, so a test can show a reply came from a real Google request.
const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');
const NEWEST_FROM = 'Alex Rivera <alex@example.com>';
const DANA_FROM = 'Dana <dana@example.com>';
const meta = (from, subject, date) => ({ headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: date }] });
function googleAnswers(sent = []) {
  return [
    [/\/gmail\/v1\/users\/me\/messages\?/, () => ({ messages: [{ id: 'msg-newest-1' }, { id: 'msg-older-2' }], resultSizeEstimate: 2 })],
    [/\/messages\/msg-newest-1\?format=metadata/, () => ({ payload: meta(NEWEST_FROM, 'Lunch on Tuesday', 'Mon, 12 Oct 2026 09:14:00 -0500'), snippet: 'Are we still on' })],
    [/\/messages\/msg-older-2\?format=metadata/, () => ({ payload: meta(DANA_FROM, 'Invoice 4411', 'Sun, 11 Oct 2026 18:02:00 -0500'), snippet: 'Attached' })],
    [/\/messages\/msg-newest-1\?format=full/, () => ({
      payload: { ...meta(NEWEST_FROM, 'Lunch on Tuesday', 'Mon, 12 Oct 2026 09:14:00 -0500'), mimeType: 'multipart/alternative',
        parts: [{ mimeType: 'text/plain', body: { data: b64url("Are we still on for noon at Marta's?") } }] },
    })],
    [/\/calendar\/v3\/calendars\/primary\/events\?/, () => ({
      items: [{ id: 'e1', summary: 'Dentist', start: { dateTime: '2026-10-15T14:30:00-05:00' }, end: { dateTime: '2026-10-15T15:00:00-05:00' } }],
    })],
    [/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\?/, () => ({ files: [{ id: 'f1', name: 'Quarterly plan' }] })],
    [/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/, (url, init) => {
      sent.push(String(init?.body || ''));
      return { id: 'doc-1', name: 'Test Plan', webViewLink: 'https://docs.google.com/document/d/doc-1/edit' };
    }],
  ];
}

// The words the owner hears: the NDJSON text deltas, decoded.
const spoken = (raw) => raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'delta').map((e) => e.delta).join('');

// Runs `run` with Google's fake in place, then puts the offline stub back.
async function withGoogle(run, sent = []) {
  const offline = globalThis.fetch;
  const calls = [];
  const routes = googleAnswers(sent);
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url || input);
    calls.push(url);
    const hit = routes.find(([pattern]) => pattern.test(url));
    if (!hit) throw new TypeError(`offline test: no fake for ${url}`);
    return new Response(JSON.stringify(hit[1](url, init)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = offline;
  }
}

test('the owner\'s mandatory Google phrases reach the real integration, with no model call', async () => {
  const cases = [
    ['CHE, check my unread emails and tell me the newest one.', /You have 2 unread emails, sir\. The newest is from Alex Rivera, subject "Lunch on Tuesday"/, 'gmail'],
    ['Check my email.', /The newest: 1: from Alex Rivera, Lunch on Tuesday\. 2: from Dana, Invoice 4411/, 'gmail'],
    ['Do I have any new emails?', /You have 2 unread emails, sir/, 'gmail'],
    ['Read my latest unread email.', /From Alex Rivera, subject "Lunch on Tuesday"[^]*Are we still on for noon at Marta's\?/, 'gmail'],
    ['CHE, what’s on my calendar today?', /Your calendar for today, sir: 14:30 Dentist/, 'calendar'],
    ["What's on my schedule tomorrow?", /Your calendar for tomorrow, sir: 14:30 Dentist/, 'calendar'],
    ['CHE, list my Google Drive files.', /Drive files CHE can see, sir: Quarterly plan/, 'drive'],
  ];
  for (const [phrase, expected, service] of cases) {
    const me = await owner();
    const grant = await liveGrant();
    me.setData((d) => { d.google_connections = { gmail: grant, calendar: grant, drive: grant }; });
    await withGoogle(async (calls) => {
      const r = await me.say(phrase);
      assert.equal(r.done.source, 'che_google', phrase);
      assert.equal(r.modelCalls, 0, `${phrase}: no model call`);
      assert.match(spoken(r.raw), expected, phrase);
      const host = { gmail: 'gmail.googleapis.com', calendar: 'calendar/v3', drive: 'drive/v3' }[service];
      assert.ok(calls.some((u) => u.includes(host)), `${phrase}: a real ${service} request was made`);
    });
  }
});

test('"Create a Google Doc called Test Plan with the words Connection Verified." writes the real text and returns the link', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { drive: grant }; });
  const sent = [];
  await withGoogle(async () => {
    const r = await me.say('Create a Google Doc called Test Plan with the words Connection Verified.');
    assert.equal(r.done.source, 'che_google');
    assert.equal(r.modelCalls, 0);
    assert.match(spoken(r.raw), /I created the Google Doc "Test Plan", sir\. Link: https:\/\/docs\.google\.com\/document\/d\/doc-1\/edit/);
  }, sent);
  assert.equal(sent.length, 1, 'one document was created');
  assert.match(sent[0], /Connection Verified/, 'the text is the owner\'s words');
  assert.doesNotMatch(sent[0], /the words/);
});

test('"CHE, check my YouTube channel." answers from the connected channel with no model call', async () => {
  const me = await owner();
  const refresh = await sealToken(OAUTH_ENV, 'yt-refresh-token');
  me.setData((d) => { d.youtube = { status: 'connected', channel_id: 'UC123', channel_title: 'Test Channel', connected_at: new Date().toISOString(), refresh }; });
  const r = await me.say('CHE, check my YouTube channel.');
  assert.equal(r.done.source, 'che_youtube_status');
  assert.equal(r.modelCalls, 0);
  assert.match(spoken(r.raw), /YouTube is connected to Test Channel, sir\./);
});

test('a follow-up refers to the list the owner just heard: "read the newest one"', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  await withGoogle(async () => {
    const listed = await me.say('check my unread emails');
    assert.match(spoken(listed.raw), /The newest: 1: from Alex Rivera/);
    const read = await me.say('read the newest one');
    assert.equal(read.modelCalls, 0);
    assert.match(spoken(read.raw), /Are we still on for noon at Marta's\?/, 'the body of the message the list named');
  });
});

test('"what about tomorrow" refers to the calendar the owner just heard', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { calendar: grant }; });
  await withGoogle(async (calls) => {
    const today = await me.say("CHE, what's on my calendar today?");
    assert.match(spoken(today.raw), /Your calendar for today/);
    const tomorrow = await me.say('what about tomorrow');
    assert.equal(tomorrow.modelCalls, 0);
    assert.match(spoken(tomorrow.raw), /Your calendar for tomorrow, sir/);
    const windows = calls.filter((u) => u.includes('calendar/v3')).map((u) => new URL(u).searchParams.get('timeMin'));
    assert.equal(windows.length, 2);
    assert.notEqual(windows[0], windows[1], 'tomorrow asks Google for a different window');
  });
});

test('"show me those files" refers to the Drive list the owner just heard', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { drive: grant }; });
  await withGoogle(async (calls) => {
    await me.say('list my Google Drive files');
    const again = await me.say('show me those files');
    assert.equal(again.modelCalls, 0);
    assert.match(spoken(again.raw), /Drive files CHE can see, sir: Quarterly plan/);
    assert.equal(calls.filter((u) => u.includes('drive/v3')).length, 2);
  });
});

test('a number outside the last Gmail list is refused without a Google request', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  await withGoogle(async (calls) => {
    await me.say('check my email');
    const before = calls.length;
    const r = await me.say('read number three');
    assert.match(spoken(r.raw), /Say a number from 1 to 2, sir\. Nothing was opened\./);
    assert.equal(calls.length, before, 'nothing was fetched');
  });
});

test('a Google phrase before Gmail is connected says so, and never reaches a model', async () => {
  const me = await owner();
  const r = await me.say('CHE, check my unread emails and tell me the newest one.');
  assert.equal(r.done.source, 'che_google');
  assert.equal(r.modelCalls, 0);
  assert.match(r.raw, /Gmail is not connected, sir\./);
});

test('a Google phrase with earlier turns in the conversation still makes no model call', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  await withGoogle(async () => {
    const before = me.modelCalls();
    const history = [{ role: 'user', content: 'What did we talk about earlier?' }, { role: 'assistant', content: 'The trip plan, sir.' }];
    const res = await me.send('/api/chat', { message: 'CHE, check my unread emails and tell me the newest one.', history }, me.token);
    const raw = await res.text();
    assert.match(spoken(raw), /You have 2 unread emails, sir/);
    assert.equal(me.modelCalls() - before, 0, 'the interpreter made no model read either');
    assert.doesNotMatch(raw, /"source":"model"/);
  });
});

test('ordinary conversation about email never calls Google', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  await withGoogle(async (calls) => {
    const r = await me.say('I checked my email yesterday and it was fine.');
    assert.notEqual(r.done.source, 'che_google');
    assert.equal(calls.length, 0, 'no Google request for ordinary talk');
  });
});

// A Gmail grant Google revoked used to read Ready on the Connections page and
// in the Command Center until the owner happened to use Gmail.
test('a revoked Gmail grant reads Reconnect on refresh, and the owner\'s phrase says so with no model', async () => {
  const me = await owner();
  const grant = { ...(await liveGrant()), access_expires_at: Date.now() - 1000 };
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  const offline = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    throw new TypeError(`offline test: no fake for ${url}`);
  };
  try {
    const commands = (await me.get('/api/commands')).body;
    assert.equal(commands.connectors.gmail.state, 'needs_reconnect');
    const r = await me.say('CHE, check my unread emails and tell me the newest one.');
    assert.equal(r.done.source, 'che_google');
    assert.equal(r.modelCalls, 0);
    assert.match(spoken(r.raw), /Google no longer accepts CHE's Gmail sign-in, sir\. Reconnect Gmail/);
    assert.ok(!calls.some((u) => u.includes('gmail.googleapis.com')), 'no Gmail read with a revoked grant');
  } finally {
    globalThis.fetch = offline;
  }
});

// Gmail's resultSizeEstimate is an estimate whenever more pages exist; CHE
// never speaks it as an exact count. "Read my latest email" reads the inbox.
test('a Gmail list with more pages is spoken as "about", and "read my latest email" reads the inbox', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  const offline = globalThis.fetch;
  const queries = [];
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/\/messages\?/.test(url)) {
      queries.push(new URL(url).searchParams.get('q'));
      return reply({ messages: [{ id: 'msg-newest-1' }], resultSizeEstimate: 201, nextPageToken: 'page-2' });
    }
    if (/msg-newest-1\?format=metadata/.test(url)) return reply({ payload: meta(NEWEST_FROM, 'Lunch on Tuesday', 'Mon, 12 Oct 2026 09:14:00 -0500') });
    if (/msg-newest-1\?format=full/.test(url)) {
      return reply({ payload: { ...meta(NEWEST_FROM, 'Lunch on Tuesday', 'Mon, 12 Oct 2026 09:14:00 -0500'), mimeType: 'text/plain', body: { data: b64url('See you at noon.') } } });
    }
    throw new TypeError(`offline test: no fake for ${url}`);
  };
  try {
    const listed = await me.say('CHE, check my unread emails and tell me the newest one.');
    assert.match(spoken(listed.raw), /You have about 201 unread emails, sir\. The newest is from Alex Rivera/);
    const read = await me.say('read my latest email');
    assert.equal(read.modelCalls, 0);
    assert.match(spoken(read.raw), /See you at noon\./);
    assert.deepEqual(queries, ['is:unread', 'in:inbox']);
  } finally {
    globalThis.fetch = offline;
  }
});

// A guest or private phone never reaches Google, so its model must not be asked: that model answered
// "I cannot access external emails", which is false for the owner's own Gmail.
test('a guest phone asking for Gmail, Calendar or the send path is refused with no model call', async () => {
  const me = await owner();
  const tenant = await me.post('/api/platform/tenants', { name: 'Guest', role: 'family' });
  const invite = await me.post('/api/platform/enrollments', { access: 'private', tenant_id: tenant.body.tenant.id });
  const guest = (await (await me.send('/api/enroll', { enrollment_token: invite.body.enrollment.token, device_name: 'guest' })).json()).device_token;
  const before = me.modelCalls();
  for (const words of [
    'CHE, check my unread emails and tell me the newest one.',
    'What is on my calendar today?',
    'Send an email to ann@example.com saying lunch at noon.',
  ]) {
    const res = await me.send('/api/chat', { message: words, history: [] }, guest);
    const reply = spoken(await res.text());
    // An email send is caught by the earlier owner-action refusal; each refusal is honest and says nothing was done.
    assert.match(reply, /^Only the CHE owner can .*(?:Nothing was (?:read or )?changed|nothing was done)/s, words);
    assert.doesNotMatch(reply, /cannot access/i, words);
  }
  assert.equal(me.modelCalls(), before);
});
