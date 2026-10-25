// CHE Earn hub (owner, 2026-10-25): Human Workforce, Opportunity Hunter and CHE Earn as one feature in the Business Hub.
//
// No second job store: every tracked opportunity, human hire and contract is a record in data.team_tasks (the Office
// task list) with kind 'earn', worker_kind 'human' | 'ai', provider and provider_ref. Search results are not stored.
// Earn statuses all start with 'earn_', so the Office agent runtime (which runs 'queued' tasks) never picks them up.
//
// Money rules enforced here, in code:
// - Supervised mode only. The authorized spending cap starts at $0. A paid or binding step (post a paid bounty, hire,
//   fund escrow, release payment, apply, submit evidence, send an invoice) needs a stored owner approval for that
//   exact step and amount (the owner's own words + time, from his paired device), passes owner_action_gate.js, and a
//   paid step is refused outright while the cap is $0 or below the amount. A model or agent saying "approved" is not an
//   approval: approvals are written only by POST /api/earn/approve from the owner's device.
// - Even when approved, CHE does not post, hire, pay, apply or submit on RentAHuman (not automated; owner does it on the
//   site). Marketplace payouts stay inside the marketplace; Stripe invoices are for direct clients only, TEST mode only.
// - "Earned" only from a verified payment record (Stripe invoice status 'paid' read back from Stripe). Test-mode
//   payments are shown as test, never as real money.
// - The RentAHuman key is stored in CHE's Durable Object key store after one verified authenticated read; replies
//   carry only a fingerprint.

import { BINDING, RENTAHUMAN_KEY_ENV, adapterFor } from './earn_marketplace.js';
import { CLASS_LABEL, evaluateOpportunity, groupOpportunities, money, rankOpportunities, rankWorkers, recommendRate } from './earn_evaluator.js';
import { classifyOwnerActions, gateOwnerAction, grantForKinds } from './owner_action_gate.js';
import { setStoredKeys, storedKeys, withStoredKeys } from './resilience.js';
import { checkHtml, saveSite, writeSite } from './site_builder.js';
import { sha256Hex } from './che_media_store.js';
import { formEncode, stripeMode } from './stripe_store.js';
import { redactSecrets } from './privacy_policy.js';

export const DEFAULT_SETTINGS = Object.freeze({ spend_cap_cents: 0, mode: 'supervised', max_active: 3 });
export const MAX_CAP_CENTS = 50_000;
export const CONNECTION_KEY = 'earn_connection';
const ACTIVE = new Set(['earn_in_progress', 'earn_delivery_prepared', 'earn_invoice_draft', 'earn_awaiting_payment']);
export const STATUS_LABEL = Object.freeze({
  earn_tracked: 'Tracked', earn_draft: 'Draft (not posted)', earn_awaiting_approval: 'Waiting for your approval',
  earn_in_progress: 'In progress', earn_delivery_prepared: 'Delivery prepared (not sent)', earn_invoice_draft: 'Invoice drafted (not sent)',
  earn_awaiting_payment: 'Invoice sent, waiting for payment', earn_paid: 'Paid (verified)', earn_closed: 'Closed',
});
const APPROVABLE = new Set(['start_work', ...Object.keys(BINDING)]);
const YES = /\b(?:yes|yeah|yep|approve[ds]?|go\s+ahead|confirm(?:ed)?|do\s+it|okay|ok)\b/i;
const NO = /\b(?:no|not|don['’]?t|do\s+not|never|cancel|stop|wait|hold\s+on)\b/i;
const RAH_KEY = /\brah_[A-Za-z0-9_-]{6,}/g;

const clip = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const nowIso = (ctx) => new Date(ctx?.now || Date.now()).toISOString();
/** Every outward string goes through both guards. */
export const scrub = (v) => redactSecrets(String(v ?? '')).replace(RAH_KEY, '[redacted]');
const reply = (body, status = 200) => new Response(scrub(JSON.stringify(body)), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export function earnSettings(data) {
  const s = data.earn_settings && typeof data.earn_settings === 'object' ? data.earn_settings : {};
  data.earn_settings = { ...DEFAULT_SETTINGS, ...s, mode: 'supervised' };
  return data.earn_settings;
}
const tasks = (data) => (data.team_tasks = Array.isArray(data.team_tasks) ? data.team_tasks : []);
export const earnRecords = (data) => tasks(data).filter((t) => t?.kind === 'earn');
const findRecord = (data, id) => earnRecords(data).find((t) => t.id === String(id || ''));
export const activeCount = (data) => earnRecords(data).filter((t) => ACTIVE.has(t.status) && t.worker_kind === 'ai').length;
const log = (rec, ctx, what) => { rec.earn.log = [...(rec.earn.log || []), { at: nowIso(ctx), what: clip(what, 300) }].slice(-40); rec.updated_at = nowIso(ctx); };

function newRecord(data, ctx, { side, worker_kind, provider, provider_ref, title, partner_name, status, earn }) {
  const at = nowIso(ctx);
  const rec = {
    id: `earn_${crypto.randomUUID()}`,
    kind: 'earn', side, worker_kind, provider, provider_ref: clip(provider_ref, 80),
    task: clip(title, 160), title: clip(title, 160), partner_name: clip(partner_name, 80),
    status, created_at: at, updated_at: at,
    earn: { approvals: [], requests: [], log: [], ...earn },
  };
  tasks(data).unshift(rec);
  return rec;
}

/** Tracks one opportunity (from a provider read or a direct client the owner entered). */
export function trackOpportunity(data, opportunity, ctx = {}) {
  const evaluation = evaluateOpportunity(opportunity, { now: ctx.now || Date.now(), capacity: { active: activeCount(data), max: earnSettings(data).max_active } });
  const existing = earnRecords(data).find((r) => r.side === 'earn' && r.provider === opportunity.provider && r.provider_ref && r.provider_ref === opportunity.provider_ref);
  if (existing) { existing.earn.evaluation = evaluation; log(existing, ctx, 'Re-evaluated.'); return existing; }
  const human = evaluation.classification === 'human_required';
  const rec = newRecord(data, ctx, {
    side: 'earn', worker_kind: human ? 'human' : 'ai', provider: opportunity.provider || 'direct', provider_ref: opportunity.provider_ref || '',
    title: opportunity.title, partner_name: human ? 'You (owner)' : 'CHE', status: 'earn_tracked',
    earn: { opportunity, evaluation, client: opportunity.client || null },
  });
  log(rec, ctx, `Tracked: ${evaluation.label}, score ${evaluation.score}.`);
  return rec;
}

/** An honest application draft. The owner fills in his own qualifications and submits it himself. */
export function draftApplication(rec) {
  const o = rec.earn.opportunity || {};
  const e = rec.earn.evaluation || {};
  const lines = [
    `Hello${o.poster ? ` ${o.poster}` : ''},`,
    `I would like to take on "${o.title}".`,
    e.classification === 'human_required'
      ? 'I will do this work myself. [Add your own relevant experience here; only list what is true.]'
      : 'I will deliver this as a digital file. I use AI tools (my assistant CHE) to help prepare the work, and I review and stand behind everything I submit. [Add your own relevant experience here; only list what is true.]',
    o.deadline ? `I can deliver before the deadline (${o.deadline.slice(0, 10)}).` : 'Tell me your preferred delivery date.',
    'Thank you.',
  ];
  return { text: lines.join('\n'), prepared_by: 'CHE', submitted: false, note: 'You submit this yourself on the marketplace. CHE never claims qualifications, attendance or reviews.' };
}

const approvalFor = (rec, action, amount) => (rec.earn.approvals || []).find((a) => a.action === action && (!BINDING[action]?.paid || Number(a.amount_cents) === Number(amount)) && !a.used_at);

/** Records the owner's approval. Only the owner's own device may call this, with his own words. */
export function recordApproval(data, { id, action, words, amount_cents = 0 }, ctx = {}) {
  if (!ctx.owner) return { ok: false, status: 403, detail: 'Only the CHE owner can approve.' };
  const rec = findRecord(data, id);
  if (!rec) return { ok: false, status: 404, detail: 'No such CHE Earn record.' };
  if (!APPROVABLE.has(action)) return { ok: false, status: 400, detail: 'Unknown step.' };
  const said = clip(words, 300);
  if (!said || !YES.test(said) || NO.test(said)) return { ok: false, status: 400, detail: 'I need your own words saying yes to this step, for example "Yes, approve it."' };
  const amount = Math.max(0, Math.round(Number(amount_cents) || 0));
  if (BINDING[action]?.paid && amount <= 0) return { ok: false, status: 400, detail: 'A paid step needs its exact amount.' };
  const approval = { action, words: said, amount_cents: amount, at: nowIso(ctx), by: 'owner_device' };
  rec.earn.approvals = [...(rec.earn.approvals || []), approval].slice(-20);
  rec.earn.requests = (rec.earn.requests || []).filter((q) => q.action !== action);
  if (action === 'start_work' && rec.status === 'earn_awaiting_approval') rec.status = 'earn_tracked';
  log(rec, ctx, `Owner approved ${action}${amount ? ` for ${money(amount)}` : ''}: "${said}".`);
  return { ok: true, approval, spoken: `Recorded your approval to ${action === 'start_work' ? 'start the work' : BINDING[action].title.toLowerCase()}${amount ? ` for ${money(amount)}` : ''}.` };
}

/**
 * The decision for one paid or binding step. Pure: reads settings and stored approvals, writes nothing.
 * Returns { allowed, held, refused, reasons[], ask }.
 */
export function bindingDecision(data, rec, action, amount_cents = 0) {
  const b = BINDING[action];
  if (!b) return { allowed: false, refused: true, reasons: ['Unknown step.'] };
  const settings = earnSettings(data);
  const amount = Math.max(0, Math.round(Number(amount_cents) || 0));
  const reasons = [];
  const phrase = b.phrase(money(amount));
  const approval = approvalFor(rec, action, amount);
  const gate = gateOwnerAction(phrase, approval ? grantForKinds(classifyOwnerActions(phrase)) : {});
  if (b.paid) {
    if (amount <= 0) reasons.push('A paid step needs its exact amount.');
    if (settings.spend_cap_cents <= 0) reasons.push('Your authorized spending is $0, so CHE refuses every paid step.');
    else if (amount > settings.spend_cap_cents) reasons.push(`${money(amount)} is over your authorized cap of ${money(settings.spend_cap_cents)}.`);
  }
  if (action === 'apply' && activeCount(data) >= settings.max_active) reasons.push(`CHE already has ${activeCount(data)} active contracts (limit ${settings.max_active}).`);
  if (reasons.length) return { allowed: false, refused: true, held: false, reasons, ask: '' };
  if (!approval || !gate.allowed) return { allowed: false, refused: false, held: true, reasons: ['Needs your approval for this exact step.'], ask: gate.ask || `Before I ${phrase}, I need your yes.` };
  return { allowed: true, refused: false, held: false, reasons: [], ask: '' };
}

// ── Deliverable → verification → delivery → payment ─────────────────────────────────────────────────────────────────

const STOP = new Set(['with', 'that', 'this', 'from', 'your', 'have', 'will', 'must', 'should', 'page', 'need', 'needs', 'about', 'into', 'than', 'they', 'them', 'make', 'build', 'create', 'include']);
export function requirementTerms(o) {
  const words = [o?.title, ...(o?.requirements || [])].join(' ').toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 20);
}

/** Requirement, quality, originality and honesty checks on a finished deliverable. */
export async function verifyDeliverable(data, rec, html, problems = []) {
  const bytes = new TextEncoder().encode(String(html || ''));
  const sha256 = await sha256Hex(bytes);
  const text = String(html || '').replace(/<[^>]+>/g, ' ').toLowerCase();
  const terms = requirementTerms(rec.earn.opportunity);
  const found = terms.filter((t) => text.includes(t));
  const coverage = terms.length ? found.length / terms.length : 1;
  const others = earnRecords(data).filter((r) => r.id !== rec.id).map((r) => r.earn?.deliverable?.sha256).filter(Boolean);
  const checks = [
    { id: 'quality', pass: problems.length === 0, detail: problems.length ? problems.join(' ') : 'Page passed the site builder\'s checks.' },
    { id: 'requirements', pass: coverage >= 0.6, detail: `${found.length} of ${terms.length} requirement terms found.` },
    { id: 'originality', pass: !others.includes(sha256) && !/lorem ipsum/.test(text), detail: others.includes(sha256) ? 'Identical to another deliverable.' : 'Not a copy of another CHE Earn deliverable.' },
    { id: 'honest', pass: !/\b(?:100%\s+human|written\s+by\s+a\s+human|hand[-\s]?written|no\s+ai\s+(?:was\s+)?used)\b/.test(text), detail: 'Makes no false claim that no AI was used.' },
  ];
  return { sha256, bytes: bytes.length, checks, verified: bytes.length > 0 && checks.every((c) => c.pass) };
}

/** Runs the next workflow step for a tracked opportunity. Returns { ok, step, detail, spoken }. */
export async function advanceWork(data, rec, ctx = {}) {
  const e = rec.earn.evaluation || {};
  if (rec.side !== 'earn') return { ok: false, status: 400, detail: 'Only opportunities have work steps.' };
  if (!['che_can_complete', 'che_can_assist'].includes(e.classification)) return { ok: false, status: 409, detail: `CHE does not do this work: ${(e.reasons || []).join(' ')}` };
  if (!approvalFor(rec, 'start_work', 0)) {
    rec.status = 'earn_awaiting_approval';
    rec.earn.requests = [...(rec.earn.requests || []).filter((q) => q.action !== 'start_work'), { action: 'start_work', amount_cents: 0, at: nowIso(ctx) }];
    log(rec, ctx, 'Waiting for the owner to approve starting the work.');
    return { ok: true, step: 'approval', detail: 'Waiting for your approval to start.', spoken: `Before I start "${rec.title}", I need your yes. It costs nothing and nothing is submitted.` };
  }
  if (!rec.earn.deliverable?.verified) {
    if (!(e.skills || []).includes('web_page')) {
      return { ok: false, status: 409, step: 'deliverable', detail: `This kind of work (${(e.skills || []).join(', ') || 'unclassified'}) is not wired to an automatic engine yet. Start it from the Office or Creation Room and CHE will help.` };
    }
    if (activeCount(data) >= earnSettings(data).max_active && rec.status !== 'earn_in_progress') return { ok: false, status: 409, detail: 'CHE is at capacity; finish an active contract first.' };
    rec.status = 'earn_in_progress';
    const o = rec.earn.opportunity || {};
    const brief = clip(`${o.title}. ${o.description || ''} Requirements: ${(o.requirements || []).join('; ')}`, 3000);
    const written = await writeSite(ctx.aiEnv || ctx.env, { brief }, ctx.model).catch((error) => ({ html: '', problems: [clip(error?.message || error, 200)] }));
    if (!written.html) { log(rec, ctx, 'The engine returned no page.'); return { ok: false, status: 502, step: 'deliverable', detail: `The site engine did not return a page: ${(written.problems || []).join(' ')}` }; }
    const site = await saveSite(ctx.storage, { brief, html: written.html });
    const v = await verifyDeliverable(data, rec, written.html, checkHtml(written.html));
    rec.earn.deliverable = { kind: 'web_page', engine: 'site_builder.writeSite', site_id: site.id, title: site.title, published: false, draft_for_owner: e.classification === 'che_can_assist', ...v, at: nowIso(ctx) };
    log(rec, ctx, `Deliverable ${v.verified ? 'verified' : 'failed checks'}: sha256 ${v.sha256.slice(0, 12)}.`);
    const failed = v.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`);
    return { ok: v.verified, step: 'deliverable', detail: v.verified ? 'Deliverable made and verified.' : `Deliverable failed: ${failed.join(' ')}`, deliverable: rec.earn.deliverable,
      spoken: v.verified ? `The page for "${rec.title}" is made and passed all ${v.checks.length} checks. It is saved as an unpublished draft.` : `The page for "${rec.title}" failed ${failed.length} check${failed.length === 1 ? '' : 's'}: ${failed.join(' ')}` };
  }
  if (!rec.earn.delivery) {
    const d = rec.earn.deliverable;
    const client = rec.earn.client?.name || (rec.provider === 'rentahuman' ? 'the RentAHuman poster' : 'the client');
    rec.earn.delivery = {
      prepared_at: nowIso(ctx), to: clip(client, 80),
      channel: rec.provider === 'direct' ? 'email after your yes' : `${rec.provider} submission, which you make yourself`,
      message: `Hello ${client},\n\nThe work for "${rec.title}" is ready (file fingerprint sha256 ${d.sha256.slice(0, 16)}). It was prepared with AI assistance (my assistant CHE) and reviewed before delivery.\n\nThank you.`,
      artifact: { kind: d.kind, site_id: d.site_id, sha256: d.sha256 },
      sent: false,
    };
    rec.status = 'earn_delivery_prepared';
    log(rec, ctx, 'Client delivery prepared, not sent.');
    return { ok: true, step: 'delivery', detail: 'Delivery prepared. Nothing was sent.', spoken: `The delivery for "${rec.title}" is prepared and not sent.` };
  }
  return { ok: true, step: 'done', detail: 'All work steps are done. Payment is tracked separately.', spoken: `"${rec.title}" has no work steps left.` };
}

// Stripe: draft invoices for direct clients, TEST mode only. Narrow allow-list, separate from stripe_store's.
const STRIPE_API = 'https://api.stripe.com/v1';
export function earnStripeAllowed(method, path) {
  const p = String(path || '');
  if (method === 'POST') return ['/customers', '/invoices', '/invoiceitems'].includes(p) || /^\/invoices\/in_[\w]+\/send$/.test(p);
  if (method === 'GET') return /^\/invoices\/in_[\w]+$/.test(p);
  return false;
}
async function stripeCall(ctx, method, path, params, idem) {
  if (!earnStripeAllowed(method, path)) throw Object.assign(new Error(`Blocked Stripe call ${method} ${path}.`), { status: 403 });
  const headers = { Authorization: `Bearer ${ctx.env.STRIPE_SECRET_KEY}`, 'Stripe-Version': String(ctx.env.CHE_STRIPE_API_VERSION || '2024-06-20') };
  let body;
  if (method === 'POST') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; if (idem) headers['Idempotency-Key'] = idem; body = formEncode(params || {}); }
  const r = await (ctx.fetcher || fetch)(`${STRIPE_API}${path}`, { method, headers, body });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(clip(d?.error?.message || `Stripe returned ${r.status}.`, 200)), { status: r.status });
  return d;
}
function stripeReady(ctx) {
  const mode = stripeMode(ctx.env || {});
  if (mode === 'not_connected') return 'Stripe is not connected (STRIPE_SECRET_KEY).';
  if (mode !== 'test') return 'CHE Earn invoices run in Stripe TEST mode first. Live mode is not turned on.';
  return '';
}

export async function draftInvoice(data, rec, ctx = {}) {
  if (rec.provider !== 'direct') return { ok: false, status: 409, detail: `Marketplace work is paid through ${rec.provider}'s own payment system. CHE never bypasses it with a Stripe invoice.` };
  if (!rec.earn.delivery) return { ok: false, status: 409, detail: 'Prepare the delivery first.' };
  if (rec.earn.invoice) return { ok: true, invoice: rec.earn.invoice, detail: 'The invoice is already drafted.' };
  const why = stripeReady(ctx);
  if (why) return { ok: false, status: 503, detail: why };
  const amount = Number(rec.earn.evaluation?.expected_pay_cents) || 0;
  if (amount < 50) return { ok: false, status: 400, detail: 'The amount is below Stripe\'s minimum.' };
  const meta = { metadata: { che_earn_record: rec.id } };
  const client = rec.earn.client || {};
  const customer = await stripeCall(ctx, 'POST', '/customers', { name: clip(client.name || 'Client', 80), ...(client.email ? { email: clip(client.email, 120) } : {}), ...meta }, `che-earn-${rec.id}-customer`);
  const inv = await stripeCall(ctx, 'POST', '/invoices', { customer: customer.id, collection_method: 'send_invoice', days_until_due: 14, auto_advance: 'false', ...meta }, `che-earn-${rec.id}-invoice`);
  await stripeCall(ctx, 'POST', '/invoiceitems', { customer: customer.id, invoice: inv.id, amount, currency: 'usd', description: clip(rec.title, 200) }, `che-earn-${rec.id}-item`);
  rec.earn.invoice = { id: inv.id, status: inv.status || 'draft', livemode: inv.livemode === true, amount_cents: amount, sent: false, at: nowIso(ctx) };
  rec.status = 'earn_invoice_draft';
  log(rec, ctx, `Stripe ${rec.earn.invoice.livemode ? 'LIVE' : 'test'} invoice ${inv.id} drafted for ${money(amount)}; not sent.`);
  return { ok: true, invoice: rec.earn.invoice, spoken: `I drafted a Stripe test invoice for ${money(amount)}. It is not sent.` };
}

/** Reads the invoice back from Stripe. Earned only when Stripe says paid. */
export async function refreshPayment(data, rec, ctx = {}) {
  if (!rec.earn.invoice?.id) return { ok: false, status: 409, detail: 'No invoice to check.' };
  const why = stripeReady(ctx);
  if (why) return { ok: false, status: 503, detail: why };
  const inv = await stripeCall(ctx, 'GET', `/invoices/${rec.earn.invoice.id}`);
  rec.earn.invoice.status = clip(inv.status, 20);
  if (inv.status === 'paid' && Number(inv.amount_paid) > 0) {
    rec.earn.payment = { verified: true, source: 'stripe', invoice_id: inv.id, amount_cents: Number(inv.amount_paid), livemode: inv.livemode === true, paid_at: inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000).toISOString() : nowIso(ctx) };
    rec.status = 'earn_paid';
    log(rec, ctx, `Stripe confirms ${money(inv.amount_paid)} paid${inv.livemode ? '' : ' (test mode, not real money)'}.`);
  }
  return { ok: true, invoice: rec.earn.invoice, payment: rec.earn.payment || null };
}

/** Earnings from verified payment records only. */
export function verifiedEarnings(data) {
  const paid = earnRecords(data).filter((r) => r.earn?.payment?.verified === true && Number(r.earn.payment.amount_cents) > 0);
  const real = paid.filter((r) => r.earn.payment.livemode);
  const test = paid.filter((r) => !r.earn.payment.livemode);
  const sum = (l) => l.reduce((s, r) => s + Number(r.earn.payment.amount_cents), 0);
  const records = paid.map((r) => ({ id: r.id, title: r.title, amount_cents: r.earn.payment.amount_cents, source: r.earn.payment.source, invoice_id: r.earn.payment.invoice_id, livemode: r.earn.payment.livemode, paid_at: r.earn.payment.paid_at }));
  const text = real.length
    ? `Verified earnings: ${money(sum(real))} from ${real.length} paid record${real.length === 1 ? '' : 's'}.`
    : 'No verified earnings yet.';
  return { real_cents: sum(real), test_cents: sum(test), records, text: test.length ? `${text} Stripe test mode shows ${money(sum(test))} paid, which is not real money.` : text };
}

// ── Views ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const OPEN_AI = new Set(['queued', 'running', 'reviewing', 'review_pending', 'needs_review', 'assigned']);
/** Human jobs beside AI agent missions, each labelled. */
export function missionsView(data) {
  const earn = earnRecords(data).map((r) => ({
    id: r.id, title: r.title, status: r.status, status_label: STATUS_LABEL[r.status] || r.status, worker_kind: r.worker_kind,
    label: r.worker_kind === 'human' ? (r.side === 'hire' ? 'Human worker (RentAHuman)' : 'Human: you') : 'AI: CHE', who: r.partner_name, provider: r.provider,
  }));
  const ai = tasks(data).filter((t) => t?.kind !== 'earn' && OPEN_AI.has(t?.status)).slice(0, 20).map((t) => ({
    id: t.id, title: clip(t.task || t.title, 160), status: t.status, status_label: t.status, worker_kind: 'ai', label: 'AI agent mission', who: clip(t.partner_name || t.agent_name || 'Office agent', 60), provider: 'office',
  }));
  return [...earn, ...ai];
}

function recordView(r) {
  const e = r.earn || {};
  return {
    id: r.id, side: r.side, title: r.title, status: r.status, status_label: STATUS_LABEL[r.status] || r.status, worker_kind: r.worker_kind, provider: r.provider, provider_ref: r.provider_ref,
    classification: e.evaluation?.classification || '', class_label: e.evaluation ? CLASS_LABEL[e.evaluation.classification] : '', evaluation: e.evaluation || null,
    opportunity: e.opportunity || null, bounty_draft: e.bounty_draft || null, worker: e.worker || null, application: e.draft_application || null,
    deliverable: e.deliverable || null, delivery: e.delivery || null, invoice: e.invoice || null, payment: e.payment || null,
    approvals: e.approvals || [], requests: e.requests || [], log: (e.log || []).slice(-8),
  };
}

export function pendingApprovals(data) {
  const out = [];
  for (const r of earnRecords(data)) for (const q of r.earn.requests || []) {
    const b = BINDING[q.action];
    const amt = Number(q.amount_cents) || 0;
    out.push({ record_id: r.id, action: q.action, amount_cents: amt, title: r.title,
      speak: `Approve ${q.action === 'start_work' ? 'starting the work' : b.title.toLowerCase()} for "${r.title}"${amt ? `, ${money(amt)}` : ''}?${b?.paid ? ' This spends money.' : ''}` });
  }
  return out;
}

export async function connectionView(ctx) {
  const env = await keyedEnv(ctx);
  let saved = null;
  try { saved = (await ctx.storage?.get?.(CONNECTION_KEY)) ?? null; } catch (_) {}
  const present = Boolean(String(env[RENTAHUMAN_KEY_ENV] || '').trim());
  const status = present && saved?.verified_at ? 'connected' : present ? 'key_unverified' : 'not_connected';
  return { provider: 'rentahuman', status, fingerprint: present ? saved?.fingerprint || '' : '', last4: present ? saved?.last4 || '' : '', verified_at: present ? saved?.verified_at || '' : '',
    label: status === 'connected' ? 'RentAHuman connected (verified)' : status === 'key_unverified' ? 'RentAHuman key present, not verified yet' : 'RentAHuman not connected: public search only' };
}

export async function earnView(data, ctx = {}) {
  const settings = earnSettings(data);
  const recs = earnRecords(data);
  const earnings = verifiedEarnings(data);
  const approvals = pendingApprovals(data);
  const conn = await connectionView(ctx);
  const opps = recs.filter((r) => r.side === 'earn');
  const view = {
    settings, connection: conn, earnings, approvals, missions: missionsView(data),
    sections: {
      can_complete: opps.filter((r) => r.earn.evaluation?.classification === 'che_can_complete').map(recordView),
      can_help: opps.filter((r) => r.earn.evaluation?.classification === 'che_can_assist').map(recordView),
      human_required: opps.filter((r) => r.earn.evaluation?.classification === 'human_required').map(recordView),
      active_contracts: recs.filter((r) => ACTIVE.has(r.status)).map(recordView),
      deliverables: recs.filter((r) => r.earn.deliverable).map(recordView),
      applications: recs.filter((r) => r.earn.draft_application).map(recordView),
      human_workers: recs.filter((r) => r.side === 'hire').map(recordView),
    },
    stripe: { mode: stripeMode(ctx.env || {}), note: 'Direct-client invoices only, TEST mode first. Marketplace payouts stay inside each marketplace.' },
  };
  view.spoken = `CHE Earn. Authorized spending ${money(settings.spend_cap_cents)}, supervised mode. ${conn.label}. ${opps.length} tracked opportunit${opps.length === 1 ? 'y' : 'ies'}, ${view.sections.human_workers.length} human worker job${view.sections.human_workers.length === 1 ? '' : 's'}, ${approvals.length} approval${approvals.length === 1 ? '' : 's'} waiting. ${earnings.text}`;
  return view;
}

async function keyedEnv(ctx) {
  let keys = {};
  try { keys = await storedKeys(ctx.storage); } catch (_) {}
  return withStoredKeys(ctx.env || {}, keys);
}

async function fingerprintOf(key) {
  const hex = await sha256Hex(new TextEncoder().encode(String(key)));
  return { fingerprint: `sha256:${hex.slice(0, 12)}`, last4: String(key).slice(-4) };
}

/** Saves the RentAHuman key only after one authenticated read succeeds. */
export async function connectRentAHuman(ctx, body = {}) {
  const adapter = adapterFor('rentahuman');
  const key = body.verify ? String((await keyedEnv(ctx))[RENTAHUMAN_KEY_ENV] || '').trim() : String(body.key || '').trim();
  if (!/^rah_[A-Za-z0-9_-]{8,200}$/.test(key)) return { ok: false, status: 400, detail: body.verify ? 'No RentAHuman key is set.' : 'That does not look like a RentAHuman key (they start with rah_). Nothing was saved.' };
  const test = await adapter.verifyKey(key, ctx);
  if (!test.ok) return { ok: false, status: 400, detail: `RentAHuman did not accept that key (${test.error || test.http}). Nothing was saved.` };
  if (!body.verify) await setStoredKeys(ctx.storage, { [RENTAHUMAN_KEY_ENV]: key });
  const fp = await fingerprintOf(key);
  const saved = { provider: 'rentahuman', ...fp, verified_at: nowIso(ctx), check: 'GET /api/keys' };
  await ctx.storage.put(CONNECTION_KEY, saved);
  return { ok: true, connection: saved, spoken: `RentAHuman is connected. I checked the key with RentAHuman; key ending ${fp.last4}.` };
}

// ── Routes: /api/earn/* (owner only) ──────────────────────────────────────────────────────────────────────────────

/** ctx: { data, storage, env, aiEnv, model, owner, save, fetcher, now }. Returns a Response, or null for unknown paths. */
export async function earnRoute(ctx, path, method, body = {}, query = new URLSearchParams()) {
  if (!path.startsWith('/api/earn')) return null;
  if (!ctx.owner) return reply({ detail: 'Only the CHE owner can use CHE Earn.' }, 403);
  const { data } = ctx;
  const env = await keyedEnv(ctx);
  const actx = { ...ctx, env };
  const q = (k) => query.get(k) || '';
  const done = async (out, status = 200) => { await ctx.save?.(); return reply(out, status); };
  try {
    if (path === '/api/earn' && method === 'GET') return reply(await earnView(data, actx));
    if (path === '/api/earn/connect' && method === 'POST') { const out = await connectRentAHuman(actx, body || {}); return reply(out, out.ok ? 200 : out.status); }
    if (path === '/api/earn/workers' && method === 'GET') {
      const sq = { skill: q('skill'), city: q('city'), country: q('country'), max_rate: q('max_rate'), min_rate: q('min_rate'), cursor: q('cursor'), limit: q('limit') };
      const r = await adapterFor('rentahuman').searchWorkers(sq, actx);
      if (!r.ok) return reply({ ok: false, detail: providerDetail(r) }, 502);
      const ranked = rankWorkers(r.workers, sq);
      return reply({ ok: true, workers: ranked, rate: recommendRate(ranked), next_cursor: r.next_cursor, provenance: r.provenance, spending: 'Search only. Authorized spending is $0.' });
    }
    const workerMatch = /^\/api\/earn\/workers\/([\w.-]{1,80})$/.exec(path);
    if (workerMatch && method === 'GET') {
      const a = adapterFor('rentahuman');
      const [w, rv] = await Promise.all([a.getWorker(workerMatch[1], actx), a.getReviews(workerMatch[1], actx)]);
      if (!w.ok) return reply({ ok: false, detail: providerDetail(w) }, 502);
      return reply({ ok: true, worker: w.worker, reviews: rv.ok ? rv.reviews : [], reviews_note: rv.ok ? '' : providerDetail(rv) });
    }
    if (path === '/api/earn/opportunities' && method === 'GET') {
      const r = await adapterFor('rentahuman').searchBounties({ skill: q('skill'), category: q('category'), min_price: q('min_price'), max_price: q('max_price'), limit: q('limit') }, actx);
      if (!r.ok) return reply({ ok: false, detail: providerDetail(r) }, 502);
      const ranked = rankOpportunities(r.opportunities, { now: ctx.now || Date.now(), capacity: { active: activeCount(data), max: earnSettings(data).max_active } });
      return reply({ ok: true, groups: groupOpportunities(ranked), count: ranked.length, provenance: r.provenance });
    }
    if (path === '/api/earn/track' && method === 'POST') {
      let opp = null;
      if (body?.provider === 'direct') {
        const o = body.opportunity || {};
        opp = { provider: 'direct', provider_ref: '', title: clip(o.title, 160), description: clip(o.description, 1500), requirements: (o.requirements || []).map((x) => clip(x, 200)).slice(0, 12), skills: [], remote: o.remote !== false,
          pay: { amount: Number(o.amount) || 0, type: 'fixed', currency: 'USD', est_hours: Number(o.est_hours) || null }, deadline: clip(o.deadline, 40) || null, status: 'open',
          client: { name: clip(o.client_name, 80), email: clip(o.client_email, 120) }, provenance: { provider: 'direct', entered_by: 'owner', at: nowIso(ctx) } };
        if (!opp.title) return reply({ detail: 'A title is required.' }, 400);
      } else {
        const r = await adapterFor('rentahuman').getBounty(String(body?.provider_ref || ''), actx);
        if (!r.ok) return reply({ ok: false, detail: providerDetail(r) }, 502);
        opp = r.opportunity;
      }
      const rec = trackOpportunity(data, opp, ctx);
      return done({ ok: true, record: recordView(rec) });
    }
    if (path === '/api/earn/hire-draft' && method === 'POST') {
      const draft = adapterFor('rentahuman').draftBounty(body || {});
      if (!draft.title || !draft.description) return reply({ detail: 'A title and a description are required.' }, 400);
      const rec = newRecord(data, ctx, { side: 'hire', worker_kind: 'human', provider: 'rentahuman', provider_ref: '', title: draft.title, partner_name: clip(body?.worker_name, 80) || 'RentAHuman worker (not hired)', status: 'earn_draft',
        earn: { bounty_draft: draft, worker: body?.worker_id ? { id: clip(body.worker_id, 80), name: clip(body.worker_name, 80) } : null } });
      log(rec, ctx, 'Bounty drafted; nothing posted or paid.');
      return done({ ok: true, record: recordView(rec), spoken: `I drafted the job "${draft.title}" for ${money(Math.round(draft.price * 100))}. Nothing is posted or paid; your authorized spending is ${money(earnSettings(data).spend_cap_cents)}.` });
    }
    const rec = findRecord(data, body?.id || q('id'));
    if (path === '/api/earn/approve' && method === 'POST') { const out = recordApproval(data, body || {}, ctx); return out.ok ? done(out) : reply(out, out.status); }
    if (path === '/api/earn/settings' && method === 'POST') {
      const words = clip(body?.words, 300);
      if (!YES.test(words) || NO.test(words)) return reply({ detail: 'Changing CHE Earn settings needs your own words saying yes.' }, 400);
      if (body?.mode && body.mode !== 'supervised') return reply({ detail: 'Only supervised mode exists. Autonomous earning is not built.' }, 400);
      const s = earnSettings(data);
      if (body?.spend_cap_cents !== undefined) s.spend_cap_cents = Math.max(0, Math.min(MAX_CAP_CENTS, Math.round(Number(body.spend_cap_cents) || 0)));
      if (body?.max_active !== undefined) s.max_active = Math.max(1, Math.min(10, Math.round(Number(body.max_active) || 3)));
      s.changed = { at: nowIso(ctx), words };
      return done({ ok: true, settings: s, spoken: `CHE Earn settings saved: authorized spending ${money(s.spend_cap_cents)}, at most ${s.max_active} active contracts.` });
    }
    if (!rec) return reply({ detail: 'No such CHE Earn record.' }, 404);
    if (path === '/api/earn/draft-application' && method === 'POST') {
      if (rec.side !== 'earn') return reply({ detail: 'Applications are for opportunities.' }, 400);
      if (rec.earn.evaluation?.classification === 'not_eligible') return reply({ detail: `Not eligible: ${(rec.earn.evaluation.reasons || []).join(' ')}` }, 409);
      rec.earn.draft_application = draftApplication(rec);
      log(rec, ctx, 'Application drafted; not submitted.');
      return done({ ok: true, application: rec.earn.draft_application, spoken: 'I drafted the application. You submit it yourself on the marketplace.' });
    }
    if (path === '/api/earn/act' && method === 'POST') {
      const action = String(body?.action || '');
      const amount = Math.max(0, Math.round(Number(body?.amount_cents) || 0));
      const decision = bindingDecision(data, rec, action, amount);
      if (decision.held) {
        rec.earn.requests = [...(rec.earn.requests || []).filter((x) => x.action !== action), { action, amount_cents: amount, at: nowIso(ctx) }];
        rec.status = rec.status === 'earn_tracked' || rec.status === 'earn_draft' ? 'earn_awaiting_approval' : rec.status;
        log(rec, ctx, `${action} held for the owner's approval.`);
        return done({ ok: false, held: true, decision, spoken: decision.ask }, 202);
      }
      if (decision.refused) { log(rec, ctx, `${action} refused: ${decision.reasons.join(' ')}`); return done({ ok: false, refused: true, decision, spoken: decision.reasons.join(' ') }, 403); }
      const approval = approvalFor(rec, action, amount);
      approval.used_at = nowIso(ctx);
      if (action === 'send_invoice') {
        const why = stripeReady(actx);
        if (why || !rec.earn.invoice?.id) return reply({ ok: false, detail: why || 'No invoice to send.' }, 409);
        const inv = await stripeCall(actx, 'POST', `/invoices/${rec.earn.invoice.id}/send`, {}, `che-earn-${rec.id}-send`);
        Object.assign(rec.earn.invoice, { status: clip(inv.status, 20), sent: true, sent_at: nowIso(ctx) });
        rec.status = 'earn_awaiting_payment';
        log(rec, ctx, `Invoice ${inv.id} sent (Stripe status ${inv.status}).`);
        return done({ ok: true, executed: true, invoice: rec.earn.invoice, spoken: `Stripe sent the test invoice; its status is ${inv.status}.` });
      }
      const b = BINDING[action];
      log(rec, ctx, `${action} approved; owner completes it at ${b.where}.`);
      return done({ ok: true, executed: false, handoff: b.where, spoken: `Approved. CHE does not ${b.title.toLowerCase()} on RentAHuman for you; do it yourself at ${b.where}. Nothing was sent or paid by CHE.` });
    }
    if (path === '/api/earn/work' && method === 'POST') { const out = await advanceWork(data, rec, actx); return done(out, out.ok ? 200 : out.status || 409); }
    if (path === '/api/earn/invoice' && method === 'POST') { const out = await draftInvoice(data, rec, actx); return done(out, out.ok ? 200 : out.status || 409); }
    if (path === '/api/earn/payment' && method === 'POST') { const out = await refreshPayment(data, rec, actx); return done(out, out.ok ? 200 : out.status || 409); }
    return reply({ detail: 'Not found.' }, 404);
  } catch (error) {
    return reply({ ok: false, detail: clip(error?.message || error, 200) }, Number(error?.status) >= 400 && Number(error?.status) < 600 ? error.status : 500);
  }
}

export function providerDetail(r) {
  if (r.error === 'needs_key') return 'RentAHuman needs your API key for this. Say "connect RentAHuman" to hear how.';
  if (r.error === 'rate_limited') return `RentAHuman asked CHE to slow down${r.retry_after_s ? `; try again in ${r.retry_after_s} seconds` : ''}.`;
  if (r.error === 'network') return 'RentAHuman could not be reached.';
  if (r.error === 'not_built') return r.detail;
  return `RentAHuman answered with an error${r.http ? ` (${r.http})` : ''}.`;
}

// ── Voice: "CHE, find someone to do this task", "CHE, show my human workers", … ─────────────────────────────────────

export function earnIntent(message) {
  const raw = String(message || '').trim();
  const t = raw.replace(/^(?:hey\s+)?(?:che|chey|shay)[,:]\s*|^(?:hey\s+)?(?:chey|shay)\s+|^(?:hey\s+)?che\s+(?!earn\b)/i, '');
  if (!t || t.length > 600) return null;
  if (/^\/earn\b/i.test(t)) return { kind: 'hub' };
  if (/\bconnect\s+rent\s*a\s*human\b/i.test(t)) return { kind: 'connect' };
  if (/\b(?:show|list|read|who\s+are|what\s+are)\s+(?:me\s+)?my\s+(?:human\s+workers|hired\s+(?:humans|people|workers))\b/i.test(t)) return { kind: 'my_workers' };
  const find = /^(?:please\s+)?(?:can\s+you\s+)?(?:find|get|look\s+for|search\s+for)\s+(?:me\s+)?(?:someone|somebody|a\s+person|a\s+human|a\s+worker|people|humans)\s+(?:to|who\s+can|for)\s+([\s\S]*)$/i.exec(t);
  if (find) return { kind: 'find_worker', task: clip(find[1].replace(/[.?!]+$/, ''), 300) };
  if (/\b(?:find|show|search|look\s+for|read)\s+(?:me\s+)?(?:my\s+)?(?:earning\s+opportunities|paid\s+(?:bounties|gigs|tasks)|bounties\s+i\s+can\s+(?:do|earn\s+from)|rent\s*a\s*human\s+(?:bounties|opportunities)|che\s+earn\s+opportunities)\b/i.test(t)) return { kind: 'opportunities' };
  if (/\b(?:che\s+earn|marketplace)\s+earnings\b|\bearnings\s+(?:from|in)\s+(?:che\s+earn|the\s+marketplace|rent\s*a\s*human)\b/i.test(t)) return { kind: 'earnings' };
  if (/\b(?:che\s+earn|earn)\s+approvals\b/i.test(t)) return { kind: 'approvals' };
  return null;
}

const numbered = (items) => items.map((s, i) => `${i + 1}. ${s}`).join(' ');

/** Spoken reply for one intent. Reads only provider records and stored CHE Earn records; never calls a model. */
export async function earnChatReply(ctx, ask) {
  const data = ctx.data || {};
  const env = await keyedEnv(ctx);
  const actx = { ...ctx, env };
  const cap = money(earnSettings(data).spend_cap_cents);
  if (ask.kind === 'connect') return 'To connect RentAHuman, create an API key on rentahuman.ai under Account, API keys. Then open Business, CHE Earn, and use Connect RentAHuman to paste it into the secure key field. Please do not say or type the key in chat. I check it with RentAHuman before I call it connected.';
  if (ask.kind === 'my_workers') {
    const hires = earnRecords(data).filter((r) => r.side === 'hire');
    if (!hires.length) return `You have no human worker jobs yet, sir. Say "find someone to" and the task, and I will search RentAHuman. Authorized spending is ${cap}.`;
    return `You have ${hires.length} human worker job${hires.length === 1 ? '' : 's'}: ${numbered(hires.slice(0, 5).map((r) => `${r.title}, ${r.partner_name}, ${STATUS_LABEL[r.status] || r.status}`))}`;
  }
  if (ask.kind === 'earnings') return verifiedEarnings(data).text;
  if (ask.kind === 'approvals') {
    const p = pendingApprovals(data);
    return p.length ? `${p.length} CHE Earn approval${p.length === 1 ? '' : 's'} waiting: ${numbered(p.slice(0, 5).map((x) => x.speak))}` : 'No CHE Earn approvals are waiting.';
  }
  if (ask.kind === 'hub') return (await earnView(data, actx)).spoken;
  if (ask.kind === 'find_worker') {
    if (!ask.task || /^(?:this|that|it|something|a\s+task|this\s+task|that\s+task)$/i.test(ask.task)) return 'What should the person do, where, and what is your budget? Tell me and I will search RentAHuman. Nothing is posted or paid.';
    const r = await adapterFor('rentahuman').searchWorkers({ skill: ask.task.split(/\s+/).slice(0, 4).join(' '), limit: 24 }, actx);
    if (!r.ok) return `I could not search RentAHuman: ${providerDetail(r)} Nothing was posted or paid.`;
    const ranked = rankWorkers(r.workers, { skill: ask.task });
    if (!ranked.length) return `RentAHuman returned no profiles for "${ask.task}". Nothing was posted or paid.`;
    const rate = recommendRate(ranked);
    return `I searched RentAHuman for "${ask.task}". Top ${Math.min(3, ranked.length)}: ${numbered(ranked.slice(0, 3).map((w) => `${w.name}${w.headline ? `, ${w.headline}` : ''}${w.hourly_rate ? `, $${w.hourly_rate} an hour` : ''}${w.rating ? `, rated ${w.rating} from ${w.review_count} reviews` : ''}${w.verified ? ', verified by RentAHuman' : ''}`))} ${rate.text} Nothing is posted, hired or paid; authorized spending is ${cap}.`;
  }
  if (ask.kind === 'opportunities') {
    const r = await adapterFor('rentahuman').searchBounties({ limit: 20 }, actx);
    if (!r.ok) return `I could not read RentAHuman's bounties: ${providerDetail(r)}`;
    const ranked = rankOpportunities(r.opportunities, { now: ctx.now || Date.now(), capacity: { active: activeCount(data), max: earnSettings(data).max_active } });
    if (!ranked.length) return 'RentAHuman lists no open bounties right now.';
    const g = groupOpportunities(ranked);
    return `RentAHuman lists ${ranked.length} open bount${ranked.length === 1 ? 'y' : 'ies'}: ${g.best.length} CHE can complete, ${g.can_help.length} CHE can help with, ${g.human_required.length} need you in person or your own identity, ${g.not_eligible.length} not eligible. Top: ${numbered(ranked.slice(0, 3).map((o) => `${o.title}, ${money(o.evaluation.expected_pay_cents)}, ${o.evaluation.label}`))} I prepare work; you submit applications yourself.`;
  }
  return '';
}
