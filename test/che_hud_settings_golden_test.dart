// Golden pictures of the Settings lane's rooms (More tab and Connections) in the HUD glass look the owner approved
// (2026-10-22: the HUD style "for all her rooms"). The data is fixed sample data from fake clients; nothing calls a
// Worker. Regenerate with: flutter test --no-pub --update-goldens test/che_hud_settings_golden_test.dart
import 'dart:convert';
import 'dart:io';

import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_agents.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/che_ui/che_phone_shell.dart';
import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/home/che_connections_screen.dart';
import 'package:chey/home/che_more_tab.dart';
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

ThemeData _theme() {
  final theme = cheThemeFor(kCheHudPalette);
  return theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto'));
}

void main() {
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    // HUD labels use Menlo, which iOS ships and the test machine does not; Roboto stands in for the picture.
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
    CheActivePalette.current = kCheHudPalette;
  });

  testWidgets('More tab in the HUD look', (tester) async {
    await tester.binding.setSurfaceSize(const Size(440, 956));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    expect(cheHudActive, isTrue);
    await tester.pumpWidget(MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: _theme(),
      home: CheHudBackdrop(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          bottomNavigationBar: ChePhoneBottomNav(index: ChePhoneTab.more.index, onChanged: (_) {}),
          body: SafeArea(
            child: CheMoreTab(
              che: CheAgent.che(),
              onTalkToChe: () {},
              items: [
                CheMoreItem(icon: Icons.apps_rounded, title: 'Capability Showroom',
                    subtitle: 'What CHE can make, and what still needs setup', onTap: () {}, hue: CheColors.apps),
                CheMoreItem(icon: Icons.candlestick_chart_rounded, title: 'Trading Room',
                    subtitle: 'Swings · entries · backtests · paper trades', onTap: () {}, hue: CheColors.markets),
                CheMoreItem(icon: Icons.forum_rounded, title: 'Conversations',
                    subtitle: 'Agents, War Room and AIs · group chats', onTap: () {}),
                CheMoreItem(icon: Icons.vpn_key_rounded, title: 'Keys',
                    subtitle: 'Create or paste an AI key · works right away', onTap: () {}),
                CheMoreItem(icon: Icons.tune_rounded, title: 'UI Controls',
                    subtitle: 'Theme, avatar, text size, voice replies', onTap: () {}),
                CheMoreItem(icon: Icons.hub_outlined, title: 'Connections',
                    subtitle: 'YouTube · Google · broker · banks · business · voice', onTap: () {}),
              ],
            ),
          ),
        ),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 400));
    // Every row stays one labelled button, as before the HUD look.
    expect(find.bySemanticsLabel(RegExp(r'^Connections\. YouTube')), findsOneWidget);
    expect(find.descendant(of: find.byType(CheMoreTab), matching: find.byType(CheGlass)), findsNWidgets(7));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/hud_settings_more.png'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Connections in the HUD look', (tester) async {
    await tester.binding.setSurfaceSize(const Size(440, 956));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final client = MockClient((r) async => http.Response(
        jsonEncode({
          'connectors': {
            'youtube': {'state': 'ready', 'detail': 'Existing YouTube channel'},
            'gmail': {'state': 'ready'},
            'drive': {'state': 'not_connected'},
            'calendar': {'state': 'needs_reconnect'},
            'broker': {'state': 'not_connected', 'detail': 'Sign in to Tradovate'},
          },
        }),
        200,
        headers: {'content-type': 'application/json'}));
    await tester.pumpWidget(MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: _theme(),
      home: CheHudBackdrop(
        child: CheConnectionsScreen(
          baseUrl: 'https://che.test',
          headers: () => const {},
          client: client,
          onVoiceSettings: () {},
          onKeys: () {},
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Connected'), findsNWidgets(2));
    expect(find.text('GOOGLE & CREATORS'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/hud_settings_connections.png'));
    await tester.pumpWidget(const SizedBox());
  });
}
