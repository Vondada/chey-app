// Fact-check requests, verdicts and statuses (owner, 2026-10-26): a verdict sits under the reply it checks.
import 'package:chey/mailbox/che_fact_check.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the request keeps the reply word for word, asks for verdicts and names the checked message', () {
    const reply = 'Water boils at 100 °C at sea level.';
    final request = cheFactCheckRequest('  $reply  ', messageId: 'che-7');
    expect(request, contains('"""\n$reply\n"""'));
    expect(request, contains("Verified, False, or Can't verify"));
    expect(request, contains('Message ID: che-7'));
    expect(cheFactCheckRequest(reply), contains('Message ID: none'));
  });

  test("a verdict from Claude sits under the CHE reply it names, and the request shows waiting then answered", () {
    final reply = {'id': 'che-7', 'from': 'che', 'to': 'claude', 'text': 'Water boils at 100 °C.'};
    final request = {'id': 'owner-1', 'from': 'che', 'to': 'claude', 'source': 'owner', 'text': cheFactCheckRequest(reply['text'] as String, messageId: 'che-7')};
    final verdict = {'id': 'claude-1', 'from': 'claude', 'to': 'che', 'reply_to': 'che-7', 'text': 'Verified. Source: NIST.'};

    expect(cheVerdictFor([reply, request], reply), isNull);
    expect(cheFactCheckStatus([reply, request], request), 'Waiting for Claude');
    expect(cheFactCheckStatus([reply, request], reply), isNull);

    final thread = [reply, request, verdict];
    expect(cheVerdictFor(thread, reply), same(verdict));
    expect(cheFactCheckStatus(thread, reply), 'Checked by Claude');
    expect(cheFactCheckStatus(thread, request), 'Claude answered');
  });

  test('a message that is not about any CHE reply has no verdict', () {
    final other = {'id': 'x', 'from': 'che', 'text': 'Good morning.'};
    expect(cheVerdictFor([other], other), isNull);
  });
}
