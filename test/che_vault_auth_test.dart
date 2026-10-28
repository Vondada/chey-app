import 'package:flutter_test/flutter_test.dart';
import 'package:chey/security/che_vault_auth.dart';

void main() {
  late CheVaultAuth auth;

  setUp(() {
    auth = CheVaultAuth.instance;
    auth.lock();
  });

  tearDown(() {
    auth.lock();
  });

  test('session starts locked', () {
    expect(auth.isSessionValid, isFalse);
    expect(auth.sessionRemaining, Duration.zero);
  });

  test('debug unlock sets valid session within TTL', () {
    auth.debugSetUnlockedUntil(DateTime.now().add(const Duration(minutes: 5)));
    expect(auth.isSessionValid, isTrue);
    expect(auth.sessionRemaining.inSeconds, greaterThan(200));
  });

  test('expired unlock is invalid', () {
    auth.debugSetUnlockedUntil(DateTime.now().subtract(const Duration(seconds: 1)));
    expect(auth.isSessionValid, isFalse);
    expect(auth.sessionRemaining, Duration.zero);
  });

  test('lock clears session', () {
    auth.debugSetUnlockedUntil(DateTime.now().add(CheVaultAuth.sessionTtl));
    expect(auth.isSessionValid, isTrue);
    auth.lock();
    expect(auth.isSessionValid, isFalse);
  });

  test('default TTL is between 5 and 15 minutes', () {
    expect(CheVaultAuth.sessionTtl.inMinutes, greaterThanOrEqualTo(5));
    expect(CheVaultAuth.sessionTtl.inMinutes, lessThanOrEqualTo(15));
  });
}
