import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isE164,
  normalizeE164,
  twilioConfigured,
  twilioMissingSecrets,
  twilioStatus,
  createBulkDraft,
  sendSms,
  sendSmsBulk,
  confirmBulkJob,
  handleInboundSms,
  pendingBulkDecisions,
  isOptedOut,
  markOptedOut,
  verifyTwilioSignature,
} from './twilio_sms.js';

test('E.164 validation and US normalize', () => {
  assert.equal(isE164('+15551234567'), true);
  assert.equal(isE164('5551234567'), false);
  assert.equal(normalizeE164('5551234567'), '+15551234567');
  assert.equal(normalizeE164('+44 7700 900123'), '+447700900123');
  assert.equal(normalizeE164('bad'), '');
});

test('missing secrets listed honestly; status never echoes values', () => {
  const env = {};
  assert.equal(twilioConfigured(env), false);
  assert.deepEqual(twilioMissingSecrets(env), ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER']);
  const status = twilioStatus(env, {});
  assert.equal(status.connected, false);
  assert.equal(status.sender, 'CHE');
  assert.match(status.authority, /Only CHE/);
  assert.ok(status.secret_names.includes('TWILIO_ACCOUNT_SID'));
  assert.ok(!JSON.stringify(status).includes('AuthToken'));
});

test('bulk draft stays Owner decision pending and does not call Twilio', async () => {
  const data = {};
  const draft = createBulkDraft(data, {
    numbers: ['+15551110001', '5551110002', 'nope'],
    body: 'Hello from CHE trial',
  });
  assert.equal(draft.status, 200);
  assert.equal(draft.job.status, 'pending_owner');
  assert.equal(draft.job.owner_approved, false);
  assert.equal(draft.job.owner_decision, 'pending');
  assert.equal(draft.job.recipient_count, 2);
  assert.match(draft.job.note, /Owner decision: pending/);
  assert.equal(pendingBulkDecisions(data).length, 1);

  let called = 0;
  const fetcher = async () => { called += 1; return { ok: true, json: async () => ({ sid: 'SM1' }) }; };
  const blocked = await sendSmsBulk(
    { TWILIO_ACCOUNT_SID: 'ACxxx', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550001111' },
    data,
    { job_id: draft.job.id, owner_approved: false },
    fetcher,
  );
  assert.equal(blocked.pending, true);
  assert.match(blocked.error, /Owner decision: pending/);
  assert.equal(called, 0);
});

test('confirm bulk sends one-to-one with rate limit and per-number results', async () => {
  const env = {
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'secret',
    TWILIO_FROM_NUMBER: '+15550001111',
  };
  const data = {};
  const draft = createBulkDraft(data, {
    numbers: ['+15551110001', '+15551110002'],
    body: 'Bulk hello',
  });
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: true, json: async () => ({ sid: `SM${calls.length}`, status: 'queued' }) };
  };
  const out = await confirmBulkJob(env, data, draft.job.id, { owner_approved: true }, fetcher);
  assert.equal(out.results.length, 2);
  assert.equal(out.results.every((r) => r.ok && r.sid), true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].body, /To=%2B15551110001/);
  assert.equal(data.twilio_bulk_jobs[0].status, 'sent');
});

test('send_sms blocks opted-out and missing config', async () => {
  const data = {};
  markOptedOut(data, '+15551119999');
  assert.equal(isOptedOut(data, '+15551119999'), true);
  const missing = await sendSms({}, data, { to: '+15551119999', body: 'hi' });
  assert.match(missing.error, /not configured|Blocked/);
  const env = { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: '+15550001111' };
  const blocked = await sendSms(env, data, { to: '+15551119999', body: 'hi' }, async () => {
    throw new Error('should not call');
  });
  assert.match(blocked.error, /opted out/i);
});

test('inbound STOP opts out and HELP returns ack TwiML; surfaces CHE job', async () => {
  const env = {};
  const data = {};
  const stop = await handleInboundSms(env, data, {
    rawBody: 'From=%2B15551230000&To=%2B15550001111&Body=STOP&MessageSid=SMstop',
    publicUrl: 'https://chey-app.henryjavoni.workers.dev/api/twilio/sms/inbound',
  });
  assert.equal(stop.status, 200);
  assert.match(stop.twiml, /opted out/i);
  assert.equal(isOptedOut(data, '+15551230000'), true);
  assert.equal(data.jobs[0].for_agent, 'CHE');
  assert.equal(data.jobs[0].source, 'twilio_sms');

  const help = await handleInboundSms(env, data, {
    rawBody: 'From=%2B15551230001&To=%2B15550001111&Body=HELP',
    publicUrl: 'https://chey-app.henryjavoni.workers.dev/api/twilio/sms/inbound',
  });
  assert.match(help.twiml, /HELP|help|STOP/i);
});

test('unapproved sendSmsBulk creates pending draft', async () => {
  const env = { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: '+15550001111' };
  const data = {};
  const out = await sendSmsBulk(env, data, {
    numbers: ['+15551110001'],
    body: 'Need owner yes',
    owner_approved: false,
  }, async () => ({ ok: true, json: async () => ({}) }));
  assert.equal(out.pending, true);
  assert.equal(out.job.status, 'pending_owner');
  assert.match(out.error, /Owner decision: pending/);
});

test('verifyTwilioSignature rejects bad sig when token set', async () => {
  await assert.rejects(
    () => verifyTwilioSignature('token', 'https://example.com/hook', { From: '+1' }, 'badsig'),
    /twilio_signature_invalid/,
  );
});
