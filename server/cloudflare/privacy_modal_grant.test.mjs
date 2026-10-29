// A Modal GPU permission is narrow and owner-controlled: it is requested in words, its confirmation lists exactly what
// would be transmitted, nothing opens until the owner says yes, and it opens only the Modal host for its time. Real
// policy code (privacy_mode.js); no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PENDING_KEY, PRIVACY_KEY, loadPrivacy, privacyConfirmIntent, privacyIntent, privacyTurn, privacyVerdict, runWithPrivacy, TRANSMITS } from './privacy_mode.js';

const HOUR = 3_600_000;
function memoryStorage() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    put: async (k, v) => { map.set(k, structuredClone(v)); },
    delete: async (k) => { map.delete(k); },
    has: (k) => map.has(k),
  };
}

test('"let Modal help for an hour" is a grant request for Modal only, one hour', () => {
  const ask = privacyIntent('Knox, let Modal help for an hour');
  assert.equal(ask.action, 'grant');
  assert.equal(ask.provider, 'modal');
  assert.equal(ask.ms, HOUR);
});

test('the confirmation lists exactly what Modal would receive, and nothing opens before "yes"', async () => {
  const storage = memoryStorage();
  const now = Date.parse('2026-10-28T10:00:00Z');
  const reply = await privacyTurn(storage, privacyIntent('Knox, let Modal help for an hour'), { now });
  assert.match(reply.text, /Exactly what would be sent to Modal GPU:/);
  for (const line of TRANSMITS.modal) assert.ok(reply.text.includes(line), `the confirmation names: ${line}`);
  assert.match(reply.text, /Nothing else leaves; no other company is opened/);
  assert.equal(storage.has(PENDING_KEY), true, 'the request waits for a yes');
  const stored = await storage.get(PRIVACY_KEY);
  assert.equal(stored, undefined, 'no permission is stored before the owner confirms');
});

test('"yes" opens Modal only, for the stated time; the Modal host is allowed and OpenAI is still blocked', async () => {
  const storage = memoryStorage();
  const now = Date.parse('2026-10-28T10:00:00Z');
  await privacyTurn(storage, privacyIntent('Knox, let Modal help for an hour'), { now });
  const confirm = await privacyConfirmIntent(storage, 'yes', now + 1000);
  assert.equal(confirm.action, 'confirm');
  const done = await privacyTurn(storage, confirm, { now: now + 1000 });
  assert.match(done.text, /Modal GPU is allowed until 11:00 UTC/);
  await runWithPrivacy(storage, async () => {
    const modal = privacyVerdict('https://vondada--che-gpu.modal.run/health', now + 2000);
    assert.equal(modal.allow, true, 'the Modal host is allowed during the grant');
    assert.equal(privacyVerdict('https://api.openai.com/v1/chat/completions', now + 2000).allow, false, 'OpenAI stays blocked');
    assert.equal(privacyVerdict('https://evil.example.com/collect', now + 2000), null, 'an unrelated host is not opened by this grant');
  }, now + 2000);
});

test('the grant expires: after the hour the Modal host is blocked again', async () => {
  const storage = memoryStorage();
  const now = Date.parse('2026-10-28T10:00:00Z');
  await privacyTurn(storage, privacyIntent('Knox, let Modal help for an hour'), { now });
  const confirm = await privacyConfirmIntent(storage, 'yes', now + 1000);
  await privacyTurn(storage, confirm, { now: now + 1000 });
  await runWithPrivacy(storage, async () => {
    const later = privacyVerdict('https://vondada--che-gpu.modal.run/health', now + HOUR + 60_000);
    assert.equal(later.allow, false, 'after the hour, Modal is blocked again');
  }, now + HOUR + 60_000);
});

test('"no" keeps Private Mode: nothing is granted and the request is dropped', async () => {
  const storage = memoryStorage();
  const now = Date.parse('2026-10-28T10:00:00Z');
  await privacyTurn(storage, privacyIntent('Knox, let Modal help for an hour'), { now });
  const cancel = await privacyConfirmIntent(storage, 'no', now + 1000);
  assert.equal(cancel.action, 'cancel');
  await privacyTurn(storage, cancel, { now: now + 1000 });
  const policy = await loadPrivacy(storage, now + 2000);
  assert.equal(policy.level, 'private');
  assert.equal(policy.grants.length, 0);
});
