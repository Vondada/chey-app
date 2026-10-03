import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/widgets/che_native_scene_world.dart';

void main() {
  test('native 3D quality presets increase visual budget without changing data', () {
    expect(
      cheSceneVisualLimit(CheSceneQuality.performance),
      lessThan(cheSceneVisualLimit(CheSceneQuality.balanced)),
    );
    expect(
      cheSceneVisualLimit(CheSceneQuality.balanced),
      lessThan(cheSceneVisualLimit(CheSceneQuality.realistic)),
    );
    expect(cheSceneQualityLabel(CheSceneQuality.realistic), 'Realistic');
  });

  test('native scene supports every immersive CHE room family', () {
    expect(
      CheSceneMode.values,
      containsAll(<CheSceneMode>[
        CheSceneMode.office,
        CheSceneMode.brain,
        CheSceneMode.warRoom,
        CheSceneMode.theater,
        CheSceneMode.artStudio,
        CheSceneMode.musicStudio,
        CheSceneMode.workshop,
        CheSceneMode.projects,
        CheSceneMode.markets,
        CheSceneMode.pipeline,
        CheSceneMode.store,
        CheSceneMode.creator,
      ]),
    );
  });

  test('scene entities keep real state and optional model slots', () {
    const entity = CheSceneEntity(
      id: 'atlas',
      label: 'Atlas',
      description: 'Researching a real task',
      color: Colors.teal,
      state: 'researching',
      importance: 4,
      modelAsset: 'assets/models/atlas.glb',
      modelScale: 1.2,
    );

    expect(entity.id, 'atlas');
    expect(entity.state, 'researching');
    expect(entity.importance, 4);
    expect(entity.modelAsset, 'assets/models/atlas.glb');
    expect(entity.modelScale, 1.2);
  });
}
