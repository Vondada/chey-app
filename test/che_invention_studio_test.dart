import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/rooms/che_invention_studio.dart';

// A project record as the Worker returns it (shape from invention_studio.js planInvention).
Map<String, dynamic> project() => {
      'id': 'inv-test',
      'title': 'Powered suit concept: Iron Man-style suit',
      'concept': {'status': 'not_generated', 'media_id': null, 'reason': 'No image engine answered for this design.'},
      'cost': {
        'currency': 'USD',
        'tiers': {
          'budget': {'low': 1000, 'high': 2000, 'unknown_parts': 0},
          'mid': {'low': 4000, 'high': 9000, 'unknown_parts': 0},
          'premium': {'low': 12000, 'high': 30000, 'unknown_parts': 0},
        },
      },
      'subsystems': [
        {'id': 'power', 'name': 'Power', 'parts': ['Battery pack'], 'cost': {'budget': {'low': 150, 'high': 300}, 'mid': {'low': 400, 'high': 800}, 'premium': {'low': 1000, 'high': 2500}}},
      ],
      'parts': [
        {'name': 'Battery pack', 'subsystem': 'power', 'quantity': 1, 'label': 'estimated source', 'kind': 'off_the_shelf', 'sourcing': {'categories': ['battery pack integrators'], 'vendor': null, 'link': null}},
        {'name': 'Shell panels', 'subsystem': 'shell', 'quantity': 1, 'label': 'custom fabrication required', 'kind': 'custom_fabricated', 'sourcing': {'categories': ['local 3D-printing service'], 'vendor': null, 'link': null}},
        {'name': 'Flight thrusters', 'subsystem': 'movement', 'quantity': 1, 'label': 'conceptual', 'kind': 'conceptual', 'sourcing': {'categories': [], 'vendor': null, 'link': null}},
      ],
      'stages': [{'id': 'concept_render', 'name': 'Concept render'}, {'id': 'testing', 'name': 'Testing checklist'}],
      'tests': ['Confirm the emergency stop cuts power to all motors within one second'],
      'feasibility': {
        'realistic_today': ['A passive or lightly powered shell and frame for display and fitting'],
        'too_heavy': ['A full-body powered suit carrying its own battery is beyond practical limits'],
        'power_limited': ['Battery energy density limits run time to minutes at high load'],
        'unsafe': ['High-current lithium packs can fail with fire'],
        'advanced_fabrication': [],
        'prototype_first': ['Static shell in foam'],
        'concept_only': ['Flight is concept-only'],
      },
    };

void main() {
  test('a project record reads its tiers, parts and feasibility; missing fields are empty, never invented', () {
    final view = CheInventionView(project());
    expect(view.title, 'Powered suit concept: Iron Man-style suit');
    expect(view.tierBand('mid')!.high, 9000);
    expect(view.tierBand('nope'), isNull);
    expect(view.feasibility('unsafe'), ['High-current lithium packs can fail with fire']);
    expect(view.feasibility('missing'), isEmpty);
    expect(view.stages, ['Concept render', 'Testing checklist']);
    expect(CheInventionView({}).parts, isEmpty);
    expect(CheInventionView({}).tierBand('budget'), isNull);
  });

  test('an unknown sourcing label is shown as unavailable / unknown, never as verified', () {
    expect(cheInventionLabel({'label': 'verified source'}), 'verified source');
    expect(cheInventionLabel({'label': 'Amazon confirmed'}), 'unavailable / unknown');
    expect(cheInventionLabel({}), 'unavailable / unknown');
  });

  test('a band that is missing reads as not costed', () {
    expect(cheInventionBand(null), 'not costed');
    expect(cheInventionBand((low: 10, high: 20)), '10 to 20 USD');
  });

  testWidgets('the detail shows the labels, the tiers as planning bands, feasibility and the no-vendor note', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: CheInventionDetail(project: CheInventionView(project()))),
    ));
    expect(find.text('Mid-range: 4000 to 9000 USD'), findsOneWidget);
    expect(find.textContaining('Supplier lookup is not connected'), findsOneWidget);
    expect(find.textContaining('estimated source'), findsWidgets);
    expect(find.textContaining('custom fabrication required'), findsWidgets);
    expect(find.textContaining('Not costed: no source CHE can name or check.'), findsOneWidget);
    expect(find.textContaining('Realistic today: A passive'), findsOneWidget);
    expect(find.textContaining('Likely too heavy:'), findsOneWidget);
    expect(find.textContaining('Power-limited:'), findsOneWidget);
    expect(find.textContaining('Concept only: Flight'), findsOneWidget);
    expect(find.text('No concept picture yet.'), findsNothing, reason: 'the reason is shown instead');
    expect(find.textContaining('No image engine answered'), findsOneWidget);
  });
}
