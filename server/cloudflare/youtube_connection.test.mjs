import assert from 'node:assert/strict';
import test from 'node:test';
import {
  disconnectYouTube,
  finishYouTubeConnect,
  startYouTubeConnect,
  youtubeAccessToken,
  youtubeResultPage,
  youtubeStatus,
} from './youtube_connection.js';

const env = {
  CHE_YOUTUBE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  CHE_YOUTUBE_CLIENT_SECRET: 'client-secret-value',
  CHE_OAUTH_SECRET: 'x'.repeat(40),
};
const ORIGIN = 'https://chey-app.example';
const UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
const READONLY = 'https://www.googleapis.com/auth/youtube.readonly';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A fake Google: token exchange, refresh, revoke and channel lookup.
function fakeGoogle(overrides = {}) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, options });
    if (target.startsWith('https://oauth2.googleapis.com/token')) {
      const form = new URLSearchParams(options.body);
      if (overrides.token) return overrides.token(form);
      if (form.get('grant_type') === 'authorization_code') {
        return json({ access_token: 'access-1', refresh_token: 'refresh-secret-value', scope: `${UPLOAD} ${READONLY}`, expires_in: 3600 });
      }
      return json({ access_token: 'access-2', expires_in: 3600 });
    }
    if (target.startsWith('https://oauth2.googleapis.com/revoke')) {
      return overrides.revoke ? overrides.revoke() : new Response('', { status: 200 });
    }
    if (target.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
      if (overrides.channel) return overrides.channel();
      return json({ items: [{ id: 'UC123', snippet: { title: 'Cognitive Horizon' } }] });
    }
    return new Response('', { status: 404 });
  };
  return { fetcher, calls };
}

async function started(data = {}) {
  const result = await startYouTubeConnect(env, data, ORIGIN);
  assert.equal(result.ok, true, result.error);
  return new URL(result.url);
}

test('sign-in link asks only for upload and read-only YouTube access, with PKCE and offline access', async () => {
  const data = {};
  const url = await started(data);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), `${UPLOAD} ${READONLY}`);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/api/youtube/callback`);
  assert.equal(url.searchParams.get('state'), data.youtube_oauth.state);
  assert.notEqual(url.searchParams.get('code_challenge'), data.youtube_oauth.verifier, 'the verifier is never sent');
});

test('missing Google client secrets are reported by name, not hidden', async () => {
  const result = await startYouTubeConnect({ CHE_OAUTH_SECRET: env.CHE_OAUTH_SECRET }, {}, ORIGIN);
  assert.equal(result.ok, false);
  assert.match(result.error, /CHE_YOUTUBE_CLIENT_ID and CHE_YOUTUBE_CLIENT_SECRET/);
});

test('a missing or short encryption secret stops the connection before Google is involved', async () => {
  const result = await startYouTubeConnect({ ...env, CHE_OAUTH_SECRET: 'short' }, {}, ORIGIN);
  assert.equal(result.ok, false);
  assert.match(result.error, /CHE_OAUTH_SECRET/);
});

test('a successful sign-in verifies the channel and stores only encrypted tokens', async () => {
  const data = {};
  await started(data);
  const { fetcher, calls } = fakeGoogle();
  const state = data.youtube_oauth.state;
  const verifier = data.youtube_oauth.verifier;
  const result = await finishYouTubeConnect(env, data, { code: 'auth-code', state }, fetcher, ORIGIN);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.channel.id, 'UC123');
  assert.equal(result.channel.title, 'Cognitive Horizon');
  const tokenCall = calls.find((c) => c.url.includes('oauth2.googleapis.com/token'));
  assert.equal(new URLSearchParams(tokenCall.options.body).get('code_verifier'), verifier);
  const stored = JSON.stringify(data.youtube);
  assert.equal(stored.includes('refresh-secret-value'), false, 'refresh token is encrypted at rest');
  assert.equal(stored.includes('access-1'), false, 'access token is encrypted at rest');
  assert.equal(data.youtube_oauth, undefined, 'the pending sign-in is used up');
  const status = youtubeStatus(data);
  assert.equal(status.connected, true);
  assert.equal(status.channel_id, 'UC123');
  assert.equal(JSON.stringify(status).includes('refresh'), false);
});

test('a sign-in link works only once and a wrong state is refused', async () => {
  const data = {};
  await started(data);
  const { fetcher } = fakeGoogle();
  const bad = await finishYouTubeConnect(env, data, { code: 'c', state: 'forged' }, fetcher, ORIGIN);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no longer valid/);
  const again = await finishYouTubeConnect(env, data, { code: 'c', state: data.youtube_oauth?.state || 'x' }, fetcher, ORIGIN);
  assert.equal(again.ok, false, 'the pending request was discarded after a mismatch');
});

test('an expired sign-in link is refused', async () => {
  const data = {};
  const start = await startYouTubeConnect(env, data, ORIGIN, 1000);
  assert.equal(start.ok, true);
  const state = data.youtube_oauth.state;
  const { fetcher } = fakeGoogle();
  const result = await finishYouTubeConnect(env, data, { code: 'c', state }, fetcher, ORIGIN, 1000 + 11 * 60 * 1000);
  assert.equal(result.ok, false);
  assert.match(result.error, /no longer valid/);
});

test('Google error codes become plain instructions', async () => {
  const cases = [
    [{ error: 'access_denied' }, /did not approve/],
    [{ error: 'org_internal' }, /test user/],
  ];
  for (const [params, pattern] of cases) {
    const data = {};
    await started(data);
    const result = await finishYouTubeConnect(env, data, { ...params, state: data.youtube_oauth.state }, fakeGoogle().fetcher, ORIGIN);
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
  }
  const data = {};
  await started(data);
  const rejected = fakeGoogle({ token: () => json({ error: 'invalid_client' }, 401) });
  const bad = await finishYouTubeConnect(env, data, { code: 'c', state: data.youtube_oauth.state }, rejected.fetcher, ORIGIN);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /CHE_YOUTUBE_CLIENT_SECRET/);
});

test('missing refresh token or upload permission is reported, not treated as connected', async () => {
  const noRefresh = {};
  await started(noRefresh);
  const a = await finishYouTubeConnect(env, noRefresh, { code: 'c', state: noRefresh.youtube_oauth.state },
    fakeGoogle({ token: () => json({ access_token: 'a', scope: `${UPLOAD} ${READONLY}` }) }).fetcher, ORIGIN);
  assert.equal(a.ok, false);
  assert.match(a.error, /long-term permission/);
  assert.equal(noRefresh.youtube, undefined);

  const noUpload = {};
  await started(noUpload);
  const b = await finishYouTubeConnect(env, noUpload, { code: 'c', state: noUpload.youtube_oauth.state },
    fakeGoogle({ token: () => json({ access_token: 'a', refresh_token: 'r', scope: READONLY }) }).fetcher, ORIGIN);
  assert.equal(b.ok, false);
  assert.match(b.error, /upload permission/);
  assert.equal(noUpload.youtube, undefined);
});

test('an account with no YouTube channel is refused with the right account to use', async () => {
  const data = {};
  await started(data);
  const result = await finishYouTubeConnect(env, data, { code: 'c', state: data.youtube_oauth.state },
    fakeGoogle({ channel: () => json({ items: [] }) }).fetcher, ORIGIN);
  assert.equal(result.ok, false);
  assert.match(result.error, /no YouTube channel/);
  assert.equal(data.youtube, undefined);
});

test('a 403 from YouTube asks for the permissions again instead of saying connected', async () => {
  const data = {};
  await started(data);
  const result = await finishYouTubeConnect(env, data, { code: 'c', state: data.youtube_oauth.state },
    fakeGoogle({ channel: () => new Response('', { status: 403 }) }).fetcher, ORIGIN);
  assert.equal(result.ok, false);
  assert.match(result.error, /approve the YouTube permissions/i);
});

async function connectedData(now = Date.now()) {
  const data = {};
  await started(data);
  await finishYouTubeConnect(env, data, { code: 'c', state: data.youtube_oauth.state }, fakeGoogle().fetcher, ORIGIN, now);
  return data;
}

test('a valid cached access token is used without asking Google again', async () => {
  const now = 1_000_000;
  const data = await connectedData(now);
  const { fetcher, calls } = fakeGoogle();
  const result = await youtubeAccessToken(env, data, fetcher, now + 1000);
  assert.equal(result.ok, true);
  assert.equal(result.token, 'access-1');
  assert.equal(result.changed, false);
  assert.equal(calls.length, 0);
});

test('an expired access token is refreshed with the stored refresh token', async () => {
  const now = 1_000_000;
  const data = await connectedData(now);
  const { fetcher, calls } = fakeGoogle();
  const result = await youtubeAccessToken(env, data, fetcher, now + 2 * 60 * 60 * 1000);
  assert.equal(result.ok, true);
  assert.equal(result.token, 'access-2');
  assert.equal(result.changed, true);
  const refresh = new URLSearchParams(calls[0].options.body);
  assert.equal(refresh.get('grant_type'), 'refresh_token');
  assert.equal(refresh.get('refresh_token'), 'refresh-secret-value');
});

test('a revoked grant is marked for reconnection and not silently retried', async () => {
  const now = 1_000_000;
  const data = await connectedData(now);
  const { fetcher } = fakeGoogle({ token: () => json({ error: 'invalid_grant' }, 400) });
  const result = await youtubeAccessToken(env, data, fetcher, now + 2 * 60 * 60 * 1000);
  assert.equal(result.ok, false);
  assert.equal(result.changed, true);
  assert.match(result.error, /Reconnect YouTube/);
  assert.equal(youtubeStatus(data).status, 'needs_reconnect');
});

test('an unconnected owner gets a clear message, never a token', async () => {
  const result = await youtubeAccessToken(env, {}, fakeGoogle().fetcher);
  assert.equal(result.ok, false);
  assert.match(result.error, /not connected/i);
  assert.equal(result.token, undefined);
});

test('a changed encryption secret reports the connection as unreadable', async () => {
  const now = 1_000_000;
  const data = await connectedData(now);
  const other = { ...env, CHE_OAUTH_SECRET: 'y'.repeat(40) };
  const result = await youtubeAccessToken(other, data, fakeGoogle().fetcher, now + 2 * 60 * 60 * 1000);
  assert.equal(result.ok, false);
  assert.match(result.error, /Reconnect YouTube/);
});

test('disconnect revokes at Google and removes the local copy even when Google is unreachable', async () => {
  const data = await connectedData();
  const { fetcher, calls } = fakeGoogle();
  const removed = await disconnectYouTube(env, data, fetcher);
  assert.equal(removed.ok, true);
  assert.equal(removed.revoked_at_google, true);
  assert.equal(data.youtube, undefined);
  assert.ok(calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke')));

  const offline = await connectedData();
  const failed = await disconnectYouTube(env, offline, fakeGoogle({ revoke: () => { throw new Error('offline'); } }).fetcher);
  assert.equal(failed.ok, true);
  assert.equal(failed.revoked_at_google, false);
  assert.equal(offline.youtube, undefined);
});

test('the browser result page escapes the channel name and never shows tokens', async () => {
  const page = await youtubeResultPage(true, 'Connected to <img src=x onerror=alert(1)>.').text();
  assert.equal(page.includes('<img'), false);
  assert.match(page, /&lt;img/);
  const failed = youtubeResultPage(false, 'Google rejected it.');
  assert.equal(failed.status, 400);
});
