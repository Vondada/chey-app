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
