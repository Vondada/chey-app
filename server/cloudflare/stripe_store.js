// CHE Studio store: Stripe products, payment links and sales, owner-approved.
//
// Safety model:
// - Uses STRIPE_SECRET_KEY (ideally a restricted key: Products/Prices/Payment
//   Links write, Charges/Balance/Checkout read). The key never leaves the Worker.
// - Nothing is created in Stripe until the owner approves a proposal in the app.
// - There is no refund, transfer, payout or spend code here at all.
// - Every created item returns Stripe's own IDs and URL as a receipt; nothing
//   is reported as done unless Stripe confirmed it.

const STRIPE_API = 'https://api.stripe.com/v1';
const MAX_PROPOSALS = 100;
const MIN_CENTS = 50; // Stripe's USD minimum charge
const MAX_CENTS = 99_999_900;

// Hard allow-list. CHE may create products/prices/payment links and read
// charges/balance/checkout — never refund, transfer, payout, or create charges.
const STRIPE_ALLOWED = {
  GET: new Set(['/charges', '/balance', '/checkout/sessions', '/products', '/prices', '/payment_links']),
  POST: new Set(['/products', '/prices', '/payment_links']),
};

export function assertStripeCallAllowed(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').split('?')[0];
  const allowed = STRIPE_ALLOWED[m];
  if (!allowed || !allowed.has(p)) {
    const error = new Error(`CHE Stripe path blocked: ${m} ${p}. Refunds, transfers, payouts and direct charges are not allowed.`);
    error.status = 403;
    throw error;
  }
}

function now() {
  return new Date().toISOString();
}

export function stripeMode(env) {
  const key = String(env.STRIPE_SECRET_KEY || '');
  if (!key) return 'not_connected';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  return 'unknown';
}

// Stripe expects form encoding with bracketed nested keys.
export function formEncode(params, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item && typeof item === 'object') parts.push(formEncode(item, `${name}[${i}]`));
        else parts.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === 'object') {
      parts.push(formEncode(value, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

export async function stripe(env, method, path, params, fetcher, idempotencyKey) {
  assertStripeCallAllowed(method, path);
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Stripe-Version': String(env.CHE_STRIPE_API_VERSION || '2024-06-20'),
  };
  let url = `${STRIPE_API}${path}`;
  let body;
  if (method === 'GET') {
    const query = formEncode(params);
    if (query) url += `?${query}`;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    body = formEncode(params);
  }
  const response = await fetcher(url, { method, headers, body });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(String(data?.error?.message || `Stripe returned ${response.status}.`).slice(0, 300));
    error.status = response.status;
    throw error;
  }
  return data;
}

export function validateProposal(body) {
  const name = String(body?.name || '').trim().slice(0, 120);
  const description = String(body?.description || '').trim().slice(0, 500);
  const kind = ['digital_product', 'class'].includes(body?.kind) ? body.kind : 'digital_product';
  const dollars = Number(body?.price_usd);
  if (name.length < 2) return { error: 'Give the product a name.' };
  if (!Number.isFinite(dollars)) return { error: 'Set a price in US dollars.' };
  const cents = Math.round(dollars * 100);
  if (cents < MIN_CENTS) return { error: 'Stripe needs a price of at least $0.50.' };
  if (cents > MAX_CENTS) return { error: 'That price is too high for one product.' };
  const proposedBy = String(body?.proposed_by || 'owner').trim().slice(0, 60) || 'owner';
  return { proposal: { name, description, kind, unit_amount: cents, currency: 'usd', proposed_by: proposedBy } };
}

function list(data) {
  data.stripe_proposals = Array.isArray(data.stripe_proposals) ? data.stripe_proposals : [];
  return data.stripe_proposals;
}

export function storeStatus(env, data) {
  const proposals = list(data);
  return {
    mode: stripeMode(env),
    connected: stripeMode(env) !== 'not_connected',
    pending: proposals.filter((p) => p.status === 'pending').length,
    live_products: proposals.filter((p) => p.status === 'approved').length,
    rules: [
      'Nothing is created in Stripe until you approve it.',
      'CHE cannot issue refunds, move money or spend.',
      'Sales and balances come straight from Stripe.',
    ],
  };
}

export function proposeProduct(data, body) {
  const checked = validateProposal(body);
  if (checked.error) return { status: 400, detail: checked.error };
  const at = now();
  const proposal = { id: crypto.randomUUID(), status: 'pending', ...checked.proposal, created_at: at, updated_at: at };
  const proposals = list(data);
  proposals.unshift(proposal);
  data.stripe_proposals = proposals.slice(0, MAX_PROPOSALS);
  return { status: 200, proposal };
}

export function rejectProposal(data, id) {
  const proposal = list(data).find((p) => p.id === id);
  if (!proposal) return { status: 404, detail: 'Proposal not found.' };
  if (proposal.status !== 'pending') return { status: 409, detail: `This proposal is already ${proposal.status}.` };
  proposal.status = 'rejected';
  proposal.updated_at = now();
  return { status: 200, proposal };
}

// Owner approval: create the Stripe product with its price, then a payment
// link. Idempotency keys make a retried approval reuse the same Stripe objects.
// `confirmed: true` is required so a bare POST cannot spend/create money objects.
export async function approveProposal(env, data, id, fetcher = fetch, { confirmed = false } = {}) {
  if (stripeMode(env) === 'not_connected') {
    return { status: 503, detail: 'Stripe is not connected. Add STRIPE_SECRET_KEY to the CHE Worker.' };
  }
  const proposal = list(data).find((p) => p.id === id);
  if (!proposal) return { status: 404, detail: 'Proposal not found.' };
  if (proposal.status === 'approved') return { status: 200, proposal };
  if (proposal.status !== 'pending') return { status: 409, detail: `This proposal is ${proposal.status}.` };
  if (confirmed !== true) {
    return { status: 400, detail: 'Confirm in the app before CHE creates anything in Stripe.' };
  }
  try {
    const product = await stripe(env, 'POST', '/products', {
      name: proposal.name,
      description: proposal.description || undefined,
      default_price_data: { currency: proposal.currency, unit_amount: proposal.unit_amount },
      metadata: { che_proposal_id: proposal.id, che_kind: proposal.kind },
    }, fetcher, `che-product-${proposal.id}`);
    const priceId = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
    if (!priceId) throw new Error('Stripe did not return a price for the product.');
    const link = await stripe(env, 'POST', '/payment_links', {
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { che_proposal_id: proposal.id },
    }, fetcher, `che-link-${proposal.id}`);
    if (!String(link?.url || '').startsWith('https://')) throw new Error('Stripe did not return a payment link.');
    proposal.status = 'approved';
    proposal.mode = stripeMode(env);
    proposal.receipt = { product_id: product.id, price_id: priceId, payment_link_id: link.id, payment_link_url: link.url };
    proposal.error = '';
    proposal.updated_at = now();
    return { status: 200, proposal };
  } catch (error) {
    proposal.error = String(error?.message || 'Stripe request failed.').slice(0, 300);
    proposal.updated_at = now();
    return { status: 502, detail: `Stripe did not create it: ${proposal.error}` };
  }
}

// Real numbers only: recent successful charges and the current balance.
export async function salesSummary(env, fetcher = fetch) {
  if (stripeMode(env) === 'not_connected') {
    return { status: 503, detail: 'Stripe is not connected. Add STRIPE_SECRET_KEY to the CHE Worker.' };
  }
  try {
    const [charges, balance] = await Promise.all([
      stripe(env, 'GET', '/charges', { limit: 25 }, fetcher),
      stripe(env, 'GET', '/balance', {}, fetcher),
    ]);
    const sales = (Array.isArray(charges?.data) ? charges.data : [])
      .filter((c) => c.paid && c.status === 'succeeded')
      .map((c) => ({
        id: c.id,
        amount: c.amount,
        amount_refunded: c.amount_refunded || 0,
        currency: c.currency,
        description: String(c.description || '').slice(0, 160),
        created_at: new Date(Number(c.created) * 1000).toISOString(),
      }));
    const sum = (rows) => (Array.isArray(rows) ? rows : [])
      .filter((r) => r.currency === 'usd')
      .reduce((total, r) => total + Number(r.amount || 0), 0);
    return {
      status: 200,
      mode: stripeMode(env),
      source: 'Stripe',
      sales,
      recent_total_cents: sales.reduce((t, s) => t + s.amount - s.amount_refunded, 0),
      balance: { available_cents: sum(balance?.available), pending_cents: sum(balance?.pending), currency: 'usd' },
      as_of: now(),
    };
  } catch (error) {
    return { status: 502, detail: `Could not read Stripe: ${String(error?.message || 'request failed').slice(0, 300)}` };
  }
}
