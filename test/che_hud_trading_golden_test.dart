// The Markets tab's Trading Room in the HUD glass look (owner, 2026-10-22: "this style for all her rooms"), rendered at
// the owner's iPhone size (440 x 956 points) with sample Worker answers. The image in test/goldens is the evidence: the
// navy backdrop shows through, the chart panel is glossy glass, section labels are mono HUD labels and the selected
// section is lit ice. Real text and icons use the Roboto and Material Icons fonts that ship with the Flutter SDK.
import 'dart:convert';
import 'dart:io';

import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/rooms/che_markets_room.dart';
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

// Sample Worker answers: a paper chart of AAPL 5-minute bars, the delayed index snapshot and its daily candles.
final _worker = MockClient((r) async {
  final p = r.url.path;
  if (p == '/api/trading/chart') {
    final start = DateTime.utc(2026, 10, 22, 14, 0);
    final bars = [
      for (var i = 0; i < 40; i++)
        {
          't': start.add(Duration(minutes: 5 * i)).toIso8601String(),
          'o': 230 + i * 0.4 + (i % 4 == 0 ? 0.6 : 0),
          'h': 231.4 + i * 0.4,
          'l': 229.3 + i * 0.4,
          'c': 230.5 + i * 0.4 + (i % 3 == 0 ? -0.9 : 0.3),
        },
    ];
    return http.Response(
        jsonEncode({
          'ok': true,
          'account': 'alpaca_paper',
          'state': 'verified',
          'symbol': 'AAPL',
          'timeframe': '5m',
          'timeframes': ['1m', '5m', '15m', '1h', '1d'],
          'bars': bars,
          'feed': {'provider': 'Alpaca IEX', 'status': 'REALTIME', 'last_bar_time': start.add(const Duration(minutes: 195)).toIso8601String(), 'age_s': 60, 'stale': false},
          'entries_allowed': true,
          'market_orders_allowed': true,
          'entries_blocked_reason': '',
          'markers': const [],
          'open_orders': const [],
          'drawings': const [],
        }),
        200);
  }
  if (p == '/api/markets/snapshot') {
    return http.Response(
        jsonEncode({
          'source': 'Public sources (delayed)',
          'quotes': [
            {'symbol': '^spx', 'name': 'S&P 500', 'price': 6123.4, 'change_pct': 0.52, 'status': 'delayed'},
            {'symbol': '^ndq', 'name': 'Nasdaq 100', 'price': 21402.0, 'change_pct': -0.31, 'status': 'delayed'},
          ],
        }),
        200);
  }
  return http.Response(jsonEncode({'ok': true}), 200);
});

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

  testWidgets('Trading Room in the HUD glass look', (tester) async {
    await tester.binding.setSurfaceSize(const Size(440, 956));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    expect(cheHudActive, isTrue);
    final theme = cheThemeFor(kCheHudPalette);
    await tester.pumpWidget(MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
      home: CheHudBackdrop(
        floor: 0.6,
        child: Scaffold(
          backgroundColor: Colors.transparent,
          body: SafeArea(
            child: CheMarketsRoom(
              baseUrl: () => 'https://che.test',
              headers: () => const {},
              client: _worker,
              onAsk: (_) {},
              onRead: (_) {},
              actions: const [],
            ),
          ),
        ),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 200));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump(const Duration(milliseconds: 200));
    // The room's controls keep their VoiceOver names in the HUD look.
    expect(find.bySemanticsLabel('CHART section, open'), findsOneWidget);
    expect(find.bySemanticsLabel('STRATEGY LAB section'), findsOneWidget);
    expect(find.bySemanticsLabel('REPLAY'), findsOneWidget);
    expect(find.text('Trading Room'), findsNothing);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/hud_trading_room.png'));
    await tester.pumpWidget(const SizedBox());
  });
}
