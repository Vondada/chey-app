// One authority for automatic microphone restarts.
//
// Root cause this replaces: iOS speech_to_text ends its session after a
// silence (pauseFor) and reports 'done'/'notListening' (sometimes also an
// error). Status, error, listen-failure and TTS-completion paths each
// scheduled their own restart and flipped the visible mic state, so an idle
// open mic looped stop -> restart -> listening -> stop every few seconds,
// each flip rebuilding the whole home screen and firing a status haptic.
//
// Rules enforced here:
// * Owner intent wins: [ownerOff] cancels any pending restart, and nothing
//   restarts the mic until [ownerOn].
// * At most one restart is pending; duplicate requests are dropped.
// * Every intent change bumps [generation]; a timer or async start from an
//   older generation can never act.
// * [canStart] is checked again when the timer fires (speaking, sending,
//   native/realtime voice owning the mic, sleeping all block it).
// * Only one start runs at a time.

import 'dart:async';

typedef CheMicLog = void Function(String event, String reason);

class CheMicSupervisor {
  CheMicSupervisor({this.log, Timer Function(Duration, void Function())? timer})
      : _timer = timer ?? Timer.new;

  final CheMicLog? log;
  final Timer Function(Duration, void Function()) _timer;

  bool ownerWantsMic = false;
  int generation = 0;
  Timer? _pending;
  bool _starting = false;

  bool get restartPending => _pending != null;
  bool get starting => _starting;

  void _log(String event, String reason) => log?.call(event, reason);

  void ownerOn(String reason) {
    ownerWantsMic = true;
    _bump('owner on: $reason');
  }

  void ownerOff(String reason) {
    ownerWantsMic = false;
    _bump('owner off: $reason');
  }

  /// A state change (speaking, sending, engine handoff) that makes any
  /// pending restart stale.
  void invalidate(String reason) => _bump(reason);

  void cancelRestart(String reason) {
    if (_pending == null) return;
    _pending!.cancel();
    _pending = null;
    _log('MIC_RESTART_CANCELLED', reason);
  }

  void _bump(String reason) {
    generation++;
    cancelRestart(reason);
  }

  /// Schedules one automatic restart. Returns false if dropped.
  bool scheduleRestart({
    required String reason,
    required Duration delay,
    required bool Function() canStart,
    required Future<void> Function() start,
  }) {
    if (!ownerWantsMic) {
      _log('MIC_RESTART_SCHEDULED', 'dropped (owner off): $reason');
      return false;
    }
    if (_pending != null || _starting) {
      _log('MIC_RESTART_SCHEDULED', 'dropped (already pending): $reason');
      return false;
    }
    final gen = generation;
    _log('MIC_RESTART_SCHEDULED', '$reason in ${delay.inMilliseconds}ms');
    _pending = _timer(delay, () {
      _pending = null;
      if (gen != generation || !ownerWantsMic || !canStart()) {
        _log('MIC_RESTART_CANCELLED', 'stale or blocked at fire: $reason');
        return;
      }
      unawaited(runStart(reason, start));
    });
    return true;
  }

  /// Runs [start] unless another start is in flight or intent changed.
  Future<bool> runStart(String reason, Future<void> Function() start) async {
    if (_starting) {
      _log('MIC_REQUEST_START', 'dropped (start in flight): $reason');
      return false;
    }
    _starting = true;
    final gen = generation;
    _log('MIC_REQUEST_START', reason);
    try {
      await start();
      if (gen != generation) {
        _log('MIC_STARTED', 'stale (superseded): $reason');
        return false;
      }
      _log('MIC_STARTED', reason);
      return true;
    } finally {
      _starting = false;
    }
  }

  /// True when [gen] is still the current intent generation.
  bool isCurrent(int gen) => gen == generation;

  void dispose() => cancelRestart('dispose');
}
