import 'package:chey/rooms/che_strategy_learning.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('strategy sample is unique and never enables live trading; source records stay separate', (tester) async {
    final said = <String>[];
    var replays = 0;
    tester.view.physicalSize = const Size(440, 956);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: CheStrategyLearningDashboard(
      data: {
        'daily_report': '14 unique EMA outcomes. Live trading remains disabled.',
        'research': {'target_per_strategy': 30},
        'strategies': [{
          'id': 'ema-pullback-5m', 'name': 'EMA Pullback', 'featured': true, 'resolution': '5m',
          'stage': 'Collecting forward evidence', 'strategy_version': 'v-test', 'params': {'target_r': 2},
          'forward': {'trades': 14, 'wins': 9, 'losses': 5, 'win_rate': 64.29, 'expectancy_r': 0.6, 'net_pnl': 95.0, 'profit_factor': 1.8, 'max_drawdown': 25.0},
          'progress': {'fraction': 14 / 30}, 'today': {'trades': 2}, 'duplicates': 14,
          'historical': {'trades': 80, 'wins': 50, 'losses': 30, 'expectancy_r': 0.2, 'net_pnl': 200},
          'out_of_sample': {'trades': 40, 'wins': 24, 'losses': 16, 'expectancy_r': 0.1, 'net_pnl': 80},
          'next_milestone': 'Historical validation',
          'milestones': [{'label': 'Owner approval', 'status': 'blocked', 'detail': 'No live approval.'}],
        }],
      }, onAsk: said.add, onResearch: () => replays++,
    )))));
    await tester.pumpAndSettle();
    expect(find.text('14 / 30 unique forward trades'), findsOneWidget);
    expect(find.textContaining('14 duplicate variant outcomes excluded'), findsOneWidget);
    expect(find.textContaining('Live locked'), findsOneWidget);
    expect(find.text(r'$95.00'), findsOneWidget);
    expect(tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator)).value, closeTo(14 / 30, 0.0001));
    await tester.tap(find.text('Read learning report'));
    expect(said.single, contains('strategy learning'));
    await tester.tap(find.text('Replay available history'));
    expect(replays, 1);
    expect(find.textContaining('Unlock live'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
