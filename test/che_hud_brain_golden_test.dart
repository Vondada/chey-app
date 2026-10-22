// The Brain Room in the HUD glass look (owner, 2026-10-22: "this style for all her rooms"), rendered as evidence:
// navy space backdrop, the brain floating in it, the chrome room title with a mono ice count, ice-glass pills and a
// glossy glass memory card. Sample Brain records only (the shape the phone replica hands over); nothing is spoken.
// Real text and icons are drawn with the Roboto and Material Icons fonts that ship with the Flutter SDK.
import 'dart:io';

import 'package:chey/brain/che_brain_space.dart';
import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/home/che_memory_brain.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

List<Map<String, dynamic>> _records() => [
      {'id': 'che:core', 'kind': 'core', 'region': 'CHE Self-Knowledge', 'path': 'CHE', 'title': 'CHE', 'excerpt': 'CHE, the central brain of the Office.', 'verification': 'owner_attested', 'created_at': '2026-10-01T00:00:00.000Z', 'source': {'kind': 'che_core'}, 'links': const [], 'places': [{'region': 'CHE Self-Knowledge', 'path': 'CHE'}, {'region': 'Office Agents', 'path': 'CHE'}]},
      for (final (id, name, role) in [('a-atlas', 'Atlas', 'Research / scout'), ('a-nova', 'Nova', 'Product / listings')])
        {'id': 'agent:$id', 'kind': 'worker', 'region': 'Office Agents', 'path': name, 'title': name, 'excerpt': '$name, $role.', 'verification': 'owner_attested', 'created_at': '2026-10-01T00:00:00.000Z', 'source': {'kind': 'office_worker', 'role': role}, 'links': [{'type': 'related_to', 'to': 'che:core'}], 'places': [{'region': 'Office Agents', 'path': name}]},
      {'id': 'task:t1', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Historical', 'title': 'Write the Etsy listing for the brass lamp', 'excerpt': 'Task: Write the Etsy listing for the brass lamp.\nStatus: complete.', 'verification': 'verified_source', 'created_at': '2026-10-10T10:00:00.000Z', 'source': {'kind': 'team_task', 'agent': 'Nova', 'status': 'complete', 'outcome': 'done'}, 'links': [{'type': 'produced_by_agent', 'to': 'agent:a-nova'}], 'places': [{'region': 'Active and Historical Tasks', 'path': 'Historical'}, {'region': 'Office Agents', 'path': 'Nova'}]},
      {'id': 'mem:1', 'kind': 'memory', 'region': 'Personal Memory', 'path': 'Family', 'title': 'My sister Ana lives in Lisbon', 'excerpt': 'My sister Ana lives in Lisbon.', 'verification': 'owner_attested', 'created_at': '2026-10-17T02:00:00.000Z', 'source': {'kind': 'memory_record'}, 'links': const [], 'places': [{'region': 'Personal Memory', 'path': 'Family'}]},
      {'id': 'note:h', 'kind': 'note', 'region': 'Trading and Market Research', 'path': 'Ideas', 'title': 'Silver may rise next week', 'excerpt': 'The momentum signal suggests silver rises next week.', 'verification': 'hypothesis', 'created_at': '2026-09-20T04:00:00.000Z', 'source': {'kind': 'note'}, 'links': const [], 'places': [{'region': 'Trading and Market Research', 'path': 'Ideas'}]},
      for (var i = 0; i < 40; i++)
        {'id': 'know:$i', 'kind': 'knowledge', 'region': 'Learned Knowledge', 'path': 'Facts', 'title': 'Market fact $i', 'excerpt': 'Learned fact $i about futures charts.', 'verification': i % 3 == 0 ? 'verified_source' : 'unverified_reference', 'created_at': '2026-10-${(1 + i % 20).toString().padLeft(2, '0')}T00:00:00.000Z', 'source': {'kind': 'knowledge'}, 'links': const [], 'places': [{'region': 'Learned Knowledge', 'path': 'Facts'}]},
    ];

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

  for (final card in [false, true]) {
    testWidgets('Brain Room in HUD glass${card ? ', filters and a memory card open' : ''}', (tester) async {
      await tester.binding.setSurfaceSize(const Size(440, 956));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final spoken = <String>[];
      final theme = cheThemeFor(kCheHudPalette);
      final dots = cheBuildMemoryDots(
        savedMemories: const ['Owner prefers voice replies and large text'],
        memoryNotes: const [],
        learnedPersonality: const [{'statement': 'Prefers short spoken answers'}],
        learnedKnowledge: const [],
        brainRecords: _records(),
      );
      await tester.pumpWidget(MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
        home: MediaQuery(
          data: const MediaQueryData(size: Size(440, 956), padding: EdgeInsets.only(top: 62, bottom: 34), viewPadding: EdgeInsets.only(top: 62, bottom: 34)),
          child: CheHudBackdrop(
            child: Scaffold(
              backgroundColor: Colors.transparent,
              body: SafeArea(
                child: CheMemoryBrainRoom(
                  dots: dots,
                  roster: const [
                    {'name': 'Atlas', 'role': 'Research / scout', 'runtime_status': 'working'},
                    {'name': 'Nova', 'role': 'Product / listings', 'runtime_status': 'idle'},
                  ],
                  onRefresh: () async {},
                  onReadAloud: (t) async => spoken.add(t),
                ),
              ),
            ),
          ),
        ),
      ));
      for (var i = 0; i < 40; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      if (card) {
        await tester.tap(find.byTooltip('Filter the brain'));
        await tester.pump();
        final c = tester.widget<CheBrainSpace>(find.byType(CheBrainSpace)).controller;
        c.find('Ana');
        c.openSelected();
        for (var i = 0; i < 60; i++) {
          await tester.pump(const Duration(milliseconds: 20));
        }
      }
      expect(tester.takeException(), isNull);
      expect(spoken, isEmpty, reason: 'the room never speaks on its own');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/hud_brain_${card ? 'card' : 'room'}.png'));
      await tester.pumpWidget(const SizedBox());
    });
  }
}
