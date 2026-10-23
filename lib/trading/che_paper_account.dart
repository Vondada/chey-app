// CHE PAPER ACCOUNT (owner, 2026-10-23): CHE's own simulated futures account, kept apart from the
// owner's account and from any live broker account. Prices come only from the verified Rithmic
// feed; a delayed or unknown source is refused. Nothing here can reach a broker: there is no
// order code, and every record says "CHE PAPER ACCOUNT · simulated".
//
// History is append-only: the balance history, the trade records, the journal and the audit only
// grow. A balance change never rewrites a closed trade; it starts a new line in the history and the
// figures that depend on it (available, risk %, drawdown) are recomputed from the records.
//
// Costs mirror server/cloudflare/trading_evidence.js COSTS so paper results here and the Worker's
// forward-paper journal use the same planning numbers. They are assumptions, not a broker schedule.

/// Every figure this module produces carries this label.
const kChePaperLabel = 'CHE PAPER ACCOUNT';
const kChePaperDefaultBalance = 100.0;

class CheContractSpec {
  const CheContractSpec(this.root, {required this.tick, required this.pointValue});
  final String root;
  final double tick;
  final double pointValue;

  /// MNQ and NQ (trading_evidence.js CONTRACTS). A symbol like "MNQZ6" maps to its root.
  static const mnq = CheContractSpec('MNQ', tick: 0.25, pointValue: 2);
  static const nq = CheContractSpec('NQ', tick: 0.25, pointValue: 20);

  static CheContractSpec? forSymbol(String symbol) {
    final s = symbol.toUpperCase();
    if (s.startsWith('MNQ')) return mnq;
    if (s.startsWith('NQ')) return nq;
    return null;
  }
}

/// Assumed costs (trading_evidence.js COSTS).
class CheCostModel {
  const CheCostModel({this.spreadTicks = 1, this.slippageTicks = 1, this.commissionPerSide = 1.5, this.feePerSide = 0.5});
  final double spreadTicks, slippageTicks, commissionPerSide, feePerSide;
  static const standard = CheCostModel();

  Map<String, Object?> toJson() =>
      {'spread_ticks': spreadTicks, 'slippage_ticks': slippageTicks, 'commission_per_side': commissionPerSide, 'fee_per_side': feePerSide};
  factory CheCostModel.fromJson(Map<String, dynamic> j) => CheCostModel(
        spreadTicks: _d(j['spread_ticks']) ?? 1,
        slippageTicks: _d(j['slippage_ticks']) ?? 1,
        commissionPerSide: _d(j['commission_per_side']) ?? 1.5,
        feePerSide: _d(j['fee_per_side']) ?? 0.5,
      );
}

/// One traded price from a market feed. Only [source] == 'rithmic' can fill a paper order.
class ChePriceTick {
  const ChePriceTick({required this.symbol, required this.price, required this.time, required this.source});
  final String symbol;
  final double price;
  final DateTime time;
  final String source;

  bool get isRithmic => source == 'rithmic';
}

enum CheSide { long, short }

extension CheSideX on CheSide {
  int get sign => this == CheSide.long ? 1 : -1;
  String get label => this == CheSide.long ? 'LONG' : 'SHORT';
}

/// A setup condition as the signal engine reported it ("Price above EMA 20": satisfied).
class CheSetupCondition {
  const CheSetupCondition(this.name, this.status);
  final String name;

  /// satisfied, pending or failed.
  final String status;

  Map<String, Object?> toJson() => {'name': name, 'status': status};
  factory CheSetupCondition.fromJson(Map<String, dynamic> j) => CheSetupCondition('${j['name'] ?? ''}', '${j['status'] ?? 'pending'}');
}

/// What the paper engine needs from a trade signal. The signals lane (che_trade_signal.dart) adapts
/// its signal to this; until then tests supply it directly.
class ChePaperSignal {
  const ChePaperSignal({
    required this.id,
    required this.symbol,
    required this.side,
    required this.entry,
    required this.stop,
    required this.target,
    required this.strategy,
    required this.timeframe,
    required this.stage,
    required this.detectedAt,
    required this.dataSource,
    this.conditions = const [],
    this.evidence = '',
  });

  final String id, symbol, strategy, timeframe, dataSource, evidence;
  final CheSide side;
  final double entry, stop, target;

  /// WATCHING … READY, TRIGGERED … (lowercase). Only ready or triggered may open a paper trade.
  final String stage;
  final DateTime detectedAt;
  final List<CheSetupCondition> conditions;

  bool get tradable => stage == 'ready' || stage == 'triggered';

  Map<String, Object?> toJson() => {
        'id': id, 'symbol': symbol, 'side': side.name, 'entry': entry, 'stop': stop, 'target': target, 'strategy': strategy,
        'timeframe': timeframe, 'stage': stage, 'detected_at': detectedAt.toUtc().toIso8601String(), 'data_source': dataSource,
        'conditions': [for (final c in conditions) c.toJson()], 'evidence': evidence,
      };
  factory ChePaperSignal.fromJson(Map<String, dynamic> j) => ChePaperSignal(
        id: '${j['id']}', symbol: '${j['symbol']}', side: j['side'] == 'short' ? CheSide.short : CheSide.long,
        entry: _d(j['entry'])!, stop: _d(j['stop'])!, target: _d(j['target'])!, strategy: '${j['strategy'] ?? ''}',
        timeframe: '${j['timeframe'] ?? ''}', stage: '${j['stage'] ?? ''}', detectedAt: DateTime.parse('${j['detected_at']}'),
        dataSource: '${j['data_source'] ?? ''}',
        conditions: [for (final c in (j['conditions'] as List? ?? const [])) CheSetupCondition.fromJson(Map<String, dynamic>.from(c as Map))],
        evidence: '${j['evidence'] ?? ''}',
      );
}

/// deposit, withdrawal, reset (new starting balance, new drawdown period) or simulation setting
/// (the account size changed for the simulation: the difference is applied, starting balance kept).
enum CheBalanceChangeType { initial, deposit, withdrawal, reset, simulationSetting }

extension CheBalanceChangeTypeX on CheBalanceChangeType {
  String get label => switch (this) {
        CheBalanceChangeType.initial => 'Opening balance',
        CheBalanceChangeType.deposit => 'Deposit',
        CheBalanceChangeType.withdrawal => 'Withdrawal',
        CheBalanceChangeType.reset => 'Reset',
        CheBalanceChangeType.simulationSetting => 'Simulation setting',
      };
}

class CheBalanceChange {
  const CheBalanceChange({required this.seq, required this.type, required this.previous, required this.next, required this.at, this.reason = ''});
  final int seq;
  final CheBalanceChangeType type;
  final double previous, next;
  final DateTime at;
  final String reason;

  double get delta => next - previous;

  Map<String, Object?> toJson() =>
      {'seq': seq, 'type': type.name, 'previous': previous, 'next': next, 'at': at.toUtc().toIso8601String(), 'reason': reason};
  factory CheBalanceChange.fromJson(Map<String, dynamic> j) => CheBalanceChange(
        seq: (j['seq'] as num).toInt(),
        type: CheBalanceChangeType.values.firstWhere((t) => t.name == j['type'], orElse: () => CheBalanceChangeType.simulationSetting),
        previous: _d(j['previous'])!, next: _d(j['next'])!, at: DateTime.parse('${j['at']}'), reason: '${j['reason'] ?? ''}',
      );
}

/// A change CHE made to an open trade (stop or target moved), with its reason.
class CheTradeAdjustment {
  const CheTradeAdjustment({required this.at, required this.field, required this.from, required this.to, required this.reason});
  final DateTime at;
  final String field;
  final double from, to;
  final String reason;

  Map<String, Object?> toJson() => {'at': at.toUtc().toIso8601String(), 'field': field, 'from': from, 'to': to, 'reason': reason};
  factory CheTradeAdjustment.fromJson(Map<String, dynamic> j) => CheTradeAdjustment(
      at: DateTime.parse('${j['at']}'), field: '${j['field']}', from: _d(j['from'])!, to: _d(j['to'])!, reason: '${j['reason'] ?? ''}');
}

class CheJournalEntry {
  const CheJournalEntry({required this.at, required this.positionId, required this.kind, required this.text});
  final DateTime at;
  final String positionId;

  /// opened, adjusted, remains_open, closed or skipped.
  final String kind;
  final String text;

  Map<String, Object?> toJson() => {'at': at.toUtc().toIso8601String(), 'position_id': positionId, 'kind': kind, 'text': text};
  factory CheJournalEntry.fromJson(Map<String, dynamic> j) =>
      CheJournalEntry(at: DateTime.parse('${j['at']}'), positionId: '${j['position_id'] ?? ''}', kind: '${j['kind']}', text: '${j['text']}');
}

/// A sampled traded price while a position is open (at most one every few seconds), so the detail
/// view can draw the real price path with entry, stop and target lines.
class ChePricePoint {
  const ChePricePoint(this.time, this.price);
  final DateTime time;
  final double price;
  Map<String, Object?> toJson() => {'t': time.toUtc().toIso8601String(), 'p': price};
  factory ChePricePoint.fromJson(Map<String, dynamic> j) => ChePricePoint(DateTime.parse('${j['t']}'), _d(j['p'])!);
}

enum ChePositionStatus { pendingEntry, open, targetHit, stopped, closed, cancelled }

extension ChePositionStatusX on ChePositionStatus {
  String get label => switch (this) {
        ChePositionStatus.pendingEntry => 'Waiting for fill',
        ChePositionStatus.open => 'Open',
        ChePositionStatus.targetHit => 'Target hit',
        ChePositionStatus.stopped => 'Stopped out',
        ChePositionStatus.closed => 'Closed',
        ChePositionStatus.cancelled => 'Cancelled',
      };
  bool get isOpen => this == ChePositionStatus.open || this == ChePositionStatus.pendingEntry;
}

/// One CHE paper position from signal to close. Prices: `entryRaw` is the traded price the fill
/// used, `entryFill` adds the half spread and slippage against CHE (never a better price than traded).
class ChePaperPosition {
  ChePaperPosition({
    required this.id,
    required this.signal,
    required this.contract,
    required this.qty,
    required this.stop,
    required this.target,
    required this.createdAt,
    required this.costs,
    required this.riskDollars,
    required this.rewardDollars,
    required this.riskPctOfEquity,
    this.status = ChePositionStatus.pendingEntry,
    this.entryRaw,
    this.entryFill,
    this.entryAt,
    this.exitRaw,
    this.exitFill,
    this.exitAt,
    this.exitReason,
    this.lastPrice,
    this.lastPriceAt,
    this.netPnl,
    this.grossPnl,
    this.costDollars,
    List<CheTradeAdjustment>? adjustments,
    List<ChePricePoint>? path,
    this.riskAlerted = false,
    this.period,
  })  : adjustments = adjustments ?? [],
        path = path ?? [];

  final String id;
  final ChePaperSignal signal;
  final CheContractSpec contract;
  final int qty;
  double stop, target;
  final DateTime createdAt;
  final CheCostModel costs;
  final double riskDollars, rewardDollars, riskPctOfEquity;
  ChePositionStatus status;
  double? entryRaw, entryFill, exitRaw, exitFill, lastPrice, netPnl, grossPnl, costDollars;
  DateTime? entryAt, exitAt, lastPriceAt;
  String? exitReason;
  final List<CheTradeAdjustment> adjustments;
  final List<ChePricePoint> path;
  bool riskAlerted;

  /// The balance period (the seq of the opening balance or reset) the trade closed in; a reset
  /// starts a new period without touching earlier trades.
  int? period;

  CheSide get side => signal.side;
  String get symbol => signal.symbol;

  /// Planned entry until filled, then the fill.
  double get entry => entryFill ?? signal.entry;

  double get _perPoint => contract.pointValue * qty;

  /// Commissions and fees for both sides (the spread and slippage are already in the fill prices).
  double get roundTripFees => 2 * (costs.commissionPerSide + costs.feePerSide) * qty;

  double? get unrealizedPnl {
    if (status != ChePositionStatus.open || entryFill == null || lastPrice == null) return null;
    // Marked at the last traded price less the exit's half spread, and the fees still to pay.
    final exitMark = lastPrice! - side.sign * costs.spreadTicks / 2 * contract.tick;
    return _r2((exitMark - entryFill!) * side.sign * _perPoint - roundTripFees);
  }

  /// Dollars still at risk if the stop is hit from here (0 once the stop locks in a gain).
  double get openRiskDollars {
    if (!status.isOpen) return 0;
    final from = entry;
    final loss = (from - stop) * side.sign * _perPoint + roundTripFees + costs.slippageTicks * contract.tick * _perPoint;
    return loss > 0 ? _r2(loss) : 0;
  }

  double? get distanceToStopPoints => lastPrice == null ? null : _r2((lastPrice! - stop) * side.sign);
  double? get distanceToTargetPoints => lastPrice == null ? null : _r2((target - lastPrice!) * side.sign);

  /// 0..1 of the way from entry to target (0 when at or behind entry).
  double? get progressToTarget {
    if (lastPrice == null) return null;
    final span = (target - entry) * side.sign;
    if (span <= 0) return null;
    return (((lastPrice! - entry) * side.sign) / span).clamp(0.0, 1.0);
  }

  /// 0..1 of the way from entry to the stop (invalidation).
  double? get progressToStop {
    if (lastPrice == null) return null;
    final span = (entry - stop) * side.sign;
    if (span <= 0) return null;
    return (((entry - lastPrice!) * side.sign) / span).clamp(0.0, 1.0);
  }

  /// Current move in R (risk units of the original stop distance).
  double? get currentR {
    if (lastPrice == null || entryFill == null) return null;
    final risk = (signal.entry - signal.stop).abs();
    if (risk == 0) return null;
    return _r2((lastPrice! - entryFill!) * side.sign / risk);
  }

  double get plannedRewardRisk {
    final risk = (signal.entry - signal.stop).abs();
    return risk == 0 ? 0 : _r2((signal.target - signal.entry).abs() / risk);
  }

  Duration? age(DateTime now) => entryAt == null ? null : now.difference(entryAt!);

  Map<String, Object?> toJson() => {
        'id': id, 'signal': signal.toJson(), 'contract': contract.root, 'qty': qty, 'stop': stop, 'target': target,
        'created_at': createdAt.toUtc().toIso8601String(), 'costs': costs.toJson(), 'risk_dollars': riskDollars,
        'reward_dollars': rewardDollars, 'risk_pct_of_equity': riskPctOfEquity, 'status': status.name, 'entry_raw': entryRaw,
        'entry_fill': entryFill, 'entry_at': entryAt?.toUtc().toIso8601String(), 'exit_raw': exitRaw, 'exit_fill': exitFill,
        'exit_at': exitAt?.toUtc().toIso8601String(), 'exit_reason': exitReason, 'last_price': lastPrice,
        'last_price_at': lastPriceAt?.toUtc().toIso8601String(), 'net_pnl': netPnl, 'gross_pnl': grossPnl, 'cost_dollars': costDollars,
        'adjustments': [for (final a in adjustments) a.toJson()], 'path': [for (final p in path) p.toJson()], 'risk_alerted': riskAlerted,
        'period': period,
        'label': kChePaperLabel,
      };

  factory ChePaperPosition.fromJson(Map<String, dynamic> j) => ChePaperPosition(
        id: '${j['id']}',
        signal: ChePaperSignal.fromJson(Map<String, dynamic>.from(j['signal'] as Map)),
        contract: CheContractSpec.forSymbol('${j['contract']}') ?? CheContractSpec.mnq,
        qty: (j['qty'] as num).toInt(),
        stop: _d(j['stop'])!,
        target: _d(j['target'])!,
        createdAt: DateTime.parse('${j['created_at']}'),
        costs: CheCostModel.fromJson(Map<String, dynamic>.from((j['costs'] as Map?) ?? const {})),
        riskDollars: _d(j['risk_dollars']) ?? 0,
        rewardDollars: _d(j['reward_dollars']) ?? 0,
        riskPctOfEquity: _d(j['risk_pct_of_equity']) ?? 0,
        status: ChePositionStatus.values.firstWhere((s) => s.name == j['status'], orElse: () => ChePositionStatus.closed),
        entryRaw: _d(j['entry_raw']), entryFill: _d(j['entry_fill']), entryAt: _t(j['entry_at']),
        exitRaw: _d(j['exit_raw']), exitFill: _d(j['exit_fill']), exitAt: _t(j['exit_at']), exitReason: j['exit_reason'] as String?,
        lastPrice: _d(j['last_price']), lastPriceAt: _t(j['last_price_at']),
        netPnl: _d(j['net_pnl']), grossPnl: _d(j['gross_pnl']), costDollars: _d(j['cost_dollars']),
        adjustments: [for (final a in (j['adjustments'] as List? ?? const [])) CheTradeAdjustment.fromJson(Map<String, dynamic>.from(a as Map))],
        path: [for (final p in (j['path'] as List? ?? const [])) ChePricePoint.fromJson(Map<String, dynamic>.from(p as Map))],
        riskAlerted: j['risk_alerted'] == true,
        period: (j['period'] as num?)?.toInt(),
      );
}

/// Limits the risk engine enforces. A trade whose stop risk breaks one is skipped, never resized
/// by moving the stop.
class ChePaperRiskLimits {
  const ChePaperRiskLimits({this.maxRiskPerTradePct = 25, this.maxOpenRiskPct = 50, this.maxDailyLossPct = 50, this.maxContracts = 1, this.maxOpenPositions = 3});
  final double maxRiskPerTradePct, maxOpenRiskPct, maxDailyLossPct;
  final int maxContracts, maxOpenPositions;

  Map<String, Object?> toJson() => {
        'max_risk_per_trade_pct': maxRiskPerTradePct, 'max_open_risk_pct': maxOpenRiskPct, 'max_daily_loss_pct': maxDailyLossPct,
        'max_contracts': maxContracts, 'max_open_positions': maxOpenPositions,
      };
  factory ChePaperRiskLimits.fromJson(Map<String, dynamic> j) => ChePaperRiskLimits(
        maxRiskPerTradePct: _d(j['max_risk_per_trade_pct']) ?? 25,
        maxOpenRiskPct: _d(j['max_open_risk_pct']) ?? 50,
        maxDailyLossPct: _d(j['max_daily_loss_pct']) ?? 50,
        maxContracts: (j['max_contracts'] as num?)?.toInt() ?? 1,
        maxOpenPositions: (j['max_open_positions'] as num?)?.toInt() ?? 3,
      );
}

/// A point on the equity line: after a fill, a close or a balance change.
class CheEquityPoint {
  const CheEquityPoint(this.at, this.equity, this.reason);
  final DateTime at;
  final double equity;
  final String reason;
  Map<String, Object?> toJson() => {'at': at.toUtc().toIso8601String(), 'equity': equity, 'reason': reason};
  factory CheEquityPoint.fromJson(Map<String, dynamic> j) => CheEquityPoint(DateTime.parse('${j['at']}'), _d(j['equity'])!, '${j['reason'] ?? ''}');
}

/// One append-only audit record: paper orders, fills, position changes, balance changes, skips.
class ChePaperAuditEvent {
  const ChePaperAuditEvent({required this.seq, required this.at, required this.kind, required this.detail});
  final int seq;
  final DateTime at;
  final String kind;
  final Map<String, Object?> detail;
  Map<String, Object?> toJson() => {'seq': seq, 'at': at.toUtc().toIso8601String(), 'kind': kind, 'account': kChePaperLabel, 'detail': detail};
  factory ChePaperAuditEvent.fromJson(Map<String, dynamic> j) => ChePaperAuditEvent(
      seq: (j['seq'] as num).toInt(), at: DateTime.parse('${j['at']}'), kind: '${j['kind']}', detail: Map<String, Object?>.from((j['detail'] as Map?) ?? const {}));
}

/// The account figures, all derived from the records (nothing stored here can drift from them).
class ChePaperSnapshot {
  const ChePaperSnapshot({
    required this.balance,
    required this.startingBalance,
    required this.netDeposits,
    required this.realizedPnl,
    required this.realizedToday,
    required this.unrealizedPnl,
    required this.openRisk,
    required this.equity,
    required this.available,
    required this.peakEquity,
    required this.drawdown,
    required this.drawdownPct,
    required this.maxDrawdown,
    required this.openPositions,
    required this.wins,
    required this.losses,
    required this.avgWin,
    required this.avgLoss,
  });

  final double balance, startingBalance, netDeposits, realizedPnl, realizedToday, unrealizedPnl, openRisk, equity, available;
  final double peakEquity, drawdown, drawdownPct, maxDrawdown, avgWin, avgLoss;
  final int openPositions, wins, losses;

  int get closedTrades => wins + losses;
  double? get winRate => closedTrades == 0 ? null : wins / closedTrades;
  double get totalRiskPct => equity <= 0 ? 0 : openRisk / equity * 100;
}

double? _d(Object? v) => v is num ? v.toDouble() : (v is String ? double.tryParse(v) : null);
DateTime? _t(Object? v) => v == null ? null : DateTime.tryParse('$v');
double _r2(double x) => (x * 100).roundToDouble() / 100;
double cheRound2(double x) => _r2(x);
