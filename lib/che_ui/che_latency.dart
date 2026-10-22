import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';

/// Measures how long the owner waits: a room or tab tap until the screen is drawn, the Talk tap until the
/// microphone is ready, and the send until CHE's first words appear. Each measurement is kept for the
/// session (the last [_keep] per metric), written to the Dart timeline (Xcode Instruments, DevTools) and, in
/// debug builds, printed. Nothing leaves the phone and nothing is spoken.
class CheLatency {
  CheLatency._();

  static const int _keep = 30;
  static final Map<String, List<int>> _samples = {};

  /// Metric names used by the app.
  static const String navigation = 'navigation.tap_to_frame';
  static const String voiceStart = 'voice.talk_to_mic_ready';
  static const String firstReply = 'reply.send_to_first_words';

  /// Starts timing [metric] now. Call [CheLatencyMark.end] when the owner can see or hear the result.
  static CheLatencyMark begin(String metric) => CheLatencyMark._(metric, Stopwatch()..start());

  /// Samples recorded for [metric], oldest first. Empty when nothing was measured yet.
  static List<int> samples(String metric) => List.unmodifiable(_samples[metric] ?? const <int>[]);

  /// Median of [metric] in milliseconds, or null when nothing was measured.
  static int? medianMs(String metric) {
    final values = [...?_samples[metric]]..sort();
    if (values.isEmpty) return null;
    return values[values.length ~/ 2];
  }

  /// One line per metric for a debug log or a diagnostics screen: name, count, median and worst in milliseconds.
  static String summary() {
    final lines = <String>[];
    for (final metric in _samples.keys.toList()..sort()) {
      final values = [..._samples[metric]!]..sort();
      lines.add('$metric: n=${values.length} median=${values[values.length ~/ 2]}ms worst=${values.last}ms');
    }
    return lines.join('\n');
  }

  /// Forgets every sample. Tests use it; the app never needs to.
  @visibleForTesting
  static void reset() => _samples.clear();

  static void _record(String metric, int ms) {
    final list = _samples.putIfAbsent(metric, () => <int>[]);
    list.add(ms);
    if (list.length > _keep) list.removeAt(0);
    developer.Timeline.instantSync('che.$metric', arguments: {'ms': ms});
    if (kDebugMode) debugPrint('CHE latency: $metric ${ms}ms');
  }
}

/// A running measurement started by [CheLatency.begin].
class CheLatencyMark {
  CheLatencyMark._(this.metric, this._watch);

  final String metric;
  final Stopwatch _watch;
  bool _done = false;

  /// Records the elapsed time once. Later calls are ignored, so a first-frame callback can fire safely.
  int end() {
    if (_done) return _watch.elapsedMilliseconds;
    _done = true;
    _watch.stop();
    final ms = _watch.elapsedMilliseconds;
    CheLatency._record(metric, ms);
    return ms;
  }
}
