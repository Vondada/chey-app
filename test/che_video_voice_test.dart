import 'package:flutter_test/flutter_test.dart';
import 'package:chey/browser/che_video_voice.dart';

void main() {
  test('one-step video searches open CHE browser on YouTube results', () {
    final a = CheVideoVoiceCommand.parse('Che, search YouTube for lofi jazz')!;
    expect(a.query, 'lofi jazz');
    expect(a.url, 'https://m.youtube.com/results?search_query=lofi+jazz');
    expect(CheVideoVoiceCommand.parse('search video results for mars landing')!.query, 'mars landing');
    final n = CheVideoVoiceCommand.parse('find new videos about SpaceX')!;
    expect(n.newest, isTrue);
    expect(n.query, 'spacex');
    expect(n.url, contains('&sp=CAI%253D'));
    expect(CheVideoVoiceCommand.parse('play the video never gonna give you up')!.query, 'never gonna give you up');
    expect(CheVideoVoiceCommand.parse('play cat compilation video')!.query, 'cat compilation');
    expect(CheVideoVoiceCommand.parse('find new videos')!.url, 'https://m.youtube.com/feed/subscriptions');
    expect(a.spoken, contains('play number one'));
  });

  test('other commands are left alone', () {
    for (final q in ['make a video about cats', 'play', 'play number one', 'play it', 'search for apples', 'pause the video', 'open youtube', 'show my recent videos']) {
      expect(CheVideoVoiceCommand.parse(q), isNull, reason: q);
    }
  });
}
