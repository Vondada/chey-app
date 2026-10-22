// The capability registry: only a candidate that passed every promotion check is usable or claimable.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PROMOTION_CHECKS, EXECUTION, emptyRegistry, register, recordCheck, promote, rollback, serving, recordUse, executionAllowed, speakCapability } from './capability_registry.js';

const passAll = (r, id) => { for (const c of PROMOTION_CHECKS) recordCheck(r, id, c, { ok: true, evidence: `${c} passed` }); };

test('a described or prototyped capability is never usable or claimed as working', () => {
  const r = emptyRegistry();
  register(r, { id: 'render.beach', name: 'Render a beach scene', status: 'AVAILABLE' });
  assert.equal(r.capabilities['render.beach'].status, 'PROTOTYPED', 'a caller cannot register straight to AVAILABLE');
  assert.equal(serving(r, 'render.beach'), null);
  assert.match(speakCapability(r.capabilities['render.beach']), /prototyped, not a working capability yet/);
  assert.equal(promote(r, 'render.beach').reason, 'missing_checks');
});

test('promotion needs every check; one failure rejects the candidate and the verified version keeps serving; rollback works', () => {
  const r = emptyRegistry();
  register(r, { id: 'render.png', name: 'Render PNG' });
  passAll(r, 'render.png');
  assert.equal(promote(r, 'render.png').ok, true);
  assert.equal(recordUse(r, 'render.png', true).status, 'AVAILABLE');
  register(r, { id: 'render.png', name: 'Render PNG' });
  assert.equal(serving(r, 'render.png').version, 1, 'the candidate does not serve yet');
  passAll(r, 'render.png');
  recordCheck(r, 'render.png', 'security', { ok: false, evidence: 'network access requested' });
  const out = promote(r, 'render.png');
  assert.deepEqual([out.ok, out.failed], [false, ['security']]);
  assert.equal(r.capabilities['render.png'].status, 'REJECTED');
  assert.equal(serving(r, 'render.png').version, 1);
  assert.equal(rollback(r, 'render.png').cap.version, 1);
});

test('internal-only mode and external approval are enforced in code', () => {
  const r = emptyRegistry();
  register(r, { id: 'ext.video', name: 'Generate video', execution: EXECUTION.EXTERNAL_PAID });
  passAll(r, 'ext.video'); promote(r, 'ext.video');
  const cap = serving(r, 'ext.video');
  assert.equal(executionAllowed(cap, { internal_only: true }).ok, false);
  assert.equal(executionAllowed(cap, {}).needs_approval, true);
  assert.equal(executionAllowed(cap, { approved_external: ['ext.video'] }).ok, true);
  assert.equal(executionAllowed(cap, { approved_external: ['ext.video'], no_paid: true }).ok, false);
  register(r, { id: 'int.png', name: 'PNG', execution: EXECUTION.OWNER_COMPUTE });
  passAll(r, 'int.png'); promote(r, 'int.png');
  assert.equal(executionAllowed(serving(r, 'int.png'), { internal_only: true }).ok, true);
  assert.deepEqual(r.capabilities['int.png'].permissions.network, [], 'least privilege by default');
});
