import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  APP_GRANT_TIMES_KEY, KNOWN_GRANTABLE_APPS, REVOKED_APPS_KEY, changeAppGrant, grantApp, isAppGranted,
  isGrantableApp, keepUnrevokedGrants, listGrants, revokeApp,
} from './app_grants.js';
import { APPS_GRANTED_KEY, classifyOwnerAction, gateAppAccess, gateOwnerAction } from './owner_action_gate.js';

// Minimal Durable Object storage stand-in: async get/put on a Map.
function memoryStorage() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.has(key) ? structuredClone(data.get(key)) : undefined; },
    async put(key, value) { data.set(key, structuredClone(value)); },
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));

test('the grantable list is the same KNOWN_APPS list the chat gate uses', () => {
  const source = readFileSync(path.join(here, 'owner_action_gate.js'), 'utf8');
  const block = /const KNOWN_APPS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(block, 'KNOWN_APPS list found in owner_action_gate.js');
  const gateList = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(KNOWN_GRANTABLE_APPS, gateList);
});

test('only known apps can be granted', async () => {
  const storage = memoryStorage();
  assert.equal(isGrantableApp('Instagram'), true);
  assert.equal(isGrantableApp('my secret bank portal'), false);
  const refused = await grantApp(storage, 'my secret bank portal');
  assert.equal(refused.ok, false);
  assert.equal(storage.data.has(APPS_GRANTED_KEY), false, 'nothing stored for an unknown app');
  const ok = await grantApp(storage, '  Instagram ');
  assert.equal(ok.ok, true);
  assert.equal(ok.app, 'instagram');
});

test('a grant is stored in the chat gate list, so the chat gate honors it', async () => {
  const storage = memoryStorage();
  await grantApp(storage, 'youtube', { grantedAt: 1234 });
  assert.equal(await isAppGranted(storage, 'YouTube'), true);
  const stored = await storage.get(APPS_GRANTED_KEY);
  assert.deepEqual(stored, ['youtube']);
  assert.equal(gateAppAccess('youtube', stored).allowed, true);
  assert.deepEqual(await listGrants(storage), [{ app: 'youtube', granted_at: 1234 }]);
});

test('granting twice keeps one entry and the first list is not duplicated', async () => {
  const storage = memoryStorage();
  await grantApp(storage, 'gmail');
  await grantApp(storage, 'gmail');
  assert.deepEqual(await storage.get(APPS_GRANTED_KEY), ['gmail']);
});

test('revoke takes effect at once for the chat gate and the list', async () => {
  const storage = memoryStorage();
  await grantApp(storage, 'instagram');
  await grantApp(storage, 'gmail', { grantedAt: 777 });
  const out = await revokeApp(storage, 'Instagram');
  assert.deepEqual(out, { ok: true, app: 'instagram', granted: false });
  assert.equal(await isAppGranted(storage, 'instagram'), false);
  assert.equal(gateAppAccess('instagram', await storage.get(APPS_GRANTED_KEY)).allowed, false);
  assert.deepEqual(await listGrants(storage), [{ app: 'gmail', granted_at: 777 }]);
  assert.equal((await storage.get(APP_GRANT_TIMES_KEY)).instagram, undefined);
});

test('a phone that still holds a revoked app cannot put it back with a chat turn', async () => {
  const storage = memoryStorage();
  await grantApp(storage, 'instagram');
  await revokeApp(storage, 'instagram');
  // The phone re-sends its local grant list with the next chat turn.
  const sent = await keepUnrevokedGrants(storage, ['Instagram', 'gmail', '']);
  assert.deepEqual(sent, ['gmail']);
  assert.equal(await isAppGranted(storage, 'instagram'), false);
  assert.ok((await storage.get(REVOKED_APPS_KEY)).includes('instagram'));
});

test('a new grant clears the revoked mark, so the phone list counts again', async () => {
  const storage = memoryStorage();
  await grantApp(storage, 'youtube');
  await revokeApp(storage, 'youtube');
  await grantApp(storage, 'youtube');
  assert.deepEqual(await keepUnrevokedGrants(storage, ['youtube']), ['youtube']);
  assert.deepEqual(await storage.get(REVOKED_APPS_KEY), []);
});

test('an app grant never releases a money action', async () => {
  const storage = memoryStorage();
  await grantApp(storage, 'paypal');
  await grantApp(storage, 'robinhood');
  assert.equal(await isAppGranted(storage, 'paypal'), true);
  assert.equal(classifyOwnerAction('pay the invoice in paypal'), 'money');
  // The money gate takes only its own grant flags, so the app grant cannot reach it.
  const gate = gateOwnerAction('pay the invoice in paypal', {});
  assert.equal(gate.allowed, false);
  assert.deepEqual(gate.kinds, ['money']);
});

test('the route body can carry only an app and an action, so no password can ride along', async () => {
  const storage = memoryStorage();
  const secret = 'hunter2-do-not-store';
  const out = await changeAppGrant(storage, { app: 'instagram', action: 'grant', password: secret });
  assert.equal(out.status, 422);
  assert.equal(JSON.stringify(out.body).includes(secret), false);
  assert.equal(storage.data.has(APPS_GRANTED_KEY), false);
  const nested = await changeAppGrant(storage, { app: 'instagram', action: 'grant', extra: { token: secret } });
  assert.equal(nested.status, 422);
  assert.equal(storage.data.has(APPS_GRANTED_KEY), false);
});

test('the route rejects a missing action, a bad action, an empty app and an unknown app', async () => {
  const storage = memoryStorage();
  assert.equal((await changeAppGrant(storage, { app: 'gmail' })).status, 422);
  assert.equal((await changeAppGrant(storage, { app: 'gmail', action: 'delete' })).status, 422);
  assert.equal((await changeAppGrant(storage, { app: '  ', action: 'grant' })).status, 422);
  assert.equal((await changeAppGrant(storage, { app: 'not an app', action: 'grant' })).status, 422);
  assert.equal((await changeAppGrant(storage, null)).status, 422);
});

test('lockdown freezes grants but a revoke still takes effect', async () => {
  const storage = memoryStorage();
  const frozen = await changeAppGrant(storage, { app: 'gmail', action: 'grant' }, { locked: true });
  assert.equal(frozen.status, 423);
  assert.equal(await isAppGranted(storage, 'gmail'), false);
  await changeAppGrant(storage, { app: 'gmail', action: 'grant' });
  const revoked = await changeAppGrant(storage, { app: 'gmail', action: 'revoke' }, { locked: true });
  assert.equal(revoked.status, 200);
  assert.equal(await isAppGranted(storage, 'gmail'), false);
});

test('a valid grant and revoke through the route return the new state', async () => {
  const storage = memoryStorage();
  const granted = await changeAppGrant(storage, { app: 'Instagram', action: 'grant' });
  assert.equal(granted.status, 200);
  assert.equal(granted.body.ok, true);
  assert.equal(granted.body.granted, true);
  const revoked = await changeAppGrant(storage, { app: 'instagram', action: 'revoke' });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.granted, false);
});
