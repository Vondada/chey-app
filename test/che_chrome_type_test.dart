// Chrome lettering (owner, 2026-10-23: the Home "Good morning" chrome throughout CHE). Checks contrast on CHE's dark
// backgrounds, VoiceOver and Dynamic Type, the theme-wide page titles, a golden of a title and a label, and measures
// the paint cost of the foreground-Paint chrome against a ShaderMask per label.
// Regenerate the golden with: flutter test --update-goldens test/che_chrome_type_test.dart
import 'dart:io';

import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_chrome_type.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

double _contrast(Color a, Color b) {
  final la = a.computeLuminance(), lb = b.computeLuminance();
  final hi = la > lb ? la : lb, lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  await (FontLoader(family)..addFont(Future.value(ByteData.view(file.readAsBytesSync().buffer)))).load();
}

void main() {
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    CheActivePalette.current = kCheHudPalette;
  });

  test('every chrome stop stays readable on the HUD backgrounds (WCAG AAA for small text)', () {
    for (final bg in [CheHud.space, CheHud.navyMid, CheHud.navyTop]) {
      expect(_contrast(CheChrome.darkest(CheChrome.strong), bg), greaterThanOrEqualTo(7), reason: 'title chrome on $bg');
      expect(_contrast(CheChrome.darkest(CheChrome.subtle), bg), greaterThanOrEqualTo(7), reason: 'subtle chrome on $bg');
      expect(_contrast(CheChrome.label().color!, bg), greaterThanOrEqualTo(7), reason: 'HUD label on $bg');
    }
  });

  test('the title chrome is the Home greeting chrome, stop for stop', () {
    expect(CheChrome.strong.colors, CheHud.chrome.colors);
    expect(CheChrome.strong.stops, CheHud.chrome.stops);
    expect(CheChrome.label(), CheHud.label);
  });

  testWidgets('chrome text stays ordinary text for VoiceOver and scales with Dynamic Type', (tester) async {
    final semantics = tester.ensureSemantics();
    for (final scale in [1.0, 1.3]) {
      await tester.pumpWidget(MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(scale)),
          child: const Scaffold(body: CheChromeLabel('Win rate 54%', style: TextStyle(fontSize: 14))),
        ),
      ));
      expect(find.bySemanticsLabel('Win rate 54%'), findsOneWidget);
      final size = tester.getSize(find.text('Win rate 54%'));
      expect(size.height, greaterThanOrEqualTo(14 * scale), reason: 'text scale $scale is honoured');
      final style = tester.widget<Text>(find.text('Win rate 54%')).style!;
      expect(style.foreground?.shader, isNotNull);
      expect(style.color, isNull, reason: 'a foreground Paint, so no colour fights the chrome');
    }
    semantics.dispose();
  });

  testWidgets('HUD page titles are chrome through the theme, even when a title sets its own colour', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: cheThemeFor(kCheHudPalette),
      home: Scaffold(appBar: AppBar(title: const Text('Workflows', style: TextStyle(color: Colors.red)))),
    ));
    final para = tester.renderObject<RenderParagraph>(find.text('Workflows'));
    expect(para.text.style?.foreground?.shader, isNotNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('golden: a chrome title and a HUD label, as on Home', (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 170));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Material(
        color: CheHud.navyTop,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('FRI · 23 OCT · 8:30 AM CDT', style: CheChrome.label(fontSize: 13)),
            const SizedBox(height: 8),
            const CheChromeText('Good morning.', style: TextStyle(fontFamily: 'Roboto', fontSize: 40, fontWeight: FontWeight.w700, letterSpacing: -0.8)),
            const SizedBox(height: 8),
            const CheChromeLabel('Expectancy +0.12R · 41 trades', style: TextStyle(fontFamily: 'Roboto', fontSize: 15, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text('LINK SECURE', style: CheChrome.label(fontSize: 13)),
          ]),
        ),
      ),
    ));
    await expectLater(find.byType(Material).first, matchesGoldenFile('goldens/chrome_type.png'));
  });

  testWidgets('measured: 200 chrome labels, foreground Paint vs a ShaderMask each', (tester) async {
    Future<int> frameMicros(Widget Function(int) label) async {
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: Wrap(children: [for (var i = 0; i < 200; i++) label(i)]))));
      final sw = Stopwatch()..start();
      for (var f = 0; f < 20; f++) {
        for (final e in find.byType(Text).evaluate()) {
          e.renderObject?.markNeedsPaint();
        }
        await tester.pump();
      }
      return sw.elapsedMicroseconds ~/ 20;
    }

    const base = TextStyle(fontSize: 12);
    final paint = await frameMicros((i) => CheChromeLabel('L$i', style: base));
    final mask = await frameMicros((i) => CheChromeText('L$i', style: base));
    // ignore: avoid_print
    print('chrome labels x200, per frame (test host, relative only): foreground Paint ${paint}us, ShaderMask ${mask}us');
    expect(paint, greaterThan(0));
  });
}
