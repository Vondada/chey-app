// Universal "?" help (owner, 2026-10-20): help comes from the controls the screen in front really
// registers. "?" opens it, "Show me" outlines the control, the walkthrough steps through each
// one, the Help Center lists every open screen's help, and the typed or spoken questions are
// answered from the same records. Nothing is guessed for a control the screen did not describe.
import 'package:chey/che_ui/che_help.dart';
import 'package:chey/rooms/che_strategy_controls.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'che_strategy_controls_test.dart' show FakeWorker;

Widget host(FakeWorker w) => MaterialApp(
      home: Scaffold(
        appBar: AppBar(actions: const [CheHelpButton()]),
        body: SingleChildScrollView(child: CheStrategyControlsPanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: (_) {}, client: w.client, refresh: const Duration(hours: 1))),
      ),
    );

void main() {
  test('the owner\'s help questions are recognised; other questions are left alone', () {
    expect(cheHelpIntent('Chey, what is this button?')?.kind, CheHelpKind.explain);
    expect(cheHelpIntent('what does the Emergency Stop button do')?.name, 'emergency stop');
    expect(cheHelpIntent('what does Flatten do?')?.name, 'flatten');
    expect(cheHelpIntent('show me the pause all button')?.kind, CheHelpKind.show);
    expect(cheHelpIntent('walk me through this screen')?.kind, CheHelpKind.walkthrough);
    expect(cheHelpIntent('open the help center')?.kind, CheHelpKind.center);
    expect(cheHelpIntent('help')?.kind, CheHelpKind.explain);
    for (final other in ['help me understand', 'what does the market do today', 'what does the EMA strategy do', 'take me back to my meeting', 'what is on my screen', 'pause the ICT strategy']) {
      expect(cheHelpIntent(other), isNull, reason: other);
    }
  });

  testWidgets('"?" shows the controls this screen registers; Show me outlines Emergency Stop; answers come from the same records', (tester) async {
    tester.view.physicalSize = const Size(900, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    addTearDown(CheHelp.clear);
    await tester.pumpWidget(host(FakeWorker()));
    await tester.pumpAndSettle();

    expect(CheHelp.answer(const CheHelpRequest(CheHelpKind.explain, 'emergency stop')), allOf(contains('Blocks new entries'), contains('By voice, say "emergency stop"')));
    expect(CheHelp.answer(const CheHelpRequest(CheHelpKind.explain, 'turbo boost')), allOf(contains('I do not see a control called "turbo boost"'), contains('1. Emergency Stop')));
    expect(CheHelp.answer(const CheHelpRequest(CheHelpKind.explain)), contains('Maximum trades per day: The most entries'));

    await tester.tap(find.bySemanticsLabel('Help for this screen').first);
    await tester.pumpAndSettle();
    expect(find.text('Strategy Control Center'), findsWidgets);
    expect(find.text('Emergency Stop'), findsWidgets);
    expect(find.textContaining('It does not close positions'), findsOneWidget);
    await tester.tap(find.text('Show me').first);
    await tester.pumpAndSettle();
    expect(CheHelp.highlighted.value, 'emergency stop');
    expect(find.bySemanticsLabel(RegExp('Emergency Stop')).evaluate().isNotEmpty, isTrue);
    expect(CheHelp.answer(const CheHelpRequest(CheHelpKind.explain)), startsWith('Emergency Stop: Blocks new entries'), reason: '"what is this button" explains the highlighted one');
  });

  testWidgets('the walkthrough steps through each control with Next, and the Help Center lists the screen', (tester) async {
    tester.view.physicalSize = const Size(900, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    addTearDown(CheHelp.clear);
    await tester.pumpWidget(host(FakeWorker()));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('Help for this screen').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Walk me through'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Step 1 of 10. Emergency Stop'), findsOneWidget);
    expect(CheHelp.highlighted.value, 'emergency stop');
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Step 2 of 10. Pause all'), findsOneWidget);
    expect(CheHelp.highlighted.value, 'pause all');
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(CheHelp.highlighted.value, isNull);

    await tester.tap(find.bySemanticsLabel('Help for this screen').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Help Center'));
    await tester.pumpAndSettle();
    expect(find.text('Help Center'), findsOneWidget);
    expect(find.text('Strategy Control Center'), findsOneWidget);
  });

  testWidgets('review of #386: no false "Highlighted"; "Strategy switch" is help; spoken next/back/done move the tour; duplicate panels keep their targets; the Help Center keeps the screen', (tester) async {
    tester.view.physicalSize = const Size(900, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    addTearDown(CheHelp.clear);
    await tester.pumpWidget(host(FakeWorker()));
    await tester.pumpAndSettle();

    // A help item with no outline target on screen is never reported as highlighted.
    final extra = CheHelp.register(tester.element(find.byType(CheStrategyControlsPanel)),
        () => const CheHelpTopic(title: 'Extra', summary: '', items: [CheControlHelp(name: 'Chart markers', does: 'Marks fills on the chart')]));
    addTearDown(() => CheHelp.unregister(extra));
    expect(CheHelp.canHighlight('Chart markers'), isFalse);
    expect(CheHelp.answer(const CheHelpRequest(CheHelpKind.show, 'chart markers')), startsWith('I cannot outline Chart markers on this screen'));
    expect(CheHelp.highlighted.value, isNull);
    expect(CheHelp.answer(const CheHelpRequest(CheHelpKind.show, 'emergency stop')), startsWith('Highlighted. Emergency Stop'));

    // The literal on-screen control name is help, even though it says "strategy".
    final sw = cheHelpIntent('what does the Strategy switch do?');
    expect(sw?.kind, CheHelpKind.explain);
    expect(CheHelp.answer(sw!), startsWith('Strategy switch: Pauses or resumes one strategy'));
    expect(cheHelpIntent('what does the EMA strategy do'), isNull);

    // Spoken steps move the walkthrough; outside one, "next" is not help.
    expect(cheHelpIntent('next'), isNull);
    await tester.tap(find.bySemanticsLabel('Help for this screen').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Walk me through'));
    await tester.pumpAndSettle();
    final next = cheHelpIntent('next');
    expect(next?.kind, CheHelpKind.step);
    expect(CheHelp.answer(next!), startsWith('Step 2 of 11. Pause all'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Step 2 of 11. Pause all'), findsOneWidget, reason: 'the banner follows the voice');
    expect(CheHelp.answer(cheHelpIntent('back')!), startsWith('Step 1 of 11. Emergency Stop'));
    expect(CheHelp.answer(cheHelpIntent('done')!), 'Walkthrough finished.');
    await tester.pumpAndSettle();
    expect(CheHelp.walking, isFalse);
    expect(find.textContaining('Step 1 of 11'), findsNothing);

    // A second Control Center on a pushed page, then popped: the room's own targets still work.
    final nav = tester.state<NavigatorState>(find.byType(Navigator).first);
    nav.push(MaterialPageRoute<void>(builder: (_) => Scaffold(body: SingleChildScrollView(child: CheStrategyControlsPanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: (_) {}, client: FakeWorker().client, refresh: const Duration(hours: 1))))));
    await tester.pumpAndSettle();
    expect(CheHelp.canHighlight('Emergency Stop'), isTrue);
    nav.pop();
    await tester.pumpAndSettle();
    expect(CheHelp.canHighlight('Emergency Stop'), isTrue, reason: 'the still-mounted panel keeps its target');

    // The Help Center keeps the screen it was opened from.
    nav.push(CheHelpCenter.route(screen: const [CheHelpTopic(title: 'Chat', summary: '', items: [CheControlHelp(name: 'New chat', does: 'Starts a new conversation')])]));
    await tester.pumpAndSettle();
    expect(find.text('Chat'), findsOneWidget);
    expect(find.text('Strategy Control Center'), findsOneWidget);
  });
}
