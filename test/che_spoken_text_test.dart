import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_spoken_text.dart';
import 'package:chey/che_stream_batcher.dart' show cheSentenceEnd;

void main() {
  test('Markdown becomes natural speech without formatting symbols', () {
    const reply = '## Summary\n'
        'Here is **what I found** for you:\n'
        '- Gmail has *three* new messages\n'
        '- Drive is `in_sync()`\n'
        '\n'
        '1. Reply to John\n'
        '2. Archive the rest\n'
        '\n'
        '| Name | Status |\n|---|---|\n| Atlas | done |\n'
        '---\n'
        'See [the report](https://example.com/r/1?x=2) or https://www.github.com/Vondada/chey-app/pull/337 ✅';
    final spoken = cheSpeakableText(reply);
    expect(spoken,
        'Summary. Here is what I found for you: Gmail has three new messages. Drive is in sync. '
        '1, Reply to John. 2, Archive the rest. Name, Status. Atlas, done. '
        'See the report or github.com done');
    for (final symbol in ['#', '*', '`', '|', '[', '](', 'https', '---']) {
      expect(spoken.contains(symbol), isFalse, reason: 'never reads "$symbol" aloud');
    }
  });

  test('plain sentences pass through unchanged, and symbols are said as words', () {
    expect(cheSpeakableText('I sent the email to John, sir.'), 'I sent the email to John, sir.');
    expect(cheSpeakableText('Build -> test -> ship & relax, e.g. tonight.'), 'Build to test to ship and relax, for example tonight.');
    expect(cheSpeakableText('It takes ~5 minutes, 2 * 3 times.'), 'It takes about 5 minutes, 2 times 3 times.');
    expect(cheSpeakableText('```dart\nfinal x = 1;\n```\nDone!!!'), 'Done!');
    expect(cheSpeakableText('snake_case and file_name stay words'), 'snake_case and file_name stay words');
    // Review of #338: symbols keep their meaning, names and addresses stay.
    expect(cheSpeakableText('If 5 > 3 and a <= b, stop.'), 'If 5 greater than 3 and a at most b, stop.');
    expect(cheSpeakableText('Send it to <john@example.com> today.'), 'Send it to john@example.com today.');
    expect(cheSpeakableText('Open VS Code, then compare A vs B.'), 'Open VS Code, then compare A versus B.');
    expect(cheSpeakableText('Use <b>bold</b> text.'), 'Use bold text.');
  });

  test('meaning survives: choices, checkboxes, signs, comparisons and directions (second review of #338)', () {
    expect(cheSpeakableText('Say [1] to send or [2] to cancel.'), 'Say 1 to send or 2 to cancel.');
    expect(cheSpeakableText('Rates rose sharply.[3] Then[^2] fell.'), 'Rates rose sharply. Then fell.');
    expect(cheSpeakableText('- [x] Paid rent\n- [ ] Paid water bill'), 'Paid rent, done. Paid water bill, not done.');
    expect(cheSpeakableText('The temp is <-5°C tonight.'), 'The temp is less than -5°C tonight.');
    expect(cheSpeakableText('| Uptime | > 99% |'), 'Uptime, more than 99%.');
    expect(cheSpeakableText('- > 5 users'), 'more than 5 users.');
    expect(cheSpeakableText('x <= -3 and y > 2'), 'x at most -3 and y greater than 2');
    expect(cheSpeakableText('Meet ~~Tuesday~~ Wednesday.'), 'Meet Tuesday (crossed out) Wednesday.');
    expect(cheSpeakableText('NQ 🔻 0.4%, ES 🔺 0.2%'), 'NQ down 0.4%, ES up 0.2%');
  });

  test('a sentence ends only where a person would stop', () {
    String first(String text, {bool force = false}) {
      final end = cheSentenceEnd(text, 0, force: force);
      return end < 0 ? '' : text.substring(0, end).trim();
    }

    expect(first('I spoke with Dr. Smith today. Then'), 'I spoke with Dr. Smith today.');
    expect(first('Use a tool, e.g. this one. Next'), 'Use a tool, e.g. this one.');
    expect(first('J. R. Tolkien wrote it. More'), 'J. R. Tolkien wrote it.');
    expect(first('It costs 3.5 dollars. More'), 'It costs 3.5 dollars.');
    // Streaming text that stops right after a period may continue ("3." → "3.5").
    expect(first('The price is 3.'), '');
    expect(first('The price is 3.', force: true), 'The price is 3.');
    expect(first('1. First option\n2. Second'), '1. First option');
    expect(first('## Plan\nThe rest'), '## Plan');
    expect(first('Wait! What happened? Next'), 'Wait!');
  });
}
