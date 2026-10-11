import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_speech_chunker.dart';

void main() {
  test('a long Brain Read aloud uses Mary-sized clips in original order', () {
    final memory = List.generate(
      25,
      (i) => 'Atlas researched evaluation dataset number $i. '
             'Keep testing the active branch before merging results.',
    ).join(' ');
    expect(memory.length, greaterThan(800));
    final clips = cheReadAloudChunks(memory);
    expect(clips.length, greaterThan(1));
    expect(clips.every((clip) => clip.isNotEmpty && clip.length <= 640), isTrue);
    expect(clips.join(' '), memory);
  });

  test('single-line and multiline readings remain complete and free of empty clips', () {
    expect(cheReadAloudChunks('  Hi, sir.  '), ['Hi, sir.']);
    const message = 'First line.\n  Second line, with  more spaces!';
    expect(cheReadAloudChunks(message), ['First line. Second line, with more spaces!']);
    expect(cheReadAloudChunks('  '), isEmpty);
  });

  test('extremely long words are still bounded and never hang', () {
    final chunks = cheReadAloudChunks('A' * 2050);
    expect(chunks.length, 4);
    expect(chunks.every((chunk) => chunk.length <= 640), isTrue);
    expect(chunks.join(''), 'A' * 2050);
  });

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
    final text = "First one. ${List.filled(6, 'This is a normal spoken sentence.').join(' ')}";
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

