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

// The page's content exactly as rendered, line by line in screen order (each line carries its index).
List<String> screen(WidgetTester tester) {
  int index(Widget w) => int.parse((w.key! as ValueKey<String>).value.substring('atlas-line-'.length));
  final lines = tester
      .widgetList(find.byWidgetPredicate((w) => w.key is ValueKey<String> && (w.key! as ValueKey<String>).value.startsWith('atlas-line-')))
      .toList()
    ..sort((a, b) => index(a).compareTo(index(b)));
  return [for (final w in lines) w is Text ? w.data! : (w as SelectableText).data!];
}

void main() {
  // Counts follow the bundled cards: ten phase-1 cards in each domain, plus each lane's own (t- for trading).
  final codingN = bundled().inDomain('coding').length;
  final tradingN = bundled().inDomain('trading').length;
  final allN = bundled().cards.length;

  test('the bundled cards: every coding and trading card has three levels and a quiz', () {
    final atlas = bundled();
    expect(codingN, 10 + atlas.cards.where((c) => c.id.startsWith('c-')).length);
    expect(tradingN, 10 + atlas.cards.where((c) => c.id.startsWith('t-')).length);
    expect(codingN + tradingN, allN);
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
    expect(atlas.next(atlas.byId('sample-size')!)?.id, 't-futures');
    expect(atlas.next(atlas.byId('t-risk-of-ruin')!), isNull);
    // A language said on its own is the topic; after another topic it is not.
    expect(atlas.find('python')?.id, 'c-python');
    expect(atlas.find('recursion in python')?.id, 'recursion');
    expect(atlas.find('binary search')?.id, 'c-binary-search');
    // An id is never a topic: "c-python" must not make "C" the Python lesson.
    for (final other in ['c', 'C++', 'C#', 'c programming', 'pythons', 'this python code', 'the python code', 'this js code', 'this dart code', 'that javascript', 'this python']) {
      expect(atlas.find(other), isNull, reason: other);
    }
    expect(atlas.find('c-python')?.id, 'c-python', reason: 'an id is still found by its exact spelling');
    expect(atlas.find('the python language')?.id, 'c-python');
    expect(atlas.find('python programming')?.id, 'c-python');
    // Trading cards state their limitations, shown and read as part of the card; the ICT ones say their evidence is mixed or limited.
    for (final c in atlas.inDomain('trading')) {
      expect(c.limitations, isNotEmpty, reason: c.id);
    }
    final blocks = atlas.byId('t-order-blocks')!;
    expect(blocks.limitations.first, contains('mixed or limited evidence'));
    final lines = cheAtlasCardLines(atlas, blocks, 'beginner').map((l) => l.text).toList();
    expect(lines, containsAllInOrder(['Limitations', blocks.limitations.first]));
  });

  test('word matching comes from the Worker through the asset, so it cannot drift from knowledge_atlas.js', () {
    final json = Map<String, dynamic>.from(jsonDecode(File('assets/atlas/knowledge_atlas.json').readAsStringSync()) as Map);
    final atlas = CheKnowledgeAtlas.fromJson(json);
    final matching = Map<String, dynamic>.from(json['matching'] as Map);
    expect(atlas.filler, (matching['filler'] as List).map((w) => '$w').toSet());
    expect(atlas.filler, containsAll(['the', 'how', 'about', 'python']));
    expect(atlas.numberOf('five'), 5);
    expect(atlas.numberOf('twenty'), 20);
    expect(atlas.referencesLabel, 'Reference links, not opened or checked by CHE');
    expect(atlas.languages, (matching['languages'] as List).map((w) => '$w').toSet());
    // Every name of every card finds that card, as in the Worker's own alias test.
    for (final c in atlas.cards) {
      for (final name in [c.id, c.title, ...c.aliases]) {
        expect(atlas.find(name)?.id, c.id, reason: name);
      }
    }
  });

  testWidgets('opening is silent; the cards, filters and buttons are on screen', (tester) async {
    final spoken = await open(tester);
    expect(spoken, isEmpty, reason: 'no speech when the page opens');
    expect(find.text('Knowledge Atlas'), findsOneWidget);
    expect(find.text('All $allN'), findsOneWidget);
    expect(find.text('Coding $codingN'), findsOneWidget);
    expect(find.text('Trading $tradingN'), findsOneWidget);
    expect(find.text('Read aloud'), findsOneWidget);
    expect(find.text('Speak to CHE'), findsOneWidget);
    expect(find.text('1. Variables and data types'), findsOneWidget);
    await tester.tap(find.text('Trading $tradingN'));
    await tester.pumpAndSettle();
    expect(find.text('1. Ticks, points and contract value'), findsOneWidget);
    expect(find.text('1. Variables and data types'), findsNothing);
    expect(spoken, isEmpty, reason: 'filtering is quiet');
    expect(CheScreenAwareness.describe(), startsWith('You are on the Knowledge Atlas, Trading cards view. $tradingN cards: 1. Ticks, points and contract value'));
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
    // Read aloud says what the screen shows, line for line, at every level: the formula and its
    // assumptions included, read from the rendered widgets, not from the function that builds them.
    await tester.tap(find.text('Read aloud'));
    await tester.pumpAndSettle();
    final beginner = screen(tester);
    expect(spoken.last, beginner.join('\n'));
    expect(beginner, containsAll([recursion.analogy, '${recursion.formula!['expression']}', 'Assumptions: ${recursion.formula!['assumptions']}']));
    expect(beginner.last, startsWith('Reference links, not opened or checked by CHE: '));
    await tester.tap(find.text('Expert'));
    await tester.pumpAndSettle();
    expect(find.text(recursion.levels['expert']!), findsOneWidget);
    await tester.tap(find.text('Read aloud'));
    await tester.pumpAndSettle();
    final expert = screen(tester);
    expect(spoken.last, expert.join('\n'));
    expect(expert, containsAll(['Common mistake', recursion.misconceptions.first, recursion.levels['expert']]));
    await tester.tap(find.text('Quiz me'));
    await tester.pumpAndSettle();
    expect(find.text('1. ${recursion.quiz.first.q}'), findsOneWidget);
    expect(find.text('Answer: ${recursion.quiz.first.a}'), findsNothing, reason: 'answers wait until asked');
    await tester.tap(find.text('Show answer 1'));
    await tester.pumpAndSettle();
    expect(find.text('Answer: ${recursion.quiz.first.a}'), findsOneWidget);
    await tester.tap(find.text('Read aloud'));
    await tester.pumpAndSettle();
    expect(spoken.last, screen(tester).join('\n'));
    expect(spoken.last, contains('Answer: ${recursion.quiz.first.a}'), reason: 'a revealed answer is read');
    expect(spoken.last, isNot(contains(recursion.quiz[1].a)), reason: 'a hidden answer is not');
    expect(spoken.length, 3);
  });

  testWidgets('every action by voice: list, number, level, formula, quiz, answers, next, back', (tester) async {
    await open(tester);
    final say = CheKnowledgeAtlasVoice.handler!;
    Future<String?> hear(String words) async {
      final reply = await say(words);
      await tester.pumpAndSettle();
      return reply;
    }

    expect(await hear('list the trading cards'), startsWith('Trading cards: $tradingN.\n1. Ticks, points and contract value\nTrading, beginner. '));
    final picked = await hear('number five');
    expect(picked, startsWith('Expectancy, beginner level.\nTrading, starts at intermediate'));
    expect(picked, screen(tester).join('\n'), reason: 'the spoken reply is the card now on screen');
    expect(find.text('Expectancy, beginner level.'), findsOneWidget);
    expect(await hear('give me the expert version'), startsWith('Expectancy, expert level.'));
    expect(await hear("CHE, what's the formula?"), startsWith('The formula for Expectancy: expectancy equals the win rate times the average win'));
    expect(await hear('quiz me'), startsWith('Quiz on Expectancy.\n1. '));
    expect(await hear('quiz answers'), contains('Answer: +0.25R'));
    expect(screen(tester).where((l) => l.startsWith('Answer: +0.25R')), hasLength(1), reason: 'the revealed answer is on the card');
    expect(await hear('whats next'), startsWith('Win rate and its confidence interval, beginner level.'));
    expect(await hear('teach me recursion'), startsWith('Recursion, beginner level.'));
    expect(await hear('go deeper'), startsWith('Recursion, intermediate level.'));
    expect(await hear('what can I do here'), startsWith('Your options: 1. Read aloud.'));
    expect(await hear('open the knowledge atlas'), 'The Knowledge Atlas is already open.');
    expect(find.byType(CheKnowledgeAtlasPage), findsOneWidget, reason: 'no second copy of the page');
    expect(await hear('go back'), 'Back to the $tradingN cards.', reason: 'back to the trading list it came from');
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
    await tester.tap(find.text('Trading $tradingN'));
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

  testWidgets('coding practice by voice and touch: exercise, answer, next, review drill, with Read aloud parity', (tester) async {
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
    final lesson = await hear('teach me binary search');
    expect(lesson, startsWith('Binary search and two pointers, beginner level.'));
    expect(lesson, contains("In CHE's own code\nserver/cloudflare/knowledge_atlas.js, binarySearchWorst"));
    expect(lesson, contains('Practice: 4 exercises and 1 review drill.'));
    final first = await hear('exercise');
    expect(first, startsWith('Exercise 1 of 4 on Binary search and two pointers.\nWhat does binarySearch([1, 3, 5, 7, 9], 7) return'));
    expect(first, screen(tester).join('\n'), reason: 'the spoken exercise is the screen');
    expect(first, isNot(contains('Answer:')), reason: 'the answer waits until asked');
    final answer = await hear('the answer');
    expect(answer, contains('Answer: 3. Indexes start at 0'));
    expect(answer, screen(tester).join('\n'));
    final second = await hear('next exercise');
    expect(second, contains('Option 1: 0. Option 2: 1. Option 3: 3. Option 4: 4.'));
    expect(second, contains('To have an answer checked, ask for this exercise in Chat: say "give me an exercise on lower bound".'), reason: 'the phone never pretends to check an answer');
    // The practice is the page; the banner only says what changed, and is never the whole exercise.
    expect(find.text('Exercise 2 of 4 shown.'), findsOneWidget);
    expect(find.text(second!), findsNothing);
    final drill = await hear('review drill');
    expect(drill, startsWith('Review drill 1 of 1 on Binary search and two pointers.\nThe search that never looks at the last item. What is wrong with this code?'));
    expect(await hear('show the finding'), contains('Finding: high is inclusive'));
    expect(find.text('Finding shown.'), findsOneWidget);
    expect(spoken, isEmpty, reason: 'voice replies are returned for Chat to speak; the page itself stays quiet');
    expect(await hear('back to the card'), startsWith('Binary search and two pointers, beginner level.'), reason: 'back to the card, not the list');
    // "Quiz me" from an open exercise shows the quiz, not the exercise.
    await hear('exercise');
    expect(await hear('quiz me'), startsWith('Quiz on Binary search and two pointers.'));
    expect(screen(tester).first, 'Quiz on Binary search and two pointers.');
    expect(await hear('go back'), startsWith('Back to the'));
    await hear('teach me binary search');
    // By touch: Read aloud says exactly the practice on screen, and "Show the answer" reveals it.
    await tester.tap(find.text('Exercise'));
    await tester.pumpAndSettle();
    expect(find.text('Exercise 1 of 4 shown.'), findsOneWidget, reason: 'a short status, not the exercise');
    await tester.tap(find.text('Read aloud'));
    await tester.pumpAndSettle();
    expect(spoken.single, screen(tester).join('\n'));
    // The result banner can cover the bottom of the card; bring the button into view first.
    await tester.ensureVisible(find.text('Show the answer'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Show the answer'));
    await tester.pumpAndSettle();
    expect(screen(tester), contains(startsWith('Answer: 3.')));
    expect(await hear('what can I do here'), endsWith('8. Exercise. 9. Review drill.'));
    // A card with no practice says so instead of inventing one.
    expect(await hear('teach me vwap'), startsWith('VWAP, beginner level.'));
    expect(await hear('exercise'), 'VWAP has no exercises yet. Say "quiz me" for its quiz.');
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
