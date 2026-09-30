// CHE Client Pipeline: leads → proposal → owner approval → build → review →
// payment link → paid. The owner approves every step that reaches a real
// person or real money; CHE and her Office do the drafting and building.
//
// Honesty rules baked in:
// - CHE cannot send email or messages here. Approved proposals and payment
//   links are handed to the owner to send (copy / open in Mail).
// - "Paid" is only set when Stripe shows a paid checkout for the deal's link.
// - Leads are only what the owner (or a real research connector) supplied;
//   nothing here invents clients.

import { stripe, stripeMode } from './stripe_store.js';

export const STAGES = ['lead', 'proposal', 'approved', 'building', 'review', 'invoiced', 'paid', 'lost'];
const MAX_DEALS = 200;

function now() {
  return new Date().toISOString();
}

function clip(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function deals(data) {
  data.pipeline = Array.isArray(data.pipeline) ? data.pipeline : [];
  return data.pipeline;
}

function log(deal, text) {
  deal.history = Array.isArray(deal.history) ? deal.history : [];
  deal.history.unshift({ at: now(), text: clip(text, 300) });
  deal.history = deal.history.slice(0, 40);
  deal.updated_at = now();
}

export function findDeal(data, id) {
  return deals(data).find((d) => d.id === id) || null;
}

export function addLead(data, body) {
  const clientName = clip(body?.client_name, 120);
  const need = clip(body?.need, 2000);
  if (clientName.length < 2) return { status: 400, detail: 'Who is the client? Add a name or business.' };
  if (need.length < 5) return { status: 400, detail: 'What do they need built?' };
  const contact = clip(body?.contact, 200);
  const source = clip(body?.source, 500);
  const at = now();
  const deal = {
    id: crypto.randomUUID(),
    stage: 'lead',
    client_name: clientName,
    contact,
    source,
    need,
    notes: clip(body?.notes, 2000),
    added_by: clip(body?.added_by, 60) || 'owner',
    proposal_text: '',
    price_usd: null,
    build_task_id: '',
    payment: null,
    history: [],
    created_at: at,
    updated_at: at,
  };
  log(deal, `Lead added by ${deal.added_by}.`);
  const list = deals(data);
  list.unshift(deal);
  data.pipeline = list.slice(0, MAX_DEALS);
  return { status: 200, deal };
}

export function parseProposalDraft(text) {
  const raw = String(text || '');
  const match = /\{[\s\S]*\}/.exec(raw);
  if (match) {
    try {
      const value = JSON.parse(match[0]);
      const price = Number(value.price_usd);
      return {
        proposal_text: clip(value.proposal_text || value.proposal, 6000),
        price_usd: Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null,
        price_reasoning: clip(value.price_reasoning, 600),
      };
    } catch (_) { /* fall through to plain text */ }
  }
  return { proposal_text: clip(raw, 6000), price_usd: null, price_reasoning: '' };
}

// CHE drafts a proposal + suggested price. It stays a draft until approved.
export async function draftProposal(env, deal, model) {
  if (!['lead', 'proposal'].includes(deal.stage)) {
    return { status: 409, detail: `This deal is already at "${deal.stage}".` };
  }
  let text = '';
  try {
    const answer = await env.AI.run(model, {
      messages: [
        {
          role: 'system',
          content: [
            'You are CHE drafting a short, honest client proposal for app or website work that the owner will review and send himself.',
            'Scope only what the client asked for. Plain language. Include: what will be built, what is not included, timeline as an estimate, and next step.',
            'Never promise results, rankings, revenue or guarantees. Never invent facts about the client. Do not claim past clients or reviews.',
            'Return ONLY JSON: {"proposal_text": string, "price_usd": number, "price_reasoning": string}. price_reasoning is for the owner only and says the estimate is a suggestion.',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify({ client: deal.client_name, need: deal.need, notes: deal.notes }) },
      ],
      max_tokens: 900,
    });
    text = String(answer?.response || answer?.choices?.[0]?.message?.content || '');
  } catch (error) {
    return { status: 503, detail: `CHE could not draft it right now: ${clip(error?.message || error, 300)}` };
  }
  const draft = parseProposalDraft(text);
  if (!draft.proposal_text) return { status: 502, detail: 'CHE returned an empty draft. Try again.' };
  deal.proposal_text = draft.proposal_text;
  deal.price_usd = draft.price_usd;
  deal.price_reasoning = draft.price_reasoning;
  deal.stage = 'proposal';
  log(deal, 'CHE drafted a proposal (waiting for your approval).');
  return { status: 200, deal };
}

export function approveProposal(deal, body) {
  if (deal.stage !== 'proposal') return { status: 409, detail: 'Draft a proposal first.' };
  const price = Number(body?.price_usd ?? deal.price_usd);
  if (!Number.isFinite(price) || price < 1) return { status: 400, detail: 'Set the price you agree to charge.' };
  if (body?.proposal_text != null) {
    const edited = clip(body.proposal_text, 6000);
    if (edited.length < 20) return { status: 400, detail: 'The proposal text is too short.' };
    deal.proposal_text = edited;
  }
  deal.price_usd = Math.round(price * 100) / 100;
  deal.stage = 'approved';
  log(deal, `You approved the proposal at $${deal.price_usd.toFixed(2)}. Send it to the client, then start the build when they agree.`);
  return { status: 200, deal };
}

export function buildBrief(deal) {
  return [
    `Client project for ${deal.client_name}.`,
    `What they need: ${deal.need}`,
    deal.notes ? `Notes: ${deal.notes}` : '',
    `Agreed scope (from the approved proposal):\n${deal.proposal_text}`,
    'Deliver: a build plan, the actual code for the first working version (complete files), and a short checklist the owner can use to review it before delivery.',
    'Stay within the agreed scope. Label anything you could not verify or finish.',
  ].filter(Boolean).join('\n\n');
}

export function markStage(deal, stage) {
  const allowed = {
    building: ['approved'],
    review: ['building'],
    lost: STAGES.filter((s) => !['paid', 'lost'].includes(s)),
  };
  if (!allowed[stage]) return { status: 400, detail: 'Unknown step.' };
  if (!allowed[stage].includes(deal.stage)) return { status: 409, detail: `Can't move from "${deal.stage}" to "${stage}".` };
  deal.stage = stage;
  log(deal, stage === 'lost' ? 'Marked as lost.' : `Moved to ${stage}.`);
  return { status: 200, deal };
}

// Creates a one-off Stripe payment link for the agreed price.
// Requires confirmed: true from the owner (app confirm dialog).
export async function createPaymentLink(env, deal, fetcher = fetch, { confirmed = false } = {}) {
  if (stripeMode(env) === 'not_connected') {
    return { status: 503, detail: 'Stripe is not connected. Add STRIPE_SECRET_KEY to the CHE Worker.' };
  }
  if (!['review', 'invoiced'].includes(deal.stage)) {
    return { status: 409, detail: 'Review the finished work before requesting payment.' };
  }
  if (deal.payment?.url) return { status: 200, deal };
  if (confirmed !== true) {
    return { status: 400, detail: 'Confirm in the app before CHE creates a Stripe payment link.' };
  }
  const cents = Math.round(Number(deal.price_usd) * 100);
  if (!Number.isFinite(cents) || cents < 50) return { status: 400, detail: 'This deal has no agreed price.' };
  try {
    const product = await stripe(env, 'POST', '/products', {
      name: clip(`Project: ${deal.client_name}`, 120),
      description: clip(deal.need, 500),
      default_price_data: { currency: 'usd', unit_amount: cents },
      metadata: { che_deal_id: deal.id },
    }, fetcher, `che-deal-product-${deal.id}`);
    const priceId = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
    if (!priceId) throw new Error('Stripe did not return a price.');
    const link = await stripe(env, 'POST', '/payment_links', {
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { che_deal_id: deal.id },
    }, fetcher, `che-deal-link-${deal.id}`);
    if (!String(link?.url || '').startsWith('https://')) throw new Error('Stripe did not return a payment link.');
    deal.payment = { mode: stripeMode(env), product_id: product.id, price_id: priceId, link_id: link.id, url: link.url, paid: false };
    deal.stage = 'invoiced';
    log(deal, 'Stripe payment link created. Send it to the client.');
    return { status: 200, deal };
  } catch (error) {
    return { status: 502, detail: `Stripe did not create the link: ${clip(error?.message || error, 300)}` };
  }
}

// Paid only when Stripe shows a paid checkout for this deal's link.
export async function checkPaid(env, deal, fetcher = fetch) {
  if (!deal.payment?.link_id) return { status: 409, detail: 'No payment link yet.' };
  if (deal.stage === 'paid') return { status: 200, deal };
  try {
    const sessions = await stripe(env, 'GET', '/checkout/sessions', { payment_link: deal.payment.link_id, limit: 10 }, fetcher);
    const paid = (Array.isArray(sessions?.data) ? sessions.data : []).find((s) => s.payment_status === 'paid');
    if (paid) {
      deal.stage = 'paid';
      deal.payment.paid = true;
      deal.payment.session_id = paid.id;
      deal.payment.amount_total = paid.amount_total;
      log(deal, `Stripe confirmed payment of $${(Number(paid.amount_total || 0) / 100).toFixed(2)}.`);
    }
    return { status: 200, deal, paid: Boolean(paid) };
  } catch (error) {
    return { status: 502, detail: `Could not check Stripe: ${clip(error?.message || error, 300)}` };
  }
}

export function pipelineSummary(data) {
  const list = deals(data);
  const count = (stage) => list.filter((d) => d.stage === stage).length;
  return {
    deals: list,
    counts: Object.fromEntries(STAGES.map((s) => [s, count(s)])),
    needs_you: list.filter((d) => ['proposal', 'review'].includes(d.stage)).length,
  };
}
