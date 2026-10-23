import 'dart:convert';

import 'package:chey/brain/che_brain_truth_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> _seeded() => {
      'health': {'checked': 4, 'verified': 1, 'inferred': 1, 'unverified': 1, 'contradicted': 1, 'stale': 0, 'corrected': 2, 'evidence_coverage': 0.25},
      'receipts': {'verified_actions': {'merged': 1, 'deployed': 1, 'memory_saved': 1, 'video_render': 1, 'trade_placed': 0, 'total': 4}, 'failed_tools': 1},
      'recent': [
        {'at': '2026-10-23T22:59:59Z', 'request_id': 'req-1-ab', 'claim_type': 'pr_merged', 'verdict': 'VERIFIED', 'outcome': 'kept', 'contradiction': ''},
        {'at': '2026-10-23T22:59:58Z', 'request_id': 'req-2', 'claim_type': 'truth_layer:deployed', 'verdict': 'UNVERIFIED', 'outcome': 'removed', 'contradiction': ''},
      ],
      'window_days': 7,
      'at': '2026-10-23T23:00:00Z',
    };

Map<String, dynamic> _empty() => {
      'health': {'checked': 0, 'verified': 0, 'inferred': 0, 'unverified': 0, 'contradicted': 0, 'stale': 0, 'corrected': 0, 'evidence_coverage': null},
      'receipts': {'verified_actions': {'total': 0}, 'failed_tools': 0},
      'recent': [],
      'window_days': 7,
    };

CheBrainTruthClient _client(Map<String, dynamic> payload) => CheBrainTruthClient(
      baseUrl: 'https://che.example',
      headers: () => {'Authorization': 'Bearer t'},
      client: MockClient((req) async {
        expect(req.url.path, '/api/brain/truth');
        expect(req.headers['Authorization'], 'Bearer t');
        return _json(payload);
      }),
    );

void main() {
  test('the model keeps counts and null coverage exactly; the spoken summary uses the real numbers', () {
    final v = CheBrainTruthView.fromJson(_seeded());
    expect(v.checked, 4);
    expect(v.evidenceCoverage, 0.25);
    expect(v.coverageLabel, '25% of checked claims');
    expect(v.verifiedActions, 4);
    expect(v.recent.first.claimLabel, 'pr merged');
    expect(v.recent.last.claimLabel, 'truth layer, deployed');
    final s = cheBrainTruthSummary(v);
    expect(s, contains('checked 4 claims: 1 verified, 1 labelled inference, 1 unverified removed, 1 contradicted, 0 stale'));
    expect(s, contains('4 verified actions by receipt and 1 failed tool execution'));
    expect(s, contains('Evidence coverage 25% of checked claims'));
    final e = CheBrainTruthView.fromJson(_empty());
    expect(e.isEmpty, isTrue);
    expect(e.evidenceCoverage, isNull);
    expect(e.coverageLabel, 'no data');
    expect(cheBrainTruthSummary(e), startsWith('No audit records yet'));
  });

  testWidgets('tiles and history rows are VoiceOver-labelled; nothing speaks until Read Aloud is pressed', (tester) async {
    tester.view.physicalSize = const Size(1200, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(home: CheBrainTruthScreen(client: _client(_seeded()), onSpeak: spoken.add)));
    await tester.pumpAndSettle();

    expect(spoken, isEmpty, reason: 'passive loading is silent');
    expect(find.bySemanticsLabel(RegExp(r'^Verified actions: 4\. merges, deploys')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Unverified claims removed: 1\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Contradictions: 1\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Failed tool executions: 1\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Corrected responses: 2\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Auditor health: 4 checked\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Evidence coverage: 25% of checked claims\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^pr merged, verified, kept, ')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^truth layer, deployed, unverified, removed, ')), findsOneWidget);
    expect(find.text('Recent audit history'), findsOneWidget);

    await tester.tap(find.text('Read Aloud'));
    expect(spoken.single, startsWith('In the last 7 days my auditor checked 4 claims'));
  });

  testWidgets('an empty payload shows the empty state, not zeros presented as achievement', (tester) async {
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(home: CheBrainTruthScreen(client: _client(_empty()), onSpeak: spoken.add)));
    await tester.pumpAndSettle();
    expect(find.text('No audit records yet'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^No audit records yet\.')), findsOneWidget);
    expect(find.text('Recent audit history'), findsNothing);
    expect(find.textContaining('Verified actions'), findsNothing);
    await tester.tap(find.text('Read Aloud'));
    expect(spoken.single, startsWith('No audit records yet'));
  });
}
