// End to end: the real Command Center page, over real HTTP, against CHE's
// real Worker code (tool/command_center_e2e_server.mjs: in-memory storage,
// offline network, a fixed fake model). Nothing between them is mocked.
//
// CI starts the server and sets CHE_E2E_URL / CHE_E2E_TOKEN (and
// CHE_E2E_REQUIRED=1, so a missing server fails instead of skipping).
import 'dart:convert';
import 'dart:io';

import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/commands/che_command_center.dart';
import 'package:chey/commands/che_command_client.dart';
import 'package:chey/commands/che_command_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

final _url = Platform.environment['CHE_E2E_URL'] ?? '';
final _token = Platform.environment['CHE_E2E_TOKEN'] ?? '';
final _required = Platform.environment['CHE_E2E_REQUIRED'] == '1';

/// Lets real network IO finish (the test clock does not run it), then
/// pumps until [finder] shows up.
Future<void> waitFor(WidgetTester tester, Finder finder, {int tries = 60}) async {
  for (var i = 0; i < tries; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 150)));
    await tester.pump(const Duration(milliseconds: 50));
    if (finder.evaluate().isNotEmpty) return;
  }
  final shown = [for (final e in find.byType(Text).evaluate()) (e.widget as Text).data ?? ''].where((t) => t.isNotEmpty).join(' | ');
  expect(finder, findsWidgets, reason: 'timed out waiting; on screen: $shown');
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await tester.pumpAndSettle();
  }
}

Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(finder, 250, scrollable: find.byType(Scrollable).first);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  test('the e2e server is running when CI requires it', () {
    if (_required) expect(_url, isNotEmpty, reason: 'start tool/command_center_e2e_server.mjs first');
  });

  testWidgets('Chat hand-off, library and a workflow run, all through the real Worker', (tester) async {
    // flutter_test answers every HTTP request with 400 unless told otherwise.
    HttpOverrides.global = null;
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    final headers = {'Authorization': 'Bearer $_token'};
    // What the page hands to Chat; the test then sends it as the real chat turn.
    final handedToChat = <(String, bool)>[];
    Future<void> runInChat(String message, {bool confirmed = false}) async => handedToChat.add((message, confirmed));
    Future<List<Map<String, dynamic>>> chatTurn(String message, bool confirmed) async {
      final res = await http.post(Uri.parse('$_url/api/chat'),
          headers: {...headers, 'Content-Type': 'application/json'},
          body: jsonEncode({'message': message, 'history': [], 'command_confirmed': confirmed}));
      return [
        for (final line in const LineSplitter().convert(utf8.decode(res.bodyBytes)))
          if (line.trim().isNotEmpty) jsonDecode(line) as Map<String, dynamic>,
      ];
    }

    await tester.pumpWidget(MaterialApp(
      theme: CheTheme.dark(),
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              child: const Text('Chat host'),
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
                builder: (_) => CheCommandCenterScreen(
                  client: CheCommandClient(baseUrl: _url, headers: () => headers),
                  store: CheCommandStore(),
                  onRunInChat: runInChat,
                ),
              )),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('Chat host'));
    await waitFor(tester, find.text('All 91'));

    // The catalog and its live status come from the Worker.
    expect(find.text('Trading 10'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, 'trade-journal');
    await tester.pumpAndSettle();
    await tester.tap(find.text('/trade-journal').first);
    await tester.pumpAndSettle();
    expect(find.text('Ready'), findsWidgets);
    await tapVisible(tester, find.text('Run /trade-journal in Chat'));
    await settle(tester);
    expect(find.text('Chat host'), findsOneWidget, reason: 'back in Chat');
    expect(handedToChat, [('/trade-journal', false)]);
    final journal = (await tester.runAsync(() => chatTurn(handedToChat.single.$1, handedToChat.single.$2)))!;
    final done = journal.firstWhere((e) => e['type'] == 'done');
    expect(done['source'], 'che_trading', reason: 'the command reached the existing trading handler');

    // A workflow built on the page runs on CHE's mission queue.
    await tester.tap(find.text('Chat host'));
    await waitFor(tester, find.text('All 91'));
    await settle(tester);
    await tester.tap(find.text('Workflows'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Build a workflow'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'Booking app plan');
    await tapVisible(tester, find.text('Add command'));
    await tester.enterText(find.byType(TextField).first, 'che-plan');
    await tester.pumpAndSettle();
    await tester.tap(find.text('/che-plan').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Step 1 input: What you want to achieve'), 'a booking app for my barbershop');
    // While CHE checks the plan a progress bar animates, so this waits in
    // real time (pumpAndSettle would run the request's timeout on fake time).
    await tester.scrollUntilVisible(find.text('Save and run'), 250, scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save and run'));
    await waitFor(tester, find.text('Run'));
    await tester.tap(find.text('Run'));
    await waitFor(tester, find.textContaining('Started "Booking app plan"'));

    // Activity shows the real run: the step finished on the job queue.
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Activity'));
    for (var i = 0; i < 20 && find.textContaining('Plan: 1. Pick the niche').evaluate().isEmpty; i++) {
      await tester.tap(find.byTooltip('Refresh from CHE'));
      await settle(tester);
    }
    expect(find.text('Booking app plan'), findsOneWidget);
    expect(find.textContaining('Plan: 1. Pick the niche'), findsOneWidget);
    expect(find.text('Completed'), findsWidgets);
    expect(find.textContaining('/trade-journal'), findsWidgets, reason: 'the chat run is in the history');
    // Let request timeouts on the test clock lapse after the page is gone.
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 30));
  }, skip: _url.isEmpty || _token.isEmpty);
}
