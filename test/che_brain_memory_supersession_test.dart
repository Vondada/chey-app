import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_ui/che_brain.dart';

void main() {
  test('new favorite memory supersedes the old value', () async {
    final brain = CheBrain();
    await brain.addFact('[Knowledge] Favorite drink: Cola');
    await brain.addFact('[Knowledge] My favorite drink is Sprite');

    final favorites = brain.facts
        .where((fact) => fact.text.toLowerCase().contains('favorite drink'))
        .map((fact) => fact.text)
        .toList();

    expect(favorites, hasLength(1));
    expect(favorites.single.toLowerCase(), contains('sprite'));
  });
}
