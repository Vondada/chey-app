// Settings → Creation Engine status (owner, 2026-10-24): connected workers, capacity, providers (automatic or needs the
// owner), the $0 limit and the two cloud settings come only from GET /api/creations/engine; loading is quiet; each
// control speaks its real result.
import 'dart:convert';

import 'package:chey/create/che_engine_status.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _view({bool auto = true, int max = 3}) => {
      'ok': true,
      'settings': {'auto_cloud': auto, 'max_cloud_workers': max, 'spend_limit_usd': 0},
      'capacity': {'gpu_online': 0, 'cpu_online': 1, 'running': 1, 'max_concurrent': max, 'runnable': 1},
      'workers': [
        {'id': 'gha-123-1', 'class': 'github_cpu', 'device': 'CPU (4 cores)', 'online': true, 'job_id': 'gpu_ab12'},
      ],
      'providers': [
        {'id': 'github_cpu', 'label': 'GitHub cloud CPU', 'automatic': true, 'cost': 'Free: this repository is public.', 'manual_step': ''},
        {
          'id': 'colab_t4',
          'label': 'Your Colab T4 GPU',
          'automatic': false,
          'cost': 'Free Colab tier.',
          'manual_step': 'Open the notebook and choose Run all; Google does not allow remote start.',
        },
      ],
      'dispatches': [],
      'spoken': 'One cloud CPU worker is connected and working. Up to $max jobs can run at once. Spending limit is 0 dollars.',
    };

void main() {
  testWidgets('shows the real workers, capacity, providers and the \$0 limit; quiet on load; settings speak their result',
      (tester) async {
    tester.view.physicalSize = const Size(1170, 4000);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    var view = _view();
    final posts = <Map<String, dynamic>>[];
    final client = MockClient((r) async {
      if (r.method == 'GET' && r.url.path == '/api/creations/engine') return http.Response(jsonEncode(view), 200);
      if (r.method == 'POST' && r.url.path == '/api/creations/engine/settings') {
        final b = jsonDecode(r.body) as Map<String, dynamic>;
        posts.add(b);
        view = _view(auto: b['auto_cloud'] as bool? ?? true, max: (b['max_cloud_workers'] as int?) ?? 3);
        return http.Response(jsonEncode({'ok': true, 'spoken': 'Saved: up to ${b['max_cloud_workers'] ?? 3} cloud workers at once.', 'view': view}), 200);
      }
      return http.Response('{}', 404);
    });
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: CheEngineStatusCard(baseUrl: 'https://che.test', headers: const {}, onRead: spoken.add, client: client),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'nothing spoken on load');
    expect(find.text('Running now: 1 · Can run at once: 3'), findsOneWidget);
    expect(find.text('Cloud CPU (GitHub) · CPU (4 cores) · working'), findsOneWidget);
    expect(find.text('GitHub cloud CPU — Automatic'), findsOneWidget);
    expect(find.text('Your Colab T4 GPU — Needs you'), findsOneWidget);
    expect(find.textContaining('Google does not allow remote start'), findsOneWidget);
    expect(find.text('Spending limit: \$0. Nothing paid can start.'), findsOneWidget);
    expect(find.bySemanticsLabel('Start free cloud workers automatically'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('engine-workers-more')));
    await tester.pumpAndSettle();
    expect(posts.single, {'max_cloud_workers': 4});
    expect(spoken.single, 'Saved: up to 4 cloud workers at once.');
    expect(find.text('4'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('engine-auto-cloud')));
    await tester.pumpAndSettle();
    expect(posts.last, {'auto_cloud': false});

    spoken.clear();
    await tester.tap(find.byTooltip('Read the Creation Engine status aloud'));
    expect(spoken.single, contains('Spending limit is 0 dollars'));
  });

  testWidgets('a failed load says so quietly', (tester) async {
    final client = MockClient((r) async => http.Response('nope', 500));
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: CheEngineStatusCard(baseUrl: 'https://che.test', headers: const {}, onRead: spoken.add, client: client)),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Could not load the Creation Engine status. Use Refresh to try again.'), findsOneWidget);
    expect(spoken, isEmpty);
  });
}
