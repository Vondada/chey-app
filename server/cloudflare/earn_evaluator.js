// CHE Earn evaluator (owner, 2026-10-25): scores and classifies marketplace opportunities and human workers.
// Deterministic: no model, no network, no clock except the `now` passed in. Every number it produces is labelled
// as an estimate unless it came from the provider record, and nothing here can accept, apply, hire or pay.
//
// Classes, in rank order:
//   che_can_complete  digital, remote, the listing explicitly permits AI work, and CHE has a matching engine
//   che_can_assist    digital and remote, but AI use is unstated (or no engine fits): CHE prepares drafts, the owner
//                     does and submits the work and discloses AI assistance
//   human_required    physical presence, identity checks, live capture, or the listing forbids AI
//   not_eligible      closed, expired, full, unpaid, or CHE is already at capacity for CHE-work

export const CLASSES = Object.freeze(['che_can_complete', 'che_can_assist', 'human_required', 'not_eligible']);
export const CLASS_LABEL = Object.freeze({
  che_can_complete: 'CHE can complete',
  che_can_assist: 'CHE can help',
  human_required: 'Human required',
  not_eligible: 'Not eligible',
});

// What CHE's existing engines can produce. `engine` names the existing system; compute is free-first (0 cents) unless
// the caller passes measured costs.
export const CHE_SKILLS = Object.freeze({
  web_page: { engine: 'site_builder.writeSite', words: /\b(?:landing\s+page|web\s*page|website|html|one[-\s]page|web\s+app)\b/i },
  coding: { engine: 'coding_runtime (Office coding crew)', words: /\b(?:code|coding|script|python|javascript|typescript|bug|api|program|developer|software|github|sql)\b/i },
  research: { engine: 'public research + Office research desk', words: /\b(?:research|summar(?:y|ize|ise)|report|analy[sz]e|analysis|fact[-\s]check|literature|market\s+research|compile|list\s+of)\b/i },
  writing: { engine: 'CHE language engine', words: /\b(?:write|writing|copy(?:writing)?|article|blog|essay|caption|product\s+description|proofread|edit(?:ing)?|translate|translation|transcri(?:be|ption))\b/i },
  design: { engine: 'Creation Studio images', words: /\b(?:design|logo|graphic|illustration|thumbnail|banner|mockup|icon)\b/i },
  music: { engine: 'Music Studio', words: /\b(?:music|song|jingle|beat|melody|audio\s+track)\b/i },
  video: { engine: 'faceless video line (free GPU first)', words: /\b(?:video\s+edit(?:ing)?|edit\s+(?:a\s+)?video|animation|short\s+video|youtube\s+short|subtitles?)\b/i },
  data: { engine: 'CHE language engine + spreadsheets', words: /\b(?:data\s+entry|spreadsheet|csv|excel|categori[sz]e|label(?:l)?ing|tagging|dataset)\b/i },
});

const PHYSICAL = /\b(?:pick\s*up|drop\s*off|in[-\s]person|on[-\s]site|attend\s+(?:a|an|the)\b|show\s+up\s+at|hold\s+(?:a\s+)?signs?|taste[-\s]test|tasting|errands?|post\s+office|stand\s+in\s+line|meet\s+in\s+person|physical(?:ly)?|drive\s+to|deliver\s+(?:a|the)\s+package|house\s*cleaning|street\s+corners?)\b/i;
const AI_FORBIDDEN = [
  /\b(?:no|not|without|never|don['’]?t\s+use|do\s+not\s+use|zero)\s+(?:use\s+of\s+)?(?:ai|a\.i\.|chat\s?gpt|gpt|llms?|genai|generative\s+ai)\b/i,
  /\b(?:ai|a\.i\.|chat\s?gpt|llm)[-\s](?:generated|written|assisted)?\s*(?:content|text|work|answers?|submissions?)?\s*(?:is|are|will\s+be)?\s*(?:not\s+allowed|prohibited|forbidden|banned|rejected|disqualified)\b/i,
  /\bhuman[-\s](?:written|only|made|created|authored)\b/i,
  /\bmust\s+be\s+(?:written|done|made|created)\s+by\s+(?:a\s+)?(?:real\s+)?human\b/i,
];
const AI_PERMITTED = [
  /\b(?:ai|a\.i\.|chat\s?gpt|llms?|ai\s+tools?)(?:[-\s]assisted)?(?:\s+(?:use|assistance|help|tools?))?\s+(?:is|are)?\s*(?:ok|okay|allowed|welcome|permitted|fine|encouraged)\b/i,
  /\byou\s+(?:may|can)\s+use\s+(?:ai|a\.i\.|chat\s?gpt|llms?|ai\s+tools?)\b/i,
  /\bai[-\s]generated\s+(?:content\s+)?(?:is\s+)?(?:ok|okay|allowed|fine|acceptable|welcome)\b/i,
];
const VAGUE = /\b(?:perfect|amazing|whatever|asap|urgent|unlimited\s+revisions|until\s+satisfied|make\s+it\s+pop)\b/i;

const cents = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) : 0);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const textOf = (o) => [o?.title, o?.description, ...(o?.requirements || []), ...(o?.skills || []), o?.category].filter(Boolean).join(' \n ');

/** 'forbidden' | 'permitted' | 'unknown', from the listing's own words only. Forbidden wins over permitted. */
export function aiPolicy(opportunity) {
  const t = textOf(opportunity);
  if (AI_FORBIDDEN.some((re) => re.test(t))) return 'forbidden';
  if (AI_PERMITTED.some((re) => re.test(t))) return 'permitted';
  return 'unknown';
}

/** CHE skills the listing matches, best first (by order in CHE_SKILLS). */
export function matchedSkills(opportunity) {
  const t = textOf(opportunity);
  return Object.entries(CHE_SKILLS).filter(([, s]) => s.words.test(t)).map(([id]) => id);
}

/** Pay in cents and how it was computed. Hourly pay without hours assumes 1 hour and says so. */
export function expectedPay(opportunity) {
  const pay = opportunity?.pay || {};
  const amount = Number(pay.amount) || 0;
  if (pay.type === 'hourly') {
    const hours = Number(pay.est_hours) > 0 ? Number(pay.est_hours) : 1;
    return { cents: cents(amount * hours), basis: Number(pay.est_hours) > 0 ? `hourly × ${hours} h listed` : 'hourly × 1 h (estimate: no hours listed)' };
  }
  return { cents: cents(amount), basis: 'fixed price listed' };
}

/**
 * Scores one opportunity. ctx: { now (ms), capacity: { active, max }, costs: { <skill>: cents }, platform_fee_rate }
 * platform_fee_rate is null unless the caller knows it (RentAHuman's worker-side fee is not in its public client docs).
 */
export function evaluateOpportunity(opportunity, ctx = {}) {
  const now = Number(ctx.now) || 0;
  const o = opportunity || {};
  const reasons = [];
  const t = textOf(o);
  const policy = aiPolicy(o);
  const skills = matchedSkills(o);
  const pay = expectedPay(o);
  const deadlineMs = Date.parse(o.deadline || '') || 0;
  const hoursLeft = deadlineMs && now ? Math.round((deadlineMs - now) / 3_600_000) : null;
  const estHours = Number(o.pay?.est_hours) > 0 ? Number(o.pay.est_hours) : null;
  const physical = o.remote === false || PHYSICAL.test(t) || Boolean(o.live_capture);
  const identity = Boolean(o.identity_required || o.linkedin_required || o.mic_check);
  const digital = !physical;
  const capacity = { active: Number(ctx.capacity?.active) || 0, max: Number(ctx.capacity?.max) || 3 };
  const atCapacity = capacity.active >= capacity.max;

  let klass = '';
  const status = String(o.status || 'open');
  if (!['open', 'partially_filled'].includes(status)) { klass = 'not_eligible'; reasons.push(`The listing is ${status}, not open.`); }
  else if (deadlineMs && now && deadlineMs <= now) { klass = 'not_eligible'; reasons.push('The deadline has passed.'); }
  else if (o.spots_remaining === 0) { klass = 'not_eligible'; reasons.push('Every spot is filled.'); }
  else if (pay.cents <= 0) { klass = 'not_eligible'; reasons.push('No pay is listed.'); }
  if (!klass && physical) { klass = 'human_required'; reasons.push(o.live_capture ? 'Needs live camera evidence from the worker.' : 'Needs someone physically there; CHE never claims attendance.'); }
  if (!klass && identity) { klass = 'human_required'; reasons.push('Needs the worker\'s own identity check (ID, LinkedIn or a mic check); CHE never stands in for you.'); }
  if (!klass && policy === 'forbidden') { klass = 'human_required'; reasons.push('The listing forbids AI work, so CHE will not draft it; only you can do it.'); }
  if (!klass && policy === 'permitted' && skills.length) { klass = 'che_can_complete'; reasons.push(`The listing permits AI work and CHE has an engine for it (${CHE_SKILLS[skills[0]].engine}).`); }
  if (!klass) {
    klass = 'che_can_assist';
    reasons.push(policy === 'unknown'
      ? 'The listing does not say whether AI help is allowed: CHE can prepare drafts, you do and submit the work, disclose AI help, and check the rules first.'
      : 'AI help is allowed but CHE has no engine that fits, so CHE can only help you prepare.');
  }
  if ((klass === 'che_can_complete' || klass === 'che_can_assist') && atCapacity) {
    klass = 'not_eligible';
    reasons.push(`CHE already has ${capacity.active} active contracts (limit ${capacity.max}); she takes no more work than she can deliver.`);
  }

  const primary = skills[0] || '';
  const compute = primary && Number.isFinite(Number(ctx.costs?.[primary])) ? Math.max(0, Math.round(Number(ctx.costs[primary]))) : 0;
  const feeRate = Number.isFinite(Number(ctx.platform_fee_rate)) && ctx.platform_fee_rate !== null ? clamp(Number(ctx.platform_fee_rate), 0, 1) : null;
  const fee = feeRate === null ? null : Math.round(pay.cents * feeRate);
  const net = pay.cents - compute - (fee || 0);
  const vague = String(o.description || '').length < 80 || VAGUE.test(t);
  const tight = hoursLeft !== null && estHours !== null && hoursLeft < estHours * 2;
  let probability = { che_can_complete: 0.8, che_can_assist: 0.6, human_required: 0.5, not_eligible: 0 }[klass];
  if (klass !== 'not_eligible') {
    if (vague) probability -= 0.15;
    if (tight) probability -= 0.2;
    if ((o.requirements || []).length > 5) probability -= 0.1;
  }
  probability = clamp(Math.round(probability * 100) / 100, 0, 1);
  const dispute = vague ? 'high' : (o.requirements || []).length > 3 ? 'medium' : 'low';
  const difficulty = estHours === null ? 'unknown' : estHours <= 1 ? 'easy' : estHours <= 4 ? 'medium' : 'hard';

  // Score 0-100: net pay (log scale), delivery probability, deadline room, skill fit, AI clarity, minus dispute risk.
  let score = 0;
  if (klass !== 'not_eligible') {
    score += clamp(Math.log10(Math.max(1, net / 100) + 1) * 20, 0, 40);
    score += probability * 30;
    score += hoursLeft === null ? 5 : tight ? 0 : 10;
    score += skills.length ? 10 : 0;
    score += policy === 'permitted' ? 10 : policy === 'unknown' ? 4 : 0;
    score -= dispute === 'high' ? 10 : dispute === 'medium' ? 4 : 0;
    if (difficulty === 'easy') score += 3;
  }
  return {
    classification: klass,
    label: CLASS_LABEL[klass],
    score: Math.round(clamp(score, 0, 100)),
    ai_policy: policy,
    digital,
    skills,
    engine: primary ? CHE_SKILLS[primary].engine : '',
    expected_pay_cents: pay.cents,
    pay_basis: pay.basis,
    compute_cost_cents: compute,
    platform_fee_cents: fee,
    platform_fee_note: fee === null ? 'Worker-side platform fee not documented; net excludes it.' : '',
    est_net_cents: net,
    delivery_probability: probability,
    dispute_risk: dispute,
    refund_risk: dispute,
    difficulty,
    deadline_hours: hoursLeft,
    reasons,
    estimate: true,
  };
}

const ORDER = Object.fromEntries(CLASSES.map((c, i) => [c, i]));

/** Evaluates and ranks: class order first, then score, then pay, then id (stable). */
export function rankOpportunities(list, ctx = {}) {
  return (Array.isArray(list) ? list : [])
    .map((o) => ({ ...o, evaluation: evaluateOpportunity(o, ctx) }))
    .sort((a, b) => ORDER[a.evaluation.classification] - ORDER[b.evaluation.classification]
      || b.evaluation.score - a.evaluation.score
      || b.evaluation.expected_pay_cents - a.evaluation.expected_pay_cents
      || String(a.provider_ref).localeCompare(String(b.provider_ref)));
}

/** Groups ranked opportunities into the hub's sections. */
export function groupOpportunities(ranked) {
  const out = { best: [], can_help: [], human_required: [], not_eligible: [] };
  for (const o of ranked || []) {
    const c = o.evaluation?.classification;
    (c === 'che_can_complete' ? out.best : c === 'che_can_assist' ? out.can_help : c === 'human_required' ? out.human_required : out.not_eligible).push(o);
  }
  return out;
}

/** Worker ranking for hiring: rating weighted by review count, verification, rate fit, location, availability. */
export function scoreWorker(w, q = {}) {
  let s = 0;
  const reviews = Number(w.review_count) || 0;
  const rating = Number(w.rating) || 0;
  s += reviews ? (rating / 5) * 40 * Math.min(1, Math.log10(reviews + 1) / 2) : 0;
  if (w.verified) s += 15;
  if (w.available) s += 10;
  const rate = Number(w.hourly_rate);
  const max = Number(q.max_rate);
  if (Number.isFinite(rate) && rate > 0) s += Number.isFinite(max) && max > 0 ? (rate <= max ? 15 : -20) : 5;
  if (q.city && String(w.location?.city || '').toLowerCase() === String(q.city).toLowerCase()) s += 10;
  if (q.skill && (w.skills || []).some((k) => String(k).toLowerCase().includes(String(q.skill).toLowerCase()))) s += 10;
  s += Math.min(10, (Number(w.total_bookings) || 0) / 10);
  return Math.round(clamp(s, 0, 100));
}

export function rankWorkers(list, q = {}) {
  return (Array.isArray(list) ? list : [])
    .map((w) => ({ ...w, score: scoreWorker(w, q) }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

/** Rate advice from the listed hourly rates of the profiles found (not a market-wide claim). */
export function recommendRate(workers) {
  const rates = (workers || []).map((w) => Number(w.hourly_rate)).filter((r) => Number.isFinite(r) && r > 0).sort((a, b) => a - b);
  if (!rates.length) return { sample: 0, text: 'No listed hourly rates to compare yet.' };
  const at = (p) => rates[Math.min(rates.length - 1, Math.floor(p * (rates.length - 1)))];
  const r = { sample: rates.length, low: at(0.25), median: at(0.5), high: at(0.75), currency: 'USD' };
  return { ...r, text: `From ${r.sample} profile${r.sample === 1 ? '' : 's'} found: middle rate $${r.median} an hour, most between $${r.low} and $${r.high}. This compares listed rates only.` };
}

export function money(c) {
  const n = Number(c) || 0;
  return `$${(n / 100).toFixed(n % 100 ? 2 : 0)}`;
}
