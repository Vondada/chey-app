import 'package:chey/trading/che_setup_engine.dart';
import 'package:chey/trading/che_trade_signal.dart';
import 'package:flutter_test/flutter_test.dart';

// 2026-10-20 13:00 UTC is 09:00 New York (daylight time): far from the 16:55 flat time.
final _t0 = DateTime.utc(2026, 10, 20, 13);

CheSetupBar _bar(int i, double o, double h, double l, double c, {int v = 100}) =>
    CheSetupBar(start: _t0.add(Duration(minutes: i)), minutes: 1, open: o, high: h, low: l, close: c, volume: v);

/// 60 rising bars: closes 20000, 20002, … with a 3-point range each side.
List<CheSetupBar> _uptrend([int n = 60]) => [
      for (var i = 0; i < n; i++) _bar(i, 20000 + 2.0 * i - 1, 20000 + 2.0 * i + 3, 20000 + 2.0 * i - 3, 20000 + 2.0 * i),
    ];

/// The bar after [bars] that pulls back to the 20 EMA and closes above it on an up bar.
CheSetupBar _pullback(List<CheSetupBar> bars) {
  final e = CheIndicators.of(bars).ema20.last!;
  final i = bars.length;
  return _bar(i, e + 1, e + 7, e - 1, e + 6);
}

void main() {
  test('New York time follows US daylight rules', () {
    expect(cheNewYorkOffset(DateTime.utc(2026, 7, 1)), const Duration(hours: -4));
    expect(cheNewYorkOffset(DateTime.utc(2026, 12, 1)), const Duration(hours: -5));
    expect(cheNewYorkMinutes(DateTime.utc(2026, 10, 20, 13, 30)), 9 * 60 + 30);
    expect(cheTradeDay(DateTime.utc(2026, 10, 20, 22, 30)), '2026-10-21'); // 18:30 New York starts the next CME day
    expect(cheAfterFlatTime(DateTime.utc(2026, 10, 20, 20, 56)), isTrue); // 16:56 New York
  });

  test('stage machine refuses illegal transitions', () {
    expect(cheSetupTransitionAllowed(CheSetupStage.watching, CheSetupStage.active), isFalse);
    expect(cheSetupTransitionAllowed(CheSetupStage.forming, CheSetupStage.targetHit), isFalse);
    expect(cheSetupTransitionAllowed(CheSetupStage.triggered, CheSetupStage.ready), isFalse);
    expect(cheSetupTransitionAllowed(CheSetupStage.active, CheSetupStage.invalidated), isFalse);
    expect(cheSetupTransitionAllowed(CheSetupStage.stopped, CheSetupStage.watching), isFalse);
    expect(cheSetupTransitionAllowed(CheSetupStage.watching, CheSetupStage.triggered), isTrue);
    expect(cheSetupTransitionAllowed(CheSetupStage.ready, CheSetupStage.forming), isTrue);
    expect(cheSetupTransitionAllowed(CheSetupStage.triggered, CheSetupStage.active), isTrue);
    expect(cheSetupTransitionAllowed(CheSetupStage.active, CheSetupStage.stopped), isTrue);
  });

  test('EMA pullback: forming bar is READY, the closed bar TRIGGERS, the next open makes it ACTIVE, the target ends it', () {
    final engine = CheSetupEngine(symbol: 'MNQZ6', minutes: 1, strategies: [cheBuiltInSetupStrategy('ema-pullback-5m')!])
      ..dataSource = 'Rithmic live — MNQZ6'
      ..dataLive = true
      ..evidence['ema-pullback-5m'] = const CheStrategyEvidence(strategyId: 'ema-pullback-5m', sampleTrades: 12);
    final bars = _uptrend();
    for (final b in bars) {
      engine.onClosed(b);
    }
    expect(engine.setups.single.stage, isNot(CheSetupStage.ready));
    final pb = _pullback(bars);

    final forming = engine.onForming(pb);
    expect(forming.map((e) => e.to), contains(CheSetupStage.ready));
    expect(engine.setups.single.stage, CheSetupStage.ready);
    expect(engine.setups.single.stage.meaning, contains('only if the bar closes'));

    final closed = engine.onClosed(pb);
    final trig = closed.singleWhere((e) => e.to == CheSetupStage.triggered);
    final sig = trig.signal!;
    expect(sig.side, 'long');
    expect(sig.entry, pb.close);
    expect(sig.stop, pb.low - 0.25);
    expect(sig.target, closeTo(sig.entry + 2 * (sig.entry - sig.stop), 1e-9));
    expect(sig.rewardRisk, closeTo(2, 1e-9));
    expect(sig.dataSource, 'Rithmic live — MNQZ6');
    expect(sig.evidence.status, 'Insufficient evidence: 12 of 30 trades');
    expect(sig.evidence.score, isNull);
    expect(sig.toMarker()['source'], 'che_signal');
    expect(sig.toMarker()['account'], 'CHE PAPER ACCOUNT');
    expect(sig.spoken, contains('not a prediction'));

    final next = _bar(61, pb.close + 1, pb.close + 2, pb.close, pb.close + 1.5);
    final fill = engine.onForming(next);
    expect(fill.map((e) => e.to), contains(CheSetupStage.active));
    final up = _bar(61, pb.close + 1, sig.target + 1, pb.close, sig.target + 0.5);
    final exit = engine.onClosed(up);
    expect(exit.map((e) => e.to), contains(CheSetupStage.targetHit));
    expect(engine.finished.first.stage, CheSetupStage.targetHit);
    // A fresh setup is followed after a finished one.
    expect(engine.setups.single.stage, isNot(CheSetupStage.targetHit));
    expect(engine.finished.first.timeline.map((t) => t.$2), containsAllInOrder([CheSetupStage.ready, CheSetupStage.triggered, CheSetupStage.active, CheSetupStage.targetHit]));
  });

  test('a bar that reaches both stop and target counts as STOPPED', () {
    final engine = CheSetupEngine(symbol: 'MNQZ6', minutes: 1, strategies: [cheBuiltInSetupStrategy('ema-pullback-5m')!]);
    final bars = _uptrend();
    for (final b in bars) {
      engine.onClosed(b);
    }
    final pb = _pullback(bars);
    final sig = engine.onClosed(pb).singleWhere((e) => e.signal != null).signal!;
    final both = _bar(61, pb.close, sig.target + 5, sig.stop - 5, pb.close);
    final ev = engine.onClosed(both);
    expect(ev.map((e) => e.to), containsAllInOrder([CheSetupStage.active, CheSetupStage.stopped]));
  });

  test('READY needs every condition: a pullback bar closing below its open is not READY', () {
    final bars = _uptrend();
    final e = CheIndicators.of(bars).ema20.last!;
    final down = _bar(60, e + 7, e + 8, e - 1, e + 6); // closes above the EMA but below its open
    final ev = cheEvaluateSetup('ema-pullback-5m', [...bars, down], intrabar: true);
    expect(ev.stage, isNot(CheSetupStage.ready));
    expect(ev.conditions.firstWhere((c) => c.id == 'direction').state, CheConditionState.pending);
  });

  test('risk outside 6–60 points never triggers', () {
    final bars = _uptrend();
    final e = CheIndicators.of(bars).ema20.last!;
    final tiny = _bar(60, e + 0.5, e + 2, e - 0.5, e + 1.5); // about 2 points of risk
    final ev = cheEvaluateSetup('ema-pullback-5m', [...bars, tiny]);
    expect(ev.stage, isNot(CheSetupStage.triggered));
    expect(ev.conditions.firstWhere((c) => c.id == 'risk').state, isNot(CheConditionState.satisfied));
  });

  test('no look-ahead: each signal is the same when only the bars up to it exist, and later bars cannot change it', () {
    final bars = [..._uptrend()];
    bars.add(_pullback(bars));
    for (var i = bars.length; i < 140; i++) {
      final p = bars.last.close;
      final step = (i % 7 < 3) ? -4.0 : 3.0;
      bars.add(_bar(i, p, p + 5 + (i % 3), p + step - 6, p + step));
    }
    List<CheTradeSignal> run(List<CheSetupBar> input) {
      final engine = CheSetupEngine(symbol: 'MNQZ6', minutes: 1);
      final out = <CheTradeSignal>[];
      for (final b in input) {
        for (final e in engine.onClosed(b)) {
          if (e.signal != null) out.add(e.signal!);
        }
      }
      return out;
    }

    final all = run(bars);
    expect(all, isNotEmpty);
    for (final s in all) {
      final upTo = bars.where((b) => !b.start.isAfter(s.barTime)).toList();
      final prefix = run(upTo);
      final same = prefix.where((p) => p.strategyId == s.strategyId && p.barTime == s.barTime).toList();
      expect(same, hasLength(1), reason: '${s.strategyId} at ${s.barTime} must exist with only past bars');
      expect(same.single.entry, s.entry);
      expect(same.single.stop, s.stop);
    }
    // Changing every bar after the first signal leaves that signal untouched.
    final first = all.first;
    final altered = [
      for (final b in bars)
        b.start.isAfter(first.barTime) ? _bar(b.start.difference(_t0).inMinutes, b.open, b.high + 50, b.low - 50, b.close - 30) : b,
    ];
    final again = run(altered).firstWhere((s) => s.barTime == first.barTime && s.strategyId == first.strategyId);
    expect(again.entry, first.entry);
    expect(again.target, first.target);
  });

  test('closed candles out of order are ignored; flat time expires pre-entry setups', () {
    final engine = CheSetupEngine(symbol: 'MNQZ6', minutes: 1, strategies: [cheBuiltInSetupStrategy('ema-pullback-5m')!]);
    final bars = _uptrend(10);
    for (final b in bars) {
      engine.onClosed(b);
    }
    expect(engine.onClosed(bars[3]), isEmpty);
    expect(engine.closedBars, hasLength(10));
    final late = CheSetupBar(start: DateTime.utc(2026, 10, 20, 20, 56), minutes: 1, open: 1, high: 2, low: 0.5, close: 1.5);
    final ev = engine.onClosed(late);
    expect(ev.single.to, CheSetupStage.expired);
  });

  test('liquidity sweep and reclaim: sweep of a swing low with a close above the prior high triggers', () {
    // A swing low at bar 5 (19990), then drift up, then a bar that sweeps it and reclaims.
    final bars = <CheSetupBar>[];
    final lows = <double>[20010, 20006, 20002, 19998, 19994, 19990, 19996, 20000, 20004, 20006, 20005, 20004];
    for (var i = 0; i < lows.length; i++) {
      final l = lows[i];
      bars.add(_bar(i, l + 3, l + 6, l, l + 4));
    }
    final prevHigh = bars.last.high;
    final sweep = _bar(lows.length, 20000, prevHigh + 3, 19988, prevHigh + 1);
    final ev = cheEvaluateSetup('sweep-reclaim-5m', [...bars, sweep]);
    expect(ev.side, 'long');
    expect(ev.stage, CheSetupStage.triggered);
    expect(ev.stop, 19988 - 0.25);

    final stayedBelow = _bar(lows.length, 19995, 19996, 19985, 19986);
    final bad = cheEvaluateSetup('sweep-reclaim-5m', [...bars, stayedBelow]);
    expect(bad.stage, CheSetupStage.invalidated);
    expect(bad.conditions.firstWhere((c) => c.id == 'reclaim').state, CheConditionState.pending);
  });

  test('evidence: sufficient samples report expectancy with the sample size; none is never a confidence', () {
    const none = CheStrategyEvidence(strategyId: 'x', sampleTrades: 0);
    expect(none.status, 'No recorded evidence');
    expect(none.score, isNull);
    const good = CheStrategyEvidence(strategyId: 'x', sampleTrades: 120, expectancyR: 0.18, winRate: 0.41, readiness: '30+ SAMPLE');
    expect(good.status, '120 trades, +0.18R expectancy, 41% wins (30+ SAMPLE)');
    expect(good.score, inInclusiveRange(0, 100));
  });
}
