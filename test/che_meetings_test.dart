// Owner, 2026-10-20: "once I left, I couldn't find my way back." Meetings
// lists the existing meetings, reopens the same room by id after leaving,
// switching rooms or a restart, answers the navigation phrases, and shows
// plain language instead of raw JSON or Markdown.
import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/world/che_meeting_room.dart';
import 'package:chey/world/che_meetings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

CheMeetingSummary _m(String id, String objective, String status, DateTime at) => CheMeetingSummary.fromJson({
      'id': id, 'objective': objective, 'status': status, 'progress': status == 'complete' ? 1 : 0.4,
      'participants': [{'name': 'Nova'}, {'name': 'Knox'}], 'created_at': at.toIso8601String(), 'updated_at': at.toIso8601String(),
    });

Map<String, dynamic> _scene(String id) => {
      'scene': 'meeting', 'id': id, 'title': 'Plan my app launch', 'objective': 'Plan my app launch', 'stage': 'complete', 'progress': 1, 'version': 'v1',
      'spoken': '2 agents at the table.',
      'objects': [
        {'id': 'agent:a1', 'kind': 'avatar', 'label': 'Nova, Research', 'name': 'Nova', 'role': 'Research', 'status': 'done', 'zone': 'seat:1', 'provenance': 'live', 'provenance_spoken': 'live state', 'source': {'store': 'agent_runtime.team', 'id': 'a1'}, 'spoken': 'Nova.'},
        {'id': 'post:1', 'kind': 'draft', 'label': 'Nova: Draft', 'status': 'posted', 'zone': 'before:agent:a1', 'author': 'Nova', 'provenance': 'model_output', 'provenance_spoken': 'an agent\'s output, not verified',
         'source': {'store': 'meeting.board', 'id': '1'}, 'text': '```json\n{"summary": "Launch with a waitlist first.", "risks": ["cost", "time"]}\n```', 'preview': '```json\n{"summary": "Launch with a waitlist first."}', 'spoken': 'Nova draft.'},
        {'id': 'plan', 'kind': 'path', 'label': 'Recommended path', 'status': 'proposed', 'zone': 'center', 'provenance': 'che_synthesis_unverified', 'provenance_spoken': 'CHE\'s synthesis, not verified',
         'source': {'store': 'meeting.final_plan', 'id': id}, 'text': '## Plan\n1. **Build** the waitlist.\n2. Ship the [beta](https://x.example).', 'preview': '## Plan\n1. **Build** the waitlist.', 'spoken': 'The recommended path.'},
      ],
    };

void main() {
  final now = DateTime(2026, 10, 20, 15);
  final meetings = [
    _m('m-live', 'Plan the Music Room launch', 'drafting', now.subtract(const Duration(minutes: 5))),
    _m('m-app', 'Plan my app launch and pricing', 'complete', now.subtract(const Duration(hours: 2))),
    _m('m-old', 'Pick a trading journal format', 'complete', now.subtract(const Duration(days: 3))),
  ];

  test('plain language: JSON and Markdown become short sentences', () {
    expect(chePlainText('```json\n{"summary": "Launch with a waitlist first.", "risks": ["cost"]}\n```'), 'Launch with a waitlist first.');
    expect(chePlainText('{"owner": "Nova", "steps": [1, 2, 3]}'), 'owner: Nova. 3 steps');
    expect(chePlainText('## Plan\n1. **Build** the waitlist.\n2. Ship the [beta](https://x.example).'), isNot(matches(RegExp(r'[#*\[\]()]'))));
    expect(chePlainText('## Plan\n1. **Build** the waitlist.'), contains('Build the waitlist.'));
    expect(chePlainText('word ' * 100, max: 60).length, lessThanOrEqualTo(61));
  });

  test('groups and dates are readable', () {
    final g = cheGroupMeetings(meetings, now: now);
    expect(g.active.map((m) => m.id), ['m-live']);
    expect(g.recent.map((m) => m.id), ['m-app']);
    expect(g.completed.map((m) => m.id), ['m-old']);
    expect(cheMeetingDate(DateTime(2026, 10, 20, 14, 5), now: now), 'Today, 2:05 PM');
    expect(cheMeetingDate(DateTime(2026, 10, 19, 9, 0), now: now), 'Yesterday, 9:00 AM');
    expect(cheMeetingDate(DateTime(2026, 10, 17, 16, 30), now: now), 'Oct 17, 4:30 PM');
    expect(cheMeetingStatusSpoken(meetings[0]), startsWith('in progress'));
  });

  test('voice: the three navigation phrases, and nothing else', () {
    expect(cheMeetingNavIntent('Take me back to my last meeting.')?.kind, 'last');
    expect(cheMeetingNavIntent('CHE, return to the meeting')?.kind, 'last');
    expect(cheMeetingNavIntent('Show my meetings')?.kind, 'list');
    final about = cheMeetingNavIntent('Open the meeting about my app');
    expect(about?.kind, 'about');
    expect(about?.topic, 'my app');
    expect(cheMatchMeeting(meetings, about!.topic)?.id, 'm-app');
    expect(cheMatchMeeting(meetings, 'music room')?.id, 'm-live');
    expect(cheMatchMeeting(meetings, 'weather'), isNull);
    for (final m in ['start a meeting about my app', 'read the suggestions', 'what meetings are on my calendar today', 'schedule a meeting']) {
      expect(cheMeetingNavIntent(m), isNull, reason: m);
    }
  });

  testWidgets('leave a meeting, find it in Meetings, reopen the same room; the last meeting survives a restart', (tester) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final loads = <String>[];
    final spoken = <String>[];
    final client = CheAgentRuntimeClient(baseUrl: () => 'https://che.example', headers: () => const {});
    Widget room(String id) => CheMeetingRoom(meetingId: id, load: (i) async { loads.add(i); return _scene(i); }, onSpeak: (t) async => spoken.add(t));

    await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: Builder(builder: (context) => Scaffold(body: Center(child: TextButton(
      onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => room('m-app'))),
      child: const Text('Office'),
    ))))));
    await tester.tap(find.text('Office'));
    await tester.pumpAndSettle(const Duration(seconds: 2));
    expect(loads, ['m-app']);
    // Plain language on the cards; the full sourced text on request.
    expect(find.textContaining('```'), findsNothing);
    expect(find.textContaining('Launch with a waitlist first.'), findsWidgets);
    expect(find.text('Leave meeting'), findsOneWidget);
    expect(find.text('Back to Office'), findsOneWidget);
    expect(spoken, isEmpty, reason: 'opening and leaving stay silent');

    await tester.tap(find.text('Leave meeting'));
    await tester.pumpAndSettle();
    expect(find.text('Office'), findsOneWidget, reason: 'left the room');
    expect(CheMeetingRoom.current.value, isNull);

    // "Restart": a fresh read of the stored pointer finds the same meeting.
    expect(await cheLastMeetingId(), 'm-app');

    await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: CheMeetingsPage(client: client, onSpeak: (t) async => spoken.add(t), load: () async => meetings)));
    await tester.pumpAndSettle();
    for (final t in ['Active (1)', 'Recent (1)', 'Completed (1)']) {
      expect(find.text(t), findsOneWidget, reason: t);
    }
    expect(find.textContaining('Return to meeting: Plan my app launch'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Plan the Music Room launch\. in progress')), findsOneWidget);
    expect(spoken, isEmpty);
  });

  testWidgets('a full card opens with the plain summary and the full sourced text below it', (tester) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: CheMeetingRoom(meetingId: 'm-app', load: (_) async => _scene('m-app'), onSpeak: (_) async {})));
    await tester.pumpAndSettle(const Duration(seconds: 2));
    await tester.tap(find.text('Nova: Draft').last);
    await tester.pumpAndSettle();
    expect(find.text('Full sourced text'), findsOneWidget);
    await tester.tap(find.text('Full sourced text'));
    await tester.pumpAndSettle();
    expect(find.textContaining('"risks"'), findsOneWidget, reason: 'the complete source is kept');
  });
}
