// Check Connection for Modal (owner report, 2026-10-27): it said "Modal is not connected. The check gave no detail."
// because the server's reason was under failure/verification, not where the screen looked. These pin what it says now.
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/mailbox/che_mailbox_screen.dart';

void main() {
  test('a failed check says its category, its reason and its check ID', () {
    final said = cheModalCheckSpeech({
      'ok': false,
      'category': 'unauthorized',
      'detail': "CHE's Modal app rejected the access token (HTTP 401)",
      'request_id': 'chk_0123456789ab',
    }, httpStatus: 422);
    expect(said, "Modal is not connected (unauthorized). CHE's Modal app rejected the access token (HTTP 401). Check ID chk_0123456789ab.");
  });

  test('an older server reply still gives its reason from failure.detail, never "no detail"', () {
    final said = cheModalCheckSpeech({
      'ok': false,
      'failure': {'reason': 'token_missing_info', 'detail': 'CHE has no Modal token to verify'},
    }, httpStatus: 409);
    expect(said, contains('CHE has no Modal token to verify'));
    expect(said, isNot(contains('gave no detail')));
  });

  test('a reply with no reason at all still names the HTTP status', () {
    expect(cheModalCheckSpeech(const {}, httpStatus: 500), 'Modal is not connected. CHE answered HTTP 500 with no reason.');
  });

  test('a passed check says connected with its check ID', () {
    final said = cheModalCheckSpeech({'ok': true, 'category': 'ok', 'detail': "CHE's Modal app accepted the access token", 'request_id': 'chk_aaaaaaaaaaaa'});
    expect(said, "Modal is connected. CHE's Modal app accepted the access token. Check ID chk_aaaaaaaaaaaa.");
  });
}
