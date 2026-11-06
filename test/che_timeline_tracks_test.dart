import 'package:flutter_test/flutter_test.dart';

import 'package:chey/visual/che_timeline_tracks.dart';

void main() {
  test('overlay rows: top track first, keyframe markers on the timeline, spoken labels', () {
    final doc = <String, dynamic>{
      'overlays': [
        {'id': 'a', 'name': 'Sunset', 'kind': 'image', 'track': 1, 'start': 1.0, 'duration': 3.0, 'keys': {'opacity': [{'t': 0, 'v': 0}, {'t': 2, 'v': 1}], 'x': [{'t': 0, 'v': -0.3}, {'t': 1, 'v': 0.5}], 'y': [], 'scale': []}},
        {'id': 'b', 'name': 'Logo', 'kind': 'image', 'track': 2, 'start': 0, 'duration': 10, 'keys': {}},
        {'id': 'c', 'name': 'Clip', 'kind': 'video', 'track': 1, 'start': 0.5, 'duration': 1},
      ],
    };
    final rows = cheOverlayRows(doc);
    expect(rows.map((r) => r.id).toList(), ['b', 'c', 'a']);
    expect(cheOverlayTracks(rows), [2, 1]);
    final sunset = rows.last;
    expect(sunset.end, 4.0);
    expect(sunset.keyTimes, [1.0, 2.0, 3.0], reason: 'keyframes at 0, 1 and 2 s after a start of 1 s; the shared one counted once');
    expect(sunset.label, 'Picture overlay Sunset on track 1, 1.0 to 4.0 seconds, 3 keyframes');
    expect(rows[1].label, startsWith('Video overlay Clip'));
    expect(rows.first.label, endsWith('no keyframes'));
  });

  test('a one-track document (before overlays) has no overlay rows', () {
    expect(cheOverlayRows(<String, dynamic>{'clips': []}), isEmpty);
  });

  test('every touch control sends words CHE understands, never a second edit path', () {
    for (final e in [...cheOverlayEdits, ...cheRampEdits]) {
      expect(e.length, 2);
      expect(e[1], isNotEmpty);
    }
    for (final e in [...cheLookEdits, ...cheCurveEdits]) {
      expect(e.length, 3);
    }
    expect(cheLookEdits.map((e) => e[0]).toList(), ['warm_film', 'teal_orange', 'mono', 'film']);
  });
}
