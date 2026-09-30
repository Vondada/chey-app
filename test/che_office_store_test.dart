import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/agents/che_office_floor_screen.dart';
import 'package:chey/agents/che_office_store.dart';
import 'package:chey/che_ui/che_agents.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

CheAgent _agent(String id, String name, {CheAgentStatus status = CheAgentStatus.idle, String? task}) =>
    CheAgent(id: id, name: name, role: '$name role', status: status, task: task);

List<CheAgent> _roster({CheAgentStatus nova = CheAgentStatus.idle}) => [
      _agent('n', 'Nova', status: nova, task: nova == CheAgentStatus.idle ? null : 'Write listing'),
      _agent('a', 'Atlas'),
      _agent('m', 'Mira'),
      _agent('k', 'Knox'),
      _agent('s', 'Sage'),
      _agent('l', 'Lyra'),
    ];

CheOfficeToday _board({List<String> announcements = const []}) => CheOfficeToday.fromJson({
      'started': [],
      'shipped': [],
      'blockers': [],
      'agents_working': 0,
      'agents': [
        {'id': 'knox', 'name': 'Knox', 'role': 'Engineering', 'state': 'blocked', 'status': 'Blocked: tool not configured (Codex)', 'job': ''},
        {'id': 'lyra', 'name': 'Lyra', 'role': 'Content', 'state': 'idle', 'status': 'Idle', 'job': ''},
      ],
      'stripe': {'connected': false},
      'che_announcements': announcements,
    });

void main() {
  test('one status change updates only that desk; the layout does not rebuild', () {
    final store = CheOfficeStore();
    store.setRoster(CheAgent.che(), _roster());
    expect(store.agentDeskIds, ['n', 'a', 'm', 'k', 's', 'l']);

    var knox = 0, nova = 0, layout = 0;
    store.desk('k')!.addListener(() => knox++);
    store.desk('n')!.addListener(() => nova++);
    store.deskOrder.addListener(() => layout++);

    store.patchDesk('k', 'Blocked: tool not configured (Codex)');
    expect(knox, 1);
    expect(nova, 0);
    expect(layout, 0);
    expect(store.desk('k')!.value.line, 'Blocked: tool not configured (Codex)');

    // The same roster again notifies nobody.
    store.setRoster(CheAgent.che(), _roster());
    expect([knox, nova, layout], [1, 0, 0]);

    // Nova starts working: only Nova's desk changes.
    store.setRoster(CheAgent.che(), _roster(nova: CheAgentStatus.building));
    expect([knox, nova, layout], [1, 1, 0]);
    expect(store.working.value, 1);

    // A new hire changes the layout.
    store.setRoster(CheAgent.che(), [..._roster(nova: CheAgentStatus.building), _agent('x', 'Orion')]);
    expect(layout, 1);
    store.dispose();
  });

  test('setBoard gives desks their real status and queues CHE lines once', () {
    final store = CheOfficeStore();
    store.setRoster(CheAgent.che(), _roster());
    store.setBoard(_board(announcements: ['CHE here. Blocked: tool not configured. Knox cannot start until Codex is connected on the Worker.']));
    expect(store.desk('k')!.value.line, 'Blocked: tool not configured (Codex)');
    expect(store.desk('l')!.value.line, 'Idle');
    expect(store.board.value, isNotNull);
    expect(store.takeAnnouncements().single, startsWith('CHE here. Blocked'));
    expect(store.takeAnnouncements(), isEmpty);
    store.dispose();
  });

  testWidgets('floor plan: labeled grid of desks, War Room on the same canvas, CHE front and center', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    final store = CheOfficeStore()..setRoster(CheAgent.che(), _roster());
    store.setBoard(_board());
    final tapped = <String>[];
    var warRoom = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: ListView(children: [
          CheOfficeFloorPlan(store: store, onTapDesk: tapped.add, onWarRoom: () => warRoom++),
        ]),
      ),
    ));
    await tester.pump();

    expect(find.byType(GridView), findsOneWidget);
    for (final name in ['Nova', 'Atlas', 'Mira', 'Knox', 'Sage', 'Lyra']) {
      expect(find.descendant(of: find.byType(GridView), matching: find.text(name)), findsOneWidget, reason: name);
    }
    expect(find.text('CHE'), findsOneWidget);
    expect(find.text('FRONT OF THE OFFICE'), findsOneWidget);
    expect(find.text('WAR ROOM'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Knox, Knox role\. Blocked: tool not configured \(Codex\)\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^CHE, Manager\.')), findsOneWidget);

    await tester.tap(find.text('Knox'));
    expect(tapped, ['k']);
    await tester.tap(find.text('WAR ROOM'));
    expect(warRoom, 1);

    await tester.pumpWidget(const SizedBox());
    store.dispose();
  });

  testWidgets('idle desks are static; working desks move', (tester) async {
    await tester.pumpWidget(MaterialApp(home: CheMiniPerson(agent: _agent('l', 'Lyra'))));
    expect(tester.hasRunningAnimations, isFalse);

    await tester.pumpWidget(MaterialApp(
      home: CheMiniPerson(agent: _agent('n', 'Nova', status: CheAgentStatus.building, task: 'Write listing')),
    ));
    await tester.pump(const Duration(milliseconds: 16));
    expect(tester.hasRunningAnimations, isTrue);

    // Back to idle: the motion stops.
    await tester.pumpWidget(MaterialApp(home: CheMiniPerson(agent: _agent('n', 'Nova'))));
    await tester.pump(const Duration(milliseconds: 16));
    expect(tester.hasRunningAnimations, isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  test('queued (waiting) is not animated; running statuses are', () {
    expect(cheAgentIsMoving(CheAgentStatus.idle), isFalse);
    expect(cheAgentIsMoving(CheAgentStatus.waiting), isFalse);
    expect(cheAgentIsMoving(CheAgentStatus.done), isFalse);
    expect(cheAgentIsMoving(CheAgentStatus.building), isTrue);
    expect(cheAgentIsMoving(CheAgentStatus.researching), isTrue);
  });
}
