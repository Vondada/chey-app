// CHE Signal Mode desk (owner, 2026-10-23): runs the setup engine on the real Rithmic candles from
// CheMarketFeed (1- and 5-minute), records every stage change and signal in the audit trail, raises
// the alerts the owner enabled, and hands signals to the chart as CHE PAPER ACCOUNT markers.
//
// - Only candles from the feed are used: real Rithmic trades. Delayed data never reaches it.
// - Recorded history is replayed into the engines on start without alerts, so a restart never
//   announces old setups as new.
// - Forming-bar evaluation is throttled (once a second per timeframe) so live ticks cannot lag the app.
// - Evidence comes from the research ledger (/api/trading/research); without it each setup says
//   "No recorded evidence" instead of a number.
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'che_market_feed.dart';
import 'che_setup_engine.dart';
import 'che_trade_alerts.dart';
import 'che_trade_audit.dart';
import 'che_trade_signal.dart';

CheSetupBar cheSetupBarOf(CheCandle c) =>
    CheSetupBar(start: c.start, minutes: c.minutes, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume);

class CheSetupDesk extends ChangeNotifier {
  CheSetupDesk({
    this.symbol = 'MNQ',
    CheTradeAlerts? alerts,
    CheTradeAudit? audit,
    DateTime Function()? clock,
    Iterable<CheSetupStrategy>? strategies,
    this.formingEvery = const Duration(seconds: 1),
  })  : alerts = alerts ?? CheTradeAlerts.instance,
        audit = audit ?? CheTradeAudit.instance,
        _clock = clock ?? DateTime.now {
    for (final m in kCheFeedMinutes) {
      engines[m] = CheSetupEngine(symbol: symbol, minutes: m, strategies: strategies);
    }
  }

  static final instance = CheSetupDesk();

  String symbol;
  final CheTradeAlerts alerts;
  final CheTradeAudit audit;
  final DateTime Function() _clock;
  final Duration formingEvery;
  final Map<int, CheSetupEngine> engines = {};

  /// Newest first. Signals are CHE PAPER ACCOUNT records.
  final List<CheTradeSignal> signals = [];
  CheMarketSnapshot? snapshot;
  final Map<int, DateTime> _lastForming = {};
  final List<StreamSubscription<Object?>> _subs = [];
  final Map<String, Set<CheSetupStage>> _alerted = {};
  bool _replaying = false;
  bool attached = false;

  /// Chart markers for the signals (source 'che_signal').
  List<Map<String, dynamic>> get markers => [for (final s in signals) s.toMarker()];

  /// The same markers as a listenable, for the Trading Room chart.
  final ValueNotifier<List<Map<String, dynamic>>> markerFeed = ValueNotifier(const []);

  /// Every setup on every timeframe, live ones first, then recent finished ones.
  List<CheSetupState> get setups => [
        for (final m in kCheFeedMinutes) ...engines[m]!.setups,
        for (final m in kCheFeedMinutes) ...engines[m]!.finished.take(5),
      ];

  /// True only while Rithmic trades are arriving. Otherwise CHE is not evaluating any setup: each one shows its state as
  /// of its last candle and waits (owner audit, 2026-10-24: a watcher waiting for candles must never read as active).
  bool get evaluating => snapshot?.isLive == true;

  /// Why CHE is not evaluating setups right now, in the feed's own words; empty while it is.
  String get notEvaluatingReason => evaluating ? '' : snapshot == null ? 'No market feed yet' : snapshot!.statusLabel;

  int get activeSetupCount => setups.where((s) => !s.stage.isFinal && s.stage != CheSetupStage.watching).length;
  List<CheSetupState> get readySetups => setups.where((s) => s.stage == CheSetupStage.ready || s.stage == CheSetupStage.triggered).toList();

  /// Subscribes to the app's market feed and replays what it has recorded so far.
  void attach([CheMarketFeed? feed]) {
    if (attached) return;
    attached = true;
    final f = feed ?? CheMarketFeed.instance;
    _onSnapshot(f.current);
    _replaying = true;
    for (final m in kCheFeedMinutes) {
      for (final c in f.history(m)) {
        if (c.closed) ingest(c);
      }
    }
    _replaying = false;
    _subs.add(f.snapshots.listen(_onSnapshot));
    for (final m in kCheFeedMinutes) {
      _subs.add(f.candles(m).listen(ingest));
    }
    notifyListeners();
  }

  void _onSnapshot(CheMarketSnapshot s) {
    snapshot = s;
    for (final e in engines.values) {
      e
        ..dataSource = s.sourceLabel
        ..dataLive = s.isLive;
    }
  }

  /// Takes one candle from the feed (forming or closed). Public for tests.
  List<CheSetupEvent> ingest(CheCandle c) {
    final engine = engines[c.minutes];
    if (engine == null || c.source != 'rithmic') return const [];
    final List<CheSetupEvent> events;
    if (c.closed) {
      events = engine.onClosed(cheSetupBarOf(c));
      _align();
    } else {
      final now = _clock();
      final last = _lastForming[c.minutes];
      if (last != null && now.difference(last) < formingEvery) return const [];
      _lastForming[c.minutes] = now;
      events = engine.onForming(cheSetupBarOf(c));
    }
    for (final e in events) {
      _record(e);
    }
    if (events.isNotEmpty || c.closed) notifyListeners();
    return events;
  }

  /// Timeframe alignment: whether the 1- and 5-minute trends agree.
  void _align() {
    final t1 = engines[1]?.trend ?? 'unknown', t5 = engines[5]?.trend ?? 'unknown';
    final text = (t1 == 'unknown' || t5 == 'unknown')
        ? 'not enough bars on both timeframes'
        : t1 == t5 && t1 != 'flat'
            ? '1- and 5-minute trends agree ($t1)'
            : '1-minute $t1, 5-minute $t5: not aligned';
    for (final e in engines.values) {
      e.alignment = text;
    }
  }

  /// Applies research-ledger evidence (GET /api/trading/research → strategies[]).
  void applyEvidence(Map<String, dynamic> research) {
    final list = research['strategies'];
    if (list is! List) return;
    for (final raw in list) {
      if (raw is! Map) continue;
      final id = '${raw['strategy_id'] ?? ''}';
      if (id.isEmpty) continue;
      num? n(Object? v) => v is num ? v : null;
      final ev = CheStrategyEvidence(
        strategyId: id,
        sampleTrades: (n(raw['sample_trades']) ?? 0).toInt(),
        paperTrades: (n(raw['paper_trades']) ?? 0).toInt(),
        expectancyR: n(raw['expectancy_r'])?.toDouble(),
        winRate: n(raw['win_rate'])?.toDouble(),
        readiness: '${raw['readiness'] ?? ''}',
      );
      for (final e in engines.values) {
        e.evidence[id] = ev;
      }
    }
    notifyListeners();
  }

  void _record(CheSetupEvent e) {
    final s = e.setup;
    const account = CheTradeSignal.account;
    unawaited(audit.append('setup_stage', account: account, data: {
      'setup_id': s.id,
      'strategy_id': s.strategyId,
      'symbol': s.symbol,
      'timeframe': '${s.timeframeMinutes}m',
      'side': s.side,
      'from': e.from.label,
      'to': e.to.label,
      'reason': e.reason,
      'data_source': s.dataSource,
      'data_live': s.dataLive,
      'replay': _replaying,
      'conditions': [for (final c in s.conditions) '${c.state.name}: ${c.label}'],
    }));
    final sig = e.signal;
    if (sig != null) {
      signals.insert(0, sig);
      if (signals.length > 50) signals.removeRange(50, signals.length);
      markerFeed.value = markers;
      unawaited(audit.append('signal', account: account, data: {...sig.toJson(), 'replay': _replaying}));
    }
    if (_replaying) return;
    // One alert per setup per stage: a forming bar going back and forth never repeats an alert.
    final seen = _alerted.putIfAbsent(s.id, () => {});
    if (!seen.add(e.to)) return;
    final title = '${s.strategyName} ${s.side.isEmpty ? '' : '${s.side} '}${s.symbol} ${s.timeframeMinutes}m: ${e.to.label}';
    final type = switch (e.to) {
      CheSetupStage.nearEntry => CheAlertType.setupNearEntry,
      CheSetupStage.ready || CheSetupStage.triggered => CheAlertType.setupReady,
      CheSetupStage.invalidated => CheAlertType.setupInvalidated,
      _ => CheAlertType.setupStage,
    };
    final message = sig != null ? sig.spoken : '${e.to.meaning[0].toUpperCase()}${e.to.meaning.substring(1)}. ${e.reason}.';
    unawaited(alerts.raise(type, title: title, message: message, account: account, data: {'setup_id': s.id, 'stage': e.to.label}));
  }

  /// Spoken summary for "what setups are ready" and Read Aloud.
  String spokenSummary() {
    final now = _clock();
    final live = setups.where((s) => !s.stage.isFinal).toList();
    final feed = snapshot == null ? 'No market feed yet.' : '${snapshot!.sourceLabel}, ${snapshot!.statusLabel}.';
    final waiting = evaluating ? '' : ' CHE is not evaluating setups right now, because Rithmic candles are not arriving.';
    if (live.isEmpty) return '$feed$waiting CHE is not following any setups yet.';
    if (!evaluating) {
      return '$feed$waiting ${live.length} setup${live.length == 1 ? ' is' : 's are'} paused at their last candle: ${live.map((s) => s.spoken(now)).join(' ')} These are paper setups for the CHE PAPER ACCOUNT, not predictions.';
    }
    final ready = live.where((s) => s.stage == CheSetupStage.ready || s.stage == CheSetupStage.triggered).toList();
    final head = ready.isEmpty ? 'No setup is ready right now.' : '${ready.length} setup${ready.length == 1 ? ' is' : 's are'} ready or triggered.';
    return '$feed $head ${live.map((s) => s.spoken(now)).join(' ')} These are paper setups for the CHE PAPER ACCOUNT, not predictions.';
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    markerFeed.dispose();
    super.dispose();
  }
}
