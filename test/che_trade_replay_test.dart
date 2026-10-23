// Trade evidence and replay (owner mission, 2026-10-23, Priority 5): the replay never shows a bar before it has
// closed, markers appear only once they happened, the controls move the clock as labelled, a trade without
// stored bars says so and draws nothing, and the page is silent until Read This is pressed.
import 'dart:convert';

import 'package:chey/trading/che_trade_replay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final _start = DateTime.utc(2026, 10, 22, 14);
Map<String, dynamic> _bar(int i, {double c = 21000}) => {
      't': _start.add(Duration(minutes: 5 * i)).toIso8601String(),
      'o': c + i, 'h': c + i + 5, 'l': c + i - 5, 'c': c + i + 1, 'v': 1,
    };

Map<String, dynamic> _json({bool bars = true}) => {
      'ok': true,
      'id': 'T0K3J9QW1ZX7AB',
      'label': 'FORWARD PAPER',
      'execution_label': 'Forward paper (CHE engine)',
      'strategy': 'ema-pullback-5m',
      'symbol': 'MNQ',
      'timeframe': '5m',
      'side': 'long',
      'signal': {'time': _start.add(const Duration(minutes: 10)).toIso8601String(), 'why': 'pullback to the 20 EMA'},
      'entry': {'time': _start.add(const Duration(minutes: 15)).toIso8601String(), 'price': 21003.5},
      'exit': {'time': _start.add(const Duration(minutes: 35)).toIso8601String(), 'price': 21020.0, 'reason': 'target'},
      'stop': 20993.5,
      'target': 21023.5,
      'outcome': {'result': 'win', 'r': 1.62, 'net': 32.5},
      'bars': bars ? [for (var i = 0; i < 12; i++) _bar(i)] : <Object>[],
      'bars_source': bars ? {'label': 'CHE forward feed Yahoo MNQ=F (DELAYED)'} : null,
      'no_data': bars ? null : 'No recorded market data for this trade.',
      'replay': {'timeframe_ms': 300000},
      'links': {'brain': {'ref': 'trade:T0K3J9QW1ZX7AB'}},
    };

void main() {
  test('the replay frame never contains a bar that had not closed, and markers appear only once they happened', () {
    final e = CheTradeEvidence.fromJson(_json())!;
    expect(e.bars.length, 12);
    for (var m = 0; m <= 65; m++) {
      final clock = _start.add(Duration(minutes: m));
      final f = cheReplayFrame(e, clock);
      expect(f.bars.every((b) => !b.t.add(const Duration(minutes: 5)).isAfter(clock)), isTrue, reason: 'no forming or future bar at minute $m');
      expect(f.bars.length, (m ~/ 5).clamp(0, 12), reason: 'exactly the closed bars at minute $m');
      expect(f.signal, m >= 15, reason: 'the signal is known when its bar closes');
      expect(f.entry, m >= 15, reason: 'the fill is at the next bar open');
      expect(f.exit, m >= 40, reason: 'the exit is known only after its bar closes');
    }
  });

  test('missing values stay unknown, never 0', () {
    final j = _json()..remove('stop')..remove('outcome');
    final e = CheTradeEvidence.fromJson(j)!;
    expect(e.stop, isNull);
    expect(e.net, isNull);
    expect(cheTradeSpoken(e), contains('stop unknown'));
    expect(cheTradeSpoken(e), contains('unknown'));
    expect(CheTradeEvidence.fromJson({'ok': false, 'error': 'x'}), isNull);
  });

  testWidgets('controls: restart, play, pause, +10s, speed and scrubbing move the clock as labelled; silent on open', (tester) async {
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(theme: ThemeData(splashFactory: NoSplash.splashFactory), home: CheTradeReplayPage(
      tradeId: 'T0K3J9QW1ZX7AB', baseUrl: () => 'https://che.test', headers: () => const {}, onRead: spoken.add,
      initial: CheTradeEvidence.fromJson(_json()),
    )));
    await tester.pump();
    expect(find.text('FORWARD PAPER'), findsOneWidget);
    expect(find.byKey(const Key('trade_replay_chart')), findsOneWidget);
    expect(spoken, isEmpty, reason: 'nothing speaks on open');
    String clock() => (tester.widget(find.byKey(const Key('trade_replay_clock'))) as Text).data!;
    expect(clock(), contains('12 of 12 bars'), reason: 'opens on the whole trade');

    await tester.tap(find.byKey(const Key('trade_replay_restart')));
    await tester.pump();
    expect(clock(), contains('0 of 12 bars'));

    await tester.tap(find.byKey(const Key('trade_replay_play')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1050));
    expect(clock(), contains('1 of 12 bars'), reason: 'at 1× one bar per second');
    await tester.tap(find.byKey(const Key('trade_replay_pause')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    expect(clock(), contains('1 of 12 bars'), reason: 'paused means the clock stops');

    await tester.tap(find.byKey(const Key('trade_replay_skip')));
    await tester.pump();
    expect(clock(), contains('11 of 12 bars'), reason: '+10s at 1× skips ten bars');

    await tester.tap(find.byKey(const Key('trade_replay_speed')));
    await tester.pump();
    expect(find.text('2×'), findsOneWidget);
    await tester.tap(find.byKey(const Key('trade_replay_restart')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('trade_replay_skip')));
    await tester.pump();
    expect(clock(), contains('12 of 12 bars'), reason: 'at 2× ten seconds is twenty bars, capped at the end');

    final slider = tester.widget<Slider>(find.byKey(const Key('trade_replay_scrub')));
    slider.onChanged!(0.5);
    await tester.pump();
    expect(clock(), contains('6 of 12 bars'), reason: 'halfway along the timeline');

    await tester.tap(find.byKey(const Key('trade_replay_read')));
    expect(spoken.single, startsWith('Trade T0K3J9QW1ZX7AB, FORWARD PAPER. ema-pullback-5m long on MNQ 5m.'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('no stored bars: says so and draws no chart or replay controls', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: ThemeData(splashFactory: NoSplash.splashFactory), home: CheTradeReplayPage(
      tradeId: 'T0K3J9QW1ZX7AB', baseUrl: () => 'https://che.test', headers: () => const {},
      initial: CheTradeEvidence.fromJson(_json(bars: false)),
    )));
    await tester.pump();
    expect(find.text('No recorded market data for this trade.'), findsOneWidget);
    expect(find.byKey(const Key('trade_replay_chart')), findsNothing);
    expect(find.byKey(const Key('trade_replay_play')), findsNothing);
    expect(find.text('Brain evidence'), findsOneWidget);
  });

  testWidgets('loads the trade by its ID from the Worker; an unknown ID shows the Worker\'s answer', (tester) async {
    final asked = <Uri>[];
    final client = MockClient((r) async {
      asked.add(r.url);
      final id = r.url.queryParameters['id'];
      return http.Response(jsonEncode(id == 'T0K3J9QW1ZX7AB' ? {'ok': true, 'trade': _json()} : {'ok': false, 'error': 'No CHE trade has the ID $id.'}), 200);
    });
    await tester.pumpWidget(MaterialApp(theme: ThemeData(splashFactory: NoSplash.splashFactory), home: CheTradeReplayPage(tradeId: 'T0K3J9QW1ZX7AB', baseUrl: () => 'https://che.test', headers: () => const {}, client: client)));
    await tester.pumpAndSettle();
    expect(asked.single.queryParameters, {'view': 'trade', 'id': 'T0K3J9QW1ZX7AB'});
    expect(find.text('FORWARD PAPER'), findsOneWidget);
    await tester.pumpWidget(MaterialApp(theme: ThemeData(splashFactory: NoSplash.splashFactory), home: CheTradeReplayPage(tradeId: 'TNOPE', baseUrl: () => 'https://che.test', headers: () => const {}, client: client)));
    await tester.pumpAndSettle();
    expect(find.text('No CHE trade has the ID TNOPE.'), findsOneWidget);
  });
}
