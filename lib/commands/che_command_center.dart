// CHE Command Center: Chat → Commands. The whole command library from CHE's
// own catalog (GET /api/commands), searchable by name or goal, in eight
// categories, with favorites, recents, saved workflows, a workflow builder
// and the real status of every run. Opening this page never makes CHE
// speak; Read This buttons and the owner's own actions do.
import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoAlertDialog, CupertinoDialogAction, showCupertinoDialog;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import 'che_command_client.dart';
import 'che_command_detail.dart';
import 'che_command_models.dart';
import 'che_command_store.dart';
import 'che_command_widgets.dart';
import 'che_workflow_builder.dart';

/// Runs a command in CHE's chat. `confirmed` is true only after the owner
/// approved it on this page.
typedef CheRunInChat = Future<void> Function(String message, {bool confirmed});

class CheCommandCenterScreen extends StatefulWidget {
  const CheCommandCenterScreen({
    super.key,
    required this.client,
    required this.store,
    required this.onRunInChat,
    this.onSpeak,
    this.initialCommand,
    this.initialSteps,
    this.initialTab = 0,
  });

  final CheCommandClient client;
  final CheCommandStore store;
  final CheRunInChat onRunInChat;
  final void Function(String text)? onSpeak;

  /// Opens this command's details first (from a chat suggestion).
  final String? initialCommand;

  /// Opens the builder with these commands (from a chat suggestion card).
  final List<String>? initialSteps;
  final int initialTab;

  @override
  State<CheCommandCenterScreen> createState() => _CheCommandCenterScreenState();
}

class _CheCommandCenterScreenState extends State<CheCommandCenterScreen> {
  CheCommandCatalog _catalog = CheCommandCatalog.empty;
  bool _loading = true;
  bool _fromCache = false;
  String _loadError = '';
  late int _tab = widget.initialTab;
  String _query = '';
  String _category = 'all';
  String _status = '';
  bool _statusOk = true;
  bool _busy = false;
  final _search = TextEditingController();
  // New search results or a new category start at the top of the list.
  final _libraryScroll = ScrollController();

  void _toTop() {
    if (_libraryScroll.hasClients) _libraryScroll.jumpTo(0);
  }

  @override
  void initState() {
    super.initState();
    widget.store.addListener(_onStore);
    unawaited(_start());
  }

  @override
  void dispose() {
    widget.store.removeListener(_onStore);
    _search.dispose();
    _libraryScroll.dispose();
    super.dispose();
  }

  void _onStore() {
    if (mounted) setState(() {});
  }

  Future<void> _start() async {
    if (!widget.store.loaded) await widget.store.load();
    final cached = widget.store.cachedCatalog;
    if (cached != null && mounted) {
      setState(() {
        _catalog = cached;
        _fromCache = true;
      });
    }
    await _refresh();
    if (!mounted) return;
    final open = widget.initialCommand == null ? null : _catalog.byId(widget.initialCommand!);
    if (open != null) unawaited(_openDetail(open));
    final steps = widget.initialSteps;
    if (steps != null && steps.isNotEmpty) {
      unawaited(_openBuilder(CheSavedWorkflow(name: '', steps: [for (final id in steps) CheWorkflowStepDraft(command: id)])));
    }
  }

  /// Quiet: loading shows muted text and never speaks.
  Future<void> _refresh() async {
    setState(() => _loading = true);
    try {
      final json = await widget.client.catalogJson();
      await widget.store.cacheCatalog(json);
      if (!mounted) return;
      setState(() {
        _catalog = CheCommandCatalog.fromJson(json);
        _fromCache = false;
        _loadError = '';
      });
    } on Object catch (e) {
      if (!mounted) return;
      final text = e is TimeoutException ? 'CHE did not answer in time' : e.toString();
      setState(() => _loadError = text.length > 240 ? '${text.substring(0, 240)}…' : text);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// The result of something the owner did: a visible banner, a haptic and
  /// CHE's voice saying the real outcome.
  void _report(String text, {bool ok = true}) {
    setState(() {
      _status = text;
      _statusOk = ok;
    });
    HapticFeedback.heavyImpact();
    if (!ok) HapticFeedback.vibrate();
    widget.onSpeak?.call(text);
  }

  // ── Actions ──────────────────────────────────────────────────────────

  Future<void> _run(CheCommandInfo command) async {
    final ask = await cheAskToRun(context, command);
    if (ask == null || !mounted) return;
    await widget.store.noteUsed(command.id);
    if (!mounted) return;
    // Back to Chat, where CHE runs it and says the real result.
    Navigator.of(context).popUntil((route) => route.isFirst);
    await widget.onRunInChat(ask.message, confirmed: ask.confirmed);
  }

  Future<void> _openDetail(CheCommandInfo command) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheCommandDetailScreen(
        command: command,
        catalog: _catalog,
        favorite: widget.store.isFavorite(command.id),
        onRun: _run,
        onToggleFavorite: () => widget.store.toggleFavorite(command.id),
        onAddToWorkflow: (c) {
          Navigator.of(context).pop();
          unawaited(_openBuilder(CheSavedWorkflow(name: '', steps: [CheWorkflowStepDraft(command: c.id)])));
        },
        onSpeak: widget.onSpeak,
      ),
    ));
  }

  Future<void> _openBuilder([CheSavedWorkflow? initial]) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheWorkflowBuilderScreen(
        catalog: _catalog,
        client: widget.client,
        initial: initial,
        onSpeak: widget.onSpeak,
        onSaved: (_, all) => setState(() => _catalog = _withWorkflows(all)),
        onStarted: () => setState(() => _tab = 2),
      ),
    ));
    if (mounted) unawaited(_refresh());
  }

  CheCommandCatalog _withWorkflows(List<CheSavedWorkflow> all) => CheCommandCatalog(
        categories: _catalog.categories,
        commands: _catalog.commands,
        connectors: _catalog.connectors,
        templates: _catalog.templates,
        workflows: all,
        runs: _catalog.runs,
        missions: _catalog.missions,
      );

  Future<void> _runSaved(CheSavedWorkflow workflow) async {
    final approvals = [
      for (final s in workflow.steps)
        if (_catalog.byId(s.command)?.approvalRequired == true) '/${s.command}',
    ];
    final go = await showCupertinoDialog<bool>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text('Run "${workflow.name}"?'),
        content: Text([
          '${workflow.steps.length} steps run on CHE\'s mission queue, each through her normal chat and its permissions.',
          if (approvals.isNotEmpty) 'These wait for your approval when they are reached: ${approvals.join(', ')}.',
        ].join('\n\n')),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
          CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx, true), child: const Text('Run')),
        ],
      ),
    );
    if (go != true || !mounted) return;
    setState(() => _busy = true);
    final result = await widget.client.run(workflow);
    if (!mounted) return;
    setState(() => _busy = false);
    _report(result.message, ok: result.ok);
    if (result.ok) {
      setState(() => _tab = 2);
      await _refresh();
    }
  }

  Future<void> _deleteSaved(CheSavedWorkflow workflow) async {
    // Owner rule: ask before deleting anything.
    final yes = await showCupertinoDialog<bool>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text('Delete "${workflow.name}"?'),
        content: const Text('The saved workflow is removed from CHE. Past runs and their results stay.'),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep it')),
          CupertinoDialogAction(isDestructiveAction: true, onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    try {
      await widget.client.delete(workflow.id);
      if (!mounted) return;
      setState(() => _catalog = _withWorkflows([for (final w in _catalog.workflows) if (w.id != workflow.id) w]));
      _report('Deleted the saved workflow "${workflow.name}".');
    } on Object catch (e) {
      _report('CHE did not delete it: $e', ok: false);
    }
  }

  Future<void> _control(CheMission mission, String action, {String? stepId}) async {
    if (action == 'cancel') {
      final yes = await showCupertinoDialog<bool>(
        context: context,
        builder: (ctx) => CupertinoAlertDialog(
          title: Text('Cancel "${mission.name}"?'),
          content: const Text('Steps that have not finished are cancelled. Finished results are kept.'),
          actions: [
            CupertinoDialogAction(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep running')),
            CupertinoDialogAction(isDestructiveAction: true, onPressed: () => Navigator.pop(ctx, true), child: const Text('Cancel run')),
          ],
        ),
      );
      if (yes != true || !mounted) return;
    }
    setState(() => _busy = true);
    final result = await widget.client.control(mission.id, action, stepId: stepId);
    if (!mounted) return;
    setState(() => _busy = false);
    _report(result.ok ? result.message : 'CHE did not $action it: ${result.message}', ok: result.ok);
    await _refresh();
  }

  String _pageSummary() {
    final ready = _catalog.commands.where((c) => c.canRun).length;
    final setup = _catalog.commands.where((c) => c.status == CheCommandStatus.setupRequired).length;
    final favorites = [for (final id in widget.store.favorites) '/$id'];
    return [
      'Commands. ${_catalog.commands.length} commands in ${_catalog.categories.length} categories.',
      '$ready ready now${setup > 0 ? ', $setup need setup' : ''}.',
      if (favorites.isNotEmpty) 'Favorites: ${favorites.join(', ')}.',
      if (_catalog.workflows.isNotEmpty) '${_catalog.workflows.length} saved workflows.',
      'Search by name or say what you want to do.',
    ].join(' ');
  }

  // ── UI ───────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(
        backgroundColor: CheColors.bg,
        leading: IconButton(
          tooltip: 'Back to Chat',
          icon: const Icon(Icons.arrow_back_ios_new_rounded),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Text('Commands', style: CheType.title.copyWith(fontSize: 22, fontWeight: FontWeight.w800)),
        actions: [
          IconButton(
            tooltip: 'Read this page aloud',
            icon: const Icon(Icons.volume_up_rounded),
            onPressed: widget.onSpeak == null ? null : () => widget.onSpeak!(_pageSummary()),
          ),
          IconButton(
            tooltip: 'Refresh from CHE',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            _tabs(),
            if (_status.isNotEmpty) _banner(),
            if (_loadError.isNotEmpty || _loading || _fromCache) _quietNote(),
            Expanded(
              child: switch (_tab) {
                1 => _workflowsTab(),
                2 => _activityTab(),
                _ => _libraryTab(),
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _tabs() {
    const labels = ['Library', 'Workflows', 'Activity'];
    return Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 4, CheSpace.gutter, 8),
      child: Row(
        children: [
          for (final (i, label) in labels.indexed) ...[
            if (i > 0) const SizedBox(width: 8),
            Expanded(
              child: Semantics(
                button: true,
                selected: _tab == i,
                label: '$label tab, ${i + 1} of 3',
                excludeSemantics: true,
                child: InkWell(
                  borderRadius: BorderRadius.circular(CheRadius.pill),
                  onTap: () {
                    HapticFeedback.selectionClick();
                    setState(() => _tab = i);
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
                    decoration: BoxDecoration(
                      color: _tab == i ? CheColors.accent.withValues(alpha: 0.18) : CheColors.surface,
                      borderRadius: BorderRadius.circular(CheRadius.pill),
                      border: Border.all(color: _tab == i ? CheColors.accent : CheColors.stroke),
                    ),
                    child: Text(
                      label,
                      textAlign: TextAlign.center,
                      style: CheType.label.copyWith(color: _tab == i ? CheColors.accent : CheColors.textDim),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _banner() {
    final color = _statusOk ? CheColors.success : CheColors.danger;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 8),
        padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(CheRadius.sm),
          border: Border.all(color: color.withValues(alpha: 0.5)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: Text(_status, style: CheType.body)),
            IconButton(
              tooltip: 'Hide this message',
              visualDensity: VisualDensity.compact,
              onPressed: () => setState(() => _status = ''),
              icon: const Icon(Icons.close_rounded, size: 18),
            ),
          ],
        ),
      ),
    );
  }

  /// Passive status: muted text, no speech, no forced announcement.
  Widget _quietNote() {
    final text = _loading
        ? 'Checking with CHE…'
        : _loadError.isNotEmpty
            ? (_catalog.isEmpty
                ? 'Could not reach CHE: $_loadError'
                : 'Could not reach CHE ($_loadError). Showing the last list CHE sent; statuses may be out of date.')
            : 'Showing the last list CHE sent.';
    return Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 6),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(text, style: CheType.caption.copyWith(color: _loadError.isNotEmpty ? CheColors.warning : CheColors.textDim)),
      ),
    );
  }

  Widget _libraryTab() {
    if (_catalog.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_loading ? 'Loading commands…' : 'No commands yet. Check that CHE is connected, then refresh.',
              style: CheType.bodyDim, textAlign: TextAlign.center),
        ),
      );
    }
    final query = _query.trim();
    final List<CheCommandInfo> shown = query.isNotEmpty
        ? _catalog.search(query)
        : _category == 'all'
            ? _catalog.commands
            : _catalog.inCategory(_category);
    final favorites = [for (final id in widget.store.favorites) ?_catalog.byId(id)];
    final recents = [for (final id in widget.store.recents) ?_catalog.byId(id)];
    final header = Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 4),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _search,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search_rounded),
              labelText: 'Search commands or describe a goal',
              hintText: 'For example: find website clients',
              suffixIcon: _query.isEmpty
                  ? null
                  : IconButton(
                      tooltip: 'Clear search',
                      icon: const Icon(Icons.close_rounded),
                      onPressed: () {
                        _search.clear();
                        setState(() => _query = '');
                      },
                    ),
            ),
            onChanged: (v) {
              setState(() => _query = v);
              _toTop();
            },
          ),
          const SizedBox(height: 10),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _categoryChip('all', 'All', _catalog.commands.length),
                for (final c in _catalog.categories) _categoryChip(c.id, c.title, _catalog.inCategory(c.id).length),
              ],
            ),
          ),
        ],
      ),
    );
    final rows = <Widget>[];
    if (query.isEmpty && _category == 'all') {
      if (favorites.isNotEmpty) {
        rows.add(const CheSectionHeader('Favorites'));
        rows.addAll(favorites.map(_tile));
      }
      if (recents.isNotEmpty) {
        rows.add(const CheSectionHeader('Recently used'));
        rows.addAll(recents.take(4).map(_tile));
      }
      for (final category in _catalog.categories) {
        rows.add(CheSectionHeader(category.title));
        rows.add(Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(category.summary, style: CheType.caption)));
        rows.addAll(_catalog.inCategory(category.id).map(_tile));
      }
    } else {
      rows.add(CheSectionHeader(query.isNotEmpty
          ? '${shown.length} match${shown.length == 1 ? '' : 'es'} for "$query"'
          : _catalog.categories.firstWhere((c) => c.id == _category).title));
      if (shown.isEmpty) {
        rows.add(Text('No command matches that yet. Try other words, or ask CHE in Chat.', style: CheType.bodyDim));
      }
      rows.addAll(shown.map(_tile));
    }
    return Column(
      children: [
        header,
        Expanded(
          child: ListView.builder(
            key: const ValueKey('command-library'),
            controller: _libraryScroll,
            padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 32),
            itemCount: rows.length,
            itemBuilder: (_, i) => rows[i],
          ),
        ),
      ],
    );
  }

  Widget _categoryChip(String id, String title, int count) {
    final selected = _category == id;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text('$title $count'),
        selected: selected,
        tooltip: '$title, $count commands',
        onSelected: (_) {
          HapticFeedback.selectionClick();
          setState(() {
            _category = id;
            _query = '';
            _search.clear();
          });
          _toTop();
        },
      ),
    );
  }

  Widget _tile(CheCommandInfo c) => CheCommandTile(
        key: ValueKey('cmd-${c.id}'),
        command: c,
        favorite: widget.store.isFavorite(c.id),
        onOpen: () => _openDetail(c),
        onToggleFavorite: () async {
          final now = await widget.store.toggleFavorite(c.id);
          if (mounted) {
            setState(() {
              _status = now ? '${c.slash} added to favorites.' : '${c.slash} removed from favorites.';
              _statusOk = true;
            });
          }
        },
      );

  Widget _workflowsTab() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 32),
      children: [
        FilledButton.icon(
          onPressed: _catalog.isEmpty ? null : () => _openBuilder(),
          icon: const Icon(Icons.account_tree_rounded),
          label: const Text('Build a workflow'),
        ),
        const CheSectionHeader('Saved workflows'),
        if (_catalog.workflows.isEmpty)
          Text('No saved workflows yet. Build one, or start from a template below.', style: CheType.bodyDim),
        for (final w in _catalog.workflows) _workflowCard(w, saved: true),
        if (_catalog.templates.isNotEmpty) ...[
          const CheSectionHeader('Templates'),
          for (final t in _catalog.templates) _workflowCard(t, saved: false),
        ],
      ],
    );
  }

  Widget _workflowCard(CheSavedWorkflow w, {required bool saved}) {
    final chain = w.steps.map((s) => '/${s.command}').join(' → ');
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: CheColors.surface,
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: CheColors.stroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(header: true, child: Text(w.name, style: CheType.headline)),
          const SizedBox(height: 4),
          Text(chain, style: CheType.mono.copyWith(color: CheColors.textDim)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: saved
                ? [
                    FilledButton.icon(
                      onPressed: _busy ? null : () => _runSaved(w),
                      icon: const Icon(Icons.play_arrow_rounded),
                      label: Text('Run ${w.name}'),
                    ),
                    OutlinedButton.icon(
                      onPressed: () => _openBuilder(w),
                      icon: const Icon(Icons.edit_rounded),
                      label: const Text('Edit'),
                    ),
                    OutlinedButton.icon(
                      onPressed: () => _deleteSaved(w),
                      icon: const Icon(Icons.delete_outline_rounded),
                      label: const Text('Delete'),
                    ),
                  ]
                : [
                    OutlinedButton.icon(
                      onPressed: () => _openBuilder(CheSavedWorkflow(name: w.name, steps: [for (final s in w.steps) s.copy()])),
                      icon: const Icon(Icons.copy_all_rounded),
                      label: Text('Use template: ${w.name}'),
                    ),
                  ],
          ),
        ],
      ),
    );
  }

  Widget _activityTab() {
    final missions = _catalog.missions;
    final runs = _catalog.runs;
    return ListView(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 32),
      children: [
        const CheSectionHeader('Workflow runs'),
        if (missions.isEmpty) Text('No workflow runs yet.', style: CheType.bodyDim),
        for (final m in missions)
          CheMissionCard(
            key: ValueKey('mission-${m.id}'),
            mission: m,
            busy: _busy,
            onControl: (action, {stepId}) => _control(m, action, stepId: stepId),
          ),
        const CheSectionHeader('Recent commands'),
        if (runs.isEmpty) Text('No commands run yet.', style: CheType.bodyDim),
        for (final r in runs)
          Semantics(
            label: '/${r.command}${r.input.isEmpty ? '' : ' ${r.input}'}: ${cheStepStatusLabel(r.status)}. ${r.reply}',
            excludeSemantics: true,
            child: Container(
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: CheColors.surface,
                borderRadius: BorderRadius.circular(CheRadius.sm),
                border: Border.all(color: CheColors.stroke),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text('/${r.command}${r.input.isEmpty ? '' : ' ${r.input}'}',
                            style: CheType.mono.copyWith(color: CheColors.accent)),
                      ),
                      ChePill(text: cheStepStatusLabel(r.status), color: cheStepColor(r.status)),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(r.reply, style: CheType.bodyDim),
                  if (r.source.isNotEmpty) Text('Handled by ${r.source}', style: CheType.caption),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
