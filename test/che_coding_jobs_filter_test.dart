// Coding investigation history belongs in Projects and Office, never in the Music or Create render queue
// (2026-10-22: the owner's Music screen listed coding jobs). Media jobs still appear.
import 'package:chey/rooms/che_creator_studio.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('coding and repository jobs are identified; media and voice jobs are not', () {
    for (final kind in ['self_development', 'software_agent', 'repo_study', 'merge_pr', 'pr_opened', 'autonomy_exam']) {
      expect(cheIsCodingJob({'kind': kind, 'title': 'x'}), isTrue, reason: kind);
    }
    for (final kind in ['media', 'music', 'podcast', 'video_render', 'voiceover', null]) {
      expect(cheIsCodingJob({'kind': kind, 'title': 'x'}), isFalse, reason: '$kind');
    }
  });
}
