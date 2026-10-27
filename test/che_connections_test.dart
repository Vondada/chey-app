import 'dart:convert';

import 'package:chey/che_cloud_voice_picker.dart';
import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/home/che_connections_screen.dart';
import 'package:chey/home/screen_command.dart';
import 'package:chey/security/che_session_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  // Widget tests have no Keychain plugin: the sign-in lives in memory, fresh for every test.
  setUp(() => CheSessionStore.instance = CheSessionStore(kv: CheMemoryKv()));

  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('natural speech and typing route to local Connections and Voice Settings without any model', () {
    for (final prompt in ['CHE, open connections', 'show me my connected accounts',
      'connect my YouTube channel', 'connect my bank account', 'show my bank transactions']) {
      expect(parseScreenCommand(prompt)?.op, ScreenOp.openConnections, reason: prompt);
    }
    for (final prompt in ['CHE, change your voice', 'preview your voice']) {
      expect(parseScreenCommand(prompt)?.op, ScreenOp.naturalVoice, reason: prompt);
    }
    expect(parseScreenCommand('open voice settings')?.op, ScreenOp.changeVoice);
    // A market-data query is NOT an account-linking operation.
    // A spoken connect goes straight to that one official sign-in.
    expect(parseScreenCommand('connect my YouTube channel')?.text, 'youtube');
    expect(parseScreenCommand('connect NinjaTrader')?.text, 'broker');
    expect(parseScreenCommand('open connections')?.text, '');
    expect(parseScreenCommand('connect my Gmail')?.text, 'gmail');
    expect(parseScreenCommand('connect google drive')?.text, 'drive');
    expect(parseScreenCommand('connect my calendar')?.text, 'calendar');
    expect(parseScreenCommand('connect google ads')?.text, 'google_ads');
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
        client: client, onVoiceSettings: () {}, onKeys: () {})));
    await tester.pumpAndSettle();
    expect(paths, ['/api/commands']);
    expect(find.text('YouTube channel'), findsOneWidget);
    expect(find.text('Existing YouTube channel'), findsOneWidget);
    expect(find.text('NinjaTrader / Tradovate'), findsOneWidget);
    await tester.scrollUntilVisible(find.textContaining('No secure bank-link provider'), 200,
      scrollable: find.byType(Scrollable).first);
    expect(find.textContaining('No secure bank-link provider'), findsOneWidget);
    expect(find.text('Unsupported'), findsWidgets);
    await tester.scrollUntilVisible(find.text('Payments / Stripe'), 200,
      scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    expect(find.text('Configured'), findsWidgets, reason: 'a key alone is not verified connection');
  });

  testWidgets('a spoken YouTube connect starts the sign-in and speaks its real result', (tester) async {
    final spoken = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        return http.Response(jsonEncode({'detail': 'Google sign-in is not configured. Open Keys for setup.'}), 503,
          headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode({'connectors': {}}), 200, headers: {'content-type': 'application/json'});
    });
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(),
      home: CheConnectionsScreen(baseUrl: 'https://che.test', headers: () => {}, client: client,
        autoConnect: 'youtube', onSpeak: spoken.add, onVoiceSettings: () {}, onKeys: () {})));
    await tester.pumpAndSettle();
    expect(spoken, ['YouTube: Google sign-in is not configured. Open Keys for setup.'],
      reason: 'the passive page load is silent; only the requested connect speaks');
  });

  testWidgets('the open voice picker answers spoken choices and speaks each real result', (tester) async {
    SharedPreferences.setMockInitialValues({
      'che_agent_base_url': 'https://che.test',
      'che_agent_device_token': 'mock-owner-token',
    });
    final spoken = <String>[];
    final posted = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        posted.add(r.body);
        return http.Response(jsonEncode({'ok': true, 'selected': jsonDecode(r.body)}), 200);
      }
      return http.Response(jsonEncode({
        'options': [
          {'provider': 'elevenlabs', 'id': 'ABCDEFGHIJKLMN', 'name': 'Clara'},
          {'provider': 'fish', 'id': 'configured', 'name': 'CHE Fish voice (configured)'},
        ],
        'selected': null, 'elevenlabs': 'Connected', 'fish': 'Connected',
      }), 200, headers: {'content-type': 'application/json'});
    });
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(),
      home: CheCloudVoicePicker(client: client, onSpeak: spoken.add)));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'the passive first load is silent');
    final voice = CheCloudVoicePickerVoice.handler!;

    expect(await tester.runAsync(() => voice('list voices')), '');
    expect(spoken.last, 'Available voices: 1, Clara; 2, CHE Fish voice (configured). Say choose and a name, or choose number and a number.');
    expect(await tester.runAsync(() => voice('choose fish')), '');
    expect(spoken.last, 'Selected CHE Fish voice (configured). Say preview voice to hear it, or save voice to use it.');
    expect(await tester.runAsync(() => voice('choose number one')), '');
    expect(spoken.last, 'Selected Clara. Say preview voice to hear it, or save voice to use it.');
    expect(await tester.runAsync(() => voice('speed 1.1')), '');
    expect(spoken.last, 'Voice speed is 1.10. Say save voice to keep it.');
    expect(await tester.runAsync(() => voice('speed 2')), '');
    expect(spoken.last, 'Speed must be between 0.7 and 1.2. It is 1.10 now.');
    expect(await tester.runAsync(() => voice('preview voice')), '');
    expect(spoken.last, startsWith('One short preview may use credits'));
    expect(await tester.runAsync(() => voice('no')), '');
    expect(spoken.last, 'Preview cancelled. Nothing was played.');
    expect(await tester.runAsync(() => voice('preview voice')), '');
    expect(await tester.runAsync(() => voice('yes')), '');
    expect(spoken.last, 'Preview failed: This voice did not return playable audio.');
    expect(find.byType(AlertDialog), findsNothing, reason: 'the spoken yes is the consent; no dialog blocks it');
    expect(await tester.runAsync(() => voice('save voice')), '');
    expect(spoken.last, 'Voice saved for CHE Chat and Read This. Test it with Read This.');
    expect(jsonDecode(posted.last)['id'], 'ABCDEFGHIJKLMN');
    expect(await tester.runAsync(() => voice('back')), '');
    expect(spoken.last, 'I could not close the voice choices.', reason: 'the picker is the only route here, so back cannot pop');
    expect(await tester.runAsync(() => voice('tell me a joke')), isNull, reason: 'anything else goes to Chat');
  });

  testWidgets('the Connections page answers spoken refresh and connect, and speaks each result', (tester) async {
    final spoken = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        return http.Response(jsonEncode({'detail': 'Tradovate OAuth application is not configured.'}), 503,
          headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode({'connectors': {
        'youtube': {'state': 'ready', 'detail': 'Existing YouTube channel'},
        'broker': {'state': 'not_connected', 'detail': 'Sign in to Tradovate'},
      }}), 200, headers: {'content-type': 'application/json'});
    });
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(),
      home: CheConnectionsScreen(baseUrl: 'https://che.test', headers: () => {}, client: client,
        onSpeak: spoken.add, onVoiceSettings: () {}, onKeys: () {})));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'the passive page load is silent');
    final voice = CheConnectionsVoice.handler!;

    expect(await tester.runAsync(() => voice('refresh connections')), '');
    expect(spoken.last, 'Connection check complete. YouTube: Connected. NinjaTrader: Needs Setup. Gmail: Unavailable. Google Drive: Unavailable. Google Calendar: Unavailable. Google Ads: Unavailable. Bank linking remains unavailable.');
    expect(await tester.runAsync(() => voice('connect NinjaTrader')), '');
    expect(spoken.last, 'NinjaTrader: Tradovate OAuth application is not configured.');
    expect(await tester.runAsync(() => voice('tell me a joke')), isNull, reason: 'anything else goes to Chat');
  });

  testWidgets('Gmail, Drive and Calendar rows show the verified account, and a spoken connect asks Google for only that service', (tester) async {
    tester.view.physicalSize = const Size(1170, 4200);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    final posted = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        posted.add(r.body);
        return http.Response(jsonEncode({'detail': 'Google Drive sign-in is not configured. Open Keys for setup.'}), 503,
          headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode({'connectors': {
        'gmail': {'state': 'ready', 'detail': 'owner@example.com'},
        'drive': {'state': 'not_connected', 'detail': 'Google Drive is not connected.'},
        'google_ads': {'state': 'not_connected', 'detail': 'Signed in, but CHE needs the Google Ads developer token.'},
      }}), 200, headers: {'content-type': 'application/json'});
    });
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(),
      home: CheConnectionsScreen(baseUrl: 'https://che.test', headers: () => {}, client: client,
        onSpeak: spoken.add, onVoiceSettings: () {}, onKeys: () {})));
    await tester.pumpAndSettle();
    expect(find.textContaining('owner@example.com'), findsOneWidget);
    expect(find.text('Connect Gmail'), findsOneWidget);
    await tester.scrollUntilVisible(find.textContaining('developer token'), 200,
      scrollable: find.byType(Scrollable).first);
    expect(find.textContaining('developer token'), findsOneWidget);

    expect(await tester.runAsync(() => CheConnectionsVoice.handler!('connect my drive')), '');
    expect(jsonDecode(posted.single)['service'], 'drive');
    expect(spoken.last, 'Google Drive: Google Drive sign-in is not configured. Open Keys for setup.');
  });

  testWidgets('a connected Google service is removed only after a confirmed yes, by button and by voice', (tester) async {
    tester.view.physicalSize = const Size(1170, 4200);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    final posted = <String>[];
    var connected = true;
    final client = MockClient((r) async {
      if (r.method == 'POST' && r.url.path == '/api/google/disconnect') {
        posted.add(r.body);
        connected = false;
        return http.Response(jsonEncode({'ok': true, 'label': 'Gmail', 'was_connected': true, 'revoked_at_google': true}),
          200, headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode({'connectors': {
        'gmail': connected ? {'state': 'ready', 'detail': 'owner@example.com'} : {'state': 'not_connected', 'detail': 'Gmail is not connected.'},
      }}), 200, headers: {'content-type': 'application/json'});
    });
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(),
      home: CheConnectionsScreen(baseUrl: 'https://che.test', headers: () => {}, client: client,
        onSpeak: spoken.add, onVoiceSettings: () {}, onKeys: () {})));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Disconnect').first);
    await tester.pumpAndSettle();
    expect(find.text('Disconnect Gmail?'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    expect(posted, isEmpty, reason: 'cancel removes nothing');
    await tester.tap(find.text('Disconnect').first);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Disconnect'));
    await tester.pumpAndSettle();
    expect(jsonDecode(posted.single)['service'], 'gmail');
    expect(spoken.last, 'Gmail disconnected. Google access was revoked.');

    posted.clear();
    connected = true;
    expect(await tester.runAsync(() => CheConnectionsVoice.handler!('disconnect my gmail')), '');
    expect(spoken.last, 'Disconnect Gmail? CHE revokes its access at Google. Say yes to disconnect, or no to cancel.');
    expect(posted, isEmpty, reason: 'a spoken disconnect asks first');
    expect(await tester.runAsync(() => CheConnectionsVoice.handler!('no')), '');
    expect(spoken.last, 'Disconnect cancelled. Nothing was removed.');
    expect(posted, isEmpty);
    expect(await tester.runAsync(() => CheConnectionsVoice.handler!('disconnect my gmail')), '');
    expect(await tester.runAsync(() => CheConnectionsVoice.handler!('yes')), '');
    expect(jsonDecode(posted.single)['service'], 'gmail');
  });

  testWidgets('FundYourEdge shows Unsupported with its Rithmic reason and no connect button', (tester) async {
    tester.view.physicalSize = const Size(1170, 4200);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final client = MockClient((r) async => http.Response(jsonEncode({'connectors': {
      'fundyouredge': {'state': 'none', 'detail': 'Rithmic requires its own licensed API.'},
    }}), 200, headers: {'content-type': 'application/json'}));
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(),
      home: CheConnectionsScreen(baseUrl: 'https://che.test', headers: () => {}, client: client,
        onVoiceSettings: () {}, onKeys: () {})));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('FundYourEdge funded account'), 200,
      scrollable: find.byType(Scrollable).first);
    expect(find.text('FundYourEdge funded account'), findsOneWidget);
    expect(find.textContaining('Rithmic'), findsWidgets);
    expect(find.text('Unsupported'), findsWidgets);
  });

  testWidgets('HTTP auth failure clears stale connection claims', (tester) async {
    final client = MockClient((r) async => http.Response('{"detail":"Pair phone"}', 401));
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(),
      home: CheConnectionsScreen(baseUrl: 'https://che.test', headers: () => {},
        client: client, onVoiceSettings: () {}, onKeys: () {})));
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
    final spoken = <String>[];
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
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(), home: CheCloudVoicePicker(client: client, onSpeak: spoken.add)));
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
    expect(spoken, ['Voice saved for CHE Chat and Read This. Test it with Read This.']);
  });
}
