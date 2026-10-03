import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_speech_chunker.dart';

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

  test('speech chunker groups sentences into long fluent chunks', () {
    final c = CheSpeechChunker(targetChars: 60);
    final text = 'First one. ' + List.filled(6, 'This is a normal spoken sentence.').join(' ');
    final chunks = [...c.addCumulative(text), ...c.flush()];
    expect(chunks.first, 'First one.');
    expect(chunks.length, lessThan(5));
    expect(chunks.skip(1).every((chunk) => chunk.length >= 60 || chunk == chunks.last), isTrue);
    expect(chunks.join(' '), text);
  });

  test('speech chunker never speaks code, even when a fence arrives in pieces', () {
    final c = CheSpeechChunker();
    final out = <String>[];
    out.addAll(c.addCumulative('Here it is. `'));
    out.addAll(c.addCumulative('Here it is. ```dart\nfinal x = 1;'));
    out.addAll(c.addCumulative('Here it is. ```dart\nfinal x = 1;\n``` All done.'));
    out.addAll(c.flush());
    expect(out, ['Here it is.', 'All done.']);
  });
}

