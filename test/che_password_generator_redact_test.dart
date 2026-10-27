import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:chey/security/che_password_generator.dart';
import 'package:chey/security/che_redact.dart';

void main() {
  group('password generator', () {
    test('default: 20+ chars with lower, upper, digit and symbol, and unique each time', () {
      final seen = <String>{};
      for (var i = 0; i < 200; i++) {
        final p = chePasswordGenerate();
        expect(p.length, greaterThanOrEqualTo(20));
        expect(p, matches(RegExp('[a-z]')));
        expect(p, matches(RegExp('[A-Z]')));
        expect(p, matches(RegExp('[0-9]')));
        expect(p, matches(RegExp('[^A-Za-z0-9]')));
        expect(chePasswordEntropyBits(p), greaterThan(110));
        seen.add(p);
      }
      expect(seen.length, 200);
    });

    test('Apple passwordrules: required classes, custom set, maxlength and max-consecutive', () {
      final rules = ChePasswordRules.fromAttributes(
        passwordrules: 'minlength: 22; maxlength: 30; required: lower; required: upper; required: digit; required: [-_]; max-consecutive: 2',
      );
      expect(rules.minLength, 22);
      expect(rules.maxLength, 30);
      for (var i = 0; i < 100; i++) {
        final p = chePasswordGenerate(rules: rules);
        expect(p.length, inInclusiveRange(22, 30));
        expect(p, matches(RegExp(r'^[A-Za-z0-9_-]+$')), reason: 'only the allowed sets');
        expect(p, matches(RegExp('[-_]')));
        expect(RegExp(r'(.)\1\1').hasMatch(p), isFalse, reason: 'max-consecutive 2');
      }
    });

    test('a site maxlength below 20 is respected; pattern attribute is satisfied', () {
      final short = ChePasswordRules.fromAttributes(maxlength: 16);
      expect(chePasswordGenerate(rules: short).length, 16);
      final pattern = ChePasswordRules.fromAttributes(pattern: '[A-Za-z0-9]{20,32}', passwordrules: 'required: lower; required: upper; required: digit');
      for (var i = 0; i < 50; i++) {
        expect(chePasswordGenerate(rules: pattern), matches(RegExp(r'^[A-Za-z0-9]{20,32}$')));
      }
    });

    test('impossible rules throw instead of producing a weak password', () {
      final impossible = ChePasswordRules.fromAttributes(passwordrules: 'required: digit', pattern: '[a-z]+');
      expect(() => chePasswordGenerate(rules: impossible, random: Random(1)), throwsStateError);
    });
  });

  group('redaction guard', () {
    const secrets = {
      'groq': 'gsk_abcdefghijklmnop1234QRSTuvwx5678',
      'openai': 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV123456',
      'anthropic': 'sk-ant-api03-ABCDEFGHIJKLMNOPqrstu-9999',
      'hf': 'hf_ABCDEFGHIJKLMNOPQRSTUVWXyz12',
      'google': 'AIzaSyA1234567890abcdefghijklmnopqrstu',
      'github': 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'pat': 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'jwt': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
      'hex': '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    };

    for (final entry in secrets.entries) {
      test('masks a ${entry.key} credential and keeps at most its last 4', () {
        final line = 'Saved ${entry.key} credential ${entry.value} for CHE.';
        final out = cheRedact(line);
        expect(out.contains(entry.value), isFalse, reason: out);
        expect(out, contains('[redacted'));
        // Nothing longer than 4 characters of the secret survives.
        // (The public format prefix such as "sk-ant-" may be named in the mask.)
        final body = entry.value.replaceFirst(RegExp(r'^(?:sk-ant-|sk-proj-|github_pat_|gsk_|hf_|ghp_|AIza)'), '');
        for (var i = 0; i + 5 <= body.length; i++) {
          expect(out.contains(body.substring(i, i + 5)), isFalse, reason: out);
        }
      });
    }

    test('password assignments, bearer headers and PEM keys are masked; ordinary words are not', () {
      expect(cheRedact('password: hunter2!!'), 'password: [redacted]');
      expect(cheRedact('Authorization: Bearer abcdefghijklmnop123456'), contains('Bearer [redacted token'));
      expect(cheRedact('-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----'), '[redacted private key]');
      const plain = 'Password: filled from vault. Groq key saved, ending 1a2b, test passed.';
      expect(cheRedact(plain), plain);
      expect(cheRedact('Filled first name, email and phone on example.com.'), 'Filled first name, email and phone on example.com.');
    });

    test('exact secrets are masked even when they look ordinary (a generated password)', () {
      final p = chePasswordGenerate();
      final out = cheRedact('the form now holds $p in the field', secrets: [p]);
      expect(out.contains(p), isFalse);
      expect(cheContainsSecret('field holds $p', secrets: [p]), isTrue);
      expect(cheContainsSecret('field holds nothing'), isFalse);
    });

    test('masking profile values for the owner\'s screen', () {
      expect(cheMaskValue('jane@example.com', kind: 'email'), 'j•••@example.com');
      expect(cheMaskValue('(602) 555-0147', kind: 'tel'), '•••• 47');
      expect(cheMaskValue('12-3456789', kind: 'x-ein'), '•••• 89');
      expect(cheMaskValue('Jane'), 'J•••');
    });
  });
}
