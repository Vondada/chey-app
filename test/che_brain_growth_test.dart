import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_ui/che_brain.dart';

void main() {
  test('an old fact that matches the message still reaches the prompt', () async {
    final brain = CheBrain();
    await brain.addFact('[Knowledge] The garage keypad word is pineapple');
    for (var i = 0; i < 60; i++) {
      await brain.addFact('[Knowledge] Filler note number $i about ordinary weekday errands');
    }
    final context = brain.contextFor('what is the garage keypad word', const []).join('\n');
    expect(context, contains('pineapple'));
  });

  test('the brain has no capacity limit by default', () async {
    final brain = CheBrain();
    expect(brain.maxFacts, isNull);
    expect(brain.maxJournal, isNull);
    for (var i = 0; i < 400; i++) {
      await brain.addFact('[Knowledge] Unlimited fact number $i');
    }
    expect(brain.facts.length, greaterThanOrEqualTo(400));
  });

  test('facts past the live limit leave the working set instead of growing it forever', () async {
    final brain = CheBrain(maxFacts: 3);
    for (var i = 0; i < 5; i++) {
      await brain.addFact('[Knowledge] Bounded fact $i');
    }
    expect(brain.facts, hasLength(3));
    expect(brain.facts.first.text, contains('Bounded fact 4'));
  });
}
