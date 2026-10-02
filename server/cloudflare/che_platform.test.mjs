import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_TENANT_ID, ensurePlatform, registerPairedDevice, tenantForDevice,
  createPersonalTenant, createEnrollment, consumeEnrollment, addNotification,
  notificationsFor, markNotificationRead, createCoreRequest, coreRequestsFor,
  coreRules, sanitizeSharedSkill, platformView,
} from './che_platform.js';

test('owner tenant and seven-agent Office are seeded without personal data sharing', () => {
  const data = {};
  const p = ensurePlatform(data);
  assert.equal(p.tenants[OWNER_TENANT_ID].flagstaff, '369');
  assert.deepEqual(p.tenants[OWNER_TENANT_ID].office.starter_roster, ['Nova','Atlas','Mira','Knox','Sage','Lyra','Iris']);
});

test('paired devices resolve only their assigned tenant', () => {
  const data = {};
  ensurePlatform(data);
  const child = createPersonalTenant(data, { name: 'Family CHE', role: 'parental_guidance' });
  registerPairedDevice(data, 'ownerhash', { name: 'Owner iPhone' });
  registerPairedDevice(data, 'guesthash', { name: 'Guest iPhone', access: 'private', tenantId: child.id });
  assert.equal(tenantForDevice(data, 'ownerhash').id, OWNER_TENANT_ID);
  assert.equal(tenantForDevice(data, 'guesthash').id, child.id);
  assert.notEqual(child.flagstaff, '369');
});

test('enrollment is short-lived and single-use', () => {
  const data = {};
  ensurePlatform(data);
  const made = createEnrollment(data, { ttlMinutes: 5 });
  assert.ok(made.token);
  assert.ok(consumeEnrollment(data, made.token, 'New phone').invite);
  assert.equal(consumeEnrollment(data, made.token, 'Replay').error, 'invalid_or_expired_invite');
});

test('notifications are tenant isolated, newest first, and readable', async () => {
  const data = {};
  ensurePlatform(data);
  const other = createPersonalTenant(data, { name: 'Other' });
  addNotification(data, { title: 'Owner one', body: 'a' });
  await new Promise(r => setTimeout(r, 2));
  const newest = addNotification(data, { title: 'Owner two', body: 'b' });
  addNotification(data, { tenantId: other.id, title: 'Other', body: 'secret' });
  assert.deepEqual(notificationsFor(data, OWNER_TENANT_ID).map(n => n.title), ['Owner two','Owner one']);
  assert.equal(notificationsFor(data, OWNER_TENANT_ID).some(n => n.title === 'Other'), false);
  markNotificationRead(data, OWNER_TENANT_ID, newest.id);
  assert.equal(notificationsFor(data, OWNER_TENANT_ID, { unreadOnly: true }).length, 1);
});

test('Core requests are tenant isolated and paid priority never means approval', () => {
  const data = {};
  ensurePlatform(data);
  const other = createPersonalTenant(data, { name: 'Other' });
  const made = createCoreRequest(data, OWNER_TENANT_ID, { request: 'Add a capability', priority: true, paid_priority_authorized: true });
  createCoreRequest(data, other.id, { request: 'Other request' });
  assert.equal(made.request.status, 'submitted');
  assert.equal(made.request.decision, null);
  assert.equal(coreRequestsFor(data, OWNER_TENANT_ID).length, 1);
  assert.ok(coreRules().some(r => r.id === 'CORE-PRIVACY-1'));
});

test('shared skills require provenance, verification and explicit sanitization', () => {
  assert.equal(sanitizeSharedSkill({ title: 'x', technique: 'y' }), null);
  const skill = sanitizeSharedSkill({ title: 'RAG', technique: 'retrieve only relevant references', provenance: 'reviewed diff abc', verified_at: new Date().toISOString(), personal_data_removed: true });
  assert.equal(skill.title, 'RAG');
});

test('platform view never exposes device token hashes', () => {
  const data = {};
  ensurePlatform(data);
  registerPairedDevice(data, 'secret-hash', { name: 'Phone' });
  const view = platformView(data, OWNER_TENANT_ID, 'secret-hash');
  assert.equal(view.device.token_hash, undefined);
  assert.equal(JSON.stringify(view).includes('secret-hash'), false);
});
