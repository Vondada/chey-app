// Visual Workflow Builder. The owner picks commands and orders them; CHE
// validates the plan (dependencies, connectors, approval checkpoints) and
// runs it on her existing mission graph. Nothing here runs a step itself.
import 'package:flutter/cupertino.dart' show CupertinoAlertDialog, CupertinoDialogAction, showCupertinoDialog;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import 'che_command_client.dart';
import 'che_command_models.dart';
import 'che_command_widgets.dart';

/// Which earlier steps a step waits for, by the same rule CHE uses: each
/// step waits for the one before it unless it runs together with it.
List<List<int>> cheWorkflowDependencies(List<CheWorkflowStepDraft> steps) {
  final deps = <List<int>>[];
  for (var i = 0; i < steps.length; i++) {
    if (i == 0) {
      deps.add(const []);
    } else if (steps[i].parallel) {
      deps.add(deps[i - 1]);
    } else {
      deps.add([i - 1]);
    }
  }
  return deps;
}

Future<String?> chePickCommand(BuildContext context, CheCommandCatalog catalog) {
  return Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => _CommandPicker(catalog: catalog)));
}

class CheWorkflowBuilderScreen extends StatefulWidget {
  const CheWorkflowBuilderScreen({
    super.key,
    required this.catalog,
    required this.client,
    this.initial,
    this.onSpeak,
    this.onSaved,
    this.onStarted,
  });

  final CheCommandCatalog catalog;
  final CheCommandClient client;
  final CheSavedWorkflow? initial;
  final void Function(String text)? onSpeak;
  final void Function(CheSavedWorkflow saved, List<CheSavedWorkflow> all)? onSaved;
  final VoidCallback? onStarted;

  @override
  State<CheWorkflowBuilderScreen> createState() => _CheWorkflowBuilderScreenState();
}

class _CheWorkflowBuilderScreenState extends State<CheWorkflowBuilderScreen> {
  late final TextEditingController _name = TextEditingController(text: widget.initial?.name ?? '');
  late List<CheWorkflowStepDraft> _steps = [for (final s in widget.initial?.steps ?? const <CheWorkflowStepDraft>[]) s.copy()];
  late String _id = widget.initial?.id ?? '';
  CheWorkflowPlan? _plan;
  bool _busy = false;
  String _status = '';
  bool _statusOk = true;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _changed() => setState(() => _plan = null);

  /// Visible banner, a haptic, and CHE's voice: the owner asked for this.
  void _report(String text, {bool ok = true}) {
    setState(() {
      _status = text;
      _statusOk = ok;
    });
    HapticFeedback.heavyImpact();
    if (!ok) HapticFeedback.vibrate();
    widget.onSpeak?.call(text);
  }

  Future<void> _addStep() async {
    final id = await chePickCommand(context, widget.catalog);
    if (id == null || !mounted) return;
    setState(() {
      _steps = [..._steps, CheWorkflowStepDraft(command: id)];
      _plan = null;
    });
  }

  void _move(int i, int delta) {
    final j = i + delta;
    if (j < 0 || j >= _steps.length) return;
    HapticFeedback.selectionClick();
    setState(() {
      final step = _steps.removeAt(i);
      _steps.insert(j, step);
      if (_steps.isNotEmpty) _steps.first.parallel = false;
      _plan = null;
    });
  }

  void _remove(int i) {
    HapticFeedback.selectionClick();
    setState(() {
      _steps.removeAt(i);
      if (_steps.isNotEmpty) _steps.first.parallel = false;
      _plan = null;
    });
  }

  CheSavedWorkflow get _draft => CheSavedWorkflow(id: _id, name: _name.text.trim(), steps: _steps);

  Future<CheWorkflowPlan?> _check({bool announce = true}) async {
    setState(() => _busy = true);
    try {
      final plan = await widget.client.describe(_draft.name, _steps);
      if (!mounted) return null;
      setState(() => _plan = plan);
      if (announce) {
        _report(
          plan.ok
              ? 'The workflow checks out: ${plan.steps.length} steps${plan.approvals.isEmpty ? '' : ', ${plan.approvals.length} waiting for your approval when they are reached'}.'
              : 'The workflow has ${plan.issues.length} problem${plan.issues.length == 1 ? '' : 's'}: ${plan.issues.join(' ')}',
          ok: plan.ok,
        );
      }
      return plan;
    } on Object catch (e) {
      _report('I could not check the workflow with CHE: $e', ok: false);
      return null;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<bool> _save() async {
    if (_name.text.trim().isEmpty || _steps.isEmpty) {
      _report('Give the workflow a name and at least one command first. Nothing was saved.', ok: false);
      return false;
    }
    setState(() => _busy = true);
    try {
      final (saved, all) = await widget.client.save(_draft);
      if (!mounted) return true;
      setState(() => _id = saved.id);
      widget.onSaved?.call(saved, all);
      _report(
        'Saved "${saved.name}" with ${saved.steps.length} step${saved.steps.length == 1 ? '' : 's'}. CHE remembers it; say "run my ${saved.name} workflow" any time.',
      );
      return true;
    } on Object catch (e) {
      _report('CHE did not save the workflow: $e', ok: false);
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _run() async {
    final plan = await _check(announce: false);
    if (plan == null || !mounted) return;
    if (!plan.ok || !plan.runnable) {
      _report('I did not start it: ${plan.issues.join(' ')} Nothing was run.', ok: false);
      return;
    }
    final approvals = plan.steps.where((s) => s.approvalRequired).toList();
    final go = await showCupertinoDialog<bool>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text('Run "${plan.name}"?'),
        content: Text(
          [
            '${plan.steps.length} steps run on CHE\'s mission queue, each through her normal chat and its permissions.',
            if (approvals.isNotEmpty)
              'These steps stop and wait for your approval when they are reached: ${approvals.map((s) => '/${s.command}').join(', ')}.',
          ].join('\n\n'),
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
          CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx, true), child: const Text('Run')),
        ],
      ),
    );
    if (go != true || !mounted) return;
    if (!await _save()) return;
    setState(() => _busy = true);
    final result = await widget.client.run(_draft);
    if (!mounted) return;
    setState(() => _busy = false);
    _report(result.ok ? result.message : 'CHE did not start it: ${result.message}', ok: result.ok);
    if (result.ok) widget.onStarted?.call();
  }

  @override
  Widget build(BuildContext context) {
    final deps = cheWorkflowDependencies(_steps);
    final costs = {for (final s in _steps) widget.catalog.byId(s.command)?.cost ?? ''}.where((c) => c.isNotEmpty).toList();
    return Scaffold(
      backgroundColor: CheColors.screen,
      appBar: AppBar(
        backgroundColor: CheColors.screen,
        leading: const BackButton(),
        title: cheRoomTitle(_id.isEmpty ? 'Build workflow' : 'Edit workflow', CheType.headline),
        actions: [
          IconButton(
            tooltip: 'Read this workflow aloud',
            icon: const Icon(Icons.volume_up_rounded),
            onPressed: widget.onSpeak == null
                ? null
                : () => widget.onSpeak!(
                    _steps.isEmpty
                        ? 'This workflow has no steps yet.'
                        : 'Workflow ${_name.text.trim().isEmpty ? 'without a name' : _name.text.trim()}. ${[for (final (i, s) in _steps.indexed) 'Step ${i + 1}, /${s.command}${s.input.isEmpty ? '' : ', ${s.input}'}${s.parallel ? ', together with the step before' : ''}.'].join(' ')}',
                  ),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (_status.isNotEmpty)
              Semantics(
                liveRegion: true,
                child: Container(
                  width: double.infinity,
                  margin: const EdgeInsets.fromLTRB(CheSpace.gutter, 4, CheSpace.gutter, 4),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: (_statusOk ? CheColors.success : CheColors.danger).withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(CheRadius.sm),
                    border: Border.all(color: (_statusOk ? CheColors.success : CheColors.danger).withValues(alpha: 0.5)),
                  ),
                  child: Text(_status, style: CheType.body),
                ),
              ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 8, CheSpace.gutter, 32),
                children: [
                  TextField(
                    controller: _name,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: const InputDecoration(labelText: 'Workflow name', hintText: 'For example: Website clients'),
                    onChanged: (_) => _changed(),
                  ),
                  const CheSectionHeader('Steps in order'),
                  if (_steps.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Text('No steps yet. Add the commands you want, in the order they should run.', style: CheType.bodyDim),
                    ),
                  for (final (i, step) in _steps.indexed) ...[
                    if (i > 0)
                      ExcludeSemantics(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Center(
                            child: Text(
                              step.parallel ? '∥  runs together with step $i' : '↓  then',
                              style: CheType.caption.copyWith(color: CheColors.accent),
                            ),
                          ),
                        ),
                      ),
                    _StepCard(
                      key: ObjectKey(step),
                      index: i,
                      step: step,
                      count: _steps.length,
                      command: widget.catalog.byId(step.command),
                      catalog: widget.catalog,
                      waitsFor: deps[i],
                      planned: _plan?.steps.where((p) => p.id == 's${i + 1}').firstOrNull,
                      onChanged: _changed,
                      onMove: (d) => _move(i, d),
                      onRemove: () => _remove(i),
                    ),
                  ],
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: _busy || _steps.length >= 12 ? null : _addStep,
                    icon: const Icon(Icons.add_rounded),
                    label: const Text('Add command'),
                  ),
                  if (costs.isNotEmpty) ...[const CheSectionHeader('Cost'), for (final c in costs) Text('• $c', style: CheType.bodyDim)],
                  if (_plan != null && _plan!.issues.isNotEmpty) ...[
                    const CheSectionHeader('Needs attention'),
                    for (final issue in _plan!.issues)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Text('• $issue', style: CheType.body.copyWith(color: CheColors.warning)),
                      ),
                  ],
                  const SizedBox(height: 18),
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      OutlinedButton.icon(
                        onPressed: _busy || _steps.isEmpty ? null : () => _check(),
                        icon: const Icon(Icons.fact_check_rounded),
                        label: const Text('Check workflow'),
                      ),
                      OutlinedButton.icon(onPressed: _busy ? null : _save, icon: const Icon(Icons.save_rounded), label: const Text('Save')),
                      FilledButton.icon(
                        onPressed: _busy || _steps.isEmpty ? null : _run,
                        icon: const Icon(Icons.play_arrow_rounded),
                        label: const Text('Save and run'),
                      ),
                    ],
                  ),
                  if (_busy) const Padding(padding: EdgeInsets.only(top: 16), child: LinearProgressIndicator()),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StepCard extends StatefulWidget {
  const _StepCard({
    super.key,
    required this.index,
    required this.step,
    required this.count,
    required this.command,
    required this.catalog,
    required this.waitsFor,
    required this.planned,
    required this.onChanged,
    required this.onMove,
    required this.onRemove,
  });
  final int index;
  final CheWorkflowStepDraft step;
  final int count;
  final CheCommandInfo? command;
  final CheCommandCatalog catalog;
  final List<int> waitsFor;
  final CheWorkflowPlanStep? planned;
  final VoidCallback onChanged;
  final void Function(int delta) onMove;
  final VoidCallback onRemove;

  @override
  State<_StepCard> createState() => _StepCardState();
}

class _StepCardState extends State<_StepCard> {
  late final TextEditingController _input = TextEditingController(text: widget.step.input);

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.command;
    final n = widget.index + 1;
    final status = c?.status ?? CheCommandStatus.unknown;
    return cheMaterialCard(
      edge: c?.approvalRequired == true ? CheColors.warning.withValues(alpha: 0.6) : CheColors.stroke,
      glow: c?.approvalRequired == true ? CheColors.warning : null,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(
              header: true,
              child: Text(
                'Step $n · /${widget.step.command}',
                style: CheType.mono.copyWith(color: CheColors.accent, fontWeight: FontWeight.w700),
              ),
            ),
            const SizedBox(height: 4),
            Text(c?.summary ?? 'Not a CHE command.', style: CheType.body),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                ChePill(text: cheCommandStatusLabel(status), color: cheStatusColor(status)),
                if (c != null) ChePill(text: c.mode.toLowerCase(), color: CheColors.accentAlt),
                if (c?.approvalRequired == true)
                  const ChePill(text: 'approval checkpoint', color: CheColors.warning, icon: Icons.verified_user_rounded),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              widget.waitsFor.isEmpty
                  ? 'Starts first.'
                  : 'Uses the results of ${widget.waitsFor.map((d) => 'step ${d + 1}').join(' and ')}.',
              style: CheType.caption,
            ),
            if (c != null) Text('Produces: ${c.produces}.', style: CheType.caption),
            if (c != null && c.needs.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final id in c.needs)
                      Builder(
                        builder: (_) {
                          final conn = widget.catalog.connectors[id];
                          final ready = conn?.ready == true;
                          return ChePill(
                            text: conn?.label ?? id,
                            color: ready ? CheColors.success : CheColors.warning,
                            icon: ready ? Icons.link_rounded : Icons.link_off_rounded,
                          );
                        },
                      ),
                  ],
                ),
              ),
            if (c?.input != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: TextField(
                  controller: _input,
                  decoration: InputDecoration(
                    labelText: 'Step $n input: ${c!.input!.hint}',
                    helperText: widget.index == 0 && c.input!.required ? 'Required' : 'Optional when earlier steps supply it',
                  ),
                  onChanged: (v) {
                    widget.step.input = v;
                    widget.onChanged();
                  },
                ),
              ),
            if (widget.index > 0)
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('Run together with step ${widget.index}', style: CheType.label),
                subtitle: Text('Only for steps that do not need its result.', style: CheType.caption),
                value: widget.step.parallel,
                onChanged: (v) {
                  HapticFeedback.selectionClick();
                  setState(() => widget.step.parallel = v);
                  widget.onChanged();
                },
              ),
            Row(
              children: [
                IconButton(
                  tooltip: 'Move step $n up',
                  onPressed: widget.index == 0 ? null : () => widget.onMove(-1),
                  icon: const Icon(Icons.arrow_upward_rounded),
                ),
                IconButton(
                  tooltip: 'Move step $n down',
                  onPressed: widget.index == widget.count - 1 ? null : () => widget.onMove(1),
                  icon: const Icon(Icons.arrow_downward_rounded),
                ),
                const Spacer(),
                IconButton(
                  tooltip: 'Remove step $n from this workflow',
                  onPressed: widget.onRemove,
                  icon: const Icon(Icons.remove_circle_outline_rounded, color: CheColors.danger),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _CommandPicker extends StatefulWidget {
  const _CommandPicker({required this.catalog});
  final CheCommandCatalog catalog;

  @override
  State<_CommandPicker> createState() => _CommandPickerState();
}

class _CommandPickerState extends State<_CommandPicker> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final results = _query.trim().isEmpty ? widget.catalog.commands : widget.catalog.search(_query, limit: 30);
    return Scaffold(
      backgroundColor: CheColors.screen,
      appBar: AppBar(backgroundColor: CheColors.screen, leading: const BackButton(), title: const Text('Add a command')),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 8, CheSpace.gutter, 8),
              child: TextField(
                autofocus: true,
                decoration: const InputDecoration(prefixIcon: Icon(Icons.search_rounded), labelText: 'Search commands or describe a goal'),
                onChanged: (v) => setState(() => _query = v),
              ),
            ),
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
                itemCount: results.length,
                itemBuilder: (context, i) {
                  final c = results[i];
                  return ListTile(
                    title: Text(c.slash, style: CheType.mono.copyWith(color: CheColors.accent)),
                    subtitle: Text('${c.summary} ${cheCommandStatusLabel(c.status)}.', style: CheType.bodyDim),
                    trailing: c.approvalRequired
                        ? const Icon(Icons.verified_user_rounded, color: CheColors.warning, semanticLabel: 'Needs approval')
                        : null,
                    onTap: () => Navigator.pop(context, c.id),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
