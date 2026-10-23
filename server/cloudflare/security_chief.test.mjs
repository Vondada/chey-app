import test from 'node:test';
import assert from 'node:assert/strict';
import { SECURITY_CHIEF_NAME, chiefAgent, securityChief, securityChiefIntent, speakChiefReport } from './security_chief.js';
import { CHE_SECURITY, access, chePrincipals } from './security_core_che.js';
import { hierarchy, SPECIALISTS } from './security_core/agent.js';
import { LA_AGENCIA_ROLES } from './office_company.js';
import { coverage } from './security_visibility.js';

const knox = { id: 'a-knox', name: 'Knox', role: 'Engineering / Codex jobs', runtime_status: 'idle' };

test('the chief is the existing Office agent Knox, not a new or duplicate agent', () => {
  assert.equal(SECURITY_CHIEF_NAME, 'Knox');
  assert.ok(LA_AGENCIA_ROLES.Knox, 'Knox is already on the canonical Office roster');
  assert.equal(chiefAgent({ team: [knox] }).id, 'a-knox');
  assert.equal(chiefAgent({ team: [{ ...knox, retired: true }] }), null, 'a retired Knox is not the chief');
  const principals = chePrincipals({});
  assert.equal(principals.filter((p) => p.kind === 'agent' && p.name === 'Knox').length, 1, 'one security agent, named Knox');
  assert.equal(principals.filter((p) => p.kind === 'agent' && /^Security$/.test(p.name)).length, 0, 'no second "Security" agent');
  const c = securityChief({ team: [knox] });
  assert.equal(c.agent_id, 'a-knox', 'the Security Room record points at the same Office agent');
  assert.equal(c.on_roster, true);
});

test('the chain is Owner → CHE → Knox → the eight specialists, with the Security Core unchanged', () => {
  const h = hierarchy({ owner: 'Owner', lead: 'CHE' }, CHE_SECURITY.config);
  assert.deepEqual(h.chain.slice(0, 3).map((c) => c.name), ['Owner', 'CHE', 'Knox']);
  assert.equal(h.chain.slice(3).length, SPECIALISTS.length);
  assert.equal(SPECIALISTS.length, 8);
  assert.ok(h.chain.slice(3).every((c) => c.reports_to === 'security'));
  const c = securityChief({ team: [knox] });
  assert.deepEqual(c.chain, ['Owner', 'CHE', 'Knox', 'Specialists']);
  assert.equal(c.supervisor, 'CHE');
  assert.equal(c.specialists.length, 8);
  assert.equal(CHE_SECURITY.config.product_name, 'Security', 'the room keeps its name');
});

test('identity matches the Office record: same name, persona and appearance', () => {
  const c = securityChief({ team: [knox] });
  assert.equal(c.name, 'Knox');
  assert.match(c.personality, /security holes/);
  assert.ok(c.appearance && c.appearance.accessory === 'headset', 'Knox\'s established look');
  assert.ok(c.strengths.some((s) => /security/i.test(s)));
});

test('permissions: configured grants are listed apart from verified checks; activity is only recorded checks and audit', () => {
  const principal = access.principal({ id: 'security', kind: 'agent', name: 'Knox', scopes: ['security:read', 'sessions:revoke'] });
  const cov = coverage({ checks: [{ at: '2026-10-23T14:00:00Z', advisories: null }], findings: 0, now: Date.parse('2026-10-23T15:00:00Z') });
  const c = securityChief({ team: [knox] }, { principal, coverage: cov, state: { state: 'MONITORING', reason: 'x' }, audit: [{ at: '2026-10-23T13:00:00Z', action: 'sessions_revoked', detail: '1 session(s)' }], checks: [{ at: '2026-10-23T14:00:00Z', findings: 0, advisories: null }] });
  assert.deepEqual(c.permissions_configured.map((p) => p.scope), ['security:read', 'sessions:revoke']);
  assert.deepEqual(c.integrations_verified.map((v) => v.id), ['security_check', 'devices'], 'only checks that actually ran');
  assert.equal(c.status.state, 'MONITORING');
  assert.equal(c.recent_verified_activity[0].kind, 'check');
  assert.ok(c.recent_verified_activity.every((a) => a.verified === true && a.at));
  const empty = securityChief({});
  assert.deepEqual(empty.integrations_verified, []);
  assert.deepEqual(empty.recent_verified_activity, []);
  assert.equal(empty.status.state, 'UNKNOWN');
  assert.equal(empty.on_roster, false);
});

test('conduct: monitoring, warnings and recording only; life safety is preserved', () => {
  const c = securityChief({ team: [knox] });
  assert.ok(c.conduct.some((s) => /never harms, threatens, traps, confronts or retaliates/.test(s)));
  assert.ok(c.conduct.some((s) => /life-safety/.test(s)));
});

test('"have Knox check security" is recognized; ordinary sentences that mention Knox are not', () => {
  for (const t of ['CHE, have Knox check security', 'Ask Knox to run a security check', 'Knox, check security', 'Have Knox run a security scan', 'hey che, get knox to do a security sweep', 'Tell Knox to review our security']) assert.deepEqual(securityChiefIntent(t), { action: 'chief_check' }, t);
  for (const t of ['Knox fixed the bug', 'Have Knox check the website', 'What did Knox say about security?', "Knox's notes on security", 'Check security', 'Ask Knox to fix the security page layout', 'Knox is checking security tomorrow', 'Is Knox good at security?']) assert.equal(securityChiefIntent(t), null, t);
});

test('the report names the checks that ran, when, the findings, and what was not checked', () => {
  const cov = coverage({ checks: [{ at: '2026-10-23T14:05:00Z', advisories: null }], findings: 1, now: Date.parse('2026-10-23T15:00:00Z') });
  const text = speakChiefReport(securityChief({ team: [knox] }), { findings: ['new device (info)'], coverage: cov });
  assert.match(text, /^Knox ran the security check at 2026-10-23 14:05 UTC, sir\./);
  assert.match(text, /Checked: threat and access check, paired device review\./);
  assert.match(text, /1 finding: 1\. new device \(info\)\./);
  assert.match(text, /Not checked: dependency advisories, deployment matches the repository/);
  const none = speakChiefReport(securityChief({}), { findings: [], coverage: coverage({ checks: [], findings: 0 }) });
  assert.match(none, /No check completed\./);
});
