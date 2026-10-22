import 'dart:convert';

import 'package:chey/workflows/che_workflows_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _view({bool disabled = false, List<Map<String, dynamic>> candidates = const []}) => {
      'workflows': [
        {'id': 'trading_desk', 'name': 'Trading desk', 'kind': 'system', 'summary': 'Charts and paper trades.', 'approval': 'money', 'disabled': disabled, 'stats': {'runs': 5, 'success_rate': 100, 'avg_model_calls': 0}},
        {'id': 'safety_gate', 'name': 'Safety gate', 'kind': 'system', 'summary': 'Holds money and delete actions.', 'approval': 'money', 'disabled': false, 'stats': {'runs': 0}},
        {'id': 'learned:ab12', 'name': 'earn today → /money-dashboard', 'kind': 'learned', 'summary': 'Learned.', 'approval': 'none', 'disabled': false, 'stats': {'runs': 1, 'success_rate': 100, 'avg_model_calls': 0}},
      ],
      'efficiency': {'requests': 8, 'via_workflow': 6, 'via_model_only': 2, 'percent_via_workflow': 75, 'avg_model_calls_workflow': 0, 'avg_model_calls_model_path': 2, 'model_calls_avoided': 12, 'learned_runs': 1},
      'candidates': candidates,
    };

http.Response _json(Object body, int status) => http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

void main() {
  testWidgets('Workflows page: measured savings as large text, Read Aloud on request, filters, and an on/off switch with its real result', (tester) async {
    tester.view.physicalSize = const Size(1200, 5000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final posts = <String>[];
    String? spoken;
    final client = MockClient((req) async {
      if (req.method == 'POST') {
        posts.add('${req.url.path} ${req.body}');
        return _json({'ok': true, 'view': _view(disabled: true)}, 200);
      }
      return _json(_view(), 200);
    });
    await tester.pumpWidget(MaterialApp(home: CheWorkflowsScreen(client: CheWorkflowsClient(baseUrl: 'https://che.test', headers: () => {}, client: client), onSpeak: (t) => spoken = t)));
    await tester.pumpAndSettle();
    expect(find.textContaining('6 ran through reusable workflows (75 percent)'), findsOneWidget);
    expect(find.textContaining('at least 12'), findsOneWidget);
    expect(spoken, isNull, reason: 'nothing is spoken on open');
    await tester.tap(find.text('Read Aloud'));
    expect(spoken, contains('75 percent'));
    expect(find.bySemanticsLabel(RegExp(r'^Trading desk, Built in\. .*5 runs · 100% succeeded')), findsOneWidget);
    await tester.tap(find.text('Learned'));
    await tester.pumpAndSettle();
    expect(find.text('Trading desk'), findsNothing);
    expect(find.text('earn today → /money-dashboard'), findsOneWidget);
    await tester.tap(find.text('All'));
    await tester.pumpAndSettle();
    final safety = tester.widget<Switch>(find.descendant(of: find.bySemanticsLabel('Safety gate always stays on'), matching: find.byType(Switch)));
    expect(safety.onChanged, isNull, reason: 'the safety gate cannot be turned off');
    await tester.tap(find.descendant(of: find.bySemanticsLabel('Use Trading desk'), matching: find.byType(Switch)));
    await tester.pumpAndSettle();
    expect(posts.single, startsWith('/api/workflows/disable'));
    expect(find.text('Trading desk is off.'), findsOneWidget);
  });

  testWidgets('Workflows page: a learned candidate is promoted only by the owner\'s tap, and a failure is reported as a failure', (tester) async {
    var fail = true;
    final client = MockClient((req) async {
      if (req.method == 'POST') {
        if (fail) return _json({'detail': 'failed_test'}, 409);
        return _json({'ok': true, 'view': _view()}, 200);
      }
      return _json(_view(candidates: [{'id': 'cand-1', 'name': 'earn today → /money-dashboard', 'reason': 'The language model answered this 3 times.'}]), 200);
    });
    await tester.pumpWidget(MaterialApp(home: CheWorkflowsScreen(client: CheWorkflowsClient(baseUrl: 'https://che.test', headers: () => {}, client: client))));
    await tester.pumpAndSettle();
    expect(find.text('Learned candidates (1)'), findsOneWidget);
    await tester.tap(find.text('Promote'));
    await tester.pumpAndSettle();
    expect(find.text('That did not work: failed_test'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Promote'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Candidate 1 promoted'), findsOneWidget);
  });
}
