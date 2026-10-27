// Fact-checking CHE's replies through Claude's mailbox (owner, 2026-10-26). The request carries the checked message's ID,
// so Claude's verdict (sent with reply_to set to that ID) can be shown under the reply it checks. Nothing here calls a model.
import 'dart:convert';

import 'package:http/http.dart' as http;

/// The first line of every fact-check request. Messages that start with it are requests, not replies.
const String kCheFactCheckLead = 'Fact-check the CHE reply below.';

/// The text sent to Claude for one CHE reply. Claude answers Verified, False or Can't verify for each claim.
String cheFactCheckRequest(String reply, {String messageId = ''}) => '''$kCheFactCheckLead For each factual claim, answer one word: Verified, False, or Can't verify. After each verdict, give the source the owner can check. Do not guess: say Can't verify when you are not sure. Ignore style. Set reply_to to the Message ID below.

Message ID: ${messageId.isEmpty ? 'none' : messageId}
Reply to check:
"""
${reply.trim()}
"""''';

final RegExp _idLine = RegExp(r'^Message ID: (\S+)$', multiLine: true);

/// True when this mailbox message is a fact-check request.
bool cheIsFactCheckRequest(Map m) => '${m['text']}'.startsWith(kCheFactCheckLead);

/// The CHE message a mailbox message is about: the request's own ID line, or the message's own ID for a reply.
String cheCheckedMessageId(Map m) {
  if (cheIsFactCheckRequest(m)) return _idLine.firstMatch('${m['text']}')?.group(1) ?? '';
  return '${m['id'] ?? ''}';
}

/// Claude's verdict for a message in the thread, if it has one. Only a reply from Claude that answers an actual fact-check
/// request in this thread counts, so ordinary correspondence (or another AI's reply) is never shown as a fact-check.
Map? cheVerdictFor(List<Map> thread, Map m) {
  final checked = cheCheckedMessageId(m);
  if (checked.isEmpty) return null;
  final Set<String> keys;
  if (cheIsFactCheckRequest(m)) {
    keys = {if (checked != 'none') checked, if ('${m['id'] ?? ''}'.isNotEmpty) '${m['id']}'};
  } else {
    final requests = thread.where((q) => cheIsFactCheckRequest(q) && cheCheckedMessageId(q) == checked);
    if (requests.isEmpty) return null;
    keys = {checked, for (final q in requests) if ('${q['id'] ?? ''}'.isNotEmpty) '${q['id']}'};
  }
  for (final r in thread) {
    if (identical(r, m) || cheIsFactCheckRequest(r)) continue;
    if ('${r['from']}' == 'claude' && keys.contains('${r['reply_to']}')) return r;
  }
  return null;
}

/// The one-line status under a fact-check request or a checked CHE reply, or null when there is nothing to say.
String? cheFactCheckStatus(List<Map> thread, Map m) {
  final verdict = cheVerdictFor(thread, m);
  if (cheIsFactCheckRequest(m)) return verdict == null ? 'Waiting for Claude' : 'Claude answered';
  if ('${m['from']}' == 'che' && verdict != null) return 'Checked by Claude';
  return null;
}

/// Sends one CHE reply to Claude's thread with the fact-check request. Returns the words to show the owner.
Future<String> cheSendFactCheck({
  required String baseUrl,
  required Map<String, String> headers,
  required String reply,
  String messageId = '',
}) async {
  try {
    final res = await http.post(
      Uri.parse('$baseUrl/api/mailbox'),
      headers: {...headers, 'Content-Type': 'application/json'},
      body: jsonEncode({'to': 'claude', 'text': cheFactCheckRequest(reply, messageId: messageId), 'reply_to': messageId}),
    );
    final sent = res.statusCode >= 200 && res.statusCode < 300;
    return sent ? 'Sent to Claude for a fact-check. The verdicts come back in the mailbox.' : 'Not sent (${res.statusCode}). Try again.';
  } catch (_) {
    return 'Not sent: no connection to CHE. Try again.';
  }
}
