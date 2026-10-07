// Spoken CHE. Drops the butler address without changing the answer.

String stripButler(String text) {
  final cleaned = text
      .replaceAll(RegExp(r',?\s+sir\b', caseSensitive: false), '')
      .replaceAll(RegExp(r'\bma.?am\b', caseSensitive: false), '')
      .replaceAll(RegExp(r'\s{2,}'), ' ')
      .replaceAll(RegExp(r'\s+([,.])'), r'$1')
      .trim();
  return cleaned;
}
