// CHE Chat in the HUD glass look (owner, 2026-10-22: "build the HUD look"). The image in test/goldens is the evidence:
// the glass header, the owner's words on chrome, CHE's reply on the backdrop, the glass composer and the glass tab bar,
// at the owner's iPhone size (440 x 956 points).
import 'dart:io';

import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/che_ui/che_phone_shell.dart';
import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/home/che_home_chat.dart';
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
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
    CheActivePalette.current = kCheHudPalette;
  });

  testWidgets('CHE Chat in the HUD glass look', (tester) async {
    await tester.binding.setSurfaceSize(const Size(440, 956));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final theme = cheThemeFor(kCheHudPalette);
    final controller = TextEditingController();
    final focus = FocusNode();
    addTearDown(controller.dispose);
    addTearDown(focus.dispose);
    await tester.pumpWidget(MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
      home: CheHudBackdrop(
        floor: 0.45,
        child: Scaffold(
          backgroundColor: Colors.transparent,
          appBar: AppBar(
            backgroundColor: Colors.transparent,
            flexibleSpace: const CheGlass(radius: 0, shadow: false, child: SizedBox.expand()),
            centerTitle: true,
            title: CheChromeText('Chat', style: CheType.title.copyWith(fontSize: 22, fontWeight: FontWeight.w800)),
            actions: [
              IconButton(onPressed: () {}, icon: const Icon(Icons.bolt_rounded), tooltip: 'Commands'),
              IconButton(onPressed: () {}, icon: const Icon(Icons.notifications_none_rounded), tooltip: 'Flagstaff'),
              IconButton(onPressed: () {}, icon: const Icon(Icons.more_vert_rounded), tooltip: 'Chat options'),
            ],
          ),
          bottomNavigationBar: ChePhoneBottomNav(index: 1, onChanged: (_) {}),
          body: Column(children: [
            Expanded(
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 24), children: const [
                CheHomeUserBubble(text: 'How did the night session go?', animate: false),
                SizedBox(height: 16),
                CheHomeAssistantMessage(
                  text: 'Quiet, but useful. The paper desk took two trades overnight: one stop and one target. '
                      'Nothing real was placed. Want the detail?',
                  streaming: false,
                  liveStart: null,
                  liveSteps: [],
                  finishedSteps: [],
                  thoughtMs: null,
                  agents: [],
                  extras: [],
                ),
                SizedBox(height: 16),
                CheHomeUserBubble(text: 'Yes, and read it to me.', animate: false),
              ]),
            ),
            CheHomeComposer(
              controller: controller,
              focusNode: focus,
              busy: false,
              modes: const ['Agent', 'Chat'],
              modeIndex: 1,
              onModeChanged: (_) {},
              onSend: () {},
              onStop: () {},
              onAttach: () {},
              onMic: () {},
              micActive: false,
              hint: 'Ask CHE anything…',
            ),
          ]),
        ),
      ),
    ));
    await tester.runAsync(() => precacheImage(
          const AssetImage('assets/avatars/che_emblem.png'),
          tester.element(find.byType(CheHomeComposer)),
        ));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('How did the night session go?'), findsOneWidget);
    expect(find.text('Chat'), findsWidgets);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chat_hud.png'));
    await tester.pumpWidget(const SizedBox());
  });
}
