// YouTube connection: Google OAuth 2.0 authorization-code flow with PKCE.
// The owner signs in with his own Google account on Google's screen and
// approves the YouTube permissions. CHE keeps a refresh token encrypted in the
// owner's store, refreshes short-lived access tokens itself, and verifies the
// connected channel. Tokens never leave the server: the app only sees status.

export const YOUTUBE_CALLBACK_PATH = '/api/youtube/callback';
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CHANNEL_URL = 'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true';
const PENDING_TTL_MS = 10 * 60 * 1000;
const ACCESS_SAFETY_MS = 60 * 1000;

function b64url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function randomToken(bytes) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

// Google's error codes, in the owner's words.
const GOOGLE_ERRORS = {
  access_denied: 'You did not approve CHE on Google\'s screen. Start Connect YouTube again and approve the permissions.',
  redirect_uri_mismatch: 'The redirect address does not match the Google OAuth client. Add exactly this address to the client: CHE callback URL.',
  invalid_client: 'Google rejected the CHE OAuth client ID or secret. Check the Cloudflare secrets CHE_YOUTUBE_CLIENT_ID and CHE_YOUTUBE_CLIENT_SECRET.',
  invalid_grant: 'Google says this sign-in expired or was already used. Start Connect YouTube again.',
  org_internal: 'This Google account is outside the OAuth app\'s allowed users. Add the account as a test user, or publish the OAuth app.',
  disallowed_useragent: 'Google blocked the sign-in page in this browser. Open the link in Safari or Chrome.',
};

export function googleErrorMessage(code) {
  return GOOGLE_ERRORS[code] || `Google did not complete the sign-in (${String(code || 'unknown error').slice(0, 80)}).`;
}

function clientConfig(env, origin) {
  const clientId = String(env.CHE_YOUTUBE_CLIENT_ID || '').trim();
  const clientSecret = String(env.CHE_YOUTUBE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    return { error: 'Google sign-in is not set up. The Cloudflare secrets CHE_YOUTUBE_CLIENT_ID and CHE_YOUTUBE_CLIENT_SECRET are missing.' };
  }
  const publicOrigin = String(env.CHE_PUBLIC_URL || origin || '').replace(/\/+$/, '');
  return { clientId, clientSecret, redirectUri: `${publicOrigin}${YOUTUBE_CALLBACK_PATH}` };
}

async function sealingKey(env) {
  const secret = String(env.CHE_OAUTH_SECRET || '');
  if (secret.length < 32) return null;
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`che-youtube:${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Encrypts a token with CHE_OAUTH_SECRET. Without that secret nothing is stored.
async function seal(env, text) {
  const key = await sealingKey(env);
  if (!key) throw new Error('CHE_OAUTH_SECRET is missing or too short (use at least 32 random characters).');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ciphertext)) };
}

// Returns '' when the value cannot be opened (missing or changed secret).
async function open(env, sealed) {
  const key = await sealingKey(env);
  if (!key || !sealed?.iv || !sealed?.ct) return '';
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(sealed.iv) }, key, fromB64url(sealed.ct));
    return new TextDecoder().decode(plain);
  } catch {
    return '';
  }
}

async function postForm(fetcher, url, fields) {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, json };
}

// Step 1: the Google sign-in address for the app to open in the browser.
export async function startYouTubeConnect(env, data, origin, now = Date.now()) {
  const config = clientConfig(env, origin);
  if (config.error) return { ok: false, error: config.error };
  if (!(await sealingKey(env))) {
    return { ok: false, error: 'CHE_OAUTH_SECRET is missing or too short, so CHE cannot store the YouTube authorization safely.' };
  }
  const state = randomToken(24);
  const verifier = randomToken(48);
  data.youtube_oauth = { state, verifier, created_at: now };
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return { ok: true, url: `${AUTH_URL}?${params.toString()}` };
}

async function channelFor(accessToken, fetcher) {
  const response = await fetcher(CHANNEL_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(12000),
  });
  const json = await response.json().catch(() => ({}));
  if (response.status === 403) {
    return { ok: false, error: 'Google did not allow CHE to read your channel. Approve the YouTube permissions on the Google screen again.' };
  }
  if (!response.ok) return { ok: false, error: `YouTube did not return your channel (HTTP ${response.status}).` };
  const channel = Array.isArray(json.items) ? json.items[0] : null;
  if (!channel?.id) {
    return { ok: false, error: 'This Google account has no YouTube channel. Sign in with the account that owns your channel.' };
  }
  return { ok: true, id: String(channel.id), title: String(channel.snippet?.title || '').slice(0, 100) };
}

// Step 2: Google redirects back with a code. The state must match the pending
// request, which is then discarded so the link works only once.
export async function finishYouTubeConnect(env, data, params, fetcher = fetch, origin = '', now = Date.now()) {
  const pending = data.youtube_oauth;
  delete data.youtube_oauth;
  if (params.error) return { ok: false, error: googleErrorMessage(params.error) };
  if (!pending || !params.state || params.state !== pending.state || now - pending.created_at > PENDING_TTL_MS) {
    return { ok: false, error: 'This sign-in link is no longer valid. Start Connect YouTube again.' };
  }
  const config = clientConfig(env, origin);
  if (config.error) return { ok: false, error: config.error };
  if (!(await sealingKey(env))) {
    return { ok: false, error: 'CHE_OAUTH_SECRET is missing or too short, so CHE cannot store the YouTube authorization safely.' };
  }
  if (!params.code) return { ok: false, error: 'Google did not send a sign-in code. Start Connect YouTube again.' };

  const token = await postForm(fetcher, TOKEN_URL, {
    code: params.code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: pending.verifier,
  });
  if (!token.ok) return { ok: false, error: googleErrorMessage(token.json.error) };
  if (!token.json.refresh_token) {
    return { ok: false, error: 'Google did not give CHE a long-term permission. Remove CHE from your Google account permissions, then connect again.' };
  }
  const granted = String(token.json.scope || '').split(' ');
  if (!granted.includes(YOUTUBE_SCOPES[0])) {
    return { ok: false, error: 'The YouTube upload permission was not approved. Connect again and approve it.' };
  }

  const channel = await channelFor(token.json.access_token, fetcher);
  if (!channel.ok) return channel;

  data.youtube = {
    status: 'connected',
    channel_id: channel.id,
    channel_title: channel.title,
    connected_at: new Date(now).toISOString(),
    scopes: granted,
    refresh: await seal(env, token.json.refresh_token),
    access: await seal(env, token.json.access_token),
    access_expires_at: now + Number(token.json.expires_in || 3600) * 1000 - ACCESS_SAFETY_MS,
  };
  return { ok: true, channel: { id: channel.id, title: channel.title } };
}

// Returns a valid access token, refreshing it when needed. `changed` tells the
// caller to save the store. A revoked grant is recorded as needs_reconnect.
export async function youtubeAccessToken(env, data, fetcher = fetch, now = Date.now()) {
  const conn = data.youtube;
  if (!conn || conn.status !== 'connected') {
    return { ok: false, error: 'YouTube is not connected. Connect YouTube first.' };
  }
  if (conn.access && conn.access_expires_at > now) {
    const cached = await open(env, conn.access);
    if (cached) return { ok: true, token: cached, changed: false };
  }
  const refreshToken = await open(env, conn.refresh);
  const config = clientConfig(env, '');
  if (!refreshToken || config.error) {
    return { ok: false, error: config.error || 'The stored YouTube authorization cannot be read. Reconnect YouTube.' };
  }
  const refreshed = await postForm(fetcher, TOKEN_URL, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!refreshed.ok || !refreshed.json.access_token) {
    if (refreshed.json.error === 'invalid_grant') {
      conn.status = 'needs_reconnect';
      return {
        ok: false,
        changed: true,
        error: 'Google no longer accepts CHE\'s YouTube authorization (revoked, expired, or the app is in testing mode). Reconnect YouTube.',
      };
    }
    return { ok: false, changed: false, error: googleErrorMessage(refreshed.json.error) };
  }
  conn.access = await seal(env, refreshed.json.access_token);
  conn.access_expires_at = now + Number(refreshed.json.expires_in || 3600) * 1000 - ACCESS_SAFETY_MS;
  return { ok: true, token: refreshed.json.access_token, changed: true };
}

// What the app may show. No tokens, ever.
export function youtubeStatus(data) {
  const conn = data.youtube;
  if (!conn) return { connected: false, status: 'not_connected' };
  return {
    connected: conn.status === 'connected',
    status: conn.status,
    channel_id: conn.channel_id,
    channel_title: conn.channel_title,
    connected_at: conn.connected_at,
  };
}

// Revokes the grant at Google and forgets it here. The local copy is removed
// even if Google cannot be reached, and the reply says which part worked.
export async function disconnectYouTube(env, data, fetcher = fetch) {
  const conn = data.youtube;
  if (!conn) return { ok: true, revoked_at_google: false, was_connected: false };
  let revoked = false;
  const refreshToken = await open(env, conn.refresh).catch(() => '');
  if (refreshToken) {
    const result = await postForm(fetcher, REVOKE_URL, { token: refreshToken }).catch(() => ({ ok: false }));
    revoked = result.ok === true;
  }
  delete data.youtube;
  return { ok: true, was_connected: true, revoked_at_google: revoked };
}

// A small page for the browser tab that Google returns to. Text is escaped.
export function youtubeResultPage(ok, message) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const title = ok ? 'YouTube connected' : 'YouTube not connected';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px 16px;line-height:1.5;font-size:20px}</style>
</head><body><h1 style="font-size:26px">${esc(title)}</h1><p>${esc(message)}</p>
<p>You can close this tab and return to CHE.</p></body></html>`;
  return new Response(body, {
    status: ok ? 200 : 400,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
