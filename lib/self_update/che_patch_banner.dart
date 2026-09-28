// "CHE updated, restart to apply" banner for Shorebird code-push patches.
// Only Dart changes can arrive this way; native changes need a new IPA.
// In builds not made with Shorebird the updater reports unavailable and the
// banner never shows.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shorebird_code_push/shorebird_code_push.dart';

class ChePatchBanner extends StatefulWidget {
  const ChePatchBanner({super.key});
  @override
  State<ChePatchBanner> createState() => _ChePatchBannerState();
}

class _ChePatchBannerState extends State<ChePatchBanner> {
  final _updater = ShorebirdUpdater();
  bool _restartReady = false;
  bool _hidden = false;

  @override
  void initState() {
    super.initState();
    unawaited(_check());
  }

  Future<void> _check() async {
    if (!_updater.isAvailable) return;
    try {
      var status = await _updater.checkForUpdate();
      if (status == UpdateStatus.outdated) {
        await _updater.update();
        status = await _updater.checkForUpdate();
      }
      if (mounted && status == UpdateStatus.restartRequired) setState(() => _restartReady = true);
    } catch (_) {
      // A failed patch download leaves the current version running.
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_restartReady || _hidden) return const SizedBox.shrink();
    return Material(
      color: const Color(0xFF0C9A7E),
      child: SafeArea(
        bottom: false,
        child: ListTile(
          dense: true,
          leading: const Icon(Icons.system_update_rounded, color: Colors.white),
          title: const Text('CHE updated. Restart to apply.', style: TextStyle(color: Colors.white)),
          subtitle: const Text('Close CHE fully and reopen it.', style: TextStyle(color: Colors.white70)),
          trailing: IconButton(
            tooltip: 'Hide',
            icon: const Icon(Icons.close_rounded, color: Colors.white),
            onPressed: () => setState(() => _hidden = true),
          ),
        ),
      ),
    );
  }
}
