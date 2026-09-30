// CHE Twilio SMS (trial-ready). Only CHE may send; Office helpers may draft
// text into a pending bulk job. Secrets stay on the Worker; never echo values.
//
// Secrets (names only): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
// Optional: TWILIO_MESSAGING_SERVICE_SID
//
// Outbound bulk stays Owner decision: pending until owner_approved === true.

const E164 = /^\+[1-9]\d{7,14}$/;
const TWILIO_API = 'https://api.twilio.com/2010-04-01';
const DEFAULT_RATE_MS = 1100;
const MAX_BULK = 50;
const MAX_BODY = 1600;
const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const TWIML_HELP = '<?xml version="1.0" encoding="UTF-8"?><Response><Message>CHE SMS help: reply STOP to opt out. For support, contact the sender.</Message></Response>';
const TWIML_STOP = '<?xml version="1.0" encoding="UTF-8"?><Response><Message>You are opted out of CHE SMS. Reply START to re-subscribe if available.</Message></Response>';

export function isE164(value) {
  return E164.test(String(value || '').trim());
}

export function normalizeE164(value) {
  const raw = String(value || '').trim().replace(/[\s()-]/g, '');
  if (isE164(raw)) return raw;
  if (/^\d{10}$/.test(raw)) return `+1${raw}`;
  if (/^1\d{10}$/.test(raw)) return `+${raw}`;
  return '';
}

export function twilioConfigured(env) {
  return Boolean(
    String(env?.TWILIO_ACCOUNT_SID || '').trim()
    && String(env?.TWILIO_AUTH_TOKEN || '').trim()
    && (String(env?.TWILIO_FROM_NUMBER || '').trim() || String(env?.TWILIO_MESSAGING_SERVICE_SID || '').trim()),
  );
}

export function twilioMissingSecrets(env) {
  const missing = [];
  if (!String(env?.TWILIO_ACCOUNT_SID || '').trim()) missing.push('TWILIO_ACCOUNT_SID');
  if (!String(env?.TWILIO_AUTH_TOKEN || '').trim()) missing.push('TWILIO_AUTH_TOKEN');
  if (!String(env?.TWILIO_FROM_NUMBER || '').trim() && !String(env?.TWILIO_MESSAGING_SERVICE_SID || '').trim()) {
    missing.push('TWILIO_FROM_NUMBER');
  }
  return missing;
}

/** Status for Plugins / Test connection — never includes secret values. */
export function twilioStatus(env, data = {}) {
  const missing = twilioMissingSecrets(env);
  const connected = missing.length === 0;
  const pending = (data.twilio_bulk_jobs || []).filter((j) => j.status === 'pending_owner').length;
  const optedOut = Array.isArray(data.twilio_opt_outs) ? data.twilio_opt_outs.length : 0;
  return {
    connected,
    ready: connected,
    missing_secrets: missing,
    from_configured: Boolean(String(env?.TWILIO_FROM_NUMBER || '').trim()),
    messaging_service_configured: Boolean(String(env?.TWILIO_MESSAGING_SERVICE_SID || '').trim()),
    pending_bulk_jobs: pending,
    opted_out_count: optedOut,
    sender: 'CHE',
    authority: 'Only CHE may call send_sms / send_sms_bulk. Helpers may draft; CHE sends after owner yes on bulk.',
    inbound_webhook: 'https://chey-app.henryjavoni.workers.dev/api/twilio/sms/inbound',
    secret_names: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'TWILIO_MESSAGING_SERVICE_SID'],
    rules: [
      'Set secrets with wrangler secret put (never commit values).',
      'Trial: ~5 verified numbers, ~100 SMS, 30 days — verify each To number in Twilio console.',
      'Bulk stays Owner decision: pending until the owner confirms recipient count + sample text.',
      'Owner must only message consented recipients. STOP opts out; HELP acks.',
      'Paid US A2P needs 10DLC or toll-free registration.',
    ],
  };
}

export function isOptedOut(data, number) {
  const n = normalizeE164(number);
  if (!n) return false;
  return (data.twilio_opt_outs || []).includes(n);
}

export function markOptedOut(data, number) {
  const n = normalizeE164(number);
  if (!n) return false;
  data.twilio_opt_outs = Array.isArray(data.twilio_opt_outs) ? data.twilio_opt_outs : [];
  if (!data.twilio_opt_outs.includes(n)) data.twilio_opt_outs.push(n);
  data.twilio_opt_outs = data.twilio_opt_outs.slice(-2000);
  return true;
}

export function clearOptOut(data, number) {
  const n = normalizeE164(number);
  if (!n) return false;
  data.twilio_opt_outs = (data.twilio_opt_outs || []).filter((x) => x !== n);
  return true;
}

function basicAuthHeader(sid, token) {
  // btoa is available in Workers; Node tests polyfill via Buffer.
  const raw = `${sid}:${token}`;
  const encoded = typeof btoa === 'function'
    ? btoa(raw)
    : Buffer.from(raw, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}

function trialAwareError(status, code, message) {
  const msg = String(message || 'Twilio request failed');
  if (status === 401 || status === 403) {
    return 'Twilio auth failed. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (wrangler secret put).';
  }
  // Common trial: unverified number
  if (code === 21608 || /unverified|trial/i.test(msg)) {
    return 'Trial limit: that To number is not verified in Twilio. Verify it in the Twilio console, or upgrade the account.';
  }
  if (code === 21211 || /invalid.*phone|not a valid/i.test(msg)) {
    return 'Invalid phone number. Use E.164 (e.g. +15551234567).';
  }
  if (code === 21610 || /blacklist|opt.?out|unsubscribed/i.test(msg)) {
    return 'That number has opted out (STOP). CHE will not send until they re-subscribe.';
  }
  return msg.slice(0, 300);
}

async function twilioCreateMessage(env, { to, body }, fetcher = fetch) {
  const sid = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const token = String(env.TWILIO_AUTH_TOKEN || '').trim();
  const from = String(env.TWILIO_FROM_NUMBER || '').trim();
  const msid = String(env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  if (!sid || !token || (!from && !msid)) {
    return { ok: false, error: `Twilio not configured. Missing: ${twilioMissingSecrets(env).join(', ') || 'secrets'}.` };
  }
  const toNorm = normalizeE164(to);
  if (!toNorm) return { ok: false, error: 'Invalid To number. Use E.164 (e.g. +15551234567).' };
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'Message body is empty.' };
  if (text.length > MAX_BODY) return { ok: false, error: `Message body too long (max ${MAX_BODY} chars).` };

  const form = new URLSearchParams();
  form.set('To', toNorm);
  form.set('Body', text.slice(0, MAX_BODY));
  if (msid) form.set('MessagingServiceSid', msid);
  else form.set('From', from);

  const url = `${TWILIO_API}/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  let response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(sid, token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
  } catch (_) {
    return { ok: false, error: 'Twilio network error.' };
  }
  let payload = {};
  try { payload = await response.json(); } catch (_) { payload = {}; }
  if (!response.ok) {
    return {
      ok: false,
      error: trialAwareError(response.status, payload.code, payload.message || payload.detail),
      code: payload.code,
    };
  }
  return { ok: true, sid: String(payload.sid || ''), to: toNorm, status: String(payload.status || '') };
}

/**
 * CHE-only single send. Logs intent; blocks opted-out numbers.
 * Prefer clear owner intent via CHE before calling.
 */
export async function sendSms(env, data, { to, body }, fetcher = fetch) {
  if (!twilioConfigured(env)) {
    return { ok: false, error: `Blocked: Twilio not configured (${twilioMissingSecrets(env).join(', ')}).` };
  }
  const toNorm = normalizeE164(to);
  if (!toNorm) return { ok: false, error: 'Invalid To number. Use E.164 (e.g. +15551234567).' };
  if (isOptedOut(data, toNorm)) {
    return { ok: false, error: 'Number opted out (STOP). CHE will not send.' };
  }
  const result = await twilioCreateMessage(env, { to: toNorm, body }, fetcher);
  data.twilio_send_log = Array.isArray(data.twilio_send_log) ? data.twilio_send_log : [];
  data.twilio_send_log.unshift({
    at: new Date().toISOString(),
    kind: 'single',
    to: toNorm,
    ok: result.ok,
    sid: result.sid || null,
    error: result.ok ? null : String(result.error || '').slice(0, 200),
    body_preview: String(body || '').slice(0, 80),
  });
  data.twilio_send_log = data.twilio_send_log.slice(0, 100);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a pending bulk job — does NOT send. Owner decision: pending.
 */
export function createBulkDraft(data, { numbers, body, sample }) {
  const list = Array.isArray(numbers) ? numbers : [];
  const normalized = [];
  const invalid = [];
  for (const raw of list.slice(0, MAX_BULK)) {
    const n = normalizeE164(raw);
    if (n) normalized.push(n);
    else invalid.push(String(raw || '').slice(0, 32));
  }
  const unique = [...new Set(normalized)];
  const text = String(body || '').trim();
  if (!unique.length) return { status: 400, detail: 'No valid E.164 recipients.' };
  if (!text) return { status: 400, detail: 'Message body is empty.' };
  const job = {
    id: crypto.randomUUID(),
    status: 'pending_owner',
    recipient_count: unique.length,
    numbers: unique,
    invalid,
    body: text.slice(0, MAX_BODY),
    sample: String(sample || text).slice(0, 160),
    owner_approved: false,
    owner_decision: 'pending',
    created_at: new Date().toISOString(),
    note: 'Owner decision: pending. Bulk send will not fire until the owner confirms recipient count and sample text (owner_approved === true).',
  };
  data.twilio_bulk_jobs = Array.isArray(data.twilio_bulk_jobs) ? data.twilio_bulk_jobs : [];
  data.twilio_bulk_jobs.unshift(job);
  data.twilio_bulk_jobs = data.twilio_bulk_jobs.slice(0, 40);
  return { status: 200, job, detail: `Pending bulk SMS to ${unique.length} number(s). Owner decision: pending.` };
}

/**
 * Execute bulk only when owner_approved === true (or job already confirmed).
 * One-to-one loop (NOT group MMS), ~1 msg/sec.
 */
export async function sendSmsBulk(env, data, {
  numbers,
  body,
  owner_approved: ownerApproved,
  job_id: jobId,
  rate_ms: rateMs,
} = {}, fetcher = fetch) {
  if (!twilioConfigured(env)) {
    return {
      ok: false,
      error: `Blocked: Twilio not configured (${twilioMissingSecrets(env).join(', ')}).`,
      results: [],
    };
  }

  let job = null;
  if (jobId) {
    job = (data.twilio_bulk_jobs || []).find((j) => j.id === jobId);
    if (!job) return { ok: false, error: 'Bulk job not found.', results: [] };
  }

  const approved = ownerApproved === true || job?.owner_approved === true;
  if (!approved) {
    if (!job) {
      const draft = createBulkDraft(data, { numbers, body });
      return {
        ok: false,
        pending: true,
        owner_decision: 'pending',
        error: 'Outbound stays Owner decision: pending until the owner confirms recipient count, sample text, and says yes.',
        job: draft.job,
        results: [],
      };
    }
    return {
      ok: false,
      pending: true,
      owner_decision: 'pending',
      error: 'Outbound stays Owner decision: pending until the owner confirms this bulk job.',
      job,
      results: [],
    };
  }

  const list = job ? job.numbers : (Array.isArray(numbers) ? numbers : []);
  const text = job ? job.body : String(body || '').trim();
  if (!text) return { ok: false, error: 'Message body is empty.', results: [] };

  const delay = Math.max(800, Number(rateMs) || DEFAULT_RATE_MS);
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const to = normalizeE164(list[i]);
    if (!to) {
      results.push({ to: String(list[i] || ''), ok: false, error: 'Invalid E.164' });
      continue;
    }
    if (isOptedOut(data, to)) {
      results.push({ to, ok: false, error: 'opted_out' });
      continue;
    }
    const r = await twilioCreateMessage(env, { to, body: text }, fetcher);
    results.push({ to, ok: r.ok, sid: r.sid || undefined, error: r.ok ? undefined : r.error });
    if (i < list.length - 1) await sleep(delay);
  }

  if (job) {
    job.status = 'sent';
    job.owner_approved = true;
    job.owner_decision = 'approved';
    job.results = results;
    job.sent_at = new Date().toISOString();
  }

  data.twilio_send_log = Array.isArray(data.twilio_send_log) ? data.twilio_send_log : [];
  data.twilio_send_log.unshift({
    at: new Date().toISOString(),
    kind: 'bulk',
    count: results.length,
    ok_count: results.filter((r) => r.ok).length,
    job_id: job?.id || null,
  });
  data.twilio_send_log = data.twilio_send_log.slice(0, 100);

  return {
    ok: results.some((r) => r.ok),
    results,
    job_id: job?.id || null,
  };
}

/** Confirm a pending bulk job and send. */
export async function confirmBulkJob(env, data, jobId, { owner_approved: ownerApproved } = {}, fetcher = fetch) {
  if (ownerApproved !== true) {
    return { ok: false, error: 'Set owner_approved to true to confirm bulk send.', pending: true };
  }
  const job = (data.twilio_bulk_jobs || []).find((j) => j.id === jobId);
  if (!job) return { ok: false, error: 'Bulk job not found.' };
  if (job.status !== 'pending_owner') {
    return { ok: false, error: `Job is ${job.status}, not pending_owner.` };
  }
  job.owner_approved = true;
  job.owner_decision = 'approved';
  return sendSmsBulk(env, data, { job_id: jobId, owner_approved: true }, fetcher);
}

function parseFormBody(raw) {
  const params = new URLSearchParams(String(raw || ''));
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

async function hmacSha1Base64(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * Validate X-Twilio-Signature when AUTH_TOKEN is set.
 * url = full public URL of the webhook; params = POST form fields.
 */
export async function verifyTwilioSignature(authToken, url, params, signatureHeader) {
  if (!authToken) throw new Error('twilio_auth_token_missing');
  const sig = String(signatureHeader || '').trim();
  if (!sig) throw new Error('twilio_signature_missing');
  const keys = Object.keys(params || {}).sort();
  let data = String(url || '');
  for (const k of keys) data += k + String(params[k] ?? '');
  const expected = await hmacSha1Base64(authToken, data);
  if (!safeEqual(expected, sig)) throw new Error('twilio_signature_invalid');
}

/**
 * Handle inbound Twilio SMS webhook. Enqueues to CHE activity / inbound log.
 * Returns { twiml, status, inbound? }.
 */
export async function handleInboundSms(env, data, {
  rawBody,
  signature,
  publicUrl,
} = {}) {
  const params = parseFormBody(rawBody);
  const token = String(env?.TWILIO_AUTH_TOKEN || '').trim();
  if (token) {
    try {
      await verifyTwilioSignature(token, publicUrl, params, signature);
    } catch (error) {
      if (error.message === 'twilio_auth_token_missing') {
        // Should not happen when token present
      } else {
        return { status: 403, twiml: TWIML_EMPTY, detail: 'Invalid Twilio signature.' };
      }
    }
  }

  const from = normalizeE164(params.From) || String(params.From || '').trim();
  const to = String(params.To || '').trim();
  const body = String(params.Body || '').trim();
  const upper = body.toUpperCase();

  let twiml = TWIML_EMPTY;
  let kind = 'inbound';
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)\b/.test(upper)) {
    markOptedOut(data, from);
    twiml = TWIML_STOP;
    kind = 'opt_out';
  } else if (/^(HELP|INFO)\b/.test(upper)) {
    twiml = TWIML_HELP;
    kind = 'help';
  } else if (/^(START|YES|UNSTOP)\b/.test(upper)) {
    clearOptOut(data, from);
    kind = 'opt_in';
  }

  const inbound = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    from,
    to,
    body: body.slice(0, MAX_BODY),
    kind,
    message_sid: String(params.MessageSid || params.SmsSid || ''),
    for_agent: 'CHE',
  };
  data.twilio_inbound = Array.isArray(data.twilio_inbound) ? data.twilio_inbound : [];
  data.twilio_inbound.unshift(inbound);
  data.twilio_inbound = data.twilio_inbound.slice(0, 200);

  // Surface as a CHE job / owner-visible activity item
  data.jobs = Array.isArray(data.jobs) ? data.jobs : [];
  data.jobs.unshift({
    id: crypto.randomUUID(),
    title: kind === 'opt_out' ? `SMS opt-out from ${from}` : `Inbound SMS from ${from}`,
    prompt: body.slice(0, 400) || kind,
    status: 'queued',
    source: 'twilio_sms',
    for_agent: 'CHE',
    inbound_id: inbound.id,
    created_at: inbound.at,
    updated_at: inbound.at,
  });
  data.jobs = data.jobs.slice(0, 80);

  return { status: 200, twiml, inbound };
}

export function pendingBulkDecisions(data) {
  return (data.twilio_bulk_jobs || [])
    .filter((j) => j.status === 'pending_owner')
    .map((j) => ({
      id: j.id,
      who: 'CHE',
      title: `Bulk SMS to ${j.recipient_count} numbers`,
      reason: 'needs your decision',
      sample: j.sample,
      at: j.created_at,
      kind: 'twilio_bulk',
    }));
}

export { TWIML_EMPTY, MAX_BULK, DEFAULT_RATE_MS };
