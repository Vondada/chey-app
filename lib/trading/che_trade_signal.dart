// CHE trade signals and setup progress (owner, 2026-10-23): the shared records the setup engine
// (che_setup_engine.dart), the Setup Progress Board, the chart and the CHE paper account read.
//
// Rules every consumer can rely on:
// - A setup only reaches READY or TRIGGERED when every required condition is actually satisfied by
//   verified market data. The engine refuses any other transition (see [cheSetupTransitionAllowed]).
// - A [CheTradeSignal] is a CHE PAPER ACCOUNT record. It never places, changes or cancels an order.
// - Evidence is the recorded strategy evidence with its sample size; a small sample is reported as
//   insufficient, never turned into a confidence number.

/// The setup progression, in order. The last four are final.
enum CheSetupStage { watching, forming, nearEntry, ready, triggered, active, targetHit, stopped, invalidated, expired }

extension CheSetupStageText on CheSetupStage {
  /// The label the board shows, in capitals like the owner wrote them.
  String get label => switch (this) {
        CheSetupStage.watching => 'WATCHING',
        CheSetupStage.forming => 'FORMING',
        CheSetupStage.nearEntry => 'NEAR ENTRY',
        CheSetupStage.ready => 'READY',
        CheSetupStage.triggered => 'TRIGGERED',
        CheSetupStage.active => 'ACTIVE',
        CheSetupStage.targetHit => 'TARGET HIT',
        CheSetupStage.stopped => 'STOPPED',
        CheSetupStage.invalidated => 'INVALIDATED',
        CheSetupStage.expired => 'EXPIRED',
      };

  /// Plain words for VoiceOver and Read Aloud. Never promises an outcome.
  String get meaning => switch (this) {
        CheSetupStage.watching => 'CHE is watching; the background conditions are not in place yet',
        CheSetupStage.forming => 'the background conditions are in place; the entry pattern has not appeared',
        CheSetupStage.nearEntry => 'price is close to the planned entry area',
        CheSetupStage.ready => 'every entry condition is met on the bar still forming; it counts only if the bar closes this way',
        CheSetupStage.triggered => 'a closed bar met every entry rule; the paper entry is the next bar open',
        CheSetupStage.active => 'the paper position is open',
        CheSetupStage.targetHit => 'price reached the target',
        CheSetupStage.stopped => 'price reached the stop',
        CheSetupStage.invalidated => 'a required condition failed before entry',
        CheSetupStage.expired => 'the setup ran out of time',
      };

  bool get isFinal => index >= CheSetupStage.targetHit.index;

  /// 0..1 position along the path to a trade, for the progress bar. Final stages show full.
  double get progress => isFinal ? 1 : index / CheSetupStage.active.index;
}

/// Allowed moves. Forward through the pre-entry stages one or more steps, back down while nothing
/// has triggered (conditions can stop holding), and from any live stage to a final one that fits.
bool cheSetupTransitionAllowed(CheSetupStage from, CheSetupStage to) {
  if (from == to) return true;
  if (from.isFinal) return false;
  const preEntry = {CheSetupStage.watching, CheSetupStage.forming, CheSetupStage.nearEntry, CheSetupStage.ready};
  if (preEntry.contains(from)) {
    if (preEntry.contains(to)) return true;
    if (to == CheSetupStage.triggered) return true;
    return to == CheSetupStage.invalidated || to == CheSetupStage.expired;
  }
  if (from == CheSetupStage.triggered) {
    // The entry fills at the next open; a time cut before that expires it.
    return to == CheSetupStage.active || to == CheSetupStage.expired || to == CheSetupStage.invalidated;
  }
  // ACTIVE ends at the target, the stop or the time limit.
  return to == CheSetupStage.targetHit || to == CheSetupStage.stopped || to == CheSetupStage.expired;
}

enum CheConditionState { satisfied, pending, failed, unavailable }

/// One rule of a setup, with the measured value that decided it.
class CheSetupCondition {
  const CheSetupCondition({required this.id, required this.label, required this.state, required this.group, this.detail = '', this.requiredForEntry = true});

  final String id, label;
  final CheConditionState state;

  /// 'structure', 'trend', 'indicator', 'volume', 'timeframe', 'trigger' or 'risk'.
  final String group;

  /// The measurement in words, e.g. "20 EMA 21,452.25 above 50 EMA 21,440.00".
  final String detail;

  /// False for context the board shows but entry does not need (volume when unavailable).
  final bool requiredForEntry;

  Map<String, dynamic> toJson() => {'id': id, 'label': label, 'state': state.name, 'group': group, 'detail': detail, 'required': requiredForEntry};
}

/// Recorded evidence for a strategy, from the research ledger. Never estimated.
class CheStrategyEvidence {
  const CheStrategyEvidence({required this.strategyId, required this.sampleTrades, this.paperTrades = 0, this.expectancyR, this.winRate, this.readiness = '', this.source = 'CHE trading research ledger'});

  /// Fewer closed trades than this is an anecdote, not evidence (trading_evidence.js MIN_TRADES).
  static const minTrades = 30;

  final String strategyId;
  final int sampleTrades, paperTrades;
  final double? expectancyR, winRate;
  final String readiness, source;

  bool get sufficient => sampleTrades >= minTrades && expectancyR != null;

  /// The evidence status in words: sample size always shown, no invented confidence.
  String get status {
    if (sampleTrades == 0) return 'No recorded evidence';
    if (!sufficient) return 'Insufficient evidence: $sampleTrades of $minTrades trades';
    final e = expectancyR!;
    final wr = winRate == null ? '' : ', ${(winRate! * 100).round()}% wins';
    return '$sampleTrades trades, ${e >= 0 ? '+' : ''}${e.toStringAsFixed(2)}R expectancy$wr${readiness.isEmpty ? '' : ' ($readiness)'}';
  }

  /// 0..100 for the badge only when the sample is sufficient; null otherwise.
  int? get score {
    if (!sufficient) return null;
    final e = expectancyR!.clamp(-1.0, 1.0);
    final sample = (sampleTrades / 200).clamp(0.0, 1.0);
    return (50 + e * 35 + sample * 15).round().clamp(0, 100);
  }

  static const none = CheStrategyEvidence(strategyId: '', sampleTrades: 0);
}

/// A CHE PAPER ACCOUNT trade signal: a closed bar met every entry rule.
class CheTradeSignal {
  const CheTradeSignal({
    required this.id,
    required this.setupId,
    required this.strategyId,
    required this.strategyName,
    required this.symbol,
    required this.timeframeMinutes,
    required this.side,
    required this.entry,
    required this.stop,
    required this.target,
    required this.signalTime,
    required this.barTime,
    required this.dataSource,
    required this.dataLive,
    required this.evidence,
    required this.why,
  });

  final String id, setupId, strategyId, strategyName, symbol;
  final int timeframeMinutes;

  /// 'long' or 'short'.
  final String side;

  /// Planned entry (the signal bar close; the paper fill is the next open, with costs).
  final double entry, stop, target;

  /// When the signal bar closed, and the bar it closed.
  final DateTime signalTime, barTime;

  /// e.g. "Rithmic live — MNQZ6", or a historical label. Delayed data is never live.
  final String dataSource;
  final bool dataLive;
  final CheStrategyEvidence evidence;
  final String why;

  static const account = 'CHE PAPER ACCOUNT';

  double get risk => (entry - stop).abs();
  double get reward => (target - entry).abs();
  double? get rewardRisk => risk == 0 ? null : reward / risk;

  Map<String, dynamic> toJson() => {
        'id': id,
        'setup_id': setupId,
        'account': account,
        'strategy_id': strategyId,
        'strategy': strategyName,
        'symbol': symbol,
        'timeframe': '${timeframeMinutes}m',
        'side': side,
        'entry': entry,
        'stop': stop,
        'target': target,
        'reward_risk': rewardRisk,
        'signal_time': signalTime.toUtc().toIso8601String(),
        'bar_time': barTime.toUtc().toIso8601String(),
        'data_source': dataSource,
        'data_live': dataLive,
        'evidence': evidence.status,
        'evidence_trades': evidence.sampleTrades,
        'why': why,
      };

  /// The chart marker the existing marker layer draws (source 'che_signal').
  Map<String, dynamic> toMarker() => {
        'source': 'che_signal',
        'kind': 'signal',
        'time': barTime.toUtc().toIso8601String(),
        'price': entry,
        'side': side,
        'strategy': strategyName,
        'status': 'signal',
        'account': account,
        'stop': stop,
        'target': target,
        'timeframe': '${timeframeMinutes}m',
        'data_source': dataSource,
        'evidence': evidence.status,
      };

  String get spoken {
    final rr = rewardRisk == null ? '' : ', reward to risk ${rewardRisk!.toStringAsFixed(1)}';
    return '$account signal: $strategyName ${side == 'short' ? 'short' : 'long'} $symbol on the $timeframeMinutes-minute chart. '
        'Planned entry ${_p(entry)}, stop ${_p(stop)}, target ${_p(target)}$rr. Data: $dataSource. Evidence: ${evidence.status}. '
        'This is a paper signal, not a prediction.';
  }
}

/// One setup being followed, with its full condition list and stage history.
class CheSetupState {
  CheSetupState({
    required this.id,
    required this.strategyId,
    required this.strategyName,
    required this.symbol,
    required this.timeframeMinutes,
    required this.side,
    required this.firstDetected,
    this.stage = CheSetupStage.watching,
  });

  final String id, strategyId, strategyName, symbol;
  final int timeframeMinutes;
  String side;
  final DateTime firstDetected;
  CheSetupStage stage;
  List<CheSetupCondition> conditions = const [];

  /// Planned levels when known (they move while the setup forms).
  double? plannedEntry, plannedStop, plannedTarget, lastPrice;
  String marketStructure = 'unknown', trend = 'unknown', timeframeAlignment = 'not checked';
  String dataSource = '';
  bool dataLive = false;
  CheStrategyEvidence evidence = CheStrategyEvidence.none;
  CheTradeSignal? signal;
  DateTime? stageSince, updatedAt;
  final List<(DateTime, CheSetupStage, String)> timeline = [];

  Iterable<CheSetupCondition> get satisfied => conditions.where((c) => c.state == CheConditionState.satisfied);
  Iterable<CheSetupCondition> get pending => conditions.where((c) => c.state == CheConditionState.pending);
  Iterable<CheSetupCondition> get failed => conditions.where((c) => c.state == CheConditionState.failed);

  /// Required conditions met, out of those required: the checklist fraction the board shows.
  (int, int) get checklist {
    final req = conditions.where((c) => c.requiredForEntry).toList();
    return (req.where((c) => c.state == CheConditionState.satisfied).length, req.length);
  }

  double? get distanceToEntry => plannedEntry == null || lastPrice == null ? null : (lastPrice! - plannedEntry!).abs();
  double? get distanceToStop => plannedStop == null || lastPrice == null ? null : (lastPrice! - plannedStop!).abs();
  double? get distanceToTarget => plannedTarget == null || lastPrice == null ? null : (lastPrice! - plannedTarget!).abs();

  Duration age(DateTime now) => now.difference(firstDetected);

  String spoken(DateTime now) {
    final (have, need) = checklist;
    final mins = age(now).inMinutes;
    final pend = pending.map((c) => c.label).take(3).join('; ');
    final fail = failed.map((c) => c.label).take(2).join('; ');
    return '$strategyName ${side == 'short' ? 'short' : 'long'} on $symbol $timeframeMinutes-minute: ${stage.label}, ${stage.meaning}. '
        '$have of $need entry conditions met.${pend.isEmpty ? '' : ' Still pending: $pend.'}${fail.isEmpty ? '' : ' Failed: $fail.'}'
        '${distanceToEntry == null ? '' : ' ${_p(distanceToEntry!)} points from the planned entry.'}'
        ' First seen $mins minute${mins == 1 ? '' : 's'} ago. Evidence: ${evidence.status}.';
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'account': CheTradeSignal.account,
        'strategy_id': strategyId,
        'strategy': strategyName,
        'symbol': symbol,
        'timeframe': '${timeframeMinutes}m',
        'side': side,
        'stage': stage.label,
        'first_detected': firstDetected.toUtc().toIso8601String(),
        'conditions': [for (final c in conditions) c.toJson()],
        'planned_entry': plannedEntry,
        'planned_stop': plannedStop,
        'planned_target': plannedTarget,
        'data_source': dataSource,
        'data_live': dataLive,
        'evidence': evidence.status,
      };
}

String _p(double v) => v.toStringAsFixed(2);
