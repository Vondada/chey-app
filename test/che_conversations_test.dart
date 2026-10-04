import 'dart:convert';

import 'package:chey/conversations/che_conversations_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  final payload = {
    'threads': [
      {
        'id': 'meeting:m1', 'kind': 'war_room', 'title': 'Launch plan', 'participants': ['CHE', 'Nova'], 'status': 'done', 'updated_at': '2026-10-04T01:05:00Z',
        'messages': [
          {'from': 'CHE', 'kind': 'brief', 'text': 'Goal: launch', 'at': '2026-10-04T01:00:00Z'},
          {'from': 'Nova', 'to': 'Knox', 'kind': 'critique', 'text': 'Your draft misses pricing', 'at': '2026-10-04T01:05:00Z'},
        ],
      },
    ],
  };

  testWidgets('threads list like Messages; a thread shows who said what to whom; VoiceOver reads it', (tester) async {
    final handle = tester.ensureSemantics();
    var flagstaff = 0;
    final client = MockClient((r) async => http.Response(jsonEncode(payload), 200));
    await tester.pumpWidget(MaterialApp(home: CheConversationsScreen(baseUrl: () => 'https://che', headers: () => const {}, client: client, onOpenFlagstaff: () => flagstaff++)));
    await tester.pumpAndSettle();
    expect(find.text('Launch plan'), findsOneWidget);
    expect(find.textContaining('War Room · Nova: Your draft misses pricing'), findsOneWidget);
    await tester.tap(find.text('Flagstaff · AI mailbox'));
    expect(flagstaff, 1);
    await tester.tap(find.text('Launch plan'));
    await tester.pumpAndSettle();
    expect(find.text('Nova → Knox · critique'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Nova to Knox, critique, .*: Your draft misses pricing$')), findsOneWidget);
    expect(find.text('done'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('no conversations or a failed load is said plainly, never invented', (tester) async {
    await tester.pumpWidget(MaterialApp(home: CheConversationsScreen(baseUrl: () => 'https://che', headers: () => const {}, client: MockClient((r) async => http.Response('{"threads":[]}', 200)))));
    await tester.pumpAndSettle();
    expect(find.textContaining('No agent conversations yet'), findsOneWidget);
    await tester.pumpWidget(MaterialApp(home: CheConversationsScreen(key: UniqueKey(), baseUrl: () => 'https://che', headers: () => const {}, client: MockClient((r) async => http.Response('{"detail":"Owner only"}', 403)))));
    await tester.pumpAndSettle();
    expect(find.textContaining('could not load: Owner only'), findsOneWidget);
  });
}
