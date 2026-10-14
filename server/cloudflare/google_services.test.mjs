import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adsCustomers, buildRawEmail, calendarCreate, calendarList, calendarWindow, disconnectGoogle,
  driveCreateDoc, driveList, finishGoogleConnect, gmailList, gmailSend, googleAccessToken,
  googleChatIntent, googleConnectorStates, googleStates, runGoogleIntent, startGoogleConnect,
  zonedWallTimeToUtc,
} from './google_services.js';

const env = {
  CHE_YOUTUBE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  CHE_YOUTUBE_CLIENT_SECRET: 'client-secret-value',
  CHE_OAUTH_SECRET: 'x'.repeat(40),
};
const ORIGIN = 'https://chey-app.example';
const SCOPE = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
  drive: ['https://www.googleapis.com/auth/drive.file'],
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  google_ads: ['https://www.googleapis.com/auth/adwords'],
};
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A fake Google: records every call and answers by URL.
function fakeGoogle(handlers = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const key = Object.keys(handlers).find((k) => u.startsWith(k));
    if (!key) return json({ error: { message: `no fake for ${u}` } }, 500);
    return handlers[key](u, init);
  };
  fetcher.calls = calls;
  return fetcher;
}

function tokenHandler({ scope, refresh = 'refresh-token-value', access = 'access-token-value', expires = 3600 } = {}) {
  return () => json({ access_token: access, refresh_token: refresh, scope: scope.join(' '), expires_in: expires });
}

function pendingFor(service, state = 'expected-state') {
  return { service, state, verifier: 'verifier-value-long-enough-0123456789', created_at: NOW };
}

test('start builds a sign-in for one service only, with PKCE and a stored one-time state', async () => {
  const data = {};
  const r = await startGoogleConnect(env, data, ORIGIN, 'gmail', NOW);
  assert.equal(r.ok, true);
  const url = new URL(r.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), SCOPE.gmail.join(' '));
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/api/youtube/callback`);
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false', 'each service gets its own consent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(data.google_oauth.service, 'gmail');
  assert.equal(data.google_oauth.state, url.searchParams.get('state'));
});

test('an unknown service and a missing secret are refused before any sign-in', async () => {
  assert.equal((await startGoogleConnect(env, {}, ORIGIN, 'bank', NOW)).ok, false);
  assert.equal((await startGoogleConnect(env, {}, ORIGIN, '__proto__', NOW)).ok, false);
  const noSecret = await startGoogleConnect({ ...env, CHE_OAUTH_SECRET: 'short' }, {}, ORIGIN, 'drive', NOW);
  assert.equal(noSecret.ok, false);
  assert.match(noSecret.error, /CHE_OAUTH_SECRET/);
});

test('a callback with the wrong state is refused and leaves the real pending sign-in alone', async () => {
  const data = { google_oauth: pendingFor('calendar') };
  const r = await finishGoogleConnect(env, data, { state: 'forged', code: 'x' }, fakeGoogle(), ORIGIN, NOW);
  assert.equal(r.ok, false);
  assert.equal(data.google_oauth.service, 'calendar', 'the real pending sign-in is kept');
});

test('a successful Gmail sign-in stores sealed tokens and reports the account', async () => {
  const data = { google_oauth: pendingFor('gmail') };
  const fetcher = fakeGoogle({
    'https://oauth2.googleapis.com/token': tokenHandler({ scope: SCOPE.gmail }),
    'https://gmail.googleapis.com/gmail/v1/users/me/profile': () => json({ emailAddress: 'owner@example.com' }),
  });
  const r = await finishGoogleConnect(env, data, { state: 'expected-state', code: 'code-1' }, fetcher, ORIGIN, NOW);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.account, 'owner@example.com');
  assert.equal(data.google_oauth, undefined, 'the pending request is used once');
  const stored = JSON.stringify(data.google_connections);
  assert.equal(stored.includes('refresh-token-value'), false, 'refresh token is sealed at rest');
  assert.equal(stored.includes('access-token-value'), false, 'access token is sealed at rest');
  assert.equal(data.google_connections.gmail.status, 'connected');
});

test('a grant missing any approved permission is revoked and not saved', async () => {
  const data = { google_oauth: pendingFor('gmail') };
  const fetcher = fakeGoogle({
    'https://oauth2.googleapis.com/token': tokenHandler({ scope: [SCOPE.gmail[0]] }),
    'https://oauth2.googleapis.com/revoke': () => new Response('', { status: 200 }),
  });
  const r = await finishGoogleConnect(env, data, { state: 'expected-state', code: 'c' }, fetcher, ORIGIN, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /every permission/);
  assert.equal(data.google_connections, undefined);
  assert.ok(fetcher.calls.some((c) => c.url.includes('/revoke')), 'the partial grant is revoked at Google');
});

test('a sign-in without a long-term refresh token is refused', async () => {
  const data = { google_oauth: pendingFor('drive') };
  const fetcher = fakeGoogle({
    'https://oauth2.googleapis.com/token': () => json({ access_token: 'a', scope: SCOPE.drive.join(' '), expires_in: 3600 }),
    'https://oauth2.googleapis.com/revoke': () => new Response('', { status: 200 }),
  });
  const r = await finishGoogleConnect(env, data, { state: 'expected-state', code: 'c' }, fetcher, ORIGIN, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /long-term/);
});

test('a Google access error at the callback is shown in the owner\'s words', async () => {
  const data = { google_oauth: pendingFor('calendar') };
  const r = await finishGoogleConnect(env, data, { state: 'expected-state', error: 'access_denied' }, fakeGoogle(), ORIGIN, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /did not approve/);
});

test('a stored token refreshes, and an expired grant becomes needs_reconnect', async () => {
  const data = { google_oauth: pendingFor('gmail') };
  const ok = fakeGoogle({
    'https://oauth2.googleapis.com/token': tokenHandler({ scope: SCOPE.gmail }),
    'https://gmail.googleapis.com/gmail/v1/users/me/profile': () => json({ emailAddress: 'o@example.com' }),
  });
  await finishGoogleConnect(env, data, { state: 'expected-state', code: 'c' }, ok, ORIGIN, NOW);
  // Access token is stale: the next call refreshes it.
  data.google_connections.gmail.access_expires_at = NOW - 1;
  const refresh = fakeGoogle({ 'https://oauth2.googleapis.com/token': () => json({ access_token: 'fresh', expires_in: 3600 }) });
  const token = await googleAccessToken(env, data, 'gmail', refresh, NOW);
  assert.equal(token.ok, true);
  assert.equal(token.token, 'fresh');
  // Google now refuses the grant.
  data.google_connections.gmail.access_expires_at = NOW - 1;
  const revoked = fakeGoogle({ 'https://oauth2.googleapis.com/token': () => json({ error: 'invalid_grant' }, 400) });
  const dead = await googleAccessToken(env, data, 'gmail', revoked, NOW);
  assert.equal(dead.ok, false);
  assert.match(dead.error, /Reconnect Gmail/);
  assert.equal(data.google_connections.gmail.status, 'needs_reconnect');
});

test('connector states: ready only when signed in, Ads also needs its developer token', async () => {
  const data = { google_connections: {
    gmail: { status: 'connected', account: 'o@example.com', refresh: null, scopes: SCOPE.gmail },
    google_ads: { status: 'connected', account: '2 accessible', refresh: null, scopes: SCOPE.google_ads },
  } };
  // Sealed refresh is unreadable here (no token saved), so states are "needs reconnect" for gmail.
  const states = await googleStates(env, data);
  assert.equal(states.drive.status, 'not_connected');
  assert.equal(states.gmail.connected, false);
  const healthy = await googleConnectorStates({ ...env, CHE_GOOGLE_ADS_DEVELOPER_TOKEN: 'dev' }, { google_connections: {} });
  assert.equal(healthy.calendar.state, 'not_connected');
  assert.match(healthy.calendar.detail, /not connected/);
});

test('Google Ads refuses to read without its developer token and calls nothing', async () => {
  const fetcher = fakeGoogle({});
  const r = await adsCustomers({ ...env }, { google_connections: {} }, fetcher);
  assert.equal(r.ok, false);
  assert.match(r.error, /CHE_GOOGLE_ADS_DEVELOPER_TOKEN/);
  assert.equal(fetcher.calls.length, 0);
});

test('disconnect revokes at Google and forgets the local copy', async () => {
  const data = { google_oauth: pendingFor('drive') };
  const fetcher = fakeGoogle({
    'https://oauth2.googleapis.com/token': tokenHandler({ scope: SCOPE.drive }),
    'https://www.googleapis.com/drive/v3/about': () => json({ user: { emailAddress: 'o@example.com' } }),
    'https://oauth2.googleapis.com/revoke': () => new Response('', { status: 200 }),
  });
  await finishGoogleConnect(env, data, { state: 'expected-state', code: 'c' }, fetcher, ORIGIN, NOW);
  const r = await disconnectGoogle(env, data, 'drive', fetcher);
  assert.equal(r.ok, true);
  assert.equal(r.revoked_at_google, true);
  assert.equal(data.google_connections.drive, undefined);
});

test('the raw email is valid RFC 2822 and a subject cannot inject headers', () => {
  const raw = buildRawEmail({ to: 'a@example.com', subject: 'Hi\r\nBcc: spy@example.com', body: 'Line one\nLine two — café' });
  const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const headers = text.split('\r\n\r\n')[0].split('\r\n');
  assert.equal(headers.some((h) => /^Bcc:/i.test(h)), false, 'no injected Bcc header');
  assert.equal(headers.filter((h) => /^To:/.test(h)).length, 1);
  assert.match(text, /Subject: =\?UTF-8\?B\?/);
  const body = text.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Line one\nLine two — café');
});

test('gmailSend refuses an incomplete address or empty text without calling Google', async () => {
  const data = { google_connections: {} };
  const fetcher = fakeGoogle({});
  assert.equal((await gmailSend(env, data, { to: 'bob', body: 'hi' }, fetcher)).ok, false);
  assert.equal((await gmailSend(env, data, { to: 'bob@example.com', body: '   ' }, fetcher)).ok, false);
  assert.equal(fetcher.calls.length, 0);
});

test('Gmail list reads message headers and Drive create sends a Google Doc upload', async () => {
  const data = { google_connections: { gmail: { status: 'connected', refresh: null }, drive: { status: 'connected', refresh: null } } };
  const fetcher = fakeGoogle({});
  const access = (await import('./google_services.js')).googleAccessToken;
  // Use a fake token by pre-seeding a fresh access token in the record.
  const { sealToken } = await import('./youtube_connection.js');
  data.google_connections.gmail.access = await sealToken(env, 'live-token');
  data.google_connections.gmail.access_expires_at = Date.now() + 3600_000;
  data.google_connections.gmail.refresh = await sealToken(env, 'r');
  data.google_connections.drive.access = await sealToken(env, 'live-token');
  data.google_connections.drive.access_expires_at = Date.now() + 3600_000;
  data.google_connections.drive.refresh = await sealToken(env, 'r');
  const api = fakeGoogle({
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?': () => json({ messages: [{ id: 'm1' }], resultSizeEstimate: 1 }),
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1': () => json({
      snippet: 'Hello there', payload: { headers: [{ name: 'From', value: 'Ann <ann@example.com>' }, { name: 'subject', value: 'Lunch' }] },
    }),
    'https://www.googleapis.com/upload/drive/v3/files': () => json({ id: 'd1', name: 'Plan', webViewLink: 'https://docs.google.com/d1' }),
  });
  assert.ok(access);
  const mail = await gmailList(env, data, {}, api);
  assert.equal(mail.ok, true);
  assert.equal(mail.messages[0].from, 'Ann <ann@example.com>');
  assert.equal(mail.messages[0].subject, 'Lunch');
  const doc = await driveCreateDoc(env, data, { name: 'Plan\nEvil', text: 'Step one' }, api);
  assert.equal(doc.ok, true);
  const upload = api.calls.find((c) => c.url.includes('upload/drive'));
  assert.match(upload.headers['content-type'], /multipart\/related; boundary=che/);
  assert.match(upload.body, /"mimeType":"application\/vnd\.google-apps\.document"/);
  assert.match(upload.body, /"name":"Plan Evil"/, 'newlines removed from the document name');
});

test('calendar windows follow the owner\'s time zone across daylight saving', () => {
  // Chicago is UTC-6 in January and UTC-5 in July.
  assert.equal(new Date(zonedWallTimeToUtc(2026, 1, 15, 0, 0, 'America/Chicago')).toISOString(), '2026-01-15T06:00:00.000Z');
  assert.equal(new Date(zonedWallTimeToUtc(2026, 7, 15, 0, 0, 'America/Chicago')).toISOString(), '2026-07-15T05:00:00.000Z');
  const today = calendarWindow('today', 'America/Chicago', NOW);
  assert.equal(today.timeMin, '2026-10-14T05:00:00.000Z');
  assert.equal(today.timeMax, '2026-10-15T05:00:00.000Z');
  const week = calendarWindow('this week', 'America/Chicago', NOW);
  assert.equal(week.timeMax, '2026-10-21T05:00:00.000Z');
});

test('calendar create sends local wall-clock times in the owner\'s zone and an hour by default', async () => {
  const data = { google_connections: { calendar: { status: 'connected', refresh: null } } };
  const { sealToken } = await import('./youtube_connection.js');
  data.google_connections.calendar.access = await sealToken(env, 'live-token');
  data.google_connections.calendar.access_expires_at = Date.now() + 3600_000;
  data.google_connections.calendar.refresh = await sealToken(env, 'r');
  const api = fakeGoogle({
    'https://www.googleapis.com/calendar/v3/calendars/primary/events': (u, init) => json({
      id: 'e1', summary: JSON.parse(init.body).summary, start: { dateTime: '2026-10-20T14:30:00-05:00' }, htmlLink: 'https://cal/e1',
    }),
  });
  const r = await calendarCreate(env, data, { summary: 'Dentist', date: '2026-10-20', time: '14:30', timeZone: 'America/Chicago' }, api);
  assert.equal(r.ok, true);
  const body = JSON.parse(api.calls[0].body);
  assert.equal(body.start.dateTime, '2026-10-20T14:30:00');
  assert.equal(body.end.dateTime, '2026-10-20T15:30:00');
  assert.equal(body.start.timeZone, 'America/Chicago');
  const bad = await calendarCreate(env, data, { summary: 'X', date: '2026-13-40', time: '14:30' }, api);
  assert.equal(bad.ok, false);
});

test('owner phrases map to one intent each, and ordinary chat maps to none', () => {
  assert.deepEqual(googleChatIntent('check my email'), { kind: 'gmail_list' });
  assert.deepEqual(googleChatIntent('send an email to ann@example.com saying lunch at noon'),
    { kind: 'gmail_send', to: 'ann@example.com', body: 'lunch at noon' });
  assert.deepEqual(googleChatIntent("what's on my calendar tomorrow"), { kind: 'calendar_list', range: 'tomorrow' });
  assert.deepEqual(googleChatIntent('add dentist on 2026-10-20 at 2:30 pm'),
    { kind: 'calendar_create', summary: 'dentist', date: '2026-10-20', time: '14:30' });
  assert.deepEqual(googleChatIntent('list my drive files'), { kind: 'drive_list' });
  assert.deepEqual(googleChatIntent('create a doc called Plan with Step one'), { kind: 'drive_create', name: 'Plan', text: 'Step one' });
  assert.equal(googleChatIntent('hello there'), null);
  assert.equal(googleChatIntent('send money to bob'), null);
});

test('a spoken request for a service that is not connected says so and does nothing', async () => {
  const fetcher = fakeGoogle({});
  const r = await runGoogleIntent({ kind: 'gmail_list' }, { env, data: { google_connections: {} }, fetcher, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.text, /Gmail is not connected, sir/);
  assert.equal(fetcher.calls.length, 0);
});

test('a spoken email send reports the real result', async () => {
  const { sealToken } = await import('./youtube_connection.js');
  const data = { google_connections: { gmail: {
    status: 'connected', refresh: await sealToken(env, 'r'), access: await sealToken(env, 'live-token'), access_expires_at: Date.now() + 3600_000,
  } } };
  const api = fakeGoogle({ 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send': () => json({ id: 'sent-1' }) });
  const r = await runGoogleIntent({ kind: 'gmail_send', to: 'ann@example.com', body: 'lunch' }, { env, data, fetcher: api, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Sent to ann@example.com, sir, with the subject "(no subject)".');
});

test('listing helpers exist and read Drive and Calendar without sending anything', async () => {
  const { sealToken } = await import('./youtube_connection.js');
  const data = { google_connections: {
    drive: { status: 'connected', refresh: await sealToken(env, 'r'), access: await sealToken(env, 't'), access_expires_at: Date.now() + 3600_000 },
    calendar: { status: 'connected', refresh: await sealToken(env, 'r'), access: await sealToken(env, 't'), access_expires_at: Date.now() + 3600_000 },
  } };
  const api = fakeGoogle({
    'https://www.googleapis.com/drive/v3/files': () => json({ files: [{ id: 'f', name: 'Notes', mimeType: 'x', modifiedTime: 'now' }] }),
    'https://www.googleapis.com/calendar/v3/calendars/primary/events': () => json({ items: [{ id: 'e', summary: 'Standup', start: { dateTime: '2026-10-14T15:00:00Z' } }] }),
  });
  assert.equal((await driveList(env, data, {}, api)).files[0].name, 'Notes');
  const cal = await calendarList(env, data, calendarWindow('today', 'America/Chicago', NOW), api);
  assert.equal(cal.events[0].summary, 'Standup');
  assert.ok(api.calls.every((c) => c.method === 'GET'), 'listing never writes');
});
