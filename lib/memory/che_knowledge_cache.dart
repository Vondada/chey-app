// CHE's offline knowledge cache: every general-knowledge answer she gets from
// her cloud engines is kept on the phone. Next time she answers from here
// first, or lets her on-phone brain combine several saved answers, and only
// spends cloud credits when the cache really can't answer.
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

class CheKnowledgeCache {
  static const int maxEntries = 3000;
  static const _stop = {
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
    'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that',
    'what', 'who', 'when', 'where', 'why', 'how', 'which', 'did', 'do', 'does',
    'can', 'could', 'would', 'should', 'will', 'please', 'explain', 'tell',
    'about', 'mean', 'means', 'meaning', 'define', 'whats',
  };

  // Questions whose answer changes (news, prices, today) always go online.
  static final RegExp _timeSensitive = RegExp(
    r'\b(?:today|tonight|tomorrow|yesterday|now|current(?:ly)?|latest|newest|recent|this (?:week|month|year)|price|stock|weather|score|news|open right now|live)\b',
    caseSensitive: false,
  );

  // Personal or app-state requests (my calendar, your mailbox, open the
  // office) are not general knowledge, so they are never cached.
  static final RegExp _personal = RegExp(
    r"\b(?:i|me|my|mine|i'm|i've|you|your|yours|che|chay|mailbox|flagstaff|office|open|start|stop|send|remind|call|text|play|lock|unlock|fix|build|make|create)\b",
    caseSensitive: false,
  );

  static final RegExp _question = RegExp(
    r'^(?:what|who|why|how|when|where|which|explain|define|describe|is|are|does|do|can|meaning of)\b',
    caseSensitive: false,
  );

  final List<_Entry> _entries = [];
  bool _loaded = false;

  /// Only general, stable knowledge questions are answered from the cache.
  static bool cacheable(String question) {
    final q = question.trim();
    if (q.length < 8 || q.length > 300) return false;
    if (!_question.hasMatch(q)) return false;
    return !_timeSensitive.hasMatch(q) && !_personal.hasMatch(q);
  }

  static Set<String> _terms(String text) => RegExp(r"[a-z0-9']{3,}")
      .allMatches(text.toLowerCase())
      .map((m) => m.group(0)!)
      .where((w) => !_stop.contains(w))
      .toSet();

  Future<File> _file() async {
    final base = await getApplicationDocumentsDirectory();
    return File('${base.path}/che_knowledge_cache.json');
  }

  Future<void> _load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final file = await _file();
      if (!await file.exists()) return;
      final data = jsonDecode(await file.readAsString());
      if (data is! List) return;
      for (final item in data.whereType<Map>()) {
        final entry = _Entry.fromJson(Map<String, dynamic>.from(item));
        if (entry != null) _entries.add(entry);
      }
    } catch (_) {}
  }

  Future<void> _save() async {
    try {
      final file = await _file();
      await file.writeAsString(jsonEncode(_entries.map((e) => e.toJson()).toList()));
    } catch (_) {}
  }

  int get count => _entries.length;

  /// Keeps a cloud answer for later. Error-looking or tiny answers are skipped.
  Future<void> remember(String question, String answer) async {
    if (!cacheable(question)) return;
    final a = answer.trim();
    if (a.length < 20 || a.length > 6000) return;
    if (RegExp(r"\b(?:sorry|couldn't|could not|can't reach|backup engine|error)\b", caseSensitive: false).hasMatch(a.substring(0, a.length < 160 ? a.length : 160))) {
      return;
    }
    await _load();
    final terms = _terms(question);
    if (terms.isEmpty) return;
    _entries.removeWhere((e) => _similarity(e.terms, terms) >= 0.95);
    _entries.add(_Entry(question.trim(), a, terms, DateTime.now()));
    if (_entries.length > maxEntries) _entries.removeRange(0, _entries.length - maxEntries);
    await _save();
  }

  static double _similarity(Set<String> a, Set<String> b) {
    if (a.isEmpty || b.isEmpty) return 0;
    final shared = a.intersection(b).length;
    return shared / a.union(b).length;
  }

  /// A saved answer to (almost) the same question, or null.
  Future<String?> answer(String question) async {
    if (!cacheable(question)) return null;
    await _load();
    final terms = _terms(question);
    _Entry? best;
    var bestScore = 0.0;
    for (final e in _entries) {
      final s = _similarity(e.terms, terms);
      if (s > bestScore) {
        bestScore = s;
        best = e;
      }
    }
    return best != null && bestScore >= 0.8 ? best.answer : null;
  }

  /// Saved answers that cover parts of [question], for the on-phone brain to
  /// put together ("two and two").
  Future<List<String>> related(String question, {int limit = 4}) async {
    if (!cacheable(question)) return const [];
    await _load();
    final terms = _terms(question);
    if (terms.isEmpty) return const [];
    final scored = <MapEntry<double, _Entry>>[];
    for (final e in _entries) {
      final shared = e.terms.intersection(terms).length;
      if (shared == 0) continue;
      scored.add(MapEntry(shared / terms.length, e));
    }
    scored.sort((a, b) => b.key.compareTo(a.key));
    return scored
        .where((s) => s.key >= 0.34)
        .take(limit)
        .map((s) => 'SAVED NOTE (Q: ${s.value.question}) ${s.value.answer.length > 700 ? '${s.value.answer.substring(0, 700)}…' : s.value.answer}')
        .toList();
  }

  /// True when the saved notes together mention every key word of the question.
  Future<bool> notesCover(String question) async {
    await _load();
    final terms = _terms(question);
    if (terms.isEmpty) return false;
    final covered = <String>{};
    for (final e in _entries) {
      covered.addAll(e.terms.intersection(terms));
    }
    return covered.length == terms.length;
  }
}

class _Entry {
  _Entry(this.question, this.answer, this.terms, this.at);

  final String question;
  final String answer;
  final Set<String> terms;
  final DateTime at;

  static _Entry? fromJson(Map<String, dynamic> json) {
    final q = '${json['q'] ?? ''}';
    final a = '${json['a'] ?? ''}';
    if (q.isEmpty || a.isEmpty) return null;
    return _Entry(q, a, CheKnowledgeCache._terms(q), DateTime.tryParse('${json['at']}') ?? DateTime.now());
  }

  Map<String, dynamic> toJson() => {'q': question, 'a': answer, 'at': at.toIso8601String()};
}
