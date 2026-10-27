// Engineer Mode for the Recording Studio: a guided engineer over the studio's own songs, tracks and takes.
//  - Punch-in by voice: arm a region by bar ("punch in bars 3 to 4") or by time ("punch in from 12 to 16 seconds"),
//    record over it, and keep the original take (its audio stays saved; undo puts it back).
//  - Undo: every change to the song is one step (slider drags count as one); after reopening, undo falls back to
//    the saved snapshots.
//  - "Bring me back": returns to the last good mix. Good points are saved when Engineer Mode starts, when the owner
//    says "this sounds good", and on every export. Snapshots live with the song (snapshots.json beside song.json),
//    so they survive closing and reopening.
//  - The Beat Producer (che_beat_producer.dart), recreated presets (che_preset_recreate.dart) and vocal analysis
//    with personalized processing (che_vocal_analysis.dart) are reached from here and by voice.
// Every action returns the sentence CHE says about what really happened.
import 'dart:convert';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'che_beat_producer.dart';
import 'che_dsp.dart';
import 'che_preset_recreate.dart';
import 'che_song.dart';
import 'che_studio_controller.dart';
import 'che_vocal_analysis.dart';

/// One saved state of the song. [good] marks a mix the owner wants to be able to come back to.
class CheSnapshot {
  CheSnapshot({required this.id, required this.label, required this.at, required this.good, required this.song});
  final String id;
  final String label;
  final int at;
  final bool good;
  final Map<String, dynamic> song;

  Map<String, dynamic> toJson() => {'id': id, 'label': label, 'at': at, 'good': good, 'song': song};
  factory CheSnapshot.fromJson(Map j) => CheSnapshot(
      id: '${j['id']}', label: '${j['label']}', at: (j['at'] as num? ?? 0).toInt(), good: j['good'] == true,
      song: Map<String, dynamic>.from(j['song'] as Map? ?? const {}));

  String get when {
    final t = DateTime.fromMillisecondsSinceEpoch(at);
    return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  }
}

String _stateOf(Map<String, dynamic> songJson) => jsonEncode(Map<String, dynamic>.from(songJson)..remove('updated'));

class CheEngineer {
  CheEngineer(this.c);
  final CheStudioController c;

  /// The owner turned Engineer Mode on (spoken choices by number work while it is on).
  bool active = false;
  List<CheSnapshot> snapshots = [];
  String? _loadedFor;

  /// The last vocal analysis, suggestion and before/after receipt (shown on the Effects tab).
  CheVocalReport? report;
  CheVocalSuggestion? suggestion;
  String receipt = '';

  static const maxSnapshots = 30;

  static const options = [
    'Punch in over bars: say punch in bars 3 to 4',
    'Analyze my vocal',
    'Personalize my vocal processing',
    'Recreate a BandLab-style preset',
    'Produce a beat',
    'Undo',
    'Bring me back to the last good mix',
    'Mark this mix as good',
  ];

  String optionsSentence() => 'Options: ${[for (var i = 0; i < options.length; i++) '${i + 1}, ${options[i]}'].join('; ')}. Say a number.';

  /// Loads the open song's snapshots from disk (once per song).
  Future<List<CheSnapshot>> load() async {
    if (_loadedFor == c.song.id) return snapshots;
    final id = c.song.id;
    final raw = await c.store.loadSnapshots(id);
    if (c.song.id != id) return snapshots;
    snapshots = [for (final j in raw) CheSnapshot.fromJson(j)];
    _loadedFor = id;
    report = null;
    suggestion = null;
    receipt = '';
    return snapshots;
  }

  /// Saves the song as it is now. A good snapshot identical to the newest good one is not saved twice.
  Future<CheSnapshot> snapshot(String label, {bool good = false}) async {
    final list = await load();
    final json = c.song.toJson();
    final state = _stateOf(json);
    if (good) {
      final lastGood = list.where((s) => s.good).lastOrNull;
      if (lastGood != null && _stateOf(lastGood.song) == state) return lastGood;
    }
    final snap = CheSnapshot(id: 'snap_${DateTime.now().microsecondsSinceEpoch}', label: label, at: DateTime.now().millisecondsSinceEpoch, good: good, song: json);
    list.add(snap);
    while (list.length > maxSnapshots) {
      final drop = list.indexWhere((s) => !s.good);
      list.removeAt(drop < 0 ? 0 : drop);
    }
    await c.store.saveSnapshots(c.song.id, [for (final s in list) s.toJson()]);
    return snap;
  }

  String _summary() {
    final takes = c.song.tracks.where((t) => t.kind == 'vocal').fold<int>(0, (n, t) => n + t.clips.length);
    return '${c.song.tracks.length} tracks, $takes vocal clips, ${cheClock(c.song.end)} long';
  }

  /// Restores a saved song state, loading any take that is no longer in memory from the song's folder.
  Future<String?> _restore(Map<String, dynamic> songJson, {required bool undoable}) async {
    final s = CheSong.fromJson(songJson);
    final extra = <String, Float32List>{};
    final missing = <String>[];
    for (final t in s.tracks) {
      for (final cl in t.clips) {
        if (c.sources.containsKey(cl.audioId) || extra.containsKey(cl.audioId)) continue;
        final src = await c.store.loadSource(c.song.id, cl.audioId);
        if (src == null) {
          missing.add(cl.audioId);
        } else {
          extra[cl.audioId] = src;
        }
      }
    }
    c.restoreSong(s, extra: extra, undoable: undoable);
    await c.saveNow();
    return missing.isEmpty ? null : '${missing.length} recording${missing.length == 1 ? ' is' : 's are'} no longer on this iPhone, so ${missing.length == 1 ? 'that clip is' : 'those clips are'} silent.';
  }

  // ---- The guided flow ----

  Future<String> start() async {
    active = true;
    final snap = await snapshot('When Engineer Mode started', good: true);
    return c.report('Engineer Mode on. I saved this mix as a safe point ("${snap.label}", ${snap.when}), so bring me back returns here. ${optionsSentence()}');
  }

  String stop() {
    active = false;
    return c.report('Engineer Mode off. Your snapshots stay saved with the song.');
  }

  Future<String> choose(int n) async {
    switch (n) {
      case 1:
        final bars = math.max(1, (c.song.end / c.song.barSamples).ceil());
        return c.report('Say punch in bars, then the first and last bar, for example punch in bars 3 to 4. The song has $bars bars at ${c.song.bpm.round()} BPM.');
      case 2:
        return analyze();
      case 3:
        return personalize();
      case 4:
        return c.report('Recreated presets, built from published mixing ranges, never imported: '
            '${[for (var i = 0; i < cheRecreatedPresets.length; i++) '${i + 1}, ${cheRecreatedPresets[i].name}'].join('; ')}. '
            'Say recreate preset and a number, or describe a chain.');
      case 5:
        return produceBeat(CheBeatSpec.of('hip hop', bpm: c.song.bpm));
      case 6:
        return undo();
      case 7:
        return bringMeBack();
      case 8:
        return markGood();
    }
    return c.report('There is no option $n. ${optionsSentence()}');
  }

  // ---- Punch-in ----

  /// Arms punch-in over bars [fromBar]..[toBar] (1-based, inclusive) or [fromSeconds]..[toSeconds]. The song is
  /// snapshotted first, so the original take can always come back.
  Future<String> armPunch({int? fromBar, int? toBar, double? fromSeconds, double? toSeconds, bool andRecord = false}) async {
    if (c.recording) return c.report('Recording is running. Say stop first.');
    final int from, to;
    final String where;
    if (fromBar != null) {
      final last = toBar ?? fromBar;
      if (fromBar < 1 || last < fromBar) return c.report('Bars start at 1, and the last bar must not come before the first.');
      from = (fromBar - 1) * c.song.barSamples;
      to = last * c.song.barSamples;
      where = last == fromBar ? 'bar $fromBar' : 'bars $fromBar to $last';
    } else if (fromSeconds != null && toSeconds != null) {
      if (toSeconds - fromSeconds < 0.25 || fromSeconds < 0) return c.report('The punch range must start at zero or later and last at least a quarter second.');
      from = (fromSeconds * cheStudioRate).round();
      to = (toSeconds * cheStudioRate).round();
      where = '${cheClock(from)} to ${cheClock(to)}';
    } else {
      return c.report('Say punch in bars 3 to 4, or punch in from 12 to 16 seconds.');
    }
    await snapshot('Before punch-in, $where');
    c.setPunch(from, to);
    final armed = 'Punch armed over $where (${cheClock(from)} to ${cheClock(to)}), with a bar of pre-roll. '
        'The original take stays saved: undo or bring me back returns to it.';
    if (!andRecord) return c.report('$armed Say record when you are ready.');
    final rec = await c.record();
    return rec.isEmpty ? rec : '$armed $rec';
  }

  // ---- Undo and bring me back ----

  Future<String> undo() async {
    if (c.recording) return c.report('Recording is running. Say stop first.');
    final prev = c.popUndo();
    if (prev != null) {
      final note = await _restore(Map<String, dynamic>.from(jsonDecode(prev) as Map), undoable: false);
      return c.report('Undone: back to before the last change. Now ${_summary()}.${note == null ? '' : ' $note'}');
    }
    // After reopening the song there is no in-memory history: step back to the newest saved snapshot that differs.
    final list = await load();
    final now = _stateOf(c.song.toJson());
    final snap = list.reversed.where((s) => _stateOf(s.song) != now).firstOrNull;
    if (snap == null) return c.report('There is nothing to undo.');
    final note = await _restore(snap.song, undoable: true);
    return c.report('Undone from the saved snapshot "${snap.label}" (${snap.when}). Now ${_summary()}.${note == null ? '' : ' $note'}');
  }

  Future<String> bringMeBack() async {
    if (c.recording) return c.report('Recording is running. Say stop first.');
    final list = await load();
    final good = list.where((s) => s.good).lastOrNull;
    if (good == null) {
      return c.report('There is no good mix saved yet. Say this sounds good, or start Engineer Mode, to save one. Undo goes back one step.');
    }
    if (_stateOf(good.song) == _stateOf(c.song.toJson())) return c.report('You are already on the last good mix, "${good.label}" from ${good.when}.');
    await snapshot('Before bring me back');
    final note = await _restore(good.song, undoable: true);
    return c.report('Brought you back to "${good.label}" from ${good.when}: ${_summary()}. Say undo to return to where you were.${note == null ? '' : ' $note'}');
  }

  Future<String> markGood() async {
    final n = (await load()).where((s) => s.good).length + 1;
    final snap = await snapshot('Good mix $n', good: true);
    return c.report('Saved this mix as a good point ("${snap.label}", ${snap.when}). Say bring me back any time to return here.');
  }

  Future<String> listSnapshots() async {
    final list = await load();
    if (list.isEmpty) return c.report('There are no snapshots for this song yet.');
    final items = [for (var i = 0; i < list.length; i++) '${i + 1}, ${list[i].label}${list[i].good ? ' (good)' : ''} at ${list[i].when}'];
    return c.report('Snapshots: ${items.join('; ')}. Say restore snapshot and a number.');
  }

  Future<String> restoreSnapshot(int n) async {
    final list = await load();
    if (n < 1 || n > list.length) return c.report(list.isEmpty ? 'There are no snapshots yet.' : 'There is no snapshot $n. There are ${list.length}.');
    final snap = list[n - 1];
    await snapshot('Before restoring snapshot $n');
    final note = await _restore(snap.song, undoable: true);
    return c.report('Restored snapshot $n, "${snap.label}" from ${snap.when}: ${_summary()}. Say undo to return.${note == null ? '' : ' $note'}');
  }

  // ---- Beat Producer ----

  static const producedName = 'Produced beat';

  // Background work goes through static functions, so the isolate is sent only data (never this controller).
  static Future<Float32List> _renderBeat(CheBeatSpec spec) => Isolate.run(() => CheProducedBeat.generate(spec).render());
  static Future<CheVocalReport> _analyze(Float32List x) => Isolate.run(() => cheAnalyzeVocal(x));
  static Future<CheVocalReport> _analyzeProcessed(CheTrack t, Map<String, Float32List> sources, int start, int n) => Isolate.run(() {
        final y = cheRenderTrack(t, sources);
        return cheAnalyzeVocal(Float32List.fromList(Float32List.sublistView(y, math.min(start, y.length), math.min(y.length, start + n))));
      });

  /// Generates and renders a beat, and puts it on the Produced beat track as audio the mixer and export use.
  Future<String> produceBeat(CheBeatSpec spec) async {
    if (c.recording) return c.report('Recording is running. Say stop first.');
    await snapshot('Before producing a beat');
    final beat = CheProducedBeat.generate(spec);
    final samples = await _renderBeat(spec);
    final id = 'produced_${DateTime.now().microsecondsSinceEpoch}';
    c.sources[id] = samples;
    await c.store.saveSource(c.song.id, id, samples);
    var t = c.song.tracks.where((t) => t.kind == 'beat' && t.name == producedName).firstOrNull;
    if (t == null) {
      t = CheTrack(name: producedName, kind: 'beat', volume: 0.8);
      c.song.tracks.insert(0, t);
    }
    t.clips
      ..clear()
      ..add(CheClip(audioId: id, start: 0, length: samples.length));
    final tempoChanged = (c.song.bpm - spec.bpm).abs() > 0.01;
    c.song
      ..bpm = spec.bpm
      ..producer = spec.toJson();
    c.markChanged();
    await c.saveNow();
    return c.report('Produced ${spec.describe()} (variation ${spec.variation + 1}), ${cheClock(samples.length)}, on the $producedName track. '
        '${tempoChanged ? 'The song tempo is now ${spec.bpm.round()} BPM. ' : ''}${beat.describe()} '
        'Say make another one for a new variation, or undo.');
  }

  /// The next variation of the last produced beat.
  Future<String> anotherBeat() async {
    final p = c.song.producer;
    if (p == null) return produceBeat(CheBeatSpec.of('hip hop', bpm: c.song.bpm));
    return produceBeat(CheBeatSpec.fromJson(p).next());
  }

  // ---- Recreated presets ----

  CheTrack? _vocal() {
    final sel = c.track;
    if (sel != null && sel.kind == 'vocal') return sel;
    return c.song.tracks.where((t) => t.kind == 'vocal').firstOrNull;
  }

  Future<String> recreatePreset(String words) async {
    if (cheAsksBandLabFileImport(words)) return c.report(cheBandLabImportAnswer);
    final t = _vocal();
    if (t == null) return c.report('Add a vocal track first.');
    final byNumber = RegExp(r'\b(?:preset|number) (\d|one|two|three|four|five)\b').firstMatch(words.toLowerCase());
    const numbers = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5};
    CheRecreatedPreset? preset;
    if (byNumber != null) {
      final n = int.tryParse(byNumber.group(1)!) ?? numbers[byNumber.group(1)!]!;
      if (n < 1 || n > cheRecreatedPresets.length) return c.report('There is no preset $n. There are ${cheRecreatedPresets.length}.');
      preset = cheRecreatedPresets[n - 1];
    } else {
      preset = cheFindRecreatedPreset(words);
    }
    final CheEffects fx;
    final String what;
    if (preset != null) {
      fx = preset.effects();
      what = '${preset.name}, $cheRecreatedLabel. BandLab publishes no preset files or settings, so CHE built it from published '
          'vocal-mixing ranges: ${preset.basis}';
    } else {
      final described = cheEffectsFromDescription(words);
      if (described == null) {
        return c.report('Name a preset (${cheRecreatedPresets.map((p) => p.name).join(', ')}) or describe the chain, for example '
            'cut lows, bright, heavy compression, short delay, big reverb.');
      }
      fx = described.$1..preset = 'Described preset ($cheRecreatedLabel)';
      what = 'a preset recreated from your description, $cheRecreatedLabel: ${described.$2.join(', ')}';
    }
    await snapshot('Before preset on ${t.name}');
    fx
      ..key = t.fx.key
      ..scale = t.fx.scale;
    t.fx = fx;
    c.markChanged();
    return c.report('${t.name}: $what. Now ${t.fx.describe()}. Say undo to go back.');
  }

  // ---- Vocal analysis ----

  /// The vocal track's takes as recorded (no effects), from its first clip to its end.
  (Float32List, int)? _dry(CheTrack t) {
    if (t.clips.isEmpty) return null;
    final dryTrack = CheTrack(name: t.name, clips: t.clips);
    final x = cheRenderTrack(dryTrack, c.sources);
    final start = t.clips.map((cl) => cl.start).reduce(math.min);
    if (x.length - start < cheStudioRate ~/ 4) return null;
    return (Float32List.fromList(Float32List.sublistView(x, start)), start);
  }

  Future<String> analyze() async {
    final t = _vocal();
    if (t == null) return c.report('Add a vocal track and record a take first.');
    final dry = _dry(t);
    if (dry == null) return c.report('${t.name} has no take long enough to analyze yet. Record one first.');
    final x = dry.$1;
    final r = await _analyze(x);
    report = r;
    suggestion = cheSuggestChain(r);
    return c.report('${t.name}, ${r.seconds.toStringAsFixed(1)} seconds analyzed. ${r.describe()} '
        'Suggested chain: ${suggestion!.fx.describe()}. Say personalize my vocal to apply it with a before and after receipt.');
  }

  /// Applies the suggested chain to the vocal track and measures the result.
  Future<String> personalize() async {
    final t = _vocal();
    if (t == null) return c.report('Add a vocal track and record a take first.');
    final dry = _dry(t);
    if (dry == null) return c.report('${t.name} has no take long enough to analyze yet. Record one first.');
    final (x, start) = dry;
    final before = await _analyze(x);
    final sug = cheSuggestChain(before);
    await snapshot('Before personalized processing on ${t.name}');
    sug.fx
      ..key = t.fx.key
      ..scale = t.fx.scale;
    t.fx = sug.fx;
    c.markChanged();
    final processed = CheTrack(name: t.name, fx: t.fx.copy(), clips: t.clips);
    final used = {for (final cl in t.clips) if (c.sources[cl.audioId] != null) cl.audioId: c.sources[cl.audioId]!};
    final after = await _analyzeProcessed(processed, used, start, x.length);
    report = after;
    suggestion = sug;
    receipt = cheVocalReceipt(before, after);
    return c.report('Personalized processing on ${t.name}: ${t.fx.describe()}. Why: ${sug.reasons.join('; ')}. '
        'Receipt, before to after: $receipt. Say undo or bring me back to return.');
  }
}

/// Engineer Mode's voice routes (asked first by cheStudioVoice). Returns what CHE says, or null.
Future<String?> cheEngineerVoice(CheStudioController c, String said, {void Function(int tab)? showTab}) async {
  final e = c.engineer;
  final s = said.toLowerCase().replaceAll(RegExp(r"[^a-z0-9 ']"), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
  bool has(String p) => RegExp(p).hasMatch(s);
  const words = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12};
  int? num(String? w) => w == null ? null : int.tryParse(w) ?? words[w];
  const n = r'(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

  if (has(r'\b(exit|leave|turn off|stop|close) (the )?engineer mode\b|\bengineer mode off\b')) return e.stop();
  if (has(r'\bengineer mode\b|\bbe my (sound )?engineer\b')) {
    showTab?.call(0);
    return e.start();
  }
  final choice = RegExp('^(?:option|number|choice)? ?$n\$').firstMatch(s);
  if (e.active && choice != null) return e.choose(num(choice.group(1))!);
  if (has(r'\bbring me back\b|\b(go back|return) to the (last )?good (mix|version|one)\b|\brestore the (last )?good (mix|version)\b')) return e.bringMeBack();
  if (has(r'^undo\b|\bundo (that|it|the last|last|my last)\b|\btake that back\b')) return e.undo();
  if (has(r'\b(this|that|it) sounds? good\b|\bmark (this|it|the mix) (as )?good\b|\bsave (this|the) mix\b|\bkeep this mix\b')) return e.markGood();
  if (has(r'\b(list|read|what|which)\b.*\bsnapshots?\b')) return e.listSnapshots();
  final restore = RegExp('\\brestore snapshot (?:number )?$n\\b').firstMatch(s);
  if (restore != null) return e.restoreSnapshot(num(restore.group(1))!);

  final record = has(r'\b(and|then) record\b|\brecord over\b');
  final byBar = RegExp('\\bpunch (?:in|me in)(?: on| over| at| for| from)? bars? $n(?: (?:to|through|thru|and|until) (?:bar )?$n)?\\b').firstMatch(s);
  if (byBar != null) {
    showTab?.call(0);
    return e.armPunch(fromBar: num(byBar.group(1)), toBar: num(byBar.group(2)), andRecord: record);
  }
  final byTime = RegExp(r'\bpunch (?:in|me in) from (\d{1,3})(?: seconds?)? (?:to|until|through) (\d{1,3})(?: seconds?)?\b').firstMatch(s);
  if (byTime != null) {
    showTab?.call(0);
    return e.armPunch(fromSeconds: double.parse(byTime.group(1)!), toSeconds: double.parse(byTime.group(2)!), andRecord: record);
  }

  final beat = cheParseBeatRequest(said);
  if (beat != null) {
    showTab?.call(2);
    return e.produceBeat(beat);
  }
  if (c.song.producer != null && has(r'\b(another|new|different) (one|beat|variation|version)\b|\bmake another\b')) {
    showTab?.call(2);
    return e.anotherBeat();
  }

  if (has(r'\bbandlab\b') || has(r'\brecreate\b.*\b(preset|chain|vocal|sound)\b')) {
    showTab?.call(4);
    return e.recreatePreset(said);
  }
  if (has(r'\banaly[sz]e (my |the )?(vocals?|voice|take|singing)\b|\bvocal analysis\b')) {
    showTab?.call(4);
    return e.analyze();
  }
  if (has(r'\b(personali[sz]e|tailor|customi[sz]e)\b.*\b(vocals?|voice|processing|chain|sound)\b|\bpersonali[sz]ed processing\b|\bapply (the |your )?suggest(ion|ed chain)\b')) {
    showTab?.call(4);
    return e.personalize();
  }
  return null;
}
