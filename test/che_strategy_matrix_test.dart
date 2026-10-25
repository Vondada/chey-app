// Strategy Matrix (Trading Room V3, owner 2026-10-25). The fixture is the Worker's own view
// (tool/dump_strategy_matrix_fixture.mjs over the committed research results). Opening is silent; every row has a
// VoiceOver label with its numbers; a thin sample says "insufficient sample" and is never shown as ranked; Read aloud
// and the voice routes run only when the owner chooses them; live is always disabled.
import 'dart:convert';
import 'dart:io';

import 'package:chey/rooms/che_strategy_matrix.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> fixture() => (jsonDecode(File('test/fixtures/strategy_matrix.json').readAsStringSync()) as Map).cast<String, dynamic>();

Widget host(Map<String, dynamic> data, List<String> read, List<String> asked) => MaterialApp(
      home: Scaffold(
        backgroundColor: Colors.black,
        body: SingleChildScrollView(child: CheStrategyMatrix(data: data, onRead: read.add, onAsk: asked.add)),
      ),
    );

void main() {
  testWidgets('opening is silent; paper only, live disabled; rows carry their numbers for VoiceOver', (tester) async {
    tester.view.physicalSize = const Size(900, 9000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final read = <String>[];
    final asked = <String>[];
    final data = fixture();
    await tester.pumpWidget(host(data, read, asked));
    await tester.pumpAndSettle();
    expect(read, isEmpty, reason: 'nothing is spoken on open');
    expect(asked, isEmpty);
    expect(find.bySemanticsLabel('Paper and research only. Live trading is disabled.'), findsOneWidget);
    final rows = (data['rows'] as List).cast<Map>();
    final ranked = rows.firstWhere((r) => r['tier'] == 'ranked');
    final oos = (ranked['oos'] as Map);
    expect(find.bySemanticsLabel(RegExp('^${RegExp.escape('${ranked['name']}')}, ${ranked['market']} .*Paper priority ${ranked['paper_priority']}\\. ${oos['trades']} out-of-sample trades.*Live disabled\\.\$')), findsOneWidget);
    final thin = rows.firstWhere((r) => r['tier'] == 'insufficient sample');
    expect(find.bySemanticsLabel(RegExp('Insufficient sample: ${(thin['oos'] as Map)['trades']} out-of-sample trades\\. Not ranked\\.\$')), findsWidgets);
    expect(find.text('Insufficient sample'), findsWidgets);
    expect(find.textContaining('Demoted · '), findsWidgets);
    expect(find.bySemanticsLabel(RegExp('Not tested: ')), findsWidgets);
  });

  testWidgets('a row expands to its rules and numbers; Read aloud and the voice routes run only on request', (tester) async {
    tester.view.physicalSize = const Size(900, 12000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final read = <String>[];
    final asked = <String>[];
    final data = fixture();
    await tester.pumpWidget(host(data, read, asked));
    await tester.pumpAndSettle();
    final ranked = (data['rows'] as List).cast<Map>().firstWhere((r) => r['tier'] == 'ranked');
    await tester.tap(find.text('${ranked['name']} · ${ranked['market']} ${ranked['tf']}'));
    await tester.pumpAndSettle();
    expect(find.text('${ranked['sentence']}'), findsOneWidget);
    expect(find.textContaining('Rules: ${ranked['rules']}'), findsOneWidget);
    expect(find.textContaining('live disabled'), findsWidgets);
    await tester.tap(find.bySemanticsLabel('Read aloud: the strategy matrix'));
    expect(read.single, contains('live trading is disabled'));
    expect(read.single, contains('${ranked['sentence']}'));
    await tester.tap(find.bySemanticsLabel('Ask CHE: what is the best strategy for BTC'));
    expect(asked.single, "What's the best strategy for BTC?");
    await tester.tap(find.bySemanticsLabel('Ask CHE to explain ${ranked['name']}'));
    expect(asked.last, 'Explain the ${ranked['name']}');
    await tester.tap(find.bySemanticsLabel('Show ETH'));
    await tester.pumpAndSettle();
    expect(find.text('${ranked['name']} · ${ranked['market']} ${ranked['tf']}'), ranked['market'] == 'ETH' ? findsOneWidget : findsNothing);
  });

  testWidgets('with no research run the matrix says the numbers are pending', (tester) async {
    final read = <String>[];
    await tester.pumpWidget(host({'groups': [{'group': 'crypto', 'pending': true}, {'group': 'futures', 'pending': true}], 'rows': [], 'cost_models': {}}, read, []));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('No research results yet. The numbers are pending a real research run.'), findsOneWidget);
    expect(find.textContaining('no real research run yet'), findsNWidgets(2));
    expect(read, isEmpty);
  });
}
