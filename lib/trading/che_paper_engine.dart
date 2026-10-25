// The CHE PAPER ACCOUNT engine: opens simulated trades from READY or TRIGGERED setups, fills them
// at real Rithmic traded prices, manages stops and targets, and keeps the account, the journal and
// the audit. Simulated only: nothing here can reach a broker, and every record is labelled
// CHE PAPER ACCOUNT.
//
// Fill rules (conservative, so paper results are not better than a real fill would be):
// - Entry is a market order filled at the first Rithmic trade after the order, plus half the spread
//   and the slippage against CHE. It is never filled at a better price than was traded.
// - A stop exit is a market order at the first trade at or through the stop, again with the half
//   spread and slippage against CHE (a gap through the stop fills at the gap price, not the stop).
// - A target is a resting limit: it fills at the target only once price trades one tick through it.
// - Commissions and fees are charged per side per contract (CheCostModel, trading_evidence.js COSTS).
//
// The risk engine never shrinks a stop to fit the account. A setup whose stop risk breaks a limit
// is skipped, and the skip is journaled with its reason ("skipped: risk exceeds balance").
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'che_market_feed.dart';
import 'che_paper_account.dart';

/// Where the account lives: one state file plus an append-only audit log. Tests use the memory store.
abstract class ChePaperStore {
  Future<Map<String, dynamic>?> readState();
  Future<void> writeState(Map<String, dynamic> state);
  Future<void> appendAudit(Map<String, Object?> event);
  Future<List<Map<String, dynamic>>> readAudit();
}

class ChePaperMemoryStore implements ChePaperStore {
  Map<String, dynamic>? state;
  final audit = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>?> readState() async => state == null ? null : jsonDecode(jsonEncode(state)) as Map<String, dynamic>;
  @override
  Future<void> writeState(Map<String, dynamic> s) async => state = jsonDecode(jsonEncode(s)) as Map<String, dynamic>;
  @override
  Future<void> appendAudit(Map<String, Object?> e) async => audit.add(jsonDecode(jsonEncode(e)) as Map<String, dynamic>);
  @override
  Future<List<Map<String, dynamic>>> readAudit() async => List.of(audit);
}

/// On the phone: Application Support/che_paper_account/{state.json, audit.jsonl}. The audit file is
/// only ever appended to.
class ChePaperFileStore implements ChePaperStore {
  ChePaperFileStore([this._dir]);
  Directory? _dir;

  Future<Directory> _root() async {
    final d = _dir ??= Directory('${(await getApplicationSupportDirectory()).path}/che_paper_account');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  @override
  Future<Map<String, dynamic>?> readState() async {
    final f = File('${(await _root()).path}/state.json');
    if (!await f.exists()) return null;
    return jsonDecode(await f.readAsString()) as Map<String, dynamic>;
  }

  @override
  Future<void> writeState(Map<String, dynamic> state) async {
    final dir = await _root();
    // Written beside, then renamed over, so a crash never leaves half a file.
    final tmp = File('${dir.path}/state.json.tmp');
    await tmp.writeAsString(jsonEncode(state), flush: true);
    await tmp.rename('${dir.path}/state.json');
  }

  @override
  Future<void> appendAudit(Map<String, Object?> event) async {
    final f = File('${(await _root()).path}/audit.jsonl');
    await f.writeAsString('${jsonEncode(event)}\n', mode: FileMode.append, flush: true);
  }

  @override
  Future<List<Map<String, dynamic>>> readAudit() async {
    final f = File('${(await _root()).path}/audit.jsonl');
    if (!await f.exists()) return [];
    return [
      for (final line in await f.readAsLines())
        if (line.trim().isNotEmpty) jsonDecode(line) as Map<String, dynamic>,
    ];
  }
}

/// An account alert. The alerts lane (che_trade_alerts.dart) decides whether it is shown and heard.
class ChePaperAlert {
  const ChePaperAlert({required this.kind, required this.title, required this.message, required this.at, this.positionId});

  /// paper_trade_opened, stop_adjusted, target_adjusted, target_hit, stop_hit, approaching_stop,
  /// daily_loss_threshold, daily_loss_limit, drawdown_threshold, balance_changed, trade_skipped.
  final String kind, title, message;
  final DateTime at;
  final String? positionId;
}

/// What happened to a signal handed to the engine.
class ChePaperDecision {
  const ChePaperDecision(this.accepted, this.reason, {this.position});
  final bool accepted;
  final String reason;
  final ChePaperPosition? position;
}

class ChePaperEngine extends ChangeNotifier {
  ChePaperEngine._(this._store, this._clock);

  final ChePaperStore _store;
  final DateTime Function() _clock;
  final _alerts = StreamController<ChePaperAlert>.broadcast(sync: true);

  final List<CheBalanceChange> _balance = [];
  final List<ChePaperPosition> _positions = [];
  final List<CheJournalEntry> _journal = [];
  final List<CheEquityPoint> _equity = [];
  final Set<String> _thresholdAlerts = {};
  ChePaperRiskLimits _limits = const ChePaperRiskLimits();
  CheCostModel _costs = CheCostModel.standard;
  int _auditSeq = 0;
  int _ignoredTicks = 0;
  String _lastTickKey = '';
  Future<void> _writes = Future.value();

  /// No live trade for longer than this, while a CHE paper trade is open or waiting, is a feed gap.
  final Duration gapThreshold = const Duration(seconds: 90);
  final Map<String, DateTime> _lastSeen = {};

  /// The phone's account, loaded once.
  static Future<ChePaperEngine>? _shared;
  static Future<ChePaperEngine> shared() => _shared ??= load(ChePaperFileStore());

  /// After a failed load, so the next open tries again.
  static void forgetShared() => _shared = null;

  /// Widget tests hand the room an in-memory account instead of the phone's file.
  @visibleForTesting
  static set sharedForTest(Future<ChePaperEngine>? engine) => _shared = engine;

  static Future<ChePaperEngine> load(ChePaperStore store, {DateTime Function()? clock}) async {
    final e = ChePaperEngine._(store, clock ?? DateTime.now);
    final s = await store.readState();
    final audit = await store.readAudit();
    e._auditSeq = audit.isEmpty ? 0 : audit.map((a) => (a['seq'] as num?)?.toInt() ?? 0).reduce((a, b) => a > b ? a : b);
    if (s != null) {
      e._balance.addAll([for (final b in s['balance_history'] as List? ?? const []) CheBalanceChange.fromJson(Map<String, dynamic>.from(b as Map))]);
      e._positions.addAll([for (final p in s['positions'] as List? ?? const []) ChePaperPosition.fromJson(Map<String, dynamic>.from(p as Map))]);
      e._journal.addAll([for (final j in s['journal'] as List? ?? const []) CheJournalEntry.fromJson(Map<String, dynamic>.from(j as Map))]);
      e._equity.addAll([for (final q in s['equity'] as List? ?? const []) CheEquityPoint.fromJson(Map<String, dynamic>.from(q as Map))]);
      e._thresholdAlerts.addAll([for (final k in s['threshold_alerts'] as List? ?? const []) '$k']);
      if (s['limits'] is Map) e._limits = ChePaperRiskLimits.fromJson(Map<String, dynamic>.from(s['limits'] as Map));
      if (s['costs'] is Map) e._costs = CheCostModel.fromJson(Map<String, dynamic>.from(s['costs'] as Map));
    }
    if (e._balance.isEmpty) {
      final now = e._clock();
      e._balance.add(CheBalanceChange(seq: 1, type: CheBalanceChangeType.initial, previous: 0, next: kChePaperDefaultBalance, at: now, reason: 'Default CHE paper balance'));
      e._equity.add(CheEquityPoint(now, kChePaperDefaultBalance, 'Opening balance'));
      e._audit('balance_change', e._balance.first.toJson());
      e._save();
    }
    return e;
  }

  Stream<ChePaperAlert> get alerts => _alerts.stream;
  List<CheBalanceChange> get balanceHistory => List.unmodifiable(_balance);
  List<ChePaperPosition> get positions => List.unmodifiable(_positions);
  List<ChePaperPosition> get openPositions => List.unmodifiable(_positions.where((p) => p.status.isOpen));
  List<ChePaperPosition> get closedPositions => List.unmodifiable(_positions.where((p) => !p.status.isOpen));
  List<CheJournalEntry> get journal => List.unmodifiable(_journal);
  List<CheEquityPoint> get equityPoints => List.unmodifiable(_equity);
  ChePaperRiskLimits get limits => _limits;
  CheCostModel get costs => _costs;

  /// Prices refused because they were not live Rithmic trades (delayed or unknown source).
  int get ignoredTicks => _ignoredTicks;

  ChePaperPosition? position(String id) => _positions.where((p) => p.id == id).firstOrNull;

  // ---------------------------------------------------------------- the account figures

  CheBalanceChange get _period => _balance.lastWhere((b) => b.type == CheBalanceChangeType.initial || b.type == CheBalanceChangeType.reset);

  ChePaperSnapshot snapshot() {
    final now = _clock();
    final period = _period;
    final cashChanges = _balance.fold<double>(0, (a, b) => a + b.delta);
    final realizedAll = _positions.fold<double>(0, (a, p) => a + (p.netPnl ?? 0));
    final balance = cheRound2(cashChanges + realizedAll);
    final netDeposits = _balance
        .where((b) => b.seq > period.seq && (b.type == CheBalanceChangeType.deposit || b.type == CheBalanceChangeType.withdrawal || b.type == CheBalanceChangeType.simulationSetting))
        .fold<double>(0, (a, b) => a + b.delta);
    final closed = _positions.where((p) => p.netPnl != null && p.period == period.seq).toList()..sort((a, b) => a.exitAt!.compareTo(b.exitAt!));
    final realized = closed.fold<double>(0, (a, p) => a + p.netPnl!);
    final today = DateTime(now.year, now.month, now.day);
    final realizedToday = closed.where((p) => !p.exitAt!.toLocal().isBefore(today)).fold<double>(0, (a, p) => a + p.netPnl!);
    final open = _positions.where((p) => p.status.isOpen).toList();
    final unrealized = open.fold<double>(0, (a, p) => a + (p.unrealizedPnl ?? 0));
    final openRisk = open.fold<double>(0, (a, p) => a + p.openRiskDollars);
    final equity = balance + unrealized;
    // Drawdown on trading results only (deposits and withdrawals are not gains or losses).
    var cum = 0.0, peak = 0.0, maxDd = 0.0;
    for (final p in closed) {
      cum += p.netPnl!;
      if (cum > peak) peak = cum;
      if (peak - cum > maxDd) maxDd = peak - cum;
    }
    final current = cum + unrealized;
    final dd = (peak - current) > 0 ? peak - current : 0.0;
    if (dd > maxDd) maxDd = dd;
    final base = period.next + netDeposits + peak;
    final wins = closed.where((p) => p.netPnl! > 0).toList();
    final losses = closed.where((p) => p.netPnl! <= 0).toList();
    return ChePaperSnapshot(
      balance: balance,
      startingBalance: period.next,
      netDeposits: cheRound2(netDeposits),
      realizedPnl: cheRound2(realized),
      realizedToday: cheRound2(realizedToday),
      unrealizedPnl: cheRound2(unrealized),
      openRisk: cheRound2(openRisk),
      equity: cheRound2(equity),
      available: cheRound2(equity - openRisk),
      peakEquity: cheRound2(period.next + netDeposits + peak),
      drawdown: cheRound2(dd),
      drawdownPct: base <= 0 ? 0 : cheRound2(dd / base * 100),
      maxDrawdown: cheRound2(maxDd),
      openPositions: open.length,
      wins: wins.length,
      losses: losses.length,
      avgWin: wins.isEmpty ? 0 : cheRound2(wins.fold<double>(0, (a, p) => a + p.netPnl!) / wins.length),
      avgLoss: losses.isEmpty ? 0 : cheRound2(losses.fold<double>(0, (a, p) => a + p.netPnl!) / losses.length),
    );
  }

  // ---------------------------------------------------------------- signals → paper orders

  /// Dollars lost on one contract if the stop is hit: the stop distance, both sides' fees, the
  /// spread and the slippage on entry and on the stop exit.
  double riskPerContract(CheContractSpec c, double entry, double stop) =>
      cheRound2((entry - stop).abs() * c.pointValue + 2 * (_costs.commissionPerSide + _costs.feePerSide) + (_costs.spreadTicks + 2 * _costs.slippageTicks) * c.tick * c.pointValue);

  /// A READY or TRIGGERED setup becomes a paper market order, if the account's limits allow it.
  ChePaperDecision onSignal(ChePaperSignal s) {
    if (!s.tradable) return ChePaperDecision(false, 'Setup is ${s.stage}, not ready or triggered.');
    if (_positions.any((p) => p.signal.id == s.id)) return const ChePaperDecision(false, 'This setup already has a paper trade.');
    String? why;
    final c = CheContractSpec.forSymbol(s.symbol);
    final valid = s.side == CheSide.long ? s.stop < s.entry && s.entry < s.target : s.stop > s.entry && s.entry > s.target;
    final snap = snapshot();
    final open = _positions.where((p) => p.status.isOpen).length;
    final dailyLimit = (snap.startingBalance + snap.netDeposits) * _limits.maxDailyLossPct / 100;
    if (s.dataSource != 'rithmic') {
      why = 'skipped: the setup was not built from verified Rithmic data (${s.dataSource.isEmpty ? 'unknown source' : s.dataSource})';
    } else if (c == null) {
      why = 'skipped: ${s.symbol} is not a contract CHE paper-trades (MNQ or NQ)';
    } else if (!valid) {
      why = 'skipped: stop ${s.stop}, entry ${s.entry} and target ${s.target} are not in order for a ${s.side.label}';
    } else if (-snap.realizedToday >= dailyLimit) {
      why = 'skipped: the daily loss limit (\$${dailyLimit.toStringAsFixed(2)}) is reached; no new paper trades today';
    } else if (open >= _limits.maxOpenPositions) {
      why = 'skipped: ${_limits.maxOpenPositions} paper positions are already open';
    }
    var qty = 0;
    var perContract = 0.0;
    if (why == null) {
      perContract = riskPerContract(c!, s.entry, s.stop);
      final perTradeCap = snap.equity * _limits.maxRiskPerTradePct / 100;
      final openRiskCap = snap.equity * _limits.maxOpenRiskPct / 100 - snap.openRisk;
      if (perContract > snap.available) {
        why = 'skipped: risk exceeds balance — one ${c.root} contract risks \$${perContract.toStringAsFixed(2)} at this stop, the CHE paper account has \$${snap.available.toStringAsFixed(2)} available';
      } else if (perContract > perTradeCap) {
        why = 'skipped: risk exceeds limit — one ${c.root} contract risks \$${perContract.toStringAsFixed(2)}, more than the ${_pct(_limits.maxRiskPerTradePct)} per-trade limit (\$${perTradeCap.toStringAsFixed(2)}); the stop was not moved to fit';
      } else if (perContract > openRiskCap) {
        why = 'skipped: risk exceeds limit — total open risk would pass ${_pct(_limits.maxOpenRiskPct)} of equity';
      } else {
        qty = [_limits.maxContracts, (perTradeCap / perContract).floor(), (openRiskCap / perContract).floor()].reduce((a, b) => a < b ? a : b);
      }
    }
    final now = _clock();
    if (why != null || qty < 1) {
      final reason = why ?? 'skipped: no whole contract fits the risk limits';
      _journal.add(CheJournalEntry(at: now, positionId: '', kind: 'skipped', text: '${s.strategy} ${s.timeframe} ${s.side.label} ${s.symbol}: $reason.'));
      _audit('signal_skipped', {'signal': s.toJson(), 'reason': reason});
      _alert('trade_skipped', 'CHE paper trade skipped', '${s.strategy} on ${s.symbol}: $reason.', now);
      _changed();
      return ChePaperDecision(false, reason);
    }
    final pos = ChePaperPosition(
      id: 'pp-${now.microsecondsSinceEpoch}-${_positions.length + 1}',
      signal: s,
      contract: c!,
      qty: qty,
      stop: s.stop,
      target: s.target,
      createdAt: now,
      costs: _costs,
      riskDollars: cheRound2(perContract * qty),
      rewardDollars: cheRound2((s.target - s.entry).abs() * c.pointValue * qty - 2 * (_costs.commissionPerSide + _costs.feePerSide) * qty),
      riskPctOfEquity: snap.equity <= 0 ? 0 : cheRound2(perContract * qty / snap.equity * 100),
    );
    _positions.add(pos);
    _audit('paper_order', {
      'position_id': pos.id, 'type': 'market', 'side': s.side.label, 'qty': qty, 'symbol': s.symbol, 'planned_entry': s.entry,
      'stop': s.stop, 'target': s.target, 'risk_dollars': pos.riskDollars, 'simulated': true,
    });
    _changed();
    return ChePaperDecision(true, 'Paper market order for $qty ${c.root} placed; it fills at the next Rithmic trade.', position: pos);
  }

  // ---------------------------------------------------------------- prices

  /// The app-wide feed: every live Rithmic trade price reaches the engine.
  StreamSubscription<CheMarketSnapshot> attach(CheMarketFeed feed) => feed.snapshots.listen((m) {
        final t = tickFrom(m);
        if (t != null) onTick(t);
      });

  /// A feed snapshot as a traded price. Only a live Rithmic session counts as 'rithmic'; a price
  /// recorded earlier on this phone, or no feed, can never fill a paper order.
  static ChePriceTick? tickFrom(CheMarketSnapshot m) {
    if (m.lastPrice == null || m.lastTradeAt == null) return null;
    return ChePriceTick(symbol: m.symbol, price: m.lastPrice!, time: m.lastTradeAt!, source: m.isLive && m.source == 'rithmic' ? 'rithmic' : 'recorded');
  }

  void onTick(ChePriceTick t) {
    if (!t.isRithmic) {
      _ignoredTicks++;
      return;
    }
    final key = '${t.symbol}|${t.time.microsecondsSinceEpoch}|${t.price}';
    if (key == _lastTickKey) return;
    _lastTickKey = key;
    final root = CheContractSpec.forSymbol(t.symbol)?.root;
    if (root == null) return;
    final seen = _lastSeen[root];
    _lastSeen[root] = t.time;
    var touched = false;
    for (final p in _positions) {
      if (!p.status.isOpen || p.contract.root != root) continue;
      // Only prices traded after the order existed.
      if (t.time.isBefore(p.createdAt)) continue;
      touched = true;
      // The last live price CHE saw for this trade: the later of the previous trade and the order itself.
      final since = seen == null || seen.isBefore(p.createdAt) ? p.createdAt : seen;
      if (t.time.difference(since) > gapThreshold) {
        _reconcileGap(p, since, t);
        continue;
      }
      if (p.status == ChePositionStatus.pendingEntry) {
        _fillEntry(p, t);
      } else {
        _mark(p, t);
      }
    }
    if (touched) _changed();
  }

  /// Live prices stopped (app in the background, feed dropped) and came back. CHE never marks a stop,
  /// target or fill on prices it did not see: a waiting order is cancelled, an open trade whose
  /// resume price is beyond its stop or target becomes unresolved (no result), and one still inside
  /// keeps going with the gap recorded on it.
  void _reconcileGap(ChePaperPosition p, DateTime from, ChePriceTick t) {
    final gap = CheFeedGap(from, t.time, t.price);
    final window = '${_hm(from)}–${_hm(t.time)}';
    if (p.status == ChePositionStatus.pendingEntry) {
      p
        ..status = ChePositionStatus.cancelled
        ..exitAt = t.time
        ..exitReason = 'feed gap $window before the order filled; the setup is stale';
      p.gaps.add(gap);
      _journal.add(CheJournalEntry(at: t.time, positionId: p.id, kind: 'closed', text: 'Paper order cancelled, not filled: feed gap $window; CHE does not fill on prices it never saw.'));
      _audit('feed_gap', {'position_id': p.id, ...gap.toJson(), 'outcome': 'order cancelled'});
      return;
    }
    p.gaps.add(gap);
    final beyondStop = (t.price - p.stop) * p.side.sign <= 0;
    final beyondTarget = (t.price - p.target) * p.side.sign >= 0;
    if (beyondStop || beyondTarget) {
      p
        ..status = ChePositionStatus.unresolved
        ..exitAt = t.time
        ..lastPrice = t.price
        ..lastPriceAt = t.time
        ..exitReason = 'feed gap $window; price came back at ${t.price}, beyond the ${beyondStop ? 'stop' : 'target'}. Whether and when the stop or target traded is unknown.';
      _journal.add(CheJournalEntry(at: t.time, positionId: p.id, kind: 'closed', text: 'Unresolved: ${p.exitReason} Not counted as a win or a loss.'));
      _audit('feed_gap', {'position_id': p.id, ...gap.toJson(), 'outcome': 'unresolved, no result'});
      _alert('feed_gap', 'CHE paper trade unresolved after a feed gap', '${p.contract.root} ${p.side.label}: feed gap $window; stop/target status unknown for that window. No result is recorded.', t.time, p.id);
      return;
    }
    _journal.add(CheJournalEntry(
        at: t.time, positionId: p.id, kind: 'remains_open', text: 'Feed gap $window; stop/target status unknown for that window. Price is back at ${t.price}, inside the stop and target, so the trade continues on live prices; its result will carry this gap.'));
    _audit('feed_gap', {'position_id': p.id, ...gap.toJson(), 'outcome': 'continues'});
    _alert('feed_gap', 'Feed gap on a CHE paper trade', '${p.contract.root} ${p.side.label}: feed gap $window; stop/target status unknown for that window.', t.time, p.id);
    _mark(p, t);
  }

  static String _hm(DateTime t) {
    final l = t.toLocal();
    return '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}';
  }

  static String _pct(double v) => '${v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(1)}%';

  double _adverse(ChePaperPosition p, {required bool entering}) {
    final ticks = p.costs.spreadTicks / 2 + p.costs.slippageTicks;
    // Buying pays up, selling receives less.
    final buying = entering ? p.side == CheSide.long : p.side == CheSide.short;
    return (buying ? 1 : -1) * ticks * p.contract.tick;
  }

  void _fillEntry(ChePaperPosition p, ChePriceTick t) {
    final through = (t.price - p.stop) * p.side.sign <= 0;
    final past = (t.price - p.target) * p.side.sign >= 0;
    if (through || past) {
      p.status = ChePositionStatus.cancelled;
      p.exitAt = t.time;
      p.exitReason = through ? 'price traded at or through the stop before the order could fill' : 'price traded at or past the target before the order could fill';
      _journal.add(CheJournalEntry(at: t.time, positionId: p.id, kind: 'closed', text: 'Paper order cancelled, not filled: ${p.exitReason} (Rithmic ${t.price}).'));
      _audit('paper_order_cancelled', {'position_id': p.id, 'price': t.price, 'reason': p.exitReason});
      return;
    }
    p
      ..entryRaw = t.price
      ..entryFill = cheRound2(t.price + _adverse(p, entering: true))
      ..entryAt = t.time
      ..status = ChePositionStatus.open
      ..lastPrice = t.price
      ..lastPriceAt = t.time;
    p.path.add(ChePricePoint(t.time, t.price));
    final s = p.signal;
    final met = s.conditions.where((c) => c.status == 'satisfied').map((c) => c.name).join('; ');
    _journal.add(CheJournalEntry(
      at: t.time,
      positionId: p.id,
      kind: 'opened',
      text: 'Opened ${s.side.label} ${p.qty} ${p.contract.root} (paper) at ${p.entryFill} — Rithmic traded ${t.price}, plus spread and slippage. '
          'Setup ${s.strategy} on ${s.timeframe}, stage ${s.stage}${met.isEmpty ? '' : '; conditions met: $met'}. '
          'Stop ${p.stop}, target ${p.target}, planned reward-to-risk ${p.plannedRewardRisk}. Risk \$${p.riskDollars} (${p.riskPctOfEquity}% of equity).',
    ));
    _audit('paper_fill', {'position_id': p.id, 'side': 'entry', 'traded': t.price, 'fill': p.entryFill, 'at': t.time.toUtc().toIso8601String(), 'source': 'rithmic', 'simulated': true});
    _equity.add(CheEquityPoint(t.time, snapshot().equity, 'Opened ${p.contract.root} ${s.side.label}'));
    _alert('paper_trade_opened', 'CHE opened a paper trade', '${s.side.label} ${p.qty} ${p.contract.root} at ${p.entryFill}, stop ${p.stop}, target ${p.target}. CHE PAPER ACCOUNT, simulated.', t.time, p.id);
  }

  void _mark(ChePaperPosition p, ChePriceTick t) {
    p
      ..lastPrice = t.price
      ..lastPriceAt = t.time;
    final gap = p.path.length >= 2000 ? const Duration(seconds: 60) : const Duration(seconds: 5);
    if (p.path.isEmpty || t.time.difference(p.path.last.time) >= gap) p.path.add(ChePricePoint(t.time, t.price));
    if ((t.price - p.stop) * p.side.sign <= 0) {
      _close(p, t, ChePositionStatus.stopped, 'stop', cheRound2(t.price + _adverse(p, entering: false)));
      return;
    }
    if ((t.price - p.target) * p.side.sign >= p.contract.tick) {
      _close(p, t, ChePositionStatus.targetHit, 'target', p.target);
      return;
    }
    final toStop = p.progressToStop ?? 0;
    if (toStop >= 0.75 && !p.riskAlerted) {
      p.riskAlerted = true;
      _audit('risk_warning', {'position_id': p.id, 'price': t.price, 'progress_to_stop': toStop});
      _alert('approaching_stop', 'CHE paper trade near its stop', '${p.contract.root} ${p.side.label} is ${(toStop * 100).round()}% of the way to its stop ${p.stop} (last ${t.price}).', t.time, p.id);
    }
  }

  void _close(ChePaperPosition p, ChePriceTick t, ChePositionStatus status, String reason, double fill) {
    final perPoint = p.contract.pointValue * p.qty;
    final gross = cheRound2((t.price - p.entryRaw!) * p.side.sign * perPoint);
    final net = cheRound2((fill - p.entryFill!) * p.side.sign * perPoint - p.roundTripFees);
    p
      ..exitRaw = t.price
      ..exitFill = fill
      ..exitAt = t.time
      ..exitReason = reason
      ..status = status
      ..grossPnl = gross
      ..netPnl = net
      ..costDollars = cheRound2(gross - net)
      ..period = _period.seq;
    final mins = t.time.difference(p.entryAt!).inMinutes;
    _journal.add(CheJournalEntry(
      at: t.time,
      positionId: p.id,
      kind: 'closed',
      text: '${reason == 'target' ? 'Target ${p.target} reached' : 'Stop ${p.stop} hit'} — Rithmic traded ${t.price}, paper exit $fill. '
          'Net \$${net.toStringAsFixed(2)} after \$${p.costDollars!.toStringAsFixed(2)} spread, slippage, commissions and fees; held $mins min.',
    ));
    _audit('paper_fill', {'position_id': p.id, 'side': 'exit', 'reason': reason, 'traded': t.price, 'fill': fill, 'net_pnl': net, 'at': t.time.toUtc().toIso8601String(), 'source': 'rithmic', 'simulated': true});
    final snap = snapshot();
    _equity.add(CheEquityPoint(t.time, snap.equity, '${reason == 'target' ? 'Target' : 'Stop'} ${p.contract.root} ${net >= 0 ? '+' : ''}${net.toStringAsFixed(2)}'));
    _alert(reason == 'target' ? 'target_hit' : 'stop_hit', reason == 'target' ? 'CHE paper trade hit its target' : 'CHE paper trade stopped out',
        '${p.contract.root} ${p.side.label}: net ${net >= 0 ? '+' : ''}\$${net.toStringAsFixed(2)}. CHE PAPER ACCOUNT, simulated.', t.time, p.id);
    _checkThresholds(snap, t.time);
  }

  void _checkThresholds(ChePaperSnapshot snap, DateTime at) {
    final day = '${at.toLocal().year}-${at.toLocal().month}-${at.toLocal().day}';
    final dailyLimit = (snap.startingBalance + snap.netDeposits) * _limits.maxDailyLossPct / 100;
    void once(String key, String kind, String title, String msg) {
      if (_thresholdAlerts.add(key)) {
        _audit('threshold', {'kind': kind, 'message': msg});
        _alert(kind, title, msg, at);
      }
    }

    if (dailyLimit > 0 && -snap.realizedToday >= dailyLimit) {
      once('$day:daily_limit', 'daily_loss_limit', 'CHE paper daily loss limit reached', 'Down \$${(-snap.realizedToday).toStringAsFixed(2)} today; no new paper trades until tomorrow.');
    } else if (dailyLimit > 0 && -snap.realizedToday >= dailyLimit * 0.75) {
      once('$day:daily_75', 'daily_loss_threshold', 'CHE paper daily loss at 75% of limit', 'Down \$${(-snap.realizedToday).toStringAsFixed(2)} of the \$${dailyLimit.toStringAsFixed(2)} daily limit.');
    }
    if (snap.drawdownPct >= 25) {
      once('${_period.seq}:dd25', 'drawdown_threshold', 'CHE paper drawdown passed 25%', 'Drawdown \$${snap.drawdown.toStringAsFixed(2)} (${snap.drawdownPct}%) from the peak.');
    }
  }

  // ---------------------------------------------------------------- changes to open trades

  /// CHE moves a stop or target on an open paper trade; the change and its reason are kept.
  String? adjust(String id, {double? stop, double? target, required String reason}) {
    final p = position(id);
    if (p == null || p.status != ChePositionStatus.open) return 'No open CHE paper trade with that id.';
    final newStop = stop ?? p.stop;
    final newTarget = target ?? p.target;
    final last = p.lastPrice!;
    if ((last - newStop) * p.side.sign <= 0) return 'A stop at $newStop is already through the last price $last.';
    if ((newTarget - last) * p.side.sign <= 0) return 'A target at $newTarget is already through the last price $last.';
    final now = _clock();
    for (final (field, from, to) in [('stop', p.stop, newStop), ('target', p.target, newTarget)]) {
      if (from == to) continue;
      p.adjustments.add(CheTradeAdjustment(at: now, field: field, from: from, to: to, reason: reason));
      _audit('position_adjusted', {'position_id': p.id, 'field': field, 'from': from, 'to': to, 'reason': reason});
      _alert('${field}_adjusted', 'CHE moved a paper $field', '${p.contract.root} ${p.side.label}: $field $from → $to. $reason', now, p.id);
    }
    p
      ..stop = newStop
      ..target = newTarget;
    _journal.add(CheJournalEntry(at: now, positionId: p.id, kind: 'adjusted', text: 'Stop $newStop, target $newTarget: $reason'));
    _changed();
    return null;
  }

  /// The signal engine re-checked an open trade's setup: its conditions now. Changes are journaled.
  void updateConditions(String signalId, List<ChePaperCondition> now) {
    final p = _positions.where((p) => p.signal.id == signalId && p.status == ChePositionStatus.open).firstOrNull;
    if (p == null) return;
    String sig(List<ChePaperCondition> l) => l.map((c) => '${c.name}=${c.status}').join('|');
    if (sig(p.currentConditions) == sig(now)) return;
    final failed = now.where((c) => c.status == 'failed').map((c) => c.name).toList();
    p
      ..currentConditions = List.of(now)
      ..conditionsAt = _clock();
    _journal.add(CheJournalEntry(
      at: _clock(),
      positionId: p.id,
      kind: 'remains_open',
      text: failed.isEmpty
          ? 'Setup re-checked: conditions still hold; the trade stays open with stop ${p.stop} and target ${p.target}.'
          : 'Setup re-checked: ${failed.join(', ')} no longer holds. The trade stays open on its stop ${p.stop}; CHE does not close early without a rule.',
    ));
    _changed();
  }

  /// A journal note on why an open trade stays open.
  void note(String id, String text) {
    if (position(id) == null) return;
    _journal.add(CheJournalEntry(at: _clock(), positionId: id, kind: 'remains_open', text: text));
    _changed();
  }

  // ---------------------------------------------------------------- the balance

  /// Changes the CHE paper balance. [amount] is the deposit or withdrawal amount, or the new
  /// balance for a reset or a simulation setting. Nothing changes unless [confirmed] is true.
  /// Returns null on success, or why it was refused.
  String? changeBalance({required CheBalanceChangeType type, required double amount, String reason = '', required bool confirmed}) {
    if (type == CheBalanceChangeType.initial) return 'The opening balance cannot be changed; use a reset.';
    if (!confirmed) return 'Confirm the balance change first. Nothing changed.';
    if (!amount.isFinite || amount <= 0) return 'Enter an amount above zero.';
    if (amount > 10000000) return 'That is above the 10,000,000 dollar simulation cap.';
    final snap = snapshot();
    final previous = snap.balance;
    double next;
    switch (type) {
      case CheBalanceChangeType.deposit:
        next = previous + amount;
      case CheBalanceChangeType.withdrawal:
        if (amount > snap.available) return 'Only \$${snap.available.toStringAsFixed(2)} is available to withdraw (open trades hold their risk).';
        next = previous - amount;
      case CheBalanceChangeType.reset:
        if (_positions.any((p) => p.status.isOpen)) return 'Close or wait out the open CHE paper trades before a reset.';
        next = amount;
      case CheBalanceChangeType.simulationSetting:
        next = amount;
      case CheBalanceChangeType.initial:
        return 'The opening balance cannot be changed.';
    }
    final now = _clock();
    final change = CheBalanceChange(seq: _balance.last.seq + 1, type: type, previous: cheRound2(previous), next: cheRound2(next), at: now, reason: reason.trim());
    _balance.add(change);
    _audit('balance_change', change.toJson());
    final after = snapshot();
    _equity.add(CheEquityPoint(now, after.equity, '${type.label}: \$${change.previous.toStringAsFixed(2)} → \$${change.next.toStringAsFixed(2)}'));
    _alert('balance_changed', 'CHE paper balance changed',
        '${type.label}: \$${change.previous.toStringAsFixed(2)} to \$${change.next.toStringAsFixed(2)}. Closed trades keep their results; available is now \$${after.available.toStringAsFixed(2)}.', now);
    _changed();
    return null;
  }

  /// New risk limits, kept in the audit. Open trades keep the risk they were opened with.
  String? setLimits(ChePaperRiskLimits l, {required bool confirmed}) {
    if (!confirmed) return 'Confirm the new limits first. Nothing changed.';
    if (l.maxRiskPerTradePct <= 0 || l.maxRiskPerTradePct > 100 || l.maxOpenRiskPct <= 0 || l.maxOpenRiskPct > 100 || l.maxDailyLossPct <= 0 || l.maxDailyLossPct > 100 || l.maxContracts < 1 || l.maxContracts > 50) {
      return 'Those limits are out of range: percentages above 0 and up to 100, 1 to 50 contracts.';
    }
    _audit('limits_change', {'previous': _limits.toJson(), 'next': l.toJson()});
    _limits = l;
    _changed();
    return null;
  }

  /// The audit records on disk agree with the balance history (a missing one means the state was edited).
  Future<List<String>> integrityProblems() async {
    final audit = await _store.readAudit();
    final logged = audit.where((a) => a['kind'] == 'balance_change').map((a) => (a['detail'] as Map)['seq']).toSet();
    return [
      for (final b in _balance)
        if (!logged.contains(b.seq)) 'Balance change #${b.seq} (${b.type.label}) has no audit record.',
    ];
  }

  Future<List<ChePaperAuditEvent>> auditTrail() async => [for (final a in await _store.readAudit()) ChePaperAuditEvent.fromJson(a)];

  // ---------------------------------------------------------------- plumbing

  void _alert(String kind, String title, String message, DateTime at, [String? positionId]) {
    if (!_alerts.isClosed) _alerts.add(ChePaperAlert(kind: kind, title: title, message: message, at: at, positionId: positionId));
  }

  void _audit(String kind, Map<String, Object?> detail) {
    final e = ChePaperAuditEvent(seq: ++_auditSeq, at: _clock(), kind: kind, detail: detail);
    _writes = _writes.then((_) => _store.appendAudit(e.toJson())).catchError((Object _) {});
  }

  Map<String, dynamic> _state() => {
        'label': kChePaperLabel,
        'balance_history': [for (final b in _balance) b.toJson()],
        'positions': [for (final p in _positions) p.toJson()],
        'journal': [for (final j in _journal) j.toJson()],
        'equity': [for (final q in _equity) q.toJson()],
        'threshold_alerts': _thresholdAlerts.toList(),
        'limits': _limits.toJson(),
        'costs': _costs.toJson(),
      };

  void _save() {
    final s = _state();
    _writes = _writes.then((_) => _store.writeState(s)).catchError((Object _) {});
  }

  void _changed() {
    _save();
    notifyListeners();
  }

  /// Waits for every pending write (tests, and before the app suspends).
  Future<void> flush() => _writes;

  @override
  void dispose() {
    _alerts.close();
    super.dispose();
  }
}
