// Create → Active Projects (owner, 2026-10-24): the project manager over GET /api/projects/library
// (server/cloudflare/project_library.js). Creative work and AI, code and research are separate lists. Each list is
// filtered Active, Paused, Completed or Archived. Every card shows its real status, last activity, output and next
// action, plus the controls that apply to it: Open, Continue, Preview, Pause, Resume, Stop, Complete, Archive, Restore,
// Place file (Roblox) and Delete, which asks first.
//
// Each control calls the Worker route that owns it and reports the Worker's own answer aloud as its receipt:
// - project state: POST /api/projects/state;
// - creation jobs: POST /api/gpu/jobs/{pause,resume,cancel,retry};
// - Roblox crew: POST /api/projects/continue;
// - delete: POST /api/project/delete.
// Nothing is spoken on open. Leaving the page cancels nothing; jobs run on the Worker.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'che_creative_studio.dart' show CheStudioColors;

const cheProjectStates = ['active', 'paused', 'completed', 'archived'];
const _stateLabel = {'active': 'Active', 'paused': 'Paused', 'completed': 'Completed', 'archived': 'Archived'};

class CheProjectManager extends StatefulWidget {
  const CheProjectManager({
    super.key,
    required this.baseUrl,
    required this.headers,
    this.onOpenProject,
    this.onOpenCreation,
    this.onSpeak,
    this.client,
    this.saveFile,
  });

  final String baseUrl;
  final Map<String, String> Function() headers;

  /// Opens a stored project (the card's lead id) in the project editor.
  final Future<void> Function(String id)? onOpenProject;

  /// Opens a 3D creation in the Live Studio viewport.
  final void Function(String id)? onOpenCreation;
  final void Function(String text)? onSpeak;
  final http.Client? client;

  /// Saves a downloaded file; returns where it went. Defaults to the app's Documents folder (Files app → CHE).
  final Future<String> Function(String name, List<int> bytes)? saveFile;

  /// While open: "read", "show paused", "show research", "open 2", "pause 1", "delete 3" then "yes, delete".
  static Future<String?> Function(String words)? voiceHandler;

  static Route<void> route({
    required String baseUrl,
    required Map<String, String> Function() headers,
    Future<void> Function(String id)? onOpenProject,
    void Function(String id)? onOpenCreation,
    void Function(String text)? onSpeak,
  }) => MaterialPageRoute<void>(
    builder: (_) => CheProjectManager(
      baseUrl: baseUrl,
      headers: headers,
      onOpenProject: onOpenProject,
      onOpenCreation: onOpenCreation,
      onSpeak: onSpeak,
    ),
  );

  @override
  State<CheProjectManager> createState() => CheProjectManagerState();
}

class CheProjectManagerState extends State<CheProjectManager> {
  Map<String, dynamic> _lib = const {};
  bool _creative = true;
  String _state = 'active';
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _pendingDelete;

  http.Client get _http => widget.client ?? http.Client();

  @override
  void initState() {
    super.initState();
    CheProjectManager.voiceHandler = voice;
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) unawaited(load()); });
  }

  @override
  void dispose() {
    if (CheProjectManager.voiceHandler == voice) CheProjectManager.voiceHandler = null;
    super.dispose();
  }

  List<Map<String, dynamic>> get allCards => [
    for (final c in (_lib['cards'] as List? ?? const []))
      if (c is Map) Map<String, dynamic>.from(c),
  ];

  /// The cards on screen, in the order Read aloud numbers them.
  List<Map<String, dynamic>> get cards => [
    for (final c in allCards)
      if ((c['creative'] != false) == _creative && c['state'] == _state) c,
  ];

  int count(bool creative, String state) =>
      ((_lib['counts'] as Map?)?[creative ? 'creative' : 'ai_code_research'] as Map?)?[state] as int? ?? 0;

  Future<void> load() async {
    setState(() => _loading = true);
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl}/api/projects/library'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final d = jsonDecode(r.body);
      if (r.statusCode != 200 || d is! Map) throw StateError(d is Map ? '${d['detail'] ?? r.statusCode}' : 'HTTP ${r.statusCode}');
      if (mounted) setState(() { _lib = Map<String, dynamic>.from(d); _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not load projects: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, Object?> body) async {
    final r = await _http
        .post(Uri.parse('${widget.baseUrl}$path'), headers: {...widget.headers(), 'Content-Type': 'application/json'}, body: jsonEncode(body))
        .timeout(const Duration(seconds: 25));
    final d = jsonDecode(r.body);
    final out = d is Map ? Map<String, dynamic>.from(d) : <String, dynamic>{};
    out['_status'] = r.statusCode;
    return out;
  }

  String _title(Map<String, dynamic> c) => '${c['title'] ?? 'that project'}';

  /// Sets a project card's state (all its copies). Creation cards pause and resume their job instead.
  Future<String> setProjectState(Map<String, dynamic> c, String state) async {
    if (c['source'] == 'creation') {
      final job = '${c['job_id'] ?? ''}';
      if (job.isEmpty) return '${_title(c)} has no Creation Engine job to ${state == 'paused' ? 'pause' : 'resume'}.';
      if (state != 'paused' && state != 'active') return 'A 3D creation is completed by its job; it cannot be marked by hand.';
      return jobControl(c, state == 'paused' ? 'pause' : 'resume');
    }
    try {
      final d = await _post('/api/projects/state', {'ids': c['ids'], 'state': state});
      unawaited(load());
      return '${d['spoken'] ?? d['detail'] ?? 'CHE did not answer.'}';
    } catch (e) {
      return 'Could not reach CHE, so ${_title(c)} was not changed: $e.';
    }
  }

  /// Pause, resume, stop or retry a creation's Creation Engine job (gpu_queue.js control).
  Future<String> jobControl(Map<String, dynamic> c, String action) async {
    final job = '${c['job_id'] ?? ''}';
    if (job.isEmpty) return '${_title(c)} has no Creation Engine job.';
    try {
      final d = await _post('/api/gpu/jobs/$action', {'id': job});
      unawaited(load());
      if (d['ok'] != true) return '${d['detail'] ?? 'The Creation Engine refused it.'}';
      final j = d['job'] is Map ? d['job'] as Map : const {};
      final word = {'pause': 'Paused', 'resume': 'Resumed', 'cancel': 'Stopped', 'retry': 'Queued again'}[action];
      return '$word ${_title(c)}. The job is now ${j['state'] ?? 'updated'}${action == 'cancel' ? '; its worker is told to stop at its next check-in' : ''}.';
    } catch (e) {
      return 'Could not reach CHE, so nothing changed: $e.';
    }
  }

  Future<String> continueCard(Map<String, dynamic> c) async {
    if (c['category'] != 'roblox') {
      await open(c);
      return 'Opened ${_title(c)}. Tell CHE what to do next.';
    }
    try {
      final d = await _post('/api/projects/continue', {'id': c['id']});
      unawaited(load());
      return '${d['spoken'] ?? d['detail'] ?? 'CHE did not answer.'}';
    } catch (e) {
      return 'Could not reach CHE, so nothing was queued: $e.';
    }
  }

  Future<void> open(Map<String, dynamic> c) async {
    HapticFeedback.selectionClick();
    if (c['source'] == 'creation') {
      widget.onOpenCreation?.call('${c['id']}');
    } else {
      await widget.onOpenProject?.call('${c['id']}');
    }
  }

  /// Downloads the Roblox place file built from the project's real scripts and saves it to Files → CHE.
  Future<String> placeFile(Map<String, dynamic> c) async {
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl}/api/projects/roblox/place.rbxlx?id=${Uri.encodeQueryComponent('${c['id']}')}'), headers: widget.headers()).timeout(const Duration(seconds: 30));
      if (r.statusCode != 200) {
        final d = jsonDecode(r.body);
        return '${d is Map ? d['detail'] : 'No place file: HTTP ${r.statusCode}.'}';
      }
      final name = '${_title(c).replaceAll(RegExp(r'[^A-Za-z0-9]+'), '-')}.rbxlx';
      final where = await (widget.saveFile ?? _saveToDocuments)(name, r.bodyBytes);
      return 'Saved $name to $where. It holds the crew\'s scripts; open it in Roblox Studio on a computer with File, Open from File. It has not been playtested.';
    } catch (e) {
      return 'The place file was not saved: $e.';
    }
  }

  static Future<String> _saveToDocuments(String name, List<int> bytes) async {
    final dir = Directory('${(await getApplicationDocumentsDirectory()).path}/Roblox');
    await dir.create(recursive: true);
    await File('${dir.path}/$name').writeAsBytes(bytes);
    return 'Files, On My iPhone, CHE, Roblox';
  }

  /// Delete asks first (AGENTS.md); this only arms the confirmation.
  String askDelete(Map<String, dynamic> c) {
    if (c['source'] == 'creation') return 'Deleting a 3D creation is not available here; you can archive it instead.';
    setState(() => _pendingDelete = c);
    final n = (c['ids'] as List?)?.length ?? 1;
    return 'Delete ${_title(c)}${n > 1 ? ' and its $n stored copies' : ''}? This cannot be undone. Say yes, delete, or say cancel. Archive keeps it instead.';
  }

  Future<String> confirmDelete() async {
    final c = _pendingDelete;
    if (c == null) return 'Nothing is waiting to be deleted.';
    setState(() => _pendingDelete = null);
    var gone = 0;
    String? failed;
    for (final id in (c['ids'] as List? ?? const [])) {
      try {
        final d = await _post('/api/project/delete', {'id': id});
        if (d['ok'] == true) {
          gone++;
        } else {
          failed = '${d['detail'] ?? d['_status']}';
        }
      } catch (e) {
        failed = '$e';
      }
    }
    unawaited(load());
    return failed == null ? 'Deleted ${_title(c)} ($gone stored cop${gone == 1 ? 'y' : 'ies'}).' : 'Deleted $gone; one was not deleted: $failed.';
  }

  String get spokenSummary {
    final list = cards;
    final where = '${_creative ? 'Creative projects' : 'AI, code and research'}, ${_stateLabel[_state]}';
    if (list.isEmpty) return '$where: none. ${'${_lib['spoken'] ?? ''}'}';
    return '$where: ${[for (var i = 0; i < list.length && i < 10; i++) '${i + 1}. ${list[i]['title']}, ${list[i]['output']?['line'] ?? ''}. Next: ${list[i]['next_action']}'].join(' ')}';
  }

  Future<String?> voice(String words) async {
    if (!mounted || !(ModalRoute.of(context)?.isCurrent ?? true)) return null;
    final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '').replaceFirst(RegExp(r'^(?:che|chey|chay)[,:]?\s+'), '');
    if (_pendingDelete != null) {
      if (RegExp(r'^(?:yes,? )?(?:delete(?: it)?|confirm(?: delete)?)$').hasMatch(t)) return confirmDelete();
      if (RegExp(r'^(?:no|cancel|keep it|never mind)$').hasMatch(t)) {
        setState(() => _pendingDelete = null);
        return 'Not deleted.';
      }
    }
    if (RegExp(r"^(?:read(?: aloud| it| this| the screen)?|what(?:'s| is) on (?:the |this )?screen)$").hasMatch(t)) return spokenSummary;
    final show = RegExp(r'^(?:show|open)(?: (?:the|my))? (active|paused|completed|archived|creative|research|ai|code)(?: projects)?$').firstMatch(t);
    if (show != null) {
      final w = show.group(1)!;
      setState(() {
        if (cheProjectStates.contains(w)) {
          _state = w;
        } else {
          _creative = w == 'creative';
        }
      });
      return spokenSummary;
    }
    final m = RegExp(r'^(open|continue|preview|pause|resume|stop|retry|complete|finish|archive|restore|delete|place file for|get the place file for) (?:project |number )?(\d{1,2})$').firstMatch(t);
    if (m == null) return null;
    final n = int.parse(m.group(2)!);
    final list = cards;
    if (n < 1 || n > list.length) return 'There is no project $n here.';
    final c = list[n - 1];
    switch (m.group(1)) {
      case 'open' || 'preview':
        await open(c);
        return 'Opening ${_title(c)}.';
      case 'continue':
        return continueCard(c);
      case 'pause':
        return setProjectState(c, 'paused');
      case 'resume' || 'restore':
        return setProjectState(c, 'active');
      case 'complete' || 'finish':
        return setProjectState(c, 'completed');
      case 'archive':
        return setProjectState(c, 'archived');
      case 'stop':
        return c['source'] == 'creation' ? jobControl(c, 'cancel') : setProjectState(c, 'paused');
      case 'retry':
        return jobControl(c, 'retry');
      case 'delete':
        return askDelete(c);
      default:
        return placeFile(c);
    }
  }

  void _report(String text) {
    widget.onSpeak?.call(text);
    HapticFeedback.mediumImpact();
    if (mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text, style: const TextStyle(fontSize: 16)), duration: const Duration(seconds: 6)));
  }

  Future<void> _confirmDeleteDialog(Map<String, dynamic> c) async {
    final ask = askDelete(c);
    if (_pendingDelete == null) {
      _report(ask);
      return;
    }
    final yes = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Delete project?'),
        content: Text(ask),
        actions: [
          TextButton(key: const ValueKey('pm-delete-cancel'), onPressed: () => Navigator.of(d).pop(false), child: const Text('Cancel')),
          FilledButton(key: const ValueKey('pm-delete-yes'), onPressed: () => Navigator.of(d).pop(true), child: const Text('Delete')),
        ],
      ),
    );
    if (yes == true) {
      _report(await confirmDelete());
    } else {
      setState(() => _pendingDelete = null);
      _report('Not deleted.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = cards;
    return Scaffold(
      backgroundColor: CheStudioColors.bg,
      appBar: AppBar(
        backgroundColor: CheStudioColors.bg,
        foregroundColor: CheStudioColors.text,
        title: Semantics(header: true, child: const Text('Projects')),
        actions: [
          IconButton(key: const ValueKey('pm-read'), tooltip: 'Read these projects aloud', onPressed: () => widget.onSpeak?.call(spokenSummary), icon: const Icon(Icons.volume_up_rounded)),
          IconButton(key: const ValueKey('pm-refresh'), tooltip: 'Refresh projects', onPressed: load, icon: const Icon(Icons.refresh_rounded)),
        ],
      ),
      body: ListView(
        key: const ValueKey('project-manager'),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
        children: [
          SegmentedButton<bool>(
            key: const ValueKey('pm-list'),
            segments: const [
              ButtonSegment(value: true, label: Text('Creative'), icon: Icon(Icons.palette_outlined)),
              ButtonSegment(value: false, label: Text('AI, code & research'), icon: Icon(Icons.science_outlined)),
            ],
            selected: {_creative},
            onSelectionChanged: (s) => setState(() => _creative = s.first),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final s in cheProjectStates)
                ChoiceChip(
                  key: ValueKey('pm-state-$s'),
                  label: Text('${_stateLabel[s]} (${count(_creative, s)})'),
                  selected: _state == s,
                  onSelected: (_) => setState(() => _state = s),
                ),
            ],
          ),
          const SizedBox(height: 12),
          if (_loading && allCards.isEmpty) const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
          if (_error != null) Text(_error!, style: const TextStyle(color: Colors.orangeAccent, fontSize: 15)),
          if (!_loading && _error == null && list.isEmpty)
            Text('No ${_stateLabel[_state]!.toLowerCase()} ${_creative ? 'creative projects' : 'AI, code or research projects'}.', style: const TextStyle(color: CheStudioColors.dim, fontSize: 15)),
          for (var i = 0; i < list.length; i++) _card(i + 1, list[i]),
        ],
      ),
    );
  }

  Widget _card(int n, Map<String, dynamic> c) {
    final creation = c['source'] == 'creation';
    final roblox = c['category'] == 'roblox';
    final state = '${c['state']}';
    final copies = c['copies'] is int ? c['copies'] as int : 1;
    final last = '${c['last_activity'] ?? ''}';
    final out = '${(c['output'] as Map?)?['line'] ?? ''}';
    final hasModel = (c['output'] as Map?)?['model_url'] != null;
    final buttons = <(String, IconData, Future<String> Function())>[
      ('Open', Icons.open_in_new_rounded, () async { await open(c); return 'Opening ${_title(c)}.'; }),
      if (state == 'active' && !creation) ('Continue', Icons.play_arrow_rounded, () => continueCard(c)),
      if (creation && hasModel) ('Preview', Icons.view_in_ar_rounded, () async { await open(c); return 'Opening ${_title(c)} in the 3D viewport.'; }),
      if (state == 'active') ('Pause', Icons.pause_rounded, () => setProjectState(c, 'paused')),
      if (state == 'paused') ('Resume', Icons.play_circle_outline_rounded, () => setProjectState(c, 'active')),
      if (creation && c['job_id'] != null && const {'queued', 'rendering', 'paused'}.contains(c['status'])) ('Stop', Icons.stop_circle_outlined, () => jobControl(c, 'cancel')),
      if (creation && const {'failed', 'cancelled'}.contains(c['status'])) ('Retry', Icons.replay_rounded, () => jobControl(c, 'retry')),
      if (!creation && state != 'completed' && state != 'archived') ('Complete', Icons.check_circle_outline_rounded, () => setProjectState(c, 'completed')),
      if (state != 'archived') ('Archive', Icons.inventory_2_outlined, () => setProjectState(c, 'archived')),
      if (state == 'archived') ('Restore', Icons.inventory_2_rounded, () => setProjectState(c, 'active')),
      if (roblox && ((c['output'] as Map?)?['luau'] ?? 0) > 0) ('Place file', Icons.save_outlined, () => placeFile(c)),
    ];
    return Semantics(
      container: true,
      label: '$n. ${c['title']}. ${c['category_label']}, ${c['state_label']}.${copies > 1 ? ' $copies stored copies shown once.' : ''} Output: $out. Next: ${c['next_action']}',
      child: Card(
        key: ValueKey('pm-card-${c['id']}'),
        color: CheStudioColors.card,
        margin: const EdgeInsets.only(bottom: 10),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('$n. ${c['title']}', style: const TextStyle(color: CheStudioColors.text, fontSize: 17, fontWeight: FontWeight.w800)),
              if ('${c['request'] ?? ''}'.isNotEmpty)
                Text('${c['request']}', style: const TextStyle(color: CheStudioColors.silver, fontSize: 14)),
              const SizedBox(height: 4),
              Text(
                '${c['category_label']} · ${c['state_label']} · ${c['status']}'
                '${last.length >= 16 ? ' · ${last.substring(0, 16).replaceFirst('T', ' ')} UTC' : ''}'
                '${copies > 1 ? ' · $copies copies kept' : ''}',
                style: const TextStyle(color: CheStudioColors.dim, fontSize: 13),
              ),
              const SizedBox(height: 4),
              Text('Output: $out', style: const TextStyle(color: CheStudioColors.text, fontSize: 14)),
              Text('Next: ${c['next_action']}', style: const TextStyle(color: CheStudioColors.teal, fontSize: 14)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 4,
                runSpacing: 0,
                children: [
                  for (final b in buttons)
                    TextButton.icon(
                      key: ValueKey('pm-${b.$1.toLowerCase().replaceAll(' ', '-')}-${c['id']}'),
                      onPressed: () async => _report(await b.$3()),
                      icon: Icon(b.$2, size: 20),
                      label: Text(b.$1),
                    ),
                  if (!creation)
                    TextButton.icon(
                      key: ValueKey('pm-delete-${c['id']}'),
                      onPressed: () => _confirmDeleteDialog(c),
                      icon: const Icon(Icons.delete_outline_rounded, size: 20),
                      label: const Text('Delete'),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
