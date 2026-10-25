// The Office in the owner's approved HUD glass look (owner, 2026-10-22: "this style for all her rooms"), rendered at
// the owner's iPhone size (440 x 956 points). The Office header, the crew rows, the meeting row and today's board are
// glass panels over the navy backdrop, with mono HUD labels and a chrome title; the floor plan is drawn in code. The data is a fixed sample of the
// Worker's own answers (/api/agents and /api/office/today), so the picture shows real shapes, not invented ones.
import 'dart:convert';
import 'dart:io';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/agents/che_office_floor_screen.dart';
import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

// Shaped like GET /api/office/today (server/cloudflare/office_board.js).
final _board = {
  'started': [
    {'id': 't1', 'agent': 'Atlas', 'task': 'Research competitors in Houston', 'status': 'running'},
    {'id': 't2', 'agent': 'Knox', 'task': 'Build a landing page', 'status': 'blocked'},
  ],
  'shipped': [
    {'id': 't3', 'agent': 'Lyra', 'task': 'Write FAQ replies'},
  ],
  'blockers': [
    {'id': 't2', 'agent': 'Knox', 'task': 'Build a landing page', 'detail': 'Blocked: tool not configured (Codex)'},
  ],
  'stalled': [],
  'agents_working': 1,
  'agents': [
    {'id': 'atlas', 'name': 'Atlas', 'role': 'Research', 'state': 'running', 'status': 'Research competitors in Houston', 'job': 'Research competitors in Houston'},
    {'id': 'knox', 'name': 'Knox', 'role': 'Engineering / Codex jobs', 'state': 'blocked', 'status': 'Blocked: tool not configured (Codex)', 'job': 'Build a landing page'},
    {'id': 'lyra', 'name': 'Lyra', 'role': 'Content / social', 'state': 'idle', 'status': 'Idle', 'job': ''},
  ],
  'stripe': {'connected': false, 'charges_cents': 0, 'refunds_cents': 0, 'net_cents': 0, 'status': 'not_connected'},
};

CheAgentRuntimeClient _client() => CheAgentRuntimeClient(
      baseUrl: () => 'https://che.test',
      headers: () => const {},
      client: MockClient((request) async {
        final path = request.url.path;
        if (path == '/api/agents') {
          return http.Response(jsonEncode({
            'che': {'status': 'idle'},
            'agents': [
              {'id': 'atlas', 'name': 'Atlas', 'role': 'Research', 'status': 'researching', 'task': 'Research competitors in Houston'},
              {'id': 'knox', 'name': 'Knox', 'role': 'Engineering / Codex jobs', 'status': 'waiting', 'task': 'Build a landing page'},
              {'id': 'lyra', 'name': 'Lyra', 'role': 'Content / social', 'status': 'idle'},
            ],
            'working': 1,
            'meetings': [
              {
                'id': 'm1',
                'objective': 'Plan the Houston launch. Pick the first three offers.',
                'status': 'done',
                'progress': 1,
                'participants': [
                  {'name': 'Atlas'},
                  {'name': 'Lyra'},
                ],
              },
            ],
          }), 200);
        }
        if (path == '/api/office/today') return http.Response(jsonEncode({'board': _board}), 200);
        return http.Response('{}', 404);
      }),
    );

void main() {
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    // The HUD labels use Menlo, which iOS ships and the test machine does not; Roboto stands in for the picture.
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
    CheActivePalette.current = kCheHudPalette;
  });

  testWidgets('The Office in HUD glass', (tester) async {
    await tester.binding.setSurfaceSize(const Size(440, 956));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final theme = cheThemeFor(kCheHudPalette);
    await tester.pumpWidget(MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
      home: CheHudBackdrop(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          body: SafeArea(child: CheOfficeFloorScreen(client: _client(), embedded: true)),
        ),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    // CHE's avatar (Image.asset) decodes asynchronously. A fixed 50 ms was not always enough under a loaded full-suite
    // run, and the golden caught the empty ring (PR #524 CI). Wait for every picture in real time; the animation clock
    // does not move during runAsync, so the frame is the same one the golden was made from.
    final pictures = find.byType(Image).evaluate().toList();
    await tester.runAsync(() async {
      for (final e in pictures) {
        await precacheImage((e.widget as Image).image, e);
      }
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pump(const Duration(milliseconds: 400));

    // The room still says what it did before: the header, the crew and the readable controls.
    expect(find.text('The Office'), findsOneWidget);
    expect(find.text('BUSINESS OVERVIEW'), findsOneWidget);
    expect(find.text('OFFICE FLOOR PLAN'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Office header\. ')), findsOneWidget);
    expect(find.byTooltip('Refresh'), findsOneWidget);

    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/hud_office_floor.png'));

    // Further down: the agents as contact cards, then the War Room and next steps, also glass.
    await tester.scrollUntilVisible(find.text('NEXT STEPS'), 300, scrollable: find.byType(Scrollable).first);
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('WAR ROOM'), findsWidgets);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/hud_office_board.png'));
    await tester.pumpWidget(const SizedBox());
  });
}
