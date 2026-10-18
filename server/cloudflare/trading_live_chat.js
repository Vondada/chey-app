// The owner's spoken and typed Trading Room commands for forward paper trading
// (owner, 2026-10-18). Answers come from the journal and the run log only: a trade is
// never mentioned before its record exists, and nothing here calls a model.
const WAKE = /^\s*(?:(?:hey\s+)?(?:che|chay|chey)[,:]?\s+)?/i;
const PATTERNS = [
  ['stop', /\b(?:stop|pause|turn\s+off|end|halt)\b[\s\S]{0,25}\bpaper[\s-]*trad\w*/i],
  ['start', /\b(?:start|begin|turn\s+on|resume|run|launch)\b[\s\S]{0,25}\bpaper[\s-]*trad\w*/i],
  ['why', /\b(?:explain|why)\b[\s\S]{0,40}\b(?:that|the\s+last|last|this|your\s+last)\s+trade\b[\s\S]{0,25}\b(?:lost|lose|won|win|worked|failed)\b|\bwhy\s+did\s+(?:that|the\s+last|your\s+last)\s+trade\s+(?:lose|win|fail|work)\b/i],
  ['chart', /\bshow\b[\s\S]{0,25}\bchart\b[\s\S]{0,30}\b(?:entered|entry|entries|exit(?:ed)?)\b/i],
  ['positions', /\b(?:current|open)\s+(?:paper\s+)?positions?\b|\bshow\s+me\s+your\s+positions\b|\bwhat\s+(?:positions|trades)\s+(?:are|do\s+you\s+have)\s+open\b/i],
  ['winloss', /\bhow\s+many\s+(?:paper\s+)?(?:trades\s+)?(?:have\s+you|did\s+you)\s+(?:won|win|lost)\b|\bwon\s+and\s+lost\b|\bwins?\s+and\s+loss(?:es)?\b/i],
  ['strategies', /\bwhat\s+strateg(?:y|ies)\s+are\s+you\s+(?:testing|running|using|trading)\b/i],
  ['compare', /\bcompare\s+(?:your\s+|the\s+|all\s+)?(?:trading\s+)?strateg/i],
  ['best', /\bwhich\b[\s\S]{0,20}\b(?:ict|smart\s+money|trading)?\s*strateg\w*\b[\s\S]{0,25}\b(?:best|performing|winning|working)\b/i],
  ['trades', /\b(?:show|list|read|tell)\b[\s\S]{0,20}\b(?:me\s+)?(?:every|all|the|your|live)?\s*(?:live\s+)?(?:nq|mnq|paper)?\s*trades?\b[\s\S]{0,30}\b(?:tonight|today|made|took|placed|you)?/i],
  ['performance', /\btrading\s+performance\b|\bread\s+me\s+your\s+(?:trading\s+)?(?:results|performance)\b/i],
  ['evidence', /\b(?:show|read)\b[\s\S]{0,15}\btrading\s+evidence\b/i],
  ['open', /\bopen\b[\s\S]{0,15}\btrading\s+room\b/i],
];

/** The command in [message], or null. Narrow on purpose: other trading talk keeps its routes. */
export function liveIntent(message) {
  const text = String(message || '').replace(WAKE, '').trim();
  if (!text || text.length > 160) return null;
  const tradingWords = /\b(?:paper|trad\w*|positions?|strateg\w*|nq|mnq|ict|trading\s+room|won|lost|entered|entry)\b/i;
  if (!tradingWords.test(text)) return null;
  for (const [kind, re] of PATTERNS) {
    if (!re.test(text)) continue;
    // "Show me the trades" needs trading context; "show me the trading evidence" is evidence.
    if (kind === 'trades' && !/\b(?:paper|nq|mnq|tonight|today|made|took|placed|live|every)\b/i.test(text)) continue;
    return { kind };
  }
  return null;
}

const money = (x) => (x == null ? 'not measured' : `${x < 0 ? 'minus ' : ''}$${Math.abs(x).toFixed(2)}`);
const pct = (x) => (x == null ? 'not measured' : `${x}%`);
const when = (iso) => {
  if (!iso) return 'unknown time';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) + ' Central';
};

function feedLine(d) {
  const f = d.feed;
  if (!f) return `No market data has been read yet. ${d.feed_blocker}`;
  const lag = f.latency_s == null ? '' : `, last bar about ${Math.max(0, Math.round(f.latency_s / 60))} minutes old`;
  return `Data: ${f.status} ${f.provider_symbol} (${f.contract || 'front month'}) from ${f.provider}${lag}. ${f.status === 'LIVE' ? '' : 'Delayed data is research only, not execution evidence. '}Market: ${d.session.state}.`;
}

function tradeLine(t) {
  return `${t.side} ${t.qty} ${t.contract}, ${t.strategy}, entered ${t.entry.fill} at ${when(t.entry.time)}, exited ${t.exit.fill} on ${t.exit.reason} at ${when(t.exit.time)}, net ${money(t.net_pnl)}`;
}

/** The reply for one command, from the dashboard data. `extra.started` etc. come from the route. */
export function liveReply(kind, d, extra = {}) {
  const t = d.totals;
  const head = 'Paper trading only; no real money and no broker orders.';
  switch (kind) {
    case 'start':
      return `${extra.already ? 'Paper trading was already on' : 'Paper trading is on'}, sir. ${d.portfolios} isolated paper portfolios run ${d.strategies.length} strategies on MNQ 5-minute bars, every minute while CME is open, even with the app closed. ${feedLine(d)} I report a trade only once it is recorded.`;
    case 'stop':
      return `Paper trading is off, sir. ${t.trades} closed trades and every record are kept. ${d.positions.length ? `${d.positions.length} open paper positions stay as they are until you start again.` : 'No paper position was open.'}`;
    case 'positions':
      if (!d.positions.length) return `No open paper positions right now, sir. ${feedLine(d)}`;
      return `${d.positions.length} open paper position${d.positions.length === 1 ? '' : 's'}, sir: ${d.positions.slice(0, 5).map((p, i) => `${i + 1}, ${p.side} ${p.qty} ${p.contract} by ${p.name}, entry ${p.entry}, stop ${p.stop}, target ${p.target}, unrealized ${money(p.unrealized)}`).join('; ')}. ${head}`;
    case 'winloss':
      return t.trades
        ? `${t.trades} closed paper trades: ${t.wins} won, ${t.losses} lost, ${t.flat} flat. Win rate ${pct(t.win_rate)} (95% range ${pct(t.win_rate_95ci?.low)} to ${pct(t.win_rate_95ci?.high)}). Net after costs ${money(t.net_pnl)}.${t.trades < d.min_trades ? ` That is fewer than ${d.min_trades} trades, so it is not yet evidence.` : ''}`
        : `No paper trade has closed yet, sir. ${d.counts.signals} signals so far and ${d.positions.length} open. ${feedLine(d)}`;
    case 'strategies':
      return `I am testing ${d.strategies.length} strategies in ${d.portfolios} isolated paper portfolios: ${d.strategies.map((s, i) => `${i + 1}, ${s.name} (${s.family})`).join('; ')}. Each has written rules for entry, stop, target and exit; ask me to explain one by name.`;
    case 'trades': {
      if (!t.trades) return `No paper trade has closed yet, sir. ${d.positions.length} open, ${d.counts.signals} signals recorded. ${feedLine(d)}`;
      const list = d.trades.slice(0, 8).map((x, i) => `${i + 1}, ${tradeLine(x)}`).join('; ');
      return `${t.trades} closed paper trades${t.trades > 8 ? ', newest eight' : ''}: ${list}. The Trading Room lists every one with its chart.`;
    }
    case 'why': {
      const wanted = extra.result || (/\b(?:won|win|worked)\b/i.test(extra.message || '') ? 'win' : 'loss');
      const last = d.trades.find((x) => (wanted === 'win' ? x.result === 'win' : x.result === 'loss')) || null;
      if (!last) return `There is no recorded paper ${wanted === 'win' ? 'win' : 'loss'} yet, sir, so there is nothing to explain.`;
      const r = last.review || {};
      return `${tradeLine(last)}. What happened: ${(r.facts || []).join(' ')} ${r.hypotheses?.length ? `Possible reasons, not proven: ${r.hypotheses.join(' ')}` : 'No pattern stands out from one trade.'}`;
    }
    case 'chart': {
      const last = d.trades[0] || null;
      const open = d.positions[0] || null;
      if (!last && !open) return 'There is no paper entry to show yet, sir. The Trading Room chart shows the live bars and will mark the first entry.';
      return `Opening the Trading Room chart, sir. ${open ? `Open entry: ${open.side} at ${open.entry}, ${when(open.entry_time)}, stop ${open.stop}, target ${open.target}.` : `Last entry: ${tradeLine(last)}.`}`;
    }
    case 'best':
    case 'compare': {
      const rows = d.by_strategy;
      if (!rows.length) {
        const bt = d.backtest?.ok ? d.backtest.rows.slice(0, 3).map((r, i) => `${i + 1}, ${r.name} (${r.filter}, ${r.target_r} R): ${r.stats.trades} backtest trades, ${r.stats.expectancy_r} R per trade, net ${money(r.stats.net_pnl)}`).join('; ') : '';
        return `No forward paper trade has closed yet, so no strategy is ranked, sir.${bt ? ` Historical baseline on delayed 5-minute data, not forward evidence: ${bt}.` : ''}`;
      }
      const ict = kind === 'best' && /\bict|smart\s+money\b/i.test(extra.message || '') ? rows.filter((r) => r.family === 'ICT') : rows;
      const list = (ict.length ? ict : rows).slice(0, kind === 'best' ? 3 : 6).map((r, i) => `${i + 1}, ${r.name} (${r.filter}, ${r.target_r} R): ${r.trades} trades, win rate ${pct(r.win_rate)}, ${r.expectancy_r} R per trade, net ${money(r.net_pnl)}${r.ranked ? '' : ', too few trades to rank'}`).join('; ');
      return `${kind === 'best' ? 'Leading by measured expectancy' : 'Strategies by measured expectancy'}, forward paper only: ${list}. No strategy is called reliable below ${d.min_trades} closed trades.`;
    }
    case 'performance':
    case 'evidence':
      return `${head} ${feedLine(d)} Since ${d.state.started_at ? when(d.state.started_at) : 'the start'}: ${d.counts.signals} signals, ${d.counts.filled} entries, ${t.trades} closed (${t.wins} won, ${t.losses} lost), ${d.positions.length} open. Net after costs ${money(t.net_pnl)}, profit factor ${t.profit_factor ?? 'not measured'}, max drawdown ${money(t.max_drawdown)}. ${t.trades < d.min_trades ? `Fewer than ${d.min_trades} trades: not yet evidence.` : ''}`;
    case 'open':
      return `Opening the Trading Room, sir. ${d.state.enabled ? 'Paper trading is on.' : 'Paper trading is off; say start paper trading to begin.'} ${feedLine(d)}`;
    default:
      return feedLine(d);
  }
}
