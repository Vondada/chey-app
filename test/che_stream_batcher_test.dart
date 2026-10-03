import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_stream_batcher.dart';

void main() {
  test('speech chunker preserves streaming order without duplicates', () {
    final c = CheSpeechChunker();
    expect(c.addCumulative('Hello'), isEmpty);
    expect(c.addCumulative('Hello there. Next'), ['Hello there.']);
    // Later sentences are grouped so the voice reads them in one breath.
    expect(c.addCumulative('Hello there. Next sentence!'), isEmpty);
    expect(c.flush(), ['Next sentence!']);
  });

  test('speech chunker flushes unfinished tail', () {
    final c = CheSpeechChunker();
    c.addCumulative('Read this slowly');
    expect(c.flush(), ['Read this slowly']);
  });

  test('stream batcher emits latest value, not every token', () async {
    final values = <String>[];
    final b = CheStreamBatcher(values.add, interval: const Duration(milliseconds: 10));
    b.add('a');
    b.add('ab');
    b.add('abc');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(values, ['abc']);
    b.dispose();
  });
}
