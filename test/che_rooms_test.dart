import 'dart:async';
import 'dart:convert';

import 'package:chey/browser/che_browser.dart';
import 'package:chey/che_immersive_hub_shell.dart';
import 'package:chey/che_ui/che_agents.dart';
import 'package:chey/home/che_insights_room.dart';
import 'package:chey/home/che_live_steps.dart';
import 'package:chey/che_ui/che_agent_chat.dart';
import 'package:chey/che_ui/che_backend.dart';
import 'package:chey/che_ui/che_brain.dart';
import 'package:chey/rooms/che_art_studio.dart';
import 'package:chey/rooms/che_creator_studio.dart';
import 'package:chey/rooms/che_markets_room.dart';
import 'package:chey/self_update/che_update_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

void main() {
  test('address bar: URLs open, anything else searches', () {
    expect(cheAddressToUri('example.com').toString(), 'https://example.com');
    expect(cheAddressToUri('https://x.io/a?b=1').toString(), 'https://x.io/a?b=1');
    final search = cheAddressToUri('best pizza near me');
    expect(search.host, 'duckduckgo.com');
    expect(search.queryParameters['q'], 'best pizza near me');
    expect(cheAddressToUri('javascript:alert(1)').host, 'duckduckgo.com');
  });

  test('che-update blocks parse and non-lib files are flagged', () {
    const text = 'Here you go.\n```che-update\n{"summary":"Add toggle","files":[{"path":"lib/a.dart","content":"x"},{"path":"ios/Podfile","content":"y"}]}\n```';
    final found = CheUpdateProposal.findInText(text);
    expect(found.single.summary, 'Add toggle');
    expect(found.single.files.length, 2);
    expect(found.single.problems.single, contains('ios/Podfile'));
    expect(CheUpdateProposal.stripBlocks(text), 'Here you go.');
    expect(CheUpdateProposal.findInText('```che-update\nnot json\n```'), isEmpty);
  });

  testWidgets('room navigator fits 9 rooms at iPhone width and switches rooms', (tester) async {
    _phone(tester);
    const names = ['Memory', 'Insights', 'Markets', 'Business', 'Devices', 'Music', 'Create', 'Office', 'Apps'];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheImmersiveHubShell(
          initialIndex: 3,
          tabs: [for (final n in names) Tab(icon: const Icon(Icons.circle), text: n)],
          pages: [for (final n in names) (_) => Center(child: Text('$n page'))],
        ),
      ),
    ));
    await tester.pump();
    expect(find.text('BUSINESS'), findsOneWidget);
    expect(find.text('Business page'), findsOneWidget);
    await tester.ensureVisible(find.text('Music'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Music'));
    await tester.pumpAndSettle();
    expect(find.text('MUSIC'), findsOneWidget);
    expect(find.text('Music page'), findsOneWidget);
  });

  testWidgets('Markets room shows real quotes, labels unavailable ones, and draws candles', (tester) async {
    _phone(tester);
    final client = MockClient((request) async {
      if (request.url.path == '/api/markets/snapshot') {
        return http.Response(jsonEncode({
          'source': 'Public sources',
          'quotes': [
            {'symbol': '^spx', 'name': 'S&P 500', 'price': 6123.4, 'change_pct': 0.52, 'status': 'delayed'},
            {'symbol': 'ETH', 'name': 'Ethereum', 'status': 'unavailable', 'note': 'Crypto source unavailable'},
          ],
        }), 200);
      }
      return http.Response(jsonEncode({
        'symbol': '^spx',
        'source': 'Stooq (delayed)',
        'candles': [
          {'date': '2026-09-24', 'open': 10, 'high': 12, 'low': 9, 'close': 11},
          {'date': '2026-09-25', 'open': 11, 'high': 13, 'low': 10, 'close': 12},
        ],
      }), 200);
    });
    final asked = <String>[];
    var ran = false;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheMarketsRoom(
          baseUrl: () => 'https://che.example',
          headers: () => const {},
          client: client,
          onAsk: asked.add,
          actions: [
            CheDeskAction(
              icon: Icons.science_outlined,
              title: 'Backtesting Lab',
              body: 'Tests',
              connected: false,
              connectorName: 'Backtest engine',
              onRun: () => ran = true,
            ),
          ],
        ),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    // The live chart now fills the top of the room; the quote panels follow it.
    expect(find.textContaining('E-mini S&P 500 futures'), findsWidgets);
    await tester.ensureVisible(find.text('6123', skipOffstage: false));
    await tester.pump();
    expect(find.text('6123'), findsOneWidget);
    expect(find.text('Unavailable'), findsOneWidget);
    expect(find.textContaining('Stooq (delayed)'), findsOneWidget);
    expect(find.textContaining('Needs: Backtest engine'), findsOneWidget);
    await tester.ensureVisible(find.text('Backtesting Lab'));
    await tester.pump();
    await tester.tap(find.text('Backtesting Lab'));
    expect(ran, isTrue);
    await tester.ensureVisible(find.text('Ask CHE'));
    await tester.pump();
    await tester.tap(find.text('Ask CHE'));
    expect(asked.single, contains('S&P 500'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('live steps show timer and agent chips; Office presence reports status', (tester) async {
    _phone(tester);
    var opened = false;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Column(children: [
          CheLiveStepsView(
            startedAt: DateTime.now(),
            steps: const [
              CheLiveStep(text: '✓ Nova delivered', agentId: 'n1', agentName: 'Nova'),
              CheLiveStep(text: '✓ Used Weather · forecast'),
            ],
            agents: const [CheAgent(id: 'n1', name: 'Nova', role: 'Research', status: CheAgentStatus.done)],
          ),
          CheOfficePresence(
            che: CheAgent.che(),
            working: 2,
            liveMeetings: 0,
            onTap: () => opened = true,
          ),
          const CheThoughtLine(thoughtMs: 1200, steps: ['✓ Used Weather · forecast']),
        ]),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.textContaining('Thinking…'), findsOneWidget);
    expect(find.text('Nova'), findsOneWidget);
    expect(find.text('✓ Used Weather · forecast'), findsOneWidget);
    expect(find.text('2 working'), findsOneWidget);
    expect(find.text('Thought 1.2s'), findsOneWidget);
    await tester.tap(find.text('2 working'));
    expect(opened, isTrue);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Creator Studio: ON AIR follows real activity and the render queue lists jobs', (tester) async {
    _phone(tester);
    Map<String, dynamic>? openedJob;
    Widget studio({required bool speaking, required List<Map<String, dynamic>> jobs}) => MaterialApp(
          home: Scaffold(
            body: CheCreatorStudio(
              speaking: speaking,
              jobs: jobs,
              onOpenJob: (job) => openedJob = job,
              musicScene: const Text('music room'),
              actions: [
                CheStudioAction(
                  icon: Icons.podcasts_rounded,
                  title: 'Podcast episode',
                  body: 'Script',
                  connected: true,
                  connectorName: '',
                  background: true,
                  onRun: () {},
                ),
              ],
            ),
          ),
        );
    await tester.pumpWidget(studio(speaking: false, jobs: const []));
    await tester.pump();
    expect(find.text('Studio ready'), findsOneWidget);
    await tester.pumpWidget(studio(speaking: false, jobs: const [
      {'id': 'j1', 'title': 'Podcast episode draft', 'status': 'running'},
    ]));
    await tester.pump();
    expect(find.text('Rendering in the cloud'), findsOneWidget);
    await tester.tap(find.text('Podcast episode draft'));
    expect(openedJob?['id'], 'j1');
    await tester.tap(find.text('Music'));
    await tester.pump();
    expect(find.text('music room'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Insights room: constellation primary with Soul and Log sheets', (tester) async {
    _phone(tester);
    final brain = CheBrain();
    final log = CheAgentController(backend: CheBackend.fromFuture((_) async => ''), brain: brain);
    log.logTurn('I trade futures', 'Noted. ```che-remember\n[Knowledge] Trades futures\n```');
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheInsightsRoom(map: const Text('neural map'), brain: brain, log: log, onOpenCloudLogs: () {}),
      ),
    ));
    await tester.pump();
    expect(find.text('neural map'), findsOneWidget);
    expect(find.text('Soul & facts'), findsOneWidget);
    expect(find.text('Log'), findsOneWidget);
    // No Map|Brain|Log segmented split.
    expect(find.text('Map'), findsNothing);
    await tester.tap(find.text('Soul & facts'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('CHE Brain'), findsOneWidget);
    Navigator.of(tester.element(find.text('CHE Brain'))).pop();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('Log'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Cloud copies on the CHE server'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 2));
    log.dispose();
    brain.dispose();
  });

  testWidgets('Art Studio shows the gallery wall and opens a piece with versions', (tester) async {
    _phone(tester);
    final client = MockClient((request) async {
      if (request.url.path == '/api/media') {
        return http.Response(jsonEncode({
          'engine': 'workers_ai',
          'upscaler': false,
          'items': [
            {'id': 'v2-000000', 'root_id': 'v1-000000', 'title': 'Neon studio', 'prompt': 'variation', 'mode': 'variation', 'version': 2, 'engine': 'CHE image engine'},
            {'id': 'v1-000000', 'root_id': 'v1-000000', 'title': 'Neon studio', 'prompt': 'A neon studio', 'mode': 'new', 'version': 1, 'engine': 'CHE image engine'},
          ],
        }), 200);
      }
      return http.Response('', 404);
    });
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheArtStudio(
          baseUrl: () => 'https://che.example',
          headers: () => const {},
          client: client,
          onSaveToVault: (_, _) async {},
        ),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('CHE image engine · highest quality'), findsOneWidget);
    expect(find.text('Neon studio'), findsOneWidget);
    expect(find.text('v2 · 2 versions'), findsOneWidget);
    await tester.tap(find.text('Neon studio'));
    await tester.pumpAndSettle();
    expect(find.text('Variation'), findsOneWidget);
    expect(find.text('Upscale (connect)'), findsOneWidget);
    expect(find.text('v1'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Markets chart ignores a slow response for an index the owner already left', (tester) async {
    _phone(tester);
    final slowSpx = Completer<http.Response>();
    final client = MockClient((request) async {
      if (request.url.path == '/api/markets/snapshot') {
        return http.Response(jsonEncode({
          'quotes': [
            {'symbol': '^spx', 'name': 'S&P 500', 'price': 1, 'change_pct': 0, 'status': 'delayed'},
            {'symbol': '^ndq', 'name': 'Nasdaq', 'price': 2, 'change_pct': 0, 'status': 'delayed'},
          ],
        }), 200);
      }
      final symbol = request.url.queryParameters['symbol'];
      if (symbol == '^spx') return slowSpx.future;
      return http.Response(jsonEncode({'candles': [
        {'date': '2026-09-25', 'open': 1, 'high': 2, 'low': 1, 'close': 2},
      ], 'source': 'NDQ source'}), 200);
    });
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheMarketsRoom(baseUrl: () => 'https://che.example', headers: () => const {}, client: client, onAsk: (_) {}, actions: const []),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    // The live chart sits above the delayed index panels.
    await tester.ensureVisible(find.text('Nasdaq', skipOffstage: false).last);
    await tester.pump();
    await tester.tap(find.text('Nasdaq').last);
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('NDQ source'), findsOneWidget);
    slowSpx.complete(http.Response(jsonEncode({'candles': [], 'error': 'SPX stale'}), 200));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('SPX stale'), findsNothing);
    expect(find.textContaining('NDQ source'), findsOneWidget);
    expect(find.text('Nasdaq · daily'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
