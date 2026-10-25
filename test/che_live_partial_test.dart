// Handoff 8f: the native recognizer's partial words show live in the composer, never over typed text.
import 'package:chey/che_live_partial.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  String? show(String partial, {String composer = '', String last = '', bool sending = false, bool asleep = false}) =>
      cheComposerForPartial(partial: partial, composer: composer, lastShown: last, sending: sending, asleepForWake: asleep);

  test('live words fill an empty composer and grow as he speaks', () {
    expect(show('book a'), 'book a');
    expect(show('book a table', composer: 'book a', last: 'book a'), 'book a table');
  });

  test('typed text is never overwritten', () {
    expect(show('book a table', composer: 'my own words', last: 'book a'), isNull);
    expect(show('hello', composer: 'typed'), isNull);
  });

  test('nothing shows while sending, while asleep for the wake word, or for empty or unchanged text', () {
    expect(show('book a table', sending: true), isNull);
    expect(show('book a table', asleep: true), isNull);
    expect(show('   '), isNull);
    expect(show('same', composer: 'same', last: 'same'), isNull);
  });
}
