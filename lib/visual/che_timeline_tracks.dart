// Visual Studio overlay tracks (creative studio stage 3): the rows the timeline draws above the main video, their
// keyframe markers, and the plain-words edits the overlay and look controls send. The controls send the same words
// the owner can say, so every touch edit is also a voice edit and goes through CHE's one edit path (versioned, undo).

/// One overlay on the timeline: where it sits and where its keyframes are, in seconds on the timeline.
class CheOverlayRow {
  const CheOverlayRow({required this.id, required this.name, required this.kind, required this.track, required this.start, required this.end, required this.keyTimes});
  final String id;
  final String name;
  final String kind;
  final int track;
  final double start;
  final double end;

  /// Timeline seconds of every keyframe on this overlay (all properties), sorted, without repeats.
  final List<double> keyTimes;

  /// Spoken label for the timeline band.
  String get label {
    final keys = keyTimes.isEmpty ? 'no keyframes' : '${keyTimes.length} keyframe${keyTimes.length == 1 ? '' : 's'}';
    return '${kind == 'video' ? 'Video' : 'Picture'} overlay $name on track $track, ${start.toStringAsFixed(1)} to ${end.toStringAsFixed(1)} seconds, $keys';
  }
}

double _num(Object? v, [double fallback = 0]) => v is num ? v.toDouble() : fallback;

/// The overlays of a video document as timeline rows, top track first (it draws on top), then by start time.
List<CheOverlayRow> cheOverlayRows(Map<String, dynamic> doc) {
  final rows = <CheOverlayRow>[];
  for (final raw in (doc['overlays'] as List? ?? const [])) {
    if (raw is! Map) continue;
    final start = _num(raw['start']);
    final end = start + _num(raw['duration'], 1);
    final times = <double>{};
    final keys = raw['keys'];
    if (keys is Map) {
      for (final list in keys.values) {
        if (list is! List) continue;
        for (final k in list) {
          if (k is Map) times.add(((start + _num(k['t'])) * 1000).roundToDouble() / 1000);
        }
      }
    }
    rows.add(CheOverlayRow(
      id: '${raw['id']}',
      name: '${raw['name'] ?? 'Overlay'}',
      kind: raw['kind'] == 'video' ? 'video' : 'image',
      track: _num(raw['track'], 1).round(),
      start: start,
      end: end,
      keyTimes: times.toList()..sort(),
    ));
  }
  rows.sort((a, b) => a.track != b.track ? b.track.compareTo(a.track) : a.start.compareTo(b.start));
  return rows;
}

/// The overlay tracks in use, top first.
List<int> cheOverlayTracks(List<CheOverlayRow> rows) => (rows.map((r) => r.track).toSet().toList()..sort()).reversed.toList();

/// Touch controls for a selected overlay, as the words CHE understands. [label, words].
const cheOverlayEdits = <List<String>>[
  ['Fade in', 'fade it in over one second'],
  ['Fade out', 'fade it out over one second'],
  ['Slide in from left', 'slide it in from the left'],
  ['Slide in from right', 'slide it in from the right'],
  ['Grow', 'make it grow over two seconds'],
  ['Shrink', 'make it shrink over two seconds'],
];

/// Colour LUT looks and curve presets, as words. [id, label, words].
const cheLookEdits = <List<String>>[
  ['warm_film', 'Warm film', 'give it a warm film look'],
  ['teal_orange', 'Teal and orange', 'give it a teal and orange look'],
  ['mono', 'Mono', 'give it a mono look'],
  ['film', 'Film', 'give it a film look'],
];
const cheCurveEdits = <List<String>>[
  ['strong_contrast', 'Strong contrast curve', 'add a strong contrast curve'],
  ['medium_contrast', 'Medium contrast curve', 'add a medium contrast curve'],
  ['vintage', 'Vintage curve', 'add a vintage curve'],
  ['cross_process', 'Cross process', 'give it a cross process look'],
];

/// Speed ramps on the selected (or last) clip, as words.
const cheRampEdits = <List<String>>[
  ['Ramp up at the end', 'ramp the speed up at the end'],
  ['Ramp down at the end', 'ramp the speed down at the end'],
  ['Ramp up at the start', 'ramp the speed up at the start'],
];
