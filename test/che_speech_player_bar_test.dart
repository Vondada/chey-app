import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/che_speech_player_bar.dart';
import 'package:chey/che_speech_playback.dart';

/// One second of audio per byte. Records what the native player was asked to do.
class BarPlayer implements CheClipPlayer {
  final List<String> calls = [];
  Duration pos = Duration.zero;

  @override
  CheClipPlayerCapabilities get capabilities => const CheClipPlayerCapabilities(pause: true, seek: true, rate: true);

  @override
  Future<Duration?> load(Uint8List bytes, {Duration offset = Duration.zero, double rate = 1.0}) async {
    calls.add('load:${bytes.length}');
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
  Future<Duration?> durationOf(Uint8List bytes) async => Duration(seconds: bytes.length);
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 10));
  }
}

void main() {
  late BarPlayer player;
  late int requests;
  late CheSpeechPlayback playback;

  setUp(() {
    player = BarPlayer();
    requests = 0;
    playback = CheSpeechPlayback(
      clips: ['aaaa', 'bbbbbb', 'cc'],
      voice: const CheSpeechVoice(voiceId: 'v1', model: 'm1'),
      source: CheSpeechSource(synthesize: (text, _) async {
        requests++;
        return Uint8List(text.length);
      }),
      player: player,
      prefetchLimit: 2,
    );
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheSpeechPlayerBar(playback: playback))),
    ));
    await tester.pump();
  }

  testWidgets('every control has a spoken label a screen reader can find', (tester) async {
    final handle = tester.ensureSemantics();
    await pump(tester);
    for (final label in [
      "Play CHE's speech.",
      "Stop CHE's speech completely.",
      "Play CHE's speech from the beginning.",
      "Skip the rest of CHE's speech.",
      "Rewind CHE's speech 10 seconds.",
      "Rewind CHE's speech 15 seconds.",
      "Rewind CHE's speech 30 seconds.",
      "Fast-forward CHE's speech 10 seconds.",
      "Fast-forward CHE's speech 15 seconds.",
      "Fast-forward CHE's speech 30 seconds.",
      "Play CHE's speech at one point five times speed.",
      "Play CHE's speech at two times speed.",
    ]) {
      expect(find.bySemanticsLabel(label), findsOneWidget, reason: label);
    }
    handle.dispose();
  });

  testWidgets('the credit note is always on the bar and says pausing does not refund credits', (tester) async {
    await pump(tester);
    expect(find.textContaining('does not refund them'), findsOneWidget);
    expect(find.textContaining('Replaying kept audio and changing speed do not use credits'), findsOneWidget);
  });

  testWidgets('Play then Pause pauses at once; Play again resumes without reloading', (tester) async {
    await pump(tester);
    await tester.tap(find.byTooltip("Play CHE's speech."));
    await settle(tester);
    expect(playback.state, CheSpeechState.playing);

    await tester.tap(find.byTooltip("Pause CHE's speech."));
    await settle(tester);
    expect(playback.state, CheSpeechState.paused);
    expect(player.calls.last, 'pause');

    final loads = player.calls.where((c) => c.startsWith('load')).length;
    await tester.tap(find.byTooltip("Play CHE's speech."));
    await settle(tester);
    expect(player.calls.last, 'resume');
    expect(player.calls.where((c) => c.startsWith('load')).length, loads);
  });

  testWidgets('rewinding 15 seconds uses audio already held, and a speed change makes no request', (tester) async {
    await pump(tester);
    await tester.tap(find.byTooltip("Play CHE's speech."));
    await settle(tester);
    final before = requests;

    await tester.tap(find.byTooltip("Rewind CHE's speech 15 seconds."));
    await settle(tester);
    expect(requests, before, reason: 'seeking never synthesizes');

    await tester.tap(find.text('1.5x'));
    await settle(tester);
    expect(playback.rate, 1.5);
    expect(requests, before, reason: 'speed never synthesizes');
  });

  testWidgets('a seek into audio that was never kept says so on screen and spends nothing', (tester) async {
    final lonely = CheSpeechPlayback(
      clips: ['aaaa', 'bbbbbb'],
      voice: const CheSpeechVoice(voiceId: 'v1', model: 'm1'),
      source: CheSpeechSource(synthesize: (text, _) async {
        requests++;
        return Uint8List(text.length);
      }),
      player: player,
      prefetchLimit: 0,
    );
    playback = lonely;
    await pump(tester);
    await tester.tap(find.byTooltip("Play CHE's speech."));
    await settle(tester);
    final before = requests;

    await tester.tap(find.byTooltip("Fast-forward CHE's speech 30 seconds."));
    await settle(tester);
    expect(requests, before);
    expect(find.textContaining('no longer kept'), findsOneWidget);
  });

  testWidgets('Stop leaves nothing playing and the next Play starts from the top', (tester) async {
    await pump(tester);
    await tester.tap(find.byTooltip("Play CHE's speech."));
    await settle(tester);
    await tester.tap(find.byTooltip("Stop CHE's speech completely."));
    await settle(tester);
    expect(playback.state, CheSpeechState.stopped);
    expect(playback.clipIndex, 0);
    expect(find.textContaining('Play starts again from the top'), findsOneWidget);
  });
}
