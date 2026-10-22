import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/che_ui/che_showroom.dart';

// A showroom record as GET /api/showroom returns it (shape from capability_showroom.js showroomView).
Map<String, dynamic> showroom() => {
      'categories': [
        {
          'id': 'inventions',
          'number': 1,
          'title': 'Inventions & Engineering',
          'summary': 'Concept designs, parts and feasibility notes.',
          'capabilities': [
            {
              'id': 'invention_studio',
              'title': 'Invention Studio',
              'description': 'Concept to parts list, cost bands and feasibility notes.',
              'example': 'design me a desk lamp',
              'output': 'A project record with parts and labels',
              'state': 'ready',
              'status_label': 'Ready',
              'reason': '',
              'start': 'design me a desk lamp',
              'thumbnail': 'real',
              'thumbnail_note': 'Real saved output.',
              'recent_project': {'kind': 'invention', 'id': 'inv-1', 'title': 'Desk lamp'},
              'missing': [],
            },
            {
              'id': 'exo',
              'title': 'Exoskeleton concept',
              'description': 'A concept only: no powered build is claimed.',
              'example': 'concept an exoskeleton',
              'output': 'Concept notes',
              'state': 'partial',
              'status_label': 'Partial',
              'reason': 'Concept only, no verified parts.',
              'start': 'concept an exoskeleton',
              'thumbnail': 'illustration',
              'thumbnail_note': 'Concept example: an illustration, not an output CHE made.',
              'recent_project': null,
              'missing': ['verified parts list'],
            },
          ],
        },
        {
          'id': 'video',
          'number': 2,
          'title': 'Video, Film & Animation',
          'summary': 'Videos and pictures CHE renders.',
          'capabilities': [
            {
              'id': 'video',
              'title': 'Video renderer',
              'description': 'Short videos from a script.',
              'example': 'make a short video',
              'output': 'MP4',
              'state': 'needs_setup',
              'status_label': 'Needs setup',
              'reason': 'No renderer is connected.',
              'start': 'make a short video',
              'thumbnail': 'illustration',
              'thumbnail_note': 'Concept example: an illustration, not an output CHE made.',
              'recent_project': null,
              'missing': ['renderer'],
            },
          ],
        },
      ],
    };

CheShowroomCategory category(int index) =>
    CheShowroomCategory(Map<String, dynamic>.from((showroom()['categories'] as List)[index] as Map));

Future<void> pumpShowroom(
  WidgetTester tester, {
  required void Function(String) onStart,
  void Function(Map<String, dynamic>)? onOpenRecent,
}) async {
  await tester.pumpWidget(MaterialApp(
    home: CheShowroomPage(
      load: () async => showroom(),
      onStart: onStart,
      onOpenRecent: onOpenRecent,
    ),
  ));
  await tester.pumpAndSettle();
}

void main() {
  test('a category reads its number, title and counts by status in words', () {
    final inventions = category(0);
    expect(inventions.number, 1);
    expect(inventions.title, 'Inventions & Engineering');
    expect(inventions.countLine(), '1 ready, 1 partial');
    expect(category(1).countLine(), '1 needs setup');
  });

  test('a picture is real only when the record says so; otherwise it is named a concept example', () {
    final items = category(0).items;
    expect(items[0].isReal, isTrue);
    expect(items[1].isReal, isFalse);
    expect(items[1].thumbnailNote, startsWith('Concept example'));
    expect(items[1].recent, isNull);
    expect(items[0].recent!['id'], 'inv-1');
  });

  test('missing fields read as empty, never as invented values', () {
    final item = CheShowroomItem({});
    expect(item.title, 'Capability');
    expect(item.statusLabel, 'Planned');
    expect(item.start, isEmpty);
    expect(item.isReal, isFalse);
    expect(item.missing, isEmpty);
    expect(item.thumbnailNote, 'Concept example: an illustration.');
  });

  test('search and status filter pick cards; the default filter is All', () {
    final items = category(0).items;
    expect(items.where((i) => cheShowroomMatches(i)).length, 2);
    expect(items.where((i) => cheShowroomMatches(i, filter: 'Ready')).map((i) => i.id), ['invention_studio']);
    expect(items.where((i) => cheShowroomMatches(i, filter: 'Needs setup')), isEmpty);
    expect(items.where((i) => cheShowroomMatches(i, query: 'exoskeleton')).map((i) => i.id), ['exo']);
    expect(items.where((i) => cheShowroomMatches(i, query: 'nothing like this')), isEmpty);
    expect(cheShowroomFilters.first, 'All');
  });

  testWidgets('the category list numbers each category and starts nothing on load', (tester) async {
    await pumpShowroom(tester, onStart: (_) => fail('loading the showroom must not start a request'));
    expect(find.text('1. Inventions & Engineering'), findsOneWidget);
    expect(find.text('2. Video, Film & Animation'), findsOneWidget);
    expect(find.text('Search what CHE can do'), findsOneWidget);
  });

  testWidgets('a capability card states its status and labels its picture in words', (tester) async {
    await pumpShowroom(tester, onStart: (_) {});
    await tester.tap(find.text('1. Inventions & Engineering'));
    await tester.pumpAndSettle();

    // Each status word appears twice: once on the filter chip and once on the card.
    expect(find.text('Ready'), findsNWidgets(2));
    expect(find.text('Partial'), findsNWidgets(2));
    expect(find.text('Real saved output'), findsOneWidget);
    expect(find.text('Concept example: an illustration, not an output CHE made.'), findsOneWidget);
    expect(find.text('Needs: verified parts list'), findsOneWidget);
  });

  testWidgets('Create your own sends the card starting request to chat; Open example opens only a real saved output', (tester) async {
    String? started;
    Map<String, dynamic>? opened;
    await pumpShowroom(
      tester,
      onStart: (prompt) => started = prompt,
      onOpenRecent: (recent) => opened = recent,
    );
    await tester.tap(find.text('1. Inventions & Engineering'));
    await tester.pumpAndSettle();

    // The first card has a real saved output, so it offers both actions.
    expect(find.text('Open example'), findsNWidgets(1));
    await tester.tap(find.text('Open example'));
    await tester.pumpAndSettle();
    expect(opened!['id'], 'inv-1');

    await tester.tap(find.text('Create your own').first);
    await tester.pumpAndSettle();
    expect(started, 'design me a desk lamp');

    // The partial concept card has no saved output, so the only action is to start it.
    expect(find.text('Create your own'), findsNWidgets(2));
    expect(find.text('Open example'), findsOneWidget);
  });

  testWidgets('a status filter narrows the cards in the open category', (tester) async {
    await pumpShowroom(tester, onStart: (_) {});
    await tester.tap(find.text('1. Inventions & Engineering'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(ChoiceChip, 'Partial'));
    await tester.pumpAndSettle();
    expect(find.text('Invention Studio'), findsNothing);
    expect(find.text('Exoskeleton concept'), findsOneWidget);
  });

  testWidgets('search on the category list reaches every category, and a miss says so in words', (tester) async {
    await pumpShowroom(tester, onStart: (_) {});

    await tester.enterText(find.byType(TextField), 'short video');
    await tester.pumpAndSettle();
    expect(find.text('1. Inventions & Engineering'), findsNothing);
    expect(find.text('Video renderer'), findsOneWidget);
    expect(find.text('Invention Studio'), findsNothing);

    await tester.enterText(find.byType(TextField), 'zzz');
    await tester.pumpAndSettle();
    expect(find.text('No capability matches that search.'), findsOneWidget);
  });
}
