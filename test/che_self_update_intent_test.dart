import 'package:flutter_test/flutter_test.dart';
import 'package:chey/self_update/che_self_update_intent.dart';

void main() {
  test('update your code routes to controlled self-update', () {
    expect(cheIsSelfUpdateRequest('CHE, update your code so voice responds faster'), isTrue);
    expect(cheIsSelfUpdateRequest('update yourself'), isTrue);
  });
  test('GitHub information question is not a self-update', () {
    expect(cheIsSelfUpdateRequest('how do I make a GitHub token?'), isFalse);
  });
}
