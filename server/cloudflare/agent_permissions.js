// Agent permission flags are enforced in code before a job is queued or run.
// La Agencia agents ship with can_merge_code / can_spend_money /
// can_open_payouts all false (office_company.js); only the owner merges PRs,
// spends money or opens payouts.

const MONEY = new Set(['spend', 'purchase', 'stripe_payout', 'payout', 'transfer']);
const MERGE = new Set(['merge', 'github_merge']);
const PAYOUT = new Set(['payout', 'stripe_payout']);

function refusal(message) {
  return Object.assign(new Error(message), { status: 403 });
}

// Explicit job.kind / job.type wins; otherwise the job's leading action is
// classified so a spoken goal like "merge PR 45" cannot slip past as an
// ordinary task. Only the opening verb counts, so "write a listing customers
// can buy" is not mistaken for spending money.
const LEAD = String.raw`^(?:(?:please|now|then|also|and)\s+)*`;
export function jobKind(job) {
  const explicit = String(job?.kind || job?.type || '').toLowerCase().trim();
  if (explicit) return explicit;
  const text = String(job?.task || job?.text || '').toLowerCase().trim();
  if (new RegExp(`${LEAD}merge\\b`).test(text)) return 'merge';
  if (new RegExp(`${LEAD}(?:open|send|start|trigger|create|make|issue)\\b[\\s\\S]{0,30}\\bpayouts?\\b`).test(text)) return 'payout';
  if (new RegExp(`${LEAD}(?:transfer|wire|send)\\b[\\s\\S]{0,40}(?:\\$\\d|\\b(?:money|funds|dollars?)\\b)`).test(text)) return 'transfer';
  if (new RegExp(`${LEAD}(?:buy|purchase|pay for|spend)\\b`).test(text)) return 'spend';
  return '';
}

export function assertAgentMayRun(agent, job) {
  const kind = jobKind(job);
  if (MERGE.has(kind) && agent?.can_merge_code !== true) throw refusal('agent_cannot_merge_code');
  if (PAYOUT.has(kind) && agent?.can_open_payouts !== true) throw refusal('agent_cannot_open_payouts');
  if (MONEY.has(kind) && agent?.can_spend_money !== true) throw refusal('agent_cannot_spend_money');
  return kind;
}

// Spoken/visible blocker line for a refused job.
export function permissionBlocker(agent, error) {
  const name = agent?.name || 'This agent';
  switch (error?.message) {
    case 'agent_cannot_merge_code': return `Blocked: ${name} cannot merge code. Only the owner merges.`;
    case 'agent_cannot_open_payouts': return `Blocked: ${name} cannot open payouts. Only the owner does.`;
    case 'agent_cannot_spend_money': return `Blocked: ${name} cannot spend money. Only the owner does.`;
    default: return `Blocked: ${error?.message || 'not permitted'}`;
  }
}

// ─── Hands-on app steps (browser, logins, forms) ───────────────────────────
// One gate for every step CHE takes inside an app: reading a page, clicking, typing,
// sending a message, spending money, deleting, or using a password. Owner rules
// (AGENTS.md): CHE may act freely, including sending messages and emails; she asks
// first before anything that costs money or deletes or removes something; she opens
// an app only after the owner grants that app; passwords come only from the vault.

const SPEND_WORDS = /\b(buy|purchase|checkout|check out|pay|payment|subscribe|subscription|order now|place order|donate|tip|transfer|send money|add to cart)\b/i;
const DELETE_WORDS = /\b(delete|remove|unsubscribe|cancel (?:my )?(?:account|subscription)|close (?:my )?account|erase|uninstall|clear all)\b/i;
const SIGNUP_WORDS = /\b(create (?:an? |my )?account|sign ?up|register|join now)\b/i;
const SEND_WORDS = /\b(send|submit|post|reply|message|email|publish|share)\b/i;
export const BROWSER_STEP_KINDS = Object.freeze(['read', 'navigate', 'click', 'type', 'send', 'spend', 'delete', 'credential', 'signup']);

// Pages that need a human: a code, a CAPTCHA, a phone or 2-step check. CHE never guesses these or tries to get past them.
const VERIFICATION = /verification code|confirmation code|enter the code|security code|one-time (?:code|password)|captcha|not a robot|two-factor|2-factor|verify (?:your )?(?:phone|email|identity|account)/i;
export function needsOwnerVerification(text = '') {
  return VERIFICATION.test(String(text || ''));
}

/** What kind of step this is. An explicit kind wins; otherwise the element's own label decides. */
export function browserStepKind(step = {}) {
  const explicit = String(step.kind || '').toLowerCase();
  if (BROWSER_STEP_KINDS.includes(explicit)) return explicit;
  const label = `${step.label || ''} ${step.text || ''}`.toLowerCase();
  if (step.action === 'type' && step.secret) return 'credential';
  if (DELETE_WORDS.test(label)) return 'delete';
  if (SPEND_WORDS.test(label)) return 'spend';
  if (step.action === 'click' && SIGNUP_WORDS.test(label)) return 'signup';
  if (step.action === 'click' && SEND_WORDS.test(label)) return 'send';
  if (step.action === 'type') return 'type';
  if (step.action === 'click') return 'click';
  if (step.action === 'navigate') return 'navigate';
  return 'read';
}

/**
 * Enforces one browser step before the phone runs it.
 * Returns { held: false, kind } when the step may run now, or { held: true, kind, reason } when it
 * waits for the owner's yes (spending and deleting). Throws a 403 for steps the owner never allowed:
 * an app without a grant, or a password typed from anywhere but the vault.
 */
export function assertBrowserStepMayRun(step = {}, { app = '', grants = [], ownerConfirmed = false } = {}) {
  const kind = browserStepKind(step);
  if (!app || !grants.includes(app)) {
    throw refusal(`CHE has no permission to act in ${app || 'that app'} yet. Grant it first.`);
  }
  if (kind === 'credential' && (!step.vault_ref || step.value !== undefined)) {
    throw refusal('A password can only be typed from the on-device vault, never from a value CHE was given.');
  }
  if ((kind === 'spend' || kind === 'delete' || kind === 'signup') && !ownerConfirmed) {
    const reason = { spend: 'Spending money needs your yes first.', delete: 'Deleting or removing needs your yes first.', signup: 'Creating an account needs your yes first. You do the verification step.' }[kind];
    return { held: true, kind, reason };
  }
  return { held: false, kind };
}
