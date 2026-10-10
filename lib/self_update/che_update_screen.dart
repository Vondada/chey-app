import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_mobile_update.dart';
import 'che_update_controller.dart';
import 'che_update_plan.dart';

/// Asks the owner to confirm, then hands the IPA to SideStore.
///
/// Returns what CHE should say about the result, or null when the owner
/// declined. The install is not confirmed here; the next launch confirms it.
Future<String?> confirmAndInstallCheUpdate(
  BuildContext context,
  CheMobileUpdateInfo target, {
  bool rollback = false,
}) async {
  final controller = CheUpdateController.instance;
  final confirmed = await showCupertinoDialog<bool>(
    context: context,
    builder: (dialogContext) => CupertinoAlertDialog(
      title: Text(
        rollback
            ? 'Go back to CHE ${target.version}?'
            : 'Install CHE ${target.version}?',
      ),
      content: Text(
        rollback
            ? 'SideStore will open to install this older build. Use this only if the current build is broken.'
            : 'SideStore will open to install build ${target.buildNumber} over CHE. You confirm the install there. CHE checks the result the next time it opens.',
      ),
      actions: [
        CupertinoDialogAction(
          onPressed: () => Navigator.pop(dialogContext, false),
          child: const Text('Not now'),
        ),
        CupertinoDialogAction(
          isDefaultAction: true,
          onPressed: () => Navigator.pop(dialogContext, true),
          child: Text(rollback ? 'Go back' : 'Update'),
        ),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return null;
  HapticFeedback.mediumImpact();
  final opened = await controller.installFullBuild(target);
  if (opened) {
    return 'SideStore is open. Confirm the install there. CHE checks the result the next time it opens.';
  }
  return controller.plan.spoken;
}

/// The CHE Updates screen: one status, one primary button, a progress bar
/// while work runs. It has no option lists, checksums or source setup.
class CheMobileUpdateScreen extends StatefulWidget {
  const CheMobileUpdateScreen({
    super.key,
    required this.baseUrl,
    required this.onSpeak,
    this.rollback = false,
  });

  final String baseUrl;
  final CheSpeak onSpeak;

  /// Opened by the "roll back" voice command. Offers the previous verified
  /// build behind its own confirmation. It is not shown on the normal screen.
  final bool rollback;

  @override
  State<CheMobileUpdateScreen> createState() => _CheMobileUpdateScreenState();
}

class _CheMobileUpdateScreenState extends State<CheMobileUpdateScreen> {
  final _controller = CheUpdateController.instance;
  CheUpdateStage? _spokenStage;
  bool _busy = false;
  bool _rollbackOffered = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onChanged);
    _controller.configure(widget.baseUrl);
    _controller.start();
    WidgetsBinding.instance.addPostFrameCallback((_) => _announce());
  }

  @override
  void dispose() {
    _controller.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() {
    if (!mounted || _busy) return;
    _announce();
  }

  /// Speaks each settled stage once. Work that the owner started speaks its
  /// own result instead, so nothing is said twice.
  void _announce() {
    if (!mounted || _controller.checking) return;
    final plan = _controller.plan;
    if (plan.stage != _spokenStage) {
      _spokenStage = plan.stage;
      unawaited(widget.onSpeak(plan.spoken));
    }
    if (widget.rollback && !_rollbackOffered) {
      _rollbackOffered = true;
      _offerRollback();
    }
  }

  void _offerRollback() {
    final target = _controller.previousVerifiedBuild();
    if (target == null) {
      unawaited(
        widget.onSpeak(
          'There is no earlier verified CHE build to go back to. CHE is unchanged.',
        ),
      );
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_install(target, rollback: true));
    });
  }

  Future<void> _checkAgain() async {
    _busy = true;
    try {
      await _controller.refresh(force: true);
    } finally {
      _busy = false;
    }
    if (!mounted) return;
    _spokenStage = _controller.plan.stage;
    await widget.onSpeak(_controller.plan.spoken);
  }

  Future<void> _install(
    CheMobileUpdateInfo target, {
    bool rollback = false,
  }) async {
    _busy = true;
    String? said;
    try {
      said = await confirmAndInstallCheUpdate(
        context,
        target,
        rollback: rollback,
      );
    } finally {
      _busy = false;
    }
    if (said == null || !mounted) return;
    _spokenStage = _controller.plan.stage;
    await widget.onSpeak(said);
  }

  Future<void> _explainRestart() async {
    HapticFeedback.mediumImpact();
    await widget.onSpeak(
      'The update is downloaded. Reopen CHE to finish: close CHE from the app switcher, then open it again.',
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _controller,
      builder: (context, _) {
        final plan = _controller.plan;
        final theme = Theme.of(context);
        return Scaffold(
          appBar: AppBar(title: const Text('CHE Updates')),
          body: SafeArea(
            child: RefreshIndicator(
              onRefresh: _checkAgain,
              child: ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  Semantics(
                    liveRegion: true,
                    header: true,
                    child: Text(
                      plan.headline,
                      style: theme.textTheme.headlineSmall,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(plan.detail, style: theme.textTheme.bodyLarge),
                  if (plan.showProgress) ...[
                    const SizedBox(height: 20),
                    Semantics(
                      label: plan.headline,
                      child: const LinearProgressIndicator(),
                    ),
                  ],
                  if (plan.stage == CheUpdateStage.fullReady)
                    ..._releaseNotes(theme),
                  const SizedBox(height: 24),
                  _primaryAction(plan),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  List<Widget> _releaseNotes(ThemeData theme) {
    final notes = _controller.latest?.releaseNotes.trim() ?? '';
    if (notes.isEmpty) return const [];
    return [
      const SizedBox(height: 20),
      Text('What changed', style: theme.textTheme.titleMedium),
      const SizedBox(height: 6),
      Text(notes),
    ];
  }

  Widget _primaryAction(CheUpdatePlan plan) {
    final latest = _controller.latest;
    if (plan.action == CheUpdateAction.installFullBuild && latest != null) {
      return FilledButton.icon(
        onPressed: _busy ? null : () => _install(latest),
        icon: const Icon(Icons.system_update_rounded),
        label: const Text('Update'),
      );
    }
    if (plan.action == CheUpdateAction.explainRestart) {
      return FilledButton.icon(
        onPressed: _explainRestart,
        icon: const Icon(Icons.restart_alt_rounded),
        label: const Text('Update'),
      );
    }
    if (plan.action == CheUpdateAction.checkAgain) {
      return OutlinedButton.icon(
        onPressed: _controller.checking ? null : _checkAgain,
        icon: const Icon(Icons.refresh_rounded),
        label: const Text('Check again'),
      );
    }
    return const SizedBox.shrink();
  }
}

/// The top banner for a full build. It shows when a new IPA is ready, or while
/// a SideStore install is waiting, is blocked, or failed.
class CheMobileUpdateNotice extends StatefulWidget {
  const CheMobileUpdateNotice({
    super.key,
    required this.baseUrl,
    required this.onSpeak,
  });

  final String baseUrl;
  final CheSpeak onSpeak;

  @override
  State<CheMobileUpdateNotice> createState() => _CheMobileUpdateNoticeState();
}

class _CheMobileUpdateNoticeState extends State<CheMobileUpdateNotice> {
  final _controller = CheUpdateController.instance;
  CheUpdateStage? _announced;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onChanged);
    _controller.configure(widget.baseUrl);
    _controller.start();
    WidgetsBinding.instance.addPostFrameCallback((_) => _onChanged());
  }

  @override
  void dispose() {
    _controller.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() {
    if (!mounted || _controller.checking) return;
    final plan = _controller.plan;
    if (plan.stage == _announced) return;
    _announced = plan.stage;
    if (plan.stage == CheUpdateStage.fullReady) {
      HapticFeedback.mediumImpact();
      unawaited(widget.onSpeak('Sir, a new CHE update is ready.'));
    } else if (plan.stage == CheUpdateStage.installed) {
      unawaited(widget.onSpeak(plan.spoken));
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _controller.dismissVerified(),
      );
    }
  }

  void _openScreen() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CheMobileUpdateScreen(
          baseUrl: widget.baseUrl,
          onSpeak: widget.onSpeak,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _controller,
      builder: (context, _) {
        final plan = _controller.plan;
        const shown = {
          CheUpdateStage.fullReady,
          CheUpdateStage.installing,
          CheUpdateStage.sideStoreMissing,
          CheUpdateStage.installFailed,
        };
        if (!shown.contains(plan.stage)) return const SizedBox.shrink();
        final latest = _controller.latest;
        return Material(
          color: const Color(0xFF0C695F),
          child: SafeArea(
            bottom: false,
            child: Semantics(
              liveRegion: true,
              child: ListTile(
                leading: const Icon(
                  Icons.system_update_rounded,
                  color: Colors.white,
                ),
                title: Text(
                  plan.headline,
                  style: const TextStyle(color: Colors.white),
                ),
                subtitle: Text(
                  plan.detail,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white70),
                ),
                trailing:
                    latest != null && plan.stage == CheUpdateStage.fullReady
                    ? FilledButton(
                        onPressed: () async {
                          final said = await confirmAndInstallCheUpdate(
                            context,
                            latest,
                          );
                          if (said != null) await widget.onSpeak(said);
                        },
                        child: const Text('Update'),
                      )
                    : const Icon(
                        Icons.chevron_right_rounded,
                        color: Colors.white,
                      ),
                onTap: _openScreen,
              ),
            ),
          ),
        );
      },
    );
  }
}
