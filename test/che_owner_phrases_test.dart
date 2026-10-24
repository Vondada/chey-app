// The owner's six spoken phrases (iPhone, 2026-10-16), exactly as said and
// as speech recognition writes them (no punctuation, lower case, "Chay",
// "Chey", "Hey CHE", "Che."), through the real routes: the Commands page's
// voice handler (what Chat's send pipeline offers the words to first while
// it is open), Chat's own parsers and send pipeline, and the screen reports
// that answer "What is on my screen?" from real navigation state.
import 'dart:convert';

import 'package:chey/che_immersive_hub_shell.dart';
import 'package:chey/che_ui/che_screen_awareness.dart';
import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/commands/che_command_voice.dart';
import 'package:chey/home/che_connections_screen.dart';
import 'package:chey/home/screen_command.dart';
import 'package:chey/main.dart';
import 'package:chey/platform/che_platform_screens.dart';
import 'package:chey/rooms/che_creator_studio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'che_command_center_test.dart' as center;

/// Each phrase as said, and as speech recognition may write it.
List<String> spoken(String phrase) {
  final bare = phrase.replaceFirst(RegExp(r'^CHE,\s*'), '');
  final plain = bare.replaceAll(RegExp(r'[.,?!]'), '');
  return [phrase, plain, plain.toLowerCase(), 'Chay $plain', 'Chey, $bare', 'Hey CHE $plain', 'hey che, ${plain.toLowerCase()}.', 'Che. $bare'];
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('the six phrases on the Commands page reach the right routes, in order and in every spelling', (tester) async {
    final che = center.FakeChe();
    final ran = center.Ran();
    await center.openCenter(tester, che: che, ran: ran);
    final voice = CheCommandCenterVoice.handler!;
    Future<String> say(String words) async {
      final reply = await voice(words);
      await tester.pumpAndSettle();
      expect(reply, isNotNull, reason: '"$words" was not answered by the page, so it would have gone to a model');
      return reply!;
    }

    for (final words in spoken('CHE, open your Commands page.')) {
      // It was a search for "your commands page" (four website commands).
      final reply = await say(words);
      expect(reply, contains('The Library tab is open.'), reason: words);
      expect(reply, isNot(contains('matches for')), reason: words);
    }
    for (final words in spoken('CHE, search for YouTube.')) {
      expect(await say(words), startsWith('YouTube: 11 commands. 1. /yt-ideas: '), reason: words);
    }
    for (final words in spoken('Show me five YouTube commands and tell me which are ready.')) {
      final reply = await say(words);
      expect(reply, contains('4. /yt-video: Generate and assemble videos. Needs setup: Video renderer.'), reason: words);
      expect(reply, contains('Of these 5: 3 ready, 2 need setup.'), reason: words);
    }
    for (final words in spoken('Show me number four.')) {
      expect(await say(words), startsWith('/yt-video. Generate and assemble videos.'), reason: words);
      await say('back');
    }
    for (final words in spoken('Run the video command.')) {
      // It was 'I don't have a command called "video"'.
      final reply = await say(words);
      expect(reply, startsWith('/yt-video: Needs setup. Missing: Video renderer.'), reason: words);
      expect(reply, endsWith('Nothing was run.'), reason: words);
    }
    for (final words in spoken('What is on my screen?')) {
      // It went on to Chat and a model.
      expect(await say(words), startsWith('Commands, Library tab, 11 matches for "youtube".'), reason: words);
    }
    expect(ran.calls, isEmpty, reason: 'nothing was run: /yt-video needs its renderer');
    expect(che.requests.where((r) => r.method != 'GET'), isEmpty);
  });

  testWidgets('"Run the video command" reaches /yt-video once it is ready, and asks for its topic first', (tester) async {
    final che = center.FakeChe()..ready = {'yt-video'};
    final ran = center.Ran();
    await center.openCenter(tester, che: che, ran: ran);
    final voice = CheCommandCenterVoice.handler!;
    expect(await voice('Run the video command.'), startsWith('/yt-video needs video topic.'));
    expect(ran.calls, isEmpty, reason: 'never claimed or run without its input');
    expect(await voice('run the video command about Mars'), '', reason: 'Chat runs it and speaks the real result');
    await tester.pumpAndSettle();
    expect(ran.calls, [('/yt-video Mars', false)]);
  });

  test('command names: a name part only one command has names it; a shared one names none', () {
    final ids = {for (final c in (center.fixture['commands'] as List).cast<Map<String, dynamic>>()) c['id'] as String};
    expect(cheMatchCommandWords('video', ids), (id: 'yt-video', rest: ''));
    expect(cheMatchCommandWords('chart NQ', ids), (id: 'trade-chart', rest: 'NQ'));
    expect(cheMatchCommandWords('publish', ids), isNull, reason: '/yt-publish and /site-publish');
    expect(cheMatchCommandWords('status', ids), isNull);
    expect(cheMatchCommandWords('errands', ids), isNull);
  });

  test('Chat: each phrase is read on the phone, never sent to a model, in every spelling', () {
    for (final words in spoken('CHE, open your Commands page.')) {
      expect(parseScreenCommand(words)?.op, ScreenOp.openCommands, reason: words);
    }
    for (final words in spoken('CHE, search for YouTube.')) {
      final route = parseScreenCommand(words);
      expect((route?.op, route?.text), (ScreenOp.searchCommands, 'youtube'), reason: words);
    }
    for (final words in spoken('Show me five YouTube commands and tell me which are ready.')) {
      final route = parseScreenCommand(words)!;
      expect((route.op, route.text, route.list!.count, route.list!.readiness), (ScreenOp.searchCommands, 'youtube', 5, true), reason: words);
    }
    for (final words in spoken('What is on my screen?')) {
      expect(cheAsksAboutScreen(words), isTrue, reason: words);
      expect(parseScreenCommand(words), isNull, reason: words);
    }
    // Other searches stay Chat's.
    for (final words in ['Search YouTube for jazz', 'search for YouTube videos about cats', 'search for youtube shorts ideas', 'search for money']) {
      expect(parseScreenCommand(words)?.op, isNot(ScreenOp.searchCommands), reason: words);
    }
    for (final words in ['what is on my calendar', 'what is on the menu', 'where am I going tonight']) {
      expect(cheAsksAboutScreen(words), isFalse, reason: words);
    }
  });

  testWidgets('screen reports: Commands tabs, a page on top that does not report itself, Connections', (tester) async {
    final che = center.FakeChe();
    await center.openCenter(tester, che: che);
    expect(CheScreenAwareness.describe(), startsWith('You are on Commands, Library tab. Tabs: 1. Library, 2. Workflows, 3. Activity. All 127 commands'));
    await CheCommandCenterVoice.handler!('show workflows');
    await tester.pumpAndSettle();
    expect(CheScreenAwareness.describe(), startsWith('You are on Commands, Workflows tab.'));
    await CheCommandCenterVoice.handler!('search for youtube');
    await CheCommandCenterVoice.handler!('number four');
    await tester.pumpAndSettle();
    // The command's details are on top and do not report themselves: CHE says so.
    expect(CheScreenAwareness.describe(), allOf(startsWith("I can't tell exactly"), contains('Behind it is Commands.')));

    final client = MockClient((r) async => http.Response(jsonEncode({'connectors': {'youtube': {'state': 'ready'}, 'gmail': {'state': 'not_connected'}}}), 200,
        headers: {'content-type': 'application/json'}));
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(MaterialApp(theme: CheTheme.dark(),
        home: CheConnectionsScreen(baseUrl: 'https://che.test', headers: () => {}, client: client, onVoiceSettings: () {}, onKeys: () {})));
    await tester.pumpAndSettle();
    final connections = CheScreenAwareness.describe();
    expect(connections, startsWith('You are on Connections. YouTube channel: '));
    expect(connections, contains('Controls: Back, Refresh verified connections'));
  });

  testWidgets('screen reports: the rooms sheet, Trading, Creator Studio and the Brain with their selected tabs', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: CheTheme.dark(),
      home: Scaffold(
        body: CheImmersiveHubShell(
          initialIndex: 1,
          tabs: const [Tab(text: 'Brain'), Tab(text: 'Trading'), Tab(text: 'Music')],
          pages: [
            (_) => const CheTwoBrainsView(live: Text('constellation'), offline: SizedBox()),
            (_) => const Text('markets'),
            (_) => CheCreatorStudio(speaking: false, jobs: const [], actions: const [], onOpenJob: (_) {}, musicScene: const SizedBox()),
          ],
        ),
      ),
    ));
    // The studio's meters animate for ever: pump, never settle.
    Future<void> settle() async {
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    await settle();
    expect(CheScreenAwareness.describe(), startsWith('You are on the rooms sheet, Trading tab. Tabs: 1. Brain, 2. Trading, 3. Music.'));
    await tester.tap(find.text('Music').first);
    await settle();
    expect(CheScreenAwareness.describe(), startsWith('You are on Creator Studio, Studio tab. Tabs: 1. Studio, 2. Music. Studio ready, not on air. Render queue: nothing rendering.'));
    await tester.tap(find.text('Brain').first);
    await settle();
    expect(CheScreenAwareness.describe(), startsWith('You are on the Brain, Live tab.'));
    await tester.tap(find.bySemanticsLabel('CHE Brain — Offline'));
    await settle();
    expect(CheScreenAwareness.describe(), startsWith('You are on the Brain, Offline tab.'));
  });

  testWidgets('Chat: "What is on my screen?" and "CHE, search for YouTube." are answered on the phone from real state', (tester) async {
    SharedPreferences.setMockInitialValues({'che_agent_base_url': 'https://che.test'});
    final che = center.FakeChe();
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await http.runWithClient(() async {
      await tester.pumpWidget(const CHEApp());
      for (var i = 0; i < 15; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      expect(CheScreenAwareness.describe(), startsWith('You are on Home, Home tab.'), reason: 'the app opens on Home');
      await tester.tap(find.text('Office'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(CheScreenAwareness.describe(), startsWith('You are on the Office, Crew tab. Tabs: 1. Crew, 2. Projects.'));
      await tester.tap(find.text('Chat'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.byTooltip('Show keyboard'));
      await tester.pump(const Duration(milliseconds: 300));

      Future<void> send(String words) async {
        await tester.enterText(find.byType(TextField).last, words);
        await tester.testTextInput.receiveAction(TextInputAction.send);
        for (var i = 0; i < 12; i++) {
          await tester.pump(const Duration(milliseconds: 150));
        }
      }

      await send('What is on my screen?');
      expect(find.textContaining('You are on Chat, Chat tab. Tabs: 1. Home, 2. Chat, 3. Office, 4. CHE World, 5. More.'), findsOneWidget,
          reason: 'shown as large text in Chat as well as spoken');
      expect(find.textContaining('Controls: Talk to CHE, Commands, Flagstaff, Help, Chat options'), findsOneWidget);
      expect(find.text('PAIR WITH C.H.E. AGENT'), findsNothing, reason: 'nothing was sent to CHE\'s server or a model');

      await send('CHE, search for YouTube.');
      expect(find.text('Library'), findsOneWidget, reason: 'the Commands page is open');
      expect(find.textContaining('YouTube: 11 commands. 1. /yt-ideas: '), findsOneWidget);
      expect(CheScreenAwareness.describe(), startsWith('You are on Commands, Library tab.'));
      expect(che.requests.where((r) => r.url.path == '/api/chat' && r.body.toLowerCase().contains('youtube')), isEmpty, reason: 'no model was asked');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    }, () => che.client);
  });
}
