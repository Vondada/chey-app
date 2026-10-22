// Visual Studio video editor. Top: the preview. Middle: a visual timeline (clips, waveforms, text, captions,
// playhead). Bottom: one context toolbar (Edit · Adjust · Audio · Text · Captions · Effects). Every action is a real
// operation on the stored timeline; every drag has a button; every control has a spoken label.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'che_visual_adjust.dart';
import 'che_visual_client.dart';
import 'che_visual_session.dart';

const _accent = Color(0xFF7FF5E6);
const _pxPerSecond = 44.0;

class CheVideoEditor extends StatefulWidget {
  const CheVideoEditor({super.key, required this.client, required this.projectId, this.pickMedia});
  final CheVisualClient client;
  final String projectId;

  /// Opens the media library or the photo picker and returns a media item ({id, kind, mime_type, duration_seconds}).
  final Future<Map<String, dynamic>?> Function(BuildContext context, {required String kind})? pickMedia;

  @override
  State<CheVideoEditor> createState() => _CheVideoEditorState();
}

class _CheVideoEditorState extends State<CheVideoEditor> {
  Map<String, dynamic>? _view;
  String? _selected;
  double _playhead = 0;
  bool _playing = false;
  bool _busy = false;
  String _status = '';
  String _tab = 'Edit';
  String _adjustKey = 'brightness';
  bool _adjustAll = false;
  WebViewController? _player;
  String? _playerSource;
  Timer? _tick;
  Timer? _poll;
  final _peaks = <String, List<double>?>{};
  final _ask = TextEditingController();

  Map<String, dynamic> get _doc => Map<String, dynamic>.from((_view?['doc'] as Map?) ?? const {});
  List<Map<String, dynamic>> get _clips => [for (final c in (_doc['clips'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)];
  List<Map<String, dynamic>> get _rows => [for (final r in (_view?['timeline'] as List? ?? const [])) Map<String, dynamic>.from(r as Map)];
  double get _duration => _rows.isEmpty ? 0 : (_rows.last['end'] as num).toDouble();
  Map<String, dynamic>? get _selClip => _clips.where((c) => c['id'] == _selected).firstOrNull;

  @override
  void initState() {
    super.initState();
    CheVisualSession.open(widget.projectId);
    unawaited(_load());
  }

  @override
  void dispose() {
    CheVisualSession.close(widget.projectId);
    _tick?.cancel();
    _poll?.cancel();
    _ask.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      _apply(await widget.client.project(widget.projectId));
    } on CheVisualException catch (e) {
      _say(e.message);
    }
  }

  void _apply(Map<String, dynamic> v) {
    _view = v;
    if (_selected != null && !_clips.any((c) => c['id'] == _selected) && !(_doc['audio'] as List? ?? const []).any((a) => (a as Map)['id'] == _selected)) _selected = null;
    _selected ??= _clips.firstOrNull?['id'] as String?;
    CheVisualSession.selection = _selected;
    for (final a in (_doc['audio'] as List? ?? const [])) {
      final id = (a as Map)['asset'] as String?;
      if (id != null && !_peaks.containsKey(id)) {
        _peaks[id] = null;
        unawaited(widget.client.post({'action': 'waveform', 'project_id': widget.projectId, 'asset': id}).then((r) {
          if (r['peaks'] is List && mounted) setState(() => _peaks[id] = [for (final p in r['peaks'] as List) (p as num).toDouble()]);
        }).catchError((_) {}));
      }
    }
    final render = (v['project'] as Map?)?['render'] as Map?;
    if (render != null && !{'ready', 'failed'}.contains(render['stage'])) _watchRender();
    if (mounted) setState(() {});
  }

  void _say(String text) {
    _status = text;
    if (mounted) {
      SemanticsService.sendAnnouncement(View.of(context), text, TextDirection.ltr);
      setState(() {});
    }
  }

  Future<void> _run(Future<Map<String, dynamic>> Function() call) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = await call();
      if (r['doc'] != null) _apply(r);
      if ('${r['said'] ?? ''}'.isNotEmpty) _say('${r['said']}');
      HapticFeedback.selectionClick();
    } on CheVisualException catch (e) {
      _say(e.message);
      HapticFeedback.heavyImpact();
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _op(Map<String, dynamic> op) => _run(() => widget.client.op(widget.projectId, op));

  // ─── Player ──────────────────────────────────────────────────────────────

  /// The clip under the playhead plays in the in-app player (the same WebView the chat uses for videos); a finished
  /// render plays as itself. Images show as pictures.
  Map<String, dynamic>? get _clipAtPlayhead {
    for (final r in _rows) {
      if (_playhead >= (r['start'] as num) && _playhead < (r['end'] as num)) return _clips.firstWhere((c) => c['id'] == r['id']);
    }
    return _clips.lastOrNull;
  }

  void _ensurePlayer(String url) {
    if (kIsWeb || _playerSource == url) return;
    _playerSource = url;
    try {
      _player = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(Colors.black)
        ..loadRequest(Uri.parse(url), headers: widget.client.headers());
    } catch (_) {
      _player = null; // no in-app player on this platform; the timeline still works
    }
  }

  Future<void> _js(String code) async {
    try {
      await _player?.runJavaScript('(function(){var v=document.querySelector("video");if(!v)return;$code})()');
    } catch (_) {/* player not ready yet */}
  }

  Future<void> _seekTo(double t) async {
    _playhead = t.clamp(0, _duration);
    CheVisualSession.playhead = _playhead;
    final c = _clipAtPlayhead;
    final row = _rows.where((r) => r['id'] == c?['id']).firstOrNull;
    if (c != null && row != null && c['kind'] == 'video') {
      final local = (c['in'] as num) + (_playhead - (row['start'] as num)) * ((c['speed'] as num?) ?? 1);
      await _js('v.currentTime=$local;');
    }
    if (mounted) setState(() {});
  }

  Future<void> _togglePlay() async {
    _playing = !_playing;
    if (_playing) {
      await _js('v.play();');
      _tick?.cancel();
      final started = DateTime.now();
      final from = _playhead;
      _tick = Timer.periodic(const Duration(milliseconds: 250), (_) {
        final t = from + DateTime.now().difference(started).inMilliseconds / 1000;
        if (t >= _duration) {
          _tick?.cancel();
          _playing = false;
          unawaited(_js('v.pause();'));
        }
        if (mounted) setState(() => _playhead = t.clamp(0, _duration));
        CheVisualSession.playhead = _playhead;
      });
    } else {
      _tick?.cancel();
      await _js('v.pause();');
    }
    if (mounted) setState(() {});
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  Future<void> _render() async {
    await _run(() => widget.client.post({'action': 'render', 'project_id': widget.projectId}));
    _watchRender();
  }

  void _watchRender() {
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 8), (_) async {
      if (!mounted) return;
      try {
        final v = await widget.client.project(widget.projectId);
        final r = (v['project'] as Map?)?['render'] as Map?;
        setState(() => _view = v);
        if (r == null || {'ready', 'failed'}.contains(r['stage'])) {
          _poll?.cancel();
          _say(r?['stage'] == 'ready' ? 'Render ready. The MP4 was checked and plays.' : 'Render failed: ${r?['error'] ?? 'unknown reason'}');
        }
      } on CheVisualException {
        // the last known stage stays on screen
      }
    });
  }

  // ─── UI ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final project = (_view?['project'] as Map?) ?? const {};
    return Scaffold(
      backgroundColor: const Color(0xFF071019),
      appBar: AppBar(
        backgroundColor: const Color(0xFF071019),
        title: Text('${project['title'] ?? 'Video'}', overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(tooltip: 'Undo', onPressed: project['can_undo'] == true ? () => _run(() => widget.client.post({'action': 'undo', 'project_id': widget.projectId})) : null, icon: const Icon(Icons.undo_rounded)),
          IconButton(tooltip: 'Redo', onPressed: project['can_redo'] == true ? () => _run(() => widget.client.post({'action': 'redo', 'project_id': widget.projectId})) : null, icon: Transform.flip(flipX: true, child: const Icon(Icons.undo_rounded))),
          PopupMenuButton<String>(
            tooltip: 'More',
            onSelected: _menu,
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'render', child: Text('Render MP4')),
              const PopupMenuItem(value: 'version', child: Text('Save version')),
              for (final v in (project['versions'] as List? ?? const [])) PopupMenuItem(value: 'restore:${(v as Map)['id']}', child: Text('Restore ${v['label']}')),
              const PopupMenuItem(value: 'variants', child: Text('Make TikTok, Reels and YouTube versions')),
              const PopupMenuItem(value: 'template', child: Text('Save as template')),
            ],
          ),
        ],
      ),
      body: _view == null
          ? Center(child: Text(_status.isEmpty ? 'Loading…' : _status))
          : Column(children: [
              Expanded(flex: 4, child: _preview(project)),
              _transport(),
              _statusLine(project),
              SizedBox(height: 150, child: _timeline()),
              _toolRow(),
              _askBar(),
              _tabs(),
              SizedBox(height: 150, child: _inspector()),
            ]),
    );
  }

  Widget _preview(Map project) {
    final render = project['render'] as Map?;
    final ready = render?['stage'] == 'ready' && render?['media_id'] != null;
    final clip = _clipAtPlayhead;
    String? url;
    if (ready) {
      url = widget.client.mediaUrl('${render!['media_id']}', video: true);
    } else if (clip != null && clip['asset'] != null) {
      url = widget.client.mediaUrl('${clip['asset']}', video: clip['kind'] == 'video');
    }
    if (url == null) {
      return const Center(child: Text('Add a clip to start.', style: TextStyle(color: Colors.white70)));
    }
    if (!ready && clip?['kind'] == 'image') {
      return Semantics(label: 'Preview: picture ${clip?['name']}', child: Image.network(url, headers: widget.client.headers(), fit: BoxFit.contain, errorBuilder: (_, _, _) => const SizedBox.shrink()));
    }
    _ensurePlayer(url);
    final player = _player;
    return Semantics(
      label: ready ? 'Rendered video preview' : 'Preview of ${clip?['name']}',
      child: player == null ? const SizedBox.shrink() : WebViewWidget(controller: player),
    );
  }

  Widget _transport() {
    String fmt(double s) => '${(s ~/ 60)}:${(s % 60).floor().toString().padLeft(2, '0')}';
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, children: [
        IconButton(tooltip: 'Back 15 seconds', icon: Transform.flip(flipX: true, child: const Icon(Icons.fast_forward)), onPressed: () => _seekTo(_playhead - 15)),
        IconButton(tooltip: 'Back 10 seconds', icon: const Icon(Icons.replay_rounded), onPressed: () => _seekTo(_playhead - 10)),
        IconButton.filled(tooltip: _playing ? 'Pause' : 'Play', iconSize: 34, icon: Icon(_playing ? Icons.pause_rounded : Icons.play_arrow_rounded), onPressed: _togglePlay),
        IconButton(tooltip: 'Forward 10 seconds', icon: Transform.flip(flipX: true, child: const Icon(Icons.replay_rounded)), onPressed: () => _seekTo(_playhead + 10)),
        IconButton(tooltip: 'Forward 15 seconds', icon: const Icon(Icons.fast_forward), onPressed: () => _seekTo(_playhead + 15)),
        Semantics(label: 'Playhead ${_playhead.toStringAsFixed(1)} of ${_duration.toStringAsFixed(1)} seconds', child: ExcludeSemantics(child: Text('${fmt(_playhead)} / ${fmt(_duration)}', style: const TextStyle(color: Colors.white70, fontFeatures: [FontFeature.tabularFigures()])))),
      ]),
    );
  }

  Widget _statusLine(Map project) {
    final r = project['render'] as Map?;
    final stage = '${r?['stage'] ?? ''}';
    final label = {'preparing': 'Preparing', 'rendering': 'Rendering', 'finalizing': 'Finalizing', 'ready': 'Ready', 'failed': 'FAILED'}[stage];
    final text = label != null ? 'Render: $label${stage == 'failed' ? ' — ${r?['error'] ?? ''}' : ''}' : _status;
    if (text.isEmpty) return const SizedBox(height: 2);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      child: Row(children: [
        if (label != null && stage != 'ready' && stage != 'failed') const Padding(padding: EdgeInsets.only(right: 8), child: SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))),
        Expanded(child: Text(text, style: TextStyle(color: stage == 'failed' ? Colors.redAccent : Colors.white70), maxLines: 3)),
        if (stage == 'failed') TextButton(onPressed: () => _run(() => widget.client.post({'action': 'retry_render', 'project_id': widget.projectId})), child: const Text('Retry')),
      ]),
    );
  }

  Widget _timeline() {
    final audio = [for (final a in (_doc['audio'] as List? ?? const [])) Map<String, dynamic>.from(a as Map)];
    final text = [for (final t in (_doc['text'] as List? ?? const [])) Map<String, dynamic>.from(t as Map)];
    final cues = [for (final c in ((_doc['captions'] as Map?)?['cues'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)];
    final width = (_duration + 2) * _pxPerSecond + 32;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: SizedBox(
        width: width,
        child: GestureDetector(
          onHorizontalDragUpdate: (d) => _seekTo(_playhead + d.delta.dx / _pxPerSecond),
          onTapDown: (d) => _seekTo(d.localPosition.dx / _pxPerSecond),
          child: Stack(children: [
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(height: 16, child: CustomPaint(painter: _RulerPainter(_duration), size: Size(width, 16))),
              SizedBox(
                height: 52,
                child: Stack(children: [
                  for (final r in _rows) _clipBlock(_clips.firstWhere((c) => c['id'] == r['id']), r),
                ]),
              ),
              SizedBox(
                height: 30,
                child: Stack(children: [
                  for (final a in audio)
                    Positioned(
                      left: ((a['start'] as num?) ?? 0) * _pxPerSecond,
                      width: _duration * _pxPerSecond,
                      top: 2,
                      bottom: 2,
                      child: Semantics(
                        button: true,
                        selected: _selected == a['id'],
                        label: '${a['role']} track ${a['name']}, volume ${(((a['volume'] as num?) ?? 1) * 100).round()} percent${a['muted'] == true ? ', muted' : ''}',
                        child: GestureDetector(
                          onTap: () => setState(() => _selected = '${a['id']}'),
                          child: Container(
                            decoration: BoxDecoration(color: const Color(0xFF1C3B4A), borderRadius: BorderRadius.circular(6), border: _selected == a['id'] ? Border.all(color: _accent) : null),
                            child: CustomPaint(painter: _WavePainter(_peaks['${a['asset']}'])),
                          ),
                        ),
                      ),
                    ),
                ]),
              ),
              SizedBox(
                height: 22,
                child: Stack(children: [
                  for (final t in text) _band(t, '${t['text']}', const Color(0xFF6B4DFF), 'Text overlay'),
                  for (final c in cues) _band(c, '${c['text']}', const Color(0xFF8A6A1C), 'Caption'),
                ]),
              ),
            ]),
            Positioned(left: _playhead * _pxPerSecond - 1, top: 0, bottom: 0, child: IgnorePointer(child: Container(width: 2, color: _accent))),
          ]),
        ),
      ),
    );
  }

  Widget _clipBlock(Map<String, dynamic> c, Map<String, dynamic> r) {
    final left = (r['start'] as num) * _pxPerSecond;
    final w = ((r['length'] as num) * _pxPerSecond).clamp(24, double.infinity).toDouble();
    final selected = _selected == c['id'];
    final index = (r['index'] as num).toInt() + 1;
    return Positioned(
      left: left,
      width: w,
      top: 4,
      bottom: 4,
      child: Semantics(
        button: true,
        selected: selected,
        label: '${c['kind'] == 'image' ? 'Picture' : 'Video'} clip $index, ${c['name']}, ${(r['length'] as num).toStringAsFixed(1)} seconds${selected ? ', selected' : ''}',
        child: GestureDetector(
          onTap: () => setState(() {
            _selected = '${c['id']}';
            CheVisualSession.selection = _selected;
          }),
          child: Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(color: const Color(0xFF213847), borderRadius: BorderRadius.circular(8), border: Border.all(color: selected ? _accent : Colors.white24, width: selected ? 2 : 1)),
            child: Stack(fit: StackFit.expand, children: [
              if (c['kind'] == 'image' && c['asset'] != null) Image.network(widget.client.mediaUrl('${c['asset']}'), headers: widget.client.headers(), fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox.shrink()),
              Padding(
                padding: const EdgeInsets.all(4),
                child: ExcludeSemantics(child: Text('${c['name']}', maxLines: 1, overflow: TextOverflow.fade, softWrap: false, style: const TextStyle(fontSize: 11, color: Colors.white, shadows: [Shadow(blurRadius: 3)]))),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _band(Map<String, dynamic> item, String label, Color color, String kind) {
    final start = ((item['start'] as num?) ?? 0).toDouble();
    final end = ((item['end'] as num?) ?? start + 1).toDouble();
    return Positioned(
      left: start * _pxPerSecond,
      width: ((end - start) * _pxPerSecond).clamp(12, double.infinity).toDouble(),
      top: 2,
      bottom: 2,
      child: Semantics(
        label: '$kind: $label, ${start.toStringAsFixed(1)} to ${end.toStringAsFixed(1)} seconds',
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          decoration: BoxDecoration(color: color.withValues(alpha: 0.75), borderRadius: BorderRadius.circular(4)),
          child: ExcludeSemantics(child: Text(label, maxLines: 1, overflow: TextOverflow.fade, softWrap: false, style: const TextStyle(fontSize: 10, color: Colors.white))),
        ),
      ),
    );
  }

  Widget _toolRow() {
    final c = _selClip;
    final id = c?['id'];
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(children: [
        _tool(Icons.alt_route_rounded, 'Split', () => _op({'op': 'split', 'at': _playhead})),
        _tool(Icons.chevron_left_rounded, 'Trim start', id == null ? null : () => _op({'op': 'trim', 'clip': id, 'trim_start': 0.5})),
        _tool(Icons.last_page_rounded, 'Trim end', id == null ? null : () => _op({'op': 'trim', 'clip': id, 'trim_end': 0.5})),
        _tool(Icons.chevron_left_rounded, 'Move clip left', id == null ? null : () => _op({'op': 'reorder', 'clip': id, 'dir': 'left'})),
        _tool(Icons.chevron_right_rounded, 'Move clip right', id == null ? null : () => _op({'op': 'reorder', 'clip': id, 'dir': 'right'})),
        _tool(Icons.copy_rounded, 'Duplicate', id == null ? null : () => _op({'op': 'duplicate_clip', 'clip': id})),
        _tool(Icons.delete_outline_rounded, 'Delete', id == null ? null : () => _op({'op': 'delete_clip', 'clip': id})),
        _tool(Icons.add_photo_alternate_outlined, 'Add clip', widget.pickMedia == null ? null : _addClip),
        _tool(Icons.queue_music_rounded, 'Add song', widget.pickMedia == null ? null : _addSong),
      ]),
    );
  }

  Widget _tool(IconData icon, String label, VoidCallback? onTap) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: TextButton.icon(onPressed: onTap, icon: Icon(icon, size: 20), label: Text(label, style: const TextStyle(fontSize: 13))),
      );

  Future<void> _addClip() async {
    final item = await widget.pickMedia!(context, kind: 'visual');
    if (item == null) return;
    final video = '${item['mime_type']}'.startsWith('video/');
    await _op({'op': 'add_clip', 'clip': {'asset': item['id'], 'name': '${item['title'] ?? 'Clip'}', 'kind': video ? 'video' : 'image', 'duration': ((item['duration_seconds'] as num?) ?? (video ? 5 : 3)).toDouble()}});
  }

  Future<void> _addSong() async {
    final item = await widget.pickMedia!(context, kind: 'audio');
    if (item == null) return;
    await _op({'op': 'add_audio', 'asset': item['id'], 'name': '${item['title'] ?? 'Song'}', 'role': 'music'});
  }

  Widget _askBar() => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: TextField(
          controller: _ask,
          textInputAction: TextInputAction.send,
          decoration: InputDecoration(isDense: true, hintText: 'Ask CHE: "cut two seconds off the intro"', suffixIcon: IconButton(tooltip: 'Send edit to CHE', icon: const Icon(Icons.auto_awesome_rounded), onPressed: _sendAsk)),
          onSubmitted: (_) => _sendAsk(),
        ),
      );

  void _sendAsk() {
    final text = _ask.text.trim();
    if (text.isEmpty) return;
    _ask.clear();
    unawaited(_run(() => widget.client.words(widget.projectId, text, selection: _selected, playhead: _playhead)));
  }

  Widget _tabs() => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: Row(children: [
          for (final t in const ['Edit', 'Adjust', 'Audio', 'Text', 'Captions', 'Effects'])
            Padding(padding: const EdgeInsets.all(4), child: ChoiceChip(label: Text(t), selected: _tab == t, onSelected: (_) => setState(() => _tab = t))),
        ]),
      );

  Widget _inspector() {
    final c = _selClip;
    switch (_tab) {
      case 'Adjust':
        return _adjustPanel(c);
      case 'Audio':
        return _audioPanel();
      case 'Text':
        return _textPanel();
      case 'Captions':
        return _captionsPanel();
      case 'Effects':
        return _effectsPanel(c);
      default:
        return _editPanel(c);
    }
  }

  Widget _wrap(List<Widget> children) => SingleChildScrollView(padding: const EdgeInsets.all(8), child: Wrap(spacing: 8, runSpacing: 8, children: children));

  Widget _editPanel(Map<String, dynamic>? c) {
    if (c == null) return const Center(child: Text('Select a clip.'));
    final id = c['id'];
    final speed = ((c['speed'] as num?) ?? 1).toDouble();
    return _wrap([
      for (final s in const [0.5, 1.0, 1.5, 2.0]) ChoiceChip(label: Text('${s}x speed'), selected: speed == s, onSelected: (_) => _op({'op': 'clip', 'clip': id, 'speed': s})),
      OutlinedButton(onPressed: () => _op({'op': 'clip', 'clip': id, 'muted': c['muted'] != true}), child: Text(c['muted'] == true ? 'Unmute clip' : 'Mute clip')),
      OutlinedButton(onPressed: () => _op({'op': 'clip', 'clip': id, 'volume': (((c['volume'] as num?) ?? 1) - 0.1).clamp(0, 2)}), child: const Text('Volume down')),
      OutlinedButton(onPressed: () => _op({'op': 'clip', 'clip': id, 'volume': (((c['volume'] as num?) ?? 1) + 0.1).clamp(0, 2)}), child: const Text('Volume up')),
      OutlinedButton(onPressed: () => _op({'op': 'rotate', 'clip': id, 'degrees': 90}), child: const Text('Rotate')),
      OutlinedButton(onPressed: () => _op({'op': 'clip', 'clip': id, 'reverse': c['reverse'] != true}), child: Text(c['reverse'] == true ? 'Play forward' : 'Reverse')),
      OutlinedButton(onPressed: () => _op({'op': 'clip', 'clip': id, 'freeze': c['freeze'] == null ? {'duration': 1} : null}), child: Text(c['freeze'] == null ? 'Freeze last frame 1 s' : 'Remove freeze')),
      OutlinedButton(onPressed: () => _op({'op': 'clip', 'clip': id, 'opacity': (((c['opacity'] as num?) ?? 1) - 0.1).clamp(0, 1)}), child: const Text('Fade opacity')),
    ]);
  }

  static const _videoAdjust = ['brightness', 'contrast', 'exposure', 'highlights', 'shadows', 'saturation', 'temperature', 'tint', 'sharpness', 'vignette'];

  Widget _adjustPanel(Map<String, dynamic>? c) {
    final source = _adjustAll || c == null ? _doc['adjust'] as Map? : c['adjust'] as Map?;
    final value = ((source?[_adjustKey] as num?) ?? 0).toDouble();
    return ListView(padding: const EdgeInsets.symmetric(horizontal: 8), children: [
      Row(children: [
        Expanded(child: SizedBox(height: 44, child: ListView(scrollDirection: Axis.horizontal, children: [
          for (final k in _videoAdjust) Padding(padding: const EdgeInsets.all(3), child: ChoiceChip(label: Text(k[0].toUpperCase() + k.substring(1)), selected: k == _adjustKey, onSelected: (_) => setState(() => _adjustKey = k))),
        ]))),
      ]),
      Row(children: [
        ChoiceChip(label: const Text('Apply to clip'), selected: !_adjustAll, onSelected: c == null ? null : (_) => setState(() => _adjustAll = false)),
        const SizedBox(width: 8),
        ChoiceChip(label: const Text('Apply to all'), selected: _adjustAll || c == null, onSelected: (_) => setState(() => _adjustAll = true)),
      ]),
      Semantics(
        slider: true,
        label: cheAdjustLabel(_adjustKey, value),
        child: Slider(
          value: value,
          min: {'sharpness', 'vignette'}.contains(_adjustKey) ? 0 : -100,
          max: 100,
          divisions: 200,
          label: '${value.round()}',
          onChanged: (_) {},
          onChangeEnd: (v) => _op({'op': 'adjust', 'key': _adjustKey, 'value': v.round(), 'scope': _adjustAll || c == null ? 'all' : 'clip:${c['id']}'}),
        ),
      ),
    ]);
  }

  Widget _audioPanel() {
    final audio = [for (final a in (_doc['audio'] as List? ?? const [])) Map<String, dynamic>.from(a as Map)];
    if (audio.isEmpty) return _wrap([const Text('No music or voice yet.'), if (widget.pickMedia != null) FilledButton.icon(onPressed: _addSong, icon: const Icon(Icons.queue_music_rounded), label: const Text('Add song'))]);
    return ListView(padding: const EdgeInsets.symmetric(horizontal: 8), children: [
      for (final a in audio)
        Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text('${a['name']} (${a['role']}) ${(((a['volume'] as num?) ?? 1) * 100).round()}%', style: const TextStyle(fontWeight: FontWeight.w600)),
          OutlinedButton(onPressed: () => _op({'op': 'audio', 'audio': a['id'], 'volume_delta': -0.1}), child: Text('${a['role']} volume down')),
          OutlinedButton(onPressed: () => _op({'op': 'audio', 'audio': a['id'], 'volume_delta': 0.1}), child: Text('${a['role']} volume up')),
          OutlinedButton(onPressed: () => _op({'op': 'audio', 'audio': a['id'], 'muted': a['muted'] != true}), child: Text(a['muted'] == true ? 'Unmute' : 'Mute')),
          OutlinedButton(onPressed: () => _op({'op': 'audio', 'audio': a['id'], 'fade_in': ((a['fade_in'] as num?) ?? 0) > 0 ? 0 : 1}), child: Text(((a['fade_in'] as num?) ?? 0) > 0 ? 'No fade in' : 'Fade in')),
          OutlinedButton(onPressed: () => _op({'op': 'audio', 'audio': a['id'], 'fade_out': ((a['fade_out'] as num?) ?? 0) > 0 ? 0 : 1.5}), child: Text(((a['fade_out'] as num?) ?? 0) > 0 ? 'No fade out' : 'Fade out')),
          OutlinedButton(onPressed: () => _op({'op': 'audio', 'audio': a['id'], 'normalize': a['normalize'] != true}), child: Text(a['normalize'] == true ? 'Normalize on' : 'Normalize')),
          if (a['role'] == 'music') OutlinedButton(onPressed: () => _op({'op': 'audio', 'audio': a['id'], 'duck': a['duck'] != true}), child: Text(a['duck'] == true ? 'Ducking on' : 'Duck under speech')),
          if (a['role'] == 'voice') OutlinedButton(onPressed: () => _op({'op': 'audio', 'audio': a['id'], 'clean': a['clean'] != true}), child: Text(a['clean'] == true ? 'Voice clean-up on' : 'Clean voice')),
          OutlinedButton(onPressed: () => _op({'op': 'audio', 'audio': a['id'], 'eq': a['eq'] == null ? {'low': 3, 'mid': 0, 'high': 2} : null}), child: Text(a['eq'] == null ? 'Warm EQ' : 'EQ off')),
        ]),
    ]);
  }

  Widget _textPanel() {
    final text = [for (final t in (_doc['text'] as List? ?? const [])) Map<String, dynamic>.from(t as Map)];
    return ListView(padding: const EdgeInsets.symmetric(horizontal: 8), children: [
      Align(alignment: Alignment.centerLeft, child: FilledButton.icon(onPressed: _addTextOverlay, icon: const Icon(Icons.format_quote_rounded), label: const Text('Add text'))),
      for (final t in text)
        ListTile(
          dense: true,
          title: Text('${t['text']}', maxLines: 2),
          subtitle: Text('${(t['start'] as num).toStringAsFixed(1)}–${(t['end'] as num).toStringAsFixed(1)} s'),
          trailing: Wrap(children: [
            IconButton(tooltip: 'Edit text', icon: const Icon(Icons.edit_rounded), onPressed: () => _editOverlay(t)),
            IconButton(tooltip: 'Move text up', icon: const Icon(Icons.arrow_upward_rounded), onPressed: () => _op({'op': 'move_layer', 'id': t['id'], 'dy': -0.05})),
            IconButton(tooltip: 'Move text down', icon: const Icon(Icons.arrow_downward_rounded), onPressed: () => _op({'op': 'move_layer', 'id': t['id'], 'dy': 0.05})),
            IconButton(tooltip: 'Delete text', icon: const Icon(Icons.delete_outline_rounded), onPressed: () => _op({'op': 'delete_layer', 'id': t['id']})),
          ]),
        ),
    ]);
  }

  Future<void> _addTextOverlay() async {
    final v = await _prompt('Add text', '');
    if (v == null || v.trim().isEmpty) return;
    await _op({'op': 'add_layer', 'layer': {'type': 'text', 'name': 'Text', 'value': v.trim(), 'style': 'tiktok', 'x': 0.08, 'y': 0.15, 'w': 0.84, 'h': 0.1, 'animation': 'fade_in'}, 'start': _playhead, 'end': (_playhead + 3).clamp(0, _duration)});
  }

  Future<void> _editOverlay(Map<String, dynamic> t) async {
    final v = await _prompt('Edit text', '${t['text']}');
    if (v == null) return;
    await _op({'op': 'edit_layer', 'id': t['id'], 'text': {'value': v}});
  }

  Widget _captionsPanel() {
    final cap = Map<String, dynamic>.from((_doc['captions'] as Map?) ?? const {});
    final cues = [for (final c in (cap['cues'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)];
    return ListView(padding: const EdgeInsets.symmetric(horizontal: 8), children: [
      Wrap(spacing: 8, runSpacing: 4, children: [
        FilledButton(onPressed: () => _run(() => widget.client.words(widget.projectId, 'add captions')), child: const Text('Auto captions')),
        for (final s in const [['caption_clean', 'Clean'], ['caption_bold', 'Bold'], ['caption_karaoke', 'Karaoke'], ['caption_minimal', 'Minimal']])
          ChoiceChip(label: Text(s[1]), selected: cap['style'] == s[0], onSelected: (_) => _op({'op': 'caption_style', 'style': s[0]})),
        OutlinedButton(onPressed: () => _op({'op': 'caption_style', 'scale': 1.15}), child: const Text('Bigger')),
        OutlinedButton(onPressed: () => _op({'op': 'caption_style', 'scale': 0.87}), child: const Text('Smaller')),
        OutlinedButton(onPressed: () => _op({'op': 'caption_style', 'position': (((cap['position'] as num?) ?? 0.78) - 0.05)}), child: const Text('Higher')),
        OutlinedButton(onPressed: () => _op({'op': 'caption_style', 'position': (((cap['position'] as num?) ?? 0.78) + 0.05)}), child: const Text('Lower')),
        OutlinedButton(onPressed: _addCaption, child: const Text('Add caption here')),
      ]),
      for (final c in cues)
        ListTile(
          dense: true,
          title: Text('${c['text']}'),
          subtitle: Text('${(c['start'] as num).toStringAsFixed(1)}–${(c['end'] as num).toStringAsFixed(1)} s'),
          trailing: IconButton(tooltip: 'Edit caption', icon: const Icon(Icons.edit_rounded), onPressed: () async {
            final v = await _prompt('Edit caption', '${c['text']}');
            if (v != null) await _op({'op': 'edit_caption', 'id': c['id'], 'text': v});
          }),
        ),
    ]);
  }

  Future<void> _addCaption() async {
    final v = await _prompt('Caption at ${_playhead.toStringAsFixed(1)} s', '');
    if (v == null || v.trim().isEmpty) return;
    final cues = [for (final c in ((_doc['captions'] as Map?)?['cues'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)];
    cues.add({'start': _playhead, 'end': (_playhead + 2).clamp(0, _duration), 'text': v.trim()});
    cues.sort((a, b) => (a['start'] as num).compareTo(b['start'] as num));
    await _op({'op': 'captions', 'cues': cues, 'source': 'owner'});
  }

  static const _transitions = [['cut', 'Cut'], ['fade', 'Fade'], ['dissolve', 'Cross dissolve'], ['slide', 'Slide'], ['zoom', 'Zoom']];
  static const _looks = [['original', 'Original'], ['clean', 'Clean'], ['warm', 'Warm'], ['cool', 'Cool'], ['cinematic', 'Cinematic'], ['vibrant', 'Vibrant'], ['dark', 'Dark'], ['vintage', 'Vintage'], ['bw', 'B&W']];

  Widget _effectsPanel(Map<String, dynamic>? c) => _wrap([
        if (c != null) ...[
          Text('After ${c['name']}:', style: const TextStyle(fontWeight: FontWeight.w600)),
          for (final t in _transitions)
            ChoiceChip(label: Text(t[1]), selected: (c['transition'] as Map?)?['type'] == t[0], onSelected: (_) => _op({'op': 'transition', 'clip': c['id'], 'type': t[0], 'duration': 0.5})),
        ],
        for (final l in _looks) ChoiceChip(label: Text('${l[1]} look'), selected: _doc['filter'] == l[0], onSelected: (_) => _op({'op': 'filter', 'name': l[0]})),
        for (final i in const [['auto_enhance', 'Auto Enhance'], ['improve_lighting', 'Improve Lighting'], ['improve_audio', 'Improve Audio'], ['clean_voice', 'Clean Voice']])
          OutlinedButton(onPressed: () => _run(() => widget.client.post({'action': 'improve', 'project_id': widget.projectId, 'id': i[0]})), child: Text(i[1])),
      ]);

  Future<String?> _prompt(String title, String initial) {
    final ctl = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(controller: ctl, autofocus: true, maxLines: 3),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text), child: const Text('Done'))],
      ),
    );
  }

  Future<void> _menu(String v) async {
    if (v == 'render') await _render();
    if (v == 'version') await _run(() => widget.client.post({'action': 'save_version', 'project_id': widget.projectId}));
    if (v.startsWith('restore:')) await _run(() => widget.client.post({'action': 'restore', 'project_id': widget.projectId, 'version': v.substring(8)}));
    if (v == 'variants') await _run(() => widget.client.post({'action': 'variants', 'project_id': widget.projectId, 'presets': ['tiktok', 'reels', 'youtube']}));
    if (v == 'template') await _run(() => widget.client.post({'action': 'save_template', 'project_id': widget.projectId}));
  }
}

class _RulerPainter extends CustomPainter {
  _RulerPainter(this.duration);
  final double duration;
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = Colors.white30;
    for (var s = 0; s <= duration.ceil() + 1; s++) {
      final x = s * _pxPerSecond;
      canvas.drawLine(Offset(x, s % 5 == 0 ? 2 : 9), Offset(x, 16), p);
      if (s % 5 == 0) {
        final tp = TextPainter(text: TextSpan(text: '${s}s', style: const TextStyle(fontSize: 9, color: Colors.white54)), textDirection: TextDirection.ltr)..layout();
        tp.paint(canvas, Offset(x + 2, 0));
      }
    }
  }

  @override
  bool shouldRepaint(covariant _RulerPainter old) => old.duration != duration;
}

class _WavePainter extends CustomPainter {
  _WavePainter(this.peaks);
  final List<double>? peaks;
  @override
  void paint(Canvas canvas, Size size) {
    final list = peaks;
    final p = Paint()
      ..color = _accent.withValues(alpha: 0.85)
      ..strokeWidth = 1.5;
    if (list == null || list.isEmpty) {
      canvas.drawLine(Offset(0, size.height / 2), Offset(size.width, size.height / 2), p..color = Colors.white24);
      return;
    }
    final step = size.width / list.length;
    for (var i = 0; i < list.length; i++) {
      final h = list[i].clamp(0, 1) * size.height / 2;
      final x = i * step;
      canvas.drawLine(Offset(x, size.height / 2 - h), Offset(x, size.height / 2 + h), p);
    }
  }

  @override
  bool shouldRepaint(covariant _WavePainter old) => old.peaks != peaks;
}
