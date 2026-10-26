// The fact-check request copied from a CHE reply (owner, 2026-10-26): it keeps the reply exactly and asks for sources.
import 'package:chey/mailbox/che_fact_check.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the request keeps the reply word for word and asks for checkable sources', () {
    const reply = 'Water boils at 100 °C at sea level.';
    final request = cheFactCheckRequest('  $reply  ');
    expect(request, contains('"""\n$reply\n"""'));
    expect(request, contains('Verified, False, or Can\'t verify'));
    expect(request, contains('give the source'));
    expect(request, contains('Do not guess'));
  });
}
