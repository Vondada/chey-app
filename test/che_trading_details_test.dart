// Owner (2026-10-21): technical diagnostics sit under one collapsed "Details" section on the Trading Room ACCOUNT tab.
import 'dart:convert';

import 'package:chey/rooms/che_trading_connections.dart';
import 'package:chey/rooms/che_trading_room.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets('ACCOUNT shows one Details section, collapsed by default, that opens to the connection diagnostics', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final client = MockClient((r) async => http.Response(jsonEncode({'ok': true}), 200));
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: Scaffold(
        body: CheTradingRoom(
          baseUrl: () => 'https://che.example',
          headers: () => const {},
          onAsk: (_) {},
          client: client,
          initialSection: CheTradingSection.account,
        ),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 300));

    // CONNECTIONS is a small card, collapsed by default; the panel is not built until it opens.
    expect(find.byKey(const Key('fold_connections')), findsOneWidget);
    expect(find.byType(CheTradingConnectionsPanel), findsNothing);
    await tester.tap(find.text('CONNECTIONS'));
    await tester.pumpAndSettle();
    expect(find.byType(CheTradingConnectionsPanel), findsOneWidget, reason: 'the diagnostics open under Details');
  });
}
