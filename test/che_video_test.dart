import 'package:chey/che_video.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Recent Videos accepts spoken commands without matching discussion', () {
    for (final text in [
      'Show my recent videos',
      'CHE, open recent videos.',
      'Open me my recent video',
    ]) {
      expect(CheVideo.isRecentCommand(text), isTrue);
    }
    expect(
      CheVideo.isRecentCommand('Explain how to open recent videos'),
      isFalse,
    );
  });
  test(
    'explicit video commands route once; discussion and negations do not',
    () {
      for (final command in [
        'Make a video about pirates',
        'CHE, create me a faceless video on pirates',
        'Generate a stick figure video about pirates',
      ]) {
        expect(CheVideo.topicFromCommand(command), 'pirates');
      }
      for (final message in [
        "Don't make a video about pirates",
        'Explain how to make a video about pirates',
        'Can you make a video?',
        'Make a video about',
      ]) {
        expect(CheVideo.topicFromCommand(message), isNull);
      }
    },
  );
  test('only valid HTTP file receipts enter Recent Videos', () {
    expect(CheVideo.isMediaUrl('https://example.com/video.mp4'), isTrue);
    for (final value in [
      'http-fake',
      'javascript:alert(1)',
      'https://',
      'https://user:secret@example.com/a',
    ]) {
      expect(CheVideo.isMediaUrl(value), isFalse);
    }
  });
}
