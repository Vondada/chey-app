// Strategy Control Center (owner, 2026-10-20): the fixture is the Worker's own view
// (trading_controls.js controlsView over the live portfolios). The 30-a-day default is visible;
// increase and decrease go through the Worker; a risk increase shows its impact and is sent again
// only on Confirm; Emergency Stop acts at once with no sheet; pause is per strategy; skip reasons
// and the audit trail are shown; opening the screen is silent.
import 'dart:convert';
import 'dart:io';

import 'package:chey/rooms/che_strategy_controls.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> fixture() => (jsonDecode(File('test/fixtures/trading_controls.json').readAsStringSync()) as Map).cast<String, dynamic>();

class FakeWorker {
  final posts = <Map<String, dynamic>>[];
  Map<String, dynamic> view = fixture();
  late final http.Client client = MockClient((r) async {
    if (r.method == 'GET') return http.Response.bytes(utf8.encode(jsonEncode(view)), 200);
    final body = (jsonDecode(r.body) as Map).cast<String, dynamic>();
    posts.add(body);
    final change = (body['change'] as Map).cast<String, dynamic>();
    final raises = change['kind'] == 'set' && change['field'] == 'max_per_day' && (change['value'] as int) > 30;
    if (raises && body['confirm'] != true) {
      return http.Response.bytes(utf8.encode(jsonEncode({
        'ok': false, 'needs_confirmation': true,
        'summary': ['fair value gap retest: maximum trades per day 30 → 31.'],
        'impact': ['fair value gap retest: up to 1 more paper entries a day (30 → 31).'],
        'spoken': 'This raises risk, sir.', 'view': view,
      })), 200);
    }
    if (change['kind'] == 'emergency_stop') {
      view = {...view, 'controls': {...(view['controls'] as Map), 'emergency': {'at': '2026-10-20T15:00:00Z', 'by': 'owner (iPhone)'}, 'stop_new_entries': true}};
      return http.Response.bytes(utf8.encode(jsonEncode({'ok': true, 'spoken': "Done, sir. Emergency Stop: new entries are blocked. CHE's MNQ paper simulations: 1 unfilled order cancelled; 0 positions still open.", 'view': view})), 200);
    }
    return http.Response.bytes(utf8.encode(jsonEncode({'ok': true, 'spoken': 'Done, sir. ${change['kind']}', 'view': view})), 200);
  });
}

Widget host(FakeWorker w, List<String> asked) => MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheStrategyControlsPanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: asked.add, client: w.client, refresh: const Duration(hours: 1)))),
    );

void main() {
  testWidgets('the 30-a-day default, PAPER ONLY, every strategy, skip reasons and the audit trail are shown; opening is silent', (tester) async {
    tester.view.physicalSize = const Size(900, 9000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final w = FakeWorker();
    final asked = <String>[];
    await tester.pumpWidget(host(w, asked));
    await tester.pumpAndSettle();
    expect(find.text('PAPER ONLY'), findsOneWidget);
    expect(find.bySemanticsLabel('Paper only. Live trading is off.'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^fair value gap retest, ICT group\. running\. 0 of 30 entries today\.$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^RSI 30/70 reversal\. running\. 0 of 20 entries today\.$')), findsOneWidget);
    expect(find.bySemanticsLabel('Maximum trades per day: 30'), findsNWidgets(9));
    expect(find.textContaining('never a target'), findsOneWidget);
    expect(find.textContaining('RSI 30/70 reversal: maximum trades per day 30 → 20'), findsOneWidget, reason: 'the audit trail');
    await tester.tap(find.bySemanticsLabel('Show rules, results and skip reasons for trend pullback to the 20 EMA'));
    await tester.pumpAndSettle();
    expect(find.textContaining('the signal was not with the 50 EMA trend'), findsOneWidget);
    expect(find.textContaining('20 EMA above the 50 EMA and rising'), findsOneWidget, reason: 'the rules are visible');
    expect(find.textContaining('no closed trades yet'), findsOneWidget, reason: 'an honest empty result');
    expect(find.bySemanticsLabel('London session filter: not implemented'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Order blocks: implemented in 1 strategies$')), findsOneWidget);
    expect(asked, isEmpty);
    expect(w.posts, isEmpty, reason: 'reading changes nothing');
  });

  testWidgets('raising a limit shows its impact and is applied only on Confirm; Keep as is sends nothing more', (tester) async {
    tester.view.physicalSize = const Size(900, 9000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final w = FakeWorker();
    await tester.pumpWidget(host(w, []));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('Increase Maximum trades per day for this strategy, now 30').first);
    await tester.pumpAndSettle();
    expect(w.posts.single['change'], {'kind': 'set', 'scope': 'fvg-retest-5m', 'field': 'max_per_day', 'value': 31});
    expect(w.posts.single['confirm'], false);
    expect(find.text('This raises risk'), findsOneWidget);
    expect(find.textContaining('up to 1 more paper entries a day'), findsOneWidget);
    await tester.tap(find.text('Keep as is'));
    await tester.pumpAndSettle();
    expect(w.posts.length, 1, reason: 'nothing more is sent');
    await tester.tap(find.bySemanticsLabel('Increase Maximum trades per day for this strategy, now 30').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm change'));
    await tester.pumpAndSettle();
    expect(w.posts.length, 3);
    expect(w.posts.last['confirm'], true);
    // Lowering needs no sheet.
    await tester.tap(find.bySemanticsLabel('Decrease Maximum trades per day for this strategy, now 30').first);
    await tester.pumpAndSettle();
    expect(w.posts.last['change'], {'kind': 'set', 'scope': 'fvg-retest-5m', 'field': 'max_per_day', 'value': 29});
    expect(find.text('This raises risk'), findsNothing);
  });

  testWidgets('Emergency Stop acts at once and shows what it stopped; pause is per strategy', (tester) async {
    tester.view.physicalSize = const Size(900, 9000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final w = FakeWorker();
    await tester.pumpWidget(host(w, []));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('Pause ICT Silver Bullet'));
    await tester.pumpAndSettle();
    expect(w.posts.last['change'], {'kind': 'pause', 'scope': 'silver-bullet-5m'});
    await tester.tap(find.bySemanticsLabel('Emergency Stop'));
    await tester.pumpAndSettle();
    expect(w.posts.last['change'], {'kind': 'emergency_stop'});
    expect(find.text('This raises risk'), findsNothing, reason: 'no confirmation for a stop');
    expect(find.textContaining('1 unfilled order cancelled; 0 positions still open'), findsWidgets);
    expect(find.text('Emergency Stop is on: no new entries anywhere.'), findsOneWidget);
    expect(find.bySemanticsLabel('Allow new entries'), findsOneWidget);
  });

  // Owner audit (2026-10-24): a strategy that is switched on but has no fresh data says "waiting for data" and why,
  // and a running one names its delayed data, never "live".
  testWidgets('a switched-on strategy without data reads waiting for data; running names its delayed data', (tester) async {
    tester.view.physicalSize = const Size(900, 9000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final w = FakeWorker();
    final rows = [for (final r in (w.view['strategies'] as List)) (r as Map).cast<String, dynamic>()];
    rows[0] = {...rows[0], 'state': 'waiting for data', 'evaluating': false, 'state_reason': 'The newest bar from Yahoo MNQ=F closed 180 minutes ago (market closed or the feed stopped). No signal is being evaluated until new bars arrive.', 'data_label': ''};
    rows[1] = {...rows[1], 'state': 'running', 'evaluating': true, 'state_reason': '', 'data_label': 'DELAYED: Yahoo MNQ=F, about 10 minutes behind. Research and forward paper testing only, not live data.'};
    w.view = {...w.view, 'strategies': rows};
    await tester.pumpWidget(host(w, <String>[]));
    await tester.pumpAndSettle();
    expect(find.textContaining('waiting for data'), findsWidgets);
    expect(find.textContaining('No signal is being evaluated until new bars arrive.'), findsOneWidget);
    expect(find.text('DELAYED: Yahoo MNQ=F, about 10 minutes behind. Research and forward paper testing only, not live data.'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('^${RegExp.escape('${rows[0]['name']}')}.*waiting for data\\..*No signal is being evaluated')), findsOneWidget);
  });
}
