// CHE 2.0 Home, rendered (owner, 2026-10-22: "show visual evidence"). The images in test/goldens are the evidence:
// the metallic teal palette, CHE's lit stage in three real states, the Talk control and the five destinations, at the
// owner's iPhone size (440 x 956 points). Real text and icons are drawn with the Roboto and Material Icons fonts that
// ship with the Flutter SDK, so the picture reads as the phone shows it.
import 'dart:io';

import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_agents.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/home/che_mockup_home.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

void main() {
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
    CheActivePalette.current = kCheSilverBlackPalette;
  });

  for (final (name, listening, working, agents) in [
    ('idle', false, 0, const <CheAgent>[]),
    ('listening', true, 0, const <CheAgent>[]),
    ('working', false, 2, const [
      CheAgent(id: 'nova', name: 'Nova', role: 'Research', status: CheAgentStatus.researching, task: 'MNQ session notes'),
      CheAgent(id: 'atlas', name: 'Atlas', role: 'Build', status: CheAgentStatus.building, task: 'Home screen tests'),
    ]),
  ]) {
    testWidgets('CHE 2.0 Home, $name', (tester) async {
      await tester.binding.setSurfaceSize(const Size(440, 956));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final theme = cheThemeFor(kCheSilverBlackPalette);
      await tester.pumpWidget(MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
        home: Scaffold(
          body: SafeArea(
            child: CheMockupHome(
              che: CheAgent.che(),
              agents: agents,
              working: working,
              liveMeetings: 0,
              connected: true,
              greeting: 'Good evening, sir. What should we build tonight?',
              listening: listening,
              onTalk: () {},
              onOpenChat: () {},
              onOpenOffice: () {},
              onOpenBrain: () {},
              onOpenTrading: () {},
              onOpenCreate: () {},
              onOpenWorld: () {},
              onOfficeStatus: () {},
              onToggleVoiceReplies: () {},
            ),
          ),
        ),
      ));
      await tester.pump(const Duration(milliseconds: 400));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home2_$name.png'));
      await tester.pumpWidget(const SizedBox());
    });
  }
}
