// CHE strategy rules as data (owner, 2026-10-23): "I want to add more without rebuilding the app".
//
// A strategy is a JSON document in the `che.strategy/1` schema. The Worker stores, versions and
// approves documents (server/cloudflare/strategy_library.js); this file validates them and runs
// them through the setup engine (che_setup_engine.dart) as a [CheSetupStrategy]. There is one
// evaluator: the engine calls [CheDslStrategy.evaluate] with indicators computed once per candle.
//
// The language is closed: numbers, bar fields, named indicator series, session levels, comparisons,
// crosses, session windows and a few price-action primitives. Nothing in a document can run code,
// read a later bar, or reach the network. An unknown construct is refused by name, never skipped.
//
// No look-ahead by construction: every value at bar i is computed from bars 0..i only, swings are
// confirmed only after their right-hand bars close, and an opening range or a window's high/low is
// "unavailable" until its window has finished on the bar being evaluated.

import 'dart:math' as math;

import 'che_setup_engine.dart';
import 'che_trade_signal.dart';

const kCheStrategySchema = 'che.strategy/1';

/// Library categories (the owner's list), as stored ids with their spoken names.
const kCheStrategyCategories = <String, String>{
  'trend': 'Trend',
  'momentum': 'Momentum',
  'breakout': 'Breakout',
  'reversal': 'Reversal',
  'scalping': 'Scalping',
  'price_action': 'Price action',
  'ict_smc': 'ICT / SMC',
  'volatility': 'Volatility',
  'volume': 'Volume',
  'other': 'Other',
};

/// Named New York session windows as [start, end) minutes after midnight; an end before the start
/// wraps past midnight. Sources are in docs/CHE_STRATEGY_DSL.md.
const kCheSessionWindows = <String, (int, int)>{
  'overnight': (18 * 60, 9 * 60 + 30), // CME Globex evening open to the New York cash open
  'asia': (20 * 60, 0),
  'london': (2 * 60, 5 * 60),
  'london_killzone': (2 * 60, 5 * 60),
  'ny_am_killzone': (7 * 60, 10 * 60),
  'ny_open': (9 * 60 + 30, 10 * 60),
  'rth': (9 * 60 + 30, 16 * 60),
  'london_silver_bullet': (3 * 60, 4 * 60),
  'silver_bullet_am': (10 * 60, 11 * 60),
  'silver_bullet_pm': (14 * 60, 15 * 60),
  'ny_lunch': (12 * 60, 13 * 60 + 30),
  'ny_pm': (13 * 60 + 30, 16 * 60),
};

/// Session levels an operand can name: `{"level": "prior_day_high"}`.
const kCheDslLevels = {
  'prior_day_high', 'prior_day_low', // previous CME trading day (18:00 → 17:00 New York)
  'prior_rth_high', 'prior_rth_low', // previous trading day's 9:30–16:00 New York session
  'overnight_high', 'overnight_low', // this trading day's 18:00–9:30 session (final once 9:30 passes)
  'day_high', 'day_low', // this trading day so far
  'rth_high', 'rth_low', // today's 9:30–16:00 session so far
  'or_high', 'or_low', // opening range from 9:30 for `or_minutes` (default 15); available once it ends
  'swing_high', 'swing_low', // last confirmed swing (3 bars each side, confirmed 3 bars later)
  'vwap', // session VWAP (resets at 18:00 New York)
};

const _barFields = {'open', 'high', 'low', 'close', 'volume', 'price'};
const _seriesFns = {'ema', 'sma', 'rsi', 'macd', 'bb', 'atr', 'vol_sma', 'highest', 'lowest', 'vwap_band'};
const _numOps = {'add', 'sub', 'mul', 'div', 'abs', 'max', 'min'};
const _cmpOps = {'gt', 'lt', 'gte', 'lte', 'cross_above', 'cross_below'};
const _boolOps = {'all', 'any', 'not', 'in_window', 'rising', 'falling', 'sweep', 'fvg', 'order_block', 'structure_break', 'bar', 'true'};
const _groups = {'structure', 'trend', 'indicator', 'volume', 'timeframe', 'trigger', 'risk', 'session'};
const _maxDepth = 8, _maxConditions = 40, _maxSeries = 24, _maxLookback = 500;

/// A problem with a document, at a JSON path such as `long.conditions[2].when`.
class CheDslIssue {
  const CheDslIssue(this.path, this.message);
  final String path, message;
  @override
  String toString() => '$path: $message';
}

// ─── Validation ─────────────────────────────────────────────────────────

/// Every reason [doc] cannot run. Empty means it is a valid `che.strategy/1` document. Validation
/// is not approval: a valid custom strategy still waits for the owner's yes in the Worker.
List<CheDslIssue> cheValidateStrategy(Map<String, dynamic> doc) {
  final out = <CheDslIssue>[];
  void bad(String p, String m) => out.add(CheDslIssue(p, m));
  const top = {'schema', 'id', 'name', 'version', 'category', 'description', 'source', 'symbols', 'timeframes', 'params', 'series', 'long', 'short', 'risk', 'or_minutes', 'expiry_bars', 'tags'};
  for (final k in doc.keys) {
    if (!top.contains(k)) bad(k, 'unsupported field "$k"');
  }
  if (doc['schema'] != kCheStrategySchema) bad('schema', 'must be "$kCheStrategySchema"');
  final id = doc['id'];
  if (id is! String || !RegExp(r'^[a-z0-9][a-z0-9-]{1,63}$').hasMatch(id)) bad('id', 'lowercase letters, digits and dashes, 2–64 characters');
  final name = doc['name'];
  if (name is! String || name.trim().isEmpty || name.length > 120) bad('name', 'a name of 1–120 characters is required');
  if (!kCheStrategyCategories.containsKey(doc['category'])) bad('category', 'one of ${kCheStrategyCategories.keys.join(', ')}');
  final tfs = doc['timeframes'];
  if (tfs is! List || tfs.isEmpty || tfs.any((t) => t is! int || t < 1 || t > 1440)) bad('timeframes', 'a list of bar sizes in minutes, e.g. [1, 5]');
  final params = doc['params'] ?? const {};
  if (params is! Map || params.values.any((v) => v is! num)) bad('params', 'an object of numbers');
  final series = doc['series'] ?? const {};
  if (series is! Map) {
    bad('series', 'an object of named indicators');
  } else {
    if (series.length > _maxSeries) bad('series', 'at most $_maxSeries indicators');
    for (final e in series.entries) {
      _validateSeriesSpec('series.${e.key}', e.value, bad, params is Map ? params : const {});
      if (_barFields.contains(e.key) || kCheDslLevels.contains(e.key)) bad('series.${e.key}', '"${e.key}" is a built-in name');
    }
  }
  final orMin = doc['or_minutes'];
  if (orMin != null && (orMin is! int || orMin < 1 || orMin > 120)) bad('or_minutes', 'whole minutes from 1 to 120');
  final expiry = doc['expiry_bars'];
  if (expiry != null && (expiry is! int || expiry < 1 || expiry > 500)) bad('expiry_bars', 'whole bars from 1 to 500');
  final risk = doc['risk'] ?? const {};
  if (risk is! Map) {
    bad('risk', 'an object');
  } else {
    final lo = risk['min_points'] ?? 6, hi = risk['max_points'] ?? 60;
    if (lo is! num || hi is! num || lo <= 0 || hi > 500 || lo >= hi) bad('risk', 'min_points and max_points with 0 < min < max ≤ 500');
    final per = risk['max_trades_per_day'];
    if (per != null && (per is! int || per < 1 || per > 30)) bad('risk.max_trades_per_day', 'whole trades from 1 to 30');
  }
  final ctx = _Names(series is Map ? series.keys.cast<String>().toSet() : <String>{}, params is Map ? params.keys.cast<String>().toSet() : <String>{});
  if (doc['long'] == null && doc['short'] == null) bad('long', 'at least one of "long" or "short" is required');
  for (final side in ['long', 'short']) {
    final s = doc[side];
    if (s == null) continue;
    if (s is! Map) {
      bad(side, 'an object');
      continue;
    }
    _validateSide(side, s, bad, ctx);
  }
  return out;
}

class _Names {
  _Names(this.series, this.params);
  final Set<String> series, params;
}

void _validateSeriesSpec(String p, Object? spec, void Function(String, String) bad, Map params) {
  if (spec is! Map) return bad(p, 'an indicator object such as {"fn": "ema", "period": 20}');
  final fn = spec['fn'];
  if (!_seriesFns.contains(fn)) return bad('$p.fn', 'unsupported indicator "$fn"; supported: ${_seriesFns.join(', ')}');
  const allowed = {'fn', 'period', 'of', 'fast', 'slow', 'signal', 'part', 'k'};
  for (final k in spec.keys) {
    if (!allowed.contains(k)) bad('$p.$k', 'unsupported field "$k"');
  }
  int? n(String k, int dflt) {
    final v = spec[k] ?? dflt;
    if (v is String && params.containsKey(v)) return (params[v] as num).toInt();
    return v is int ? v : null;
  }

  for (final k in ['period', 'fast', 'slow', 'signal']) {
    if (spec[k] == null) continue;
    final v = n(k, 0);
    if (v == null || v < 1 || v > _maxLookback) bad('$p.$k', 'whole bars from 1 to $_maxLookback');
  }
  final of = spec['of'];
  if (of != null && !_barFields.contains(of)) bad('$p.of', 'one of ${_barFields.join(', ')}');
  if (fn == 'macd' && !{'line', 'signal', 'hist', null}.contains(spec['part'])) bad('$p.part', 'line, signal or hist');
  if (fn == 'bb' && !{'upper', 'mid', 'lower', null}.contains(spec['part'])) bad('$p.part', 'upper, mid or lower');
  if (fn == 'vwap_band' && spec['k'] is! num) bad('$p.k', 'a number of standard deviations, e.g. 2 or -2');
}

void _validateSide(String side, Map s, void Function(String, String) bad, _Names ctx) {
  const allowed = {'conditions', 'entry', 'stop', 'target', 'invalidation', 'near'};
  for (final k in s.keys) {
    if (!allowed.contains(k)) bad('$side.$k', 'unsupported field "$k"');
  }
  final conds = s['conditions'];
  if (conds is! List || conds.isEmpty) {
    bad('$side.conditions', 'at least one condition is required');
  } else {
    if (conds.length > _maxConditions) bad('$side.conditions', 'at most $_maxConditions conditions');
    final ids = <String>{};
    for (var i = 0; i < conds.length; i++) {
      final p = '$side.conditions[$i]';
      final c = conds[i];
      if (c is! Map) {
        bad(p, 'an object with id, label and when');
        continue;
      }
      for (final k in c.keys) {
        if (!{'id', 'label', 'group', 'required', 'when'}.contains(k)) bad('$p.$k', 'unsupported field "$k"');
      }
      if (c['id'] is! String || !ids.add(c['id'] as String)) bad('$p.id', 'a unique id is required');
      if (c['label'] is! String || (c['label'] as String).trim().isEmpty) bad('$p.label', 'a plain-language label is required');
      if (c['group'] != null && !_groups.contains(c['group'])) bad('$p.group', 'one of ${_groups.join(', ')}');
      if (c['required'] != null && c['required'] is! bool) bad('$p.required', 'true or false');
      _validateBool('$p.when', c['when'], bad, ctx, 0);
    }
  }
  if (s['stop'] == null) {
    bad('$side.stop', 'a stop is required: every CHE strategy defines where it is wrong');
  } else {
    _validateNum('$side.stop', s['stop'], bad, ctx, 0);
  }
  final t = s['target'];
  if (t == null) {
    bad('$side.target', 'a target is required, e.g. {"r": 2}');
  } else if (t is Map && t.containsKey('r')) {
    final r = t['r'];
    if (r is! num || r < 0.5 || r > 10) bad('$side.target.r', 'a reward multiple from 0.5 to 10');
  } else {
    _validateNum('$side.target', t, bad, ctx, 0);
  }
  if (s['entry'] != null) _validateNum('$side.entry', s['entry'], bad, ctx, 0);
  if (s['near'] != null) _validateNum('$side.near', s['near'], bad, ctx, 0);
  final inv = s['invalidation'];
  if (inv != null) {
    if (inv is! List) {
      bad('$side.invalidation', 'a list of conditions');
    } else {
      for (var i = 0; i < inv.length; i++) {
        final c = inv[i];
        if (c is! Map || c['label'] is! String) {
          bad('$side.invalidation[$i]', 'an object with label and when');
          continue;
        }
        _validateBool('$side.invalidation[$i].when', c['when'], bad, ctx, 0);
      }
    }
  }
}

void _validateAgo(String p, Map m, void Function(String, String) bad) {
  if (m.containsKey('ahead') || m.containsKey('future') || m.containsKey('offset')) bad(p, 'look-ahead is not allowed: only "ago" (bars back) exists');
  final ago = m['ago'];
  if (ago != null && (ago is! int || ago < 0 || ago > _maxLookback)) bad('$p.ago', 'look-ahead is not allowed: "ago" is 0 or more bars back (at most $_maxLookback)');
}

void _validateNum(String p, Object? v, void Function(String, String) bad, _Names ctx, int depth) {
  if (depth > _maxDepth) return bad(p, 'nested more than $_maxDepth levels');
  if (v is num) return;
  if (v is String) {
    if (_barFields.contains(v) || ctx.series.contains(v)) return;
    if (kCheDslLevels.contains(v)) return;
    return bad(p, 'unknown name "$v": not a bar field, level or declared series');
  }
  if (v is! Map || v.length != 1 && !(v.length == 2 && v.containsKey('ago')) && !(v.length == 2 && v.containsKey('day'))) {
    return bad(p, 'a number, a name, or one operator object');
  }
  _validateAgo(p, v, bad);
  final k = v.keys.firstWhere((k) => k != 'ago' && k != 'day', orElse: () => '');
  final x = v[k];
  if (k == 'param') {
    if (!ctx.params.contains(x)) bad(p, 'unknown param "$x"');
  } else if (k == 'series') {
    if (!ctx.series.contains(x)) bad(p, 'unknown series "$x"');
  } else if (k == 'bar') {
    if (!_barFields.contains(x)) bad(p, 'unknown bar field "$x"');
  } else if (k == 'level') {
    if (!kCheDslLevels.contains(x)) bad(p, 'unknown level "$x"; supported: ${kCheDslLevels.join(', ')}');
  } else if (k == 'window_high' || k == 'window_low') {
    if (!kCheSessionWindows.containsKey(x)) bad(p, 'unknown session window "$x"');
    final day = v['day'];
    if (day != null && day != 0 && day != -1) bad('$p.day', '0 (this trading day) or -1 (the previous one)');
  } else if (_numOps.contains(k)) {
    if (k == 'abs') return _validateNum('$p.abs', x, bad, ctx, depth + 1);
    if (x is! List || x.length < 2 || (k != 'max' && k != 'min' && x.length != 2)) return bad('$p.$k', 'a list of operands');
    for (var i = 0; i < x.length; i++) {
      _validateNum('$p.$k[$i]', x[i], bad, ctx, depth + 1);
    }
  } else {
    bad(p, 'unsupported construct "$k"');
  }
}

void _validateBool(String p, Object? v, void Function(String, String) bad, _Names ctx, int depth) {
  if (depth > _maxDepth) return bad(p, 'nested more than $_maxDepth levels');
  if (v is! Map || v.isEmpty) return bad(p, 'a condition object such as {"gt": ["close", "ema20"]}');
  final k = v.keys.first;
  final x = v[k];
  final extra = v.keys.where((e) => e != k).toSet();
  const extras = {'within', 'retest', 'of', 'bars', 'displacement_atr'};
  for (final e in extra) {
    if (!extras.contains(e)) bad('$p.$e', 'unsupported field "$e"');
  }
  _validateAgo(p, v, bad);
  if (_cmpOps.contains(k)) {
    if (x is! List || x.length != 2) return bad('$p.$k', 'two operands');
    _validateNum('$p.$k[0]', x[0], bad, ctx, depth + 1);
    _validateNum('$p.$k[1]', x[1], bad, ctx, depth + 1);
  } else if (k == 'all' || k == 'any') {
    if (x is! List || x.isEmpty) return bad('$p.$k', 'a list of conditions');
    for (var i = 0; i < x.length; i++) {
      _validateBool('$p.$k[$i]', x[i], bad, ctx, depth + 1);
    }
  } else if (k == 'not') {
    _validateBool('$p.not', x, bad, ctx, depth + 1);
  } else if (k == 'in_window') {
    if (x is String) {
      if (!kCheSessionWindows.containsKey(x)) bad('$p.in_window', 'unknown session window "$x"; supported: ${kCheSessionWindows.keys.join(', ')}');
    } else if (x is Map) {
      for (final e in ['start', 'end']) {
        if (x[e] is! String || !RegExp(r'^([01]\d|2[0-3]):[0-5]\d$').hasMatch(x[e] as String)) bad('$p.in_window.$e', 'HH:MM New York time');
      }
    } else {
      bad('$p.in_window', 'a window name or {"start": "HH:MM", "end": "HH:MM"} (New York time)');
    }
  } else if (k == 'rising' || k == 'falling') {
    _validateNum('$p.$k', x, bad, ctx, depth + 1);
    final b = v['bars'] ?? 1;
    if (b is! int || b < 1 || b > 50) bad('$p.bars', 'whole bars from 1 to 50');
  } else if (k == 'sweep') {
    if (x != 'low' && x != 'high') bad('$p.sweep', '"low" or "high"');
    if (v['of'] == null) {
      bad('$p.of', 'the level that is swept, e.g. "prior_day_low"');
    } else {
      _validateNum('$p.of', v['of'], bad, ctx, depth + 1);
    }
    _within(p, v, bad);
  } else if (k == 'fvg' || k == 'order_block' || k == 'structure_break') {
    if (x != 'bull' && x != 'bear') bad('$p.$k', '"bull" or "bear"');
    if (k != 'structure_break') _within(p, v, bad);
    final d = v['displacement_atr'];
    if (d != null && (d is! num || d <= 0 || d > 10)) bad('$p.displacement_atr', 'a multiple of ATR from 0 to 10');
  } else if (k == 'bar') {
    if (x != 'bull' && x != 'bear') bad('$p.bar', '"bull" (close above open) or "bear"');
  } else if (k == 'true') {
    // Always met: for strategies whose entry is purely a window or level.
  } else {
    bad(p, 'unsupported construct "$k"; supported: ${[..._cmpOps, ..._boolOps].join(', ')}');
  }
}

void _within(String p, Map v, void Function(String, String) bad) {
  final w = v['within'] ?? 1;
  if (w is! int || w < 1 || w > 100) bad('$p.within', 'whole bars from 1 to 100');
}

// ─── Shared per-candle values ───────────────────────────────────────────

/// Indicator series and session levels for one candle's bar list, computed once and shared by
/// every DSL strategy evaluated on that candle. Each series is causal: value i uses bars 0..i.
class CheDslContext {
  CheDslContext._(this.x);

  static final _cache = Expando<CheDslContext>('che_dsl');

  /// The shared context for [x] (one per [CheIndicators], i.e. one per candle).
  static CheDslContext of(CheIndicators x) => _cache[x] ??= CheDslContext._(x);

  final CheIndicators x;
  final Map<String, List<double?>> _series = {};
  List<int>? _nyMin;
  final Map<String, List<double?>> _levels = {};
  int computedSeries = 0;

  List<CheSetupBar> get bars => x.bars;
  int get last => x.bars.length - 1;

  List<int> get nyMinutes => _nyMin ??= [for (final b in x.bars) cheNewYorkMinutes(b.start)];

  double _field(CheSetupBar b, String f) => switch (f) {
        'open' => b.open,
        'high' => b.high,
        'low' => b.low,
        'volume' => b.volume.toDouble(),
        _ => b.close,
      };

  /// A series by its canonical spec key, computed at most once per candle.
  List<double?> series(Map spec, Map<String, num> params) {
    int p(String k, int d) {
      final v = spec[k] ?? d;
      return v is String ? (params[v] ?? d).toInt() : (v as num).toInt();
    }

    final fn = spec['fn'] as String;
    final of = (spec['of'] ?? 'close') as String;
    final key = switch (fn) {
      'macd' => 'macd:${p('fast', 12)}:${p('slow', 26)}:${p('signal', 9)}:${spec['part'] ?? 'line'}:$of',
      'bb' => 'bb:${p('period', 20)}:${spec['k'] ?? 2}:${spec['part'] ?? 'mid'}:$of',
      'vwap_band' => 'vwap_band:${spec['k']}',
      _ => '$fn:${p('period', 14)}:$of',
    };
    final hit = _series[key];
    if (hit != null) return hit;
    computedSeries += 1;
    final src = [for (final b in bars) _field(b, of)];
    final out = switch (fn) {
      'ema' => _ema(src, p('period', 20)),
      'sma' => _sma(src, p('period', 20)),
      'rsi' => _rsi(src, p('period', 14)),
      'atr' => _atr(bars, p('period', 14)),
      'vol_sma' => _sma([for (final b in bars) b.volume.toDouble()], p('period', 20)),
      'highest' => _roll(src, p('period', 20), math.max),
      'lowest' => _roll(src, p('period', 20), math.min),
      'vwap_band' => [for (var i = 0; i < bars.length; i++) x.vwap[i] == null ? null : x.vwap[i]! + (spec['k'] as num) * x.vwapSd[i]!],
      'macd' => _macd(src, p('fast', 12), p('slow', 26), p('signal', 9), (spec['part'] ?? 'line') as String),
      'bb' => _bb(src, p('period', 20), ((spec['k'] ?? 2) as num).toDouble(), (spec['part'] ?? 'mid') as String),
      _ => List<double?>.filled(bars.length, null),
    };
    return _series[key] = out;
  }

  /// A session level at bar [i], or null while it is not yet known at that bar.
  double? level(String name, int i, {int orMinutes = 15}) {
    final key = name.startsWith('or_') ? '$name:$orMinutes' : name;
    final arr = _levels[key] ??= _computeLevel(name, orMinutes);
    return i >= 0 && i < arr.length ? arr[i] : null;
  }

  /// The high or low of a named window on this trading day (day 0, so far / final once it ends)
  /// or the previous one (day -1).
  double? windowExtreme(String window, bool high, int day, int i) {
    final arr = _levels['w:$window:$high:$day'] ??= _windowLevels(kCheSessionWindows[window]!, high, day);
    return i >= 0 && i < arr.length ? arr[i] : null;
  }

  bool inWindow((int, int) w, int i) => _inWin(w, nyMinutes[i]);

  static bool _inWin((int, int) w, int m) => w.$1 <= w.$2 ? (m >= w.$1 && m < w.$2) : (m >= w.$1 || m < w.$2);

  List<double?> _windowLevels((int, int) w, bool high, int dayOffset) {
    final n = bars.length;
    final out = List<double?>.filled(n, null);
    final perDay = <String, double>{};
    final days = <String>[];
    for (var i = 0; i < n; i++) {
      final d = x.day[i];
      if (days.isEmpty || days.last != d) days.add(d);
      if (_inWin(w, nyMinutes[i])) {
        final v = high ? bars[i].high : bars[i].low;
        final cur = perDay[d];
        perDay[d] = cur == null ? v : (high ? math.max(cur, v) : math.min(cur, v));
      }
      if (dayOffset == 0) {
        out[i] = perDay[d];
      } else {
        out[i] = days.length >= 2 ? perDay[days[days.length - 2]] : null;
      }
    }
    return out;
  }

  List<double?> _computeLevel(String name, int orMinutes) {
    final n = bars.length;
    final out = List<double?>.filled(n, null);
    bool hi(String s) => s.endsWith('_high');
    switch (name) {
      case 'vwap':
        return List.of(x.vwap);
      case 'swing_high':
        return List.of(x.lastHigh);
      case 'swing_low':
        return List.of(x.lastLow);
      case 'prior_day_high' || 'prior_day_low' || 'day_high' || 'day_low':
        {
          final perDay = <String, double>{};
          final days = <String>[];
          final isHigh = hi(name);
          for (var i = 0; i < n; i++) {
            final d = x.day[i];
            if (days.isEmpty || days.last != d) days.add(d);
            final v = isHigh ? bars[i].high : bars[i].low;
            final cur = perDay[d];
            perDay[d] = cur == null ? v : (isHigh ? math.max(cur, v) : math.min(cur, v));
            out[i] = name.startsWith('prior') ? (days.length >= 2 ? perDay[days[days.length - 2]] : null) : perDay[d];
          }
          return out;
        }
      case 'prior_rth_high' || 'prior_rth_low':
        return _windowLevels(kCheSessionWindows['rth']!, hi(name), -1);
      case 'rth_high' || 'rth_low':
        return _windowLevels(kCheSessionWindows['rth']!, hi(name), 0);
      case 'overnight_high' || 'overnight_low':
        return _windowLevels(kCheSessionWindows['overnight']!, hi(name), 0);
      case 'or_high' || 'or_low':
        {
          // Known only once the range has ended: bars inside it never see their own range.
          final start = 9 * 60 + 30, end = start + orMinutes;
          final isHigh = hi(name);
          final perDay = <String, double>{};
          for (var i = 0; i < n; i++) {
            final d = x.day[i];
            final m = nyMinutes[i];
            final barEnd = m + bars[i].minutes;
            if (m >= start && barEnd <= end) {
              final v = isHigh ? bars[i].high : bars[i].low;
              final cur = perDay[d];
              perDay[d] = cur == null ? v : (isHigh ? math.max(cur, v) : math.min(cur, v));
            }
            out[i] = (m >= end && m < 16 * 60) ? perDay[d] : null;
          }
          return out;
        }
    }
    return out;
  }
}

List<double?> _ema(List<double> s, int len) {
  final out = List<double?>.filled(s.length, null);
  final k = 2 / (len + 1);
  double? v;
  for (var i = 0; i < s.length; i++) {
    v = v == null ? s[i] : s[i] * k + v * (1 - k);
    if (i >= len - 1) out[i] = v;
  }
  return out;
}

List<double?> _sma(List<double> s, int len) {
  final out = List<double?>.filled(s.length, null);
  var sum = 0.0;
  for (var i = 0; i < s.length; i++) {
    sum += s[i];
    if (i >= len) sum -= s[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

List<double?> _roll(List<double> s, int len, double Function(double, double) f) {
  final out = List<double?>.filled(s.length, null);
  for (var i = len - 1; i < s.length; i++) {
    var v = s[i];
    for (var j = i - len + 1; j < i; j++) {
      v = f(v, s[j]);
    }
    out[i] = v;
  }
  return out;
}

/// Wilder's RSI.
List<double?> _rsi(List<double> s, int len) {
  final out = List<double?>.filled(s.length, null);
  double g = 0, l = 0;
  for (var i = 1; i < s.length; i++) {
    final d = s[i] - s[i - 1];
    final up = math.max(0.0, d), dn = math.max(0.0, -d);
    if (i <= len) {
      g += up / len;
      l += dn / len;
    } else {
      g = (g * (len - 1) + up) / len;
      l = (l * (len - 1) + dn) / len;
    }
    if (i >= len) out[i] = l == 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/// Wilder's ATR.
List<double?> _atr(List<CheSetupBar> b, int len) {
  final out = List<double?>.filled(b.length, null);
  double? a;
  var sum = 0.0;
  for (var i = 0; i < b.length; i++) {
    final tr = i == 0 ? b[i].high - b[i].low : math.max(b[i].high - b[i].low, math.max((b[i].high - b[i - 1].close).abs(), (b[i].low - b[i - 1].close).abs()));
    if (i < len) {
      sum += tr;
      if (i == len - 1) a = sum / len;
    } else {
      a = (a! * (len - 1) + tr) / len;
    }
    out[i] = i >= len - 1 ? a : null;
  }
  return out;
}

List<double?> _macd(List<double> s, int fast, int slow, int signal, String part) {
  final f = _ema(s, fast), sl = _ema(s, slow);
  final line = [for (var i = 0; i < s.length; i++) f[i] == null || sl[i] == null ? null : f[i]! - sl[i]!];
  final start = line.indexWhere((v) => v != null);
  final sig = List<double?>.filled(s.length, null);
  if (start >= 0) {
    final e = _ema([for (var i = start; i < s.length; i++) line[i]!], signal);
    for (var i = 0; i < e.length; i++) {
      sig[start + i] = e[i];
    }
  }
  return switch (part) {
    'signal' => sig,
    'hist' => [for (var i = 0; i < s.length; i++) line[i] == null || sig[i] == null ? null : line[i]! - sig[i]!],
    _ => line,
  };
}

List<double?> _bb(List<double> s, int len, double k, String part) {
  final mid = _sma(s, len);
  if (part == 'mid') return mid;
  final out = List<double?>.filled(s.length, null);
  for (var i = len - 1; i < s.length; i++) {
    var v = 0.0;
    for (var j = i - len + 1; j <= i; j++) {
      v += (s[j] - mid[i]!) * (s[j] - mid[i]!);
    }
    final sd = math.sqrt(v / len);
    out[i] = part == 'upper' ? mid[i]! + k * sd : mid[i]! - k * sd;
  }
  return out;
}

// ─── Evaluation ─────────────────────────────────────────────────────────

/// A validated `che.strategy/1` document the setup engine can follow. Construct with
/// [CheDslStrategy.parse], which refuses an invalid document with its issues.
class CheDslStrategy extends CheSetupStrategy {
  CheDslStrategy._(this.doc);

  /// Parses and validates; throws [FormatException] naming every issue.
  factory CheDslStrategy.parse(Map<String, dynamic> doc) {
    final issues = cheValidateStrategy(doc);
    if (issues.isNotEmpty) throw FormatException('Invalid strategy: ${issues.join('; ')}');
    return CheDslStrategy._(Map.unmodifiable(doc));
  }

  final Map<String, dynamic> doc;

  @override
  String get id => doc['id'] as String;
  @override
  String get name => doc['name'] as String;
  String get category => doc['category'] as String;
  List<int> get timeframes => (doc['timeframes'] as List).cast<int>();
  Map<String, num> get params => ((doc['params'] ?? const {}) as Map).cast<String, num>();
  Map get _series => (doc['series'] ?? const {}) as Map;
  int get orMinutes => (doc['or_minutes'] ?? 15) as int;
  double get minRisk => (((doc['risk'] ?? const {}) as Map)['min_points'] ?? 6 as num).toDouble();
  double get maxRisk => (((doc['risk'] ?? const {}) as Map)['max_points'] ?? 60 as num).toDouble();
  int? get maxTradesPerDay => ((doc['risk'] ?? const {}) as Map)['max_trades_per_day'] as int?;

  @override
  CheEvaluation evaluate(CheIndicators x, {required bool intrabar, required double nearPoints, double? price}) {
    if (x.bars.isEmpty) return CheEvaluation(side: '', stage: CheSetupStage.watching, conditions: const []);
    final ctx = CheDslContext.of(x);
    final results = <CheEvaluation>[];
    for (final side in ['long', 'short']) {
      final s = doc[side];
      if (s is Map) results.add(_evalSide(side, s, ctx, intrabar: intrabar, near: nearPoints, price: price));
    }
    // A triggered side wins, then the side with more required conditions met.
    results.sort((a, b) {
      int rank(CheEvaluation e) => e.stage == CheSetupStage.triggered || e.stage == CheSetupStage.ready ? 2 : e.invalidated ? -1 : 0;
      final r = rank(b) - rank(a);
      if (r != 0) return r;
      int met(CheEvaluation e) => e.conditions.where((c) => c.requiredForEntry && c.state == CheConditionState.satisfied).length;
      return met(b) - met(a);
    });
    return results.first;
  }

  CheEvaluation _evalSide(String side, Map s, CheDslContext ctx, {required bool intrabar, required double near, double? price}) {
    final i = ctx.last;
    final ev = _Eval(this, ctx, price: price);
    final conds = <CheSetupCondition>[];
    for (final c in (s['conditions'] as List).cast<Map>()) {
      final ok = ev.boolean(c['when'] as Map, i);
      conds.add(CheSetupCondition(
        id: c['id'] as String,
        label: c['label'] as String,
        group: (c['group'] ?? 'indicator') as String,
        requiredForEntry: (c['required'] ?? true) as bool,
        detail: ev.lastDetail,
        state: ok == null ? CheConditionState.unavailable : (ok ? CheConditionState.satisfied : CheConditionState.pending),
      ));
    }
    final long = side == 'long';
    final b = ctx.bars[i];
    final entry = s['entry'] == null ? b.close : ev.number(s['entry'], i);
    final stop = ev.number(s['stop'], i);
    double? target;
    final t = s['target'];
    if (t is Map && t.containsKey('r')) {
      if (entry != null && stop != null) target = long ? entry + (t['r'] as num) * (entry - stop) : entry - (t['r'] as num) * (stop - entry);
    } else {
      target = ev.number(t, i);
    }
    // The stop must be on the losing side of the entry, and the risk inside the document's bounds.
    final sideOk = entry != null && stop != null && (long ? stop < entry : stop > entry) && target != null && (long ? target > entry : target < entry);
    final r = entry != null && stop != null ? (entry - stop).abs() : null;
    final riskOk = sideOk && r! >= minRisk && r <= maxRisk;
    conds.add(CheSetupCondition(
      id: 'risk',
      label: 'Stop on the losing side, target on the winning side, risk between ${_n(minRisk)} and ${_n(maxRisk)} points',
      group: 'risk',
      state: entry == null || stop == null ? CheConditionState.unavailable : (riskOk ? CheConditionState.satisfied : CheConditionState.pending),
      detail: r == null ? 'levels not known yet' : '${r.toStringAsFixed(2)} points',
    ));
    final inv = (s['invalidation'] ?? const []) as List;
    String? broken;
    for (final c in inv.cast<Map>()) {
      if (ev.boolean(c['when'] as Map, i) == true) {
        broken = c['label'] as String;
        break;
      }
    }
    final why = '$name ($side)';
    if (broken != null) {
      return CheEvaluation(side: side, stage: CheSetupStage.invalidated, invalidated: true, conditions: conds, entry: entry, stop: stop, target: target, why: 'invalidated: $broken');
    }
    final required = conds.where((c) => c.requiredForEntry);
    final all = required.every((c) => c.state == CheConditionState.satisfied);
    if (all) {
      return CheEvaluation(side: side, stage: intrabar ? CheSetupStage.ready : CheSetupStage.triggered, conditions: conds, entry: entry, stop: stop, target: target, why: '$why: every rule met');
    }
    final met = required.where((c) => c.state == CheConditionState.satisfied).length;
    final nearLevel = s['near'] == null ? null : ev.number(s['near'], i);
    final p = price ?? b.close;
    final isNear = nearLevel != null && (p - nearLevel).abs() <= near;
    final stage = met == 0
        ? CheSetupStage.watching
        : (isNear || met >= required.length - 1)
            ? CheSetupStage.nearEntry
            : CheSetupStage.forming;
    return CheEvaluation(side: side, stage: stage, conditions: conds, entry: entry, stop: stop, target: target, why: '$why: $met of ${required.length} rules met');
  }

  /// The rules in plain language, for the library card and Read Aloud.
  List<String> describe() => cheDescribeStrategy(doc);
}

String _n(num v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();

class _Eval {
  _Eval(this.s, this.ctx, {this.price});
  final CheDslStrategy s;
  final CheDslContext ctx;
  final double? price;
  String lastDetail = '';

  double? number(Object? v, int i) {
    if (i < 0) return null;
    if (v is num) return v.toDouble();
    if (v is String) {
      if (_barFields.contains(v)) return _bar(v, i);
      if (kCheDslLevels.contains(v)) return ctx.level(v, i, orMinutes: s.orMinutes);
      final spec = s._series[v];
      return spec == null ? null : ctx.series(spec as Map, s.params)[i];
    }
    if (v is! Map) return null;
    final ago = (v['ago'] ?? 0) as int;
    final j = i - ago;
    if (j < 0) return null;
    final k = v.keys.firstWhere((k) => k != 'ago' && k != 'day');
    final x = v[k];
    switch (k) {
      case 'param':
        return s.params[x]?.toDouble();
      case 'series':
        return number(x as String, j);
      case 'bar':
        return _bar(x as String, j);
      case 'level':
        return ctx.level(x as String, j, orMinutes: s.orMinutes);
      case 'window_high' || 'window_low':
        return ctx.windowExtreme(x as String, k == 'window_high', (v['day'] ?? 0) as int, j);
      case 'abs':
        final a = number(x, j);
        return a?.abs();
    }
    final xs = [for (final e in x as List) number(e, j)];
    if (xs.any((e) => e == null)) return null;
    final ys = xs.cast<double>();
    return switch (k) {
      'add' => ys[0] + ys[1],
      'sub' => ys[0] - ys[1],
      'mul' => ys[0] * ys[1],
      'div' => ys[1] == 0 ? null : ys[0] / ys[1],
      'max' => ys.reduce(math.max),
      'min' => ys.reduce(math.min),
      _ => null,
    };
  }

  double _bar(String f, int i) {
    final b = ctx.bars[i];
    return switch (f) {
      'open' => b.open,
      'high' => b.high,
      'low' => b.low,
      'volume' => b.volume.toDouble(),
      'price' => i == ctx.last && price != null ? price! : b.close,
      _ => b.close,
    };
  }

  /// True, false, or null when a value it needs is not known yet at bar [i].
  bool? boolean(Map v, int i) {
    final ago = (v['ago'] ?? 0) as int;
    i -= ago;
    if (i < 0) return null;
    final k = v.keys.first;
    final x = v[k];
    switch (k) {
      case 'true':
        return true;
      case 'gt' || 'lt' || 'gte' || 'lte':
        final a = number((x as List)[0], i), b = number(x[1], i);
        if (a == null || b == null) return null;
        lastDetail = '${a.toStringAsFixed(2)} vs ${b.toStringAsFixed(2)}';
        return switch (k) { 'gt' => a > b, 'lt' => a < b, 'gte' => a >= b, _ => a <= b };
      case 'cross_above' || 'cross_below':
        final a = number((x as List)[0], i), b = number(x[1], i), a0 = number(x[0], i - 1), b0 = number(x[1], i - 1);
        if (a == null || b == null || a0 == null || b0 == null) return null;
        lastDetail = '${a.toStringAsFixed(2)} vs ${b.toStringAsFixed(2)}';
        return k == 'cross_above' ? (a0 <= b0 && a > b) : (a0 >= b0 && a < b);
      case 'all':
        var unknown = false;
        for (final e in (x as List).cast<Map>()) {
          final r = boolean(e, i);
          if (r == false) return false;
          if (r == null) unknown = true;
        }
        return unknown ? null : true;
      case 'any':
        var unknown = false;
        for (final e in (x as List).cast<Map>()) {
          final r = boolean(e, i);
          if (r == true) return true;
          if (r == null) unknown = true;
        }
        return unknown ? null : false;
      case 'not':
        final r = boolean(x as Map, i);
        return r == null ? null : !r;
      case 'in_window':
        final w = x is String ? kCheSessionWindows[x]! : (_hm(x['start'] as String), _hm(x['end'] as String));
        final m = ctx.nyMinutes[i];
        lastDetail = 'New York ${(m ~/ 60).toString().padLeft(2, '0')}:${(m % 60).toString().padLeft(2, '0')}';
        return ctx.inWindow(w, i);
      case 'rising' || 'falling':
        final n = (v['bars'] ?? 1) as int;
        final a = number(x, i), b = number(x, i - n);
        if (a == null || b == null) return null;
        return k == 'rising' ? a > b : a < b;
      case 'bar':
        final b = ctx.bars[i];
        return x == 'bull' ? b.close > b.open : b.close < b.open;
      case 'sweep':
        return _sweep(x == 'low', v['of'], (v['within'] ?? 1) as int, i);
      case 'fvg':
        return _fvg(x == 'bull', (v['within'] ?? 10) as int, v['retest'] == true, i);
      case 'order_block':
        return _orderBlock(x == 'bull', (v['within'] ?? 20) as int, ((v['displacement_atr'] ?? 1.5) as num).toDouble(), i);
      case 'structure_break':
        final bull = x == 'bull';
        final lvl = bull ? ctx.x.lastHigh[i - 1 < 0 ? 0 : i - 1] : ctx.x.lastLow[i - 1 < 0 ? 0 : i - 1];
        if (lvl == null || i < 1) return null;
        final c = ctx.bars[i].close, c0 = ctx.bars[i - 1].close;
        lastDetail = 'close ${c.toStringAsFixed(2)} vs swing ${lvl.toStringAsFixed(2)}';
        return bull ? (c > lvl && c0 <= lvl) : (c < lvl && c0 >= lvl);
    }
    return null;
  }

  static int _hm(String s) => int.parse(s.substring(0, 2)) * 60 + int.parse(s.substring(3, 5));

  /// Price traded through [of] within the last [within] bars and the current bar closes back on
  /// the other side (a sweep of the lows closes back above the level).
  bool? _sweep(bool low, Object? of, int within, int i) {
    final level = number(of, i);
    if (level == null) return null;
    final c = ctx.bars[i].close;
    final back = low ? c > level : c < level;
    if (!back) return false;
    for (var j = i; j >= 0 && j > i - within; j--) {
      final lvlJ = number(of, j) ?? level;
      if (low ? ctx.bars[j].low < lvlJ : ctx.bars[j].high > lvlJ) {
        lastDetail = 'swept ${lvlJ.toStringAsFixed(2)}, closed ${c.toStringAsFixed(2)}';
        return true;
      }
    }
    return false;
  }

  /// A fair value gap: three bars where bar k's low is above bar k-2's high (bullish). With
  /// [retest], the current bar trades into the gap and closes outside it on the gap's side.
  bool? _fvg(bool bull, int within, bool retest, int i) {
    for (var k = i - (retest ? 1 : 0); k >= 2 && k > i - within - 1; k--) {
      final a = ctx.bars[k - 2], c = ctx.bars[k];
      final top = bull ? c.low : a.low, bottom = bull ? a.high : c.high;
      if (top <= bottom) continue;
      if (!retest) {
        lastDetail = 'gap ${bottom.toStringAsFixed(2)}–${top.toStringAsFixed(2)}';
        return true;
      }
      final b = ctx.bars[i];
      final touched = bull ? b.low <= top : b.high >= bottom;
      final held = bull ? b.close > bottom : b.close < top;
      if (touched && held) {
        lastDetail = 'retested gap ${bottom.toStringAsFixed(2)}–${top.toStringAsFixed(2)}';
        return true;
      }
      return false;
    }
    return i < 2 ? null : false;
  }

  /// An order block: the last opposite candle before a displacement bar (body ≥ [atrMult] × ATR(14)
  /// that closes beyond that candle). The current bar trades back into the block and holds it.
  bool? _orderBlock(bool bull, int within, double atrMult, int i) {
    final atr = ctx.series(const {'fn': 'atr', 'period': 14}, const {});
    for (var d = i - 1; d >= 1 && d > i - within; d--) {
      final disp = ctx.bars[d], ob = ctx.bars[d - 1];
      final a = atr[d];
      if (a == null) return null;
      final body = (disp.close - disp.open).abs();
      final isDisp = bull ? disp.close > disp.open && disp.close > ob.high : disp.close < disp.open && disp.close < ob.low;
      final obOpposite = bull ? ob.close < ob.open : ob.close > ob.open;
      if (!isDisp || !obOpposite || body < atrMult * a) continue;
      final b = ctx.bars[i];
      final into = bull ? b.low <= ob.high : b.high >= ob.low;
      final held = bull ? b.close > ob.low : b.close < ob.high;
      lastDetail = 'block ${ob.low.toStringAsFixed(2)}–${ob.high.toStringAsFixed(2)}';
      return into && held;
    }
    return false;
  }
}

// ─── Plain language ─────────────────────────────────────────────────────

/// A document's rules as sentences, so the owner hears exactly what will run before approving it.
List<String> cheDescribeStrategy(Map<String, dynamic> doc) {
  final series = (doc['series'] ?? const {}) as Map;
  String op(Object? v) {
    if (v is num) return _n(v);
    if (v is String) {
      final s = series[v];
      if (s is Map) return _seriesName(s);
      return v.replaceAll('_', ' ');
    }
    if (v is Map) {
      final ago = v['ago'];
      final k = v.keys.firstWhere((k) => k != 'ago' && k != 'day', orElse: () => '');
      final x = v[k];
      final base = switch (k) {
        'param' => '$x',
        'series' || 'bar' || 'level' => op(x),
        'window_high' => '${v['day'] == -1 ? 'previous ' : ''}${'$x'.replaceAll('_', ' ')} high',
        'window_low' => '${v['day'] == -1 ? 'previous ' : ''}${'$x'.replaceAll('_', ' ')} low',
        'add' => '${op((x as List)[0])} plus ${op(x[1])}',
        'sub' => '${op((x as List)[0])} minus ${op(x[1])}',
        'mul' => '${op((x as List)[0])} times ${op(x[1])}',
        'div' => '${op((x as List)[0])} divided by ${op(x[1])}',
        'abs' => 'the size of ${op(x)}',
        'max' => 'the larger of ${(x as List).map(op).join(' and ')}',
        'min' => 'the smaller of ${(x as List).map(op).join(' and ')}',
        _ => '?',
      };
      return ago == null || ago == 0 ? base : '$base $ago bar${ago == 1 ? '' : 's'} ago';
    }
    return '?';
  }

  String cond(Map v) {
    final k = v.keys.first;
    final x = v[k];
    final ago = v['ago'];
    final s = switch (k) {
      'gt' => '${op((x as List)[0])} is above ${op(x[1])}',
      'lt' => '${op((x as List)[0])} is below ${op(x[1])}',
      'gte' => '${op((x as List)[0])} is at or above ${op(x[1])}',
      'lte' => '${op((x as List)[0])} is at or below ${op(x[1])}',
      'cross_above' => '${op((x as List)[0])} crosses above ${op(x[1])}',
      'cross_below' => '${op((x as List)[0])} crosses below ${op(x[1])}',
      'all' => (x as List).cast<Map>().map(cond).join(', and '),
      'any' => 'either ${(x as List).cast<Map>().map(cond).join(', or ')}',
      'not' => 'not (${cond(x as Map)})',
      'in_window' => x is String ? 'the time is in the ${x.replaceAll('_', ' ')} window (New York)' : 'the time is between ${x['start']} and ${x['end']} New York',
      'rising' => '${op(x)} is higher than ${v['bars'] ?? 1} bar(s) ago',
      'falling' => '${op(x)} is lower than ${v['bars'] ?? 1} bar(s) ago',
      'bar' => x == 'bull' ? 'the bar closes above its open' : 'the bar closes below its open',
      'sweep' => 'price ${x == 'low' ? 'trades below' : 'trades above'} ${op(v['of'])} within ${v['within'] ?? 1} bar(s) and closes back ${x == 'low' ? 'above' : 'below'} it',
      'fvg' => v['retest'] == true ? 'price retests a ${x == 'bull' ? 'bullish' : 'bearish'} fair value gap from the last ${v['within'] ?? 10} bars and holds it' : 'a ${x == 'bull' ? 'bullish' : 'bearish'} fair value gap formed in the last ${v['within'] ?? 10} bars',
      'order_block' => 'price retests a ${x == 'bull' ? 'bullish' : 'bearish'} order block (displacement of at least ${v['displacement_atr'] ?? 1.5} ATR) from the last ${v['within'] ?? 20} bars and holds it',
      'structure_break' => 'the close breaks the last confirmed swing ${x == 'bull' ? 'high' : 'low'}',
      'true' => 'always',
      _ => '?',
    };
    return ago == null || ago == 0 ? s : '$s ($ago bar${ago == 1 ? '' : 's'} ago)';
  }

  final out = <String>['${doc['name']}: ${kCheStrategyCategories[doc['category']] ?? doc['category']}, on ${(doc['timeframes'] as List).map((t) => '$t-minute').join(' and ')} bars.'];
  for (final side in ['long', 'short']) {
    final s = doc[side];
    if (s is! Map) continue;
    out.add('${side == 'long' ? 'Long' : 'Short'} when: ${(s['conditions'] as List).cast<Map>().map((c) => '${c['label']} (${cond(c['when'] as Map)})${c['required'] == false ? ', optional' : ''}').join('; ')}.');
    out.add('Entry: ${s['entry'] == null ? 'the next bar open after the signal bar closes' : op(s['entry'])}. Stop: ${op(s['stop'])}. Target: ${s['target'] is Map && (s['target'] as Map).containsKey('r') ? '${(s['target'] as Map)['r']} times the risk' : op(s['target'])}.');
    final inv = (s['invalidation'] ?? const []) as List;
    if (inv.isNotEmpty) out.add('Cancelled before entry if: ${inv.cast<Map>().map((c) => c['label']).join('; ')}.');
  }
  final risk = (doc['risk'] ?? const {}) as Map;
  out.add('Risk per trade: ${_n(risk['min_points'] ?? 6)} to ${_n(risk['max_points'] ?? 60)} points${risk['max_trades_per_day'] != null ? ', at most ${risk['max_trades_per_day']} trades a day' : ''}. Paper only.');
  return out;
}

String _seriesName(Map s) => switch (s['fn']) {
      'ema' => '${s['period'] ?? 20}-bar EMA',
      'sma' => '${s['period'] ?? 20}-bar average',
      'rsi' => '${s['period'] ?? 14}-bar RSI',
      'atr' => '${s['period'] ?? 14}-bar ATR',
      'vol_sma' => '${s['period'] ?? 20}-bar average volume',
      'highest' => 'highest ${s['of'] ?? 'close'} of ${s['period'] ?? 20} bars',
      'lowest' => 'lowest ${s['of'] ?? 'close'} of ${s['period'] ?? 20} bars',
      'macd' => 'MACD ${s['part'] ?? 'line'} (${s['fast'] ?? 12}, ${s['slow'] ?? 26}, ${s['signal'] ?? 9})',
      'bb' => 'Bollinger ${s['part'] ?? 'mid'} band (${s['period'] ?? 20}, ${s['k'] ?? 2})',
      'vwap_band' => 'VWAP ${(s['k'] as num) >= 0 ? '+' : ''}${s['k']} standard deviations',
      _ => '${s['fn']}',
    };
