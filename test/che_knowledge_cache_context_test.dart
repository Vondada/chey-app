import 'package:flutter_test/flutter_test.dart';
import 'package:chey/memory/che_knowledge_cache.dart';

void main() {
  test('active conversation bypasses direct saved-answer reuse', () async {
    final cache = CheKnowledgeCache();
    final answer = await cache.answer(
      'What is photosynthesis?',
      hasConversationContext: true,
    );
    expect(answer, isNull);
  });
}
