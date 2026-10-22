// Visual Studio image editor: the picture on top, one compact tool panel at the bottom
// (Adjust · Crop · Text · Layers · Looks). Every change is a real operation on the stored edit document, so it can be
// undone, compared with the Original, rendered and exported. Every gesture has a button alternative.
import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';

import 'che_image_canvas.dart';
import 'che_visual_adjust.dart';
import 'che_visual_client.dart';
import 'che_visual_session.dart';

const _accent = Color(0xFF7FF5E6);

class CheImageEditor extends StatefulWidget {
  const CheImageEditor({super.key, required this.client, required this.projectId});
  final CheVisualClient client;
  final String projectId;

  @override
  State<CheImageEditor> createState() => _CheImageEditorState();
}

class _CheImageEditorState extends State<CheImageEditor> {
  Map<String, dynamic>? _view;
  Map<String, dynamic>? _doc;
  Map<String, dynamic>? _original;
  String? _selected;
  String _tab = 'Adjust';
  String _adjustKey = 'brightness';
  bool _busy = false;
  bool _ab = false;
  String _status = '';
  late final CheImageCache _cache = CheImageCache((id) => widget.client.mediaUrl(id), widget.client.headers);
  final _boundary = GlobalKey();
  final _ask = TextEditingController();
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    CheVisualSession.open(widget.projectId);
    unawaited(_load());
  }

  @override
  void dispose() {
    CheVisualSession.close(widget.projectId);
    _poll?.cancel();
    _ask.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      _apply(await widget.client.project(widget.projectId));
      final cmp = await widget.client.post({'action': 'compare', 'project_id': widget.projectId, 'a': 'v0'});
      _original = Map<String, dynamic>.from(cmp['a'] as Map);
    } on CheVisualException catch (e) {
      _say(e.message);
    }
    if (mounted) setState(() {});
  }

  void _apply(Map<String, dynamic> v) {
    _view = v;
    _doc = Map<String, dynamic>.from(v['doc'] as Map);
    final render = (v['project'] as Map?)?['render'] as Map?;
    if (render != null && !{'ready', 'failed'}.contains(render['stage'])) _watchRender();
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

  List<Map<String, dynamic>> get _layers => [for (final l in (_doc?['layers'] as List? ?? const [])) Map<String, dynamic>.from(l as Map)];
  Map<String, dynamic>? get _sel => _layers.where((l) => l['id'] == _selected).firstOrNull;

  // ─── Export ──────────────────────────────────────────────────────────────

  /// Saves exactly what is on the canvas at the document's full size, as a PNG in the media library.
  Future<void> _exportHere() async {
    final b = _boundary.currentContext?.findRenderObject() as RenderRepaintBoundary?;
    final canvas = _doc?['canvas'] as Map?;
    if (b == null || canvas == null) return;
    await _run(() async {
      final ratio = (canvas['w'] as num).toDouble() / b.size.width;
      final image = await b.toImage(pixelRatio: ratio);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      if (png == null) throw const CheVisualException('The picture could not be encoded.');
      final r = await widget.client.post({'action': 'upload', 'name': '${(_view?['project'] as Map?)?['title'] ?? 'Edit'}.png', 'media_type': 'image/png', 'base64': base64Encode(png.buffer.asUint8List())}, timeout: const Duration(seconds: 90));
      return {'said': 'Exported a ${image.width} by ${image.height} PNG to your library.', 'item': r['item']};
    });
  }

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
          _say(r?['stage'] == 'ready' ? 'Render ready and verified.' : 'Render failed: ${r?['error'] ?? 'unknown reason'}');
        }
      } on CheVisualException {
        // keep polling; the status line still shows the last known stage
      }
    });
  }

  // ─── UI ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final doc = _doc;
    final project = (_view?['project'] as Map?) ?? const {};
    return Scaffold(
      backgroundColor: const Color(0xFF071019),
      appBar: AppBar(
        backgroundColor: const Color(0xFF071019),
        title: Text('${project['title'] ?? 'Image'}', overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(tooltip: 'Undo', onPressed: project['can_undo'] == true ? () => _run(() => widget.client.post({'action': 'undo', 'project_id': widget.projectId})) : null, icon: const Icon(Icons.undo_rounded)),
          IconButton(tooltip: 'Redo', onPressed: project['can_redo'] == true ? () => _run(() => widget.client.post({'action': 'redo', 'project_id': widget.projectId})) : null, icon: Transform.flip(flipX: true, child: const Icon(Icons.undo_rounded))),
          IconButton(tooltip: _ab ? 'Show edited' : 'Show original', onPressed: () => setState(() => _ab = !_ab), icon: Icon(_ab ? Icons.compare_arrows_rounded : Icons.compare_arrows_rounded)),
          PopupMenuButton<String>(
            tooltip: 'More',
            onSelected: _menu,
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'version', child: Text('Save version')),
              for (final v in (project['versions'] as List? ?? const [])) PopupMenuItem(value: 'restore:${(v as Map)['id']}', child: Text('Restore ${v['label']}')),
              const PopupMenuItem(value: 'template', child: Text('Save as template')),
              const PopupMenuItem(value: 'variants', child: Text('Make TikTok, Reels and YouTube versions')),
              const PopupMenuItem(value: 'render', child: Text('Render in the cloud (verified PNG)')),
              const PopupMenuItem(value: 'export', child: Text('Export to library')),
            ],
          ),
        ],
      ),
      body: doc == null
          ? Center(child: Text(_status.isEmpty ? 'Loading…' : _status))
          : Column(children: [
              Expanded(
                flex: 5,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Center(
                    child: RepaintBoundary(
                      key: _boundary,
                      child: CheImageCanvas(
                        doc: doc,
                        original: _original,
                        showOriginal: _ab,
                        cache: _cache,
                        selected: _selected,
                        onSelect: (id) => setState(() => _selected = id),
                        onMove: (id, dx, dy) => setState(() {
                          final l = (doc['layers'] as List).firstWhere((x) => (x as Map)['id'] == id) as Map;
                          l['x'] = ((l['x'] as num) + dx);
                          l['y'] = ((l['y'] as num) + dy);
                        }),
                      ),
                    ),
                  ),
                ),
              ),
              if (_ab) const Padding(padding: EdgeInsets.only(bottom: 4), child: Text('ORIGINAL', style: TextStyle(color: _accent, letterSpacing: 2, fontWeight: FontWeight.w700))),
              _statusLine(project),
              _askBar(),
              _suggestionsRow(),
              _toolTabs(),
              SizedBox(height: 168, child: _panel(doc)),
            ]),
    );
  }

  Widget _statusLine(Map project) {
    final r = project['render'] as Map?;
    final text = r != null && r['stage'] != 'ready' && r['stage'] != 'failed'
        ? 'Render: ${'${r['stage']}'[0].toUpperCase()}${'${r['stage']}'.substring(1)}'
        : r?['stage'] == 'failed'
            ? 'Render FAILED: ${r?['error'] ?? ''}'
            : _status;
    if (text.isEmpty) return const SizedBox(height: 4);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Row(children: [
        Expanded(child: Text(text, style: const TextStyle(color: Colors.white70), maxLines: 3)),
        if (r?['stage'] == 'failed') TextButton(onPressed: () => _run(() => widget.client.post({'action': 'retry_render', 'project_id': widget.projectId})), child: const Text('Retry')),
      ]),
    );
  }

  Widget _askBar() => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: TextField(
          controller: _ask,
          textInputAction: TextInputAction.send,
          decoration: InputDecoration(
            isDense: true,
            hintText: 'Ask CHE: "make the text easier to read"',
            suffixIcon: IconButton(tooltip: 'Send edit to CHE', icon: const Icon(Icons.auto_awesome_rounded), onPressed: _sendAsk),
          ),
          onSubmitted: (_) => _sendAsk(),
        ),
      );

  void _sendAsk() {
    final text = _ask.text.trim();
    if (text.isEmpty) return;
    _ask.clear();
    unawaited(_run(() => widget.client.words(widget.projectId, text, selection: _selected)));
  }

  Widget _suggestionsRow() {
    final list = [for (final s in (_view?['suggestions'] as List? ?? const [])) Map<String, dynamic>.from(s as Map)];
    if (list.isEmpty) return const SizedBox(height: 6);
    return SizedBox(
      height: 52,
      child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
        for (final s in list)
          Padding(
            padding: const EdgeInsets.only(right: 8, top: 6),
            child: Semantics(
              label: '${s['text']} Button: ${s['fix']}',
              child: ActionChip(
                label: Text('${s['fix']}'),
                avatar: const Icon(Icons.lightbulb_outline_rounded, size: 18),
                onPressed: s['ops'] is List ? () => _run(() => widget.client.post({'action': 'ops', 'project_id': widget.projectId, 'ops': s['ops']})) : null,
              ),
            ),
          ),
      ]),
    );
  }

  Widget _toolTabs() => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: Row(children: [
          for (final t in const ['Adjust', 'Crop', 'Text', 'Layers', 'Looks'])
            Padding(
              padding: const EdgeInsets.all(4),
              child: ChoiceChip(label: Text(t), selected: _tab == t, onSelected: (_) => setState(() => _tab = t)),
            ),
        ]),
      );

  Widget _panel(Map<String, dynamic> doc) {
    switch (_tab) {
      case 'Crop':
        return _cropPanel(doc);
      case 'Text':
        return _textPanel();
      case 'Layers':
        return _layersPanel();
      case 'Looks':
        return _looksPanel();
      default:
        return _adjustPanel(doc);
    }
  }

  static const _adjustments = ['brightness', 'contrast', 'exposure', 'highlights', 'shadows', 'saturation', 'vibrance', 'temperature', 'tint', 'sharpness', 'clarity', 'fade', 'vignette', 'blur'];
  static const _zeroToHundred = {'sharpness', 'clarity', 'fade', 'vignette', 'blur'};

  Widget _adjustPanel(Map<String, dynamic> doc) {
    final adjust = Map<String, dynamic>.from(doc['adjust'] as Map);
    final value = ((adjust[_adjustKey] as num?) ?? 0).toDouble();
    return ListView(children: [
      SizedBox(
        height: 52,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 8), children: [
          for (final k in _adjustments)
            Padding(padding: const EdgeInsets.all(4), child: ChoiceChip(label: Text(k[0].toUpperCase() + k.substring(1)), selected: k == _adjustKey, onSelected: (_) => setState(() => _adjustKey = k))),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Semantics(
          label: cheAdjustLabel(_adjustKey, value),
          slider: true,
          child: Slider(
            value: value,
            min: _zeroToHundred.contains(_adjustKey) ? 0 : -100,
            max: 100,
            divisions: 200,
            label: '${value.round()}',
            onChanged: (v) => setState(() => doc['adjust'] = {...adjust, _adjustKey: v.round()}),
            onChangeEnd: (v) => _op({'op': 'adjust', 'key': _adjustKey, 'value': v.round()}),
          ),
        ),
      ),
      Wrap(alignment: WrapAlignment.center, children: [
        TextButton(onPressed: () => _op({'op': 'adjust', 'key': _adjustKey, 'delta': -5}), child: Text('${_adjustKey[0].toUpperCase()}${_adjustKey.substring(1)} down')),
        TextButton(onPressed: () => _op({'op': 'adjust', 'key': _adjustKey, 'value': 0}), child: const Text('Reset')),
        TextButton(onPressed: () => _op({'op': 'adjust', 'key': _adjustKey, 'delta': 5}), child: Text('${_adjustKey[0].toUpperCase()}${_adjustKey.substring(1)} up')),
      ]),
    ]);
  }

  Widget _cropPanel(Map<String, dynamic> doc) => SingleChildScrollView(
        padding: const EdgeInsets.all(8),
        child: Wrap(spacing: 8, runSpacing: 8, children: [
          for (final p in const [['square', 'Square 1:1'], ['portrait', 'Portrait 4:5'], ['tiktok', 'Vertical 9:16'], ['youtube', 'Wide 16:9'], ['album', 'Album cover']])
            OutlinedButton(onPressed: () => _op({'op': 'aspect', 'preset': p[0]}), child: Text(p[1])),
          OutlinedButton.icon(onPressed: () => _op({'op': 'rotate', 'degrees': 90}), icon: const Icon(Icons.refresh_rounded), label: const Text('Rotate')),
          OutlinedButton.icon(onPressed: () => _op({'op': 'flip', 'axis': 'h'}), icon: const Icon(Icons.swap_horiz_rounded), label: const Text('Flip horizontal')),
          OutlinedButton.icon(onPressed: () => _op({'op': 'flip', 'axis': 'v'}), icon: const Icon(Icons.swap_horiz_rounded), label: const Text('Flip vertical')),
          OutlinedButton(onPressed: () => _op({'op': 'crop', 'x': 0.1, 'y': 0.1, 'w': 0.8, 'h': 0.8}), child: const Text('Crop in 10%')),
          OutlinedButton(onPressed: () => _op({'op': 'crop', 'x': 0, 'y': 0, 'w': 1, 'h': 1}), child: const Text('Reset crop')),
          OutlinedButton(onPressed: () => _op({'op': 'straighten', 'degrees': (((doc['transform'] as Map)['straighten'] as num? ?? 0) - 1)}), child: const Text('Straighten −1°')),
          OutlinedButton(onPressed: () => _op({'op': 'straighten', 'degrees': (((doc['transform'] as Map)['straighten'] as num? ?? 0) + 1)}), child: const Text('Straighten +1°')),
        ]),
      );

  static const _styles = [['tiktok', 'TikTok'], ['reels', 'Reels'], ['shorts', 'Shorts'], ['thumbnail', 'Thumbnail'], ['ad', 'Ad'], ['album', 'Album'], ['social', 'Social']];

  Widget _textPanel() {
    final sel = _sel;
    final t = sel?['type'] == 'text' ? Map<String, dynamic>.from(sel!['text'] as Map) : null;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(8),
      child: Wrap(spacing: 8, runSpacing: 8, children: [
        FilledButton.icon(onPressed: _addText, icon: const Icon(Icons.format_quote_rounded), label: const Text('Add text')),
        if (t == null) const Padding(padding: EdgeInsets.all(8), child: Text('Select a text layer to edit it.'))
        else ...[
          OutlinedButton(onPressed: () => _editText(sel!, t), child: const Text('Edit text')),
          for (final s in _styles) OutlinedButton(onPressed: () => _op({'op': 'edit_layer', 'id': sel!['id'], 'text': {'style': s[0]}}), child: Text(s[1])),
          OutlinedButton(onPressed: () => _op({'op': 'edit_layer', 'id': sel!['id'], 'text': {'size': ((t['size'] as num) * 1.15)}}), child: const Text('Bigger')),
          OutlinedButton(onPressed: () => _op({'op': 'edit_layer', 'id': sel!['id'], 'text': {'size': ((t['size'] as num) / 1.15)}}), child: const Text('Smaller')),
          for (final a in const ['left', 'center', 'right']) OutlinedButton(onPressed: () => _op({'op': 'edit_layer', 'id': sel!['id'], 'text': {'align': a}}), child: Text('Align $a')),
          OutlinedButton(onPressed: () => _op({'op': 'edit_layer', 'id': sel!['id'], 'text': {'outline': t['outline'] == null ? {'color': '#000000', 'width': 0.004} : null}}), child: Text(t['outline'] == null ? 'Add outline' : 'Remove outline')),
          OutlinedButton(onPressed: () => _op({'op': 'edit_layer', 'id': sel!['id'], 'text': {'shadow': t['shadow'] == null ? {'color': '#000000CC', 'blur': 8} : null}}), child: Text(t['shadow'] == null ? 'Add shadow' : 'Remove shadow')),
          OutlinedButton(onPressed: () => _op({'op': 'edit_layer', 'id': sel!['id'], 'text': {'background': t['background'] == null ? {'color': '#000000AA', 'radius': 0.01} : null}}), child: Text(t['background'] == null ? 'Add background' : 'Remove background')),
          for (final m in const [['Move up', 0.0, -0.03], ['Move down', 0.0, 0.03], ['Move left', -0.03, 0.0], ['Move right', 0.03, 0.0]])
            OutlinedButton(onPressed: () => _op({'op': 'move_layer', 'id': sel!['id'], 'dx': m[1], 'dy': m[2]}), child: Text('${m[0]}')),
        ],
      ]),
    );
  }

  Future<void> _addText() async {
    final value = await _prompt('Add text', '');
    if (value == null || value.trim().isEmpty) return;
    await _op({'op': 'add_layer', 'layer': {'type': 'text', 'name': 'Text', 'value': value.trim(), 'style': 'social', 'x': 0.08, 'y': 0.42, 'w': 0.84, 'h': 0.12}});
  }

  Future<void> _editText(Map<String, dynamic> l, Map<String, dynamic> t) async {
    final value = await _prompt('Edit text', '${t['value'] ?? ''}');
    if (value == null) return;
    await _op({'op': 'edit_layer', 'id': l['id'], 'text': {'value': value}});
  }

  Future<String?> _prompt(String title, String initial) {
    final c = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(controller: c, autofocus: true, maxLines: 3),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('Done'))],
      ),
    );
  }

  Widget _layersPanel() => ListView(padding: const EdgeInsets.symmetric(horizontal: 8), children: [
        for (final l in _layers.reversed)
          Semantics(
            label: '${l['name']} layer${l['hidden'] == true ? ', hidden' : ''}${l['id'] == _selected ? ', selected' : ''}',
            child: ListTile(
              dense: true,
              selected: l['id'] == _selected,
              onTap: () => setState(() => _selected = '${l['id']}'),
              title: Text('${l['name']}', maxLines: 1, overflow: TextOverflow.ellipsis),
              trailing: Wrap(children: [
                IconButton(tooltip: 'Bring forward', icon: const Icon(Icons.arrow_upward_rounded), onPressed: () => _op({'op': 'order', 'id': l['id'], 'dir': 'forward'})),
                IconButton(tooltip: 'Send back', icon: const Icon(Icons.arrow_downward_rounded), onPressed: () => _op({'op': 'order', 'id': l['id'], 'dir': 'backward'})),
                IconButton(tooltip: 'Duplicate', icon: const Icon(Icons.copy_rounded), onPressed: () => _op({'op': 'duplicate_layer', 'id': l['id']})),
                IconButton(tooltip: l['hidden'] == true ? 'Show' : 'Hide', icon: Icon(l['hidden'] == true ? Icons.remove_circle_outline_rounded : Icons.check_circle_outline_rounded), onPressed: () => _op({'op': 'edit_layer', 'id': l['id'], 'hidden': l['hidden'] != true})),
                IconButton(tooltip: 'Delete layer', icon: const Icon(Icons.delete_outline_rounded), onPressed: () => _op({'op': 'delete_layer', 'id': l['id']})),
              ]),
            ),
          ),
      ]);

  static const _looks = [['original', 'Original'], ['clean', 'Clean'], ['warm', 'Warm'], ['cool', 'Cool'], ['cinematic', 'Cinematic'], ['vibrant', 'Vibrant'], ['dark', 'Dark'], ['vintage', 'Vintage'], ['bw', 'B&W']];
  static const _improve = [['auto_enhance', 'Auto Enhance'], ['improve_lighting', 'Improve Lighting'], ['balance_color', 'Balance Color'], ['clean_up', 'Clean Up']];

  Widget _looksPanel() => SingleChildScrollView(
        padding: const EdgeInsets.all(8),
        child: Wrap(spacing: 8, runSpacing: 8, children: [
          for (final l in _looks) ChoiceChip(label: Text(l[1]), selected: _doc?['filter'] == l[0], onSelected: (_) => _op({'op': 'filter', 'name': l[0]})),
          for (final i in _improve) OutlinedButton(onPressed: () => _run(() => widget.client.post({'action': 'improve', 'project_id': widget.projectId, 'id': i[0]})), child: Text(i[1])),
        ]),
      );

  Future<void> _menu(String v) async {
    if (v == 'version') await _run(() => widget.client.post({'action': 'save_version', 'project_id': widget.projectId}));
    if (v.startsWith('restore:')) await _run(() => widget.client.post({'action': 'restore', 'project_id': widget.projectId, 'version': v.substring(8)}));
    if (v == 'template') await _run(() => widget.client.post({'action': 'save_template', 'project_id': widget.projectId}));
    if (v == 'variants') await _run(() => widget.client.post({'action': 'variants', 'project_id': widget.projectId, 'presets': ['tiktok', 'reels', 'youtube']}));
    if (v == 'render') await _render();
    if (v == 'export') await _exportHere();
  }
}
