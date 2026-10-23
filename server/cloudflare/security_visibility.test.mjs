import test from 'node:test';
import assert from 'node:assert/strict';
import { VISIBILITY_CATEGORIES, coverage, leastPrivilege, physicalActionGate, physicalPage, securityVisibility, speakVisibility } from './security_visibility.js';
import { access } from './security_core_che.js';
import { _clearPhysicalAdapters, physicalDevice, physicalResponse, registerPhysicalAdapter, verifyPhysicalDevice } from './security_core/physical.js';

const NOW = Date.parse('2026-10-23T15:00:00Z');
const principals = [
  access.principal({ id: 'che', kind: 'agent', name: 'CHE', scopes: ['chat', 'memory'] }),
  access.principal({ id: 'security', kind: 'agent', name: 'Security', scopes: ['security:read'] }),
  access.principal({ id: 'tool:scraper', kind: 'tool', name: 'Scraper', scopes: ['network:*', 'action:fetch'], last_used_at: '2026-10-20T00:00:00Z' }),
  access.principal({ id: 'app:Safari', kind: 'app', name: 'Safari', scopes: ['open', 'act_with_permission'] }),
  access.principal({ id: 'device:d1', kind: 'device', name: 'Owner iPhone', scopes: ['owner'], last_used_at: '2026-10-23T14:00:00Z' }),
  access.principal({ id: 'device:d2', kind: 'device', name: 'Old iPad', scopes: ['private'], status: 'revoked' }),
];
const fixture = () => securityVisibility({
  principals,
  review: access.reviewAccess(principals, NOW),
  team: [{ id: 'w1', name: 'Nova', role: 'Researcher', provider_preference: 'gemini' }, { id: 'w2', name: 'Gone', retired: true }],
  commands: [{ id: 'trade-chart', mode: 'EXPLORE', summary: 'Open the chart.', needs: ['market_data'], status: 'available', approval: { required: false } }],
  connectors: { youtube: { state: 'not_connected', label: 'YouTube', detail: 'YouTube is not connected.' }, github: { state: 'ready', label: 'GitHub' } },
  sessions: [{ scopes: ['vault'], factors: ['device', 'face_id'], created_at: NOW - 60_000, expires_at: NOW + 240_000, this_device: true }],
  events: [
    { event_id: 'ev_1', event_type: 'unknown_token', source: 'worker', affected_resource: 'api', severity: 'high', status: 'open', summary: 'Unknown token used', timestamp: '2026-10-23T12:00:00Z', verification: 'verified', evidence_refs: ['req:abc'] },
    { event_id: 'ev_sim', event_type: 'unknown_token', source: 'drill', severity: 'high', status: 'open', summary: 'Drill', timestamp: '2026-10-23T12:00:00Z', verification: 'simulation' },
    { event_id: 'ev_2', event_type: 'session_created', source: 'security', severity: 'info', status: 'resolved', summary: 'Face ID session', timestamp: '2026-10-23T11:00:00Z' },
  ],
  audit: [{ at: '2026-10-23T13:00:00Z', action: 'session_created', detail: 'face_id for vault' }],
  checks: [{ at: '2026-10-23T10:00:00Z', findings: 1, advisories: null, deploy_checked: false }],
  now: NOW,
});

test('every category count is exactly the length of its own list, and every list item belongs to its category', () => {
  const v = fixture();
  assert.deepEqual(v.categories.map((c) => c.id), VISIBILITY_CATEGORIES.map((c) => c.id));
  for (const c of v.categories) {
    assert.equal(c.count, c.items.length, c.id);
    for (const i of c.items) assert.equal(i.category, c.id, `${c.id}: ${i.id}`);
    assert.equal(new Set(c.items.map((i) => i.id)).size, c.items.length, `${c.id} ids are unique`);
  }
  const by = Object.fromEntries(v.categories.map((c) => [c.id, c]));
  assert.equal(by.agents.count, 3, 'CHE, Security, and the one active office worker');
  assert.equal(by.tools.count, 2, 'one capability and one command');
  assert.equal(by.apps.count, 3, 'one granted app and two connectors');
  assert.equal(by.devices.count, 2);
  assert.equal(by.sessions.count, 1);
  assert.equal(by.permissions.count, principals.reduce((n, p) => n + p.scopes.length, 0), 'one entry per granted scope');
  assert.equal(by.threats.count, v.findings.length);
  assert.ok(!by.threats.items.some((i) => i.id.includes('ev_sim')), 'drills never count as real threats');
});

test('each entry carries name, type, permissions, source, last activity and status; findings carry evidence and an action', () => {
  const v = fixture();
  for (const c of v.categories) for (const i of c.items) {
    for (const k of ['name', 'type', 'source', 'status']) assert.ok(i[k], `${i.id} ${k}`);
    assert.ok(Array.isArray(i.permissions), `${i.id} permissions`);
    assert.ok('last_activity' in i, `${i.id} last_activity`);
  }
  for (const f of v.findings) {
    assert.ok(f.severity, f.id);
    assert.ok(f.evidence && typeof f.evidence === 'object', f.id);
    assert.ok(f.recommendation.length > 10, f.id);
  }
  const token = v.findings.find((f) => f.id.includes('ev_1'));
  assert.equal(token.evidence.affected_resource, 'api');
  assert.deepEqual(token.evidence.evidence_refs, ['req:abc']);
  assert.equal(token.last_activity, '2026-10-23T12:00:00Z');
});

test('least privilege is explained in plain words, and a wildcard network grant reads as excessive', () => {
  const scraper = fixture().categories.find((c) => c.id === 'tools').items.find((i) => i.name === 'Scraper');
  assert.equal(scraper.verdict, 'excessive');
  assert.match(scraper.plain, /Scraper \(tool\) can: reach any website; perform "fetch"\./);
  assert.match(scraper.plain, /wider than any one job needs/);
  assert.equal(leastPrivilege({ name: 'CHE', kind: 'agent', scopes: ['chat'] }).verdict, 'appropriate');
  assert.equal(leastPrivilege({ name: 'X', kind: 'tool', scopes: ['chat'], last_used_at: '2026-08-01T00:00:00Z' }, NOW).verdict, 'review');
  assert.equal(leastPrivilege({ name: 'X', kind: 'device', scopes: ['owner'], status: 'revoked' }).verdict, 'not in use');
});

test('no token, session id, password or credential value appears anywhere in the payload', () => {
  const secret = 'f'.repeat(48);
  const v = securityVisibility({
    principals,
    review: access.reviewAccess(principals, NOW),
    sessions: [{ scopes: ['vault'], factors: ['device', 'face_id'], created_at: NOW, expires_at: NOW + 1000, this_device: false, id: secret, device: secret, token: secret }],
    team: [{ id: 'w1', name: 'Nova', api_key: secret }],
    connectors: { youtube: { state: 'ready', label: 'YouTube', refresh_token: secret } },
    now: NOW,
  });
  const json = JSON.stringify(v);
  assert.ok(!json.includes(secret), 'secret value leaked');
  assert.doesNotMatch(json, /"(?:token|refresh_token|api_key|password|device_token)"\s*:/);
});

test('coverage: zero findings is never an all-clear unless every check ran, and unseen areas are named', () => {
  const none = coverage({ checks: [], findings: 0, now: NOW });
  assert.equal(none.all_checked, false);
  assert.equal(none.checked, 0);
  assert.match(none.summary, /not an all-clear/);
  for (const id of ['security_check', 'dependencies', 'deploy', 'devices']) assert.equal(none.checks.find((c) => c.id === id).state, 'not_checked', id);
  assert.equal(none.checks.find((c) => c.id === 'vault').state, 'unknown');
  assert.equal(none.checks.find((c) => c.id === 'physical').state, 'not_monitored');
  const ran = coverage({ checks: [{ at: '2026-10-23T14:00:00Z', advisories: 0, deploy_checked: true }], advisoriesChecked: true, deployChecked: true, findings: 0, now: NOW });
  assert.equal(ran.checks.filter((c) => c.state === 'checked').length, 4);
  assert.equal(ran.all_checked, false, 'the vault and physical devices stay outside the server view');
  assert.match(ran.summary, /not an all-clear/);
  const stale = coverage({ checks: [{ at: '2026-10-20T00:00:00Z' }], findings: 0, now: NOW });
  assert.equal(stale.checks.find((c) => c.id === 'security_check').stale, true, 'a check older than a day is stale');
});

test('physical security: no integration exists, so nothing reads as connected; connected only after a recorded handshake', async () => {
  _clearPhysicalAdapters();
  const page = physicalPage([]);
  assert.equal(page.headline, 'No supported integrations yet');
  assert.ok(page.candidates.length >= 3);
  for (const c of page.candidates) {
    assert.equal(c.status, 'unsupported');
    assert.match(c.source, /^https:\/\//);
  }
  const unsupported = physicalDevice({ id: 'lock1', device_class: 'door_lock', adapter: 'fake' });
  assert.equal(physicalPage([unsupported]).devices[0].status_word, 'Unsupported');
  registerPhysicalAdapter({ id: 'fake', classes: ['door_lock'], handshake: async () => false });
  const failed = await verifyPhysicalDevice(physicalDevice({ id: 'lock1', device_class: 'door_lock', adapter: 'fake' }));
  assert.equal(physicalPage([failed]).devices[0].status_word, 'Disconnected', 'a failed handshake is never connected');
  _clearPhysicalAdapters();
  registerPhysicalAdapter({ id: 'fake', classes: ['door_lock'], handshake: async () => true });
  const ok = await verifyPhysicalDevice(physicalDevice({ id: 'lock1', device_class: 'door_lock', adapter: 'fake' }), '2026-10-23T15:00:00Z');
  const shown = physicalPage([ok]).devices[0];
  assert.equal(shown.status_word, 'Verified connected');
  assert.equal(shown.connected, true);
  _clearPhysicalAdapters();
});

test('sensitive physical actions need the owner with Face ID every time; life-safety responses are never taken', () => {
  const device = { id: 'lock1', status: 'connected', verified_at: '2026-10-23T15:00:00Z' };
  assert.equal(physicalActionGate('unlock_door', { device }, physicalResponse).allowed, false);
  assert.equal(physicalActionGate('unlock_door', { device, owner_confirmed: true }, physicalResponse).allowed, false, 'confirmation without Face ID is refused');
  assert.match(physicalActionGate('disarm_alarm', { device, owner_confirmed: true }, physicalResponse).reason, /Face ID every time/);
  assert.equal(physicalActionGate('unlock_door', { device, owner_confirmed: true, face_id: true }, physicalResponse).allowed, true);
  assert.equal(physicalActionGate('unlock_door', { device: { status: 'not_connected' }, owner_confirmed: true, face_id: true }, physicalResponse).allowed, false, 'no verified device, no action');
  for (const a of ['disable_smoke_detector', 'disable_life_safety', 'lock_person_in']) assert.equal(physicalActionGate(a, { device, owner_confirmed: true, face_id: true }, physicalResponse).allowed, false, a);
  assert.equal(physicalActionGate('notify_owner', {}, physicalResponse).allowed, true, 'notifying and recording run on their own');
  assert.equal(physicalActionGate('record_event', {}, physicalResponse).allowed, true);
});

test('spoken access and findings answers give counts and state what was not checked', () => {
  const v = fixture();
  const a = speakVisibility(v, 'access');
  assert.match(a, /3 agents, 2 tools, 3 apps, 2 devices, 1 session, \d+ permissions/);
  assert.match(a, /1 grant is wider than needed/, 'the wildcard grant is counted once');
  assert.match(a, /not checked or not visible|not an all-clear/);
  const f = speakVisibility(v, 'findings');
  assert.match(f, /security finding/);
  assert.match(f, /not checked or not visible|not an all-clear/);
});

test('review fix: every real finding a check produced is a Threat, including che.* capability and device findings', () => {
  const events = ['che.unreviewed_capability', 'che.wide_capability_access', 'che.new_device', 'capability.unreviewed', 'device.new', 'identity.long_session'].map((t, i) => ({ event_id: `e${i}`, event_type: t, severity: i % 2 ? 'medium' : 'info', status: 'open', summary: t, timestamp: '2026-10-23T12:00:00Z', verification: 'verified' }));
  events.push({ event_id: 'closed', event_type: 'che.session_created', severity: 'info', status: 'resolved', summary: 'x', timestamp: '2026-10-23T12:00:00Z' });
  events.push({ event_id: 'drill', event_type: 'che.new_device', severity: 'high', status: 'open', summary: 'x', timestamp: '2026-10-23T12:00:00Z', verification: 'simulation' });
  const v = securityVisibility({ events, now: NOW });
  const threats = v.categories.find((c) => c.id === 'threats');
  assert.equal(threats.count, 6);
  assert.doesNotMatch(speakVisibility(v, 'findings'), /No security findings/);
});

test('review fix: Office agents show their real runtime activity time', () => {
  const v = securityVisibility({ team: [{ id: 'n', name: 'Nova', runtime_updated_at: '2026-10-23T09:00:00Z', updated_at: '2026-10-01T00:00:00Z' }, { id: 'm', name: 'Mira', updated_at: '2026-10-02T00:00:00Z' }], now: NOW });
  const agents = v.categories.find((c) => c.id === 'agents').items;
  assert.equal(agents.find((a) => a.name === 'Nova').last_activity, '2026-10-23T09:00:00Z');
  assert.equal(agents.find((a) => a.name === 'Mira').last_activity, '2026-10-02T00:00:00Z');
});

test('review fix: a stale last check marks every row it produced stale, and none of them count as checked', () => {
  const c = coverage({ checks: [{ at: '2026-10-20T00:00:00Z', advisories: 0, deploy_checked: true }], advisoriesChecked: true, deployChecked: true, findings: 0, now: NOW });
  for (const id of ['security_check', 'dependencies', 'deploy', 'devices']) assert.equal(c.checks.find((x) => x.id === id).stale, true, id);
  assert.equal(c.checked, 0);
  assert.match(c.summary, /not an all-clear/);
  const fresh = coverage({ checks: [{ at: '2026-10-23T14:00:00Z' }], findings: 0, now: NOW });
  assert.equal(fresh.checks.find((x) => x.id === 'devices').stale, false);
  assert.equal(fresh.checked, 2);
});
