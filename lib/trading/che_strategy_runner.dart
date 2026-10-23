// Many strategies, one feed, inside a budget (owner, 2026-10-23): "evaluating hundreds of strategies must not
// overload CHE, exhaust API budgets, or overtrade".
//
// The runner does not evaluate anything itself. It chooses which strategies the setup engine follows
// (che_setup_engine.dart, one evaluator, indicators computed once per candle and shared), times them, and
// decides whether a TRIGGERED signal may become a paper order. Every strategy left out is listed with its
// reason ("paused: budget"); nothing is dropped silently. No model is called here.

import 'che_setup_engine.dart';
import 'che_trade_signal.dart';

/// The limits, mirrored from strategy_library.js BUDGET (the Worker sends its values with the library).
class CheStrategyBudget {
  const CheStrategyBudget({
    this.maxActive = 60,
    this.perCandleMs = 250,
    this.maxPaperPerStrategyDay = 5,
    this.maxPaperGlobalDay = 60,
    this.maxOpenPerSymbol = 1,
  });

  factory CheStrategyBudget.fromJson(Map m) => CheStrategyBudget(
        maxActive: (m['max_active'] as num?)?.toInt() ?? 60,
        perCandleMs: (m['per_candle_ms'] as num?)?.toInt() ?? 250,
        maxPaperPerStrategyDay: (m['max_paper_per_strategy_day'] as num?)?.toInt() ?? 5,
        maxPaperGlobalDay: (m['max_paper_global_day'] as num?)?.toInt() ?? 60,
        maxOpenPerSymbol: (m['max_open_per_symbol'] as num?)?.toInt() ?? 1,
      );

  final int maxActive, perCandleMs, maxPaperPerStrategyDay, maxPaperGlobalDay, maxOpenPerSymbol;
}

/// Why a strategy is not being followed, or why a signal did not become a paper order.
class CheRunnerNote {
  const CheRunnerNote(this.strategyId, this.reason, this.at);
  final String strategyId, reason;
  final DateTime at;
}

/// Times a strategy's evaluations so the runner can keep the candle inside its budget.
class _Timed extends CheSetupStrategy {
  _Timed(this.inner);
  final CheSetupStrategy inner;
  int micros = 0, calls = 0;
  @override
  String get id => inner.id;
  @override
  String get name => inner.name;
  @override
  CheEvaluation evaluate(CheIndicators x, {required bool intrabar, required double nearPoints, double? price}) {
    final sw = Stopwatch()..start();
    try {
      return inner.evaluate(x, intrabar: intrabar, nearPoints: nearPoints, price: price);
    } finally {
      micros += sw.elapsedMicroseconds;
      calls += 1;
    }
  }

  double get avgMs => calls == 0 ? 0 : micros / calls / 1000;
}

class CheStrategyRunner {
  /// [strategies] in priority order (favorites first, then the rest); the first [budget.maxActive] are followed.
  CheStrategyRunner({required this.symbol, required this.minutes, required List<CheSetupStrategy> strategies, this.budget = const CheStrategyBudget(), Map<String, int>? perStrategyDayCap})
      : _all = List.of(strategies),
        _caps = perStrategyDayCap ?? const {} {
    _rebuild(DateTime.now().toUtc());
  }

  final String symbol;
  final int minutes;
  final CheStrategyBudget budget;
  final List<CheSetupStrategy> _all;
  final Map<String, int> _caps;
  late CheSetupEngine engine;
  List<_Timed> _active = [];
  final Set<String> _budgetPaused = {};
  final List<CheRunnerNote> notes = [];
  final Set<String> _seenSignals = {};
  final Map<String, int> _paperToday = {};
  final Set<String> _openSetups = {};
  String _day = '';
  int lastCandleMs = 0;

  List<String> get activeIds => [for (final t in _active) t.id];

  /// Strategy id → "paused: budget …" for every strategy the runner is not following now.
  Map<String, String> get paused => {for (final id in _budgetPaused) id: _pauseReason(id)};

  String _pauseReason(String id) => 'paused: budget (CHE follows at most ${budget.maxActive} strategies and ${budget.perCandleMs} ms of evaluation per candle)';

  void _rebuild(DateTime at) {
    final keep = <_Timed>[];
    for (final s in _all) {
      if (_budgetPaused.contains(s.id)) continue;
      if (keep.length >= budget.maxActive) {
        if (_budgetPaused.add(s.id)) notes.add(CheRunnerNote(s.id, _pauseReason(s.id), at));
        continue;
      }
      keep.add(_active.firstWhere((t) => t.id == s.id, orElse: () => _Timed(s)));
    }
    _active = keep;
    engine = CheSetupEngine(symbol: symbol, minutes: minutes, strategies: _active);
  }

  /// Feed a closed candle. When the candle took longer than the budget, the lowest-priority strategies are paused
  /// (with a note) until the total fits; their history restarts when they are resumed.
  List<CheSetupEvent> onClosed(CheSetupBar bar) {
    final sw = Stopwatch()..start();
    final events = engine.onClosed(bar);
    lastCandleMs = sw.elapsedMilliseconds;
    if (lastCandleMs > budget.perCandleMs && _active.length > 1) {
      var total = lastCandleMs.toDouble();
      final drop = <String>[];
      for (final t in _active.reversed) {
        if (total <= budget.perCandleMs || _active.length - drop.length <= 1) break;
        total -= t.avgMs;
        drop.add(t.id);
      }
      if (drop.isNotEmpty) {
        final closed = engine.closedBars;
        _budgetPaused.addAll(drop);
        for (final id in drop) {
          notes.add(CheRunnerNote(id, 'paused: budget (the last candle took $lastCandleMs ms of ${budget.perCandleMs})', bar.end));
        }
        _rebuild(bar.end);
        for (final b in closed) {
          engine.onClosed(b);
        }
      }
    }
    return events;
  }

  List<CheSetupEvent> onForming(CheSetupBar bar) => engine.onForming(bar);

  /// Whether a TRIGGERED signal may become a CHE paper order: once per signal id, within the strategy's and the
  /// global daily caps, and at most [CheStrategyBudget.maxOpenPerSymbol] open per symbol. A refusal is recorded.
  ({bool ok, String reason}) admit(CheTradeSignal s) {
    final day = cheTradeDay(s.signalTime);
    if (day != _day) {
      _day = day;
      _paperToday.clear();
    }
    String? why;
    if (_seenSignals.contains(s.id)) {
      why = 'duplicate signal: already handled';
    } else if (_openSetups.length >= budget.maxOpenPerSymbol) {
      why = 'skipped: CHE already has ${_openSetups.length} paper position${_openSetups.length == 1 ? '' : 's'} open on $symbol (overtrading guard)';
    } else if ((_paperToday[s.strategyId] ?? 0) >= _capFor(s.strategyId)) {
      why = 'skipped: ${s.strategyName} reached its ${_capFor(s.strategyId)} paper trades for today';
    } else if (_paperToday.values.fold(0, (a, b) => a + b) >= budget.maxPaperGlobalDay) {
      why = 'skipped: the global limit of ${budget.maxPaperGlobalDay} paper trades today is reached';
    }
    _seenSignals.add(s.id);
    if (why != null) {
      notes.add(CheRunnerNote(s.strategyId, why, s.signalTime));
      return (ok: false, reason: why);
    }
    _paperToday[s.strategyId] = (_paperToday[s.strategyId] ?? 0) + 1;
    _openSetups.add(s.setupId);
    return (ok: true, reason: 'admitted as a CHE PAPER ACCOUNT order');
  }

  /// The paper position for [setupId] closed (target, stop, expiry or void).
  void closed(String setupId) => _openSetups.remove(setupId);

  int _capFor(String id) {
    final own = _caps[id];
    return own == null ? budget.maxPaperPerStrategyDay : (own < budget.maxPaperPerStrategyDay ? own : budget.maxPaperPerStrategyDay);
  }

  /// Average evaluation time per strategy, for the library's diagnostics.
  Map<String, double> get timings => {for (final t in _active) t.id: t.avgMs};
}
