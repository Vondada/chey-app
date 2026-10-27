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

/// MACD (12, 26, 9) on closes: the line is EMA 12 minus EMA 26, the signal is an EMA of the line, and the
/// histogram is line minus signal. Null until each part has enough history.
({List<double?> macd, List<double?> signal, List<double?> hist}) macd(List<double> closes, {int fast = 12, int slow = 26, int signal = 9}) {
  final fastEma = ema(closes, fast), slowEma = ema(closes, slow);
  final line = List<double?>.filled(closes.length, null);
  for (var i = 0; i < closes.length; i++) {
    final f = fastEma[i], s = slowEma[i];
    if (f != null && s != null) line[i] = f - s;
  }
  final firstLine = line.indexWhere((v) => v != null);
  final sig = List<double?>.filled(closes.length, null);
  if (firstLine >= 0) {
    final tail = [for (var i = firstLine; i < closes.length; i++) line[i] ?? 0.0];
    final tailSignal = ema(tail, signal);
    for (var i = 0; i < tail.length; i++) {
      sig[firstLine + i] = tailSignal[i];
    }
  }
  final hist = List<double?>.filled(closes.length, null);
  for (var i = 0; i < closes.length; i++) {
    final m = line[i], g = sig[i];
    if (m != null && g != null) hist[i] = m - g;
  }
  return (macd: line, signal: sig, hist: hist);
}

/// Average true range (Wilder). The first bar's true range is high minus low; later bars also reach back to the
/// previous close. Null until [period] bars exist.
List<double?> atr(List<CheIndicatorBar> bars, [int period = 14]) {
  final out = List<double?>.filled(bars.length, null);
  if (period <= 0 || bars.length < period) return out;
  final tr = List<double>.filled(bars.length, 0);
  for (var i = 0; i < bars.length; i++) {
    final b = bars[i];
    if (i == 0) {
      tr[i] = b.h - b.l;
    } else {
      final pc = bars[i - 1].c;
      tr[i] = math.max(b.h - b.l, math.max((b.h - pc).abs(), (b.l - pc).abs()));
    }
  }
  var sum = 0.0;
  for (var i = 0; i < period; i++) {
    sum += tr[i];
  }
  var a = sum / period;
  out[period - 1] = a;
  for (var i = period; i < bars.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

/// Heikin-Ashi bars: a smoothed view of the same bars, for reading trend. The same time and volume; the prices are
/// the averaged ones. Drawing aid only, never a price the market traded at.
List<CheIndicatorBar> heikinAshi(List<CheIndicatorBar> bars) {
  final out = <CheIndicatorBar>[];
  double? prevO, prevC;
  for (final b in bars) {
    final c = (b.o + b.h + b.l + b.c) / 4;
    final o = prevO == null || prevC == null ? (b.o + b.c) / 2 : (prevO + prevC) / 2;
    final h = math.max(b.h, math.max(o, c));
    final l = math.min(b.l, math.min(o, c));
    out.add(CheIndicatorBar(b.t, o, h, l, c, b.v));
    prevO = o;
    prevC = c;
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

/// When the session holding [t] began, in UTC: midnight for crypto, 22:00 UTC the evening before for futures
/// (the same day boundary as [sessionOf]).
DateTime sessionStartOf(DateTime t, {bool futures = false}) {
  final shift = futures ? const Duration(hours: 2) : Duration.zero;
  final u = t.toUtc().add(shift);
  return DateTime.utc(u.year, u.month, u.day).subtract(shift);
}

/// The opening range: high and low of the first [minutes] after the latest session's start, once those minutes
/// are complete. Null when the bars are too coarse (a bar longer than the range), the range has not finished yet,
/// or the loaded history does not cover the whole opening interval (it starts mid-session, or bars are missing):
/// a range drawn from part of the open would be a wrong level, not a smaller one.
({double high, double low})? openingRange(List<CheIndicatorBar> bars, {int minutes = 30, bool futures = false}) {
  if (bars.length < 2) return null;
  var step = 0;
  for (var i = 1; i < bars.length; i++) {
    final gap = bars[i].t.difference(bars[i - 1].t).inSeconds;
    if (gap > 0 && (step == 0 || gap < step)) step = gap;
  }
  final range = minutes * 60;
  if (step <= 0 || step > range) return null;
  final start = sessionStartOf(bars.last.t, futures: futures);
  final end = start.add(Duration(seconds: range));
  if (bars.last.t.add(Duration(seconds: step)).isBefore(end)) return null;
  var hi = -double.infinity, lo = double.infinity;
  var count = 0;
  DateTime? first;
  for (final b in bars) {
    if (b.t.isBefore(start) || !b.t.isBefore(end)) continue;
    first ??= b.t;
    count++;
    hi = math.max(hi, b.h);
    lo = math.min(lo, b.l);
  }
  if (first == null || !first.isAtSameMomentAs(start) || count * step < range) return null;
  return (high: hi, low: lo);
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
