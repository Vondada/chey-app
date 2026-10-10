import 'dart:convert';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/agents/che_office_floor_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets('Brain agent link does not invent absence after roster network failure', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    var rosterCalls = 0;
    final client = CheAgentRuntimeClient(
      baseUrl: () => 'https://che.example',
      headers: () => const {},
      client: MockClient((request) async {
        if (request.url.path == '/api/agents') {
          rosterCalls++;
          return http.Response('Temporary roster outage', 503);
        }
        if (request.url.path == '/api/office/today') {
          return http.Response(jsonEncode({'board': {
            'started': [], 'shipped': [], 'blockers': [], 'agents_working': 0,
            'agents': [], 'stripe': {'connected': false},
          }}), 200, headers: {'content-type': 'application/json'});
        }
        return http.Response('{}', 404);
      }),
    );
    await tester.pumpWidget(MaterialApp(
      home: CheOfficeFloorScreen(
        client: client,
        initialAgentName: 'Nova',
        onSpeak: (text) async => spoken.add(text),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 300));
    expect(rosterCalls, 1);
    expect(spoken, isEmpty, reason: 'Unavailable roster does not mean Nova is absent');
    await tester.pumpWidget(const SizedBox());
  });
}
