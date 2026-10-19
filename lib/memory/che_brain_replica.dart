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
const int _compactAfterLines = 2000;

/// The same words the Worker refuses (research_memory.js SENSITIVE_RE and the
/// privacy policy's secret class). A memory that names a password, key or code
/// is never written to the replica: passwords live only in the Keychain vault.
final RegExp _sensitive = RegExp(
  r"password|passcode|security code|social security|credit card|api[_ -]?key|private key|seed phrase|session cookie|auth\s+token|\b(?:secret|token|2fa|otp|ssn|pin)\b",
  caseSensitive: false,
);

/// True when [text] must not be kept in the Brain or placed in the on-device model's context. Checked
/// over the whole text: the words the Worker refuses, and the shapes of a secret (below).
bool cheBrainTextIsSensitive(String text) => _sensitive.hasMatch(text) || cheBrainTextHasSecretShape(text);

// The shapes of a secret, mirrored from research_memory.js (hasSecretShape and BROKER_KEY_RE), so the phone
// refuses what the Worker refuses (second review of #354). A commit SHA, an id, a date, a version, a trading
// figure, an address and an ordinary link are not secrets; see the Worker's tests for each case.
final RegExp _brokerKeyShape = RegExp(r'\b[AP]K[A-Z0-9]{16,38}\b');
final RegExp _pemShape = RegExp(r'-----BEGIN [A-Z0-9 ]{3,40}-----');
final RegExp _jwtShape = RegExp(r'\beyJ[A-Za-z0-9_-]{8,}');
final RegExp _userPassShape = RegExp(r"""(?:^|[\s(])[A-Za-z0-9._%+-]{2,40}:(?=[^\s:/@"'{}\[\],]*[A-Za-z])(?=[^\s:/@"'{}\[\],]*[\d!@#$%^&*+=?~])[^\s:/@"'{}\[\],]{6,}""");
final RegExp _tokenSplitShape = RegExp(r'[\s"“”,;(){}\[\]<>]+');
final RegExp _leadPunctShape = RegExp(r'''^[("'“‘[<{]+''');
final RegExp _trailPunctShape = RegExp(r'''[)"'”’\]>},.;:?]+$''');
final RegExp _trailingBangShape = RegExp(r'!+$');
final RegExp _passwordSymbolShape = RegExp(r'[!@#$%^&*+=~?|\\]');
final RegExp _hexShape = RegExp(r'^[0-9a-f]+$', caseSensitive: false);
final RegExp _uuidShape = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', caseSensitive: false);
final RegExp _webhookShape = RegExp(r'hooks\.slack\.com/services/|discord(?:app)?\.com/api/webhooks/', caseSensitive: false);
final RegExp _linkShape = RegExp(r'://|^www\.', caseSensitive: false);
final RegExp _linkHeadShape = RegExp(r'^(?:[a-z][a-z0-9+.-]*://|www\.)([^/?#]*)', caseSensitive: false);
final RegExp _pathSplitShape = RegExp(r'[?#]');
final RegExp _queryPieceSplitShape = RegExp(r'[?&=#]+');
final RegExp _percentShape = RegExp(r'%([0-9A-Fa-f]{2})');
final RegExp _randomRunShape = RegExp(r'^[A-Za-z0-9_]{20,}$');
// A hyphen-joined run of 20+ characters with capitals, lower-case letters and digits (fifth review of #354).
final RegExp _hyphenRunShape = RegExp(r'^[A-Za-z0-9_-]{20,}$');
final RegExp _groupShape = RegExp(r'^[A-Za-z0-9]{3,8}$');
final RegExp _googleDocHostShape = RegExp(r'^(?:docs|drive)\.google\.com$', caseSensitive: false);
// A Google document ID is 28 to 64 letters, digits, hyphens or underscores (fourth review of #354).
final RegExp _googleDocIdShape = RegExp(r'^[A-Za-z0-9_-]{28,64}$');
final RegExp _upperGroupShape = RegExp(r'^[A-Z0-9]+$');
final RegExp _letterShape = RegExp(r'[A-Za-z]');
final RegExp _digitShape = RegExp(r'\d');
final RegExp _upperShape = RegExp(r'[A-Z]');
final RegExp _lowerShape = RegExp(r'[a-z]');
final RegExp _switchShape = RegExp(r'[A-Za-z](?=\d)|\d(?=[A-Za-z])');
final RegExp _datePrefixShape = RegExp(r'^\d{4}-\d{2}-\d{2}');
final RegExp _versionPrefixShape = RegExp(r'^v?\d+(?:\.\d+)+', caseSensitive: false);
final RegExp _hashNumberShape = RegExp(r'^#\d+');
final RegExp _emailShape = RegExp(r'^[\w.+-]+@[\w-]+\.[\w.]+$');
final RegExp _figureShape = RegExp(r'^[+\-−]?\$?\d+\.\d+(?:R|%)?$');
final RegExp _rFigureShape = RegExp(r'^[+\-−]\d+R$');

/// True when [text] holds the shape of a password, key, token or private key. Whole text, not a window.
bool cheBrainTextHasSecretShape(String text) {
  if (_brokerKeyShape.hasMatch(text) || _pemShape.hasMatch(text) || _jwtShape.hasMatch(text) || _userPassShape.hasMatch(text)) {
    return true;
  }
  for (final piece in text.split(_tokenSplitShape)) {
    if (piece.isNotEmpty && _secretToken(piece)) return true;
  }
  return false;
}

bool _secretToken(String raw) {
  final trimmed = raw.replaceFirst(_leadPunctShape, '').replaceFirst(_trailPunctShape, '');
  if (_webhookShape.hasMatch(trimmed)) return true;
  if (_linkShape.hasMatch(trimmed)) return _linkHasSecret(trimmed);
  return _plainSecret(trimmed);
}

// A commit SHA is 7-12 or exactly 40 hex characters; any other hex run is a key or a token.
bool _plainSecret(String trimmed) {
  if (_groupedCode(trimmed)) return true;
  final token = trimmed.replaceFirst(_trailingBangShape, '');
  if (token.length < 8 || !_letterShape.hasMatch(token) || !_digitShape.hasMatch(token)) return false;
  if (_hexShape.hasMatch(token)) return token.length >= 13 && token.length != 40;
  if (_uuidShape.hasMatch(token) || _emailShape.hasMatch(token)) return false;
  if (_datePrefixShape.hasMatch(token) || _versionPrefixShape.hasMatch(token) || _hashNumberShape.hasMatch(token)) return false;
  if (_figureShape.hasMatch(token) || _rFigureShape.hasMatch(token)) return false;
  final mixedCase = _lowerShape.hasMatch(token) && _upperShape.hasMatch(token);
  if (_passwordSymbolShape.hasMatch(token) || (mixedCase && trimmed != token)) return true;
  final switches = _switchShape.allMatches(token).length;
  return mixedCase && ((token.length >= 12 && switches >= 3) || token.length >= 24);
}

// A code is four or more hyphen-separated groups of four or five letters and digits, and each group has
// a digit or all groups are capitals (the same rule as research_memory.js; third review of #354).
bool _groupedCode(String token) {
  if (_uuidShape.hasMatch(token)) return false;
  final groups = token.split('-');
  if (groups.length < 4 || !groups.every(_groupShape.hasMatch)) return false;
  if (!_letterShape.hasMatch(groups.join())) return false;
  return groups.every(_digitShape.hasMatch) || groups.every(_upperGroupShape.hasMatch);
}

// Google links (owner decisions, seventh round of #354), as in research_memory.js. An ID is exempt from the
// random-run checks only inside one of the functional shapes below, and only when it is a clean ID of 28 to 64
// characters. Any other Google path with a long ID is withheld. A shape lists the path parts after the leading
// "/": 'ID' is the Google ID and a List is a choice of parts.
const List<List<Object>> _googleAllowedLinks = [
  ['docs.google.com', ['document', 'd', 'ID', ['edit', 'view']]],
  ['docs.google.com', ['spreadsheets', 'd', 'ID', 'edit']],
  ['docs.google.com', ['presentation', 'd', 'ID', 'edit']],
  ['docs.google.com', ['document', 'd', 'e', 'ID', 'pub']],
  ['drive.google.com', ['file', 'd', 'ID', 'view']],
  ['drive.google.com', ['drive', 'folders', 'ID']],
];

// The index of the allow-listed ID in the raw path segments, or -1 when the path is not one of those shapes.
int _googleAllowedIdIndex(String host, List<String> rawSegments) {
  final parts = rawSegments.sublist(1);
  for (final entry in _googleAllowedLinks) {
    final allowedHost = entry[0] as String;
    final shape = entry[1] as List<Object>;
    if (host.toLowerCase() != allowedHost || parts.length != shape.length) continue;
    var idIndex = -1;
    var matches = true;
    for (var k = 0; k < shape.length && matches; k++) {
      final want = shape[k];
      final part = parts[k];
      if (want == 'ID') {
        idIndex = k + 1;
        matches = _googleDocIdShape.hasMatch(part);
      } else if (want is List) {
        matches = want.contains(part);
      } else {
        matches = part == want;
      }
    }
    if (matches) return idIndex;
  }
  return -1;
}

// A password in the userinfo is withheld when it is six or more characters with a letter and a digit or a
// symbol (sixth review of #354), as in research_memory.js.
final RegExp _digitOrSymbolShape = RegExp(r'[\d\W_]');
bool _userinfoPasswordShape(String userinfo) {
  final colon = userinfo.indexOf(':');
  if (colon < 0) return false;
  final password = userinfo.substring(colon + 1);
  return password.length >= 6 && _letterShape.hasMatch(password) && _digitOrSymbolShape.hasMatch(password);
}

// Percent-encoded characters read as the characters they stand for (sixth review of #354).
String _decodePercent(String text) =>
    text.replaceAllMapped(_percentShape, (m) => String.fromCharCode(int.parse(m.group(1)!, radix: 16)));

// Any character outside the token alphabet cuts a decoded segment into pieces (seventh review of #354).
final RegExp _tokenBreakShape = RegExp(r'[^A-Za-z0-9_-]+');

bool _randomRun(String piece) =>
    _randomRunShape.hasMatch(piece) && _letterShape.hasMatch(piece) && _digitShape.hasMatch(piece) && !_hexShape.hasMatch(piece);

// The hyphen-joined form: a hyphen, capitals, lower-case letters and digits (the same floor as _randomRun).
bool _hyphenatedRandomRun(String piece) =>
    _hyphenRunShape.hasMatch(piece) && piece.contains('-') && _lowerShape.hasMatch(piece) && _upperShape.hasMatch(piece) && _digitShape.hasMatch(piece);

// A link is judged by its parts, as in research_memory.js: userinfo and query values get the full token check;
// a path segment is judged piece by piece after decoding.
bool _linkHasSecret(String link) {
  final head = _linkHeadShape.firstMatch(link);
  final authority = head == null ? '' : head.group(1)!;
  final rest = head == null ? link : link.substring(head.group(0)!.length);
  final at = authority.lastIndexOf('@');
  if (at > 0 && authority.substring(0, at).split(':').any((piece) => piece.isNotEmpty && _plainSecret(piece))) return true;
  if (at > 0 && _userinfoPasswordShape(authority.substring(0, at))) return true;
  final host = authority.substring(at + 1).split(':').first;
  final path = rest.split(_pathSplitShape).first;
  final query = rest.substring(path.length);
  final rawSegments = path.split('/');
  final allowedId = _googleAllowedIdIndex(host, rawSegments);
  final googleHost = _googleDocHostShape.hasMatch(host);
  for (var i = 0; i < rawSegments.length; i++) {
    if (i == allowedId) continue;
    final decoded = _decodePercent(rawSegments[i]);
    final pieces = decoded.split(_tokenBreakShape).where((p) => p.isNotEmpty).toList();
    if (googleHost && pieces.any(_googleDocIdShape.hasMatch)) return true;
    for (final piece in pieces) {
      if (_randomRun(piece) || _hyphenatedRandomRun(piece)) return true;
      if (_hexShape.hasMatch(piece) && _plainSecret(piece)) return true;
    }
  }
  // The raw query is split on its delimiters first, so an encoded delimiter stays inside its value.
  return query.split(_queryPieceSplitShape).any((raw) {
    if (raw.isEmpty) return false;
    final piece = _decodePercent(raw);
    return _randomRun(piece) || _plainSecret(piece);
  });
}

// Google document IDs are not repeated in logs, reports or unrelated model requests (owner decision): the ID in a
// Google link becomes "[google-id]". The link itself stays stored whole.
final RegExp _googleLinkTextShape =
    RegExp(r"""https?://(?:docs|drive)\.google\.com/[^\s"'<>()\[\]]*""", caseSensitive: false);
final RegExp _googleRequestShape = RegExp(r'google|docs\.google\.com|drive\.google\.com', caseSensitive: false);
final RegExp _tokenCutShape = RegExp(r'[?#]');
final RegExp _googleIdRunShape = RegExp(r'[A-Za-z0-9_-]{28,64}');

String cheRedactGoogleIds(String text) => text.replaceAllMapped(_googleLinkTextShape, (m) {
      final link = m.group(0)!;
      final cut = link.indexOf(_tokenCutShape);
      final head = cut < 0 ? link : link.substring(0, cut);
      final tail = cut < 0 ? '' : link.substring(cut);
      final redactedHead = head.split('/').map((part) => _googleDocIdShape.hasMatch(part) ? '[google-id]' : part).join('/');
      return redactedHead + tail.replaceAll(_googleIdRunShape, '[google-id]');
    });

/// True when the owner's own words are about a Google file, so the ID in it is theirs to use.
bool cheAskedAboutGoogle(String text) => _googleRequestShape.hasMatch(text);

/// Brain text for a log, a report or a model request: IDs are redacted unless the owner's request is about Google.
String cheRedactBrainText(String text, String ownerMessage) =>
    cheAskedAboutGoogle(ownerMessage) ? text : cheRedactGoogleIds(text);

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
    this.places = const [],
  });

  final String id;
  final String kind;
  final String region;
  final String path;

  /// Every region/folder the record sits in (a task shared by two workers is in both brains); empty means its own region/path only.
  final List<Map<String, dynamic>> places;
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

  bool get inlineBody => bodyChars <= _excerptChars;

  CheBrainRecord copyWith({
    String? title, String? excerpt, int? bodyChars, Map<String, dynamic>? source, String? verification,
    Map<String, dynamic>? significance, List<Map<String, dynamic>>? links, int? rev, String? updatedAt,
    String? origin, bool? deleted, int? seq, bool? pending, String? syncNote, String? region, String? path, String? kind,
    List<Map<String, dynamic>>? places,
  }) => CheBrainRecord(
        id: id, kind: kind ?? this.kind, region: region ?? this.region, path: path ?? this.path, places: places ?? this.places,
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
        if (places.isNotEmpty) 'places': places,
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
      places: json['places'] is List
          ? [for (final p in json['places'] as List) if (p is Map && '${p['region'] ?? ''}'.isNotEmpty) {'region': '${p['region']}', 'path': '${p['path'] ?? ''}'}]
          : const [],
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

  /// The cloud could not be reached at all (no connection, DNS, a timeout), as opposed to an
  /// answer the sync could not use (401, 500, a refused op): only the first means "offline".
  bool get unreachable => error.isNotEmpty &&
      RegExp(r'SocketException|ClientException|TimeoutException|HandshakeException|Failed host lookup|Connection (?:refused|failed|reset|closed|timed out)|Network is unreachable|connection abort', caseSensitive: false).hasMatch(error);

  /// The quiet line the Brain room shows when the cloud answered but the sync could not use the
  /// answer (a 401, a 503, a refused op). Null when the sync worked or the cloud was unreachable,
  /// which the room shows as offline instead.
  String? get syncNotice {
    if (ok || unreachable) return null;
    final status = RegExp(r'\b([45]\d\d)\b').firstMatch(error)?.group(1);
    return 'the cloud did not accept the sync${status == null ? '' : ' (HTTP $status)'}; this is the copy on your phone.';
  }

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
        final op = Map<String, dynamic>.from(entry['o'] as Map);
        if (_outbox.any((o) => o['op_id'] == op['op_id'])) break;
        // A later put for the same record supersedes an earlier one, and a delete supersedes
        // every earlier op for its record, as the live path does.
        if (op['type'] == 'put') {
          final id = (op['record'] as Map?)?['id'];
          _outbox.removeWhere((o) => (o['type'] == 'put' && (o['record'] as Map?)?['id'] == id) || (o['type'] == 'delete' && o['id'] == id));
        } else if (op['type'] == 'delete') {
          final id = op['id'];
          _outbox.removeWhere((o) => (o['type'] == 'put' && (o['record'] as Map?)?['id'] == id) || (o['type'] == 'delete' && o['id'] == id));
        }
        _outbox.add(op);
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

  // Journal writes and compaction take turns, so an append never lands between
  // the snapshot rename and the journal truncation.
  Future<void> _lock = Future.value();
  Future<T> _locked<T>(Future<T> Function() work) {
    final next = _lock.then((_) => work());
    _lock = next.then((_) {}, onError: (_) {});
    return next;
  }
  bool _holdCompaction = false;

  /// One flushed write for a batch of journal entries: a sync page costs one disk write, not one per record.
  Future<void> _appendMany(List<Map<String, dynamic>> entries) async {
    if (entries.isEmpty) return;
    await _locked(() async {
      final journal = await _file('journal.ndjson');
      await journal.writeAsString(entries.map(jsonEncode).map((l) => '$l\n').join(), mode: FileMode.append, flush: true);
      _journalLines += entries.length;
    });
    _recordsJson = null;
    if (_compactionDue && !_holdCompaction) await compact();
  }

  // Compaction rewrites the whole snapshot, so it waits until the journal is as
  // long as half the records (never below 2000 lines): linear, not quadratic.
  bool get _compactionDue => _journalLines > _compactAfterLines && _journalLines > _records.length ~/ 2;

  /// Rewrites the snapshot from memory and empties the journal. Atomic: the new
  /// snapshot is written beside the old one and renamed over it.
  Future<void> compact() => _locked(_compactUnlocked);

  Future<void> _compactUnlocked() async {
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
    _recordsJson = null;
    _records[record.id] = record;
    if (record.deleted) {
      _tokens.remove(record.id);
    } else if (cheBrainTextIsSensitive('${record.title}\n${record.excerpt}')) {
      // A record that holds a secret shape (a sync from before the gate) stays in the list, but it is
      // never indexed: no search finds it, so its words never reach the on-device model (second review of #354).
      _tokens.remove(record.id);
    } else {
      _tokens[record.id] = _tokenize('${record.title} ${record.excerpt}');
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  List<Map<String, dynamic>>? _recordsJson;

  /// Every live record as JSON for the Brain room, computed once per change, not per frame.
  List<Map<String, dynamic>> recordsJson() => _recordsJson ??= records.map((r) => r.toJson()).toList(growable: false);

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
  Future<CheBrainRecord?> remember({
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
    // Secrets never touch the disk here, not even as a pending record.
    if (cheBrainTextIsSensitive('${title ?? ''}\n$body')) return null;
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
    // A new put supersedes an earlier put and a pending delete of the same record: the recreate
    // then reaches the cloud against the live revision instead of racing its own tombstone.
    _outbox.removeWhere((o) => (o['type'] == 'put' && (o['record'] as Map)['id'] == recordId) || (o['type'] == 'delete' && o['id'] == recordId));
    _outbox.add(op);
    _index(record);
    // Record and op in one write: a cut-off never leaves a record that is pending but never sent.
    await _appendMany([{'t': 'rec', 'r': record.toJson()}, {'t': 'op', 'o': op}]);
    return record;
  }

  /// A request CHE could not run offline. Kept as a task record that says so;
  /// nothing here claims it ran, and no authorization is inferred from it.
  Future<CheBrainRecord?> queueRemoteRequest(String request, {String reason = 'offline'}) => remember(
        kind: 'queued_request',
        region: cheBrainRegions[15],
        path: 'Queued offline',
        title: request.length > 90 ? '${request.substring(0, 90)}…' : request,
        body: 'Queued, not run ($reason): $request',
        verification: 'unknown',
        source: {'kind': 'queued_request', 'status': 'queued', 'reason': reason},
      );

  /// Every live memory record showing [text] (the Memory screen knows memories by their
  /// words): each becomes a tombstone here and at the cloud. Returns how many.
  Future<int> forgetMemoriesShowing(String text) async {
    await load();
    final wanted = displayCopy(text).toLowerCase();
    if (wanted.isEmpty) return 0;
    final ids = <String>[];
    for (final r in _records.values.where((r) => !r.deleted && r.kind == 'memory')) {
      // The excerpt is the first 600 raw characters; a body with much whitespace collapses to
      // fewer than 500, so the display copy must come from the whole body.
      final body = r.inlineBody ? r.excerpt : await bodyOf(r.id);
      if (displayCopy(body).toLowerCase() == wanted) ids.add(r.id);
    }
    for (final id in ids) {
      await forget(id);
    }
    return ids.length;
  }

  static String displayCopy(String body) {
    final collapsed = body.replaceAll(RegExp(r'\s+'), ' ').trim();
    // Trimmed after the cut as the Worker does, so a copy of a copy is the same copy.
    return collapsed.length > 500 ? collapsed.substring(0, 500).trimRight() : collapsed;
  }

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
    await _appendMany([{'t': 'rec', 'r': tomb.toJson()}, {'t': 'op', 'o': op}]);
  }

  Future<void> resolveConflict(String conflictId, {required bool keepLocal}) async {
    final conflict = _conflicts.where((c) => c.id == conflictId).firstOrNull;
    if (conflict == null) return;
    if (keepLocal) {
      final local = conflict.local;
      final kept = await remember(
        id: conflict.recordId, kind: '${local['kind'] ?? 'note'}', region: '${local['region'] ?? ''}', path: '${local['path'] ?? ''}',
        title: '${local['title'] ?? ''}', body: '${local['body'] ?? local['excerpt'] ?? ''}', verification: '${local['verification'] ?? 'owner_attested'}',
        source: local['source'] is Map ? Map<String, dynamic>.from(local['source'] as Map) : const {},
      );
      if (kept == null) return;
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

  /// The Worker's copy of a record, taken as it is (a push answered with it): the body file
  /// follows the record, so a deleted or replaced record leaves no orphan on disk.
  Future<void> _takeServerCopy(Map<String, dynamic> json) async {
    final incoming = CheBrainRecord.fromJson(json);
    if (incoming == null) return;
    final body = '${json['body'] ?? ''}';
    try {
      final file = await _bodyFile(incoming.id);
      if (incoming.deleted || incoming.inlineBody) {
        if (await file.exists()) await file.delete();
      } else {
        await file.writeAsString(body, flush: true);
      }
    } catch (_) {}
    _index(incoming);
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  /// Push first, then pull, then compare digests. Any transport failure leaves
  /// the outbox and the cursor untouched and is reported in the receipt.
  Future<CheBrainSyncReceipt> sync(String baseUrl, Map<String, String> headers, {required CheBrainGet get, required CheBrainPost post}) async {
    await load();
    final startedAt = DateTime.now().toUtc().toIso8601String();
    _holdCompaction = true;
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
          // A replayed op answers 'duplicate' with what happened the first time.
          final outcome = result['outcome'] == 'duplicate' && result['first_outcome'] != null ? '${result['first_outcome']}' : '${result['outcome']}';
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
                await _takeServerCopy(serverRecord);
                await _append({'t': 'rec', 'r': _records[id]!.toJson()});
              } else if (local != null) {
                try { final f = await _bodyFile(id); if (await f.exists()) await f.delete(); } catch (_) {}
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
                await _takeServerCopy(serverRecord);
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
    _holdCompaction = false;
    try {
      await _append({'t': 'meta', 'since': _since, 'receipt': receipt.toJson()});
      if (_compactionDue) await compact();
    } catch (_) {}
    return receipt;
  }
}
