import 'dart:convert';

import 'package:chey/rooms/che_trading_connections.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> view({String alpaca = 'not_configured'}) => {
      'mode': 'PAPER',
      'permissions': {'research': true, 'paper': true, 'sim_orders': 'off', 'live_orders': 'off'},
      'cards': [
        {'id': 'che_paper', 'name': 'CHE Paper', 'state': 'on', 'mode': 'PAPER', 'data': {'source': 'Yahoo Finance chart (public) MNQ=F', 'label': 'DELAYED', 'lag_minutes': 11}, 'detail': '24 isolated paper portfolios.'},
        {
          'id': 'tradovate', 'name': 'Tradovate (NinjaTrader)', 'state': 'not_configured', 'mode': 'PAPER',
          'blocked_by': ['A funded Tradovate live account with more than 1,000 dollars in it', 'The CME market-data agreement, signed inside Tradovate'],
          'blocked_note': 'Until Tradovate approves API access, Tradovate demo and live orders stay blocked in CHE.',
          'worker_secrets': ['CHE_TRADOVATE_OAUTH_CLIENT_ID', 'CHE_TRADOVATE_OAUTH_CLIENT_SECRET'],
          'open_account': 'https://www.tradovate.com/open-your-trading-account/', 'detail': 'Not set up.',
        },
        {
          'id': 'alpaca', 'name': 'Alpaca (stock paper)', 'state': alpaca, 'mode': 'PAPER', 'detail': alpaca == 'verified' ? 'Paper account ending 6543.' : 'Not set up.',
          if (alpaca == 'verified') 'options': {'approved_level': 2, 'trading_level': 2, 'orders': 'off', 'detail': 'Options, read only: Alpaca approved level 2; trading level 2. CHE places no option orders yet.'},
        },
        {'id': 'fundyouredge', 'name': 'FundYourEdge (Rithmic)', 'state': 'unsupported', 'mode': null, 'detail': 'CHE has no Rithmic connection.'},
      ],
    };

Widget host(http.Client client, List<String> asked) => MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheTradingConnectionsPanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: asked.add, client: client))),
    );

void main() {
  testWidgets('each connection shows its real state; opening it is silent', (tester) async {
    final asked = <String>[];
    final client = MockClient((r) async => http.Response(jsonEncode(view()), 200));
    await tester.pumpWidget(host(client, asked));
    await tester.pumpAndSettle();
    expect(find.text('CHE Paper'), findsOneWidget);
    expect(find.textContaining('DELAYED data from Yahoo Finance chart (public) MNQ=F, about 11 minutes behind'), findsOneWidget);
    expect(find.text('not set up'), findsNWidgets(2));
    expect(find.text('not supported'), findsOneWidget);
    expect(find.textContaining('Live orders: off'), findsOneWidget);
    expect(find.textContaining('connected'), findsNothing, reason: 'nothing reads connected until a provider proved it');
    expect(asked, isEmpty, reason: 'opening the Trading Room is silent');
    await tester.tap(find.text('Read aloud'));
    expect(asked, ['What are my trading connections?']);
  });

  testWidgets('the Alpaca paper keys go to CHE once, from masked fields, and the result is shown', (tester) async {
    final posted = <Map<String, dynamic>>[];
    var verified = false;
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        posted.add(Map<String, dynamic>.from(jsonDecode(r.body) as Map));
        verified = true;
        return http.Response(jsonEncode({'ok': true, 'key_last4': '7890'}), 200);
      }
      return http.Response(jsonEncode(view(alpaca: verified ? 'verified' : 'not_configured')), 200);
    });
    await tester.pumpWidget(host(client, []));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Add paper keys'));
    await tester.tap(find.text('Add paper keys'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Paper key ID'), 'PKPAPERKEY1234567890');
    await tester.enterText(find.widgetWithText(TextField, 'Paper secret'), 'p' * 40);
    final secretField = tester.widget<TextField>(find.widgetWithText(TextField, 'Paper secret'));
    expect(secretField.obscureText, isTrue);
    await tester.tap(find.text('Check and save'));
    await tester.pumpAndSettle();
    expect(posted, [{'key_id': 'PKPAPERKEY1234567890', 'secret': 'p' * 40}]);
    expect(find.text('Alpaca paper keys saved: key ending 7890 verified.'), findsOneWidget);
    expect(find.text('verified'), findsOneWidget);
    expect(find.textContaining('PKPAPERKEY'), findsNothing, reason: 'the key never stays on screen');
  });

  testWidgets('removing the Alpaca keys asks first; keeping them sends nothing', (tester) async {
    final posted = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') { posted.add(r.body); return http.Response(jsonEncode({'ok': true, 'removed': true, 'detail': 'The Alpaca paper keys are removed, sir.'}), 200); }
      return http.Response(jsonEncode(view(alpaca: 'verified')), 200);
    });
    await tester.pumpWidget(host(client, []));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Remove keys'));
    await tester.tap(find.text('Remove keys'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Keep them'));
    await tester.pumpAndSettle();
    expect(posted, isEmpty);
    await tester.ensureVisible(find.text('Remove keys'));
    await tester.tap(find.text('Remove keys'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    expect(posted.single, jsonEncode({'action': 'remove', 'confirm': true}));
    expect(find.text('The Alpaca paper keys are removed, sir.'), findsOneWidget);
  });

  testWidgets('an older CHE server without the view says so in one quiet line', (tester) async {
    final client = MockClient((r) async => http.Response(jsonEncode({'detail': 'Not found.'}), 404));
    await tester.pumpWidget(host(client, []));
    await tester.pumpAndSettle();
    expect(find.text('Not found.'), findsOneWidget);
  });

  testWidgets('Tradovate lists its numbered steps and what stays blocked; Alpaca shows its options level, read only (issue #344)', (tester) async {
    final asked = <String>[];
    final client = MockClient((r) async => http.Response(jsonEncode(view(alpaca: 'verified')), 200));
    await tester.pumpWidget(host(client, asked));
    await tester.pumpAndSettle();
    expect(find.text('1. A funded Tradovate live account with more than 1,000 dollars in it'), findsOneWidget);
    expect(find.text('2. The CME market-data agreement, signed inside Tradovate'), findsOneWidget);
    expect(find.textContaining('demo and live orders stay blocked'), findsOneWidget);
    expect(find.byWidgetPredicate((w) => w is SelectableText && (w.data ?? '').contains('CHE_TRADOVATE_OAUTH_CLIENT_ID')), findsOneWidget);
    expect(find.text('Options, read only: Alpaca approved level 2; trading level 2. CHE places no option orders yet.'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Tradovate \(NinjaTrader\): not set up.*Steps: 1\. A funded Tradovate live account')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Alpaca \(stock paper\): verified.*Options, read only: Alpaca approved level 2')), findsOneWidget);
    expect(asked, isEmpty, reason: 'nothing is read aloud until asked');
    await tester.ensureVisible(find.text('Read the Tradovate steps'));
    await tester.tap(find.text('Read the Tradovate steps'));
    expect(asked, ['What do I need for Tradovate?']);
  });
}
