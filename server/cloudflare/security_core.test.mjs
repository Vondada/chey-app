// Security Core as a sibling product: portability (no product imports, no branding or pricing), the tenant-scoped
// event model, incidents and replay, the promotion pipeline, the agent, access and lockdown, simulations, readiness,
// and the physical-security architecture. These tests import only security_core/.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ENGINES, ENGINE_NAMES, SECURITY_CORE_VERSION, access, agent, capabilitySecurity, createSecurityCore, events, incidents,
  knowledge, physical, policies, productConfig, readiness, simulation, validateAdapters, workflows,
} from './security_core/index.js';

const CORE_DIR = new URL('./security_core/', import.meta.url);
const coreFiles = readdirSync(CORE_DIR).filter((f) => f.endsWith('.js'));
const GH_TOKEN = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c';

// ─── Sibling architecture and portability (13) ──────────────────────────────

test('S1. the core imports only its own modules: nothing from CHE, music, trading, UI or the Worker', () => {
  assert.ok(coreFiles.length >= 10);
  for (const f of coreFiles) {
    const src = readFileSync(new URL(f, CORE_DIR), 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      assert.match(m[1], /^\.\/[\w-]+\.js$/, `${f} imports ${m[1]}`);
      assert.ok(coreFiles.includes(m[1].slice(2)), `${f} imports ${m[1]} outside the core`);
    }
    assert.doesNotMatch(src, /\bimport\s*\(/, `${f} uses a dynamic import`);
  }
});

test('S2. no branding or pricing is hard-coded in the core; the product name comes from configuration', () => {
  for (const f of coreFiles) {
    const src = readFileSync(new URL(f, CORE_DIR), 'utf8');
    assert.doesNotMatch(src, /CHE Security/i, f);
    assert.doesNotMatch(src, /\$\s?\d|\bper (?:month|seat|user)\b|price:|pricing:/i, f);
  }
  const cfg = productConfig({ product_name: 'Acme Shield', price: 99, pricing: { pro: 10 } });
  assert.equal(cfg.product_name, 'Acme Shield');
  assert.equal(cfg.price, undefined);
  assert.equal(cfg.pricing, undefined);
  assert.equal(productConfig().product_name, 'Security Core');
});

test('S3. the core is versioned and exposes all thirteen engines', () => {
  assert.match(SECURITY_CORE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(ENGINE_NAMES, ['threat', 'malware', 'identity', 'access', 'device', 'repository', 'dependency', 'incident', 'knowledge', 'policies', 'event_model', 'capability_security', 'workflow_library']);
  for (const n of ENGINE_NAMES) assert.ok(ENGINES[n] && Object.keys(ENGINES[n]).length, n);
  const pkg = JSON.parse(readFileSync(new URL('package.json', CORE_DIR), 'utf8'));
  assert.equal(pkg.version, SECURITY_CORE_VERSION);
});

test('S4. a standalone product can embed the core with its own name and adapters; bad adapters are refused', () => {
  const core = createSecurityCore({ config: { product_name: 'Standalone', edition: 'standalone' }, adapters: { notifier: { notify: () => {} } } });
  assert.deepEqual(core.describe().adapters, ['notifier']);
  assert.equal(core.describe().edition, 'standalone');
  assert.deepEqual(validateAdapters({ storage: { get() {} } }), ['storage.put missing']);
  assert.throws(() => createSecurityCore({ adapters: { billing: {} } }), /unknown adapter/);
});

test('S5. every event carries the full event model and a tenant', () => {
  const e = events.createEvent({ event_type: 'threat.test', severity: 'high', confidence: 3, evidence_refs: ['x'] }, { tenant_id: 'acme' });
  for (const f of events.EVENT_FIELDS) assert.ok(f in e, f);
  assert.equal(e.confidence, 1);
  assert.equal(e.customer_scope, 'acme');
  assert.throws(() => events.createEvent({}, { tenant_id: '' }), /tenant/);
});

test('S6. tenant isolation: one tenant cannot read, publish into or update another tenant\'s events', () => {
  const store = events.emptyStore();
  const a = events.openBus(store, 'tenant-a');
  const b = events.openBus(store, 'tenant-b');
  const ea = a.publish({ event_type: 'x', severity: 'high' });
  b.publish({ event_type: 'y' });
  assert.equal(a.query().length, 1);
  assert.equal(b.query()[0].event_type, 'y');
  assert.equal(b.get(ea.event_id), null);
  assert.equal(b.update(ea.event_id, { status: 'dismissed' }), null);
  assert.equal(a.get(ea.event_id).status, 'open');
  assert.throws(() => b.publish({ tenant_id: 'tenant-a', event_type: 'z' }), /Cross-tenant/);
  const seen = [];
  b.subscribe((e) => seen.push(e.tenant_id));
  a.publish({ event_type: 'q' });
  assert.deepEqual(seen, []);
});

test('S7. no plaintext secret can be stored in an event, an incident or knowledge', () => {
  const store = events.emptyStore();
  const bus = events.openBus(store, 't1');
  const e = bus.publish({ summary: `token ${GH_TOKEN} leaked`, actions_taken: [`rotated ${GH_TOKEN}`] });
  assert.ok(!JSON.stringify(e).includes(GH_TOKEN));
  assert.deepEqual(e.redacted, ['github_token']);
  const inc = incidents.openIncident(store, 't1', { title: `leak ${GH_TOKEN}`, event_ids: [e.event_id] });
  incidents.advanceIncident(inc, 'TRIAGED', { note: `checked ${GH_TOKEN}` });
  const k = knowledge.captureExperience(store, 't1', { title: 'x', body: GH_TOKEN });
  assert.ok(!JSON.stringify(store).includes(GH_TOKEN));
  assert.ok(k.body.includes('[redacted:github_token]'));
});

test('S8. incidents move forward only, need a note per step, and replay exactly as recorded', () => {
  const store = events.emptyStore();
  const ev = events.openBus(store, 't').publish({ event_type: 'x', severity: 'high' });
  const inc = incidents.openIncident(store, 't', { title: 'x', event_ids: [ev.event_id, 'not-mine'], now: '2026-10-22T10:00:00.000Z' });
  assert.deepEqual(inc.event_ids, [ev.event_id]);
  assert.equal(incidents.advanceIncident(inc, 'INVESTIGATING', { note: '' }).reason, 'note_required');
  assert.ok(incidents.advanceIncident(inc, 'INVESTIGATING', { note: 'looked', now: '2026-10-22T10:00:05.000Z' }).ok);
  assert.equal(incidents.advanceIncident(inc, 'TRIAGED', { note: 'back' }).reason, 'lifecycle_moves_forward_only');
  assert.ok(incidents.advanceIncident(inc, 'RESOLVED', { note: 'done', now: '2026-10-22T10:01:00.000Z' }).ok);
  const r = incidents.replayIncident(inc);
  assert.deepEqual(r.frames.map((f) => f.stage), ['DETECTED', 'INVESTIGATING', 'RESOLVED']);
  assert.deepEqual(r.frames.map((f) => f.offset_ms), [0, 5000, 60000]);
  assert.equal(r.label, 'REAL EVENT');
  assert.equal(r.complete, true);
});

test('S9. promotion pipeline: generalize → strip identifiers → review → test → promote; the tenant does not travel', () => {
  const store = events.emptyStore();
  const k = knowledge.captureExperience(store, 'acme', { title: 'Pairing flood from 10.0.0.5', body: 'owner@acme.io phone', portability: 'SHARED_SECURITY' });
  assert.ok(knowledge.generalize(k, { lesson: 'Many wrong pairing codes from 10.0.0.5 against acme-phone means guessing; rate-limit and alert.', rule: { event_type: 'threat.auth_failures', min_severity: 'high' } }).ok);
  assert.ok(knowledge.stripIdentifiers(k, { identifiers: ['acme-phone'] }).ok);
  assert.doesNotMatch(k.general.lesson, /10\.0\.0\.5|acme-phone/);
  assert.equal(k.body, '');
  assert.ok(knowledge.reviewKnowledge(k).ok);
  assert.equal(knowledge.testKnowledge(k, { positives: [{ event_type: 'threat.auth_failures', severity: 'high' }] }).reason, 'samples_required');
  assert.ok(knowledge.testKnowledge(k, { positives: [{ event_type: 'threat.auth_failures', severity: 'high' }], negatives: [{ event_type: 'threat.auth_failures', severity: 'low' }, { event_type: 'other', severity: 'high' }] }).ok);
  const p = knowledge.promoteKnowledge(store, k);
  assert.ok(p.ok);
  assert.equal(p.shared.tenant_id, undefined);
  assert.equal(k.stage, 'PROMOTED');
  assert.equal(knowledge.sharedKnowledge(store).length, 1);
});

test('S10. CUSTOMER_PRIVATE, RESTRICTED and CHE_ONLY knowledge never promote; leftover identifiers fail review', () => {
  const store = events.emptyStore();
  for (const tag of ['CUSTOMER_PRIVATE', 'RESTRICTED', 'CHE_ONLY']) {
    const k = knowledge.captureExperience(store, 't', { title: 'x', portability: tag });
    const r = knowledge.generalize(k, { lesson: 'a lesson' });
    assert.equal(r.ok, false);
    assert.equal(k.stage, 'REJECTED');
  }
  assert.deepEqual(knowledge.PORTABILITY, ['CHE_ONLY', 'SHARED_SECURITY', 'PRODUCT_GENERAL', 'CUSTOMER_PRIVATE', 'RESTRICTED']);
  const k = knowledge.captureExperience(store, 't', { title: 'x', portability: 'PRODUCT_GENERAL' });
  knowledge.generalize(k, { lesson: 'Device Zorblax7 was lost' });
  knowledge.stripIdentifiers(k, { identifiers: [] });
  k._identifiers = ['Zorblax7'];
  const r = knowledge.reviewKnowledge(k);
  assert.equal(r.ok, false);
  assert.equal(k.stage, 'REJECTED');
  assert.equal(knowledge.sharedKnowledge(store).length, 0);
});

test('S11. the security agent sits under the lead assistant, directs the specialists, keeps coding peers separate, and its state follows real incidents', () => {
  const h = agent.hierarchy({ owner: 'Owner', lead: 'Lead', separate: [{ id: 'coder', name: 'Coder' }] }, productConfig({ agent_name: 'Guardian' }));
  assert.deepEqual(h.chain.slice(0, 3).map((c) => [c.id, c.reports_to]), [['owner', null], ['lead', 'owner'], ['security', 'lead']]);
  assert.equal(h.chain[2].name, 'Guardian');
  assert.ok(h.chain.slice(3).every((c) => c.reports_to === 'security'));
  assert.equal(h.separate[0].relation, 'peer_outside_security_chain');
  const store = events.emptyStore();
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.equal(agent.agentState(store, 't', { now }).state, 'MONITORING');
  assert.equal(agent.agentState(store, 't', { lastCheckAt: '2026-10-22T11:00:00Z', now }).state, 'SECURED');
  const inc = incidents.openIncident(store, 't', { title: 'x' });
  assert.equal(agent.agentState(store, 't', { now }).state, 'INVESTIGATING');
  incidents.advanceIncident(inc, 'CONTAINING', { note: 'locking' });
  assert.equal(agent.agentState(store, 't', { now }).state, 'CONTAINING');
  incidents.advanceIncident(inc, 'RECOVERING', { note: 'restoring' });
  assert.equal(agent.agentState(store, 't', { now }).state, 'RECOVERING');
  incidents.openIncident(store, 't', { title: 'drill', simulation: true });
  incidents.advanceIncident(inc, 'RESOLVED', { note: 'done' });
  assert.equal(agent.agentState(store, 't', { lastCheckAt: '2026-10-22T11:00:00Z', now }).state, 'SECURED', 'a simulation never changes the real state');
});

test('S12. simulations run in an isolated sandbox, are labelled SIMULATION everywhere and cannot reach a real system', () => {
  const realStore = events.emptyStore();
  events.openBus(realStore, 'owner').publish({ event_type: 'real' });
  const before = JSON.stringify(realStore);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error('no network'); };
  try {
    for (const s of simulation.SCENARIOS) {
      const r = simulation.runSimulation(s.id, { now: Date.parse('2026-10-22T00:00:00Z') });
      assert.equal(r.label, 'SIMULATION');
      assert.equal(r.touched_real_systems, false);
      assert.ok(r.events.every((e) => e.verification === 'simulation' && e.tenant_id === 'simulation'));
      assert.equal(r.incident.simulation, true);
      assert.equal(r.replay.label, 'SIMULATION');
      assert.equal(r.incident.stage, 'RESOLVED');
      assert.equal(r.replay.frames.length, 8);
    }
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(realStore), before);
  assert.equal(simulation.runSimulation('nope').ok, false);
});

test('S13. readiness is computed from measured metrics only, shows its working, and excludes what was not measured', () => {
  const none = readiness.computeReadiness({});
  assert.equal(none.score, 0, 'only the snapshot component counts as measured (missing snapshot = 0)');
  assert.equal(none.unknown.length, 7);
  const good = readiness.computeReadiness({ last_check_age_h: 2, open_incidents: 0, open_high_events: 0, wide_grants: 0, unreviewed_capabilities: 0, dependency_advisories: 0, snapshot_age_h: 10, secret_exposures_24h: 0, secret_redactions_24h: 4 });
  assert.equal(good.score, 100);
  assert.match(good.how, /not immunity/);
  const bad = readiness.computeReadiness({ last_check_age_h: 2, open_incidents: 1, open_high_events: 3, wide_grants: 1, unreviewed_capabilities: 0, dependency_advisories: null, snapshot_age_h: null, secret_exposures_24h: 0 });
  assert.ok(bad.score < 60);
  assert.ok(bad.components.find((c) => c.id === 'open_incidents').evidence.includes('1 open'));
  assert.ok(bad.unknown.includes('dependencies'));
  const sum = bad.components.filter((c) => c.score != null).reduce((n, c) => n + c.weight * c.score, 0);
  assert.equal(bad.score, Math.round((sum / bad.measured_weight) * 100));
});

test('S14. least privilege: wildcards and broad scopes are flagged; lockdown needs its preview token and an explicit yes', async () => {
  const ps = [access.principal({ id: 'a', kind: 'agent', scopes: ['*'] }), access.principal({ id: 't', kind: 'tool', scopes: ['network:api.example.com', 'credentials:*'] }), access.principal({ id: 'd', kind: 'device', scopes: [] })];
  const review = access.reviewAccess(ps);
  assert.equal(review.least_privilege, false);
  assert.deepEqual(review.findings.map((f) => f.id), ['a', 't']);
  assert.equal(access.allowed(ps[1], 'network:api.example.com'), true);
  assert.equal(access.allowed(ps[1], 'network:other.com'), false);
  assert.throws(() => access.principal({ id: 'x', kind: 'robot' }));
  const preview = await access.previewLockdown({ mechanisms: [{ id: 'm', effect: 'pauses x' }], keeps: ['y stays'], principals: ps });
  assert.equal(preview.requires_confirmation, true);
  assert.deepEqual(preview.effects, [{ id: 'm', effect: 'pauses x' }]);
  assert.equal((await access.confirmLockdown({ token: preview.token, confirm: false, preview })).reason, 'explicit_confirmation_required');
  assert.equal((await access.confirmLockdown({ token: 'wrong', confirm: true, preview })).reason, 'preview_token_mismatch');
  assert.equal((await access.confirmLockdown({ token: preview.token, confirm: true, preview }, Date.now() + 11 * 60_000)).reason, 'preview_expired');
  assert.ok((await access.confirmLockdown({ token: preview.token, confirm: true, preview })).ok);
});

test('S15. policies refuse offensive actions, retaliation, probing unrelated systems and unhackable claims; the veto blocks unsafe capabilities', () => {
  assert.equal(policies.evaluateAction({ verb: 'hack back' }).allowed, false);
  assert.equal(policies.evaluateAction({ verb: 'retaliate' }).policy, 'defensive_only');
  assert.equal(policies.evaluateAction({ verb: 'port scan', target: 'stranger.example', owned: ['worker'] }).policy, 'owned_scope_only');
  assert.equal(policies.evaluateAction({ verb: 'scan', target: 'worker', owned: ['worker'] }).allowed, true);
  assert.equal(policies.overclaims('Your phone is unhackable now'), true);
  assert.equal(policies.overclaims('No system can be made unhackable.'), false);
  const clean = { checks: { security: { ok: true } }, permissions: { network: ['api.example.com'] }, approval_policy: 'owner' };
  assert.equal(capabilitySecurity.vetoCapability(clean).ok, true);
  assert.match(capabilitySecurity.vetoCapability({ ...clean, permissions: { network: ['*'] } }).reasons.join(), /wildcard network/);
  assert.match(capabilitySecurity.vetoCapability({ ...clean, description: `key ${GH_TOKEN}` }).reasons.join(), /credential/);
  assert.match(capabilitySecurity.vetoCapability({ ...clean, approval_policy: 'auto', permissions: { actions: ['delete'] } }).reasons.join(), /risky actions/);
  assert.match(capabilitySecurity.vetoCapability({ ...clean, checks: {} }).reasons.join(), /security review/);
  assert.deepEqual(workflows.confirmationsNeeded('contain_incident'), ['access.activate_lockdown']);
});

// ─── Physical security architecture (6) ─────────────────────────────────────

test('P1. with no adapter, every physical device is unsupported and nothing is shown as connected', () => {
  physical._clearPhysicalAdapters();
  const cam = physical.physicalDevice({ id: 'c1', device_class: 'camera', name: 'Front door', adapter: 'acme-cam' });
  assert.equal(cam.status, 'unsupported');
  const view = physical.physicalView([cam]);
  assert.equal(view.architecture_only, true);
  assert.equal(view.devices[0].connected, false);
  assert.match(view.note, /architecture only/);
});

test('P2. a device is connected only after a supported adapter completes a verified handshake', async () => {
  physical._clearPhysicalAdapters();
  physical.registerPhysicalAdapter({ id: 'lab', classes: ['motion_sensor'], handshake: async (d) => d.id === 'ok' });
  const good = physical.physicalDevice({ id: 'ok', device_class: 'motion_sensor', adapter: 'lab' });
  assert.equal(good.status, 'not_connected');
  const verified = await physical.verifyPhysicalDevice(good);
  assert.equal(verified.status, 'connected');
  assert.ok(verified.verified_at);
  const bad = await physical.verifyPhysicalDevice(physical.physicalDevice({ id: 'no', device_class: 'motion_sensor', adapter: 'lab' }));
  assert.equal(bad.status, 'error');
  assert.equal(physical.physicalView([bad]).devices[0].connected, false);
  physical._clearPhysicalAdapters();
});

test('P3. an adapter that does not support the class, or a throwing handshake, never yields connected', async () => {
  physical._clearPhysicalAdapters();
  physical.registerPhysicalAdapter({ id: 'cams', classes: ['camera'], handshake: async () => { throw new Error('offline'); } });
  assert.equal(physical.physicalDevice({ id: 'l', device_class: 'door_lock', adapter: 'cams' }).status, 'unsupported');
  const cam = await physical.verifyPhysicalDevice(physical.physicalDevice({ id: 'c', device_class: 'camera', adapter: 'cams' }));
  assert.equal(cam.status, 'error');
  assert.throws(() => physical.physicalDevice({ id: 'x', device_class: 'turret' }));
  assert.throws(() => physical.registerPhysicalAdapter({ id: 'x' }));
  physical._clearPhysicalAdapters();
});

test('P4. harmful physical responses are refused outright, even with the owner\'s confirmation', () => {
  const dev = { status: 'connected', verified_at: 'now' };
  for (const a of physical.FORBIDDEN_RESPONSES) {
    const r = physical.physicalResponse(a, { owner_confirmed: true, device: dev });
    assert.equal(r.allowed, false, a);
    assert.match(r.reason, /never taken/);
  }
  assert.ok(physical.FORBIDDEN_RESPONSES.includes('lock_person_in'));
  assert.ok(physical.FORBIDDEN_RESPONSES.includes('disable_smoke_detector'));
});

test('P5. the only autonomous physical responses are notifying and recording; actuation needs the owner and a verified device', () => {
  assert.deepEqual(physical.AUTONOMOUS_RESPONSES, ['notify_owner', 'record_event', 'save_clip_reference']);
  assert.equal(physical.physicalResponse('notify_owner').autonomous, true);
  assert.equal(physical.physicalResponse('lock_door', { device: { status: 'connected' } }).needs_owner, true);
  assert.equal(physical.physicalResponse('lock_door', { owner_confirmed: true, device: { status: 'unsupported' } }).allowed, false);
  assert.equal(physical.physicalResponse('lock_door', { owner_confirmed: true, device: { status: 'connected' } }).allowed, true);
  assert.equal(physical.physicalResponse('teleport').allowed, false);
});

test('P6. physical safety is part of the versioned policy set and of the device engine', () => {
  assert.ok(policies.POLICIES.some((p) => p.id === 'physical_no_harm'));
  assert.equal(ENGINES.device.physical, physical);
  assert.ok(physical.PHYSICAL_DEVICE_CLASSES.includes('door_lock'));
  assert.deepEqual(physical.PHYSICAL_STATUSES, ['unsupported', 'not_connected', 'connected', 'error']);
});
