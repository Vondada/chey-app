enum CheSceneQuality { efficient, immersive, realistic }

extension CheSceneQualityConfig on CheSceneQuality {
  int get renderNodeBudget => switch (this) {
        CheSceneQuality.efficient => 220,
        CheSceneQuality.immersive => 700,
        CheSceneQuality.realistic => 560,
      };

  int get renderEdgeBudget => switch (this) {
        CheSceneQuality.efficient => 320,
        CheSceneQuality.immersive => 1200,
        CheSceneQuality.realistic => 900,
      };

  double get maxFrameRate => switch (this) {
        CheSceneQuality.efficient => 30,
        CheSceneQuality.immersive => 45,
        CheSceneQuality.realistic => 60,
      };

  double get pixelRatio => switch (this) {
        CheSceneQuality.efficient => 0.85,
        CheSceneQuality.immersive => 1.10,
        CheSceneQuality.realistic => 1.35,
      };

  int get sphereSegments => switch (this) {
        CheSceneQuality.efficient => 14,
        CheSceneQuality.immersive => 22,
        CheSceneQuality.realistic => 30,
      };

  int get sphereRings => switch (this) {
        CheSceneQuality.efficient => 8,
        CheSceneQuality.immersive => 12,
        CheSceneQuality.realistic => 16,
      };

  int get tubeSegments => switch (this) {
        CheSceneQuality.efficient => 4,
        CheSceneQuality.immersive => 6,
        CheSceneQuality.realistic => 8,
      };
}
