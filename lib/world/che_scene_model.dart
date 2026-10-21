// CHE Spatial World scene (owner, 2026-10-20; server: server/cloudflare/world_scene.js).
// A scene is the Worker's read-only projection of real records. Every object
// names its source record and a provenance label; this model only parses it,
// and the room only draws what is here. The spoken lines come from the same
// scene, so what VoiceOver reads and what the room shows never differ.

class CheSceneObject {
  const CheSceneObject({
    required this.id,
    required this.kind,
    required this.label,
    required this.status,
    required this.zone,
    required this.provenance,
    required this.provenanceSpoken,
    required this.sourceStore,
    required this.sourceId,
    this.text = '',
    this.preview = '',
    this.spoken = '',
    this.author = '',
    this.name = '',
    this.role = '',
    this.detail = '',
  });

  final String id;

  /// avatar, brief, draft, critique, suggestion, decision, conflict, path.
  final String kind;
  final String label;
  final String status;
  final String zone;

  /// che-fact-check label: live, owner_request, model_output, che_synthesis_unverified.
  final String provenance;
  final String provenanceSpoken;
  final String sourceStore;
  final String sourceId;
  final String text;
  final String preview;
  final String spoken;
  final String author;
  final String name;
  final String role;
  final String detail;

  bool get isAvatar => kind == 'avatar';
  bool get isCard => const {'brief', 'draft', 'critique'}.contains(kind);
  bool get isOutcome => const {'suggestion', 'decision', 'conflict'}.contains(kind);
  bool get isPath => kind == 'path';

  static CheSceneObject? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final source = raw['source'];
    final store = source is Map ? '${source['store'] ?? ''}' : '';
    // No record behind it, no object (the server never sends one; the phone checks too).
    if (store.isEmpty) return null;
    String s(String k) => '${raw[k] ?? ''}';
    return CheSceneObject(
      id: s('id'),
      kind: s('kind'),
      label: s('label'),
      status: s('status'),
      zone: s('zone'),
      provenance: s('provenance'),
      provenanceSpoken: s('provenance_spoken'),
      sourceStore: store,
      sourceId: source is Map ? '${source['id'] ?? ''}' : '',
      text: s('text'),
      preview: s('preview'),
      spoken: s('spoken'),
      author: s('author'),
      name: s('name'),
      role: s('role'),
      detail: s('detail'),
    );
  }
}

class CheScene {
  const CheScene({
    required this.id,
    required this.title,
    required this.objective,
    required this.stage,
    required this.progress,
    required this.spoken,
    required this.version,
    required this.objects,
  });

  final String id;
  final String title;
  final String objective;

  /// gathering, drafting, cross_check, synthesizing, complete, failed.
  final String stage;
  final double progress;
  final String spoken;
  final String version;
  final List<CheSceneObject> objects;

  bool get finished => stage == 'complete' || stage == 'failed';
  List<CheSceneObject> get avatars => [for (final o in objects) if (o.isAvatar) o];
  List<CheSceneObject> get cards => [for (final o in objects) if (o.isCard) o];
  List<CheSceneObject> get outcomes => [for (final o in objects) if (o.isOutcome) o];
  List<CheSceneObject> get suggestions => [for (final o in objects) if (o.kind == 'suggestion') o];
  CheSceneObject? get path => objects.where((o) => o.isPath).firstOrNull;

  /// What can be inspected, in the order it is read: the path first, then
  /// suggestions, decisions, conflicts, and the cards as they were posted.
  List<CheSceneObject> get readingOrder => [?path, ...outcomes, ...cards];

  static CheScene? fromJson(Map<String, dynamic>? j) {
    if (j == null || '${j['id'] ?? ''}'.isEmpty) return null;
    return CheScene(
      id: '${j['id']}',
      title: '${j['title'] ?? ''}',
      objective: '${j['objective'] ?? ''}',
      stage: '${j['stage'] ?? 'drafting'}',
      progress: (j['progress'] as num?)?.toDouble() ?? 0,
      spoken: '${j['spoken'] ?? ''}',
      version: '${j['version'] ?? ''}',
      objects: [
        for (final raw in (j['objects'] as List? ?? const [])) ?CheSceneObject.fromJson(raw),
      ],
    );
  }
}

/// Voice inside the Meeting Room: "read the suggestions", "read suggestion 2",
/// "what's the recommendation", "who's at the table", "what's happening".
/// Returns the spoken answer from the scene, or null when it is not one of these.
String? cheMeetingRoomAnswer(CheScene scene, String raw) {
  final t = raw.trim().toLowerCase().replaceAll('’', "'").replaceAll(RegExp(r'[.?!]+$'), '')
      .replaceFirst(RegExp(r'^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?(?:please\s+)?'), '').trim();
  const numbers = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'first': 1, 'second': 2, 'third': 3};
  final one = RegExp(r"^(?:read|open|show|what(?:'s| is))(?: me)? (?:the )?(?:suggestion|recommendation) (?:number )?(\w+)$").firstMatch(t);
  if (one != null) {
    final n = int.tryParse(one.group(1)!) ?? numbers[one.group(1)!];
    final list = scene.suggestions;
    if (n == null || n < 1 || n > list.length) {
      return list.isEmpty ? 'There are no suggestions yet, sir.' : 'There ${list.length == 1 ? 'is one suggestion' : 'are ${list.length} suggestions'}, sir.';
    }
    return '${list[n - 1].spoken} That is ${list[n - 1].provenanceSpoken}.';
  }
  if (RegExp(r"^(?:read|list|what are)(?: me)? (?:the |all )?(?:suggestions|recommendations|ideas)$").hasMatch(t)) {
    final list = scene.suggestions;
    if (list.isEmpty) return scene.finished ? 'The meeting made no suggestions, sir.' : 'No suggestions yet, sir: the team is still working.';
    return 'Suggestions, sir, CHE\'s synthesis, not verified: ${[for (final (i, s) in list.indexed) '${i + 1}. ${s.text}'].join(' ')}';
  }
  if (RegExp(r"^(?:what(?:'s| is) (?:the )?(?:recommendation|recommended path|plan|way forward)|read (?:me )?(?:the )?(?:plan|recommended path|recommendation))$").hasMatch(t)) {
    final path = scene.path;
    return path == null ? 'There is no recommended path yet, sir. ${scene.spoken}' : '${path.spoken} That is ${path.provenanceSpoken}.';
  }
  if (RegExp(r"^(?:who(?:'s| is) (?:at the table|in the meeting|here)|who is meeting)$").hasMatch(t)) {
    return [for (final a in scene.avatars) a.spoken].join(' ');
  }
  if (RegExp(r"^(?:what(?:'s| is) happening|where are we|read the (?:room|scene|meeting)|what(?:'s| is) the status)$").hasMatch(t)) {
    return scene.spoken;
  }
  return null;
}
