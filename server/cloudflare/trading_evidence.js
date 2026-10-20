// Trading evidence: deterministic execution, statistics and isolated forward-paper
// portfolios for CHE's NQ/MNQ strategy research. Pure functions over candles, so
// every number can be recomputed from the recorded trades. No model is called per
// trade. Every record states its data quality: daily bars are approximate, and ideas
// that need intraday sessions are reported as untestable until intraday data exists.

export const CONTRACTS = Object.freeze({
  MNQ: { name: 'MNQ', tick: 0.25, pointValue: 2 },
  NQ: { name: 'NQ', tick: 0.25, pointValue: 20 },
});

// Assumed costs: round planning numbers, not a broker's schedule. Each portfolio and
// trade record stores the values it used. A change of costs is a new strategy version,
// so experiments with different costs never share a result.
export const COSTS = Object.freeze({
  spreadTicks: 1,          // full spread; half is paid on each side
  slippageTicks: 1,        // per side on market orders (entries and stop exits)
  commissionPerSide: 1.5,  // dollars per contract per side
  feePerSide: 0.5,         // exchange and regulatory fees per contract per side
});

export const MIN_TRADES = 30;   // below this a result is anecdote, not evidence
export const TARGET_R = 2;      // every candidate targets two times its risk

const r4 = (x) => Math.round(x * 10000) / 10000;
const r2 = (x) => Math.round(x * 100) / 100;
const finite = (x) => Number.isFinite(x);

// ─── Data quality ─────────────────────────────────────────────────────────

// Returns the problems in a candle series. An empty list means it may be used.
export function candleProblems(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return ['no candles'];
  const problems = [];
  candles.forEach((b, i) => {
    if (!b || !b.t || ![b.o, b.h, b.l, b.c].every(finite)) {
      problems.push(`bar ${i} is missing a time or a numeric price`);
      return;
    }
    if (b.l > b.h || b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c)) problems.push(`bar ${i} has an impossible range`);
    if (i > 0 && !(b.t > candles[i - 1].t)) problems.push(`bar ${i} is not after the bar before it`);
  });
  return problems.slice(0, 10);
}

// ─── Execution ────────────────────────────────────────────────────────────

// Market buy at the next bar's open: half the spread and slippage are paid.
// A short sells at the bid: half the spread and slippage come off the open.
export function fillEntry(bar, contract, costs = COSTS, side = 'long') {
  const half = (costs.spreadTicks * contract.tick) / 2;
  const slip = costs.slippageTicks * contract.tick;
  const price = side === 'short' ? bar.o - half - slip : bar.o + half + slip;
  return { raw: bar.o, price: r4(price), spread: half, slippage: slip };
}

// A stop is a market sell: half the spread and slippage. A target is a resting limit
// sell: half the spread only, because it cannot fill worse than its price.
// A time exit is a market order like a stop. A short covers by buying at the ask.
export function fillExit(price, reason, contract, costs = COSTS, side = 'long') {
  const half = (costs.spreadTicks * contract.tick) / 2;
  const slip = reason === 'target' ? 0 : costs.slippageTicks * contract.tick;
  const fill = side === 'short' ? price + half + slip : price - half - slip;
  return { raw: price, price: r4(fill), spread: half, slippage: slip };
}

// Decides whether a bar closes a long trade. Stops are market orders and fill at the
// open when the market gapped through them. Targets are limits and fill at the open
// when it gapped above them. If one bar touches both, the stop is assumed first
// (conservative) and the record says so.
// A position with `exit_by` (intraday: flat before the CME daily break) closes at the
// open of the first bar at or after that time, if neither stop nor target came first.
export function exitOn(pos, bar, contract, costs = COSTS) {
  const side = pos.side || 'long';
  if (pos.exit_by && bar.t >= pos.exit_by) {
    return { reason: 'time', exit: fillExit(bar.o, 'time', contract, costs, side), same_bar_both: false };
  }
  if (side === 'short') {
    const stopHit = bar.h >= pos.stop;
    const targetHit = bar.l <= pos.target;
    if (stopHit) return { reason: 'stop', exit: fillExit(Math.max(bar.o, pos.stop), 'stop', contract, costs, side), same_bar_both: targetHit };
    if (targetHit) return { reason: 'target', exit: fillExit(Math.min(bar.o, pos.target), 'target', contract, costs, side), same_bar_both: false };
    return null;
  }
  const stopHit = bar.l <= pos.stop;
  const targetHit = bar.h >= pos.target;
  if (stopHit) return { reason: 'stop', exit: fillExit(Math.min(bar.o, pos.stop), 'stop', contract, costs), same_bar_both: targetHit };
  if (targetHit) return { reason: 'target', exit: fillExit(Math.max(bar.o, pos.target), 'target', contract, costs), same_bar_both: false };
  return null;
}

// Long or short (position.side). Costs are in dollars for `qty` contracts.
export function settleTrade(position, exit, qty, contract, costs = COSTS) {
  const pv = contract.pointValue * qty;
  const dir = position.side === 'short' ? -1 : 1;
  const gross = dir * (exit.raw - position.entry.raw) * pv;
  const spread = (position.entry.spread + exit.spread) * pv;
  const slippage = (position.entry.slippage + exit.slippage) * pv;
  const commissions = 2 * qty * costs.commissionPerSide;
  const fees = 2 * qty * costs.feePerSide;
  const net = gross - spread - slippage - commissions - fees;
  const riskDollars = dir * (position.entry.raw - position.stop) * pv;
  return {
    gross_before_costs: r2(gross),
    costs: { spread: r2(spread), slippage: r2(slippage), commissions: r2(commissions), fees: r2(fees) },
    net_pnl: r2(net),
    r_gross: riskDollars > 0 ? r4(gross / riskDollars) : 0,
    r_net: riskDollars > 0 ? r4(net / riskDollars) : 0,
    risk_dollars: r2(riskDollars),
  };
}

// ─── Sessions ─────────────────────────────────────────────────────────────

// New York session of an intraday bar. Daily bars are simply 'daily'.
export function sessionOf(time, resolution = 'daily') {
  if (resolution === 'daily' || !/T\d/.test(String(time))) return 'daily';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(time)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (mins === 510) return 'econ-0830';          // the 8:30 AM release bar
  if (mins < 570) return 'pre-open';             // before 9:30 AM
  if (mins < 600) return 'opening-30m';
  if (mins < 780) return 'mid-morning';
  if (mins < 960) return 'afternoon';
  return 'close-and-overnight';
}

// ─── Causal indicators: each value uses only bars up to and including its own bar ─

// A swing low at bar j needs swingN bars after it, so it is known only once bar j + swingN closes.
function isSwingLow(c, j, n) {
  for (let m = j - n; m <= j + n; m++) if (m !== j && c[m].l <= c[j].l) return false;
  return true;
}

export function causalContext(candles, { swingN = 3, atrN = 14, smaN = 50 } = {}) {
  const n = candles.length;
  const atr14 = new Array(n).fill(null);
  const sma50 = new Array(n).fill(null);
  const lastLow = new Array(n).fill(null);
  const tr = candles.map((b, i) => (i === 0
    ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - candles[i - 1].c), Math.abs(b.l - candles[i - 1].c))));
  let trSum = 0;
  let closeSum = 0;
  let confirmedLow = null;
  for (let i = 0; i < n; i++) {
    trSum += tr[i];
    if (i >= atrN) trSum -= tr[i - atrN];
    if (i >= atrN - 1) atr14[i] = trSum / atrN;
    closeSum += candles[i].c;
    if (i >= smaN) closeSum -= candles[i - smaN].c;
    if (i >= smaN - 1) sma50[i] = closeSum / smaN;
    const j = i - swingN;
    if (j - swingN >= 0 && isSwingLow(candles, j, swingN)) confirmedLow = candles[j].l;
    lastLow[i] = confirmedLow;
  }
  return { atr14, sma50, lastLow };
}

// ─── Candidate strategies (long-only, closed bars only) ───────────────────

export const CANDIDATES = Object.freeze({
  'pdh-break': {
    name: 'previous-day high break',
    entry(c, i) {
      if (i < 2 || !(c[i].c > c[i - 1].h && c[i - 1].c <= c[i - 2].h)) return null;
      return { ref: c[i].c, stop: c[i].l - 0.25, why: `closed above the previous high ${r2(c[i - 1].h)}` };
    },
  },
  'sweep-reclaim': {
    name: 'liquidity sweep and reclaim',
    entry(c, i, x) {
      const level = x.lastLow[i - 1];
      if (level == null || !(c[i].l < level && c[i].c > level && c[i].c > c[i].o)) return null;
      return { ref: c[i].c, stop: c[i].l - 0.25, why: `swept the swing low ${r2(level)} and closed back above it` };
    },
  },
  'fvg-retest': {
    name: 'fair value gap retest',
    entry(c, i) {
      if (i < 4 || !(c[i].c > c[i].o)) return null;
      for (let j = i - 2; j >= Math.max(0, i - 10); j--) {
        if (!(c[j].h < c[j + 2].l)) continue;            // bullish gap between bars j and j+2
        const top = c[j + 2].l;
        const bottom = c[j].h;
        if (c[i].l <= top && c[i].c >= bottom) {
          if (c.slice(j + 3, i).some((k) => k.l <= bottom)) return null;   // only an unfilled gap's first retest counts
          return { ref: c[i].c, stop: bottom - 0.25, why: `retested the bullish gap ${r2(bottom)} to ${r2(top)}` };
        }
      }
      return null;
    },
  },
  'displacement-continuation': {
    name: 'displacement continuation',
    entry(c, i, x) {
      if (i < 2) return null;
      const d = c[i - 1];
      const atr = x.atr14[i - 1];
      if (atr == null || !(d.c > d.o && d.c - d.o >= 1.5 * atr && c[i].c > d.h)) return null;
      return { ref: c[i].c, stop: d.l, why: `broke above a displacement bar of ${r2(d.c - d.o)} points` };
    },
  },
  'order-block-retest': {
    name: 'order block retest',
    entry(c, i, x) {
      if (i < 3) return null;
      const d = c[i - 1];
      const atr = x.atr14[i - 1];
      if (atr == null || !(d.c > d.o && d.c - d.o >= 1.5 * atr)) return null;
      let block = null;
      for (let b = i - 2; b >= Math.max(0, i - 6); b--) if (c[b].c < c[b].o) { block = c[b]; break; }
      if (!block || !(c[i].l <= block.h && c[i].c >= block.l && c[i].c > c[i].o)) return null;
      return { ref: c[i].c, stop: block.l - 0.25, why: `retested the last down candle before a displacement, ${r2(block.l)} to ${r2(block.h)}` };
    },
  },
});

// Ideas that cannot be tested on daily bars. They are reported as untestable, never estimated.
export const NEEDS_INTRADAY = Object.freeze({
  'opening-range-breakout': 'needs 9:30 AM New York intraday bars',
  'vwap-deviation': 'needs an intraday session VWAP',
  'session-levels': 'needs intraday session highs and lows',
});

export const FILTERS = Object.freeze({
  any: { name: 'any trend', ok: () => true },
  above50: { name: 'above the 50-day average', ok: (c, i, x) => x.sma50[i] != null && c[i].c > x.sma50[i] },
});

// ─── Intraday (5-minute) context and candidates ──────────────────────────
// Every value at bar i uses bars up to and including bar i only (no future data, no
// repainting). Times are New York; the CME trading day starts at 18:00 New York.
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function etParts(time) {
  const p = ET.formatToParts(new Date(time)).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return { day: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute) };
}
// Minutes since the CME day opened at 18:00 New York (0 … 1379; the break is 17:00–18:00).
export const tradeMins = (etMins) => (etMins - 1080 + 1440) % 1440;
export function tradeDayOf(time) {
  const { day, mins } = etParts(time);
  if (mins < 1080) return day;
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const FLAT_TD = tradeMins(16 * 60 + 55); // flat by 16:55 New York, before the daily break
const isSwingHigh = (c, j, n) => {
  for (let m = j - n; m <= j + n; m++) if (m !== j && c[m].h >= c[j].h) return false;
  return true;
};
export function intradayContext(candles, { swingN = 3 } = {}) {
  const base = causalContext(candles, { swingN, atrN: 14, smaN: 50 });
  const n = candles.length;
  const ema = (len) => {
    const out = new Array(n).fill(null);
    const k = 2 / (len + 1);
    let v = null;
    for (let i = 0; i < n; i++) {
      v = v == null ? candles[i].c : candles[i].c * k + v * (1 - k);
      if (i >= len - 1) out[i] = v;
    }
    return out;
  };
  const ema20 = ema(20);
  const ema50 = ema(50);
  const rsi14 = new Array(n).fill(null);
  let gain = 0; let loss = 0;
  for (let i = 1; i < n; i++) {
    const ch = candles[i].c - candles[i - 1].c;
    const g = Math.max(0, ch); const l = Math.max(0, -ch);
    if (i <= 14) { gain += g / 14; loss += l / 14; } else { gain = (gain * 13 + g) / 14; loss = (loss * 13 + l) / 14; }
    if (i >= 14) rsi14[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  const lastHigh = new Array(n).fill(null);
  let confirmedHigh = null;
  const day = []; const td = []; const et = [];
  const vwap = new Array(n).fill(null); const vwapSd = new Array(n).fill(null); const sessionBars = new Array(n).fill(0);
  const orHigh = new Array(n).fill(null); const orLow = new Array(n).fill(null);
  const pdh = new Array(n).fill(null); const pdl = new Array(n).fill(null);
  let pv = 0; let vol = 0; let pv2 = 0; let count = 0;
  let curDay = null; let dayHigh = -Infinity; let dayLow = Infinity; let prevHigh = null; let prevLow = null;
  let orH = null; let orL = null; let orDay = null;
  for (let i = 0; i < n; i++) {
    const b = candles[i];
    const parts = etParts(b.t);
    et.push(parts.mins);
    td.push(tradeMins(parts.mins));
    const dkey = tradeDayOf(b.t);
    day.push(dkey);
    if (dkey !== curDay) {
      if (curDay !== null) { prevHigh = dayHigh; prevLow = dayLow; }
      curDay = dkey; dayHigh = -Infinity; dayLow = Infinity; pv = 0; vol = 0; pv2 = 0; count = 0;
    }
    dayHigh = Math.max(dayHigh, b.h); dayLow = Math.min(dayLow, b.l);
    pdh[i] = prevHigh; pdl[i] = prevLow;
    const w = b.v > 0 ? b.v : 1;
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * w; vol += w; pv2 += tp * tp * w; count += 1;
    vwap[i] = pv / vol;
    vwapSd[i] = Math.sqrt(Math.max(0, pv2 / vol - vwap[i] * vwap[i]));
    sessionBars[i] = count;
    // Opening range 9:30–9:45 New York, known once the 9:40 bar has closed.
    if (parts.mins >= 570 && parts.mins < 585) {
      if (orDay !== parts.day) { orDay = parts.day; orH = b.h; orL = b.l; } else { orH = Math.max(orH, b.h); orL = Math.min(orL, b.l); }
    }
    if (orDay === parts.day && parts.mins >= 585) { orHigh[i] = orH; orLow[i] = orL; }
    const j = i - swingN;
    if (j - swingN >= 0 && isSwingHigh(candles, j, swingN)) confirmedHigh = candles[j].h;
    lastHigh[i] = confirmedHigh;
  }
  return { ...base, ema20, ema50, rsi14, lastHigh, day, td, et, vwap, vwapSd, sessionBars, orHigh, orLow, pdh, pdl };
}
// Risk bounds in index points: below the floor, costs are most of the risk (MNQ's round
// trip is about 2.5 points); above the ceiling, one trade risks too much of a small account.
const MIN_RISK = 6;
const MAX_RISK = 60;
const sized = (sig) => {
  const risk = Math.abs(sig.ref - sig.stop);
  return risk >= MIN_RISK && risk <= MAX_RISK ? sig : null;
};
// Fair value gaps between bars j and j+2, newest first, that no later bar has filled.
function openGaps(c, i, from) {
  const out = [];
  // The gap's third bar must close before the retest bar: the bar that creates a gap is not its retest.
  for (let j = i - 3; j >= Math.max(from, i - 14); j--) {
    if (c[j].h < c[j + 2].l) {
      const bottom = c[j].h; const top = c[j + 2].l;
      if (top - bottom >= 0.5 && !c.slice(j + 3, i).some((k) => k.l <= top)) out.push({ side: 'long', bottom, top, j });
    } else if (c[j].l > c[j + 2].h) {
      const top = c[j].l; const bottom = c[j + 2].h;
      if (top - bottom >= 0.5 && !c.slice(j + 3, i).some((k) => k.h >= bottom)) out.push({ side: 'short', bottom, top, j });
    }
  }
  return out;
}
function gapRetest(c, i, gaps, label) {
  for (const g of gaps) {
    if (g.side === 'long' && c[i].l <= g.top && c[i].c >= g.bottom && c[i].c > c[i].o) {
      return sized({ side: 'long', ref: c[i].c, stop: g.bottom - 0.25, why: `${label}: first retest of the bullish gap ${r2(g.bottom)}–${r2(g.top)} closed up` });
    }
    if (g.side === 'short' && c[i].h >= g.bottom && c[i].c <= g.top && c[i].c < c[i].o) {
      return sized({ side: 'short', ref: c[i].c, stop: g.top + 0.25, why: `${label}: first retest of the bearish gap ${r2(g.bottom)}–${r2(g.top)} closed down` });
    }
  }
  return null;
}
export const INTRADAY_COMMON_RULES = 'All strategies: entries are market orders at the next bar open, checked after costs; a signal with risk under 6 or over 60 index points is skipped; positions are flat by 16:55 New York, before the CME daily break; one position per portfolio.';
const inSilverBullet = (m) => (m >= 600 && m < 660) || (m >= 840 && m < 900);
export const INTRADAY_CANDIDATES = Object.freeze({
  'fvg-retest-5m': {
    name: 'fair value gap retest', family: 'ICT',
    rules: 'Gap: bar 1 high below bar 3 low (bullish) or bar 1 low above bar 3 high (bearish), at least 2 ticks, unfilled. Entry: the first bar that trades into the gap and closes in its direction; market order at the next open. Stop: 1 tick beyond the far side of the gap. Target: the R multiple of the portfolio. Flat by 16:55 New York.',
    entry: (c, i) => (i < 4 ? null : gapRetest(c, i, openGaps(c, i, 0), 'FVG')),
  },
  'silver-bullet-5m': {
    name: 'ICT Silver Bullet', family: 'ICT',
    rules: 'Only 10:00–11:00 and 14:00–15:00 New York. A fair value gap formed inside the window, first retest closing in its direction. Stop beyond the gap; target the R multiple.',
    entry(c, i, x) {
      if (i < 4 || !inSilverBullet(x.et[i])) return null;
      const gaps = openGaps(c, i, 0).filter((g) => inSilverBullet(x.et[g.j + 2]) && x.day[g.j + 2] === x.day[i]);
      return gapRetest(c, i, gaps, 'Silver Bullet FVG');
    },
  },
  'sweep-mss-5m': {
    name: 'liquidity sweep then market structure shift', family: 'ICT',
    rules: 'Long: within the last 12 bars a bar traded below the last confirmed swing low (the sweep); now, for the first time since, a bar closes above the last confirmed swing high before the sweep (the shift). Short: mirror. Stop 1 tick beyond the sweep extreme.',
    entry(c, i, x) {
      if (i < 3) return null;
      for (let k = i - 1; k >= Math.max(1, i - 12); k--) {
        const low = x.lastLow[k - 1]; const high = x.lastHigh[k - 1];
        if (low != null && c[k].l < low && high != null && c[i].c > high && !c.slice(k, i).some((b) => b.c > high)) {
          const extreme = Math.min(...c.slice(k, i + 1).map((b) => b.l));
          return sized({ side: 'long', ref: c[i].c, stop: extreme - 0.25, why: `swept the swing low ${r2(low)}, then closed above the swing high ${r2(high)} (structure shift)` });
        }
        if (high != null && c[k].h > high && low != null && c[i].c < low && !c.slice(k, i).some((b) => b.c < low)) {
          const extreme = Math.max(...c.slice(k, i + 1).map((b) => b.h));
          return sized({ side: 'short', ref: c[i].c, stop: extreme + 0.25, why: `swept the swing high ${r2(high)}, then closed below the swing low ${r2(low)} (structure shift)` });
        }
      }
      return null;
    },
  },
  'sweep-reclaim-5m': {
    name: 'liquidity sweep and reclaim', family: 'ICT',
    rules: 'Long: the bar trades below the last confirmed swing low, closes back above it and above the prior bar high. Short: mirror at the last swing high. Stop 1 tick beyond the sweep extreme.',
    entry(c, i, x) {
      if (i < 2) return null;
      const low = x.lastLow[i - 1]; const high = x.lastHigh[i - 1];
      if (low != null && c[i].l < low && c[i].c > low && c[i].c > c[i - 1].h) {
        return sized({ side: 'long', ref: c[i].c, stop: c[i].l - 0.25, why: `swept the swing low ${r2(low)}, closed back above it and above the prior high (structure shift)` });
      }
      if (high != null && c[i].h > high && c[i].c < high && c[i].c < c[i - 1].l) {
        return sized({ side: 'short', ref: c[i].c, stop: c[i].h + 0.25, why: `swept the swing high ${r2(high)}, closed back below it and below the prior low (structure shift)` });
      }
      return null;
    },
  },
  'pdhl-sweep-5m': {
    name: 'previous-day high/low sweep', family: 'ICT',
    rules: 'Long: the first bar of the CME day to trade below the previous day low and close back above it. Short: mirror at the previous day high. Stop 1 tick beyond the bar extreme.',
    entry(c, i, x) {
      if (i < 1 || x.pdl[i] == null) return null;
      const today = (k) => x.day[k] === x.day[i];
      const earlier = (test) => { for (let k = i - 1; k >= 0 && today(k); k--) if (test(k)) return true; return false; };
      if (c[i].l < x.pdl[i] && c[i].c > x.pdl[i] && !earlier((k) => c[k].l < x.pdl[i])) {
        return sized({ side: 'long', ref: c[i].c, stop: c[i].l - 0.25, why: `swept the previous day low ${r2(x.pdl[i])} and closed back above it` });
      }
      if (c[i].h > x.pdh[i] && c[i].c < x.pdh[i] && !earlier((k) => c[k].h > x.pdh[i])) {
        return sized({ side: 'short', ref: c[i].c, stop: c[i].h + 0.25, why: `swept the previous day high ${r2(x.pdh[i])} and closed back below it` });
      }
      return null;
    },
  },
  'order-block-5m': {
    name: 'order block retest', family: 'ICT',
    rules: 'A displacement bar (body at least 1.5 ATR). Long: the last down bar before an up displacement is the block; the next bar trades into it and closes up. Short: mirror. Stop 1 tick beyond the block.',
    entry(c, i, x) {
      if (i < 3) return null;
      const d = c[i - 1]; const atr = x.atr14[i - 1];
      if (atr == null || Math.abs(d.c - d.o) < 1.5 * atr) return null;
      const up = d.c > d.o;
      let block = null;
      for (let b = i - 2; b >= Math.max(0, i - 6); b--) if (up ? c[b].c < c[b].o : c[b].c > c[b].o) { block = c[b]; break; }
      if (!block) return null;
      if (up && c[i].l <= block.h && c[i].c >= block.l && c[i].c > c[i].o) {
        return sized({ side: 'long', ref: c[i].c, stop: block.l - 0.25, why: `retested the bullish order block ${r2(block.l)}–${r2(block.h)} after a displacement` });
      }
      if (!up && c[i].h >= block.l && c[i].c <= block.h && c[i].c < c[i].o) {
        return sized({ side: 'short', ref: c[i].c, stop: block.h + 0.25, why: `retested the bearish order block ${r2(block.l)}–${r2(block.h)} after a displacement` });
      }
      return null;
    },
  },
  'orb-15m': {
    name: 'opening range breakout (9:30–9:45 New York)', family: 'Breakout',
    rules: 'Range: high and low of 9:30–9:45 New York. Entry: the first 5-minute close above the high (long) or below the low (short) between 9:45 and 11:30. Stop: the middle of the range. Target: the R multiple of the portfolio. Flat by 15:55 New York.',
    flat: tradeMins(15 * 60 + 55),
    entry(c, i, x) {
      if (x.orHigh[i] == null || x.et[i] < 585 || x.et[i] >= 690) return null;
      const mid = (x.orHigh[i] + x.orLow[i]) / 2;
      const before = (test) => { for (let k = i - 1; k >= 0 && x.day[k] === x.day[i] && x.et[k] >= 585; k--) if (test(k)) return true; return false; };
      if (c[i].c > x.orHigh[i] && !before((k) => c[k].c > x.orHigh[i])) {
        return sized({ side: 'long', ref: c[i].c, stop: mid, why: `closed above the opening range high ${r2(x.orHigh[i])}` });
      }
      if (c[i].c < x.orLow[i] && !before((k) => c[k].c < x.orLow[i])) {
        return sized({ side: 'short', ref: c[i].c, stop: mid, why: `closed below the opening range low ${r2(x.orLow[i])}` });
      }
      return null;
    },
  },
  'vwap-revert-5m': {
    name: 'VWAP 2-sigma reversion', family: 'Mean reversion',
    rules: 'Session VWAP from 18:00 New York. Long: a close below VWAP minus 2 standard deviations, then a close back inside on an up bar. Short: mirror. Stop 1 tick beyond the two-bar extreme. Target: VWAP.',
    entry(c, i, x) {
      if (i < 1 || x.sessionBars[i] < 12 || x.day[i - 1] !== x.day[i]) return null;
      const lo = (k) => x.vwap[k] - 2 * x.vwapSd[k]; const hi = (k) => x.vwap[k] + 2 * x.vwapSd[k];
      if (c[i - 1].c < lo(i - 1) && c[i].c > lo(i) && c[i].c > c[i].o && x.vwap[i] > c[i].c) {
        return sized({ side: 'long', ref: c[i].c, stop: Math.min(c[i].l, c[i - 1].l) - 0.25, target: r2(x.vwap[i]), why: `closed back inside the lower 2σ band toward VWAP ${r2(x.vwap[i])}` });
      }
      if (c[i - 1].c > hi(i - 1) && c[i].c < hi(i) && c[i].c < c[i].o && x.vwap[i] < c[i].c) {
        return sized({ side: 'short', ref: c[i].c, stop: Math.max(c[i].h, c[i - 1].h) + 0.25, target: r2(x.vwap[i]), why: `closed back inside the upper 2σ band toward VWAP ${r2(x.vwap[i])}` });
      }
      return null;
    },
  },
  'ema-pullback-5m': {
    name: 'trend pullback to the 20 EMA', family: 'Trend',
    rules: 'Long: 20 EMA above the 50 EMA and rising; the bar touches the 20 EMA and closes above it on an up bar. Short: mirror. Stop 1 tick beyond the two-bar extreme.',
    entry(c, i, x) {
      if (i < 4 || x.ema50[i] == null) return null;
      const e = x.ema20[i];
      if (e > x.ema50[i] && e > x.ema20[i - 3] && c[i].l <= e && c[i].c > e && c[i].c > c[i].o) {
        return sized({ side: 'long', ref: c[i].c, stop: Math.min(c[i].l, c[i - 1].l) - 0.25, why: `uptrend pullback held the 20 EMA ${r2(e)}` });
      }
      if (e < x.ema50[i] && e < x.ema20[i - 3] && c[i].h >= e && c[i].c < e && c[i].c < c[i].o) {
        return sized({ side: 'short', ref: c[i].c, stop: Math.max(c[i].h, c[i - 1].h) + 0.25, why: `downtrend pullback rejected the 20 EMA ${r2(e)}` });
      }
      return null;
    },
  },
  'rsi-revert-5m': {
    name: 'RSI 30/70 reversal', family: 'Mean reversion',
    rules: 'Long: RSI(14) crosses back above 30 on an up bar. Short: crosses back below 70 on a down bar. Stop 1 tick beyond the six-bar extreme.',
    entry(c, i, x) {
      if (i < 6 || x.rsi14[i - 1] == null || x.rsi14[i] == null) return null;
      const last6 = c.slice(i - 5, i + 1);
      if (x.rsi14[i - 1] < 30 && x.rsi14[i] >= 30 && c[i].c > c[i].o) {
        return sized({ side: 'long', ref: c[i].c, stop: Math.min(...last6.map((b) => b.l)) - 0.25, why: `RSI crossed back above 30 (${r2(x.rsi14[i])})` });
      }
      if (x.rsi14[i - 1] > 70 && x.rsi14[i] <= 70 && c[i].c < c[i].o) {
        return sized({ side: 'short', ref: c[i].c, stop: Math.max(...last6.map((b) => b.h)) + 0.25, why: `RSI crossed back below 70 (${r2(x.rsi14[i])})` });
      }
      return null;
    },
  },
});
export const INTRADAY_FILTERS = Object.freeze({
  any: { name: 'any trend', ok: () => true },
  trend: { name: 'with the 50 EMA trend', ok: (c, i, x, side) => x.ema50[i] != null && x.ema50[i - 3] != null
    && (side === 'short' ? c[i].c < x.ema50[i] && x.ema50[i] < x.ema50[i - 3] : c[i].c > x.ema50[i] && x.ema50[i] > x.ema50[i - 3]) },
});
const candidateOf = (id) => CANDIDATES[id] || INTRADAY_CANDIDATES[id];
const filterOf = (id) => FILTERS[id] || INTRADAY_FILTERS[id];

function conditionOf(c, k, x) {
  const trend = x.sma50[k] == null ? 'no-trend-data' : c[k].c > x.sma50[k] ? 'above-50d' : 'below-50d';
  const recent = x.atr14.slice(Math.max(0, k - 50), k).filter((v) => v != null);
  const avg = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : null;
  const volatility = x.atr14[k] == null || avg == null ? 'unknown' : x.atr14[k] > 1.5 * avg ? 'high-vol' : 'normal-vol';
  return { trend, volatility };
}

// Bump this whenever an entry, filter, fill or exit rule changes. The rule code is not in the
// hash, so without a bump a changed rule would keep loading the old portfolio state and its journal.
export const ENGINE_VERSION = 'evidence-2'; // 2: plans are checked on the fill after costs; FVG retests start after the gap

// A deterministic version: the same engine, candidate, filter, parameters and costs always give the same version.
export function strategyVersion(candidateId, filterId, params = {}) {
  const text = JSON.stringify({ engine: ENGINE_VERSION, candidateId, filterId, params });
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `v-${h.toString(16).padStart(8, '0')}`;
}

// ─── Portfolios: one isolated state per strategy version and source ───────

export function newPortfolio(candidateId, filterId, {
  contract = 'MNQ', qty = 1, source = 'paper', resolution = 'daily', priceSeries = 'unknown', costs = {}, params = {},
} = {}) {
  if (!candidateOf(candidateId)) throw new Error(`unknown candidate ${candidateId}`);
  if (!filterOf(filterId)) throw new Error(`unknown filter ${filterId}`);
  if (!CONTRACTS[contract]) throw new Error(`unknown contract ${contract}`);
  if (!['backtest', 'paper'].includes(source)) throw new Error(`source ${source} is not a research environment`);
  if (!(qty > 0)) throw new Error('quantity must be positive');
  const fullCosts = { ...COSTS, ...costs };
  const fullParams = { target_r: TARGET_R, ...params };
  const version = strategyVersion(candidateId, filterId, { ...fullParams, contract, qty, costs: fullCosts });
  return {
    key: `${candidateId}|${filterId}@${version}`,
    candidate: candidateId, filter: filterId, strategy_version: version,
    contract, qty, source, resolution, price_series: priceSeries, costs: fullCosts, params: fullParams,
    open: null, pending: null, last_bar_time: null,
    counts: { bars: 0, signals: 0, filled: 0, gap_skipped: 0, closed: 0 },
  };
}

// Processes each new bar in time order. A signal is read from the closed bar; the
// trade fills at the next bar's open. Returns the trades that closed in this step.
// Portfolio state persists, so a later step continues where this one stopped.
// A skipped or blocked signal is kept with its reason (live portfolios carry a skips list).
function noteSkip(pf, time, reason, sig) {
  if (!Array.isArray(pf.skips)) return;
  pf.skips = [...pf.skips, { time, reason, side: sig?.side || 'long', why: sig?.why || '' }].slice(-40);
}

/**
 * `gate(pf, {stage, time, day})`, when given, is the owner's controls (trading_controls.js): it is
 * asked before a signal becomes an order ('signal') and before that order fills ('fill'), and
 * returns null to allow or the reason it is blocked. A blocked signal is never traded and is kept
 * with its reason; nothing is ever entered to fill a quota.
 *
 * `allowEntries: false` is the real-time evidence gate (trading_live.js): while the feed is not
 * fresh, authenticated and subscribed real-time delivery, no new signal is taken and a pending
 * order is cancelled before it fills. Open positions are still managed to their exit.
 */
export function stepPortfolio(pf, candles, ctx = causalContext(candles), gate = null, { allowEntries = true } = {}) {
  const problems = candleProblems(candles);
  if (problems.length) throw new Error(`candles refused: ${problems.join('; ')}`);
  const cand = candidateOf(pf.candidate);
  const filter = filterOf(pf.filter);
  const contract = CONTRACTS[pf.contract];
  const closed = [];
  const start = pf.last_bar_time == null ? 0 : candles.findIndex((b) => b.t > pf.last_bar_time);
  if (start < 0) return closed;
  for (let k = start; k < candles.length; k++) {
    const bar = candles[k];
    if (!allowEntries && pf.pending) {
      noteSkip(pf, pf.pending.signal_time, 'the order was cancelled before it filled: no verified real-time market data', pf.pending);
      pf.pending = null; pf.counts.blocked_entries = (pf.counts.blocked_entries || 0) + 1;
    }
    if (pf.pending && !pf.open) {
      const sig = pf.pending;
      pf.pending = null;
      // The open may already have passed the planned stop or target. Then the plan is void: skip, never invent a fill.
      const side = sig.side || 'long';
      // Checked on the fill after costs, the price the trade would really have.
      const fill = fillEntry(bar, contract, pf.costs, side).price;
      const inside = side === 'short' ? fill < sig.stop && fill > sig.target : fill > sig.stop && fill < sig.target;
      // An intraday plan is void across the CME daily break: it never fills at the next session's open.
      const sameDay = !ctx.day || !sig.trade_day || ctx.day[k] === sig.trade_day;
      const blocked = gate ? gate(pf, { stage: 'fill', time: bar.t, day: ctx.day?.[k] }) : null;
      if (blocked) {
        pf.counts.skipped = (pf.counts.skipped || 0) + 1;
        noteSkip(pf, sig.signal_time, `the order was cancelled before it filled: ${blocked}`, sig);
      } else if (inside && sameDay) {
        pf.open = {
          side, signal_time: sig.signal_time, signal_why: sig.why, signal_ref: sig.ref, condition: sig.condition,
          entry_feed: pf.feed ? structuredClone(pf.feed) : null,
          entry_time: bar.t, entry: fillEntry(bar, contract, pf.costs, side), stop: sig.stop, target: sig.target,
          max_high: bar.o, min_low: bar.o, session: sessionOf(bar.t, pf.resolution),
          ...(sig.trade_day ? { trade_day: sig.trade_day, flat_td: sig.flat_td } : {}),
        };
        pf.counts.filled += 1;
      } else {
        pf.counts.gap_skipped += 1;
        noteSkip(pf, sig.signal_time, sameDay ? 'the next bar opened past the stop or target, so the plan was void' : 'the plan could not fill before the CME daily break', sig);
      }
    }
    if (pf.open) {
      // Intraday: flat at the open of the first bar past the portfolio's flat time or in a new CME day.
      const flatten = pf.open.trade_day && ctx.day && (ctx.day[k] !== pf.open.trade_day || ctx.td[k] >= pf.open.flat_td);
      const hit = flatten
        ? { reason: 'time', exit: fillExit(bar.o, 'time', contract, pf.costs, pf.open.side), same_bar_both: false, gap: ctx.day[k] !== pf.open.trade_day }
        : exitOn(pf.open, bar, contract, pf.costs);
      if (!flatten) {
        pf.open.max_high = Math.max(pf.open.max_high, bar.h);
        pf.open.min_low = Math.min(pf.open.min_low, bar.l);
      }
      if (hit) { closed.push(closeAt(pf, bar, hit)); pf.last_exit_time = bar.t; }
    }
    const late = ctx.td && ctx.td[k] >= FLAT_TD - 5;
    if (allowEntries && !pf.open && !pf.pending && cand && !late) {
      const sig = cand.entry(candles, k, ctx);
      const side = sig?.side || 'long';
      const risk = sig ? (side === 'short' ? sig.stop - sig.ref : sig.ref - sig.stop) : 0;
      const filterOk = sig && finite(sig.ref) && finite(sig.stop) && risk >= 0.25 && filter.ok(candles, k, ctx, side);
      if (sig && !filterOk) noteSkip(pf, bar.t, risk < 0.25 ? 'the stop was too close to the entry' : `the ${pf.filter} filter refused it: the signal was not ${filter.name || 'allowed'}`, { side, why: sig.why });
      if (filterOk) {
        const R = pf.params?.target_r ?? TARGET_R;
        const target = finite(sig.target) ? sig.target : r4(side === 'short' ? sig.ref - R * risk : sig.ref + R * risk);
        const reward = side === 'short' ? sig.ref - target : target - sig.ref;
        const blocked = reward >= 0.5 && gate ? gate(pf, { stage: 'signal', time: bar.t, day: ctx.day?.[k] }) : null;
        if (reward < 0.5) noteSkip(pf, bar.t, 'the target was too close to the entry', { side, why: sig.why });
        if (blocked) {
          pf.counts.skipped = (pf.counts.skipped || 0) + 1;
          noteSkip(pf, bar.t, `blocked: ${blocked}`, { side, why: sig.why });
        }
        if (reward >= 0.5 && !blocked) {
          pf.pending = {
            side, signal_time: bar.t, why: sig.why, ref: sig.ref, stop: sig.stop,
            target, condition: conditionOf(candles, k, ctx),
            ...(ctx.day ? { trade_day: ctx.day[k], flat_td: cand.flat ?? FLAT_TD } : {}),
          };
          pf.counts.signals += 1;
          if (Array.isArray(pf.signals)) pf.signals = [...pf.signals, { time: bar.t, side, ref: sig.ref, stop: sig.stop, target, why: sig.why }].slice(-40);
        }
      }
    }
    pf.last_bar_time = bar.t;
    pf.counts.bars += 1;
  }
  return closed;
}

function closeAt(pf, bar, hit) {
  const pos = pf.open;
  const contract = CONTRACTS[pf.contract];
  const settled = settleTrade(pos, hit.exit, pf.qty, contract, pf.costs);
  const short = pos.side === 'short';
  const riskPts = short ? pos.stop - pos.entry.raw : pos.entry.raw - pos.stop;
  const up = short ? pos.entry.raw - pos.min_low : pos.max_high - pos.entry.raw;
  const down = short ? pos.max_high - pos.entry.raw : pos.entry.raw - pos.min_low;
  const trade = {
    source: pf.source,
    environment: pf.source === 'paper' ? 'paper' : 'backtest',
    portfolio: pf.key,
    symbol: pf.contract,
    contract: pf.contract,
    qty: pf.qty,
    strategy: pf.candidate,
    filter: pf.filter,
    strategy_version: pf.strategy_version,
    params: pf.params,
    side: pos.side || 'long',
    session: pos.session,
    signal: { time: pos.signal_time, why: pos.signal_why, ref: pos.signal_ref },
    condition: pos.condition,
    entry: { time: pos.entry_time, raw: pos.entry.raw, fill: pos.entry.price, spread: pos.entry.spread, slippage: pos.entry.slippage, basis: 'next_bar_open' },
    stop: pos.stop,
    target: pos.target,
    risk_points: r4(riskPts),
    exit: { time: bar.t, raw: hit.exit.raw, fill: hit.exit.price, reason: hit.reason,
      ...(hit.reason === 'time' && pos.trade_day && hit.gap ? { note: 'data gap: no bar before the daily break, so it closed at the next bar the feed had' } : {}) },
    same_bar_both_touched: hit.same_bar_both,
    ...settled,
    mfe_points: r2(up),
    mae_points: r2(down),
    mfe_r: riskPts > 0 ? r2(up / riskPts) : 0,
    mae_r: riskPts > 0 ? r2(down / riskPts) : 0,
    data: {
      resolution: pf.resolution,
      price_series: pf.price_series,
      label: pf.resolution === 'daily' ? 'approximate: daily bars, fills at the next open' : pf.resolution === 'intraday' ? 'intraday bars' : `intraday ${pf.resolution} bars, fills at the next open`,
      ...(pf.feed ? { feed: pf.feed } : {}),
      entry_feed: pos.entry_feed || null,
    },
    cost_assumptions: { ...pf.costs },
    result: settled.net_pnl > 0 ? 'win' : settled.net_pnl < 0 ? 'loss' : 'flat',
  };
  pf.open = null;
  pf.counts.closed += 1;
  return trade;
}

// ─── Record validation ────────────────────────────────────────────────────

const REQUIRED = [
  'source', 'environment', 'portfolio', 'symbol', 'contract', 'strategy', 'strategy_version', 'side', 'session',
  'signal', 'entry', 'exit', 'stop', 'target', 'qty', 'costs', 'net_pnl', 'r_net',
  'mfe_points', 'mae_points', 'data', 'cost_assumptions', 'params',
];

// Returns the problems in a trade record. An empty list means it may be journalled.
export function validateTradeRecord(t) {
  const problems = [];
  for (const key of REQUIRED) if (t?.[key] === undefined || t?.[key] === null) problems.push(`missing ${key}`);
  if (problems.length) return problems;
  if (t.environment !== (t.source === 'paper' ? 'paper' : 'backtest')) problems.push('source and environment disagree');
  if (!['backtest', 'paper'].includes(t.environment)) problems.push('only backtest and paper records are journalled here');
  if (!candidateOf(t.strategy)) problems.push('unknown strategy');
  const sideOk = t.side === 'short' ? t.stop > t.entry.raw && t.target < t.entry.fill : t.stop < t.entry.raw && t.target > t.entry.fill;
  if (!sideOk) problems.push('stop and target are on the wrong side of the entry');
  if (!['stop', 'target', 'time'].includes(t.exit.reason)) problems.push('exit reason must be stop, target or time');
  // Equal times are valid: a bar can open the trade and stop it out on the same bar.
  if (!(t.entry.time <= t.exit.time)) problems.push('exit must not come before entry');
  for (const v of [t.entry.fill, t.exit.fill, t.net_pnl, t.r_net, t.qty]) if (!finite(v)) problems.push('a price or amount is not a number');
  if (!(t.qty > 0)) problems.push('quantity must be positive');
  if (!t.data?.label) problems.push('data quality label missing');
  return problems;
}

// ─── Statistics (never a win rate alone) ──────────────────────────────────

// Wilson 95% interval for a proportion: the honest range, especially at small n.
export function wilsonInterval(wins, n, z = 1.96) {
  if (!n) return { low: 0, high: 0 };
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function sampleStatus(n) {
  if (n < MIN_TRADES) return 'insufficient';
  if (n < 100) return 'low';
  return 'adequate';
}

export function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.net_pnl > 0);
  const losses = trades.filter((t) => t.net_pnl < 0);
  const rs = trades.map((t) => t.r_net);
  const mean = n ? rs.reduce((s, v) => s + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0;
  const grossWin = wins.reduce((s, t) => s + t.net_pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.net_pnl, 0);
  const netPnl = trades.reduce((s, t) => s + t.net_pnl, 0);
  let equity = 0; let peak = 0; let dd = 0; let eqR = 0; let peakR = 0; let ddR = 0;
  for (const t of trades) {
    equity += t.net_pnl; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity);
    eqR += t.r_net; peakR = Math.max(peakR, eqR); ddR = Math.max(ddR, peakR - eqR);
  }
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const ci = wilsonInterval(wins.length, n);
  return {
    trades: n,
    sample: sampleStatus(n),
    wins: wins.length,
    losses: losses.length,
    flat: n - wins.length - losses.length,
    win_rate: n ? r2((100 * wins.length) / n) : null,
    win_rate_95ci: n ? { low: r2(100 * ci.low), high: r2(100 * ci.high) } : null,
    avg_winner: r2(avgWin),
    avg_loser: r2(-avgLoss),
    risk_reward: avgLoss ? r2(avgWin / avgLoss) : null,
    expectancy_r: r4(mean),
    expectancy_r_95ci: { low: r4(mean - half), high: r4(mean + half) },
    expectancy_dollars: n ? r2(netPnl / n) : null,
    net_pnl: r2(netPnl),
    profit_factor: grossLoss ? r2(grossWin / grossLoss) : null,   // null: no losing trades, or none at all
    max_drawdown: r2(dd),
    max_drawdown_r: r4(ddR),
    costs_paid: r2(trades.reduce((s, t) => s + t.costs.spread + t.costs.slippage + t.costs.commissions + t.costs.fees, 0)),
    long: trades.filter((t) => t.side === 'long').length,
    short: trades.filter((t) => t.side === 'short').length,
  };
}

// Breakdowns for the dashboard, for example by session, condition or strategy version.
export function breakdown(trades, keyOf) {
  const groups = {};
  for (const t of trades) (groups[keyOf(t)] ||= []).push(t);
  return Object.fromEntries(Object.entries(groups).map(([k, list]) => [k, summarize(list)]));
}

// Anchored walk-forward. The first `minTrain` share is the training period; the rest is
// cut into equal, consecutive test folds. The rules are frozen before the test, so the
// training period is used only to compare, never to tune.
export function walkForwardFolds(n, { folds = 4, minTrain = 0.4 } = {}) {
  const start = Math.floor(n * minTrain);
  const size = Math.floor((n - start) / folds);
  if (size < 1) return [];
  const out = [];
  for (let f = 0; f < folds; f++) {
    const testStart = start + f * size;
    const testEnd = f === folds - 1 ? n : testStart + size;
    out.push({ fold: f + 1, trainEnd: testStart, testStart, testEnd });
  }
  return out;
}

const byEntry = (a, b) => String(a.entry.time).localeCompare(String(b.entry.time));

// Evaluates trades in time order, fold by fold. Returns the out-of-sample trades too.
export function evaluateWalkForward(trades, opts = {}) {
  const sorted = [...trades].sort(byEntry);
  const folds = walkForwardFolds(sorted.length, opts);
  const rows = folds.map((f) => {
    const part = sorted.slice(f.testStart, f.testEnd);
    const s = summarize(part);
    return {
      fold: f.fold,
      test_from: part[0]?.entry.time ?? null,
      test_to: part[part.length - 1]?.entry.time ?? null,
      trades: s.trades, net_pnl: s.net_pnl, expectancy_r: s.expectancy_r, profit_factor: s.profit_factor,
    };
  });
  return {
    folds: rows,
    folds_total: rows.length,
    folds_positive: rows.filter((r) => r.trades > 0 && r.net_pnl > 0).length,
    oos: folds.length ? sorted.slice(folds[0].testStart) : [],
  };
}

// Promotion needs statistically meaningful, out-of-sample evidence on intraday data.
// Daily results can rank an idea, but they can never promote it.
export function promotionVerdict(oosTrades, { resolution = 'daily', foldsPositive = 0, folds = 0 } = {}) {
  const s = summarize(oosTrades);
  const reasons = [];
  if (resolution !== 'intraday') reasons.push('evidence is approximate (daily bars): it can rank an idea, not promote it');
  if (s.trades < MIN_TRADES) reasons.push(`only ${s.trades} out-of-sample trades; ${MIN_TRADES} are needed`);
  if (!(s.expectancy_r_95ci.low > 0)) reasons.push('the 95% range of expectancy in R includes zero or less');
  const pfOk = s.profit_factor === null ? s.wins > 0 : s.profit_factor > 1.2;
  if (!pfOk) reasons.push('profit factor after costs is not above 1.2');
  if (!folds) reasons.push('no walk-forward folds were tested');
  else if (foldsPositive / folds < 0.6) reasons.push('fewer than 60% of walk-forward folds were profitable');
  return { promote: reasons.length === 0, reasons, summary: s };
}

// ─── Evidence journal: append-only; losing trades and failed experiments are kept ─

export const RECORD_PREFIX = 'evr:';
const CHUNK = 100;   // Durable Object storage accepts up to 128 keys per call

// One trade is one key: a portfolio holds at most one open trade, so its entry bar identifies it.
export function recordKey(t) {
  return `${RECORD_PREFIX}${t.environment}:${t.portfolio}:${t.entry.time}`;
}

const sameRecord = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// All-or-nothing on validation: if any record is refused, nothing is written.
// An identical repeat is a duplicate and is skipped. A different outcome for an existing
// trade is a conflict: it is reported, and the stored record is kept as it was.
export async function appendTrades(storage, trades) {
  const refused = [];
  trades.forEach((t, i) => {
    const problems = validateTradeRecord(t);
    if (problems.length) refused.push({ index: i, problems });
  });
  if (refused.length) throw new Error(`trade records refused: ${JSON.stringify(refused)}`);
  const keys = trades.map(recordKey);
  const stored = new Map();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const found = await storage.get(keys.slice(i, i + CHUNK));
    for (const k of keys.slice(i, i + CHUNK)) if (found.get(k) !== undefined) stored.set(k, found.get(k));
  }
  const toWrite = {};
  const result = { written: 0, duplicates: 0, conflicts: [] };
  trades.forEach((t, i) => {
    const k = keys[i];
    if (stored.has(k)) {
      if (sameRecord(stored.get(k), t)) result.duplicates += 1;
      else result.conflicts.push(k);
      return;
    }
    if (k in toWrite) {
      if (sameRecord(toWrite[k], t)) result.duplicates += 1;
      else result.conflicts.push(k);
      return;
    }
    toWrite[k] = t;
    result.written += 1;
  });
  const entries = Object.entries(toWrite);
  for (let i = 0; i < entries.length; i += CHUNK) await storage.put(Object.fromEntries(entries.slice(i, i + CHUNK)));
  return result;
}

export async function readTrades(storage, filter = () => true) {
  const map = await storage.list({ prefix: RECORD_PREFIX });
  return [...map.values()].filter(filter).sort(byEntry);
}
