// Google services beyond YouTube: Gmail, Google Drive, Google Calendar and
// Google Ads. Each one is its own Google sign-in that asks only for that
// service's permissions, so the owner approves each service on its own screen.
// It reuses the YouTube module's OAuth client, PKCE, sealed refresh tokens,
// revoke-on-replace and callback address. Tokens never leave the server.
import {
  ACCESS_SAFETY_MS, AUTH_URL, PENDING_TTL_MS, TOKEN_URL, codeChallenge, googleClientConfig,
  googleErrorMessage, openToken, postForm, randomToken, revokeGrant, sealToken,
} from './youtube_connection.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export function adsApiBase(env = {}) {
  const version = /^v\d{1,2}$/.test(String(env.CHE_GOOGLE_ADS_API_VERSION || '')) ? env.CHE_GOOGLE_ADS_API_VERSION : 'v20';
  return `https://googleads.googleapis.com/${version}`;
}

function developerToken(env = {}) {
  return String(env.CHE_GOOGLE_ADS_DEVELOPER_TOKEN || '').trim();
}

// Each service lists the only scopes CHE asks for. Gmail can read and send but
// not modify or delete; Drive sees only files CHE creates or the owner opens
// with it; Calendar works on events only.
export const GOOGLE_SERVICES = Object.freeze({
  gmail: {
    label: 'Gmail',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    async verify(token, fetcher) {
      const r = await googleCall(fetcher, 'GET', `${GMAIL}/profile`, token);
      if (!r.ok) throw new Error(callError('Gmail', r));
      return String(r.json.emailAddress || '').slice(0, 200);
    },
  },
  drive: {
    label: 'Google Drive',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    async verify(token, fetcher) {
      const r = await googleCall(fetcher, 'GET', `${DRIVE}/about?fields=user`, token);
      if (!r.ok) throw new Error(callError('Google Drive', r));
      return String(r.json.user?.emailAddress || '').slice(0, 200);
    },
  },
  calendar: {
    label: 'Google Calendar',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    async verify(token, fetcher) {
      const r = await googleCall(fetcher, 'GET', `${CALENDAR}/events?maxResults=1`, token);
      if (!r.ok) throw new Error(callError('Google Calendar', r));
      return 'your primary calendar';
    },
  },
  google_ads: {
    label: 'Google Ads',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    // Ads needs Google's developer token; without it the grant is kept but not ready.
    async verify(token, fetcher, env) {
      const dev = developerToken(env);
      if (!dev) return '';
      const r = await googleCall(fetcher, 'GET', `${adsApiBase(env)}/customers:listAccessibleCustomers`, token, null, { 'developer-token': dev });
      if (!r.ok) throw new Error(callError('Google Ads', r));
      const count = (r.json.resourceNames || []).length;
      return `${count} accessible Google Ads account${count === 1 ? '' : 's'}`;
    },
  },
});

export function isGoogleService(id) {
  return Object.prototype.hasOwnProperty.call(GOOGLE_SERVICES, id);
}

// The owner's name for a service, for pages and replies.
export function googleLabel(id) {
  return isGoogleService(id) ? GOOGLE_SERVICES[id].label : 'Google';
}

function callError(label, r) {
  if (r.status === 0) return `Google did not answer ${label}. Try again.`;
  if (r.status === 401) return `Google no longer accepts CHE's ${label} sign-in. Reconnect ${label} on the Connections page.`;
  if (r.status === 403) {
    const reason = String(r.json?.error?.message || 'permission denied').slice(0, 140);
    return `Google refused ${label} for this account (${reason}). Reconnect ${label} and approve every permission.`;
  }
  return `${label} returned an error (HTTP ${r.status}).`;
}

async function googleCall(fetcher, method, url, token, body = null, headers = {}) {
  const init = { method, headers: { authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout(15000) };
  if (body !== null) {
    if (typeof body === 'string') init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] ??= 'application/json';
    }
  }
  let response;
  try {
    response = await fetcher(url, init);
  } catch {
    return { ok: false, status: 0, json: {} };
  }
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, json };
}

// Step 1: the Google sign-in address for one service. The pending request is
// stored once; a new request replaces it.
export async function startGoogleConnect(env, data, origin, service, now = Date.now()) {
  if (!isGoogleService(service)) return { ok: false, error: 'CHE cannot connect that Google service.' };
  const spec = GOOGLE_SERVICES[service];
  const config = googleClientConfig(env, origin);
  if (config.error) return { ok: false, error: config.error };
  try {
    await sealToken(env, 'check');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const state = randomToken(24);
  const verifier = randomToken(48);
  data.google_oauth = { service, state, verifier, created_at: now };
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: spec.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'false',
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return { ok: true, url: `${AUTH_URL}?${params.toString()}` };
}

// Step 2: Google redirects back to the shared callback with a code. Only the
// pending request's state is accepted, and it is discarded either way.
export async function finishGoogleConnect(env, data, params, fetcher = fetch, origin = '', now = Date.now()) {
  const pending = data.google_oauth;
  const matches = Boolean(pending && params.state && params.state === pending.state
    && now - pending.created_at <= PENDING_TTL_MS && isGoogleService(pending.service));
  if (!matches) return { ok: false, error: 'This sign-in link is no longer valid. Start the Google connection again.' };
  delete data.google_oauth;
  const spec = GOOGLE_SERVICES[pending.service];
  if (params.error) return { ok: false, service: pending.service, error: googleErrorMessage(params.error) };
  const config = googleClientConfig(env, origin);
  if (config.error) return { ok: false, service: pending.service, error: config.error };
  if (!params.code) return { ok: false, service: pending.service, error: `Google did not send a sign-in code for ${spec.label}. Connect again.` };

  const token = await postForm(fetcher, TOKEN_URL, {
    code: params.code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: pending.verifier,
  });
  if (!token.ok) return { ok: false, service: pending.service, error: googleErrorMessage(token.json.error) };
  if (!token.json.refresh_token) {
    await revokeGrant(fetcher, token.json.access_token);
    return { ok: false, service: pending.service, error: `Google did not give CHE a long-term ${spec.label} permission. Remove CHE from your Google permissions and connect again.` };
  }
  const granted = String(token.json.scope || '').split(' ');
  const missing = spec.scopes.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    await revokeGrant(fetcher, token.json.refresh_token);
    return { ok: false, service: pending.service, error: `${spec.label} needs every permission approved. Connect again and approve them all.` };
  }
  let account;
  try {
    account = await spec.verify(token.json.access_token, fetcher, env);
  } catch (e) {
    await revokeGrant(fetcher, token.json.refresh_token);
    return { ok: false, service: pending.service, error: e.message };
  }
  // Reconnecting replaces the old grant, so the old one is revoked at Google.
  data.google_connections ||= {};
  const previous = data.google_connections[pending.service];
  const previousRefresh = previous ? await openToken(env, previous.refresh).catch(() => '') : '';
  if (previousRefresh && previousRefresh !== token.json.refresh_token) await revokeGrant(fetcher, previousRefresh);
  data.google_connections[pending.service] = {
    status: 'connected',
    account,
    scopes: granted.filter((scope) => spec.scopes.includes(scope)),
    connected_at: new Date(now).toISOString(),
    refresh: await sealToken(env, token.json.refresh_token),
    access: await sealToken(env, token.json.access_token),
    access_expires_at: now + Number(token.json.expires_in || 3600) * 1000 - ACCESS_SAFETY_MS,
  };
  return { ok: true, service: pending.service, label: spec.label, account };
}

// A usable access token for one service, refreshed when needed. A grant Google
// no longer accepts is recorded as needs_reconnect.
export async function googleAccessToken(env, data, service, fetcher = fetch, now = Date.now()) {
  if (!isGoogleService(service)) return { ok: false, error: 'CHE cannot use that Google service.' };
  const label = GOOGLE_SERVICES[service].label;
  const conn = data.google_connections?.[service];
  if (conn?.status === 'needs_reconnect') return { ok: false, error: `Google no longer accepts CHE's ${label} authorization. Reconnect ${label}.` };
  if (!conn || conn.status !== 'connected') return { ok: false, error: `${label} is not connected. Connect ${label} first.` };
  if (conn.access && conn.access_expires_at > now) {
    const cached = await openToken(env, conn.access);
    if (cached) return { ok: true, token: cached };
  }
  const refreshToken = await openToken(env, conn.refresh);
  const config = googleClientConfig(env, '');
  if (!refreshToken || config.error) {
    return { ok: false, error: config.error || `The stored ${label} authorization cannot be read. Reconnect ${label}.` };
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
      return { ok: false, error: `Google no longer accepts CHE's ${label} authorization (revoked, expired, or the app is in testing mode). Reconnect ${label}.` };
    }
    return { ok: false, error: googleErrorMessage(refreshed.json.error) };
  }
  conn.access = await sealToken(env, refreshed.json.access_token);
  conn.access_expires_at = now + Number(refreshed.json.expires_in || 3600) * 1000 - ACCESS_SAFETY_MS;
  return { ok: true, token: refreshed.json.access_token };
}

// What the app may show: status and the signed-in address, never a token.
export async function googleStates(env, data) {
  const out = {};
  for (const [id, spec] of Object.entries(GOOGLE_SERVICES)) {
    const conn = data.google_connections?.[id];
    if (!conn) {
      out[id] = { connected: false, status: 'not_connected', label: spec.label };
      continue;
    }
    const readable = Boolean(await openToken(env, conn.refresh));
    const status = conn.status === 'connected' && !readable ? 'needs_reconnect' : conn.status;
    out[id] = {
      connected: status === 'connected', status, label: spec.label,
      account: conn.account || '', connected_at: conn.connected_at || '', scopes: conn.scopes || [],
    };
  }
  return out;
}

// Connector readiness for the Command Center and the Connections page.
export async function googleConnectorStates(env, data) {
  const states = await googleStates(env, data);
  const out = {};
  for (const [id, s] of Object.entries(states)) {
    if (id === 'google_ads' && s.connected && !developerToken(env)) {
      out[id] = { state: 'not_connected', detail: 'Signed in, but CHE needs the Google Ads developer token (CHE_GOOGLE_ADS_DEVELOPER_TOKEN) from Google Ads API approval.' };
    } else if (s.connected) {
      out[id] = { state: 'ready', detail: s.account || `${s.label} connected` };
    } else if (s.status === 'needs_reconnect') {
      out[id] = { state: 'needs_reconnect', detail: `Reconnect ${s.label}.` };
    } else {
      out[id] = { state: 'not_connected', detail: `${s.label} is not connected.` };
    }
  }
  return out;
}

// Revokes the grant at Google and forgets it here. The local copy is removed
// even when Google cannot be reached, and the reply says which part worked.
export async function disconnectGoogle(env, data, service, fetcher = fetch) {
  if (!isGoogleService(service)) return { ok: false, error: 'CHE cannot disconnect that Google service.' };
  const label = GOOGLE_SERVICES[service].label;
  const conn = data.google_connections?.[service];
  if (!conn) return { ok: true, label, was_connected: false, revoked_at_google: false };
  const refresh = await openToken(env, conn.refresh).catch(() => '');
  const revoked = await revokeGrant(fetcher, refresh);
  delete data.google_connections[service];
  return { ok: true, label, was_connected: true, revoked_at_google: revoked };
}

const clampCount = (value, fallback, max) => Math.min(Math.max(Number(value) || fallback, 1), max);

// Gmail: the newest messages matching a Gmail search (unread by default).
export async function gmailList(env, data, { query = 'is:unread', max = 5 } = {}, fetcher = fetch) {
  const access = await googleAccessToken(env, data, 'gmail', fetcher);
  if (!access.ok) return access;
  const size = clampCount(max, 5, 10);
  const list = await googleCall(fetcher, 'GET', `${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(size) })}`, access.token);
  if (!list.ok) return { ok: false, error: callError('Gmail', list) };
  const messages = [];
  for (const item of (list.json.messages || []).slice(0, size)) {
    const meta = await googleCall(fetcher, 'GET', `${GMAIL}/messages/${encodeURIComponent(item.id)}?${new URLSearchParams([
      ['format', 'metadata'], ['metadataHeaders', 'From'], ['metadataHeaders', 'Subject'], ['metadataHeaders', 'Date'],
    ])}`, access.token);
    if (!meta.ok) continue;
    const header = (name) => String((meta.json.payload?.headers || [])
      .find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value || '');
    messages.push({
      id: String(item.id),
      from: header('From').slice(0, 200),
      subject: header('Subject').slice(0, 200) || '(no subject)',
      date: header('Date').slice(0, 60),
      snippet: String(meta.json.snippet || '').slice(0, 160),
    });
  }
  return { ok: true, messages, total: list.json.resultSizeEstimate ?? messages.length };
}

const utf8 = (text) => new TextEncoder().encode(text);

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64url(bytes) {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The RFC 2822 message Gmail's send endpoint takes. Header values lose their
// line breaks, so no text can add a header. The subject is MIME-encoded.
export function buildRawEmail({ to, subject, body }) {
  const header = (text) => String(text).replace(/[\r\n]+/g, ' ').trim();
  const lines = [
    `To: ${header(to)}`,
    `Subject: =?UTF-8?B?${base64(utf8(header(subject)))}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64(utf8(String(body))).replace(/(.{76})/g, '$1\r\n'),
  ];
  return base64url(utf8(lines.join('\r\n')));
}

// Gmail: send one plain-text email. The owner's standing permission covers it;
// nothing is sent unless the address and the text are complete.
export async function gmailSend(env, data, { to, subject = '', body = '' } = {}, fetcher = fetch) {
  const address = String(to || '').trim();
  if (address.length > 254 || !EMAIL.test(address)) return { ok: false, error: 'That is not a full email address.' };
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'The email has no message text.' };
  if (text.length > 20000) return { ok: false, error: 'The email is too long to send from here.' };
  const access = await googleAccessToken(env, data, 'gmail', fetcher);
  if (!access.ok) return access;
  const title = String(subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || '(no subject)';
  const sent = await googleCall(fetcher, 'POST', `${GMAIL}/messages/send`, access.token, {
    raw: buildRawEmail({ to: address, subject: title, body: text }),
  });
  if (!sent.ok) return { ok: false, error: callError('Gmail', sent) };
  return { ok: true, id: String(sent.json.id || ''), to: address, subject: title };
}

// Drive: files CHE created or the owner opened with CHE (drive.file scope).
export async function driveList(env, data, { max = 10 } = {}, fetcher = fetch) {
  const access = await googleAccessToken(env, data, 'drive', fetcher);
  if (!access.ok) return access;
  const params = new URLSearchParams({
    pageSize: String(clampCount(max, 10, 25)),
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });
  const r = await googleCall(fetcher, 'GET', `${DRIVE}/files?${params}`, access.token);
  if (!r.ok) return { ok: false, error: callError('Google Drive', r) };
  return {
    ok: true,
    files: (r.json.files || []).map((f) => ({
      id: String(f.id || ''), name: String(f.name || '').slice(0, 200),
      mimeType: String(f.mimeType || ''), modifiedTime: String(f.modifiedTime || ''),
      link: String(f.webViewLink || ''),
    })),
  };
}

// The multipart body that makes a Google Doc from plain text.
export function buildDriveUpload(name, text, boundary) {
  const metadata = { name: String(name).slice(0, 200), mimeType: 'application/vnd.google-apps.document' };
  return [
    `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', String(text),
    `--${boundary}--`, '',
  ].join('\r\n');
}

// Drive: create a Google Doc named as the owner says, with the given text.
export async function driveCreateDoc(env, data, { name, text } = {}, fetcher = fetch) {
  const title = String(name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  if (!title) return { ok: false, error: 'The document needs a name.' };
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'The document has no text.' };
  if (body.length > 100000) return { ok: false, error: 'The document text is too long to create from here.' };
  const access = await googleAccessToken(env, data, 'drive', fetcher);
  if (!access.ok) return access;
  const boundary = `che${randomToken(12)}`;
  const r = await googleCall(fetcher, 'POST', `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink`,
    access.token, buildDriveUpload(title, body, boundary), { 'content-type': `multipart/related; boundary=${boundary}` });
  if (!r.ok) return { ok: false, error: callError('Google Drive', r) };
  return { ok: true, id: String(r.json.id || ''), name: String(r.json.name || title), link: String(r.json.webViewLink || '') };
}

function zonedParts(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    h: Number(parts.hour), mi: Number(parts.minute), s: Number(parts.second) };
}

function zoneOffsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - ms;
}

// The instant of a wall-clock time in a time zone (two passes handle DST).
export function zonedWallTimeToUtc(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone);
}

// A valid IANA time zone, or UTC. The owner sets CHE_TIMEZONE for his own.
export function safeTimeZone(name) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    return 'UTC';
  }
}

// The UTC window for "today", "tomorrow" or "this week" in the owner's zone.
export function calendarWindow(range, timeZone, now = Date.now()) {
  const p = zonedParts(now, timeZone);
  const offsetDays = range === 'tomorrow' ? 1 : 0;
  const days = range === 'this week' ? 7 : 1;
  const start = zonedWallTimeToUtc(p.y, p.m, p.d + offsetDays, 0, 0, timeZone);
  const end = zonedWallTimeToUtc(p.y, p.m, p.d + offsetDays + days, 0, 0, timeZone);
  return { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() };
}

// Calendar: events in a window, earliest first.
export async function calendarList(env, data, { timeMin, timeMax, max = 10 } = {}, fetcher = fetch) {
  const access = await googleAccessToken(env, data, 'calendar', fetcher);
  if (!access.ok) return access;
  const params = new URLSearchParams({
    singleEvents: 'true', orderBy: 'startTime', maxResults: String(clampCount(max, 10, 25)), timeMin, timeMax,
  });
  const r = await googleCall(fetcher, 'GET', `${CALENDAR}/events?${params}`, access.token);
  if (!r.ok) return { ok: false, error: callError('Google Calendar', r) };
  return {
    ok: true,
    events: (r.json.items || []).map((e) => ({
      id: String(e.id || ''),
      summary: String(e.summary || '(no title)').slice(0, 200),
      start: String(e.start?.dateTime || e.start?.date || ''),
      end: String(e.end?.dateTime || e.end?.date || ''),
      link: String(e.htmlLink || ''),
    })),
  };
}

const pad = (n) => String(n).padStart(2, '0');

// Calendar: one event on a given date and time in a time zone.
export async function calendarCreate(env, data, { summary, date, time, durationMinutes = 60, timeZone } = {}, fetcher = fetch) {
  const title = String(summary || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  if (!title) return { ok: false, error: 'The event needs a title.' };
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!dateMatch) return { ok: false, error: 'The event needs a date like 2026-10-20.' };
  const [year, month, day] = [Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])];
  const real = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) {
    return { ok: false, error: 'That is not a real calendar date.' };
  }
  if (!timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) return { ok: false, error: 'The event needs a time like 14:30.' };
  const zone = safeTimeZone(timeZone || 'UTC');
  const startMs = zonedWallTimeToUtc(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]),
    Number(timeMatch[1]), Number(timeMatch[2]), zone);
  const endMs = startMs + clampCount(durationMinutes, 60, 24 * 60) * 60000;
  const wall = (ms) => {
    const p = zonedParts(ms, zone);
    return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:00`;
  };
  const access = await googleAccessToken(env, data, 'calendar', fetcher);
  if (!access.ok) return access;
  const r = await googleCall(fetcher, 'POST', `${CALENDAR}/events`, access.token, {
    summary: title,
    start: { dateTime: wall(startMs), timeZone: zone },
    end: { dateTime: wall(endMs), timeZone: zone },
  });
  if (!r.ok) return { ok: false, error: callError('Google Calendar', r) };
  return { ok: true, id: String(r.json.id || ''), summary: title, start: String(r.json.start?.dateTime || wall(startMs)), link: String(r.json.htmlLink || '') };
}

// Google Ads: the customer accounts this sign-in can reach (listing only).
export async function adsCustomers(env, data, fetcher = fetch) {
  const dev = developerToken(env);
  if (!dev) return { ok: false, error: 'Google Ads needs the developer token (CHE_GOOGLE_ADS_DEVELOPER_TOKEN) from Google Ads API approval. Nothing was read.' };
  const access = await googleAccessToken(env, data, 'google_ads', fetcher);
  if (!access.ok) return access;
  const r = await googleCall(fetcher, 'GET', `${adsApiBase(env)}/customers:listAccessibleCustomers`, access.token, null, { 'developer-token': dev });
  if (!r.ok) return { ok: false, error: callError('Google Ads', r) };
  return { ok: true, customers: (r.json.resourceNames || []).map((n) => String(n).replace(/^customers\//, '')) };
}

const TIME_OF_DAY = (hour, minute, meridiem) => {
  let h = Number(hour);
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  return `${pad(h)}:${minute}`;
};

// What the owner says in Chat about Gmail, Drive and Calendar, matched
// deterministically before any model is asked. Null means "not one of these".
export function googleChatIntent(message) {
  const t = String(message || '').trim().replace(/\s+/g, ' ');
  let m = null;
  if (/^(?:check|read|show|list|any)\s+(?:my\s+)?(?:new\s+|unread\s+)?(?:e-?mails?|inbox|gmail)\b/i.test(t)) return { kind: 'gmail_list' };
  m = t.match(/^(?:send|email|mail)\s+(?:an?\s+)?(?:e-?mail\s+)?to\s+([^\s,;]+@[^\s,;]+)\s*(?:saying|that says|with the message|:)\s*(.+)$/i);
  if (m) return { kind: 'gmail_send', to: m[1], body: m[2] };
  m = t.match(/^(?:what(?:'s| is)\s+on|show|check|list)\s+(?:my\s+)?(?:google\s+)?calendar(?:\s+(today|tomorrow|this week))?$/i);
  if (m) return { kind: 'calendar_list', range: (m[1] || 'today').toLowerCase() };
  if (/^(?:list|show|check)\s+(?:my\s+)?(?:google\s+)?drive(?:\s+files)?$/i.test(t)) return { kind: 'drive_list' };
  m = t.match(/^(?:create|make|save)\s+(?:a\s+)?(?:google\s+)?(?:doc|document|drive file|file)\s+(?:called|named)\s+(.+?)\s+(?:with|saying|containing)\s+(.+)$/i);
  if (m) return { kind: 'drive_create', name: m[1], text: m[2] };
  m = t.match(/^(?:add|schedule|put|create)\s+(?:an?\s+|the\s+)?(?:event|meeting|appointment|calendar event)?\s*(?:called\s+|titled\s+)?(.+?)\s+on\s+(\d{4}-\d{2}-\d{2})\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (m) return { kind: 'calendar_create', summary: m[1], date: m[2], time: TIME_OF_DAY(m[3], m[4], m[5]?.toLowerCase()) };
  return null;
}

const SERVICE_FOR_KIND = {
  gmail_list: 'gmail', gmail_send: 'gmail', drive_list: 'drive', drive_create: 'drive',
  calendar_list: 'calendar', calendar_create: 'calendar',
};

function clock(iso, zone) {
  if (!iso) return '';
  if (!/T/.test(iso)) return 'all day';
  const p = zonedParts(Date.parse(iso), zone);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

// Runs one owner request and returns the spoken reply with its real result.
export async function runGoogleIntent(intent, { env = {}, data, fetcher = fetch, now = Date.now() } = {}) {
  const service = SERVICE_FOR_KIND[intent.kind];
  const label = GOOGLE_SERVICES[service].label;
  const state = data.google_connections?.[service];
  if (!state) {
    return { ok: false, text: `${label} is not connected, sir. Say connect my ${label} or open Connections. Nothing was done.` };
  }
  if (state.status !== 'connected') {
    return { ok: false, text: `Google no longer accepts CHE's ${label} sign-in, sir. Reconnect ${label} on the Connections page. Nothing was done.` };
  }
  const zone = safeTimeZone(env.CHE_TIMEZONE || 'America/Chicago');
  if (intent.kind === 'gmail_list') {
    const r = await gmailList(env, data, {}, fetcher);
    if (!r.ok) return { ok: false, text: `I could not read your email, sir. ${r.error}` };
    if (!r.messages.length) return { ok: true, text: 'No unread email, sir.' };
    const lines = r.messages.map((m, i) => `${i + 1}: from ${m.from || 'unknown'}, ${m.subject}`);
    return { ok: true, text: `You have ${r.total} unread email${r.total === 1 ? '' : 's'}, sir. The newest: ${lines.join('. ')}.` };
  }
  if (intent.kind === 'gmail_send') {
    const r = await gmailSend(env, data, { to: intent.to, body: intent.body }, fetcher);
    if (!r.ok) return { ok: false, text: `The email was not sent, sir. ${r.error}` };
    return { ok: true, text: `Sent to ${r.to}, sir, with the subject "${r.subject}".` };
  }
  if (intent.kind === 'calendar_list') {
    const window = calendarWindow(intent.range, zone, now);
    const r = await calendarList(env, data, window, fetcher);
    if (!r.ok) return { ok: false, text: `I could not read your calendar, sir. ${r.error}` };
    if (!r.events.length) return { ok: true, text: `Nothing on your calendar for ${intent.range}, sir.` };
    return { ok: true, text: `Your calendar for ${intent.range}, sir: ${r.events.map((e) => `${clock(e.start, zone)} ${e.summary}`).join('; ')}.` };
  }
  if (intent.kind === 'calendar_create') {
    const r = await calendarCreate(env, data, { summary: intent.summary, date: intent.date, time: intent.time, timeZone: zone }, fetcher);
    if (!r.ok) return { ok: false, text: `The event was not added, sir. ${r.error}` };
    return { ok: true, text: `Added "${r.summary}" on ${intent.date} at ${intent.time} in your calendar, sir.` };
  }
  if (intent.kind === 'drive_list') {
    const r = await driveList(env, data, {}, fetcher);
    if (!r.ok) return { ok: false, text: `I could not list your Drive files, sir. ${r.error}` };
    if (!r.files.length) return { ok: true, text: 'No Drive files are visible to CHE yet, sir. CHE only sees files it creates or that you open with it.' };
    return { ok: true, text: `Drive files CHE can see, sir: ${r.files.map((f) => f.name).join('; ')}.` };
  }
  const r = await driveCreateDoc(env, data, { name: intent.name, text: intent.text }, fetcher);
  if (!r.ok) return { ok: false, text: `The document was not created, sir. ${r.error}` };
  return { ok: true, text: `I created the Google Doc "${r.name}", sir.` };
}
