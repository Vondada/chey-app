// Concept-to-Plan (owner, 2026-10-20): the Plan Room draws a real plan scene
// (fixture made by world_scene.js planScene from project_plan.js), sorts it
// every way the owner named, prices each tier, and answers by voice.
import 'dart:convert';
import 'dart:io';

import 'package:chey/world/che_plan_room.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _scene() => (jsonDecode(File('test/fixtures/plan_scene.json').readAsStringSync()) as Map).cast<String, dynamic>();

void main() {
  test('the plan model reads every item, tier, stage and label from the scene', () {
    final plan = ChePlan.fromJson(_scene())!;
    expect(plan.items.length, 15);
    expect(plan.items.firstWhere((i) => i.id == 'hud').required, isTrue, reason: 'the owner asked for a HUD');
    expect(plan.speculative.any((s) => s.label.contains('Flight')), isTrue);
    expect(plan.speculative.first.provenanceSpoken, 'fiction, not real technology');
    expect(plan.sources.single.url, 'https://en.wikipedia.org/wiki/Powered_exoskeleton');
    expect(plan.tiers['cheapest']!.oneTime.$2, lessThan(plan.tiers['premium']!.oneTime.$1));
    expect(plan.stages.first.$1, 1);
    expect(ChePlan.fromJson(const {'scene': 'meeting', 'id': 'm'}), isNull);
  });

  test('sorting matches the Worker: size, cost, required, dependency', () {
    final plan = ChePlan.fromJson(_scene())!;
    final bySize = chePlanSort(plan.items, 'size');
    for (var i = 1; i < bySize.length; i++) {
      expect(bySize[i - 1].size, lessThanOrEqualTo(bySize[i].size));
    }
    final byCost = chePlanSort(plan.items, 'cost', tier: 'premium');
    double mid(ChePlanItem i) => (i.cost['premium']!.$1 + i.cost['premium']!.$2) / 2;
    for (var i = 1; i < byCost.length; i++) {
      expect(mid(byCost[i - 1]), lessThanOrEqualTo(mid(byCost[i])));
    }
    final byStage = chePlanSort(plan.items, 'dependency');
    expect(byStage.first.stage, 1);
    expect(cheMoney((1200, 2550)), r'$1,200 to $2,550');
  });

  test('voice in the Plan Room answers from the plan and says which view to show', () {
    final plan = ChePlan.fromJson(_scene())!;
    final size = chePlanAnswer(plan, 'CHE, sort the parts from smallest to biggest.')!;
    expect(size.$1, startsWith('smallest to largest: 1. '));
    expect(size.$2, 'size');
    final premium = chePlanAnswer(plan, 'show the luxury version')!;
    expect(premium.$3, 'premium');
    expect(premium.$1, contains('not a quote'));
    expect(chePlanAnswer(plan, 'what comes first')!.$1, contains('Stage 1'));
    expect(chePlanAnswer(plan, "what's possible today")!.$1, contains('Flight like Iron Man'));
    expect(chePlanAnswer(plan, "what's the total")!.$1, contains('Cheapest about'));
    for (final m in ['What is the weather?', 'read my email', 'plan my week']) {
      expect(chePlanAnswer(plan, m), isNull, reason: m);
    }
  });

  testWidgets('the room shows tiers, the map, the sorted list and the notes; items read aloud; opening is silent', (tester) async {
    tester.view.physicalSize = const Size(900, 6000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: ChePlanRoom(planId: 'plan-fixture', load: (_) async => _scene(), onSpeak: (t) async => spoken.add(t)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(spoken, isEmpty, reason: 'opening the room is silent');
    expect(find.textContaining('Balanced version: about'), findsOneWidget);
    expect(find.text('Not real today'), findsOneWidget);
    expect(find.textContaining('Wikipedia: Powered exoskeleton'), findsOneWidget);
    expect(ChePlanRoom.current.value?.plan?.id, 'plan-fixture');

    await tester.tap(find.text('Premium'));
    await tester.pump();
    expect(find.textContaining('Premium version: about'), findsOneWidget);

    final answer = ChePlanRoom.current.value!.answer('sort by cheapest to most expensive');
    await tester.pump();
    expect(answer, contains('premium prices'));
    expect(find.text('Items, cheapest to most expensive'), findsOneWidget);

    await tester.tap(find.text('Helmet display (HUD)').last);
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.textContaining('you asked for it'), findsOneWidget);
    await tester.tap(find.text('Read aloud'));
    await tester.pump();
    expect(spoken.single, startsWith('Helmet display (HUD):'));
    expect(spoken.single, endsWith("That is CHE's estimate, not a quote."));

    await tester.pumpWidget(const SizedBox.shrink());
    expect(ChePlanRoom.current.value, isNull);
  });
}
