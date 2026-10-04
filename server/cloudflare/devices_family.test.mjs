import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonalTenant, deviceCommandIntent, ensurePlatform, findDevice, platformView, registerPairedDevice, revokeDevice } from './che_platform.js';
import { removeKey } from './resilience.js';
import { webAppPage } from './web_app.js';

const twoDevices = () => {
  const data = { devices: { aaaaaaaaaaaaaaaa1: 'Owner iPhone', bbbbbbbbbbbbbbbb2: 'Work laptop' } };
  ensurePlatform(data);
  registerPairedDevice(data, 'aaaaaaaaaaaaaaaa1', { name: 'Owner iPhone' });
  registerPairedDevice(data, 'bbbbbbbbbbbbbbbb2', { name: 'Work laptop' });
  return data;
};

test('owner lists devices by a random id and revokes a lost one from another device', () => {
  const data = twoDevices();
  const view = platformView(data, 'owner-369', 'bbbbbbbbbbbbbbbb2');
  assert.deepEqual(view.devices.map((d) => d.name), ['Owner iPhone', 'Work laptop']);
  assert.ok(view.devices.every((d) => /^[0-9a-f]{12}$/.test(d.id)));
  assert.equal(JSON.stringify(view).includes('aaaaaaaa'), false, 'no token hash leaks, not even a prefix');
  const [phone, laptop] = view.devices;
  assert.equal(revokeDevice(data, laptop.id, { byTokenHash: 'bbbbbbbbbbbbbbbb2' }).error, 'cannot_revoke_current_device');
  const out = revokeDevice(data, phone.id, { byTokenHash: 'bbbbbbbbbbbbbbbb2' });
  assert.equal(out.device.name, 'Owner iPhone');
  assert.equal('token_hash' in out.device, false);
  assert.ok(data.platform.devices.aaaaaaaaaaaaaaaa1.revoked_at);
  assert.equal(Object.hasOwn(data.devices, 'aaaaaaaaaaaaaaaa1'), false, 'the token no longer authenticates');
  assert.equal(revokeDevice(data, 'zzzzzzzzzzzz', {}).error, 'device_not_found');
});

test('device voice commands', () => {
  assert.deepEqual(deviceCommandIntent('list my devices'), { kind: 'list' });
  assert.deepEqual(deviceCommandIntent('Che, which devices are signed in?'), { kind: 'list' });
  assert.equal(deviceCommandIntent('remove my lost iPhone').target, 'iPhone');
  assert.equal(deviceCommandIntent('sign out the work laptop').target, 'work laptop');
  assert.equal(deviceCommandIntent('remove the background from this photo'), null);
  const data = twoDevices();
  assert.equal(findDevice(data, 'my lost iphone').length, 1);
  assert.equal(findDevice(data, 'tablet').length, 0);
});

test('Parental Guidance is a real profile type with isolated memory', () => {
  const data = twoDevices();
  const kid = createPersonalTenant(data, { name: 'Mia', role: 'parental_guidance' });
  assert.equal(kid.role, 'parental_guidance');
  assert.equal(kid.memory_scope, 'isolated');
  assert.equal(createPersonalTenant(data, { name: 'X', role: 'owner' }).role, 'personal', 'nobody can mint a second owner');
});

test('a stored key can be removed', async () => {
  const m = new Map([['provider_keys', { GROQ_API_KEY: 'gsk_x' }], ['key_health', { groq: { status: 'healthy' } }]]);
  const storage = { get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); } };
  const keysKey = [...m.keys()][0];
  const out = await removeKey(storage, 'groq');
  assert.equal(out.ok, true);
  assert.equal((await removeKey(storage, 'nope')).ok, false);
  assert.equal(JSON.stringify(m.get(keysKey) || {}).includes('gsk_x'), false);
});

test('the any-device web app is served locked down', async () => {
  const res = webAppPage();
  assert.match(res.headers.get('Content-Security-Policy'), /connect-src 'self'/);
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const html = await res.text();
  assert.match(html, /Sign in to CHE on this device/);
  assert.doesNotMatch(html, /innerHTML/, 'all text is rendered with textContent');
  new Function(html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>')));
});
