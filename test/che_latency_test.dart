// Latency (owner, 2026-10-22: "she's moving slow now, kind of laggy when I click on different buttons"). The app kept
// drawing frames nobody could see: hidden tabs' animations, idle cards' spinning borders and idle figures on a hidden
// Office tab. These tests prove an idle or hidden screen schedules no frames, and that HUD panels do not blur.
import 'package:chey/che_ui/che_agents.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('an idle glow card is drawn still; an active one animates', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: GlowCard(child: Text('idle')))));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.hasScheduledFrame, isFalse, reason: 'an idle card must not keep the phone drawing');

    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: GlowCard(active: true, child: Text('busy')))));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.hasScheduledFrame, isTrue, reason: 'an active card still shows its working border');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('figures on a hidden tab (TickerMode off) stop the idle clock; on screen it runs', (tester) async {
    const agent = CheAgent(id: 'nova', name: 'Nova', role: 'Research', status: CheAgentStatus.idle);
    final clock = CheIdleLifeClock.instance;
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: TickerMode(enabled: false, child: CheMiniPerson(agent: agent, painted: true))),
    ));
    var before = clock.t;
    await tester.pump(const Duration(milliseconds: 600));
    expect(clock.t, before, reason: 'a hidden tab must not keep the idle clock redrawing its figures');

    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: TickerMode(enabled: true, child: CheMiniPerson(agent: agent, painted: true))),
    ));
    before = clock.t;
    await tester.pump(const Duration(milliseconds: 600));
    expect(clock.t, isNot(before), reason: 'the visible figure keeps its idle life');

    // Hidden again: the clock stops.
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: TickerMode(enabled: false, child: CheMiniPerson(agent: agent, painted: true))),
    ));
    before = clock.t;
    await tester.pump(const Duration(milliseconds: 600));
    expect(clock.t, before);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('HUD glass panels do not blur unless asked, and the backdrop repaints on its own layer', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: CheHudBackdrop(child: Center(child: CheGlass(padding: EdgeInsets.all(16), child: Text('panel')))),
    ));
    expect(find.byType(BackdropFilter), findsNothing, reason: 'a blur per panel costs a full-screen pass every frame');
    expect(find.descendant(of: find.byType(CheHudBackdrop), matching: find.byType(RepaintBoundary)), findsWidgets);

    await tester.pumpWidget(const MaterialApp(home: CheGlass(blur: true, child: Text('bar'))));
    expect(find.byType(BackdropFilter), findsOneWidget);
  });
}
