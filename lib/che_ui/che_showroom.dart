// CHE's Capability Showroom (owner addendum, 2026-10-22): six categories of what CHE can create, each capability with its
// real readiness. Every value comes from GET /api/showroom (server/cloudflare/capability_showroom.js, which reads the
// command catalog). Nothing here decides readiness. A picture is labelled "Concept example" unless it is a real saved output.
// Status is written as text on every card, never by colour alone. Nothing speaks on load (owner rule, 2026-10-11).
import 'package:flutter/material.dart';

import 'che_theme.dart';

/// One capability card, read from the showroom JSON. Missing fields read as empty, never as invented values.
class CheShowroomItem {
  const CheShowroomItem(this.json);

  final Map<String, dynamic> json;

  String get id => '${json['id'] ?? ''}';
  String get title => '${json['title'] ?? 'Capability'}';
  String get description => '${json['description'] ?? ''}';
  String get example => '${json['example'] ?? ''}';
  String get output => '${json['output'] ?? ''}';
  String get state => '${json['state'] ?? 'planned'}';
  String get statusLabel => '${json['status_label'] ?? 'Planned'}';
  String get reason => '${json['reason'] ?? ''}';
  String get start => '${json['start'] ?? ''}';
  String get thumbnailNote => '${json['thumbnail_note'] ?? 'Concept example: an illustration.'}';
  bool get isReal => json['thumbnail'] == 'real';
  Map<String, dynamic>? get recent => json['recent_project'] is Map ? Map<String, dynamic>.from(json['recent_project']) : null;
  List<String> get missing => json['missing'] is List ? [for (final m in json['missing'] as List) '$m'] : const [];
}

class CheShowroomCategory {
  const CheShowroomCategory(this.json);

  final Map<String, dynamic> json;

  String get id => '${json['id'] ?? ''}';
  String get title => '${json['title'] ?? ''}';
  String get summary => '${json['summary'] ?? ''}';
  int get number => (json['number'] as num?)?.toInt() ?? 0;
  List<CheShowroomItem> get items => [
        for (final c in (json['capabilities'] as List? ?? const [])) if (c is Map) CheShowroomItem(Map<String, dynamic>.from(c)),
      ];

  /// "2 ready, 3 partial": the counts by state, in words.
  String countLine() {
    final counts = <String, int>{};
    for (final item in items) {
      counts[item.statusLabel] = (counts[item.statusLabel] ?? 0) + 1;
    }
    return counts.entries.map((e) => '${e.value} ${e.key.toLowerCase()}').join(', ');
  }
}

/// The filters the owner can choose, in words. "All" is the default.
const cheShowroomFilters = ['All', 'Ready', 'Partial', 'Needs setup', 'Unavailable', 'Planned'];

/// Whether a card passes the search text and the status filter. Pure, so it can be tested.
bool cheShowroomMatches(CheShowroomItem item, {String query = '', String filter = 'All'}) {
  if (filter != 'All' && item.statusLabel != filter) return false;
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  return '${item.title} ${item.description} ${item.example} ${item.statusLabel}'.toLowerCase().contains(q);
}

class CheShowroomPage extends StatefulWidget {
  const CheShowroomPage({super.key, required this.load, required this.onStart, this.onOpenRecent});

  /// Loads the showroom JSON. The app passes GET /api/showroom with the owner's device token.
  final Future<Map<String, dynamic>> Function() load;

  /// "Create your own / Start": sends the card's starting request to CHE's chat.
  final void Function(String prompt) onStart;

  /// "Open example" when the card has a real saved output: opens that record (kind: invention, video or image).
  final void Function(Map<String, dynamic> recent)? onOpenRecent;

  static Route<void> route({
    required Future<Map<String, dynamic>> Function() load,
    required void Function(String prompt) onStart,
    void Function(Map<String, dynamic> recent)? onOpenRecent,
  }) =>
      MaterialPageRoute<void>(
        builder: (_) => CheShowroomPage(load: load, onStart: onStart, onOpenRecent: onOpenRecent),
      );

  @override
  State<CheShowroomPage> createState() => _CheShowroomPageState();
}

class _CheShowroomPageState extends State<CheShowroomPage> {
  List<CheShowroomCategory> _categories = const [];
  String _error = '';
  bool _loading = true;
  String _query = '';
  String _filter = 'All';
  CheShowroomCategory? _open;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final json = await widget.load();
      if (!mounted) return;
      setState(() {
        _categories = [for (final c in (json['categories'] as List? ?? const [])) if (c is Map) CheShowroomCategory(Map<String, dynamic>.from(c))];
        _error = '';
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'I could not load the Capability Showroom. Check the connection and try again.';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final open = _open;
    return Scaffold(
      appBar: AppBar(
        title: Text(open?.title ?? 'Capability Showroom'),
        leading: open == null
            ? null
            : IconButton(
                tooltip: 'Back to categories',
                icon: const Icon(Icons.arrow_back),
                onPressed: () => setState(() => _open = null),
              ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error.isNotEmpty
              ? Padding(padding: const EdgeInsets.all(CheSpace.gutter), child: Text(_error))
              : open == null
                  ? _categoryList()
                  : _capabilityList(open),
    );
  }

  Widget _categoryList() => ListView(
        padding: const EdgeInsets.all(CheSpace.gutter),
        children: [
          Semantics(
            label: 'Search capabilities',
            textField: true,
            child: TextField(
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search what CHE can do'),
              onChanged: (value) => setState(() => _query = value),
            ),
          ),
          const SizedBox(height: CheSpace.md),
          for (final category in _categories)
            _CategoryCard(
              category: category,
              onTap: () => setState(() => _open = category),
            ),
        ],
      );

  Widget _capabilityList(CheShowroomCategory category) {
    final items = category.items.where((item) => cheShowroomMatches(item, query: _query, filter: _filter)).toList();
    return ListView(
      padding: const EdgeInsets.all(CheSpace.gutter),
      children: [
        Text(category.summary),
        const SizedBox(height: CheSpace.sm),
        Wrap(
          spacing: CheSpace.sm,
          children: [
            for (final filter in cheShowroomFilters)
              ChoiceChip(
                label: Text(filter),
                selected: _filter == filter,
                onSelected: (_) => setState(() => _filter = filter),
              ),
          ],
        ),
        const SizedBox(height: CheSpace.md),
        if (items.isEmpty) const Text('No capability matches that search and filter.'),
        for (final item in items)
          _CapabilityCard(
            item: item,
            onStart: item.start.isEmpty ? null : () => widget.onStart(item.start),
            onOpen: item.recent == null || widget.onOpenRecent == null ? null : () => widget.onOpenRecent!(item.recent!),
          ),
      ],
    );
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard({required this.category, required this.onTap});

  final CheShowroomCategory category;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: '${category.number}. ${category.title}. ${category.summary} ${category.countLine()}.',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.only(bottom: CheSpace.md),
        child: Material(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.lg),
          child: InkWell(
            borderRadius: BorderRadius.circular(CheRadius.lg),
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 72),
              child: Padding(
                padding: const EdgeInsets.all(CheSpace.lg),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${category.number}. ${category.title}', style: CheType.title),
                    const SizedBox(height: CheSpace.xs),
                    Text(category.summary),
                    const SizedBox(height: CheSpace.xs),
                    Text(category.countLine(), style: CheType.caption),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _CapabilityCard extends StatelessWidget {
  const _CapabilityCard({required this.item, this.onStart, this.onOpen});

  final CheShowroomItem item;
  final VoidCallback? onStart;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final picture = item.isReal ? 'Real saved output' : 'Concept example';
    return Semantics(
      container: true,
      label: '${item.title}. ${item.statusLabel}. $picture. ${item.description}',
      child: Padding(
        padding: const EdgeInsets.only(bottom: CheSpace.md),
        child: Container(
          padding: const EdgeInsets.all(CheSpace.lg),
          decoration: BoxDecoration(
            color: CheColors.surface,
            borderRadius: BorderRadius.circular(CheRadius.lg),
            border: Border.all(color: CheColors.accent.withValues(alpha: 0.18)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Expanded(child: Text(item.title, style: CheType.title)),
                Text(item.statusLabel, style: const TextStyle(fontWeight: FontWeight.w700)),
              ]),
              const SizedBox(height: CheSpace.xs),
              // The picture is named in words: a real output, or an illustration.
              Text(item.isReal ? 'Real saved output' : item.thumbnailNote, style: CheType.caption),
              const SizedBox(height: CheSpace.sm),
              Text(item.description),
              if (item.example.isNotEmpty) Text('Example: ${item.example}'),
              if (item.output.isNotEmpty) Text('Output: ${item.output}'),
              if (item.reason.isNotEmpty) Text('Why: ${item.reason}'),
              if (item.missing.isNotEmpty) Text('Needs: ${item.missing.join(', ')}'),
              const SizedBox(height: CheSpace.sm),
              Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.xs, children: [
                if (onOpen != null)
                  OutlinedButton(
                    style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
                    onPressed: onOpen,
                    child: const Text('Open example'),
                  ),
                if (onStart != null)
                  FilledButton(
                    style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
                    onPressed: onStart,
                    child: const Text('Create your own'),
                  ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
