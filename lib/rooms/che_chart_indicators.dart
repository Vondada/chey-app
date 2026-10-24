// Chart indicators for the Trading Room (owner, 2026-10-24): VWAP, EMA 9/20/50/200, RSI 14, Bollinger
// Bands (20, 2), session high/low and the opening range. Computed on this phone from the bars the chart
// already shows; they are drawing aids, never trade signals, and say so when read aloud.
//
// Every series has one value per bar; null where there is not enough history yet (an EMA 200 on 80 bars
// is null on every bar, never a guess).
import 'dart:math' as math;

/// The bar fields the indicators read. ChartBar implements this shape through [CheIndicatorBar.of].
class CheIndicatorBar {
  const CheIndicatorBar(this.t, this.o, this.h, this.l, this.c, [this.v = 0]);
  final DateTime t;
  final double o, h, l, c, v;
}

/// The indicators the owner can switch on. The ids are what the chart saves and voice names.
const kChartIndicators = <String, String>{
  'vwap': 'VWAP',
  'ema9': 'EMA 9',
  'ema20': 'EMA 20',
  'ema50': 'EMA 50',
  'ema200': 'EMA 200',
  'bb': 'Bollinger',
  'rsi': 'RSI 14',
  'session': 'Session high/low',
  'orb': 'Opening range',
};

/// Exponential moving average seeded with the simple average of the first [period] closes.
List<double?> ema(List<double> closes, int period) {
  final out = List<double?>.filled(closes.length, null);
  if (period <= 0 || closes.length < period) return out;
  var sum = 0.0;
  for (var i = 0; i < period; i++) {
    sum += closes[i];
  }
  var e = sum / period;
  out[period - 1] = e;
  final k = 2 / (period + 1);
  for (var i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/// Wilder's RSI.
List<double?> rsi(List<double> closes, [int period = 14]) {
  final out = List<double?>.filled(closes.length, null);
  if (closes.length <= period) return out;
  var gain = 0.0, loss = 0.0;
  for (var i = 1; i <= period; i++) {
    final d = closes[i] - closes[i - 1];
    if (d >= 0) {
      gain += d;
    } else {
      loss -= d;
    }
  }
  gain /= period;
  loss /= period;
  double value(double g, double l) => l == 0 ? (g == 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  out[period] = value(gain, loss);
  for (var i = period + 1; i < closes.length; i++) {
    final d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + math.max(d, 0)) / period;
    loss = (loss * (period - 1) + math.max(-d, 0)) / period;
    out[i] = value(gain, loss);
  }
  return out;
}

/// Bollinger Bands: middle (simple average), upper and lower at [k] population standard deviations.
({List<double?> mid, List<double?> upper, List<double?> lower}) bollinger(List<double> closes, [int period = 20, double k = 2]) {
  final mid = List<double?>.filled(closes.length, null), up = List<double?>.filled(closes.length, null), lo = List<double?>.filled(closes.length, null);
  for (var i = period - 1; i < closes.length; i++) {
    var s = 0.0;
    for (var j = i - period + 1; j <= i; j++) {
      s += closes[j];
    }
    final m = s / period;
    var v = 0.0;
    for (var j = i - period + 1; j <= i; j++) {
      v += (closes[j] - m) * (closes[j] - m);
    }
    final sd = math.sqrt(v / period);
    mid[i] = m;
    up[i] = m + k * sd;
    lo[i] = m - k * sd;
  }
  return (mid: mid, upper: up, lower: lo);
}

/// The trading day a bar belongs to, in UTC. Crypto trades all day, so its session is the UTC day; CME futures
/// sessions start at 22:00 UTC (17:00 Chicago in winter, close enough for a drawing aid), so their day rolls there.
String sessionOf(DateTime t, {bool futures = false}) {
  final u = futures ? t.toUtc().add(const Duration(hours: 2)) : t.toUtc();
  return '${u.year}-${u.month}-${u.day}';
}

/// Volume-weighted average price from the typical price, reset each session. Null where volume is zero so far.
List<double?> vwap(List<CheIndicatorBar> bars, {bool futures = false}) {
  final out = List<double?>.filled(bars.length, null);
  String? day;
  var pv = 0.0, vol = 0.0;
  for (var i = 0; i < bars.length; i++) {
    final b = bars[i];
    final s = sessionOf(b.t, futures: futures);
    if (s != day) {
      day = s;
      pv = 0;
      vol = 0;
    }
    pv += (b.h + b.l + b.c) / 3 * b.v;
    vol += b.v;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

/// The latest session's high and low so far, or null with no bars.
({double high, double low})? sessionHighLow(List<CheIndicatorBar> bars, {bool futures = false}) {
  if (bars.isEmpty) return null;
  final day = sessionOf(bars.last.t, futures: futures);
  var hi = -double.infinity, lo = double.infinity;
  for (final b in bars.reversed) {
    if (sessionOf(b.t, futures: futures) != day) break;
    hi = math.max(hi, b.h);
    lo = math.min(lo, b.l);
  }
  return (high: hi, low: lo);
}

/// The opening range: high and low of the first [minutes] of the latest session, once those minutes are complete.
/// Null when the bars are too coarse (a bar longer than the range) or the range has not finished yet.
({double high, double low})? openingRange(List<CheIndicatorBar> bars, {int minutes = 30, bool futures = false}) {
  if (bars.length < 2) return null;
  final step = bars[1].t.difference(bars[0].t).inMinutes;
  if (step <= 0 || step > minutes) return null;
  final day = sessionOf(bars.last.t, futures: futures);
  final first = bars.lastIndexWhere((b) => sessionOf(b.t, futures: futures) != day) + 1;
  final start = bars[first].t;
  final end = start.add(Duration(minutes: minutes));
  if (!bars.last.t.add(Duration(minutes: step)).isAfter(end.subtract(const Duration(seconds: 1)))) return null;
  var hi = -double.infinity, lo = double.infinity;
  for (var i = first; i < bars.length && bars[i].t.isBefore(end); i++) {
    hi = math.max(hi, bars[i].h);
    lo = math.min(lo, bars[i].l);
  }
  return hi.isFinite ? (high: hi, low: lo) : null;
}

/// The series the chart draws over the candles for the switched-on indicators, keyed by line label.
Map<String, List<double?>> overlaySeries(List<CheIndicatorBar> bars, Set<String> on, {bool futures = false}) {
  final closes = [for (final b in bars) b.c];
  final out = <String, List<double?>>{};
  for (final (id, period) in const [('ema9', 9), ('ema20', 20), ('ema50', 50), ('ema200', 200)]) {
    if (on.contains(id)) out[kChartIndicators[id]!] = ema(closes, period);
  }
  if (on.contains('vwap')) out['VWAP'] = vwap(bars, futures: futures);
  if (on.contains('bb')) {
    final b = bollinger(closes);
    out['BB upper'] = b.upper;
    out['BB mid'] = b.mid;
    out['BB lower'] = b.lower;
  }
  return out;
}

/// One sentence of the switched-on indicators' latest values, for Read Aloud and VoiceOver.
String indicatorSummary(List<CheIndicatorBar> bars, Set<String> on, {bool futures = false, String Function(double)? fmt}) {
  if (bars.isEmpty || on.isEmpty) return '';
  final f = fmt ?? (double x) => x.toStringAsFixed(2);
  final parts = <String>[];
  for (final e in overlaySeries(bars, on, futures: futures).entries) {
    if (e.key == 'BB mid') continue;
    final v = e.value.last;
    parts.add(v == null ? '${e.key} needs more bars' : '${e.key} ${f(v)}');
  }
  if (on.contains('rsi')) {
    final v = rsi([for (final b in bars) b.c]).last;
    parts.add(v == null ? 'RSI needs more bars' : 'RSI ${v.toStringAsFixed(1)}');
  }
  if (on.contains('session')) {
    final s = sessionHighLow(bars, futures: futures);
    if (s != null) parts.add('session high ${f(s.high)}, low ${f(s.low)}');
  }
  if (on.contains('orb')) {
    final r = openingRange(bars, futures: futures);
    parts.add(r == null ? 'opening range not available on this timeframe yet' : '30-minute opening range ${f(r.low)} to ${f(r.high)}');
  }
  return parts.isEmpty ? '' : 'Indicators (drawing aids, not signals): ${parts.join('; ')}.';
}
