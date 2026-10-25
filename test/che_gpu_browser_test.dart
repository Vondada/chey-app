import 'dart:convert';
import 'package:chey/browser/che_browser.dart';
import 'package:chey/create/che_gpu_browser.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('Google sign-in handoff matches the exact host', () {
    expect(cheGoogleSignInUrl('https://accounts.google.com/o/oauth2/auth'), isTrue);
    expect(cheGoogleSignInUrl('https://accounts.google.com.evil.test/'), isFalse);
    expect(cheGoogleSignInUrl('https://colab.research.google.com/'), isFalse);
  });
  testWidgets('GPU status excludes CPU workers and reconnect never claims connection', (tester) async {
    // The saved Colab account is read from preferences; a test has none, so give it an empty store (it would wait forever).
    SharedPreferences.setMockInitialValues({});
    final spoken = <String>[];
    var gpuOnline = false;
    final client = MockClient((r) async {
      expect(r.headers['Authorization'], 'Bearer test');
      return http.Response(jsonEncode({'workers': [
        {'class': 'github_cpu', 'gpu': 'CPU', 'device': 'cpu', 'online': true},
        {'class': 'colab', 'gpu': 'Tesla T4', 'online': gpuOnline, 'last_seen': '2026-10-24T20:00:00Z'},
      ]}), 200);
    });
    await tester.pumpWidget(MaterialApp(home: CheGpuBrowser(
      baseUrl: 'https://che.test', headers: const {'Authorization': 'Bearer test'},
      client: client, browser: const SizedBox(), onRead: spoken.add,
    )));
    await tester.pumpAndSettle();
    expect(find.textContaining('No GPU heartbeat online'), findsOneWidget);
    expect(spoken, isEmpty);
    gpuOnline = true;
    expect(await CheGpuBrowser.voiceHandler!('GPU status'), contains('Tesla T4'));
    var opened = '';
    CheBrowserActions.openUrl = (url) async { opened = url; };
    final reply = await CheGpuBrowser.voiceHandler!('reconnect');
    expect(opened, startsWith('https://colab.research.google.com/'));
    expect(reply, contains('CHE cannot start the GPU herself'));
    CheBrowserActions.openUrl = null;
    await tester.pumpWidget(const SizedBox());
    expect(CheGpuBrowser.voiceHandler, isNull);
  });
  testWidgets('the Colab page gets most of an iPhone screen and the controls stay reachable (owner, 2026-10-25)', (tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final client = MockClient((r) async => http.Response(jsonEncode({'workers': []}), 200));
    await tester.pumpWidget(MaterialApp(home: CheGpuBrowser(
      baseUrl: 'https://che.test', headers: const {'Authorization': 'Bearer test'},
      client: client, browser: const SizedBox(key: Key('colab-page')), onRead: (_) {},
    )));
    await tester.pumpAndSettle();
    expect(tester.getSize(find.byKey(const Key('colab-page'))).height, greaterThan((844 - kToolbarHeight) * 0.5));
    expect(tester.getRect(find.widgetWithText(TextButton, 'Open')).bottom, lessThan(844));
    await tester.pumpWidget(const SizedBox());
  });
}
