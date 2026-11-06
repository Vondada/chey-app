// Diagnostic only (never merged): find the exception behind the owner's grey boxes (2026-11-06) by rendering the real
// widgets the way the app does. A test fails with the exception text when one is thrown, so CI prints it.
import 'dart:convert';
import 'dart:io';

import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/rooms/che_trading_room.dart';
import 'package:chey/trading/che_crypto_desk.dart';
import 'package:chey/trading/che_market_feed.dart';
import 'package:chey/trading/che_setup_board.dart';
import 'package:chey/trading/che_setup_desk.dart';
import 'package:chey/trading/che_setup_engine.dart';
import 'package:chey/trading/che_trade_alerts.dart';
import 'package:chey/trading/che_trade_audit.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> _desk() => {
      'enabled': true,
      'feeds': [
        {'coin': 'BTC', 'tf': '5m', 'status': 'LIVE', 'last_bar': '2026-11-05T20:40:00Z', 'last_close': 75966.84},
        {'coin': 'ETH', 'tf': '5m', 'status': 'LIVE', 'last_bar': '2026-11-05T20:40:00Z', 'last_close': 2236.95},
      ],
      'schedule': {'last_run_at': '2026-11-05T20:45:00Z', 'next_at': '2026-11-05T20:50:00Z'},
      'budget': {'requests': 129, 'limit': 3000},
      'simulated': {
        'open_positions': [], 'closed_trades': 338, 'net_pnl': -2687.54, 'expectancy_r': -6.0822, 'enough_data': true,
        'recent': [
          for (var i = 0; i < 10; i++)
            {'coin': 'BTC', 'tf': '5m', 'strategy': 'ema-pullback-5m', 'side': 'long', 'entry_time': '2026-10-28T08:15:00.000Z', 'entry': 75000.5, 'exit_time': '2026-10-28T09:05:00.000Z', 'exit': 74800.0, 'reason': 'stop', 'net_pnl': -12.1, 'costs': {'spread': 1, 'slippage': 2, 'commissions': 0, 'fees': 9}, 'why': 'pulled back'},
        ],
      },
      'research': [],
      'funding': {'status': 'MISSING'},
      'spoken': 'Orion crypto desk.',
    };

final _client = MockClient((r) async {
  if (r.url.path == '/api/trading/crypto') return http.Response(jsonEncode(_desk()), 200);
  if (r.url.path == '/api/trading/chart') return http.Response(jsonEncode({'ok': true, 'bars': [], 'markers': [], 'feed': {'status': 'DELAYED'}}), 200);
  return http.Response(jsonEncode({'ok': true}), 200);
});

void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(1179, 2556);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

void _noError(WidgetTester tester, String where) {
  final e = tester.takeException();
  expect(e, isNull, reason: 'DIAG $where: $e');
}

Future<CheSetupDesk> _setupDesk(int bars) async {
  SharedPreferences.setMockInitialValues({});
  final dir = Directory.systemTemp.createTempSync('diag');
  final audit = CheTradeAudit(file: () async => File('${dir.path}/a.jsonl'));
  final alerts = CheTradeAlerts(audit: audit, haptic: (n) async {});
  alerts.speak = (t) async {};
  var now = DateTime.utc(2026, 11, 5, 20);
  final desk = CheSetupDesk(alerts: alerts, audit: audit, clock: () => now = now.add(const Duration(seconds: 2)), strategies: [cheBuiltInSetupStrategy('ema-pullback-5m')!]);
  for (final e in desk.engines.values) {
    e
      ..dataSource = 'Rithmic live — MNQZ6'
      ..dataLive = true;
  }
  desk.snapshot = const CheMarketSnapshot(symbol: 'MNQZ6', exchange: 'CME', source: 'rithmic', sourceLabel: 'Rithmic live — MNQZ6', connection: CheFeedConnection.connected, statusLabel: 'Connected', isLive: true, lastPrice: 27141, lastTradeAt: null, lastUpdate: null);
  final t0 = DateTime.utc(2026, 11, 5, 20);
  for (var i = 0; i < bars; i++) {
    final p = 27100 + 2.0 * i;
    desk.ingest(CheCandle(start: t0.add(Duration(minutes: i)), minutes: 1, open: p - 1, high: p + 3, low: p - 3, close: p, volume: 100, trades: 10, closed: true, source: 'rithmic', symbol: 'MNQZ6'));
  }
  return desk;
}

void main() {
  for (final cheTheme in [true, false]) {
    testWidgets('diag crypto desk, ${cheTheme ? 'CheTheme' : 'ThemeData.dark'}', (tester) async {
      _phone(tester);
      await tester.pumpWidget(MaterialApp(theme: cheTheme ? CheTheme.dark() : ThemeData.dark(), home: Scaffold(body: SingleChildScrollView(child: CheCryptoDeskPanel(baseUrl: () => 'https://che.example', headers: () => const {}, client: _client)))));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      _noError(tester, 'crypto desk');
      expect(find.textContaining('Recent simulated trades'), findsOneWidget);
    });

    testWidgets('diag setup board, 10 bars, ${cheTheme ? 'CheTheme' : 'ThemeData.dark'}', (tester) async {
      _phone(tester);
      final desk = await _setupDesk(10);
      await tester.pumpWidget(MaterialApp(theme: cheTheme ? CheTheme.dark() : ThemeData.dark(), home: Scaffold(body: SingleChildScrollView(child: CheSetupBoard(desk: desk)))));
      await tester.pump();
      _noError(tester, 'setup board');
      expect(find.textContaining('Timeline ('), findsWidgets);
    });
  }

  testWidgets('diag trading room crypto section in a bottom sheet inside a TabBarView, scrolled and re-shown', (tester) async {
    _phone(tester);
    await tester.pumpWidget(MaterialApp(
      theme: CheTheme.dark(),
      home: Builder(builder: (context) => Scaffold(body: Center(child: ElevatedButton(
        onPressed: () => showModalBottomSheet<void>(context: context, isScrollControlled: true, builder: (_) => SizedBox(
          height: 700,
          child: DefaultTabController(length: 2, child: Column(children: [
            const TabBar(tabs: [Tab(text: 'Brain'), Tab(text: 'Trading')]),
            Expanded(child: TabBarView(children: [
              const Center(child: Text('brain')),
              Theme(data: CheTheme.dark(), child: Material(child: CheTradingRoom(baseUrl: () => 'https://che.example', headers: () => const {}, onAsk: (_) {}, client: _client, initialSection: CheTradingSection.crypto))),
            ])),
          ])),
        )),
        child: const Text('open'),
      )))),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 5));
    await tester.tap(find.text('Trading'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 500));
    _noError(tester, 'sheet open');
    await tester.drag(find.byType(Scrollable).last, const Offset(0, -800));
    await tester.pump(const Duration(milliseconds: 500));
    _noError(tester, 'after scroll');
    await tester.tap(find.text('Brain'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(find.text('Trading'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 500));
    _noError(tester, 'after tab switch');
    expect(find.textContaining('Recent simulated trades'), findsWidgets);
  });
}
