import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:chey/rooms/che_fye_draft.dart';

Map<String, dynamic> draft() => {
      'status': 'NOT SUBMITTED — NO BROKER CONNECTION.',
      'rows': [
        {'label': 'Account', 'value': 'FundYourEdge (Rithmic)'},
        {'label': 'Contract quantity', 'value': '2'},
        {'label': 'Entry', 'value': '21450', 'note': 'Your number. Not checked against a live quote.'},
        {'label': 'Account balance and buying power', 'value': 'unknown'},
      ],
      'warnings': ['Stop and target are on the wrong sides of the entry for a long.'],
      'assumptions': ['Nothing is sent. This draft is for you to copy into a trading platform by hand.'],
      'copy_text': 'NOT SUBMITTED — NO BROKER CONNECTION.\nEntry: 21450',
      'missing': [],
    };

Future<void> pump(WidgetTester tester, http.Client client) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: CheFyeDraftCard(baseUrl: () => 'https://che.example', headers: () => {'Authorization': 'Bearer t'}, client: client),
      ),
    ),
  ));
  await tester.pumpAndSettle();
}

http.Client serve(Object? draftJson, {int status = 200, List<http.Request>? seen}) => MockClient((request) async {
      seen?.add(request);
      return http.Response.bytes(utf8.encode(jsonEncode({'ok': true, 'draft': draftJson, 'order_sent': false})), status, headers: {'content-type': 'application/json; charset=utf-8'});
    });

void main() {
  testWidgets('a draft shows the NOT SUBMITTED banner, every field, and unknown where nothing was verified', (tester) async {
    final seen = <http.Request>[];
    await pump(tester, serve(draft(), seen: seen));

    expect(seen.single.url.path, '/api/trading/fye/draft');
    expect(seen.single.headers['Authorization'], 'Bearer t');
    expect(find.text('NOT SUBMITTED — NO BROKER CONNECTION.'), findsWidgets);
    expect(find.text('Contract quantity: 2'), findsOneWidget);
    expect(find.text('Account balance and buying power: unknown'), findsOneWidget);
    expect(find.text('Your number. Not checked against a live quote.'), findsOneWidget);
    expect(find.textContaining('wrong sides'), findsOneWidget);
  });

  testWidgets('the draft has no control that sends, places, submits, buys or sells', (tester) async {
    await pump(tester, serve(draft()));
    final labels = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '').join(' | ');
    for (final word in ['Send', 'Place', 'Submit', 'Buy', 'Sell', 'Execute']) {
      expect(labels.contains(word), isFalse, reason: '$word must not appear in the draft');
    }
    expect(find.widgetWithText(OutlinedButton, 'Copy Order Details'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('Copy Order Details copies the draft text and says nothing was sent', (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));

    await pump(tester, serve(draft()));
    await tester.tap(find.widgetWithText(OutlinedButton, 'Copy Order Details'));
    await tester.pumpAndSettle();

    expect(copied, 'NOT SUBMITTED — NO BROKER CONNECTION.\nEntry: 21450');
    expect(find.text('Copied. Nothing was sent to any broker.'), findsOneWidget);
  });

  testWidgets('with no draft yet the card says how to ask for one and shows no figures', (tester) async {
    await pump(tester, serve(null));
    expect(find.textContaining('No FundYourEdge draft yet'), findsOneWidget);
    expect(find.textContaining('Entry'), findsNothing);
  });

  testWidgets('a refused request is shown on screen as a plain failure, with no draft invented', (tester) async {
    await pump(tester, serve(null, status: 401));
    expect(find.textContaining('could not load the FundYourEdge draft'), findsOneWidget);
    expect(find.text('NOT SUBMITTED — NO BROKER CONNECTION.'), findsNothing);
  });
}
