// The Invention 3D viewer (owner, 2026-10-24: "show me, rotate it, change the color, open it in 3D"). It opens the
// invention's saved GLB (GET /api/inventions/:id/model.glb, built by server/cloudflare/invention_visuals.js) in CHE's
// own 3D page (studio.html). Rotate and zoom are viewport commands; a colour change asks the Worker for a new saved model
// version and loads it. Every action reports what the page or the Worker really did; loading never speaks.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_theme.dart';
import '../create/che_live_studio.dart' show CheViewportDriver, cheWebViewport;

/// The colours the Worker accepts (invention_visuals.js COLOURS), shown as buttons.
const cheInventionColours = ['red', 'gold', 'blue', 'black', 'silver', 'white', 'green', 'purple', 'orange', 'teal'];
const _allColours = {...cheInventionColours, 'crimson', 'yellow', 'navy', 'grey', 'gray', 'pink', 'bronze', 'chrome'};

/// Owner words for the viewer: a viewport command, a colour, or null (not the viewer's).
({Map<String, Object>? cmd, String? colour, String? say})? cheInventionViewerIntent(String words) {
  final t = words.toLowerCase().replaceFirst(RegExp(r'^(?:che|chey|chay)[,:]?\s+'), '').replaceAll(RegExp(r'[.!?]+$'), '').trim();
  if (RegExp(r'\b(?:colou?r|paint|recolou?r)\b').hasMatch(t) || RegExp(r'^(?:make|paint|turn) (?:it|the \w+) \w+$').hasMatch(t)) {
    final named = _allColours.firstWhere((c) => RegExp('\\b$c\\b').hasMatch(t), orElse: () => '');
    if (named.isNotEmpty) return (cmd: null, colour: named, say: null);
    if (RegExp(r'\b(?:change|set|switch)\b').hasMatch(t)) {
      return (cmd: null, colour: null, say: 'Which colour? ${cheInventionColours.join(', ')}. Nothing was changed.');
    }
  }
  final rot = RegExp(r'^(?:rotate|turn|spin)(?: (?:it|the \w+))?(?: (left|right))?(?: (?:by )?(\d{1,3}) ?(?:degrees?|°))?$').firstMatch(t);
  if (rot != null) {
    final deg = int.tryParse(rot.group(2) ?? '') ?? 45;
    return (cmd: {'action': 'rotate', 'deg': rot.group(1) == 'left' ? -deg : deg}, colour: null, say: null);
  }
  if (RegExp(r'^zoom (?:in|closer)\b|^closer$').hasMatch(t)) return (cmd: {'action': 'zoom', 'factor': 1.4}, colour: null, say: null);
  if (RegExp(r'^zoom out\b|^further$|^farther$').hasMatch(t)) return (cmd: {'action': 'zoom', 'factor': 0.7}, colour: null, say: null);
  if (RegExp(r'^reset(?: the)?(?: view| camera)?$').hasMatch(t)) return (cmd: {'action': 'reset'}, colour: null, say: null);
  final view = RegExp(r'\b(front|side|back) view\b|^show (?:me )?the (front|side|back)$').firstMatch(t);
  if (view != null) {
    final w = view.group(1) ?? view.group(2)!;
    return (cmd: {'action': 'view', 'deg': w == 'front' ? 0 : w == 'back' ? 180 : 90}, colour: null, say: null);
  }
  if (RegExp(r'^(?:spin|turntable)(?: it)?(?: around)?$|^keep spinning$').hasMatch(t)) return (cmd: {'action': 'spin', 'on': true}, colour: null, say: null);
  if (RegExp(r'^stop spinning$').hasMatch(t)) return (cmd: {'action': 'spin', 'on': false}, colour: null, say: null);
  return null;
}

class CheInventionViewer extends StatefulWidget {
  const CheInventionViewer({
    super.key,
    required this.baseUrl,
    required this.headers,
    required this.inventionId,
    this.title = 'Invention',
    this.version,
    this.initialCommand,
    this.onSpeak,
    this.client,
    this.viewport,
  });

  final String baseUrl;
  final Map<String, String> headers;
  final String inventionId;
  final String title;

  /// The model version to open; null opens the newest.
  final int? version;

  /// A viewport move to apply once the model is in ("rotate it" said in chat).
  final Map<String, Object>? initialCommand;

  /// Speaks the result of an action the owner took with a button (voice results are spoken by the voice route).
  final void Function(String text)? onSpeak;
  final http.Client? client;
  final CheViewportDriver Function(void Function(Map<String, dynamic>) onMessage)? viewport;

  /// While the viewer is open, typed or spoken words reach it first; null means "not mine".
  static Future<String?> Function(String words)? voiceHandler;

  static Route<void> route({
    required String baseUrl,
    required Map<String, String> headers,
    required String inventionId,
    String title = 'Invention',
    int? version,
    Map<String, Object>? initialCommand,
    void Function(String text)? onSpeak,
  }) => MaterialPageRoute<void>(
    builder: (_) => CheInventionViewer(
      baseUrl: baseUrl,
      headers: headers,
      inventionId: inventionId,
      title: title,
      version: version,
      initialCommand: initialCommand,
      onSpeak: onSpeak,
    ),
  );

  @override
  State<CheInventionViewer> createState() => CheInventionViewerState();
}

class CheInventionViewerState extends State<CheInventionViewer> {
  late final CheViewportDriver _viewport = (widget.viewport ?? cheWebViewport)(_onPage);
  late final http.Client _http = widget.client ?? http.Client();
  String _status = 'Loading the 3D model…';
  bool _busy = true;
  int? _version;
  Completer<Map<String, dynamic>>? _waiting;

  @override
  void initState() {
    super.initState();
    CheInventionViewer.voiceHandler = voice;
    _version = widget.version;
    unawaited(_load(first: true));
  }

  @override
  void dispose() {
    if (CheInventionViewer.voiceHandler == voice) CheInventionViewer.voiceHandler = null;
    _viewport.dispose();
    if (widget.client == null) _http.close();
    super.dispose();
  }

  void _onPage(Map<String, dynamic> m) {
    final w = _waiting;
    if (w != null && !w.isCompleted && ['model', 'done', 'error'].contains(m['type'])) w.complete(m);
  }

  /// Sends one thing to the page and waits for its own answer (never a guessed one).
  Future<Map<String, dynamic>?> _ask(Future<void> Function() send) async {
    final w = Completer<Map<String, dynamic>>();
    _waiting = w;
    await send();
    return w.future.timeout(const Duration(seconds: 20), onTimeout: () => {'type': 'error', 'message': 'The 3D page did not answer.'});
  }

  Future<String> _load({bool first = false}) async {
    setState(() => _busy = true);
    try {
      final v = _version == null ? '' : '?v=$_version';
      final res = await _http.get(Uri.parse('${widget.baseUrl}/api/inventions/${widget.inventionId}/model.glb$v'), headers: widget.headers);
      if (res.statusCode != 200) {
        final detail = (() {
          try {
            return '${(jsonDecode(res.body) as Map)['detail']}';
          } catch (_) {
            return 'The 3D model could not be loaded (HTTP ${res.statusCode}).';
          }
        })();
        return _done(detail);
      }
      final page = await _ask(() => _viewport.load(res.bodyBytes, widget.title));
      if (page?['type'] != 'model') return _done('${page?['message'] ?? 'The 3D page could not show the model.'}');
      var said = '${widget.title}${_version == null ? '' : ', version $_version'}: ${page!['meshes']} parts in the viewer.';
      final first0 = widget.initialCommand;
      if (first && first0 != null) said = '$said ${await _command(first0)}';
      return _done(said);
    } catch (_) {
      return _done('The 3D model could not be loaded. Check the connection and try again.');
    }
  }

  String _done(String text) {
    if (mounted) {
      setState(() {
        _status = text;
        _busy = false;
      });
    }
    return text;
  }

  Future<String> _command(Map<String, Object> cmd) async {
    final page = await _ask(() => _viewport.command(cmd));
    if (page?['type'] != 'done') return '${page?['message'] ?? 'The 3D page did not answer.'}';
    if (page!['ok'] != true) return '${page['note'] ?? 'That did not work.'}';
    final note = '${page['note'] ?? ''}'.trim();
    if (note.isNotEmpty) return note;
    return switch (cmd['action']) {
      'rotate' => 'Turned ${(cmd['deg'] as int).abs()} degrees ${(cmd['deg'] as int) < 0 ? 'left' : 'right'}.',
      'zoom' => (cmd['factor'] as num) > 1 ? 'Zoomed in.' : 'Zoomed out.',
      'reset' => 'View reset.',
      'view' => 'Showing the ${{0: 'front', 90: 'side', 180: 'back'}[cmd['deg']]} view.',
      'spin' => cmd['on'] == true ? 'Spinning.' : 'Stopped spinning.',
      _ => 'Done.',
    };
  }

  Future<String> _colour(String colour) async {
    setState(() => _busy = true);
    try {
      final res = await _http.post(
        Uri.parse('${widget.baseUrl}/api/inventions/${widget.inventionId}/visual'),
        headers: {...widget.headers, 'Content-Type': 'application/json'},
        body: jsonEncode({'action': 'colour', 'colour': colour}),
      );
      final body = jsonDecode(res.body);
      if (res.statusCode != 200 || body is! Map || body['model'] is! Map) {
        return _done(body is Map && body['spoken'] != null ? '${body['spoken']}' : 'The colour was not changed (HTTP ${res.statusCode}).');
      }
      _version = (body['model'] as Map)['v'] as int?;
      final loaded = await _load();
      return _done('${body['spoken']} $loaded');
    } catch (_) {
      return _done('The colour was not changed. Check the connection and try again.');
    }
  }

  /// Voice and typing while the viewer is open. Returns the spoken result, or null when the words are not for it.
  Future<String?> voice(String words) async {
    final ask = cheInventionViewerIntent(words);
    if (ask == null) return null;
    if (ask.say != null) return _done(ask.say!);
    if (ask.colour != null) return _colour(ask.colour!);
    return _done(await _command(ask.cmd!));
  }

  Future<void> _button(Future<String> Function() run) async {
    HapticFeedback.selectionClick();
    final said = await run();
    widget.onSpeak?.call(said);
  }

  @override
  Widget build(BuildContext context) {
    Widget btn(String label, String semantics, IconData icon, Future<String> Function() run) => Semantics(
      button: true,
      label: semantics,
      excludeSemantics: true,
      child: OutlinedButton.icon(onPressed: _busy ? null : () => _button(run), icon: Icon(icon, size: 18), label: Text(label)),
    );
    return Scaffold(
      appBar: AppBar(title: Text('${widget.title} in 3D')),
      body: Column(
        children: [
          Expanded(
            child: Semantics(
              label: '3D view of ${widget.title}. Say rotate it, zoom in, front view, or change the colour.',
              child: _viewport.build(context),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, 0),
            child: Semantics(liveRegion: false, child: Text(_status, key: const Key('invention-viewer-status'))),
          ),
          Padding(
            padding: const EdgeInsets.all(CheSpace.sm),
            child: Wrap(
              spacing: CheSpace.sm,
              runSpacing: CheSpace.xs,
              alignment: WrapAlignment.center,
              children: [
                btn('Left', 'Rotate left', Icons.rotate_left, () async => _done(await _command({'action': 'rotate', 'deg': -45}))),
                btn('Right', 'Rotate right', Icons.rotate_right, () async => _done(await _command({'action': 'rotate', 'deg': 45}))),
                btn('Zoom in', 'Zoom in', Icons.zoom_in, () async => _done(await _command({'action': 'zoom', 'factor': 1.4}))),
                btn('Zoom out', 'Zoom out', Icons.zoom_out, () async => _done(await _command({'action': 'zoom', 'factor': 0.7}))),
                btn('Reset', 'Reset the view', Icons.center_focus_strong, () async => _done(await _command({'action': 'reset'}))),
              ],
            ),
          ),
          SizedBox(
            height: 52,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
              children: [
                for (final c in cheInventionColours)
                  Padding(
                    padding: const EdgeInsets.only(right: CheSpace.xs),
                    child: Semantics(
                      button: true,
                      label: 'Change the main colour to $c',
                      excludeSemantics: true,
                      child: ActionChip(label: Text(c), onPressed: _busy ? null : () => _button(() => _colour(c))),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: CheSpace.sm),
        ],
      ),
    );
  }
}
