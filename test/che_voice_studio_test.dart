import 'dart:convert';

import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/che_voice_studio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, Object?> _library({String state = 'Connected', String reason = ''}) => {
      'state': state,
      'reason': reason,
      'voices': [
        {'provider': 'elevenlabs', 'id': 'CONNIEvoice0001', 'name': 'Connie', 'source': 'mine', 'category': 'cloned', 'preview': '', 'labels': {}},
        {'provider': 'elevenlabs', 'id': 'RACHELvoice0002', 'name': 'Rachel', 'source': 'default', 'category': 'premade', 'preview': 'https://cdn.example.test/r.mp3', 'labels': {}},
      ],
      'favorites': <String>[],
      'selected': null,
      'models': {
        'elevenlabs': [
          {
            'id': 'eleven_flash_v2_5',
            'name': 'Flash v2.5',
            'explanation': 'Fastest replies, for live conversation.',
            'credits': '0.5 times the standard credit rate',
            'controls': {'stability': true, 'similarity_boost': true, 'speed': true, 'style': false, 'use_speaker_boost': true},
          },
        ],
        'state': 'Connected',
        'reason': '',
      },
      'fish': {'models': <Object>[], 'state': 'Needs Setup', 'reason': 'No Fish Audio key is set.'},
      'total': 2,
      'complete': true,
    };

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({
      'che_agent_base_url': 'https://che.test',
      'che_agent_device_token': 'mock-owner-token',
    });
  });

  testWidgets('Voice Studio lists the account voices by group and says why a key is refused', (tester) async {
    final client = MockClient((r) async => http.Response(
          jsonEncode(_library(state: 'Needs Reconnect', reason: 'The ElevenLabs key is missing the voices_read permission.')),
          200,
          headers: {'content-type': 'application/json'},
        ));
    await tester.pumpWidget(MaterialApp(
      theme: CheTheme.dark(),
      home: Scaffold(body: CheVoiceStudioPanel(client: client)),
    ));
    await tester.pumpAndSettle();
    expect(find.textContaining('missing the voices_read permission'), findsOneWidget);
    expect(find.text('Connie'), findsOneWidget);
    expect(find.text('Rachel'), findsOneWidget);
  });

  testWidgets('saving keeps the chosen model and sends only the controls that model allows', (tester) async {
    final posted = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        posted.add(r.body);
        return http.Response(jsonEncode({'ok': true, 'selected': {}}), 200, headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode(_library()), 200, headers: {'content-type': 'application/json'});
    });
    await tester.pumpWidget(MaterialApp(
      theme: CheTheme.dark(),
      home: Scaffold(body: CheVoiceStudioPanel(client: client)),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Choose').first);
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Save as CHE’s voice'), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Save as CHE’s voice'));
    await tester.pumpAndSettle();
    expect(posted, hasLength(1));
    final body = jsonDecode(posted.single) as Map<String, dynamic>;
    expect(body['id'], 'CONNIEvoice0001');
    expect(body['model_id'], 'eleven_flash_v2_5');
    final settings = body['settings'] as Map<String, dynamic>;
    expect(settings.containsKey('style'), isFalse, reason: 'Flash does not offer style');
    expect(settings['use_speaker_boost'], isTrue);
  });

  testWidgets('a generated sample waits for the owner to confirm the credits; cancel sends nothing', (tester) async {
    final posted = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') posted.add(r.body);
      return http.Response(jsonEncode(_library()), 200, headers: {'content-type': 'application/json'});
    });
    await tester.pumpWidget(MaterialApp(
      theme: CheTheme.dark(),
      home: Scaffold(body: CheVoiceStudioPanel(client: client)),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Choose').first);
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Generate a paid sample (uses credits)'), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Generate a paid sample (uses credits)'));
    await tester.pumpAndSettle();
    expect(find.text('Generate a paid sample?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(posted, isEmpty, reason: 'no credit is spent until the owner confirms');
  });
}
