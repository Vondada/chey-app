// The Knowledge Atlas page (issue #346) on the phone, on the bundled cards the Worker writes
// (assets/atlas/knowledge_atlas.json): silent when it opens, Read aloud speaks exactly what is
// shown, large text holds, and every button has a spoken route while the page is open.
import 'dart:convert';
import 'dart:io';

import 'package:chey/brain/che_knowledge_atlas.dart';
import 'package:chey/che_ui/che_screen_awareness.dart';
import 'package:chey/home/screen_command.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

CheKnowledgeAtlas bundled() => CheKnowledgeAtlas.fromJson(
    Map<String, dynamic>.from(jsonDecode(File('assets/atlas/knowledge_atlas.json').readAsStringSync()) as Map));

Future<List<String>> open(WidgetTester tester, {double textScale = 1, List<String>? asked}) async {
  final spoken = <String>[];
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
        child: CheKnowledgeAtlasPage(
          atlas: bundled(),
          onSpeak: spoken.add,
          onListen: () {},
          onAskChe: asked == null ? null : (message) async {
            asked.add(message);
            return 'Your records: no recorded data yet.';
          },
        ),
      ),
    ),
  ));
  await tester.pumpAndSettle();
  return spoken;
}

void main() {
  test('the bundled cards: ten coding and ten trading, each with three levels and a quiz', () {
    final atlas = bundled();
    // Phase 1's cards; the coding (c-) and trading (t-) lanes add theirs with prefixed ids.
    final phase1 = atlas.cards.where((c) => !RegExp(r'^[ct]-').hasMatch(c.id));
    expect(phase1.where((c) => c.domain == 'coding').length, 10);
    expect(phase1.where((c) => c.domain == 'trading').length, 10);
    for (final c in atlas.cards) {
      for (final level in cheAtlasLevels) {
        expect(c.levels[level], isNotEmpty, reason: '${c.id} $level');
      }
      expect(c.quiz.length, greaterThanOrEqualTo(3), reason: c.id);
      expect(c.analogy, isNotEmpty, reason: c.id);
    }
    // The same exact-name rule as the Worker: a card is named, or there is none.
    expect(atlas.find('big o')?.id, 'big-o');
    expect(atlas.find('Risk management')?.id, 'risk-management');
    expect(atlas.find('the formula for vwap'), isNull);
    expect(atlas.find('option spreads'), isNull);
    expect(atlas.next(atlas.byId('recursion')!)?.id, 'hash-maps');
    expect(atlas.next(atlas.byId('sample-size')!), isNull);
    // A language named on its own is the topic; after another topic it is not.
    expect(atlas.find('python')?.id, 'c-python');
    expect(atlas.find('recursion in python')?.id, 'recursion');
    expect(atlas.find('binary search')?.id, 'c-binary-search');
  });

  testWidgets('opening is silent; the cards, filters and buttons are on screen', (tester) async {
    final spoken = await open(tester);
    final atlas = bundled();
    expect(spoken, isEmpty, reason: 'no speech when the page opens');
    expect(find.text('Knowledge Atlas'), findsOneWidget);
    expect(find.text('All ${atlas.cards.length}'), findsOneWidget);
    expect(find.text('Coding ${atlas.inDomain('coding').length}'), findsOneWidget);
    expect(find.text('Trading ${atlas.inDomain('trading').length}'), findsOneWidget);
    expect(find.text('Read aloud'), findsOneWidget);
    expect(find.text('Speak to CHE'), findsOneWidget);
    expect(find.text('1. Variables and data types'), findsOneWidget);
    await tester.tap(find.text('Trading ${atlas.inDomain('trading').length}'));
    await tester.pumpAndSettle();
    expect(find.text('1. Ticks, points and contract value'), findsOneWidget);
    expect(find.text('1. Variables and data types'), findsNothing);
    expect(spoken, isEmpty, reason: 'filtering is quiet');
    expect(CheScreenAwareness.describe(), startsWith('You are on the Knowledge Atlas, Trading cards view. 10 cards: 1. Ticks, points and contract value'));
  });

  testWidgets('a card by touch: levels, Read aloud of exactly what is shown, and the quiz', (tester) async {
    final spoken = await open(tester);
    await tester.scrollUntilVisible(find.text('6. Recursion'), 200, scrollable: find.byType(Scrollable).first);
    // ensureVisible jumps the list; lay out that frame before tapping at the row's new place.
    await tester.pumpAndSettle();
    await tester.tap(find.text('6. Recursion'));
    await tester.pumpAndSettle();
    final recursion = bundled().byId('recursion')!;
    expect(find.text(recursion.levels['beginner']!), findsOneWidget);
    expect(find.text(recursion.analogy), findsOneWidget);
    expect(spoken, isEmpty, reason: 'opening a card is quiet');
    await tester.tap(find.text('Expert'));
    await tester.pumpAndSettle();
    expect(find.text(recursion.levels['expert']!), findsOneWidget);
    await tester.tap(find.text('Read aloud'));
    await tester.pumpAndSettle();
    expect(spoken, [cheAtlasCardText(recursion, 'expert')]);
    await tester.tap(find.text('Quiz me'));
    await tester.pumpAndSettle();
    expect(find.text('1. ${recursion.quiz.first.q}'), findsOneWidget);
    expect(find.text('Answer: ${recursion.quiz.first.a}'), findsNothing, reason: 'answers wait until asked');
    await tester.tap(find.text('Show answer 1'));
    await tester.pumpAndSettle();
    expect(find.text('Answer: ${recursion.quiz.first.a}'), findsOneWidget);
  });

  testWidgets('every action by voice: list, number, level, formula, quiz, answers, next, back', (tester) async {
    await open(tester);
    final say = CheKnowledgeAtlasVoice.handler!;
    Future<String?> hear(String words) async {
      final reply = await say(words);
      await tester.pumpAndSettle();
      return reply;
    }

    expect(await hear('list the trading cards'), startsWith('Trading cards: 10. 1. Ticks, points and contract value, beginner.'));
    expect(await hear('number five'), startsWith('Expectancy, beginner level. Expectancy is what a strategy makes or loses'));
    expect(find.text('Expectancy'), findsOneWidget);
    expect(await hear('give me the expert version'), startsWith('Expectancy, expert level.'));
    expect(await hear("CHE, what's the formula?"), startsWith('The formula for Expectancy: expectancy equals the win rate times the average win'));
    expect(await hear('quiz me'), startsWith('Quiz on Expectancy. 1. '));
    expect(await hear('quiz answers'), startsWith('Answers. 1. +0.25R'));
    expect(find.textContaining('Answer: +0.25R'), findsOneWidget);
    expect(await hear('whats next'), startsWith('Win rate and its confidence interval, beginner level.'));
    expect(await hear('teach me recursion'), startsWith('Recursion, beginner level.'));
    expect(await hear('go deeper'), startsWith('Recursion, intermediate level.'));
    expect(await hear('what can I do here'), startsWith('Your options: 1. Read aloud.'));
    expect(await hear('go back'), 'Back to the 10 cards.', reason: 'back to the trading list it came from');
    expect(find.text('1. Ticks, points and contract value'), findsOneWidget);
    // Not the page's: Chat answers these as usual.
    expect(await hear('tell me a joke'), isNull);
    expect(await hear('/learn expectancy'), isNull);
    expect(await hear('teach me quantum chromodynamics'), isNull, reason: 'no card is invented; the Worker says so');
    await tester.pumpWidget(const SizedBox());
    expect(CheKnowledgeAtlasVoice.handler, isNull, reason: 'the voice route ends with the page');
  });

  testWidgets('recorded trading numbers come from CHE through Chat, never from the card', (tester) async {
    final asked = <String>[];
    await open(tester, asked: asked);
    await tester.tap(find.text('Trading ${bundled().inDomain('trading').length}'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('5. Expectancy'), 200, scrollable: find.byType(Scrollable).first);
    // ensureVisible jumps the list; lay out that frame before tapping at the row's new place.
    await tester.pumpAndSettle();
    await tester.tap(find.text('5. Expectancy'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Ask CHE for my recorded numbers'), 300, scrollable: find.byType(Scrollable).first);
    // ensureVisible jumps the list; lay out that frame before tapping at the row's new place.
    await tester.pumpAndSettle();
    await tester.tap(find.text('Ask CHE for my recorded numbers'));
    await tester.pumpAndSettle();
    expect(asked, ['/learn expectancy']);
    expect(find.text('Your records: no recorded data yet.'), findsOneWidget);
  });

  testWidgets('coding practice by voice and touch: exercise, answer, next, review drill, and Read aloud parity', (tester) async {
    final spoken = await open(tester);
    final say = CheKnowledgeAtlasVoice.handler!;
    Future<String?> hear(String words) async {
      final reply = await say(words);
      await tester.pumpAndSettle();
      return reply;
    }

    final card = bundled().byId('c-binary-search')!;
    expect(card.exercises.length, 4);
    expect(card.repoExamples.first, startsWith('server/cloudflare/knowledge_atlas.js, binarySearchWorst: '));
    expect(await hear('teach me binary search'), startsWith('Binary search and two pointers, beginner level.'));
    expect(spoken, isEmpty, reason: 'voice replies are returned for Chat to speak; the page itself stays quiet');
    expect(await hear('exercise'), startsWith('Exercise 1 of 4. What does binarySearch([1, 3, 5, 7, 9], 7) return'));
    expect(await hear('the answer'), startsWith('Answer: 3. Indexes start at 0'));
    expect(find.textContaining('Answer: 3. Indexes start at 0'), findsWidgets, reason: 'the answer is shown as large text too');
    expect(await hear('next exercise'), contains('Options: 1. 0. 2. 1. 3. 3. 4. 4.'));
    expect(await hear('review drill'), startsWith('Review drill 1 of 1: The search that never looks at the last item.'));
    expect(await hear('tell me the answer'), startsWith('Finding: high is inclusive'));
    expect(await hear('what can I do here'), endsWith('8. Exercise. 9. Review drill.'));
    // Read aloud speaks exactly the card text, which now names CHE's own code and the practice.
    await tester.tap(find.text('Read aloud'));
    await tester.pumpAndSettle();
    expect(spoken, [cheAtlasCardText(card, 'beginner')]);
    expect(spoken.single, contains("In CHE's own code: server/cloudflare/knowledge_atlas.js, binarySearchWorst"));
    expect(spoken.single, contains('Practice: 4 exercises and 1 review drill.'));
    // By touch: an answer stays hidden until its button is pressed.
    final show = find.text('Show the answer to exercise 3');
    await tester.scrollUntilVisible(show, 300, scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    expect(find.text(card.exercises[2].answerText), findsNothing);
    await tester.tap(show);
    await tester.pumpAndSettle();
    expect(find.text(card.exercises[2].answerText), findsOneWidget);
    // A card with no practice says so instead of inventing one.
    expect(await hear('teach me vwap'), startsWith('VWAP'));
    expect(await hear('exercise'), startsWith('VWAP'), reason: 'a trading card has no coding exercise');
  });

  testWidgets('VoiceOver and large text: buttons are labelled, nothing overflows at 2x', (tester) async {
    final handle = tester.ensureSemantics();
    await open(tester, textScale: 2);
    expect(tester.takeException(), isNull);
    expect(find.bySemanticsLabel('Read aloud'), findsOneWidget);
    await tester.tap(find.text('1. Variables and data types'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.bySemanticsLabel(RegExp('Beginner')), findsWidgets);
    handle.dispose();
  });

  test('"open the knowledge atlas" opens the page on the phone; "Atlas" alone stays the Office agent', () {
    for (final words in ['Open the Knowledge Atlas.', 'open the knowledge atlas', 'show me the knowledge atlas', 'CHE, open the Knowledge Atlas']) {
      expect(parseScreenCommand(words)?.op, ScreenOp.openAtlas, reason: words);
    }
    expect(parseScreenCommand('open atlas'), isNull);
    expect(parseScreenCommand('add a chip that says Check Atlas')?.op, ScreenOp.addChip);
  });
}
