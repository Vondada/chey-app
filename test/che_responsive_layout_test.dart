// Responsive layout guard (owner, 2026-10-23: "every page fits its available width without clipping or cramped
// controls" on iPhone, Android, tablet and desktop, portrait and landscape). Each top-level screen outside the
// Trading Room, the Brain and login is pumped at real device viewports with offline fake data, in the HUD look,
// and any layout overflow or build exception fails the test with the screen and size that broke.
import 'dart:convert';
import 'dart:io';

import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_agents.dart';
import 'package:chey/che_ui/che_help.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/che_ui/che_showroom.dart';
import 'package:chey/commands/che_command_center.dart';
import 'package:chey/commands/che_command_client.dart';
import 'package:chey/commands/che_command_store.dart';
import 'package:chey/conversations/che_conversations_screen.dart';
import 'package:chey/film/che_film_studio_screen.dart';
import 'package:chey/home/che_cloud_logs_screen.dart';
import 'package:chey/home/che_connections_screen.dart';
import 'package:chey/home/che_more_tab.dart';
import 'package:chey/home/che_projects_board.dart';
import 'package:chey/home/che_ui_controls_screen.dart';
import 'package:chey/knowledge/che_knowledge_library_screen.dart';
import 'package:chey/mailbox/che_mailbox_screen.dart';
import 'package:chey/rithmic/che_rithmic_screen.dart';
import 'package:chey/rooms/che_alpaca_paper.dart';
import 'package:chey/rooms/che_invention_studio.dart';
import 'package:chey/rooms/che_strategy_controls.dart';
import 'package:chey/security/che_security_screen.dart';
import 'package:chey/visual/che_visual_client.dart';
import 'package:chey/visual/che_visual_studio.dart';
import 'package:chey/workflows/che_workflows_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/che_layout_fixtures.dart';

/// Real device viewports in logical pixels.
const kCheViewports = <String, Size>{
  'iPhone SE 375x667': Size(375, 667),
  'iPhone 15 393x852': Size(393, 852),
  'iPhone Pro Max 430x932': Size(430, 932),
  'iPhone landscape 852x393': Size(852, 393),
  'iPad 820x1180': Size(820, 1180),
  'Desktop 1440x900': Size(1440, 900),
};

const _base = 'https://che.test';
Map<String, String> _headers() => const {};

final Map<String, dynamic> _catalog =
    jsonDecode(File('test/fixtures/command_catalog.json').readAsStringSync()) as Map<String, dynamic>;

/// Offline Worker stand-in: the command catalog where screens ask for it, an empty object everywhere else.
final http.Client _fake = MockClient((req) async {
  final body = req.url.path == '/api/commands' ? _catalog : <String, dynamic>{};
  return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
});

/// A Worker stand-in that answers every request with [body] (the screen's real payload shape).
http.Client _fixed(Map<String, dynamic> body) => MockClient(
  (req) async => http.Response.bytes(
    utf8.encode(jsonEncode(body)),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  ),
);

final _screens = <String, Widget Function()>{
  'More': () => CheMoreTab(
    che: CheAgent.che(),
    onTalkToChe: () {},
    items: [
      for (final t in ['Capability Showroom', 'Trading Room', 'Conversations', 'Keys', 'UI Controls', 'Connections'])
        CheMoreItem(
          icon: Icons.apps_rounded,
          title: t,
          subtitle: 'What CHE can do here, in one line of plain words',
          onTap: () {},
        ),
    ],
  ),
  'Connections': () =>
      CheConnectionsScreen(baseUrl: _base, headers: _headers, client: _fake, onVoiceSettings: () {}, onKeys: () {}),
  'UI Controls': () => const CheUiControlsScreen(),
  'Commands': () => CheCommandCenterScreen(
    client: CheCommandClient(baseUrl: _base, headers: _headers, client: _fake),
    store: CheCommandStore(),
    onRunInChat: (message, {bool confirmed = false}) async {},
  ),
  'Knowledge Library': () => CheKnowledgeLibraryScreen(baseUrl: () => _base, headers: _headers, client: _fake),
  'Conversations': () =>
      CheConversationsScreen(baseUrl: () => _base, headers: _headers, client: _fixed(layoutConversations)),
  'Flagstaff mailbox': () => CheMailboxScreen(baseUrl: _base, headers: _headers, onSpeak: (_) {}),
  'Workflows': () => CheWorkflowsScreen(
    client: CheWorkflowsClient(baseUrl: _base, headers: _headers, client: _fixed(layoutWorkflows())),
  ),
  'Security': () => CheSecurityScreen(
    client: CheSecurityClient(
      baseUrl: _base,
      headers: _headers,
      client: _fixed(layoutSecurityCore()),
      biometric: (_) async => false,
    ),
  ),
  'Help': () => const CheHelpCenter(),
  'Showroom': () => CheShowroomPage(load: () async => const {}, onStart: (_) async {}),
  'Projects': () => Scaffold(
    body: CheProjectsBoard(items: const [], onAskChe: (_) {}),
  ),
  'Film Studio': () => CheFilmStudioScreen(
    client: CheFilmClient(baseUrl: _base, headers: _headers, client: _fixed(layoutFilm())),
    refreshEvery: const Duration(hours: 1),
  ),
  'Visual Studio': () => CheVisualStudio(
    client: CheVisualClient(baseUrl: () => _base, headers: _headers, client: _fake),
  ),
  'Rithmic': () => const CheRithmicScreen(),
  'Cloud logs': () => CheCloudLogsScreen(baseUrl: () => _base, headers: _headers, client: _fake),
  'Strategy controls': () => CheStrategyControlsPage(baseUrl: () => _base, headers: _headers, onAsk: (_) {}),
  'Alpaca paper': () => CheAlpacaPaperPage(baseUrl: () => _base, headers: _headers, onAsk: (_) {}, client: _fake),
  'Invention Studio': () => CheInventionStudioPage(baseUrl: _base, headers: const {}),
};

ThemeData _theme() => cheThemeFor(kCheHudPalette);

void main() {
  setUpAll(() {
    CheActivePalette.current = kCheHudPalette;
  });

  testWidgets('the guard itself catches an overflow (so a pass means something)', (tester) async {
    await tester.binding.setSurfaceSize(const Size(375, 667));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final errors = <String>[];
    final previous = FlutterError.onError;
    FlutterError.onError = (d) => errors.add(d.exceptionAsString());
    await tester.pumpWidget(const MaterialApp(home: Row(children: [SizedBox(width: 500), SizedBox(width: 10)])));
    FlutterError.onError = previous;
    expect(errors.join(), contains('overflowed'));
  });

  for (final screen in _screens.entries) {
    testWidgets('${screen.key} fits every device viewport without overflow', (tester) async {
      final failures = <String>[];
      for (final size in kCheViewports.entries) {
        for (final scale in const [1.0, 1.3]) {
          SharedPreferences.setMockInitialValues({});
          await tester.binding.setSurfaceSize(size.value);
          tester.view.physicalSize = size.value;
          tester.view.devicePixelRatio = 1;
          final errors = <String>[];
          final previous = FlutterError.onError;
          FlutterError.onError = (details) {
            errors.add(details.exceptionAsString().split('\n').first);
            if (Platform.environment['CHE_LAYOUT_DEBUG'] == '1') debugPrint(details.toString());
          };
          await http.runWithClient(() async {
            await tester.pumpWidget(
              MaterialApp(
                key: ValueKey('${size.key}$scale'),
                debugShowCheckedModeBanner: false,
                theme: _theme(),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
                  child: child!,
                ),
                home: CheHudBackdrop(child: screen.value()),
              ),
            );
            await tester.pump(const Duration(milliseconds: 300));
            await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
            await tester.pump(const Duration(milliseconds: 300));
          }, () => _fake);
          await tester.pumpWidget(const SizedBox());
          FlutterError.onError = previous;
          for (final e in errors.toSet()) {
            failures.add('${size.key} text x$scale: $e');
          }
        }
      }
      tester.view.reset();
      await tester.binding.setSurfaceSize(null);
      expect(failures, isEmpty, reason: '${screen.key} layout failures:\n${failures.join('\n')}');
    });
  }

  for (final screen in _screens.entries) {
    testWidgets('${screen.key} keeps 44pt touch targets on an iPhone', (tester) async {
      final semantics = tester.ensureSemantics();
      SharedPreferences.setMockInitialValues({});
      tester.view.physicalSize = const Size(393, 852);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await http.runWithClient(() async {
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: _theme(),
            home: CheHudBackdrop(child: screen.value()),
          ),
        );
        await tester.pump(const Duration(milliseconds: 300));
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
        await tester.pump(const Duration(milliseconds: 300));
      }, () => _fake);
      final result = await iOSTapTargetGuideline.evaluate(tester);
      await tester.pumpWidget(const SizedBox());
      semantics.dispose();
      expect(result.passed, isTrue, reason: '${screen.key}: ${result.reason}');
    });
  }
}
