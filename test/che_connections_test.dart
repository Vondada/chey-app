import 'dart:convert';

import 'package:chey/che_cloud_voice_picker.dart';
import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/home/che_connections_screen.dart';
import 'package:chey/home/screen_command.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('natural speech and typing route to local Connections and Voice Settings without any model', () {
    for (final prompt in ['CHE, open connections', 'show me my connected accounts',
      'connect my YouTube channel', 'connect my bank account', 'show my bank transactions']) {
      expect(parseScreenCommand(prompt)?.op, ScreenOp.openConnections, reason: prompt);
    }
    for (final prompt in ['CHE, change your voice', 'open voice settings', 'preview your voice']) {
      expect(parseScreenCommand(prompt)?.op, ScreenOp.changeVoice, reason: prompt);
    }
    // A market-data query is NOT an account-linking operation.
    expect(parseScreenCommand('analyze NQ chart')?.op, isNot(ScreenOp.openConnections));
    expect(parseScreenCommand('make a YouTube video')?.op, isNot(ScreenOp.openConnections));
  });

  testWidgets('Connections reports actual provider states and never invents bank access', (tester) async {
    tester.view.physicalSize = const Size(1170, 4200);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final paths = <String>[];
    final client = MockClient((r) async {
      paths.add(r.url.path);
      return http.Response(jsonEncode({'connectors': {
        'youtube': {'state': 'ready', 'detail': 'Existing YouTube channel'},
        'broker': {'state': 'not_connected', 'detail': 'Sign in to Tradovate'},
        'stripe': {'state': 'ready'},
        'github': {'state': 'ready'},
        'voice': {'state': 'ready'},
        'site_hosting': {'state': 'ready'},
        'research': {'state': 'ready'},
      }}), 200, headers: {'content-type': 'application/json'});
    });
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(),
      home: CheConnectionsScreen(baseUrl: 'https://che.test', headers: () => {'Authorization': 'Bearer x'},
        client: client, onBrokerConnect: () {}, onVoiceSettings: () {}, onKeys: () {})));
    await tester.pumpAndSettle();
    expect(paths, ['/api/commands']);
    expect(find.text('YouTube channel'), findsOneWidget);
    expect(find.text('Existing YouTube channel'), findsOneWidget);
    expect(find.text('NinjaTrader / Tradovate'), findsOneWidget);
    expect(find.textContaining('No secure bank-link provider'), findsOneWidget);
    expect(find.text('Unsupported'), findsWidgets);
    expect(find.text('Configured'), findsWidgets, reason: 'a key alone is not verified connection');
  });

  testWidgets('HTTP auth failure clears stale connection claims', (tester) async {
    final client = MockClient((r) async => http.Response('{"detail":"Pair phone"}', 401));
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(),
      home: CheConnectionsScreen(baseUrl: 'https://che.test', headers: () => {},
        client: client, onBrokerConnect: () {}, onVoiceSettings: () {}, onKeys: () {})));
    await tester.pumpAndSettle();
    expect(find.textContaining('Pair this iPhone to CHE first'), findsWidgets);
    expect(find.text('Connected'), findsNothing);
  });

  testWidgets('Voice picker saves only verified account voice, never a provider key', (tester) async {
    SharedPreferences.setMockInitialValues({
      'che_agent_base_url': 'https://che.test',
      'che_agent_device_token': 'mock-owner-token',
    });
    final requests = <http.Request>[];
    final client = MockClient((r) async {
      requests.add(r);
      if (r.method == 'GET') {
        return http.Response(jsonEncode({
          'options': [{'provider': 'elevenlabs', 'id': 'ABCDEFGHIJKLMN', 'name': 'Clara'}],
          'selected': null, 'elevenlabs': 'Connected', 'fish': 'Needs Setup',
        }), 200, headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode({'ok': true, 'selected': jsonDecode(r.body)}), 200);
    });
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(), home: CheCloudVoicePicker(client: client)));
    await tester.pumpAndSettle();
    expect(find.text('Clara'), findsOneWidget);
    await tester.tap(find.text('Save Voice'));
    await tester.pumpAndSettle();
    expect(requests.where((r) => r.method == 'POST').length, 1);
    final last = requests.last;
    expect(last.url.path, '/api/voice/choice');
    final saved = jsonDecode(last.body) as Map<String, dynamic>;
    expect(saved['id'], 'ABCDEFGHIJKLMN');
    expect(saved['provider'], 'elevenlabs');
    expect(last.body.contains('mock-owner-token'), false);
    expect(find.textContaining('Voice saved for CHE Chat'), findsOneWidget);
  });
}
