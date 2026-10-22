// Deterministic team debate: no model call, same input always gives the same
// lines. Each idea gets its proposer's support line, then the Skeptic, the
// Finance Guard and the Security Chief respond. The Skeptic challenges every
// idea. The Finance Guard and the Security Chief challenge any idea that
// proposes money or a public post, because those need the owner's yes.

import { TEAM_ROSTER } from './team_roster.js';

const ROSTER_BY_ID = new Map(TEAM_ROSTER.map((e) => [e.id, e]));

// Money: any payment, purchase, order, subscription, transfer or trade, or a dollar amount.
const MONEY_RE = /\$\s?\d|\b(pay|pays|paying|payment|buy|buying|purchase|order|ordering|subscribe|subscription|transfer|transferring|invest|investing|deposit|withdraw|fund|spend|spending|cost|costs|price|fee|fees|trade|trades|trading)\b/i;

// Public posting: anything that puts the owner's name or work in front of others.
const PUBLIC_RE = /\b(post|posts|posting|publish|publishes|publishing|upload|uploads|uploading|tweet|announce|announces|announcing|go live|publicly|youtube)\b/i;

export function proposesMoneyOrPublicPost(idea) {
  return MONEY_RE.test(idea) || PUBLIC_RE.test(idea);
}

function validate(ideas) {
  if (!Array.isArray(ideas)) throw new TypeError('ideas must be an array of {agentId, idea}');
  for (const item of ideas) {
    if (!item || typeof item !== 'object') throw new TypeError('each idea must be an object');
    if (!ROSTER_BY_ID.has(item.agentId)) throw new TypeError(`unknown agentId: ${item.agentId}`);
    if (typeof item.idea !== 'string' || item.idea.trim() === '') throw new TypeError('idea must be a non-empty string');
  }
}

export function debate(ideas) {
  validate(ideas);
  const lines = [];
  for (const { agentId, idea } of ideas) {
    const text = idea.trim();
    const outbound = proposesMoneyOrPublicPost(text);
    // One line per agent per idea. Map keeps the first position and lets a
    // guard's own line replace its proposer line when the guard proposed it.
    const byAgent = new Map();
    byAgent.set(agentId, {
      agentId,
      stance: 'support',
      reason: `${ROSTER_BY_ID.get(agentId).role} proposes: ${text}`,
    });
    byAgent.set('skeptic', {
      agentId: 'skeptic',
      stance: 'challenge',
      reason: outbound
        ? `Challenge: this moves money or goes public, so the risk and the owner's yes come first: "${text}"`
        : `Challenge: name the evidence and the risk before acting on: "${text}"`,
    });
    byAgent.set('finance_guard', outbound
      ? {
          agentId: 'finance_guard',
          stance: 'challenge',
          reason: `Challenge: money or public posting needs the owner's yes and a cost check against the owner's rules: "${text}"`,
        }
      : {
          agentId: 'finance_guard',
          stance: 'support',
          reason: 'No money moves and nothing goes public in this idea, so no cost check is needed.',
        });
    if (outbound) {
      byAgent.set('security_chief', {
        agentId: 'security_chief',
        stance: 'challenge',
        reason: "Hold: no outbound step until the owner says yes, and no sensitive data leaves the device.",
      });
    }
    lines.push(...byAgent.values());
  }
  return lines;
}
