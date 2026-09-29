async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyStripeSignature(rawBody, header, secret) {
  if (!secret) throw new Error('stripe_webhook_secret_missing');
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  const expected = await hmacHex(secret, `${parts.t}.${rawBody}`);
  if (!parts.v1 || parts.v1 !== expected) throw new Error('stripe_signature_invalid');
}

export function applyStripeEvent(today, event) {
  const next = {
    charges_cents: Number(today?.charges_cents || 0),
    refunds_cents: Number(today?.refunds_cents || 0),
  };
  const amount = Number(event?.data?.object?.amount || event?.data?.object?.amount_received || 0);
  if (event?.type === 'charge.succeeded' || event?.type === 'payment_intent.succeeded') {
    next.charges_cents += amount;
  }
  if (event?.type === 'charge.refunded' || event?.type === 'refund.created') {
    next.refunds_cents += Number(event?.data?.object?.amount_refunded || event?.data?.object?.amount || 0);
  }
  next.net_cents = next.charges_cents - next.refunds_cents;
  next.connected = true;
  return next;
}
