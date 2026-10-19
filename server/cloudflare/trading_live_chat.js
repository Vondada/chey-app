// The owner's spoken and typed Trading Room commands for forward paper trading
// (owner, 2026-10-18). Answers come from the journal and the run log only: a trade is
// never mentioned before its record exists, and nothing here calls a model.
import { withoutProhibitions } from './owner_action_gate.js';

const WAKE = /^\s*(?:(?:hey\s+)?(?:che|chay|chey)[,:]?\s+)?/i;
// Start and stop are commands only: "Don't stop paper trading" and "Why did you stop paper
// trading?" change nothing (review of #339). They count only when the turn opens with them.
const COMMANDS = [
  ['stop', /^(?:please\s+)?(?:stop|pause|turn\s+off|end|halt)\s+(?:the\s+|your\s+)?paper[\s-]*trad\w*/i],
  ['start', /^(?:please\s+)?(?:start|begin|turn\s+on|resume|run|launch)\s+(?:the\s+|your\s+)?paper[\s-]*trad\w*/i],
];
// Every read needs trading words of its own. One question can ask several (issue #350), and each
// one asked is answered, in the order asked.
const READS = [
  ['why', /\b(?:explain|why)\b[\s\S]{0,40}\b(?:that|the\s+last|last|this|your\s+last)\s+trade\b[\s\S]{0,25}\b(?:lost|lose|won|win|worked|failed)\b|\bwhy\s+did\s+(?:that|the\s+last|your\s+last)\s+trade\s+(?:lose|win|fail|work)\b|\bexplain\s+(?:the\s+|your\s+)?last\s+(?:losing|winning)\s+trade\b/i],
  ['chart', /\bshow\b[\s\S]{0,25}\bchart\b[\s\S]{0,30}\b(?:you\s+)?(?:entered|entry|exited)\b|\bshow\s+me\s+where\s+you\s+(?:entered|exited)\b/i],
  ['positions', /\b(?:your|my|paper)\s+(?:current\s+|open\s+)?(?:paper\s+)?positions?\b|\bcurrent\s+(?:paper\s+)?positions?\b/i],
  ['winloss', /\bhow\s+many\s+(?:paper\s+)?trades?\s+(?:have\s+you|did\s+you)\s+(?:won|win|lost)\b|\btrades?\b[\s\S]{0,30}\bwon\s+and\s+lost\b/i],
  ['strategies', /\bwhat\s+strateg(?:y|ies)\s+are\s+you\s+(?:testing|running|using|trading)\b/i],
  ['compare', /\bcompare\s+(?:all\s+)?your\s+(?:trading\s+|paper\s+)?strateg|\bcompare\s+(?:the\s+)?(?:trading|paper)\s+strateg/i],
  ['best', /\bwhich\s+(?:ict|smart\s+money|trading|paper)\s+strateg\w*\b[\s\S]{0,25}\b(?:best|performing|winning|working)\b|\bwhich\s+of\s+your\s+(?:trading\s+)?strateg\w*\b[\s\S]{0,25}\b(?:best|performing|winning|working)\b/i],
  ['trades', /\b(?:show|list|read|tell)\s+me\s+(?:every|all|the|your)?\s*(?:live\s+)?(?:(?:nq|mnq|paper)\s+)+trades?\b|\bevery\s+trade\s+you\s+(?:made|took|placed)\b|\b(?:show|list|read)\s+me\s+(?:all\s+)?(?:the\s+)?trades\s+you\s+(?:made|took|placed)\b/i],
  // "How did my paper trades do today?", "what's my paper trading balance?" (comprehension audit).
  ['performance', /\btrading\s+performance\b|\bread\s+me\s+your\s+(?:trading\s+|paper\s+)?(?:results|performance)\b|\bhow\s+(?:did|are|have)\s+(?:your|my|the)\s+paper\s+trades?\s+(?:do|doing|done|going|gone)\b|\bpaper[\s-]*trad\w*\s+(?:balance|results|profit|p\s*&\s*l|pnl)\b|\bpaper\s+(?:balance|p\s*&\s*l|pnl)\b/i],
  ['evidence', /\b(?:show|read)\b[\s\S]{0,15}\btrading\s+evidence\b/i],
  ['open', /^(?:please\s+)?open\s+(?:up\s+)?(?:your\s+|the\s+)?trading\s+room\b/i],
  // "Is paper trading still on?" reads the switch and never flips it. "Is paper trading on NQ
  // profitable?" is not about the switch.
  ['state', /\b(?:is|are)\s+(?:the\s+|your\s+)?paper[\s-]*trading\s+(?:still\s+)?(?:on|off|running|active|enabled)(?=\s*(?:[?.!,;]|$)|\s+(?:still|now|right\s+now|today|and|or|dont|don't|do\s+not|please)\b)|\bare\s+you\s+still\s+paper[\s-]*trading\b/i],
];
// "Which strategy is performing best" says no market of its own, so it counts only in a turn that
// does ("... paper trades ..."); "which strategy works best for my YouTube channel" is not trading.
const PLAIN_BEST = /\bwhich\s+strateg(?:y|ies)\b[\s\S]{0,25}\b(?:best|performing|winning|working)\b/i;
const TRADING_WORDS = /\bpaper[\s-]*trad\w*|\b(?:m?nq|ict)\b|\btrading\s+room\b/i;
// Another topic that mentions trading belongs to its own route: a code change, a message to send.
const OTHER_TOPIC = /\b(?:code|coding|feature|function|bug|fix|button|pull\s+request|commit|deploy|send|e-?mail|mailbox|youtube|video|website)\b|\b(?:ask|tell)\s+(?:claude|chatgpt|codex|gemini|cursor|copilot|grok)\b/i;
// The 160-character cap of #339 dropped long compound questions; this only bounds the scan.
const MAX_TURN = 1200;

// "Analyze MNQ using your latest data ... and whether any paper trades occurred. Don't place any orders":
// a read of the feed and the journal. An order asked for in the same turn belongs to the desk.
const ANALYSIS = /\b(?:analy[sz]e|analysis\s+(?:of|on)|break\s+down|assess)\b[\s\S]{0,40}\b(?:mnq|nq|micro\s+nasdaq|nasdaq\s+futures)\b/i;
// "Analyze the NQ chart" is the chart analyzer's (trading_lab); a read that asks about the feed or the
// paper journal itself is answered here.
const FEED_DETAIL = /\b(?:paper\s+trades?|vwap|data\s+delay|delay(?:ed)?|time\s*stamps?|data\s+source|(?:the|its)\s+source|latest\s+(?:available\s+)?(?:market\s+)?data)\b/i;
// An order asked for in the turn belongs to the desk (fundyouredge.js, trading_desk.js); the chart
// analyzer uses the same test. "Short MNQ" is an order; "short positions" and "short-term" are reads.
// "Reverse my position", "flatten" and "close my position" are orders too.
const LATER_COMMAND = /(?:[,.;!?]\s*|\b(?:and|then|also|now)\s+)(?:please\s+)?(?:stop|pause|turn\s+off|halt|end|start|begin|turn\s+on|resume|launch)\s+(?:the\s+|your\s+)?paper[\s-]*trad/i;
const ORDER_FIRST = /^(?:place|submit|enter|buy|sell|short|go\s+long|go\s+short|take\s+(?:the|a)\s+trade|open\s+a\s+(?:position|trade)|order|trade|prepare|set\s+up|reverse|flatten|close)\b/i;
export const ORDER_ASK = /\b(?:place|submit|enter|buy|sell|go\s+long|go\s+short|take\s+(?:the|a|this|that)\s+trade|open\s+a\s+(?:position|trade)|reverse|flatten|close\s+(?:out\s+)?(?:my|the|that|this|all)\s+(?:\w+\s+)?(?:positions?|trades?|longs?|shorts?)|close\s+(?:out\s+)?everything|close\s+out)\b|\bshort\b(?![\s-]*(?:term|positions?|trades?|side)\b)/i;

/** The command in [message], or null. Narrow on purpose: other trading talk keeps its routes.
 *  A turn that asks several reads gets `kinds`, in the order asked; `kind` is the first. */
export function liveIntent(message) {
  const text = String(message || '').replace(WAKE, '').trim();
  if (!text || text.length > MAX_TURN) return null;
  // Only what the owner asks for counts: "don't start or stop anything" asks nothing. An order is set
  // aside only when the owner forbade the order itself ("don't place any orders"), never for "don't
  // ask me, buy MNQ" (review of #351).
  const asked = withoutProhibitions(text);
  if (ORDER_ASK.test(withoutProhibitions(text, { only: ORDER_FIRST }))) return null;
  const command = COMMANDS.find(([, re]) => re.test(asked))?.[0];
  // "Analyze MNQ … and then stop paper trading": a start or stop later in the turn is a command these
  // reads cannot carry out, so the turn goes on to the routes that can ("why did you stop" is a read).
  if (!command && LATER_COMMAND.test(asked)) return null;
  if (!command && ANALYSIS.test(text) && FEED_DETAIL.test(text)) return { kind: 'analysis' };
  if (OTHER_TOPIC.test(asked)) return null;
  // A long turn needs trading words of its own: "my positions on the church committee … help me write
  // her a note" is not about paper trades (review of #352). Short questions keep the plain reads.
  if (!command && text.length > 160 && !TRADING_WORDS.test(text) && !/\btrad(?:e|es|ing)\b/i.test(text)) return null;
  const found = READS.map(([kind, re]) => [kind, text.search(re)]);
  if (TRADING_WORDS.test(text)) found.push(['best', text.search(PLAIN_BEST)]);
  const reads = [...new Set(found.filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1]).map(([kind]) => kind))]
    // After a start or stop the reply itself says whether paper trading is on.
    .filter((kind) => !command || !['state', 'open'].includes(kind));
  const kinds = command ? [command, ...reads] : reads;
  if (!kinds.length) return null;
  return kinds.length === 1 ? { kind: kinds[0] } : { kind: kinds[0], kinds };
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

const price = (x) => Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The bars of the current session: back from the newest bar until the daily CME break (a gap of 45
// minutes or more).
function sessionBars(bars) {
  const out = [];
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (out.length && Date.parse(out[0].t) - Date.parse(bars[i].t) >= 45 * 60_000) break;
    out.unshift(bars[i]);
  }
  return out;
}

/** Price, structure and VWAP from the stored bars only; each says what it was computed from. */
export function marketRead(bars = []) {
  const rows = (Array.isArray(bars) ? bars : []).filter((b) => b && Number.isFinite(b.c) && !Number.isNaN(Date.parse(b.t)));
  if (!rows.length) return 'No price bar is stored yet, so there is no price, structure or VWAP to report.';
  const last = rows[rows.length - 1];
  const session = sessionBars(rows);
  // The bar size is measured inside the session, never across the daily break.
  const step = session.length > 1 ? Math.round((Date.parse(last.t) - Date.parse(session[session.length - 2].t)) / 60_000) : 0;
  const parts = [`Last ${step ? `${step}-minute ` : ''}bar: close ${price(last.c)} at ${when(last.t)}.`];
  const hour = session.slice(-Math.max(4, step ? Math.round(60 / step) : 12));
  if (hour.length >= 4) {
    const half = Math.floor(hour.length / 2);
    const [a, b] = [hour.slice(0, half), hour.slice(half)];
    const hi = (x) => Math.max(...x.map((r) => r.h));
    const lo = (x) => Math.min(...x.map((r) => r.l));
    const shape = hi(b) > hi(a) && lo(b) > lo(a) ? 'rising, with higher highs and higher lows'
      : hi(b) < hi(a) && lo(b) < lo(a) ? 'falling, with lower highs and lower lows' : 'mixed, inside a range';
    parts.push(`Structure over the last ${hour.length} bars: ${shape}, between ${price(lo(hour))} and ${price(hi(hour))}.`);
  }
  const volume = session.reduce((n, r) => n + (Number(r.v) || 0), 0);
  parts.push(volume > 0
    ? `VWAP since this session's first stored bar at ${when(session[0].t)}: ${price(session.reduce((n, r) => n + ((r.h + r.l + r.c) / 3) * (Number(r.v) || 0), 0) / volume)}, from ${session.length} bars.`
    : 'VWAP: not available, because the feed gave no volume for this session.');
  return parts.join(' ');
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
    case 'analysis':
      return `I placed no order, sir. ${feedLine(d)} ${marketRead(d.bars)} Paper trading is ${d.state.enabled ? 'on' : 'off'}: ${d.counts.signals} signals, ${d.counts.filled} entries, ${t.trades} closed (${t.wins} won, ${t.losses} lost), ${d.positions.length} open. This is a read of recorded data, not a forecast.`;
    case 'open':
      return `Opening the Trading Room, sir. ${d.state.enabled ? 'Paper trading is on.' : 'Paper trading is off; say start paper trading to begin.'} ${feedLine(d)}`;
    case 'state':
      return d.state.enabled
        ? `Paper trading is on, sir${d.state.started_at ? `, since ${when(d.state.started_at)}` : ''}. I did not change it.`
        : `Paper trading is off, sir${d.state.stopped_at ? `, since ${when(d.state.stopped_at)}` : ''}. I did not change it; say start paper trading to turn it on.`;
    default:
      return feedLine(d);
  }
}

/** One spoken answer to every read the turn asked, in order. The feed is said once and a repeated
 *  answer is dropped, so a compound question does not read the same line twice. */
export function liveAnswer(intent, d, extra = {}) {
  const feed = feedLine(d);
  const said = [];
  const parts = [];
  for (const kind of intent.kinds || [intent.kind]) {
    const reply = liveReply(kind, d, extra);
    if (said.includes(reply)) continue;
    said.push(reply);
    parts.push(parts.some((p) => p.includes(feed)) ? reply.replace(feed, '').replace(/\s{2,}/g, ' ').trim() : reply);
  }
  return parts.join(' ');
}
