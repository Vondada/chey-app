import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:chey/che_speech_playback.dart';

/// A native player stand-in. A clip lasts one second per byte, so the bytes come from the text length.
class FakePlayer implements CheClipPlayer {
  FakePlayer({this.caps = const CheClipPlayerCapabilities(pause: true, seek: true, rate: true), this.canMeasure = true});

  final CheClipPlayerCapabilities caps;
  final bool canMeasure;
  final List<String> calls = [];
  Duration pos = Duration.zero;

  @override
  CheClipPlayerCapabilities get capabilities => caps;

  @override
  Future<Duration?> load(Uint8List bytes, {Duration offset = Duration.zero, double rate = 1.0}) async {
    calls.add('load:${bytes.length}@${offset.inSeconds}x$rate');
    pos = offset;
    return Duration(seconds: bytes.length);
  }

  @override
  Future<void> resume() async => calls.add('resume');

  @override
  Future<void> pause() async => calls.add('pause');

  @override
  Future<void> stop() async => calls.add('stop');

  @override
  Future<void> setRate(double rate) async => calls.add('rate:$rate');

  @override
  Future<Duration> position() async => pos;

  @override
  Future<Duration?> durationOf(Uint8List bytes) async => canMeasure ? Duration(seconds: bytes.length) : null;
}

const voice = CheSpeechVoice(voiceId: 'v1', model: 'm1', settings: 's1');

/// Counts every request to the provider. Each clip costs one request.
class Provider {
  int requests = 0;
  final Map<String, Completer<Uint8List?>> held = {};
  final Set<String> holdTexts = {};

  Future<Uint8List?> call(String text, CheSpeechVoice _) {
    requests++;
    if (holdTexts.contains(text)) {
      final c = Completer<Uint8List?>();
      held[text] = c;
      return c.future;
    }
    return Future.value(Uint8List(text.length));
  }

  CheSpeechSource source({CheSpeechCache? cache}) => CheSpeechSource(synthesize: call, cache: cache);
}

/// Lets queued microtasks and prefetch requests finish.
Future<void> settle() async {
  for (var i = 0; i < 10; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  test('pause stops the audio at once, keeps the exact position, and requests nothing more', () async {
    final provider = Provider();
    final player = FakePlayer();
    final playback = CheSpeechPlayback(clips: ['aaaa', 'bbbbbb', 'cc', 'dddddd', 'eeeeee'], voice: voice, source: provider.source(), player: player, prefetchLimit: 1);
    await playback.play();
    await settle();
    player.pos = const Duration(seconds: 2);
    final requestsAtPause = provider.requests;

    expect(await playback.pause(), isTrue);
    expect(player.calls.last, 'pause');
    expect(playback.state, CheSpeechState.paused);
    expect(playback.position, const Duration(seconds: 2));
    expect(playback.prefetchOpen, isFalse);

    await settle();
    expect(provider.requests, requestsAtPause, reason: 'pausing suspends future synthesis');
  });

  test('resume continues from the saved position without restarting the clip', () async {
    final provider = Provider();
    final player = FakePlayer();
    final playback = CheSpeechPlayback(clips: ['aaaa', 'bbbbbb'], voice: voice, source: provider.source(), player: player);
    await playback.play();
    player.pos = const Duration(seconds: 3);
    await playback.pause();
    final loadsBefore = player.calls.where((c) => c.startsWith('load')).length;

    await playback.play();
    expect(player.calls.last, 'resume');
    expect(player.calls.where((c) => c.startsWith('load')).length, loadsBefore, reason: 'resume is not a reload');
    expect(playback.state, CheSpeechState.playing);
    expect(playback.position, const Duration(seconds: 3));
  });

  test('rewind and fast-forward cross clip boundaries using audio that already exists', () async {
    final provider = Provider();
    final player = FakePlayer();
    final playback = CheSpeechPlayback(clips: ['aaaa', 'bbbbbb', 'cc'], voice: voice, source: provider.source(), player: player);
    await playback.play();
    await settle();
    player.pos = const Duration(seconds: 3);
    final requests = provider.requests;

    expect(await playback.seekBy(const Duration(seconds: 3)), CheSeekResult.moved);
    expect(playback.clipIndex, 1);
    expect(playback.position, const Duration(seconds: 6));
    expect(player.calls.last, 'load:6@2x1.0');

    expect(await playback.seekBy(const Duration(seconds: -4)), CheSeekResult.moved);
    expect(playback.clipIndex, 0);
    expect(playback.position, const Duration(seconds: 2));
    expect(player.calls.last, 'load:4@2x1.0');
    expect(provider.requests, requests, reason: 'seeking reuses cached audio');
  });

  test('changing speed sets the local rate and never synthesizes', () async {
    final provider = Provider();
    final player = FakePlayer();
    final playback = CheSpeechPlayback(clips: ['aaaa', 'bbbbbb'], voice: voice, source: provider.source(), player: player);
    await playback.play();
    await settle();
    final requests = provider.requests;

    expect(await playback.setRate(1.5), isTrue);
    expect(player.calls.last, 'rate:1.5');
    expect(await playback.setRate(3.0), isFalse, reason: 'only the owner\'s five speeds are allowed');
    expect(provider.requests, requests);
  });

  test('replaying cached audio makes zero additional provider requests', () async {
    final provider = Provider();
    final player = FakePlayer();
    final playback = CheSpeechPlayback(clips: ['aaaa', 'bbbbbb', 'cc'], voice: voice, source: provider.source(), player: player);
    await playback.play();
    await settle();
    await playback.stop();
    final requests = provider.requests;

    expect(await playback.replay(), CheSeekResult.moved);
    await playback.play();
    await settle();
    expect(provider.requests, requests, reason: 'every clip was cached on the first play');
  });

  test('stop cancels pending playback: nothing plays after it, and audio already paid for is kept and counted', () async {
    final provider = Provider()..holdTexts.add('bbbbbb');
    final player = FakePlayer();
    final source = provider.source();
    final playback = CheSpeechPlayback(clips: ['aaaa', 'bbbbbb'], voice: voice, source: source, player: player);
    await playback.play();
    await settle();
    await playback.stop();
    expect(playback.state, CheSpeechState.stopped);

    provider.held['bbbbbb']!.complete(Uint8List(6));
    await settle();
    expect(player.calls.where((c) => c == 'load:6@0x1.0'), isEmpty, reason: 'stopped audio never plays');
    expect(source.cached('bbbbbb', voice), isNotNull, reason: 'the paid audio is kept for a later replay');
    expect(source.usage.cancelledAfterRequest, 1);
  });

  test('two requests for the same text share one provider request', () async {
    final provider = Provider();
    final source = provider.source();
    final a = source.clip('hello there', voice, allowSpend: true);
    final b = source.clip('hello there', voice, allowSpend: true);
    await Future.wait([a, b]);
    expect(provider.requests, 1);
    expect(source.usage.sharedInFlight, 1);
  });

  test('different text, voice or settings never share audio', () async {
    final provider = Provider();
    final source = provider.source();
    const other = CheSpeechVoice(voiceId: 'v2', model: 'm1', settings: 's1');
    await source.clip('same words', voice, allowSpend: true);
    expect(source.cached('same words', other), isNull, reason: 'another voice has its own audio');
    expect(source.cached('other words', voice), isNull);
    await source.clip('same words', other, allowSpend: true);
    expect(provider.requests, 2);
  });

  test('seeking into audio that was never generated reports it missing and spends nothing', () async {
    final provider = Provider();
    final player = FakePlayer();
    final playback = CheSpeechPlayback(clips: ['aaaa', 'bbbbbb'], voice: voice, source: provider.source(), player: player, prefetchLimit: 0);
    await playback.play();
    player.pos = Duration.zero;
    final requests = provider.requests;

    expect(await playback.seekBy(const Duration(seconds: 5)), CheSeekResult.audioMissing);
    expect(provider.requests, requests, reason: 'a missing clip is never bought again without an explicit Play');
  });

  test('a player without seek or pause says so and does not pretend', () async {
    final provider = Provider();
    final noPause = FakePlayer(caps: const CheClipPlayerCapabilities(seek: true));
    final playback = CheSpeechPlayback(clips: ['aaaa'], voice: voice, source: provider.source(), player: noPause);
    await playback.play();
    expect(await playback.pause(), isFalse);
    expect(playback.state, CheSpeechState.playing);

    final noSeek = FakePlayer(caps: const CheClipPlayerCapabilities(pause: true));
    final other = CheSpeechPlayback(clips: ['aaaa'], voice: voice, source: provider.source(), player: noSeek);
    await other.play();
    expect(await other.seekBy(const Duration(seconds: 1)), CheSeekResult.unsupported);
  });

  test('a cached clip whose length cannot be read gives unknown length, never a guessed position', () async {
    final provider = Provider();
    final player = FakePlayer(canMeasure: false);
    final playback = CheSpeechPlayback(clips: ['aaaa', 'bbbbbb'], voice: voice, source: provider.source(), player: player);
    await playback.play();
    await settle();
    expect(await playback.seekBy(const Duration(seconds: 9)), CheSeekResult.unknownLength);
  });

  test('the audio cache is bounded and clears when CHE closes', () {
    final cache = CheSpeechCache(maxBytes: 10);
    cache.put('a', Uint8List(6));
    cache.put('b', Uint8List(6));
    expect(cache.get('a'), isNull, reason: 'the oldest audio is evicted past the byte cap');
    expect(cache.get('b'), isNotNull);
    cache.clear();
    expect(cache.count, 0);
    expect(cache.bytes, 0);
  });

  test('a long reply is spoken in bounded clips, the first shortest', () {
    final text = List.filled(60, 'This is one sentence of CHE talking about the market.').join(' ');
    final clips = speechClipsFor(text);
    expect(clips.length, greaterThan(1));
    expect(clips.first.length, lessThanOrEqualTo(240));
    for (final clip in clips) {
      expect(clip.length, lessThanOrEqualTo(640));
    }
  });

  test('voice commands are read from short playback phrases only', () {
    expect(parseSpeechCommand('CHE, pause.')?.kind, 'pause');
    expect(parseSpeechCommand('resume')?.kind, 'resume');
    expect(parseSpeechCommand('CHE, stop talking.')?.kind, 'stop');
    expect(parseSpeechCommand('rewind ten seconds')?.seconds, 10);
    expect(parseSpeechCommand('CHE, rewind fifteen seconds')?.seconds, 15);
    expect(parseSpeechCommand('skip ahead thirty seconds')?.kind, 'forward');
    expect(parseSpeechCommand('skip ahead thirty seconds')?.seconds, 30);
    expect(parseSpeechCommand('play that again')?.kind, 'replay');
    expect(parseSpeechCommand('read this at double speed')?.rate, 2.0);
    expect(parseSpeechCommand('pause the video in the other tab'), isNull);
    expect(parseSpeechCommand('what is the weather like in Lafayette today and tomorrow'), isNull);
  });
}
