import 'package:flutter_test/flutter_test.dart';
import 'package:chey/memory/che_knowledge_cache.dart';

void main() {
  test('unverified answers and untrusted URLs cannot be placed in local fact cache', () {
    expect(CheKnowledgeCache.hasVerifiedEvidence(const []), isFalse);
    expect(CheKnowledgeCache.hasVerifiedEvidence(
      const ['https://www.britannica.com/place/Paris'],
    ), isTrue);
    expect(CheKnowledgeCache.hasVerifiedEvidence(
      const ['file:///private/passwords'],
    ), isFalse);
    expect(CheKnowledgeCache.hasVerifiedEvidence(
      const ['https://trusted.example/page', 'javascript:alert(1)'],
    ), isFalse);
  });

  test('active conversation bypasses direct saved-answer reuse', () async {
    final cache = CheKnowledgeCache();
    final answer = await cache.answer(
      'What is photosynthesis?',
      hasConversationContext: true,
    );
    expect(answer, isNull);
  });
}
