import 'dart:convert';

import 'package:chey/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('skill commands reach chat and show the Worker outcome receipt', (tester) async {
    SharedPreferences.setMockInitialValues({
      'che_agent_base_url': 'https://che.test',
      'che_agent_device_token': 'test-token',
      'che_typing_on': true,
      'che.ui.voiceResponsesEnabled': false,
    });
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final requests = <http.Request>[];
    var ok = true;
    final client = MockClient((request) async {
      requests.add(request);
      if (request.url.path == '/api/chat') {
        return http.Response([
          jsonEncode({'type': 'delta', 'delta': ok ? 'Found a React testing skill.' : 'That skill is not installed.'}),
          jsonEncode({'type': 'done', 'source': 'che_installed_skills', 'ok': ok}),
        ].join('\n'), 200);
      }
      return http.Response('{}', 200);
    });
    await http.runWithClient(() async {
      await tester.pumpWidget(const CHEApp());
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      await tester.tap(find.text('Chat'));
      await tester.pump(const Duration(milliseconds: 300));

      for (final command in [
        'find a skill for React testing',
        'list installed skills',
        'use find-skills to build an app',
        'use skill unknown to update your code',
      ]) {
        requests.clear();
        ok = !command.contains('unknown');
        await tester.enterText(find.byType(TextField), command);
        await tester.testTextInput.receiveAction(TextInputAction.send);
        for (var i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 200));
        }
        final chat = requests.where((r) => r.url.path == '/api/chat');
        expect(chat, hasLength(1), reason: command);
        expect(jsonDecode(chat.single.body)['message'], command);
        expect(requests.where((r) => [
          '/api/find', '/api/project/create', '/api/change/request',
        ].contains(r.url.path)), isEmpty, reason: command);
        expect(find.text(ok
            ? 'Skill request completed.'
            : 'Skill request could not be completed.'), findsOneWidget);
        // Allow the previous SnackBar to exit before the next request.
        await tester.pump(const Duration(seconds: 5));
        await tester.pump(const Duration(milliseconds: 300));
      }
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 4));
    }, () => client);
  });
}
