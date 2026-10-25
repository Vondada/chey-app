// The Trading Room dashboard's figures (owner, 2026-10-25: "P&L, Win Rate, W/L, Open and Drawdown missing, zero or
// unexplained"). One function computes every headline number from one account's closed records, so the same
// definitions hold everywhere and are tested (test/che_account_stats_test.dart):
//
//   realized P&L  = the sum of each closed trade's result in the account's unit (dollars, or R for the simulation)
//   win rate      = wins / closed trades (a flat trade counts as closed, not as a win)
//   W / L         = trades with a positive result / trades with a negative result
//   open          = the account's open positions as its own record reports them (null when it did not report)
//   max drawdown  = the largest fall from a peak of the cumulative realized curve, trades in exit order,
//                   the curve starting at zero
//
// Accounts are never mixed: each call gets one account's rows. A backtest row is refused outright (it is research, not
// an account). No rows reads "No recorded trades", never 0 or a dash; a failed read reads "Data unavailable (reason)".
import 'dart:math' as math;

/// The kinds of record set a dashboard figure can come from. Backtests are deliberately absent.
enum CheAccountSource { chePaper, forwardPaperFutures, forwardPaperCrypto, simulation, ownerTrades }

extension CheAccountSourceWords on CheAccountSource {
  String get label => switch (this) {
        CheAccountSource.chePaper => 'CHE PAPER · iPhone',
        CheAccountSource.forwardPaperFutures => 'FORWARD PAPER · FUTURES',
        CheAccountSource.forwardPaperCrypto => 'FORWARD PAPER · CRYPTO',
        CheAccountSource.simulation => 'SIMULATION (R)',
        CheAccountSource.ownerTrades => 'MY TRADES',
      };

  /// Where the records live and what they are, read with every explanation.
  String get spoken => switch (this) {
        CheAccountSource.chePaper => 'the CHE paper account on this iPhone: simulated MNQ trades filled on live Rithmic prices',
        CheAccountSource.forwardPaperFutures => "CHE's forward paper journal for futures on the Worker: simulated fills on delayed 5-minute bars",
        CheAccountSource.forwardPaperCrypto => "Orion's forward paper journal for BTC and ETH on the Worker: simulated fills on Coinbase public candles",
        CheAccountSource.simulation => 'the strategy simulation on 1-minute bars, measured in R only; no dollars are recorded',
        CheAccountSource.ownerTrades => 'the trades you entered yourself on this phone; P&L before fees',
      };

  String get unit => this == CheAccountSource.simulation ? 'R' : 'USD';

  /// The Worker account id (GET /api/trading/calendar?view=accounts), or null for the phone's own records.
  String? get workerId => switch (this) {
        CheAccountSource.forwardPaperFutures => 'forward_paper_futures',
        CheAccountSource.forwardPaperCrypto => 'forward_paper_crypto',
        CheAccountSource.simulation => 'simulation',
        _ => null,
      };
}

/// One closed (or open) trade as the dashboard reads it, from any account.
class CheStatTrade {
  const CheStatTrade({
    required this.id,
    required this.instrument,
    required this.market,
    this.strategy = '',
    this.side = '',
    this.entryAt,
    this.exitAt,
    this.value,
    this.kind = '',
    this.replay = true,
  });

  final String id, instrument, market, strategy, side, kind;
  final DateTime? entryAt, exitAt;

  /// The result in the account's unit: dollars, or R for the simulation. Null when the record has none.
  final double? value;
  final bool replay;

  bool get closed => exitAt != null;

  /// From a Worker row (trading_accounts.js row()). [unit] picks dollars or R.
  factory CheStatTrade.fromWorker(Map<String, dynamic> j, String unit) {
    num? n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}');
    return CheStatTrade(
      id: '${j['id'] ?? ''}',
      instrument: '${j['symbol'] ?? ''}',
      market: '${j['market'] ?? 'futures'}',
      strategy: '${j['strategy'] ?? ''}',
      side: '${j['side'] ?? ''}',
      kind: '${j['kind'] ?? ''}',
      entryAt: DateTime.tryParse('${j['entry_time'] ?? ''}'),
      exitAt: DateTime.tryParse('${j['exit_time'] ?? ''}'),
      value: (unit == 'R' ? n(j['r']) : n(j['net']))?.toDouble(),
      replay: j['replay'] != false,
    );
  }
}

class CheAccountStats {
  const CheAccountStats({
    required this.source,
    required this.closed,
    required this.wins,
    required this.losses,
    required this.realized,
    required this.winRate,
    required this.open,
    required this.maxDrawdown,
    required this.updatedAt,
    required this.checkedAt,
    required this.missingValues,
    this.unavailable,
  });

  final CheAccountSource source;
  final int closed, wins, losses, missingValues;
  final double? realized, winRate, maxDrawdown;
  final int? open;

  /// The newest trade's exit (the latest verified value) and when the records were read.
  final DateTime? updatedAt, checkedAt;

  /// Why the records could not be read; null when they were.
  final String? unavailable;

  String get unit => source.unit;
  bool get empty => unavailable == null && closed == 0;
  int get flat => closed - wins - losses;
}

/// The one definition of every dashboard figure. Throws on a backtest row: research never enters an account's stats.
CheAccountStats cheComputeAccountStats(
  CheAccountSource source,
  List<CheStatTrade> trades, {
  int? openPositions,
  DateTime? checkedAt,
  String? unavailable,
}) {
  for (final t in trades) {
    if (t.kind == 'historical_backtest' || t.kind == 'backtest') {
      throw ArgumentError('A backtest record (${t.id}) is research, not an account trade; it is never counted in ${source.label}.');
    }
  }
  if (unavailable != null) {
    return CheAccountStats(source: source, closed: 0, wins: 0, losses: 0, realized: null, winRate: null, open: openPositions, maxDrawdown: null,
        updatedAt: null, checkedAt: checkedAt, missingValues: 0, unavailable: unavailable);
  }
  final closed = trades.where((t) => t.closed).toList()..sort((a, b) => a.exitAt!.compareTo(b.exitAt!));
  final valued = closed.where((t) => t.value != null).toList();
  final wins = closed.where((t) => (t.value ?? 0) > 0).length;
  final losses = closed.where((t) => (t.value ?? 0) < 0).length;
  var cum = 0.0, peak = 0.0, maxDd = 0.0;
  for (final t in valued) {
    cum += t.value!;
    peak = math.max(peak, cum);
    maxDd = math.max(maxDd, peak - cum);
  }
  double r2(double x) => (x * 100).roundToDouble() / 100;
  return CheAccountStats(
    source: source,
    closed: closed.length,
    wins: wins,
    losses: losses,
    realized: valued.isEmpty ? null : r2(cum),
    winRate: closed.isEmpty ? null : wins / closed.length,
    open: openPositions,
    maxDrawdown: valued.isEmpty ? null : r2(maxDd),
    updatedAt: closed.isEmpty ? null : closed.last.exitAt,
    checkedAt: checkedAt,
    missingValues: closed.length - valued.length,
  );
}

/// The four headline stats.
enum CheStat { pnl, winRate, open, drawdown }

/// "+$29.70", "−1.50 R".
String cheStatAmount(double v, String unit) {
  final sign = v < 0 ? '−' : (v > 0 ? '+' : '');
  return unit == 'R' ? '$sign${v.abs().toStringAsFixed(2)} R' : '$sign\$${v.abs().toStringAsFixed(2)}';
}

/// What a stat tile shows. Never a bare 0 or a dash for missing data.
String cheStatValue(CheAccountStats s, CheStat stat) {
  if (s.unavailable != null) return 'Data unavailable';
  switch (stat) {
    case CheStat.pnl:
      if (s.closed == 0) return 'No recorded trades';
      return s.realized == null ? 'No P&L recorded' : cheStatAmount(s.realized!, s.unit);
    case CheStat.winRate:
      if (s.closed == 0) return 'No recorded trades';
      return '${(s.winRate! * 100).round()}% · ${s.wins}W ${s.losses}L';
    case CheStat.open:
      return s.open == null ? 'Not reported' : '${s.open}';
    case CheStat.drawdown:
      if (s.closed == 0) return 'No recorded trades';
      return s.maxDrawdown == null ? 'No P&L recorded' : cheStatAmount(-s.maxDrawdown!, s.unit).replaceFirst('+', '');
  }
}

String cheStatTitle(CheStat stat) => switch (stat) {
      CheStat.pnl => 'Realized P&L',
      CheStat.winRate => 'Win rate · W/L',
      CheStat.open => 'Open positions',
      CheStat.drawdown => 'Max drawdown',
    };

String _when(DateTime? t) {
  if (t == null) return 'never';
  final ny = cheNewYork(t);
  final h = ny.hour % 12 == 0 ? 12 : ny.hour % 12;
  return '${ny.month}/${ny.day} $h:${ny.minute.toString().padLeft(2, '0')} ${ny.hour < 12 ? 'AM' : 'PM'} New York time';
}

/// The tap-to-expand explanation (and the spoken answer to "explain win rate", "what's my drawdown").
String cheStatExplain(CheAccountStats s, CheStat stat) {
  final where = 'From ${s.source.spoken}.';
  final value = cheStatValue(s, stat);
  if (s.unavailable != null) return '${cheStatTitle(stat)}: data unavailable, because ${s.unavailable}. $where No number is shown until the records can be read.';
  final asOf = s.closed == 0 ? '' : ' Latest trade closed ${_when(s.updatedAt)}.';
  final missing = s.missingValues > 0 ? ' ${s.missingValues} closed trade${s.missingValues == 1 ? ' has' : 's have'} no recorded result and ${s.missingValues == 1 ? 'is' : 'are'} not added in.' : '';
  return switch (stat) {
    CheStat.pnl => s.closed == 0
        ? 'Realized P&L: no recorded trades yet in this account. $where Nothing is shown as zero until a trade closes.'
        : 'Realized P&L: $value, the sum of ${s.closed} closed trade${s.closed == 1 ? '' : 's'}${s.unit == 'R' ? ' in R' : ' after costs'}. $where$asOf$missing Backtests are never included.',
    CheStat.winRate => s.closed == 0
        ? 'Win rate: no recorded trades yet. $where Win rate is wins divided by closed trades.'
        : 'Win rate: ${(s.winRate! * 100).round()} percent, ${s.wins} win${s.wins == 1 ? '' : 's'} divided by ${s.closed} closed trade${s.closed == 1 ? '' : 's'}. ${s.wins} win${s.wins == 1 ? '' : 's'}, ${s.losses} loss${s.losses == 1 ? '' : 'es'}${s.flat > 0 ? ', ${s.flat} flat' : ''}. $where$asOf',
    CheStat.open => s.open == null
        ? 'Open positions: not reported by this account\'s records. $where'
        : 'Open positions: ${s.open}, as this account\'s own record reports them now. $where',
    CheStat.drawdown => s.closed == 0
        ? 'Max drawdown: no recorded trades yet. $where Drawdown is the largest fall from a peak of the realized P&L curve.'
        : 'Max drawdown: $value, the largest fall from a peak of the cumulative realized curve, trades in the order they closed, starting from zero. $where$asOf',
  };
}

/// New York wall time for a UTC instant, with US daylight saving (second Sunday of March 2:00 AM to first Sunday of
/// November 2:00 AM local). The fields of the returned DateTime are New York's; it is not a real UTC instant.
DateTime cheNewYork(DateTime t) {
  final u = t.toUtc();
  DateTime nthSunday(int year, int month, int n) {
    var d = DateTime.utc(year, month, 1);
    while (d.weekday != DateTime.sunday) {
      d = d.add(const Duration(days: 1));
    }
    return d.add(Duration(days: 7 * (n - 1)));
  }

  // DST starts 2:00 AM EST (07:00 UTC) and ends 2:00 AM EDT (06:00 UTC).
  final start = nthSunday(u.year, 3, 2).add(const Duration(hours: 7));
  final end = nthSunday(u.year, 11, 1).add(const Duration(hours: 6));
  final dst = !u.isBefore(start) && u.isBefore(end);
  return u.subtract(Duration(hours: dst ? 4 : 5));
}

String _ymd(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// The calendar date a closed trade counts on, the same rule as the Worker (trading_accounts.tradeDateOf): futures on
/// the CME trading date (from 6:00 PM New York a trade belongs to the next date), crypto on its New York calendar date.
String cheTradeDate(DateTime exitAt, String market) {
  final ny = cheNewYork(exitAt);
  if (market == 'futures' && ny.hour >= 18) return _ymd(DateTime.utc(ny.year, ny.month, ny.day + 1));
  return _ymd(ny);
}
