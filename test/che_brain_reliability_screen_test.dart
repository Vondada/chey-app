import 'dart:convert';

import 'package:chey/brain/che_brain_reliability_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> _seeded() => {
      'lower_bound': true,
      'coverage': {
        'sources_inaccessible': ['CHE conversation history (Worker storage)', "The owner's ChatGPT history"],
      },
      'missing_records': [
        {'id': 'M-reliability-test-2'},
      ],
      'summary': 'Reliability Registry. At least 2 testing sessions and 3 questions.',
      'take': 'No test session is open. By my records you have tested me in at least 2 sessions: 3 individual questions, 1 of them a retest.',
      'totals': {
        'sessions': 2, 'attempts': 3, 'retests': 1, 'proposed_unexecuted': 1, 'verified_results': 2, 'unknown_results': 1,
        'fabricated': 1, 'no_answer': 0, 'misrouted': 0,
        'outcomes': {'pass': 1, 'partial': 0, 'fail': 1, 'blocked': 0, 'unknown': 1},
        'most_failed': [
          {'category': 'code_understanding', 'count': 1},
        ],
      },
      'sessions': [
        {'id': 'S1', 'number': 1, 'title': 'Autonomy test round 1', 'first_at': '2026-10-08T04:19:22Z', 'attempts': 2, 'outcomes': {'pass': 1, 'fail': 1}},
        {'id': 'S2', 'number': 2, 'title': 'Round 2', 'first_at': '2026-10-08T06:06:54Z', 'attempts': 1, 'outcomes': {'unknown': 1}},
      ],
      'attempts': [
        {'key': 'r1-q1', 'number': 1, 'session_number': 1, 'attempt_in_session': 1, 'at': '2026-10-08T04:19:22Z', 'question': 'What is 17 times 23?', 'reply': 'Three hundred ninety-one.', 'outcome': 'pass', 'category': 'general_knowledge', 'evidence': [{'url': 'https://github.com/x'}]},
        {'key': 'r1-q3', 'number': 2, 'session_number': 1, 'attempt_in_session': 2, 'at': '2026-10-08T04:19:55Z', 'question': 'Which two engines does publicResearch query?', 'reply': 'Promise.all…', 'outcome': 'fail', 'category': 'code_understanding', 'failure_reason': 'Invented a line', 'evidence': []},
        {'key': 'r2-q3', 'number': 3, 'session_number': 2, 'attempt_in_session': 1, 'at': '2026-10-08T06:06:59Z', 'question': 'Which two engines does publicResearch query?', 'reply': 'No reply recorded.', 'outcome': 'unknown', 'category': 'code_understanding', 'retest_of_key': 'r1-q3', 'evidence': []},
      ],
    };

CheReliabilityClient _client(Map<String, dynamic> payload) => CheReliabilityClient(
      baseUrl: 'https://che.example',
      headers: () => {'Authorization': 'Bearer t'},
      client: MockClient((req) async {
        expect(req.url.path, '/api/brain/reliability');
        expect(req.headers['Authorization'], 'Bearer t');
        return _json(payload);
      }),
    );

void main() {
  test('the model keeps the separate totals, the lower-bound flag and each attempt as recorded', () {
    final v = CheReliabilityView.fromJson(_seeded());
    expect(v.lowerBound, isTrue);
    expect(v.totals['sessions'], 2);
    expect(v.totals['attempts'], 3);
    expect(v.totals['retests'], 1);
    expect(v.totals['proposed_unexecuted'], 1);
    expect(v.attemptsOf(1).length, 2);
    expect(v.attempts.last.retestOf, 'r1-q3');
    expect(v.attempts.first.spoken, contains('Test question 1, question 1 of session 1'));
    expect(v.attempts.first.spoken, contains('CHE answered: Three hundred ninety-one.'));
    expect(v.missing, 1);
  });

  testWidgets('tiles say "at least" and are VoiceOver-labelled; nothing speaks until a button or row is pressed', (tester) async {
    tester.view.physicalSize = const Size(1200, 3200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(home: CheBrainReliabilityScreen(client: _client(_seeded()), onSpeak: spoken.add)));
    await tester.pumpAndSettle();

    expect(spoken, isEmpty, reason: 'passive loading is silent');
    expect(find.bySemanticsLabel(RegExp(r'^Testing sessions: at least 2\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Questions asked: at least 3\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Retests: 1\. .*already inside the questions count')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Proposed, never run: 1\. not counted as tests')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^These counts are lower bounds\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Session 2: Round 2\.')), findsOneWidget);

    await tester.tap(find.text('Which test are we on?'));
    expect(spoken.single, contains('at least 2 sessions: 3 individual questions'));
    await tester.tap(find.text('Read Aloud'));
    expect(spoken.last, startsWith('Reliability Registry.'));

    await tester.tap(find.text('Session 1: Autonomy test round 1'));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel(RegExp(r'^Test question 2, question 2 of session 1.*Result: fail, Invented a line')), findsOneWidget);
    await tester.tap(find.textContaining('#2 · FAIL'));
    expect(spoken.last, contains('The question was: Which two engines does publicResearch query?'));
  });

  testWidgets('an empty registry shows how to start, not zeros', (tester) async {
    await tester.pumpWidget(MaterialApp(home: CheBrainReliabilityScreen(client: _client({'attempts': [], 'sessions': [], 'totals': {}}), onSpeak: (_) {})));
    await tester.pumpAndSettle();
    expect(find.text('No tests recorded yet'), findsOneWidget);
    expect(find.textContaining('Testing sessions'), findsNothing);
  });
}
