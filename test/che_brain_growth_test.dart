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

  test('the live brain keeps far more than the old 300 facts', () {
    expect(CheBrain().maxFacts, greaterThanOrEqualTo(5000));
    expect(CheBrain().maxJournal, greaterThanOrEqualTo(1000));
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
