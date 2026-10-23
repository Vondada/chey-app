// The Strategy Library on the phone: the Worker's registry (server/cloudflare/strategy_library.js) read as
// typed entries, plus the calls that change it. Definitions arrive from the Worker, so a new strategy needs
// no app update. Executable ones run through che_strategy_dsl.dart in the setup engine.

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'che_strategy_dsl.dart';

/// DISCOVERED → RULES DOCUMENTED → IMPLEMENTED → BACKTESTED → FORWARD TESTED → PAPER ACTIVE (owner, 2026-10-23).
enum CheLibraryStage { discovered, rulesDocumented, implemented, backtested, forwardTested, paperActive }

extension CheLibraryStageText on CheLibraryStage {
  String get label => const ['DISCOVERED', 'RULES DOCUMENTED', 'IMPLEMENTED', 'BACKTESTED', 'FORWARD TESTED', 'PAPER ACTIVE'][index];
  String get wire => const ['discovered', 'rules_documented', 'implemented', 'backtested', 'forward_tested', 'paper_active'][index];

  /// What the stage means, for VoiceOver and Read Aloud.
  String get meaning => const [
        'only a name or idea; no written rules',
        'rules or assumptions are written down; nothing runs them yet',
        'an engine can run its rules',
        'it has recorded backtest trades',
        'it has at least 30 forward paper trades',
        'it is paper trading now',
      ][index];

  static CheLibraryStage parse(String? s) {
    final i = const ['discovered', 'rules_documented', 'implemented', 'backtested', 'forward_tested', 'paper_active'].indexOf(s ?? '');
    return i < 0 ? CheLibraryStage.discovered : CheLibraryStage.values[i];
  }
}

enum CheLibraryKind { strategy, marketContext }

class CheLibrarySource {
  const CheLibrarySource({required this.type, required this.title, this.url});
  final String type, title;
  final String? url;
  factory CheLibrarySource.fromJson(Map m) => CheLibrarySource(type: '${m['type'] ?? ''}', title: '${m['title'] ?? m['url'] ?? ''}', url: m['url'] as String?);
}

/// One library entry as the Worker reports it. Every number in [results] comes from a recorded ledger.
class CheLibraryEntry {
  CheLibraryEntry({
    required this.id,
    required this.kind,
    required this.name,
    required this.category,
    required this.stage,
    required this.engine,
    required this.origin,
    this.family = '',
    this.notRunning,
    this.sources = const [],
    this.rules = const [],
    this.assumptions = const [],
    this.timeframes = const [],
    this.dataRequirements = const [],
    this.eventDependencies = const [],
    this.limitations = const [],
    this.results = const {},
    this.enabled = false,
    this.favorite = false,
    this.approval = 'not_needed',
    this.version = 1,
    this.definition,
  });

  final String id, name, category, engine, origin, family, approval;
  final CheLibraryKind kind;
  final CheLibraryStage stage;
  final String? notRunning;
  final List<CheLibrarySource> sources;
  final List<String> rules, assumptions, dataRequirements, eventDependencies, limitations;
  final List<String> timeframes;
  final Map<String, dynamic> results;
  final bool enabled, favorite;
  final int version;
  final Map<String, dynamic>? definition;

  bool get executable => stage.index >= CheLibraryStage.implemented.index;
  bool get needsApproval => approval == 'pending_owner';
  String get categoryLabel => kCheStrategyCategories[category] ?? category;
  int get backtestTrades => (results['backtest'] is Map ? (results['backtest']['trades'] as num?)?.toInt() : null) ?? 0;
  int get forwardTrades => (results['forward'] is Map ? (results['forward']['trades'] as num?)?.toInt() : null) ?? 0;

  factory CheLibraryEntry.fromJson(Map<String, dynamic> m) {
    List<String> strs(Object? v) => [for (final x in (v as List? ?? const [])) '$x'];
    return CheLibraryEntry(
      id: '${m['id']}',
      kind: m['kind'] == 'market_context' ? CheLibraryKind.marketContext : CheLibraryKind.strategy,
      name: '${m['name'] ?? m['id']}',
      category: '${m['category'] ?? 'other'}',
      stage: CheLibraryStageText.parse(m['lifecycle'] as String?),
      engine: '${m['engine'] ?? 'none'}',
      origin: '${m['origin'] ?? ''}',
      family: '${m['family'] ?? ''}',
      notRunning: m['not_running'] as String?,
      sources: [for (final s in (m['sources'] as List? ?? const [])) if (s is Map) CheLibrarySource.fromJson(s)],
      rules: strs(m['rules']),
      assumptions: strs(m['assumptions']),
      timeframes: strs(m['timeframes']),
      dataRequirements: strs(m['data_requirements']),
      eventDependencies: strs(m['event_dependencies']),
      limitations: strs(m['limitations']),
      results: (m['results'] as Map?)?.cast<String, dynamic>() ?? const {},
      enabled: m['enabled'] == true,
      favorite: m['favorite'] == true,
      approval: '${m['approval'] ?? 'not_needed'}',
      version: (m['version'] as num?)?.toInt() ?? 1,
      definition: (m['definition'] as Map?)?.cast<String, dynamic>(),
    );
  }

  /// The card in plain words, for VoiceOver and Read Aloud.
  String spoken() {
    final b = StringBuffer('$name. ${kind == CheLibraryKind.marketContext ? 'Market-context model' : 'Strategy'}, $categoryLabel. Stage: ${stage.label}, ${stage.meaning}.');
    if (backtestTrades > 0) b.write(' $backtestTrades recorded backtest trades.');
    if (forwardTrades > 0) b.write(' $forwardTrades forward paper trades.');
    if (notRunning != null) b.write(' Not paper trading: $notRunning');
    if (needsApproval) b.write(' Waiting for your approval.');
    if (favorite) b.write(' A favorite.');
    return b.toString();
  }
}

/// The library as one response: entries, the audit counts and the resource budget.
class CheLibraryView {
  CheLibraryView({required this.entries, required this.counts, required this.budget, required this.total});
  final List<CheLibraryEntry> entries;
  final Map<String, dynamic> counts, budget;
  final int total;

  factory CheLibraryView.fromJson(Map<String, dynamic> m) => CheLibraryView(
        entries: [for (final e in (m['entries'] as List? ?? const [])) if (e is Map) CheLibraryEntry.fromJson(e.cast<String, dynamic>())],
        counts: (m['counts'] as Map?)?.cast<String, dynamic>() ?? const {},
        budget: (m['budget'] as Map?)?.cast<String, dynamic>() ?? const {},
        total: (m['total'] as num?)?.toInt() ?? 0,
      );
}

/// The Worker calls. Each returns the Worker's own answer; nothing is assumed to have worked.
class CheStrategyLibraryClient {
  CheStrategyLibraryClient({required this.baseUrl, required this.headers, http.Client? client}) : _http = client ?? http.Client();
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _http;

  Future<CheLibraryView> load({String q = '', String category = '', String kind = '', String lifecycle = ''}) async {
    final uri = Uri.parse('${baseUrl()}/api/trading/library').replace(queryParameters: {
      if (q.isNotEmpty) 'q': q,
      if (category.isNotEmpty) 'category': category,
      if (kind.isNotEmpty) 'kind': kind,
      if (lifecycle.isNotEmpty) 'lifecycle': lifecycle,
    });
    final r = await _http.get(uri, headers: headers()).timeout(const Duration(seconds: 20));
    if (r.statusCode != 200) throw StateError('The strategy library did not load (${r.statusCode}).');
    return CheLibraryView.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  /// enable, disable, favorite, unfavorite, approve, duplicate, register, draft.
  Future<Map<String, dynamic>> act(String action, Map<String, dynamic> body) async {
    final r = await _http
        .post(Uri.parse('${baseUrl()}/api/trading/library/$action'), headers: {...headers(), 'content-type': 'application/json'}, body: jsonEncode(body))
        .timeout(const Duration(seconds: 45));
    final out = (jsonDecode(r.body.isEmpty ? '{}' : r.body) as Map).cast<String, dynamic>();
    return {...out, 'status': r.statusCode};
  }

  /// The approved, enabled definitions the setup engine should follow, as strategies. Invalid ones are skipped
  /// with their reasons, never run.
  Future<({List<CheDslStrategy> strategies, List<String> refused, List<String> pausedBudget})> active() async {
    final r = await _http.get(Uri.parse('${baseUrl()}/api/trading/library/active'), headers: headers()).timeout(const Duration(seconds: 20));
    if (r.statusCode != 200) throw StateError('Active strategies did not load (${r.statusCode}).');
    final m = jsonDecode(r.body) as Map<String, dynamic>;
    final ok = <CheDslStrategy>[], refused = <String>[];
    for (final d in (m['definitions'] as List? ?? const [])) {
      final doc = ((d as Map)['definition'] as Map).cast<String, dynamic>();
      try {
        ok.add(CheDslStrategy.parse(doc));
      } on FormatException catch (e) {
        refused.add('${d['id']}: ${e.message}');
      }
    }
    return (strategies: ok, refused: refused, pausedBudget: [for (final p in (m['paused_budget'] as List? ?? const [])) '$p']);
  }
}
