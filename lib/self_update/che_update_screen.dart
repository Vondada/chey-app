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
  bool repair = false,
}) async {
  final controller = CheUpdateController.instance;
  final confirmed = await showCupertinoDialog<bool>(
    context: context,
    builder: (dialogContext) => CupertinoAlertDialog(
      title: Text(
        rollback
            ? 'Go back to CHE ${target.version}?'
            : repair
                ? 'Repair CHE with ${target.version}?'
                : 'Install CHE ${target.version}?',
      ),
      content: Text(
        rollback
            ? 'SideStore will open to install this older build. Use this only if the current build is broken.'
            : repair
                ? 'CHE cannot read the version currently installed, so it cannot confirm this build is newer. SideStore will open to reinstall the latest verified CHE build ${target.buildNumber}. Confirm there. CHE checks the result next time it opens.'
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
          child: Text(rollback ? 'Go back' : repair ? 'Repair' : 'Update'),
        ),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return null;
  HapticFeedback.mediumImpact();
  final opened = await controller.installFullBuild(target, rollback: rollback, repair: repair);
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
    this.announceRequestedCheck = false,
  });

  final String baseUrl;
  final CheSpeak onSpeak;

  /// Only an explicit owner 'check for updates' command can request speech.
  final bool announceRequestedCheck;

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
    // Opening the screen remains silent; status is displayed immediately.
    // Opening the screen is a request to check, so it never shows a result
    // from earlier than this open.
    unawaited(_refreshOnOpen());
  }

  @override
  void dispose() {
    _controller.removeListener(_onChanged);
    super.dispose();
  }

  Future<void> _refreshOnOpen() async {
    await _controller.refresh(force: true);
    if (mounted && widget.announceRequestedCheck) {
      await widget.onSpeak(_controller.plan.spoken);
    }
  }

  void _onChanged() {
    if (!mounted || _busy) return;
    _announce();
  }

  /// Track settled stages without narrating screen changes automatically.
  void _announce() {
    if (!mounted || _controller.checking) return;
    final plan = _controller.plan;
    if (plan.stage != _spokenStage) {
      _spokenStage = plan.stage;
      // Only explicit Read/Update actions speak.
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

  Future<void> _stopWaiting() async {
    await _controller.stopWaiting();
    if (!mounted) return;
    _spokenStage = _controller.plan.stage;
    await widget.onSpeak('Stopped waiting for SideStore. ${_controller.plan.spoken}');
  }

  Future<void> _install(
    CheMobileUpdateInfo target, {
    bool rollback = false,
    bool repair = false,
  }) async {
    _busy = true;
    String? said;
    try {
      said = await confirmAndInstallCheUpdate(
        context,
        target,
        rollback: rollback,
        repair: repair,
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
                  const SizedBox(height: 8),
                  // Always visible, so the owner can confirm what is installed.
                  Text(
                    _controller.installedSummary,
                    style: theme.textTheme.bodyMedium,
                  ),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: () => widget.onSpeak(
                        '${plan.spoken} ${_controller.installedSummary}',
                      ),
                      icon: const Icon(Icons.volume_up_rounded),
                      label: const Text('Read this'),
                    ),
                  ),
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
    if (plan.action == CheUpdateAction.repairFullBuild && latest != null) {
      return FilledButton.icon(
        onPressed: _busy ? null : () => _install(latest, repair: true),
        icon: const Icon(Icons.build_circle_outlined),
        label: const Text('Repair CHE'),
      );
    }
    if (plan.action == CheUpdateAction.explainRestart) {
      return FilledButton.icon(
        onPressed: _explainRestart,
        icon: const Icon(Icons.restart_alt_rounded),
        label: const Text('Update'),
      );
    }
    if (plan.action == CheUpdateAction.stopWaiting) {
      return OutlinedButton.icon(
        onPressed: _stopWaiting,
        icon: const Icon(Icons.stop_circle_outlined),
        label: const Text('Stop waiting'),
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
  Timer? _verifiedTimer;

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
    _verifiedTimer?.cancel();
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
    } else if (plan.stage == CheUpdateStage.installed) {
      // The confirmed result stays for a moment, then clears by itself, so the
      // Update button does not linger. The close button clears it sooner.
      HapticFeedback.mediumImpact();
      _verifiedTimer?.cancel();
      _verifiedTimer = Timer(const Duration(seconds: 15), _controller.dismissVerified);
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

  Widget _trailing(CheUpdatePlan plan, CheMobileUpdateInfo? latest) {
    if (plan.stage == CheUpdateStage.installed) {
      return IconButton(
        tooltip: 'Hide the update notice',
        icon: const Icon(Icons.close_rounded, color: Colors.white),
        onPressed: _controller.dismissVerified,
      );
    }
    if (latest != null && plan.stage == CheUpdateStage.fullReady) {
      return FilledButton(
        onPressed: () async {
          final said = await confirmAndInstallCheUpdate(context, latest);
          if (said != null) await widget.onSpeak(said);
        },
        child: const Text('Update'),
      );
    }
    return const Icon(Icons.chevron_right_rounded, color: Colors.white);
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
          CheUpdateStage.installed,
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
                trailing: _trailing(plan, latest),
                onTap: _openScreen,
              ),
            ),
          ),
        );
      },
    );
  }
}
