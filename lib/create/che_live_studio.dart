// Live Studio (owner, 2026-10-24): Create → Create Person opens one creation project in a large 3D viewport the owner
// can turn, pinch, inspect and edit by voice or typing. Everything shown is real:
//  - the viewport holds either the GLB the Creation Engine exported from Blender for this project (gpu_queue.js stores
//    it; the page names the job, the GPU and the time) or, before that exists, CHE's bundled crew model of the base
//    character, labelled as such and never as the owner's edits;
//  - progress is the Creation Engine job's own history (queued, claimed by the Colab GPU, geometry ready, each preview
//    picture as it arrives, completed or failed) with its timestamps, and the preview pictures themselves;
//  - edits go to the Worker's deterministic edit parser (creation_studio.js), which keeps versions with undo and redo.
// Nothing is spoken on open (owner rule, 2026-10-11); Read aloud speaks the page on request, and every action reports
// its real outcome in a large banner with a haptic. While the studio is on screen, typed or spoken words reach it first
// (CheLiveStudio.voiceHandler, lib/home_state/send.dart).
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:webview_flutter/webview_flutter.dart';

import '../rooms/che_crew_states.dart' show cheCrewModelIds;
import 'che_creative_studio.dart' show CheStudioColors;

const cheColabNotebookUrl =
    'https://colab.research.google.com/github/Vondada/chey-app/blob/main/notebooks/CHE_GPU_Face_Preview.ipynb';

/// The Creation Engine as the Worker reports it: the owner's Colab GPU when it is open, and the free GitHub cloud CPU
/// workers CHE starts by herself (`automatic`).
class CheCreationEngine {
  const CheCreationEngine({
    this.status = 'unknown',
    this.gpu,
    this.lastSeen,
    this.notebookUrl = cheColabNotebookUrl,
    this.automatic = false,
    this.workersOnline = 0,
    this.maxConcurrent = 0,
    this.waitingReason = '',
  });

  factory CheCreationEngine.fromJson(Object? j) {
    if (j is! Map) return const CheCreationEngine();
    final gpu = '${j['gpu'] ?? ''}'.trim();
    return CheCreationEngine(
      status:
          '${j['status'] ?? (j['online'] == true
                  ? 'online'
                  : j['paired'] == false
                  ? 'not_paired'
                  : 'offline')}',
      gpu: gpu.isEmpty ? null : gpu,
      lastSeen: j['last_seen'] == null ? null : '${j['last_seen']}',
      notebookUrl: '${j['notebook_url'] ?? cheColabNotebookUrl}',
      automatic: j['automatic'] == true,
      workersOnline: (j['workers_online'] as num?)?.toInt() ?? 0,
      maxConcurrent: (j['max_concurrent'] as num?)?.toInt() ?? 0,
      waitingReason: '${j['waiting_reason'] ?? ''}'.trim(),
    );
  }

  /// online (a GPU is checked in) | cloud (CHE starts free cloud workers) | offline | not_paired | unknown (not loaded).
  final String status;
  final String? gpu;
  final String? lastSeen;
  final String notebookUrl;

  /// CHE can start a free cloud worker herself, so nothing is needed from the owner.
  final bool automatic;
  final int workersOnline;
  final int maxConcurrent;
  final String waitingReason;

  bool get online => status == 'online';

  /// Jobs run without the owner doing anything: a GPU is online, or CHE can start a cloud worker.
  bool get ready => online || automatic;
  bool get paired => status != 'not_paired';

  String get label => online
      ? 'Creation Engine Online'
      : automatic
      ? 'Creation Engine Ready'
      : switch (status) {
          'not_paired' => 'Cloud Computer not set up',
          'unknown' => 'Checking the Cloud Computer',
          _ => 'Waiting for a worker',
        };

  String get detail {
    final jobs = maxConcurrent > 1 ? ' Up to $maxConcurrent jobs at once.' : '';
    if (online) return 'Running on ${gpu ?? 'your GPU'}.$jobs';
    if (automatic) return 'CHE starts free cloud workers herself. They use the CPU, which is slower than your Colab GPU.$jobs';
    if (status == 'unknown') return '';
    final why = waitingReason.isEmpty ? '' : '$waitingReason ';
    if (status == 'not_paired') return '${why}No worker can run yet. Setup is in Settings, Connections, Cloud Computer.';
    return '${why}No worker is online; saved stages are kept and jobs resume when one is free.';
  }
}

/// The owner-facing state of a Creation Engine job: Creating, Waiting for Resources, Starting a cloud worker, Paused,
/// Completed, Failed or Cancelled. The Worker's own `display_state` wins; older jobs are mapped from their state.
String cheJobDisplayState(Map? job) {
  if (job == null) return '';
  final shown = '${job['display_state'] ?? ''}'.trim();
  if (shown.isNotEmpty) return shown;
  return switch ('${job['state'] ?? ''}') {
    'rendering' => 'Creating',
    'queued' => 'Waiting for Resources',
    'paused' => 'Paused',
    'completed' => 'Completed',
    'failed' => 'Failed',
    'cancelled' => 'Cancelled',
    _ => '',
  };
}

/// "rotate the model left", "turn it around", "zoom in", "front view", "reset the view" → a viewport command, or null.
/// These need no server and work while the Creation Engine is offline.
Map<String, Object>? cheViewportCommand(String words) {
  final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '');
  final deg = RegExp(r'(\d{1,3})\s*degrees?').firstMatch(t);
  if (RegExp(r'^(?:rotate|turn|spin)\b').hasMatch(t) && !RegExp(r'\b(?:on|off|turntable)\b').hasMatch(t)) {
    if (RegExp(r'\baround\b').hasMatch(t) && deg == null) return {'action': 'rotate', 'deg': 180};
    final n = deg == null ? 45 : int.parse(deg.group(1)!);
    return {'action': 'rotate', 'deg': RegExp(r'\bleft\b').hasMatch(t) ? -n : n};
  }
  if (RegExp(r'^zoom in|^closer$|^get closer').hasMatch(t)) return {'action': 'zoom', 'factor': 1.4};
  if (RegExp(r'^zoom out|^further$|^back up').hasMatch(t)) return {'action': 'zoom', 'factor': 1 / 1.4};
  if (RegExp(r'^reset(?: the)? (?:view|camera)$|^recenter|^re-center').hasMatch(t)) return {'action': 'reset'};
  if (RegExp(r'^(?:show (?:me )?)?(?:the )?front(?: view)?$').hasMatch(t)) return {'action': 'view', 'deg': 0};
  if (RegExp(r'^(?:show (?:me )?)?(?:the )?(?:side|profile)(?: view)?$').hasMatch(t)) {
    return {'action': 'view', 'deg': 90};
  }
  if (RegExp(r'^(?:show (?:me )?)?(?:the )?back(?: view)?$').hasMatch(t)) return {'action': 'view', 'deg': 180};
  if (RegExp(r'^(?:show (?:me )?)?(?:the )?three[- ]quarter(?: view)?$').hasMatch(t)) {
    return {'action': 'view', 'deg': 45};
  }
  if (RegExp(r'^(?:turntable|auto[- ]?rotate|spin)(?: on)?$').hasMatch(t)) return {'action': 'spin', 'on': true};
  if (RegExp(r'^(?:turntable|auto[- ]?rotate|spin) off$|^stop (?:spinning|turning)$').hasMatch(t)) {
    return {'action': 'spin', 'on': false};
  }
  if (RegExp(r'^stop(?: the)? anim').hasMatch(t)) return {'action': 'stop'};
  return null;
}

/// Mouth cues for a spoken reply, generated from its words alone (Rhubarb Lip Sync's mouth shapes A to H and X).
///
/// APPROXIMATE, by design: CHE's voice arrives as MP3 from ElevenLabs or Fish, and decoding MP3 to an amplitude
/// envelope in pure Dart is not cheap, so this does not listen to the audio. It walks the text at about 13 characters
/// a second (vowels open the mouth, b/m/p close it, f/v touch the lip, punctuation pauses). When [durationMs] is known
/// (cheAudioDurationMs reads it from the clip's MP3 header) the cues are stretched to the clip's real length, so the
/// mouth starts and stops with the audio; the shapes in between follow the letters, not the sounds.
List<Map<String, Object>> cheLipSyncCues(String text, {int? durationMs}) {
  const perChar = 1 / 13;
  final t = text.toLowerCase();
  final raw = <(String, double)>[];
  for (var i = 0; i < t.length; i++) {
    final c = t[i];
    final next = i + 1 < t.length ? t[i + 1] : '';
    final shape = switch (c) {
      'a' => 'D',
      'e' || 'i' || 'y' => 'C',
      'o' => next == 'o' ? 'F' : 'E',
      'u' || 'w' || 'q' => 'F',
      'b' || 'm' || 'p' => 'A',
      'f' || 'v' => 'G',
      'l' => 'H',
      ' ' || '\n' || '\t' || '-' => 'X',
      '.' || ',' || '!' || '?' || ';' || ':' => 'P', // a pause, written as rest below
      _ => RegExp(r'[a-z0-9]').hasMatch(c) ? 'B' : '',
    };
    if (shape.isEmpty) continue;
    raw.add(shape == 'P' ? ('X', perChar * 3) : (shape, perChar));
  }
  while (raw.isNotEmpty && raw.last.$1 == 'X') {
    raw.removeLast();
  }
  final total = raw.fold<double>(0, (a, r) => a + r.$2);
  if (total <= 0) return const [];
  final scale = durationMs != null && durationMs > 200 ? (durationMs / 1000) / total : 1.0;
  final cues = <Map<String, Object>>[];
  var at = 0.0;
  for (final (shape, len) in raw) {
    final end = at + len * scale;
    if (cues.isNotEmpty && cues.last['value'] == shape) {
      cues.last['end'] = double.parse(end.toStringAsFixed(3));
    } else {
      cues.add({'start': double.parse(at.toStringAsFixed(3)), 'end': double.parse(end.toStringAsFixed(3)), 'value': shape});
    }
    at = end;
  }
  return cues;
}

/// Whether words are meant for the open creation ("make the hair longer", "bigger eyes", "undo", "save it") rather
/// than for Chat ("what's the weather"). Edits the Worker cannot do are still answered here, plainly, so Chat never
/// claims a change that was not made.
bool cheLooksLikeEdit(String words) {
  final t = words.trim().toLowerCase();
  return RegExp(
        r'^(?:make|change|give|add|remove|turn|put|set|use|try|more|less|bigger|smaller|larger|longer|shorter|'
        r'wider|narrower|fuller|thinner|darker|lighter|rounder|older|younger|higher|lower|undo|redo|save|generate|build|'
        r'render|create|go)\b',
      ).hasMatch(t) ||
      RegExp(
        r'\b(?:hair|eyes?|skin|nose|lips?|mouth|face|chin|cheek(?:bone)?s?|brows?|outfit|jacket|clothes|model|'
        r'character|photoreal(?:istic)?|stylized|stylised|cartoon|hybrid|office)\b',
      ).hasMatch(t);
}

/// What the viewport is showing, in words for the label above it and for Read aloud.
class CheShownModel {
  const CheShownModel({required this.source, required this.label, this.key = ''});
  final String source; // generated | bundled | none
  final String label;
  final String key; // job id + sha256 for generated, base id for bundled
}

/// The bridge to the 3D page. The real one drives a WebView (assets/characters/app/studio.html); tests use a fake.
abstract class CheViewportDriver {
  Widget build(BuildContext context);
  Future<void> load(Uint8List glb, String label);
  Future<void> command(Map<String, Object> cmd);
  Future<void> pause(bool paused);
  void dispose();
}

class _WebViewportDriver implements CheViewportDriver {
  _WebViewportDriver(this.onMessage) {
    try {
      _controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(CheStudioColors.bg)
        ..addJavaScriptChannel(
          'CheBridge',
          onMessageReceived: (m) {
            try {
              final d = jsonDecode(m.message);
              if (d is Map) onMessage(Map<String, dynamic>.from(d));
            } catch (_) {}
          },
        )
        ..setNavigationDelegate(
          NavigationDelegate(
            onPageFinished: (_) {
              _ready.isCompleted ? null : _ready.complete();
            },
          ),
        )
        ..loadFlutterAsset('assets/characters/app/studio.html');
    } catch (_) {
      _controller = null; // widget tests have no WebView platform
    }
  }

  final void Function(Map<String, dynamic>) onMessage;
  WebViewController? _controller;
  final _ready = Completer<void>();

  @override
  Widget build(BuildContext context) => _controller == null
      ? const Center(
          child: Text('The 3D viewport needs the iPhone app.', style: TextStyle(color: CheStudioColors.dim)),
        )
      : WebViewWidget(controller: _controller!);

  Future<void> _js(String code) async {
    final c = _controller;
    if (c == null) return;
    await _ready.future;
    await c.runJavaScript(code);
  }

  @override
  Future<void> load(Uint8List glb, String label) =>
      _js("window.CHE && window.CHE.loadModel('${base64Encode(glb)}', ${jsonEncode({'label': label})});");

  @override
  Future<void> command(Map<String, Object> cmd) => _js('window.CHE && window.CHE.view(${jsonEncode(cmd)});');

  @override
  Future<void> pause(bool paused) => _js('window.CHE && window.CHE.pause($paused);');

  @override
  void dispose() {}
}

enum CheLiveStudioMode { person, animation }

class CheLiveStudio extends StatefulWidget {
  const CheLiveStudio({
    super.key,
    required this.baseUrl,
    required this.headers,
    this.projectId,
    this.base = 'che',
    this.mode = CheLiveStudioMode.person,
    this.onRead,
    this.onSpeak,
    this.onOpenEngineSettings,
    this.client,
    this.viewport,
    this.loadBundled,
  });

  final String baseUrl;
  final Map<String, String> headers;

  /// The creation project (person mode). Null in animation mode, which previews a bundled crew model's own clips.
  final String? projectId;
  final String base;
  final CheLiveStudioMode mode;
  final void Function(String text)? onRead;

  /// Speaks the outcome of an action the owner took with a button or the text field (AGENTS.md: every action is
  /// reported aloud). Actions by voice are spoken by the voice route itself, so they never speak twice; passive loads
  /// and polls never speak.
  final void Function(String text)? onSpeak;
  final VoidCallback? onOpenEngineSettings;
  final http.Client? client;

  /// Tests: a fake viewport and bundled-model loader.
  final CheViewportDriver Function(void Function(Map<String, dynamic>) onMessage)? viewport;
  final Future<Uint8List?> Function(String id)? loadBundled;

  /// While the studio is on screen, typed or spoken words reach it first; null means "not mine" (it goes to Chat).
  static Future<String?> Function(String words)? voiceHandler;

  /// While the studio is open, CHE's voice player (lib/home_state/voice.dart, _playServerVoice) calls this as each
  /// clip starts playing, with the clip's words and its length from the MP3 header, so the character's mouth moves
  /// with whatever CHE is already saying. It never starts speech itself (owner rule, 2026-10-11).
  static void Function(String text, int? durationMs)? speechLipSync;

  /// Called when a clip ends or fails: the mouth returns to rest.
  static VoidCallback? speechLipSyncStop;

  /// The short line the lip sync test speaks.
  static const lipSyncTestLine = 'Hi, I am CHE. This is a lip sync test, so you can see my mouth move.';

  static Route<void> route({
    required String baseUrl,
    required Map<String, String> headers,
    String? projectId,
    String base = 'che',
    CheLiveStudioMode mode = CheLiveStudioMode.person,
    void Function(String text)? onRead,
    void Function(String text)? onSpeak,
    VoidCallback? onOpenEngineSettings,
  }) => MaterialPageRoute<void>(
    builder: (_) => CheLiveStudio(
      baseUrl: baseUrl,
      headers: headers,
      projectId: projectId,
      base: base,
      mode: mode,
      onRead: onRead,
      onSpeak: onSpeak,
      onOpenEngineSettings: onOpenEngineSettings,
    ),
  );

  @override
  State<CheLiveStudio> createState() => CheLiveStudioState();
}

String _clock(String? iso) {
  final t = DateTime.tryParse(iso ?? '')?.toLocal();
  if (t == null) return '';
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
}

const _viewNames = {'0': 'Front', '45': 'Three-quarter', '90': 'Side'};

class CheLiveStudioState extends State<CheLiveStudio> with WidgetsBindingObserver {
  late final http.Client _http = widget.client ?? http.Client();
  late final CheViewportDriver _viewport = (widget.viewport ?? _WebViewportDriver.new)(_onPage);
  final _edit = TextEditingController();
  Map<String, dynamic> project = const {};
  CheCreationEngine engine = const CheCreationEngine();
  CheShownModel shown = const CheShownModel(source: 'none', label: 'No model loaded yet.');
  Map<String, dynamic> modelInfo = const {};
  List<String> clips = const [];
  String? playing;
  String banner = '';
  bool bannerOk = true;
  bool busy = false;
  bool loading = true;
  Timer? _poll;
  late String _animBase = widget.base;

  bool get _personMode => widget.mode == CheLiveStudioMode.person;
  Map<String, dynamic>? get job => project['job'] is Map ? Map<String, dynamic>.from(project['job'] as Map) : null;
  String get jobState => '${job?['state'] ?? ''}';
  bool get jobActive => const {'queued', 'rendering', 'paused'}.contains(jobState);

  /// How many versions the project has: the detail lists them (`versions`), the summary counts them.
  int get versionCount =>
      (project['versions_count'] as num?)?.toInt() ??
      (project['versions'] is List
          ? (project['versions'] as List).length
          : (project['versions'] as num?)?.toInt() ?? 0);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    CheLiveStudio.voiceHandler = voice;
    CheLiveStudio.speechLipSync = lipSyncSpeech;
    CheLiveStudio.speechLipSyncStop = stopSpeaking;
    unawaited(_personMode ? refresh(first: true) : _showBundled(_animBase));
    if (!_personMode) loading = false;
  }

  @override
  void dispose() {
    if (CheLiveStudio.voiceHandler == voice) CheLiveStudio.voiceHandler = null;
    if (CheLiveStudio.speechLipSync == lipSyncSpeech) CheLiveStudio.speechLipSync = null;
    if (CheLiveStudio.speechLipSyncStop == stopSpeaking) CheLiveStudio.speechLipSyncStop = null;
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _viewport.dispose();
    _edit.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final paused = state != AppLifecycleState.resumed;
    unawaited(_viewport.pause(paused).catchError((_) {}));
    if (paused) {
      _poll?.cancel();
    } else {
      _schedulePoll();
    }
  }

  /// True while voice() runs: its reply is spoken by the voice route, so actions inside it do not speak again.
  bool _inVoice = false;

  /// An explicit action's outcome: banner, haptic and, unless a voice route will speak it, speech.
  void _say(bool ok, String text) {
    _report(ok, text);
    if (!_inVoice) widget.onSpeak?.call(text);
  }

  void _report(bool ok, String text) {
    if (ok) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    if (mounted) {
      setState(() {
        banner = text;
        bannerOk = ok;
      });
    }
  }

  void _onPage(Map<String, dynamic> m) {
    if (!mounted) return;
    switch (m['type']) {
      case 'model':
        setState(() {
          modelInfo = m;
          clips = [for (final c in (m['clips'] as List? ?? const [])) '$c'];
        });
      case 'done':
        setState(() => playing = m['playing'] == null ? null : '${m['playing']}');
        // A passive lip sync answer must not stand in for the answer another command is waiting on.
        if (_waitingFor != null && m['action'] != null && '${m['action']}' != _waitingFor) return;
        final w = _waiting;
        _waiting = null;
        if (w != null && !w.isCompleted) w.complete(m);
      case 'error':
        _report(false, '${m['message'] ?? 'The model could not be shown.'}');
    }
  }

  Map<String, String> get _json => {...widget.headers, 'Content-Type': 'application/json'};

  Future<Map<String, dynamic>?> _call(String method, String path, [Map<String, dynamic>? body]) async {
    try {
      final uri = Uri.parse('${widget.baseUrl}$path');
      final r =
          await (method == 'GET'
                  ? _http.get(uri, headers: widget.headers)
                  : _http.post(uri, headers: _json, body: jsonEncode(body ?? const {})))
              .timeout(const Duration(seconds: 15));
      final d = jsonDecode(r.body);
      if (d is! Map) return null;
      return {...Map<String, dynamic>.from(d), '_status': r.statusCode};
    } catch (_) {
      return null;
    }
  }

  /// Reloads the project (state, stages, previews, engine) and shows the newest real model.
  Future<void> refresh({bool first = false}) async {
    final id = widget.projectId;
    if (id == null) return;
    final d = await _call('GET', '/api/creations/$id');
    if (!mounted) return;
    if (d == null || d['project'] is! Map) {
      setState(() => loading = false);
      if (first) _report(false, 'Could not load this creation from CHE. Use Refresh to try again.');
      // A dropped request while a model is building must not stop the updates: try again on the next tick (review of
      // #520). With no job running, nothing polls.
      _schedulePoll();
      return;
    }
    final p = Map<String, dynamic>.from(d['project'] as Map);
    setState(() {
      project = p;
      engine = CheCreationEngine.fromJson(p['engine'] ?? d['engine']);
      loading = false;
    });
    await _showBest();
    _schedulePoll();
  }

  void _schedulePoll() {
    _poll?.cancel();
    if (!mounted || !_personMode || !jobActive) return;
    _poll = Timer(const Duration(seconds: 6), () {
      if (mounted && (ModalRoute.of(context)?.isCurrent ?? true)) unawaited(refresh());
    });
  }

  /// The generated GLB when the Creation Engine has delivered one, else the bundled model of the base character.
  Future<void> _showBest() async {
    final j = job;
    final m = j?['model'] is Map ? Map<String, dynamic>.from(j!['model'] as Map) : null;
    if (m != null && '${m['url'] ?? ''}'.isNotEmpty) {
      final key = '${j!['id']}:${m['sha256']}';
      if (shown.key == key) return;
      try {
        final r = await _http
            .get(Uri.parse('${widget.baseUrl}${m['url']}'), headers: widget.headers)
            .timeout(const Duration(seconds: 40));
        if (r.statusCode != 200 || r.bodyBytes.length < 20) throw StateError('status ${r.statusCode}');
        final gpu = '${j['receipt'] is Map ? (j['receipt'] as Map)['nvidia_smi'] ?? '' : ''}'.split(',').first.trim();
        final label =
            'Version ${project['version'] ?? ''} model, exported by Blender'
            '${gpu.isEmpty ? '' : ' on $gpu'} at ${_clock('${m['uploaded_at']}')}.';
        await _viewport.load(r.bodyBytes, label);
        if (mounted) setState(() => shown = CheShownModel(source: 'generated', label: label, key: key));
        return;
      } catch (_) {
        if (mounted) _report(false, 'The 3D model exists but could not be downloaded. Use Refresh to try again.');
      }
    }
    if (shown.source == 'generated') {
      // The newest version has no model yet (an edit since): the last built model stays, and the label says so.
      final note = ' Your newest edits are not in it yet: say generate to build them.';
      if (!shown.label.endsWith(note) && mounted) {
        setState(() => shown = CheShownModel(source: 'generated', label: '${shown.label}$note', key: shown.key));
      }
      return;
    }
    if (shown.source == 'none') await _showBundled('${project['base_id'] ?? widget.base}');
  }

  Future<void> _showBundled(String id) async {
    if (!cheCrewModelIds.contains(id)) {
      if (mounted) {
        setState(
          () => shown = CheShownModel(
            source: 'none',
            label: 'There is no 3D model of ${_name(id)} yet. Generate the model to build one.',
          ),
        );
      }
      return;
    }
    try {
      final bytes = widget.loadBundled != null
          ? await widget.loadBundled!(id)
          : (await rootBundle.load('assets/characters/crew/$id.glb')).buffer.asUint8List();
      if (bytes == null) throw StateError('missing');
      final label = _personMode
          ? 'Bundled stylised model of ${_name(id)}: not your edits. Your model appears here when the Creation Engine builds it.'
          : 'Bundled stylised model of ${_name(id)} with its built-in animation clips.';
      await _viewport.load(bytes, label);
      if (mounted) setState(() => shown = CheShownModel(source: 'bundled', label: label, key: id));
    } catch (_) {
      if (mounted) _report(false, 'Could not load the bundled model of ${_name(id)}.');
    }
  }

  static String _name(String id) => id.isEmpty
      ? 'this character'
      : id == 'che'
      ? 'CHE'
      : '${id[0].toUpperCase()}${id.substring(1)}';

  Completer<Map<String, dynamic>>? _waiting;
  String? _waitingFor;

  /// Sends one command to the viewport and waits for its own answer ({ok, note}); null when it never answered. Spoken
  /// confirmations come from this answer, so CHE never reports a viewport change that did not happen (review of #521).
  Future<Map<String, dynamic>?> _runViewport(Map<String, Object> cmd) async {
    final w = Completer<Map<String, dynamic>>();
    _waiting = w;
    _waitingFor = '${cmd['action']}';
    try {
      await _viewport.command(cmd);
      return await w.future.timeout(const Duration(seconds: 3));
    } catch (_) {
      return null;
    } finally {
      if (identical(_waiting, w)) {
        _waiting = null;
        _waitingFor = null;
      }
    }
  }

  /// The mouth shape key the page found in the loaded model (e.g. mouth_open), or null when it has none.
  String? get mouthMorph {
    final m = modelInfo['mouth_morph'];
    return m == null || '$m'.isEmpty ? null : '$m';
  }

  /// Passive: moves the character's mouth with words CHE is already speaking. Nothing is spoken, shown or reported
  /// here, and nothing is sent when the model has no mouth shape key (the page would refuse it anyway).
  void lipSyncSpeech(String text, int? durationMs) {
    if (!mounted || shown.source == 'none' || mouthMorph == null || text.trim().isEmpty) return;
    final cues = cheLipSyncCues(text, durationMs: durationMs);
    if (cues.isEmpty) return;
    unawaited(
      _viewport
          .command({'action': 'lipsync', 'cues': cues, 'source': 'text', if (durationMs != null) 'duration': durationMs / 1000})
          .catchError((_) {}),
    );
  }

  /// Passive: the mouth back at rest when a clip ends.
  void stopSpeaking() {
    if (!mounted || shown.source == 'none' || mouthMorph == null) return;
    unawaited(_viewport.command({'action': 'stop_speaking'}).catchError((_) {}));
  }

  /// "Make her talk" / "lip sync test" / the Lip sync test button: the page animates the test line's mouth cues and
  /// says whether it could; the reply (the test line) is then spoken by the usual voice path, which moves the mouth
  /// again in time with the real audio.
  Future<String> lipSyncTest() async {
    HapticFeedback.selectionClick();
    if (shown.source == 'none') {
      const msg = 'There is no model in the viewport yet.';
      _say(false, msg);
      return msg;
    }
    final r = await _runViewport({
      'action': 'lipsync',
      'cues': cheLipSyncCues(CheLiveStudio.lipSyncTestLine),
      'source': 'text',
    });
    if (r == null || r['ok'] != true) {
      final msg = 'That did not work: ${'${r?['note'] ?? ''}'.trim().isEmpty ? 'the 3D view did not answer.' : r!['note']}';
      _say(false, msg);
      return msg;
    }
    final morph = '${r['mouth_morph'] ?? mouthMorph ?? 'mouth'}';
    final msg = '${CheLiveStudio.lipSyncTestLine} The mouth moves on the $morph shape key, timed from the words, '
        'so it is approximate.';
    _say(true, msg);
    return msg;
  }

  Future<String> _post(String path, [Map<String, dynamic>? body]) async {
    setState(() => busy = true);
    final d = await _call('POST', path, body);
    if (!mounted) return '';
    setState(() => busy = false);
    if (d == null) {
      const msg = 'That did not work: CHE could not be reached.';
      _say(false, msg);
      return msg;
    }
    final ok = d['ok'] == true && (d['_status'] as int? ?? 500) < 300;
    if (d['project'] is Map) setState(() => project = Map<String, dynamic>.from(d['project'] as Map));
    var said = '${d['spoken'] ?? d['detail'] ?? (ok ? 'Done.' : 'That did not work.')}';
    var done = ok;
    if (d['viewport'] is Map) {
      // The viewport acts first; its own answer decides what is reported.
      final cmd = Map<String, Object>.from(d['viewport'] as Map);
      final r = shown.source == 'none' ? {'ok': false, 'note': 'There is no model in the viewport yet.'} : await _runViewport(cmd);
      if (r == null || r['ok'] != true) {
        done = false;
        said = 'That did not work: ${'${r?['note'] ?? ''}'.trim().isEmpty ? 'the 3D view did not answer.' : r!['note']}';
      } else if ('${r['note'] ?? ''}'.trim().isNotEmpty) {
        said = '${r['note']}';
      }
    }
    _say(done, said);
    if (ok) await refresh();
    return said;
  }

  Future<String> generate() => _post('/api/creations/${widget.projectId}/generate');
  Future<String> undo() => _post('/api/creations/${widget.projectId}/undo');
  Future<String> redo() => _post('/api/creations/${widget.projectId}/redo');
  Future<String> save() => _post('/api/creations/${widget.projectId}/save');

  Future<String> applyEdit(String text) async {
    final t = text.trim();
    if (t.isEmpty) return 'Say or type a change, like make the hair longer.';
    _edit.clear();
    return _post('/api/creations/${widget.projectId}/edit', {'text': t});
  }

  Future<String> viewportCommand(Map<String, Object> cmd) async {
    HapticFeedback.selectionClick();
    if (shown.source == 'none') {
      const msg = 'There is no model in the viewport yet.';
      _say(false, msg);
      return msg;
    }
    final r = await _runViewport(cmd);
    if (r == null || r['ok'] != true) {
      final msg = 'That did not work: ${'${r?['note'] ?? ''}'.trim().isEmpty ? 'the 3D view did not answer.' : r!['note']}';
      _say(false, msg);
      return msg;
    }
    final a = cmd['action'];
    final msg = switch (a) {
      'rotate' =>
        'Turned the model ${(cmd['deg'] as num) < 0 ? 'left' : 'right'} ${(cmd['deg'] as num).abs()} degrees.',
      'zoom' => (cmd['factor'] as num) > 1 ? 'Zoomed in.' : 'Zoomed out.',
      'reset' => 'View reset.',
      'view' => '${_viewNames['${cmd['deg']}'] ?? 'Back'} view.',
      'spin' => cmd['on'] == false ? 'Turntable off.' : 'Turntable on.',
      'stop' => 'Animation stopped.',
      _ => '${r['note'] ?? ''}'.trim().isEmpty ? 'Done.' : '${r['note']}',
    };
    _say(true, msg);
    return msg;
  }

  Future<String> animate([String? clip]) async {
    if (clips.isEmpty) {
      final msg = shown.source == 'generated'
          ? 'This generated model has no skeleton yet, so it cannot be animated. Animation works on the bundled crew models.'
          : 'This model has no animation clips.';
      _say(false, msg);
      return msg;
    }
    final want = clip != null && clips.contains(clip) ? clip : (clips.contains('idle') ? 'idle' : clips.first);
    final r = await _runViewport({'action': 'animate', 'clip': want});
    if (r == null || r['ok'] != true) {
      final msg = 'That did not work: ${'${r?['note'] ?? ''}'.trim().isEmpty ? 'the 3D view did not answer.' : r!['note']}';
      _say(false, msg);
      return msg;
    }
    setState(() => playing = want);
    final msg = 'Playing the $want animation on the ${shown.source == 'generated' ? 'model' : 'bundled model'}.';
    _say(true, msg);
    return msg;
  }

  /// "Connect": CHE's Cloud Computer picks and starts workers by itself, so this never opens a website. It re-reads the
  /// engine and reports the truth; only when no worker can run does it open Settings, Connections, Cloud Computer.
  Future<void> connectEngine() async {
    HapticFeedback.selectionClick();
    await refresh();
    if (!mounted) return;
    if (engine.ready) {
      _say(true, engine.online ? 'Connected. ${engine.label}. ${engine.detail}' : 'Connected. Your Cloud Computer is ready. ${engine.detail}');
      return;
    }
    widget.onOpenEngineSettings?.call();
    _say(false, '${engine.label}. ${engine.detail} Opened Settings, Connections, Cloud Computer.');
  }

  List<Map<String, dynamic>> get stages => [
    for (final s in (project['stages'] as List? ?? const []))
      if (s is Map) Map<String, dynamic>.from(s),
  ];

  Map<String, String> get previews => {
    for (final e in ((job?['previews'] ?? project['previews']) as Map? ?? const {}).entries) '${e.key}': '${e.value}',
  };

  /// Read aloud: what is on screen, from real state only.
  String get spokenSummary {
    if (!_personMode) {
      return 'Animation preview of ${_name(_animBase)}. ${shown.label} '
          '${clips.isEmpty ? '' : 'Clips: ${clips.join(', ')}. Say play, then a clip name.'}';
    }
    final title = '${project['title'] ?? 'Creation'}';
    final v = project['version'];
    final n = versionCount;
    final j = job;
    final work = j == null
        ? 'No model has been generated for this version yet. Say generate the model.'
        : 'Creation Engine job: ${cheJobDisplayState(j)}. ${'${j['status_line'] ?? ''}'.trim().isNotEmpty ? j['status_line'] : '${j['progress'] is Map ? (j['progress'] as Map)['message'] ?? '' : ''}'}';
    final pics = previews.isEmpty ? '' : ' ${previews.length} preview picture${previews.length == 1 ? '' : 's'} ready.';
    return '$title, version $v of $n. ${engine.label}. ${shown.label} $work$pics '
        'Say a change like make the hair longer, or rotate, zoom in, undo, redo, save, generate.';
  }

  /// Voice and typed control while the studio is on screen.
  Future<String?> voice(String words) async {
    if (!(ModalRoute.of(context)?.isCurrent ?? true)) return null;
    _inVoice = true;
    try {
      return await _voice(words);
    } finally {
      _inVoice = false;
    }
  }

  Future<String?> _voice(String words) async {
    final t = words
        .trim()
        .toLowerCase()
        .replaceAll(RegExp(r'[.!?]+$'), '')
        .replaceFirst(RegExp(r'^(?:che|chey|chay)[,:]?\s+'), '');
    if (t.isEmpty) return null;
    if (RegExp(r"^(?:read(?: aloud| it| this| the screen)?|what(?:'s| is) on (?:the |this )?screen|where are we)$")
        .hasMatch(t)) {
      return spokenSummary;
    }
    final cmd = cheViewportCommand(t);
    if (cmd != null) return viewportCommand(cmd);
    if (RegExp(
      r'^(?:make (?:her|him|it|them|che|the (?:character|model)) (?:talk|speak)|(?:run |do |try )?(?:a |the )?lip ?sync(?: test)?|'
      r'test (?:the )?lip ?sync|talk test)$',
    ).hasMatch(t)) {
      return lipSyncTest();
    }
    final play = RegExp(
      r'^(?:animate(?: (?:the|this|my))?(?: character| model| it)?|play(?: the)?(?: (\w+))?(?: animation| clip)?)$',
    ).firstMatch(t);
    if (play != null) return animate(play.group(1));
    if (RegExp(r'^(?:refresh|update|check (?:the )?progress)$').hasMatch(t)) {
      await refresh();
      return spokenSummary;
    }
    if (RegExp(r'^connect(?: the)?(?: creation)? engine$|^connect$|^open (?:the )?(?:colab )?notebook$').hasMatch(t)) {
      await connectEngine();
      return banner;
    }
    if (!_personMode || !cheLooksLikeEdit(t)) return null;
    if (RegExp(
      r'^(?:generate|build|make|create|render)(?: the| my| a)?(?: 3d)?(?: model| it| this| person| character| preview)?$',
    ).hasMatch(t)) {
      return generate();
    }
    if (RegExp(r'^undo(?: that| the last change)?$').hasMatch(t)) return undo();
    if (RegExp(r'^redo(?: that)?$').hasMatch(t)) return redo();
    if (RegExp(r'^save(?: it| this| the (?:project|creation|character))?$').hasMatch(t)) return save();
    // Everything else is an edit for this creation; the Worker says plainly what it changed and what it cannot do.
    return applyEdit(words);
  }

  @override
  Widget build(BuildContext context) {
    final h = MediaQuery.sizeOf(context).height;
    final title = _personMode ? '${project['title'] ?? 'Live Studio'}' : 'Animation preview';
    return Scaffold(
      backgroundColor: CheStudioColors.bg,
      appBar: AppBar(
        backgroundColor: CheStudioColors.bg,
        foregroundColor: CheStudioColors.text,
        title: Semantics(header: true, child: Text(title, overflow: TextOverflow.ellipsis)),
        actions: [
          IconButton(
            key: const ValueKey('live-read'),
            tooltip: 'Read the Live Studio aloud',
            onPressed: widget.onRead == null ? null : () => widget.onRead!(spokenSummary),
            icon: const Icon(Icons.volume_up_rounded),
          ),
          if (_personMode)
            IconButton(
              key: const ValueKey('live-refresh'),
              tooltip: 'Refresh progress',
              onPressed: busy ? null : () => unawaited(refresh()),
              icon: const Icon(Icons.refresh_rounded),
            ),
        ],
      ),
      body: SafeArea(
        top: false,
        // One built column (not a lazy list): VoiceOver can reach every control, and voice routes need no scrolling.
        child: SingleChildScrollView(
          key: const ValueKey('live-studio-scroll'),
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_personMode) _EngineBar(engine: engine, onConnect: () => unawaited(connectEngine())),
              if (banner.isNotEmpty) ...[const SizedBox(height: 10), _Banner(text: banner, ok: bannerOk)],
              const SizedBox(height: 10),
              // ── Viewport ──────────────────────────────────────────────────────────────
              Semantics(
                label:
                    '3D viewport. ${shown.label} Drag to turn, pinch to zoom, double tap to reset. '
                    'Or use the buttons below, or say rotate, zoom in, or front view.',
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(20),
                  child: Container(
                    key: const ValueKey('live-viewport'),
                    height: (h * 0.46).clamp(260.0, 560.0),
                    decoration: BoxDecoration(
                      color: CheStudioColors.bg,
                      border: Border.all(color: CheStudioColors.stroke),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: _viewport.build(context),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                shown.label,
                key: const ValueKey('live-shown'),
                style: const TextStyle(color: CheStudioColors.silver, fontSize: 14, height: 1.35),
              ),
              if (modelInfo.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    '${modelInfo['vertices']} vertices, ${modelInfo['triangles']} triangles, ${modelInfo['meshes']} parts'
                    '${clips.isEmpty ? '' : ', ${clips.length} animation clips'}.',
                    style: const TextStyle(color: CheStudioColors.dim, fontSize: 13),
                  ),
                ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  _tool(
                    'Turn left',
                    Icons.chevron_left_rounded,
                    () => viewportCommand({'action': 'rotate', 'deg': -45}),
                  ),
                  _tool(
                    'Turn right',
                    Icons.chevron_right_rounded,
                    () => viewportCommand({'action': 'rotate', 'deg': 45}),
                  ),
                  _tool('Zoom in', Icons.zoom_in_rounded, () => viewportCommand({'action': 'zoom', 'factor': 1.4})),
                  _tool(
                    'Zoom out',
                    Icons.zoom_out_rounded,
                    () => viewportCommand({'action': 'zoom', 'factor': 1 / 1.4}),
                  ),
                  _tool('Front', Icons.person_outline_rounded, () => viewportCommand({'action': 'view', 'deg': 0})),
                  _tool('Side', Icons.account_circle_outlined, () => viewportCommand({'action': 'view', 'deg': 90})),
                  _tool('Reset view', Icons.center_focus_strong_rounded, () => viewportCommand({'action': 'reset'})),
                  _tool('Turntable', Icons.autorenew, () => viewportCommand({'action': 'spin', 'on': true})),
                  _tool('Lip sync test', Icons.record_voice_over_rounded, lipSyncTest),
                  if (clips.isNotEmpty)
                    _tool(
                      playing == null ? 'Animate' : 'Stop animation',
                      Icons.directions_walk_rounded,
                      () => playing == null ? animate() : viewportCommand({'action': 'stop'}),
                    ),
                ],
              ),
              if (!_personMode) ...[
                const SizedBox(height: 18),
                const _Label('CHARACTER'),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final id in cheCrewModelIds)
                      ChoiceChip(
                        key: ValueKey('anim-base-$id'),
                        label: Text(_name(id)),
                        selected: _animBase == id,
                        onSelected: (_) {
                          setState(() => _animBase = id);
                          unawaited(_showBundled(id));
                        },
                      ),
                  ],
                ),
                if (clips.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  const _Label('CLIPS'),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final c in clips)
                        ChoiceChip(
                          key: ValueKey('anim-clip-$c'),
                          label: Text(c),
                          selected: playing == c,
                          onSelected: (_) => unawaited(animate(c)),
                        ),
                    ],
                  ),
                ],
                const SizedBox(height: 14),
                const Text(
                  'These are the clips built into the crew models. Making new animations and rendering animation videos is not built yet.',
                  style: TextStyle(color: CheStudioColors.dim, fontSize: 13.5, height: 1.4),
                ),
              ],
              if (_personMode) ..._personPanels(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _tool(String label, IconData icon, Future<Object?> Function() onTap) => Semantics(
    button: true,
    label: label,
    excludeSemantics: true,
    child: OutlinedButton.icon(
      key: ValueKey('live-tool-$label'),
      style: OutlinedButton.styleFrom(
        foregroundColor: CheStudioColors.text,
        side: const BorderSide(color: CheStudioColors.stroke),
        minimumSize: const Size(48, 44),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      onPressed: () => unawaited(onTap()),
      icon: Icon(icon, size: 20, color: CheStudioColors.teal),
      label: Text(label),
    ),
  );

  List<Widget> _personPanels() {
    final v = project['version'];
    final n = versionCount;
    final j = job;
    final progress = j?['progress'] is Map
        ? Map<String, dynamic>.from(j!['progress'] as Map)
        : const <String, dynamic>{};
    return [
      const SizedBox(height: 20),
      // ── Edit ───────────────────────────────────────────────────────────────────────
      const _Label('EDIT'),
      const SizedBox(height: 8),
      Row(
        children: [
          Expanded(
            child: TextField(
              key: const ValueKey('live-edit'),
              controller: _edit,
              style: const TextStyle(color: CheStudioColors.text, fontSize: 16),
              textInputAction: TextInputAction.done,
              onSubmitted: (s) => unawaited(applyEdit(s)),
              decoration: InputDecoration(
                hintText: 'Make the hair longer',
                hintStyle: const TextStyle(color: CheStudioColors.dim),
                labelText: 'Describe a change',
                labelStyle: const TextStyle(color: CheStudioColors.silver),
                filled: true,
                fillColor: CheStudioColors.card,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Semantics(
            button: true,
            label: 'Apply the change',
            excludeSemantics: true,
            child: FilledButton(
              key: const ValueKey('live-apply'),
              style: FilledButton.styleFrom(
                backgroundColor: CheStudioColors.teal,
                foregroundColor: Colors.black,
                minimumSize: const Size(64, 52),
              ),
              onPressed: busy ? null : () => unawaited(applyEdit(_edit.text)),
              child: const Text('Apply'),
            ),
          ),
        ],
      ),
      const SizedBox(height: 8),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final s in const [
            'Make the hair longer',
            'Change the outfit',
            'Make it photorealistic',
            'Bigger eyes',
            'Make it stylized',
          ])
            ActionChip(
              key: ValueKey('live-chip-$s'),
              label: Text(s),
              onPressed: busy ? null : () => unawaited(applyEdit(s)),
            ),
        ],
      ),
      const SizedBox(height: 14),
      Row(
        children: [
          Expanded(
            child: Text(
              loading
                  ? 'Loading…'
                  : 'Version $v of $n${project['saved_at'] == null ? '' : ' · saved ${_clock('${project['saved_at']}')}'}',
              key: const ValueKey('live-version'),
              style: const TextStyle(color: CheStudioColors.silver, fontSize: 15, fontWeight: FontWeight.w600),
            ),
          ),
          _small('Undo', Icons.undo_rounded, project['can_undo'] == true ? undo : null),
          _small('Redo', Icons.arrow_forward_rounded, project['can_redo'] == true ? redo : null),
          _small('Save', Icons.save_rounded, project.isEmpty ? null : save),
        ],
      ),
      const SizedBox(height: 10),
      Semantics(
        button: true,
        label: j == null ? 'Generate the 3D model' : 'Generate the 3D model again for this version',
        excludeSemantics: true,
        child: FilledButton.icon(
          key: const ValueKey('live-generate'),
          style: FilledButton.styleFrom(
            backgroundColor: CheStudioColors.teal,
            foregroundColor: Colors.black,
            minimumSize: const Size.fromHeight(56),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          ),
          onPressed: busy || project.isEmpty ? null : () => unawaited(generate()),
          icon: const Icon(Icons.view_in_ar_rounded),
          label: Text(jobActive ? 'Model in progress' : 'Generate 3D model'),
        ),
      ),
      const SizedBox(height: 22),
      // ── Progress (the job's own history) ───────────────────────────────────────────
      const _Label('PROGRESS'),
      const SizedBox(height: 8),
      if (j == null)
        const Text(
          'Nothing generated for this version yet.',
          style: TextStyle(color: CheStudioColors.dim, fontSize: 14),
        )
      else ...[
        Text(
          cheJobDisplayState(j),
          key: const ValueKey('live-job-state'),
          style: TextStyle(
            color: switch (cheJobDisplayState(j)) {
              'Completed' => CheStudioColors.teal,
              'Failed' => Colors.redAccent,
              _ => CheStudioColors.text,
            },
            fontSize: 17,
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          '${j['status_line'] ?? progress['message'] ?? jobState}',
          key: const ValueKey('live-progress'),
          style: const TextStyle(color: CheStudioColors.text, fontSize: 15, height: 1.35),
        ),
        if (progress['pct'] is num) ...[
          const SizedBox(height: 8),
          Semantics(
            label: '${progress['pct']} percent of the preview views rendered',
            child: LinearProgressIndicator(
              value: (progress['pct'] as num).toDouble() / 100,
              color: CheStudioColors.teal,
              backgroundColor: CheStudioColors.cardHi,
            ),
          ),
        ],
        const SizedBox(height: 10),
        for (final s in stages)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 76,
                  child: Text(
                    _clock('${s['at']}'),
                    style: const TextStyle(
                      color: CheStudioColors.dim,
                      fontSize: 13,
                      fontFeatures: [FontFeature.tabularFigures()],
                    ),
                  ),
                ),
                Expanded(
                  child: Text(
                    '${s['label']}',
                    style: const TextStyle(color: CheStudioColors.silver, fontSize: 14, height: 1.3),
                  ),
                ),
              ],
            ),
          ),
      ],
      if (previews.isNotEmpty) ...[
        const SizedBox(height: 14),
        const _Label('PREVIEW RENDERS'),
        const SizedBox(height: 8),
        SizedBox(
          height: 170,
          child: ListView(
            scrollDirection: Axis.horizontal,
            children: [
              for (final e in previews.entries)
                Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: Semantics(
                    container: true,
                    image: true,
                    excludeSemantics: true,
                    label: '${_viewNames[e.key] ?? '${e.key} degree'} preview render from the Creation Engine',
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(14),
                      child: Image.network(
                        '${widget.baseUrl}/api/media/${e.value}/image',
                        headers: widget.headers,
                        width: 136,
                        height: 170,
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => Container(
                          width: 136,
                          color: CheStudioColors.card,
                          alignment: Alignment.center,
                          child: const Text(
                            'Picture not loaded',
                            style: TextStyle(color: CheStudioColors.dim, fontSize: 12),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
      if (j?['model'] is Map) ...[
        const SizedBox(height: 14),
        Text(
          '3D model file: ${(((j!['model'] as Map)['bytes'] as num? ?? 0) / 1024).round()} KB GLB, saved on your CHE server.',
          key: const ValueKey('live-model-file'),
          style: const TextStyle(color: CheStudioColors.silver, fontSize: 14),
        ),
      ],
    ];
  }

  Widget _small(String label, IconData icon, Future<String> Function()? onTap) => Semantics(
    button: true,
    enabled: onTap != null,
    label: label,
    excludeSemantics: true,
    child: IconButton(
      key: ValueKey('live-$label'),
      tooltip: label,
      constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
      color: CheStudioColors.text,
      disabledColor: CheStudioColors.dim.withValues(alpha: 0.4),
      onPressed: onTap == null || busy ? null : () => unawaited(onTap()),
      icon: Icon(icon),
    ),
  );
}

class _EngineBar extends StatelessWidget {
  const _EngineBar({required this.engine, required this.onConnect});
  final CheCreationEngine engine;
  final VoidCallback onConnect;

  @override
  Widget build(BuildContext context) {
    final on = engine.ready;
    return Semantics(
      container: true,
      label: '${engine.label}. ${engine.detail}',
      child: Container(
        key: const ValueKey('live-engine'),
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        decoration: BoxDecoration(
          color: CheStudioColors.card,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: on ? CheStudioColors.teal.withValues(alpha: 0.6) : CheStudioColors.stroke),
        ),
        child: Row(
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(shape: BoxShape.circle, color: on ? CheStudioColors.teal : CheStudioColors.dim),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: ExcludeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      engine.label,
                      style: const TextStyle(color: CheStudioColors.text, fontSize: 15.5, fontWeight: FontWeight.w700),
                    ),
                    if (engine.detail.isNotEmpty)
                      Text(
                        engine.detail,
                        style: const TextStyle(color: CheStudioColors.dim, fontSize: 13, height: 1.3),
                      ),
                  ],
                ),
              ),
            ),
            if (!engine.ready && engine.status != 'unknown')
              Semantics(
                container: true,
                button: true,
                label: 'Cloud Computer: open Settings, Connections, Cloud Computer',
                excludeSemantics: true,
                child: TextButton(
                  key: const ValueKey('live-connect'),
                  style: TextButton.styleFrom(foregroundColor: CheStudioColors.teal, minimumSize: const Size(64, 44)),
                  onPressed: onConnect,
                  child: const Text('Cloud Computer', style: TextStyle(fontWeight: FontWeight.w800)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.text, required this.ok});
  final String text;
  final bool ok;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('live-banner'),
    width: double.infinity,
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: ok ? CheStudioColors.tealDeep.withValues(alpha: 0.55) : const Color(0x55B3261E),
      borderRadius: BorderRadius.circular(14),
    ),
    child: Text(
      text,
      style: const TextStyle(color: CheStudioColors.text, fontSize: 18, height: 1.35, fontWeight: FontWeight.w600),
    ),
  );
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Text(
      text,
      style: const TextStyle(
        color: CheStudioColors.dim,
        fontSize: 12.5,
        fontWeight: FontWeight.w800,
        letterSpacing: 1.6,
      ),
    ),
  );
}
