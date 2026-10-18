import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_speech_chunker.dart';
import 'package:chey/che_spoken_text.dart';

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

  test('the first Read This clip is short so the voice starts sooner', () {
    final article = List.generate(30, (i) => 'Sentence number $i tells part of the story.').join(' ');
    final clips = cheReadAloudChunks(article);
    expect(clips.first.length, lessThanOrEqualTo(240));
    expect(clips.skip(1).every((clip) => clip.length <= 640), isTrue);
    expect(clips.join(' '), article);
  });

  test('single-line and multiline readings remain complete and free of empty clips', () {
    expect(cheReadAloudChunks('  Hi, sir.  '), ['Hi, sir.']);
    const message = 'First line.\n  Second line, with  more spaces!';
    expect(cheReadAloudChunks(message), ['First line. Second line, with more spaces!']);
    expect(cheReadAloudChunks('  '), isEmpty);
  });

  test('extremely long words are still bounded and never hang', () {
    final text = List.filled(2050, 'A').join();
    final chunks = cheReadAloudChunks(text);
    expect(chunks.length, 4);
    expect(chunks.every((chunk) => chunk.length <= 640), isTrue);
    expect(chunks.join(''), text);
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

  test('streaming never cuts a number or an abbreviation in half (owner, 2026-10-18)', () {
    final c = CheSpeechChunker();
    final out = <String>[];
    out.addAll(c.addCumulative('The price is 3.'));
    expect(out, isEmpty, reason: '"3." may be the start of "3.5"');
    out.addAll(c.addCumulative('The price is 3.5 dollars. I asked Dr.'));
    out.addAll(c.addCumulative('The price is 3.5 dollars. I asked Dr. Smith about it, e.g. the fee. He agreed.'));
    out.addAll(c.flush());
    expect(out, ['The price is 3.5 dollars.', 'I asked Dr. Smith about it, e.g. the fee. He agreed.']);
  });

  test('no streamed chunk is longer than a clip, and a long sentence breaks at a phrase', () {
    final c = CheSpeechChunker();
    final long = 'Here is ${List.generate(40, (i) => 'item number $i, which matters').join(' and ')}';
    final out = [...c.addCumulative('Okay. $long.'), ...c.flush()];
    expect(out.first, 'Okay.');
    expect(out.every((chunk) => chunk.length <= 640), isTrue, reason: 'ElevenLabs refuses clips over 800 characters');
    for (final chunk in out.skip(1).take(out.length - 2)) {
      expect(chunk, endsWith(','), reason: 'a cut falls after a comma, not mid-phrase: $chunk');
    }
    expect(out.join(' ').replaceAll(RegExp(r'\s+'), ' '), 'Okay. $long.');
  });

  test('lists and headings keep their lines so each item gets its own pause', () {
    final c = CheSpeechChunker(targetChars: 40, secondTargetChars: 40);
    final out = [...c.addCumulative('## Today\n- Gmail\n- Drive\n- Calendar\n'), ...c.flush()];
    expect(out.first, '## Today');
    expect(out.skip(1).join('\n'), '- Gmail\n- Drive\n- Calendar');
    expect(cheSpeakableText(out.skip(1).join('\n')), 'Gmail. Drive. Calendar.');
  });

  test('Read This cuts at sentence ends or phrase breaks, never mid-phrase', () {
    final text = List.generate(20, (i) => 'Part $i of the plan covers the budget, the schedule, and the team').join('; ');
    final clips = cheReadAloudChunks(text);
    expect(clips.length, greaterThan(1));
    for (final clip in clips.take(clips.length - 1)) {
      expect(clip, matches(RegExp(r'[,;]$')), reason: clip);
    }
    expect(clips.join(' '), text);
  });

  test('a sentence waits for the next word, and ~~~ fences are never read (review of #338)', () {
    final c = CheSpeechChunker();
    final out = <String>[];
    out.addAll(c.addCumulative('Well... '));
    expect(out, isEmpty, reason: '"Well..." may go on');
    out.addAll(c.addCumulative('Well... maybe not. Here is code:\n~~~\nrm -rf /\n~~~\nAfter that it works.'));
    out.addAll(c.flush());
    expect(out.first, 'Well... maybe not.');
    expect(out.join(' ').contains('rm -rf'), isFalse);
    expect(out.join(' '), contains('After that it works.'));
  });
}

