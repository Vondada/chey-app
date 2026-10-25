// CHE's Social Security number guard on the phone (owner rule, Privacy Center, 2026-10-25).
//
// CHE never stores a full SSN in memory, logs, prompts, analytics, the Brain or the mailbox. Typed or spoken
// text that holds one is stopped HERE, before it leaves the iPhone: the turn is answered on the phone and the
// number is never sent to the CHE Worker, an AI provider, chat history or logs. The Worker repeats the same
// check as defense in depth (server/cloudflare/security_core/ssn.js); the two must find the same things.
//
// What counts as an SSN:
//   - "123-45-6789": the dashed 3-2-4 shape of a valid SSN (area not 000, 666 or 900-999; group not 00;
//     serial not 0000). No context word is needed.
//   - nine digits written any other way ("123 45 6789", "123456789", "one two three four five six seven
//     eight nine") when an SSN word is near: SSN, social security, my social, SS#, ITIN.
// Not: phone numbers (ten digits or 3-3-4), the last four alone, nine-digit numbers with no SSN word near.

const cheSsnRedaction = '[SSN removed]';

/// What CHE says when a turn carried an SSN. The same words as the Worker's SSN_REPLY.
const cheSsnReply = 'I did not keep that. CHE never stores a Social Security number: I removed it before anything was saved, logged or sent to an AI. '
    'When a service needs your number, enter it yourself on that service\'s official site: ssa.gov/myaccount for Social Security, '
    'irs.gov for an Identity Protection PIN, and Equifax, Experian and TransUnion to freeze your credit. '
    'Say "open Privacy Center" for those official links.';

const _digitWords = {
  'zero': '0', 'oh': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
};
const _separatorWords = {'dash', 'hyphen'};
final _context = RegExp(
  r'\bsocial\s+security\b|\bsocial\s*(?:#|no\b|num(?:ber)?\b)'
  r'|\bmy\s+social(?=\s*(?:is\b|was\b|number\b|no\b|#|:|,|$|\d|zero\b|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b))'
  r'|\bssn\b|\bs\.\s?s\.\s?n\b|\bss\s*(?:#|no\b|number\b)|\bitin\b|\btaxpayer\s+id(?:entification)?\b',
  caseSensitive: false,
);
final _dashed = RegExp(r'(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?!\d|-\d)');
final _anyDigit = RegExp(r'\d|zero|one|two|three|four|five|six|seven|eight|nine', caseSensitive: false);

/// True when the nine digits are shaped like an issued SSN.
bool cheValidSsnDigits(String d) {
  if (!RegExp(r'^\d{9}$').hasMatch(d)) return false;
  final area = d.substring(0, 3);
  return area != '000' && area != '666' && !area.startsWith('9') && d.substring(3, 5) != '00' && d.substring(5) != '0000';
}

bool _hasContext(String text, int start, int end) {
  final before = text.substring(start - 80 < 0 ? 0 : start - 80, start);
  final after = text.substring(end, end + 40 > text.length ? text.length : end + 40);
  return _context.hasMatch(before) || _context.hasMatch(after);
}

class _Run {
  _Run(this.start);
  final int start;
  int end = 0;
  String digits = '';
}

List<_Run> _digitRuns(String text) {
  final runs = <_Run>[];
  _Run? run;
  var lastEnd = 0;
  void close() {
    if (run != null && run!.digits.isNotEmpty) runs.add(run!);
    run = null;
  }

  for (final m in RegExp(r'\d+|[A-Za-z]+').allMatches(text)) {
    final token = m[0]!;
    final lower = token.toLowerCase();
    final isNumber = RegExp(r'^\d+$').hasMatch(token);
    final word = _digitWords[lower];
    final joins = run != null && RegExp(r'^[\s.,–-]{0,3}$').hasMatch(text.substring(lastEnd, m.start));
    if (!joins) close();
    if (isNumber || (word != null && (lower != 'oh' || run != null))) {
      run ??= _Run(m.start);
      run!.digits += isNumber ? token : word!;
      run!.end = m.end;
      lastEnd = m.end;
    } else if (run != null && _separatorWords.contains(lower)) {
      lastEnd = m.end;
    } else {
      close();
    }
  }
  close();
  return runs;
}

/// Every SSN in [text] as (start, end). Never the value.
List<(int, int)> cheFindSsns(String text) {
  if (!_anyDigit.hasMatch(text)) return const [];
  final found = <(int, int)>[];
  for (final m in _dashed.allMatches(text)) {
    if (cheValidSsnDigits('${m[1]}${m[2]}${m[3]}') || _hasContext(text, m.start, m.end)) found.add((m.start, m.end));
  }
  for (final r in _digitRuns(text)) {
    if (r.digits.length != 9) continue;
    if (found.any((f) => r.start < f.$2 && f.$1 < r.end)) continue;
    if (_hasContext(text, r.start, r.end)) found.add((r.start, r.end));
  }
  found.sort((a, b) => a.$1.compareTo(b.$1));
  return found;
}

bool cheContainsSsn(String text) => cheFindSsns(text).isNotEmpty;

/// [text] with every SSN replaced by [cheSsnRedaction].
String cheRedactSsn(String text) {
  final found = cheFindSsns(text);
  if (found.isEmpty) return text;
  final out = StringBuffer();
  var at = 0;
  for (final (start, end) in found) {
    if (start < at) continue;
    out
      ..write(text.substring(at, start))
      ..write(cheSsnRedaction);
    at = end;
  }
  out.write(text.substring(at));
  return out.toString();
}

/// A turn about an SSN, even before the digits arrive ("my social security number is"): live voice hands such
/// a turn to the iPhone recognizer so the digits that follow stay on the phone.
bool cheIsSsnTurn(String text) =>
    cheContainsSsn(text) || RegExp(r'\bsocial security (?:number|#)\b|\bmy ssn\b|\bmy social is\b', caseSensitive: false).hasMatch(text);
