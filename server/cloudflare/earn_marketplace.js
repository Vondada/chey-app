// CHE Earn marketplace adapters (owner, 2026-10-25). One interface over every marketplace, official APIs only.
//
// Adapter interface (every method returns { ok, ... } and never throws):
//   searchWorkers(q, ctx)  getWorker(id, ctx)  getReviews(id, ctx)       read-only
//   searchBounties(q, ctx) getBounty(id, ctx)                             read-only
//   verifyKey(key, ctx)                                                   one authenticated read
//   draftBounty(input)                                                    local draft, no network
//   binding(action)                                                       describes a paid/binding step; never executes
//
// RentAHuman endpoints used are exactly the ones its vendor-published client (npm rentahuman-mcp 4.1.0, 2026-10-22)
// calls against https://rentahuman.ai/api with the X-API-Key header: GET /humans, GET /humans/{id},
// GET /reviews?humanId=, GET /bounties, GET /bounties/{id}, GET /keys (account check). Nothing else is called: posting
// bounties, hiring, funding escrow, releasing payment, applying and submitting evidence are not automated here; the
// owner does them on rentahuman.ai after CHE's approval gate (earn_hub.js). See docs/CHE_EARN.md.
//
// The key is read from ctx.env.RENTAHUMAN_API_KEY (Worker secret, or the owner's key in CHE's Durable Object key
// store merged into the runtime env). It is sent only to rentahuman.ai and never appears in a result.

export const RENTAHUMAN_API = 'https://rentahuman.ai/api';
export const RENTAHUMAN_KEY_ENV = 'RENTAHUMAN_API_KEY';

// Paid or binding steps. `phrase` is how the step reads to CHE's owner action gate (owner_action_gate.js), so every
// paid one is classified as money there; `paid` steps also need the spending cap.
export const BINDING = Object.freeze({
  post_paid_bounty: { paid: true, title: 'Post a paid bounty', phrase: (amt) => `pay ${amt} to post a paid bounty and fund it`, where: 'rentahuman.ai → Post a bounty' },
  hire: { paid: true, title: 'Hire a worker', phrase: (amt) => `pay ${amt} to hire this worker`, where: 'rentahuman.ai → the worker\'s application → Accept' },
  fund_escrow: { paid: true, title: 'Fund escrow', phrase: (amt) => `pay ${amt} into escrow`, where: 'rentahuman.ai → the bounty → Fund' },
  release_payment: { paid: true, title: 'Release payment', phrase: (amt) => `pay ${amt} by releasing the escrow payment`, where: 'rentahuman.ai → the job → Release payment' },
  apply: { paid: false, title: 'Submit an application', phrase: () => 'submit the application in my name', where: 'rentahuman.ai → the bounty → Apply' },
  submit_evidence: { paid: false, title: 'Submit work evidence', phrase: () => 'submit the work evidence in my name', where: 'rentahuman.ai → your accepted job → Submit' },
  send_invoice: { paid: false, title: 'Send the client invoice', phrase: () => 'send the invoice to the client', where: 'Stripe (CHE finalizes only after your yes)' },
});

const clip = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (v, n = 12, each = 80) => (Array.isArray(v) ? v : []).map((x) => clip(x, each)).filter(Boolean).slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const SAFE_ID = /^[\w.-]{1,80}$/;

/** Only these GET paths are ever requested from RentAHuman. */
export function rentahumanPathAllowed(path) {
  const p = String(path || '').split('?')[0];
  return p === '/humans' || p === '/bounties' || p === '/reviews' || p === '/keys'
    || /^\/humans\/[\w.-]{1,80}$/.test(p) || /^\/bounties\/[\w.-]{1,80}$/.test(p);
}

async function rahGet(ctx, path, { auth = true } = {}) {
  if (!rentahumanPathAllowed(path)) return { ok: false, http: 0, error: 'blocked_path' };
  const key = auth ? String(ctx?.env?.[RENTAHUMAN_KEY_ENV] || ctx?.key || '').trim() : '';
  const fetcher = ctx?.fetcher || fetch;
  try {
    const r = await fetcher(`${RENTAHUMAN_API}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
      signal: AbortSignal.timeout(12_000),
    });
    const body = await r.json().catch(() => null);
    const retry = num(r.headers?.get?.('retry-after'));
    if (!r.ok) return { ok: false, http: r.status, keyed: Boolean(key), retry_after_s: retry, error: r.status === 401 || r.status === 403 ? 'needs_key' : r.status === 429 ? 'rate_limited' : 'provider_error', detail: clip(body?.error || body?.message || '', 200) };
    return { ok: true, http: r.status, keyed: Boolean(key), body };
  } catch (error) {
    return { ok: false, http: 0, keyed: Boolean(key), error: 'network', detail: clip(error?.message || error, 120) };
  }
}

const provenance = (endpoint, keyed, now) => ({ provider: 'rentahuman', endpoint: `GET ${RENTAHUMAN_API}${endpoint.split('?')[0]}`, keyed, fetched_at: new Date(now || Date.now()).toISOString() });

/** RentAHuman public profile → contact-style card. Emails and other contact details are never surfaced. */
export function normalizeHuman(h, prov) {
  return {
    id: clip(h?.id, 80),
    name: clip(h?.name, 80),
    headline: clip(h?.headline, 160),
    bio: clip(h?.bio, 400),
    skills: list(h?.skills),
    hourly_rate: num(h?.hourlyRate),
    currency: clip(h?.currency || 'USD', 8),
    location: { city: clip(h?.location?.city, 60), state: clip(h?.location?.state, 40), country: clip(h?.location?.country, 40) },
    remote: h?.location?.isRemoteAvailable === true,
    rating: num(h?.rating),
    review_count: num(h?.reviewCount) || 0,
    total_bookings: num(h?.totalBookings) || 0,
    verified: h?.isVerified === true,
    available: h?.isAvailable !== false,
    timezone: clip(h?.timezone, 40),
    provenance: prov,
  };
}

/** RentAHuman bounty → provider-independent opportunity. */
export function normalizeBounty(b, prov) {
  const spots = num(b?.spotsRemaining) ?? (num(b?.spotsAvailable) !== null && num(b?.spotsFilled) !== null ? Math.max(0, b.spotsAvailable - b.spotsFilled) : null);
  return {
    provider: 'rentahuman',
    provider_ref: clip(b?.id, 80),
    title: clip(b?.title, 160),
    description: clip(b?.description, 1500),
    requirements: list(b?.requirements, 12, 200),
    skills: list(b?.skillsNeeded),
    category: clip(b?.category, 60),
    remote: b?.location?.isRemoteAllowed === true ? true : b?.location?.isRemoteAllowed === false ? false : null,
    location: { city: clip(b?.location?.city, 60), country: clip(b?.location?.country, 40) },
    pay: { amount: num(b?.price) || 0, type: b?.priceType === 'hourly' ? 'hourly' : 'fixed', currency: clip(b?.currency || 'USD', 8), est_hours: num(b?.estimatedHours) },
    deadline: clip(b?.deadline, 40) || null,
    spots_remaining: spots,
    status: clip(b?.status || 'open', 30),
    identity_required: b?.identityRequired === true,
    linkedin_required: b?.linkedinVerifiedRequired === true,
    mic_check: b?.micCheckRequired === true,
    live_capture: Boolean(b?.liveCaptureRequirement),
    poster: clip(b?.agentName, 80),
    applications: num(b?.applicationCount),
    provenance: prov,
  };
}

const qs = (pairs) => {
  const p = new URLSearchParams();
  for (const [k, v] of pairs) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const rentahuman = Object.freeze({
  id: 'rentahuman',
  name: 'RentAHuman',
  docs: 'https://rentahuman.ai/docs',
  key_page: 'https://rentahuman.ai/account/api-keys',
  async searchWorkers(q = {}, ctx = {}) {
    const keyed = Boolean(String(ctx?.env?.[RENTAHUMAN_KEY_ENV] || '').trim());
    // Without a key the vendor's client says limit must be 24 or less (larger values are rejected) and paging stops early.
    const limit = Math.max(1, Math.min(keyed ? 100 : 24, Number(q.limit) || 24));
    const path = `/humans${qs([['skill', clip(q.skill, 80)], ['minRate', num(q.min_rate)], ['maxRate', num(q.max_rate)], ['city', clip(q.city, 60)], ['country', clip(q.country, 40)], ['name', clip(q.name, 60)], ['limit', limit], ['cursor', clip(q.cursor, 200)]])}`;
    const r = await rahGet(ctx, path);
    if (!r.ok) return r;
    const prov = provenance(path, r.keyed, ctx.now);
    const raw = Array.isArray(r.body?.humans) ? r.body.humans : [];
    return { ok: true, workers: raw.map((h) => normalizeHuman(h, prov)).filter((w) => w.id), next_cursor: clip(r.body?.nextCursor, 200) || null, has_more: r.body?.hasMore === true, provenance: prov };
  },
  async getWorker(id, ctx = {}) {
    if (!SAFE_ID.test(String(id || ''))) return { ok: false, error: 'bad_id' };
    const path = `/humans/${id}`;
    const r = await rahGet(ctx, path);
    if (!r.ok) return r;
    const h = r.body?.human || r.body;
    return { ok: true, worker: normalizeHuman(h, provenance(path, r.keyed, ctx.now)) };
  },
  async getReviews(id, ctx = {}) {
    if (!SAFE_ID.test(String(id || ''))) return { ok: false, error: 'bad_id' };
    const path = `/reviews${qs([['humanId', id], ['limit', 10]])}`;
    const r = await rahGet(ctx, path);
    if (!r.ok) return r;
    const reviews = (Array.isArray(r.body?.reviews) ? r.body.reviews : []).map((v) => ({ rating: num(v?.rating), comment: clip(v?.comment, 300), at: clip(v?.createdAt, 40) }));
    return { ok: true, reviews, provenance: provenance(path, r.keyed, ctx.now) };
  },
  async searchBounties(q = {}, ctx = {}) {
    // GET /bounties takes limit 1-100 (default 20) and has no documented cursor, so one page is all CHE reads.
    const path = `/bounties${qs([['status', 'open'], ['category', clip(q.category, 60)], ['skill', clip(q.skill, 80)], ['minPrice', num(q.min_price)], ['maxPrice', num(q.max_price)], ['limit', Math.max(1, Math.min(100, Number(q.limit) || 20))], ['includePartiallyFilled', 'true']])}`;
    const r = await rahGet(ctx, path);
    if (!r.ok) return r;
    const prov = provenance(path, r.keyed, ctx.now);
    const raw = Array.isArray(r.body?.bounties) ? r.body.bounties : [];
    return { ok: true, opportunities: raw.map((b) => normalizeBounty(b, prov)).filter((o) => o.provider_ref), provenance: prov };
  },
  async getBounty(id, ctx = {}) {
    if (!SAFE_ID.test(String(id || ''))) return { ok: false, error: 'bad_id' };
    const path = `/bounties/${id}`;
    const r = await rahGet(ctx, path);
    if (!r.ok) return r;
    return { ok: true, opportunity: normalizeBounty(r.body?.bounty || r.body, provenance(path, r.keyed, ctx.now)) };
  },
  /** One authenticated read (the vendor client's own account check). Connected only on HTTP 2xx. */
  async verifyKey(key, ctx = {}) {
    const r = await rahGet({ ...ctx, env: {}, key }, '/keys');
    return { ok: r.ok, http: r.http, error: r.ok ? '' : r.error };
  },
  draftBounty(input = {}) {
    const price = Math.max(0, Number(input.price) || 0);
    return {
      provider: 'rentahuman',
      title: clip(input.title, 120),
      description: clip(input.description, 2000),
      requirements: list(input.requirements, 10, 200),
      skills: list(input.skills),
      price,
      price_type: input.price_type === 'hourly' ? 'hourly' : 'fixed',
      remote: input.remote !== false,
      location: { city: clip(input.city, 60), country: clip(input.country, 40) },
      deadline: clip(input.deadline, 40) || null,
      posted: false,
      note: 'Draft only. Nothing is posted, funded or paid until you approve and post it yourself on rentahuman.ai.',
    };
  },
  binding(action) { return BINDING[action] || null; },
});

// CHE's own future marketplace: the same interface, nothing behind it yet. Every call says so.
const notBuilt = async () => ({ ok: false, error: 'not_built', detail: 'CHE\'s own marketplace is not built yet.' });
export const cheNative = Object.freeze({
  id: 'che_native', name: 'CHE marketplace (not built)', docs: '', key_page: '',
  searchWorkers: notBuilt, getWorker: notBuilt, getReviews: notBuilt, searchBounties: notBuilt, getBounty: notBuilt, verifyKey: notBuilt,
  draftBounty: (input = {}) => ({ provider: 'che_native', title: clip(input.title, 120), posted: false, note: 'CHE\'s own marketplace is not built yet.' }),
  binding(action) { return BINDING[action] || null; },
});

export const ADAPTERS = Object.freeze({ rentahuman, che_native: cheNative });
export function adapterFor(id) { return ADAPTERS[String(id || 'rentahuman')] || null; }
