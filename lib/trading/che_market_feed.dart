// CHE's market-data feed for trading engines on this phone (owner, 2026-10-23).
//
// One read-only API over the live Rithmic session (lib/rithmic/rithmic_live.dart): 1- and 5-minute candles built from
// real Rithmic trades, as forming updates and as closed candles, plus the last price, the source label, the connection
// status and the last update time. Signals, the CHE paper account and the side-by-side view consume this; none of them
// talks to Rithmic directly.
//
// Rules every consumer can rely on:
// - Only real trades make candles. A period with no trades has no candle; nothing is filled in or invented.
// - A candle is [CheCandle.closed] once its period ended and a short grace for late trades passed. Closed candles are
//   final: an engine never sees one change afterwards. The chart may still show a very late trade in its candle.
// - [CheMarketSnapshot.isLive] is true only while Rithmic trades are actually arriving. Delayed data (Yahoo) never
//   comes through this feed and is never labelled live.
// - Read only: nothing here can place, change or cancel an order.
import 'dart:async';

import '../rithmic/rithmic_candles.dart';
import '../rithmic/rithmic_live.dart';

/// The candle widths this feed builds.
const kCheFeedMinutes = [1, 5];

enum CheFeedConnection { off, waiting, connected, quiet, disconnected, failed }

class CheCandle {
  const CheCandle({
    required this.start,
    required this.minutes,
    required this.open,
    required this.high,
    required this.low,
    required this.close,
    required this.volume,
    required this.trades,
    required this.closed,
    required this.source,
    required this.symbol,
  });

  /// Period start, UTC.
  final DateTime start;
  final int minutes;
  final double open, high, low, close;
  final int volume, trades;

  /// False while the period is still forming.
  final bool closed;

  /// Always 'rithmic' for this feed.
  final String source;
  final String symbol;

  DateTime get end => start.add(Duration(minutes: minutes));

  @override
  String toString() => '$symbol ${minutes}m ${start.toIso8601String()} O$open H$high L$low C$close V$volume${closed ? '' : ' (forming)'}';
}

class CheMarketSnapshot {
  const CheMarketSnapshot({
    required this.symbol,
    required this.exchange,
    required this.source,
    required this.sourceLabel,
    required this.connection,
    required this.statusLabel,
    required this.isLive,
    required this.lastPrice,
    required this.lastTradeAt,
    required this.lastUpdate,
  });

  final String symbol, exchange;

  /// 'rithmic', or 'none' when no Rithmic session exists.
  final String source;

  /// For headers: "Rithmic live — MNQZ6", "Rithmic MNQZ6 (recorded on this phone)" or "No live feed".
  final String sourceLabel;
  final CheFeedConnection connection;

  /// The connection in words, never stronger than the evidence.
  final String statusLabel;
  final bool isLive;
  final double? lastPrice;

  /// When the newest trade happened (Rithmic's timestamp).
  final DateTime? lastTradeAt;

  /// When this phone last received a trade.
  final DateTime? lastUpdate;
}

class CheMarketFeed {
  CheMarketFeed({CheRithmicLive? live, DateTime Function()? clock, this.closeGrace = const Duration(seconds: 2)})
      : _live = live ?? CheRithmicLive.instance,
        _clock = clock ?? DateTime.now {
    _live.addListener(_onLive);
  }

  /// The app-wide feed over the app-wide Rithmic session.
  static final instance = CheMarketFeed();

  final CheRithmicLive _live;
  final DateTime Function() _clock;

  /// How long after a period ends a candle waits for late trades before it is closed.
  final Duration closeGrace;

  final _snapshots = StreamController<CheMarketSnapshot>.broadcast();
  final _candles = {for (final m in kCheFeedMinutes) m: StreamController<CheCandle>.broadcast()};
  final _closedThrough = <int, DateTime>{};
  final _timers = <int, Timer>{};

  /// Every change of price, status or last update.
  Stream<CheMarketSnapshot> get snapshots => _snapshots.stream;

  /// Forming updates and closed candles for [minutes] (1 or 5). A closed candle arrives exactly once.
  Stream<CheCandle> candles(int minutes) {
    final c = _candles[minutes];
    if (c == null) throw ArgumentError.value(minutes, 'minutes', 'CHE builds ${kCheFeedMinutes.join(' and ')}-minute candles');
    return c.stream;
  }

  /// The candles recorded so far for [minutes], oldest first; the last one may be forming.
  List<CheCandle> history(int minutes) {
    final now = _clock();
    return [for (final c in _live.book.candles(minutes)) _candle(c, minutes, closed: _isClosed(c.t, minutes, now))];
  }

  CheMarketSnapshot get current {
    final status = _connection(_live.status);
    final recorded = !_live.book.isEmpty;
    final last = recorded ? _live.book.candles(1).last.c : null;
    return CheMarketSnapshot(
      symbol: _live.symbol,
      exchange: _live.exchange,
      source: _live.attached || recorded ? 'rithmic' : 'none',
      sourceLabel: _live.isLive
          ? 'Rithmic live — ${_live.symbol}'
          : recorded
              ? 'Rithmic ${_live.symbol} (recorded on this phone)'
              : 'No live feed',
      connection: status,
      statusLabel: _live.statusLabel,
      isLive: _live.isLive,
      lastPrice: last,
      lastTradeAt: _live.lastTradeAt,
      lastUpdate: _live.lastReceivedAt,
    );
  }

  bool _isClosed(DateTime start, int minutes, DateTime now) => !now.toUtc().isBefore(start.add(Duration(minutes: minutes)).add(closeGrace));

  CheCandle _candle(RithmicCandle c, int minutes, {required bool closed}) => CheCandle(
        start: c.t,
        minutes: minutes,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volume: c.v,
        trades: c.trades,
        closed: closed,
        source: 'rithmic',
        symbol: _live.symbol,
      );

  static CheFeedConnection _connection(RithmicLiveStatus s) => switch (s) {
        RithmicLiveStatus.off => CheFeedConnection.off,
        RithmicLiveStatus.waiting => CheFeedConnection.waiting,
        RithmicLiveStatus.connected => CheFeedConnection.connected,
        RithmicLiveStatus.quiet => CheFeedConnection.quiet,
        RithmicLiveStatus.disconnected => CheFeedConnection.disconnected,
        RithmicLiveStatus.loginFailed => CheFeedConnection.failed,
      };

  void _onLive() {
    if (!_snapshots.isClosed) _snapshots.add(current);
    for (final m in kCheFeedMinutes) {
      _advance(m);
    }
  }

  /// Emits the forming candle, and closes every earlier period that has not been closed yet.
  void _advance(int minutes) {
    if (_live.book.isEmpty) return;
    final now = _clock();
    final all = _live.book.candles(minutes);
    final done = _closedThrough[minutes];
    for (final c in all) {
      if (done != null && !c.t.isAfter(done)) continue;
      // Final only once the period and its grace for late trades are over, never earlier.
      if (!_isClosed(c.t, minutes, now)) continue;
      _emit(minutes, _candle(c, minutes, closed: true));
      _closedThrough[minutes] = c.t;
    }
    final last = all.last;
    final closedThrough = _closedThrough[minutes];
    if (closedThrough == null || last.t.isAfter(closedThrough)) {
      _emit(minutes, _candle(last, minutes, closed: false));
      _timers[minutes]?.cancel();
      final wait = last.t.add(Duration(minutes: minutes)).add(closeGrace).difference(now);
      _timers[minutes] = Timer(wait.isNegative ? Duration.zero : wait, () => _advance(minutes));
    }
  }

  void _emit(int minutes, CheCandle c) {
    final s = _candles[minutes]!;
    if (!s.isClosed) s.add(c);
  }

  Future<void> dispose() async {
    _live.removeListener(_onLive);
    for (final t in _timers.values) {
      t.cancel();
    }
    await _snapshots.close();
    for (final c in _candles.values) {
      await c.close();
    }
  }
}
