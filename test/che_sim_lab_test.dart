// Simulation Lab (owner, 2026-10-20): the lab draws a real run (fixture made by
// world_scene.js simScene from sim_lab.js), says what actually ran, keeps
// predictions and simulated results apart, and answers by voice.
import 'dart:convert';
import 'dart:io';

import 'package:chey/world/che_sim_lab.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _scene() => (jsonDecode(File('test/fixtures/sim_scene.json').readAsStringSync()) as Map).cast<String, dynamic>();

void main() {
  test('the lab model reads the models, counts, candidates and notes from the scene', () {
    final lab = CheSimLab.fromJson(_scene())!;
    expect(lab.models.map((m) => m.id), ['hover_flight', 'config_search']);
    final raw = _scene()['totals'] as Map;
    expect(lab.evaluations, raw['screening_evaluations']);
    expect(lab.samples, raw['monte_carlo_samples']);
    expect(lab.best!.model, 'hover_flight');
    expect(lab.best!.rank, 1);
    expect(lab.best!.p10, lessThanOrEqualTo(lab.best!.p50));
    expect(lab.best!.p50, lessThanOrEqualTo(lab.best!.p90));
    expect(lab.best!.provenanceSpoken, 'a simulated result, not a measurement');
    expect(lab.of('elimination').first.provenanceSpoken, 'a mathematical prediction, not a simulation');
    expect(lab.readinessStage, 'simulated');
    expect(lab.ladder.last, 'proven in the real world');
    expect(lab.design(lab.best!), contains('total fan disk area'));
    expect(lab.design(lab.candidatesOf('config_search').first), matches(RegExp(r'^\d+ cheapest, \d+ balanced, \d+ premium$')));
    expect(CheSimLab.fromJson(const {'scene': 'plan', 'id': 'p'}), isNull);
  });

  test('voice in the lab answers from the run, with provenance, and leaves other questions alone', () {
    final lab = CheSimLab.fromJson(_scene())!;
    expect(cheSimLabAnswer(lab, "CHE, what's the best design?"), allOf(contains('design 1'), contains('a simulated result, not a measurement')));
    expect(cheSimLabAnswer(lab, 'read design two'), contains('design 2'));
    expect(cheSimLabAnswer(lab, 'read design 9'), 'There are 5 leading designs, sir.');
    expect(cheSimLabAnswer(lab, 'Why were designs eliminated?'), allOf(contains('too large to wear'), contains('1.')));
    expect(cheSimLabAnswer(lab, 'how many simulations did you run'), allOf(contains('mathematical predictions, not simulations'), contains('Monte Carlo'), contains('Nothing has been built or measured')));
    expect(cheSimLabAnswer(lab, 'read the assumptions'), contains('Pilot 80 kg'));
    expect(cheSimLabAnswer(lab, "what's still unresolved"), contains('benchmarked against measured data'));
    expect(cheSimLabAnswer(lab, "what's next"), allOf(contains('unmanned'), contains('simulated')));
    for (final m in ['What is the weather?', 'read my email', 'sort by cheapest']) {
      expect(cheSimLabAnswer(lab, m), isNull, reason: m);
    }
  });

  testWidgets('the lab shows what ran, the leading designs, eliminations and notes; opening is silent; inspect reads aloud', (tester) async {
    tester.view.physicalSize = const Size(900, 8000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: CheSimLabPage(simId: 'sim-fixture', load: (_) async => _scene(), onSpeak: (t) async => spoken.add(t)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(spoken, isEmpty, reason: 'opening the lab is silent');
    expect(CheSimLabPage.current.value?.lab?.id, 'sim-fixture');
    for (final heading in ['Progress toward a real build', 'What actually ran', 'Electric hover flight for one person: leading designs', 'Option choices: leading designs', 'Findings', 'Prototype roadmap', 'Safety', 'Unresolved problems', 'Assumptions', 'Methods']) {
      expect(find.text(heading), findsOneWidget, reason: heading);
    }
    expect(find.textContaining('mathematical predictions, not simulations'), findsWidgets);
    expect(find.textContaining('Eliminated, and why'), findsWidgets);
    expect(find.bySemanticsLabel(RegExp(r'^Design 1\. Hover time about')), findsOneWidget);

    await tester.tap(find.bySemanticsLabel(RegExp(r'^Design 1\. Hover time about')));
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('Parts and costs'), findsOneWidget);
    await tester.tap(find.text('Read aloud'));
    await tester.pump();
    expect(spoken.single, allOf(startsWith('Electric hover flight for one person, design 1'), endsWith('That is a simulated result, not a measurement.')));

    await tester.pumpWidget(const SizedBox.shrink());
    expect(CheSimLabPage.current.value, isNull);
  });
}
