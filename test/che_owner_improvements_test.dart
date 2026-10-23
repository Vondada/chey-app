// Owner Improvements (owner, 2026-10-23): CHE's preference changes apply in the app with no new build, the app
// reports what it really uses, and the dashboard shows each request with its history, evidence and Undo.
import 'dart:convert';

import 'package:chey/che_ui/che_owner_improvements.dart';
import 'package:chey/che_ui/che_ui_preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> _task(String id, String status, {Map<String, dynamic>? undo, String kind = 'config'}) => {
      'id': id,
      'request': 'Make the chart smaller.',
      'status': status,
      'kind': kind,
      'screen': 'Trading Room',
      'history': [
        {'at': '2026-10-23T12:00:00Z', 'status': 'requested', 'note': 'Owner request received.'},
        {'at': '2026-10-23T12:00:01Z', 'status': status, 'note': 'Stored and read back.'},
      ],
      'evidence': ['Stored and read back: chart.height = compact (config revision 1).'],
      'acceptance': const [],
      'undo': undo ?? {'available': false},
      'job_id': null,
    };

void main() {
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await CheUiPreferences.instance.load();
    CheUiPreferences.instance.ownerConfigRev = 0;
  });

  test('a newer server revision applies; an older one never overwrites a later change on this phone', () async {
    final p = CheUiPreferences.instance;
    final applied = await p.applyOwnerConfig({'chart.height': 'compact', 'layout.density': 'spacious', 'status.success_color': 'chrome_green', 'chart.orientation': 'portrait'}, rev: 3);
    expect(applied['chart.height'], 'compact');
    expect(applied['layout.density'], 'spacious');
    expect(p.successColor, CheUiPreferences.successColors['chrome_green']);
    expect(p.spacing, 1.5);
    expect(p.deskDensity, CheDeskDensity.comfortable);
    final stale = await p.applyOwnerConfig({'chart.height': 'tall'}, rev: 2);
    expect(stale['chart.height'], 'compact', reason: 'revision 2 is older than 3');
    // Unknown keys and values are ignored, never guessed.
    await p.applyOwnerConfig({'chart.height': 'huge', 'made.up': 'x'}, rev: 4);
    expect(p.chartHeight, CheChartHeight.compact);
    // Persisted: a restart reads the same values.
    await p.load();
    expect(p.chartHeight, CheChartHeight.compact);
    expect(p.chartPortrait, isTrue);
    expect(p.ownerConfigRev, 4);
  });

  test('chart height follows the size preference, and portrait makes a tall chart only while upright', () async {
    final p = CheUiPreferences.instance;
    expect(p.chartHeightFor(340), 340);
    await p.applyOwnerConfig({'chart.height': 'compact'}, rev: 1);
    expect(p.chartHeightFor(340), closeTo(238, 0.01));
    await p.applyOwnerConfig({'chart.orientation': 'portrait'}, rev: 2);
    expect(p.chartHeightFor(340, screen: const Size(390, 844)), closeTo(844 * 0.55, 0.01));
    expect(p.chartHeightFor(340, screen: const Size(844, 390)), closeTo(238, 0.01), reason: 'nothing changes in landscape');
  });

  test('a reply\'s ui_config is applied and the app reports exactly what it now uses', () async {
    Map<String, dynamic>? reported;
    final client = CheOwnerImprovementsClient(
      baseUrl: 'https://che.test',
      headers: () => const {},
      client: MockClient((req) async {
        expect(req.url.path, '/api/owner/improvements/imp-20261023-001/applied');
        reported = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(jsonEncode({'ok': true, 'status': 'verified'}), 200);
      }),
    );
    final status = await CheOwnerConfigSync.applyReply({'rev': 7, 'values': {'chart.height': 'compact'}, 'task_id': 'imp-20261023-001'}, client);
    expect(status, 'verified');
    expect((reported!['applied'] as Map)['chart.height'], 'compact');
    expect(CheUiPreferences.instance.chartHeight, CheChartHeight.compact);
  });

  testWidgets('dashboard: grouped cards with id, history and evidence; Undo puts the setting back', (tester) async {
    await CheUiPreferences.instance.applyOwnerConfig({'chart.height': 'compact'}, rev: 1);
    var undone = false;
    final spoken = <String>[];
    final client = CheOwnerImprovementsClient(
      baseUrl: 'https://che.test',
      headers: () => const {},
      client: MockClient((req) async {
        if (req.method == 'GET') {
          return http.Response(jsonEncode({
            'tasks': [
              _task('imp-20261023-001', undone ? 'failed' : 'testing', undo: undone ? null : {'available': true, 'key': 'chart.height', 'to': 'standard'}),
              _task('imp-20261023-002', 'verified'),
              _task('imp-20261023-003', 'requested', kind: 'code'),
            ],
          }), 200);
        }
        expect(req.url.path, '/api/owner/improvements/imp-20261023-001/undo');
        undone = true;
        return http.Response(jsonEncode({'ok': true, 'spoken': 'Undone. The chart size is back to standard.', 'ui_config': {'rev': 2, 'values': {'chart.height': 'standard'}}}), 200);
      }),
    );
    await tester.pumpWidget(MaterialApp(home: CheOwnerImprovementsScreen(client: client, onSpeak: spoken.add)));
    await tester.pumpAndSettle();
    expect(find.text('TESTING'), findsOneWidget);
    expect(find.text('VERIFIED'), findsOneWidget);
    expect(find.text('REQUESTED'), findsOneWidget);
    expect(find.textContaining('imp-20261023-002 · Verified'), findsOneWidget);
    expect(spoken, isEmpty, reason: 'loading the page is silent');

    await tester.tap(find.textContaining('imp-20261023-001'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Stored and read back: chart.height = compact'), findsWidgets);
    expect(find.bySemanticsLabel('Undo imp-20261023-001'), findsOneWidget);
    await tester.tap(find.text('Undo'));
    await tester.pumpAndSettle();
    expect(spoken.single, 'Undone. The chart size is back to standard.');
    expect(CheUiPreferences.instance.chartHeight, CheChartHeight.standard);
    expect(find.text('FAILED OR BLOCKED'), findsOneWidget);

    // A logged coding task offers "Send to engineers".
    await tester.tap(find.textContaining('imp-20261023-003'));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel("Send imp-20261023-003 to CHE's engineers"), findsOneWidget);
  });

  test('the spoken summary states the same counts as the page', () {
    expect(
      cheImprovementsSummary({'tasks': [_task('a', 'verified'), _task('b', 'verified'), _task('c', 'coding')]}),
      '3 improvements: 1 Coding, 2 Verified.',
    );
    expect(cheImprovementsSummary({'tasks': const []}), startsWith('There are no owner improvements yet.'));
  });
}
