import 'package:flutter_test/flutter_test.dart';
import 'package:chey/self_update/che_self_update_intent.dart';

void main() {
  test('update your code routes to controlled self-update', () {
    expect(cheIsSelfUpdateRequest('CHE, update your code so voice responds faster'), isTrue);
    expect(cheIsSelfUpdateRequest('update yourself'), isTrue);
    expect(cheIsSelfUpdateRequest('Fix everything inside CHE so you can keep improving yourself'), isTrue);
    expect(cheIsSelfUpdateRequest('Work on your own code and improve your repository'), isTrue);
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

  test('natural CHE surface changes route to controlled self-update', () {
    expect(
      cheIsSelfUpdateRequest(
        'CHE, find where your Office screen displays agent status. Change one small visual detail that improves readability. Figure out the correct files yourself, make the change, test it, review it, and report what you changed.',
      ),
      isTrue,
    );
    expect(cheIsSelfUpdateRequest('Improve the Office agent status readability and test it.'), isTrue);
    expect(cheIsSelfUpdateRequest('Where is the Office screen implemented?'), isFalse);
    expect(cheIsSelfUpdateRequest('What does agent status mean?'), isFalse);
  });

  test('GitHub information question is not a self-update', () {
    expect(cheIsSelfUpdateRequest('how do I make a GitHub token?'), isFalse);
    expect(cheIsSelfUpdateRequest('what does pull request mean?'), isFalse);
  });

  test('starred repository research stays research, implementation routes to self-update', () {
    const implementation = 'Go through my GitHub starred repositories and my Inspirations list, inspect the agent systems, and integrate useful capabilities into CHE with a draft PR.';
    expect(cheIsRepositoryResearchRequest(implementation), isFalse);
    expect(cheIsSelfUpdateRequest(implementation), isTrue);

    const explicitUpdate = 'Update your code: use Study 1 and 2 as references, compare them with CHE, implement only the useful delta, run tests, and prepare a draft PR.';
    expect(cheIsRepositoryResearchRequest(explicitUpdate), isFalse);
    expect(cheIsSelfUpdateRequest(explicitUpdate), isTrue);

    expect(
      cheIsRepositoryResearchRequest('Inspect the repos I have starred and find useful voice and RAG code.'),
      isTrue,
    );
    expect(
      cheIsSelfUpdateRequest('Integrate owner/specific-agent-repo into your code and create a draft PR.'),
      isTrue,
    );
  });

  test('commands about an existing change never start a new coding job', () {
    for (final command in ['Show me the code', 'show me the code please', 'Create the PR', 'merge it', 'Merge and deploy', 'PR status', 'is it deployed']) {
      expect(cheIsSelfUpdateCommand(command), isTrue, reason: command);
      expect(cheIsSelfUpdateRequest(command), isFalse, reason: command);
    }
    expect(cheIsSelfUpdateRequest('Merge the search feature into your code'), isTrue);
    expect(cheIsSelfUpdateRequest('Update your code: show the code view in a bigger font'), isTrue);
  });
}
