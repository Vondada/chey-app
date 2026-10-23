// Security Room visibility (owner, 2026-10-23): every count opens exactly the entries behind it, findings open their
// evidence, coverage gaps are named, the physical page is honest, and Knox, the Office Security Chief, has one record.
//
// Everything here renders the Worker's /api/security/core `visibility` and `chief` payloads
// (server/cloudflare/security_visibility.js, security_chief.js). A count is always the length of the list it opens,
// because the Worker builds both from the same array. Nothing here holds a token or credential value.
import 'package:flutter/material.dart';

import '../che_ui/che_screen_awareness.dart';

import '../che_ui/che_chrome_status.dart';
import '../che_ui/che_hud.dart';

List<Map<String, dynamic>> _maps(Object? v) => [for (final e in (v as List? ?? const [])) if (e is Map) Map<String, dynamic>.from(e)];

String _when(Object? at) => at == null || '$at'.isEmpty ? 'no recorded activity' : '$at'.replaceFirst('T', ' ').split('.').first.replaceAll('Z', ' UTC');

/// The status word a record carries, mapped to a chrome tone. Words always travel with the color.
CheStatusTone cheSecurityTone(String? word) {
  final w = (word ?? '').toLowerCase();
  if (const {'high', 'critical', 'failed', 'error', 'excessive'}.contains(w)) return CheStatusTone.failure;
  if (const {'medium', 'open', 'not_checked', 'review', 'needs_reconnect', 'setup_required', 'disconnected', 'not_connected', 'investigating', 'containing'}.contains(w)) return CheStatusTone.warning;
  if (const {'active', 'ready', 'available', 'checked', 'completed', 'recorded', 'connected', 'appropriate', 'resolved', 'secured', 'verified connected', 'supported'}.contains(w)) return CheStatusTone.success;
  if (const {'running', 'working'}.contains(w)) return CheStatusTone.active;
  return CheStatusTone.neutral;
}

String _word(String? s) => (s ?? 'unknown').replaceAll('_', ' ');

/// Spoken control for the Security Room while one of its pages is open, called from the chat send path
/// (lib/home_state/send.dart) before anything else handles the words. A null reply lets the turn continue.
class CheSecurityRoomVoice {
  CheSecurityRoomVoice._();
  static final _stack = <(Object, Future<String?> Function(String))>[];

  static Future<String?> Function(String)? get handler => _stack.isEmpty ? null : _stack.last.$2;

  static Object register(Future<String?> Function(String) h) {
    final token = Object();
    _stack.add((token, h));
    return token;
  }

  static void unregister(Object? token) => _stack.removeWhere((e) => identical(e.$1, token));

  static String _clean(String said) => said.trim().toLowerCase().replaceAll(RegExp(r'[.!?,]+$'), '').replaceFirst(RegExp(r'^(?:(?:hey|ok|okay)\s+)?(?:che|chey|chay)[,\s]+'), '').trim();

  /// "show tools", "open the devices list", "go to permissions" → the category id, or null.
  static String? categoryFor(String said, List<Map<String, dynamic>> cats) {
    final m = RegExp(r'^(?:show|open|go to|list|read)(?: me)?(?: the| my)? (\w+)(?: list| category)?$').firstMatch(_clean(said));
    if (m == null) return null;
    final w = m.group(1)!;
    for (final c in cats) {
      final id = '${c['id']}';
      final title = '${c['title']}'.toLowerCase();
      if (w == id || w == title || '${w}s' == id || w == id.replaceAll(RegExp(r's$'), '')) return id;
    }
    if (w == 'findings') return 'threats';
    if (w == 'access') return 'agents';
    return null;
  }

  static String? searchFor(String said) => RegExp(r'^(?:search|find|filter)(?: for)? (.+)$').firstMatch(_clean(said))?.group(1)?.trim();

  static int? numberFor(String said) {
    final m = RegExp(r'^(?:open|read|expand)(?: number)? (\d+|one|two|three|four|five|six|seven|eight|nine|ten)$').firstMatch(_clean(said));
    if (m == null) return null;
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    final g = m.group(1)!;
    return int.tryParse(g) ?? words.indexOf(g) + 1;
  }

  static bool isReadList(String said) => RegExp(r"^(?:read(?: (?:this|the list|it|them))?(?: aloud)?|what(?:'s| is) (?:on|in) (?:this|the) list)$").hasMatch(_clean(said));

  static bool isClearSearch(String said) => RegExp(r'^(?:clear|cancel|reset)(?: the)? search$').hasMatch(_clean(said));
}

/// One category's exact entries, searchable, with filters to jump between categories.
class CheSecurityCategoryScreen extends StatefulWidget {
  const CheSecurityCategoryScreen({super.key, required this.visibility, required this.initial});
  final Map<String, dynamic> visibility;
  final String initial;

  @override
  State<CheSecurityCategoryScreen> createState() => _CheSecurityCategoryScreenState();
}

class _CheSecurityCategoryScreenState extends State<CheSecurityCategoryScreen> {
  late String _category = widget.initial;
  String _query = '';
  final _search = TextEditingController();
  Object? _voice;
  Object? _aware;

  List<Map<String, dynamic>> get _cats => _maps(widget.visibility['categories']);
  Map<String, dynamic> get _cat => _cats.firstWhere((c) => c['id'] == _category, orElse: () => _cats.isEmpty ? const <String, dynamic>{} : _cats.first);
  List<Map<String, dynamic>> get _shown {
    final items = _maps(_cat['items']);
    final q = _query.trim().toLowerCase();
    return q.isEmpty
        ? items
        : items.where((i) => '${i['name']} ${i['type']} ${i['source']} ${i['status']} ${(i['permission_words'] as List? ?? const []).join(' ')}'.toLowerCase().contains(q)).toList();
  }

  String _spokenList() {
    final shown = _shown;
    if (shown.isEmpty) return '${_cat['title']}: nothing recorded${_query.isEmpty ? '' : ' matching $_query'}.';
    final first = shown.take(10).toList();
    return '${_cat['title']}, ${shown.length}${_query.isEmpty ? '' : ' matching $_query'}: ${[for (final (n, i) in first.indexed) '${n + 1}. ${i['name']}, ${_word('${i['severity'] ?? i['verdict'] ?? i['status']}')}'].join('; ')}.${shown.length > 10 ? ' Say search for a name to narrow the list.' : ''}';
  }

  String _spokenItem(Map<String, dynamic> i) => [
        '${i['name']}, ${i['type']}.',
        if ('${i['plain'] ?? ''}'.isNotEmpty) '${i['plain']}',
        'Source ${i['source']}. Status ${_word('${i['status']}')}. Last activity ${_when(i['last_activity'])}.',
        if ('${i['recommendation'] ?? ''}'.isNotEmpty) 'Recommended: ${i['recommendation']}',
      ].join(' ');

  Future<String?> _onVoice(String said) async {
    final cat = CheSecurityRoomVoice.categoryFor(said, _cats);
    if (cat != null) {
      setState(() { _category = cat; _query = ''; _search.clear(); });
      return _spokenList();
    }
    if (CheSecurityRoomVoice.isClearSearch(said)) {
      setState(() { _query = ''; _search.clear(); });
      return _spokenList();
    }
    final q = CheSecurityRoomVoice.searchFor(said);
    if (q != null) {
      setState(() { _query = q; _search.text = q; });
      return _spokenList();
    }
    final n = CheSecurityRoomVoice.numberFor(said);
    if (n != null) {
      final shown = _shown;
      if (n < 1 || n > shown.length) return 'There is no number $n here; the list has ${shown.length}.';
      return _spokenItem(shown[n - 1]);
    }
    if (CheSecurityRoomVoice.isReadList(said)) return _spokenList();
    return null;
  }

  @override
  void initState() {
    super.initState();
    _voice = CheSecurityRoomVoice.register(_onVoice);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _aware ??= CheScreenAwareness.register(context, () => CheScreenReport(
          page: 'Security',
          tab: '${_cat['title']}',
          tabs: [for (final c in _cats) '${c['title']} ${c['count']}'],
          controls: const ['Search', 'Category filters', 'Each entry expands to its details'],
          detail: '${_shown.length} ${'${_cat['title']}'.toLowerCase()} shown${_query.isEmpty ? '' : ' matching $_query'}. Say show tools, search for a name, read number 2, or read the list',
        ));
  }

  @override
  void dispose() {
    CheSecurityRoomVoice.unregister(_voice);
    CheScreenAwareness.unregister(_aware);
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cats = _cats;
    final cat = _cat;
    final items = _maps(cat['items']);
    final q = _query.trim().toLowerCase();
    final shown = _shown;
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: Text('${cat['title'] ?? 'Security'} (${cat['count'] ?? items.length})')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 24), children: [
        TextField(
          controller: _search,
          decoration: const InputDecoration(labelText: 'Search', prefixIcon: Icon(Icons.search_rounded)),
          onChanged: (v) => setState(() => _query = v),
        ),
        const SizedBox(height: 8),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final c in cats)
            ChoiceChip(
              label: Text('${c['title']} ${c['count']}'),
              selected: c['id'] == _category,
              onSelected: (_) => setState(() => _category = '${c['id']}'),
            ),
        ]),
        const SizedBox(height: 8),
        Semantics(
          liveRegion: false,
          child: Text(q.isEmpty ? 'Showing all ${items.length} ${'${cat['title'] ?? ''}'.toLowerCase()}.' : 'Showing ${shown.length} of ${items.length} matching "$_query".', style: text.bodyMedium),
        ),
        if (shown.isEmpty) Padding(padding: const EdgeInsets.only(top: 16), child: Text('Nothing recorded here.', style: text.bodyLarge)),
        for (final i in shown) CheSecurityItemTile(item: i),
      ]),
    );
  }
}

/// One entry: compact first, details when expanded.
class CheSecurityItemTile extends StatelessWidget {
  const CheSecurityItemTile({super.key, required this.item});
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final status = '${item['severity'] ?? item['verdict'] ?? item['status'] ?? 'unknown'}';
    final words = [for (final w in (item['permission_words'] as List? ?? const [])) '$w'];
    final evidence = item['evidence'] is Map ? Map<String, dynamic>.from(item['evidence'] as Map) : null;
    final spoken = '${item['name']}, ${item['type']}, ${_word(status)}. Last activity ${_when(item['last_activity'])}.';
    return Semantics(
      container: true,
      label: spoken,
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        title: ExcludeSemantics(child: Text('${item['name']}', maxLines: 2, overflow: TextOverflow.ellipsis)),
        subtitle: ExcludeSemantics(child: Text('${item['type']} · ${_when(item['last_activity'])}', maxLines: 2, overflow: TextOverflow.ellipsis)),
        trailing: ExcludeSemantics(child: CheStatusPill(label: _word(status), tone: cheSecurityTone(status), compact: true)),
        childrenPadding: const EdgeInsets.only(bottom: 12),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if ('${item['plain'] ?? ''}'.isNotEmpty) Text('${item['plain']}', style: text.bodyLarge),
          if (words.isNotEmpty) Text('Can: ${words.join('; ')}', style: text.bodyMedium),
          Text('Source: ${item['source']}', style: text.bodyMedium),
          Text('Status: ${_word('${item['status']}')}', style: text.bodyMedium),
          if ('${item['detail'] ?? ''}'.isNotEmpty) Text('${item['detail']}', style: text.bodyMedium),
          if (evidence != null) ...[
            const SizedBox(height: 6),
            Text('Evidence', style: text.titleSmall),
            for (final e in evidence.entries)
              if (e.value != null && '${e.value}' != '[]' && '${e.value}'.isNotEmpty) Text('${_word(e.key)}: ${e.value is List ? (e.value as List).join(', ') : e.value}', style: text.bodyMedium),
          ],
          if ('${item['recommendation'] ?? ''}'.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text('Recommended: ${item['recommendation']}', style: text.bodyLarge),
          ],
        ],
      ),
    );
  }
}

/// The counts, every one tappable. Two or more per row as width allows; 48-point targets.
class CheSecurityCounts extends StatelessWidget {
  const CheSecurityCounts({super.key, required this.visibility, required this.onOpen});
  final Map<String, dynamic> visibility;
  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    final cats = _maps(visibility['categories']);
    return LayoutBuilder(builder: (context, box) {
      final perRow = box.maxWidth >= 900 ? 4 : box.maxWidth >= 520 ? 3 : 2;
      final w = (box.maxWidth - (perRow - 1) * 8) / perRow;
      return Wrap(spacing: 8, runSpacing: 8, children: [
        for (final c in cats)
          SizedBox(
            width: w,
            child: Semantics(
              button: true,
              label: '${c['title']}, ${c['count']}. Opens the list.',
              child: ExcludeSemantics(
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(56), alignment: Alignment.centerLeft, padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8)),
                  onPressed: () => onOpen('${c['id']}'),
                  child: Row(children: [
                    Expanded(child: Text('${c['title']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheHud.label.copyWith(fontSize: 12))),
                    Text('${c['count']}', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontFeatures: const [FontFeature.tabularFigures()])),
                  ]),
                ),
              ),
            ),
          ),
      ]);
    });
  }
}

/// What was checked, when, and what was not. Zero findings never reads as all-clear unless every check ran.
class CheSecurityCoverageCard extends StatelessWidget {
  const CheSecurityCoverageCard({super.key, required this.coverage});
  final Map<String, dynamic> coverage;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final checks = _maps(coverage['checks']);
    String word(Map<String, dynamic> c) => c['stale'] == true ? 'stale' : _word('${c['state']}');
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(header: true, child: Text('Coverage', style: text.titleLarge)),
          Semantics(container: true, label: '${coverage['summary']}', child: ExcludeSemantics(child: Text('${coverage['summary'] ?? ''}', style: text.bodyLarge))),
          const SizedBox(height: 6),
          for (final c in checks)
            Semantics(
              container: true,
              label: '${c['label']}: ${word(c)}${c['at'] != null ? ', ${_when(c['at'])}' : ''}${c['why'] != null ? '. ${c['why']}' : ''}',
              child: ExcludeSemantics(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    CheStatusPill(label: word(c), tone: c['stale'] == true ? CheStatusTone.warning : cheSecurityTone('${c['state']}'), compact: true),
                    const SizedBox(width: 8),
                    Expanded(child: Text('${c['label']}${c['at'] != null ? ' · ${_when(c['at'])}' : ''}${c['why'] != null ? '\n${c['why']}' : ''}', style: text.bodyMedium)),
                  ]),
                ),
              ),
            ),
        ]),
      ),
    );
  }
}

/// Knox, the Office Security Chief: identity, chain of command, specialists, configured permissions apart from
/// verified checks, status and recent verified activity. Tapping the name opens Knox's Office desk (same record).
class CheSecurityChiefCard extends StatelessWidget {
  const CheSecurityChiefCard({super.key, required this.chief, this.onOpenAgent});
  final Map<String, dynamic> chief;
  final ValueChanged<String>? onOpenAgent;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final name = '${chief['name'] ?? 'Knox'}';
    final status = Map<String, dynamic>.from(chief['status'] as Map? ?? const {});
    final configured = _maps(chief['permissions_configured']);
    final verified = _maps(chief['integrations_verified']);
    final activity = _maps(chief['recent_verified_activity']);
    final specialists = _maps(chief['specialists']);
    final chain = [for (final c in (chief['chain'] as List? ?? const [])) '$c'];
    final state = '${status['state'] ?? 'UNKNOWN'}';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(
            button: onOpenAgent != null,
            label: '$name, ${chief['title']}, reports to ${chief['supervisor']}. Status ${state.toLowerCase()}. ${onOpenAgent != null ? 'Opens $name\'s Office desk.' : ''}',
            child: ExcludeSemantics(
              child: InkWell(
                onTap: onOpenAgent == null ? null : () => onOpenAgent!(name),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 48),
                  child: Row(children: [
                    const Icon(Icons.security_rounded, size: 32),
                    const SizedBox(width: 10),
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      CheChromeText(name, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700)),
                      Text('${chief['title']} · reports to ${chief['supervisor']}', style: CheHud.label.copyWith(fontSize: 11), maxLines: 2, overflow: TextOverflow.ellipsis),
                    ])),
                    CheStatusPill(label: state.toLowerCase(), tone: cheSecurityTone(state), compact: true),
                  ]),
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Semantics(container: true, label: 'Chain of command: ${chain.join(', then ')}.', child: ExcludeSemantics(child: Text(chain.join('  →  '), style: text.bodyLarge))),
          if ('${chief['personality'] ?? ''}'.isNotEmpty) Text('${chief['personality']}', style: text.bodyMedium),
          if (chief['on_roster'] != true && '${chief['roster_note'] ?? ''}'.isNotEmpty) Text('${chief['roster_note']}', style: text.bodyMedium),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text('Responsibilities and ${specialists.length} specialists'),
            expandedCrossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final r in (chief['responsibilities'] as List? ?? const [])) Text('• $r', style: text.bodyMedium),
              const SizedBox(height: 6),
              for (final s in specialists) Text('${s['name']} · reports to $name', style: text.bodyMedium),
              const SizedBox(height: 6),
              for (final c in (chief['conduct'] as List? ?? const [])) Text('$c', style: text.bodySmall),
            ],
          ),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text('Permissions: ${configured.length} configured, ${verified.length} verified working'),
            expandedCrossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('CONFIGURED (granted in the access registry)', style: CheHud.label.copyWith(fontSize: 11)),
              for (final p in configured) Text('• ${p['words']}', style: text.bodyMedium),
              const SizedBox(height: 6),
              Text('VERIFIED (checks that actually ran)', style: CheHud.label.copyWith(fontSize: 11)),
              if (verified.isEmpty) Text('None yet. Run a security check.', style: text.bodyMedium),
              for (final v in verified) Text('• ${v['label']} · ${_when(v['at'])}', style: text.bodyMedium),
            ],
          ),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text('Recent verified activity (${activity.length})'),
            expandedCrossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (activity.isEmpty) Text('No recorded activity yet.', style: text.bodyMedium),
              for (final a in activity) Text('${_when(a['at'])} · ${a['text']}', style: text.bodyMedium),
            ],
          ),
        ]),
      ),
    );
  }
}

/// Physical Security connections: honest about what exists. Nothing reads connected without a recorded handshake.
class CheSecurityPhysicalScreen extends StatelessWidget {
  const CheSecurityPhysicalScreen({super.key, required this.physical});
  final Map<String, dynamic> physical;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final devices = _maps(physical['devices']);
    final candidates = _maps(physical['candidates']);
    return Scaffold(
      appBar: AppBar(title: const Text('Physical Security')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 24), children: [
        Semantics(header: true, child: CheChromeText('${physical['headline'] ?? 'No supported integrations yet'}', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700), maxLines: 2)),
        if ('${physical['note'] ?? ''}'.isNotEmpty) Text('${physical['note']}', style: text.bodyLarge),
        const SizedBox(height: 12),
        Text('Your devices (${devices.length})', style: text.titleMedium),
        if (devices.isEmpty) Text('No camera, lock, alarm or sensor is connected.', style: text.bodyLarge),
        for (final d in devices)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text('${d['name']}'),
            subtitle: Text(_word('${d['device_class']}')),
            trailing: CheStatusPill(label: '${d['status_word']}', tone: cheSecurityTone('${d['status_word']}'.toLowerCase()), compact: true, uppercase: false),
          ),
        const SizedBox(height: 12),
        Text('Researched platforms (${candidates.length})', style: text.titleMedium),
        Text('Each has an official API. None is integrated yet, so each is Unsupported until an adapter completes a real handshake.', style: text.bodyMedium),
        for (final c in candidates)
          Semantics(
            container: true,
            label: '${c['name']}. ${c['status_word']}. ${c['api']}. Source ${c['source']}.',
            child: ExcludeSemantics(
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('${c['name']}'),
                subtitle: SelectableText('${c['api']}\n${c['source']}'),
                trailing: CheStatusPill(label: '${c['status_word']}', tone: cheSecurityTone('${c['status']}'), compact: true, uppercase: false),
              ),
            ),
          ),
        const SizedBox(height: 12),
        Text('Rules', style: text.titleMedium),
        for (final r in (physical['rules'] as List? ?? const [])) Text('• $r', style: text.bodyMedium),
      ]),
    );
  }
}
