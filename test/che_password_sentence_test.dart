import 'package:flutter_test/flutter_test.dart';
import 'package:chey/security/che_password_vault.dart';

// A password sentence is kept on the phone: stored in the vault, or refused.
// It is never sent to the Worker (send.dart intercepts it before any request).
void main() {
  group('Password sentences on the phone', () {
    test('"my <site> password is <value>" saves to the vault', () {
      final c = CheVaultCommand.parse('my gmail password is hunter2')!;
      expect(c.kind, 'save');
      expect(c.site, 'gmail');
      expect(c.password, 'hunter2');
    });

    test('"my <site> password: <value>" keeps the value exactly', () {
      final c = CheVaultCommand.parse('my bank password: Blue\$tone9')!;
      expect(c.kind, 'save');
      expect(c.site, 'bank');
      expect(c.password, 'Blue\$tone9');
    });

    test('a multi-word value and "the password for <site> is" save whole', () {
      final wifi = CheVaultCommand.parse('the wifi password is correct horse battery')!;
      expect(wifi.kind, 'save');
      expect(wifi.password, 'correct horse battery');
      final netflix = CheVaultCommand.parse('the password for netflix is Rocket9')!;
      expect(netflix.site, 'netflix');
      expect(netflix.password, 'Rocket9');
    });

    test('a password sentence with no site is refused, not stored', () {
      expect(CheVaultCommand.parse('my password is hunter2')!.kind, 'refuse');
    });

    test('every password-setting sentence is intercepted before the Worker', () {
      expect(CheVaultCommand.isPasswordSentence('my gmail password is hunter2'), isTrue);
      expect(CheVaultCommand.isPasswordSentence('my bank password: Blue\$tone9'), isTrue);
      expect(CheVaultCommand.isPasswordSentence('the wifi password is correct horse battery'), isTrue);
    });

    test('sentences that mention a password without a value are not intercepted', () {
      expect(CheVaultCommand.isPasswordSentence('how do I reset my password?'), isFalse);
      expect(CheVaultCommand.isPasswordSentence('my password is in the vault'), isFalse);
      expect(CheVaultCommand.parse('how do I reset my password?'), isNull);
    });

    test('existing read, list and delete commands are unchanged', () {
      expect(CheVaultCommand.parse("What's my Netflix password?")!.kind, 'read');
      expect(CheVaultCommand.parse('what passwords do you have')!.kind, 'list');
      expect(CheVaultCommand.parse('delete my gmail password')!.kind, 'delete');
    });
  });
}
