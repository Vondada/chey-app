// VoiceOver route for long-press actions (docs/CHE_A11Y_AUDIT.md items 8 and 9): a long press is awkward with
// VoiceOver, so the home chat bubbles expose the same message actions as a named custom action.
import 'package:chey/home/che_home_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

/// Every semantics node in the tree that carries a custom action, with its labels.
List<(SemanticsNode, List<String?>)> _customActionNodes(WidgetTester tester) {
  final found = <(SemanticsNode, List<String?>)>[];
  void visit(SemanticsNode node) {
    final ids = node.getSemanticsData().customSemanticsActionIds ?? const <int>[];
    if (ids.isNotEmpty) found.add((node, ids.map((id) => CustomSemanticsAction.getAction(id)?.label).toList()));
    node.visitChildren((child) {
      visit(child);
      return true;
    });
  }

  var root = tester.getSemantics(find.byType(Scaffold));
  while (root.parent != null) {
    root = root.parent!;
  }
  visit(root);
  return found;
}

void main() {
  testWidgets('an owner bubble with message actions offers them to VoiceOver by name', (tester) async {
    final handle = tester.ensureSemantics();
    var opened = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: CheHomeUserBubble(text: 'buy milk', animate: false, onLongPress: () => opened++)),
    ));
    await tester.pumpAndSettle();

    final nodes = _customActionNodes(tester);
    expect(nodes.expand((n) => n.$2), contains('Message actions'));
    final node = nodes.firstWhere((n) => n.$2.contains('Message actions')).$1;
    final id = (node.getSemanticsData().customSemanticsActionIds ?? const <int>[])
        .firstWhere((id) => CustomSemanticsAction.getAction(id)?.label == 'Message actions');
    node.owner!.performAction(node.id, SemanticsAction.customAction, id);
    await tester.pump();
    expect(opened, 1, reason: 'the named action runs the same handler as the long press');
    handle.dispose();
  });

  testWidgets('a bubble without actions adds no empty custom action', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: CheHomeUserBubble(text: 'hello', animate: false))));
    await tester.pumpAndSettle();
    expect(_customActionNodes(tester), isEmpty);
    handle.dispose();
  });
}
