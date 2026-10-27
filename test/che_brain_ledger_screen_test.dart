import 'dart:convert';

import 'package:chey/brain/che_brain_ledger_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> _overview() => {
      'totals': {'knowledge': 2, 'procedures': 1, 'capabilities': 1, 'pending': 1, 'failed': 0},
      'categories': [
        {'category': 'Trading', 'items': 2, 'procedures': 1, 'capabilities': 0, 'pending': 1, 'failed': 0, 'last_populated': '2026-10-22T21:31:18Z', 'last_populated_label': 'Today · 4:31 PM'},
        {'category': 'Legal', 'items': 0, 'procedures': 0, 'capabilities': 0, 'pending': 0, 'failed': 0, 'last_populated': null, 'last_populated_label': 'Nothing yet'},
      ],
      'recent': [
        {'brain_event_id': 'e1', 'title': 'ORB first 15 minutes', 'category': 'Trading', 'subcategory': 'ORB', 'time': 'Today · 4:31 PM', 'status': 'Knowledge', 'spoken': 'Trading. ORB first 15 minutes. Knowledge saved at 4:31 PM. From you. Knowledge.'},
      ],
    };

void main() {
  test('the spoken overview uses the real totals and the most recently populated categories', () {
    final s = cheBrainLedgerSummary(_overview());
    expect(s, contains('2 knowledge items, 1 procedures and 1 verified capabilities'));
    expect(s, contains('1 pending, not yet learned'));
    expect(s, contains('Most recent: Trading, Today · 4:31 PM'));
    expect(cheBrainLedgerSummary({'categories': [], 'totals': {}}), 'Nothing has entered my brain yet.');
  });

  testWidgets('category cards and events are VoiceOver-labelled; Read Aloud speaks the overview; pending items can be committed', (tester) async {
    tester.view.physicalSize = const Size(1200, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final posted = <Map<String, dynamic>>[];
    final client = CheBrainLedgerClient(
      baseUrl: 'https://che.example',
      headers: () => {'Authorization': 'Bearer t'},
      client: MockClient((req) async {
        if (req.method == 'POST') {
          posted.add(Map<String, dynamic>.from(jsonDecode(req.body) as Map));
          return _json({'ok': true, 'said': 'Committed, sir: Keep risk at 1R is now in my Trading brain as knowledge, not yet a capability.'});
        }
        final q = req.url.queryParameters;
        if (q['category'] == 'Trading') {
          return _json({
            'category': 'Trading',
            'subcategories': ['EMA', 'ORB'],
            'events': [
              {'kind': 'event', 'brain_event_id': 'e2', 'record_id': 'pend:1', 'title': 'Keep risk at 1R', 'category': 'Trading', 'subcategory': 'Risk', 'time': 'Today · 4:32 PM', 'status': 'Pending', 'spoken': 'Trading. Keep risk at 1R. Pending at 4:32 PM. System event. Pending.'},
              {'kind': 'batch', 'batch_id': 'b1', 'title': 'Trading evidence batch', 'time': 'Today · 4:00 PM', 'items': 3, 'groups': [{'name': 'ORB', 'count': 2}, {'name': 'VWAP', 'count': 1}]},
            ],
          });
        }
        return _json(_overview());
      }),
    );
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(home: CheBrainLedgerScreen(client: client, onSpeak: spoken.add)));
    await tester.pumpAndSettle();

    expect(find.bySemanticsLabel(RegExp(r'^Trading\. 2 knowledge items, 1 procedures, 0 verified capabilities, 1 pending\. Last populated Today · 4:31 PM\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Legal\. .*Last populated Nothing yet\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Trading\. ORB first 15 minutes\. Knowledge saved')), findsOneWidget);

    await tester.tap(find.text('Read Aloud'));
    expect(spoken.single, startsWith('My brain holds 2 knowledge items'));

    await tester.tap(find.text('Trading').first);
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel(RegExp(r'^Trading evidence batch, Today · 4:00 PM\. 3 items: ORB 2, VWAP 1\.')), findsOneWidget);
    await tester.tap(find.text('Commit Keep risk at 1R'));
    await tester.pumpAndSettle();
    expect(posted.single, {'record_id': 'pend:1', 'decision': 'commit'});
    expect(find.textContaining('Committed, sir: Keep risk at 1R'), findsOneWidget);
  });
}
