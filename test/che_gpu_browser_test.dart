import 'dart:convert';
import 'package:chey/browser/che_browser.dart';
import 'package:chey/create/che_gpu_browser.dart';
import 'package:chey/create/che_gpu_connect.dart';
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
  testWidgets('Office account switches through Google; Back stays in browser and Close returns without logout', (tester) async {
    var account = 'office@example.com';
    final calls = <String>[];
    Uri? auth;
    final client = MockClient((r) async {
      calls.add('${r.method} ${r.url.path}');
      if (r.url.path == '/api/google/status') return http.Response(jsonEncode({'services': {'office': {'connected': true, 'account': account}}}), 200);
      if (r.url.path == '/api/google/connect/start') {
        expect(jsonDecode(r.body), {'service': 'office'});
        return http.Response(jsonEncode({'url': 'https://accounts.google.com/o/oauth2/v2/auth?prompt=consent%20select_account'}), 200);
      }
      return http.Response(jsonEncode({'workers': []}), 200);
    });
    final navigation = <String>[];
    CheBrowserActions.voice = (words) async { navigation.add(words); return 'This is the first page.'; };
    CheBrowserActions.openUrl = (url) async { navigation.add(url); };
    await tester.pumpWidget(MaterialApp(home: Builder(builder: (context) => Scaffold(body: TextButton(
      child: const Text('CHE'), onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CheGpuBrowser(
        baseUrl: 'https://che.test', headers: const {}, client: client, browser: const SizedBox(),
        authenticate: (uri) async { auth = uri; return true; },
      ))),
    )))));
    await tester.tap(find.text('CHE')); await tester.pumpAndSettle();
    expect(find.text('CHE Office: office@example.com'), findsOneWidget);
    await tester.tap(find.text('Back')); await tester.pumpAndSettle();
    expect(navigation, ['back']);
    expect(find.text('GPU Browser'), findsOneWidget);
    await tester.tap(find.text('Forward')); await tester.pumpAndSettle();
    expect(navigation.last, 'forward');
    await tester.ensureVisible(find.text('Switch CHE Office account'));
    await tester.tap(find.text('Switch CHE Office account')); await tester.pumpAndSettle();
    expect(auth!.host, 'accounts.google.com');
    expect(auth!.queryParameters['prompt'], contains('select_account'));
    account = 'new-office@example.com';
    await CheGpuBrowser.voiceHandler!('gpu status'); await tester.pumpAndSettle();
    expect(find.text('CHE Office: new-office@example.com'), findsOneWidget);
    await CheGpuBrowser.voiceHandler!('open'); await tester.pumpAndSettle();
    expect(Uri.parse(navigation.last).queryParameters['authuser'], account);
    await tester.tap(find.text('Close')); await tester.pumpAndSettle();
    expect(find.text('CHE'), findsOneWidget);
    expect(calls.any((s) => s.contains('disconnect') || s.contains('revoke')), false);
    await tester.tap(find.text('CHE')); await tester.pumpAndSettle();
    expect(find.text('CHE Office: new-office@example.com'), findsOneWidget);
    expect(calls.where((s) => s == 'POST /api/google/connect/start').length, 1);
    await tester.pumpWidget(const SizedBox());
    CheBrowserActions.voice = null;
    CheBrowserActions.openUrl = null;
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
  test('screen commands in the owner\'s words are UI commands, never GPU connection commands (owner, 2026-10-25)', () {
    const expected = {
      'open the browser': CheGpuUiCommand.open,
      'pull up the browser': CheGpuUiCommand.open,
      'make the browser bigger': CheGpuUiCommand.expand,
      'make the browser larger': CheGpuUiCommand.expand,
      'expand the browser': CheGpuUiCommand.expand,
      'full screen': CheGpuUiCommand.expand,
      'get this stuff out of the way': CheGpuUiCommand.hideStatus,
      'hide the status': CheGpuUiCommand.hideStatus,
      'show status': CheGpuUiCommand.showStatus,
      'show the status': CheGpuUiCommand.showStatus,
      'minimize the browser': CheGpuUiCommand.minimize,
      'close the browser': CheGpuUiCommand.close,
      'go back': CheGpuUiCommand.back,
      'back': CheGpuUiCommand.back,
      'go forward': CheGpuUiCommand.forward,
      'refresh': CheGpuUiCommand.refresh,
      'reload the page': CheGpuUiCommand.refresh,
      'sign out of Google': CheGpuUiCommand.signOutGoogle,
      'log out of Google in the browser': CheGpuUiCommand.signOutGoogle,
      'check Google sign-in': CheGpuUiCommand.checkGoogleSignIn,
      'am I signed out of Google': CheGpuUiCommand.checkGoogleSignIn,
    };
    for (final entry in expected.entries) {
      expect(cheGpuUiCommand(entry.key), entry.value, reason: entry.key);
    }
    for (final words in ['open the browser', 'pull up the browser', 'make the browser bigger', 'get this stuff out of the way']) {
      expect(cheGpuConnectCommand(words), isFalse, reason: 'must not start a GPU connection: $words');
    }
    expect(cheGpuUiCommand('connect the GPU'), isNull);
    expect(cheGpuUiCommand('what is the weather'), isNull);
  });

  testWidgets('the screen commands change what is visible and say what happened (owner, 2026-10-25)', (tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    var opened = '';
    CheBrowserActions.openUrl = (url) async { opened = url; };
    final client = MockClient((r) async => http.Response(jsonEncode({'workers': []}), 200));
    await tester.pumpWidget(MaterialApp(home: CheGpuBrowser(
      baseUrl: 'https://che.test', headers: const {'Authorization': 'Bearer test'},
      client: client, browser: const SizedBox(key: Key('colab-page')), onRead: (_) {},
    )));
    await tester.pumpAndSettle();
    final handler = CheGpuBrowser.voiceHandler!;
    final statusFinder = find.textContaining('Google decides whether');
    expect(statusFinder, findsOneWidget);
    final before = tester.getSize(find.byKey(const Key('colab-page'))).height;

    final hidden = await handler('get this stuff out of the way');
    await tester.pumpAndSettle();
    expect(hidden, 'Status hidden. Say "show status" to see it.');
    expect(statusFinder, findsNothing);
    expect(tester.getSize(find.byKey(const Key('colab-page'))).height, greaterThan(before));

    final shown = await handler('show status');
    await tester.pumpAndSettle();
    expect(shown, 'Showing the GPU status above the browser.');
    expect(statusFinder, findsOneWidget);

    final reply = await handler('open the browser');
    await tester.pumpAndSettle();
    expect(opened, startsWith('https://colab.research.google.com/'));
    expect(reply, startsWith('Colab is open and fills the screen'));
    expect(statusFinder, findsNothing);
    expect(reply, isNot(contains('Google account')), reason: 'a screen command never answers with account text');
    await tester.pumpWidget(const SizedBox());
    CheBrowserActions.openUrl = null;
  });

  testWidgets("sign out of Google opens Google's sign-out page in CHE's browser and reports only that (owner, 2026-10-25)", (tester) async {
    var opened = '';
    CheBrowserActions.openUrl = (url) async { opened = url; };
    final client = MockClient((r) async => http.Response(jsonEncode({'workers': []}), 200));
    await tester.pumpWidget(MaterialApp(home: CheGpuBrowser(
      baseUrl: 'https://che.test', headers: const {'Authorization': 'Bearer test'},
      client: client, browser: const SizedBox(), onRead: (_) {},
    )));
    await tester.pumpAndSettle();
    final reply = await CheGpuBrowser.voiceHandler!('sign out of Google');
    expect(opened, 'https://accounts.google.com/Logout');
    expect(reply, startsWith("Opened Google's sign-out page"));
    // The next step is spoken, not visual: "check Google sign-in" reads Google's own page aloud (Codex review, PR #689).
    expect(reply, contains('check Google sign-in'));
    expect(reply, isNot(contains('picture')));
    final asked = <String>[];
    CheBrowserActions.voice = (words) async { asked.add(words); return 'You are signed out. Choose an account.'; };
    final check = await CheGpuBrowser.voiceHandler!('check Google sign-in');
    expect(asked, ['read the page']);
    expect(check, "Google's page says: You are signed out. Choose an account.");
    CheBrowserActions.voice = (words) async => null;
    expect(await CheGpuBrowser.voiceHandler!('am I signed out of Google'), contains('cannot say whether you are signed out'));
    expect(cheGpuUiCommand('connect the GPU'), isNull);
    CheBrowserActions.openUrl = null;
    CheBrowserActions.voice = null;
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('back, forward and refresh go to the browser and report its real answer (owner, 2026-10-25)', (tester) async {
    final calls = <String>[];
    String next = 'This is the first page.';
    CheBrowserActions.voice = (words) async { calls.add(words); return next; };
    final client = MockClient((r) async => http.Response(jsonEncode({'workers': []}), 200));
    await tester.pumpWidget(MaterialApp(home: CheGpuBrowser(
      baseUrl: 'https://che.test', headers: const {'Authorization': 'Bearer test'},
      client: client, browser: const SizedBox(), onRead: (_) {},
    )));
    await tester.pumpAndSettle();
    final handler = CheGpuBrowser.voiceHandler!;
    expect(await handler('go back'), 'This is the first page.');
    next = 'There is no page ahead.';
    expect(await handler('go forward'), 'There is no page ahead.');
    expect(await handler('refresh'), 'There is no page ahead.');
    expect(calls, ['back', 'forward', 'refresh']);
    CheBrowserActions.voice = null;
    await tester.pumpWidget(const SizedBox());
  });
}
