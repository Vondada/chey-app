import 'dart:convert';

import 'package:chey/knowledge/che_knowledge_library_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Client fakeLibrary(List<Uri> seen) {
  return MockClient((request) async {
    seen.add(request.url);
    if (request.url.path == '/api/knowledge') {
      return http.Response(jsonEncode({
        'categories': [
          {'id': 'software_engineering', 'name': 'Software Engineering', 'indexed': 1, 'cataloged': 2},
          {'id': 'cybersecurity', 'name': 'Cybersecurity', 'indexed': 0, 'cataloged': 1},
        ],
        'references': [],
      }), 200);
    }
    return http.Response(jsonEncode({
      'status': 'answered',
      'text': '[Team notes, part 1; software_engineering; trust: owner_text]\nRetries should use jitter.',
      'citations': ['[Team notes, part 1; software_engineering; trust: owner_text]'],
    }), 200);
  });
}

void main() {
  testWidgets('shows the status per category with labels, and nothing is spoken on open', (tester) async {
    final seen = <Uri>[];
    var spoken = 0;
    await tester.pumpWidget(MaterialApp(
      home: CheKnowledgeLibraryScreen(
        baseUrl: () => 'https://che.example',
        headers: () => const {},
        client: fakeLibrary(seen),
        onSpeak: (_) => spoken += 1,
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Knowledge Library'), findsOneWidget);
    expect(find.text('Software Engineering'), findsOneWidget);
    expect(find.text('1 / 2'), findsOneWidget);
    expect(find.text('1 indexed reference with text I can quote, 3 catalogued only.'), findsOneWidget);
    expect(spoken, 0);
    expect(seen.map((u) => u.path), ['/api/knowledge']);
  });

  testWidgets('a search shows the cited answer as text, and Read aloud speaks that text', (tester) async {
    final seen = <Uri>[];
    String? spokenText;
    await tester.pumpWidget(MaterialApp(
      home: CheKnowledgeLibraryScreen(
        baseUrl: () => 'https://che.example',
        headers: () => const {},
        client: fakeLibrary(seen),
        onSpeak: (text) => spokenText = text,
      ),
    ));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'retry jitter');
    await tester.tap(find.widgetWithText(FilledButton, 'Search'));
    await tester.pumpAndSettle();
    expect(seen.last.queryParameters['q'], 'retry jitter');
    expect(find.textContaining('Retries should use jitter.'), findsOneWidget);
    expect(find.textContaining('[Team notes, part 1'), findsWidgets);
    await tester.tap(find.bySemanticsLabel('Read the answer aloud'));
    expect(spokenText, contains('Retries should use jitter.'));
  });

  testWidgets('a failed load says so in text and does not pretend to have the library', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: CheKnowledgeLibraryScreen(
        baseUrl: () => 'https://che.example',
        headers: () => const {},
        client: MockClient((_) async => http.Response('no', 503)),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.textContaining('I could not load the knowledge library.'), findsOneWidget);
  });
}
