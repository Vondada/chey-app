import 'dart:convert';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/agents/che_office_floor_screen.dart';
import 'package:chey/home/che_activity_feed.dart';
import 'package:chey/che_ui/che_agents.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _nova = {
  'id': 'agent-nova-0001',
  'name': 'Nova',
  'role': 'Research Partner',
  'specialty': 'sources',
  'mission': 'Check facts.',
  'personality': 'Curious and fast.',
  'color': '5CC8FF',
  'hair': '2B1D14',
  'skin': 'C68B59',
  'status': 'researching',
  'task': 'Find competitors',
  'responsibilities': ['Own market research'],
  'model_tier': 'fast',
  'temporary': false,
};

const _meeting = {
  'id': 'meeting-0000001',
  'objective': 'Plan the launch',
  'status': 'complete',
  'progress': 1,
  'participants': [
    {'agent_id': 'agent-nova-0001', 'name': 'Nova', 'role': 'Research Partner', 'responsibility': 'Research slice'},
  ],
  'board': [
    {'from': 'Nova', 'agent_id': 'agent-nova-0001', 'kind': 'draft', 'text': 'Draft text'},
    {'from': 'CHE', 'kind': 'synthesis', 'text': '1. Ship it'},
  ],
  'decisions': ['Ship v1'],
  'conflicts': [],
  'recommendations': ['Test first'],
  'final_plan': '1. Ship it',
};

MockClient _backend(List<http.Request> seen) => MockClient((request) async {
      seen.add(request);
      final path = request.url.path;
      Object body;
      if (path == '/api/agents' && request.method == 'GET') {
        body = {
          'che': {'status': 'waiting', 'task': '1 delegated task in progress'},
          'agents': [_nova],
          'working': 1,
          'meetings': [_meeting],
        };
      } else if (path == '/api/agents/agent-nova-0001' && request.method == 'GET') {
        body = {
          'agent': _nova,
          'history': [
            {
              'id': 't1',
              'task': 'Find competitors',
              'status': 'complete',
              'result': 'Three found.',
              'che_review': 'APPROVED',
              'verified_by_che': true,
            },
          ],
          'meetings': [],
        };
      } else if (path == '/api/agents/agent-nova-0001/task') {
        body = {'task': {'id': 't2', 'status': 'queued'}};
      } else if (path == '/api/meetings/meeting-0000001') {
        body = {'meeting': _meeting};
      } else {
        return http.Response(jsonEncode({'detail': 'Not found.'}), 404);
      }
      return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
    });

void main() {
  test('short summaries keep titles glanceable', () {
    expect(cheShortSummary('Find competitors'), 'Find competitors');
    expect(cheShortSummary('Research the top five competitors in Houston. Then write a report.'),
        'Research the top five competitors in…');
    expect(cheShortSummary('Plan the launch: budget, venues and guests'), 'Plan the launch');
  });

  test('runtime client parses roster, agent detail and meetings', () async {
    final seen = <http.Request>[];
    final client = CheAgentRuntimeClient(
      baseUrl: () => 'https://che.example',
      headers: () => {'Authorization': 'Bearer x'},
      client: _backend(seen),
    );
    final runtime = CheAgentRuntimeController(client);
    await runtime.refresh();
    runtime.stop();

    expect(runtime.error, isNull);
    expect(runtime.che.status, CheAgentStatus.waiting);
    expect(runtime.agents.single.agent.name, 'Nova');
    expect(runtime.agents.single.agent.status, CheAgentStatus.researching);
    expect(runtime.agents.single.agent.color, const Color(0xFF5CC8FF));
    expect(runtime.meetings.single.statusLabel, 'Final plan ready');
    expect(seen.first.headers['Authorization'], 'Bearer x');

    final detail = await client.agent('agent-nova-0001');
    expect(detail.history.single.verifiedByChe, isTrue);
    expect(detail.profile.responsibilities, ['Own market research']);

    final meeting = await client.meeting('meeting-0000001');
    expect(meeting.decisions, ['Ship v1']);
    expect(meeting.board.last.kind, 'synthesis');
    runtime.dispose();
  });

  test('runtime surfaces backend errors honestly', () async {
    final client = CheAgentRuntimeClient(
      baseUrl: () => 'https://che.example',
      headers: () => const {},
      client: MockClient((_) async => http.Response('{"detail":"Pair your phone to CHE."}', 401)),
    );
    final runtime = CheAgentRuntimeController(client);
    await runtime.refresh();
    runtime.dispose();
    expect(runtime.error, contains('Pair this phone'));
    expect(runtime.agents, isEmpty);
  });

  testWidgets('Office floor shows live agents and the desk sheet sends a task', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    final seen = <http.Request>[];
    final client = CheAgentRuntimeClient(
      baseUrl: () => 'https://che.example',
      headers: () => const {},
      client: _backend(seen),
    );
    await tester.pumpWidget(MaterialApp(home: CheOfficeFloorScreen(client: client)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('Nova'), findsWidgets);
    expect(find.text('1 working'), findsOneWidget);
    expect(find.text('Plan the launch'), findsOneWidget);

    await tester.tap(find.text('Nova').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Curious and fast.'), findsOneWidget);
    expect(find.text('Approved by CHE'), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, 'Check pricing');
    await tester.tap(find.byTooltip('Send task'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    final sent = seen.where((r) => r.url.path.endsWith('/task')).single;
    expect(jsonDecode(sent.body), {'task': 'Check pricing'});

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('War Room shows the final plan, decisions and board', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    final client = CheAgentRuntimeClient(
      baseUrl: () => 'https://che.example',
      headers: () => const {},
      client: _backend([]),
    );
    await tester.pumpWidget(MaterialApp(home: CheOfficeFloorScreen(client: client)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.text('Plan the launch'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));

    expect(find.text('FINAL PLAN'), findsOneWidget);
    expect(find.text('• Ship v1'), findsOneWidget);
    expect(find.text('Draft text'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Office tab opens on the live world with Read to me', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    final client = CheAgentRuntimeClient(
      baseUrl: () => 'https://che.example',
      headers: () => const {},
      client: _backend([]),
    );
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheOfficeFloorScreen(client: client, embedded: true, onSpeak: (t) async => spoken.add(t)),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Nova'), findsWidgets);
    expect(find.textContaining('Agents working:'), findsOneWidget);
    await tester.tap(find.text('Read to me'));
    await tester.pump();
    expect(spoken.single, contains('Nova'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('activity feed reads real events aloud', (tester) async {
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheActivityFeedSheet(
          events: const [
            {'line': 'Mira finished “Summer song”.', 'at': '2026-09-29T10:00:00Z'},
          ],
          onSpeak: (t) async => spoken.add(t),
        ),
      ),
    ));
    expect(find.text('Mira finished “Summer song”.'), findsOneWidget);
    await tester.tap(find.text('Read all'));
    expect(spoken.single, 'Mira finished “Summer song”.');
  });
}
