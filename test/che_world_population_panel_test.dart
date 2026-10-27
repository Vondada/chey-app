import 'dart:convert';

import 'package:chey/world/che_world_population_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _FakeCrowd implements CheCrowdDriver {
  _FakeCrowd(this.onMessage);
  final void Function(Map<String, dynamic>) onMessage;
  List<Map<String, dynamic>> records = const [];
  final provided = <String, List<int>?>{};
  @override
  Widget build(BuildContext context) => const SizedBox.expand(key: ValueKey('fake-crowd'));
  @override
  Future<void> setPopulation(List<Map<String, dynamic>> r) async => records = r;
  @override
  Future<void> provideBucket(String key, List<int>? glb) async => provided[key] = glb;
  @override
  void dispose() {}
}

void main() {
  final calls = <String>[];
  late MockClient client;
  setUp(() {
    calls.clear();
    client = MockClient((r) async {
      calls.add('${r.method} ${r.url.path}?${r.url.query}');
      if (r.url.path == '/api/world/population') {
        final limit = int.parse(r.url.queryParameters['limit'] ?? '20');
        return http.Response(jsonEncode({
          'ok': true,
          // The Worker's real shape (world_population.js summarizeCounts).
          'counts': {'records': 100000, 'buckets_total': 288, 'models_generated': 2, 'models_building': 1, 'models_failed': 0, 'active': null},
          'records': [
            for (var i = 0; i < limit && i < 3; i++)
              {'seed': i + 1, 'bucket': 'hybrid.feminine_slim.long_wavy.jacket', 'variation': {'scale': 1.0, 'skin': '#c98b62', 'hair': '#2a1a12', 'outfit': '#1f6f78'}},
          ],
        }), 200);
      }
      if (r.url.path == '/api/world/buckets') {
        return http.Response(jsonEncode({
          'buckets': [
            {'key': 'hybrid.feminine_slim.long_wavy.jacket', 'state': 'completed', 'model': {'bytes': 4, 'url': '/api/gpu/jobs/gpu_aaaaaaaaaaaa/model.glb'}},
          ],
        }), 200);
      }
      if (r.url.path == '/api/gpu/jobs/gpu_aaaaaaaaaaaa/model.glb') return http.Response.bytes([0x67, 0x6c, 0x54, 0x46], 200);
      return http.Response('{}', 404);
    });
  });

  testWidgets('shows records, generated models and active characters as three distinct, labelled counts; silent on open', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532); // an iPhone-sized screen, so every control is built
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(MaterialApp(home: CheWorldPopulationPanel(baseUrl: 'https://che.test', headers: const {}, client: client, onRead: spoken.add)));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'passive screens stay silent');
    expect(find.byKey(const ValueKey('population-banner')), findsNothing, reason: 'opening shows no result banner');
    expect(find.text('100,000'), findsOneWidget);
    expect(find.text('2 of 288'), findsOneWidget);
    expect(find.text('unknown'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^1\. Character records: 100,000 character records\. Seeded descriptions, not built models\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^2\. Generated models: 2 of 288 shared base models generated, 1 building\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^3\. Active now: Active now: unknown\. The crowd viewer is closed')), findsOneWidget);
    expect(find.bySemanticsLabel('Read the CHE World population aloud'), findsOneWidget);
    expect(find.bySemanticsLabel('Refresh the CHE World counts', skipOffstage: false), findsOneWidget);
    expect(find.bySemanticsLabel('Open the crowd viewer to see and count active residents', skipOffstage: false), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('population-read')));
    expect(spoken.single, startsWith('CHE World population. 1. 100,000 character records.'));
    expect(spoken.single, contains('2. 2 of 288 shared base models generated'));
    semantics.dispose();
  });

  testWidgets('the crowd viewer gets one page of records, a generated bucket on request, and reports active residents', (tester) async {
    _FakeCrowd? crowd;
    await tester.pumpWidget(MaterialApp(
      home: CheWorldPopulationPanel(
        baseUrl: 'https://che.test',
        headers: const {},
        client: client,
        crowd: (onMessage) => crowd = _FakeCrowd(onMessage),
      ),
    ));
    await tester.pumpAndSettle();
    final state = tester.state<CheWorldPopulationPanelState>(find.byType(CheWorldPopulationPanel));
    final reply = await state.voice('Open the crowd viewer');
    await tester.pumpAndSettle();
    expect(reply, startsWith('Crowd viewer open with 3 residents.'));
    expect(crowd!.records, hasLength(3));
    expect(calls, contains('GET /api/world/population?world=che_world&limit=200'));
    crowd!.onMessage({'type': 'need_bucket', 'bucket': 'hybrid.feminine_slim.long_wavy.jacket'});
    crowd!.onMessage({'type': 'need_bucket', 'bucket': 'stylized.masculine_full.afro.hoodie'});
    await tester.pumpAndSettle();
    expect(crowd!.provided['hybrid.feminine_slim.long_wavy.jacket'], [0x67, 0x6c, 0x54, 0x46]);
    expect(crowd!.provided.containsKey('stylized.masculine_full.afro.hoodie'), isTrue);
    expect(crowd!.provided['stylized.masculine_full.afro.hoodie'], isNull, reason: 'no generated model: nothing is invented');
    crowd!.onMessage({'type': 'status', 'active_animated': 12, 'records_in_view': 40, 'models_loaded': 1, 'fps': 58.5});
    await tester.pump();
    expect(find.text('12'), findsOneWidget);
    expect(await state.voice('read'), contains('3. 12 active now: animated on screen this second, of 40 residents in view.'));
    expect(await state.voice('close the crowd'), 'Crowd viewer closed.');
    await tester.pump();
    expect(find.text('unknown'), findsOneWidget);
    expect(await state.voice('play some music'), isNull, reason: 'anything else goes to Chat');
  });
}
