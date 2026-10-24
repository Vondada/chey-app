// The Recording Studio on real samples: every effect is measured on PCM buffers, the sequencer is checked to the
// sample, WAV bytes are checked field by field, and takes, punch-in, autosave/resume, export and the voice routes
// run through the real controller with a fake microphone that returns a real WAV.
import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:chey/music/che_dsp.dart';
import 'package:chey/music/che_recording_studio.dart';
import 'package:chey/music/che_song.dart';
import 'package:chey/music/che_studio_audio.dart';
import 'package:chey/music/che_studio_controller.dart';
import 'package:chey/music/che_wav.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const sr = cheStudioRate;

Float32List sine(double hz, double seconds, {double amp = 0.5}) =>
    Float32List.fromList([for (var i = 0; i < (sr * seconds).round(); i++) amp * math.sin(2 * math.pi * hz * i / sr)]);

double rmsDb(Float32List x, [int from = 0, int? to]) => cheRmsDb(x, from, to);

class FakeAudio implements CheStudioAudio {
  FakeAudio({this.take, this.unavailable, this.routeKind = 'speaker', this.inLat = 0.005, this.outLat = 0.010});
  Uint8List? take;
  String? unavailable;
  String routeKind;
  double inLat, outLat;
  final played = <Uint8List>[];
  Completer<bool>? _playing;
  bool recordingNow = false;

  @override
  Future<Map<String, dynamic>> startRecording() async {
    if (unavailable != null) throw CheAudioUnavailable(unavailable!);
    recordingNow = true;
    return {'input_latency': inLat, 'output_latency': outLat, 'route': routeKind, 'input': 'iPhone Microphone'};
  }

  @override
  Future<CheTake?> stopRecording() async {
    recordingNow = false;
    final t = take;
    return t == null ? null : CheTake(wav: t, seconds: 1, inputLatency: inLat, outputLatency: outLat, route: routeKind);
  }

  @override
  Future<double?> level() async => recordingNow ? -18 : null;

  @override
  Future<bool> play(Uint8List wav) {
    played.add(wav);
    _playing = Completer<bool>();
    return _playing!.future;
  }

  @override
  Future<void> stop() async {
    if (_playing?.isCompleted == false) _playing!.complete(false);
  }

  void finish() {
    if (_playing?.isCompleted == false) _playing!.complete(true);
  }

  @override
  Future<Map<String, dynamic>> route() async => {'route': routeKind};
}

Future<CheStudioController> studio(Directory dir, FakeAudio audio) async {
  final c = CheStudioController(audio: audio, store: CheSongStore(dir), render: (job) async => cheRenderMix(job), autosaveDelay: const Duration(milliseconds: 1));
  await c.open();
  if (c.song.tracks.isEmpty) await c.newSong(title: 'Test song');
  return c;
}

void main() {
  group('WAV', () {
    test('16-bit stereo WAV bytes: header fields and samples round-trip', () {
      final l = sine(440, 0.1), r = sine(660, 0.1, amp: 0.25);
      final wav = cheEncodeWav([l, r], sr);
      final b = ByteData.sublistView(wav);
      expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
      expect(String.fromCharCodes(wav.sublist(8, 16)), 'WAVEfmt ');
      expect(b.getUint32(4, Endian.little), wav.length - 8);
      expect(b.getUint16(20, Endian.little), 1, reason: 'PCM');
      expect(b.getUint16(22, Endian.little), 2);
      expect(b.getUint32(24, Endian.little), sr);
      expect(b.getUint32(28, Endian.little), sr * 4, reason: 'byte rate');
      expect(b.getUint16(34, Endian.little), 16);
      expect(b.getUint32(40, Endian.little), l.length * 4);
      final back = cheDecodeWav(wav);
      expect(back.channels.length, 2);
      expect(back.sampleRate, sr);
      for (var i = 0; i < l.length; i += 97) {
        expect(back.channels[0][i], closeTo(l[i], 1 / 16000));
        expect(back.channels[1][i], closeTo(r[i], 1 / 16000));
      }
    });

    test('an MP3 is refused with the reason, never guessed', () {
      final mp3 = Uint8List.fromList([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(() => cheDecodeWav(mp3), throwsA(isA<CheWavException>().having((e) => e.message, 'message', contains('not a WAV'))));
    });

    test('a 48 kHz import is resampled to the studio rate at the same pitch', () {
      final x48 = Float32List.fromList([for (var i = 0; i < 48000 ~/ 5; i++) 0.5 * math.sin(2 * math.pi * 300 * i / 48000)]);
      final y = cheResample(x48, 48000, sr);
      expect(y.length, (x48.length * sr / 48000).round());
      expect(cheDetectPitch(y, 2000, 4096), closeTo(300, 1));
    });
  });

  group('DSP on real samples', () {
    test('YIN finds 110, 220 and 440 Hz to within 1 Hz', () {
      for (final hz in [110.0, 220.0, 440.0]) {
        expect(cheDetectPitch(sine(hz, 0.3), 1000, 4096), closeTo(hz, 1), reason: '$hz Hz');
      }
      expect(cheDetectPitch(Float32List(8000), 0, 4096), 0, reason: 'silence has no pitch');
    });

    test('pitch correction pulls a flat 428 Hz note to A 440 and leaves timing alone', () {
      final x = sine(428, 1.0);
      final n = x.length;
      final report = chePitchCorrect(x, strength: 1);
      expect(x.length, n);
      expect(report.pitched, greaterThan(report.frames ~/ 2));
      expect(report.meanCorrectionCents, closeTo(1200 * math.log(440 / 428) / math.ln2, 3));
      expect(cheDetectPitch(x, sr ~/ 3, 4096), closeTo(440, 4));
    });

    test('pitch correction in C major sends a 450 Hz note to A (440), not A# (466)', () {
      expect(cheNearestNoteHz(452, key: 0, scale: 'major'), closeTo(440, 0.01));
      expect(cheNearestNoteHz(460, key: 0, scale: 'major'), closeTo(440, 0.01), reason: 'A# is not in C major');
      expect(cheNearestNoteHz(460, scale: 'chromatic'), closeTo(466.16, 0.01));
    });

    test('EQ: +6 dB low shelf raises 60 Hz by about 6 dB; -6 dB high shelf cuts 14 kHz by about 6 dB', () {
      final low = sine(60, 0.5), before = rmsDb(low, sr ~/ 10);
      cheEq(low, lowDb: 6);
      expect(rmsDb(low, sr ~/ 10) - before, closeTo(6, 0.8));
      final high = sine(14000, 0.5), hb = rmsDb(high, sr ~/ 10);
      cheEq(high, highDb: -6);
      expect(rmsDb(high, sr ~/ 10) - hb, closeTo(-6, 0.8));
      final mid = sine(1000, 0.5), mb = rmsDb(mid, sr ~/ 10);
      cheEq(mid, lowDb: 6, highDb: -6);
      expect((rmsDb(mid, sr ~/ 10) - mb).abs(), lessThan(1.2), reason: 'the shelves leave 1 kHz nearly alone');
    });

    test('compressor at 4:1 above -20 dB turns a -6 dB tone down by the expected amount', () {
      final x = sine(500, 0.6, amp: 0.7);
      final before = rmsDb(x, sr ~/ 5);
      cheCompress(x, thresholdDb: -20, ratio: 4, attackMs: 2, releaseMs: 50);
      final after = rmsDb(x, sr ~/ 5);
      // The peak envelope sits about 3 dB over RMS: -3 dBFS peak is 17 dB over, so about 12.75 dB of reduction.
      expect(before - after, inInclusiveRange(10.5, 14.0));
      final quiet = sine(500, 0.6, amp: 0.05), qb = rmsDb(quiet, sr ~/ 5);
      cheCompress(quiet, thresholdDb: -20, ratio: 4);
      expect(rmsDb(quiet, sr ~/ 5), closeTo(qb, 0.05), reason: 'below threshold nothing changes');
    });

    test('limiter keeps every sample under the ceiling', () {
      final x = sine(200, 0.3, amp: 1.0);
      for (var i = 0; i < x.length; i++) {
        x[i] *= 1.8;
      }
      cheLimit(x, ceilingDb: -1);
      expect(chePeakDb(x), lessThanOrEqualTo(-0.99));
    });

    test('delay puts an echo exactly 250 ms later at the mix level', () {
      final x = Float32List(sr)..[0] = 1;
      final y = cheDelay(x, ms: 250, feedback: 0.5, mix: 0.4);
      final d = (sr * 0.25).round();
      expect(y[0], 1);
      expect(y[d], closeTo(0.4, 1e-6));
      expect(y[2 * d], closeTo(0.2, 1e-6), reason: 'the second repeat is feedback times quieter');
      expect(y.length, greaterThan(x.length));
    });

    test('reverb leaves a decaying tail after the sound stops', () {
      final x = Float32List(sr ~/ 2)..[0] = 1;
      final y = cheReverb(x, room: 0.7, mix: 0.4);
      expect(y.length, greaterThan(x.length));
      final early = rmsDb(y, (sr * 0.05).round(), (sr * 0.25).round());
      final late = rmsDb(y, (sr * 0.9).round(), (sr * 1.1).round());
      expect(early, greaterThan(-60));
      expect(late, lessThan(early - 6), reason: 'the tail decays');
    });

    test('noise reduction drops hiss between phrases by over 12 dB and leaves the singing within 1 dB', () {
      final rnd = math.Random(3);
      final x = Float32List(sr * 2);
      for (var i = 0; i < x.length; i++) {
        x[i] = (rnd.nextDouble() * 2 - 1) * 0.01;
        if ((i ~/ (sr ~/ 2)).isEven) x[i] += 0.4 * math.sin(2 * math.pi * 330 * i / sr);
      }
      final toneBefore = rmsDb(x, sr ~/ 10, sr * 4 ~/ 10);
      final noiseBefore = rmsDb(x, sr * 6 ~/ 10, sr * 9 ~/ 10);
      cheReduceNoise(x);
      expect(noiseBefore - rmsDb(x, sr * 6 ~/ 10, sr * 9 ~/ 10), greaterThan(12));
      expect((toneBefore - rmsDb(x, sr ~/ 10, sr * 4 ~/ 10)).abs(), lessThan(1));
    });

    test('equal-power pan: hard left is silent on the right, centre is -3 dB each side', () {
      final (l, r) = chePanGains(-1);
      expect(l, closeTo(1, 1e-9));
      expect(r, closeTo(0, 1e-9));
      final (cl, cr) = chePanGains(0);
      expect(cheDb(cl), closeTo(-3.01, 0.01));
      expect(cr, closeTo(cl, 1e-9));
    });
  });

  group('Beat Maker timing', () {
    test('16th steps land on the exact sample at 120 BPM, swing delays only the off-steps', () {
      expect(CheBeat.stepSample(4, 120), sr ~/ 2, reason: 'step 5 is beat 2: half a second at 120 BPM');
      expect(CheBeat.stepSample(16, 120), sr * 2);
      expect(CheBeat.stepSample(1, 120, swing: 0.5), (sr / 8 * 1.5).round());
      expect(CheBeat.stepSample(2, 120, swing: 0.5), CheBeat.stepSample(2, 120));
    });

    test('a kick on steps 1 and 5 starts on samples 0 and 22050 and the render is the bar length', () {
      final beat = CheBeat(bars: 1);
      beat.steps['kick']![0] = true;
      beat.steps['kick']![4] = true;
      final x = beat.render(120);
      expect(x.length, sr * 2);
      int onset(int from) {
        for (var i = from; i < x.length; i++) {
          if (x[i].abs() > 1e-4) return i;
        }
        return -1;
      }

      expect(onset(0), lessThanOrEqualTo(1));
      final silentGap = rmsDb(x, (sr * 0.47).round(), (sr * 0.499).round());
      expect(silentGap, lessThan(-40), reason: 'the first kick has decayed before the second');
      expect(rmsDb(x, sr ~/ 2, sr ~/ 2 + 2000), greaterThan(-15), reason: 'the second kick hits at half a second');
    });
  });

  group('mixing and editing', () {
    test('solo, mute and pan decide what each speaker plays', () {
      final song = CheSong(title: 'Mix', tracks: [
        CheTrack(name: 'A', pan: -1, clips: [CheClip(audioId: 'a', start: 0, length: sr ~/ 2)]),
        CheTrack(name: 'B', pan: 1, clips: [CheClip(audioId: 'b', start: 0, length: sr ~/ 2)]),
      ]);
      final sources = {'a': sine(300, 0.5), 'b': sine(500, 0.5)};
      var mix = cheRenderMix(CheRenderJob(song: song.toJson(), sources: sources));
      expect(rmsDb(mix[0]), greaterThan(-12));
      expect(rmsDb(mix[1]), greaterThan(-12));
      song.tracks[1].solo = true;
      mix = cheRenderMix(CheRenderJob(song: song.toJson(), sources: sources));
      expect(rmsDb(mix[0]), lessThan(-100), reason: 'A is not soloed and was panned left');
      song.tracks[1]
        ..solo = false
        ..mute = true;
      mix = cheRenderMix(CheRenderJob(song: song.toJson(), sources: sources));
      expect(rmsDb(mix[1]), lessThan(-100));
    });

    test('count-in adds a bar of clicks before the song and the metronome clicks on each beat', () {
      final song = CheSong(title: 'Click', bpm: 120);
      final mix = cheRenderMix(CheRenderJob(song: song.toJson(), sources: const {}, to: sr * 2, metronome: true, countInBars: 1));
      expect(mix[0].length, sr * 4, reason: 'two seconds of count-in at 120 BPM plus two seconds of song');
      for (final beat in [0, 1, 2, 3, 4, 5, 6, 7]) {
        expect(rmsDb(mix[0], beat * sr ~/ 2, beat * sr ~/ 2 + 400), greaterThan(-20), reason: 'click on beat $beat');
      }
    });

    test('split, trim, move and duplicate keep the audio lined up', () {
      final t = CheTrack(name: 'V', clips: [CheClip(audioId: 'x', start: 1000, length: 10000)]);
      final c = t.clips.first;
      final right = cheSplitClip(t, c, 6000)!;
      expect([c.start, c.length, right.start, right.offset, right.length], [1000, 5000, 6000, 5000, 5000]);
      expect(cheTrimClip(right, from: 7000), isTrue);
      expect([right.start, right.offset, right.length], [7000, 6000, 4000]);
      final d = cheDuplicateClip(t, c);
      expect(d.start, c.end);
      expect(d.offset, c.offset);
      cheMoveClip(c, -5000);
      expect(c.start, 0);
      expect(cheSplitClip(t, c, 99999), isNull);
    });

    test('mastering reaches the loudness target and never passes the ceiling', () {
      final l = sine(220, 1, amp: 0.05), r = sine(330, 1, amp: 0.05);
      final report = cheMasterStereo(l, r, CheMaster(enabled: true, targetRmsDb: -14, ceilingDb: -1));
      expect(report.rmsBefore, lessThan(-28));
      expect(report.rmsAfter, closeTo(-14, 1.5));
      expect(report.peakAfter, lessThanOrEqualTo(-0.99));
    });
  });

  group('controller: takes, punch, autosave, export, voice', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('che_studio_'));
    tearDown(() => dir.deleteSync(recursive: true));

    /// A take as the iPhone writes it: one bar of count-in, the measured latency, then a click where the singer hit.
    Uint8List takeWithClickAt(double seconds) {
      final x = Float32List((sr * 6).round());
      final at = (seconds * sr).round();
      for (var i = 0; i < 200; i++) {
        x[at + i] = 0.8;
      }
      return cheEncodeWav([x], sr);
    }

    test('a take is lined up by count-in plus the measured latency and saved before anything else', () async {
      final audio = FakeAudio(inLat: 0.005, outLat: 0.010);
      final c = await studio(dir, audio);
      c.setBpm(120); // one bar = 2 s
      c.setCountIn(1);
      // The singer hits the beat 1 s into the song: 2 s count-in + 15 ms of latency + 1 s.
      audio.take = takeWithClickAt(2 + 0.015 + 1);
      final started = await c.record();
      expect(started, contains('Recording on Vocals'));
      expect(started, contains('iPhone Microphone'));
      expect(audio.played, hasLength(1), reason: 'the count-in and backing play while the mic records');
      final saved = await c.stopRecording();
      expect(saved, contains('Take saved on Vocals'));
      expect(saved, contains('15 ms'));
      final clip = c.song.tracks.first.clips.single;
      expect(clip.start, 0);
      final src = c.sources[clip.audioId]!;
      // The click must sit at timeline 1.0 s exactly.
      var first = -1;
      for (var i = clip.offset; i < clip.offset + clip.length; i++) {
        if (src[i] > 0.5) {
          first = i - clip.offset + clip.start;
          break;
        }
      }
      expect(first, sr);
      expect(File('${dir.path}/${c.song.id}/${clip.audioId}.wav').existsSync(), isTrue);
    });

    test('punch in replaces only the punch range of the earlier take', () async {
      final audio = FakeAudio(inLat: 0, outLat: 0);
      final c = await studio(dir, audio);
      c.setBpm(120);
      c.setCountIn(0);
      audio.take = cheEncodeWav([sine(200, 8)], sr);
      await c.record();
      await c.stopRecording();
      final first = c.song.tracks.first.clips.single;
      expect(first.length, sr * 8);
      c.setPunch(sr * 3, sr * 4);
      audio.take = cheEncodeWav([sine(400, 6)], sr);
      await c.record();
      final out = await c.stopRecording();
      expect(out, contains('Take saved'));
      final clips = [...c.song.tracks.first.clips]..sort((a, b) => a.start.compareTo(b.start));
      expect([for (final x in clips) [x.start, x.end]], [
        [0, sr * 3],
        [sr * 3, sr * 4],
        [sr * 4, sr * 8],
      ]);
    });

    test('autosave and resume: a reopened studio has the same song, tracks and audio', () async {
      final audio = FakeAudio();
      final c = await studio(dir, audio);
      c.rename('Late night idea');
      await c.importWav(cheEncodeWav([sine(110, 1)], 48000), name: 'My beat');
      await c.saveNow();
      final again = CheStudioController(audio: audio, store: CheSongStore(dir), render: (j) async => cheRenderMix(j));
      final said = await again.open();
      expect(said, contains('Resumed "Late night idea"'));
      expect(again.song.tracks.map((t) => t.name), ['Vocals', 'My beat']);
      final clip = again.song.tracks[1].clips.single;
      // 44,100 samples labelled 48 kHz are 0.919 s: resampled once on import to 40,516 at the studio rate, not again on load.
      expect(again.sources[clip.audioId]!.length, closeTo(sr * sr / 48000, 2));
      expect(again.songs.map((s) => s.title), contains('Late night idea'));
    });

    test('export writes a real WAV of the whole song to Exports', () async {
      final c = await studio(dir, FakeAudio());
      c.rename('Demo');
      await c.importWav(cheEncodeWav([sine(220, 2)], sr), name: 'Beat');
      final said = await c.export();
      expect(said, contains('Exported "Demo" as a WAV'));
      expect(said, contains('MP3 and M4A export are not available yet'));
      final f = File('${dir.path}/Exports/Demo.wav');
      final back = cheDecodeWav(f.readAsBytesSync());
      expect(back.channels.length, 2);
      expect(back.length, sr * 2);
    });

    test('an installed build without the recorder says so instead of pretending', () async {
      final c = await studio(dir, FakeAudio(unavailable: 'Recording needs the next CHE app build: this installed version has no microphone recorder yet.'));
      final said = await c.record();
      expect(said, startsWith('Recording needs the next CHE app build'));
      expect(c.recording, isFalse);
      expect(c.song.tracks.first.clips, isEmpty);
    });

    test('Bluetooth output shows the latency warning', () async {
      final c = await studio(dir, FakeAudio(routeKind: 'bluetooth'));
      await c.route();
      expect(c.warning, contains('Bluetooth headphones are connected'));
      expect(cheLatencyWarning({'route': 'speaker'}), isEmpty);
    });

    test('voice: record my vocals, stop, play that back, play the beat, add reverb', () async {
      final audio = FakeAudio(inLat: 0, outLat: 0);
      final c = await studio(dir, audio);
      c.setCountIn(0);
      audio.take = cheEncodeWav([sine(300, 2)], sr);
      expect(await cheStudioVoice(c, 'record my vocals'), contains('Recording on Vocals'));
      expect(c.recording, isTrue);
      expect(await cheStudioVoice(c, 'stop'), contains('Take saved'));
      expect(await cheStudioVoice(c, 'play that back'), contains('Playing the song from 0:00.0'));
      await c.stop();
      final beat = await cheStudioVoice(c, 'play the beat');
      expect(beat, contains('Playing the Beat'));
      final wav = cheDecodeWav(audio.played.last);
      expect(chePeakDb(wav.channels[0]), greaterThan(-20), reason: 'the beat really has drums in it');
      await c.stop();
      c.select(c.song.tracks.firstWhere((t) => t.kind == 'vocal').id);
      expect(await cheStudioVoice(c, 'add reverb'), contains('reverb 30%'));
      expect(c.song.tracks.firstWhere((t) => t.kind == 'vocal').fx.reverb, 0.3);
      expect(await cheStudioVoice(c, 'add some auto tune'), contains('pitch correction 70%'));
      expect(await cheStudioVoice(c, 'set the tempo to 100'), 'Tempo 100 BPM. Say use the beat to rebuild the beat track at this tempo.');
      expect(await cheStudioVoice(c, 'what is the weather'), isNull);
    });
  });

  test('by voice, CHE speaks before the sound starts (her voice would stop the music or land in the take)', () async {
    final dir = Directory.systemTemp.createTempSync('che_studio_ahead_');
    addTearDown(() => dir.deleteSync(recursive: true));
    final audio = FakeAudio(inLat: 0, outLat: 0);
    final c = await studio(dir, audio);
    c.setCountIn(0);
    final order = <String>[];
    Future<void> speak(String s) async => order.add('spoke: $s (played ${audio.played.length}, recording ${audio.recordingNow})');
    expect(await cheStudioVoice(c, 'play the beat', speakFirst: speak), '', reason: 'already said; nothing to say after');
    expect(order.single, startsWith('spoke: Playing the Beat from 0:00.0. (played 0'));
    expect(audio.played, hasLength(1));
    await c.stop();
    order.clear();
    audio.take = cheEncodeWav([sine(300, 2)], sr);
    expect(await cheStudioVoice(c, 'record my vocals', speakFirst: speak), '');
    expect(order.single, contains('recording false'), reason: 'the mic opens after CHE has finished speaking');
    expect(c.recording, isTrue);
    final saved = await cheStudioVoice(c, 'stop', speakFirst: speak);
    expect(saved, contains('Take saved'), reason: 'results after the sound has stopped are spoken normally');
  });

  testWidgets('the studio shows its six sections and labelled transport', (tester) async {
    final dir = Directory.systemTemp.createTempSync('che_studio_ui_');
    addTearDown(() => dir.deleteSync(recursive: true));
    late CheStudioController c;
    await tester.runAsync(() async => c = await studio(dir, FakeAudio()));
    await tester.pumpWidget(MaterialApp(home: CheRecordingStudio(controller: c)));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    for (final t in CheRecordingStudio.tabs) {
      expect(find.text(t), findsOneWidget);
    }
    for (final label in ['Record', 'Play', 'Stop', 'Rewind to the start', 'Loop off', 'Metronome off']) {
      expect(find.byTooltip(label), findsOneWidget, reason: label);
    }
    expect(find.text('New Recording'), findsOneWidget);
    expect(CheRecordingStudio.voiceHandler, isNotNull);
    await tester.pumpWidget(const SizedBox());
    expect(CheRecordingStudio.voiceHandler, isNull);
  });
}
