// Google services beyond YouTube: Gmail, Google Drive, Google Calendar and
// Google Ads. Each one is its own Google sign-in that asks only for that
// service's permissions, so the owner approves each service on its own screen.
// It reuses the YouTube module's OAuth client, PKCE, sealed refresh tokens,
// revoke-on-replace and callback address. Tokens never leave the server.
import { isOwnerYes } from './owner_action_gate.js';
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
    // Connected only when Google lists a real account for this sign-in. Google sets
    // Ads access by Cloud project; until it confirms CHE's access, the grant is kept
    // and the status is Needs Setup (NeedsAccess), never Connected.
    async verify(token, fetcher, env) {
      const r = await googleCall(fetcher, 'GET', `${adsApiBase(env)}/customers:listAccessibleCustomers`, token, null, adsHeaders(env));
      if (r.status === 403) throw new NeedsAccess(adsAccessMessage(r));
      if (!r.ok) throw new Error(callError('Google Ads', r));
      const count = (r.json.resourceNames || []).length;
      if (!count) throw new NeedsAccess('Needs Setup: Google lists no Google Ads accounts for this sign-in. Sign in with the account that manages your ads.');
      return `${count} Google Ads account${count === 1 ? '' : 's'}`;
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
  let account = '';
  let needsAccess = '';
  try {
    account = await spec.verify(token.json.access_token, fetcher, env);
  } catch (e) {
    if (!(e instanceof NeedsAccess)) {
      await revokeGrant(fetcher, token.json.refresh_token);
      return { ok: false, service: pending.service, error: e.message };
    }
    // The grant is real and kept: the service needs Google's approval, not a new sign-in.
    needsAccess = e.message;
  }
  // Reconnecting replaces the old grant, so the old one is revoked at Google.
  data.google_connections ||= {};
  const previous = data.google_connections[pending.service];
  const previousRefresh = previous ? await openToken(env, previous.refresh).catch(() => '') : '';
  if (previousRefresh && previousRefresh !== token.json.refresh_token) await revokeGrant(fetcher, previousRefresh);
  data.google_connections[pending.service] = {
    status: needsAccess ? 'needs_access' : 'connected',
    account,
    access_status_detail: needsAccess,
    scopes: granted.filter((scope) => spec.scopes.includes(scope)),
    connected_at: new Date(now).toISOString(),
    refresh: await sealToken(env, token.json.refresh_token),
    access: await sealToken(env, token.json.access_token),
    access_expires_at: now + Number(token.json.expires_in || 3600) * 1000 - ACCESS_SAFETY_MS,
  };
  if (needsAccess) return { ok: false, service: pending.service, label: spec.label, error: needsAccess };
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
      access_status_detail: conn.access_status_detail || '',
    };
  }
  return out;
}

// Connector readiness for the Command Center and the Connections page.
export async function googleConnectorStates(env, data) {
  const states = await googleStates(env, data);
  const out = {};
  for (const [id, st] of Object.entries(states)) {
    if (st.connected) {
      out[id] = { state: 'ready', detail: st.account || `${st.label} connected` };
    } else if (st.status === 'needs_access') {
      out[id] = { state: 'not_connected', detail: st.access_status_detail || `${st.label}: Needs Setup. Google has not confirmed CHE's access yet.` };
    } else if (st.status === 'needs_reconnect') {
      out[id] = { state: 'needs_reconnect', detail: `Reconnect ${st.label}.` };
    } else {
      out[id] = { state: 'not_connected', detail: `${st.label} is not connected.` };
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
  const access = await googleAccessToken(env, data, 'google_ads', fetcher);
  if (!access.ok) return access;
  const r = await googleCall(fetcher, 'GET', `${adsApiBase(env)}/customers:listAccessibleCustomers`, access.token, null, adsHeaders(env));
  if (r.status === 403) return { ok: false, error: adsAccessMessage(r) };
  if (!r.ok) return { ok: false, error: callError('Google Ads', r) };
  return { ok: true, customers: (r.json.resourceNames || []).map((n) => String(n).replace(/^customers\//, '')) };
}

// Google Ads, read-only: campaign results for the last seven days on one account.
const ADS_CAMPAIGN_QUERY = 'SELECT campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS ORDER BY metrics.cost_micros DESC LIMIT 10';

export async function adsCampaignReport(env, data, { customerId } = {}, fetcher = fetch) {
  const id = String(customerId || '').replace(/\D/g, '');
  if (!id) return { ok: false, error: 'Google Ads needs one account number to read a report.' };
  const access = await googleAccessToken(env, data, 'google_ads', fetcher);
  if (!access.ok) return access;
  const r = await googleCall(fetcher, 'POST', `${adsApiBase(env)}/customers/${id}/googleAds:searchStream`, access.token, { query: ADS_CAMPAIGN_QUERY }, adsHeaders(env));
  if (r.status === 403) return { ok: false, error: adsAccessMessage(r) };
  if (!r.ok) return { ok: false, error: callError('Google Ads', r) };
  const rows = (Array.isArray(r.json) ? r.json : []).flatMap((chunk) => chunk.results || []);
  return {
    ok: true,
    campaigns: rows.map((row) => ({
      name: String(row.campaign?.name || '').slice(0, 120),
      status: String(row.campaign?.status || ''),
      impressions: Number(row.metrics?.impressions || 0),
      clicks: Number(row.metrics?.clicks || 0),
      cost: Number(row.metrics?.costMicros ?? row.metrics?.cost_micros ?? 0) / 1e6,
    })),
  };
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
  m = t.match(/^(?:send|email|mail)\s+(?:an?\s+)?(?:e-?mail\s+)?to\s+(\S+?)[,;]?\s*(?:saying|that says|with the message|:)\s*(.+)$/i);
  if (m) return { kind: 'gmail_send', to: m[1], body: m[2] };
  // An email request missing its address or text: say so, never let a model claim it was sent.
  if (/^(?:send|email|mail)\b/i.test(t) && /\be-?mails?\b/i.test(t)) return { kind: 'gmail_incomplete' };
  m = t.match(/^(?:what(?:'s| is)\s+on|show|check|list)\s+(?:my\s+)?(?:google\s+)?calendar(?:\s+(today|tomorrow|this week))?$/i);
  if (m) return { kind: 'calendar_list', range: (m[1] || 'today').toLowerCase() };
  if (/^(?:list|show|check)\s+(?:my\s+)?(?:google\s+)?drive(?:\s+files)?$/i.test(t)) return { kind: 'drive_list' };
  m = t.match(/^(?:create|make|save)\s+(?:a\s+)?(?:google\s+)?(?:doc|document|drive file|file)\s+(?:called|named)\s+(.+?)\s+(?:with|saying|containing)\s+(.+)$/i);
  if (m) return { kind: 'drive_create', name: m[1], text: m[2] };
  m = t.match(/^(?:add|schedule|put|create)\s+(?:an?\s+|the\s+)?(?:event|meeting|appointment|calendar event)?\s*(?:called\s+|titled\s+)?(.+?)\s+on\s+(\d{4}-\d{2}-\d{2})\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (m) return { kind: 'calendar_create', summary: m[1], date: m[2], time: TIME_OF_DAY(m[3], m[4], m[5]?.toLowerCase()) };
  if (/^(?:list|show|check)\s+(?:my\s+)?google ads(?:\s+accounts?)?$/i.test(t)) return { kind: 'ads_accounts' };
  if (/^(?:show|check|list)\s+(?:my\s+)?google ads\s+(?:campaigns?|report|performance|results)$/i.test(t)) return { kind: 'ads_report' };
  return null;
}

const SERVICE_FOR_KIND = {
  gmail_list: 'gmail', gmail_send: 'gmail', drive_list: 'drive', drive_create: 'drive',
  calendar_list: 'calendar', calendar_create: 'calendar',
  ads_accounts: 'google_ads', ads_report: 'google_ads',
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
  if (state.status === 'needs_access') {
    return { ok: false, text: `${label} needs Google's approval before CHE can use it, sir. ${state.access_status_detail || ''} Nothing was done.` };
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
  if (intent.kind === 'ads_accounts') {
    const r = await adsCustomers(env, data, fetcher);
    if (!r.ok) return { ok: false, text: `I could not read your Google Ads accounts, sir. ${r.error}` };
    if (!r.customers.length) return { ok: true, text: 'Google lists no Google Ads accounts for this sign-in, sir.' };
    return { ok: true, text: `Google Ads accounts CHE can read, sir: ${r.customers.join(', ')}.` };
  }
  if (intent.kind === 'ads_report') {
    const list = await adsCustomers(env, data, fetcher);
    if (!list.ok) return { ok: false, text: `I could not read Google Ads, sir. ${list.error}` };
    if (!list.customers.length) return { ok: true, text: 'Google lists no Google Ads accounts for this sign-in, sir.' };
    const account = list.customers[0];
    const r = await adsCampaignReport(env, data, { customerId: account }, fetcher);
    if (!r.ok) return { ok: false, text: `I could not read the campaign report, sir. ${r.error}` };
    if (!r.campaigns.length) return { ok: true, text: `No campaign results in the last seven days for account ${account}, sir.` };
    const top = r.campaigns.slice(0, 3).map((c) => `${c.name}: $${c.cost.toFixed(2)} spent, ${c.clicks} clicks`).join('; ');
    return { ok: true, text: `Last seven days, account ${account}, top campaigns: ${top}. Read only; nothing was changed.` };
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

// A verified sign-in whose service still needs Google's approval (Needs Setup).
class NeedsAccess extends Error {}

function adsHeaders(env = {}) {
  const headers = {};
  const dev = developerToken(env);
  if (dev) headers['developer-token'] = dev;
  const login = String(env.CHE_GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '').trim();
  if (login) headers['login-customer-id'] = login;
  return headers;
}

function adsAccessMessage(r) {
  const reason = String(r.json?.error?.message || 'access not approved').slice(0, 140);
  return `Needs Setup: Google has not confirmed CHE's Google Ads API access yet (${reason}). Apply in the Google Ads API Overview in Google Cloud Console. CHE shows Connected only after Google lists a real account.`;
}

// Writes change something outside CHE, so each one waits for the owner's yes.
export const WRITE_KINDS = new Set(['gmail_send', 'calendar_create', 'drive_create']);
export const GOOGLE_HOLD_MS = 10 * 60 * 1000;
export const PENDING_GOOGLE_ACTION_KEY = 'pending_google_action';
const NO_PHRASES = new Set(['no', 'nope', 'cancel', 'stop', 'never mind', 'no thanks', 'do not', 'dont']);

export function isOwnerNo(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  return NO_PHRASES.has(t);
}

// Why a write cannot be asked for, or null when it can.
export function googleWriteProblem(intent) {
  if (intent.kind === 'gmail_send') {
    const address = String(intent.to || '').trim();
    if (address.length > 254 || !EMAIL.test(address)) return 'That is not a full email address, so nothing was sent.';
    if (!String(intent.body || '').trim()) return 'The email has no message text, so nothing was sent.';
    if (String(intent.body).length > 20000) return 'The email is too long to send from here, so nothing was sent.';
    return null;
  }
  if (intent.kind === 'calendar_create') {
    if (!String(intent.summary || '').trim()) return 'The event needs a title, so nothing was added.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(intent.date || ''))) return 'The event needs a date like 2026-10-20, so nothing was added.';
    if (!/^\d{1,2}:\d{2}$/.test(String(intent.time || ''))) return 'The event needs a time like 14:30, so nothing was added.';
    return null;
  }
  if (intent.kind === 'drive_create') {
    if (!String(intent.name || '').trim()) return 'The document needs a name, so nothing was created.';
    if (!String(intent.text || '').trim()) return 'The document has no text, so nothing was created.';
    return null;
  }
  return null;
}

// What CHE reads back before a write, so the owner hears exactly what will happen.
export function googleConfirmText(intent) {
  if (intent.kind === 'gmail_send') {
    return `Ready to send an email to ${intent.to}, sir, saying: "${String(intent.body).trim().slice(0, 200)}". Say yes to send it, or no to cancel.`;
  }
  if (intent.kind === 'calendar_create') {
    return `Ready to add "${intent.summary}" on ${intent.date} at ${intent.time} to your calendar, sir. Say yes to add it, or no to cancel.`;
  }
  return `Ready to create a Google Doc named "${intent.name}", sir, with this text: "${String(intent.text).trim().slice(0, 200)}". Say yes to create it, or no to cancel.`;
}

// The owner's Chat turn for Gmail, Drive and Calendar. Reads run now; a write is
// held until a plain yes. A no cancels it, and any other reply drops it. Returns
// null when the turn is not a Google request.
export async function googleOwnerStep(message, { storage, env = {}, fetcher = fetch, now = Date.now(), loadData, saveData }) {
  // Guarded like the rest of the Worker: a storage read that throws or returns nothing is no hold.
  const held = await Promise.resolve().then(() => storage.get(PENDING_GOOGLE_ACTION_KEY)).catch(() => null);
  const live = Boolean(held) && now - Number(held.at || 0) < GOOGLE_HOLD_MS;
  if (held) await storage.put(PENDING_GOOGLE_ACTION_KEY, null);
  const run = async (intent) => {
    const data = await loadData();
    const out = await runGoogleIntent(intent, { env, data, fetcher, now });
    await saveData(data);
    return { ok: out.ok, text: out.text };
  };
  if (live && isOwnerYes(message)) return run(held.intent);
  if (live && isOwnerNo(message)) return { ok: true, text: `Cancelled, sir. ${held.summary} was not done.` };
  const intent = googleChatIntent(message);
  if (!intent) return null;
  if (intent.kind === 'gmail_incomplete') return { ok: false, text: 'Tell me the full address and what the email should say, sir. Nothing was sent.' };
  if (!WRITE_KINDS.has(intent.kind)) return run(intent);
  const data = await loadData();
  const state = data.google_connections?.[SERVICE_FOR_KIND[intent.kind]];
  if (!state || state.status !== 'connected') return run(intent);
  const problem = googleWriteProblem(intent);
  if (problem) return { ok: false, text: problem };
  const summary = intent.kind === 'gmail_send' ? `The email to ${intent.to}`
    : intent.kind === 'calendar_create' ? `The event "${intent.summary}"` : `The Google Doc "${intent.name}"`;
  await storage.put(PENDING_GOOGLE_ACTION_KEY, { intent, at: now, summary });
  return { ok: true, held: true, text: googleConfirmText(intent) };
}
