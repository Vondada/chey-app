// 1-minute and 5-minute candles built on this phone from real Rithmic trades.
//
// Rules (owner, 2026-10-23): a candle exists only for a period that had at least one real trade, so a quiet
// minute stays a gap; the bar still in progress is marked forming; a trade arriving out of order lands in its own
// period and only becomes the open or close when its timestamp is earliest or latest there. Nothing here is ever
// sent to the Worker or labelled anything but Rithmic.
import 'rithmic_wire.dart';

/// One candle. [t] is the period's start, in UTC.
class RithmicCandle {
  RithmicCandle._(this.t, double price, int size, DateTime at)
      : o = price,
        h = price,
        l = price,
        c = price,
        v = size,
        trades = 1,
        _openAt = at,
        _closeAt = at;

  final DateTime t;
  double o, h, l, c;
  int v, trades;
  DateTime _openAt, _closeAt;

  /// When the last trade in this candle happened.
  DateTime get lastTradeAt => _closeAt;

  void _add(double price, int size, DateTime at) {
    if (price > h) h = price;
    if (price < l) l = price;
    v += size;
    trades++;
    if (at.isBefore(_openAt)) {
      _openAt = at;
      o = price;
    }
    if (!at.isBefore(_closeAt)) {
      _closeAt = at;
      c = price;
    }
  }

  RithmicCandle _copyAt(DateTime start) => RithmicCandle._(start, o, v, _openAt)
    ..h = h
    ..l = l
    ..c = c
    ..trades = trades
    .._closeAt = _closeAt;
}

/// The exchange-side time of a Rithmic trade: seconds since the epoch plus microseconds, or null when the
/// update carried no timestamp (such an update is never placed in a candle).
DateTime? rithmicTradeTime(RithmicLastTrade t) {
  final s = t.ssboe;
  if (s == null || s <= 0) return null;
  return DateTime.fromMicrosecondsSinceEpoch(s * 1000000 + (t.usecs ?? 0).clamp(0, 999999), isUtc: true);
}

/// The candle book for one contract.
class RithmicCandleBook {
  RithmicCandleBook({this.maxMinutes = 2880});

  /// How many 1-minute candles are kept (two days by default); older ones fall off the left.
  final int maxMinutes;
  final _minutes = <int, RithmicCandle>{};

  /// Trades refused because they had no price or no timestamp; shown so nothing is silently dropped.
  int refused = 0;
  DateTime? lastTradeAt;

  bool get isEmpty => _minutes.isEmpty;

  /// Adds one real trade. Returns false when it cannot be placed (no price, no timestamp).
  bool addTrade(RithmicLastTrade trade) {
    final price = trade.price;
    final at = rithmicTradeTime(trade);
    if (price == null || !price.isFinite || price <= 0 || at == null) {
      refused++;
      return false;
    }
    addPrice(price, trade.size ?? 0, at);
    return true;
  }

  void addPrice(double price, int size, DateTime at) {
    final utc = at.toUtc();
    final key = utc.millisecondsSinceEpoch ~/ 60000;
    final bar = _minutes[key];
    if (bar == null) {
      _minutes[key] = RithmicCandle._(DateTime.fromMillisecondsSinceEpoch(key * 60000, isUtc: true), price, size < 0 ? 0 : size, utc);
      if (_minutes.length > maxMinutes) {
        final oldest = _minutes.keys.reduce((a, b) => a < b ? a : b);
        _minutes.remove(oldest);
      }
    } else {
      bar._add(price, size < 0 ? 0 : size, utc);
    }
    if (lastTradeAt == null || utc.isAfter(lastTradeAt!)) lastTradeAt = utc;
  }

  /// The candles for [minutes]-wide periods (1 or 5), oldest first. 5-minute candles roll up only the
  /// 1-minute candles that exist, so a 5-minute period with no trades has no candle.
  List<RithmicCandle> candles(int minutes) {
    final keys = _minutes.keys.toList()..sort();
    if (minutes <= 1) return [for (final k in keys) _minutes[k]!];
    final out = <RithmicCandle>[];
    RithmicCandle? cur;
    var curKey = -1;
    for (final k in keys) {
      final m = _minutes[k]!;
      final bucket = k ~/ minutes;
      if (cur == null || bucket != curKey) {
        cur = m._copyAt(DateTime.fromMillisecondsSinceEpoch(bucket * minutes * 60000, isUtc: true));
        curKey = bucket;
        out.add(cur);
      } else {
        if (m.h > cur.h) cur.h = m.h;
        if (m.l < cur.l) cur.l = m.l;
        cur.v += m.v;
        cur.trades += m.trades;
        cur.c = m.c;
        cur._closeAt = m._closeAt;
      }
    }
    return out;
  }

  /// True while [c]'s period has not ended yet at [now].
  static bool forming(RithmicCandle c, int minutes, DateTime now) => now.toUtc().isBefore(c.t.add(Duration(minutes: minutes)));

  void clear() {
    _minutes.clear();
    refused = 0;
    lastTradeAt = null;
  }
}
