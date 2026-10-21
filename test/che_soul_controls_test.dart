// CHE's Soul controls (owner, 2026-10-21): the phone reads the Worker's Soul, shows six traits and the history,
// saves a change as the next version, and shows a failure as text without changing anything.
import 'dart:convert';

import 'package:chey/che_ui/che_soul.dart';
import 'package:chey/che_ui/che_soul_controls.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> profileJson({int version = 0, Map<String, int>? traits, List<Map<String, dynamic>> history = const []}) => {
      'version': version,
      'hash': 'a1b2c3d4',
      'default': version == 0,
      'text': '',
      'traits': traits ?? {'warmth': 7, 'playfulness': 4, 'formality': 5, 'directness': 7, 'verbosity': 3, 'proactivity': 5},
      'history': history,
    };

void useClient(http.Client client) {
  CheSoulClient.configure(baseUrl: () => 'https://che.example', headers: () => {'Authorization': 'Bearer t'});
  CheSoulClient.httpClient = client;
}

Future<void> pumpControls(WidgetTester tester) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: const CheSoulControls())));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('the owner sees the six traits, the current version, and the built-in values', (tester) async {
    useClient(MockClient((request) async => http.Response(jsonEncode(profileJson()), 200, headers: {'content-type': 'application/json'})));
    await pumpControls(tester);
    expect(find.text('Built-in Soul (version 0)'), findsOneWidget);
    for (final label in ['Warmth', 'Playfulness', 'Formality', 'Directness', 'Detail', 'Initiative']) {
      expect(find.text(label), findsOneWidget);
    }
    expect(find.text('7 of 10'), findsNWidgets(2), reason: 'warmth and directness are both 7');
    expect(find.bySemanticsLabel(RegExp('Warmth, 7 of 10')), findsOneWidget);
  });

  testWidgets('a save sends the change to the Worker and shows the new version as text', (tester) async {
    final bodies = <Map<String, dynamic>>[];
    useClient(MockClient((request) async {
      if (request.method == 'POST') {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        bodies.add(body);
        return http.Response(jsonEncode(profileJson(version: 1, traits: {...(body['traits'] as Map).cast<String, int>()})), 200,
            headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode(profileJson()), 200, headers: {'content-type': 'application/json'});
    }));
    await pumpControls(tester);
    await tester.tap(find.text('Save Soul'));
    await tester.pumpAndSettle();
    expect(bodies, hasLength(1));
    expect((bodies.single['traits'] as Map)['warmth'], 7);
    expect(find.text('Saved as Soul version 1. The next reply uses it.'), findsOneWidget);
  });

  testWidgets('a refused save shows the Worker\'s reason as text and says nothing changed', (tester) async {
    useClient(MockClient((request) async {
      if (request.method == 'POST') return http.Response(jsonEncode({'detail': 'The Soul was not changed: soul_trait_warmth_not_a_number.'}), 400, headers: {'content-type': 'application/json'});
      return http.Response(jsonEncode(profileJson()), 200, headers: {'content-type': 'application/json'});
    }));
    await pumpControls(tester);
    await tester.tap(find.text('Save Soul'));
    await tester.pumpAndSettle();
    expect(find.textContaining('The Soul was not changed'), findsOneWidget);
    expect(find.text('Built-in Soul (version 0)'), findsOneWidget);
  });

  testWidgets('an earlier version can be restored from the history, and the history is shown', (tester) async {
    final restores = <int>[];
    final history = [
      {'version': 0, 'hash': 'a1b2c3d4', 'saved_at': '2026-10-21T10:00:00.000Z', 'reason': 'built-in', 'traits': {'warmth': 7}},
    ];
    useClient(MockClient((request) async {
      if (request.url.path == '/api/soul/restore') {
        restores.add((jsonDecode(request.body) as Map)['version'] as int);
        return http.Response(jsonEncode(profileJson(version: 2, history: history)), 200, headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode(profileJson(version: 1, history: history)), 200, headers: {'content-type': 'application/json'});
    }));
    await pumpControls(tester);
    expect(find.text('Version 0'), findsOneWidget);
    await tester.tap(find.text('Restore'));
    await tester.pumpAndSettle();
    expect(restores, [0]);
    expect(find.text('Version 0 is back as version 2. Nothing was deleted.'), findsOneWidget);
  });

  testWidgets('when CHE is not connected, the controls say so and change nothing', (tester) async {
    CheSoulClient.configure(baseUrl: () => throw StateError('no base'), headers: () => {});
    CheSoulClient.httpClient = MockClient((request) async => http.Response('{}', 500));
    await pumpControls(tester);
    expect(find.textContaining('Nothing was changed'), findsOneWidget);
  });
}
