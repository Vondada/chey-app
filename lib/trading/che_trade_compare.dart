// One trade as the side-by-side view shows it, the account summaries, and the comparison of the owner's
// trade with CHE's (owner, 2026-10-23). Every number comes from a record: CHE's paper journal
// (/api/trading/live) or a trade the owner entered himself. A value nobody recorded stays null and
// reads "unknown"; nothing here estimates a fill, a balance or a P&L that was not recorded.
import 'che_account_kind.dart';

/// USD per index point (CME contract multipliers), the same table as the Worker's FYE_POINT_VALUE.
const kChePointValue = <String, double>{'MNQ': 2, 'NQ': 20, 'MES': 5, 'ES': 50};

double? _num(Object? v) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}');
DateTime? _time(Object? v) {
  if (v is num) return DateTime.fromMillisecondsSinceEpoch(v > 1e12 ? v.toInt() : (v * 1000).toInt(), isUtc: true);
  if (v is String && v.isNotEmpty) return DateTime.tryParse(v)?.toUtc();
  return null;
}

/// The contract's root ("MNQZ6" → MNQ) for the point value.
String cheContractRoot(String contract) {
  final up = contract.toUpperCase().trim();
  for (final root in const ['MNQ', 'MES', 'NQ', 'ES']) {
    if (up.startsWith(root)) return root;
  }
  return up;
}

class CheTradeView {
  const CheTradeView({
    required this.id,
    required this.account,
    required this.symbol,
    required this.side,
    required this.qty,
    required this.entry,
    this.stop,
    this.target,
    this.current,
    this.openedAt,
    this.closedAt,
    this.exit,
    this.setup = '',
    this.timeframe = '',
    this.status = 'open',
    this.unrealized,
    this.realized,
    this.adjusted = false,
    this.source = '',
    this.why = '',
  });

  final String id;
  final CheAccountKind account;
  final String symbol, side, setup, timeframe, status, source, why;
  final double qty, entry;
  final double? stop, target, current, exit, unrealized, realized;
  final DateTime? openedAt, closedAt;
  final bool adjusted;

  bool get isLong => side.toLowerCase() != 'short' && side.toLowerCase() != 'sell';
  bool get isOpen => status == 'open';
  double? get pointValue => kChePointValue[cheContractRoot(symbol)];

  /// Dollars lost if the stop fills exactly (before fees and slippage). Null without a stop or a known multiplier.
  double? get dollarRisk {
    final pv = pointValue;
    if (stop == null || pv == null) return null;
    return (entry - stop!).abs() * qty * pv;
  }

  double? get dollarReward {
    final pv = pointValue;
    if (target == null || pv == null) return null;
    return (target! - entry).abs() * qty * pv;
  }

  /// Recorded P&L: unrealized while open, realized once closed.
  double? get pnl => isOpen ? unrealized : realized;

  /// P&L as a percentage of the dollars at risk (R as a percent). Null when either is unknown.
  double? get returnOnRiskPct {
    final p = pnl, r = dollarRisk;
    if (p == null || r == null || r == 0) return null;
    return 100 * p / r;
  }

  Duration? timeInTrade(DateTime now) {
    final start = openedAt;
    if (start == null) return null;
    final end = closedAt ?? now;
    final d = end.difference(start);
    return d.isNegative ? Duration.zero : d;
  }

  /// The same trade with a P&L marked at a live price (owner-entered trades only).
  CheTradeView withUnrealized(double? value) => CheTradeView(
        id: id, account: account, symbol: symbol, side: side, qty: qty, entry: entry, stop: stop, target: target,
        current: current, openedAt: openedAt, closedAt: closedAt, exit: exit, setup: setup, timeframe: timeframe,
        status: status, unrealized: value, realized: realized, adjusted: adjusted, source: source, why: why,
      );

  /// A position from CHE's paper journal (/api/trading/live `positions`).
  factory CheTradeView.fromLivePosition(Map<String, dynamic> p) => CheTradeView(
        id: '${p['portfolio'] ?? p['strategy'] ?? ''}|${p['entry_time'] ?? ''}',
        account: CheAccountKind.chePaper,
        symbol: '${p['contract'] ?? 'MNQ'}',
        side: '${p['side'] ?? 'long'}',
        qty: _num(p['qty']) ?? 1,
        entry: _num(p['entry']) ?? 0,
        stop: _num(p['stop']),
        target: _num(p['target']),
        openedAt: _time(p['entry_time']),
        setup: '${p['name'] ?? p['strategy'] ?? ''}',
        timeframe: '${p['timeframe'] ?? '5m'}',
        unrealized: _num(p['unrealized']),
        adjusted: p['adjusted'] == true,
        source: 'CHE paper journal',
        why: '${p['why'] ?? ''}',
      );

  /// A closed trade from CHE's paper journal (/api/trading/live `trades`).
  factory CheTradeView.fromLiveTrade(Map<String, dynamic> t) {
    final entry = t['entry'] is Map ? t['entry'] as Map : const {};
    final exit = t['exit'] is Map ? t['exit'] as Map : const {};
    return CheTradeView(
      id: '${t['strategy'] ?? ''}|${entry['time'] ?? ''}',
      account: CheAccountKind.chePaper,
      symbol: '${t['contract'] ?? 'MNQ'}',
      side: '${t['side'] ?? 'long'}',
      qty: _num(t['qty']) ?? 1,
      entry: _num(entry['fill'] ?? entry['price']) ?? 0,
      stop: _num(t['stop']),
      target: _num(t['target']),
      exit: _num(exit['fill'] ?? exit['price']),
      openedAt: _time(entry['time']),
      closedAt: _time(exit['time']),
      setup: '${t['name'] ?? t['strategy'] ?? ''}',
      timeframe: '${t['timeframe'] ?? '5m'}',
      status: 'closed',
      realized: _num(t['net_pnl']),
      source: 'CHE paper journal',
      why: '${exit['reason'] ?? ''}',
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'account': account.name,
        'symbol': symbol,
        'side': side,
        'qty': qty,
        'entry': entry,
        'stop': stop,
        'target': target,
        'exit': exit,
        'opened_at': openedAt?.toIso8601String(),
        'closed_at': closedAt?.toIso8601String(),
        'setup': setup,
        'timeframe': timeframe,
        'status': status,
        'realized': realized,
        'adjusted': adjusted,
        'source': source,
        'why': why,
      };

  factory CheTradeView.fromJson(Map<String, dynamic> j) => CheTradeView(
        id: '${j['id']}',
        account: CheAccountKind.values.firstWhere((k) => k.name == j['account'], orElse: () => CheAccountKind.mine),
        symbol: '${j['symbol'] ?? ''}',
        side: '${j['side'] ?? 'long'}',
        qty: _num(j['qty']) ?? 1,
        entry: _num(j['entry']) ?? 0,
        stop: _num(j['stop']),
        target: _num(j['target']),
        exit: _num(j['exit']),
        openedAt: _time(j['opened_at']),
        closedAt: _time(j['closed_at']),
        setup: '${j['setup'] ?? ''}',
        timeframe: '${j['timeframe'] ?? ''}',
        status: '${j['status'] ?? 'open'}',
        realized: _num(j['realized']),
        adjusted: j['adjusted'] == true,
        source: '${j['source'] ?? ''}',
        why: '${j['why'] ?? ''}',
      );
}

/// My trade against CHE's: each difference is mine minus CHE's, null when either side is unknown.
class CheTradeComparison {
  CheTradeComparison(this.mine, this.che, {DateTime? now}) : now = now ?? DateTime.now().toUtc();

  final CheTradeView mine, che;
  final DateTime now;

  static double? _diff(double? a, double? b) => a == null || b == null ? null : a - b;

  double? get entryDiff => mine.entry - che.entry;
  double? get stopDiff => _diff(mine.stop, che.stop);
  double? get targetDiff => _diff(mine.target, che.target);
  double get qtyDiff => mine.qty - che.qty;
  double? get dollarRiskDiff => _diff(mine.dollarRisk, che.dollarRisk);
  double? get pnlDiff => _diff(mine.pnl, che.pnl);
  double? get returnPctDiff => _diff(mine.returnOnRiskPct, che.returnOnRiskPct);
  Duration? get timeInTradeDiff {
    final a = mine.timeInTrade(now), b = che.timeInTrade(now);
    return a == null || b == null ? null : a - b;
  }

  bool get sameSymbol => cheContractRoot(mine.symbol) == cheContractRoot(che.symbol);
  bool get sameDirection => mine.isLong == che.isLong;

  /// Same setup only when both name one and the names match; an unnamed setup is never assumed equal.
  bool get sameSetup => mine.setup.trim().isNotEmpty && mine.setup.trim().toLowerCase() == che.setup.trim().toLowerCase();
  bool get eitherAdjusted => mine.adjusted || che.adjusted;
}

/// One account's summary card. Null means not recorded or not connected; it reads "unknown".
class CheAccountSummary {
  const CheAccountSummary({
    required this.account,
    this.connected = true,
    this.note = '',
    this.balance,
    this.available,
    this.equity,
    this.realized,
    this.unrealized,
    this.openPositions,
    this.winRate,
    this.avgWin,
    this.avgLoss,
    this.maxDrawdown,
    this.dailyRisk,
    this.activeSetups,
    this.activeTrades,
    this.source = '',
  });

  final CheAccountKind account;
  final bool connected;
  final String note, source;
  final double? balance, available, equity, realized, unrealized, winRate, avgWin, avgLoss, maxDrawdown, dailyRisk;
  final int? openPositions, activeSetups, activeTrades;

  /// The owner's live or funded account: CHE's Rithmic link is market data only, so nothing is read.
  factory CheAccountSummary.notConnected(CheAccountKind account, String why) =>
      CheAccountSummary(account: account, connected: false, note: why);

  /// CHE's paper account from /api/trading/live. The journal has no cash balance of its own, so
  /// balance, available and equity stay unknown here until CHE's paper balance is recorded.
  factory CheAccountSummary.fromLiveDashboard(Map<String, dynamic> d) {
    final totals = d['totals'] is Map ? Map<String, dynamic>.from(d['totals'] as Map) : const <String, dynamic>{};
    final positions = [for (final p in d['positions'] as List? ?? const []) if (p is Map) CheTradeView.fromLivePosition(Map<String, dynamic>.from(p))];
    double? unrealized;
    for (final p in positions) {
      if (p.unrealized != null) unrealized = (unrealized ?? 0) + p.unrealized!;
    }
    double? risk;
    for (final p in positions) {
      if (p.dollarRisk != null) risk = (risk ?? 0) + p.dollarRisk!;
    }
    final setups = d['signals'] is List ? (d['signals'] as List).length : null;
    return CheAccountSummary(
      account: CheAccountKind.chePaper,
      realized: _num(totals['net_pnl']),
      unrealized: positions.isEmpty ? 0 : unrealized,
      openPositions: positions.length,
      winRate: _num(totals['win_rate']),
      avgWin: _num(totals['avg_winner']),
      avgLoss: _num(totals['avg_loser']),
      maxDrawdown: _num(totals['max_drawdown']),
      dailyRisk: positions.isEmpty ? 0 : risk,
      activeSetups: setups,
      activeTrades: positions.length,
      source: 'CHE paper journal (/api/trading/live)',
      note: 'Balance appears once CHE\'s paper balance is set.',
    );
  }

  /// The owner's trades he entered himself: counts and P&L from those records only.
  factory CheAccountSummary.fromOwnerTrades(List<CheTradeView> trades) {
    final open = trades.where((t) => t.isOpen).toList();
    final closed = trades.where((t) => !t.isOpen && t.realized != null).toList();
    final wins = closed.where((t) => t.realized! > 0).toList();
    final losses = closed.where((t) => t.realized! < 0).toList();
    double sum(Iterable<double> xs) => xs.fold(0.0, (a, b) => a + b);
    double? maxDd;
    if (closed.isNotEmpty) {
      var peak = 0.0, eq = 0.0, dd = 0.0;
      final ordered = [...closed]..sort((a, b) => (a.closedAt ?? DateTime(0)).compareTo(b.closedAt ?? DateTime(0)));
      for (final t in ordered) {
        eq += t.realized!;
        if (eq > peak) peak = eq;
        if (peak - eq > dd) dd = peak - eq;
      }
      maxDd = dd;
    }
    double? risk;
    for (final t in open) {
      if (t.dollarRisk != null) risk = (risk ?? 0) + t.dollarRisk!;
    }
    return CheAccountSummary(
      account: CheAccountKind.mine,
      realized: closed.isEmpty ? null : sum(closed.map((t) => t.realized!)),
      openPositions: open.length,
      winRate: closed.isEmpty ? null : 100 * wins.length / closed.length,
      avgWin: wins.isEmpty ? null : sum(wins.map((t) => t.realized!)) / wins.length,
      avgLoss: losses.isEmpty ? null : sum(losses.map((t) => t.realized!)) / losses.length,
      maxDrawdown: maxDd,
      dailyRisk: open.isEmpty ? 0 : risk,
      activeTrades: open.length,
      source: 'Trades you entered in CHE',
      note: 'Your broker balance is not connected: CHE\'s Rithmic link reads market data only.',
    );
  }
}
