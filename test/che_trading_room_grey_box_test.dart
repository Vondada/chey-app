// The owner's grey boxes (2026-11-06), reproduced: the real Trading room in a rooms sheet with CHE's theme at iPhone size.
// Before every ExpansionTile had a PageStorageKey, scrolling saved the list's offset (a double) in the slot an
// ExpansionTile then read as its open state, and it threw "type 'double' is not a subtype of type 'bool?'"
// (diagnostic run 42154237391). A release build draws that as a grey box.
import 'dart:convert';

import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/rooms/che_trading_room.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

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
  expect(e, isNull, reason: '$where: $e');
}

void main() {
  testWidgets('the owner\'s grey box: the Trading room in the rooms sheet, scrolled and re-shown, builds every expandable section', (tester) async {
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
    await tester.drag(find.byKey(const Key('trading_room_list')), const Offset(0, -800));
    await tester.pump(const Duration(milliseconds: 500));
    _noError(tester, 'after scroll');
    await tester.tap(find.text('Brain'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(find.text('Trading'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 500));
    _noError(tester, 'after tab switch');
    // Scroll to the crypto desk's expandable section: it builds, and nothing throws on the way.
    await tester.scrollUntilVisible(find.textContaining('Recent simulated trades'), 200,
        scrollable: find.descendant(of: find.byKey(const Key('trading_room_list')), matching: find.byType(Scrollable)).first);
    await tester.pump(const Duration(milliseconds: 300));
    _noError(tester, 'scrolled to the section');
    expect(find.textContaining('Recent simulated trades'), findsOneWidget);
  });
}
