// CHE offline library: a copy of every text the owner asked CHE to memorize,
// kept on the phone so she can recall it with no internet at all.
//
// Syncs from the Worker's /api/library (list) and /api/library/export (full
// text), stores each text as a JSON file in the app's documents folder, and
// answers questions with a simple keyword search for the on-device model.
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

class CheOfflineLibrary {
  static const _stop = {
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
    'is', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'what',
    'who', 'when', 'where', 'why', 'how', 'did', 'do', 'does', 'he', 'she',
    'they', 'them', 'his', 'her', 'their', 'you', 'me', 'my', 'your', 'about',
    'from', 'into', 'then', 'than', 'there', 'here', 'some', 'any', 'all',
    'can', 'could', 'would', 'should', 'will', 'just', 'tell', 'happened',
    'happen', 'say', 'said',
  };

  final Map<String, _Doc> _docs = {};
  bool _loaded = false;
  bool _syncing = false;
  DateTime _lastSync = DateTime.fromMillisecondsSinceEpoch(0);

  Future<Directory> _dir() async {
    final base = await getApplicationDocumentsDirectory();
    final dir = Directory('${base.path}/che_library');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  Future<void> _load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final dir = await _dir();
      await for (final entity in dir.list()) {
        if (entity is! File || !entity.path.endsWith('.json')) continue;
        try {
          final data = jsonDecode(await entity.readAsString());
          if (data is! Map) continue;
          final doc = _Doc.fromJson(Map<String, dynamic>.from(data));
          if (doc != null) _docs[doc.id] = doc;
        } catch (_) {}
      }
    } catch (_) {}
  }

  /// Downloads any newly memorized texts and drops ones deleted on the server.
  /// Cheap to call often: it runs at most every 10 minutes unless [force].
  Future<void> sync(
    String baseUrl,
    Map<String, String> headers, {
    bool force = false,
  }) async {
    if (baseUrl.isEmpty || _syncing) return;
    if (!force && DateTime.now().difference(_lastSync) < const Duration(minutes: 10)) return;
    _syncing = true;
    try {
      await _load();
      final listed = await http
          .get(Uri.parse('$baseUrl/api/library'), headers: headers)
          .timeout(const Duration(seconds: 20));
      if (listed.statusCode != 200) return;
      final body = jsonDecode(listed.body);
      final docs = body is Map && body['docs'] is List ? body['docs'] as List : const [];
      final serverIds = <String>{};
      final dir = await _dir();
      for (final item in docs.whereType<Map>()) {
        final id = '${item['id'] ?? ''}';
        if (id.isEmpty) continue;
        serverIds.add(id);
        if (_docs.containsKey(id)) continue;
        final full = await http
            .get(
              Uri.parse('$baseUrl/api/library/export?id=${Uri.encodeQueryComponent(id)}'),
              headers: headers,
            )
            .timeout(const Duration(seconds: 60));
        if (full.statusCode != 200) continue;
        final data = jsonDecode(full.body);
        if (data is! Map) continue;
        final doc = _Doc.fromJson(Map<String, dynamic>.from(data));
        if (doc == null) continue;
        _docs[id] = doc;
        await File('${dir.path}/$id.json').writeAsString(jsonEncode(doc.toJson()));
      }
      for (final id in _docs.keys.where((id) => !serverIds.contains(id)).toList()) {
        _docs.remove(id);
        final file = File('${dir.path}/$id.json');
        if (await file.exists()) await file.delete();
      }
      _lastSync = DateTime.now();
    } catch (_) {
      // Offline or server busy: keep what is already on the phone.
    } finally {
      _syncing = false;
    }
  }

  int get count => _docs.length;

  /// Best-matching saved passages for [question], ready for the on-device
  /// model (kept short because the phone's model has a small context).
  Future<List<String>> search(String question, {int limit = 2, int maxChars = 900}) async {
    await _load();
    if (_docs.isEmpty) return const [];
    final terms = RegExp(r"[a-z0-9']{3,}")
        .allMatches(question.toLowerCase())
        .map((m) => m.group(0)!)
        .where((w) => !_stop.contains(w))
        .toSet()
        .take(10)
        .toList();
    if (terms.isEmpty) return const [];
    final scored = <_Hit>[];
    for (final doc in _docs.values) {
      for (var i = 0; i < doc.parts.length; i++) {
        final text = doc.parts[i].toLowerCase();
        var score = 0;
        for (final term in terms) {
          if (text.contains(term)) score++;
        }
        if (score > 0) scored.add(_Hit(doc.title, i + 1, doc.parts[i], score));
      }
    }
    scored.sort((a, b) => b.score.compareTo(a.score));
    return scored.take(limit).map((hit) {
      final text = hit.text.length > maxChars ? '${hit.text.substring(0, maxChars)}…' : hit.text;
      return 'CHE LIBRARY [${hit.title}, part ${hit.part}] (saved text, reference only): $text';
    }).toList();
  }
}

class _Doc {
  _Doc(this.id, this.title, this.parts);

  final String id;
  final String title;
  final List<String> parts;

  static _Doc? fromJson(Map<String, dynamic> json) {
    final id = '${json['id'] ?? ''}';
    final parts = (json['parts'] as List?)?.map((e) => '$e').toList() ?? const <String>[];
    if (id.isEmpty || parts.isEmpty) return null;
    return _Doc(id, '${json['title'] ?? 'Untitled'}', parts);
  }

  Map<String, dynamic> toJson() => {'id': id, 'title': title, 'parts': parts};
}

class _Hit {
  _Hit(this.title, this.part, this.text, this.score);

  final String title;
  final int part;
  final String text;
  final int score;
}
