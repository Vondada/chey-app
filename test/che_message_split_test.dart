import 'package:chey/mailbox/che_message_split.dart';
import 'package:flutter_test/flutter_test.dart';

String words(Iterable<String> parts) => parts.join(' ').split(RegExp(r'\s+')).join(' ');

void main() {
  test('short messages stay one bubble', () {
    expect(cheSplitMessage('  Hello CHE.  '), ['Hello CHE.']);
  });

  test('long messages split at paragraphs, then sentences, never losing words', () {
    final paragraph = List.filled(30, 'The crew finished the review.').join(' ');
    final text = '$paragraph\n\n$paragraph\n\n${List.filled(80, 'word').join(' ')}';
    final parts = cheSplitMessage(text, maxChars: 600);
    expect(parts.length, greaterThan(2));
    for (final p in parts) {
      expect(p.length, lessThanOrEqualTo(600));
      expect(p, isNot(startsWith(' ')));
    }
    expect(words(parts), words([text]));
    expect(parts.first.endsWith('.'), isTrue, reason: 'cuts at a sentence end, not mid-sentence');
  });

  test('one unbroken run still splits without losing characters', () {
    final blob = 'x' * 1500;
    final parts = cheSplitMessage(blob, maxChars: 600);
    expect(parts.join(), blob);
  });
}
