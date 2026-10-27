import 'dart:async';
import 'dart:convert';

import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/home/che_broker_return.dart';
import 'package:chey/home/che_connections_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _separate = {
  'website_login': 'Not visible to CHE. Signing in on NinjaTrader\'s website in Safari grants CHE no brokerage access.',
  'brokerage_authorized': true,
  'accounts': {'sim': 'DEMO123', 'live': null},
  'market_data': 'allowed',
  'live_orders': 'disabled: needs verified account permissions, a preview and your explicit confirmation',
};

Map<String, dynamic> _card(String state, {bool authorized = false}) => {
  'id': 'tradovate',
  'name': 'Tradovate (NinjaTrader)',
  'state': state,
  'separate': {..._separate, 'brokerage_authorized': authorized, if (!authorized) 'accounts': null, if (!authorized) 'market_data': 'unknown'},
};

http.Client _worker({required String brokerState, Map<String, dynamic>? card, List<String>? paths}) => MockClient((r) async {
  paths?.add(r.url.path);
  final body = r.url.path == '/api/trading/connections'
      ? {'mode': 'PAPER', 'cards': [?card]}
      : {'connectors': {'broker': {'state': brokerState}}};
  return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
});

Widget _page(http.Client client, {String brokerReturn = '', List<String>? spoken}) => MaterialApp(
  theme: CheTheme.dark(),
  home: CheConnectionsScreen(baseUrl: 'https://che.test', headers: () => {}, client: client,
    brokerReturn: brokerReturn, onSpeak: spoken?.add, onVoiceSettings: () {}, onKeys: () {}),
);

void main() {
  group('che://broker/tradovate parsing', () {
    test('reads the result the Tradovate page reported', () {
      expect(CheBrokerReturn.parse(Uri.parse('che://broker/tradovate?result=connected')), const CheBrokerReturn('connected'));
      expect(CheBrokerReturn.parse(Uri.parse('che://broker/tradovate?result=failed')), const CheBrokerReturn('failed'));
      expect(CheBrokerReturn.parse(Uri.parse('CHE://Broker/Tradovate/?result=CONNECTED')), const CheBrokerReturn('connected'));
      expect(CheBrokerReturn.parse(Uri.parse('che://broker/tradovate')), const CheBrokerReturn('unknown'));
      expect(CheBrokerReturn.parse(Uri.parse('che://broker/tradovate?result=hacked')), const CheBrokerReturn('unknown'));
    });

    test('ignores every other link', () {
      for (final link in ['https://broker/tradovate?result=connected', 'che://broker/rithmic?result=connected',
        'che://youtube?result=connected', 'che://broker?result=connected', 'che://broker/tradovate/extra?result=connected',
        'sidestore://install']) {
        expect(CheBrokerReturn.parse(Uri.parse(link)), isNull, reason: link);
      }
    });

    test('the listener delivers links from the stream it is given', () async {
      final links = StreamController<Uri>();
      CheDeepLinks.debugStream = links.stream;
      addTearDown(() => CheDeepLinks.debugStream = null);
      final got = <Uri>[];
      final sub = CheDeepLinks.listen(got.add);
      links.add(Uri.parse('che://broker/tradovate?result=connected'));
      await Future<void>.delayed(Duration.zero);
      expect(got.single.toString(), 'che://broker/tradovate?result=connected');
      await sub?.cancel();
      await links.close();
    });
  });

  group('NinjaTrader separate facts', () {
    test('one line per fact, live orders disabled', () {
      expect(cheNinjaTraderLines(_separate), [
        'Website login: Not visible to CHE. Signing in on NinjaTrader\'s website in Safari grants CHE no brokerage access.',
        'Brokerage authorized: yes.',
        'Accounts: simulated DEMO123.',
        'Market data: allowed.',
        'Live orders: Disabled: needs verified account permissions, a preview and your explicit confirmation.',
      ]);
      expect(cheNinjaTraderLines({..._separate, 'brokerage_authorized': false, 'accounts': null})[1], 'Brokerage authorized: no.');
      expect(cheNinjaTraderLines({..._separate, 'accounts': null})[2], 'Accounts: none reported to CHE.');
      expect(cheNinjaTraderLines(null), isEmpty, reason: 'nothing is guessed when the Worker did not report');
    });

    test('"connected" only when the Worker says signed_in', () {
      expect(cheNinjaTraderReturnLine(linkResult: 'connected', card: _card('signed_in', authorized: true)),
        startsWith('NinjaTrader connected.'));
      final notYet = cheNinjaTraderReturnLine(linkResult: 'connected', card: _card('configured'));
      expect(notYet, 'NinjaTrader is not connected. The Tradovate page said connected, but CHE\'s check says NinjaTrader is set up, not signed in. Brokerage authorized: no.');
      expect(cheNinjaTraderReturnLine(linkResult: 'failed', card: _card('expired')),
        contains('The Tradovate sign-in did not finish. CHE\'s check says NinjaTrader is sign-in expired.'));
      expect(cheNinjaTraderReturnLine(linkResult: 'connected', card: null, error: 'CHE did not answer in time.'),
        'I could not verify NinjaTrader after the Tradovate page, sir. CHE did not answer in time. Nothing is claimed as connected.');
    });
  });

  testWidgets('the return link refreshes, then shows and speaks the verified result with separate lines', (tester) async {
    tester.view.physicalSize = const Size(1170, 4200);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    final paths = <String>[];
    await tester.pumpWidget(_page(_worker(brokerState: 'ready', card: _card('signed_in', authorized: true), paths: paths),
      brokerReturn: 'connected', spoken: spoken));
    await tester.pumpAndSettle();
    expect(paths, ['/api/commands', '/api/trading/connections'], reason: 'one verified refresh, not a second router');
    expect(spoken.single, startsWith('NinjaTrader connected.'));
    expect(spoken.single, contains('Live orders: Disabled'));
    expect(find.text(spoken.single), findsOneWidget, reason: 'the spoken result is also shown');
    await tester.scrollUntilVisible(find.textContaining('Live orders: Disabled').last, 200,
      scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    for (final line in cheNinjaTraderLines(_separate)) {
      expect(find.bySemanticsLabel(line), findsOneWidget, reason: line);
    }
  });

  testWidgets('a "connected" link with a Worker that is not signed in reports the real state', (tester) async {
    final spoken = <String>[];
    await tester.pumpWidget(_page(_worker(brokerState: 'not_connected', card: _card('configured')),
      brokerReturn: 'connected', spoken: spoken));
    await tester.pumpAndSettle();
    expect(spoken.single, startsWith('NinjaTrader is not connected.'));
    expect(spoken.single, isNot(contains('NinjaTrader connected')));
    expect(find.text('Connected'), findsNothing);
  });

  testWidgets('an open Connections page handles the return itself, and a plain load stays silent', (tester) async {
    final spoken = <String>[];
    await tester.pumpWidget(_page(_worker(brokerState: 'ready', card: _card('signed_in', authorized: true)), spoken: spoken));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'passive page load is silent');
    expect(CheConnectionsVoice.brokerReturn, isNotNull);
    await tester.runAsync(() => CheConnectionsVoice.brokerReturn!('connected'));
    await tester.pumpAndSettle();
    expect(spoken.single, startsWith('NinjaTrader connected.'));
    await tester.pumpWidget(const SizedBox());
    expect(CheConnectionsVoice.brokerReturn, isNull, reason: 'the handler leaves with the page');
  });
}
