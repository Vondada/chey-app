// Hands-on app steps: the owner's rules, enforced in code (agent_permissions.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBrowserStepMayRun, browserStepKind, needsOwnerVerification } from './agent_permissions.js';

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

test('creating an account is held until the owner says yes for it; the owner does the verification', () => {
  const r = assertBrowserStepMayRun({ action: 'click', label: 'Create account' }, { app: 'TikTok', grants: ['TikTok'] });
  assert.equal(r.held, true);
  assert.equal(r.kind, 'signup');
  assert.match(r.reason, /You do the verification step/);
  const yes = assertBrowserStepMayRun({ action: 'click', label: 'Sign up' }, { app: 'TikTok', grants: ['TikTok'], ownerConfirmed: true });
  assert.deepEqual(yes, { held: false, kind: 'signup' });
});

test('filling a signup form field is not held, and her password for the account is typed from the vault', () => {
  const grants = ['Instagram'];
  assert.deepEqual(assertBrowserStepMayRun({ action: 'type', label: 'Email' }, { app: 'Instagram', grants }), { held: false, kind: 'type' });
  assert.deepEqual(assertBrowserStepMayRun({ action: 'type', secret: true, vault_ref: 'instagram.password' }, { app: 'Instagram', grants }), { held: false, kind: 'credential' });
});

test('a verification, CAPTCHA or phone-check page is recognized, and an ordinary page is not', () => {
  assert.equal(needsOwnerVerification('Enter the 6-digit verification code we sent to your email.'), true);
  assert.equal(needsOwnerVerification('Confirm you are not a robot'), true);
  assert.equal(needsOwnerVerification('Verify your phone number to continue'), true);
  assert.equal(needsOwnerVerification('Welcome back. Here is your feed.'), false);
});
