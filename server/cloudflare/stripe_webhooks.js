// Stripe webhook → Office daily totals. The signature is verified with
// STRIPE_WEBHOOK_SECRET (Worker secret only) before any event is trusted.
// This file only reads money events; it never refunds, transfers or pays out.

const TOLERANCE_SECONDS = 300;

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('stripe_webhook_secret_missing');
  let timestamp = '';
  const signatures = [];
  for (const part of String(header || '').split(',')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp) || !signatures.length) throw new Error('stripe_signature_invalid');
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) throw new Error('stripe_signature_expired');
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  if (!signatures.some((sig) => safeEqual(sig, expected))) throw new Error('stripe_signature_invalid');
}

// Pure reducer. Charges count once (charge.succeeded only, so a payment's
// payment_intent.succeeded twin is not double-counted). Refunds use each
// charge's cumulative amount_refunded, so repeated partial refunds add up
// exactly once.
export function applyStripeEvent(today, event) {
  const next = {
    charges_cents: Number(today?.charges_cents || 0),
    refunds_cents: Number(today?.refunds_cents || 0),
    refunded_by_charge: { ...(today?.refunded_by_charge || {}) },
  };
  const object = event?.data?.object || {};
  if (event?.type === 'charge.succeeded' && (object.currency || 'usd') === 'usd') {
    next.charges_cents += Number(object.amount || 0);
  }
  if (event?.type === 'charge.refunded' && (object.currency || 'usd') === 'usd') {
    const id = String(object.id || '');
    const total = Number(object.amount_refunded || 0);
    const before = Number(next.refunded_by_charge[id] || 0);
    if (total > before) {
      next.refunds_cents += total - before;
      next.refunded_by_charge[id] = total;
    }
  }
  next.net_cents = next.charges_cents - next.refunds_cents;
  next.connected = true;
  return next;
}

// Applies one verified event to the Durable Object's Office money state,
// resetting at the UTC day boundary and ignoring replays by event id.
export function recordStripeEvent(data, event, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const current = data.office_stripe && data.office_stripe.date === date
    ? data.office_stripe
    : { date, charges_cents: 0, refunds_cents: 0, net_cents: 0, event_ids: [], refunded_by_charge: {} };
  const id = String(event?.id || '');
  if (id && current.event_ids.includes(id)) return { duplicate: true, today: current };
  const next = applyStripeEvent(current, event);
  data.office_stripe = {
    date,
    charges_cents: next.charges_cents,
    refunds_cents: next.refunds_cents,
    net_cents: next.net_cents,
    refunded_by_charge: next.refunded_by_charge,
    event_ids: id ? [...current.event_ids, id].slice(-500) : current.event_ids,
    updated_at: now.toISOString(),
  };
  return { duplicate: false, today: data.office_stripe };
}
