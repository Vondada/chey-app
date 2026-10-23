// The one place that states every market and cost assumption a CHE backtest uses (owner, 2026-10-23). It reads the
// engine's own constants, so what is shown here is what the engine charges, never a second copy that could drift:
//   contracts and default costs   trading_evidence.js CONTRACTS, COSTS (fillEntry, fillExit, settleTrade)
//   cost profiles                 trading_research.js COST_PROFILES (OPTIMISTIC, NORMAL, STRESS)
//   trading hours and holidays    trading_research.js cmeOpen, cmeCalendar, SESSIONS
// Costs are planning numbers, not a broker's fee schedule: the owner's actual commissions and CME/NFA fees may differ,
// and every trade record stores the values it was charged.
import { CONTRACTS, COSTS } from './trading_evidence.js';
import { COST_PROFILES, SESSIONS, cmeCalendar } from './trading_research.js';

const r2 = (x) => Math.round(x * 100) / 100;

export const CONTRACT_SOURCES = Object.freeze([
  { what: 'MNQ: $2 × Nasdaq-100 index, minimum tick 0.25 index points ($0.50)', url: 'https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.html', accessed: '2026-10-23' },
  { what: 'NQ: $20 × Nasdaq-100 index, minimum tick 0.25 index points ($5.00); CHE\'s existing contract table, its CME page not re-read on 2026-10-23 (cmegroup.com unreachable from the build machine)', url: null, accessed: null },
]);

/** Dollars one contract pays for a round trip under a cost profile: market entry, then a stop or time exit (market)
 * or a target (limit, no slippage). Exactly the arithmetic of fillEntry, fillExit and settleTrade. */
export function roundTripCost(contractId, profile = 'NORMAL', exit = 'stop') {
  const contract = CONTRACTS[contractId];
  const costs = COST_PROFILES[profile] || COSTS;
  if (!contract) return null;
  const tick$ = contract.tick * contract.pointValue;
  const spread = costs.spreadTicks * tick$;                               // half on entry, half on exit
  const slippage = costs.slippageTicks * tick$ * (exit === 'target' ? 1 : 2); // entry always; exit unless a limit target
  const fixed = 2 * (costs.commissionPerSide + costs.feePerSide);
  return { contract: contractId, profile, exit, spread: r2(spread), slippage: r2(slippage), commissions_and_fees: r2(fixed), total: r2(spread + slippage + fixed), points: r2((spread + slippage + fixed) / contract.pointValue) };
}

/** Everything a backtest assumed, attached to each comparison so the owner can read the assumptions beside the result. */
export function marketSpec(year = new Date().getUTCFullYear()) {
  const cal = cmeCalendar(year);
  return {
    contracts: Object.fromEntries(Object.entries(CONTRACTS).map(([id, c]) => [id, { tick: c.tick, point_value: c.pointValue, tick_value: r2(c.tick * c.pointValue) }])),
    contract_sources: CONTRACT_SOURCES,
    cost_profiles: Object.fromEntries(Object.entries(COST_PROFILES).map(([id, p]) => [id, { ...p }])),
    cost_note: 'Planning numbers, not a broker schedule. Spread is paid half on each side; slippage on market entries, stops and time exits; a target is a limit order and pays no slippage.',
    round_trip_examples: ['MNQ', 'NQ'].flatMap((c) => ['OPTIMISTIC', 'NORMAL', 'STRESS'].map((p) => roundTripCost(c, p))),
    fills: 'A signal is read on a closed bar and fills at the next bar open (never the signal close). If one bar touches the stop and the target, the stop is assumed first.',
    hours: 'CME Globex equity index: Sunday 18:00 to Friday 17:00 New York, closed 17:00–18:00 every day. Intraday strategies are flat by 16:55 (15:55 where the rule says so).',
    hours_source: 'trading_research.cmeOpen (CME standard schedule; not re-verified against CME for this year)',
    holidays: { year, closed: [...cal.closed].sort(), early_close_13_00: [...cal.early].sort(), note: 'Computed rules (New Year, Good Friday, Christmas closed; US federal holidays close at 13:00). An unusual exchange closure that is not in these rules is not known to CHE.' },
    sessions: SESSIONS.map((s) => ({ id: s.id, label: s.label })),
    risk_bounds: 'Intraday signals with risk under 6 or over 60 index points are skipped (one contract).',
  };
}
