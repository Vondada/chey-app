// Market context in the Trading Room (owner, 2026-10-23). Every event here is a TEST FIXTURE served by a mock Worker:
// these tests prove labels, sources, stage text (never color alone), the quiet strip and the chart annotations.
import 'dart:convert';

import 'package:chey/rooms/che_trading_chart.dart';
import 'package:chey/trading/che_market_context.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final _start = DateTime.utc(2026, 10, 20, 14, 0);
String _at(int i) => _start.add(Duration(minutes: 5 * i)).toIso8601String();

Map<String, dynamic> _view() => {
      'events_total': 31,
      'events_by_kind': {
        'cpi': {'label': 'CPI (consumer prices)', 'count': 1, 'sources': ['BLS (TEST)']},
        'political_statement': {'label': 'Statement or post by an influential political figure', 'count': 0, 'sources': []},
      },
      'models': [
        {
          'id': 'ctx-cpi', 'name': 'CPI release reaction', 'stage': 'implemented', 'stage_label': 'IMPLEMENTED', 'events_stored': 1,
          'reason_not_running': '1 events stored; no study has been run on verified bars yet.', 'rules': 'Event study of CPI.',
          'sources': [{'name': 'BLS (TEST)', 'url': 'https://www.bls.gov/test'}], 'limitations': ['Association, not causation.'],
        },
        {
          'id': 'ctx-political', 'name': 'Political statements and posts', 'stage': 'rules_documented', 'stage_label': 'RULES DOCUMENTED', 'events_stored': 0,
          'reason_not_running': 'Only owner-cited posts count.', 'rules': 'Event study from the post timestamp.', 'sources': [],
          'source_limits': 'Truth Social has no free official API and the X API is paid.', 'limitations': ['Association, not causation.'],
        },
      ],
      'classifiers': [{'name': 'Volatility regime', 'note': 'A tag.'}],
      'upcoming': [
        {'kind': 'cpi', 'label': 'CPI (consumer prices)', 'minutes_until': 25, 'high_impact': true, 'source_name': 'BLS — release calendar'},
      ],
      'studies': [],
      'live_trading': 'disabled',
    };

http.Response _ok(String body, [int status = 200]) => http.Response.bytes(utf8.encode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

class _Server {
  final requests = <http.Request>[];
  late final client = MockClient((r) async {
    requests.add(r);
    switch (r.url.path) {
      case '/api/trading/context/upcoming':
        return _ok(jsonEncode({'upcoming': _view()['upcoming'], 'spoken': 'Coming up, sir: CPI in 25 minutes.'}), 200);
      case '/api/trading/context':
        return _ok(jsonEncode(_view()), 200);
      case '/api/trading/context/refresh':
        return _ok(jsonEncode({'ok': true, 'report': {'rules': {'added': 30}, 'sources': [{'name': 'BLS — calendar', 'status': 'failed', 'error': 'answered 403'}]}}), 200);
      case '/api/trading/context/annotations':
        return _ok(jsonEncode({'annotations': [
          {'id': 'e1', 't': _at(10), 'kind': 'cpi', 'label': 'CPI (consumer prices)', 'title': 'CPI (TEST)', 'scheduled': true, 'source_name': 'BLS (TEST)',
            'source_url': 'https://www.bls.gov/test', 'verified': 'official schedule', 'reaction_label': 'no measured reaction'},
        ]}), 200);
      case '/api/trading/chart':
        return _ok(jsonEncode({
          'ok': true, 'account': 'futures_paper', 'state': 'verified', 'symbol': 'MNQ', 'timeframe': '5m', 'timeframes': ['5m'],
          'bars': [for (var i = 0; i < 40; i++) {'t': _at(i), 'o': 100 + i * 0.5, 'h': 101.5 + i * 0.5, 'l': 99.5 + i * 0.5, 'c': 100.8 + i * 0.5}],
          'feed': {'provider': 'Yahoo MNQ=F', 'status': 'DELAYED', 'age_s': 60}, 'entries_allowed': false, 'markers': [], 'drawings': [], 'open_orders': [],
        }), 200);
    }
    return http.Response('{"detail":"not found"}', 404);
  });
  CheMarketContextClient get ctx => CheMarketContextClient(baseUrl: () => 'https://che.example', headers: () => const {}, client: client);
}

Future<void> _pump(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: Scaffold(body: SingleChildScrollView(child: child))));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  test('an annotation keeps its source, verification and tag; a missing time is dropped', () {
    final a = CheEventAnnotation.fromJson({'t': '2026-10-20T12:30:00Z', 'kind': 'fomc_decision', 'label': 'FOMC rate decision', 'title': 'FOMC (TEST)',
      'source_name': 'Federal Reserve', 'verified': 'official schedule', 'reaction_label': 'day +0.4% (persistent; observed, not caused)', 'scheduled': true})!;
    expect(a.tag, 'FED');
    expect(a.receipt, contains('Source: Federal Reserve (official schedule)'));
    expect(a.receipt, contains('observed, not caused'));
    expect(CheEventAnnotation.fromJson({'kind': 'cpi'}), isNull);
    expect(CheEventAnnotation.fromJson({'t': '2026-10-20T12:30:00Z', 'kind': 'political_statement'})!.tag, 'POL');
  });

  test('every stage has its own text and icon', () {
    final stages = ['discovered', 'rules_documented', 'implemented', 'backtested', 'forward_tested', 'paper_active'];
    expect({for (final s in stages) cheStageBadge(s).$1}.length, 6);
    expect({for (final s in stages) cheStageBadge(s).$2}.length, 6);
    expect(cheStageBadge('rules_documented').$1, 'RULES DOCUMENTED');
  });

  testWidgets('the strip shows upcoming-event warnings in text, quietly, and reads only on request', (tester) async {
    final s = _Server();
    final spoken = <String>[];
    await _pump(tester, CheMarketContextStrip(client: s.ctx, onRead: spoken.add));
    expect(find.textContaining('HIGH IMPACT · CPI (consumer prices) in 25 min'), findsOneWidget);
    expect(find.byKey(const Key('context_dependency')), findsOneWidget);
    expect(find.textContaining('not a prediction'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('Event warning: CPI')), findsOneWidget);
    expect(spoken, isEmpty, reason: 'silent on open');
    await tester.tap(find.byKey(const Key('context_read')));
    expect(spoken.single, contains('CPI in 25 minutes'));
  });

  testWidgets('the page lists models with stage text, why each is not running, and the political-post source limits', (tester) async {
    final s = _Server();
    await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: CheMarketContextPage(client: s.ctx, onRead: (_) {})));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('context_disclaimer')), findsOneWidget);
    expect(find.text('IMPLEMENTED'), findsOneWidget);
    expect(find.text('RULES DOCUMENTED'), findsOneWidget);
    expect(find.textContaining('Not running: 1 events stored'), findsOneWidget);
    await tester.scrollUntilVisible(find.textContaining('X API is paid'), 200);
    expect(find.textContaining('Source limits: Truth Social has no free official API'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Political statements and posts\. Stage: RULES DOCUMENTED')), findsOneWidget);
  });

  testWidgets('refresh is sent only when pressed and its failures are reported, not hidden', (tester) async {
    final s = _Server();
    await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: CheMarketContextPage(client: s.ctx)));
    await tester.pumpAndSettle();
    expect(s.requests.where((r) => r.method == 'POST'), isEmpty, reason: 'nothing is fetched on open');
    await tester.tap(find.byKey(const Key('context_refresh')));
    await tester.pumpAndSettle();
    expect(s.requests.where((r) => r.url.path == '/api/trading/context/refresh'), hasLength(1));
    expect(find.textContaining('30 rule-based dates added'), findsOneWidget);
    expect(find.textContaining('BLS: failed (answered 403)'), findsOneWidget);
  });

  testWidgets('the futures chart loads market events and names them in its summary', (tester) async {
    final s = _Server();
    final key = GlobalKey<CheTradingChartState>();
    await _pump(tester, CheTradingChart(key: key, baseUrl: () => 'https://che.example', headers: () => const {}, client: s.client, initialAccount: 'futures_paper', height: 300));
    await tester.pumpAndSettle();
    expect(s.requests.where((r) => r.url.path == '/api/trading/context/annotations' && r.url.queryParameters['market'] == 'MNQ'), isNotEmpty);
    expect(key.currentState!.summary, contains('1 market event on this chart: CPI (consumer prices)'));
  });

  testWidgets('an Alpaca stock chart asks for no market events', (tester) async {
    final s = _Server();
    await _pump(tester, CheTradingChart(baseUrl: () => 'https://che.example', headers: () => const {}, client: s.client, initialAccount: 'alpaca_paper', height: 300));
    await tester.pumpAndSettle();
    expect(s.requests.where((r) => r.url.path == '/api/trading/context/annotations'), isEmpty);
  });
}
