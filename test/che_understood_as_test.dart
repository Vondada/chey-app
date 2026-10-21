import 'package:chey/che_ui/che_understood_as.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('understood_as is read from a done event or a held reply, and only when present', () {
    expect(cheUnderstoodAs({'type': 'done', 'understood_as': 'do: buy 3 apples online now | needs yes: money'}),
        'do: buy 3 apples online now | needs yes: money');
    expect(cheUnderstoodAs({'held_for_owner': true, 'understood_as': ' do: Delete my last note | needs yes: delete '}),
        'do: Delete my last note | needs yes: delete');
    expect(cheUnderstoodAs({'type': 'done'}), isNull);
    expect(cheUnderstoodAs({'type': 'done', 'understood_as': '  '}), isNull);
    expect(cheUnderstoodAs('not a map'), isNull);
  });

  testWidgets('the line is quiet visible text with one VoiceOver label', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: CheUnderstoodAs(text: "plan (owner): go to Walmart tomorrow; buy apples | not: don't order anything yet")),
    ));
    const line = "Understood as: plan (owner): go to Walmart tomorrow; buy apples | not: don't order anything yet";
    expect(find.text(line), findsOneWidget);
    expect(find.bySemanticsLabel(line), findsOneWidget);
    final labelled = find.byWidgetPredicate((w) => w is Semantics && w.properties.label == line);
    expect(labelled, findsOneWidget);
    expect(tester.widget<Semantics>(labelled).properties.liveRegion, isNot(true), reason: 'shown, never announced by itself');
    semantics.dispose();
  });
}
