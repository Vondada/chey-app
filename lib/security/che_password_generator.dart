// CHE's on-device password generator.
//
// Used when a sign-up form asks for a new password: CHE generates a strong,
// unique password here on the iPhone, saves it to the Keychain vault
// (che_password_vault.dart) BEFORE the form is submitted, and fills it
// straight into the password field. The value never enters chat, memory,
// logs, the Worker or any AI provider. Callers must not print or return it
// in any report; report "password: generated and saved to the vault".
//
// Site rules come from the field itself: minlength / maxlength, the HTML
// `pattern` attribute and Apple's `passwordrules` attribute
// (https://developer.apple.com/password-rules/ — "minlength: 20; required:
// lower; required: upper; required: digit; required: [-_.]; allowed: ...;
// max-consecutive: 2").

import 'dart:math';

/// Character classes understood by `passwordrules`.
const String _lower = 'abcdefghijklmnopqrstuvwxyz';
const String _upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const String _digit = '0123456789';
// Apple's "special" set minus characters that commonly break sites or
// shell/URL contexts (quotes, backslash, space).
const String _specialDefault = '-_.!@#\$%^&*()+=?~';

/// The rules a generated password must satisfy.
class ChePasswordRules {
  const ChePasswordRules({
    this.minLength = 20,
    this.maxLength = 64,
    this.required = const [],
    this.allowed = '',
    this.pattern,
    this.maxConsecutive,
  });

  /// At least this long. CHE never goes below 20 unless the site's maxlength forces it.
  final int minLength;
  final int maxLength;

  /// Each entry is a set of characters; at least one character from each must appear.
  final List<String> required;

  /// Extra characters allowed (beyond the required sets). Empty = lower+upper+digit+default specials.
  final String allowed;

  /// The HTML `pattern` attribute (whole-value match), when the field has one.
  final String? pattern;

  /// Apple `max-consecutive`: no run of identical characters longer than this.
  final int? maxConsecutive;

  /// Builds rules from a field's attributes. Unknown or malformed values are ignored.
  factory ChePasswordRules.fromAttributes({int? minlength, int? maxlength, String? passwordrules, String? pattern}) {
    var minLen = 20;
    var maxLen = 64;
    final req = <String>[];
    final allowed = StringBuffer();
    int? maxConsecutive;
    final rules = (passwordrules ?? '').trim();
    if (rules.isNotEmpty) {
      for (final part in rules.split(';')) {
        final idx = part.indexOf(':');
        if (idx < 0) continue;
        final name = part.substring(0, idx).trim().toLowerCase();
        final value = part.substring(idx + 1).trim();
        switch (name) {
          case 'minlength':
            final n = int.tryParse(value);
            if (n != null && n > minLen) minLen = n;
          case 'maxlength':
            final n = int.tryParse(value);
            if (n != null && n > 0) maxLen = n;
          case 'max-consecutive':
            maxConsecutive = int.tryParse(value);
          case 'required':
            final set = _classSet(value);
            if (set.isNotEmpty) req.add(set);
          case 'allowed':
            allowed.write(_classSet(value));
        }
      }
    }
    if (minlength != null && minlength > minLen) minLen = minlength;
    if (maxlength != null && maxlength > 0 && maxlength < maxLen) maxLen = maxlength;
    if (maxLen < minLen) minLen = maxLen; // the site's hard cap wins
    return ChePasswordRules(
      minLength: minLen,
      maxLength: maxLen,
      required: req,
      allowed: allowed.toString(),
      pattern: (pattern ?? '').trim().isEmpty ? null : pattern!.trim(),
      maxConsecutive: maxConsecutive,
    );
  }

  /// One or more comma-separated `passwordrules` classes → the characters they mean.
  static String _classSet(String value) {
    final out = StringBuffer();
    for (final raw in value.split(',')) {
      final v = raw.trim();
      switch (v.toLowerCase()) {
        case 'lower':
          out.write(_lower);
        case 'upper':
          out.write(_upper);
        case 'digit':
          out.write(_digit);
        case 'special':
          out.write(_specialDefault);
        case 'ascii-printable':
          out.write(_lower + _upper + _digit + _specialDefault);
        case 'unicode':
          out.write(_lower + _upper + _digit + _specialDefault);
        default:
          if (v.startsWith('[') && v.endsWith(']') && v.length > 2) {
            // Custom set: characters inside the brackets (']' and '-' escaped per Apple's spec).
            out.write(v.substring(1, v.length - 1).replaceAll(' ', ''));
          }
      }
    }
    return out.toString();
  }
}

/// Generates a password that satisfies [rules] using a cryptographically
/// secure random source. Throws [StateError] if the rules cannot be met
/// (for example a pattern that no generated password matches), so callers
/// tell the owner instead of submitting a weak or invalid password.
String chePasswordGenerate({ChePasswordRules rules = const ChePasswordRules(), Random? random}) {
  final rng = random ?? Random.secure();
  final requiredSets = rules.required.isNotEmpty ? rules.required : const [_lower, _upper, _digit, _specialDefault];
  final alphabetSet = <String>{
    for (final s in requiredSets) ...s.split(''),
    ...rules.allowed.split('').where((c) => c.isNotEmpty),
  };
  if (rules.required.isEmpty && rules.allowed.isEmpty) alphabetSet.addAll((_lower + _upper + _digit + _specialDefault).split(''));
  final alphabet = alphabetSet.toList();
  if (alphabet.isEmpty) throw StateError('no characters allowed');
  final length = max(rules.minLength, min(24, rules.maxLength)).clamp(1, rules.maxLength);
  if (requiredSets.length > length) throw StateError('too many required character classes for the length');
  final pattern = rules.pattern == null ? null : _tryPattern(rules.pattern!);

  for (var attempt = 0; attempt < 400; attempt++) {
    final chars = <String>[
      for (final s in requiredSets) s[rng.nextInt(s.length)],
      for (var i = requiredSets.length; i < length; i++) alphabet[rng.nextInt(alphabet.length)],
    ];
    // Fisher–Yates so required characters are not always at the front.
    for (var i = chars.length - 1; i > 0; i--) {
      final j = rng.nextInt(i + 1);
      final t = chars[i];
      chars[i] = chars[j];
      chars[j] = t;
    }
    final candidate = chars.join();
    if (rules.maxConsecutive != null && _longestRun(candidate) > rules.maxConsecutive!) continue;
    if (pattern != null && !pattern.hasMatch(candidate)) continue;
    return candidate;
  }
  throw StateError('could not satisfy the site password rules');
}

RegExp? _tryPattern(String p) {
  try {
    return RegExp('^(?:$p)\$');
  } catch (_) {
    return null; // A pattern Dart cannot parse is ignored; the site still validates on submit.
  }
}

int _longestRun(String s) {
  var best = 0, run = 0;
  for (var i = 0; i < s.length; i++) {
    run = i > 0 && s[i] == s[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/// A rough strength estimate in bits (length × log2(alphabet)), for tests and
/// the owner's "how strong is it" question. Never reveals the password.
double chePasswordEntropyBits(String password) {
  var pool = 0;
  if (RegExp('[a-z]').hasMatch(password)) pool += 26;
  if (RegExp('[A-Z]').hasMatch(password)) pool += 26;
  if (RegExp('[0-9]').hasMatch(password)) pool += 10;
  if (RegExp('[^A-Za-z0-9]').hasMatch(password)) pool += 20;
  if (pool == 0) return 0;
  return password.length * (log(pool) / ln2);
}
