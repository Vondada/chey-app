import 'package:chey/browser/che_chat_links.dart';
import 'package:chey/browser/che_embedded_app_shell.dart';
import 'package:chey/home/che_chat_link_actions.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('link detection', () {
    test('a destination CHE recommends becomes a named action', () {
      final links = cheChatLinks('Go to Supabase and create an account: https://supabase.com/dashboard/new.');
      expect(links, hasLength(1));
      expect(links.single.url, 'https://supabase.com/dashboard/new');
      expect(links.single.label, 'Open Supabase dashboard');
      expect(links.single.host, 'supabase.com');
      expect(links.single.opensExternally, isFalse);
    });

    test('labels are human-readable for common destinations', () {
      String label(String url) => cheChatLinks('See $url').single.label;
      expect(label('https://github.com/Vondada/chey-app/pull/161'), 'Open GitHub PR #161');
      expect(label('https://github.com/Vondada/chey-app/issues/7'), 'Open GitHub issue #7');
      expect(label('https://github.com/Vondada/chey-app'), 'Open chey-app on GitHub');
      expect(label('https://supabase.com/docs/guides/database'), 'Open Supabase documentation');
      expect(label('https://docs.flutter.dev/ui'), 'Open Flutter documentation');
      expect(label('https://cloud.cerebras.ai/signup'), 'Open Cerebras sign-up');
      expect(label('https://console.groq.com/keys'), 'Open Groq dashboard');
      expect(label('https://www.bbc.co.uk/news'), 'Open Bbc');
      expect(cheChatLinks('[Supabase](https://supabase.com)').single.label, 'Open Supabase');
      expect(cheChatLinks('[Open the guide](https://supabase.com/x)').single.label, 'Open the guide');
    });

    test('CHE\'s own pages get CHE names', () {
      final links = cheChatLinks('Use https://che.workers.dev/app and https://che.workers.dev/site/abc', ownBase: 'https://che.workers.dev');
      expect(links.map((l) => l.label), ['Open CHE web app', 'Open the website CHE built']);
    });

    test('multiple links keep order, never share a name, and stop at four', () {
      final links = cheChatLinks(
        'First https://github.com/a/one then https://supabase.com and https://github.com/b/one '
        'plus https://groq.com https://mistral.ai https://openrouter.ai',
      );
      expect(links, hasLength(4));
      expect(links.map((l) => l.label), ['Open one on GitHub 1', 'Open Supabase', 'Open one on GitHub 2', 'Open Groq']);
    });

    test('duplicates, trailing punctuation and brackets are cleaned', () {
      final links = cheChatLinks('(see https://supabase.com/docs), again https://supabase.com/docs/ and "https://groq.com".');
      expect(links.map((l) => l.url), ['https://supabase.com/docs', 'https://groq.com']);
    });

    test('ordinary text, code blocks, images and previewed links add nothing', () {
      expect(cheChatLinks('Sure, sir. The weather is clear today.'), isEmpty);
      expect(cheChatLinks('```\ncurl https://supabase.com/rest/v1\n```'), isEmpty);
      expect(cheChatLinks('Here it is https://cdn.site.com/a.png'), isEmpty);
      expect(cheChatLinks('Watch https://youtu.be/abc', skip: ['https://youtu.be/abc']), isEmpty);
    });
  });

  group('URL safety', () {
    test('malformed and unsafe addresses are rejected', () {
      for (final bad in [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'file:///etc/passwd',
        'intent://scan#Intent;end',
        'https://bank.com@evil.site/login',
        'https://localhost:8080/x',
        'https://192.168.1.1/admin',
        'https://example.com/x',
        'https://supa base.com',
        'https://supabase.com/a\nb',
        'https://supabase.com/%0d%0aSet-Cookie:x',
        'https://supabase.com/<script>',
        'https://',
        'https://-bad-.com',
        'https://${'a' * 2100}.com',
      ]) {
        expect(cheSafeLinkUri(bad), isNull, reason: bad);
      }
      expect(cheSafeLinkUri('https://supabase.com/dashboard/new?x=1#y'), isNotNull);
      expect(cheSafeLinkUri('http://neverssl.com'), isNotNull);
    });

    test('unsafe links in a reply never become actions', () {
      expect(cheChatLinks('[Open](javascript:alert(1)) or https://bank.com@evil.site'), isEmpty);
    });
  });

  group('external-browser fallback', () {
    test('only links that cannot work inside CHE open outside it', () {
      expect(cheChatLinks('https://apps.apple.com/app/id123').single.externalReason, contains('App Store'));
      expect(cheChatLinks('https://accounts.google.com/signin').single.externalReason, contains('Google'));
      expect(cheChatLinks('https://site.com/manual.pdf').single.externalReason, contains('file'));
      expect(cheChatLinks('https://supabase.com').single.externalReason, isNull);
    });
  });

  group('spoken link commands', () {
    final one = cheChatLinks('Go to https://supabase.com/dashboard/new');
    final two = cheChatLinks('Use https://supabase.com and https://github.com/Vondada/chey-app/pull/161');

    test('open by name, by "it", by number and in Safari', () {
      expect(CheLinkVoiceCommand.parse('Open Supabase', one)!.link.url, one.single.url);
      expect(CheLinkVoiceCommand.parse('Che, open it.', one)!.action, CheLinkVoiceAction.open);
      expect(CheLinkVoiceCommand.parse('open link 2', two)!.link.label, 'Open GitHub PR #161');
      expect(CheLinkVoiceCommand.parse('open the second link', two)!.link.label, 'Open GitHub PR #161');
      final safari = CheLinkVoiceCommand.parse('open the first link in Safari', two)!;
      expect(safari.action, CheLinkVoiceAction.openExternally);
      expect(safari.link.label, 'Open Supabase');
      expect(CheLinkVoiceCommand.parse('open GitHub PR #161', two)!.link.label, 'Open GitHub PR #161');
    });

    test('"open it" with several links reads a numbered list', () {
      final c = CheLinkVoiceCommand.parse('open the link', two)!;
      expect(c.action, CheLinkVoiceAction.chooseFromList);
      expect(CheLinkVoiceCommand.listAloud(c.links), contains('1. Open Supabase\n2. Open GitHub PR #161'));
    });

    test('raw address and copy on request', () {
      expect(CheLinkVoiceCommand.parse("what's the link", one)!.action, CheLinkVoiceAction.readAddress);
      expect(CheLinkVoiceCommand.parse('read me the link for supabase', two)!.link.label, 'Open Supabase');
      expect(CheLinkVoiceCommand.parse('copy the link', one)!.action, CheLinkVoiceAction.copyAddress);
    });

    test('other commands keep working', () {
      expect(CheLinkVoiceCommand.parse('open YouTube', one), isNull);
      expect(CheLinkVoiceCommand.parse('open link 5', two), isNull);
      expect(CheLinkVoiceCommand.parse('tell me a joke', one), isNull);
      expect(CheLinkVoiceCommand.parse('open it', const []), isNull);
    });
  });

  group('chat actions', () {
    late List<String> spoken;
    late List<String> openedInApp;
    late List<Uri> openedExternally;

    setUp(() {
      spoken = [];
      openedInApp = [];
      openedExternally = [];
      CheEmbeddedAppAnnouncer.speak = spoken.add;
      CheChatLinkOpener.inApp = (context, link) async {
        openedInApp.add(link.url);
        // Stand-in for CHE's expandable browser: a route over the chat.
        await Navigator.of(context).push(MaterialPageRoute<void>(
          builder: (c) => Scaffold(body: Center(child: TextButton(onPressed: () => Navigator.pop(c), child: Text('Close ${link.name}')))),
        ));
        return true;
      };
      CheChatLinkOpener.external = (uri) async {
        openedExternally.add(uri);
        return true;
      };
    });

    tearDown(() => CheEmbeddedAppAnnouncer.speak = null);

    Widget chat(ScrollController scroll, List<CheChatLink> links) => MaterialApp(
          home: Scaffold(
            body: ListView.builder(
              controller: scroll,
              itemCount: 60,
              itemBuilder: (_, i) => i == 40
                  ? CheChatLinkActions(links: links)
                  : SizedBox(height: 80, child: Text('message $i')),
            ),
          ),
        );

    testWidgets('opens inside CHE and returns to the same place in the conversation', (tester) async {
      final scroll = ScrollController();
      final links = cheChatLinks('Go to https://supabase.com/dashboard/new');
      await tester.pumpWidget(chat(scroll, links));
      await tester.scrollUntilVisible(find.text('Open Supabase dashboard'), 300, scrollable: find.byType(Scrollable));
      final offset = scroll.offset;
      expect(offset, greaterThan(0));

      await tester.tap(find.text('Open Supabase dashboard'));
      await tester.pumpAndSettle();
      expect(openedInApp, ['https://supabase.com/dashboard/new']);
      expect(openedExternally, isEmpty);
      expect(find.text('Close Supabase dashboard'), findsOneWidget);

      await tester.tap(find.text('Close Supabase dashboard'));
      await tester.pumpAndSettle();
      expect(scroll.offset, offset);
      expect(find.text('Open Supabase dashboard'), findsOneWidget);
    });

    testWidgets('every action has a clear VoiceOver label and options', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheChatLinkActions(links: cheChatLinks('https://supabase.com and https://apps.apple.com/app/id1')))));
      final inside = tester.getSemantics(find.byType(CheChatLinkButton).first);
      expect(inside.label, 'Open Supabase inside CHE');
      expect(inside.hint, contains('Link to supabase.com'));
      expect(inside.flagsCollection.isButton, isTrue);
      final actions = inside.getSemanticsData().customSemanticsActionIds!.map((id) => CustomSemanticsAction.getAction(id)!.label);
      expect(actions, containsAll(['Open in Safari', 'Read the link aloud', 'Copy the link']));
      expect(tester.getSemantics(find.byType(CheChatLinkButton).last).label, 'Open Apple in Safari');
      handle.dispose();
    });

    testWidgets('links that need Safari open there and say why', (tester) async {
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheChatLinkActions(links: cheChatLinks('https://apps.apple.com/app/id1')))));
      await tester.tap(find.byType(CheChatLinkButton));
      await tester.pumpAndSettle();
      expect(openedInApp, isEmpty);
      expect(openedExternally.single.toString(), 'https://apps.apple.com/app/id1');
      expect(spoken.single, 'Opening Apple in Safari, because it opens in the App Store app.');
    });

    testWidgets('owner can choose Safari, hear the raw link, or copy it', (tester) async {
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheChatLinkActions(links: cheChatLinks('https://supabase.com')))));
      await tester.longPress(find.byType(CheChatLinkButton));
      await tester.pumpAndSettle();
      expect(find.text('https://supabase.com'), findsOneWidget);
      await tester.tap(find.text('Open in Safari'));
      await tester.pumpAndSettle();
      expect(openedExternally.single.host, 'supabase.com');
      expect(spoken.last, 'Opening Supabase in Safari.');

      await tester.longPress(find.byType(CheChatLinkButton));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Read the link aloud'));
      await tester.pumpAndSettle();
      expect(spoken.last, 'Open Supabase: https://supabase.com');
    });

    testWidgets('a failed in-app open falls back to Safari and says so', (tester) async {
      CheChatLinkOpener.inApp = (context, link) async => throw StateError('no web view');
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheChatLinkActions(links: cheChatLinks('https://supabase.com')))));
      await tester.tap(find.byType(CheChatLinkButton));
      await tester.pumpAndSettle();
      expect(spoken.single, 'I could not open Supabase inside CHE, so I am opening it in Safari.');
      expect(openedExternally.single.host, 'supabase.com');
    });

    testWidgets('a link Safari cannot open is reported, not silently dropped', (tester) async {
      CheChatLinkOpener.external = (uri) async => false;
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheChatLinkActions(links: cheChatLinks('https://apps.apple.com/app/id1')))));
      await tester.tap(find.byType(CheChatLinkButton));
      await tester.pumpAndSettle();
      expect(spoken.last, startsWith('I could not open Apple.'));
    });

    testWidgets('a reply with no links shows no actions', (tester) async {
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheChatLinkActions(links: cheChatLinks('Hello, sir.')))));
      expect(find.byType(CheChatLinkButton), findsNothing);
    });
  });
}
