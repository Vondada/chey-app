// BTC and ETH candles built on this phone from real exchange trades (owner, 2026-10-25: live crypto chart).
//
// Pure and synchronous, so it is unit tested without a socket. lib/trading/che_crypto_stream.dart feeds it.
//
// Rules:
// - Only real trades make candles. A period with no trade has no candle: a gap stays a gap, nothing is filled in.
// - Each trade lands in the period of its exchange timestamp (UTC), never the time this phone received it.
// - A trade that arrives out of order lands in its own period; it becomes the open only when it is the earliest trade
//   there and the close only when it is the latest.
// - A trade id already seen (an exchange re-sends its snapshot on every reconnect) is ignored, so nothing is counted
//   twice.
// - Candles from different exchanges are never mixed: one aggregator holds one venue's trades.
// - Read only: nothing here places, changes or cancels an order.
import 'dart:collection';

/// The candle widths the stream builds, in minutes: the chart's 1m, 5m, 15m, 1h and 1d.
const kCryptoStreamMinutes = [1, 5, 15, 60, 1440];

/// The chart timeframe ('1m', '5m', '15m', '1h', '1d') in minutes; null for any other.
int? cryptoTimeframeMinutes(String tf) => const {'1m': 1, '5m': 5, '15m': 15, '1h': 60, '1d': 1440}[tf];

/// One trade as an exchange published it.
class CryptoTrade {
  const CryptoTrade({required this.venue, required this.product, required this.tradeId, required this.price, required this.size, required this.time});

  /// 'coinbase' or 'kraken'.
  final String venue;

  /// 'BTC-USD' or 'ETH-USD'.
  final String product;
  final String tradeId;
  final double price, size;

  /// The exchange's trade time, UTC.
  final DateTime time;

  @override
  String toString() => '$venue $product #$tradeId $price x $size @ ${time.toIso8601String()}';
}

/// One candle. [start] is the period start, UTC.
class CryptoCandle {
  CryptoCandle._(this.start, this.minutes, CryptoTrade t)
      : open = t.price,
        high = t.price,
        low = t.price,
        close = t.price,
        volume = t.size,
        trades = 1,
        openAt = t.time,
        closeAt = t.time;

  final DateTime start;
  final int minutes;
  double open, high, low, close, volume;
  int trades;

  /// The times of the earliest and latest trade in this candle.
  DateTime openAt, closeAt;

  DateTime get end => start.add(Duration(minutes: minutes));

  void _add(CryptoTrade t) {
    if (t.price > high) high = t.price;
    if (t.price < low) low = t.price;
    volume += t.size;
    trades++;
    if (t.time.isBefore(openAt)) {
      openAt = t.time;
      open = t.price;
    }
    if (!t.time.isBefore(closeAt)) {
      closeAt = t.time;
      close = t.price;
    }
  }

  @override
  String toString() => '${minutes}m ${start.toIso8601String()} O$open H$high L$low C$close V$volume ($trades trades)';
}

/// The period start for [t] at [minutes]: whole minutes since the Unix epoch, so 1d periods start at 00:00 UTC like
/// the exchanges' daily candles.
DateTime cryptoPeriodStart(DateTime t, int minutes) {
  final ms = minutes * 60000;
  final at = t.toUtc().millisecondsSinceEpoch;
  return DateTime.fromMillisecondsSinceEpoch(at - at % ms, isUtc: true);
}

/// Candles for one venue and product, at every width in [minutes].
class CryptoCandleAggregator {
  CryptoCandleAggregator({this.minutes = kCryptoStreamMinutes, this.maxCandles = 1500, this.rememberIds = 20000});

  final List<int> minutes;

  /// Candles kept per width; the oldest drop off. A trade older than the oldest kept candle is dropped, never
  /// placed in a candle that already left.
  final int maxCandles;

  /// How many recent trade ids are remembered for duplicate detection.
  final int rememberIds;

  final _byWidth = <int, SplayTreeMap<int, CryptoCandle>>{};
  final _seen = <String>{}; // insertion ordered, so the oldest id is dropped first

  /// Trades accepted, and trades ignored as duplicates or too old.
  int accepted = 0, duplicates = 0, tooOld = 0;

  /// The newest trade accepted (by exchange time).
  CryptoTrade? last;

  bool get isEmpty => accepted == 0;

  /// Adds one trade. False when it was a duplicate or older than every kept candle.
  bool add(CryptoTrade t) {
    final key = '${t.venue}:${t.product}:${t.tradeId}';
    if (_seen.contains(key)) {
      duplicates++;
      return false;
    }
    if (!t.price.isFinite || t.price <= 0 || !t.size.isFinite || t.size < 0) return false;
    // Too old for the widest kept history of the narrowest width: it would make a candle that already dropped off.
    final narrow = _byWidth[minutes.first];
    if (narrow != null && narrow.length >= maxCandles && cryptoPeriodStart(t.time, minutes.first).millisecondsSinceEpoch < narrow.firstKey()!) {
      tooOld++;
      return false;
    }
    _seen.add(key);
    if (_seen.length > rememberIds) _seen.remove(_seen.first);
    for (final m in minutes) {
      final book = _byWidth.putIfAbsent(m, SplayTreeMap.new);
      final start = cryptoPeriodStart(t.time, m);
      final c = book[start.millisecondsSinceEpoch];
      if (c == null) {
        book[start.millisecondsSinceEpoch] = CryptoCandle._(start, m, t);
        while (book.length > maxCandles) {
          book.remove(book.firstKey());
        }
      } else {
        c._add(t);
      }
    }
    accepted++;
    if (last == null || !t.time.isBefore(last!.time)) last = t;
    return true;
  }

  /// Oldest first. Empty for a width with no trades yet.
  List<CryptoCandle> candles(int width) => List.unmodifiable(_byWidth[width]?.values ?? const <CryptoCandle>[]);

  void clear() {
    _byWidth.clear();
    _seen.clear();
    accepted = duplicates = tooOld = 0;
    last = null;
  }
}

/// One bar for the chart: REST history or streamed.
class CryptoBar {
  const CryptoBar(this.t, this.o, this.h, this.l, this.c, this.v, {this.streamed = false});
  final DateTime t;
  final double o, h, l, c, v;

  /// True when the bar holds streamed trades (alone, or joined with the REST bar of the same period).
  final bool streamed;
}

/// The REST history with streamed candles laid over it, oldest first. Every bar is a real exchange candle or built
/// from real trades; nothing is filled in.
///
/// - A period only REST has: the REST bar.
/// - A period before the newest REST bar that both have: the REST bar unchanged. The exchange's own candle for a
///   finished period is complete; the stream may have joined late or dropped for part of it.
/// - The newest REST bar's period, when the stream has it too: it was usually still forming when it was fetched, so
///   the REST bar supplies the open, high and low are the wider of the two, the close is the streamed one (newer), and
///   the volume is the larger of the two: a lower bound, never a sum that could count a trade twice.
/// - Periods after the newest REST bar: streamed candles only. A period with no trade has no bar.
List<CryptoBar> mergeCryptoHistory(List<CryptoBar> history, List<CryptoCandle> streamed) {
  if (streamed.isEmpty) return history;
  final newestRest = history.isEmpty ? null : history.last.t;
  final rest = {for (final b in history) b.t.millisecondsSinceEpoch: b};
  final out = SplayTreeMap<int, CryptoBar>()..addAll(rest);
  for (final c in streamed) {
    final key = c.start.millisecondsSinceEpoch;
    final r = rest[key];
    if (r == null) {
      out[key] = CryptoBar(c.start, c.open, c.high, c.low, c.close, c.volume, streamed: true);
    } else if (newestRest != null && c.start.isAtSameMomentAs(newestRest)) {
      out[key] = CryptoBar(c.start, r.o, c.high > r.h ? c.high : r.h, c.low < r.l ? c.low : r.l, c.close, c.volume > r.v ? c.volume : r.v, streamed: true);
    }
  }
  return out.values.toList();
}
