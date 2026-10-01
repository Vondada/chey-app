import 'dart:convert';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/agents/che_office_floor_screen.dart';
import 'package:chey/che_ui/che_agents.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// Shaped exactly like GET /api/office/today from server/cloudflare/office_board.js.
Map<String, dynamic> _board({bool stripe = false}) => {
      'started': [
        {'id': 't1', 'agent': 'Atlas', 'task': 'Research competitors in Houston', 'status': 'queued'},
        {'id': 't2', 'agent': 'Knox', 'task': 'Build a landing page', 'status': 'blocked'},
        {'id': 't3', 'agent': 'Mira', 'task': 'Write FAQ replies', 'status': 'complete'},
      ],
      'shipped': [
        {'id': 't3', 'agent': 'Mira', 'task': 'Write FAQ replies'},
      ],
      'blockers': [
        {'id': 't2', 'agent': 'Knox', 'task': 'Build a landing page', 'detail': 'Blocked: tool not configured (Codex)'},
      ],
      'stalled': [
        {'id': 't2', 'agent': 'Knox', 'task': 'Build a landing page', 'detail': 'blocked'},
      ],
      'agents_working': 1,
      'agents': [
        {'id': 'atlas', 'name': 'Atlas', 'role': 'Research', 'state': 'queued', 'status': 'Up next: Research competitors in Houston', 'job': 'Research competitors in Houston'},
        {'id': 'knox', 'name': 'Knox', 'role': 'Engineering / Codex jobs', 'state': 'blocked', 'status': 'Blocked: tool not configured (Codex)', 'job': 'Build a landing page'},
        {'id': 'lyra', 'name': 'Lyra', 'role': 'Content / social', 'state': 'idle', 'status': 'Idle', 'job': ''},
      ],
      'stripe': stripe
          ? {'connected': true, 'charges_cents': 5000, 'refunds_cents': 1250, 'net_cents': 3750, 'status': 'connected'}
          : {'connected': false, 'charges_cents': 0, 'refunds_cents': 0, 'net_cents': 0, 'status': 'not_connected'},
    };

void main() {
  test('dollars and the always-visible header lines', () {
    expect(cheDollars(0), r'$0.00');
    expect(cheDollars(3750), r'$37.50');
    expect(cheDollars(-5), r'-$0.05');

    final off = CheOfficeToday.fromJson(_board());
    expect(cheOfficeHeaderLines(off, CheOfficeConnection.live), [
      'Built today: 1',
      r'Earned today: $0.00',
      'Agents working: 1',
      'Connection: live',
      r'$0.00 · Stripe not connected',
      'Stalled: 1',
    ]);

    final on = CheOfficeToday.fromJson(_board(stripe: true));
    expect(on.earnedTodayCents, 3750);
    expect(cheOfficeHeaderLines(on, CheOfficeConnection.reconnecting), [
      'Built today: 1',
      r'Earned today: $37.50',
      'Agents working: 1',
      'Connection: reconnecting',
      r'Stripe today: charges $50.00, refunds $12.50, net $37.50',
      'Stalled: 1',
    ]);

    // Before the first board arrives the header still shows honest zeros.
    expect(cheOfficeHeaderLines(null, CheOfficeConnection.down)[3], 'Connection: down');
  });

  test('board parses real desk status and CHE reads the whole board', () {
    final t = CheOfficeToday.fromJson(_board());
    expect(t.startedToday, 3);
    expect(t.deskFor('Knox')!.status, 'Blocked: tool not configured (Codex)');
    expect(t.deskFor('atlas')!.state, 'queued');
    final speech = cheOfficeBoardSpeech(t, CheOfficeConnection.live);
    expect(speech, startsWith('CHE here. Office board. Started today 3. Finished today 1. 1 working.'));
    expect(speech, contains(r'Stripe not connected. Earned today $0.00.'));
    expect(speech, contains('Blockers: Knox: Blocked: tool not configured (Codex).'));
    expect(speech, contains('Stalled: Knox: Build a landing page (blocked).'));
    expect(speech, contains('1. Atlas: Up next: Research competitors in Houston. 2. Knox: Blocked: tool not configured (Codex). 3. Lyra: Idle'));
    expect(cheOfficeHeaderLines(t, CheOfficeConnection.live).last, 'Stalled: 1');
  });

  test('desks show real job status instead of Idle', () {
    const knox = CheAgent(id: 'k', name: 'Knox', role: 'Engineering / Codex jobs', status: CheAgentStatus.offline, task: 'Blocked: tool not configured (Codex)');
    expect(cheDeskLine(knox, 'Blocked: tool not configured (Codex)'), 'Blocked: tool not configured (Codex)');
    const atlas = CheAgent(id: 'a', name: 'Atlas', role: 'Research');
    expect(cheDeskLine(atlas, 'Up next: Research competitors in Houston'), 'Up next: Research competitors in Houston');
    const nova = CheAgent(id: 'n', name: 'Nova', role: 'Product', status: CheAgentStatus.building, task: 'Write listing');
    expect(cheDeskLine(nova, null), 'Write listing');
    expect(cheDeskLine(const CheAgent(id: 'l', name: 'Lyra', role: 'Content'), null), 'Idle');
  });

  test('connection goes live, then reconnecting, then down on repeated failures', () async {
    var fail = false;
    final client = CheAgentRuntimeClient(
      baseUrl: () => 'https://che.example',
      headers: () => const {},
      client: MockClient((request) async => fail
          ? http.Response('{"detail":"boom"}', 503)
          : http.Response(jsonEncode({'che': {'status': 'idle'}, 'agents': [], 'working': 0, 'meetings': []}), 200)),
    );
    final c = CheAgentRuntimeController(client);
    expect(c.connection, CheOfficeConnection.reconnecting);
    await c.refresh();
    expect(c.connection, CheOfficeConnection.live);
    fail = true;
    await c.refresh();
    expect(c.connection, CheOfficeConnection.reconnecting);
    await c.refresh();
    await c.refresh();
    expect(c.connection, CheOfficeConnection.down);
    fail = false;
    await c.refresh();
    expect(c.connection, CheOfficeConnection.live);
    c.dispose();
  });

  testWidgets('Office screen: header always visible, labeled desks, board and voice actions', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    final seen = <http.Request>[];
    final client = CheAgentRuntimeClient(
      baseUrl: () => 'https://che.example',
      headers: () => const {},
      client: MockClient((request) async {
        seen.add(request);
        final path = request.url.path;
        if (path == '/api/agents') {
          return http.Response(jsonEncode({
            'che': {'status': 'idle'},
            'agents': [
              {'id': 'id-atlas', 'name': 'Atlas', 'role': 'Research', 'status': 'idle'},
              {'id': 'id-knox', 'name': 'Knox', 'role': 'Engineering / Codex jobs', 'status': 'idle'},
            ],
            'working': 0,
            'meetings': [],
          }), 200);
        }
        if (path == '/api/office/today') return http.Response(jsonEncode({'board': _board()}), 200);
        if (path == '/api/autonomy') return http.Response(jsonEncode({'autonomy': false, 'reply': 'Standing by, sir. Queued work is paused.'}), 200);
        if (path == '/api/office/goals') return http.Response(jsonEncode({'reply': 'CHE here. I split that into 1 job. 1. Atlas: Research rivals.'}), 200);
        return http.Response('{}', 404);
      }),
    );
    await tester.pumpWidget(MaterialApp(
      home: CheOfficeFloorScreen(client: client, onSpeak: (t) async => spoken.add(t)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    // Header: built today, earned today, agents working, connection, Stripe.
    expect(find.text('Built today: 1'), findsOneWidget);
    expect(find.text(r'Earned today: $0.00'), findsOneWidget);
    expect(find.text('Agents working: 1'), findsOneWidget);
    expect(find.text('Connection: live'), findsOneWidget);
    expect(find.descendant(of: find.byType(CheOfficeHeader), matching: find.text(r'$0.00 · Stripe not connected')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Office header\. Built today: 1\.')), findsOneWidget);

    // The default 3D surface has a voice-accessible flat-plan fallback.
    await tester.tap(find.text('Flat floor plan'));
    await tester.pump();

    // Desks: full names, roles and the real job status (never a bare Idle).
    expect(find.bySemanticsLabel(RegExp(r'^Knox, Engineering / Codex jobs\. Blocked: tool not configured \(Codex\)\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Atlas, Research\. Up next: Research competitors in Houston\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^CHE, Office Boss\.')), findsOneWidget);

    // The board sits below the floor plan and action buttons; scroll to it.
    await tester.scrollUntilVisible(find.text('BLOCKERS (1)'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('STARTED TODAY (3)'), findsOneWidget);
    expect(find.text('FINISHED TODAY (1)'), findsOneWidget);
    expect(find.text('STRIPE TODAY'), findsOneWidget);
    expect(find.text('BLOCKERS (1)'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('STALLED (1)'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('STALLED (1)'), findsOneWidget);

    await tester.ensureVisible(find.text('Stand down the Office'));
    await tester.pump();
    await tester.tap(find.text('Stand down the Office'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(seen.any((r) => r.url.path == '/api/autonomy' && jsonDecode(r.body)['enabled'] == false), isTrue);
    expect(spoken.last, startsWith('CHE here. Office standing down.'));
    expect(find.text(spoken.last), findsOneWidget, reason: 'spoken result is also shown');

    await tester.tap(find.byTooltip('Read this Office to me'));
    await tester.pump();
    expect(spoken.last, startsWith('CHE here. Office board.'));
    await tester.pumpWidget(const SizedBox());
  });
}
