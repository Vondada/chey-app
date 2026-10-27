// CHE setup engine (owner, 2026-10-23): follows each strategy's setup on real candles and moves it
// through WATCHING → FORMING → NEAR ENTRY → READY → TRIGGERED → ACTIVE → TARGET HIT / STOPPED /
// INVALIDATED / EXPIRED.
//
// - The entry rules are the research engine's own, ported from server/cloudflare/trading_evidence.js
//   (INTRADAY_CANDIDATES: 'ema-pullback-5m', 'vwap-revert-5m', 'sweep-reclaim-5m'), including the
//   6–60 point risk bounds, the 1-tick stop offsets, the 2R target (VWAP for the reversion) and the
//   16:55 New York flat time. A signal here is the same signal the backtests counted.
// - TRIGGERED needs a CLOSED bar that meets every entry rule. READY needs the bar still forming to
//   meet every rule so far, and says it only counts if the bar closes that way.
// - No look-ahead: an evaluation at bar i reads bars 0..i only. Indicators are recomputed from the
//   closed bars (plus the forming bar, for intrabar stages only).
// - Pure Dart and deterministic: the same bars in the same order give the same stages and signals.
// - Read only: nothing here can place an order. ACTIVE/TARGET HIT/STOPPED track price against the
//   planned levels; the CHE paper account books the paper fills with costs.
import 'dart:math' as math;

import 'che_trade_signal.dart';

/// One candle as the engine needs it. [start] is UTC.
class CheSetupBar {
  const CheSetupBar({required this.start, required this.minutes, required this.open, required this.high, required this.low, required this.close, this.volume = 0});
  final DateTime start;
  final int minutes;
  final double open, high, low, close;
  final int volume;
  DateTime get end => start.add(Duration(minutes: minutes));
}

/// The strategies the engine follows, with the research ledger's ids.
const kCheSetupStrategies = <String, String>{
  'ema-pullback-5m': 'Trend pullback to the 20 EMA',
  'vwap-revert-5m': 'VWAP 2-sigma reversion',
  'sweep-reclaim-5m': 'Liquidity sweep and reclaim',
};

const _tick = 0.25;
const _minRisk = 6.0;
const _maxRisk = 60.0;
const _targetR = 2.0;
const _swingN = 3;
const _minBars = 50;

// ─── New York time without a timezone database (US rules since 2007) ─────

DateTime _nthSunday(int year, int month, int n) {
  var d = DateTime.utc(year, month, 1);
  while (d.weekday != DateTime.sunday) {
    d = d.add(const Duration(days: 1));
  }
  return d.add(Duration(days: 7 * (n - 1)));
}

/// New York offset from UTC at [utc]: -4 h in daylight time, -5 h otherwise.
Duration cheNewYorkOffset(DateTime utc) {
  final y = utc.toUtc().year;
  final start = _nthSunday(y, 3, 2).add(const Duration(hours: 7)); // 2:00 EST = 07:00 UTC
  final end = _nthSunday(y, 11, 1).add(const Duration(hours: 6)); // 2:00 EDT = 06:00 UTC
  final t = utc.toUtc();
  return (!t.isBefore(start) && t.isBefore(end)) ? const Duration(hours: -4) : const Duration(hours: -5);
}

/// New York wall clock for a UTC instant (returned as a UTC-flagged DateTime holding local fields).
DateTime cheNewYork(DateTime utc) => utc.toUtc().add(cheNewYorkOffset(utc));

/// Minutes since New York midnight.
int cheNewYorkMinutes(DateTime utc) {
  final ny = cheNewYork(utc);
  return ny.hour * 60 + ny.minute;
}

/// The CME trading day (it starts at 18:00 New York), as yyyy-mm-dd.
String cheTradeDay(DateTime utc) {
  var ny = cheNewYork(utc);
  if (ny.hour >= 18) ny = ny.add(const Duration(days: 1));
  return '${ny.year}-${ny.month.toString().padLeft(2, '0')}-${ny.day.toString().padLeft(2, '0')}';
}

/// Flat by 16:55 New York (before the CME daily break), like the research engine.
bool cheAfterFlatTime(DateTime utc) {
  final m = cheNewYorkMinutes(utc);
  return m >= 16 * 60 + 55 && m < 18 * 60;
}

// ─── Indicators (same formulas as intradayContext) ───────────────────────

class CheIndicators {
  CheIndicators._(this.bars, this.ema20, this.ema50, this.vwap, this.vwapSd, this.sessionBars, this.day, this.lastLow, this.lastHigh, this.swingLows, this.swingHighs);

  final List<CheSetupBar> bars;
  final List<double?> ema20, ema50, vwap, vwapSd, lastLow, lastHigh;
  final List<int> sessionBars;
  final List<String> day;

  /// Confirmed swings in order, for market structure.
  final List<double> swingLows, swingHighs;

  factory CheIndicators.of(List<CheSetupBar> c) {
    final n = c.length;
    List<double?> ema(int len) {
      final out = List<double?>.filled(n, null);
      final k = 2 / (len + 1);
      double? v;
      for (var i = 0; i < n; i++) {
        v = v == null ? c[i].close : c[i].close * k + v * (1 - k);
        if (i >= len - 1) out[i] = v;
      }
      return out;
    }

    final vwap = List<double?>.filled(n, null), sd = List<double?>.filled(n, null);
    final sessionBars = List<int>.filled(n, 0);
    final day = <String>[];
    final lastLow = List<double?>.filled(n, null), lastHigh = List<double?>.filled(n, null);
    final swingLows = <double>[], swingHighs = <double>[];
    double pv = 0, vol = 0, pv2 = 0;
    var count = 0;
    String? cur;
    double? confLow, confHigh;
    bool isSwingLow(int j) {
      for (var m = j - _swingN; m <= j + _swingN; m++) {
        if (m != j && c[m].low <= c[j].low) return false;
      }
      return true;
    }

    bool isSwingHigh(int j) {
      for (var m = j - _swingN; m <= j + _swingN; m++) {
        if (m != j && c[m].high >= c[j].high) return false;
      }
      return true;
    }

    for (var i = 0; i < n; i++) {
      final b = c[i];
      final d = cheTradeDay(b.start);
      day.add(d);
      if (d != cur) {
        cur = d;
        pv = 0;
        vol = 0;
        pv2 = 0;
        count = 0;
      }
      final w = b.volume > 0 ? b.volume.toDouble() : 1.0;
      final tp = (b.high + b.low + b.close) / 3;
      pv += tp * w;
      vol += w;
      pv2 += tp * tp * w;
      count += 1;
      vwap[i] = pv / vol;
      sd[i] = math.sqrt(math.max(0, pv2 / vol - vwap[i]! * vwap[i]!));
      sessionBars[i] = count;
      final j = i - _swingN;
      if (j - _swingN >= 0) {
        if (isSwingLow(j)) {
          confLow = c[j].low;
          swingLows.add(confLow);
        }
        if (isSwingHigh(j)) {
          confHigh = c[j].high;
          swingHighs.add(confHigh);
        }
      }
      lastLow[i] = confLow;
      lastHigh[i] = confHigh;
    }
    return CheIndicators._(c, ema(20), ema(50), vwap, sd, sessionBars, day, lastLow, lastHigh, swingLows, swingHighs);
  }

  /// Higher highs and higher lows, lower highs and lower lows, or mixed.
  String get structure {
    if (swingLows.length < 2 || swingHighs.length < 2) return 'not enough swings yet';
    final hh = swingHighs.last > swingHighs[swingHighs.length - 2];
    final hl = swingLows.last > swingLows[swingLows.length - 2];
    if (hh && hl) return 'higher highs and higher lows';
    if (!hh && !hl) return 'lower highs and lower lows';
    return 'mixed swings';
  }

  /// 'up', 'down' or 'flat' from the 20/50 EMAs at bar [i].
  String trendAt(int i) {
    if (i < 3 || ema50[i] == null || ema20[i - 3] == null) return 'unknown';
    final e = ema20[i]!;
    if (e > ema50[i]! && e > ema20[i - 3]!) return 'up';
    if (e < ema50[i]! && e < ema20[i - 3]!) return 'down';
    return 'flat';
  }
}

// ─── Per-strategy evaluation ────────────────────────────────────────────

/// What a strategy sees at the last bar of [x.bars]. [intrabar] is true when that bar is still forming.
class CheEvaluation {
  CheEvaluation({required this.side, required this.stage, required this.conditions, this.entry, this.stop, this.target, this.why = '', this.invalidated = false});
  final String side;
  final CheSetupStage stage;
  final List<CheSetupCondition> conditions;
  final double? entry, stop, target;
  final String why;

  /// The closed bar broke the setup (a required condition failed after it had formed).
  final bool invalidated;

  bool get allRequiredMet => conditions.where((c) => c.requiredForEntry).every((c) => c.state == CheConditionState.satisfied);
}

CheSetupCondition _c(String id, String label, bool? ok, String group, {String detail = '', bool required = true, bool pendingWhenFalse = true}) => CheSetupCondition(
      id: id,
      label: label,
      group: group,
      detail: detail,
      requiredForEntry: required,
      state: ok == null
          ? CheConditionState.unavailable
          : ok
              ? CheConditionState.satisfied
              : pendingWhenFalse
                  ? CheConditionState.pending
                  : CheConditionState.failed,
    );

String _f(double? v) => v == null ? '—' : v.toStringAsFixed(2);

CheSetupCondition _riskCondition(double? entry, double? stop) {
  if (entry == null || stop == null) return _c('risk', 'Risk between 6 and 60 points', false, 'risk');
  final r = (entry - stop).abs();
  final ok = r >= _minRisk && r <= _maxRisk;
  return _c('risk', 'Risk between 6 and 60 points', ok, 'risk', detail: '${r.toStringAsFixed(2)} points', pendingWhenFalse: r < _minRisk);
}

CheSetupCondition _volumeCondition(CheIndicators x, int i) {
  final b = x.bars[i];
  if (b.volume <= 0) return _c('volume', 'Volume above its 20-bar average', null, 'volume', detail: 'volume not available', required: false);
  final from = math.max(0, i - 20);
  final prior = x.bars.sublist(from, i).where((k) => k.volume > 0).map((k) => k.volume).toList();
  if (prior.isEmpty) return _c('volume', 'Volume above its 20-bar average', null, 'volume', detail: 'not enough volume history', required: false);
  final avg = prior.reduce((a, b) => a + b) / prior.length;
  return _c('volume', 'Volume above its 20-bar average', b.volume >= avg, 'volume', detail: '${b.volume} vs ${avg.round()}', required: false);
}

/// Trend pullback to the 20 EMA (ema-pullback-5m).
CheEvaluation _emaPullback(CheIndicators x, bool intrabar, double near, double? price) {
  final i = x.bars.length - 1;
  final b = x.bars[i];
  final trend = x.trendAt(i);
  final e = x.ema20[i];
  final hist = _c('history', '50 bars of history', i >= _minBars, 'timeframe', detail: '${i + 1} bars');
  if (trend == 'unknown' || e == null || i < 4) {
    return CheEvaluation(side: '', stage: CheSetupStage.watching, conditions: [hist, _c('trend', '20 EMA trending with the 50 EMA', false, 'trend')]);
  }
  final long = trend != 'down' ? (trend == 'up' ? true : null) : false;
  if (long == null) {
    return CheEvaluation(side: '', stage: CheSetupStage.watching, conditions: [
      hist,
      _c('trend', '20 EMA trending with the 50 EMA', false, 'trend', detail: '20 EMA ${_f(e)}, 50 EMA ${_f(x.ema50[i])}: no clear trend'),
    ]);
  }
  final side = long ? 'long' : 'short';
  final touched = long ? b.low <= e : b.high >= e;
  final closedThrough = long ? b.close > e : b.close < e;
  final bodyDir = long ? b.close > b.open : b.close < b.open;
  final stop = long ? math.min(b.low, x.bars[i - 1].low) - _tick : math.max(b.high, x.bars[i - 1].high) + _tick;
  final entry = b.close;
  final risk = _riskCondition(entry, stop);
  final target = long ? entry + _targetR * (entry - stop) : entry - _targetR * (stop - entry);
  final conds = [
    hist,
    _c('trend', long ? '20 EMA above the 50 EMA and rising' : '20 EMA below the 50 EMA and falling', true, 'trend', detail: '20 EMA ${_f(e)}, 50 EMA ${_f(x.ema50[i])}'),
    _c('touch', long ? 'Bar trades down to the 20 EMA' : 'Bar trades up to the 20 EMA', touched, 'indicator', detail: long ? 'low ${_f(b.low)} vs EMA ${_f(e)}' : 'high ${_f(b.high)} vs EMA ${_f(e)}'),
    _c('close', long ? 'Bar closes above the 20 EMA' : 'Bar closes below the 20 EMA', closedThrough, 'trigger', detail: '${intrabar ? 'price' : 'close'} ${_f(b.close)}'),
    _c('direction', long ? 'Up bar (close above open)' : 'Down bar (close below open)', bodyDir, 'trigger'),
    risk,
    _volumeCondition(x, i),
  ];
  final ev = CheEvaluation(side: side, stage: CheSetupStage.forming, conditions: conds, entry: e, stop: stop, target: target, why: long ? 'uptrend pullback held the 20 EMA ${_f(e)}' : 'downtrend pullback rejected the 20 EMA ${_f(e)}');
  if (ev.allRequiredMet) {
    return CheEvaluation(side: side, stage: intrabar ? CheSetupStage.ready : CheSetupStage.triggered, conditions: conds, entry: entry, stop: stop, target: target, why: ev.why);
  }
  final p = price ?? b.close;
  final nearNow = (p - e).abs() <= near;
  return CheEvaluation(side: side, stage: nearNow || touched ? CheSetupStage.nearEntry : CheSetupStage.forming, conditions: conds, entry: e, stop: stop, target: target, why: ev.why);
}

/// VWAP 2-sigma reversion (vwap-revert-5m). Target: VWAP.
CheEvaluation _vwapRevert(CheIndicators x, bool intrabar, double near, double? price) {
  final i = x.bars.length - 1;
  final b = x.bars[i];
  final enough = i >= 1 && x.sessionBars[i] >= 12 && x.day[i - 1] == x.day[i];
  final session = _c('session', '12 bars into the session', enough, 'timeframe', detail: '${x.sessionBars[i]} bars since 18:00 New York');
  if (!enough) return CheEvaluation(side: '', stage: CheSetupStage.watching, conditions: [session]);
  double lo(int k) => x.vwap[k]! - 2 * x.vwapSd[k]!;
  double hi(int k) => x.vwap[k]! + 2 * x.vwapSd[k]!;
  final prev = x.bars[i - 1];
  final stretchedLow = prev.close < lo(i - 1), stretchedHigh = prev.close > hi(i - 1);
  if (!stretchedLow && !stretchedHigh) {
    // Watching for a close beyond a band; near when price is close to one.
    final p = price ?? b.close;
    final dLow = (p - lo(i)).abs(), dHigh = (p - hi(i)).abs();
    final long = dLow <= dHigh;
    final band = long ? lo(i) : hi(i);
    final stretchedNow = !intrabar && (long ? b.close < lo(i) : b.close > hi(i));
    return CheEvaluation(
      side: long ? 'long' : 'short',
      stage: stretchedNow ? CheSetupStage.forming : CheSetupStage.watching,
      entry: band,
      target: x.vwap[i],
      conditions: [
        session,
        _c('stretch', long ? 'A close below VWAP minus 2 standard deviations' : 'A close above VWAP plus 2 standard deviations', stretchedNow, 'indicator', detail: 'band ${_f(band)}, VWAP ${_f(x.vwap[i])}'),
      ],
    );
  }
  final long = stretchedLow;
  final side = long ? 'long' : 'short';
  final band = long ? lo(i) : hi(i);
  final back = long ? b.close > band : b.close < band;
  final dir = long ? b.close > b.open : b.close < b.open;
  final room = long ? x.vwap[i]! > b.close : x.vwap[i]! < b.close;
  final stop = long ? math.min(b.low, prev.low) - _tick : math.max(b.high, prev.high) + _tick;
  final risk = _riskCondition(b.close, stop);
  final conds = [
    session,
    _c('stretch', long ? 'Previous close below VWAP minus 2σ' : 'Previous close above VWAP plus 2σ', true, 'indicator', detail: 'close ${_f(prev.close)} vs band ${_f(long ? lo(i - 1) : hi(i - 1))}'),
    _c('back', long ? 'Closes back above the lower band' : 'Closes back below the upper band', back, 'trigger', detail: '${intrabar ? 'price' : 'close'} ${_f(b.close)} vs band ${_f(band)}'),
    _c('direction', long ? 'Up bar' : 'Down bar', dir, 'trigger'),
    _c('room', 'VWAP still beyond price (room to the target)', room, 'structure', detail: 'VWAP ${_f(x.vwap[i])}'),
    risk,
    _volumeCondition(x, i),
  ];
  final why = long ? 'closed back inside the lower 2σ band toward VWAP ${_f(x.vwap[i])}' : 'closed back inside the upper 2σ band toward VWAP ${_f(x.vwap[i])}';
  final probe = CheEvaluation(side: side, stage: CheSetupStage.forming, conditions: conds);
  if (probe.allRequiredMet) {
    return CheEvaluation(side: side, stage: intrabar ? CheSetupStage.ready : CheSetupStage.triggered, conditions: conds, entry: b.close, stop: stop, target: x.vwap[i], why: why);
  }
  // On a closed bar: still beyond the band keeps the stretch (it becomes the new previous bar);
  // back inside without the rest of the rule fails the setup.
  if (!intrabar && back) {
    return CheEvaluation(side: side, stage: CheSetupStage.invalidated, invalidated: true, conditions: conds, entry: band, stop: stop, target: x.vwap[i], why: 'came back inside the band without meeting every entry rule');
  }
  final p = price ?? b.close;
  return CheEvaluation(side: side, stage: (p - band).abs() <= near || back ? CheSetupStage.nearEntry : CheSetupStage.forming, conditions: conds, entry: band, stop: stop, target: x.vwap[i], why: why);
}

/// Liquidity sweep and reclaim (sweep-reclaim-5m).
CheEvaluation _sweepReclaim(CheIndicators x, bool intrabar, double near, double? price) {
  final i = x.bars.length - 1;
  final b = x.bars[i];
  if (i < 2) return CheEvaluation(side: '', stage: CheSetupStage.watching, conditions: [_c('swing', 'A confirmed swing low or high', false, 'structure')]);
  final low = x.lastLow[i - 1], high = x.lastHigh[i - 1];
  final structure = _c('swing', 'A confirmed swing low or high to sweep', low != null || high != null, 'structure', detail: 'swing low ${_f(low)}, swing high ${_f(high)}');
  if (low == null && high == null) return CheEvaluation(side: '', stage: CheSetupStage.watching, conditions: [structure]);
  final p = price ?? b.close;
  // Long at the swing low, short at the swing high: whichever the bar swept, else the nearer level.
  final bool long;
  if (low != null && b.low < low) {
    long = true;
  } else if (high != null && b.high > high) {
    long = false;
  } else {
    long = high == null || (low != null && (p - low).abs() <= (p - high).abs());
  }
  final level = long ? low! : high!;
  final swept = long ? b.low < level : b.high > level;
  final reclaimed = long ? b.close > level : b.close < level;
  final shift = long ? b.close > x.bars[i - 1].high : b.close < x.bars[i - 1].low;
  final stop = long ? b.low - _tick : b.high + _tick;
  final risk = _riskCondition(b.close, stop);
  final target = long ? b.close + _targetR * (b.close - stop) : b.close - _targetR * (stop - b.close);
  final conds = [
    structure,
    _c('sweep', long ? 'Bar trades below the swing low (sweep)' : 'Bar trades above the swing high (sweep)', swept, 'structure', detail: '${long ? 'low ${_f(b.low)}' : 'high ${_f(b.high)}'} vs level ${_f(level)}'),
    _c('reclaim', long ? 'Closes back above the swing low' : 'Closes back below the swing high', reclaimed, 'trigger', detail: '${intrabar ? 'price' : 'close'} ${_f(b.close)}'),
    _c('shift', long ? 'Closes above the prior bar high (structure shift)' : 'Closes below the prior bar low (structure shift)', shift, 'trigger', detail: 'prior ${long ? 'high' : 'low'} ${_f(long ? x.bars[i - 1].high : x.bars[i - 1].low)}'),
    risk,
    _volumeCondition(x, i),
  ];
  final why = long ? 'swept the swing low ${_f(level)}, closed back above it and above the prior high (structure shift)' : 'swept the swing high ${_f(level)}, closed back below it and below the prior low (structure shift)';
  final probe = CheEvaluation(side: long ? 'long' : 'short', stage: CheSetupStage.forming, conditions: conds);
  if (probe.allRequiredMet) {
    return CheEvaluation(side: probe.side, stage: intrabar ? CheSetupStage.ready : CheSetupStage.triggered, conditions: conds, entry: b.close, stop: stop, target: target, why: why);
  }
  // A closed bar that swept and stayed beyond the level failed to reclaim it.
  if (!intrabar && swept && !reclaimed) {
    return CheEvaluation(side: probe.side, stage: CheSetupStage.invalidated, invalidated: true, conditions: conds, entry: level, why: 'swept ${_f(level)} but closed beyond it: no reclaim');
  }
  final stage = swept ? CheSetupStage.nearEntry : ((p - level).abs() <= near ? CheSetupStage.forming : CheSetupStage.watching);
  return CheEvaluation(side: probe.side, stage: stage, conditions: conds, entry: level, stop: swept ? stop : null, target: swept ? target : null, why: why);
}

/// A strategy the engine can follow. The strategy library (T5) supplies data-driven ones; the three
/// built-ins below port the research engine's rules. [evaluate] reads only [x.bars] (bars 0..last),
/// and receives indicators already computed once for this candle and shared by every strategy.
abstract class CheSetupStrategy {
  const CheSetupStrategy();
  String get id;
  String get name;
  CheEvaluation evaluate(CheIndicators x, {required bool intrabar, required double nearPoints, double? price});
}

class _BuiltIn extends CheSetupStrategy {
  const _BuiltIn(this.id, this.name, this._f);
  @override
  final String id;
  @override
  final String name;
  final CheEvaluation Function(CheIndicators x, bool intrabar, double near, double? price) _f;
  @override
  CheEvaluation evaluate(CheIndicators x, {required bool intrabar, required double nearPoints, double? price}) => _f(x, intrabar, nearPoints, price);
}

/// The built-in strategies, ported rule for rule from trading_evidence.js.
final kCheBuiltInSetupStrategies = <CheSetupStrategy>[
  _BuiltIn('ema-pullback-5m', kCheSetupStrategies['ema-pullback-5m']!, _emaPullback),
  _BuiltIn('vwap-revert-5m', kCheSetupStrategies['vwap-revert-5m']!, _vwapRevert),
  _BuiltIn('sweep-reclaim-5m', kCheSetupStrategies['sweep-reclaim-5m']!, _sweepReclaim),
];

CheSetupStrategy? cheBuiltInSetupStrategy(String id) {
  for (final s in kCheBuiltInSetupStrategies) {
    if (s.id == id) return s;
  }
  return null;
}

/// Evaluates one strategy at the last bar of [bars]. Public for tests and the look-ahead check.
CheEvaluation cheEvaluateSetup(String strategyId, List<CheSetupBar> bars, {bool intrabar = false, double nearPoints = 5, double? price}) {
  final f = cheBuiltInSetupStrategy(strategyId);
  if (f == null) throw ArgumentError.value(strategyId, 'strategyId', 'not a setup strategy');
  if (bars.isEmpty) return CheEvaluation(side: '', stage: CheSetupStage.watching, conditions: const []);
  return f.evaluate(CheIndicators.of(bars), intrabar: intrabar, nearPoints: nearPoints, price: price);
}

// ─── The engine: setups, stage changes and signals ───────────────────────

/// A stage change the board, alerts and audit trail record.
class CheSetupEvent {
  const CheSetupEvent({required this.setup, required this.from, required this.to, required this.at, required this.reason, this.signal});
  final CheSetupState setup;
  final CheSetupStage from, to;
  final DateTime at;
  final String reason;
  final CheTradeSignal? signal;
}

class CheSetupEngine {
  CheSetupEngine({required this.symbol, required this.minutes, Iterable<CheSetupStrategy>? strategies, this.nearPoints = 5, this.maxBars = 600})
      : strategyDefs = List.unmodifiable(strategies ?? kCheBuiltInSetupStrategies);

  final String symbol;
  final int minutes;
  final List<CheSetupStrategy> strategyDefs;
  List<String> get strategies => [for (final d in strategyDefs) d.id];
  double nearPoints;
  final int maxBars;

  final List<CheSetupBar> _closed = [];
  final Map<String, CheSetupState> _live = {};
  final List<CheSetupState> finished = [];
  final Map<String, CheStrategyEvidence> evidence = {};
  String dataSource = '';
  bool dataLive = false;
  String alignment = 'not checked';
  var _seq = 0;

  List<CheSetupBar> get closedBars => List.unmodifiable(_closed);

  /// The setups being followed now, one per strategy.
  List<CheSetupState> get setups => [for (final d in strategyDefs) _setup(d, _closed.isEmpty ? DateTime.now().toUtc() : _closed.last.end)];

  CheSetupState _setup(CheSetupStrategy def, DateTime at) => _live.putIfAbsent(def.id, () {
        _seq += 1;
        return CheSetupState(
          id: '$symbol-${minutes}m-${def.id}-$_seq',
          strategyId: def.id,
          strategyName: def.name,
          symbol: symbol,
          timeframeMinutes: minutes,
          side: '',
          firstDetected: at,
        )
          ..stageSince = at
          ..timeline.add((at, CheSetupStage.watching, 'CHE started following this setup'));
      });

  CheSetupEvent? _move(CheSetupState s, CheSetupStage to, DateTime at, String reason, {CheTradeSignal? signal}) {
    if (s.stage == to) return null;
    if (!cheSetupTransitionAllowed(s.stage, to)) {
      throw StateError('Refused setup transition ${s.stage.label} → ${to.label}');
    }
    final from = s.stage;
    s.stage = to;
    s.stageSince = at;
    s.timeline.add((at, to, reason));
    if (to.isFinal) {
      _live.remove(s.strategyId);
      finished.insert(0, s);
      if (finished.length > 40) finished.removeRange(40, finished.length);
    }
    return CheSetupEvent(setup: s, from: from, to: to, at: at, reason: reason, signal: signal);
  }

  void _apply(CheSetupState s, CheEvaluation ev, double? price, DateTime at) {
    s.conditions = ev.conditions;
    if (ev.side.isNotEmpty) s.side = ev.side;
    s.plannedEntry = ev.entry;
    s.plannedStop = ev.stop;
    s.plannedTarget = ev.target;
    s.lastPrice = price;
    s.updatedAt = at;
    s.dataSource = dataSource;
    s.dataLive = dataLive;
    s.evidence = evidence[s.strategyId] ?? CheStrategyEvidence(strategyId: s.strategyId, sampleTrades: 0);
    s.timeframeAlignment = alignment;
  }

  void _context(CheSetupState s, CheIndicators x) {
    s.marketStructure = x.structure;
    final t = x.trendAt(x.bars.length - 1);
    s.trend = switch (t) { 'up' => 'uptrend (20 EMA above a rising 50 EMA)', 'down' => 'downtrend (20 EMA below a falling 50 EMA)', 'flat' => 'no clear trend', _ => 'not enough bars' };
  }

  /// The trend on this timeframe at the last closed bar, for timeframe alignment.
  String get trend => _closed.length < 4 ? 'unknown' : CheIndicators.of(_closed).trendAt(_closed.length - 1);

  /// Feed a closed candle. Returns the stage changes it caused. Candles must arrive in time order;
  /// a candle that is not after the last one is ignored (closed candles are final).
  List<CheSetupEvent> onClosed(CheSetupBar bar) {
    if (_closed.isNotEmpty && !bar.start.isAfter(_closed.last.start)) return const [];
    final events = <CheSetupEvent>[];
    _trackOpen(bar, events, closed: true);
    _closed.add(bar);
    if (_closed.length > maxBars) _closed.removeRange(0, _closed.length - maxBars);
    final x = CheIndicators.of(_closed);
    final at = bar.end;
    for (final def in strategyDefs) {
      final id = def.id;
      final s = _setup(def, at);
      if (s.stage == CheSetupStage.triggered || s.stage == CheSetupStage.active) continue;
      if (cheAfterFlatTime(bar.start)) {
        final e = _move(s, CheSetupStage.expired, at, 'flat time 16:55 New York: no new entries before the CME break');
        if (e != null) events.add(e);
        continue;
      }
      final ev = def.evaluate(x, intrabar: false, nearPoints: nearPoints, price: bar.close);
      _apply(s, ev, bar.close, at);
      _context(s, x);
      if (ev.stage == CheSetupStage.triggered) {
        final signal = CheTradeSignal(
          id: '${s.id}-sig',
          setupId: s.id,
          strategyId: id,
          strategyName: s.strategyName,
          symbol: symbol,
          timeframeMinutes: minutes,
          side: ev.side,
          entry: ev.entry!,
          stop: ev.stop!,
          target: ev.target!,
          signalTime: at,
          barTime: bar.start,
          dataSource: dataSource,
          dataLive: dataLive,
          evidence: s.evidence,
          why: ev.why,
        );
        s.signal = signal;
        final e = _move(s, CheSetupStage.triggered, at, 'closed bar met every entry rule: ${ev.why}', signal: signal);
        if (e != null) events.add(e);
      } else if (ev.invalidated) {
        final e = _move(s, CheSetupStage.invalidated, at, ev.why);
        if (e != null) events.add(e);
      } else {
        // On a closed bar a setup can be at most NEAR ENTRY; READY belongs to the forming bar.
        final to = ev.stage.index > CheSetupStage.nearEntry.index ? CheSetupStage.nearEntry : ev.stage;
        final e = _move(s, to, at, _reasonFor(to, ev));
        if (e != null) events.add(e);
      }
    }
    return events;
  }

  /// Feed the forming candle (live updates). Returns stage changes: READY, NEAR ENTRY, fills and exits.
  List<CheSetupEvent> onForming(CheSetupBar bar) {
    if (_closed.isNotEmpty && !bar.start.isAfter(_closed.last.start)) return const [];
    final events = <CheSetupEvent>[];
    _trackOpen(bar, events, closed: false);
    if (_closed.isEmpty) return events;
    final x = CheIndicators.of([..._closed, bar]);
    final at = bar.start;
    for (final def in strategyDefs) {
      final s = _setup(def, at);
      if (s.stage == CheSetupStage.triggered || s.stage == CheSetupStage.active) continue;
      if (cheAfterFlatTime(bar.start)) continue;
      final ev = def.evaluate(x, intrabar: true, nearPoints: nearPoints, price: bar.close);
      _apply(s, ev, bar.close, at);
      _context(s, x);
      final to = switch (ev.stage) {
        CheSetupStage.triggered => CheSetupStage.ready,
        CheSetupStage.invalidated => s.stage,
        final other => other,
      };
      final e = _move(s, to, at, _reasonFor(to, ev));
      if (e != null) events.add(e);
    }
    return events;
  }

  String _reasonFor(CheSetupStage to, CheEvaluation ev) {
    final pend = ev.conditions.where((c) => c.requiredForEntry && c.state != CheConditionState.satisfied).map((c) => c.label).take(2).join('; ');
    return switch (to) {
      CheSetupStage.ready => 'every entry rule is met on the forming bar; counts only if the bar closes this way',
      CheSetupStage.nearEntry => 'price is near the planned entry${pend.isEmpty ? '' : '; still needed: $pend'}',
      CheSetupStage.forming => 'background conditions in place${pend.isEmpty ? '' : '; still needed: $pend'}',
      _ => pend.isEmpty ? 'conditions changed' : 'waiting for: $pend',
    };
  }

  /// Fills a TRIGGERED setup at the first later bar's open, then follows ACTIVE setups to their
  /// target, stop or the flat time. When one bar reaches both levels the stop is assumed first.
  void _trackOpen(CheSetupBar bar, List<CheSetupEvent> events, {required bool closed}) {
    for (final s in [..._live.values]) {
      final sig = s.signal;
      if (sig == null) continue;
      if (s.stage == CheSetupStage.triggered && bar.start.isAfter(sig.barTime)) {
        if (cheAfterFlatTime(bar.start)) {
          final e = _move(s, CheSetupStage.expired, bar.start, 'flat time reached before the entry bar opened');
          if (e != null) events.add(e);
          continue;
        }
        s.lastPrice = bar.open;
        final e = _move(s, CheSetupStage.active, bar.start, 'paper entry at the next bar open ${_f(bar.open)} (CHE PAPER ACCOUNT; costs are booked by the paper account)');
        if (e != null) events.add(e);
      }
      if (s.stage != CheSetupStage.active) continue;
      final long = sig.side == 'long';
      s.lastPrice = bar.close;
      s.updatedAt = closed ? bar.end : bar.start;
      final hitStop = long ? bar.low <= sig.stop : bar.high >= sig.stop;
      final hitTarget = long ? bar.high >= sig.target : bar.low <= sig.target;
      if (hitStop) {
        final e = _move(s, CheSetupStage.stopped, s.updatedAt!, 'price reached the stop ${_f(sig.stop)}${hitTarget ? ' (the same bar also reached the target; the stop is assumed first)' : ''}');
        if (e != null) events.add(e);
      } else if (hitTarget) {
        final e = _move(s, CheSetupStage.targetHit, s.updatedAt!, 'price reached the target ${_f(sig.target)}');
        if (e != null) events.add(e);
      } else if (closed && cheAfterFlatTime(bar.start)) {
        final e = _move(s, CheSetupStage.expired, bar.end, 'flat by 16:55 New York: closed at ${_f(bar.close)} before the CME break');
        if (e != null) events.add(e);
      }
    }
  }
}
