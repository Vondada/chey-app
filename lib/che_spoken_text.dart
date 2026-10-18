// What CHE's voice is handed (owner, 2026-10-18): Markdown and technical
// formatting become natural speech without changing the meaning. The words on
// screen keep their formatting; only the voice's copy changes.
//
// Pure helpers, shared by chat replies and Read This, so both sound the same.
// Sentence ends for clip boundaries are cheSentenceEnd in che_stream_batcher.dart.

String _host(String url) {
  final match = RegExp(r'^(?:https?://)?(?:www\.)?([^/:?#\s]+)', caseSensitive: false).firstMatch(url);
  return match?.group(1) ?? url;
}

String _inline(String line) {
  var s = line;
  // Images and links say their words; a bare web address says its site.
  s = s.replaceAllMapped(RegExp(r'!\[([^\]]*)\]\([^)]*\)'), (m) => m[1]!.trim().isEmpty ? 'an image' : 'image: ${m[1]}');
  s = s.replaceAllMapped(RegExp(r'\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)'), (m) => m[1]!);
  s = s.replaceAllMapped(RegExp(r'<?\bhttps?://[^\s>)\]]+>?', caseSensitive: false), (m) => _host(m[0]!.replaceAll(RegExp(r'^<|>$'), '')));
  s = s.replaceAllMapped(RegExp(r'\bwww\.[^\s)\]]+', caseSensitive: false), (m) => _host(m[0]!));
  // Inline code: say the words, not the symbols ("che_voice()" → "che voice").
  s = s.replaceAllMapped(RegExp(r'`([^`]+)`'), (m) => m[1]!.replaceAll('()', '').replaceAll('_', ' '));
  s = s.replaceAll('`', '');
  // Emphasis and strikethrough keep their words.
  s = s.replaceAllMapped(RegExp(r'(\*\*|__)(.+?)\1'), (m) => m[2]!);
  s = s.replaceAllMapped(RegExp(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])'), (m) => m[1]!);
  s = s.replaceAllMapped(RegExp(r'(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])'), (m) => m[1]!);
  s = s.replaceAllMapped(RegExp(r'~~(.+?)~~'), (m) => m[1]!);
  s = s.replaceAll(RegExp(r'<br\s*/?>', caseSensitive: false), ', ');
  s = s.replaceAll(RegExp(r'</?[a-zA-Z][^>]*>'), '');
  // Footnote marks and stray formatting symbols are not read; a product keeps its meaning.
  s = s.replaceAllMapped(RegExp(r'(\d)\s*[*×]\s*(\d)'), (m) => '${m[1]} times ${m[2]}');
  s = s.replaceAll(RegExp(r'\[\^?\d+\]'), '');
  s = s.replaceAll(RegExp(r'(?<=\s|^)[*#>]+(?=\s|$)'), '');
  s = s.replaceAll(RegExp(r'\*{2,}|#{2,}'), '');
  s = s.replaceAllMapped(RegExp(r'\\([\\`*_{}\[\]()#+\-.!|>~])'), (m) => m[1]!);
  // Symbols said the way a person says them.
  s = s.replaceAll(RegExp(r'\s*(?:->|→|⟶|=>)\s*'), ' to ');
  s = s.replaceAll(RegExp(r'\s*(?:<-|←)\s*'), ' from ');
  s = s.replaceAll(RegExp(r'\s+&\s+'), ' and ');
  s = s.replaceAll('±', ' plus or minus ');
  s = s.replaceAllMapped(RegExp(r'(^|\s)~(?=\d)'), (m) => '${m[1]}about ');
  s = s.replaceAll(RegExp(r'\band/or\b', caseSensitive: false), 'and or');
  s = s.replaceAll(RegExp(r'\be\.g\.,?(?=\s)', caseSensitive: false), 'for example');
  s = s.replaceAll(RegExp(r'\bi\.e\.,?(?=\s)', caseSensitive: false), 'that is');
  s = s.replaceAll(RegExp(r'\bvs\.?(?=\s)', caseSensitive: false), 'versus');
  s = s.replaceAll(RegExp(r'\bw/(?=\s)'), 'with');
  // Pictures and emoji are not words; status marks become their meaning.
  s = s.replaceAll(RegExp(r'[✅✔✓☑]️?'), ' done ');
  s = s.replaceAll(RegExp(r'[❌✖✗]️?'), ' not done ');
  s = s.replaceAll(RegExp(r'[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]', unicode: true), '');
  s = s.replaceAllMapped(RegExp(r'([!?])\1+'), (m) => m[1]!);
  return s;
}

bool _isTableDivider(String line) => RegExp(r'^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$').hasMatch(line);

String _period(String text) {
  final t = text.trim();
  if (t.isEmpty) return t;
  return RegExp(r'[.!?…:;,]["”’)\]]*$').hasMatch(t) ? t : '$t.';
}

/// [markdown] as natural speech: headings, list items and table rows become
/// short sentences (a list keeps its numbers, so options can be chosen by
/// number), links say their words, web addresses say their site, code blocks
/// and formatting symbols are not read. Plain text passes through unchanged
/// apart from spacing.
String cheSpeakableText(String markdown) {
  final out = <String>[];
  var inFence = false;
  for (final raw in markdown.replaceAll('\r', '').split('\n')) {
    if (RegExp(r'^\s*(```|~~~)').hasMatch(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    var line = raw.trimRight();
    if (line.trim().isEmpty) continue;
    if (RegExp(r'^\s*(?:-{3,}|\*{3,}|_{3,})\s*$').hasMatch(line) || _isTableDivider(line)) continue;
    final heading = RegExp(r'^\s*#{1,6}\s+(.*?)\s*#*\s*$').firstMatch(line);
    final bullet = RegExp(r'^\s*(?:[-*•+])\s+(?:\[[ xX]\]\s+)?(.*)$').firstMatch(line);
    final numbered = RegExp(r'^\s*(\d{1,3})[.)]\s+(.*)$').firstMatch(line);
    if (heading != null) {
      out.add(_period(_inline(heading[1]!)));
    } else if (numbered != null) {
      out.add(_period('${numbered[1]}, ${_inline(numbered[2]!).trim()}'));
    } else if (bullet != null) {
      out.add(_period(_inline(bullet[1]!)));
    } else if (line.trimLeft().startsWith('|')) {
      final cells = line.trim().replaceAll(RegExp(r'^\||\|$'), '').split('|').map((c) => _inline(c).trim()).where((c) => c.isNotEmpty);
      if (cells.isNotEmpty) out.add(_period(cells.join(', ')));
    } else {
      line = line.replaceFirst(RegExp(r'^\s*>+\s?'), '');
      out.add(_inline(line).trim());
    }
  }
  return out.where((s) => s.isNotEmpty).join(' ').replaceAll(RegExp(r'\s+'), ' ').replaceAllMapped(RegExp(r'\s+([,.;:!?])'), (m) => m[1]!).trim();
}
