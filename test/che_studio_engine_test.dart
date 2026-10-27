// The Recording Studio's engine lane: Beat Producer, Engineer Mode ("Bring Me Back", punch-in, undo), recreated
// BandLab-style presets, the de-esser and vocal analysis with personalized processing.
//
// Every audio fixture here is SYNTHETIC (generated in this file): sine "voices" with harmonics and a little vibrato,
// white-noise hiss, and high-passed noise bursts standing in for "s" sounds. No real recording is used. The
// microphone is a fake that returns a WAV built from those fixtures, so the real controller, DSP, store, export and
// reload all run.
import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:chey/music/che_beat_producer.dart';
import 'package:chey/music/che_dsp.dart';
import 'package:chey/music/che_engineer.dart';
import 'package:chey/music/che_preset_recreate.dart';
import 'package:chey/music/che_recording_studio.dart';
import 'package:chey/music/che_song.dart';
import 'package:chey/music/che_studio_audio.dart';
import 'package:chey/music/che_studio_controller.dart';
import 'package:chey/music/che_vocal_analysis.dart';
import 'package:chey/music/che_wav.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const sr = cheStudioRate;

// ---- Synthetic fixtures ----

/// SYNTHETIC "voice": a note at [hz] with four harmonics and a 5.5 Hz vibrato of [vibratoCents].
Float32List synthVoice(double hz, double seconds, {double amp = 0.3, double vibratoCents = 8}) {
  final n = (sr * seconds).round();
  final out = Float32List(n);
  var phase = 0.0;
  for (var i = 0; i < n; i++) {
    final t = i / sr;
    final f = hz * math.pow(2, vibratoCents * math.sin(2 * math.pi * 5.5 * t) / 1200);
    phase += 2 * math.pi * f / sr;
    out[i] = amp * (math.sin(phase) + 0.5 * math.sin(2 * phase) + 0.25 * math.sin(3 * phase) + 0.12 * math.sin(4 * phase));
  }
  return out;
}

/// SYNTHETIC "s": white noise high-passed at 5 kHz.
Float32List synthSibilant(double seconds, {double amp = 0.25, int seed = 11}) {
  final r = math.Random(seed);
  final x = Float32List.fromList([for (var i = 0; i < (sr * seconds).round(); i++) amp * (r.nextDouble() * 2 - 1)]);
  CheBiquad.highPass(5000).run(x);
  CheBiquad.highPass(5000).run(x);
  return x;
}

/// SYNTHETIC sung phrase: 0.6 s of room hiss, then A3, C#4 and E4 (220, 277, 330 Hz) for a second each with 0.4 s of
/// hiss between and after, optionally a 0.15 s "s" burst in each gap. Hiss amplitude 0.003 (RMS -55.2 dBFS).
Float32List synthPhrase({bool sibilants = true, int seed = 5}) {
  final r = math.Random(seed);
  final parts = <Float32List>[Float32List((sr * 0.6).round())];
  for (final hz in [220.0, 277.18, 329.63]) {
    parts.add(synthVoice(hz, 1.0));
    final gap = Float32List((sr * 0.4).round());
    if (sibilants) gap.setRange(0, (sr * 0.15).round(), synthSibilant(0.15, seed: hz.round()));
    parts.add(gap);
  }
  final total = parts.fold<int>(0, (n, p) => n + p.length);
  final out = Float32List(total);
  var at = 0;
  for (final p in parts) {
    out.setRange(at, at + p.length, p);
    at += p.length;
  }
  for (var i = 0; i < out.length; i++) {
    out[i] += 0.003 * (r.nextDouble() * 2 - 1);
  }
  return out;
}

class FakeAudio implements CheStudioAudio {
  Uint8List? take;
  final played = <Uint8List>[];
  Completer<bool>? _playing;
  bool recordingNow = false;

  @override
  Future<Map<String, dynamic>> startRecording() async {
    recordingNow = true;
    return {'input_latency': 0.0, 'output_latency': 0.0, 'route': 'headphones', 'input': 'Fake microphone (synthetic)'};
  }

  @override
  Future<CheTake?> stopRecording() async {
    recordingNow = false;
    final t = take;
    return t == null ? null : CheTake(wav: t, seconds: 1, route: 'headphones');
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

  @override
  Future<Map<String, dynamic>> route() async => {'route': 'headphones'};

  @override
  Future<Uint8List> encodeM4a(Uint8List wav) async => throw CheAudioUnavailable('M4A export needs the next CHE app build.');

  @override
  Future<Uint8List> decodeToWav(Uint8List bytes, String ext) async => throw CheAudioUnavailable('needs the next CHE app build');

  @override
  Future<Map<String, dynamic>> startMonitor(Map<String, Object> effects, {bool allowSpeaker = false}) async => {'monitoring': false};

  @override
  Future<void> updateMonitor(Map<String, Object> effects) async {}

  @override
  Future<void> stopMonitor() async {}
}

CheStudioController controllerFor(Directory dir, FakeAudio audio) => CheStudioController(
    audio: audio, store: CheSongStore(dir), render: (job) async => cheRenderMix(job), autosaveDelay: const Duration(milliseconds: 1), undoCoalesce: Duration.zero);

Future<CheStudioController> studio(Directory dir, FakeAudio audio) async {
  final c = controllerFor(dir, audio);
  await c.open();
  if (c.song.tracks.isEmpty) await c.newSong(title: 'Engine test');
  c.setCountIn(0);
  return c;
}

CheTrack vocalOf(CheStudioController c) => c.song.tracks.firstWhere((t) => t.kind == 'vocal');

void main() {
  group('de-esser (synthetic vowel and "s" fixtures)', () {
    test('turns the "s" burst down by over 4 dB and leaves the vowel within 0.5 dB', () {
      final vowel = synthVoice(220, 0.6), ess = synthSibilant(0.3);
      final x = Float32List(vowel.length * 2 + ess.length)
        ..setRange(0, vowel.length, vowel)
        ..setRange(vowel.length, vowel.length + ess.length, ess)
        ..setRange(vowel.length + ess.length, vowel.length * 2 + ess.length, vowel);
      final v0 = cheRmsDb(x, sr ~/ 10, vowel.length - 2000);
      final s0 = cheRmsDb(x, vowel.length + 2000, vowel.length + ess.length - 2000);
      final report = cheDeEss(x, amount: 0.8);
      final v1 = cheRmsDb(x, sr ~/ 10, vowel.length - 2000);
      final s1 = cheRmsDb(x, vowel.length + 2000, vowel.length + ess.length - 2000);
      expect(s0 - s1, greaterThan(4), reason: 'the sibilant burst is reduced');
      expect((v0 - v1).abs(), lessThan(0.5), reason: 'the vowel is left alone');
      expect(report.maxReductionDb, greaterThan(4));
      expect(report.reducedFraction, inInclusiveRange(0.05, 0.4));
    });

    test('amount 0 leaves the take bit for bit', () {
      final x = synthSibilant(0.2);
      final copy = Float32List.fromList(x);
      cheDeEss(x, amount: 0);
      expect(x, copy);
    });
  });

  group('Beat Producer', () {
    test('the same genre, tempo, key and variation give the same pattern and the same samples', () {
      final spec = CheBeatSpec.of('trap', bpm: 140, key: 5, minor: true);
      final a = CheProducedBeat.generate(spec), b = CheProducedBeat.generate(spec);
      expect(a.toJson(), b.toJson());
      final ra = a.render(), rb = b.render();
      expect(ra.length, rb.length);
      var same = true;
      for (var i = 0; i < ra.length; i++) {
        if (ra[i] != rb[i]) {
          same = false;
          break;
        }
      }
      expect(same, isTrue, reason: 'rendering is deterministic, noise included');
      expect(CheProducedBeat.generate(spec.next()).toJson(), isNot(a.toJson()), reason: 'the next variation differs');
    });

    test('a trap beat is exactly 4 bars long, has its kick on 1 and snare on 3, and is real audio', () {
      final spec = CheBeatSpec.of('trap', bpm: 140, key: 5, minor: true);
      final beat = CheProducedBeat.generate(spec);
      expect(beat.drums['kick']![0], greaterThanOrEqualTo(0.88));
      expect(beat.drums['snare']![8], greaterThanOrEqualTo(0.88), reason: 'half-time snare on beat 3');
      final x = beat.render();
      expect(x.length, (4 * 16 * sr * 60 / 140 / 4).round());
      expect(x.length, beat.length());
      expect(chePeakDb(x), inInclusiveRange(-12, -0.99), reason: 'loud enough, limited at -1 dBFS');
      expect(cheRmsDb(x), greaterThan(-30));
      final drums = beat.renderDrums();
      var onset = -1;
      for (var i = 0; i < 100; i++) {
        if (drums[i].abs() > 1e-4) {
          onset = i;
          break;
        }
      }
      expect(onset, lessThanOrEqualTo(1), reason: 'the first kick starts on sample 0');
      final snareAt = beat.stepSample(8);
      expect(cheRmsDb(drums, snareAt, snareAt + 2000), greaterThan(-20), reason: 'snare at beat 3');
    });

    test('the bass plays the key: an F minor beat starts on F2 (87.3 Hz), an A minor one on A1 (55 Hz)', () {
      for (final (key, hz) in [(5, 87.31), (9, 55.0)]) {
        final beat = CheProducedBeat.generate(CheBeatSpec.of('trap', bpm: 140, key: key, minor: true));
        expect(beat.bass.first.step, 0);
        final bass = beat.renderBass();
        expect(cheDetectPitch(bass, 2000, 4096, minHz: 40), closeTo(hz, 1.5), reason: cheNoteNames[key]);
      }
    });

    test('every genre renders non-silent audio at its own tempo', () {
      for (final g in cheGenres.keys) {
        final spec = CheBeatSpec.of(g, bars: 1);
        final x = CheProducedBeat.generate(spec).render();
        expect(x.length, (16 * sr * 60 / spec.bpm / 4).round(), reason: g);
        expect(cheRmsDb(x), greaterThan(-35), reason: g);
      }
    });

    test('requests are read for genre, key and tempo; "make me a beat" alone stays with the Beat Maker', () {
      final a = cheParseBeatRequest('Make a trap beat in F sharp minor at 150')!;
      expect([a.genre, a.key, a.minor, a.bpm], ['trap', 6, true, 150]);
      final b = cheParseBeatRequest('cook up a drill instrumental in E flat')!;
      expect([b.genre, b.key, b.minor], ['drill', 3, true]);
      final c = cheParseBeatRequest('produce a beat')!;
      expect([c.genre, c.bpm], ['hip hop', 90]);
      expect(cheParseBeatRequest('make me a beat'), isNull);
      expect(cheParseBeatRequest('play the beat'), isNull);
      expect(cheParseBeatRequest('make an r&b beat at 96 bpm')!.genre, 'r&b');
    });
  });

  group('recreated presets (never imported)', () {
    test('named presets map onto the studio chain and are labelled recreated, not imported', () {
      final p = cheFindRecreatedPreset('recreate the BandLab Hip Hop Vocal preset')!;
      expect(p.name, 'BandLab Hip Hop Vocal');
      final fx = p.effects();
      expect(fx.preset, 'BandLab Hip Hop Vocal (recreated, not imported)');
      expect(fx.highPass, inInclusiveRange(80, 100), reason: 'published high-pass range');
      expect(fx.midHz, inInclusiveRange(3000, 5000), reason: 'published presence range');
      final (ratio, _) = cheCompressorSettings(fx.compress);
      expect(ratio, inInclusiveRange(2, 4.01), reason: 'published 2:1 to 4:1');
      expect(fx.delayMs, inInclusiveRange(100, 400));
      expect(cheFindRecreatedPreset('bandlab trap vocal')!.name, 'BandLab Trap Vocal', reason: '"trap vocal" beats "rap"');
      expect(cheFindRecreatedPreset('something else'), isNull);
    });

    test('a described chain becomes settings, and asking to import a BandLab file is answered honestly', () {
      final (fx, understood) = cheEffectsFromDescription('cut lows, bright, heavy compression, short delay and big reverb')!;
      expect(fx.highPass, 100);
      expect(fx.eqHigh, 3);
      expect(fx.compress, 0.75);
      expect([fx.delay, fx.delayMs], [0.2, 120]);
      expect([fx.reverb, fx.room], [0.5, 0.85]);
      expect(understood.join(', '), contains('compression 4.9 to 1'));
      expect(cheEffectsFromDescription('hello there'), isNull);
      expect(cheAsksBandLabFileImport('import my bandlab preset file'), isTrue);
      expect(cheAsksBandLabFileImport('recreate the bandlab hip hop vocal'), isFalse);
      expect(cheBandLabImportAnswer, contains("doesn't publish a preset file format"));
    });

    test('the new effects really render: high-pass removes 40 Hz, the presence bell lifts 4 kHz', () {
      final low = Float32List.fromList([for (var i = 0; i < sr ~/ 2; i++) 0.2 * math.sin(2 * math.pi * 40 * i / sr)]);
      final t = CheTrack(name: 'V', fx: CheEffects(highPass: 100), clips: [CheClip(audioId: 'a', start: 0, length: low.length)]);
      final y = cheRenderTrack(t, {'a': low});
      expect(cheRmsDb(low, sr ~/ 10) - cheRmsDb(y, sr ~/ 10), greaterThan(12));
      final tone = Float32List.fromList([for (var i = 0; i < sr ~/ 2; i++) 0.2 * math.sin(2 * math.pi * 4000 * i / sr)]);
      final t2 = CheTrack(name: 'V', fx: CheEffects(eqMid: 3, midHz: 4000), clips: [CheClip(audioId: 'b', start: 0, length: tone.length)]);
      final z = cheRenderTrack(t2, {'b': tone});
      expect(cheRmsDb(z, sr ~/ 10) - cheRmsDb(tone, sr ~/ 10), closeTo(3, 0.5));
      final back = CheEffects.fromJson(CheEffects(highPass: 90, midHz: 4000, deEss: 0.5).toJson());
      expect([back.highPass, back.midHz, back.deEss], [90, 4000, 0.5]);
      expect(CheEffects.fromJson(const {}).midHz, 1500, reason: 'songs saved before these fields still load');
    });
  });

  group('vocal analysis (synthetic phrase)', () {
    test('measures range, level, peak, noise floor and sibilance', () {
      final x = synthPhrase(sibilants: false);
      final r = cheAnalyzeVocal(x);
      expect(r.lowHz, closeTo(220, 4));
      expect(r.highHz, closeTo(329.6, 5));
      expect(CheVocalReport.note(r.lowHz), 'A3');
      expect(CheVocalReport.note(r.highHz), 'E4');
      expect(r.noiseFloorDb, closeTo(-55.2, 2.5), reason: 'hiss of amplitude 0.003');
      expect(r.rmsDb, closeTo(-12.2, 1.5));
      expect(r.peakDb, chePeakDb(x));
      expect(r.offKeyCents, lessThan(12), reason: 'the notes are in tune, with an 8 cent vibrato');
      expect(r.voicedFraction, greaterThan(0.7));
      final withS = cheAnalyzeVocal(synthPhrase());
      expect(withS.sibilanceDb - r.sibilanceDb, greaterThan(6), reason: 'the "s" bursts raise the 5 to 10 kHz energy');
    });

    test('the suggestion follows the numbers', () {
      final r = cheAnalyzeVocal(synthPhrase());
      final s = cheSuggestChain(r);
      expect(s.fx.noise, isTrue, reason: 'noise floor above -60 dB');
      expect(s.fx.deEss, greaterThan(0));
      expect(s.fx.highPass, 120, reason: '0.6 x 220 Hz, capped at 120');
      expect(s.reasons.join(' '), contains('lowest note (A3'));
      expect(s.fx.pitch, 0, reason: 'in tune, so no pitch correction');
    });
  });

  group('Engineer Mode on the real controller', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('che_engine_'));
    tearDown(() => dir.deleteSync(recursive: true));

    test('engineer mode reads numbered options and takes a spoken choice; undo reverses each change', () async {
      final c = await studio(dir, FakeAudio());
      final on = await cheStudioVoice(c, 'start engineer mode');
      expect(on, contains('Engineer Mode on'));
      expect(on, contains('1, Punch in over bars'));
      expect(on, contains('8, Mark this mix as good'));
      expect(await cheStudioVoice(c, 'option 4'), contains('1, BandLab Hip Hop Vocal'));
      c.setEffect('reverb', 0.5);
      c.setEffect('delay', 0.3);
      expect(await cheStudioVoice(c, 'undo'), startsWith('Undone'));
      expect(vocalOf(c).fx.delay, 0);
      expect(vocalOf(c).fx.reverb, 0.5);
      await cheStudioVoice(c, 'undo');
      expect(vocalOf(c).fx.reverb, 0);
      expect(await cheStudioVoice(c, 'engineer mode off'), contains('Engineer Mode off'));
      expect(await cheStudioVoice(c, '4'), isNull, reason: 'bare numbers are choices only while Engineer Mode is on');
    });

    test('bring me back with no good mix says so; asking to import a BandLab file is refused with the reason', () async {
      final c = await studio(dir, FakeAudio());
      expect(await cheStudioVoice(c, 'bring me back'), startsWith('There is no good mix saved yet'));
      expect(await cheStudioVoice(c, 'import my BandLab preset file'), contains("can't import BandLab presets"));
      expect(await cheStudioVoice(c, 'punch in bars 4 to 2'), startsWith('Bars start at 1'));
    });

    test('analyze and personalize a take give real numbers and a before/after receipt', () async {
      final audio = FakeAudio()..take = cheEncodeWav([synthPhrase()], sr);
      final c = await studio(dir, audio);
      await c.record();
      await c.stopRecording();
      final a = await cheStudioVoice(c, 'analyze my vocals');
      expect(a, contains('Range A3 to E4'));
      expect(a, contains('Suggested chain'));
      final p = await cheStudioVoice(c, 'personalize my vocal processing');
      expect(p, contains('Personalized processing on Vocals'));
      expect(p, contains('Receipt, before to after'));
      final e = c.engineer;
      expect(e.receipt, contains('sibilance'));
      expect(vocalOf(c).fx.preset, 'Personalized');
      expect(vocalOf(c).fx.deEss, greaterThan(0));
      final before = cheAnalyzeVocal(synthPhrase());
      expect(e.report!.sibilanceDb, lessThan(before.sibilanceDb - 1.5), reason: 'the de-esser lowered the "s" energy');
      expect(e.report!.noiseFloorDb, lessThan(before.noiseFloorDb - 6), reason: 'noise reduction lowered the hiss');
      expect(await cheStudioVoice(c, 'undo that'), startsWith('Undone'));
      expect(vocalOf(c).fx.preset, 'None');
    });
  });

  test('end to end: beat, vocal, punch-in, recreated preset, WAV export, reload, snapshot restore', () async {
    final dir = Directory.systemTemp.createTempSync('che_engine_e2e_');
    addTearDown(() => dir.deleteSync(recursive: true));
    final audio = FakeAudio();
    final c = await studio(dir, audio);
    c.rename('Engine E2E');

    // 1. Generate a beat.
    final made = await cheStudioVoice(c, 'make a trap beat in F minor at 140');
    expect(made, contains('Produced Trap in F minor at 140 BPM, 4 bars'));
    expect(c.song.bpm, 140);
    final beatTrack = c.song.tracks.firstWhere((t) => t.name == CheEngineer.producedName);
    final spec = CheBeatSpec.of('trap', bpm: 140, key: 5, minor: true);
    expect(beatTrack.clips.single.length, CheProducedBeat.generate(spec).length());
    expect(cheRmsDb(c.sources[beatTrack.clips.single.audioId]!), greaterThan(-30));
    expect(c.song.producer, spec.toJson());

    // 2. Add a vocal track: the fake mic returns a SYNTHETIC 8 s sine "voice".
    c.select(vocalOf(c).id);
    audio.take = cheEncodeWav([synthVoice(220, 8)], sr);
    expect(await cheStudioVoice(c, 'record my vocals'), contains('Recording on Vocals'));
    expect(await cheStudioVoice(c, 'stop'), contains('Take saved on Vocals'));
    final original = vocalOf(c).clips.single;
    expect([original.start, original.length], [0, sr * 8]);
    expect(await cheStudioVoice(c, 'engineer mode'), contains('saved this mix as a safe point'));

    // 3. Punch in over bar 2 and record a different (SYNTHETIC 330 Hz) take over it; the original is kept.
    final bar = c.song.barSamples;
    final armed = await cheStudioVoice(c, 'punch in bar 2');
    expect(armed, contains('Punch armed over bar 2'));
    expect([c.song.punchIn, c.song.punchOut], [bar, 2 * bar]);
    audio.take = cheEncodeWav([synthVoice(330, 6)], sr);
    await c.record();
    expect(await c.stopRecording(), contains('The original take is kept'));
    final clips = [...vocalOf(c).clips]..sort((a, b) => a.start.compareTo(b.start));
    expect([for (final x in clips) [x.start, x.end]], [
      [0, bar],
      [bar, 2 * bar],
      [2 * bar, sr * 8],
    ]);
    final punchId = clips[1].audioId;
    expect(punchId, isNot(original.audioId));
    expect(File('${dir.path}/${c.song.id}/${original.audioId}.wav').existsSync(), isTrue, reason: 'the original take stays on disk');

    // 4. Apply a recreated preset.
    final preset = await cheStudioVoice(c, 'recreate the BandLab hip hop vocal preset');
    expect(preset, contains('BandLab Hip Hop Vocal, recreated, not imported'));
    expect(vocalOf(c).fx.preset, 'BandLab Hip Hop Vocal (recreated, not imported)');

    // 5. Export a WAV: header, length and real sound checked.
    final exported = await c.export();
    expect(exported, contains('Exported "Engine E2E" as a WAV'));
    final bytes = File('${dir.path}/Exports/Engine E2E.wav').readAsBytesSync();
    final b = ByteData.sublistView(bytes);
    expect(String.fromCharCodes(bytes.sublist(0, 4)), 'RIFF');
    expect(String.fromCharCodes(bytes.sublist(8, 12)), 'WAVE');
    expect(b.getUint16(22, Endian.little), 2);
    expect(b.getUint32(24, Endian.little), sr);
    final wav = cheDecodeWav(bytes);
    expect(wav.length, c.song.end + sr * 2, reason: 'the whole song plus two seconds for the delay and reverb tails');
    expect(cheRmsDb(wav.channels[0]), greaterThan(-35), reason: 'not silence');
    expect(cheRmsDb(wav.channels[0], 0, bar), greaterThan(-35), reason: 'the beat and the vocal from the first bar');

    // Then the mix goes wrong: the vocal is nearly muted and the preset is replaced.
    c.setVolume(vocalOf(c), 0.05);
    c.applyPreset('Hard tune');
    await c.saveNow();

    // 6. Reload the project in a fresh controller (as when the studio is reopened).
    final again = controllerFor(dir, audio);
    expect(await again.open(), contains('Resumed "Engine E2E"'));
    expect(vocalOf(again).volume, 0.05);
    final snaps = await again.engineer.load();
    expect(snaps.map((s) => s.label), containsAll(['When Engineer Mode started', 'Before punch-in, bar 2', 'Exported mix']));
    expect(await cheStudioVoice(again, 'list snapshots'), contains('Exported mix (good)'));

    // 7. Restore the snapshot from before the punch-in: only the original take, which then no longer references the
    // punch take. Save and reopen once more, so the punch take is not in memory, then bring me back to the exported
    // mix, which needs the punch take read back from the song's folder.
    final before = snaps.indexWhere((s) => s.label == 'Before punch-in, bar 2') + 1;
    expect(await cheStudioVoice(again, 'restore snapshot $before'), contains('Restored snapshot $before'));
    expect(vocalOf(again).clips.single.length, sr * 8, reason: 'the original take is whole again');
    await again.saveNow();
    final third = controllerFor(dir, audio);
    await third.open();
    expect(third.sources.containsKey(punchId), isFalse);
    final back = await cheStudioVoice(third, 'bring me back');
    expect(back, contains('Brought you back to "Exported mix"'));
    expect(vocalOf(third).volume, 0.9);
    expect(vocalOf(third).fx.preset, 'BandLab Hip Hop Vocal (recreated, not imported)');
    expect(vocalOf(third).clips, hasLength(3));
    expect(third.sources[punchId], isNotNull, reason: 'the punch take was loaded back from disk');
    final mix = cheRenderMix(CheRenderJob(song: third.song.toJson(), sources: third.sources));
    expect(mix[0].length, wav.length, reason: 'the restored mix renders to the exported length');
    expect(await cheStudioVoice(third, 'bring me back'), startsWith('You are already on the last good mix'));
  });

  testWidgets('the studio shows the new controls with labels on Record, Beat Maker and Effects', (tester) async {
    final semantics = tester.ensureSemantics();
    final dir = Directory.systemTemp.createTempSync('che_engine_ui_');
    addTearDown(() => dir.deleteSync(recursive: true));
    late CheStudioController c;
    await tester.runAsync(() async => c = await studio(dir, FakeAudio()));
    for (final (tab, texts) in [
      (0, ['Engineer Mode', 'Undo', 'Bring me back', 'Mark mix as good', 'Read snapshots', 'Arm punch-in, bars 1 to 2']),
      (2, ['Beat Producer', 'Produce Hip hop beat at 90 BPM', 'New variation', 'Beat Maker']),
      (4, ['Analyze vocal', 'Personalize processing', 'BandLab-style chains (recreated, not imported)']),
    ]) {
      await tester.pumpWidget(MaterialApp(key: ValueKey(tab), home: CheRecordingStudio(controller: c, initialTab: tab)));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      for (final t in texts) {
        expect(find.textContaining(t), findsWidgets, reason: t);
      }
    }
    expect(find.byTooltip('Engineer Mode off. Turn it on and hear the options'), findsNothing, reason: 'not on the Effects tab');
    expect(find.bySemanticsLabel('BandLab Hip Hop Vocal, recreated, not imported'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    semantics.dispose();
  });
}
