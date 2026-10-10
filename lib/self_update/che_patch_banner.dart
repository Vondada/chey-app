// Top banner for a Shorebird patch (Dart changes only). It appears only when
// the patch is downloaded and waiting for CHE to restart. The download itself
// is silent and handled by CheUpdateController. In builds without Shorebird
// the controller reports unavailable and this banner never shows.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import 'che_mobile_update.dart';
import 'che_update_controller.dart';
import 'che_update_plan.dart';

class ChePatchBanner extends StatefulWidget {
  const ChePatchBanner({super.key, this.onSpeak});

  /// Speaks the restart instruction once the patch is ready.
  final CheSpeak? onSpeak;

  @override
  State<ChePatchBanner> createState() => _ChePatchBannerState();
}

class _ChePatchBannerState extends State<ChePatchBanner> {
  final _controller = CheUpdateController.instance;
  bool _hidden = false;
  bool _announced = false;

  static const _readyText =
      'Update ready. Reopen CHE to finish. The update applies the next time CHE starts.';

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onChanged);
    _controller.start();
    WidgetsBinding.instance.addPostFrameCallback((_) => _onChanged());
  }

  @override
  void dispose() {
    _controller.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() {
    if (!mounted) return;
    final ready = _controller.plan.stage == CheUpdateStage.fastReady;
    if (!ready) {
      _announced = false;
      return;
    }
    if (_announced) return;
    _announced = true;
    HapticFeedback.mediumImpact();
    final speak = widget.onSpeak;
    if (speak != null) {
      unawaited(speak(_readyText));
    } else {
      _announceToScreenReader();
    }
  }

  void _announceToScreenReader() {
    final view = View.maybeOf(context);
    if (view == null) return;
    unawaited(
      SemanticsService.sendAnnouncement(
        view,
        _readyText,
        Directionality.maybeOf(context) ?? TextDirection.ltr,
      ),
    );
  }

  void _explain() {
    HapticFeedback.mediumImpact();
    final speak = widget.onSpeak;
    if (speak != null) {
      unawaited(speak(_readyText));
    } else {
      _announceToScreenReader();
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _controller,
      builder: (context, _) {
        final plan = _controller.plan;
        if (plan.stage != CheUpdateStage.fastReady || _hidden) {
          return const SizedBox.shrink();
        }
        return Material(
          color: const Color(0xFF0C9A7E),
          child: SafeArea(
            bottom: false,
            child: Semantics(
              liveRegion: true,
              child: ListTile(
                dense: true,
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
                  style: const TextStyle(color: Colors.white70),
                ),
                onTap: _explain,
                trailing: IconButton(
                  tooltip: 'Hide the update notice',
                  icon: const Icon(Icons.close_rounded, color: Colors.white),
                  onPressed: () => setState(() => _hidden = true),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
