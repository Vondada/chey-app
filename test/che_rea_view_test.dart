// REA investigation pages: list, detail and actions, through a MockClient
// that records every request and a fake chat turn that records every
// command. Opening the pages never speaks; Read this does; direct Build starts a draft job.
import 'dart:convert';
import 'dart:io';

import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/commands/che_command_center.dart';
import 'package:chey/commands/che_command_client.dart';
import 'package:chey/commands/che_command_store.dart';
import 'package:chey/commands/che_command_voice.dart';
import 'package:chey/commands/che_rea_models.dart';
import 'package:chey/commands/che_rea_view.dart';
import 'package:chey/commands/che_rea_voice.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

final Map<String, dynamic> reaFixture = jsonDecode(File('test/fixtures/rea_investigations.json').readAsStringSync()) as Map<String, dynamic>;
final Map<String, dynamic> catalogFixture = jsonDecode(File('test/fixtures/command_catalog.json').readAsStringSync()) as Map<String, dynamic>;

Map<String, dynamic> record(int i) => Map<String, dynamic>.from((reaFixture['investigations'] as List)[i] as Map);

class FakeRea {
  final requests = <http.Request>[];

  /// Replaces record 0 as the Worker serves it (list and detail).
  Map<String, dynamic>? first;

  static http.Response json(Object body, [int status = 200]) =>
      http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

  List<Map<String, dynamic>> get _records => [first ?? record(0), record(1)];

  late final client = MockClient((request) async {
    requests.add(request);
    final path = request.url.path;
    if (path == '/api/commands') return json(catalogFixture);
    if (path == '/api/rea/investigations') return json({...reaFixture, 'investigations': _records});
    for (final r in _records) {
      if (path == '/api/rea/investigations/${r['id']}') return json({'investigation': r});
    }
    return json({'detail': 'Not found.'}, 404);
  });

  CheCommandClient get che => CheCommandClient(baseUrl: 'https://che.test', headers: () => const {'Authorization': 'Bearer paired'}, client: client);

  /// Only the Worker's REA reads: never a route of the page's own for actions.
  Iterable<String> get paths => requests.map((r) => '${r.method} ${r.url.path}');
}

/// The chat turn: records each command; answers with [reply] unless busy.
class FakeChat {
  final sent = <(String, bool)>[];
  String reply = 'Mapped 3 features of Example Notes, sir.';
  bool busy = false;

  Future<({bool sent, String reply})> send(String message, {bool confirmed = false}) async {
    if (busy) return (sent: false, reply: '');
    sent.add((message, confirmed));
    return (sent: true, reply: reply);
  }
}

void tall(WidgetTester tester, {double height = 36000}) {
  tester.view.physicalSize = Size(1170, height);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Widget host(Widget Function() page, {double textScale = 1}) => MaterialApp(
      theme: CheTheme.dark(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              child: const Text('Commands host'),
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page())),
            ),
          ),
        ),
      ),
    );

Future<void> openList(WidgetTester tester, {required FakeRea rea, required FakeChat chat, List<String>? spoken}) async {
  tall(tester, height: 8000);
  await tester.pumpWidget(host(() => CheReaInvestigationsScreen(client: rea.che, send: chat.send, onSpeak: spoken?.add)));
  await tester.tap(find.text('Commands host'));
  await tester.pumpAndSettle();
}

Future<void> openDetail(WidgetTester tester, {required FakeRea rea, required FakeChat chat, List<String>? spoken, int index = 0, double textScale = 1}) async {
  tall(tester);
  final inv = CheReaInvestigation.fromJson(index == 0 ? (rea.first ?? record(0)) : record(index));
  await tester.pumpWidget(host(() => CheReaInvestigationScreen(client: rea.che, investigation: inv, send: chat.send, onSpeak: spoken?.add), textScale: textScale));
  await tester.tap(find.text('Commands host'));
  await tester.pumpAndSettle();
}

Finder pageButton(String label) => find.ancestor(of: find.text(label), matching: find.byWidgetPredicate((w) => w is ButtonStyleButton));

Future<void> press(WidgetTester tester, String label) async {
  await tester.ensureVisible(pageButton(label).first);
  await tester.pumpAndSettle();
  await tester.tap(pageButton(label).first);
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('list: each investigation with its kind, state and stage; opening it is silent', (tester) async {
    final handle = tester.ensureSemantics();
    final rea = FakeRea();
    final chat = FakeChat();
    final spoken = <String>[];
    await openList(tester, rea: rea, chat: chat, spoken: spoken);
    expect(find.bySemanticsLabel('Example Notes, website. Running. Stage 5 of 13, Architecture.'), findsOneWidget);
    expect(find.bySemanticsLabel('semver, npm package. Complete. Stage 13 of 13, Remember.'), findsOneWidget);
    expect(find.text('App Store apps: not available; needs an App Store link.'), findsOneWidget);
    expect(find.byTooltip('Read this list aloud'), findsOneWidget);
    expect(find.byTooltip('Refresh investigations'), findsOneWidget);
    expect(find.byTooltip('Back to Commands'), findsOneWidget);
    expect(tester.getSemantics(find.text('Investigations').last), isSemantics(isHeader: true));

    await tester.tap(find.text('Example Notes'));
    await tester.pumpAndSettle();
    expect(find.text('Stage progress'), findsOneWidget);
    expect(spoken, isEmpty, reason: 'opening the list and an investigation never speaks');
    expect(chat.sent, isEmpty);
    expect(rea.paths, ['GET /api/rea/investigations', 'GET /api/rea/investigations/rea-1a2b3c4d']);

    await tester.tap(find.byTooltip('Back to investigations'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Read this list aloud'));
    await tester.pumpAndSettle();
    expect(spoken.single, startsWith('Investigations. 2 investigations, newest first. 1. Example Notes, website: Running, Stage 5 of 13, Architecture.'));
    expect(find.text(spoken.single), findsOneWidget, reason: 'the exact spoken list must also be visible for deaf owners');
    handle.dispose();
  });

  testWidgets('detail: every section in order, as headings; stages read as "Stage 4 of 13"; no fake screenshots', (tester) async {
    final handle = tester.ensureSemantics();
    final rea = FakeRea();
    final chat = FakeChat();
    final spoken = <String>[];
    await openDetail(tester, rea: rea, chat: chat, spoken: spoken);
    expect(spoken, isEmpty, reason: 'the page is silent when it opens and loads');
    expect(tester.takeException(), isNull);

    const sections = ['Target', 'Stage progress', 'Sources', 'Screenshots', 'Feature map (3)', 'Architecture findings', 'Comparison with CHE',
      'Proposals', 'Plan', 'Build', 'Verification', 'Limitations'];
    var lastY = double.negativeInfinity;
    for (final s in sections) {
      final heading = find.byWidgetPredicate((w) => w is Text && w.data == s && w.style?.fontSize == 21);
      expect(heading, findsOneWidget, reason: s);
      expect(tester.getSemantics(heading), isSemantics(isHeader: true, label: s), reason: s);
      final y = tester.getTopLeft(heading).dy;
      expect(y, greaterThan(lastY), reason: '$s comes after the section before it');
      lastY = y;
    }
    for (final group in ['Observed', 'Inferred', 'Unknown']) {
      expect(tester.getSemantics(find.text(group)), isSemantics(isHeader: true), reason: group);
    }

    expect(find.bySemanticsLabel('Stage 4 of 13, Map behavior: done'), findsOneWidget);
    expect(find.bySemanticsLabel('Stage 5 of 13, Architecture: running. Current stage'), findsOneWidget);
    expect(find.bySemanticsLabel('Stage 3 of 13, Inspect: done. Public page observed in an isolated browser.'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Stage \d+ of 13, [^.:]+: ')), findsNWidgets(13), reason: 'all 13 stages, each with its state');

    expect(find.text('No screenshots were captured.'), findsOneWidget);
    expect(find.byType(Image), findsNothing, reason: 'no placeholder pretends to be a preview');

    // Target, feature cards (with CHE status and evidence), findings, plan.
    expect(find.text('https://notes.example.com/'), findsWidgets);
    expect(find.textContaining('sha256:9f2c41d0'), findsWidgets);
    expect(find.text('1. Quick search'), findsOneWidget);
    expect(find.text('CHE partly has it'), findsWidgets);
    expect(find.text('CHE status: CHE is missing it'), findsOneWidget);
    expect(find.text('CHE searches memories, not notes'), findsOneWidget);
    expect(find.text('• Whether search covers attachments.'), findsOneWidget);
    expect(find.text('Client-side search index'), findsOneWidget);
    expect(find.text('1. Add a note search to CHE\'s memory screen.'), findsOneWidget);
    expect(find.text('• Notes open with the iPhone offline.'), findsOneWidget);
    expect(find.text('No build started.'), findsOneWidget);
    expect(find.text('Not verified yet.'), findsOneWidget);

    for (final label in ['Read this', 'Map features', 'Compare with CHE', 'Plan selected: 2 features', 'Build', 'Verify', 'Refresh']) {
      expect(tester.getSemantics(pageButton(label).first), isSemantics(isButton: true, label: label), reason: label);
    }
    expect(find.bySemanticsLabel('Choose "Offline notes" for the plan'), findsOneWidget);
    expect(find.byTooltip('Back to investigations'), findsOneWidget);
    expect(spoken, isEmpty);
    handle.dispose();
  });

  testWidgets('screenshots: only the captured ones, loaded from CHE with the paired headers', (tester) async {
    final handle = tester.ensureSemantics();
    await openDetail(tester, rea: FakeRea(), chat: FakeChat(), index: 1);
    expect(find.text('No screenshots were captured.'), findsNothing);
    final image = tester.widget<Image>(find.byType(Image));
    final provider = image.image as NetworkImage;
    expect(provider.url, 'https://che.test/api/rea/files/rea-5e6f7a8b/desktop.jpg');
    expect(provider.headers, {'Authorization': 'Bearer paired'});
    expect(image.semanticLabel, 'Screenshot 1 of 1, desktop, captured by CHE');
    expect(find.text('Draft pull request: #412'), findsOneWidget);
    expect(find.text('Coding job: job-77'), findsOneWidget);
    expect(find.text('https://github.com/Vondada/chey-app/pull/412'), findsOneWidget);
    expect(find.text('flutter test: passed'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('Build starts exactly one draft-PR job without a second confirmation', (tester) async {
    final handle = tester.ensureSemantics();
    final rea = FakeRea();
    final chat = FakeChat()..reply = 'Started coding job job-81 for 2 features. It opens a draft pull request; nothing merges.';
    final spoken = <String>[];
    await openDetail(tester, rea: rea, chat: chat, spoken: spoken);

    await press(tester, 'Build');
    expect(chat.sent, [('/rea-build rea-1a2b3c4d', true)], reason: 'the direct Build press authorizes a draft job');
    final reply = find.byWidgetPredicate((w) => w is SelectableText && w.data == chat.reply);
    expect(reply, findsOneWidget, reason: "CHE's actual reply is on screen");
    expect(tester.widget<SelectableText>(reply).style!.fontSize, greaterThanOrEqualTo(20));
    expect(spoken, isEmpty, reason: 'Chat speaks the reply; the page adds no second voice');
    expect(rea.paths.where((p) => !p.startsWith('GET /api/rea/')), isEmpty, reason: 'actions go through Chat');
    handle.dispose();
  });

  testWidgets('Map features, Compare, Plan selected with chosen features, Verify: the exact chat commands', (tester) async {
    final rea = FakeRea();
    final chat = FakeChat();
    await openDetail(tester, rea: rea, chat: chat);
    await press(tester, 'Map features');
    expect(find.text(chat.reply), findsOneWidget);
    await press(tester, 'Compare with CHE');
    await press(tester, 'Verify');
    // The plan starts from CHE's plan (f1, f2); the owner swaps f2 for f3.
    await tester.ensureVisible(find.text('Choose "Offline notes" for the plan'));
    await tester.tap(find.text('Choose "Offline notes" for the plan'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Choose "Share link" for the plan'));
    await tester.tap(find.text('Choose "Share link" for the plan'));
    await tester.pumpAndSettle();
    await press(tester, 'Plan selected: 2 features');
    expect(chat.sent, [
      ('/rea-features rea-1a2b3c4d', false),
      ('/rea-compare rea-1a2b3c4d', false),
      ('/rea-verify rea-1a2b3c4d', false),
      ('/rea-rebuild rea-1a2b3c4d f1 f3', false),
    ]);
  });

  testWidgets('nothing to plan or build, and a busy Chat, are said plainly and send nothing', (tester) async {
    final rea = FakeRea()..first = {...record(0), 'plan': null};
    final chat = FakeChat();
    final spoken = <String>[];
    await openDetail(tester, rea: rea, chat: chat, spoken: spoken);
    await press(tester, 'Build');
    expect(find.textContaining('There is no plan to build yet'), findsOneWidget);
    await press(tester, 'Plan selected');
    expect(find.text('Choose at least one feature in the feature map first. Nothing was sent.'), findsOneWidget);
    chat.busy = true;
    await press(tester, 'Verify');
    expect(find.textContaining('CHE is still answering another message in Chat, so "/rea-verify rea-1a2b3c4d" was not sent.'), findsOneWidget);
    expect(chat.sent, isEmpty);
    expect(spoken.length, 3, reason: 'each result of the owner\'s own action is spoken');
  });

  testWidgets('Read this reads a concise summary and shows it; it is never disabled', (tester) async {
    final spoken = <String>[];
    final chat = FakeChat();
    await openDetail(tester, rea: FakeRea(), chat: chat, spoken: spoken);
    await press(tester, 'Read this');
    final summary = cheReaSummary(CheReaInvestigation.fromJson(record(0)));
    expect(spoken, [summary]);
    expect(summary, contains('Example Notes, website'));
    expect(summary, contains('Running. Stage 5 of 13, Architecture. 3 features mapped.'));
    expect(summary, contains('she has 1, partly has 1, is missing 1'));
    expect(summary, contains('Plan: 2 features'));
    expect(summary, contains('No build started. Not verified yet.'));
    expect(find.text(summary), findsOneWidget, reason: 'what CHE says is shown as text');
    final read = tester.widget<ButtonStyleButton>(pageButton('Read this').first);
    expect(read.onPressed, isNotNull);
  });

  testWidgets('voice: describe, choose features, plan, and build directly without a second yes', (tester) async {
    final chat = FakeChat();
    final spoken = <String>[];
    await openDetail(tester, rea: FakeRea(), chat: chat, spoken: spoken);
    final say = CheReaVoice.handler!;
    expect(await say("what's on my screen"), allOf(startsWith('Example Notes, website'), contains('Options: 1. Map features, 2. Compare with CHE')));
    expect(await say('read the features'), contains('2. Offline notes: CHE is missing it, high complexity, chosen for the plan.'));
    expect(await say('search for youtube'), isNull, reason: 'not for this page: the Command Center answers it');

    expect(await say('build it'), '');
    await tester.pumpAndSettle();
    expect(chat.sent, [('/rea-build rea-1a2b3c4d', true)]);
    expect(await say('yes'), isNull, reason: 'there is no pending approval dialog');

    expect(await say('plan features one and three'), '');
    await tester.pumpAndSettle();
    expect(await say('build'), '');
    await tester.pumpAndSettle();
    expect(chat.sent, [
      ('/rea-build rea-1a2b3c4d', true),
      ('/rea-rebuild rea-1a2b3c4d f1 f3', false),
      ('/rea-build rea-1a2b3c4d', true),
    ]);
    expect(find.text(chat.reply), findsOneWidget);
    expect(spoken, isEmpty, reason: 'Chat speaks responses once');

    await press(tester, 'Build');
    expect(chat.sent.last, ('/rea-build rea-1a2b3c4d', true));
    expect(chat.sent.length, 4);
  });

  testWidgets('large Dynamic Type: the detail lays out without overflow', (tester) async {
    await openDetail(tester, rea: FakeRea(), chat: FakeChat(), textScale: 2.0);
    expect(tester.takeException(), isNull);
    expect(find.text('No screenshots were captured.'), findsOneWidget);
  });

  testWidgets('Commands → Activity → Open investigations, silently; actions hand off to Chat; voice opens it too', (tester) async {
    tall(tester, height: 8000);
    final rea = FakeRea();
    final ran = <(String, bool)>[];
    final spoken = <String>[];
    await tester.pumpWidget(host(() => CheCommandCenterScreen(
          client: rea.che,
          store: CheCommandStore(),
          onSpeak: spoken.add,
          onRunInChat: (message, {bool confirmed = false}) async => ran.add((message, confirmed)),
        )));
    await tester.tap(find.text('Commands host'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Activity'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open investigations'));
    await tester.pumpAndSettle();
    expect(find.text('Example Notes'), findsOneWidget);
    expect(CheReaVoice.handler, isNotNull);

    // The Command Center offers the owner's words to the page in front first.
    expect(await CheCommandCenterVoice.handler!('number 1'), startsWith('Opened Example Notes.'));
    await tester.pumpAndSettle();
    expect(find.text('Stage progress'), findsOneWidget);
    await press(tester, 'Map features');
    expect(ran, [('/rea-features rea-1a2b3c4d', false)], reason: 'the same chat turn as the Run button');
    expect(find.text('Sent "/rea-features rea-1a2b3c4d" to CHE. Her answer is in Chat.'), findsOneWidget);
    expect(spoken, isEmpty);
    expect(await CheCommandCenterVoice.handler!('go back'), 'Back to investigations.');
    await tester.pumpAndSettle();
    expect(await CheCommandCenterVoice.handler!('back'), 'Back to Commands.');
    await tester.pumpAndSettle();
    expect(CheReaVoice.handler, isNull, reason: 'closed pages answer no voice routes');

    expect(await CheCommandCenterVoice.handler!('open investigations'), contains('REA investigations are open'));
    await tester.pumpAndSettle();
    expect(find.text('semver'), findsOneWidget);
    expect(rea.paths.where((p) => !p.startsWith('GET /api/rea/') && p != 'GET /api/commands'), isEmpty);
    await tester.tap(find.byTooltip('Back to Commands'));
    await tester.pumpAndSettle();

    // A REA command's details link to the investigations.
    await tester.tap(find.text('Library'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'rea-status');
    await tester.pumpAndSettle();
    await tester.tap(find.text('/rea-status').first);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Open REA investigations'));
    await tester.tap(find.text('Open REA investigations'));
    await tester.pumpAndSettle();
    expect(find.text('Example Notes'), findsOneWidget);
    expect(spoken, isEmpty, reason: 'navigating to and through REA pages never speaks');
  });
}
