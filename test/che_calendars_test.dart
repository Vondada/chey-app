// The Trading P&L calendar and the Office calendar (owner, 2026-10-24), driven by the Worker's own answers
// (test/fixtures/calendars, written by tool/dump_calendar_fixtures.mjs from server/cloudflare/che_calendars.js).
import 'dart:convert';
import 'dart:io';

import 'package:chey/office/che_office_calendar.dart';
import 'package:chey/rooms/che_strategy_learning.dart';
import 'package:chey/trading/che_trade_replay.dart';
import 'package:chey/trading/che_trading_calendar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

String _fixture(String name) => File('test/fixtures/calendars/$name.json').readAsStringSync();

void main() {
  final asked = <Uri>[];

  MockClient worker() => MockClient((r) async {
        asked.add(r.url);
        final q = r.url.queryParameters;
        if (r.url.path == '/api/trading/calendar') {
          if (q.containsKey('day')) return http.Response(_fixture('trading_day'), 200);
          if (q['source'] == 'sim') return http.Response(_fixture('trading_empty'), 200);
          return http.Response(_fixture('trading_month'), 200);
        }
        if (r.url.path == '/api/trading/learning') return http.Response(_fixture('learning'), 200);
        if (r.url.path == '/api/office/calendar') return http.Response(_fixture(q.containsKey('day') ? 'office_day' : 'office_month'), 200);
        return http.Response(jsonEncode({'ok': false, 'detail': 'not found'}), 404);
      });

  Widget app(Widget home) => MaterialApp(theme: ThemeData(splashFactory: NoSplash.splashFactory), home: home);

  setUp(asked.clear);

  testWidgets('trading calendar: the month from stored rows, each day labelled for VoiceOver, weekly subtotal, no voice on open', (tester) async {
    tester.view.physicalSize = const Size(1179, 6000);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final semantics = tester.ensureSemantics();
    final spoken = <String>[];
    await tester.pumpWidget(app(CheTradingCalendarPage(baseUrl: () => 'https://che.test', headers: () => const {}, client: worker(), onRead: spoken.add, initialMonth: '2026-09')));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'silent until Read This is pressed');
    expect(asked.first.queryParameters, {'source': 'paper', 'month': '2026-09'});
    expect(find.text('September 2026'), findsOneWidget);
    expect(find.textContaining('4 closed trades, 2 wins, 2 losses'), findsOneWidget);
    expect(find.textContaining('−\$981.00'), findsWidgets);
    expect(find.bySemanticsLabel('Tuesday, September 22: net −\$1,016.00, 3 trades, 1 wins, 2 losses.'), findsOneWidget);
    expect(find.bySemanticsLabel('Wednesday, September 23: no closed trades.'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Week of Monday, September 21: net −\$981\.00, 4 trades')), findsOneWidget);
    await tester.tap(find.byTooltip('Read this'));
    expect(spoken.single, contains('net −\$981.00'));
    semantics.dispose();
  });

  testWidgets('tapping a day lists its real trades with the audit line, and a trade opens its replay by its ledger ID', (tester) async {
    tester.view.physicalSize = const Size(1179, 6000);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(app(CheTradingCalendarPage(baseUrl: () => 'https://che.test', headers: () => const {}, client: worker(), initialMonth: '2026-09')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('calendar_day_2026-09-22')));
    await tester.pumpAndSettle();
    expect(asked.last.queryParameters, {'source': 'paper', 'day': '2026-09-22'});
    expect(find.textContaining('3 trades, 1 wins, 2 losses, net −\$1,016.00'), findsOneWidget);
    expect(find.textContaining('Audit: 3 rows add up to −\$1,016.00'), findsOneWidget);
    final first = find.byKey(const Key('day_trade_T0J5YUMZMA043C'));
    expect(first, findsOneWidget);
    await tester.tap(first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    final page = tester.widget<CheTradeReplayPage>(find.byType(CheTradeReplayPage));
    expect(page.tradeId, 'T0J5YUMZMA043C');
    semantics.dispose();
  });

  testWidgets('sources stay apart and months move: Simulation is its own request, an empty month says so and shows nothing made up', (tester) async {
    tester.view.physicalSize = const Size(1179, 6000);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(app(CheTradingCalendarPage(baseUrl: () => 'https://che.test', headers: () => const {}, client: worker(), initialMonth: '2026-09')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('calendar_source_sim')));
    await tester.pumpAndSettle();
    expect(asked.last.queryParameters['source'], 'sim');
    expect(find.textContaining('no trade closed in September 2026'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'September 22: net')), findsNothing);
    await tester.tap(find.byKey(const Key('calendar_next')));
    await tester.pumpAndSettle();
    expect(asked.last.queryParameters, {'source': 'sim', 'month': '2026-10'});
    await tester.tap(find.byKey(const Key('calendar_prev')));
    await tester.pumpAndSettle();
    expect(asked.last.queryParameters['month'], '2026-08');
    semantics.dispose();
  });

  testWidgets('Is CHE improving: 7, 30 and 90-day windows beside the period before, insufficient evidence said plainly', (tester) async {
    tester.view.physicalSize = const Size(1179, 6000);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final semantics = tester.ensureSemantics();
    final data = jsonDecode(_fixture('learning')) as Map<String, dynamic>;
    await tester.pumpWidget(app(Scaffold(body: SingleChildScrollView(child: CheLearningWindows(data: data)))));
    expect(find.textContaining('INSUFFICIENT EVIDENCE'), findsWidgets);
    expect(find.textContaining('at least 30 trades'), findsOneWidget);
    expect(find.byKey(const Key('learning_paper_orb-5m')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^30 days: 2 trades, net')), findsWidgets);
    semantics.dispose();
  });

  testWidgets('Office calendar: days colored by real outcomes; a day opens its jobs with receipts and errors, filterable', (tester) async {
    tester.view.physicalSize = const Size(1179, 6000);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(app(CheOfficeCalendarPage(baseUrl: () => 'https://che.test', headers: () => const {}, client: worker(), initialMonth: '2026-09')));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('Tuesday, September 22: 1 done, 0 active, 0 pending, 1 failed.'), findsOneWidget);
    expect(find.bySemanticsLabel('Friday, September 25: nothing recorded.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('calendar_day_2026-09-22')));
    await tester.pumpAndSettle();
    expect(find.textContaining('1 done, 0 active, 0 pending, 1 failed; finished by Nova 1'), findsOneWidget);
    expect(find.text('Write the release notes'), findsOneWidget);
    expect(find.textContaining('Notes saved to the mailbox.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('office_filter_failed')));
    await tester.pumpAndSettle();
    expect(find.text('Write the release notes'), findsNothing);
    await tester.tap(find.byKey(const Key('office_item_t2')));
    await tester.pumpAndSettle();
    expect(find.text('Error: GitHub answered 403'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('a Worker failure is said plainly, never an empty calendar presented as real', (tester) async {
    final failing = MockClient((r) async => http.Response(jsonEncode({'ok': false, 'detail': 'Choose a source: sim, paper or broker.'}), 400));
    await tester.pumpWidget(app(CheTradingCalendarPage(baseUrl: () => 'https://che.test', headers: () => const {}, client: failing)));
    await tester.pumpAndSettle();
    expect(find.textContaining('The calendar could not be read: Choose a source'), findsOneWidget);
    expect(find.byKey(const Key('calendar_summary')), findsNothing);
  });
}
