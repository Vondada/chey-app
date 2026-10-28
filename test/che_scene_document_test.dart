// Tests for lib/create/che_scene_document.dart (M2b). Each test changes real data and checks the result.
import 'package:flutter_test/flutter_test.dart';
import 'package:chey/create/che_scene_document.dart';

SceneObject chair({String id = 'chair_1'}) => SceneObject(
      id: id,
      kind: 'object',
      name: 'Oak chair',
      assetRef: 'object_chair_oak',
      props: const {'color': '#8b5a2b', 'roughness': 0.6},
    );

SceneHistory fresh() => SceneHistory.start(const SceneDocument(id: 'scene_office', name: 'Office', objects: []));

void main() {
  test('adding an object stores it with its asset reference', () {
    final h = fresh().addObject(chair());
    expect(h.present.objects, hasLength(1));
    expect(h.present.objects.first.assetRef, 'object_chair_oak');
  });

  test('a duplicate ID is refused and the scene is unchanged', () {
    final h = fresh().addObject(chair());
    expect(() => h.addObject(chair()), throwsA(isA<SceneException>()));
    expect(h.present.objects, hasLength(1));
  });

  test('a property outside its range is refused, and a declared one is set', () {
    final h = fresh().addObject(chair());
    expect(() => h.setProperty('chair_1', 'roughness', 1.5), throwsA(isA<SceneException>()));
    expect(() => h.setProperty('chair_1', 'pore_detail', 0.5), throwsA(isA<SceneException>()));
    final ok = h.setProperty('chair_1', 'roughness', 0.9);
    expect(ok.present.objects.first.props['roughness'], 0.9);
  });

  test('a colour is stored in lower case and a bad colour is refused', () {
    expect(validateProperty('object', 'color', '#AABBCC'), '#aabbcc');
    expect(() => validateProperty('object', 'color', 'red'), throwsA(isA<SceneException>()));
  });

  test('a room light must be one of its choices', () {
    expect(validateProperty('room', 'light', 'cool'), 'cool');
    expect(() => validateProperty('room', 'light', 'purple'), throwsA(isA<SceneException>()));
  });

  test('undo and redo walk the history both ways, and a new change clears redo', () {
    var h = fresh().addObject(chair());
    h = h.setProperty('chair_1', 'roughness', 0.9).setProperty('chair_1', 'roughness', 0.2);
    h = h.undo();
    expect(h.present.objects.first.props['roughness'], 0.9);
    h = h.undo();
    expect(h.present.objects.first.props['roughness'], 0.6);
    h = h.redo();
    expect(h.present.objects.first.props['roughness'], 0.9);
    h = h.setProperty('chair_1', 'roughness', 0.5);
    expect(h.canRedo, isFalse);
  });

  test('undo on an empty history changes nothing', () {
    final h = fresh();
    expect(identical(h.undo(), h), isTrue);
    expect(h.canUndo, isFalse);
  });

  test('history keeps at most 100 steps', () {
    var h = fresh().addObject(chair());
    for (var i = 0; i < 120; i++) {
      h = h.setProperty('chair_1', 'roughness', (i % 100) / 100);
    }
    expect(h.past, hasLength(100));
  });

  test('moving an object changes only its transform', () {
    final h = fresh().addObject(chair()).setTransform('chair_1', const Transform(position: Vec3(2, 0, -1)));
    final moved = h.present.objects.first;
    expect(moved.transform.position.x, 2);
    expect(moved.props['roughness'], 0.6);
  });

  test('a saved document reads back the same, and a broken one is refused on load', () {
    final h = fresh().addObject(chair()).setProperty('chair_1', 'color', '#112233');
    final json = Map<String, dynamic>.from(h.present.toJson());
    final loaded = SceneDocument.fromJson(json);
    expect(loaded.objects.first.props['color'], '#112233');
    expect(loaded.objects.first.assetRef, 'object_chair_oak');

    final bad = Map<String, dynamic>.from(json);
    bad['schema'] = 2;
    expect(() => SceneDocument.fromJson(bad), throwsA(isA<SceneException>()));

    final tampered = Map<String, dynamic>.from(json);
    tampered['objects'] = [
      {'id': 'o1', 'kind': 'object', 'name': 'Cup', 'asset_ref': 'object_cup', 'properties': {'roughness': 7}},
    ];
    expect(() => SceneDocument.fromJson(tampered), throwsA(isA<SceneException>()));
  });

  test('removing an object drops it, and undo brings it back', () {
    var h = fresh().addObject(chair()).removeObject('chair_1');
    expect(h.present.objects, isEmpty);
    h = h.undo();
    expect(h.present.objects, hasLength(1));
  });
}
