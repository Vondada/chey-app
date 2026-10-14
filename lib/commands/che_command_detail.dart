// One command, explained from CHE's own catalog: what it does, what it
// needs and whether that is connected, whether it needs the owner's
// approval, what to say, and a Run button that hands it to CHE's chat.
import 'package:flutter/cupertino.dart' show CupertinoAlertDialog, CupertinoDialogAction, showCupertinoDialog;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import 'che_command_models.dart';
import 'che_command_widgets.dart';

/// Asks for the command's input (when it has one), then for approval (when
/// it needs one). Returns the request to send, or null when the owner
/// stopped. `confirmed` is true only when the owner approved here.
Future<({String message, bool confirmed})?> cheAskToRun(BuildContext context, CheCommandInfo command) async {
  var input = '';
  if (command.input != null) {
    final typed = await showDialog<String>(context: context, builder: (_) => _CommandInputDialog(command: command));
    if (typed == null) return null;
    input = typed.trim();
    if (command.input!.required && input.isEmpty) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${command.slash} needs ${command.input!.hint.toLowerCase()}. Nothing was run.')));
      }
      return null;
    }
  }
  var confirmed = false;
  if (command.approvalRequired) {
    if (!context.mounted) return null;
    final approve = await showCupertinoDialog<bool>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text('Approve ${command.slash}?'),
        content: Text('${command.approvalReason} CHE runs it now in Chat and reports the real result. Money, delete and app permissions still ask separately.'),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
          CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx, true), child: const Text('Approve and run')),
        ],
      ),
    );
    if (approve != true) return null;
    confirmed = true;
  }
  final message = [command.slash, if (input.isNotEmpty) input].join(' ');
  return (message: message, confirmed: confirmed);
}

/// Owns its text field's controller, so closing the dialog never touches a
/// disposed controller while the exit animation still runs.
class _CommandInputDialog extends StatefulWidget {
  const _CommandInputDialog({required this.command});
  final CheCommandInfo command;

  @override
  State<_CommandInputDialog> createState() => _CommandInputDialogState();
}

class _CommandInputDialogState extends State<_CommandInputDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final command = widget.command;
    return AlertDialog(
      backgroundColor: CheColors.surfaceHi,
      title: Text('Run ${command.slash}'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(command.summary, style: CheType.bodyDim),
          const SizedBox(height: 12),
          TextField(
            controller: _controller,
            autofocus: true,
            minLines: 1,
            maxLines: 4,
            textInputAction: TextInputAction.done,
            decoration: InputDecoration(
              labelText: command.input!.hint,
              helperText: command.input!.required ? 'Required' : 'Optional',
            ),
            onSubmitted: (v) => Navigator.pop(context, v),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, _controller.text), child: const Text('Continue')),
      ],
    );
  }
}

class CheCommandDetailScreen extends StatelessWidget {
  const CheCommandDetailScreen({
    super.key,
    required this.command,
    required this.catalog,
    required this.favorite,
    required this.onRun,
    required this.onToggleFavorite,
    required this.onAddToWorkflow,
    this.onSpeak,
  });

  final CheCommandInfo command;
  final CheCommandCatalog catalog;
  final bool favorite;
  final Future<void> Function(CheCommandInfo command) onRun;
  final Future<bool> Function() onToggleFavorite;
  final void Function(CheCommandInfo command) onAddToWorkflow;
  final void Function(String text)? onSpeak;

  @override
  Widget build(BuildContext context) {
    final c = command;
    final category = catalog.categories.where((x) => x.id == c.category).map((x) => x.title).firstOrNull ?? c.category;
    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(
        backgroundColor: CheColors.bg,
        leading: const BackButton(),
        title: Text(c.slash, style: CheType.mono.copyWith(fontSize: 18, color: CheColors.accent, fontWeight: FontWeight.w800)),
        actions: [
          IconButton(
            tooltip: 'Read this command aloud',
            icon: const Icon(Icons.volume_up_rounded),
            onPressed: onSpeak == null ? null : () => onSpeak!(c.spoken),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 4, CheSpace.gutter, 32),
          children: [
            Semantics(header: true, child: Text(c.title, style: CheType.title)),
            const SizedBox(height: 4),
            Text(category, style: CheType.caption),
            const SizedBox(height: 10),
            Text(c.summary, style: CheType.body.copyWith(fontSize: 17)),
            const SizedBox(height: 12),
            Wrap(spacing: 6, runSpacing: 6, children: [
              ChePill(text: cheCommandStatusLabel(c.status), color: cheStatusColor(c.status)),
              ChePill(text: cheModeLabel(c.mode), color: CheColors.accentAlt, icon: cheModeIcon(c.mode)),
              if (c.approvalRequired) const ChePill(text: 'Needs your approval', color: CheColors.warning, icon: Icons.verified_user_rounded),
            ]),
            const CheSectionHeader('What it can actually do'),
            Text(c.does, style: CheType.body),
            const CheSectionHeader('Requirements'),
            ..._requirements(),
            const CheSectionHeader('Approval'),
            Text(
              c.approvalRequired
                  ? 'Needs your approval first: ${c.approvalReason}'
                  : c.mode == 'BUILD'
                      ? 'No extra approval. CHE\'s money, delete and app permissions still ask you first.'
                      : 'No approval needed: it does not act outside CHE.',
              style: CheType.body,
            ),
            const CheSectionHeader('Input'),
            Text(c.input == null ? 'No input needed.' : '${c.input!.hint} (${c.input!.required ? 'required' : 'optional'}).', style: CheType.body),
            if (c.examples.isNotEmpty) ...[
              const CheSectionHeader('Say it'),
              for (final e in c.examples)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text('“$e”', style: CheType.body.copyWith(fontStyle: FontStyle.italic)),
                ),
            ],
            const CheSectionHeader('Results and evidence'),
            Text('Produces: ${c.produces}.', style: CheType.body),
            const SizedBox(height: 4),
            Text(c.evidence, style: CheType.bodyDim),
            const CheSectionHeader('Cost'),
            Text(c.cost, style: CheType.bodyDim),
            const CheSectionHeader('Runs on'),
            Text(c.handler, style: CheType.mono.copyWith(color: CheColors.textDim)),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: c.canRun
                  ? () {
                      HapticFeedback.mediumImpact();
                      onRun(c);
                    }
                  : null,
              icon: const Icon(Icons.play_arrow_rounded),
              label: Text(c.canRun ? 'Run ${c.slash} in Chat' : '${cheCommandStatusLabel(c.status)}: cannot run yet'),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: () => onAddToWorkflow(c),
              icon: const Icon(Icons.account_tree_rounded),
              label: const Text('Add to a workflow'),
            ),
            const SizedBox(height: 10),
            _FavoriteButton(initial: favorite, slash: c.slash, onToggle: onToggleFavorite),
          ],
        ),
      ),
    );
  }

  List<Widget> _requirements() {
    final c = command;
    if (c.needs.isEmpty) return [Text('Nothing to connect.', style: CheType.body)];
    return [
      for (final id in [...c.needs, ...c.optional])
        Builder(builder: (context) {
          final connector = catalog.connectors[id];
          final ready = connector?.ready == true;
          final optional = !c.needs.contains(id);
          final missing = c.missing.where((m) => m.id == id).firstOrNull;
          final label = connector?.label ?? id;
          return Semantics(
            label: '$label: ${ready ? 'connected' : optional ? 'optional, not connected' : 'not connected'}.'
                '${!ready && (missing?.setup ?? connector?.setup ?? '').isNotEmpty ? ' To set up: ${missing?.setup ?? connector?.setup}' : ''}',
            excludeSemantics: true,
            child: Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(ready ? Icons.check_circle_rounded : Icons.error_outline_rounded,
                      size: 18, color: ready ? CheColors.success : (optional ? CheColors.textDim : CheColors.warning)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('$label${optional ? ' (optional)' : ''}', style: CheType.label),
                        if (!ready)
                          Text(missing?.setup.isNotEmpty == true ? missing!.setup : (connector?.setup ?? ''), style: CheType.caption),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
        }),
    ];
  }
}

class _FavoriteButton extends StatefulWidget {
  const _FavoriteButton({required this.initial, required this.slash, required this.onToggle});
  final bool initial;
  final String slash;
  final Future<bool> Function() onToggle;

  @override
  State<_FavoriteButton> createState() => _FavoriteButtonState();
}

class _FavoriteButtonState extends State<_FavoriteButton> {
  late bool _on = widget.initial;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: () async {
        HapticFeedback.lightImpact();
        final now = await widget.onToggle();
        if (mounted) setState(() => _on = now);
      },
      icon: Icon(_on ? Icons.star_rounded : Icons.star_outline_rounded, color: _on ? CheColors.warning : null),
      label: Text(_on ? 'Favorite · tap to remove' : 'Add to favorites'),
    );
  }
}
