// CHE Recording Studio (owner, 2026-10-24: "a BandLab-style multitrack studio"): New Recording, My Songs, Beat Maker,
// the Recording Timeline, Mixer, Effects and Mastering on one screen with a fixed transport bar and six tabs, so
// nothing needs long scrolling. All sound is real: takes come from the iPhone's microphone or audio interface,
// processing runs on the samples (lib/music/che_dsp.dart), and Play renders the actual mix. Every control has a
// VoiceOver label and a voice route (cheStudioVoice); while the studio is open, CheRecordingStudio.voiceHandler
// takes the owner's words first (lib/home_state/send.dart).
import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import '../che_ui/che_theme.dart';
import 'che_beat_producer.dart';
import 'che_dsp.dart';
import 'che_preset_recreate.dart';
import 'che_song.dart';
import 'che_studio_audio.dart';
import 'che_studio_controller.dart';

class CheRecordingStudio extends StatefulWidget {
  const CheRecordingStudio({super.key, this.controller, this.onAsk, this.onSpeak, this.initialTab = 0, this.say});

  /// Injected for tests; otherwise the studio makes its own over the iPhone's audio and Documents/CHE Songs.
  final CheStudioController? controller;

  /// Hands a writing or production question to CHE's chat (lyrics, melody, arrangement, mix advice).
  final Future<void> Function(String prompt)? onAsk;

  /// Speaks aloud (Read aloud, and the voice routes' results). Completes when CHE has finished speaking.
  final Future<void> Function(String text)? onSpeak;
  final int initialTab;

  /// Words that opened the studio ("record my vocals"), run as soon as it is ready.
  final String? say;

  /// While the studio is open, its voice routes (send.dart asks it first).
  static Future<String?> Function(String words)? voiceHandler;

  static const tabs = ['Record', 'My Songs', 'Beat Maker', 'Mixer', 'Effects', 'Master'];

  static Route<void> route({Future<void> Function(String prompt)? onAsk, Future<void> Function(String text)? onSpeak, int initialTab = 0, String? say}) =>
      MaterialPageRoute<void>(builder: (_) => CheRecordingStudio(onAsk: onAsk, onSpeak: onSpeak, initialTab: initialTab, say: say));

  @override
  State<CheRecordingStudio> createState() => _CheRecordingStudioState();
}

class _CheRecordingStudioState extends State<CheRecordingStudio> with SingleTickerProviderStateMixin {
  CheStudioController? _c;
  late final TabController _tabs = TabController(length: CheRecordingStudio.tabs.length, vsync: this, initialIndex: widget.initialTab);
  Timer? _tick;
  final _peaks = <String, Float32List>{};
  Future<String?> _voice(String words) async {
    final c = _c;
    if (c == null) return null;
    return cheStudioVoice(c, words, showTab: (i) => _tabs.animateTo(i), ask: widget.onAsk, speakFirst: widget.onSpeak);
  }

  @override
  void initState() {
    super.initState();
    CheRecordingStudio.voiceHandler = _voice;
    unawaited(_start());
  }

  Future<void> _start() async {
    var c = widget.controller;
    if (c == null) {
      final docs = await getApplicationDocumentsDirectory();
      c = CheStudioController(audio: CheNativeStudioAudio(), store: CheSongStore(Directory('${docs.path}/CHE Songs')));
    }
    if (!mounted) return;
    c.addListener(_onChange);
    setState(() => _c = c);
    await c.open();
    if (c.song.tracks.isEmpty) await c.newSong();
    _tick = Timer.periodic(const Duration(milliseconds: 200), (_) {
      if (mounted && (c!.playing || c.recording)) setState(() {});
    });
    final say = widget.say;
    if (say != null && say.trim().isNotEmpty) {
      final reply = await _voice(say);
      if (reply != null && reply.isNotEmpty) await widget.onSpeak?.call(reply);
    }
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    if (CheRecordingStudio.voiceHandler == _voice) CheRecordingStudio.voiceHandler = null;
    _tick?.cancel();
    _c?.removeListener(_onChange);
    if (widget.controller == null) {
      unawaited(_c?.stop());
      _c?.dispose();
    }
    _tabs.dispose();
    _title.dispose();
    super.dispose();
  }

  /// Runs one action and reports its real result: shown on the status line, a haptic, and a VoiceOver announcement.
  Future<void> _do(FutureOr<String> Function() action) async {
    HapticFeedback.selectionClick();
    final said = await action();
    if (!mounted || said.isEmpty) return;
    final failed = RegExp(r"\b(not|could not|failed|nothing|needs|first)\b", caseSensitive: false).hasMatch(said);
    if (failed) {
      HapticFeedback.heavyImpact();
    } else {
      HapticFeedback.mediumImpact();
    }
    unawaited(SemanticsService.sendAnnouncement(View.of(context), said, TextDirection.ltr));
  }

  @override
  Widget build(BuildContext context) {
    final c = _c;
    return Theme(
      data: CheTheme.dark(),
      child: Scaffold(
        appBar: AppBar(
          title: Text(c == null ? 'Recording Studio' : c.song.title, maxLines: 1, overflow: TextOverflow.ellipsis),
          actions: [
            IconButton(
              tooltip: 'Read aloud',
              icon: const Icon(Icons.record_voice_over_rounded),
              onPressed: c == null ? null : () => widget.onSpeak?.call(_describe(c)),
            ),
            if (widget.onAsk != null)
              IconButton(
                tooltip: 'Ask CHE for help with this song',
                icon: const Icon(Icons.auto_awesome_rounded),
                onPressed: c == null ? null : () => unawaited(widget.onAsk!('Help me with the song I am making in the CHE Recording Studio: lyrics, melody, arrangement or mix. What it really has now: ${c.brief()}.')),
              ),
          ],
          bottom: TabBar(
            controller: _tabs,
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: [for (final t in CheRecordingStudio.tabs) Tab(text: t)],
          ),
        ),
        body: c == null
            ? const Center(child: CircularProgressIndicator())
            : Column(children: [
                _transport(c),
                if (c.warning.isNotEmpty) _banner(c.warning),
                if (c.status.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 4, CheSpace.gutter, 4),
                    child: Text(c.status, maxLines: 3, overflow: TextOverflow.ellipsis, style: CheType.caption),
                  ),
                Expanded(
                  child: TabBarView(controller: _tabs, children: [
                    _recordTab(c),
                    _songsTab(c),
                    _beatTab(c),
                    _mixerTab(c),
                    _effectsTab(c),
                    _masterTab(c),
                  ]),
                ),
              ]),
      ),
    );
  }

  String _describe(CheStudioController c) {
    final state = switch (c.transport) {
      CheTransport.playing => 'playing',
      CheTransport.paused => 'paused',
      CheTransport.countIn => 'counting in',
      CheTransport.recording => 'recording',
      CheTransport.stopped => 'stopped',
    };
    final e = c.engineer;
    final good = e.snapshots.where((s) => s.good).length;
    return 'Recording Studio, ${CheRecordingStudio.tabs[_tabs.index]} tab. ${c.brief()}. Playhead ${cheClock(c.position)}, $state. '
        'Metronome ${c.metronome ? 'on' : 'off'}, loop ${c.loop ? 'on' : 'off'}, punch ${c.punch ? 'on' : 'off'}. '
        'Engineer Mode ${e.active ? 'on' : 'off'}, ${e.snapshots.length} snapshots, $good good mixes saved.'
        '${e.receipt.isEmpty ? '' : ' Last personalized processing receipt: ${e.receipt}.'} ${c.warning}';
  }

  Widget _banner(String text) => Semantics(
        container: true,
        label: 'Warning: $text',
        child: ExcludeSemantics(
          child: Container(
            width: double.infinity,
            margin: const EdgeInsets.symmetric(horizontal: CheSpace.gutter, vertical: 4),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: CheColors.warning.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(8)),
            child: Row(children: [
              Icon(Icons.headphones_rounded, color: CheColors.warning, size: 18),
              const SizedBox(width: 8),
              Expanded(child: Text(text, style: CheType.caption)),
            ]),
          ),
        ),
      );

  Widget _btn(IconData icon, String label, VoidCallback? onTap, {bool on = false, Color? color}) => IconButton(
        tooltip: label,
        isSelected: on,
        icon: Icon(icon, color: color),
        onPressed: onTap,
      );

  Widget _transport(CheStudioController c) {
    final rec = c.recording;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
      child: Column(children: [
        Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, children: [
          _btn(Icons.replay_rounded, 'Rewind to the start', () => _do(c.rewind)),
          _btn(Icons.arrow_back_rounded, 'Back 10 seconds', () => _do(() => c.nudge(-10))),
          c.playing
              ? _btn(Icons.pause_rounded, 'Pause', () => _do(c.pause))
              : _btn(Icons.play_arrow_rounded, 'Play', rec ? null : () => _do(() => c.play())),
          _btn(Icons.stop_rounded, 'Stop', () => _do(c.stop)),
          _btn(rec ? Icons.stop_circle : Icons.radio_button_checked, rec ? 'Stop recording' : 'Record', () => _do(rec ? c.stopRecording : c.record),
              color: Colors.redAccent),
          _btn(Icons.arrow_forward_rounded, 'Forward 10 seconds', () => _do(() => c.nudge(10))),
          _btn(Icons.sync_outlined, c.loop ? 'Loop on' : 'Loop off', () => _do(() => c.toggleLoop()), on: c.loop),
          _btn(Icons.schedule_rounded, c.metronome ? 'Metronome on' : 'Metronome off', () => _do(() => c.toggleMetronome()), on: c.metronome),
          _btn(Icons.headphones_rounded, c.monitoring ? 'Live monitoring on' : c.monitor ? 'Live monitoring requested' : 'Live monitoring off',
              () => _do(() => c.setMonitor(!c.monitor)), on: c.monitor),
        ]),
        Semantics(
          label: 'Playhead ${cheClock(c.position)} of ${cheClock(c.song.end)}, ${c.song.bpm.round()} BPM'
              '${rec ? ', ${c.transport == CheTransport.countIn ? 'counting in' : 'recording'}' : ''}${c.busy ? ', preparing audio' : ''}',
          child: ExcludeSemantics(
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              Text('${cheClock(c.position)} / ${cheClock(c.song.end)} · ${c.song.bpm.round()} BPM',
                  style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()])),
              if (rec) ...[
                const SizedBox(width: 8),
                Text(c.transport == CheTransport.countIn ? 'COUNT-IN' : 'REC', style: const TextStyle(color: Colors.redAccent, fontWeight: FontWeight.w800)),
                const SizedBox(width: 8),
                SizedBox(width: 80, child: LinearProgressIndicator(value: c.inputLevel == null ? 0 : ((c.inputLevel! + 60) / 60).clamp(0, 1).toDouble())),
              ],
              if (c.busy) const Padding(padding: EdgeInsets.only(left: 8), child: SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))),
            ]),
          ),
        ),
      ]),
    );
  }

  // ---- Record: New Recording and the Recording Timeline ----

  Float32List _peaksOf(String id, Float32List src) => _peaks.putIfAbsent(id, () {
        const hop = 512;
        final out = Float32List((src.length / hop).ceil());
        for (var i = 0; i < out.length; i++) {
          var p = 0.0;
          for (var j = i * hop; j < math.min(src.length, (i + 1) * hop); j++) {
            final a = src[j].abs();
            if (a > p) p = a;
          }
          out[i] = p;
        }
        return out;
      });

  Widget _recordTab(CheStudioController c) {
    final total = math.max(c.song.end, c.song.barSamples * 8);
    final clip = c.clip;
    return ListView(padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 8, CheSpace.gutter, 24), children: [
      Wrap(spacing: 8, runSpacing: 8, children: [
        FilledButton.icon(onPressed: () => _do(() => c.newSong()), icon: const Icon(Icons.add_rounded), label: const Text('New Recording')),
        OutlinedButton.icon(onPressed: () => _do(() => c.addTrack()), icon: const Icon(Icons.queue_music_rounded), label: const Text('Add track')),
        OutlinedButton.icon(onPressed: () => _do(() => _import(c)), icon: const Icon(Icons.folder_open_outlined), label: const Text('Import beat (WAV)')),
        OutlinedButton.icon(onPressed: () => _do(c.playBack), icon: const Icon(Icons.headphones_outlined), label: const Text('Play that back')),
      ]),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
        const Text('Count-in'),
        for (final n in [0, 1, 2])
          ChoiceChip(label: Text(n == 0 ? 'Off' : '$n bar${n == 2 ? 's' : ''}'), selected: c.countInBars == n, onSelected: (_) => _do(() => c.setCountIn(n))),
        FilterChip(label: const Text('Punch in/out'), selected: c.punch, onSelected: (_) => _do(() => c.togglePunch())),
      ]),
      if (c.punch && c.song.punchIn != null)
        Wrap(spacing: 8, children: [
          Text('Punch ${cheClock(c.song.punchIn!)} to ${cheClock(c.song.punchOut!)}'),
          TextButton(onPressed: () => _do(() => c.setPunch(c.position, math.max(c.position + c.song.barSamples, c.song.punchOut!))), child: const Text('Punch in here')),
          TextButton(onPressed: () => _do(() => c.setPunch(c.song.punchIn!, math.max(c.song.punchIn! + 4410, c.position))), child: const Text('Punch out here')),
        ]),
      if (c.loop && c.song.loopStart != null)
        Wrap(spacing: 8, children: [
          Text('Loop ${cheClock(c.song.loopStart!)} to ${cheClock(c.song.loopEnd!)}'),
          TextButton(onPressed: () => _do(() => c.setLoop(c.position, math.max(c.position + c.song.barSamples, c.song.loopEnd!))), child: const Text('Loop starts here')),
          TextButton(onPressed: () => _do(() => c.setLoop(c.song.loopStart!, math.max(c.song.loopStart! + c.song.barSamples, c.position))), child: const Text('Loop ends here')),
        ]),
      const SizedBox(height: 8),
      _engineerCard(c),
      const SizedBox(height: 8),
      Text('Recording Timeline', style: Theme.of(context).textTheme.titleMedium),
      for (final t in c.song.tracks) _trackRow(c, t, total),
      Semantics(
        label: 'Playhead position',
        child: Slider(
          value: c.position.clamp(0, total).toDouble(),
          max: total.toDouble(),
          onChanged: c.recording ? null : (v) => c.seek(v.round()),
          onChangeEnd: (v) => _do(() => c.seek(v.round())),
        ),
      ),
      if (clip != null) ...[
        Text('Selected clip: ${cheClock(clip.start)} to ${cheClock(clip.end)}', style: CheType.caption),
        Wrap(spacing: 4, runSpacing: 4, children: [
          OutlinedButton(onPressed: () => _do(c.trimStart), child: const Text('Trim start to playhead')),
          OutlinedButton(onPressed: () => _do(c.trimEnd), child: const Text('Trim end to playhead')),
          OutlinedButton(onPressed: () => _do(c.split), child: const Text('Split at playhead')),
          OutlinedButton(onPressed: () => _do(() => c.move(-1)), child: const Text('Move a beat earlier')),
          OutlinedButton(onPressed: () => _do(() => c.move(1)), child: const Text('Move a beat later')),
          OutlinedButton(onPressed: () => _do(c.duplicate), child: const Text('Duplicate')),
          OutlinedButton(onPressed: () => unawaited(_confirmDelete(c)), child: const Text('Remove clip')),
        ]),
      ],
      const SizedBox(height: 12),
      Semantics(
        label: 'Take alignment, ${c.song.latencyMs.round()} milliseconds added to the measured delay',
        child: Row(children: [
          const ExcludeSemantics(child: Text('Alignment')),
          Expanded(
            child: Slider(value: c.song.latencyMs, min: -300, max: 300, divisions: 60, label: '${c.song.latencyMs.round()} ms', onChanged: (v) => c.setLatency(v)),
          ),
        ]),
      ),
    ]);
  }

  // ---- Engineer Mode (che_engineer.dart): punch-in by bar, undo, bring me back ----

  int _punchFrom = 1, _punchTo = 2;

  Widget _engineerCard(CheStudioController c) {
    final e = c.engineer;
    final bars = math.max(8, (c.song.end / c.song.barSamples).ceil());
    if (_punchFrom > bars) _punchFrom = 1;
    if (_punchTo < _punchFrom || _punchTo > bars) _punchTo = _punchFrom;
    final good = e.snapshots.where((s) => s.good).lastOrNull;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Engineer', style: Theme.of(context).textTheme.titleSmall),
          Wrap(spacing: 8, runSpacing: 8, children: [
            FilterChip(
              label: const Text('Engineer Mode'),
              tooltip: e.active ? 'Engineer Mode on. Turn it off' : 'Engineer Mode off. Turn it on and hear the options',
              selected: e.active,
              onSelected: (on) => _do(() => on ? e.start() : e.stop()),
            ),
            OutlinedButton.icon(onPressed: () => _do(e.undo), icon: const Icon(Icons.undo_rounded), label: const Text('Undo')),
            OutlinedButton.icon(onPressed: () => _do(e.bringMeBack), icon: const Icon(Icons.history_rounded), label: const Text('Bring me back')),
            OutlinedButton.icon(onPressed: () => _do(e.markGood), icon: const Icon(Icons.bookmark_outline_rounded), label: const Text('Mark mix as good')),
            OutlinedButton(onPressed: () => _do(e.listSnapshots), child: const Text('Read snapshots')),
          ]),
          const SizedBox(height: 4),
          Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Semantics(
              label: 'Punch from bar $_punchFrom',
              child: DropdownButton<int>(
                value: _punchFrom,
                items: [for (var b = 1; b <= bars; b++) DropdownMenuItem(value: b, child: Text('From bar $b'))],
                onChanged: (v) => setState(() => _punchFrom = v ?? 1),
              ),
            ),
            Semantics(
              label: 'Punch to bar $_punchTo',
              child: DropdownButton<int>(
                value: _punchTo,
                items: [for (var b = _punchFrom; b <= bars; b++) DropdownMenuItem(value: b, child: Text('To bar $b'))],
                onChanged: (v) => setState(() => _punchTo = v ?? _punchFrom),
              ),
            ),
            FilledButton(
              onPressed: () => _do(() => e.armPunch(fromBar: _punchFrom, toBar: _punchTo)),
              child: Text('Arm punch-in, bars $_punchFrom to $_punchTo'),
            ),
          ]),
          Text(good == null ? 'No good mix saved yet.' : 'Last good mix: ${good.label}, ${good.when}. ${e.snapshots.length} snapshots saved with the song.',
              style: CheType.caption),
        ]),
      ),
    );
  }

  Future<void> _confirmDelete(CheStudioController c) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove this clip from the timeline?'),
        content: const Text('The recording stays saved with the song.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Remove')),
        ],
      ),
    );
    if (ok == true) await _do(c.deleteClip);
  }

  Future<String> _import(CheStudioController c) async {
    final picked = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: cheImportFormats, withData: true);
    final f = picked?.files.firstOrNull;
    if (f == null) return 'Import cancelled.';
    final bytes = f.bytes ?? (f.path == null ? null : await File(f.path!).readAsBytes());
    if (bytes == null) return 'That file could not be read.';
    final dot = f.name.lastIndexOf('.');
    return c.importAudio(bytes, name: dot > 0 ? f.name.substring(0, dot) : f.name, ext: dot > 0 ? f.name.substring(dot + 1) : 'wav');
  }

  Widget _trackRow(CheStudioController c, CheTrack t, int total) {
    final selected = c.selectedTrack == t.id;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Semantics(
          button: true,
          selected: selected,
          label: 'Track ${c.song.tracks.indexOf(t) + 1}, ${t.name}, ${t.clips.length} clips${t.mute ? ', muted' : ''}${t.solo ? ', soloed' : ''}',
          child: InkWell(
            onTap: () => _do(() => c.select(t.id)),
            child: ExcludeSemantics(
              child: Text('${t.name}${t.mute ? ' (muted)' : ''}${t.solo ? ' (solo)' : ''}',
                  style: TextStyle(fontWeight: selected ? FontWeight.w800 : FontWeight.w500)),
            ),
          ),
        ),
        LayoutBuilder(builder: (context, box) {
          final w = box.maxWidth;
          return GestureDetector(
            onTapDown: (d) {
              final at = (d.localPosition.dx / w * total).round();
              final hit = t.clips.where((cl) => at >= cl.start && at < cl.end).firstOrNull;
              unawaited(_do(() => c.select(t.id, hit?.id)));
            },
            child: ExcludeSemantics(
              child: CustomPaint(
                size: Size(w, 44),
                painter: _WavePainter(
                  clips: [
                    for (final cl in t.clips)
                      if (c.sources[cl.audioId] != null) (cl, _peaksOf(cl.audioId, c.sources[cl.audioId]!)),
                  ],
                  total: total,
                  playhead: c.position,
                  selected: c.selectedClip,
                  color: t.kind == 'vocal' ? const Color(0xFF3FD0F0) : const Color(0xFFFF3D8B),
                ),
              ),
            ),
          );
        }),
        // The clips as buttons, so VoiceOver can pick one without seeing the waveform.
        Wrap(spacing: 4, children: [
          for (final (i, cl) in t.clips.indexed)
            Semantics(
              button: true,
              selected: c.selectedClip == cl.id,
              label: '${t.name} clip ${i + 1}, ${cheClock(cl.start)} to ${cheClock(cl.end)}',
              child: ExcludeSemantics(
                child: ActionChip(
                  visualDensity: VisualDensity.compact,
                  label: Text('${i + 1}: ${cheClock(cl.start)}', style: const TextStyle(fontSize: 11)),
                  onPressed: () => _do(() => c.select(t.id, cl.id)),
                ),
              ),
            ),
        ]),
      ]),
    );
  }

  // ---- My Songs ----

  final _title = TextEditingController();
  String? _titleFor;

  Widget _songsTab(CheStudioController c) {
    final title = _title;
    if (_titleFor != c.song.id) {
      _titleFor = c.song.id;
      title.text = c.song.title;
    }
    return ListView(padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 8, CheSpace.gutter, 24), children: [
      Row(children: [
        Expanded(
          child: TextField(
            controller: title,
            decoration: const InputDecoration(labelText: 'Song name'),
            onSubmitted: (v) => _do(() => c.rename(v)),
          ),
        ),
        IconButton(tooltip: 'Rename the song', icon: const Icon(Icons.check_rounded), onPressed: () => _do(() => c.rename(title.text))),
      ]),
      const SizedBox(height: 8),
      Wrap(spacing: 8, children: [
        FilledButton.icon(onPressed: () => _do(() => c.newSong()), icon: const Icon(Icons.add_rounded), label: const Text('New Recording')),
        OutlinedButton.icon(onPressed: () => _do(c.saveNow), icon: const Icon(Icons.save_rounded), label: const Text('Save')),
        OutlinedButton.icon(onPressed: () => _do(c.export), icon: const Icon(Icons.save_rounded), label: const Text('Export WAV')),
        OutlinedButton.icon(onPressed: () => _do(() => c.export(format: 'm4a')), icon: const Icon(Icons.save_outlined), label: const Text('Export M4A')),
      ]),
      const SizedBox(height: 8),
      Text('My Songs', style: Theme.of(context).textTheme.titleMedium),
      if (c.songs.isEmpty) Text('No saved songs yet. Songs save themselves as you work.', style: CheType.bodyDim),
      for (final s in c.songs)
        ListTile(
          selected: s.id == c.song.id,
          leading: const Icon(Icons.music_note_rounded),
          title: Text(s.title),
          subtitle: Text('${s.tracks.length} tracks · ${s.bpm.round()} BPM · ${cheClock(s.end)} · saved ${_ago(s.updated)}'),
          onTap: () => _do(() => c.openSong(s.id)),
        ),
    ]);
  }

  String _ago(int ms) {
    final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
    if (d.inMinutes < 1) return 'just now';
    if (d.inHours < 1) return '${d.inMinutes} min ago';
    if (d.inDays < 1) return '${d.inHours} h ago';
    return '${d.inDays} days ago';
  }

  // ---- Beat Maker ----

  Widget _beatTab(CheStudioController c) {
    final beat = c.song.beat;
    return ListView(padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 8, CheSpace.gutter, 24), children: [
      _producerCard(c),
      const SizedBox(height: 8),
      Text('Beat Maker', style: Theme.of(context).textTheme.titleSmall),
      Wrap(spacing: 8, runSpacing: 8, children: [
        FilledButton.icon(onPressed: () => _do(c.playBeat), icon: const Icon(Icons.play_arrow_rounded), label: const Text('Play the beat')),
        OutlinedButton(onPressed: () => _do(c.useBeat), child: const Text('Use in song')),
        OutlinedButton(onPressed: () => _do(c.starterBeat), child: const Text('Starter groove')),
        OutlinedButton(onPressed: () => _do(c.clearBeat), child: const Text('Clear')),
      ]),
      Semantics(
        label: 'Tempo ${c.song.bpm.round()} BPM',
        child: Slider(value: c.song.bpm, min: 60, max: 180, divisions: 120, label: '${c.song.bpm.round()} BPM', onChanged: (v) => c.setBpm(v)),
      ),
      Semantics(
        label: 'Swing ${(beat.swing * 200).round()} percent',
        child: Slider(value: beat.swing, max: 0.5, divisions: 10, label: 'Swing ${(beat.swing * 200).round()}%', onChanged: (v) => c.setSwing(v)),
      ),
      Wrap(spacing: 8, children: [
        const Text('Bars'),
        for (final n in [1, 2, 4, 8])
          ChoiceChip(
            label: Text('$n'),
            selected: beat.bars == n,
            onSelected: (_) {
              beat.bars = n;
              unawaited(_do(() => c.setBpm(c.song.bpm)));
            },
          ),
      ]),
      const SizedBox(height: 8),
      for (final inst in CheBeat.instruments)
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Row(children: [
            SizedBox(width: 74, child: Text(CheBeat.labels[inst]!, style: CheType.caption)),
            Expanded(
              child: Row(children: [
                for (var s = 0; s < 16; s++)
                  Expanded(
                    child: Semantics(
                      button: true,
                      toggled: beat.steps[inst]![s],
                      label: '${CheBeat.labels[inst]} step ${s + 1}',
                      child: ExcludeSemantics(
                        child: GestureDetector(
                          onTap: () => _do(() => c.toggleStep(inst, s)),
                          child: Container(
                            height: 26,
                            margin: EdgeInsets.only(right: s % 4 == 3 ? 4 : 1),
                            decoration: BoxDecoration(
                              color: beat.steps[inst]![s] ? const Color(0xFFFF3D8B) : (s ~/ 4).isEven ? Colors.white12 : Colors.white10,
                              borderRadius: BorderRadius.circular(3),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ]),
            ),
          ]),
        ),
    ]);
  }

  String _genre = 'hip hop';
  int? _beatKey;
  bool? _beatMinor;

  Widget _producerCard(CheStudioController c) {
    final g = cheGenres[_genre]!;
    final key = _beatKey ?? g.key;
    final minor = _beatMinor ?? g.minor;
    CheBeatSpec spec() => CheBeatSpec.of(_genre, bpm: c.song.bpm, key: key, minor: minor);
    final producedTrack = c.song.tracks.where((t) => t.name == 'Produced beat').firstOrNull;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Beat Producer', style: Theme.of(context).textTheme.titleSmall),
          Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Semantics(
              label: 'Genre ${g.name}',
              child: DropdownButton<String>(
                value: _genre,
                items: [for (final e in cheGenres.entries) DropdownMenuItem(value: e.key, child: Text(e.value.name))],
                onChanged: (v) => setState(() {
                  _genre = v ?? 'hip hop';
                  _beatKey = null;
                  _beatMinor = null;
                }),
              ),
            ),
            Semantics(
              label: 'Key ${cheNoteNames[key]}',
              child: DropdownButton<int>(
                value: key,
                items: [for (var k = 0; k < 12; k++) DropdownMenuItem(value: k, child: Text(cheNoteNames[k]))],
                onChanged: (v) => setState(() => _beatKey = v),
              ),
            ),
            Semantics(
              label: minor ? 'Minor key' : 'Major key',
              child: DropdownButton<bool>(
                value: minor,
                items: const [DropdownMenuItem(value: true, child: Text('minor')), DropdownMenuItem(value: false, child: Text('major'))],
                onChanged: (v) => setState(() => _beatMinor = v),
              ),
            ),
          ]),
          Wrap(spacing: 8, runSpacing: 8, children: [
            FilledButton.icon(
              onPressed: () => _do(() => c.engineer.produceBeat(spec())),
              icon: const Icon(Icons.tune_rounded),
              label: Text('Produce ${g.name} beat at ${c.song.bpm.round()} BPM'),
            ),
            OutlinedButton(onPressed: c.song.producer == null ? null : () => _do(c.engineer.anotherBeat), child: const Text('New variation')),
            if (producedTrack != null)
              OutlinedButton.icon(
                onPressed: () => _do(() => c.play(onlyTrack: producedTrack.id, from: 0)),
                icon: const Icon(Icons.play_arrow_rounded),
                label: const Text('Play produced beat'),
              ),
          ]),
          Text('Synthesised on this iPhone and placed on the Produced beat track, ready for the mixer and export.', style: CheType.caption),
        ]),
      ),
    );
  }

  // ---- Mixer ----

  Widget _mixerTab(CheStudioController c) => ListView(padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 8, CheSpace.gutter, 24), children: [
        Wrap(spacing: 8, children: [
          FilledButton.icon(onPressed: () => _do(c.balance), icon: const Icon(Icons.tune_rounded), label: const Text('Balance the mix')),
          if (widget.onAsk != null)
            OutlinedButton(
              onPressed: () => unawaited(widget.onAsk!('Give me mixing advice for my song in the CHE Recording Studio. What it really has now: ${c.brief()}.')),
              child: const Text('Mixing advice from CHE'),
            ),
        ]),
        for (final t in c.song.tracks)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text(t.name, style: const TextStyle(fontWeight: FontWeight.w700))),
                  FilterChip(label: const Text('M'), tooltip: 'Mute ${t.name}', selected: t.mute, onSelected: (_) => _do(() => c.toggleMute(t))),
                  const SizedBox(width: 4),
                  FilterChip(label: const Text('S'), tooltip: 'Solo ${t.name}', selected: t.solo, onSelected: (_) => _do(() => c.toggleSolo(t))),
                ]),
                Semantics(
                  label: '${t.name} volume ${(t.volume * 100).round()} percent',
                  child: Slider(value: t.volume, max: 1.5, label: 'Volume ${(t.volume * 100).round()}%', divisions: 30, onChanged: (v) => c.setVolume(t, v)),
                ),
                Semantics(
                  label: '${t.name} pan',
                  child: Slider(value: t.pan, min: -1, max: 1, divisions: 20, label: 'Pan ${t.pan.toStringAsFixed(1)}', onChanged: (v) => c.setPan(t, v)),
                ),
              ]),
            ),
          ),
      ]);

  // ---- Effects ----

  Widget _effectsTab(CheStudioController c) {
    final t = c.track ?? c.song.tracks.firstOrNull;
    if (t == null) return Center(child: Text('Add a track first.', style: CheType.bodyDim));
    final fx = t.fx;
    Widget slider(String label, double v, ValueChanged<double> on, {double min = 0, double max = 1, String Function(double)? show}) => Semantics(
          label: '$label ${show?.call(v) ?? '${(v * 100).round()} percent'}',
          child: Row(children: [
            ExcludeSemantics(child: SizedBox(width: 110, child: Text(label, style: CheType.caption))),
            Expanded(child: Slider(value: v.clamp(min, max).toDouble(), min: min, max: max, onChanged: on, label: show?.call(v) ?? '${(v * 100).round()}%')),
          ]),
        );
    return ListView(padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 8, CheSpace.gutter, 24), children: [
      DropdownButtonFormField<String>(
        initialValue: t.id,
        decoration: const InputDecoration(labelText: 'Track'),
        items: [for (final x in c.song.tracks) DropdownMenuItem(value: x.id, child: Text(x.name))],
        onChanged: (id) => id == null ? null : _do(() => c.select(id)),
      ),
      const SizedBox(height: 8),
      Text('Vocal presets', style: CheType.caption),
      Wrap(spacing: 6, children: [
        for (final p in CheEffects.presets.keys)
          ChoiceChip(label: Text(p), selected: fx.preset == p, onSelected: (_) => _do(() => c.applyPreset(p))),
      ]),
      const SizedBox(height: 8),
      Text('BandLab-style chains ($cheRecreatedLabel)', style: CheType.caption),
      Wrap(spacing: 6, children: [
        for (final p in cheRecreatedPresets)
          Semantics(
            button: true,
            selected: fx.preset == p.label,
            label: '${p.name}, $cheRecreatedLabel',
            child: ExcludeSemantics(
              child: ChoiceChip(
                label: Text(p.name.replaceFirst('BandLab ', '')),
                selected: fx.preset == p.label,
                onSelected: (_) => _do(() => c.engineer.recreatePreset(p.name)),
              ),
            ),
          ),
      ]),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [
        OutlinedButton.icon(onPressed: () => _do(c.engineer.analyze), icon: const Icon(Icons.graphic_eq_rounded), label: const Text('Analyze vocal')),
        OutlinedButton.icon(onPressed: () => _do(c.engineer.personalize), icon: const Icon(Icons.person_outline_rounded), label: const Text('Personalize processing')),
      ]),
      if (c.engineer.report != null)
        Semantics(
          container: true,
          label: 'Vocal analysis: ${c.engineer.report!.describe()}${c.engineer.receipt.isEmpty ? '' : ' Receipt, before to after: ${c.engineer.receipt}.'}',
          child: ExcludeSemantics(
            child: Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('${c.engineer.report!.describe()}${c.engineer.receipt.isEmpty ? '' : '\nBefore to after: ${c.engineer.receipt}'}', style: CheType.caption),
            ),
          ),
        ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Noise reduction'),
        value: fx.noise,
        onChanged: (v) => _do(() => c.setEffect('noise', v ? 1 : 0, on: t)),
      ),
      slider('Pitch correction', fx.pitch, (v) => c.setEffect('pitch', v, on: t)),
      Row(children: [
        Expanded(
          child: DropdownButtonFormField<int>(
            initialValue: fx.key,
            decoration: const InputDecoration(labelText: 'Key'),
            items: [for (var k = 0; k < 12; k++) DropdownMenuItem(value: k, child: Text(cheNoteNames[k]))],
            onChanged: (k) => _do(() => c.setKey(t, k ?? 0, fx.scale)),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: DropdownButtonFormField<String>(
            initialValue: fx.scale,
            decoration: const InputDecoration(labelText: 'Scale'),
            items: [for (final s in cheScales.keys) DropdownMenuItem(value: s, child: Text(s))],
            onChanged: (s) => _do(() => c.setKey(t, fx.key, s ?? 'chromatic')),
          ),
        ),
      ]),
      slider('Reverb', fx.reverb, (v) => c.setEffect('reverb', v, on: t)),
      slider('Room size', fx.room, (v) {
        fx.room = v;
        c.setEffect('reverb', fx.reverb, on: t);
      }),
      slider('Delay', fx.delay, (v) => c.setEffect('delay', v, on: t)),
      slider('Delay time', fx.delayMs, (v) {
        fx.delayMs = v;
        c.setEffect('delay', fx.delay, on: t);
      }, min: 60, max: 1000, show: (v) => '${v.round()} ms'),
      slider('Compression', fx.compress, (v) => c.setEffect('compress', v, on: t)),
      slider('EQ low', fx.eqLow, (v) => c.setEq(t, low: v), min: -12, max: 12, show: (v) => '${v.round()} dB'),
      slider('EQ mid', fx.eqMid, (v) => c.setEq(t, mid: v), min: -12, max: 12, show: (v) => '${v.round()} dB'),
      slider('EQ high', fx.eqHigh, (v) => c.setEq(t, high: v), min: -12, max: 12, show: (v) => '${v.round()} dB'),
      const SizedBox(height: 8),
      OutlinedButton.icon(onPressed: () => _do(() => c.play(onlyTrack: t.id, from: 0)), icon: const Icon(Icons.headphones_rounded), label: Text('Hear ${t.name} with effects')),
    ]);
  }

  // ---- Mastering ----

  Widget _masterTab(CheStudioController c) {
    final m = c.song.master;
    Widget slider(String label, double v, double min, double max, ValueChanged<double> on, String unit) => Semantics(
          label: '$label ${v.toStringAsFixed(1)} $unit',
          child: Row(children: [
            ExcludeSemantics(child: SizedBox(width: 120, child: Text(label, style: CheType.caption))),
            Expanded(child: Slider(value: v.clamp(min, max).toDouble(), min: min, max: max, label: '${v.toStringAsFixed(1)} $unit', onChanged: on)),
          ]),
        );
    void edit(VoidCallback f) {
      f();
      c.song.updated = DateTime.now().millisecondsSinceEpoch;
      setState(() {});
    }

    return ListView(padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 8, CheSpace.gutter, 24), children: [
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Master the song'),
        subtitle: const Text('Tone, bus compression, loudness and a peak limiter on the whole mix.'),
        value: m.enabled,
        onChanged: (v) => _do(() => c.master(on: v)),
      ),
      slider('Low end', m.low, -6, 6, (v) => edit(() => m.low = v), 'dB'),
      slider('Brightness', m.high, -6, 6, (v) => edit(() => m.high = v), 'dB'),
      slider('Glue', m.glue, 0, 1, (v) => edit(() => m.glue = v), ''),
      slider('Loudness (RMS)', m.targetRmsDb, -20, -8, (v) => edit(() => m.targetRmsDb = v), 'dB'),
      slider('Ceiling', m.ceilingDb, -3, -0.1, (v) => edit(() => m.ceilingDb = v), 'dB'),
      Wrap(spacing: 8, runSpacing: 8, children: [
        FilledButton(onPressed: () => _do(() => c.master()), child: const Text('Master and measure')),
        OutlinedButton(onPressed: () => _do(() => c.play(from: 0)), child: const Text('Play the master')),
        OutlinedButton.icon(onPressed: () => _do(c.export), icon: const Icon(Icons.save_rounded), label: const Text('Export WAV')),
        OutlinedButton.icon(onPressed: () => _do(() => c.export(format: 'm4a')), icon: const Icon(Icons.save_outlined), label: const Text('Export M4A')),
      ]),
      const SizedBox(height: 8),
      Text('Exports go to Files, On My iPhone, CHE, CHE Songs, Exports: WAV, or M4A (AAC) on the newest app build. '
          'MP3 can be imported but not exported (the iPhone has no MP3 encoder).', style: CheType.bodyDim),
    ]);
  }
}

class _WavePainter extends CustomPainter {
  _WavePainter({required this.clips, required this.total, required this.playhead, required this.selected, required this.color});
  final List<(CheClip, Float32List)> clips;
  final int total;
  final int playhead;
  final String? selected;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRRect(RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(6)), Paint()..color = Colors.white10);
    final mid = size.height / 2;
    for (final (clip, peaks) in clips) {
      final x0 = clip.start / total * size.width, x1 = clip.end / total * size.width;
      final sel = clip.id == selected;
      canvas.drawRRect(RRect.fromLTRBR(x0, 2, x1, size.height - 2, const Radius.circular(4)), Paint()..color = color.withValues(alpha: sel ? 0.35 : 0.18));
      final wave = Paint()
        ..color = color
        ..strokeWidth = 1;
      for (var x = x0; x < x1; x += 1.5) {
        final s = clip.offset + ((x - x0) / size.width * total).round();
        final p = peaks[(s ~/ 512).clamp(0, peaks.length - 1)];
        canvas.drawLine(Offset(x, mid - p * mid * 0.9), Offset(x, mid + p * mid * 0.9), wave);
      }
      if (sel) {
        canvas.drawRRect(RRect.fromLTRBR(x0, 2, x1, size.height - 2, const Radius.circular(4)), Paint()
          ..style = PaintingStyle.stroke
          ..color = Colors.white
          ..strokeWidth = 1.5);
      }
    }
    final px = playhead / total * size.width;
    canvas.drawLine(Offset(px, 0), Offset(px, size.height), Paint()
      ..color = Colors.white
      ..strokeWidth = 1.5);
  }

  @override
  bool shouldRepaint(_WavePainter old) => true;
}
