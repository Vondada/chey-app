// Live "what CHE is doing" line for the background job the owner just started.
// Shows real job progress quietly with a haptic. Read this is optional.
// Polls /api/job/activity until the job ends.
// Everything shown comes from the server's job log; nothing is invented here.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'che_ui/che_foreground.dart';

import 'che_ui/che_ui_preferences.dart';

/// The job the owner is watching. Set when a background job is started.
final ValueNotifier<String?> cheWatchedJobId = ValueNotifier<String?>(null);

const Set<String> _finishedStatuses = {'complete', 'failed', 'cancelled', 'dead_letter'};

class CheJobActivityBanner extends StatefulWidget {
  const CheJobActivityBanner({super.key, required this.fetch, required this.speak});

  /// Calls a server path with a JSON body and returns the decoded reply.
  final Future<Map<String, dynamic>?> Function(String path, Map<String, dynamic> body) fetch;

  /// Speaks one line aloud.
  final Future<void> Function(String text) speak;

  @override
  State<CheJobActivityBanner> createState() => _CheJobActivityBannerState();
}

class _CheJobActivityBannerState extends State<CheJobActivityBanner> {
  Timer? _timer;
  String? _jobId;
  String _line = '';
  String _status = '';

  @override
  void initState() {
    super.initState();
    cheWatchedJobId.addListener(_onWatchChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) => _onWatchChanged());
  }

  @override
  void dispose() {
    cheWatchedJobId.removeListener(_onWatchChanged);
    _timer?.cancel();
    super.dispose();
  }

  void _onWatchChanged() {
    if (!mounted) return;
    final id = cheWatchedJobId.value;
    if (id == null || id == _jobId) return;
    _timer?.cancel();
    setState(() {
      _jobId = id;
      _line = '';
      _status = '';
    });
    unawaited(_poll());
    _timer = Timer.periodic(const Duration(seconds: 4), (_) {
      if (cheAppInForeground()) unawaited(_poll());
    });
  }

  Future<void> _poll() async {
    final id = _jobId;
    if (id == null) return;
    Map<String, dynamic>? data;
    try {
      data = await widget.fetch('/api/job/activity', {'id': id});
    } catch (_) {
      return;
    }
    if (!mounted || data == null || _jobId != id) return;

    final activity = (data['activity'] as List?) ?? const [];
    final last = activity.isNotEmpty && activity.last is Map
        ? '${(activity.last as Map)['text'] ?? ''}'.trim()
        : '';
    final status = '${data['status'] ?? ''}';
    final changed = last.isNotEmpty && last != _line;

    setState(() {
      if (changed) _line = last;
      _status = status;
    });

    if (changed) {
      // Keep progress available in text, not unsolicited speech.
      HapticFeedback.lightImpact();
    }
    if (_finishedStatuses.contains(status)) _timer?.cancel();
  }

  @override
  Widget build(BuildContext context) {
    if (_jobId == null || _line.isEmpty) return const SizedBox.shrink();
    final done = _finishedStatuses.contains(_status);
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    // Quiet working subtext, like Claude's status line: small and muted.
    return Semantics(
      liveRegion: true,
      label: 'CHE: $_line',
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
        child: Row(
          children: [
            ExcludeSemantics(
              child: Icon(
                done ? Icons.check_circle_outline : Icons.autorenew,
                size: 14,
                // A finished, successful job takes the owner's success color (Owner Improvements); the words say it too.
                color: _status == 'complete' ? CheUiPreferences.instance.successColor : muted,
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                _line,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: muted),
              ),
            ),
            IconButton(
              tooltip: 'Read this job status aloud',
              icon: Icon(Icons.volume_up_rounded, size: 18, color: muted),
              onPressed: () => widget.speak(_line),
            ),
          ],
        ),
      ),
    );
  }
}
