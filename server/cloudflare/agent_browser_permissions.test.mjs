// Hands-on app steps: the owner's rules, enforced in code (agent_permissions.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBrowserStepMayRun, browserStepKind } from './agent_permissions.js';

test('reading, clicking, typing and navigating an app she was granted all run now', () => {
  const grants = ['Gmail'];
  assert.deepEqual(assertBrowserStepMayRun({ action: 'read' }, { app: 'Gmail', grants }), { held: false, kind: 'read' });
  assert.deepEqual(assertBrowserStepMayRun({ action: 'navigate' }, { app: 'Gmail', grants }), { held: false, kind: 'navigate' });
  assert.deepEqual(assertBrowserStepMayRun({ action: 'click', label: 'Open inbox' }, { app: 'Gmail', grants }), { held: false, kind: 'click' });
  assert.deepEqual(assertBrowserStepMayRun({ action: 'type', label: 'Search' }, { app: 'Gmail', grants }), { held: false, kind: 'type' });
});

test('sending a message or email runs now, because the owner gave standing permission to send', () => {
  const r = assertBrowserStepMayRun({ action: 'click', label: 'Send' }, { app: 'Gmail', grants: ['Gmail'] });
  assert.deepEqual(r, { held: false, kind: 'send' });
});

test('buying, paying or subscribing is held until the owner says yes', () => {
  const r = assertBrowserStepMayRun({ action: 'click', label: 'Place order' }, { app: 'Shop', grants: ['Shop'] });
  assert.equal(r.held, true);
  assert.equal(r.kind, 'spend');
  const confirmed = assertBrowserStepMayRun({ action: 'click', label: 'Place order' }, { app: 'Shop', grants: ['Shop'], ownerConfirmed: true });
  assert.equal(confirmed.held, false);
});

test('deleting or removing is held until the owner says yes', () => {
  const r = assertBrowserStepMayRun({ action: 'click', label: 'Delete this email' }, { app: 'Gmail', grants: ['Gmail'] });
  assert.equal(r.held, true);
  assert.equal(r.kind, 'delete');
  assert.equal(browserStepKind({ action: 'click', label: 'Cancel my subscription' }), 'delete');
});

test('an app the owner has not granted is refused, whatever the step', () => {
  assert.throws(() => assertBrowserStepMayRun({ action: 'read' }, { app: 'TikTok', grants: ['Gmail'] }), /no permission to act in TikTok/);
  assert.throws(() => assertBrowserStepMayRun({ action: 'read' }, { app: '', grants: ['Gmail'] }), /no permission/);
});

test('a password is typed only from the vault, never from a value', () => {
  const grants = ['Instagram'];
  const ok = assertBrowserStepMayRun({ action: 'type', secret: true, vault_ref: 'instagram.password' }, { app: 'Instagram', grants });
  assert.deepEqual(ok, { held: false, kind: 'credential' });
  assert.throws(() => assertBrowserStepMayRun({ action: 'type', secret: true, value: 'hunter2' }, { app: 'Instagram', grants }), /only be typed from the on-device vault/);
  assert.throws(() => assertBrowserStepMayRun({ action: 'type', secret: true }, { app: 'Instagram', grants }), /only be typed from the on-device vault/);
});

test('an explicit kind wins over the label', () => {
  assert.equal(browserStepKind({ kind: 'read', label: 'Buy now' }), 'read');
  assert.equal(browserStepKind({ kind: 'nonsense', action: 'click', label: 'Open' }), 'click');
});
