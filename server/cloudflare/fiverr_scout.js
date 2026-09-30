// Fiverr scout tasks: shortlist research for the owner only.
// Never auto-message, bid, purchase, or store Fiverr credentials.

export const FIVERR_SCOUT_QUERIES = [
  'AI ads',
  'AI ad creative',
  'Facebook ads design',
  'Instagram ads',
  'Meta ad creative',
  'AI chatbot',
  'chatbot for small business',
  'AI content writing',
  'social media content',
  'AI logo design',
  'AI flyer design',
];

/** Owner-facing shortlist record shape (fill from manual browser scout). */
export function emptyScoutNote(query, at = new Date()) {
  const stamp = at.toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: true });
  return {
    title: 'Fiverr scout shortlist',
    query: String(query || 'AI ad buyers').trim().slice(0, 200),
    scouted_at_label: `${stamp} America/Chicago`,
    opportunities: [],
    owner_confirm_required: true,
    outbound_allowed: false,
    note_template: [
      `Fiverr scout — ${stamp} America/Chicago`,
      `Query: ${String(query || 'AI ad buyers').trim()}`,
      'Category:',
      'Buyer request/brief (if visible):',
      'Competitor gig(s):',
      'Observed pricing/delivery:',
      'Potential agency fit:',
      'Risks / missing facts:',
      'URL(s):',
      'Confidence: high | medium | low',
      'Recommendation: watch | ask owner | owner-approved message | discard',
      'Owner decision: pending',
    ].join('\n'),
  };
}

/**
 * Task text for Atlas (research) — produces a shortlist, never outbound action.
 */
export function buildFiverrScoutTask(query) {
  const q = String(query || 'AI ad buyers').replace(/\s+/g, ' ').trim().slice(0, 200) || 'AI ad buyers';
  return [
    `Fiverr scout shortlist for: ${q}.`,
    'Use the browser-first scout playbook (docs/ai-ad-business/FIVERR_SCOUT.md).',
    'Capture a small owner-review shortlist: query, URL, category, observed pricing, fit, risks, confidence, next_step.',
    'Do NOT message, bid, accept, order, purchase, or store Fiverr passwords/cookies/tokens.',
    'Any outbound draft stays Owner decision: pending until the owner confirms the exact recipient, channel, and text.',
  ].join(' ');
}

/**
 * Optional Iris follow-up: map shortlist rows to Tonight Pack / offer fit.
 */
export function buildFiverrFitTask(query) {
  const q = String(query || 'AI ad buyers').replace(/\s+/g, ' ').trim().slice(0, 200) || 'AI ad buyers';
  return [
    `Map Fiverr scout opportunities for "${q}" to honest agency offers (Tonight Pack / Mid / Starter / content).`,
    'List missing inputs and risks. Draft message copy only — do not send.',
    'Owner must confirm before any Fiverr outbound action.',
  ].join(' ');
}

export function speakFiverrScoutPlan(jobs, query) {
  const q = String(query || 'AI ad buyers').trim();
  if (!jobs.length) {
    return `CHE here. I could not queue a Fiverr scout for "${q}". Open the Office and try again.`;
  }
  const lines = jobs.map((j, i) => `${i + 1}. ${j.agent}: ${j.task}${j.blocker ? ` — ${j.blocker}` : ''}`).join('. ');
  return [
    `CHE here. Fiverr scout queued for "${q}".`,
    lines + '.',
    'This produces a shortlist for your review only.',
    'I will not message, bid, or buy on Fiverr until you confirm the exact recipient, channel, and text.',
  ].join(' ');
}

export function speakHireIris(agent, taskNote = '') {
  if (!agent) {
    return 'CHE here. Iris is not on the roster yet. Opening the Office will staff Ad Studio.';
  }
  const role = agent.role || 'Ad Studio / paid-social creatives';
  const next = taskNote
    ? taskNote
    : 'Say draft tonight pack for a business, or tell the Office your creative goal.';
  return `CHE here. Iris is hired on Ad Studio — ${role}. ${next}`;
}
