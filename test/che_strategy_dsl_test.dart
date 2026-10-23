import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:chey/trading/che_setup_engine.dart';
import 'package:chey/trading/che_strategy_dsl.dart';
import 'package:chey/trading/che_strategy_runner.dart';
import 'package:chey/trading/che_trade_signal.dart';
import 'package:flutter_test/flutter_test.dart';

/// Deterministic 5-minute MNQ-like bars from a New York start time (UTC fields hold the instant).
List<CheSetupBar> bars(int n, {DateTime? start, int minutes = 5, int seed = 7, double drift = 0}) {
  final r = math.Random(seed);
  var p = 21000.0;
  final t0 = start ?? DateTime.utc(2026, 10, 21, 13, 30); // 09:30 New York (EDT)
  return [
    for (var i = 0; i < n; i++)
      () {
        final o = p;
        final c = o + (r.nextDouble() - 0.5) * 16 + drift;
        final h = math.max(o, c) + r.nextDouble() * 6;
        final l = math.min(o, c) - r.nextDouble() * 6;
        p = c;
        return CheSetupBar(start: t0.add(Duration(minutes: i * minutes)), minutes: minutes, open: o, high: h, low: l, close: c, volume: 100 + r.nextInt(400));
      }(),
  ];
}

Map<String, dynamic> doc([Map<String, dynamic> patch = const {}]) => {
      'schema': kCheStrategySchema,
      'id': 'test-ema',
      'name': 'Test EMA',
      'category': 'trend',
      'timeframes': [5],
      'series': {
        'ema9': {'fn': 'ema', 'period': 9},
        'ema21': {'fn': 'ema', 'period': 21},
      },
      'long': {
        'conditions': [
          {'id': 'x', 'label': '9 EMA above 21 EMA', 'when': {'gt': ['ema9', 'ema21']}},
        ],
        'stop': {'sub': ['close', 10]},
        'target': {'r': 2},
      },
      ...patch,
    };

CheEvaluation evalAt(CheDslStrategy s, List<CheSetupBar> b, {bool intrabar = false}) => s.evaluate(CheIndicators.of(b), intrabar: intrabar, nearPoints: 5, price: b.last.close);

void main() {
  group('validation', () {
    test('a well-formed document is valid', () {
      expect(cheValidateStrategy(doc()), isEmpty);
    });

    test('every executable library seed validates in the evaluator', () {
      final seeds = (jsonDecode(File('test/fixtures/strategy_seeds.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();
      expect(seeds, isNotEmpty);
      for (final s in seeds) {
        expect(cheValidateStrategy(s), isEmpty, reason: '${s['id']}: ${cheValidateStrategy(s).join('; ')}');
        CheDslStrategy.parse(s);
      }
    });

    test('unknown constructs are refused by name, never skipped', () {
      final bad = doc({
        'long': {
          'conditions': [
            {'id': 'x', 'label': 'security call', 'when': {'request_security': ['NQ', '1D']}},
          ],
          'stop': 'low',
          'target': {'r': 2},
        },
      });
      expect(cheValidateStrategy(bad).join(' '), contains('unsupported construct "request_security"'));
      expect(cheValidateStrategy(doc({'script': 'x'})).join(' '), contains('unsupported field "script"'));
      expect(cheValidateStrategy(doc({'series': {'k': {'fn': 'kalman'}}})).join(' '), contains('unsupported indicator "kalman"'));
    });

    test('look-ahead, a missing stop and an absurd target are refused', () {
      final ahead = doc({
        'long': {
          'conditions': [
            {'id': 'x', 'label': 'next bar', 'when': {'gt': [{'series': 'ema9', 'ago': -1}, 'close']}},
          ],
          'stop': 'low',
          'target': {'r': 2},
        },
      });
      expect(cheValidateStrategy(ahead).join(' '), contains('look-ahead is not allowed'));
      final noStop = doc({
        'long': {
          'conditions': [
            {'id': 'x', 'label': 'a', 'when': {'true': true}},
          ],
          'target': {'r': 2},
        },
      });
      expect(cheValidateStrategy(noStop).join(' '), contains('a stop is required'));
      final huge = doc({
        'long': {
          'conditions': [
            {'id': 'x', 'label': 'a', 'when': {'true': true}},
          ],
          'stop': 'low',
          'target': {'r': 50},
        },
      });
      expect(cheValidateStrategy(huge).join(' '), contains('reward multiple from 0.5 to 10'));
      expect(() => CheDslStrategy.parse(noStop), throwsFormatException);
    });

    test('unknown names, windows and levels are refused', () {
      final bad = doc({
        'long': {
          'conditions': [
            {'id': 'a', 'label': 'a', 'when': {'gt': ['ema200', 'close']}},
            {'id': 'b', 'label': 'b', 'when': {'in_window': 'tokyo_lunch'}},
            {'id': 'c', 'label': 'c', 'when': {'gt': [{'level': 'last_week_high'}, 'close']}},
          ],
          'stop': 'low',
          'target': {'r': 2},
        },
      });
      final out = cheValidateStrategy(bad).join(' ');
      expect(out, contains('unknown name "ema200"'));
      expect(out, contains('unknown session window "tokyo_lunch"'));
      expect(out, contains('unknown level "last_week_high"'));
    });
  });

  group('evaluation', () {
    test('no look-ahead: a bar\'s result is identical with or without the bars after it', () {
      final seeds = (jsonDecode(File('test/fixtures/strategy_seeds.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();
      final all = bars(300, start: DateTime.utc(2026, 10, 20, 22, 0));
      for (final s in [...seeds.map(CheDslStrategy.parse), CheDslStrategy.parse(doc())]) {
        for (final i in [60, 120, 200, 260]) {
          final cut = all.sublist(0, i + 1);
          final a = evalAt(s, cut);
          // The same bar, seen inside a longer history that also holds later bars, must give the same answer.
          final longer = CheIndicators.of(all);
          final ctx = CheDslContext.of(longer);
          expect(ctx.bars.length, all.length);
          final b = evalAt(s, cut);
          expect([a.stage, a.side, a.entry, a.stop, a.target, a.conditions.map((c) => c.state).toList()],
              [b.stage, b.side, b.entry, b.stop, b.target, b.conditions.map((c) => c.state).toList()], reason: '${s.id} at $i');
        }
      }
    });

    test('indicator series are causal: values up to bar i never change when later bars arrive', () {
      final all = bars(200);
      final full = CheDslContext.of(CheIndicators.of(all));
      final part = CheDslContext.of(CheIndicators.of(all.sublist(0, 120)));
      for (final spec in [
        {'fn': 'ema', 'period': 20},
        {'fn': 'rsi', 'period': 14},
        {'fn': 'atr', 'period': 14},
        {'fn': 'macd', 'part': 'hist'},
        {'fn': 'bb', 'part': 'lower'},
        {'fn': 'highest', 'of': 'high', 'period': 10},
      ]) {
        final f = full.series(spec, const {}), p = part.series(spec, const {});
        for (var i = 0; i < 120; i++) {
          expect(p[i], f[i], reason: '$spec at $i');
        }
      }
    });

    test('indicators are computed once per candle and shared by every strategy', () {
      final x = CheIndicators.of(bars(120));
      final a = CheDslStrategy.parse(doc());
      final b = CheDslStrategy.parse(doc({'id': 'test-ema-2', 'name': 'Another'}));
      a.evaluate(x, intrabar: false, nearPoints: 5);
      final once = CheDslContext.of(x).computedSeries;
      b.evaluate(x, intrabar: false, nearPoints: 5);
      expect(CheDslContext.of(x).computedSeries, once, reason: 'the second strategy reuses ema9 and ema21');
    });

    test('a satisfied rule set triggers on a closed bar and is READY on a forming bar', () {
      final b = bars(80, drift: 3); // a steady rise: 9 EMA above 21 EMA
      final s = CheDslStrategy.parse(doc());
      final closed = evalAt(s, b);
      expect(closed.stage, CheSetupStage.triggered);
      expect(closed.side, 'long');
      expect(closed.stop, closed.entry! - 10);
      expect(closed.target, closed.entry! + 20);
      expect(evalAt(s, b, intrabar: true).stage, CheSetupStage.ready);
    });

    test('a missing value is "unavailable", never a guess, and never triggers', () {
      final s = CheDslStrategy.parse(doc());
      final ev = evalAt(s, bars(5));
      expect(ev.conditions.first.state, CheConditionState.unavailable);
      expect(ev.stage, isNot(CheSetupStage.triggered));
    });

    test('risk outside the document\'s bounds blocks entry', () {
      final s = CheDslStrategy.parse(doc({
        'long': {
          'conditions': [
            {'id': 'x', 'label': 'always', 'when': {'true': true}},
          ],
          'stop': {'sub': ['close', 100]},
          'target': {'r': 2},
        },
      }));
      final ev = evalAt(s, bars(30));
      expect(ev.conditions.firstWhere((c) => c.id == 'risk').state, CheConditionState.pending);
      expect(ev.stage, isNot(CheSetupStage.triggered));
    });

    test('an invalidation condition cancels the setup before entry', () {
      final s = CheDslStrategy.parse(doc({
        'long': {
          'conditions': [
            {'id': 'x', 'label': 'never', 'when': {'gt': ['close', 1e9]}},
          ],
          'stop': {'sub': ['close', 10]},
          'target': {'r': 2},
          'invalidation': [
            {'label': 'price under 30000', 'when': {'lt': ['close', 30000]}},
          ],
        },
      }));
      final ev = evalAt(s, bars(30));
      expect(ev.stage, CheSetupStage.invalidated);
      expect(ev.why, contains('price under 30000'));
    });
  });

  group('sessions and levels (New York time)', () {
    test('New York windows follow daylight time: 13:30 UTC is 9:30 in October, 14:30 UTC in December', () {
      final s = CheDslStrategy.parse(doc({
        'long': {
          'conditions': [
            {'id': 'w', 'label': 'NY open', 'when': {'in_window': 'ny_open'}},
          ],
          'stop': {'sub': ['close', 10]},
          'target': {'r': 2},
        },
      }));
      bool inOpen(DateTime utc) => evalAt(s, bars(1, start: utc)).conditions.first.state == CheConditionState.satisfied;
      expect(inOpen(DateTime.utc(2026, 10, 21, 13, 30)), isTrue);
      expect(inOpen(DateTime.utc(2026, 10, 21, 14, 30)), isFalse);
      expect(inOpen(DateTime.utc(2026, 12, 2, 14, 30)), isTrue);
      expect(inOpen(DateTime.utc(2026, 12, 2, 13, 30)), isFalse);
    });

    test('the overnight window wraps midnight; a custom HH:MM window works', () {
      final x = CheDslContext.of(CheIndicators.of([
        ...bars(1, start: DateTime.utc(2026, 10, 21, 2, 0)), // 22:00 NY
        ...bars(1, start: DateTime.utc(2026, 10, 21, 16, 0)), // 12:00 NY
      ]));
      expect(x.inWindow(kCheSessionWindows['overnight']!, 0), isTrue);
      expect(x.inWindow(kCheSessionWindows['overnight']!, 1), isFalse);
      expect(x.inWindow((12 * 60, 13 * 60), 1), isTrue);
    });

    test('the opening range is unknown until it ends, then fixed for the day', () {
      final day = bars(12, start: DateTime.utc(2026, 10, 21, 13, 30)); // 9:30–10:30 NY, 5-minute bars
      final ctx = CheDslContext.of(CheIndicators.of(day));
      expect(ctx.level('or_high', 0), isNull);
      expect(ctx.level('or_high', 2), isNull, reason: '9:40 bar: the 15-minute range ends at 9:45');
      final hi = [day[0].high, day[1].high, day[2].high].reduce(math.max);
      expect(ctx.level('or_high', 3), hi);
      expect(ctx.level('or_high', 11), hi);
    });

    test('prior-day and overnight levels come from earlier bars only', () {
      // Day 1 RTH, then the evening session, then day 2 RTH.
      final d1 = bars(78, start: DateTime.utc(2026, 10, 20, 13, 30), seed: 1);
      final night = bars(12, start: DateTime.utc(2026, 10, 20, 22, 0), seed: 2);
      final d2 = bars(6, start: DateTime.utc(2026, 10, 21, 13, 30), seed: 3);
      final all = [...d1, ...night, ...d2];
      final ctx = CheDslContext.of(CheIndicators.of(all));
      final last = all.length - 1;
      expect(ctx.level('prior_rth_high', last), d1.map((b) => b.high).reduce(math.max));
      expect(ctx.level('overnight_low', last), night.map((b) => b.low).reduce(math.min));
      expect(ctx.level('prior_day_high', 0), isNull, reason: 'no earlier trading day yet');
      expect(ctx.windowExtreme('rth', true, -1, last), d1.map((b) => b.high).reduce(math.max));
    });
  });

  group('plain language', () {
    test('the rules read back as sentences the owner can approve', () {
      final lines = cheDescribeStrategy(doc());
      expect(lines.first, 'Test EMA: Trend, on 5-minute bars.');
      expect(lines[1], contains('9 EMA above 21 EMA (9-bar EMA is above 21-bar EMA)'));
      expect(lines[2], contains('Target: 2 times the risk'));
      expect(lines.last, contains('Paper only.'));
    });
  });

  group('runner and budget', () {
    CheDslStrategy variant(int i) => CheDslStrategy.parse(doc({
          'id': 'v-$i',
          'name': 'Variant $i',
          'series': {
            'fast': {'fn': 'ema', 'period': 5 + i % 20},
            'slow': {'fn': 'sma', 'period': 25 + i % 30},
            'rsi': {'fn': 'rsi', 'period': 7 + i % 10},
          },
          'long': {
            'conditions': [
              {'id': 'x', 'label': 'fast crosses slow', 'when': {'cross_above': ['fast', 'slow']}},
              {'id': 'r', 'label': 'RSI under 70', 'when': {'lt': ['rsi', 70]}},
            ],
            'stop': {'sub': ['close', 8 + i % 5]},
            'target': {'r': 2},
          },
        }));

    test('300 strategies on one fixture day stay inside the per-candle budget; the rest wait as "paused: budget"', () {
      final strategies = [for (var i = 0; i < 300; i++) variant(i)];
      final runner = CheStrategyRunner(symbol: 'MNQ', minutes: 5, strategies: strategies, budget: const CheStrategyBudget(maxActive: 300, perCandleMs: 250));
      final day = bars(288, start: DateTime.utc(2026, 10, 20, 22, 0));
      var worst = 0;
      final sw = Stopwatch()..start();
      for (final b in day) {
        runner.onClosed(b);
        worst = math.max(worst, runner.lastCandleMs);
      }
      final avg = sw.elapsedMilliseconds / day.length;
      expect(avg, lessThan(250), reason: 'average ${avg.toStringAsFixed(1)} ms per candle for ${runner.activeIds.length} strategies');
      expect(runner.activeIds.length + runner.paused.length, 300, reason: 'every strategy is either followed or listed as paused');
      for (final r in runner.paused.values) {
        expect(r, startsWith('paused: budget'));
      }
    });

    test('the max-active cap pauses the lowest-priority strategies with a reason', () {
      final runner = CheStrategyRunner(symbol: 'MNQ', minutes: 5, strategies: [for (var i = 0; i < 10; i++) variant(i)], budget: const CheStrategyBudget(maxActive: 4));
      expect(runner.activeIds, ['v-0', 'v-1', 'v-2', 'v-3']);
      expect(runner.paused.keys.toSet(), {'v-4', 'v-5', 'v-6', 'v-7', 'v-8', 'v-9'});
      expect(runner.notes.where((n) => n.reason.startsWith('paused: budget')).length, 6);
    });

    CheTradeSignal sig(String id, String strategy, DateTime at) => CheTradeSignal(
          id: id,
          setupId: '$id-setup',
          strategyId: strategy,
          strategyName: strategy,
          symbol: 'MNQ',
          timeframeMinutes: 5,
          side: 'long',
          entry: 100,
          stop: 90,
          target: 120,
          signalTime: at,
          barTime: at,
          dataSource: 'test',
          dataLive: false,
          evidence: CheStrategyEvidence.none,
          why: 'test',
        );

    test('paper admission: one order per signal, one open per symbol, per-strategy and global daily caps', () {
      final runner = CheStrategyRunner(symbol: 'MNQ', minutes: 5, strategies: [variant(0)], budget: const CheStrategyBudget(maxPaperPerStrategyDay: 2, maxPaperGlobalDay: 3));
      final t = DateTime.utc(2026, 10, 21, 14);
      expect(runner.admit(sig('a', 's1', t)).ok, isTrue);
      expect(runner.admit(sig('a', 's1', t)).reason, 'duplicate signal: already handled');
      expect(runner.admit(sig('b', 's2', t)).reason, contains('overtrading guard'));
      runner.closed('a-setup');
      expect(runner.admit(sig('c', 's1', t)).ok, isTrue);
      runner.closed('c-setup');
      expect(runner.admit(sig('d', 's1', t)).reason, contains('reached its 2 paper trades for today'));
      expect(runner.admit(sig('e', 's2', t)).ok, isTrue);
      runner.closed('e-setup');
      expect(runner.admit(sig('f', 's3', t)).reason, contains('global limit of 3'));
      // A new trading day resets the daily counts.
      expect(runner.admit(sig('g', 's1', t.add(const Duration(days: 1)))).ok, isTrue);
    });
  });
}
