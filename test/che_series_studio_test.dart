import 'dart:convert';

import 'package:chey/rooms/che_series_studio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// The shape /api/studio returns (server/cloudflare/creator_studio.js studioView).
Map<String, dynamic> view({String render = 'not_started', String youtube = 'not_connected', String? posted}) => {
      'series': {'title': 'Street Smart Explainers', 'format_label': 'Neighborhood Science', 'logline': 'A corner shop argues; a chalkboard explains.', 'cast': []},
      'pilot': {'episode': 'S1E1', 'title': 'Confident, Not Correct', 'seconds': 40, 'scenes': 6, 'valid': true, 'errors': [], 'render': render},
      'platforms': [
        {'id': 'youtube_shorts', 'label': 'YouTube Shorts', 'connection': youtube, 'exported': false, 'posted': posted},
        {'id': 'tiktok', 'label': 'TikTok', 'connection': 'not_connected', 'exported': true, 'posted': null},
        {'id': 'instagram_reels', 'label': 'Instagram Reels', 'connection': 'not_connected', 'exported': false, 'posted': null},
        {'id': 'facebook_reels', 'label': 'Facebook Reels', 'connection': 'not_connected', 'exported': false, 'posted': null},
      ],
      'capability': 'Phase 1 renders still illustrated scenes with burned-in captions and one narrator voice. It is not animation, not photoreal and not lip-synced.',
    };

Widget host(http.Client client, List<String> asked) => MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheSeriesStudioPanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: asked.add, client: client))),
    );

void main() {
  testWidgets('the series panel shows real states, opens silently and reads aloud only when asked', (tester) async {
    final asked = <String>[];
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(host(MockClient((r) async => http.Response(jsonEncode(view()), 200)), asked));
    await tester.pumpAndSettle();
    expect(find.text('Street Smart Explainers'), findsOneWidget);
    expect(find.textContaining('Pilot S1E1 "Confident, Not Correct", 40 seconds, 6 scenes: not rendered.'), findsOneWidget);
    expect(find.textContaining('not lip-synced'), findsOneWidget);
    expect(find.text('not connected'), findsNWidgets(4));
    expect(find.text('connected'), findsNothing, reason: 'nothing reads connected until the platform proved it');
    expect(find.bySemanticsLabel('TikTok: not connected, package checked.'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('Neighborhood Science. Pilot S1E1')), findsOneWidget);
    expect(asked, isEmpty, reason: 'opening the studio is silent');
    await tester.tap(find.text('Read aloud'));
    expect(asked, ['What is the pilot status?']);
    semantics.dispose();
  });

  testWidgets('each button asks CHE in the owner\'s words; posting is only a request she confirms', (tester) async {
    final asked = <String>[];
    await tester.pumpWidget(host(MockClient((r) async => http.Response(jsonEncode(view(render: 'verified', youtube: 'connected')), 200)), asked));
    await tester.pumpAndSettle();
    expect(find.textContaining('verified MP4'), findsOneWidget);
    expect(find.text('connected'), findsOneWidget);
    for (final button in ['Series bible', 'Pilot script', 'Render pilot', 'Export for every platform', 'Post to YouTube Shorts', 'Growth plan']) {
      await tester.ensureVisible(find.text(button));
      await tester.tap(find.text(button));
    }
    expect(asked, [
      'Show the series bible',
      'Read me the pilot script',
      'Render the pilot',
      'Export the pilot for every platform',
      'Post the pilot to YouTube Shorts',
      'Show the growth experiments',
    ]);
  });

  testWidgets('a posted pilot and an unreachable CHE are both shown as they are', (tester) async {
    await tester.pumpWidget(host(MockClient((r) async => http.Response(jsonEncode(view(render: 'verified', youtube: 'connected', posted: 'https://www.youtube.com/watch?v=abc')), 200)), []));
    await tester.pumpAndSettle();
    expect(find.text('posted'), findsOneWidget);
    // A fresh panel, so it loads again.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(host(MockClient((r) async => http.Response('{"detail":"down"}', 503)), []));
    await tester.pumpAndSettle();
    expect(find.textContaining('not available from CHE yet (503)'), findsOneWidget);
  });
}
