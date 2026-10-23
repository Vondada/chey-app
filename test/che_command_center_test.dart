// CHE Command Center widget tests. The catalog is the Worker's own
// (test/fixtures/command_catalog.json, kept in sync by
// server/cloudflare/command_center.test.mjs); HTTP is a MockClient that
// records every request, so each test checks what the phone actually sent.
import 'dart:convert';
import 'dart:io';

import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/commands/che_command_center.dart';
import 'package:chey/commands/che_command_client.dart';
import 'package:chey/commands/che_command_models.dart';
import 'package:chey/commands/che_command_store.dart';
import 'package:chey/commands/che_command_voice.dart';
import 'package:chey/commands/che_command_widgets.dart';
import 'package:chey/home/screen_command.dart';
import 'package:chey/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

final Map<String, dynamic> fixture = jsonDecode(File('test/fixtures/command_catalog.json').readAsStringSync()) as Map<String, dynamic>;
final List<Map<String, dynamic>> _fixtureCommands = (fixture['commands'] as List).cast<Map<String, dynamic>>();
final String _allLabel = 'All ${_fixtureCommands.length}';
final String _intelligenceLabel = 'Intelligence & Control ${_fixtureCommands.where((c) => c['category'] == 'intelligence').length}';

class FakeChe {
  FakeChe({this.offline = false});
  bool offline;
  /// Workflow run/control requests fail in transport (dropped connection).
  bool dropActions = false;

  /// Commands whose connectors are signed in on this test CHE.
  Set<String> ready = {};
  final requests = <http.Request>[];
  List<Map<String, dynamic>> workflows = [];
  List<Map<String, dynamic>> missions = [];
  List<Map<String, dynamic>> runs = [];
  Map<String, dynamic> describe = {'name': 'x', 'steps': [], 'issues': [], 'ok': true, 'runnable': true, 'approvals': []};

  static http.Response json(Object body, [int status = 200]) =>
      http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

  late final client = MockClient((request) async {
    requests.add(request);
    if (offline) throw const SocketException('offline');
    if (dropActions && request.url.path.startsWith('/api/commands/workflow/')) throw http.ClientException('Connection reset by peer', request.url);
    final path = request.url.path;
    Map<String, dynamic> body() => request.body.isEmpty ? {} : jsonDecode(request.body) as Map<String, dynamic>;
    if (path == '/api/commands') {
      final commands = [
        for (final c in (fixture['commands'] as List).cast<Map<String, dynamic>>())
          ready.contains(c['id']) ? {...c, 'status': 'available', 'missing': <Object>[]} : c,
      ];
      return json({...fixture, 'commands': commands, 'workflows': workflows, 'missions': missions, 'runs': runs}, 200);
    }
    if (path == '/api/commands/workflow/describe') return json(describe, 200);
    if (path == '/api/commands/workflows/save') {
      final w = {...body(), 'id': body()['id'] ?? 'wf-1', 'updated_at': '2026-10-14T00:00:00Z'};
      workflows = [w, ...workflows.where((x) => x['id'] != w['id'])];
      return json({'workflow': w, 'workflows': workflows}, 200);
    }
    if (path == '/api/commands/workflows/delete') {
      workflows = workflows.where((x) => x['id'] != body()['id']).toList();
      return json({'ok': true}, 200);
    }
    if (path == '/api/commands/workflow/run') {
      return json({'spoken': 'Started "Website clients", sir: 2 steps, 1 running now.'}, 200);
    }
    if (path == '/api/commands/workflow/control') {
      return json({'spoken': 'Website clients: 1 of 2 steps done.'}, 200);
    }
    return json({'detail': 'Not found.'}, 404);
  });

  List<Map<String, dynamic>> posted(String path) => [
        for (final r in requests)
          if (r.method == 'POST' && r.url.path == path) jsonDecode(r.body) as Map<String, dynamic>,
      ];
}

/// Scrolls the page's main list until [finder] is on screen, then taps it.
Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(finder, 250, scrollable: find.byType(Scrollable).first);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

class Ran {
  final calls = <(String, bool)>[];
}

Future<void> openCenter(
  WidgetTester tester, {
  required FakeChe che,
  CheCommandStore? store,
  Ran? ran,
  List<String>? spoken,
  double textScale = 1,
  String initialSearch = '',
  Duration statesMaxAge = const Duration(seconds: 60),
}) async {
  tester.view.physicalSize = const Size(1170, 4200);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final s = store ?? CheCommandStore();
  await tester.pumpWidget(MaterialApp(
    theme: CheTheme.dark(),
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
      child: child!,
    ),
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: TextButton(
            child: const Text('Chat host'),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => CheCommandCenterScreen(
                client: CheCommandClient(baseUrl: 'https://che.test', headers: () => const {}, client: che.client),
                store: s,
                initialSearch: initialSearch,
                statesMaxAge: statesMaxAge,
                onSpeak: spoken?.add,
                onRunInChat: (message, {bool confirmed = false}) async => ran?.calls.add((message, confirmed)),
              ),
            )),
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('Chat host'));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('the fixture is the whole catalog: 119 commands in 9 categories', () {
    final catalog = CheCommandCatalog.fromJson(fixture);
    expect(catalog.commands.length, 119);
    expect(catalog.categories.length, 9);
    expect(catalog.commands.map((c) => c.id).toSet().length, 119);
    expect(catalog.byId('/trade-chart')?.title, isNotEmpty);
    expect(catalog.search('find website clients').take(3).map((c) => c.id), contains('lead-scout'));
    expect(catalog.search('how much should I charge').take(3).map((c) => c.id), contains('pricing'));
    expect(catalog.search('yt-seo').first.id, 'yt-seo');
  });

  testWidgets('library: all 9 categories with counts, filter, search and live status', (tester) async {
    final che = FakeChe();
    await openCenter(tester, che: che);
    expect(find.text('Commands'), findsOneWidget);
    expect(find.text('All 119'), findsOneWidget);
    for (final label in [_intelligenceLabel, 'YouTube 11', 'Trading 24', 'Websites, Apps & AI 20', 'Money Management 8',
      'Client Scouting & Delivery 9', 'Marketing & Sales 7', 'Office & Automation 11', 'Creator Studio 8']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    await tester.ensureVisible(find.text('Trading 24'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Trading 24'));
    await tester.pumpAndSettle();
    final library = find.descendant(of: find.byKey(const ValueKey('command-library')), matching: find.byType(Scrollable)).first;
    for (final id in ['trade-open', 'trade-chart', 'trade-setup', 'trade-liquidity', 'trade-risk', 'trade-backtest', 'trade-journal', 'trade-alert', 'trade-execute', 'trade-connections']) {
      await tester.scrollUntilVisible(find.text('/$id'), 200, scrollable: library);
      expect(find.text('/$id'), findsOneWidget, reason: id);
    }
    expect(find.text('/yt-ideas'), findsNothing);
    // Back to the top, where the search field and its results header are: the eleventh trading tile moved
    // trade-connections below the first screen, so the list was still scrolled down here.
    await tester.fling(library, const Offset(0, 3000), 3000);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'find website clients');
    await tester.pumpAndSettle();
    expect(find.textContaining('MATCHES FOR "FIND WEBSITE CLIENTS"'), findsOneWidget);
    expect(find.text('/lead-scout'), findsOneWidget);
  });

  testWidgets('a command needing setup explains what is missing and cannot run', (tester) async {
    final che = FakeChe();
    final ran = Ran();
    await openCenter(tester, che: che, ran: ran);
    await tester.enterText(find.byType(TextField).first, 'trade-execute');
    await tester.pumpAndSettle();
    await tester.tap(find.text('/trade-execute').first);
    await tester.pumpAndSettle();
    expect(find.text('Needs setup'), findsWidgets);
    expect(find.textContaining('CHE_TRADOVATE_OAUTH_CLIENT_ID'), findsOneWidget);
    expect(find.textContaining('Needs your approval first: Places a real order'), findsOneWidget);
    final run = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Needs setup: cannot run yet'));
    expect(run.onPressed, isNull);
    expect(ran.calls, isEmpty);
  });

  testWidgets('running a command asks for its input and hands it to Chat', (tester) async {
    final che = FakeChe();
    final ran = Ran();
    final store = CheCommandStore();
    await openCenter(tester, che: che, ran: ran, store: store);
    await tester.enterText(find.byType(TextField).first, 'trade-chart');
    await tester.pumpAndSettle();
    await tester.tap(find.text('/trade-chart').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('Analyzes trend, swing highs and lows'), findsOneWidget);
    expect(find.text('“Analyze the NQ chart”'), findsOneWidget);
    await tester.tap(find.text('Run /trade-chart in Chat'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'NQ');
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(ran.calls, [('/trade-chart NQ', false)]);
    expect(find.text('Chat host'), findsOneWidget, reason: 'back in Chat');
    expect(store.recents.first, 'trade-chart');
  });

  testWidgets('an approval command runs only after the owner approves it', (tester) async {
    final che = FakeChe()..ready = {'trade-execute'};
    final ran = Ran();
    await openCenter(tester, che: che, ran: ran);
    await tester.enterText(find.byType(TextField).first, 'trade-execute');
    await tester.pumpAndSettle();
    await tester.tap(find.text('/trade-execute').first);
    await tester.pumpAndSettle();
    await tapVisible(tester, find.text('Run /trade-execute in Chat'));
    expect(find.text('Approve /trade-execute?'), findsOneWidget);
    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    expect(ran.calls, isEmpty);
    await tester.tap(find.text('Run /trade-execute in Chat'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Approve and run'));
    await tester.pumpAndSettle();
    expect(ran.calls, [('/trade-execute', true)]);
  });

  testWidgets('publishing a site is the owner\'s explicit request: it runs without an extra approval', (tester) async {
    final che = FakeChe();
    final ran = Ran();
    await openCenter(tester, che: che, ran: ran);
    await tester.enterText(find.byType(TextField).first, 'site-publish');
    await tester.pumpAndSettle();
    await tester.tap(find.text('/site-publish').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('Needs your approval'), findsNothing);
    await tapVisible(tester, find.text('Run /site-publish in Chat'));
    expect(ran.calls, [('/site-publish', false)]);
  });

  testWidgets('favorites and recents survive a restart', (tester) async {
    final che = FakeChe();
    await openCenter(tester, che: che);
    await tester.tap(find.byTooltip('Add /che to favorites'));
    await tester.pumpAndSettle();
    expect(find.text('/che added to favorites.'), findsOneWidget);
    final reloaded = CheCommandStore();
    await reloaded.load();
    expect(reloaded.favorites, ['che']);
    expect(reloaded.cachedCatalog?.commands.length, 119, reason: 'the catalog is cached for offline use');
  });

  testWidgets('offline: the cached library still opens and says it may be out of date', (tester) async {
    final online = FakeChe();
    await openCenter(tester, che: online);
    await tester.pumpWidget(const SizedBox());
    final offline = FakeChe(offline: true);
    await openCenter(tester, che: offline);
    expect(find.textContaining('Showing the last list CHE sent; statuses may be out of date'), findsOneWidget);
    expect(find.text('All 119'), findsOneWidget);
  });

  testWidgets('offline with nothing cached says so instead of showing an empty success', (tester) async {
    await openCenter(tester, che: FakeChe(offline: true));
    expect(find.textContaining('Could not reach CHE'), findsOneWidget);
    expect(find.textContaining('No commands yet'), findsOneWidget);
  });

  testWidgets('workflow builder: compose, connect in order, run together, save, check and run', (tester) async {
    final che = FakeChe();
    final spoken = <String>[];
    await openCenter(tester, che: che, spoken: spoken);
    await tester.tap(find.text('Workflows'));
    await tester.pumpAndSettle();
    expect(find.text('TEMPLATES'), findsOneWidget);
    await tester.tap(find.text('Build a workflow'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'Website clients');
    for (final query in ['lead-scout', 'pricing', 'lead-proposal']) {
      await tapVisible(tester, find.text('Add command'));
      await tester.enterText(find.byType(TextField).first, query);
      await tester.pumpAndSettle();
      await tester.tap(find.text('/$query').first);
      await tester.pumpAndSettle();
    }
    expect(find.text('Step 1 · /lead-scout'), findsOneWidget);
    expect(find.text('Uses the results of step 2.'), findsOneWidget);
    await tapVisible(tester, find.text('Run together with step 1'));
    expect(find.text('Starts first.'), findsNWidgets(2), reason: 'steps 1 and 2 now run together');
    expect(find.text('Uses the results of step 2.'), findsOneWidget, reason: 'step 3 still waits for step 2');
    // Reorder: move step 3 up.
    await tapVisible(tester, find.byTooltip('Move step 3 up'));
    expect(find.text('Step 2 · /lead-proposal'), findsOneWidget);
    await tapVisible(tester, find.text('Save'));
    final saved = che.posted('/api/commands/workflows/save').single;
    expect(saved['name'], 'Website clients');
    expect([for (final s in saved['steps'] as List) s['command']], ['lead-scout', 'lead-proposal', 'pricing']);
    expect(find.textContaining('Saved "Website clients" with 3 steps'), findsOneWidget);
    expect(spoken.last, contains('Saved "Website clients"'));
    // Check: CHE's validation issues are shown, nothing runs.
    che.describe = {'name': 'Website clients', 'steps': [], 'issues': ['Step 1 (/lead-scout) needs: Who to look for.'], 'ok': false, 'runnable': false, 'approvals': []};
    await tapVisible(tester, find.text('Save and run'));
    expect(find.textContaining('I did not start it: Step 1 (/lead-scout) needs: Who to look for.'), findsOneWidget);
    expect(che.posted('/api/commands/workflow/run'), isEmpty);
    che.describe = {'name': 'Website clients', 'steps': [], 'issues': [], 'ok': true, 'runnable': true, 'approvals': []};
    await tapVisible(tester, find.text('Save and run'));
    await tester.tap(find.text('Run'));
    await tester.pumpAndSettle();
    expect(che.posted('/api/commands/workflow/run'), hasLength(1));
    expect(find.textContaining('Started "Website clients"'), findsOneWidget);
  });

  testWidgets('activity: real run states, approve, retry, pause and cancel with confirmation', (tester) async {
    final che = FakeChe()
      ..missions = [
        {
          'id': 'm1', 'name': 'Ship site', 'status': 'awaiting_approval', 'paused': false, 'spoken': 'Ship site: 1 of 3 steps done.',
          'steps': [
            {'id': 's1', 'command': 'site-audit', 'title': '/site-audit my site', 'status': 'complete', 'depends_on': [], 'output': 'Add alt text.', 'evidence': [], 'verified_by': 'model'},
            {'id': 's2', 'command': 'yt-publish', 'title': '/yt-publish', 'status': 'awaiting_approval', 'depends_on': ['s1'], 'needs_approval': true, 'evidence': []},
            {'id': 's3', 'command': 'trade-open', 'title': '/trade-open NQ', 'status': 'failed', 'depends_on': [], 'evidence': ['job x failed: The free data source did not answer.'], 'recovery': 'exhausted'},
          ],
        },
      ]
      ..runs = [
        {'command': 'trade-chart', 'input': 'NQ', 'status': 'failed', 'source': 'che_trading', 'reply': 'The free data source did not answer.'},
      ];
    final spoken = <String>[];
    await openCenter(tester, che: che, spoken: spoken);
    await tester.tap(find.text('Activity'));
    await tester.pumpAndSettle();
    expect(find.text('Needs your approval'), findsWidgets);
    expect(find.text('Add alt text.'), findsOneWidget);
    expect(find.textContaining('free data source did not answer'), findsWidgets);
    await tester.tap(find.text('Approve step 2'));
    await tester.pumpAndSettle();
    expect(che.posted('/api/commands/workflow/control').last, {'id': 'm1', 'action': 'approve', 'node_id': 's2'});
    await tester.tap(find.text('Retry step 3'));
    await tester.pumpAndSettle();
    expect(che.posted('/api/commands/workflow/control').last, {'id': 'm1', 'action': 'retry', 'node_id': 's3'});
    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();
    expect(che.posted('/api/commands/workflow/control').last['action'], 'pause');
    await tester.tap(find.text('Cancel run'));
    await tester.pumpAndSettle();
    expect(find.text('Cancel "Ship site"?'), findsOneWidget);
    await tester.tap(find.text('Keep running'));
    await tester.pumpAndSettle();
    expect(che.posted('/api/commands/workflow/control').where((b) => b['action'] == 'cancel'), isEmpty);
    expect(spoken, isNotEmpty, reason: 'owner actions report their real result aloud');
  });

  testWidgets('a dropped connection is reported and leaves the controls usable', (tester) async {
    final che = FakeChe()
      ..missions = [
        {
          'id': 'm1', 'name': 'Ship site', 'status': 'running', 'paused': false, 'spoken': 'Ship site: 0 of 1 steps done.',
          'steps': [
            {'id': 's1', 'command': 'site-audit', 'title': '/site-audit my site', 'status': 'running', 'depends_on': [], 'evidence': []},
          ],
        },
      ]
      ..dropActions = true;
    final spoken = <String>[];
    await openCenter(tester, che: che, spoken: spoken);
    await tester.tap(find.text('Activity'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();
    expect(find.textContaining('CHE did not pause it: the connection failed (Connection reset by peer)'), findsWidgets);
    expect(spoken.last, contains('the connection failed'), reason: 'the failure is spoken, not swallowed');
    // Not stuck busy: the same control works again.
    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();
    expect(che.posted('/api/commands/workflow/control').length, 2);
  });

  testWidgets('deleting a saved workflow asks first', (tester) async {
    final che = FakeChe()
      ..workflows = [
        {'id': 'wf-1', 'name': 'Website clients', 'steps': [{'command': 'lead-scout', 'input': 'barbers'}]},
      ];
    await openCenter(tester, che: che);
    await tester.tap(find.text('Workflows'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Keep it'));
    await tester.pumpAndSettle();
    expect(che.posted('/api/commands/workflows/delete'), isEmpty);
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete').last);
    await tester.pumpAndSettle();
    expect(che.posted('/api/commands/workflows/delete'), [{'id': 'wf-1'}]);
  });

  testWidgets('no automatic speech: opening, browsing and searching stay silent; Read This speaks', (tester) async {
    final spoken = <String>[];
    await openCenter(tester, che: FakeChe(), spoken: spoken);
    await tester.ensureVisible(find.text('Trading 24'));
    await tester.tap(find.text('Trading 24'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Workflows'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Activity'));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty);
    await tester.tap(find.byTooltip('Read this page aloud'));
    await tester.pumpAndSettle();
    expect(spoken.single, startsWith('Commands. 119 commands in 9 categories.'));
  });

  testWidgets('VoiceOver labels and large Dynamic Type', (tester) async {
    final handle = tester.ensureSemantics();
    await openCenter(tester, che: FakeChe(), textScale: 2.0);
    expect(tester.takeException(), isNull);
    expect(find.bySemanticsLabel(RegExp(r'^/trade chart\. Analyze NQ/MNQ market structure\. (Ready|Needs setup)')), findsNothing,
        reason: 'not on screen until scrolled');
    await tester.ensureVisible(find.text('Trading 24'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Trading 24'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.bySemanticsLabel(RegExp(r'^/trade chart\. Analyze NQ/MNQ market structure\. Ready\.')), findsOneWidget);
    expect(find.byTooltip('Add /trade-chart to favorites'), findsOneWidget);
    expect(find.bySemanticsLabel('Library tab, 1 of 3'), findsOneWidget);
    expect(find.byTooltip('Back to Chat'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('/trade-execute'), 300, scrollable: find.descendant(of: find.byKey(const ValueKey('command-library')), matching: find.byType(Scrollable)).first);
    expect(tester.takeException(), isNull);
    expect(find.bySemanticsLabel(RegExp(r'^/trade execute\..*Needs setup.*Needs your approval')), findsOneWidget);
    handle.dispose();
  });

  testWidgets('a suggestion card opens commands but never runs them; it can be dismissed', (tester) async {
    final card = cheSuggestionsFrom({
      'type': 'command_suggestions',
      'suggestions': [
        {'id': 'website-clients', 'label': 'Find and win website clients', 'commands': [
          {'id': 'lead-scout', 'title': 'Lead Scout', 'summary': 'Find clients.', 'approval': false, 'status': 'available'},
          {'id': 'pricing', 'title': 'Pricing', 'summary': 'Price it.', 'approval': false, 'status': 'available'},
        ]},
      ],
    }).single;
    final opened = <String>[];
    final built = <List<String>>[];
    var dismissed = 0;
    await tester.pumpWidget(MaterialApp(
      theme: CheTheme.dark(),
      home: Scaffold(
        body: CheCommandSuggestionCard(
          card: card,
          onOpenCommand: opened.add,
          onBuildWorkflow: built.add,
          onDismiss: () => dismissed++,
        ),
      ),
    ));
    expect(find.text('Find and win website clients'), findsOneWidget);
    await tester.tap(find.text('/lead-scout'));
    expect(opened, ['lead-scout']);
    await tester.tap(find.text('Build workflow'));
    expect(built.single, ['lead-scout', 'pricing']);
    await tester.tap(find.byTooltip('Dismiss this suggestion'));
    expect(dismissed, 1);
    expect(cheSuggestionsFrom({'type': 'done'}), isEmpty);
  });

  test('"open commands" is a spoken screen command; other phrases are not', () {
    for (final phrase in ['open commands', 'Show me the command center', 'CHE, open the command library', 'commands']) {
      expect(parseScreenCommand(phrase)?.op, ScreenOp.openCommands, reason: phrase);
    }
    for (final phrase in ['what commands can you run for my trading', 'open the office', 'clear the suggestions']) {
      expect(parseScreenCommand(phrase)?.op, isNot(ScreenOp.openCommands), reason: phrase);
    }
  });

  test('Chat searches the local command catalog, never the web, using spoken words', () {
    for (final phrase in ['Show me all commands', 'find all commands', 'search for all commands', 'list every command']) {
      final route = parseScreenCommand(phrase);
      expect(route?.op, ScreenOp.openCommands, reason: phrase);
    }
    for (final phrase in [
      'Search for YouTube commands',
      'CHE, search for YouTube commands',
      'Find YouTube commands',
      'Search commands for YouTube',
      'Show me YouTube commands',
      'Look up YouTube in my command library',
    ]) {
      final route = parseScreenCommand(phrase);
      expect(route?.op, ScreenOp.searchCommands, reason: phrase);
      expect(route?.text, 'youtube', reason: phrase);
    }
    // Asking CHE what commands she has is answered from her catalog, not by
    // a model (which told the owner on 2026-10-15 that it had no Commands page).
    expect(parseScreenCommand('What commands do you have for clients?')?.text, 'clients');
    for (final phrase in [
      'Search YouTube for jazz',
      'Research YouTube video strategy',
      'Find YouTube videos about cooking',
      'Search the web for YouTube commands',
      // Not CHE's commands.
      'Show me five Linux commands to list files',
      'Teach my dog five commands',
      'What are the voice commands for Siri?',
      'What does the trade chart command do?',
      // A group's bare name ("CHE, search for YouTube.") is CHE's catalog
      // (owner, 2026-10-16; che_owner_phrases_test.dart); more words are not.
      'CHE, search for YouTube videos about cats.',
    ]) {
      expect(parseScreenCommand(phrase)?.op, isNot(ScreenOp.searchCommands), reason: phrase);
    }
  });

  test('natural speech in Chat: a compound request becomes one list request for the Commands page', () {
    final video = parseScreenCommand('CHE, open your Commands page and show me five commands you can use to create, edit, and publish '
        'faceless YouTube videos. Explain which ones are ready to use and which need setup. '
        'Don\'t just describe the page—actually open it.')!;
    expect(video.op, ScreenOp.searchCommands);
    expect(video.text, 'create, edit, and publish faceless youtube videos');
    expect(video.list!.count, 5);
    expect(video.list!.readiness, isTrue);
    expect(video.list!.only, '', reason: 'both ready and setup were asked about');
    final five = parseScreenCommand('Show me five YouTube commands and tell me which are ready.')!;
    expect((five.op, five.text, five.list!.count, five.list!.readiness), (ScreenOp.searchCommands, 'youtube', 5, true));
    expect(parseScreenCommand('open your commands page')?.op, ScreenOp.openCommands);
    expect(parseScreenCommand('which YouTube commands are ready?')?.list?.only, 'ready');
    expect(parseScreenCommand('any commands for invoices?')?.text, 'invoices');
    expect(parseScreenCommand('show me your commands for YouTube')?.text, 'youtube');
    expect(parseScreenCommand('Search the web for YouTube commands'), isNull);
    expect(parseScreenCommand('What commands are there for YouTube?')?.text, 'youtube');
    expect(parseScreenCommand("Which YouTube commands aren't ready?")?.list?.only, 'setup');
    for (final phrase in [
      'Why are your commands so slow?',
      'Do your commands work offline?',
      'Give me 3 git commands for my website repo',
      'show me five commands to clean up my videos folder',
    ]) {
      expect(parseScreenCommand(phrase), isNull, reason: phrase);
    }
    final catalog = CheCommandCatalog.fromJson(fixture);
    expect(catalog.categoryNamed('YouTube')?.id, 'youtube');
    expect(catalog.categoryNamed('sales'), isNull, reason: 'an ordinary word is searched, not one category');
    expect(catalog.search('track an expense').first.id, 'expenses', reason: '"expense" meets "expenses"');
    expect(parseScreenCommand('search the command library for invoices')?.text, 'invoices');
    expect(parseScreenCommand('what commands can I use to make money')?.list?.only, '', reason: '"can I use to" is a purpose, not readiness');
    for (final phrase in ['Which YouTube video commands work in Final Cut?', 'show me the commands for my Tesla', 'I need a command to restart my router']) {
      expect(parseScreenCommand(phrase), isNull, reason: phrase);
    }
  });

  test('natural speech on the Commands page: lists, counts, follow-ups and named commands', () {
    CheCommandVoice? p(String words) => CheCommandVoice.parse(words);
    CheCommandListRequest? list(String words) => p(words)?.list;
    for (final words in [
      'Show me five YouTube commands and tell me which are ready.',
      'Show me five YouTube commands show me which ones are ready to use',
      'Chay, show me 5 you tube comands and tell me which ones are ready',
      'Can you list five YouTube commands, and which ones work right now?',
    ]) {
      final r = list(words);
      expect(r, isNotNull, reason: words);
      expect((r!.topic, r.count, r.readiness), ('youtube', 5, true), reason: words);
    }
    for (final words in ['CHE, search for YouTube.', 'search for you tube', 'look up YouTube', 'find youtube', 'Show me the YouTube commands']) {
      expect(list(words)?.topic, 'youtube', reason: words);
    }
    expect(list('list the top three trading commands')?.count, 3);
    expect(list('list the top three trading commands')?.topic, 'trading');
    expect(list('give me a couple of money commands')?.count, 2);
    expect(list('show me all the YouTube commands')?.all, isTrue);
    expect(list('which YouTube commands need setup')?.only, 'setup');
    expect(list('show me the ready YouTube commands')?.only, 'ready');
    expect(list('which command should I use to price a website')?.topic, 'price a website');
    expect(list('what commands can I use to find website clients')?.topic, 'find website clients');
    // Follow-ups about the list just read.
    expect(list('which ones are ready?')?.followUp, isTrue);
    expect(list('Which need setup?')?.only, 'setup');
    expect(list('show me more')?.more, isTrue);
    expect(list('the next three')?.count, 3);
    // Several commands said with "run" are listed, never run.
    expect(list('run the YouTube commands')?.runAsked, isTrue);
    // One command named outright still opens or runs.
    expect(p('open trade chart')?.op, CheCommandVoiceOp.open);
    expect(p('show me the trade chart command')?.text, 'trade chart');
    expect(p('tell me about YouTube ideas')?.op, CheCommandVoiceOp.open);
    expect(p('what does the yt publish command do')?.text, 'yt publish');
    expect(p('what does number three need')?.text, 'number three');
    expect(p('Run trade chart NQ')?.op, CheCommandVoiceOp.run);
    expect(p('show me YouTube')?.op, CheCommandVoiceOp.open, reason: 'the page lists a topic it cannot open');
    expect(p("what's the status of those")?.op, CheCommandVoiceOp.search, reason: 'about the list, not workflow runs');
    expect(p("what's the status")?.op, CheCommandVoiceOp.activity);
    expect(list('what about the trading commands')?.topic, 'trading');
    expect(list('and the money ones?')?.topic, 'money');
    expect(list('which one should I use to publish a video')?.topic, 'publish a video');
    expect(p('read them again')?.op, CheCommandVoiceOp.repeat);
    expect(p('what can I do here')?.op, CheCommandVoiceOp.describe);
  });

  test('voice phrases map to the page\'s actions, deterministically', () {
    CheCommandVoice? p(String words) => CheCommandVoice.parse(words);
    expect(p("What's on screen?")?.op, CheCommandVoiceOp.describe);
    expect(p('read my options')?.op, CheCommandVoiceOp.describe);
    expect(p('show workflows')?.text, 'workflows');
    expect(p('go to the activity tab')?.text, 'activity');
    expect(p('Che, find website clients')?.text, 'website clients');
    expect(p('which command should I use to price a website')?.text, 'price a website');
    expect(p('number two')?.number, 2);
    expect(p('the first one')?.number, 1);
    expect(p('Run trade chart NQ')?.op, CheCommandVoiceOp.run);
    expect(p('Run trade chart NQ')?.text, 'trade chart NQ', reason: 'the input keeps its case');
    expect(p('favorite it')?.op, CheCommandVoiceOp.favorite);
    expect(p('remove trade chart from my favorites')?.op, CheCommandVoiceOp.unfavorite);
    final built = p('build a workflow called website clients with lead scout, lead audit and then pricing')!;
    expect(built.op, CheCommandVoiceOp.buildWorkflow);
    expect(built.target, 'website clients');
    expect(built.items, ['lead scout', 'lead audit', 'pricing']);
    expect(p('new workflow')?.op, CheCommandVoiceOp.newWorkflow);
    expect(p('add pricing to my website clients workflow')?.target, 'website clients');
    expect(p('remove step 2 from website clients workflow')?.number, 2);
    expect(p('delete the website clients workflow')?.op, CheCommandVoiceOp.deleteWorkflow);
    expect(p('run my website clients workflow')?.target, 'website clients');
    expect(p('approve step 3')?.number, 3);
    expect(p('retry it')?.op, CheCommandVoiceOp.retry);
    expect(p('pause the run')?.op, CheCommandVoiceOp.pause);
    expect(p('resume ship site')?.target, 'ship site');
    expect(p('cancel the run')?.op, CheCommandVoiceOp.cancel);
    expect(p('back to chat')?.op, CheCommandVoiceOp.back);
    expect(p('yes')?.op, CheCommandVoiceOp.yes);
    expect(p('what is the weather like'), isNull, reason: 'anything else goes to Chat as usual');
    final ids = {'trade-chart', 'yt-ideas', 'create-3d', 'che-plan', 'che'};
    expect(cheMatchCommandWords('trade chart NQ', ids), (id: 'trade-chart', rest: 'NQ'));
    expect(cheMatchCommandWords('YouTube ideas for cooking', ids), (id: 'yt-ideas', rest: 'cooking'));
    expect(cheMatchCommandWords('slash chey plan my week', ids), (id: 'che-plan', rest: 'my week'));
    expect(cheMatchCommandWords('create 3 d obby', ids), (id: 'create-3d', rest: 'obby'));
    expect(cheMatchCommandWords('my errands', ids), isNull, reason: 'a command runs only when its name was said');
    expect(cheMatchCommandWords('YouTube ideas command for cooking', ids), (id: 'yt-ideas', rest: 'cooking'));
  });

  testWidgets('every page action works by voice: read options, pick, favorite, search, tabs, run and back', (tester) async {
    final che = FakeChe();
    final ran = Ran();
    final store = CheCommandStore();
    final spoken = <String>[];
    await openCenter(tester, che: che, ran: ran, store: store, spoken: spoken);
    final voice = CheCommandCenterVoice.handler!;
    Future<String?> say(String words) async {
      final reply = await voice(words);
      await tester.pumpAndSettle();
      return reply;
    }

    final screen = (await say("what's on screen"))!;
    expect(screen, contains('119 commands in 9 categories'));
    expect(screen, contains('Tabs: 1. Library, 2. Workflows, 3. Activity.'));
    final found = (await say('search for trade chart'))!;
    expect(found, contains('1. /trade-chart: '));
    expect(find.textContaining('for "trade chart"'), findsOneWidget, reason: 'the screen shows what CHE read');
    expect(await say('number one'), contains('/trade-chart'));
    expect(find.byTooltip('Read this command aloud'), findsOneWidget, reason: 'its details are open');
    expect(await say('favorite it'), '/trade-chart is in your favorites.');
    expect(store.isFavorite('trade-chart'), isTrue);
    expect(await say('back'), 'Back to Commands.');
    expect(find.byTooltip('Read this command aloud'), findsNothing);
    expect(await say('remove trade chart from favorites'), '/trade-chart is not in your favorites.');
    expect(store.isFavorite('trade-chart'), isFalse);
    expect(await say('show activity'), contains('Activity tab'));
    expect(find.text('Workflow runs'.toUpperCase()), findsOneWidget);
    expect(await say('run lead scout'), contains('/lead-scout needs who to look for'));
    expect(await say('run trade execute'), allOf(contains('Needs setup'), contains('Nothing was run')));
    expect(await say('run my errands'), contains('I don\'t have a command called "my errands"'));
    expect(ran.calls, isEmpty, reason: 'nothing ran from a refused or unknown request');
    expect(find.textContaining('Nothing was run'), findsOneWidget, reason: 'each spoken reply is also on the banner');
    expect(await say('run trade chart NQ'), '', reason: 'Chat runs it and speaks the real result');
    expect(ran.calls, [('/trade-chart NQ', false)]);
    expect(find.text('Chat host'), findsOneWidget, reason: 'back in Chat');
    expect(CheCommandCenterVoice.handler, isNull);
    expect(spoken, isEmpty, reason: 'Chat speaks voice replies once; the page never adds a second voice');
  });

  testWidgets('workflows and runs by voice: build, edit, run, approve, pause; delete and cancel ask first', (tester) async {
    final che = FakeChe()
      ..missions = [
        {
          'id': 'm1', 'name': 'Ship site', 'status': 'awaiting_approval', 'paused': false, 'spoken': 'Ship site: 1 of 2 steps done.',
          'steps': [
            {'id': 's1', 'command': 'site-audit', 'title': '/site-audit my site', 'status': 'complete', 'depends_on': [], 'evidence': []},
            {'id': 's2', 'command': 'yt-publish', 'title': '/yt-publish', 'status': 'awaiting_approval', 'depends_on': ['s1'], 'needs_approval': true, 'evidence': []},
          ],
        },
      ];
    await openCenter(tester, che: che);
    final voice = CheCommandCenterVoice.handler!;
    Future<String?> say(String words) async {
      final reply = await voice(words);
      await tester.pumpAndSettle();
      return reply;
    }

    expect(await say('build a workflow called website clients with lead scout for barbers in Phoenix, lead audit and pricing'),
        startsWith('Saved "website clients": /lead-scout barbers in Phoenix, then /lead-audit, then /pricing.'));
    expect(che.posted('/api/commands/workflows/save').last['steps'], [
      {'command': 'lead-scout', 'input': 'barbers in Phoenix', 'parallel': false},
      {'command': 'lead-audit', 'input': '', 'parallel': false},
      {'command': 'pricing', 'input': '', 'parallel': false},
    ]);
    expect(await say('add lead proposal to my website clients workflow'), contains('then /lead-proposal'));
    expect(che.posted('/api/commands/workflows/save').last['id'], 'wf-1', reason: 'an edit of the same workflow, not a copy');
    expect(await say('remove step 3 from website clients workflow'), isNot(contains('/pricing')));
    expect(await say('run website clients workflow'), contains('Started'));
    expect(che.posted('/api/commands/workflow/run').last, {'id': 'wf-1'});
    await say('approve');
    expect(che.posted('/api/commands/workflow/control').last, {'id': 'm1', 'action': 'approve', 'node_id': 's2'});
    await say('pause the run');
    expect(che.posted('/api/commands/workflow/control').last['action'], 'pause');
    expect(await say('cancel the run'), contains('Say yes to cancel it'));
    expect(che.posted('/api/commands/workflow/control').where((b) => b['action'] == 'cancel'), isEmpty);
    await say('yes');
    expect(che.posted('/api/commands/workflow/control').last['action'], 'cancel');
    expect(await say('delete website clients workflow'), contains('Say yes to delete it'));
    expect(await say('no'), 'Okay. Nothing was changed.');
    expect(che.posted('/api/commands/workflows/delete'), isEmpty);
    await say('delete website clients workflow');
    expect(await say('yes'), contains('Deleted the saved workflow "website clients"'));
    expect(che.posted('/api/commands/workflows/delete').single, {'id': 'wf-1'});
    expect(await say('yes'), isNull, reason: 'nothing pending: a yes goes on to Chat (a held command)');
  });

  testWidgets('Chat-directed YouTube command search opens filtered local results', (tester) async {
    final che = FakeChe();
    final spoken = <String>[];
    await openCenter(tester, che: che, initialSearch: 'youtube', spoken: spoken);
    final field = tester.widget<TextField>(find.byType(TextField).first);
    expect(field.controller?.text, 'youtube');
    expect(find.textContaining('MATCHES FOR "YOUTUBE"'), findsOneWidget);
    expect(find.text('/yt-ideas'), findsOneWidget);
    expect(spoken.any((line) => line.startsWith('YouTube: 11 commands. 1. /yt-ideas: ')), isTrue,
        reason: 'an explicit voice search reads numbered local results');
    expect(che.requests.every((r) => r.url.path == '/api/commands'),
        isTrue, reason: 'searching the catalog never calls web or an AI model');
  });

  testWidgets('explicit command search reports an offline catalog failure aloud', (tester) async {
    final che = FakeChe()..offline = true;
    final spoken = <String>[];
    await openCenter(tester, che: che, initialSearch: 'youtube', spoken: spoken);
    expect(spoken.any((line) => line.contains('could not search the command library for "youtube"')), isTrue,
        reason: 'voice-first owner must hear the failure, not only see quiet error text');
    expect(find.textContaining('could not search the command library'), findsOneWidget);
  });

  testWidgets('Chat → Commands → back to Chat, in the real app, with no speech on the way', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const CHEApp());
    for (var i = 0; i < 15; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    await tester.tap(find.text('Chat'));
    await tester.pump(const Duration(milliseconds: 500));
    final handle = tester.ensureSemantics();
    expect(find.bySemanticsLabel(RegExp(r"^Commands\. Open CHE's command library")), findsOneWidget);
    expect(find.text('What can I help with?'), findsOneWidget, reason: 'the normal Chat stays as it was');
    await tester.tap(find.text('Commands'));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 150));
    }
    expect(find.text('Library'), findsOneWidget);
    // This test phone is not paired, so CHE says so instead of showing an empty list.
    expect(find.textContaining('Could not reach CHE'), findsOneWidget);
    expect(tester.takeException(), isNull);
    // While the page is open, Chat's voice pipeline offers it the owner's
    // words first, and its mic button is CHE's own microphone.
    expect(CheCommandCenterVoice.handler, isNotNull);
    expect(find.byTooltip('Speak to CHE'), findsOneWidget);
    expect(await CheCommandCenterVoice.handler!('search for website clients'), startsWith('Could not reach CHE'),
        reason: 'unpaired: the spoken search says why instead of an empty success');
    await tester.tap(find.byTooltip('Back to Chat'));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 150));
    }
    expect(find.text('What can I help with?'), findsOneWidget);
    expect(CheCommandCenterVoice.handler, isNull, reason: 'closed pages answer no voice routes');
    handle.dispose();
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });
}
