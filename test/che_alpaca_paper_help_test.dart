import 'dart:convert';

import 'package:chey/che_ui/che_screen_awareness.dart';
import 'package:chey/che_ui/che_screen_guide.dart';
import 'package:chey/rooms/che_alpaca_paper_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('guide uses actual report and explicitly declines to invent unregistered controls', () {
    const report = CheScreenReport(
      page: 'Trading Room',
      controls: ['Alpaca paper orders', 'Live market chart'],
      detail: 'Alpaca stocks and MNQ futures are separate sources.',
    );
    expect(CheScreenGuide.description(report, 'Other page'), contains('1. Alpaca paper orders'));
    expect(CheScreenGuide.description(report, 'Other page'), contains('separate sources'));
    final missing = CheScreenGuide.description(null, 'Other page');
    expect(missing, contains('not registered'));
    expect(missing, isNot(contains('Alpaca paper orders')));
  });

  testWidgets('Alpaca panel displays only the broker-confirmed filled quantity and receipt', (tester) async {
    final requests = <String>[];
    final spoken = <String>[];
    final client = MockClient((request) async {
      requests.add('${request.method} ${request.url.path}');
      if (request.url.path == '/api/trading/alpaca/orders') {
        return http.Response(jsonEncode({
          'ok': true, 'orders': [{
            'id': 'broker-order-1', 'client_order_id': 'local-request-1',
            'symbol': 'AAPL', 'side': 'buy', 'qty': 3, 'filled_qty': 1,
            'filled_avg_price': 195.0, 'status': 'partially_filled',
            'environment': 'alpaca_paper',
            'submitted_at': '2026-10-20T14:01:00.000Z',
          }],
        }), 200);
      }
      return http.Response(jsonEncode({
        'cards': [{'id': 'alpaca', 'state': 'verified', 'account': {'equity': 10000.0}}],
      }), 200);
    });
    await tester.pumpWidget(MaterialApp(home: Scaffold(
      body: SingleChildScrollView(child: CheAlpacaPaperPanel(
        baseUrl: () => 'https://che.test', headers: () => const {},
        client: client, onRead: spoken.add, refresh: const Duration(days: 1),
      )),
    )));
    await tester.pumpAndSettle();
    expect(find.text('Alpaca paper orders'), findsOneWidget);
    expect(find.text('AAPL · BUY'), findsOneWidget);
    expect(find.text('1 / 3 filled'), findsOneWidget);
    expect(find.text('partially_filled'), findsOneWidget);
    expect(find.text(r'Paper account equity: $10000.00'), findsOneWidget);
    await tester.tap(find.text('Read Alpaca paper orders aloud'));
    expect(spoken.single, contains(r'average fill $195.00'));
    await tester.tap(find.text('AAPL · BUY'));
    await tester.pumpAndSettle();
    expect(find.text('Verified paper-order receipt'), findsOneWidget);
    expect(find.text('Filled: 1'), findsOneWidget);
    expect(find.text(r'Average fill: $195.00'), findsOneWidget);
    expect(find.text('Alpaca order ID: broker-order-1'), findsOneWidget);
    expect(requests, contains('GET /api/trading/alpaca/orders'));
    expect(requests.every((r) => r.startsWith('GET ')), isTrue,
      reason: 'opening paper-order receipts may never submit an order');
  });

  testWidgets('no Alpaca credentials produces an honest empty state', (tester) async {
    final client = MockClient((request) async {
      if (request.url.path == '/api/trading/alpaca/orders') {
        return http.Response('{"ok":false,"state":"not_configured","orders":[]}', 200);
      }
      return http.Response('{"cards":[{"id":"alpaca","state":"not_configured"}]}', 200);
    });
    await tester.pumpWidget(MaterialApp(home: Scaffold(
      body: SingleChildScrollView(child: CheAlpacaPaperPanel(
        baseUrl: () => 'https://che.test', headers: () => const {},
        client: client, refresh: const Duration(days: 1),
      )),
    )));
    await tester.pumpAndSettle();
    expect(find.textContaining('Connect Alpaca PAPER'), findsOneWidget);
    expect(find.text('AAPL · BUY'), findsNothing);
  });
}
