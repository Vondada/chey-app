// More → Film Studio: the room shows CHE's real film state and free farm, stays quiet on open, and reports every
// action's real outcome. The Keys tab lists Kaggle for the farm (served by the Worker's provider list).
import 'dart:convert';

import 'package:chey/film/che_film_studio_screen.dart';
import 'package:chey/rooms/che_creator_studio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _view({String state = 'making'}) => {
      'film': {
        'id': 'film_0123456789abcdef', 'title': 'The Keeper', 'topic': 'a lighthouse keeper', 'state': state, 'target_s': 600,
        'plan': {'ok': true, 'shots': 100, 'tier_a': 0, 'tier_b': 100, 'segments': 10, 'eta_s': 420, 'estimated': true},
        'notes': ['No free GPU farm is connected, so every shot is a still picture with camera motion.'],
        'stats': {'stills_made': 40},
      },
      'progress': {'state': state, 'shots_total': 100, 'shots_verified': 40, 'shots_failed': 0, 'elapsed_s': 120, 'eta_s': 420, 'remaining_s': 300},
      'spoken': '"The Keeper": 40 of 100 shots done. 2 minutes in, against an estimate of 7 minutes.',
      'shots': [
        {'n': 1, 'scene': 1, 'tier': 'B', 'status': 'verified', 'description': 'Mara climbs the stairs', 'still_key': '', 'reuses': 1, 'reason': '', 'downgraded': ''},
        {'n': 2, 'scene': 1, 'tier': 'B', 'status': 'failed', 'description': 'Mara looks out', 'still_key': '', 'reuses': 2, 'reason': 'almost no detail (a blank or flat frame)', 'downgraded': ''},
      ],
      'providers': [
        {'id': 'workers_ai', 'name': 'Cloudflare Workers AI', 'status': 'connected', 'detail': '3000 of the film\'s 6000 neurons left today.'},
        {'id': 'kaggle', 'name': 'Kaggle', 'status': 'not set up', 'detail': 'Paste your Kaggle API token in Keys as username:token.'},
        {'id': 'colab', 'name': 'Google Colab', 'status': 'not automated', 'detail': 'Colab has no official way to start a notebook without a person opening it in a browser, so I cannot run it for you.'},
      ],
    };

void main() {
  testWidgets('the room shows real progress, checks and the free farm, and says nothing on open', (tester) async {
    tester.view.physicalSize = const Size(1200, 4000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    final client = CheFilmClient(baseUrl: 'https://che.example', headers: () => {}, client: MockClient((r) async => http.Response.bytes(utf8.encode(jsonEncode(_view())), 200)));
    await tester.pumpWidget(MaterialApp(home: CheFilmStudioScreen(client: client, onSpeak: spoken.add, refreshEvery: const Duration(hours: 1))));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'opening the room never starts speech');
    expect(find.textContaining('40 of 100 shots done'), findsOneWidget);
    expect(find.textContaining('Estimate 7 minutes (starting numbers)'), findsOneWidget);
    expect(find.textContaining('almost no detail'), findsOneWidget);
    expect(find.text('Google Colab: not automated'), findsOneWidget);
    expect(find.text('Only free compute. Your own computer is never used.'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('40 of 100 shots done. 2 minutes elapsed of an estimated 7 minutes')), findsOneWidget);
    await tester.tap(find.text('Read Aloud'));
    expect(spoken.single, startsWith('"The Keeper": 40 of 100 shots done.'));
    expect(spoken.single, contains('every shot is a still picture with camera motion'));
  });

  testWidgets('making a film sends the subject, length and deadline, and shows CHE\'s real answer', (tester) async {
    tester.view.physicalSize = const Size(1200, 4000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    Map<String, dynamic>? posted;
    final client = CheFilmClient(baseUrl: 'https://che.example', headers: () => {'Authorization': 'Bearer t'}, client: MockClient((r) async {
      if (r.method == 'POST') {
        posted = jsonDecode(r.body) as Map<String, dynamic>;
        return http.Response.bytes(utf8.encode(jsonEncode({'ok': true, 'said': "I can't make a 10-minute film in 5 minutes with free compute. The fastest I can do is about 7 minutes, all stills with camera motion. Starting now."})), 200);
      }
      return http.Response.bytes(utf8.encode(jsonEncode(_view(state: 'done'))), 200);
    }));
    await tester.pumpWidget(MaterialApp(home: CheFilmStudioScreen(client: client, refreshEvery: const Duration(hours: 1))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Make the film'));
    await tester.pumpAndSettle();
    expect(posted, isNull, reason: 'nothing is sent without a subject');
    expect(find.text('Say or type what the film is about first.'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'What is the film about?'), 'a lighthouse keeper');
    await tester.tap(find.text('In 5 minutes'));
    await tester.tap(find.text('Make the film'));
    await tester.pumpAndSettle();
    expect(posted, {'action': 'make', 'topic': 'a lighthouse keeper', 'seconds': 600, 'deadline_s': 300});
    expect(find.textContaining("I can't make a 10-minute film in 5 minutes"), findsOneWidget);
  });

  testWidgets('remake, pause and the farm check each report the outcome; a typo is caught on the phone', (tester) async {
    tester.view.physicalSize = const Size(1200, 4000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final posts = <Map<String, dynamic>>[];
    final client = CheFilmClient(baseUrl: 'https://che.example', headers: () => {}, client: MockClient((r) async {
      if (r.method == 'POST') {
        final body = jsonDecode(r.body) as Map<String, dynamic>;
        posts.add(body);
        return http.Response.bytes(utf8.encode(jsonEncode({'ok': true, 'said': 'Done: ${body['action']}.'})), 200);
      }
      return http.Response.bytes(utf8.encode(jsonEncode(_view())), 200);
    }));
    await tester.pumpWidget(MaterialApp(home: CheFilmStudioScreen(client: client, refreshEvery: const Duration(hours: 1))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remake this shot'));
    await tester.pumpAndSettle();
    expect(find.text('Type the shot number to remake.'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'Shot number'), '2');
    await tester.tap(find.text('Remake this shot'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pause film'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Check the farm now'));
    await tester.pumpAndSettle();
    expect(posts.map((p) => p['action']), ['remake', 'pause', 'farm']);
    expect(posts.first['shot'], 2);
    expect(find.text('Done: farm.'), findsOneWidget);
  });

  test('durations are said the way CHE says them', () {
    expect(cheFilmDuration(45), '45 seconds');
    expect(cheFilmDuration(420), '7 minutes');
    expect(cheFilmDuration(3900), '65 minutes');
    expect(cheFilmDuration(7500), '2 hours 5 minutes');
  });

  testWidgets('the video series and video tools live in Film Studio (moved from Music, 2026-10-24)', (tester) async {
    tester.view.physicalSize = const Size(1200, 4000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final ran = <String>[];
    final client = CheFilmClient(baseUrl: 'https://che.example', headers: () => {}, client: MockClient((r) async => http.Response.bytes(utf8.encode(jsonEncode(_view())), 200)));
    await tester.pumpWidget(MaterialApp(
      home: CheFilmStudioScreen(
        client: client,
        refreshEvery: const Duration(hours: 1),
        series: const Text('Street Smart Explainers panel'),
        tools: [
          CheStudioAction(icon: Icons.movie_creation_outlined, title: 'Script + storyboard', body: 'Scenes.', connected: true, connectorName: '', onRun: () => ran.add('script')),
          CheStudioAction(icon: Icons.videocam_rounded, title: 'Generate video', body: 'Clips.', connected: false, connectorName: 'Video generator (CHE_VIDEO_GEN_URL)', onRun: () => ran.add('video')),
        ],
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Video series'), findsOneWidget);
    expect(find.text('Street Smart Explainers panel'), findsOneWidget);
    expect(find.text('CONNECT'), findsOneWidget, reason: 'an unconnected generator says what it needs');
    await tester.tap(find.text('Script + storyboard'));
    expect(ran, ['script']);
  });
}
