// CHE's headquarters screen (owner mission, 2026-10-24): rooms from the Worker, a room page with its records and
// conversation, and a send that goes to the lead through the Worker route.
import 'dart:convert';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/rooms/che_headquarters.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _roomList = [
  {'id': 'security', 'name': 'Security Room', 'lead': 'Knox', 'title': 'Office Security Chief', 'status': 'Idle', 'task': null},
  {'id': 'engineering', 'name': 'Development Room', 'lead': 'Atlas', 'title': 'Chief Technology Officer', 'status': 'Waiting', 'task': 'Fix the chart overflow'},
];

const _rooms = {
  'rooms': _roomList,
  'counts': {'heads': 2, 'working': 0, 'waiting': 1, 'idle': 1, 'blocked': 0, 'offline': 0},
  'summary': 'No agent working, one waiting, one idle, sir. That is from the Office records, not from the animation.',
};

CheAgentRuntimeClient _client(List<http.Request> seen) => CheAgentRuntimeClient(
      baseUrl: () => 'https://che.example',
      headers: () => const {},
      client: MockClient((request) async {
        seen.add(request);
        if (request.url.path == '/api/office/hq') return http.Response(jsonEncode(_rooms), 200);
        if (request.url.path == '/api/office/hq/security' && request.method == 'GET') {
          return http.Response(jsonEncode({
            'room': _roomList[0],
            'facts': ['Room status: Idle.', 'No task is running right now.'],
            'conversation': [{'from': 'owner', 'text': 'Knox, give me a security report.'}],
          }), 200);
        }
        if (request.url.path == '/api/office/hq/talk') {
          return http.Response(jsonEncode({'room': 'security', 'agent': 'Knox', 'reply': 'Knox here, sir. Lockdown is off.', 'model_calls': 0}), 200);
        }
        return http.Response('{"detail":"not found"}', 404);
      }),
    );

void main() {
  testWidgets('lists every room with its lead and the summary from the records', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final seen = <http.Request>[];
    await tester.pumpWidget(MaterialApp(home: CheHeadquartersScreen(client: _client(seen))));
    await tester.pumpAndSettle();

    expect(find.text('Security Room'), findsOneWidget);
    expect(find.text('Led by Knox'), findsOneWidget);
    expect(find.textContaining('one waiting'), findsOneWidget);
    expect(find.text('Fix the chart overflow'), findsOneWidget);
  });

  testWidgets('a room opens with its lead, records and conversation; sending goes to the lead', (tester) async {
    tester.view.physicalSize = const Size(1170, 4200);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final seen = <http.Request>[];
    await tester.pumpWidget(MaterialApp(home: CheHeadquartersScreen(client: _client(seen))));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Security Room'));
    await tester.pumpAndSettle();
    expect(find.text('LEAD: Knox'), findsOneWidget);
    expect(find.text('Room status: Idle.'), findsOneWidget);
    expect(find.text('You: Knox, give me a security report.'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'Knox, give me a security report.');
    await tester.pumpAndSettle();
    final send = find.bySemanticsLabel('Send to Knox');
    await tester.ensureVisible(send);
    await tester.pumpAndSettle();
    await tester.tap(send);
    await tester.pumpAndSettle();

    final sent = seen.where((r) => r.url.path == '/api/office/hq/talk').single;
    expect(jsonDecode(sent.body), {'room': 'security', 'text': 'Knox, give me a security report.', 'mode': 'talk'});
    expect(find.text('Knox here, sir. Lockdown is off.'), findsOneWidget);
  });

  testWidgets('assign sends the task in assign mode, not as a chat line', (tester) async {
    // Tall enough that the whole room page fits, so both buttons sit inside the list's visible area.
    tester.view.physicalSize = const Size(1170, 4200);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final seen = <http.Request>[];
    await tester.pumpWidget(MaterialApp(home: CheHeadquartersScreen(client: _client(seen))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Security Room'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Review the login flow.');
    await tester.pumpAndSettle();
    final assign = find.widgetWithText(OutlinedButton, 'Assign to Knox');
    await tester.ensureVisible(assign);
    await tester.pumpAndSettle();
    await tester.tap(assign);
    await tester.pumpAndSettle();
    final sent = seen.where((r) => r.url.path == '/api/office/hq/talk').single;
    expect(jsonDecode(sent.body)['mode'], 'assign');
  });

  testWidgets('inside the Office tab there is no second app bar, and the 3D crew opens from its button', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    var opened = 0;
    await tester.pumpWidget(MaterialApp(
      home: CheHeadquartersScreen(client: _client(<http.Request>[]), embedded: true, onOpen3D: () => opened++),
    ));
    await tester.pumpAndSettle();

    expect(find.byType(AppBar), findsNothing);
    expect(find.text('Security Room'), findsOneWidget);
    await tester.tap(find.text('Open 3D crew'));
    expect(opened, 1);
  });

testWidgets('the Development Room shows its Office job; opening it shows each stage result and that it is not verified yet', (tester) async {
  tester.view.physicalSize = const Size(1170, 4200);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final client = CheAgentRuntimeClient(
    baseUrl: () => 'https://che.example',
    headers: () => const {},
    client: MockClient((request) async {
      if (request.url.path == '/api/office/hq') return http.Response(jsonEncode(_rooms), 200);
      if (request.url.path == '/api/office/hq/engineering') {
        return http.Response(jsonEncode({
          'room': {'id': 'engineering', 'name': 'Development Room', 'lead': 'Atlas', 'title': 'Chief Technology Officer', 'status': 'Working', 'task': null},
          'facts': ['Room status: Working.'],
          'conversation': [],
          'jobs': [_jobSummary],
        }), 200);
      }
      if (request.url.path == '/api/office/hq/job/oj-a609d813') {
        return http.Response(jsonEncode({
          'job': _jobSummary,
          'acceptance_criteria': ['The request is done as asked.'],
          'stage_results': [
            {'stage': 's1', 'agent': 'Atlas', 'discipline': 'engineering', 'status': 'complete', 'task_status': 'complete', 'result': 'Changed projects_list.dart: added a sort control.', 'error': ''},
          ],
          'evidence': [],
          'history': [],
        }), 200);
      }
      return http.Response('{"detail":"not found"}', 404);
    }),
  );
  await tester.pumpWidget(MaterialApp(home: CheHeadquartersScreen(client: client)));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Development Room'));
  await tester.pumpAndSettle();

  expect(find.text('OFFICE WORK'), findsOneWidget);
  expect(find.textContaining('Atlas (engineering): complete'), findsOneWidget);
  expect(find.textContaining('Not verified yet (running)'), findsOneWidget);

  await tester.tap(find.bySemanticsLabel(RegExp(r'Open result for Add a sort control')));
  await tester.pumpAndSettle();
  expect(find.text('Office result'), findsOneWidget);
  expect(find.textContaining('NOT VERIFIED YET'), findsOneWidget);
  expect(find.textContaining('Changed projects_list.dart'), findsOneWidget);
});

  testWidgets('asking CHE for a room shows her proposal in her words, with its layout, tools and cost', (tester) async {
    tester.view.physicalSize = const Size(1170, 4200);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final office = _FakeOffice();
    await tester.pumpWidget(MaterialApp(home: CheHeadquartersScreen(client: office.client())));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Ask CHE for a room'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'a robotics lab');
    await tester.tap(find.text('Ask CHE'));
    await tester.pumpAndSettle();

    final sent = office.seen.where((r) => r.method == 'POST' && r.url.path == '/api/office/rooms/proposals').single;
    expect(jsonDecode(sent.body), {'need': 'a robotics lab'});
    expect(find.text("Sir, I've developed a proposal for a new Robotics Lab. Would you like to review it?"), findsOneWidget);
    expect(find.text('Robotics Lab'), findsOneWidget);
    expect(find.textContaining('Layout: Workbench, Robot arm (simulated).'), findsOneWidget);
    expect(find.textContaining('Tools: Office task runtime connected; Robot simulator not connected.'), findsOneWidget);
    expect(find.textContaining('Nothing is bought or ordered'), findsOneWidget);
    expect(find.text('Approve'), findsOneWidget);
  });

  testWidgets('approve asks first; a verified room joins the headquarters and says so', (tester) async {
    tester.view.physicalSize = const Size(1170, 4200);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final office = _FakeOffice()..proposals.add(_proposal());
    await tester.pumpWidget(MaterialApp(home: CheHeadquartersScreen(client: office.client())));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Approve'));
    await tester.pumpAndSettle();
    expect(find.text('Build the Robotics Lab?'), findsOneWidget);
    expect(office.seen.where((r) => r.method == 'POST'), isEmpty, reason: 'nothing is built before the owner confirms');

    await tester.tap(find.text('Build and verify'));
    await tester.pumpAndSettle();
    final decision = office.seen.where((r) => r.url.path == '/api/office/rooms/proposals/rp-1a2b3c4d/decision').single;
    expect(jsonDecode(decision.body), {'decision': 'approve', 'changes': {}});
    expect(find.text('Verified: 1 of 1 checks passed. The Robotics Lab is in the headquarters.'), findsOneWidget);
    expect(find.text('Robotics Lab'), findsOneWidget, reason: 'the built room is a room tile now, not a proposal card');
    expect(find.text('Approve'), findsNothing);
  });

  testWidgets('a built room rolls back only after the owner confirms, and the list says what changed', (tester) async {
    tester.view.physicalSize = const Size(1170, 4200);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final office = _FakeOffice()..built = true;
    await tester.pumpWidget(MaterialApp(home: CheHeadquartersScreen(client: office.client())));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Robotics Lab'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Roll back Robotics Lab'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Roll back Robotics Lab'));
    await tester.pumpAndSettle();
    expect(find.text('Roll back the Robotics Lab?'), findsOneWidget);
    expect(office.seen.where((r) => r.method == 'POST'), isEmpty, reason: 'nothing is removed before the owner confirms');

    await tester.tap(find.text('Roll back'));
    await tester.pumpAndSettle();
    expect(office.seen.where((r) => r.method == 'POST' && r.url.path == '/api/office/rooms/robotics_lab/rollback'), hasLength(1));
    expect(find.text('No earlier version: the room is retired and leaves the headquarters.'), findsOneWidget);
    expect(find.text('Robotics Lab'), findsNothing);
  });
}

Map<String, dynamic> _proposal({String status = 'proposed'}) => {
      'id': 'rp-1a2b3c4d',
      'template': 'robotics_lab',
      'need': 'a robotics lab',
      'status': status,
      'version': 1,
      'room': {'id': 'robotics_lab', 'name': 'Robotics Lab', 'short': 'Robotics', 'purpose': 'Design and simulate robot tasks.', 'department': 'robotics'},
      'lead': {'name': 'Knox', 'reason': 'Knox leads engineering.', 'on_roster': true},
      'layout': [
        {'kind': 'bench', 'label': 'Workbench', 'x': -2.2, 'z': -2.6},
        {'kind': 'equipment', 'label': 'Robot arm (simulated)', 'x': 2.2, 'z': -2.6},
      ],
      'equipment': [
        {'name': 'Robot arm (simulated)', 'connected': false, 'cost': 'not measured', 'needs_approval': true},
      ],
      'tools': [
        {'name': 'Office task runtime', 'connected': true},
        {'name': 'Robot simulator', 'connected': false},
      ],
      'workflows': <String>[],
      'approvals': ['Buying or ordering any equipment'],
      'cost': {'measured': null, 'note': 'Not measured. Nothing is bought or ordered; equipment waits for approval.'},
      'checks': <String>[],
      'verification': status == 'active' ? {'passed': true, 'checks': [{'check': 'the lead is on the roster', 'passed': true}]} : null,
      'history': <Object>[],
    };

/// A small stand-in for the Worker's headquarters and room routes, so a test can see what the screen sent.
class _FakeOffice {
  final List<Map<String, dynamic>> proposals = [];
  final List<http.Request> seen = [];
  bool built = false;

  CheAgentRuntimeClient client() => CheAgentRuntimeClient(
        baseUrl: () => 'https://che.example',
        headers: () => const {},
        client: MockClient((request) async {
          seen.add(request);
          final path = request.url.path;
          if (path == '/api/office/hq') {
            return http.Response(jsonEncode({
              'rooms': [
                ..._roomList,
                if (built) {'id': 'robotics_lab', 'name': 'Robotics Lab', 'lead': 'Knox', 'title': 'Office Security Chief', 'status': 'Idle', 'task': null, 'custom': true},
              ],
              'counts': null,
              'summary': 'Two heads, sir.',
            }), 200);
          }
          if (path == '/api/office/rooms/proposals' && request.method == 'GET') {
            return http.Response(jsonEncode({'proposals': proposals, 'rooms': []}), 200);
          }
          if (path == '/api/office/rooms/proposals' && request.method == 'POST') {
            proposals.insert(0, _proposal());
            return http.Response(jsonEncode({'proposal': proposals.first, 'reused': false}), 200);
          }
          if (path == '/api/office/rooms/proposals/rp-1a2b3c4d/decision') {
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            if (body['decision'] == 'approve') {
              built = true;
              proposals[0] = _proposal(status: 'active');
              return http.Response(jsonEncode({'proposal': proposals[0], 'room': {'id': 'robotics_lab', 'status': 'active', 'version': 1}}), 200);
            }
            return http.Response(jsonEncode({'proposal': proposals[0]}), 200);
          }
          if (path == '/api/office/hq/robotics_lab' && request.method == 'GET') {
            return http.Response(jsonEncode({
              'room': {'id': 'robotics_lab', 'name': 'Robotics Lab', 'lead': 'Knox', 'title': 'Office Security Chief', 'status': 'Idle', 'task': null, 'custom': true},
              'facts': ['Room status: Idle.'],
              'conversation': [],
            }), 200);
          }
          if (path == '/api/office/rooms/robotics_lab/rollback') {
            built = false;
            return http.Response(jsonEncode({'room': {'id': 'robotics_lab', 'status': 'retired'}, 'note': 'No earlier version: the room is retired and leaves the headquarters.'}), 200);
          }
          return http.Response('{"detail":"not found"}', 404);
        }),
      );
}

const _jobSummary = {
  'id': 'oj-a609d813',
  'goal': 'Add a sort control to the Projects list.',
  'status': 'running',
  'workflow_stage': 'act',
  'verification': {'status': 'unverified', 'by': '', 'basis': ''},
  'stages': [
    {'id': 's1', 'agent': 'Atlas', 'discipline': 'engineering', 'status': 'complete'},
    {'id': 's2', 'agent': 'Knox', 'discipline': 'security', 'status': 'running'},
    {'id': 's3', 'agent': 'Vale', 'discipline': 'qa', 'status': 'pending'},
  ],
  'evidence_count': 1,
  'corrections': 0,
  'updated_at': '2026-10-24T00:00:00Z',
};
