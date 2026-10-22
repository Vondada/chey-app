// FundYourEdge funded accounts trade on Rithmic, the platform the firm documents
// (TradeSea is one front end). Rithmic's order API is licensed: a developer kit,
// a conformance review and recurring fees before production access. CHE has no
// such connection, so it says so and never invents a balance, position or order.
//
// Owner (2026-10-22): CHE may PREPARE a read-only trade draft for the owner to copy into a
// trading platform by hand. A draft is never sent, is labelled NOT SUBMITTED, and every price,
// limit or balance it cannot verify is "unknown". Placing, submitting or closing an order stays refused.
import { withoutProhibitions } from './owner_action_gate.js';

const FYE = /\bfund\s*your\s*edge\b|\bfundyouredge\b|\bfye\b/i;
// "Close my MNQ position" and "flatten" are orders too (comprehension audit).
const ORDER_VERB = /\b(?:place|submit|enter|buy|sell|flatten)\b|\bclose\s+(?:out\s+)?(?:my|the|all|that|this)\s+(?:[\w-]+\s+)?positions?\b/i;
// Preparing a draft is not sending one: "prepare", "draft", "preview", "set up", "plan".
const DRAFT_VERB = /\b(?:prepare|draft|preview|set\s+up|plan)\b/i;
// A prohibition is set aside only when it forbids the order itself ("don't place any orders"), never
// when it forbids something else ("Don't ask me, prepare an MNQ order").
const ORDER_FIRST = /^(?:prepare|draft|preview|plan|place|submit|enter|buy|sell|set\s+up|trade|order|execute|short|flatten)\b/i;
const FUTURES = /\b(?:mnq|nq|mes|es|nasdaq|s&p)\b/i;

export const FYE_STATUS = 'NOT SUBMITTED — NO BROKER CONNECTION.';
// USD per index point for each contract (CME contract multipliers). Dollar risk is an estimate from these.
export const FYE_POINT_VALUE = { MNQ: 2, NQ: 20, MES: 5, ES: 50 };
const CONTRACT_NAMES = { MNQ: 'Micro E-mini Nasdaq-100', NQ: 'E-mini Nasdaq-100', MES: 'Micro E-mini S&P 500', ES: 'E-mini S&P 500' };

// orderBrokerReady: a broker that can take orders is connected, so a generic
// futures order belongs to that broker's desk and is not refused here.
export function fundyouredgeIntent(message, { orderBrokerReady = false } = {}) {
  const t = String(message || '').trim().replace(/\s+/g, ' ');
  // "Analyze MNQ. Don't place any orders." forbids an order; only what the owner asks for counts.
  const asked = withoutProhibitions(t, { only: ORDER_FIRST });
  // "Place a paper trade for 1 MNQ long" goes to CHE's own paper journal, which no broker touches
  // (comprehension audit). A live or real-money order in the same words still gets the refusal.
  const paperOnly = /\bpaper\b/i.test(t) && !/\b(?<!not\s|no\s)(?:live|real[\s-]money|funded)\b/i.test(t);
  if (ORDER_VERB.test(asked) && FYE.test(t)) return { kind: 'order' };
  if (!orderBrokerReady && ORDER_VERB.test(asked) && FUTURES.test(t) && !paperOnly) return { kind: 'order' };
  if (DRAFT_VERB.test(asked) && FYE.test(t)) return { kind: 'draft', account: 'FundYourEdge (Rithmic)' };
  if (!orderBrokerReady && DRAFT_VERB.test(asked) && FUTURES.test(t) && !paperOnly) return { kind: 'draft', account: null };
  if (!FYE.test(t)) return null;
  if (/\b(?:check|show|read|open|status|balance|account|positions?|drawdown|payouts?|p&l)\b/i.test(t)) return { kind: 'account' };
  return null;
}

const NUM = String.raw`\$?([\d,]+(?:\.\d+)?)`;
const parseNum = (raw) => (raw == null ? null : Number(String(raw).replace(/,/g, '')));

// The owner's own numbers, read from the words. Anything not said stays null: nothing is looked up or guessed.
function draftFields(message) {
  const t = String(message || '');
  const root = /\b(MNQ|NQ|MES|ES)\b/i.exec(t);
  const side = /\b(short|sell)\b/i.test(t) ? 'short' : /\b(long|buy)\b/i.test(t) ? 'long' : null;
  const qty = /\b(?:long|short|buy|sell)\s+(\d{1,3})\b/i.exec(t) || /\b(\d{1,3})\s*(?:contracts?|lots?|minis?|micros?|mnq|nq|mes|es)\b/i.exec(t);
  return {
    symbol: root ? root[1].toUpperCase() : null,
    side,
    qty: qty ? parseNum(qty[1]) : null,
    entry: parseNum(new RegExp(String.raw`\bentry\s*(?:at|of|@|:)?\s*${NUM}`, 'i').exec(t)?.[1]),
    stop: parseNum(new RegExp(String.raw`\bstop(?:[\s-]?loss)?\s*(?:at|of|@|:)?\s*${NUM}`, 'i').exec(t)?.[1]),
    target: parseNum(new RegExp(String.raw`\b(?:take[\s-]?profit|target|tp)\s*(?:at|of|@|:)?\s*${NUM}`, 'i').exec(t)?.[1]),
  };
}

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/** The read-only draft: every value the owner gave or CHE can state, and "unknown" for the rest. Pure, nothing is sent. */
export function fundyouredgeDraft(message, { account = 'FundYourEdge (Rithmic)' } = {}) {
  const f = draftFields(message);
  const pointValue = f.symbol ? FYE_POINT_VALUE[f.symbol] ?? null : null;
  const riskPoints = f.entry != null && f.stop != null ? Math.abs(f.entry - f.stop) : null;
  const rewardPoints = f.entry != null && f.target != null ? Math.abs(f.target - f.entry) : null;
  const warnings = [];
  if (f.side && f.entry != null && f.stop != null && f.target != null) {
    const ok = f.side === 'long' ? f.stop < f.entry && f.entry < f.target : f.stop > f.entry && f.entry > f.target;
    if (!ok) warnings.push(`Stop and target are on the wrong sides of the entry for a ${f.side}. Check the levels before you enter anything by hand.`);
  }
  const estDollarRisk = riskPoints != null && pointValue != null && f.qty != null ? riskPoints * pointValue * f.qty : null;
  const rr = riskPoints && rewardPoints != null ? rewardPoints / riskPoints : null;
  const known = (v, fmt = String) => (v == null || v === '' ? 'unknown' : fmt(v));
  const rows = [
    { label: 'Account', value: account ?? 'no broker connected' },
    { label: 'Contract', value: f.symbol ? `${CONTRACT_NAMES[f.symbol]} (${f.symbol})` : 'unknown' },
    { label: 'Direction', value: known(f.side) },
    { label: 'Contract quantity', value: known(f.qty) },
    { label: 'Entry', value: known(f.entry), note: f.entry == null ? '' : 'Your number. Not checked against a live quote.' },
    { label: 'Stop-loss', value: known(f.stop) },
    { label: 'Take-profit', value: known(f.target) },
    { label: 'Risk per contract', value: riskPoints == null ? 'unknown' : `${riskPoints} points` },
    { label: 'Risk / reward', value: rr == null ? 'unknown' : `1 : ${rr.toFixed(2)}` },
    { label: 'Estimated dollar risk', value: estDollarRisk == null ? 'unknown' : money(estDollarRisk), note: 'Estimate from the contract multiplier, before fees and slippage.' },
    { label: 'Account balance and buying power', value: 'unknown', note: 'No funded-account connection, so no limit is read or assumed.' },
  ];
  const assumptions = [
    'Nothing is sent. This draft is for you to copy into a trading platform by hand.',
    'Prices are your numbers. No live quote is verified here, so entry and levels may not match the market.',
    pointValue == null ? 'The dollar risk is unknown: the contract multiplier is not known for this symbol.' : `Dollar risk uses ${f.symbol} at $${pointValue} per point (CME contract multiplier).`,
    'Commissions, fees and slippage are not included.',
    'Account balance, buying power and funded-account rules are unknown.',
  ];
  const draft = {
    status: FYE_STATUS,
    account,
    rows,
    assumptions,
    warnings,
    missing: [['contract', f.symbol], ['direction', f.side], ['quantity', f.qty], ['entry', f.entry], ['stop-loss', f.stop], ['take-profit', f.target]]
      .filter(([, v]) => v == null).map(([k]) => k),
    at: new Date().toISOString(),
  };
  draft.copy_text = [FYE_STATUS, ...rows.map((r) => `${r.label}: ${r.value}`), ...warnings.map((w) => `Warning: ${w}`), ...assumptions.map((a) => `Assumption: ${a}`)].join('\n');
  return draft;
}

// The honest spoken reply, or null when the message is not about this account.
export function fundyouredgeReply(message, options = {}) {
  const intent = fundyouredgeIntent(message, options);
  if (!intent) return null;
  if (intent.kind === 'draft') return fundyouredgeDraftReply(fundyouredgeDraft(message, { account: intent.account }));
  if (intent.kind === 'order') {
    return 'I cannot place or submit an order for FundYourEdge, sir. Its accounts trade on Rithmic, and CHE has no licensed Rithmic order connection. Nothing was placed. I can prepare a draft for you to copy by hand.';
  }
  return 'FundYourEdge is not connected, sir. Its accounts trade on Rithmic, and CHE needs a licensed Rithmic connection to read them. Nothing was checked, so I have no balance, drawdown, positions or payout figures to report.';
}

/** What CHE says about a draft it prepared: it names what is unknown and that nothing was sent. */
export function fundyouredgeDraftReply(draft) {
  const unknown = draft.missing.length ? `Still needed from you: ${draft.missing.join(', ')}.` : 'Every field is filled from your words.';
  return `${draft.status} I prepared a draft for you to copy by hand. ${unknown} Account balance and buying power are unknown, and nothing was sent.`;
}
