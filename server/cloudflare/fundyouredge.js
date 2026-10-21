// FundYourEdge funded accounts trade on Rithmic, the platform the firm documents
// (TradeSea is one front end). Rithmic's order API is licensed: a developer kit,
// a conformance review and recurring fees before production access. CHE has no
// such connection, so it says so and never invents a balance, position or order.
import { withoutProhibitions } from './owner_action_gate.js';

const FYE = /\bfund\s*your\s*edge\b|\bfundyouredge\b|\bfye\b/i;
// "Close my MNQ position" and "flatten" are orders too (comprehension audit).
const ORDER_VERB = /\b(?:prepare|place|submit|enter|buy|sell|set up|flatten)\b|\bclose\s+(?:out\s+)?(?:my|the|all|that|this)\s+(?:[\w-]+\s+)?positions?\b/i;
// A prohibition is set aside only when it forbids the order itself ("don't place any orders"), never
// when it forbids something else ("Don't ask me, prepare an MNQ order").
const ORDER_FIRST = /^(?:prepare|place|submit|enter|buy|sell|set\s+up|trade|order|execute|short)\b/i;
const FUTURES = /\b(?:mnq|nq|mes|es|nasdaq|s&p)\b/i;

// orderBrokerReady: a broker that can take orders is connected, so a generic
// futures order belongs to that broker's desk and is not refused here.
export function fundyouredgeIntent(message, { orderBrokerReady = false } = {}) {
  const t = String(message || '').trim().replace(/\s+/g, ' ');
  // "Analyze MNQ. Don't place any orders." forbids an order; only what the owner asks for counts.
  const asked = withoutProhibitions(t, { only: ORDER_FIRST });
  if (ORDER_VERB.test(asked) && FYE.test(t)) return { kind: 'order' };
  // "Place a paper trade for 1 MNQ long" goes to CHE's own paper journal, which no broker touches
  // (comprehension audit). A live or real-money order in the same words still gets the refusal.
  const paperOnly = /\bpaper\b/i.test(t) && !/\b(?<!not\s|no\s)(?:live|real[\s-]money|funded)\b/i.test(t);
  if (!orderBrokerReady && ORDER_VERB.test(asked) && FUTURES.test(t) && !paperOnly) return { kind: 'order' };
  if (!FYE.test(t)) return null;
  if (/\b(?:check|show|read|open|status|balance|account|positions?|drawdown|payouts?|p&l)\b/i.test(t)) return { kind: 'account' };
  return null;
}

// The honest spoken reply, or null when the message is not about this account.
export function fundyouredgeReply(message, options = {}) {
  const intent = fundyouredgeIntent(message, options);
  if (!intent) return null;
  if (intent.kind === 'order') {
    return 'I cannot prepare or place an order for FundYourEdge, sir. Its accounts trade on Rithmic, and CHE has no licensed Rithmic order connection. Nothing was prepared or placed.';
  }
  return 'FundYourEdge is not connected, sir. Its accounts trade on Rithmic, and CHE needs a licensed Rithmic connection to read them. Nothing was checked, so I have no balance, drawdown, positions or payout figures to report.';
}
