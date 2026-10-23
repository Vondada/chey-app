import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/main.dart';

void main() {
  // The responsive guard (che_responsive_layout_test.dart) verifies layouts at text 1.0 and 1.3. CHE must never draw
  // above that, however large the iPhone's Larger Text and CHE's own setting are together.
  test('CHE never draws text above the verified 1.3x cap', () {
    expect(cheEffectiveTextScale(const TextScaler.linear(2.0), 1.0), lessThanOrEqualTo(kCheMaxTextScale));
    expect(cheEffectiveTextScale(const TextScaler.linear(1.6), 1.18), lessThanOrEqualTo(kCheMaxTextScale));
    expect(cheEffectiveTextScale(const TextScaler.linear(3.1), 1.18), lessThanOrEqualTo(kCheMaxTextScale));
  });

  test('a 2.0 system size yields the same as the cap', () {
    expect(cheEffectiveTextScale(const TextScaler.linear(2.0), 1.0), cheEffectiveTextScale(const TextScaler.linear(3.1), 1.18));
    expect(cheEffectiveTextScale(const TextScaler.linear(2.0), 1.0), kCheMaxTextScale);
  });

  test('Larger Text and CHE Text size still apply inside the cap', () {
    expect(cheEffectiveTextScale(TextScaler.noScaling, 1.0), 1.0);
    expect(cheEffectiveTextScale(const TextScaler.linear(1.15), 1.0), closeTo(1.15, 0.001));
    expect(cheEffectiveTextScale(const TextScaler.linear(1.15), 1.18), closeTo(kCheMaxTextScale, 0.001));
  });
}
