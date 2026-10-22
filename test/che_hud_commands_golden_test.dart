// The Commands and Flagstaff rooms in the owner's approved HUD glass look (owner, 2026-10-22: "this style for all her
// rooms"), rendered at the owner's iPhone size (440 x 956 points). The images in test/goldens are the evidence: glass
// panels with a spectral rim over the navy backdrop, chrome titles and mono ice-blue section labels. The data is the
// Worker's own command catalog fixture and a small fake Flagstaff; HTTP never leaves the test.
import 'dart:convert';
import 'dart:io';

import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/commands/che_command_center.dart';
import 'package:chey/commands/che_command_client.dart';
import 'package:chey/commands/che_command_store.dart';
import 'package:chey/mailbox/che_mailbox_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

http.Response _json(Object body) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});

final Map<String, dynamic> _catalog =
    jsonDecode(File('test/fixtures/command_catalog.json').readAsStringSync()) as Map<String, dynamic>;

final _commands = MockClient((request) async {
  if (request.url.path == '/api/commands') {
    return _json({
      ..._catalog,
      'workflows': <Object>[],
      'missions': [
        {
          'id': 'm-1',
          'name': 'Website clients',
          'status': 'running',
          'spoken': 'Website clients: 1 of 2 steps done.',
          'steps': [
            {'id': 's1', 'title': 'Find local businesses without a website', 'status': 'complete', 'depends_on': <Object>[]},
            {'id': 's2', 'title': 'Draft a short offer for each', 'status': 'running', 'depends_on': ['s1']},
          ],
        },
      ],
      'runs': [
        {'command': 'trade-chart', 'input': 'MNQ', 'status': 'complete', 'reply': 'MNQ 5-minute chart is open. Data is delayed.'},
      ],
    });
  }
  return http.Response('{}', 404);
});

final _flagstaff = MockClient((request) async {
  switch (request.url.path) {
    case '/api/flagstaff':
      return _json({
        'open': true,
        'link': 'https://che.test/flagstaff/369',
        'unread': 0,
        'messages': [
          {'from': 'claude', 'to': 'che', 'text': 'The Commands room is on HUD glass now.', 'at': '2026-10-22T14:02:00Z'},
          {'from': 'che', 'to': 'claude', 'text': 'Thank you. I will show the owner.', 'at': '2026-10-22T14:03:00Z'},
          {'from': 'codex', 'to': 'che', 'text': 'Latency fix is merged.', 'at': '2026-10-22T13:40:00Z'},
        ],
      });
    case '/api/letters':
      return _json({'letters': <Object>[]});
    case '/api/keys':
      return _json({'providers': <Object>[]});
    case '/api/flagstaff/archive':
      return _json({'sessions': <Object>[]});
    case '/api/youtube/status':
      return _json({'connected': false});
  }
  return http.Response('{}', 404);
});

Future<void> _pump(WidgetTester tester, Widget room) async {
  await tester.binding.setSurfaceSize(const Size(440, 956));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final theme = cheThemeFor(kCheHudPalette);
  await tester.pumpWidget(MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
    home: CheHudBackdrop(child: room),
  ));
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    // The HUD labels use Menlo, which iOS ships and the test machine does not; Roboto stands in for the picture.
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
  });
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    CheActivePalette.current = kCheHudPalette;
  });

  for (final (name, tab) in [('library', 0), ('activity', 2)]) {
    testWidgets('Command Center in HUD glass, $name', (tester) async {
      await _pump(
        tester,
        CheCommandCenterScreen(
          client: CheCommandClient(baseUrl: 'https://che.test', headers: () => const {}, client: _commands),
          store: CheCommandStore(),
          initialTab: tab,
          onSpeak: (_) {},
          onRunInChat: (message, {bool confirmed = false}) async {},
        ),
      );
      expect(find.text('Commands'), findsOneWidget);
      expect(find.byType(CheGlass), findsWidgets);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/hud_commands_$name.png'));
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('Flagstaff in HUD glass', (tester) async {
    await http.runWithClient(() async {
      await _pump(tester, CheMailboxScreen(baseUrl: 'https://che.test', headers: () => const {}, onSpeak: (_) {}));
    }, () => _flagstaff);
    expect(find.text('Claude'), findsOneWidget);
    expect(find.byType(CheGlass), findsWidgets);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/hud_commands_flagstaff.png'));
    await tester.pumpWidget(const SizedBox());
  });
}
