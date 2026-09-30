import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_wake_match.dart';

void main() {
  test('trailing fillers keep the turn open while the owner thinks', () {
    expect(cheSoundsUnfinished('open my calendar and um'), isTrue);
    expect(cheSoundsUnfinished('remind me to call Mom because'), isTrue);
    expect(cheSoundsUnfinished('So,'), isTrue);
  });

  test('complete sentences are sent', () {
    expect(cheSoundsUnfinished('what time is it'), isFalse);
    expect(cheSoundsUnfinished('open my calendar.'), isFalse);
    expect(cheSoundsUnfinished(''), isFalse);
  });
}
