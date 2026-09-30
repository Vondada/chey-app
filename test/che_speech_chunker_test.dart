import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_speech_chunker.dart';

void main() {
  test('speech chunker preserves streaming order without duplicates', () {
    final c = CheSpeechChunker();
    expect(c.addCumulative('Hello'), isEmpty);
    expect(c.addCumulative('Hello there. Next'), ['Hello there.']);
    expect(c.addCumulative('Hello there. Next sentence!'), ['Next sentence!']);
    expect(c.flush(), isEmpty);
  });

  test('speech chunker flushes unfinished tail', () {
    final c = CheSpeechChunker();
    c.addCumulative('Read this slowly');
    expect(c.flush(), ['Read this slowly']);
  });
}
