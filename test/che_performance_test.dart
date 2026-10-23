// Performance guards for the app (owner, 2026-10-22: "make sure every time we add features she doesn't lag"). An idle
// screen must schedule no frames: today's new screens are held to the same rule as the ones in che_latency_test.dart.
// The over-budget note from the Worker is quiet text, never a live region or speech.
import 'package:chey/che_ui/che_performance_note.dart';
import 'package:chey/security/che_cyber_world.dart';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _nodes = [CheWorldNode(id: 'worker', kind: 'server', label: 'Server', status: 'ok', events24h: 0)];

void main() {
  testWidgets('the Cyber World with nothing open draws once and stops', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: CheCyberWorld(nodes: _nodes))));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.hasScheduledFrame, isFalse, reason: 'an idle security map must not keep the phone drawing');
  });

  testWidgets('a pulsing Cyber World on a hidden tab (TickerMode off) schedules no frames', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: TickerMode(enabled: false, child: CheCyberWorld(nodes: _nodes, pulses: ['worker']))),
    ));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.hasScheduledFrame, isFalse, reason: 'a hidden screen must not animate');
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: CheCyberWorld(nodes: _nodes, pulses: ['worker']))));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.hasScheduledFrame, isTrue, reason: 'on screen, a real event still pulses');
    await tester.pumpWidget(const SizedBox());
  });

  test('the performance note shows only when the Worker says CHE is over budget', () {
    expect(chePerformanceNote(null), isNull);
    expect(chePerformanceNote({'status': 'ok'}), isNull);
    expect(chePerformanceNote({'status': 'slow', 'note': ''}), isNull);
    expect(chePerformanceNote({'status': 'slow', 'note': 'CHE is slower than her budget on replies.'}), 'CHE is slower than her budget on replies.');
  });

  testWidgets('the performance note is quiet: labelled for VoiceOver, never a live region', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: ChePerformanceNote(note: 'CHE is slower than her budget on replies.'))));
    final node = tester.getSemantics(find.bySemanticsLabel(RegExp('^Performance: ')));
    expect(node.label, contains('Performance: CHE is slower'));
    expect(node.getSemanticsData().flagsCollection.isLiveRegion, isFalse);
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.hasScheduledFrame, isFalse, reason: 'the note does not animate');
    handle.dispose();
  });
}
