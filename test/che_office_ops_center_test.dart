// The Office as an AI operations center (owner UI cleanup, 2026-10-25): sections from real Worker answers, plain
// empty states, contact cards whose status comes from real task states, VoiceOver labels on every quick action, zones
// that open the right desks and rooms by tap or voice, and no speech on open.
import 'dart:convert';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/agents/che_office_floor_screen.dart';
import 'package:chey/agents/che_office_status.dart';
import 'package:chey/agents/che_office_voice.dart';
import 'package:chey/che_ui/che_agents.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'che_office_fixture.dart';

Future<void> _pumpOffice(
  WidgetTester tester,
  CheAgentRuntimeClient client, {
  List<String>? spoken,
  String? zone,
  String? agent,
  CheOfficeVoiceAction action = CheOfficeVoiceAction.open,
  List<String>? rooms,
  bool projects = true,
  bool emptyProjects = false,
}) async {
  tester.view.physicalSize = const Size(1320, 2868);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: CheOfficeFloorScreen(
        client: client,
        embedded: true,
        onSpeak: (t) async => spoken?.add(t),
        initialZone: zone,
        initialAgentName: agent,
        initialAction: action,
        onOpenRoom: rooms?.add,
        projects: projects ? (emptyProjects ? const [] : cheFixtureProjects) : null,
        onOpenProjects: () {},
      ),
    ),
  ));
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Finder _scroll() => find.byType(Scrollable).first;

/// Scrolls the Office down until [f] is built (it may match several widgets), then settles a few frames.
Future<void> _reveal(WidgetTester tester, Finder f) async {
  for (var i = 0; i < 60 && f.evaluate().isEmpty; i++) {
    await tester.drag(_scroll(), const Offset(0, -250));
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(f, findsWidgets);
  await tester.ensureVisible(f.first);
  await tester.pump(const Duration(milliseconds: 50));
}

/// Animated figures never settle, so frames are pumped for a fixed time instead of pumpAndSettle.
Future<void> _frames(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

void main() {
  group('card status mapping from real task states', () {
    const a = CheAgent(id: 'a', name: 'Atlas', role: 'Research');
    test('the Office board decides first', () {
      expect(cheWorkStateFor(a, boardState: 'working'), CheWorkState.working);
      expect(cheWorkStateFor(a, boardState: 'queued'), CheWorkState.queued);
      expect(cheWorkStateFor(a, boardState: 'blocked'), CheWorkState.blocked);
      expect(cheWorkStateFor(a, boardState: 'stalled'), CheWorkState.blocked);
      expect(cheWorkStateFor(a, boardState: 'failed'), CheWorkState.blocked);
      expect(cheWorkStateFor(a, boardState: 'done'), CheWorkState.finished);
      expect(cheWorkStateFor(a, boardState: 'idle', assignmentStatus: 'running'), CheWorkState.available);
    });
    test('then the latest team_tasks status', () {
      expect(cheWorkStateFor(a, assignmentStatus: 'queued'), CheWorkState.queued);
      for (final s in ['running', 'reviewing', 'review_pending']) {
        expect(cheWorkStateFor(a, assignmentStatus: s), CheWorkState.working, reason: s);
      }
      for (final s in ['blocked', 'failed', 'rejected', 'needs_review']) {
        expect(cheWorkStateFor(a, assignmentStatus: s), CheWorkState.blocked, reason: s);
      }
      expect(cheWorkStateFor(a, assignmentStatus: 'complete'), CheWorkState.finished);
    });
    test('then the runtime status; nothing is invented', () {
      expect(cheWorkStateFor(a), CheWorkState.available);
      expect(cheWorkStateFor(const CheAgent(id: 'a', name: 'Atlas', role: 'R', status: CheAgentStatus.building)), CheWorkState.working);
      expect(cheWorkStateFor(const CheAgent(id: 'a', name: 'Atlas', role: 'R', status: CheAgentStatus.waiting)), CheWorkState.queued);
      expect(cheWorkStateFor(const CheAgent(id: 'a', name: 'Atlas', role: 'R', status: CheAgentStatus.offline), boardState: 'working'),
          CheWorkState.offline);
    });
    test('lines say the real task or plain availability', () {
      const t = CheAgent(id: 'a', name: 'Atlas', role: 'R', task: 'Find rivals');
      expect(cheWorkLine(CheWorkState.working, t), 'Working on: Find rivals');
      expect(cheWorkLine(CheWorkState.queued, a, job: 'Find rivals'), 'Up next: Find rivals');
      expect(cheWorkLine(CheWorkState.blocked, a, note: 'Blocked: tool not configured (Codex)'), 'Blocked: tool not configured (Codex)');
      expect(cheWorkLine(CheWorkState.available, a), 'Available for a new task');
      expect(cheWorkingOnSpeech(a, CheWorkState.available, 'Available for a new task'), 'Atlas is available. No task is running or queued.');
    });
    test('zones come from the role first', () {
      expect(cheZoneForAgent(const CheAgent(id: 'x', name: 'Atlas', role: 'Research', specialty: 'Sourced market research')), CheOfficeZone.research);
      expect(cheZoneForAgent(const CheAgent(id: 'x', name: 'Zed', role: 'Futures trader')), CheOfficeZone.trading);
      expect(cheZoneForAgent(const CheAgent(id: 'x', name: 'Zed', role: 'Video editor')), CheOfficeZone.creative);
      expect(cheZoneForAgent(const CheAgent(id: 'x', name: 'Zed', role: 'Sales lead')), CheOfficeZone.operations);
      expect(cheZoneForAgent(const CheAgent(id: 'x', name: 'Zed', role: 'Helper')), CheOfficeZone.desks);
      expect(cheZoneForAgent(CheAgent.che()), CheOfficeZone.central);
    });
  });

  group('voice routes', () {
    test('zones, desks and card actions parse; other phrases do not', () {
      expect(cheParseOfficeVoice('Take me to the trading desk')!.zone, CheOfficeZone.trading);
      expect(cheParseOfficeVoice('CHE, open the creative studio.')!.zone, CheOfficeZone.creative);
      expect(cheParseOfficeVoice('show me the brain lab')!.zone, CheOfficeZone.research);
      expect(cheParseOfficeVoice('open business operations')!.zone, CheOfficeZone.operations);
      final desk = cheParseOfficeVoice("Open Atlas's desk")!;
      expect((desk.agentName, desk.action), ('Atlas', CheOfficeVoiceAction.open));
      expect(cheParseOfficeVoice('Show Atlas')!.agentName, 'Atlas');
      final msg = cheParseOfficeVoice('message Nova in the war room')!;
      expect((msg.agentName, msg.action), ('Nova', CheOfficeVoiceAction.message));
      final assign = cheParseOfficeVoice('assign a task to Knox')!;
      expect((assign.agentName, assign.action), ('Knox', CheOfficeVoiceAction.assign));
      expect(cheParseOfficeVoice('give Mira a task')!.action, CheOfficeVoiceAction.assign);
      // Left to their existing routes: the Worker's agentStatus, the Knowledge Atlas page, the Office tab.
      expect(cheParseOfficeVoice('what is Atlas working on'), isNull);
      expect(cheParseOfficeVoice('open the knowledge atlas'), isNull);
      expect(cheParseOfficeVoice('open the office'), isNull);
      expect(cheParseOfficeVoice('open the war room'), isNull);
    });
  });

  testWidgets('hub sections render from real records; no auto speech on open', (tester) async {
    final spoken = <String>[];
    await _pumpOffice(tester, cheFixtureClient(), spoken: spoken);
    for (final title in [
      'BUSINESS OVERVIEW',
      'NEEDS YOU (1)',
      'ACTIVE PROJECTS (2)',
      'OFFICE FLOOR PLAN',
      'OFFICE AGENTS',
      'CURRENT TASKS (4)',
      'RECENT VERIFIED ACTIVITY',
      'WAR ROOM',
      'NEXT STEPS',
    ]) {
      await _reveal(tester, find.text(title));
      expect(find.text(title), findsWidgets, reason: title);
    }
    expect(find.text('Old idea'), findsNothing, reason: 'completed projects are not active');
    expect(find.byType(ErrorWidget), findsNothing);
    expect(tester.takeException(), isNull);
    expect(spoken, isEmpty, reason: 'the Office never speaks by itself');
  });

  testWidgets('an empty Office says so plainly: no ErrorWidget, no placeholder boxes', (tester) async {
    final spoken = <String>[];
    await _pumpOffice(tester, cheFixtureClient(empty: true), spoken: spoken, emptyProjects: true);
    for (final line in [
      'Nothing is blocked or stalled.',
      'No active projects.',
      'No desk here yet.',
      'No agents yet. Ask CHE to staff the Office.',
      'No tasks are running or queued.',
      'Nothing was finished and approved by CHE today.',
      'No meetings yet. Convene the team when a project needs several specialties.',
      'Give the Office a goal. CHE staffs the team.',
    ]) {
      final f = find.textContaining(line);
      await _reveal(tester, f);
      expect(f, findsWidgets, reason: line);
    }
    expect(find.byType(ErrorWidget), findsNothing);
    expect(tester.takeException(), isNull);
    expect(spoken, isEmpty);
  });

  testWidgets('contact cards: real status and a labelled voice route for every quick action', (tester) async {
    await _pumpOffice(tester, cheFixtureClient());
    final expected = {
      'Nova': 'Working',
      'Atlas': 'Working',
      'Mira': 'Queued',
      'Knox': 'Blocked',
      'Sage': 'Finished',
      'Lyra': 'Available',
      'Iris': 'Available',
    };
    for (final MapEntry(key: name, value: state) in expected.entries) {
      final card = find.bySemanticsLabel(RegExp('^$name, [^.]+\\. $state\\. .*Double tap to open $name\'s desk\\.\$'));
      await _reveal(tester, card);
      expect(card, findsOneWidget, reason: name);
      for (final label in [
        'Message $name in the War Room',
        'Assign a task to $name',
        "Open $name's desk",
        'What are you working on, $name?',
      ]) {
        expect(find.bySemanticsLabel(RegExp('^${RegExp.escape(label)}')), findsOneWidget, reason: label);
      }
    }
  });

  testWidgets('What are you working on? speaks the real status and shows it', (tester) async {
    final spoken = <String>[];
    await _pumpOffice(tester, cheFixtureClient(), spoken: spoken);
    final ask = find.byKey(const ValueKey('agent-status-knox'));
    await _reveal(tester, ask);
    await tester.tap(ask);
    await tester.pump();
    expect(spoken.single, 'Knox: Blocked. Blocked: tool not configured (Codex).');
    expect(find.text(spoken.single), findsOneWidget, reason: 'shown as a banner too');
  });

  testWidgets('Assign sends the task to that agent and reports the real result aloud', (tester) async {
    final spoken = <String>[];
    final requests = <http.Request>[];
    await _pumpOffice(tester, cheFixtureClient(requests: requests), spoken: spoken);
    final assign = find.byKey(const ValueKey('agent-assign-lyra'));
    await _reveal(tester, assign);
    await tester.tap(assign);
    await _frames(tester);
    await tester.enterText(find.byType(TextField), 'Write three captions');
    await tester.tap(find.widgetWithText(FilledButton, 'Assign'));
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    final sent = requests.where((r) => r.url.path == '/api/agents/lyra/task').toList();
    expect(sent, hasLength(1));
    expect(jsonDecode(sent.single.body)['task'], 'Write three captions');
    expect(spoken.last, startsWith('Sent to Lyra: Write three captions.'));
  });

  testWidgets('a zone opens its real desks and leads to its room', (tester) async {
    final rooms = <String>[];
    await _pumpOffice(tester, cheFixtureClient(), rooms: rooms);
    final trading = find.text('TRADING DESK');
    await _reveal(tester, trading);
    await tester.tap(trading);
    await _frames(tester);
    expect(find.text('Trading Desk'), findsOneWidget);
    expect(find.text('Sage finished.'), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-card-sage')), findsWidgets);
    await tester.tap(find.byKey(const ValueKey('office-zone-room-trading')));
    await _frames(tester);
    expect(rooms, ['trading']);
  });

  testWidgets('a desk on the floor plan opens that agent\'s desk', (tester) async {
    await _pumpOffice(tester, cheFixtureClient());
    final knox = find.byKey(const ValueKey('office-desk-knox'));
    await _reveal(tester, knox);
    await tester.tap(knox);
    await _frames(tester);
    expect(find.text('Office Security Chief'), findsWidgets);
    expect(find.text('CURRENT JOB'), findsOneWidget);
  });

  testWidgets('voice deep links: a zone opens its sheet, an assign opens the Assign box, nothing speaks', (tester) async {
    final spoken = <String>[];
    await _pumpOffice(tester, cheFixtureClient(), spoken: spoken, zone: 'creative');
    await _frames(tester);
    expect(find.text('Creative Studio'), findsOneWidget);
    expect(find.text('Mira queued, Lyra available, Iris available.'), findsOneWidget);
    expect(spoken, isEmpty);

    await tester.pumpWidget(const SizedBox());
    await _pumpOffice(tester, cheFixtureClient(), spoken: spoken, agent: 'Atlas', action: CheOfficeVoiceAction.assign);
    await _frames(tester);
    expect(find.text('Assign a task to Atlas'), findsOneWidget);
    expect(spoken, isEmpty);
  });
}
