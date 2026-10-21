// Spatial World MVP 1 (owner, 2026-10-20): the Meeting Room draws a real War
// Room meeting from its scene, reads it aloud on request, and speaks once
// when the meeting finishes.
import 'package:chey/world/che_meeting_room.dart';
import 'package:chey/world/che_scene_model.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _avatar(String id, String name, String role) => {
      'id': 'agent:$id', 'kind': 'avatar', 'label': '$name, $role', 'name': name, 'role': role, 'status': 'talking',
      'zone': 'seat:1', 'provenance': 'live', 'provenance_spoken': 'live state',
      'source': {'store': 'agent_runtime.team', 'id': id}, 'spoken': '$name, $role: drafting.',
    };

Map<String, dynamic> _scene({bool done = false}) => {
      'scene': 'meeting', 'id': 'm-1', 'title': 'Plan the Music Room launch', 'objective': 'Plan the Music Room launch',
      'stage': done ? 'complete' : 'drafting', 'progress': done ? 1 : 0.3, 'version': done ? 'v2' : 'v1',
      'spoken': done ? '2 agents at the table: Nova, Knox. The meeting is done, with one recommended path.' : '2 agents at the table: Nova, Knox. Each agent is drafting their part.',
      'objects': [
        _avatar('a1', 'Nova', 'Research Partner'),
        _avatar('a2', 'Knox', 'Critical Reviewer'),
        {
          'id': 'post:1', 'kind': 'draft', 'label': 'Nova: Draft', 'status': 'posted', 'zone': 'before:agent:a1', 'author': 'Nova',
          'provenance': 'model_output', 'provenance_spoken': 'an agent\'s output, not verified',
          'source': {'store': 'meeting.board', 'id': '1'}, 'text': 'Playlists drive retention.', 'preview': 'Playlists drive retention.',
          'spoken': 'Nova\'s draft: Playlists drive retention.',
        },
        // No source: never drawn.
        {'id': 'ghost', 'kind': 'draft', 'label': 'Ghost', 'author': 'Nova'},
        if (done) ...[
          {
            'id': 'suggestion:0', 'kind': 'suggestion', 'label': 'Suggestion 1', 'status': 'proposed', 'zone': 'table',
            'provenance': 'che_synthesis_unverified', 'provenance_spoken': 'CHE\'s synthesis, not verified',
            'source': {'store': 'meeting.recommendations', 'id': '0'}, 'text': 'Verify the retention claim first', 'preview': 'Verify the retention claim first',
            'spoken': 'Suggestion 1: Verify the retention claim first',
          },
          {
            'id': 'plan', 'kind': 'path', 'label': 'Recommended path', 'status': 'proposed', 'zone': 'center',
            'provenance': 'che_synthesis_unverified', 'provenance_spoken': 'CHE\'s synthesis, not verified',
            'source': {'store': 'meeting.final_plan', 'id': 'm-1'}, 'text': '1. Nova verifies the data. 2. Juno builds the MVP.',
            'preview': '1. Nova verifies the data. 2. Juno builds the MVP.', 'spoken': 'The recommended path: 1. Nova verifies the data. 2. Juno builds the MVP.',
          },
        ],
      ],
    };

void main() {
  test('the scene model keeps only objects with a record, and reads the path first', () {
    final scene = CheScene.fromJson(_scene(done: true))!;
    expect(scene.objects.any((o) => o.id == 'ghost'), isFalse);
    expect(scene.avatars.length, 2);
    expect(scene.readingOrder.first.isPath, isTrue);
    expect(scene.readingOrder.map((o) => o.id), ['plan', 'suggestion:0', 'post:1']);
    expect(scene.finished, isTrue);
    expect(CheScene.fromJson(const {}), isNull);
  });

  test('voice in the room answers from the scene, with each answer\'s provenance', () {
    final working = CheScene.fromJson(_scene())!;
    final done = CheScene.fromJson(_scene(done: true))!;
    expect(cheMeetingRoomAnswer(working, 'Read the suggestions'), contains('still working'));
    expect(cheMeetingRoomAnswer(done, 'CHE, read the suggestions.'), contains('1. Verify the retention claim first'));
    expect(cheMeetingRoomAnswer(done, 'read suggestion one'), contains('not verified'));
    expect(cheMeetingRoomAnswer(done, 'read suggestion 4'), 'There is one suggestion, sir.');
    expect(cheMeetingRoomAnswer(done, "What's the recommendation?"), contains('Juno builds the MVP'));
    expect(cheMeetingRoomAnswer(working, "what's the plan"), startsWith('There is no recommended path yet'));
    expect(cheMeetingRoomAnswer(done, "who's at the table"), contains('Knox, Critical Reviewer'));
    expect(cheMeetingRoomAnswer(done, "what's happening"), done.spoken);
    for (final m in ['What is the weather?', 'read my email', 'plan my week']) {
      expect(cheMeetingRoomAnswer(done, m), isNull, reason: m);
    }
  });

  testWidgets('the room shows the team, the cards and the path; inspect reads aloud; it speaks once when the meeting ends', (tester) async {
    tester.view.physicalSize = const Size(900, 3200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    var polls = 0;
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: CheMeetingRoom(
        meetingId: 'm-1',
        pollEvery: const Duration(milliseconds: 100),
        load: (_) async => _scene(done: ++polls > 1),
        onSpeak: (t) async => spoken.add(t),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Plan the Music Room launch'), findsWidgets);
    expect(find.text('Nova'), findsOneWidget);
    expect(find.text('Nova: Draft'), findsOneWidget);
    expect(find.text('Recommended path'), findsNothing);
    expect(CheMeetingRoom.current.value?.stage, 'drafting');
    expect(spoken, isEmpty, reason: 'passive arrivals stay silent');

    await tester.pump(const Duration(milliseconds: 150));
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Recommended path'), findsOneWidget);
    expect(spoken.length, 1, reason: 'the meeting the owner started ends: CHE says so once');
    expect(spoken.single, contains('Juno builds the MVP'));

    await tester.tap(find.text('Suggestion 1'));
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('Read aloud'), findsOneWidget);
    await tester.tap(find.text('Read aloud'));
    await tester.pump();
    expect(spoken.last, 'Suggestion 1: Verify the retention claim first That is CHE\'s synthesis, not verified.');

    await tester.pump(const Duration(seconds: 1));
    expect(polls, 2, reason: 'a finished meeting stops polling');
    await tester.pumpWidget(const SizedBox.shrink());
    expect(CheMeetingRoom.current.value, isNull);
  });
}
