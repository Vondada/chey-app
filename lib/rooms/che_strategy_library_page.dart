// Strategy Library (owner, 2026-10-23): every strategy CHE knows, every one she can execute, and every one
// she is testing, from the Worker's registry (server/cloudflare/strategy_library.js). Searchable by words,
// category, kind and stage. Discovered ideas sit in their own section and are never shown as validated.
//
// Paper only. Approving a custom strategy shows its exact rules and needs the owner's confirm; enabling a
// built-in research strategy goes through the Strategy Control Center on the Worker. The page is silent on
// open: Read Aloud is a button. Every status is text and an icon, never color alone.
import 'package:flutter/material.dart';

import '../che_ui/che_help.dart';
import '../che_ui/che_theme.dart';
import '../trading/che_strategy_dsl.dart';
import '../trading/che_strategy_library.dart';

const kStrategyLibraryHelp = CheHelpTopic(
  title: 'Strategy Library',
  summary: 'Every strategy CHE knows, which ones she can run, and which she is paper testing. Paper only; live trading is off.',
  items: [
    CheControlHelp(name: 'Search', does: 'Finds strategies by name, rule words or category', say: 'show the strategy library'),
    CheControlHelp(name: 'Stage', does: 'DISCOVERED, RULES DOCUMENTED, IMPLEMENTED, BACKTESTED, FORWARD TESTED or PAPER ACTIVE, from recorded evidence only'),
    CheControlHelp(name: 'Favorite', does: 'Keeps a strategy at the top of the list', say: 'favorite Silver Bullet'),
    CheControlHelp(name: 'Enable or disable', does: 'Allows or stops paper testing. Built-in strategies switch in the Strategy Control Center', caution: 'A custom strategy needs your approval first'),
    CheControlHelp(name: 'Approve', does: 'Reads you the exact rules, then lets a custom strategy paper trade', caution: 'Only your confirm approves it; editing the rules needs a new approval', say: 'approve MACD signal cross'),
    CheControlHelp(name: 'Duplicate', does: 'Copies a strategy under a new name as your own, waiting for approval'),
    CheControlHelp(name: 'Compare', does: 'Puts two or more strategies side by side from their recorded results', say: 'compare EMA pullback and VWAP reversion'),
    CheControlHelp(name: 'Add a strategy', does: 'Turns your words into written rules for you to read and approve', say: 'add a strategy that …'),
  ],
);

/// The live state the owner asked to see per strategy. Without a running setup engine the page says what it
/// knows from the registry (disabled, insufficient data) and never invents "watching".
const kLiveStatuses = ['watching', 'forming', 'triggered', 'paper trading', 'backtesting', 'insufficient data', 'disabled'];

(IconData, Color) _stageLook(CheLibraryStage s) => switch (s) {
      CheLibraryStage.discovered => (Icons.lightbulb_outline, CheColors.textDim),
      CheLibraryStage.rulesDocumented => (Icons.description_outlined, CheColors.warning),
      CheLibraryStage.implemented => (Icons.code, CheColors.accent),
      CheLibraryStage.backtested => (Icons.history_rounded, const Color(0xFF7AB8FF)),
      CheLibraryStage.forwardTested => (Icons.fact_check_outlined, const Color(0xFFB98CFF)),
      CheLibraryStage.paperActive => (Icons.play_circle_outline, CheColors.success),
    };

class CheStrategyLibraryPage extends StatefulWidget {
  const CheStrategyLibraryPage({super.key, required this.client, this.onRead, this.liveStatus});
  final CheStrategyLibraryClient client;

  /// Read Aloud (manual only).
  final void Function(String words)? onRead;

  /// Live status by strategy id from the phone's setup engine, when it is running.
  final Map<String, String> Function()? liveStatus;

  static Route<void> route({required CheStrategyLibraryClient client, void Function(String)? onRead, Map<String, String> Function()? liveStatus}) => MaterialPageRoute(
        builder: (_) => CheStrategyLibraryPage(client: client, onRead: onRead, liveStatus: liveStatus),
        settings: const RouteSettings(name: 'strategy_library'),
      );

  @override
  State<CheStrategyLibraryPage> createState() => _CheStrategyLibraryPageState();
}

class _CheStrategyLibraryPageState extends State<CheStrategyLibraryPage> {
  CheLibraryView? _view;
  String _error = '', _q = '', _category = '', _kind = '', _result = '';
  final Set<String> _selected = {};
  bool _busy = false;
  Object? _help;

  @override
  void initState() {
    super.initState();
    _help = CheHelp.register(context, () => kStrategyLibraryHelp);
    _load();
  }

  @override
  void dispose() {
    CheHelp.unregister(_help);
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final v = await widget.client.load();
      if (!mounted) return;
      setState(() {
        _view = v;
        _error = '';
      });
    } catch (e) {
      if (mounted) setState(() => _error = 'The strategy library did not load: $e');
    }
  }

  List<CheLibraryEntry> get _filtered {
    final v = _view;
    if (v == null) return const [];
    final q = _q.toLowerCase().trim();
    return v.entries.where((e) {
      if (_category.isNotEmpty && e.category != _category) return false;
      if (_kind == 'strategy' && e.kind != CheLibraryKind.strategy) return false;
      if (_kind == 'market_context' && e.kind != CheLibraryKind.marketContext) return false;
      if (q.isEmpty) return true;
      return '${e.name} ${e.id} ${e.family} ${e.categoryLabel} ${e.rules.join(' ')}'.toLowerCase().contains(q);
    }).toList();
  }

  String liveStatusOf(CheLibraryEntry e) {
    final live = widget.liveStatus?.call()[e.id];
    if (live != null && kLiveStatuses.contains(live)) return live;
    if (!e.enabled) return 'disabled';
    if (e.stage == CheLibraryStage.paperActive) return 'paper trading';
    if (!e.executable || e.backtestTrades == 0) return 'insufficient data';
    return 'not followed on the phone yet';
  }

  Future<void> _act(String action, CheLibraryEntry e, [Map<String, dynamic> extra = const {}]) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final out = await widget.client.act(action, {'id': e.id, ...extra});
      final ok = out['ok'] == true;
      final words = ok
          ? switch (action) {
              'enable' => '${e.name} is enabled for paper testing.',
              'disable' => '${e.name} is disabled.',
              'favorite' => '${e.name} is a favorite.',
              'unfavorite' => '${e.name} is no longer a favorite.',
              'approve' => 'Approved ${e.name}. Enable it to start paper testing.',
              'duplicate' => 'Copied as ${extra['new_id']}. It waits for your approval.',
              _ => 'Done.',
            }
          : '${out['spoken'] ?? out['error'] ?? (out['problems'] as List?)?.join('; ') ?? 'That did not work (${out['status']}).'}';
      if (mounted) setState(() => _result = words);
      await _load();
    } catch (err) {
      if (mounted) setState(() => _result = 'That did not reach CHE: $err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _approve(CheLibraryEntry e) async {
    final rules = e.definition == null ? e.rules : cheDescribeStrategy(e.definition!);
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Approve ${e.name} for paper testing?'),
        content: SingleChildScrollView(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            for (final r in rules) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(r)),
            const SizedBox(height: 8),
            const Text('It will paper trade only. Live trading stays off. Editing the rules later needs a new approval.', style: TextStyle(fontWeight: FontWeight.w700)),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Approve for paper')),
        ],
      ),
    );
    if (yes == true) await _act('approve', e, {'confirm': true});
  }

  Future<void> _duplicate(CheLibraryEntry e) async {
    final c = TextEditingController(text: 'my-${e.id.replaceAll(':', '-')}');
    final id = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Duplicate ${e.name}'),
        content: TextField(controller: c, decoration: const InputDecoration(labelText: 'New id (lowercase, dashes)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('Duplicate')),
        ],
      ),
    );
    if (id != null && id.isNotEmpty) await _act('duplicate', e, {'new_id': id});
  }

  Future<void> _addStrategy() async {
    final c = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add a strategy'),
        content: TextField(
          controller: c,
          minLines: 3,
          maxLines: 8,
          decoration: const InputDecoration(labelText: 'Describe the rules in your words', hintText: 'Go long when the 9 EMA crosses above the 21 EMA in the New York open; stop under the last swing low; target 2R.'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('Write the rules')),
        ],
      ),
    );
    if (text == null || text.length < 8) return;
    setState(() => _busy = true);
    try {
      final out = await widget.client.act('draft', {'text': text});
      final def = out['definition'];
      setState(() => _result = out['ok'] == true && def is Map
          ? 'Wrote "${def['name']}". It waits for your approval; open it to read the rules.'
          : '${out['error'] ?? 'That could not be turned into rules.'}');
      await _load();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _openDetail(CheLibraryEntry e) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: CheColors.surface,
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.85,
        builder: (_, scroll) => _EntryDetail(
          entry: e,
          scroll: scroll,
          liveStatus: liveStatusOf(e),
          busy: _busy,
          onRead: widget.onRead,
          onAction: (a) async {
            Navigator.pop(ctx);
            if (a == 'approve') return _approve(e);
            if (a == 'duplicate') return _duplicate(e);
            await _act(a, e);
          },
        ),
      ),
    );
  }

  void _openCompare() {
    final picks = _view!.entries.where((e) => _selected.contains(e.id)).toList();
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: CheColors.surface,
      builder: (ctx) => SafeArea(child: _CompareSheet(entries: picks, liveStatus: liveStatusOf, onRead: widget.onRead)),
    );
  }

  String _spokenSummary() {
    final c = _view?.counts ?? const {};
    return 'Strategy Library. ${c['named'] ?? 0} named strategies and ${c['market_context_models'] ?? 0} market-context models. '
        '${c['executable_rules'] ?? 0} have executable rules, ${c['backtested'] ?? 0} have recorded backtests, ${c['forward_tested'] ?? 0} are forward tested, '
        'and ${c['paper_active'] ?? 0} are paper trading now. Live trading is off.';
  }

  @override
  Widget build(BuildContext context) {
    final entries = _filtered;
    final testing = entries.where((e) => e.stage == CheLibraryStage.paperActive).toList();
    final library = entries.where((e) => e.stage.index >= CheLibraryStage.implemented.index && e.stage != CheLibraryStage.paperActive).toList();
    final discovery = entries.where((e) => e.stage.index < CheLibraryStage.implemented.index).toList();
    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(
        backgroundColor: CheColors.bg,
        foregroundColor: CheColors.text,
        title: const Text('Strategy Library'),
        leading: IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.of(context).maybePop()),
        actions: [
          if (widget.onRead != null)
            IconButton(tooltip: 'Read aloud', icon: const Icon(Icons.volume_up_rounded), onPressed: _view == null ? null : () => widget.onRead!(_spokenSummary())),
          IconButton(tooltip: 'Add a strategy', icon: const Icon(Icons.add), onPressed: _busy ? null : _addStrategy),
          const CheHelpButton(),
        ],
      ),
      floatingActionButton: _selected.length >= 2
          ? FloatingActionButton.extended(onPressed: _openCompare, icon: const Icon(Icons.compare_arrows_rounded), label: Text('Compare ${_selected.length}'))
          : null,
      body: SafeArea(
        child: _view == null
            ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error.isEmpty ? 'Loading the strategy library…' : _error, style: TextStyle(color: CheColors.textDim))))
            : RefreshIndicator(
                onRefresh: _load,
                child: ListView(padding: const EdgeInsets.all(12), children: [
                  _Counts(counts: _view!.counts),
                  const SizedBox(height: 8),
                  Semantics(
                    textField: true,
                    label: 'Search strategies',
                    child: TextField(
                      onChanged: (v) => setState(() => _q = v),
                      style: TextStyle(color: CheColors.text),
                      decoration: InputDecoration(prefixIcon: const Icon(Icons.search), hintText: 'Search by name, rule or category', hintStyle: TextStyle(color: CheColors.textDim), border: const OutlineInputBorder()),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Wrap(spacing: 6, runSpacing: 6, children: [
                    for (final k in const [('', 'All kinds'), ('strategy', 'Strategies'), ('market_context', 'Market context')])
                      ChoiceChip(label: Text(k.$2), selected: _kind == k.$1, onSelected: (_) => setState(() => _kind = k.$1)),
                  ]),
                  const SizedBox(height: 6),
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(children: [
                      for (final c in [const MapEntry('', 'All categories'), ...kCheStrategyCategories.entries])
                        Padding(
                          padding: const EdgeInsets.only(right: 6),
                          child: ChoiceChip(label: Text(c.value), selected: _category == c.key, onSelected: (_) => setState(() => _category = c.key)),
                        ),
                    ]),
                  ),
                  if (_result.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 10),
                      child: Semantics(liveRegion: true, child: Text(_result, style: TextStyle(color: CheColors.text, fontSize: 16))),
                    ),
                  _Section(title: 'Testing now (paper)', empty: 'No strategy is paper trading right now.', children: [for (final e in testing) _card(e)]),
                  _Section(title: 'Executable strategies', empty: 'Nothing matches.', children: [for (final e in library) _card(e)]),
                  _Section(
                    title: 'Strategy Discovery: ideas, not implemented and not validated',
                    empty: 'No discovered ideas match.',
                    children: [for (final e in discovery) _card(e)],
                  ),
                  const SizedBox(height: 60),
                ]),
              ),
      ),
    );
  }

  Widget _card(CheLibraryEntry e) => _EntryCard(
        entry: e,
        liveStatus: liveStatusOf(e),
        selected: _selected.contains(e.id),
        onSelect: (v) => setState(() => v ? _selected.add(e.id) : _selected.remove(e.id)),
        onFavorite: () => _act(e.favorite ? 'unfavorite' : 'favorite', e),
        onOpen: () => _openDetail(e),
      );
}

class _Counts extends StatelessWidget {
  const _Counts({required this.counts});
  final Map<String, dynamic> counts;
  @override
  Widget build(BuildContext context) {
    final tiles = [
      ('Named', counts['named']),
      ('Executable', counts['executable_rules']),
      ('Backtested', counts['backtested']),
      ('Forward tested', counts['forward_tested']),
      ('Paper active', counts['paper_active']),
      ('Market context', counts['market_context_models']),
    ];
    return Semantics(
      container: true,
      label: tiles.map((t) => '${t.$1}: ${t.$2 ?? 0}').join(', '),
      excludeSemantics: true,
      child: Wrap(spacing: 8, runSpacing: 8, children: [
        for (final t in tiles)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(color: CheColors.surface, border: Border.all(color: CheColors.stroke), borderRadius: BorderRadius.circular(8)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${t.$2 ?? 0}', style: TextStyle(color: CheColors.text, fontSize: 20, fontWeight: FontWeight.w700, fontFeatures: const [FontFeature.tabularFigures()])),
              Text(t.$1, style: TextStyle(color: CheColors.textDim, fontSize: 12)),
            ]),
          ),
        Padding(padding: const EdgeInsets.only(top: 8), child: Text('Live trading is off.', style: TextStyle(color: CheColors.textDim))),
      ]),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children, required this.empty});
  final String title, empty;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(header: true, child: Text('$title (${children.length})', style: TextStyle(color: CheColors.text, fontSize: 17, fontWeight: FontWeight.w700))),
          const SizedBox(height: 6),
          if (children.isEmpty) Text(empty, style: TextStyle(color: CheColors.textDim)) else ...children,
        ]),
      );
}

class StageBadge extends StatelessWidget {
  const StageBadge(this.stage, {super.key});
  final CheLibraryStage stage;
  @override
  Widget build(BuildContext context) {
    final (icon, color) = _stageLook(stage);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(border: Border.all(color: color), borderRadius: BorderRadius.circular(12)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 14, color: color),
        const SizedBox(width: 4),
        Text(stage.label, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.4)),
      ]),
    );
  }
}

class _EntryCard extends StatelessWidget {
  const _EntryCard({required this.entry, required this.liveStatus, required this.selected, required this.onSelect, required this.onFavorite, required this.onOpen});
  final CheLibraryEntry entry;
  final String liveStatus;
  final bool selected;
  final ValueChanged<bool> onSelect;
  final VoidCallback onFavorite, onOpen;

  @override
  Widget build(BuildContext context) {
    final e = entry;
    final facts = [
      if (e.timeframes.isNotEmpty) e.timeframes.join(', '),
      if (e.backtestTrades > 0) '${e.backtestTrades} backtest trades' else if (e.executable) 'no recorded backtest',
      if (e.forwardTrades > 0) '${e.forwardTrades} forward paper trades',
    ].join(' · ');
    return Semantics(
      container: true,
      label: '${e.spoken()} Live status: $liveStatus.',
      child: Card(
        color: CheColors.surface,
        margin: const EdgeInsets.only(bottom: 8),
        child: InkWell(
          onTap: onOpen,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(4, 8, 8, 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Checkbox(value: selected, onChanged: (v) => onSelect(v ?? false), semanticLabel: 'Select ${e.name} to compare'),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(e.name, style: TextStyle(color: CheColors.text, fontSize: 16, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                    StageBadge(e.stage),
                    Text(e.kind == CheLibraryKind.marketContext ? 'Market context · ${e.categoryLabel}' : e.categoryLabel, style: TextStyle(color: CheColors.textDim, fontSize: 12)),
                    if (e.needsApproval) const _Flag(icon: Icons.verified_user_outlined, text: 'Waiting for your approval'),
                    _Flag(icon: e.enabled ? Icons.play_circle_outline : Icons.stop_circle_outlined, text: liveStatus),
                  ]),
                  if (facts.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(facts, style: TextStyle(color: CheColors.textDim, fontSize: 12))),
                  if (e.notRunning != null) Padding(padding: const EdgeInsets.only(top: 2), child: Text(e.notRunning!, style: TextStyle(color: CheColors.textDim, fontSize: 12))),
                ]),
              ),
              IconButton(
                tooltip: e.favorite ? 'Remove ${e.name} from favorites' : 'Favorite ${e.name}',
                icon: Icon(e.favorite ? Icons.star_rounded : Icons.star_border_rounded, color: e.favorite ? CheColors.warning : CheColors.textDim),
                onPressed: onFavorite,
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

class _Flag extends StatelessWidget {
  const _Flag({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Text.rich(
        TextSpan(children: [
          WidgetSpan(alignment: PlaceholderAlignment.middle, child: Padding(padding: const EdgeInsets.only(right: 3), child: Icon(icon, size: 14, color: CheColors.textDim))),
          TextSpan(text: text),
        ]),
        style: TextStyle(color: CheColors.textDim, fontSize: 12),
      );
}

class _EntryDetail extends StatelessWidget {
  const _EntryDetail({required this.entry, required this.scroll, required this.liveStatus, required this.busy, required this.onAction, this.onRead});
  final CheLibraryEntry entry;
  final ScrollController scroll;
  final String liveStatus;
  final bool busy;
  final void Function(String action) onAction;
  final void Function(String)? onRead;

  @override
  Widget build(BuildContext context) {
    final e = entry;
    final rules = e.definition == null ? e.rules : cheDescribeStrategy(e.definition!);
    final issues = e.definition == null ? const <CheDslIssue>[] : cheValidateStrategy(e.definition!);
    Widget list(String title, List<String> items) => items.isEmpty
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Semantics(header: true, child: Text(title, style: TextStyle(color: CheColors.text, fontWeight: FontWeight.w700))),
              for (final i in items) Padding(padding: const EdgeInsets.only(top: 4), child: SelectableText(i, style: TextStyle(color: CheColors.text))),
            ]),
          );
    final bt = e.results['backtest'], fw = e.results['forward'];
    return SingleChildScrollView(controller: scroll, padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(e.name, style: TextStyle(color: CheColors.text, fontSize: 20, fontWeight: FontWeight.w700)),
      const SizedBox(height: 6),
      Wrap(spacing: 8, runSpacing: 6, children: [StageBadge(e.stage), _Flag(icon: Icons.help_outline_rounded, text: 'live status: $liveStatus'), _Flag(icon: Icons.memory, text: 'engine: ${e.engine}')]),
      Padding(padding: const EdgeInsets.only(top: 8), child: Text('${e.stage.label}: ${e.stage.meaning}.', style: TextStyle(color: CheColors.textDim))),
      if (e.notRunning != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Not paper trading: ${e.notRunning}', style: TextStyle(color: CheColors.textDim))),
      const SizedBox(height: 10),
      Wrap(spacing: 8, runSpacing: 8, children: [
        if (e.needsApproval && e.definition != null) FilledButton.icon(onPressed: busy ? null : () => onAction('approve'), icon: const Icon(Icons.verified_user_rounded), label: const Text('Approve for paper')),
        if (e.executable)
          OutlinedButton.icon(
            onPressed: busy ? null : () => onAction(e.enabled ? 'disable' : 'enable'),
            icon: Icon(e.enabled ? Icons.pause_circle_rounded : Icons.play_circle_outline),
            label: Text(e.enabled ? 'Disable' : 'Enable for paper'),
          ),
        OutlinedButton.icon(onPressed: busy ? null : () => onAction(e.favorite ? 'unfavorite' : 'favorite'), icon: Icon(e.favorite ? Icons.star_rounded : Icons.star_border_rounded), label: Text(e.favorite ? 'Unfavorite' : 'Favorite')),
        OutlinedButton.icon(onPressed: busy ? null : () => onAction('duplicate'), icon: const Icon(Icons.copy), label: const Text('Duplicate')),
        if (onRead != null) OutlinedButton.icon(onPressed: () => onRead!('${e.spoken()} ${rules.join(' ')}'), icon: const Icon(Icons.volume_up_rounded), label: const Text('Read aloud')),
      ]),
      if (issues.isNotEmpty) list('Problems in these rules (they cannot run)', [for (final i in issues) '$i']),
      list(e.definition == null ? 'Rules' : 'Rules (exactly what runs)', rules),
      list('Assumptions', e.assumptions),
      list('Timeframes', e.timeframes),
      list('Data needed', e.dataRequirements),
      list('Depends on events', e.eventDependencies),
      list('Results (recorded only)', [
        if (bt is Map) 'Backtest: ${bt['trades']} trades${bt['source'] != null ? ' — ${bt['source']}' : ''}' else 'Backtest: none recorded',
        if (fw is Map) 'Forward paper: ${fw['trades']} trades (30 needed)${fw['source'] != null ? ' — ${fw['source']}' : ''}' else 'Forward paper: none recorded',
      ]),
      list('Limitations', e.limitations),
      list('Sources', [for (final s in e.sources) '${s.title}${s.url != null ? ' — ${s.url}' : ''} (${s.type})']),
      list('Version', ['Version ${e.version}${e.approval == 'approved' ? ', approved' : e.needsApproval ? ', waiting for approval' : ''}']),
    ]));
  }
}

class _CompareSheet extends StatelessWidget {
  const _CompareSheet({required this.entries, required this.liveStatus, this.onRead});
  final List<CheLibraryEntry> entries;
  final String Function(CheLibraryEntry) liveStatus;
  final void Function(String)? onRead;

  List<(String, String)> _rows(CheLibraryEntry e) => [
        ('Stage', e.stage.label),
        ('Live status', liveStatus(e)),
        ('Category', e.categoryLabel),
        ('Timeframes', e.timeframes.isEmpty ? '—' : e.timeframes.join(', ')),
        ('Backtest trades', e.backtestTrades > 0 ? '${e.backtestTrades}' : 'none recorded'),
        ('Forward paper trades', e.forwardTrades > 0 ? '${e.forwardTrades}' : 'none recorded'),
        ('Engine', e.engine),
        ('Not running because', e.notRunning ?? 'it is running'),
      ];

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 600;
    final columns = [
      for (final e in entries)
        Container(
          width: wide ? 280 : double.infinity,
          margin: const EdgeInsets.all(6),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(border: Border.all(color: CheColors.stroke), borderRadius: BorderRadius.circular(8)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(e.name, style: TextStyle(color: CheColors.text, fontWeight: FontWeight.w700)),
            for (final r in _rows(e)) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${r.$1}: ${r.$2}', style: TextStyle(color: CheColors.text))),
          ]),
        ),
    ];
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.8,
      child: Column(children: [
        ListTile(
          title: Text('Compare ${entries.length} strategies', style: TextStyle(color: CheColors.text)),
          subtitle: Text('From recorded evidence only.', style: TextStyle(color: CheColors.textDim)),
          trailing: onRead == null
              ? null
              : IconButton(
                  tooltip: 'Read the comparison aloud',
                  icon: const Icon(Icons.volume_up_rounded),
                  onPressed: () => onRead!(entries.map((e) => '${e.name}: ${_rows(e).map((r) => '${r.$1} ${r.$2}').join(', ')}.').join(' ')),
                ),
        ),
        Expanded(child: SingleChildScrollView(child: wide ? SingleChildScrollView(scrollDirection: Axis.horizontal, child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: columns)) : Column(children: columns))),
      ]),
    );
  }
}
