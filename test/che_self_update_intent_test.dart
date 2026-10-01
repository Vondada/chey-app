import 'package:flutter_test/flutter_test.dart';
import 'package:chey/self_update/che_self_update_intent.dart';

void main() {
  test('update your code routes to controlled self-update', () {
    expect(cheIsSelfUpdateRequest('CHE, update your code so voice responds faster'), isTrue);
    expect(cheIsSelfUpdateRequest('update yourself'), isTrue);
  });
  test('long engineering briefs route to controlled self-update', () {
    expect(
      cheIsSelfUpdateRequest(
        'CHE, do not stop at planning. Execute the change now. Inspect the real codebase, implement the gallery, run checks, and provide the branch, PR number, commit SHA, files changed, and CI status.',
      ),
      isTrue,
    );
    expect(
      cheIsSelfUpdateRequest(
        'Implement this permanently in the CHE Flutter app and create a reviewable pull request.',
      ),
      isTrue,
    );
  });

  test('GitHub information question is not a self-update', () {
    expect(cheIsSelfUpdateRequest('how do I make a GitHub token?'), isFalse);
    expect(cheIsSelfUpdateRequest('what does pull request mean?'), isFalse);
  });
}
