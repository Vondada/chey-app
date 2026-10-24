// GPU jobs card in the Creation Room (lib/che_gpu_jobs.dart): shows each job state from the Worker's queue, says
// whether the Colab worker is online, stays silent until Read aloud, and its Pair, Cancel and Retry buttons call the
// Worker routes in server/cloudflare/gpu_queue.js.
import 'dart:convert';

import 'package:chey/che_gpu_jobs.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _view({bool online = false, bool paired = true}) => {
      'worker_paired': paired,
      'workers': [if (online) {'id': 'colab-1', 'online': true, 'gpu': 'Tesla T4, 550.54, 15360 MiB'}],
      'counts': {'rendering': 1, 'paused': 1, 'completed': 1, 'failed': 1},
      'spoken': 'GPU jobs: 1 rendering. It costs nothing.',
      'jobs': [
        {'id': 'gpu_r', 'title': 'Face v8', 'state': 'rendering', 'progress': {'pct': 33}, 'previews': {}, 'history': [{'note': 'Claimed by the Colab worker.'}]},
        {'id': 'gpu_p', 'title': 'Face v7b', 'state': 'paused', 'progress': {}, 'previews': {}, 'history': [{'note': 'The Colab session stopped answering.'}]},
        {'id': 'gpu_c', 'title': 'Face v7', 'state': 'completed', 'progress': {'pct': 100}, 'previews': {'0': 'm0', '45': 'm45', '90': 'm90'}, 'history': [{'note': 'Rendered on Tesla T4.'}]},
        {'id': 'gpu_f', 'title': 'Face v6', 'state': 'failed', 'progress': {}, 'previews': {}, 'history': [{'note': 'A face check failed.'}]},
      ],
    };

class _Server {
  _Server(this.view);
  Map<String, dynamic> view;
  final calls = <http.Request>[];
  late final client = MockClient((r) async {
    calls.add(r);
    if (r.url.path == '/api/gpu') return http.Response(jsonEncode(view), 200);
    if (r.url.path == '/api/gpu/worker-token') return http.Response(jsonEncode({'ok': true, 'token': 'a' * 64}), 200);
    if (r.url.path.startsWith('/api/gpu/jobs/')) return http.Response(jsonEncode({'ok': true, 'job': {}}), 200);
    return http.Response('{}', 404);
  });
}

Future<void> _pump(WidgetTester tester, _Server s, {List<String>? read}) async {
  // Tall enough that every job is on screen (a scroll view leaves off-screen buttons out of the semantics tree).
  tester.view.physicalSize = const Size(1000, 3000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      backgroundColor: Colors.black,
      body: SingleChildScrollView(
        child: CheGpuJobsCard(baseUrl: 'https://che.example', headers: const {}, client: s.client, onRead: read?.add),
      ),
    ),
  ));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('every job state is shown, with progress, and the worker status is honest', (tester) async {
    final s = _Server(_view());
    final read = <String>[];
    await _pump(tester, s, read: read);
    expect(find.text('Rendering on the GPU · 33%'), findsOneWidget);
    expect(find.text('Paused: resumes on the next free worker'), findsOneWidget);
    expect(find.text('Completed on the GPU'), findsOneWidget);
    expect(find.text('Failed'), findsOneWidget);
    expect(find.textContaining('No Colab session open'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('GPU picture, three-quarter view')), findsOneWidget);
    expect(read, isEmpty, reason: 'the room never speaks on its own');
    await tester.tap(find.bySemanticsLabel('Read the GPU jobs aloud'));
    expect(read.single, 'GPU jobs: 1 rendering. It costs nothing.');
  });

  testWidgets('an online worker is named; unpaired says how to pair', (tester) async {
    await _pump(tester, _Server(_view(online: true)));
    expect(find.text('Colab GPU worker online: Tesla T4, 550.54, 15360 MiB.'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());   // a fresh card, not the one above
    await _pump(tester, _Server(_view(paired: false)));
    expect(find.textContaining('not paired yet'), findsOneWidget);
    expect(find.text('Pair Colab'), findsOneWidget);
  });

  testWidgets('Pair Colab shows the token once; Cancel and Retry call the queue', (tester) async {
    final s = _Server(_view());
    await _pump(tester, s);
    await tester.tap(find.bySemanticsLabel('Make the Colab worker token'));
    await tester.pumpAndSettle();
    expect(find.text('a' * 64), findsOneWidget);
    expect(find.textContaining('CHE_GPU_TOKEN'), findsOneWidget);
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('Cancel Face v8'));
    await tester.pumpAndSettle();
    final cancel = s.calls.singleWhere((r) => r.url.path == '/api/gpu/jobs/cancel');
    expect(jsonDecode(cancel.body)['id'], 'gpu_r');
    await tester.tap(find.bySemanticsLabel('Retry Face v6'));
    await tester.pumpAndSettle();
    expect(jsonDecode(s.calls.singleWhere((r) => r.url.path == '/api/gpu/jobs/retry').body)['id'], 'gpu_f');
    expect(find.textContaining('Queued again'), findsOneWidget);
  });
}
