import 'dart:convert';
import 'dart:io';

import 'package:chey/rooms/che_strategy_library_page.dart';
import 'package:chey/trading/che_strategy_library.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final _macd = (jsonDecode(File('test/fixtures/strategy_seeds.json').readAsStringSync()) as List).cast<Map<String, dynamic>>().firstWhere((d) => d['id'] == 'macd-signal-cross');

Map<String, dynamic> _entry(String id, String name, String stage, {String kind = 'strategy', String category = 'trend', bool enabled = true, String approval = 'not_needed', Map<String, dynamic>? definition, Map<String, dynamic> results = const {}, String? notRunning, String engine = 'trading_evidence'}) => {
      'id': id, 'kind': kind, 'name': name, 'category': category, 'lifecycle': stage, 'engine': engine, 'origin': 'built-in',
      'enabled': enabled, 'favorite': false, 'approval': approval, 'version': 1, 'results': results, 'not_running': notRunning,
      'rules': ['rule one'], 'sources': [{'type': 'repo_code', 'title': 'trading_evidence.js'}], 'timeframes': ['5m'],
      ...?definition == null ? null : {'definition': definition},
    };

Map<String, dynamic> _view() => {
      'counts': {'named': 4, 'market_context_models': 1, 'executable_rules': 3, 'backtested': 1, 'forward_tested': 0, 'paper_active': 1, 'disabled_or_unsupported': 1},
      'budget': {'max_active': 60},
      'total': 5,
      'entries': [
        _entry('ema-pullback-5m', 'Trend pullback to the 20 EMA', 'paper_active', results: {'backtest': {'trades': 412, 'source': 'trading_research stored units'}}),
        _entry('vwap-revert-5m', 'VWAP 2-sigma reversion', 'backtested', category: 'reversal', results: {'backtest': {'trades': 133}}),
        _entry('macd-signal-cross', 'MACD signal-line cross', 'implemented', category: 'momentum', enabled: false, approval: 'pending_owner', definition: _macd, engine: 'dsl', notRunning: "Waiting for the owner's approval before it may paper trade."),
        _entry('dirty-trez', 'Dirty Trez', 'discovered', category: 'other', enabled: false, engine: 'none', notRunning: 'Only a name or idea.'),
        _entry('amd-power-of-three', 'AMD / Power of Three', 'rules_documented', kind: 'market_context', category: 'ict_smc', enabled: false, engine: 'none'),
      ],
    };

final _list = find.byWidgetPredicate((w) => w is Scrollable && w.axisDirection == AxisDirection.down);

Future<void> see(WidgetTester tester, Finder f) async {
  await tester.scrollUntilVisible(f, 200, scrollable: _list.first);
  await tester.ensureVisible(f.first);
  await tester.pumpAndSettle();
}

void main() {
  late List<(String, Map<String, dynamic>)> posts;
  late List<String> spoken;

  Future<void> pump(WidgetTester tester, {Size size = const Size(390, 844)}) async {
    tester.view.physicalSize = size * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.resetPhysicalSize);
    posts = [];
    spoken = [];
    final client = MockClient((r) async {
      if (r.method == 'GET') return http.Response(jsonEncode(_view()), 200);
      final action = r.url.pathSegments.last;
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      posts.add((action, body));
      return http.Response(jsonEncode({'ok': true}), 200);
    });
    await tester.pumpWidget(MaterialApp(
      home: CheStrategyLibraryPage(client: CheStrategyLibraryClient(baseUrl: () => 'https://che.test', headers: () => const {}, client: client), onRead: spoken.add),
    ));
    await tester.pumpAndSettle();
  }

  testWidgets('shows the counts, the sections and every stage as words, and stays silent on open', (tester) async {
    await pump(tester);
    expect(find.text('Strategy Library'), findsOneWidget);
    expect(find.text('Live trading is off.'), findsOneWidget);
    await see(tester, find.text('Testing now (paper) (1)'));
    expect(find.text('PAPER ACTIVE'), findsWidgets);
    await see(tester, find.text('Executable strategies (2)'));
    await see(tester, find.text('BACKTESTED'));
    await see(tester, find.text('IMPLEMENTED'));
    await see(tester, find.textContaining('Strategy Discovery'));
    expect(find.text('Strategy Discovery: ideas, not implemented and not validated (2)'), findsOneWidget);
    expect(spoken, isEmpty, reason: 'Read Aloud is manual');
  });

  testWidgets('a pending custom strategy says so, and approving shows its exact rules before the confirm', (tester) async {
    await pump(tester);
    await see(tester, find.textContaining('Waiting for your approval'));
    await tester.tap(find.text('MACD signal-line cross'));
    await tester.pumpAndSettle();
    expect(find.text('Rules (exactly what runs)'), findsOneWidget);
    await tester.tap(find.text('Approve for paper'));
    await tester.pumpAndSettle();
    expect(find.text('Approve MACD signal-line cross for paper testing?'), findsOneWidget);
    expect(find.textContaining('Long when: MACD below zero'), findsOneWidget);
    expect(find.textContaining('Live trading stays off'), findsOneWidget);
    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    expect(posts, isEmpty, reason: '"Not now" sends nothing');
  });

  testWidgets('approving sends confirm: true only after the owner\'s confirm', (tester) async {
    await pump(tester);
    await see(tester, find.text('MACD signal-line cross'));
    await tester.tap(find.text('MACD signal-line cross'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Approve for paper'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Approve for paper'));
    await tester.pumpAndSettle();
    expect(posts.single.$1, 'approve');
    expect(posts.single.$2, {'id': 'macd-signal-cross', 'confirm': true});
  });

  testWidgets('search and category filters narrow the list', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'vwap');
    await tester.pumpAndSettle();
    await see(tester, find.text('VWAP 2-sigma reversion'));
    expect(find.text('Trend pullback to the 20 EMA'), findsNothing);
    await tester.enterText(find.byType(TextField), '');
    await tester.tap(find.widgetWithText(ChoiceChip, 'Market context'));
    await tester.pumpAndSettle();
    expect(find.text('Trend pullback to the 20 EMA'), findsNothing);
    await see(tester, find.text('AMD / Power of Three'));
    expect(find.text('AMD / Power of Three'), findsOneWidget);
  });

  testWidgets('selecting two strategies compares them from recorded results only', (tester) async {
    await pump(tester);
    await see(tester, find.bySemanticsLabel('Select Trend pullback to the 20 EMA to compare'));
    await tester.tap(find.bySemanticsLabel('Select Trend pullback to the 20 EMA to compare'));
    await see(tester, find.bySemanticsLabel('Select VWAP 2-sigma reversion to compare'));
    await tester.tap(find.bySemanticsLabel('Select VWAP 2-sigma reversion to compare'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Compare 2'));
    await tester.pumpAndSettle();
    expect(find.text('Compare 2 strategies'), findsOneWidget);
    expect(find.text('Backtest trades: 412'), findsOneWidget);
    expect(find.text('Backtest trades: 133'), findsOneWidget);
    expect(find.text('Forward paper trades: none recorded'), findsNWidgets(2));
  });

  testWidgets('Read Aloud speaks the summary only when pressed; favorite sends the action', (tester) async {
    await pump(tester);
    await tester.tap(find.byTooltip('Read aloud'));
    expect(spoken.single, contains('4 named strategies and 1 market-context models'));
    expect(spoken.single, contains('Live trading is off.'));
    await see(tester, find.byTooltip('Favorite VWAP 2-sigma reversion'));
    await tester.tap(find.byTooltip('Favorite VWAP 2-sigma reversion'));
    await tester.pumpAndSettle();
    expect(posts.single.$1, 'favorite');
    expect(posts.single.$2, {'id': 'vwap-revert-5m'});
  });

  testWidgets('every card has a spoken label with its stage and live status', (tester) async {
    await pump(tester);
    final h = tester.ensureSemantics();
    await see(tester, find.text('Trend pullback to the 20 EMA'));
    expect(find.bySemanticsLabel(RegExp(r'^Trend pullback to the 20 EMA\. Strategy, Trend\. Stage: PAPER ACTIVE, it is paper trading now\. 412 recorded backtest trades\. Live status: paper trading\.$')), findsOneWidget);
    await see(tester, find.text('MACD signal-line cross'));
    expect(find.bySemanticsLabel(RegExp(r'MACD signal-line cross\..*Waiting for your approval\. Live status: disabled\.')), findsOneWidget);
    h.dispose();
  });

  testWidgets('fits a phone in landscape and a tablet without overflow', (tester) async {
    for (final size in const [Size(844, 390), Size(1024, 1366)]) {
      await pump(tester, size: size);
      expect(tester.takeException(), isNull, reason: '$size');
    }
  });
}
