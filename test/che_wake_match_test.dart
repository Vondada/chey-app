import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_wake_match.dart';

void main() {
  test('CHE wake spellings are accepted', () {
    for (final word in ['CHE', 'Chay', 'Chey', 'Shay', 'Chai', 'Che']) {
      expect(cheIsWake('$word what time is it'), isTrue, reason: word);
    }
  });

  test('wake opens remainder without requiring another wake name', () {
    expect(cheWakeRemainder('Hey Chay, read this to me'), 'read this to me');
  });
}
