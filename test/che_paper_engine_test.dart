import 'package:chey/trading/che_market_feed.dart';
import 'package:chey/trading/che_paper_account.dart';
import 'package:chey/trading/che_paper_engine.dart';
import 'package:flutter_test/flutter_test.dart';

DateTime t0 = DateTime.utc(2026, 10, 23, 14, 30);

ChePaperSignal sig({
  String id = 's1',
  CheSide side = CheSide.long,
  double entry = 21000,
  double stop = 20995,
  double target = 21010,
  String stage = 'ready',
  String source = 'rithmic',
  String symbol = 'MNQZ6',
}) =>
    ChePaperSignal(
      id: id,
      symbol: symbol,
      side: side,
      entry: entry,
      stop: stop,
      target: target,
      strategy: 'EMA 20 pullback',
      timeframe: '5m',
      stage: stage,
      detectedAt: t0,
      dataSource: source,
      conditions: const [CheSetupCondition('Price above EMA 20', 'satisfied'), CheSetupCondition('Pullback to EMA', 'satisfied')],
    );

ChePriceTick tick(double price, int sec, {String source = 'rithmic'}) =>
    ChePriceTick(symbol: 'MNQZ6', price: price, time: t0.add(Duration(seconds: sec)), source: source);

Future<(ChePaperEngine, ChePaperMemoryStore, List<ChePaperAlert>)> engine({DateTime? now, bool wide = true}) async {
  final store = ChePaperMemoryStore();
  final e = await ChePaperEngine.load(store, clock: () => now ?? t0);
  // Most tests check fills and costs on the default $100, so they use wide limits; the defaults have their own test.
  if (wide) e.setLimits(const ChePaperRiskLimits(maxRiskPerTradePct: 25, maxOpenRiskPct: 50, maxDailyLossPct: 50), confirmed: true);
  final alerts = <ChePaperAlert>[];
  e.alerts.listen(alerts.add);
  return (e, store, alerts);
}

void main() {
  test('a new CHE paper account starts at the default 100 dollars, recorded and audited', () async {
    final (e, store, _) = await engine(wide: false);
    await e.flush();
    final s = e.snapshot();
    expect(s.balance, 100);
    expect(s.startingBalance, 100);
    expect(s.equity, 100);
    expect(e.balanceHistory.single.type, CheBalanceChangeType.initial);
    expect(store.audit.single['kind'], 'balance_change');
    expect(store.audit.single['account'], kChePaperLabel);
    expect(await e.integrityProblems(), isEmpty);
  });

  test('entry fills at the next Rithmic trade, never better than traded; target fills one tick through', () async {
    final (e, _, alerts) = await engine();
    final d = e.onSignal(sig());
    expect(d.accepted, isTrue, reason: d.reason);
    final p = d.position!;
    expect(p.status, ChePositionStatus.pendingEntry);
    e.onTick(tick(21000.5, 1));
    expect(p.status, ChePositionStatus.open);
    expect(p.entryRaw, 21000.5);
    // Half a 1-tick spread plus 1 tick slippage against a buyer.
    expect(p.entryFill, greaterThan(p.entryRaw!));
    expect(p.entryFill, closeTo(21000.875, 0.01));
    expect(alerts.map((a) => a.kind), contains('paper_trade_opened'));
    // Touching the target is not a fill.
    e.onTick(tick(21010, 2));
    expect(p.status, ChePositionStatus.open);
    e.onTick(tick(21010.25, 3));
    expect(p.status, ChePositionStatus.targetHit);
    expect(p.exitFill, 21010);
    // (21010 − 21000.88) × $2 − $4 round-trip commissions and fees.
    expect(p.netPnl, closeTo(14.24, 0.011));
    expect(p.grossPnl, closeTo((21010.25 - 21000.5) * 2, 0.001));
    expect(e.snapshot().balance, closeTo(114.24, 0.011));
    expect(e.journal.map((j) => j.kind), containsAll(['opened', 'closed']));
  });

  test('a gap through the stop fills at the traded price with slippage, not at the stop', () async {
    final (e, _, alerts) = await engine();
    final p = e.onSignal(sig()).position!;
    e.onTick(tick(21000.5, 1));
    e.onTick(tick(20990, 2));
    expect(p.status, ChePositionStatus.stopped);
    expect(p.exitFill, lessThan(20990));
    expect(p.exitFill, closeTo(20989.625, 0.01));
    expect(p.netPnl, closeTo((20989.63 - 21000.88) * 2 - 4, 0.02));
    expect(alerts.map((a) => a.kind), contains('stop_hit'));
  });

  test('short positions pay the spread the other way', () async {
    final (e, _, _) = await engine();
    final p = e.onSignal(sig(side: CheSide.short, entry: 21000, stop: 21005, target: 20990)).position!;
    e.onTick(tick(21000, 1));
    expect(p.entryFill, lessThan(21000));
    e.onTick(tick(20989.75, 2));
    expect(p.status, ChePositionStatus.targetHit);
    expect(p.netPnl! > 0, isTrue);
  });

  test('risk that breaks a limit is skipped and journaled; the stop is never moved to fit', () async {
    final (e, _, alerts) = await engine();
    // 10-point MNQ stop: $20 + $4 fees + $1.50 spread/slippage = $25.50 > 25% of $100.
    final d = e.onSignal(sig(stop: 20990));
    expect(d.accepted, isFalse);
    expect(d.reason, startsWith('skipped: risk exceeds limit'));
    expect(e.positions, isEmpty);
    expect(e.journal.last.kind, 'skipped');
    expect(alerts.last.kind, 'trade_skipped');

    expect(e.setLimits(const ChePaperRiskLimits(maxRiskPerTradePct: 100, maxOpenRiskPct: 100), confirmed: true), isNull);
    final big = e.onSignal(sig(id: 's2', stop: 20940));
    expect(big.accepted, isFalse);
    expect(big.reason, startsWith('skipped: risk exceeds balance'));
    expect(e.journal.last.text, contains('risk exceeds balance'));
  });

  test('only live Rithmic prices fill; delayed or recorded prices and non-Rithmic setups are refused', () async {
    final (e, _, _) = await engine();
    expect(e.onSignal(sig(stage: 'forming')).accepted, isFalse);
    expect(e.onSignal(sig(id: 'y', source: 'yahoo_delayed')).reason, contains('not built from verified Rithmic data'));
    final p = e.onSignal(sig(id: 'ok')).position!;
    e.onTick(tick(21000, 1, source: 'yahoo_delayed'));
    e.onTick(tick(21000, 1, source: 'recorded'));
    expect(p.status, ChePositionStatus.pendingEntry);
    expect(e.ignoredTicks, 2);

    final recorded = ChePaperEngine.tickFrom(CheMarketSnapshot(
      symbol: 'MNQZ6', exchange: 'CME', source: 'rithmic', sourceLabel: 'Rithmic MNQZ6 (recorded on this phone)',
      connection: CheFeedConnection.disconnected, statusLabel: 'Disconnected', isLive: false, lastPrice: 21000, lastTradeAt: t0, lastUpdate: t0,
    ))!;
    expect(recorded.isRithmic, isFalse);
    final live = ChePaperEngine.tickFrom(CheMarketSnapshot(
      symbol: 'MNQZ6', exchange: 'CME', source: 'rithmic', sourceLabel: 'Rithmic live — MNQZ6',
      connection: CheFeedConnection.connected, statusLabel: 'Connected', isLive: true, lastPrice: 21000, lastTradeAt: t0, lastUpdate: t0,
    ))!;
    expect(live.isRithmic, isTrue);
  });

  test('an order whose first trade is already through the stop is cancelled, not filled', () async {
    final (e, _, _) = await engine();
    final p = e.onSignal(sig()).position!;
    e.onTick(tick(20994, 1));
    expect(p.status, ChePositionStatus.cancelled);
    expect(p.netPnl, isNull);
    expect(e.snapshot().balance, 100);
  });

  test('balance changes need confirmation, are append-only, and never rewrite closed trades', () async {
    final (e, store, alerts) = await engine();
    final p = e.onSignal(sig()).position!;
    e.onTick(tick(21000.5, 1));
    e.onTick(tick(21010.25, 2));
    final net = p.netPnl;

    expect(e.changeBalance(type: CheBalanceChangeType.deposit, amount: 400, confirmed: false), contains('Confirm'));
    expect(e.balanceHistory, hasLength(1));
    expect(e.changeBalance(type: CheBalanceChangeType.deposit, amount: 400, reason: 'bigger test', confirmed: true), isNull);
    final dep = e.balanceHistory.last;
    expect(dep.previous, closeTo(114.24, 0.011));
    expect(dep.next, closeTo(514.24, 0.011));
    expect(dep.reason, 'bigger test');
    expect(e.snapshot().startingBalance, 100);
    expect(e.snapshot().netDeposits, 400);
    expect(alerts.last.kind, 'balance_changed');

    expect(e.changeBalance(type: CheBalanceChangeType.withdrawal, amount: 10000, confirmed: true), contains('available'));
    expect(e.changeBalance(type: CheBalanceChangeType.reset, amount: 250, reason: 'fresh start', confirmed: true), isNull);
    final s = e.snapshot();
    expect(s.balance, 250);
    expect(s.startingBalance, 250);
    expect(s.realizedPnl, 0, reason: 'a reset starts a new period');
    expect(p.netPnl, net, reason: 'the closed trade keeps its result');
    expect(e.balanceHistory.map((b) => b.type), [CheBalanceChangeType.initial, CheBalanceChangeType.deposit, CheBalanceChangeType.reset]);
    expect(() => (e.balanceHistory as List).add(e.balanceHistory.first), throwsUnsupportedError);
    await e.flush();
    expect(store.audit.where((a) => a['kind'] == 'balance_change'), hasLength(3));
    expect(await e.integrityProblems(), isEmpty);
  });

  test('a reset is refused while CHE paper trades are open', () async {
    final (e, _, _) = await engine();
    e.onSignal(sig());
    e.onTick(tick(21000.5, 1));
    expect(e.changeBalance(type: CheBalanceChangeType.reset, amount: 1000, confirmed: true), contains('open'));
    expect(e.changeBalance(type: CheBalanceChangeType.simulationSetting, amount: 1000, reason: 'size test', confirmed: true), isNull);
    expect(e.snapshot().startingBalance, 100);
    expect(e.balanceHistory.last.type.label, 'Simulation setting');
  });

  test('the account reloads from its records, and a state edited without an audit record is caught', () async {
    final (e, store, _) = await engine();
    e.onSignal(sig());
    e.onTick(tick(21000.5, 1));
    e.changeBalance(type: CheBalanceChangeType.deposit, amount: 50, confirmed: true);
    await e.flush();
    final again = await ChePaperEngine.load(store, clock: () => t0);
    expect(again.positions.single.entryFill, e.positions.single.entryFill);
    expect(again.balanceHistory, hasLength(2));
    expect(again.snapshot().balance, e.snapshot().balance);
    expect(await again.integrityProblems(), isEmpty);

    final edited = Map<String, dynamic>.from(store.state!);
    edited['balance_history'] = [
      ...edited['balance_history'] as List,
      {'seq': 99, 'type': 'deposit', 'previous': 150, 'next': 1000000, 'at': t0.toIso8601String(), 'reason': ''},
    ];
    store.state = edited;
    final tampered = await ChePaperEngine.load(store, clock: () => t0);
    expect(await tampered.integrityProblems(), [contains('#99')]);
  });

  test('adjustments are kept with reasons; nearing the stop raises one alert', () async {
    final (e, _, alerts) = await engine();
    final p = e.onSignal(sig()).position!;
    e.onTick(tick(21000.5, 1));
    expect(e.adjust(p.id, stop: 21002, reason: 'test'), contains('through the last price'));
    expect(e.adjust(p.id, target: 21012, reason: 'Structure extends; target to the next swing high'), isNull);
    expect(p.adjustments.single.field, 'target');
    expect(p.adjustments.single.from, 21010);
    expect(alerts.map((a) => a.kind), contains('target_adjusted'));
    e.onTick(tick(20996.5, 5));
    e.onTick(tick(20996.25, 10));
    expect(alerts.where((a) => a.kind == 'approaching_stop'), hasLength(1));
    expect(p.progressToStop, greaterThanOrEqualTo(0.75));
    expect(p.unrealizedPnl, lessThan(0));
  });

  test('positions report distances, progress, R and age from the last price', () async {
    final (e, _, _) = await engine(now: t0.add(const Duration(minutes: 3)));
    final p = e.onSignal(sig()).position!;
    // The clock is fixed after the ticks below, so the order exists before them.
    e.onTick(tick(21000.5, 200));
    e.onTick(tick(21005, 230));
    expect(p.distanceToTargetPoints, 5);
    expect(p.distanceToStopPoints, 10);
    expect(p.progressToTarget, closeTo((21005 - 21000.88) / (21010 - 21000.88), 0.01));
    expect(p.plannedRewardRisk, 2);
    expect(p.age(t0.add(const Duration(seconds: 260))), const Duration(seconds: 60));
    expect(p.path, isNotEmpty);
  });

  test('default limits are 2% per trade, 6% open and 6% daily: a 100 dollar account skips MNQ setups, a 2,500 dollar setting takes them', () async {
    final (e, _, _) = await engine(wide: false);
    expect(e.limits.maxRiskPerTradePct, 2);
    expect(e.limits.maxOpenRiskPct, 6);
    expect(e.limits.maxDailyLossPct, 6);
    final d = e.onSignal(sig());
    expect(d.accepted, isFalse);
    expect(d.reason, startsWith('skipped: risk exceeds limit'));
    expect(d.reason, contains('the stop was not moved to fit'));
    expect(e.changeBalance(type: CheBalanceChangeType.simulationSetting, amount: 2500, reason: 'preset', confirmed: true), isNull);
    final ok = e.onSignal(sig(id: 's2'));
    expect(ok.accepted, isTrue, reason: ok.reason);
    expect(ok.position!.qty, 1);
    expect(ok.position!.stop, 20995, reason: 'the stop is exactly the setup stop');
  });

  test('a feed gap never fills a stop or target on unseen prices: beyond a level the trade is unresolved, with no result', () async {
    final (e, store, alerts) = await engine();
    final p = e.onSignal(sig()).position!;
    e.onTick(tick(21000.5, 1));
    // Two minutes with no live price (app in the background), then price is back below the stop.
    e.onTick(tick(20990, 125));
    expect(p.status, ChePositionStatus.unresolved);
    expect(p.netPnl, isNull);
    expect(p.exitFill, isNull);
    expect(p.gaps.single.length, const Duration(seconds: 124));
    expect(e.snapshot().balance, 100);
    expect(e.snapshot().closedTrades, 0);
    expect(alerts.last.kind, 'feed_gap');
    expect(alerts.last.message, contains('stop/target status unknown for that window'));
    expect(e.journal.last.text, contains('Not counted as a win or a loss'));
    await e.flush();
    expect(store.audit.where((a) => a['kind'] == 'feed_gap'), hasLength(1));
  });

  test('a feed gap with price back inside the levels keeps the trade, recorded with the gap', () async {
    final (e, _, _) = await engine();
    final p = e.onSignal(sig()).position!;
    e.onTick(tick(21000.5, 1));
    e.onTick(tick(21002, 300));
    expect(p.status, ChePositionStatus.open);
    expect(p.gaps, hasLength(1));
    expect(e.journal.last.text, contains('stop/target status unknown for that window'));
    e.onTick(tick(21010.25, 301));
    expect(p.status, ChePositionStatus.targetHit);
    expect(p.gaps, hasLength(1));
  });

  test('an order still waiting when the feed stops is cancelled at the gap, never filled late', () async {
    final (e, _, _) = await engine();
    final p = e.onSignal(sig()).position!;
    e.onTick(tick(21000.5, 600));
    expect(p.status, ChePositionStatus.cancelled);
    expect(p.entryFill, isNull);
    expect(p.exitReason, contains('feed gap'));
  });
}
