// Standing per-app grants: the owner grants CHE access to an app ONCE in
// Connections, and CHE may then act in that app without asking each time.
//
// What a grant does: it only satisfies the "may CHE open or act in this app"
// check (gateAppAccess). It never releases money (owner_action_gate.js still
// asks for every money action), never allows sending sensitive data out, and
// carries no secret. Passwords stay only in the on-device Keychain vault.
//
// The grant list is the SAME list the chat gate reads (APPS_GRANTED_KEY in
// owner_action_gate.js), so there is one source of truth. Revoking removes the
// name from that list at once, and a revoked name is also kept out of the grants
// a phone re-sends with each chat turn (keepUnrevokedGrants), so a stale device
// copy cannot put it back.

import { APPS_GRANTED_KEY, gateAppAccess } from './owner_action_gate.js';

// Grant timestamps, app name -> ms since epoch.
export const APP_GRANT_TIMES_KEY = 'che:app_grant_times';
// Names the owner revoked. Read only to filter grants a device re-sends.
export const REVOKED_APPS_KEY = 'che:revoked_apps';

// Known apps. A verbatim copy of KNOWN_APPS in owner_action_gate.js, which is
// not exported; app_grants.test.mjs reads that file and fails if the lists differ.
export const KNOWN_GRANTABLE_APPS = [
  'app store', 'google calendar', 'google maps', 'google drive', 'google docs', 'microsoft teams',
  'prime video', 'yahoo mail', 'pluto tv', 'disney+', 'tradingview', 'ninjatrader', 'tradesea',
  'instagram', 'snapchat', 'facebook', 'linkedin', 'whatsapp', 'messenger', 'telegram',
  'chatgpt', 'youtube', 'spotify', 'outlook', 'notion', 'pinterest', 'netflix',
  'weather', 'reminders', 'messages', 'settings', 'safari', 'photos', 'calendar', 'amazon',
  'paypal', 'robinhood', 'reddit', 'discord', 'twitch', 'threads', 'gmail', 'slack', 'zoom', 'hulu', 'tubi',
  'github', 'grok', 'music', 'notes', 'mail', 'email', 'maps', 'clock', 'camera',
];

const KNOWN_SET = new Set(KNOWN_GRANTABLE_APPS);
const BODY_KEYS = new Set(['app', 'action']);

function normalizeApp(app) {
  return String(app ?? '').toLowerCase().trim();
}

export function isGrantableApp(app) {
  return KNOWN_SET.has(normalizeApp(app));
}

async function storedNames(storage) {
  const list = await storage.get(APPS_GRANTED_KEY);
  return Array.isArray(list) ? list.map(normalizeApp).filter(Boolean) : [];
}

async function storedTimes(storage) {
  const times = await storage.get(APP_GRANT_TIMES_KEY);
  return times && typeof times === 'object' ? times : {};
}

async function storedRevoked(storage) {
  const list = await storage.get(REVOKED_APPS_KEY);
  return Array.isArray(list) ? list.map(normalizeApp).filter(Boolean) : [];
}

// Grants the owner may use now: [{ app, granted_at }], granted_at in ms or null.
export async function listGrants(storage) {
  const times = await storedTimes(storage);
  return (await storedNames(storage)).map((app) => ({
    app,
    granted_at: Number.isFinite(times[app]) ? times[app] : null,
  }));
}

export async function isAppGranted(storage, app) {
  const name = normalizeApp(app);
  if (!name) return false;
  return gateAppAccess(name, await storedNames(storage)).allowed;
}

// Grants a known app. Returns { ok, app, granted_at } or { ok: false, detail }.
export async function grantApp(storage, app, { grantedAt = Date.now() } = {}) {
  const name = normalizeApp(app);
  if (!name) return { ok: false, detail: 'Name the app to grant.' };
  if (!isGrantableApp(name)) return { ok: false, detail: 'CHE can only be granted access to apps on her known list.' };
  const names = await storedNames(storage);
  if (!names.includes(name)) await storage.put(APPS_GRANTED_KEY, [...names, name]);
  const revoked = await storedRevoked(storage);
  if (revoked.includes(name)) await storage.put(REVOKED_APPS_KEY, revoked.filter((r) => r !== name));
  const times = await storedTimes(storage);
  await storage.put(APP_GRANT_TIMES_KEY, { ...times, [name]: grantedAt });
  return { ok: true, app: name, granted: true, granted_at: grantedAt };
}

// Revokes an app at once. Returns { ok, app, granted: false }.
export async function revokeApp(storage, app) {
  const name = normalizeApp(app);
  if (!name) return { ok: false, detail: 'Name the app to revoke.' };
  const names = await storedNames(storage);
  if (names.includes(name)) await storage.put(APPS_GRANTED_KEY, names.filter((n) => n !== name));
  const revoked = await storedRevoked(storage);
  if (!revoked.includes(name)) await storage.put(REVOKED_APPS_KEY, [...revoked, name]);
  const times = await storedTimes(storage);
  if (name in times) {
    const { [name]: _gone, ...rest } = times;
    await storage.put(APP_GRANT_TIMES_KEY, rest);
  }
  return { ok: true, app: name, granted: false };
}

// The app names a phone re-sends with a chat turn, minus any the owner revoked.
export async function keepUnrevokedGrants(storage, names) {
  const revoked = await storedRevoked(storage);
  return (Array.isArray(names) ? names : [])
    .map(normalizeApp)
    .filter((name) => name && !revoked.includes(name));
}

// The POST /api/app-grants handler, separate from the route so it can be tested.
// `locked` is the lockdown state: a grant is frozen while lockdown is on, but a
// revoke always goes through, because it only takes access away.
// Returns { status, body }. A body with any key but app and action is refused, so
// no password or other secret can ride along with a grant.
export async function changeAppGrant(storage, rawBody, { locked = false } = {}) {
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
  const extra = Object.keys(body).filter((key) => !BODY_KEYS.has(key));
  if (extra.length) return { status: 422, body: { detail: 'Only an app name and an action can be sent for an app grant.' } };
  const action = String(body.action ?? '').toLowerCase().trim();
  if (action !== 'grant' && action !== 'revoke') return { status: 422, body: { detail: 'The action must be grant or revoke.' } };
  if (action === 'grant' && locked) return { status: 423, body: { detail: 'Lockdown is on; app grants are frozen. Revoking still works.' } };
  const out = action === 'grant' ? await grantApp(storage, body.app) : await revokeApp(storage, body.app);
  if (!out.ok) return { status: 422, body: { detail: out.detail } };
  return { status: 200, body: { ok: true, ...out } };
}
