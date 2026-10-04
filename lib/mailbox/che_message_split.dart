// Splits a long mailbox message into readable, ordered bubbles, like
// iPhone Messages: paragraph breaks first, then sentence ends, then word
// gaps. Every word is kept, in order; only the whitespace at each cut is
// dropped.

List<String> cheSplitMessage(String text, {int maxChars = 600}) {
  final clean = text.trim();
  if (clean.length <= maxChars) return [clean];
  final parts = <String>[];
  var rest = clean;
  while (rest.length > maxChars) {
    final window = rest.substring(0, maxChars);
    var cut = window.lastIndexOf('\n\n');
    if (cut < maxChars ~/ 3) {
      final sentence = RegExp(r'[.!?](?=\s)').allMatches(window).map((m) => m.end).where((i) => i >= maxChars ~/ 3);
      cut = sentence.isEmpty ? -1 : sentence.last;
    }
    if (cut < maxChars ~/ 3) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = maxChars;
    parts.add(rest.substring(0, cut).trim());
    rest = rest.substring(cut).trim();
  }
  if (rest.isNotEmpty) parts.add(rest);
  return parts;
}
