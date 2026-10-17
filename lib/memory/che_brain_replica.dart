// CHE's Brain on the phone: a replica of the one logical Brain the Worker
// keeps (server/cloudflare/brain_store.js), with the same record ids, regions,
// revisions and relationships, so CHE can recall, search and learn offline and
// reconcile with the cloud when the connection is back.
//
// Pure Dart on purpose: a Shorebird patch cannot add a native plugin, so the
// replica is an append-only journal plus a snapshot under the app's Documents
// folder (iOS Data Protection encrypts that folder at rest). Every local write
// goes to the journal before it is acknowledged; the outbox of unsynced
// operations is cleared only when the Worker has answered for each one; a
// failed sync leaves everything where it was. Nothing is discarded silently:
// a record the Worker rejects or holds as a conflict stays here, marked.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

/// 32-bit FNV-1a over UTF-16 code units, the same number the Worker computes.
int cheFnv1a32(String text) {
  var hash = 0x811c9dc5;
  for (final unit in text.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0xffffffff;
  }
  return hash;
}

/// The sixteen folder regions, in the Worker's order.
const List<String> cheBrainRegions = [
  'Conversations and Corrections',
  'Personal Memory',
  'Learned Knowledge',
  'Coding and Development',
  'Trading and Market Research',
  'YouTube and Media',
  'Business and Finance',
  'REA Investigations',
  'Office Agents',
  'Skills and Tools',
  'Experiments and Lessons',
  'CHE Self-Knowledge',
  'Problems and Opportunities',
  'Projects and Proposals',
  'Daily Audits and Conclusions',
  'Active and Historical Tasks',
];

const List<String> cheBrainRelationshipTypes = [
  'learned_from', 'related_to', 'builds_upon', 'verified_by', 'contradicts', 'corrected_by',
  'produced_by_agent', 'implemented_in_code', 'result_of_experiment', 'superseded_by', 'relevant_to',
  'solves', 'tests', 'inspired_by', 'requires_verification', 'escalated_to', 'used_by_project',
  'discovered_by_audit',
];

const int _excerptChars = 600;
const int _bodyFileThreshold = 2000;
const int _compactAfterLines = 2000;

class CheBrainRecord {
  CheBrainRecord({
    required this.id,
    required this.kind,
    required this.region,
    required this.path,
    required this.title,
    required this.excerpt,
    required this.bodyChars,
    required this.source,
    required this.verification,
    required this.significance,
    required this.links,
    required this.rev,
    required this.createdAt,
    required this.updatedAt,
    required this.origin,
    required this.deleted,
    required this.seq,
    required this.pending,
    this.syncNote = '',
  });

  final String id;
  final String kind;
  final String region;
  final String path;
  final String title;
  /// The first part of the body; long bodies live in their own file and are read on demand.
  final String excerpt;
  final int bodyChars;
  final Map<String, dynamic> source;
  final String verification;
  final Map<String, dynamic> significance;
  final List<Map<String, dynamic>> links;
  /// The Worker's revision this copy is based on; 0 while the record has never reached the cloud.
  final int rev;
  final String createdAt;
  final String updatedAt;
  final String origin;
  final bool deleted;
  final int seq;
  /// True while a local change to this record waits in the outbox.
  final bool pending;
  /// Why the Worker refused or held the last push of this record, if it did.
  final String syncNote;

  bool get inlineBody => bodyChars <= _bodyFileThreshold;

  CheBrainRecord copyWith({
    String? title, String? excerpt, int? bodyChars, Map<String, dynamic>? source, String? verification,
    Map<String, dynamic>? significance, List<Map<String, dynamic>>? links, int? rev, String? updatedAt,
    String? origin, bool? deleted, int? seq, bool? pending, String? syncNote, String? region, String? path, String? kind,
  }) => CheBrainRecord(
        id: id, kind: kind ?? this.kind, region: region ?? this.region, path: path ?? this.path,
        title: title ?? this.title, excerpt: excerpt ?? this.excerpt, bodyChars: bodyChars ?? this.bodyChars,
        source: source ?? this.source, verification: verification ?? this.verification,
        significance: significance ?? this.significance, links: links ?? this.links, rev: rev ?? this.rev,
        createdAt: createdAt, updatedAt: updatedAt ?? this.updatedAt, origin: origin ?? this.origin,
        deleted: deleted ?? this.deleted, seq: seq ?? this.seq, pending: pending ?? this.pending,
        syncNote: syncNote ?? this.syncNote,
      );

  Map<String, dynamic> toJson() => {
        'id': id, 'kind': kind, 'region': region, 'path': path, 'title': title, 'excerpt': excerpt,
        'body_chars': bodyChars, 'source': source, 'verification': verification, 'significance': significance,
        'links': links, 'rev': rev, 'created_at': createdAt, 'updated_at': updatedAt, 'origin': origin,
        'deleted': deleted, 'seq': seq, 'pending': pending, if (syncNote.isNotEmpty) 'sync_note': syncNote,
      };

  static CheBrainRecord? fromJson(Map<String, dynamic> json, {bool pending = false}) {
    final id = '${json['id'] ?? ''}'.trim();
    if (id.isEmpty) return null;
    final body = json.containsKey('body') ? '${json['body'] ?? ''}' : null;
    final excerpt = body != null ? _excerpt(body) : '${json['excerpt'] ?? ''}';
    return CheBrainRecord(
      id: id,
      kind: '${json['kind'] ?? 'note'}',
      region: cheBrainRegions.contains(json['region']) ? '${json['region']}' : cheBrainRegions[2],
      path: '${json['path'] ?? ''}',
      title: '${json['title'] ?? ''}',
      excerpt: excerpt,
      bodyChars: body?.length ?? (json['body_chars'] is int ? json['body_chars'] as int : excerpt.length),
      source: json['source'] is Map ? Map<String, dynamic>.from(json['source'] as Map) : <String, dynamic>{},
      verification: '${json['verification'] ?? 'unknown'}',
      significance: json['significance'] is Map ? Map<String, dynamic>.from(json['significance'] as Map) : <String, dynamic>{},
      links: json['links'] is List
          ? (json['links'] as List).whereType<Map>().map((l) => Map<String, dynamic>.from(l)).toList()
          : const [],
      rev: (json['rev'] is num) ? (json['rev'] as num).toInt() : 0,
      createdAt: '${json['created_at'] ?? ''}',
      updatedAt: '${json['updated_at'] ?? ''}',
      origin: '${json['origin'] ?? ''}',
      deleted: json['deleted'] == true,
      seq: (json['seq'] is num) ? (json['seq'] as num).toInt() : 0,
      pending: json['pending'] == true || pending,
      syncNote: '${json['sync_note'] ?? ''}',
    );
  }

  static String _excerpt(String body) =>
      body.length <= _excerptChars ? body : body.substring(0, _excerptChars);
}

class CheBrainConflict {
  CheBrainConflict({required this.id, required this.recordId, required this.local, required this.server, required this.at});
  final String id;
  final String recordId;
  final Map<String, dynamic> local;
  final Map<String, dynamic> server;
  final String at;
  Map<String, dynamic> toJson() => {'id': id, 'record_id': recordId, 'local': local, 'server': server, 'at': at};
}

/// What one synchronization really did. Every number is a count of real operations.
class CheBrainSyncReceipt {
  CheBrainSyncReceipt({
    required this.at,
    this.pushed = 0,
    this.acknowledged = 0,
    this.conflicts = 0,
    this.rejected = 0,
    this.pulled = 0,
    this.since = 0,
    this.pendingAfter = 0,
    this.digestChecked = false,
    this.digestMatch = false,
    this.serverCount,
    this.localCount = 0,
    this.error = '',
  });
  final String at;
  final int pushed;
  final int acknowledged;
  final int conflicts;
  final int rejected;
  final int pulled;
  final int since;
  final int pendingAfter;
  final bool digestChecked;
  final bool digestMatch;
  final int? serverCount;
  final int localCount;
  final String error;
  bool get ok => error.isEmpty;

  Map<String, dynamic> toJson() => {
        'at': at, 'pushed': pushed, 'acknowledged': acknowledged, 'conflicts': conflicts, 'rejected': rejected,
        'pulled': pulled, 'since': since, 'pending_after': pendingAfter, 'digest_checked': digestChecked,
        'digest_match': digestMatch, 'server_count': serverCount, 'local_count': localCount, 'error': error,
      };

  /// Spoken, so a blind owner hears exactly what happened.
  String speech() {
    if (!ok) return 'The Brain could not sync: $error. Nothing was lost; ${pendingAfter == 1 ? 'one change is' : '$pendingAfter changes are'} still waiting.';
    final parts = <String>[];
    if (pushed > 0) parts.add('sent $pushed change${pushed == 1 ? '' : 's'}');
    if (pulled > 0) parts.add('received $pulled');
    if (conflicts > 0) parts.add('$conflicts conflict${conflicts == 1 ? '' : 's'} kept for you to settle');
    if (rejected > 0) parts.add('$rejected refused as sensitive');
    final summary = parts.isEmpty ? 'nothing to exchange' : parts.join(', ');
    final check = digestChecked ? (digestMatch ? ' Both copies match.' : ' The copies do not match yet; the next sync will keep going.') : '';
    return 'Brain sync: $summary.$check';
  }
}

/// HTTP as two functions, so tests run without a network.
typedef CheBrainGet = Future<({int status, String body})> Function(Uri uri, Map<String, String> headers);
typedef CheBrainPost = Future<({int status, String body})> Function(Uri uri, Map<String, String> headers, String body);

class CheBrainReplica {
  CheBrainReplica({Directory? directory, String? deviceName})
      : _directoryOverride = directory,
        deviceName = deviceName ?? 'iphone';

  final Directory? _directoryOverride;
  final String deviceName;

  final Map<String, CheBrainRecord> _records = {};
  final Map<String, Uint32List> _tokens = {};
  final Map<String, int> _intern = {};
  final List<Map<String, dynamic>> _outbox = [];
  final List<CheBrainConflict> _conflicts = [];
  int _since = 0;
  int _journalLines = 0;
  bool _loaded = false;
  Directory? _dir;
  CheBrainSyncReceipt? lastReceipt;

  // ── Storage ────────────────────────────────────────────────────────────────

  Future<Directory> _directory() async {
    if (_dir != null) return _dir!;
    final base = _directoryOverride ?? Directory('${(await getApplicationDocumentsDirectory()).path}/che_brain_replica');
    if (!await base.exists()) await base.create(recursive: true);
    _dir = base;
    return base;
  }

  Future<File> _file(String name) async => File('${(await _directory()).path}/$name');

  Future<File> _bodyFile(String id) async {
    final dir = Directory('${(await _directory()).path}/bodies');
    if (!await dir.exists()) await dir.create(recursive: true);
    return File('${dir.path}/${cheFnv1a32(id).toRadixString(16)}_${id.hashCode.toRadixString(16)}.txt');
  }

  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final snapshot = await _file('snapshot.ndjson');
      if (await snapshot.exists()) {
        for (final line in const LineSplitter().convert(await snapshot.readAsString())) {
          _replay(line);
        }
      }
      final journal = await _file('journal.ndjson');
      if (await journal.exists()) {
        final lines = const LineSplitter().convert(await journal.readAsString());
        _journalLines = lines.length;
        for (final line in lines) {
          _replay(line);
        }
      }
    } catch (_) {
      // A damaged line is skipped; everything readable stays.
    }
  }

  void _replay(String line) {
    if (line.trim().isEmpty) return;
    Map<String, dynamic> entry;
    try {
      final decoded = jsonDecode(line);
      if (decoded is! Map) return;
      entry = Map<String, dynamic>.from(decoded);
    } catch (_) {
      return;
    }
    switch ('${entry['t']}') {
      case 'rec':
        final record = CheBrainRecord.fromJson(Map<String, dynamic>.from(entry['r'] as Map));
        if (record != null) _index(record);
        break;
      case 'op':
        _outbox.add(Map<String, dynamic>.from(entry['o'] as Map));
        break;
      case 'ack':
        _outbox.removeWhere((op) => op['op_id'] == entry['op_id']);
        break;
      case 'conflict':
        final c = Map<String, dynamic>.from(entry['c'] as Map);
        _conflicts.add(CheBrainConflict(
          id: '${c['id']}', recordId: '${c['record_id']}',
          local: Map<String, dynamic>.from(c['local'] as Map), server: Map<String, dynamic>.from(c['server'] as Map), at: '${c['at']}',
        ));
        break;
      case 'resolved':
        _conflicts.removeWhere((c) => c.id == entry['id']);
        break;
      case 'meta':
        if (entry['since'] is num) _since = (entry['since'] as num).toInt();
        if (entry['receipt'] is Map) lastReceipt = _receiptFromJson(Map<String, dynamic>.from(entry['receipt'] as Map));
        break;
    }
  }

  CheBrainSyncReceipt _receiptFromJson(Map<String, dynamic> j) => CheBrainSyncReceipt(
        at: '${j['at'] ?? ''}', pushed: (j['pushed'] as num?)?.toInt() ?? 0, acknowledged: (j['acknowledged'] as num?)?.toInt() ?? 0,
        conflicts: (j['conflicts'] as num?)?.toInt() ?? 0, rejected: (j['rejected'] as num?)?.toInt() ?? 0,
        pulled: (j['pulled'] as num?)?.toInt() ?? 0, since: (j['since'] as num?)?.toInt() ?? 0,
        pendingAfter: (j['pending_after'] as num?)?.toInt() ?? 0, digestChecked: j['digest_checked'] == true,
        digestMatch: j['digest_match'] == true, serverCount: (j['server_count'] as num?)?.toInt(),
        localCount: (j['local_count'] as num?)?.toInt() ?? 0, error: '${j['error'] ?? ''}',
      );

  Future<void> _append(Map<String, dynamic> entry) => _appendMany([entry]);

  /// One flushed write for a batch of journal entries: a sync page costs one disk write, not one per record.
  Future<void> _appendMany(List<Map<String, dynamic>> entries) async {
    if (entries.isEmpty) return;
    final journal = await _file('journal.ndjson');
    await journal.writeAsString(entries.map(jsonEncode).map((l) => '$l\n').join(), mode: FileMode.append, flush: true);
    _journalLines += entries.length;
    if (_journalLines > _compactAfterLines) await compact();
  }

  /// Rewrites the snapshot from memory and empties the journal. Atomic: the new
  /// snapshot is written beside the old one and renamed over it.
  Future<void> compact() async {
    final tmp = await _file('snapshot.tmp');
    final sink = tmp.openWrite();
    for (final record in _records.values) {
      sink.writeln(jsonEncode({'t': 'rec', 'r': record.toJson()}));
    }
    for (final op in _outbox) {
      sink.writeln(jsonEncode({'t': 'op', 'o': op}));
    }
    for (final c in _conflicts) {
      sink.writeln(jsonEncode({'t': 'conflict', 'c': c.toJson()}));
    }
    sink.writeln(jsonEncode({'t': 'meta', 'since': _since, if (lastReceipt != null) 'receipt': lastReceipt!.toJson()}));
    await sink.flush();
    await sink.close();
    await tmp.rename((await _file('snapshot.ndjson')).path);
    final journal = await _file('journal.ndjson');
    if (await journal.exists()) await journal.writeAsString('', flush: true);
    _journalLines = 0;
  }

  // ── Index ──────────────────────────────────────────────────────────────────

  static final RegExp _word = RegExp(r"[a-z0-9']{3,}");
  static const Set<String> _stop = {
    'the', 'and', 'for', 'you', 'are', 'was', 'with', 'that', 'this', 'have', 'from', 'your', 'what', 'can',
    'will', 'just', 'not', 'but', 'they', 'them', 'she', 'her', 'his', 'him', 'its', 'our', 'out', 'who', 'how',
    'why', 'when', 'where', 'which', 'would', 'could', 'should', 'about', 'into', 'than', 'then', 'there',
    'their', 'been', 'were', 'also', 'please', 'okay', 'yeah', 'sir', 'che', 'chay', 'chey', 'said', 'answered',
  };

  Uint32List _tokenize(String text) {
    final ids = <int>{};
    for (final m in _word.allMatches(text.toLowerCase())) {
      final w = m.group(0)!;
      if (_stop.contains(w)) continue;
      ids.add(_intern.putIfAbsent(w, () => _intern.length + 1));
    }
    final list = Uint32List.fromList(ids.toList()..sort());
    return list;
  }

  void _index(CheBrainRecord record) {
    _records[record.id] = record;
    if (record.deleted) {
      _tokens.remove(record.id);
    } else {
      _tokens[record.id] = _tokenize('${record.title} ${record.excerpt}');
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  int get count => _records.values.where((r) => !r.deleted).length;
  int get tombstones => _records.values.where((r) => r.deleted).length;
  int get pendingOps => _outbox.length;
  int get since => _since;
  List<CheBrainConflict> get conflicts => List.unmodifiable(_conflicts);
  CheBrainRecord? get(String id) => _records[id];
  Iterable<CheBrainRecord> get records => _records.values.where((r) => !r.deleted);

  /// The whole body, from memory or from its file.
  Future<String> bodyOf(String id) async {
    final record = _records[id];
    if (record == null || record.deleted) return '';
    if (record.inlineBody) return record.excerpt;
    try {
      final file = await _bodyFile(id);
      if (await file.exists()) return await file.readAsString();
    } catch (_) {}
    return record.excerpt;
  }

  /// Records that share the most words with [question], newest first on ties.
  List<CheBrainRecord> search(String question, {int limit = 8, String? region}) {
    final query = _tokenize(question);
    if (query.isEmpty) return const [];
    final scored = <(int, CheBrainRecord)>[];
    for (final entry in _tokens.entries) {
      final record = _records[entry.key];
      if (record == null || record.deleted) continue;
      if (region != null && region.isNotEmpty && record.region != region) continue;
      final shared = _sharedCount(entry.value, query);
      if (shared > 0) scored.add((shared, record));
    }
    scored.sort((a, b) {
      final byScore = b.$1.compareTo(a.$1);
      return byScore != 0 ? byScore : b.$2.updatedAt.compareTo(a.$2.updatedAt);
    });
    return scored.take(limit).map((s) => s.$2).toList();
  }

  static int _sharedCount(Uint32List a, Uint32List b) {
    var i = 0, j = 0, shared = 0;
    while (i < a.length && j < b.length) {
      if (a[i] == b[j]) { shared++; i++; j++; } else if (a[i] < b[j]) { i++; } else { j++; }
    }
    return shared;
  }

  /// Live records in a region (and folder), newest first; paged for the orb map.
  List<CheBrainRecord> list({String? region, String? path, int limit = 100, String? beforeUpdatedAt}) {
    final out = _records.values.where((r) => !r.deleted
        && (region == null || region.isEmpty || r.region == region)
        && (path == null || r.path == path)
        && (beforeUpdatedAt == null || r.updatedAt.compareTo(beforeUpdatedAt) < 0)).toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return out.take(limit).toList();
  }

  /// Every region with its folders and real counts, empty regions included.
  List<Map<String, dynamic>> folders() {
    final counts = <String, Map<String, int>>{};
    for (final r in records) {
      final region = counts.putIfAbsent(r.region, () => {});
      region[r.path] = (region[r.path] ?? 0) + 1;
    }
    return cheBrainRegions.map((region) {
      final paths = counts[region] ?? const {};
      final total = paths.values.fold<int>(0, (a, b) => a + b);
      final folders = paths.entries.where((e) => e.key.isNotEmpty).map((e) => {'path': e.key, 'count': e.value}).toList()
        ..sort((a, b) => (b['count'] as int).compareTo(a['count'] as int));
      return {'region': region, 'count': total, 'folders': folders};
    }).toList();
  }

  /// The same digest the Worker computes: count and the sum of fnv1a32("id:rev") mod 2^32.
  ({int count, int sum}) digest() {
    var sum = 0;
    var count = 0;
    for (final r in _records.values) {
      sum = (sum + cheFnv1a32('${r.id}:${r.rev}')) % 4294967296;
      count += 1;
    }
    return (count: count, sum: sum);
  }

  Map<String, dynamic> status() {
    final byRegion = <String, int>{};
    final byVerification = <String, int>{};
    for (final r in records) {
      byRegion[r.region] = (byRegion[r.region] ?? 0) + 1;
      byVerification[r.verification] = (byVerification[r.verification] ?? 0) + 1;
    }
    final d = digest();
    return {
      'records': count, 'tombstones': tombstones, 'pending_ops': pendingOps, 'conflicts': _conflicts.length,
      'since': _since, 'by_region': byRegion, 'by_verification': byVerification,
      'digest': {'count': d.count, 'sum': d.sum},
      'last_sync': lastReceipt?.toJson(),
    };
  }

  // ── Local writes ───────────────────────────────────────────────────────────

  String _newId(String prefix) {
    final now = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
    final salt = (DateTime.now().hashCode ^ _records.length).toRadixString(36);
    return '$prefix:$now$salt';
  }

  /// Saves a record the owner made here (a memory, a note, a correction, a
  /// queued request) and queues it for the cloud. Durable before it returns.
  Future<CheBrainRecord> remember({
    String? id,
    required String kind,
    required String region,
    String path = '',
    String? title,
    required String body,
    String verification = 'owner_attested',
    Map<String, dynamic> source = const {},
    List<Map<String, dynamic>> links = const [],
  }) async {
    await load();
    final existing = id == null ? null : _records[id];
    final recordId = id ?? _newId(kind == 'memory' ? 'mem' : kind == 'conversation' ? 'conv' : 'phone');
    final now = DateTime.now().toUtc().toIso8601String();
    final cleanBody = body.trim();
    final record = CheBrainRecord(
      id: recordId,
      kind: kind,
      region: cheBrainRegions.contains(region) ? region : cheBrainRegions[2],
      path: path,
      title: (title ?? cleanBody.split('\n').first).trim().isEmpty ? recordId : (title ?? cleanBody.split('\n').first).trim(),
      excerpt: CheBrainRecord._excerpt(cleanBody),
      bodyChars: cleanBody.length,
      source: {...source, 'device': deviceName},
      verification: verification,
      significance: existing?.significance ?? const {},
      links: links,
      rev: existing?.rev ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      origin: deviceName,
      deleted: false,
      seq: existing?.seq ?? 0,
      pending: true,
    );
    if (!record.inlineBody) await (await _bodyFile(recordId)).writeAsString(cleanBody, flush: true);
    final op = {
      'op_id': '$deviceName-${_newId('op')}',
      'type': 'put',
      'record': {
        'id': recordId, 'kind': kind, 'region': record.region, 'path': path, 'title': record.title, 'body': cleanBody,
        'verification': verification, 'source': record.source, 'links': links, 'created_at': record.createdAt,
      },
      'base_rev': existing?.rev,
    };
    _outbox.removeWhere((o) => o['type'] == 'put' && (o['record'] as Map)['id'] == recordId);
    _outbox.add(op);
    _index(record);
    await _append({'t': 'rec', 'r': record.toJson()});
    await _append({'t': 'op', 'o': op});
    return record;
  }

  /// A request CHE could not run offline. Kept as a task record that says so;
  /// nothing here claims it ran, and no authorization is inferred from it.
  Future<CheBrainRecord> queueRemoteRequest(String request, {String reason = 'offline'}) => remember(
        kind: 'queued_request',
        region: cheBrainRegions[15],
        path: 'Queued offline',
        title: request.length > 90 ? '${request.substring(0, 90)}…' : request,
        body: 'Queued, not run ($reason): $request',
        verification: 'unknown',
        source: {'kind': 'queued_request', 'status': 'queued', 'reason': reason},
      );

  /// The owner's deletion: a tombstone here now, and at the cloud at the next sync.
  Future<void> forget(String id) async {
    await load();
    final existing = _records[id];
    final now = DateTime.now().toUtc().toIso8601String();
    final tomb = (existing ?? CheBrainRecord(
      id: id, kind: 'note', region: cheBrainRegions[2], path: '', title: '', excerpt: '', bodyChars: 0, source: const {},
      verification: 'unknown', significance: const {}, links: const [], rev: 0, createdAt: now, updatedAt: now,
      origin: deviceName, deleted: true, seq: 0, pending: true,
    )).copyWith(deleted: true, title: '', excerpt: '', bodyChars: 0, links: const [], updatedAt: now, pending: true);
    try { final f = await _bodyFile(id); if (await f.exists()) await f.delete(); } catch (_) {}
    final op = {'op_id': '$deviceName-${_newId('op')}', 'type': 'delete', 'id': id};
    _outbox.removeWhere((o) => (o['type'] == 'put' && (o['record'] as Map)['id'] == id) || (o['type'] == 'delete' && o['id'] == id));
    _outbox.add(op);
    _index(tomb);
    await _append({'t': 'rec', 'r': tomb.toJson()});
    await _append({'t': 'op', 'o': op});
  }

  Future<void> resolveConflict(String conflictId, {required bool keepLocal}) async {
    final conflict = _conflicts.where((c) => c.id == conflictId).firstOrNull;
    if (conflict == null) return;
    if (keepLocal) {
      final local = conflict.local;
      await remember(
        id: conflict.recordId, kind: '${local['kind'] ?? 'note'}', region: '${local['region'] ?? ''}', path: '${local['path'] ?? ''}',
        title: '${local['title'] ?? ''}', body: '${local['body'] ?? local['excerpt'] ?? ''}', verification: '${local['verification'] ?? 'owner_attested'}',
        source: local['source'] is Map ? Map<String, dynamic>.from(local['source'] as Map) : const {},
      );
    }
    _conflicts.removeWhere((c) => c.id == conflictId);
    await _append({'t': 'resolved', 'id': conflictId});
  }

  // ── Server records ─────────────────────────────────────────────────────────

  Future<void> _applyServer(Map<String, dynamic> json, {List<Map<String, dynamic>>? buffer}) async {
    final incoming = CheBrainRecord.fromJson(json);
    if (incoming == null) return;
    final local = _records[incoming.id];
    // A newer local change waits in the outbox: the push reconciles it, so the
    // server copy is not written over it. Never overwrite newer with older.
    if (local != null && local.pending) return;
    if (local != null && local.rev > incoming.rev && !incoming.deleted) return;
    final body = '${json['body'] ?? ''}';
    if (incoming.deleted) {
      try { final f = await _bodyFile(incoming.id); if (await f.exists()) await f.delete(); } catch (_) {}
    } else if (!incoming.inlineBody) {
      await (await _bodyFile(incoming.id)).writeAsString(body, flush: true);
    }
    _index(incoming);
    final entry = {'t': 'rec', 'r': incoming.toJson()};
    if (buffer != null) { buffer.add(entry); } else { await _append(entry); }
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  /// Push first, then pull, then compare digests. Any transport failure leaves
  /// the outbox and the cursor untouched and is reported in the receipt.
  Future<CheBrainSyncReceipt> sync(String baseUrl, Map<String, String> headers, {required CheBrainGet get, required CheBrainPost post}) async {
    await load();
    final startedAt = DateTime.now().toUtc().toIso8601String();
    var pushed = 0, acknowledged = 0, conflicts = 0, rejected = 0, pulled = 0;
    int? serverCount;
    var digestChecked = false;
    var digestMatch = false;
    String error = '';
    try {
      // Push, in batches, acknowledging each op only when the Worker answered for it.
      while (_outbox.isNotEmpty) {
        final batch = _outbox.take(200).toList();
        pushed += batch.length;
        final res = await post(Uri.parse('$baseUrl/api/brain/push'), headers, jsonEncode({'ops': batch, 'device': deviceName}));
        if (res.status != 200) throw StateError('push answered ${res.status}');
        final decoded = jsonDecode(res.body);
        final results = decoded is Map && decoded['results'] is List ? (decoded['results'] as List) : const [];
        for (final raw in results.whereType<Map>()) {
          final result = Map<String, dynamic>.from(raw);
          final opId = '${result['op_id']}';
          final op = batch.where((o) => '${o['op_id']}' == opId).firstOrNull;
          if (op == null) continue;
          final id = '${result['id'] ?? (op['record'] is Map ? (op['record'] as Map)['id'] : op['id'])}';
          final outcome = '${result['outcome']}';
          final serverRecord = result['record'] is Map ? Map<String, dynamic>.from(result['record'] as Map) : null;
          final local = _records[id];
          switch (outcome) {
            case 'created':
            case 'updated':
            case 'unchanged':
            case 'merged':
            case 'duplicate':
              if (local != null) {
                final rev = (result['rev'] as num?)?.toInt() ?? local.rev;
                _index(local.copyWith(rev: rev, pending: false, syncNote: ''));
                await _append({'t': 'rec', 'r': _records[id]!.toJson()});
              }
              if (serverRecord != null) await _applyServer(serverRecord);
              break;
            case 'deleted':
              if (serverRecord != null) {
                _index(CheBrainRecord.fromJson(serverRecord)!);
                await _append({'t': 'rec', 'r': _records[id]!.toJson()});
              } else if (local != null) {
                _index(local.copyWith(deleted: true, pending: false, title: '', excerpt: '', bodyChars: 0, links: const []));
                await _append({'t': 'rec', 'r': _records[id]!.toJson()});
              }
              break;
            case 'conflict':
              conflicts += 1;
              final conflict = CheBrainConflict(
                id: '${result['conflict_id'] ?? '$id@${DateTime.now().millisecondsSinceEpoch}'}', recordId: id,
                local: {...(op['record'] is Map ? Map<String, dynamic>.from(op['record'] as Map) : local?.toJson() ?? {}), 'rev': local?.rev},
                server: serverRecord ?? {}, at: startedAt,
              );
              _conflicts.add(conflict);
              await _append({'t': 'conflict', 'c': conflict.toJson()});
              if (serverRecord != null) {
                _index(CheBrainRecord.fromJson(serverRecord)!);
                await _append({'t': 'rec', 'r': _records[id]!.toJson()});
              } else if (local != null) {
                _index(local.copyWith(pending: false, syncNote: 'conflict'));
                await _append({'t': 'rec', 'r': _records[id]!.toJson()});
              }
              break;
            case 'rejected':
              rejected += 1;
              if (local != null) {
                _index(local.copyWith(pending: false, syncNote: 'rejected: ${result['reason'] ?? 'unknown'}'));
                await _append({'t': 'rec', 'r': _records[id]!.toJson()});
              }
              break;
            default:
              continue; // Unknown outcome: the op stays queued.
          }
          acknowledged += 1;
          _outbox.remove(op);
          await _append({'t': 'ack', 'op_id': opId});
        }
        if (results.isEmpty) break;
        if (batch.any((op) => _outbox.contains(op))) break; // Unanswered ops wait for the next sync.
      }
      // Pull everything changed since the cursor, in pages.
      var more = true;
      while (more) {
        final res = await get(Uri.parse('$baseUrl/api/brain/changes?since=$_since&limit=500'), headers);
        if (res.status != 200) throw StateError('changes answered ${res.status}');
        final decoded = jsonDecode(res.body);
        if (decoded is! Map) throw StateError('changes returned no page');
        final page = Map<String, dynamic>.from(decoded);
        final buffer = <Map<String, dynamic>>[];
        for (final raw in (page['records'] as List? ?? const []).whereType<Map>()) {
          await _applyServer(Map<String, dynamic>.from(raw), buffer: buffer);
          pulled += 1;
        }
        _since = (page['next'] as num?)?.toInt() ?? _since;
        more = page['more'] == true;
        // The page and its cursor land in one write, so a cut-off never leaves the cursor ahead of the records.
        await _appendMany([...buffer, {'t': 'meta', 'since': _since}]);
        if (!more && page['digest'] is Map) {
          final remote = Map<String, dynamic>.from(page['digest'] as Map);
          serverCount = (remote['count'] as num?)?.toInt();
          if (_outbox.isEmpty) {
            digestChecked = true;
            final mine = digest();
            digestMatch = mine.count == serverCount && mine.sum == (remote['sum'] as num?)?.toInt();
          }
        }
      }
    } catch (e) {
      error = e is StateError ? e.message : e.toString();
    }
    final receipt = CheBrainSyncReceipt(
      at: startedAt, pushed: pushed, acknowledged: acknowledged, conflicts: conflicts, rejected: rejected, pulled: pulled,
      since: _since, pendingAfter: _outbox.length, digestChecked: digestChecked, digestMatch: digestMatch,
      serverCount: serverCount, localCount: _records.length, error: error,
    );
    lastReceipt = receipt;
    try { await _append({'t': 'meta', 'since': _since, 'receipt': receipt.toJson()}); } catch (_) {}
    return receipt;
  }
}
