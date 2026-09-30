// Forever opportunity scout — shortlist research for the owner only.
// Channels: Fiverr, Pinterest, dropship/middleman leads, and other public
// marketplaces where CHE can sell services for the owner's benefit.
// Never auto-message, auto-buy inventory, bid, order, or spend without confirm.
// Fiverr-specific helpers stay in fiverr_scout.js; this module is the umbrella.

export const OPPORTUNITY_CHANNELS = [
  'fiverr',
  'pinterest',
  'dropship_middleman',
  'marketplace',
  'multi',
];

export const OPPORTUNITY_SCOUT_QUERIES = {
  fiverr: [
    'AI ads',
    'AI ad creative',
    'AI chatbot',
    'AI content writing',
    'AI logo design',
  ],
  pinterest: [
    'AI product mockups',
    'digital download planners',
    'printable wall art',
    'social media templates',
    'AI ad creative boards',
  ],
  dropship_middleman: [
    'print on demand merch',
    'custom product fulfillment',
    'white label supplements middleman',
    'niche gadget dropship',
    'local delivery middleman offer',
  ],
  marketplace: [
    'AI design services',
    'ad creative freelance',
    'chatbot setup gig',
    'content pack for small business',
  ],
  multi: [
    'AI ads and creative services',
    'small business marketing packs',
    'chatbot and automation offers',
  ],
};

export function normalizeOpportunityChannel(raw) {
  const t = String(raw || '').toLowerCase().replace(/\s+/g, '_');
  if (!t || t === 'any' || t === 'all' || t === 'forever') return 'multi';
  if (/fiverr/.test(t)) return 'fiverr';
  if (/pinterest|pin\b/.test(t)) return 'pinterest';
  if (/drop|middleman|alibaba|cj_|print.?on.?demand|pod\b/.test(t)) return 'dropship_middleman';
  if (/etsy|upwork|freelancer|gumroad|marketplace/.test(t)) return 'marketplace';
  if (OPPORTUNITY_CHANNELS.includes(t)) return t;
  return 'multi';
}

/** Owner-facing shortlist record (fill from manual/browser-first scout). */
export function emptyOpportunityNote(query, channel = 'multi', at = new Date()) {
  const ch = normalizeOpportunityChannel(channel);
  const stamp = at.toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: true });
  const q = String(query || 'AI service buyers').trim().slice(0, 200);
  return {
    title: `Opportunity scout shortlist (${ch})`,
    channel: ch,
    query: q,
    scouted_at_label: `${stamp} America/Chicago`,
    opportunities: [],
    owner_confirm_required: true,
    outbound_allowed: false,
    auto_message: false,
    auto_buy_inventory: false,
    spend_without_confirm: false,
    note_template: [
      `Opportunity scout — ${stamp} America/Chicago`,
      `Channel: ${ch}`,
      `Query: ${q}`,
      'Offer / service angle:',
      'Why it fits the owner:',
      'URL:',
      'Observed pricing / terms (if public):',
      'Risks / missing facts:',
      'Confidence: high | medium | low',
      'Recommendation: watch | ask owner | owner-approved message | discard',
      'Owner decision: pending',
      'Hard rules: maximize legal money-making; no artificial product walls; never auto-message/bid/buy/spend/Stripe without owner confirm; never illegal or impossible schemes.',
    ].join('\n'),
  };
}

function channelPlaybook(channel) {
  const ch = normalizeOpportunityChannel(channel);
  if (ch === 'fiverr') return 'docs/ai-ad-business/FIVERR_SCOUT.md and docs/ai-ad-business/OPPORTUNITY_SCOUT.md';
  return 'docs/ai-ad-business/OPPORTUNITY_SCOUT.md';
}

/**
 * Atlas research task — produces a shortlist only (channel, offer, why, URL).
 */
export function buildOpportunityScoutTask(query, channel = 'multi') {
  const ch = normalizeOpportunityChannel(channel);
  const q = String(query || 'AI service buyers').replace(/\s+/g, ' ').trim().slice(0, 200) || 'AI service buyers';
  return [
    `Opportunity scout shortlist on channel "${ch}" for: ${q}.`,
    `Use the playbook (${channelPlaybook(ch)}).`,
    'Goal: maximize legal money-making for the owner. No artificial product boundaries — any lawful, reality-possible offer is in scope.',
    'Hard stops only: illegal activity, or things impossible in reality. Do not invent illegal schemes.',
    'For each useful lead capture: Channel, Offer, Why (owner benefit), URL.',
    'Also note observed public pricing/terms, risks, confidence, and next_step (watch | ask owner | discard).',
    'Do NOT message, bid, accept, order, purchase inventory, place ads that spend money, charge Stripe, or store marketplace passwords/cookies/tokens.',
    'Owner must confirm before spend, outreach, bids, purchases, or Stripe charges. Outbound drafts stay Owner decision: pending.',
  ].join(' ');
}

/**
 * Iris follow-up: map shortlist to honest agency / product offers.
 */
export function buildOpportunityFitTask(query, channel = 'multi') {
  const ch = normalizeOpportunityChannel(channel);
  const q = String(query || 'AI service buyers').replace(/\s+/g, ' ').trim().slice(0, 200) || 'AI service buyers';
  return [
    `Map ${ch} opportunity-scout leads for "${q}" to honest owner offers — any lawful money-making angle. No artificial product walls; skip only illegal or impossible ideas.`,
    'List missing inputs, inventory or fulfillment risks, and regulated-claim risks.',
    'Draft message or listing copy only — do not send, publish, buy stock, charge Stripe, or spend.',
    'Owner must confirm before outreach, bids, purchases, spend, or Stripe charges.',
  ].join(' ');
}

export function speakOpportunityScoutPlan(jobs, query, channel = 'multi') {
  const ch = normalizeOpportunityChannel(channel);
  const q = String(query || 'AI service buyers').trim();
  if (!jobs.length) {
    return `CHE here. I could not queue an opportunity scout on ${ch} for "${q}". Open the Office and try again.`;
  }
  const lines = jobs.map((j, i) => `${i + 1}. ${j.agent}: ${j.task}${j.blocker ? ` — ${j.blocker}` : ''}`).join('. ');
  return [
    `CHE here. Opportunity scout queued on ${ch} for "${q}".`,
    lines + '.',
    'This produces a shortlist for your review only — channel, offer, why, and URL.',
    'I will not auto-message, bid, buy, spend, or charge Stripe until you confirm the exact action. Legal money-making only — no artificial product walls.',
  ].join(' ');
}

/** Parse spoken "scout Pinterest for X" / "scout opportunities for X" etc. */
export function parseOpportunityScoutPhrase(original, normalized) {
  const t = String(normalized || '').toLowerCase();
  const raw = String(original || '');

  // Keep dedicated Fiverr phrase elsewhere; still allow "scout opportunities on Fiverr".
  const forever = /\b(?:forever\s+)?(?:opportunity|opportunities)\s+scout\b/.test(t)
    || /\bscout\s+(?:forever\s+)?(?:opportunit(?:y|ies)|leads?|channels?)\b/.test(t)
    || /\bscout\s+(?:on\s+)?(?:pinterest|drop\s*ships?|dropshipping|middleman|etsy|upwork|marketplaces?)\b/.test(t)
    || /\b(?:pinterest|drop\s*ship|middleman)\s+scout\b/.test(t);

  if (!forever) return null;

  let channel = 'multi';
  if (/\bfiverr\b/.test(t)) channel = 'fiverr';
  else if (/\bpinterest\b/.test(t)) channel = 'pinterest';
  else if (/\bdrop\s*ships?|dropshipping|middleman\b/.test(t)) channel = 'dropship_middleman';
  else if (/\betsy|upwork|freelancer|gumroad|marketplace\b/.test(t)) channel = 'marketplace';

  const fromOriginal = raw.match(/\bscout\s+(?:forever\s+)?(?:opportunit(?:y|ies)|leads?|channels?|pinterest|drop\s*ships?|dropshipping|middleman|etsy|upwork|marketplaces?|fiverr)\s+(?:on\s+\w+\s+)?(?:for\s+)?(.+)$/i)
    || raw.match(/\b(?:pinterest|drop\s*ship|middleman|opportunity)\s+scout\s+for\s+(.+)$/i)
    || raw.match(/\bforever\s+opportunity\s+scout\s+for\s+(.+)$/i);
  const query = (fromOriginal && fromOriginal[1] ? fromOriginal[1] : 'AI service buyers')
    .replace(/[.!?]+$/, '')
    .trim() || 'AI service buyers';

  return { type: 'opportunityScout', channel, query: query.slice(0, 200) };
}
