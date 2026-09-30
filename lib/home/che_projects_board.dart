// Live Projects / Businesses board — Creator Studio projects, Office goals,
// Iris/scout shortlists, pipeline deals, War Room meetings. Progress is
// derived from Worker state/jobs only (never invented).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../agents/che_agent_runtime.dart' show CheMeetingSummary;
import '../che_ui/che_theme.dart';
import '../che_ui/che_voice_actions.dart';
import '../che_ui/che_widgets.dart';
import '../widgets/che_3d_room_view.dart';

enum CheBoardKind { project, goal, scout, deal, meeting }

class CheBoardItem {
  const CheBoardItem({
    required this.id,
    required this.title,
    required this.kind,
    required this.typeLabel,
    required this.statusLabel,
    required this.progress,
    this.subtitle = '',
    this.url,
    this.raw = const {},
    this.tasks = const [],
    this.confirmRequired = false,
    this.metrics,
  });

  final String id;
  final String title;
  final CheBoardKind kind;
  final String typeLabel;
  final String statusLabel;
  final double progress; // 0..1 from real Worker data
  final String subtitle;
  final String? url;
  final Map<String, dynamic> raw;
  final List<String> tasks;
  final bool confirmRequired;
  final Map<String, dynamic>? metrics;
}

/// Merge projects, office goals (+ jobs), scouts, pipeline deals, meetings.
List<CheBoardItem> cheBuildBoardItems({
  required List<Map<String, dynamic>> projects,
  required List<Map<String, dynamic>> officeGoals,
  required List<Map<String, dynamic>> jobs,
  required List<Map<String, dynamic>> opportunityScouts,
  required List<Map<String, dynamic>> deals,
  List<CheMeetingSummary> meetings = const [],
  String? worldUrl,
}) {
  final byId = {for (final j in jobs) '${j['id']}': j};
  final items = <CheBoardItem>[];

  for (final p in projects) {
    final type = '${p['type'] ?? 'general'}';
    final status = '${p['status'] ?? 'new'}';
    final url = _firstUrl('${p['url'] ?? ''}${p['preview_url'] ?? ''}\n${p['content'] ?? ''}\n${p['brief'] ?? ''}')
        ?? (type == 'app' || type.startsWith('roblox') ? worldUrl : null);
    items.add(CheBoardItem(
      id: '${p['id']}',
      title: '${p['title'] ?? 'Untitled project'}',
      kind: CheBoardKind.project,
      typeLabel: _projectTypeLabel(type),
      statusLabel: status,
      progress: _projectProgress(status, type),
      subtitle: '${p['brief'] ?? ''}'.trim(),
      url: url,
      raw: p,
      confirmRequired: type.startsWith('roblox'),
      metrics: p['metrics'] is Map ? Map<String, dynamic>.from(p['metrics'] as Map) : null,
    ));
  }

  for (final g in officeGoals.reversed) {
    final ids = [for (final id in (g['job_ids'] as List? ?? const [])) '$id'];
    final linked = [for (final id in ids) if (byId[id] != null) byId[id]!];
    final progress = _jobsProgress(linked);
    final status = _jobsStatusLabel(linked);
    final goal = '${g['goal'] ?? 'Office goal'}';
    final kind = '${g['kind'] ?? ''}';
    items.add(CheBoardItem(
      id: '${g['id']}',
      title: goal,
      kind: CheBoardKind.goal,
      typeLabel: kind.contains('scout')
          ? 'Opportunity scout'
          : kind.contains('ml') || kind == 'ml_eval' || kind == 'ml_studio'
              ? (kind.contains('cluster') || '${g['ml_kind']}'.contains('cluster') ? 'ML · Clustering' : 'ML · Classification')
              : kind.contains('translat')
                  ? 'Translation'
                  : _goalLooksRoblox(goal)
                      ? 'Roblox / Office'
                      : 'Office goal',
      statusLabel: status,
      progress: progress,
      subtitle: linked.isEmpty
          ? 'Queued on the Office'
          : '${linked.length} jobs · ${linked.map((j) => j['agent'] ?? '?').join(', ')}',
      raw: g,
      tasks: [
        for (final j in linked)
          '${j['agent'] ?? 'Agent'}: ${j['task'] ?? j['status'] ?? ''}${j['blocker'] != null ? ' — ${j['blocker']}' : ''}',
      ],
      confirmRequired: g['owner_confirm_required'] == true || _goalLooksRoblox(goal),
      metrics: g['metrics'] is Map ? Map<String, dynamic>.from(g['metrics'] as Map) : null,
    ));
  }

  for (final s in opportunityScouts.reversed) {
    final opps = (s['opportunities'] as List? ?? const []);
    final ids = [for (final id in (s['job_ids'] as List? ?? const [])) '$id'];
    final linked = [for (final id in ids) if (byId[id] != null) byId[id]!];
    final url = opps.isNotEmpty
        ? _firstUrl('${opps.first is Map ? (opps.first as Map)['url'] ?? '' : ''}')
        : null;
    items.add(CheBoardItem(
      id: '${s['id'] ?? s['query']}',
      title: '${s['title'] ?? 'Opportunity scout'}',
      kind: CheBoardKind.scout,
      typeLabel: 'Iris / scout · ${s['channel'] ?? 'multi'}',
      statusLabel: opps.isEmpty ? _jobsStatusLabel(linked) : '${opps.length} shortlisted',
      progress: opps.isNotEmpty ? 0.7 : _jobsProgress(linked),
      subtitle: '${s['query'] ?? ''}',
      url: url,
      raw: s,
      tasks: [
        for (final o in opps.take(5))
          o is Map
              ? '${o['offer'] ?? o['title'] ?? 'Lead'}${o['url'] != null ? ' · ${o['url']}' : ''}'
              : '$o',
      ],
      confirmRequired: true,
    ));
  }

  for (final d in deals) {
    final stage = '${d['stage'] ?? 'lead'}';
    items.add(CheBoardItem(
      id: '${d['id']}',
      title: '${d['client_name'] ?? d['client'] ?? 'Deal'}',
      kind: CheBoardKind.deal,
      typeLabel: 'Business / pipeline',
      statusLabel: stage,
      progress: _dealProgress(stage),
      subtitle: '${d['need'] ?? d['notes'] ?? ''}',
      url: _firstUrl('${d['url'] ?? ''}'),
      raw: d,
      confirmRequired: true,
    ));
  }

  for (final m in meetings) {
    items.add(CheBoardItem(
      id: m.id,
      title: m.objective,
      kind: CheBoardKind.meeting,
      typeLabel: 'War Room',
      statusLabel: m.statusLabel,
      progress: m.progress.clamp(0.0, 1.0),
      subtitle: m.participantNames.join(', '),
      raw: {'id': m.id, 'status': m.status},
    ));
  }

  return items;
}

bool _goalLooksRoblox(String goal) {
  final t = goal.toLowerCase();
  return t.contains('roblox') ||
      t.contains('luau') ||
      t.contains('ugc') ||
      t.contains('game pass') ||
      (t.contains('avatar') && t.contains('clothing'));
}

String _projectTypeLabel(String type) {
  final t = type.toLowerCase();
  return switch (t) {
    'website' || 'site' => 'Website',
    'app' => 'App',
    'book' => 'Book',
    'screenplay' => 'Screenplay',
    'invention' => 'Invention',
    'business' => 'Business',
    'roblox' || 'roblox_game' => 'Roblox · Game',
    'roblox_weapon' => 'Roblox · Weapon',
    'roblox_clothing' || 'roblox_ugc' || 'roblox_avatar' => 'Roblox · Clothing / UGC',
    'roblox_pass' => 'Roblox · Game Pass',
    'ml_classification' => 'ML · Classification',
    'ml_clustering' => 'ML · Clustering',
    'translate' || 'translation' => 'Translation',
    _ => type.isEmpty ? 'Project' : type,
  };
}

double _projectProgress(String status, String type) {
  final s = status.toLowerCase();
  if (s.contains('done') || s.contains('ship') || s.contains('complete') || s == 'live') return 1;
  if (s.contains('review') || s.contains('publish')) return 0.85;
  if (s.contains('draft') || s.contains('build') || s.contains('progress')) return 0.55;
  if (s == 'new' || s.isEmpty) return type.startsWith('roblox') ? 0.08 : 0.12;
  return 0.35;
}

double _jobsProgress(List<Map<String, dynamic>> jobs) {
  if (jobs.isEmpty) return 0.05;
  double score(String status) {
    final s = status.toLowerCase();
    if (s.contains('complete') || s == 'done' || s == 'finished') return 1;
    if (s.contains('review')) return 0.75;
    if (s.contains('running') || s.contains('working')) return 0.45;
    if (s.contains('blocked') || s.contains('failed')) return 0.2;
    if (s.contains('queued')) return 0.1;
    return 0.3;
  }
  var sum = 0.0;
  for (final j in jobs) {
    sum += score('${j['status'] ?? ''}');
  }
  return (sum / jobs.length).clamp(0.0, 1.0);
}

String _jobsStatusLabel(List<Map<String, dynamic>> jobs) {
  if (jobs.isEmpty) return 'Queued';
  final running = jobs.where((j) {
    final s = '${j['status']}'.toLowerCase();
    return s.contains('running') || s.contains('review') || s.contains('queued');
  }).length;
  final done = jobs.where((j) => '${j['status']}'.toLowerCase().contains('complete')).length;
  final blocked = jobs.where((j) {
    final s = '${j['status']}'.toLowerCase();
    return s.contains('blocked') || s.contains('fail') || j['blocker'] != null;
  }).length;
  if (blocked > 0) return 'Blocked · $blocked';
  if (done == jobs.length) return 'Complete';
  if (running > 0) return 'In progress · $done/${jobs.length}';
  return '$done/${jobs.length} done';
}

double _dealProgress(String stage) {
  return switch (stage.toLowerCase()) {
    'lead' => 0.1,
    'qualified' => 0.25,
    'proposal' => 0.45,
    'approved' => 0.55,
    'build' || 'building' => 0.7,
    'review' => 0.85,
    'invoiced' || 'paid' || 'won' => 1.0,
    'lost' => 0.0,
    _ => 0.2,
  };
}

final _urlRe = RegExp(r'https?://[^\s<>\[\]()]+', caseSensitive: false);

String? _firstUrl(String text) {
  final m = _urlRe.firstMatch(text);
  if (m == null) return null;
  return m.group(0)?.replaceAll(RegExp(r'[.,;]+$'), '');
}

String _formatMetrics(Map<String, dynamic> m) {
  final task = '${m['task'] ?? ''}';
  if (task == 'classification' || m.containsKey('accuracy')) {
    final acc = ((m['accuracy'] as num?)?.toDouble() ?? 0) * 100;
    final f1 = ((m['macro_f1'] as num?)?.toDouble() ?? 0) * 100;
    final p = ((m['macro_precision'] as num?)?.toDouble() ?? 0) * 100;
    final r = ((m['macro_recall'] as num?)?.toDouble() ?? 0) * 100;
    return 'Accuracy ${acc.toStringAsFixed(1)}% · Macro F1 ${f1.toStringAsFixed(1)}%\n'
        'Precision ${p.toStringAsFixed(1)}% · Recall ${r.toStringAsFixed(1)}% · n=${m['n'] ?? '?'}';
  }
  if (task == 'clustering' || m.containsKey('silhouette')) {
    final sil = (m['silhouette'] as num?)?.toDouble() ?? 0;
    final cm = m['confusion_matrix'];
    final cmLine = cm is Map && cm['summary'] != null ? '\nConfusion: ${cm['summary']}' : '';
    return 'k=${m['k'] ?? '?'} · Silhouette ${sil.toStringAsFixed(3)} · Inertia ${m['inertia'] ?? '?'} · n=${m['n'] ?? '?'}$cmLine';
  }
  if (m['available'] == true || m.containsKey('token_f1') || m.containsKey('chrf')) {
    final f1 = ((m['token_f1'] as num?) ?? (m['f1'] as num?) ?? 0).toDouble() * 100;
    final summary = '${m['summary'] ?? ''}';
    return summary.isNotEmpty ? summary : 'Translation quality · Token F1 ${f1.toStringAsFixed(1)}%';
  }
  if (m.containsKey('confusion_matrix')) {
    final cm = m['confusion_matrix'];
    final summary = cm is Map ? '${cm['summary'] ?? ''}' : '';
    final acc = ((m['accuracy'] as num?)?.toDouble() ?? 0) * 100;
    return 'Accuracy ${acc.toStringAsFixed(1)}%${summary.isNotEmpty ? ' · $summary' : ''}';
  }
  return m.entries.take(8).map((e) => '${e.key}: ${e.value}').join('\n');
}

/// Live Projects / Businesses screen (mockup Projects + War Room active list).
class CheProjectsBoard extends StatefulWidget {
  const CheProjectsBoard({
    super.key,
    required this.items,
    this.onRefresh,
    this.onCreateProject,
    this.onAskChe,
    this.onOpenWarRoom,
    this.embedded = false,
  });

  final List<CheBoardItem> items;
  final Future<void> Function()? onRefresh;
  final VoidCallback? onCreateProject;
  final void Function(String prompt)? onAskChe;
  final VoidCallback? onOpenWarRoom;
  final bool embedded;

  @override
  State<CheProjectsBoard> createState() => _CheProjectsBoardState();
}

class _CheProjectsBoardState extends State<CheProjectsBoard> {
  String _filter = 'All';

  static const _filters = [
    'All',
    'Apps',
    'Web',
    'Business',
    'Roblox',
    'ML',
    'Goals',
    'War Room',
  ];

  List<CheBoardItem> get _filtered {
    bool match(CheBoardItem i) {
      final t = i.typeLabel.toLowerCase();
      return switch (_filter) {
        'Apps' => t.contains('app') && !t.contains('roblox'),
        'Web' => t.contains('website') || t.contains('web'),
        'Business' => t.contains('business') || i.kind == CheBoardKind.deal || i.kind == CheBoardKind.scout,
        'Roblox' => t.contains('roblox') || t.contains('ugc') || t.contains('game pass'),
        'ML' => t.contains('ml') || t.contains('classif') || t.contains('cluster') || (i.metrics != null && i.metrics!.isNotEmpty),
        'Goals' => i.kind == CheBoardKind.goal,
        'War Room' => i.kind == CheBoardKind.meeting,
        _ => true,
      };
    }
    return [for (final i in widget.items) if (match(i)) i];
  }

  Future<void> _openUrl(String? url) async {
    if (url == null || url.isEmpty) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    HapticFeedback.selectionClick();
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  void _openDetail(CheBoardItem item) {
    HapticFeedback.selectionClick();
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: CheColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl)),
      ),
      builder: (ctx) {
        final bottom = MediaQuery.viewPaddingOf(ctx).bottom;
        return Padding(
          padding: EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.lg, CheSpace.gutter, CheSpace.xl + bottom),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(item.title, style: CheType.title),
                const SizedBox(height: 4),
                Text('${item.typeLabel} · ${item.statusLabel}', style: CheType.caption.copyWith(color: CheColors.accent)),
                const SizedBox(height: CheSpace.md),
                _ProgressBar(value: item.progress, label: '${(item.progress * 100).round()}%'),
                if (item.subtitle.trim().isNotEmpty) ...[
                  const SizedBox(height: CheSpace.md),
                  Text(item.subtitle, style: CheType.bodyDim),
                ],
                if (item.confirmRequired) ...[
                  const SizedBox(height: CheSpace.md),
                  Container(
                    padding: const EdgeInsets.all(CheSpace.md),
                    decoration: BoxDecoration(
                      color: CheColors.warning.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(CheRadius.md),
                      border: Border.all(color: CheColors.warning.withValues(alpha: 0.5)),
                    ),
                    child: Text(
                      'Owner confirm required before publish, spend, Roblox upload, or outreach.',
                      style: CheType.caption.copyWith(color: CheColors.warning),
                    ),
                  ),
                ],
                if (item.metrics != null && item.metrics!.isNotEmpty) ...[
                  const SizedBox(height: CheSpace.lg),
                  Text('EVAL METRICS', style: CheType.overline.copyWith(color: CheColors.accent)),
                  const SizedBox(height: CheSpace.sm),
                  Text(_formatMetrics(item.metrics!), style: CheType.body),
                ],
                if (item.tasks.isNotEmpty) ...[
                  const SizedBox(height: CheSpace.lg),
                  Text('LIVE TASKS', style: CheType.overline.copyWith(color: CheColors.accent)),
                  const SizedBox(height: CheSpace.sm),
                  for (final t in item.tasks)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Text('• $t', style: CheType.body),
                    ),
                ],
                const SizedBox(height: CheSpace.lg),
                CheVoiceActionList(
                  actions: [
                    if (item.url != null)
                      CheVoiceAction(
                        number: 1,
                        label: 'Open preview URL',
                        icon: Icons.open_in_new_rounded,
                        onTap: () => _openUrl(item.url),
                      ),
                    CheVoiceAction(
                      number: item.url != null ? 2 : 1,
                      label: 'Ask CHE about this',
                      icon: Icons.mic_rounded,
                      onTap: () {
                        Navigator.pop(ctx);
                        widget.onAskChe?.call(
                          'Update me on project "${item.title}" (${item.typeLabel}). Status ${item.statusLabel}, ${(item.progress * 100).round()} percent. Live tasks: ${item.tasks.join('; ')}',
                        );
                      },
                    ),
                    CheVoiceAction(
                      number: item.url != null ? 3 : 2,
                      label: 'Close',
                      icon: Icons.close_rounded,
                      onTap: () => Navigator.pop(ctx),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final rows = _filtered;
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.xs, CheSpace.gutter, 0),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Projects', style: CheType.title),
                    Text(
                      'Apps, websites, businesses, Roblox — live from the Worker.',
                      style: CheType.caption,
                    ),
                  ],
                ),
              ),
              if (widget.onCreateProject != null)
                CheIconButton(
                  icon: Icons.add_rounded,
                  glow: true,
                  onTap: widget.onCreateProject!,
                  tooltip: 'New project',
                ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
          child: Che3DRoomView(
            assetPath: 'assets/office3d/projects.html',
            updateFunction: 'updateScene',
            payload: {
              'agents': [
                {'id': 'che', 'name': 'CHE', 'role': 'Office Boss', 'status': 'working', 'isChe': true},
              ],
              'items': [
                for (final i in rows.take(9))
                  {
                    'id': i.id,
                    'title': i.title,
                    'kind': i.kind.name,
                    'progress': i.progress,
                    'status': i.statusLabel,
                  },
              ],
            },
            height: 300,
            semanticsLabel: '3D Projects build floor',
            onTapId: (id) {
              final match = rows.where((i) => i.id == id);
              if (match.isNotEmpty) _openDetail(match.first);
            },
          ),
        ),
        const SizedBox(height: CheSpace.sm),
        SizedBox(
          height: 40,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
            children: [
              for (var i = 0; i < _filters.length; i++) ...[
                if (i > 0) const SizedBox(width: CheSpace.sm),
                _Pill(
                  label: _filters[i],
                  selected: _filter == _filters[i],
                  onTap: () => setState(() => _filter = _filters[i]),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: CheSpace.sm),
        Expanded(
          child: RefreshIndicator(
            onRefresh: widget.onRefresh ?? () async {},
            child: rows.isEmpty
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(CheSpace.xl),
                    children: [
                      const SizedBox(height: 80),
                      Text(
                        'No ${_filter == 'All' ? 'projects' : _filter} yet. Ask CHE to create an app, website, business, or Roblox game / weapon / clothing / pass.',
                        textAlign: TextAlign.center,
                        style: CheType.bodyDim,
                      ),
                    ],
                  )
                : ListView.builder(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl),
                    itemCount: rows.length,
                    itemBuilder: (_, i) => Padding(
                      padding: const EdgeInsets.only(bottom: CheSpace.sm),
                      child: _ProjectCard(
                        item: rows[i],
                        onTap: () => _openDetail(rows[i]),
                        onOpenUrl: rows[i].url != null ? () => _openUrl(rows[i].url) : null,
                      ),
                    ),
                  ),
          ),
        ),
      ],
    );

    // Pull-to-refresh is on the list panes inside [body] (AlwaysScrollable / ListView).
    final child = body;

    if (widget.embedded) {
      return Material(color: CheColors.bg, child: child);
    }
    return child;
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: '$label filter',
      excludeSemantics: true,
      child: GestureDetector(
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: AnimatedContainer(
          duration: CheMotion.fast,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: selected ? CheColors.accent : CheColors.surface,
            borderRadius: BorderRadius.circular(CheRadius.pill),
            border: Border.all(color: selected ? CheColors.accent : CheColors.strokeHi),
            boxShadow: selected
                ? [BoxShadow(color: CheColors.accent.withValues(alpha: 0.35), blurRadius: 12)]
                : null,
          ),
          child: Text(
            label,
            style: CheType.label.copyWith(
              color: selected ? const Color(0xFF03120F) : CheColors.text,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ),
    );
  }
}

class _ProgressBar extends StatelessWidget {
  const _ProgressBar({required this.value, required this.label});
  final double value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(99),
            child: LinearProgressIndicator(
              value: value.clamp(0.0, 1.0),
              minHeight: 6,
              backgroundColor: CheColors.stroke,
              color: CheColors.accent,
            ),
          ),
        ),
        const SizedBox(width: 10),
        Text(label, style: CheType.caption.copyWith(color: CheColors.accent, fontWeight: FontWeight.w700)),
      ],
    );
  }
}

class _ProjectCard extends StatelessWidget {
  const _ProjectCard({required this.item, required this.onTap, this.onOpenUrl});
  final CheBoardItem item;
  final VoidCallback onTap;
  final VoidCallback? onOpenUrl;

  @override
  Widget build(BuildContext context) {
    final live = item.progress > 0.05 && item.progress < 0.99;
    return Semantics(
      button: true,
      label: '${item.title}. ${item.typeLabel}. ${item.statusLabel}. ${(item.progress * 100).round()} percent.',
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(CheRadius.lg),
          child: Ink(
            padding: const EdgeInsets.all(CheSpace.md),
            decoration: BoxDecoration(
              color: CheColors.surfaceHi,
              borderRadius: BorderRadius.circular(CheRadius.lg),
              border: Border.all(
                color: live ? CheColors.accent.withValues(alpha: 0.55) : CheColors.stroke,
              ),
              boxShadow: live
                  ? [BoxShadow(color: CheColors.accent.withValues(alpha: 0.16), blurRadius: 14)]
                  : null,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: CheColors.accent.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(CheRadius.pill),
                      ),
                      child: Text(item.typeLabel, style: CheType.caption.copyWith(color: CheColors.accent)),
                    ),
                    const Spacer(),
                    Text(item.statusLabel, style: CheType.caption.copyWith(color: live ? CheColors.success : CheColors.textDim)),
                    if (onOpenUrl != null) ...[
                      const SizedBox(width: 4),
                      IconButton(
                        tooltip: 'Open URL',
                        onPressed: onOpenUrl,
                        icon: const Icon(Icons.open_in_new_rounded, size: 18, color: CheColors.accent),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 6),
                Text(item.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.headline),
                if (item.subtitle.trim().isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(item.subtitle, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.caption),
                ],
                if (item.metrics != null && item.metrics!.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(
                    _formatMetrics(item.metrics!).split('\n').first,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: CheType.caption.copyWith(color: CheColors.accent),
                  ),
                ],
                const SizedBox(height: 10),
                _ProgressBar(value: item.progress, label: '${(item.progress * 100).round()}%'),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
