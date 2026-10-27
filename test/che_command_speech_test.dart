// The owner's own spoken requests to the Command Center (iPhone, 2026-10-15),
// through the real routing: the page's voice handler (what Chat's send
// pipeline calls while Commands is open) and Chat's own send pipeline in the
// real app. Each failed on the phone; these keep them fixed.
import 'package:chey/commands/che_command_voice.dart';
import 'package:chey/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'che_command_center_test.dart' as center;

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<String?> Function(String) voiceOn(WidgetTester tester) {
    final voice = CheCommandCenterVoice.handler!;
    return (words) async {
      final reply = await voice(words);
      await tester.pumpAndSettle();
      return reply;
    };
  }

  int catalogReads(center.FakeChe che) => che.requests.where((r) => r.method == 'GET' && r.url.path == '/api/commands').length;

  testWidgets('screenshot 1: "Show me five YouTube commands and tell me which are ready" lists five with their states', (tester) async {
    final che = center.FakeChe();
    final ran = center.Ran();
    // Every answer re-reads the states (by default they may be a minute old).
    await center.openCenter(tester, che: che, ran: ran, statesMaxAge: Duration.zero);
    final say = voiceOn(tester);

    for (final words in [
      'Show me five YouTube commands and tell me which are ready.',
      // What the iPhone heard (the banner quoted everything after "show me").
      'Show me five YouTube commands show me which ones are ready to use',
    ]) {
      final before = catalogReads(che);
      final reply = (await say(words))!;
      expect(reply, isNot(contains('have a command called')), reason: words);
      expect(reply, startsWith('YouTube: 11 commands.'), reason: words);
      // The first five YouTube commands in catalog order, each with its state.
      expect(reply, contains('1. /yt-ideas: Research promising video ideas. Ready.'), reason: words);
      expect(reply, contains('3. /yt-script: Create original video scripts. Ready.'), reason: words);
      expect(reply, contains('4. /yt-video: Generate and assemble videos. Needs setup: Video renderer.'), reason: words);
      expect(reply, contains('5. /yt-voice: '), reason: words);
      expect(reply, isNot(contains('6. ')), reason: 'five, as asked');
      expect(reply, contains('Of these 5: 3 ready, 2 need setup.'), reason: words);
      expect(catalogReads(che), before + 1, reason: 'the states are read fresh from CHE for the answer');
      // The screen shows the filtered catalog CHE read.
      expect(find.text('/yt-ideas'), findsOneWidget);
      expect(find.text('/trade-chart'), findsNothing);
    }
    expect(ran.calls, isEmpty, reason: 'listing never runs a command');
    expect(che.requests.where((r) => r.method != 'GET'), isEmpty, reason: 'nothing was sent but catalog reads');

    // Follow-ups about the list just read keep its numbers.
    expect(await say('Which ones need setup?'), 'Of those 5: 2 not ready: 4. /yt-video (Needs setup: Video renderer); '
        '5. /yt-voice (Needs setup: CHE voice (ElevenLabs or Fish), Video renderer).');
    expect(await say("which ones aren't ready?"), startsWith('Of those 5: 2 not ready: 4. /yt-video'), reason: 'a negation is not "ready"');
    expect(await say('which ones are ready'), 'Of those 5: 3 ready: 1. /yt-ideas, 2. /yt-research, 3. /yt-script.');
    final more = (await say('show me more'))!;
    expect(more, startsWith('6 to 10 of 11.'));
    expect(more, contains('6. /yt-thumbnail: '));
    expect(await say('number four'), contains('/yt-video'), reason: 'numbers still mean what CHE read');
    expect(await say('is it ready?'), startsWith('/yt-video: Needs setup: Video renderer.'), reason: '"it" is the command just picked');
    expect(find.byTooltip('Read this command aloud'), findsNothing, reason: 'the answer comes back on the page');
    expect(await say('show me the next five commands'), startsWith('11 to 11 of 11.'));
    // Another list read in between: "more" continues that one, never the old numbers.
    await say('Show me five YouTube commands');
    expect(await say('run yt thumb'), contains('Closest: 1. /yt-thumbnail'));
    expect(await say('more'), 'That was all 3.');
    // A search that finds nothing replaced the list on screen: nothing to continue.
    await say('Show me YouTube commands');
    expect(await say('search for zebra polka'), startsWith('No command matches'));
    expect(await say('more'), startsWith('I have no list of commands to continue.'));
    // "What's on screen" reads the same list and "more" still continues it.
    await say('Show me YouTube commands');
    expect(await say("what's on screen"), contains('Say "more" for the next 5.'));
    expect(await say('more'), startsWith('6 to 10 of 11.'));
    // Another tab cleared the numbers: "more" says so instead of misnumbering.
    await say('show activity');
    expect(await say('more'), startsWith('I have no list of commands to continue.'));
    expect(ran.calls, isEmpty);
  });

  testWidgets('screenshot 2: "CHE, search for YouTube" filters the catalog and reads the YouTube commands', (tester) async {
    final che = center.FakeChe();
    final ran = center.Ran();
    await center.openCenter(tester, che: che, ran: ran);
    final say = voiceOn(tester);

    // The banner quoted "YouTube" alone: the words reached the open/run path.
    // Each of these is the same request and must list, never refuse.
    for (final words in ['CHE, search for YouTube.', 'search for you tube', 'Show me YouTube', 'open YouTube', 'tell me about YouTube']) {
      final reply = (await say(words))!;
      expect(reply, isNot(contains('have a command called')), reason: words);
      expect(reply, startsWith('YouTube: 11 commands. 1. /yt-ideas: '), reason: words);
      expect(reply, contains('Say "more" for the next 5'), reason: words);
      final field = tester.widget<TextField>(find.byType(TextField).first);
      expect(field.controller?.text, 'youtube', reason: 'the search box shows the filter');
    }
    expect(find.text('/yt-ideas'), findsOneWidget);
    expect(find.text('/lead-scout'), findsNothing, reason: 'only YouTube commands are listed');
    expect(ran.calls, isEmpty);

    // A command named outright still opens or runs as before.
    expect(await say('tell me about YouTube ideas'), startsWith('/yt-ideas. Research promising video ideas.'));
    expect(find.byTooltip('Read this command aloud'), findsOneWidget, reason: 'its details are open');
    expect(ran.calls, isEmpty, reason: 'explaining a command does not run it');
    expect(await say('run YouTube'), allOf(contains('YouTube is a group of 11 commands'), contains('Nothing was run.')));
    expect(await say('run the YouTube commands'), contains('Nothing was run.'));
    expect(ran.calls, isEmpty);
    expect(catalogReads(che), 1, reason: 'states read when the page opened are reused for a minute, so answers come at once');
    expect(await say('run trade chart NQ'), '');
    expect(ran.calls, [('/trade-chart NQ', false)]);
  });

  testWidgets('readiness questions answer from the catalog, and say when the states could not be re-read', (tester) async {
    final che = center.FakeChe();
    await center.openCenter(tester, che: che, statesMaxAge: Duration.zero);
    final say = voiceOn(tester);
    final ready = (await say('Which YouTube commands are ready?'))!;
    expect(ready, startsWith('7 of the 11 YouTube commands are ready. 1. /yt-ideas: '));
    expect(ready, isNot(contains('/yt-video')), reason: 'only the ready ones are read');
    expect(await say('how many YouTube commands need setup'), startsWith('4 of the 11 YouTube commands are not ready. 1. /yt-video: '));
    expect(await say('read them again'), startsWith('4 of the 11 YouTube commands are not ready.'));
    expect(await say('Show me the YouTube commands that need setup'), startsWith('4 of the 11 YouTube commands are not ready.'));
    expect(await say('which commands are there for trading'), startsWith('Trading: 25 commands.'));
    // A topic in a readiness question is that topic, not the last list.
    expect(await say('are the trading ones ready?'), startsWith('24 of the 25 Trading commands are ready.'));
    expect(find.text('/trade-execute'), findsNothing, reason: 'the screen lists only what CHE read: the ready ones');
    expect(await say('which money ones need setup'), 'All 8 Money Management commands are ready.');
    expect(await say('show me 0 YouTube commands'), contains('Say "more" for the next 5.'), reason: 'zero is not a page size');
    // How-to questions are not about the list: they go on to Chat.
    expect(await say('show me how to set up YouTube'), isNull);
    expect(await say('is YouTube available'), isNull);
    // "Available" asks what exists: every one, each with its state.
    expect(await say('What YouTube commands are available?'), startsWith('YouTube: 11 commands. 1. /yt-ideas: '));
    expect(await say('find a command to build an invoice'), contains('/invoices: '), reason: '"build" is a verb here, not the Websites category');
    expect(await say('which commands can price a site'), contains('/pricing: '));
    expect(await say('search for online marketing commands'), contains('/marketing-plan: '));
    // CHE cannot be reached: the answer still comes, and says how old it is.
    che.offline = true;
    final offline = (await say('show me five trading commands'))!;
    expect(offline, startsWith('CHE could not be reached just now, so these states are from when this page last loaded and may be out of date. '
        'Trading: 25 commands. 1. /trade-open: '));
  });

  testWidgets('Chat: "open your Commands page and show me five commands…" opens Commands and reads states, no model', (tester) async {
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
      await tester.tap(find.text('Chat'));
      await tester.pump(const Duration(milliseconds: 500));
      // Typed and spoken words take the same path: the mic puts the words in
      // the composer and calls the same send as the keyboard's Send key.
      await tester.tap(find.byTooltip('Show keyboard'));
      await tester.pump(const Duration(milliseconds: 300));

      Future<void> send(String words) async {
        await tester.enterText(find.byType(TextField).last, words);
        await tester.testTextInput.receiveAction(TextInputAction.send);
        for (var i = 0; i < 12; i++) {
          await tester.pump(const Duration(milliseconds: 150));
        }
      }

      // The owner's request in the screen recording (it went to the model,
      // which answered that CHE has no Commands page).
      await send('CHE, open your Commands page and show me five commands you can use to create, edit, and publish '
          'faceless YouTube videos. Explain which ones are ready to use and which need setup. '
          'Don\'t just describe the page—actually open it.');
      expect(find.text('Library'), findsOneWidget, reason: 'the Commands page is open');
      expect(find.textContaining('/yt-publish: Upload or schedule approved videos. Needs setup: Video renderer, YouTube channel.'), findsOneWidget);
      expect(find.textContaining(RegExp(r'Of these 5: \d ready, \d needs? setup\.')), findsOneWidget);
      expect(CheCommandCenterVoice.handler, isNotNull);
      // Speech while the page is open goes to its voice routes first.
      expect(await CheCommandCenterVoice.handler!('CHE, search for YouTube.'), startsWith('YouTube: 11 commands.'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(await CheCommandCenterVoice.handler!('back to chat'), 'Back to Chat.');
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 150));
      }

      await send('Show me five YouTube commands and tell me which are ready.');
      expect(find.text('Library'), findsOneWidget);
      expect(find.textContaining('YouTube: 11 commands. 1. /yt-ideas: '), findsOneWidget);
      expect(find.textContaining('Of these 5: 3 ready, 2 need setup.'), findsOneWidget);

      // (The app's own background status poll also uses /api/chat; none of
      // the owner's words may.)
      expect(che.requests.where((r) => r.url.path == '/api/chat' && r.body.toLowerCase().contains('youtube')), isEmpty,
          reason: 'no model was asked');
      expect(che.requests.where((r) => r.url.path.startsWith('/api/commands') && r.method != 'GET'), isEmpty,
          reason: 'nothing was run or saved');
      await tester.pumpWidget(const SizedBox());
      // CHE spoke each answer; let her speech timers finish.
      await tester.pump(const Duration(seconds: 5));
    }, () => che.client);
  });
}
