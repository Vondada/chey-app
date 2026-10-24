// Flagstaff message times. The Worker sends every `at` as UTC ISO-8601 with Z (server/cloudflare/mailbox_time.js);
// the app shows it in the device's own time zone. Older rows are read the same way the Worker reads them: a clock
// time without a zone is UTC (every writer produced UTC), and a bare date is a date, never shifted to the day before.

final RegExp _dateOnly = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final RegExp _hasZone = RegExp(r'(?:Z|[+-]\d{2}(?::?\d{2})?)$', caseSensitive: false);

/// The UTC instant of a message's `at`, or null when it is not a date.
DateTime? cheMailInstant(Object? at) {
  final s = '${at ?? ''}'.trim();
  if (s.isEmpty) return null;
  if (_dateOnly.hasMatch(s)) return DateTime.tryParse('${s}T00:00:00Z');
  // Dart reads a zone-less time as device-local; the mailbox's zone-less values were written in UTC.
  final hasClock = s.length > 10 && (s[10] == 'T' || s[10] == 't' || s[10] == ' ');
  return DateTime.tryParse(hasClock && !_hasZone.hasMatch(s) ? '${s}Z' : s)?.toUtc();
}

/// True when the message only carries a calendar date.
bool cheMailDayOnly(Map m) => '${m['at_precision'] ?? ''}' == 'day' || _dateOnly.hasMatch('${m['at'] ?? ''}'.trim());

/// Oldest first by instant; unknown times sort last. List.sort is not stable, so callers that need ties kept
/// should use [cheSortMail].
int cheMailCompare(Map a, Map b) {
  final x = cheMailInstant(a['at']);
  final y = cheMailInstant(b['at']);
  if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
  return x.compareTo(y);
}

/// Stable chronological sort: equal times keep their original order.
List<Map> cheSortMail(Iterable<Map> messages) {
  final indexed = messages.toList().asMap().entries.toList()
    ..sort((a, b) {
      final c = cheMailCompare(a.value, b.value);
      return c != 0 ? c : a.key.compareTo(b.key);
    });
  return [for (final e in indexed) e.value];
}

Duration _deviceOffset(DateTime utc) => utc.toLocal().timeZoneOffset;

/// "12:16 PM" for today, otherwise "10/24", in the device's zone. [offsetOf] gives the zone's UTC offset at an
/// instant (tests pass America/Chicago so the result does not depend on the machine).
String cheMailWhen(Map m, {DateTime? now, Duration Function(DateTime utc)? offsetOf}) {
  final utc = cheMailInstant(m['at']);
  if (utc == null) return '';
  if (cheMailDayOnly(m)) return '${utc.month}/${utc.day}';
  final zone = offsetOf ?? _deviceOffset;
  final t = utc.add(zone(utc));   // wall-clock fields, read in UTC
  final nowUtc = (now ?? DateTime.now()).toUtc();
  final today = nowUtc.add(zone(nowUtc));
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  final clock = '$h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
  if (t.year == today.year && t.month == today.month && t.day == today.day) return clock;
  return '${t.month}/${t.day}';
}

/// "10/24 12:16 PM" in the device's zone (archive titles), or '' when [at] is not a time.
String cheMailStamp(Object? at, {Duration Function(DateTime utc)? offsetOf}) {
  final utc = cheMailInstant(at);
  if (utc == null) return '';
  final t = utc.add((offsetOf ?? _deviceOffset)(utc));
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  return '${t.month}/${t.day} $h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
}
