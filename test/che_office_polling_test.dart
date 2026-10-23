// Office polling (owner, 2026-10-23: "diagnose freezes, lag ... improve iPhone responsiveness"). The app keeps one
// Office runtime for the whole session. Before this fix it kept asking the Worker for the roster every 6 seconds
// (1.5 s while busy), the coding status every 20 s and the board every 45 s even with CHE in the background, and the
// embedded Office tab started a second runtime that polled the same endpoints again.
import 'dart:convert';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/agents/che_office_floor_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

CheAgentRuntimeClient _client(Map<String, int> calls) => CheAgentRuntimeClient(
      baseUrl: () => 'https://che.example',
      headers: () => const {},
      client: MockClient((request) async {
        calls.update(request.url.path, (n) => n + 1, ifAbsent: () => 1);
        if (request.url.path == '/api/agents') {
          return http.Response(jsonEncode({'che': {'status': 'idle'}, 'agents': [], 'meetings': [], 'working': 0}), 200,
              headers: {'content-type': 'application/json'});
        }
        if (request.url.path == '/api/office/today') {
          return http.Response(jsonEncode({'board': {
            'started': [], 'shipped': [], 'blockers': [], 'agents_working': 0, 'agents': [], 'stripe': {'connected': false},
          }}), 200, headers: {'content-type': 'application/json'});
        }
        return http.Response('{}', 200, headers: {'content-type': 'application/json'});
      }),
    );

int _total(Map<String, int> calls) => calls.values.fold(0, (a, b) => a + b);

void main() {
  testWidgets('the Office runtime makes no requests while CHE is in the background, and refreshes once on return',
      (tester) async {
    final calls = <String, int>{};
    final runtime = CheAgentRuntimeController(_client(calls))..start();
    await tester.pump(const Duration(seconds: 1));
    expect(calls['/api/agents'], 1);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    final before = _total(calls);
    await tester.pump(const Duration(minutes: 3));
    expect(_total(calls), before, reason: 'a backgrounded phone must not keep polling the Worker');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(const Duration(milliseconds: 100));
    expect(calls['/api/agents'], 2, reason: 'one fresh roster on return');
    await tester.pump(const Duration(seconds: 7));
    expect(calls['/api/agents'], 3, reason: 'polling resumes at its normal pace');
    runtime.dispose();
  });

  testWidgets('start() called twice before the first roster arrives starts one set of polls', (tester) async {
    final calls = <String, int>{};
    final runtime = CheAgentRuntimeController(_client(calls))
      ..start()
      ..start();
    await tester.pump(const Duration(seconds: 41));
    expect(calls['/api/agents'], 7, reason: 'one roster loop: at 0 s, then every 6 s');
    expect(calls['/api/office/today'], 1, reason: 'one board poll, not two');
    runtime.dispose();
  });

  testWidgets('the embedded Office tab reuses the app runtime instead of polling the same endpoints twice',
      (tester) async {
    final calls = <String, int>{};
    final client = _client(calls);
    final shared = CheAgentRuntimeController(client)..start();
    await tester.pumpWidget(MaterialApp(home: CheOfficeFloorScreen(client: client, runtime: shared, embedded: true)));
    await tester.pump(const Duration(seconds: 13));
    expect(calls['/api/agents'], 3, reason: 'only the shared runtime polls the roster (0, 6, 12 s)');
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
    expect(calls['/api/agents'], 4, reason: 'closing the tab does not stop or dispose the shared runtime');
    shared.dispose();
  });
}
