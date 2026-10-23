// The Brain Room's list view (owner, 2026-10-23): a fast, searchable, VoiceOver-friendly list of
// every real record beside the neural visualization, in five sections (Conversations, Research,
// Knowledge, Memory, Actions). Opening a record shows who it came from, how far it is verified and
// every piece of evidence it holds; an action marked done with no evidence says it is not verified.
//
// Quiet by design: opening, searching and filtering never speak. Only "Read aloud" speaks.

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';
import '../home/che_memory_brain.dart' show CheMemoryDot, cheBrainFieldBorder;
import 'che_brain_sections.dart';

/// Opens in-app evidence (a trade, its replay, a coding job). Returns false when it cannot.
typedef CheOpenBrainEvidence = Future<bool> Function(CheBrainEvidence evidence);

IconData cheEvidenceIcon(CheEvidenceKind k) => switch (k) {
  CheEvidenceKind.commit => Icons.code_rounded,
  CheEvidenceKind.pullRequest => Icons.account_tree_outlined,
  CheEvidenceKind.deployment => Icons.rocket_launch_outlined,
  CheEvidenceKind.codingJob => Icons.receipt_long_rounded,
  CheEvidenceKind.trade => Icons.candlestick_chart_rounded,
  CheEvidenceKind.replay => Icons.play_circle_outline_rounded,
  CheEvidenceKind.video => Icons.movie_outlined,
  CheEvidenceKind.article => Icons.description_outlined,
  CheEvidenceKind.link => Icons.link_rounded,
};

IconData cheSectionIcon(CheBrainSection s) => switch (s) {
  CheBrainSection.conversations => Icons.forum_rounded,
  CheBrainSection.research => Icons.source_outlined,
  CheBrainSection.knowledge => Icons.school_rounded,
  CheBrainSection.memory => Icons.person_outline_rounded,
  CheBrainSection.actions => Icons.task_alt_rounded,
};

String _when(DateTime? at) {
  if (at == null) return 'date not recorded';
  final l = at.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.year}-${two(l.month)}-${two(l.day)} ${two(l.hour)}:${two(l.minute)}';
}

class CheBrainList extends StatefulWidget {
  const CheBrainList({super.key, required this.dots, this.onReadAloud, this.onOpenEvidence, this.initialSection});

  final List<CheMemoryDot> dots;
  final Future<void> Function(String text)? onReadAloud;

  /// In-app evidence (trade, replay, job). Null until that screen exists: those items then say
  /// "evidence not available yet" instead of opening something else.
  final CheOpenBrainEvidence? onOpenEvidence;
  final CheBrainSection? initialSection;

  @override
  State<CheBrainList> createState() => _CheBrainListState();
}

class _CheBrainListState extends State<CheBrainList> {
  final _query = TextEditingController();
  CheBrainSection? _section;
  late Map<CheBrainSection, int> _counts;
  late List<CheMemoryDot> _shown;

  @override
  void initState() {
    super.initState();
    _section = widget.initialSection;
    _refresh();
  }

  @override
  void didUpdateWidget(covariant CheBrainList old) {
    super.didUpdateWidget(old);
    if (!identical(old.dots, widget.dots)) _refresh();
  }

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  void _refresh() {
    _counts = cheBrainSectionCounts(widget.dots);
    _shown = cheBrainSearch(widget.dots, _query.text, section: _section);
  }

  void _select(CheBrainSection? s) => setState(() {
    _section = s;
    _refresh();
  });

  @override
  Widget build(BuildContext context) {
    final total = _counts.values.fold<int>(0, (a, b) => a + b);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 4, CheSpace.gutter, 6),
          child: SizedBox(
            height: 44,
            child: TextField(
              controller: _query,
              textInputAction: TextInputAction.search,
              onChanged: (_) => setState(_refresh),
              style: const TextStyle(fontSize: 15),
              decoration: InputDecoration(
                isDense: true,
                hintText: 'Search conversations, research, knowledge, memory, actions',
                prefixIcon: Icon(Icons.search_rounded, size: 18, color: CheColors.accent),
                suffixIcon: _query.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: 'Clear the search',
                        icon: const Icon(Icons.close_rounded, size: 18),
                        onPressed: () => setState(() {
                          _query.clear();
                          _refresh();
                        }),
                      ),
                filled: true,
                fillColor: CheColors.surfaceHi,
                contentPadding: const EdgeInsets.symmetric(vertical: 10),
                border: cheBrainFieldBorder(),
              ),
            ),
          ),
        ),
        // Wrapped, not scrolled sideways: every section stays visible and reachable by VoiceOver.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
          child: Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [_chip(null, 'All', total), for (final s in CheBrainSection.values) _chip(s, s.label, _counts[s] ?? 0)],
          ),
        ),
        if (_section != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 2, CheSpace.gutter, 4),
            child: Text(_section!.meaning, style: CheType.bodyDim.copyWith(fontSize: 13)),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 2, CheSpace.gutter, 4),
          child: Semantics(
            liveRegion: false,
            child: Text('${_shown.length} record${_shown.length == 1 ? '' : 's'}', style: CheType.bodyDim.copyWith(fontSize: 12.5)),
          ),
        ),
        Expanded(
          child: _shown.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(CheSpace.xl),
                    child: Text(
                      _query.text.isEmpty ? 'Nothing recorded here yet.' : 'No record matches “${_query.text}”.',
                      textAlign: TextAlign.center,
                      style: CheType.bodyDim,
                    ),
                  ),
                )
              : ListView.builder(
                  itemCount: _shown.length,
                  itemExtent: 76,
                  padding: const EdgeInsets.only(bottom: 72),
                  itemBuilder: (context, i) => _row(_shown[i]),
                ),
        ),
      ],
    );
  }

  Widget _chip(CheBrainSection? s, String label, int count) {
    final on = _section == s;
    return Semantics(
      button: true,
      selected: on,
      label: '$label, $count record${count == 1 ? '' : 's'}${on ? ', showing' : ''}',
      excludeSemantics: true,
      child: ChoiceChip(
        avatar: s == null ? null : Icon(cheSectionIcon(s), size: 16),
        label: Text('$label $count'),
        selected: on,
        onSelected: (_) => _select(on ? null : s),
        materialTapTargetSize: MaterialTapTargetSize.padded,
      ),
    );
  }

  Widget _row(CheMemoryDot d) {
    final section = cheBrainSectionOf(d);
    final evidence = cheBrainEvidenceOf(d);
    final status = cheBrainStatusOf(d, evidence).label;
    final simulated = cheBrainIsSimulated(d) ? ' · Simulated' : '';
    final proof = '$status$simulated';
    final origin = cheBrainOriginOf(d);
    final evidenceWords = evidence.isEmpty ? ' No evidence recorded.' : ' ${evidence.length} evidence item${evidence.length == 1 ? '' : 's'}.';
    return Semantics(
      button: true,
      label: '${section.label}. ${d.title}. Source: $origin. Status: $proof.$evidenceWords ${_when(d.at)}. Opens the record.',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => _open(d),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter, vertical: 8),
          child: Row(
            children: [
              Icon(cheSectionIcon(section), size: 22, color: CheColors.accent),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      d.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: CheType.body.copyWith(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 2),
                    Text('$origin · $proof', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.bodyDim.copyWith(fontSize: 12.5)),
                    Text(_when(d.at), maxLines: 1, style: CheType.bodyDim.copyWith(fontSize: 11.5)),
                  ],
                ),
              ),
              if (evidence.isNotEmpty) ...[
                const SizedBox(width: 8),
                Icon(cheEvidenceIcon(evidence.first.kind), size: 18, color: CheColors.textDim),
                Text(' ${evidence.length}', style: CheType.bodyDim.copyWith(fontSize: 12.5)),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _open(CheMemoryDot d) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: CheColors.surface,
    builder: (_) => CheBrainRecordSheet(dot: d, onReadAloud: widget.onReadAloud, onOpenEvidence: widget.onOpenEvidence),
  );
}

/// One record: section, origin, trust, outcome, its evidence and its full text.
class CheBrainRecordSheet extends StatelessWidget {
  const CheBrainRecordSheet({super.key, required this.dot, this.onReadAloud, this.onOpenEvidence});

  final CheMemoryDot dot;
  final Future<void> Function(String text)? onReadAloud;
  final CheOpenBrainEvidence? onOpenEvidence;

  @override
  Widget build(BuildContext context) {
    final d = dot;
    final section = cheBrainSectionOf(d);
    final evidence = cheBrainEvidenceOf(d);
    final isAction = section == CheBrainSection.actions;
    final proof = isAction ? cheActionProofOf(d, evidence) : null;
    final facts = <(String, String)>[
      ('Category', section.label),
      ('Source', cheBrainOriginOf(d)),
      ('Status', '${cheBrainStatusOf(d, evidence).label}${cheBrainIsSimulated(d) ? ' (simulated, not a live or broker result)' : ''}'),
      ('Fact check', cheBrainTrustOf(d)),
      if (proof != null) ('Outcome', cheActionProofLabel(proof)),
      ('Recorded', _when(d.at)),
      if (d.region.isNotEmpty) ('Folder', d.path.isEmpty ? d.region : '${d.region} / ${d.path}'),
    ];
    final spoken = [
      d.title,
      for (final (k, v) in facts) '$k: $v.',
      if (evidence.isEmpty)
        (isAction ? 'No evidence is recorded for this action.' : 'No evidence links are recorded.')
      else
        'Evidence: ${evidence.map((e) => e.label).join(', ')}.',
      d.body,
    ].join(' ');
    return SafeArea(
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: .72,
        maxChildSize: .95,
        builder: (context, scroll) => ListView(
          controller: scroll,
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.md, CheSpace.gutter, CheSpace.xl),
          children: [
            Row(
              children: [
                Expanded(
                  child: Semantics(
                    header: true,
                    child: cheHudActive ? CheChromeText(d.title, style: CheType.headline) : Text(d.title, style: CheType.headline),
                  ),
                ),
                IconButton(tooltip: 'Close', icon: const Icon(Icons.close_rounded), onPressed: () => Navigator.of(context).maybePop()),
              ],
            ),
            for (final (k, v) in facts)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Semantics(
                  label: '$k: $v',
                  excludeSemantics: true,
                  child: Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(text: '$k  ', style: CheType.bodyDim.copyWith(fontSize: 13)),
                        TextSpan(text: v, style: CheType.body.copyWith(fontSize: 14)),
                      ],
                    ),
                  ),
                ),
              ),
            const SizedBox(height: CheSpace.md),
            Semantics(header: true, child: Text('Evidence', style: CheType.headline.copyWith(fontSize: 15))),
            const SizedBox(height: 4),
            if (evidence.isEmpty)
              Text(
                isAction ? 'No evidence is recorded for this action, so CHE does not count it as verified.' : 'No evidence links are recorded for this record.',
                style: CheType.bodyDim,
              )
            else
              for (final e in evidence) CheEvidenceTile(evidence: e, onOpenEvidence: onOpenEvidence),
            const SizedBox(height: CheSpace.md),
            if (onReadAloud != null)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(onPressed: () => onReadAloud!(spoken), icon: const Icon(Icons.volume_up_rounded), label: const Text('Read aloud')),
              ),
            const SizedBox(height: CheSpace.sm),
            SelectableText(d.body, style: CheType.body.copyWith(fontSize: 14.5)),
          ],
        ),
      ),
    );
  }
}

class CheEvidenceTile extends StatelessWidget {
  const CheEvidenceTile({super.key, required this.evidence, this.onOpenEvidence});

  final CheBrainEvidence evidence;
  final CheOpenBrainEvidence? onOpenEvidence;

  @override
  Widget build(BuildContext context) {
    final e = evidence;
    final web = e.url.isNotEmpty;
    final available = web || onOpenEvidence != null;
    final detail = web ? Uri.tryParse(e.url)?.host ?? e.url : (available ? 'Opens in CHE' : 'Evidence not available yet');
    return Semantics(
      button: available,
      enabled: available,
      label: '${e.label}. ${available ? (web ? 'Opens $detail in the browser.' : 'Opens in CHE.') : 'Evidence not available yet on this phone.'}',
      excludeSemantics: true,
      child: ListTile(
        contentPadding: EdgeInsets.zero,
        minTileHeight: 52,
        leading: Icon(cheEvidenceIcon(e.kind), color: available ? CheColors.accent : CheColors.textDim),
        title: Text(e.label, style: CheType.body.copyWith(fontSize: 14.5)),
        subtitle: Text(detail, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.bodyDim.copyWith(fontSize: 12)),
        trailing: available ? const Icon(Icons.open_in_new_rounded, size: 18) : null,
        enabled: available,
        onTap: !available ? null : () => _open(context),
      ),
    );
  }

  Future<void> _open(BuildContext context) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    var ok = false;
    try {
      ok = evidence.url.isNotEmpty ? await launchUrl(Uri.parse(evidence.url), mode: LaunchMode.externalApplication) : await onOpenEvidence!(evidence);
    } catch (_) {
      ok = false;
    }
    if (!ok) messenger?.showSnackBar(SnackBar(content: Text('Could not open ${evidence.label}.')));
  }
}
