// SECURITY command center over the Security Core: protection state, readiness with its working, the Cyber World from
// real state (animating only on real events or a labelled drill, never with Reduce Motion), lockdown preview before
// confirmation, drills labelled SIMULATION, access control, incident replay and the Home destination.
import 'dart:convert';

import 'package:chey/che_ui/che_agents.dart';
import 'package:chey/home/che_mockup_home.dart';
import 'package:chey/security/che_cyber_world.dart';
import 'package:chey/security/che_security_panels.dart';
import 'package:chey/security/che_security_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

Map<String, dynamic> _coreView({List<Map<String, dynamic>> pulses = const [], String state = 'MONITORING'}) => {
      'core': {'version': '1.0.0', 'product_name': 'Security', 'engines': List.filled(13, 'x')},
      'spoken': 'Security is monitoring: No security check in the last day. Readiness 80 out of 100. This lowers risk; no system can be made unhackable.',
      'status': 'Lockdown is off. No serious security events in the last day.',
      'protection': {'locked_down': false, 'internal_only': false, 'state': state, 'reason': 'No security check in the last day.'},
      'readiness': {
        'score': 80,
        'how': 'Weighted average of 2 measured component(s) out of 8; unmeasured components are excluded, not counted as passing. A readiness score measures preparation, not immunity.',
        'components': [
          {'id': 'open_incidents', 'label': 'No open incidents', 'weight': 20, 'score': 1, 'status': 'pass', 'evidence': '0 open incident(s)'},
          {'id': 'backup', 'label': 'Trusted snapshot within a week', 'weight': 10, 'score': 0, 'status': 'fail', 'evidence': 'no trusted snapshot'},
        ],
        'unknown': ['recent_check'],
      },
      'world': {
        'nodes': [
          {'id': 'worker', 'kind': 'server', 'label': 'CHE server', 'status': pulses.isEmpty ? 'ok' : 'alert', 'events_24h': pulses.length},
          {'id': 'vault', 'kind': 'vault', 'label': 'Password vault (on your phone)', 'status': 'unknown', 'events_24h': 0, 'detail': 'Kept only on the phone; the server cannot see it.'},
          {'id': 'repository', 'kind': 'repository', 'label': 'Code repository', 'status': 'ok', 'events_24h': 0},
        ],
        'links': [],
        'pulses': pulses,
        'simulated': false,
      },
      'systems': [
        {'id': 'worker', 'kind': 'server', 'label': 'CHE server', 'status': 'ok', 'events_24h': 0},
      ],
      'defense': {'active': [], 'recent': []},
      'sections': {'threats': [], 'identity': [], 'code': [], 'dependencies': [], 'secrets': [], 'malware': []},
      'access': {
        'principals': [
          {'id': 'che', 'kind': 'agent', 'name': 'CHE', 'scopes': ['chat'], 'status': 'active'},
          {'id': 'tool:wide', 'kind': 'tool', 'name': 'Wide tool', 'scopes': ['*'], 'status': 'active'},
          {'id': 'app:spotify', 'kind': 'app', 'name': 'spotify', 'scopes': ['open'], 'status': 'active'},
          {'id': 'device:d1', 'kind': 'device', 'name': 'Owner iPhone', 'scopes': ['owner'], 'status': 'active'},
        ],
        'review': {
          'findings': [{'id': 'tool:wide', 'kind': 'tool', 'severity': 'high', 'issue': 'holds every scope (wildcard)'}],
        },
      },
      'backups': {'last_snapshot_at': null},
      'knowledge': {'private': [], 'shared': [], 'portability': [], 'categories': []},
      'policies': {'list': [{'id': 'defensive_only', 'rule': 'No offensive hacking, exploitation, retaliation or counter-attack, ever.'}]},
      'simulations': {
        'scenarios': [{'id': 'pairing_flood', 'name': 'Repeated wrong pairing codes'}],
        'recent': [],
      },
      'physical': {'architecture_only': true, 'devices': [], 'note': 'Physical security is architecture only: no camera, lock, alarm or sensor is connected.'},
      'lockdown': {'active': false},
    };

const _preview = {
  'effects': [
    {'id': 'remote_engines', 'effect': 'Chat to remote AI engines pauses; CHE answers with her on-phone brain.'},
    {'id': 'key_changes', 'effect': 'Adding, changing or removing keys is refused.'},
  ],
  'unaffected': ['The password vault stays on your phone and is not touched.'],
  'token': 'tok123',
  'requires_confirmation': true,
};

CheSecurityClient _client({Map<String, dynamic>? core, List<String>? posts, List<Map<String, dynamic>>? bodies}) => CheSecurityClient(
      baseUrl: 'https://che.test',
      headers: () => {},
      biometric: (_) async => false,
      client: MockClient((req) async {
        if (req.method == 'GET' && req.url.path == '/api/security/core') return _json(core ?? _coreView());
        if (req.method == 'GET') return _json({'status': 'Lockdown is off. No serious security events in the last day.', 'internal_only': false, 'events': []});
        posts?.add(req.url.path);
        bodies?.add(req.body.isEmpty ? {} : Map<String, dynamic>.from(jsonDecode(req.body) as Map));
        return switch (req.url.path) {
          '/api/security/core/lockdown/preview' => _json({'preview': _preview}),
          '/api/security/core/lockdown/confirm' => _json({'ok': true, 'locked': true}),
          '/api/security/core/simulate' => _json({'label': 'SIMULATION', 'replay': {'frames': List.filled(8, {})}}),
          '/api/security/core/check' => _json({..._coreView(), 'spoken': 'Security is secured: a check ran just now.'}),
          _ => _json({}),
        };
      }),
    );

Future<void> _tall(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1200, 4000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

void main() {
  testWidgets('command center: protection state, readiness with its working, Cyber World nodes for VoiceOver, silent on open', (tester) async {
    await _tall(tester);
    String? spoken;
    await tester.pumpWidget(MaterialApp(home: CheSecurityScreen(client: _client(), onSpeak: (t) => spoken = t)));
    await tester.pumpAndSettle();
    expect(find.text('MONITORING'), findsOneWidget);
    expect(find.text('Readiness: 80 / 100'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Readiness 80 out of 100\. Weighted average')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Password vault \(on your phone\): status unknown')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^CHE server: normal')), findsOneWidget);
    expect(spoken, isNull, reason: 'nothing is spoken when the page opens');
    await tester.tap(find.text('Read Aloud'));
    expect(spoken, contains('Security is monitoring'));
    for (final s in ['Active Defense', 'Recent Defense', 'Systems', 'Threats', 'Access', 'Identity', 'Code', 'Dependencies', 'Secrets', 'Malware', 'Backups', 'Knowledge', 'Policies', 'Simulations']) {
      expect(find.textContaining(RegExp('^${RegExp.escape(s)} \\(')), findsOneWidget, reason: s);
    }
    await tester.tap(find.text('Run Security Check'));
    await tester.pumpAndSettle();
    expect(find.text('Security is secured: a check ran just now.'), findsOneWidget);
  });

  testWidgets('Cyber World animates only for real pulses, and never with Reduce Motion', (tester) async {
    Widget world({List<String> pulses = const [], String? sim, bool reduce = false}) => MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(size: const Size(400, 800), disableAnimations: reduce),
            child: Scaffold(body: CheCyberWorld(nodes: const [CheWorldNode(id: 'worker', kind: 'server', label: 'Server', status: 'ok', events24h: 0)], pulses: pulses, simulationPulse: sim)),
          ),
        );
    await tester.pumpWidget(world());
    expect(tester.hasRunningAnimations, isFalse, reason: 'no real event, no motion');
    await tester.pumpWidget(world(pulses: ['worker']));
    await tester.pump();
    expect(tester.hasRunningAnimations, isTrue);
    await tester.pumpWidget(world(pulses: ['worker'], reduce: true));
    await tester.pump();
    expect(tester.hasRunningAnimations, isFalse, reason: 'Reduce Motion stops it');
    await tester.pumpWidget(world(sim: 'worker'));
    await tester.pump();
    expect(find.text('SIMULATION'), findsOneWidget);
    expect(find.bySemanticsLabel('A simulation is showing. Nothing real is affected.'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('lockdown: the preview lists effects and changes nothing; only Confirm Lockdown sends the token with confirm', (tester) async {
    await _tall(tester);
    final posts = <String>[];
    final bodies = <Map<String, dynamic>>[];
    await tester.pumpWidget(MaterialApp(home: CheSecurityScreen(client: _client(posts: posts, bodies: bodies))));
    await tester.pumpAndSettle();
    expect(find.text('Lock Down CHE'), findsNothing, reason: 'no one-tap lockdown when the preview exists');
    await tester.tap(find.text('Preview Lockdown'));
    await tester.pumpAndSettle();
    expect(find.text('Lockdown preview: nothing has changed yet'), findsOneWidget);
    expect(find.text('1. Chat to remote AI engines pauses; CHE answers with her on-phone brain.'), findsOneWidget);
    expect(posts, ['/api/security/core/lockdown/preview']);
    await tester.tap(find.text('Confirm Lockdown'));
    await tester.pumpAndSettle();
    expect(posts.last, '/api/security/core/lockdown/confirm');
    expect(bodies.last, {'token': 'tok123', 'confirm': true});
    expect(find.textContaining('Lockdown is on and confirmed'), findsOneWidget);
  });

  testWidgets('a drill is announced as SIMULATION and marked on the Cyber World', (tester) async {
    await _tall(tester);
    final posts = <String>[];
    await tester.pumpWidget(MaterialApp(home: CheSecurityScreen(client: _client(posts: posts))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Simulations (0)'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Run Drill: Repeated wrong pairing codes'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(posts, ['/api/security/core/simulate']);
    expect(find.textContaining('SIMULATION: Repeated wrong pairing codes'), findsOneWidget);
    expect(find.text('Showing a SIMULATION pulse. Real systems are unaffected.'), findsOneWidget);
    await tester.tap(find.text('Clear Simulation View'));
    await tester.pumpAndSettle();
    expect(find.text('SIMULATION'), findsNothing);
  });

  testWidgets('access control lists agents, tools, apps and devices with least-privilege findings', (tester) async {
    await _tall(tester);
    String? spoken;
    final access = Map<String, dynamic>.from(_coreView()['access'] as Map);
    await tester.pumpWidget(MaterialApp(home: CheSecurityAccessScreen(access: access, onSpeak: (t) => spoken = t)));
    for (final t in ['Agents', 'Tools', 'Apps', 'Devices']) {
      expect(find.text(t), findsOneWidget);
    }
    expect(find.bySemanticsLabel(RegExp(r'^Wide tool, active\. Scopes: \*\. Finding: holds every scope')), findsOneWidget);
    await tester.tap(find.byTooltip('Read access control aloud'));
    expect(spoken, contains('1 agents, 1 tools, 1 apps, 1 devices'));
    expect(spoken, contains('1. tool:wide holds every scope'));
  });

  testWidgets('incident replay steps through recorded frames and labels a drill SIMULATION', (tester) async {
    await _tall(tester);
    String? spoken;
    final replay = {
      'title': 'SIMULATION: Repeated wrong pairing codes',
      'label': 'SIMULATION',
      'frames': [
        {'stage': 'DETECTED', 'offset_ms': 0, 'by': 'security (simulation)', 'note': 'Opened from 1 event(s).'},
        {'stage': 'TRIAGED', 'offset_ms': 1000, 'by': 'security (simulation)', 'note': 'Severity and scope assessed.'},
      ],
    };
    await tester.pumpWidget(MaterialApp(home: CheIncidentReplayScreen(replay: replay, onSpeak: (t) => spoken = t)));
    expect(find.text('Replay · SIMULATION'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^SIMULATION\. Step 1 of 2: detected')), findsWidgets);
    await tester.tap(find.text('Next Step'));
    await tester.pump();
    await tester.tap(find.text('Read Aloud'));
    expect(spoken, startsWith('SIMULATION. Step 2 of 2: triaged, 1.0 seconds after detection'));
  });

  testWidgets('Home lists Security as a destination when the app wires it', (tester) async {
    var opened = 0;
    CheMockupHome home({VoidCallback? security}) => CheMockupHome(
          che: CheAgent.che(), agents: const [], working: 0, liveMeetings: 0, connected: true, greeting: '',
          onTalk: () {}, onOpenChat: () {}, onOpenOffice: () {}, onOpenBrain: () {}, onOpenTrading: () {}, onOpenCreate: () {}, onOpenWorld: () {},
          onOpenSecurity: security, onOfficeStatus: () {},
        );
    expect(home().destinations.map((d) => d.id), isNot(contains('security')));
    final h = home(security: () => opened++);
    final sec = h.destinations.singleWhere((d) => d.id == 'security');
    expect(sec.label, 'Security');
    sec.onOpen();
    expect(opened, 1);
  });
}
