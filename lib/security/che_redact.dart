// CHE's redaction guard: one function every report, banner, spoken reply and
// log line about credentials goes through before it is shown, spoken,
// stored or printed.
//
// It masks anything shaped like an API key, token or password (provider
// prefixes such as gsk_, sk-, sk-ant-, hf_, AIza, ghp_/github_pat_, xai-,
// Stripe sk_/rk_, Slack xox*, AWS AKIA, JWTs, PEM private keys, long hex or
// base64-like strings, "password: x" assignments) plus any exact secret the
// caller passes in [secrets]. What is left is safe redacted status such as
// "Groq key saved, ending 1a2b, test passed".
//
// The mask keeps a recognisable prefix and at most the last 4 characters
// (the same "last4" the Worker's /api/keys already returns), never more.

/// Known key formats: (prefix shown in the mask, pattern).
final List<(String, RegExp)> _keyFormats = [
  ('sk-ant-', RegExp(r'sk-ant-[A-Za-z0-9_-]{16,}')),
  ('sk-proj-', RegExp(r'sk-proj-[A-Za-z0-9_-]{16,}')),
  ('sk-or-', RegExp(r'sk-or-[A-Za-z0-9_-]{16,}')),
  ('sk-', RegExp(r'\bsk-[A-Za-z0-9_-]{16,}')),
  ('sk_live_', RegExp(r'\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}')),
  ('gsk_', RegExp(r'\bgsk_[A-Za-z0-9]{16,}')),
  ('hf_', RegExp(r'\bhf_[A-Za-z0-9]{16,}')),
  ('xai-', RegExp(r'\bxai-[A-Za-z0-9_-]{16,}')),
  ('csk-', RegExp(r'\bcsk-[A-Za-z0-9_-]{16,}')),
  ('AIza', RegExp(r'\bAIza[0-9A-Za-z_-]{30,}')),
  ('github_pat_', RegExp(r'\bgithub_pat_[A-Za-z0-9_]{20,}')),
  ('gh*_', RegExp(r'\bgh[pousr]_[A-Za-z0-9]{20,}')),
  ('xox', RegExp(r'\bxox[baprs]-[A-Za-z0-9-]{10,}')),
  ('AKIA', RegExp(r'\bAKIA[0-9A-Z]{16}\b')),
  ('JWT', RegExp(r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}')),
];

final RegExp _pem = RegExp(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)');
final RegExp _bearer = RegExp(r'\b(Bearer|Basic|token)\s+([A-Za-z0-9._~+/=-]{12,})', caseSensitive: false);
// "password: x", "api_key=x", "secret is x", "pin 1234": keep the label, mask the value.
final RegExp _assignment = RegExp(
  r'\b(password|passwd|passcode|passphrase|pwd|pin|api[ _-]?key|secret(?:[ _-]?key)?|client[ _-]?secret|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|private[ _-]?key|token)(\s*(?:is|=|:)\s*|\s+)(?!is\b|for\b|the\b|a\b|an\b|to\b|and\b|of\b|was\b|has\b|from\b|saved\b|filled\b|generated\b|redacted\b)("[^"]{4,}"|\x27[^\x27]{4,}\x27|\S{4,})',
  caseSensitive: false,
);
// Long opaque runs: 32+ hex, or 32+ base64/url-safe chars containing both letters and digits.
final RegExp _longHex = RegExp(r'\b[0-9a-fA-F]{32,}\b');
final RegExp _longOpaque = RegExp(r'[A-Za-z0-9+/_=-]{32,}');

String _tail(String s) => s.length >= 12 ? s.substring(s.length - 4) : '';

String _mask(String label, String secret) {
  final t = _tail(secret);
  return t.isEmpty ? '[redacted $label]' : '[redacted $label …$t]';
}

/// Returns [text] with every secret-shaped run masked. [secrets] are exact
/// values to mask wherever they appear (for example the password CHE just
/// generated, or the key it just read), even if they look ordinary.
String cheRedact(String text, {Iterable<String> secrets = const []}) {
  if (text.isEmpty) return text;
  var out = text;
  // Exact secrets first, longest first, so a short one never leaves part of a long one.
  final exact = [for (final s in secrets) if (s.length >= 4) s]..sort((a, b) => b.length.compareTo(a.length));
  for (final s in exact) {
    out = out.replaceAll(s, '[redacted secret]');
  }
  out = out.replaceAllMapped(_pem, (_) => '[redacted private key]');
  for (final (label, re) in _keyFormats) {
    out = out.replaceAllMapped(re, (m) => _mask('$label key', m[0]!));
  }
  out = out.replaceAllMapped(_bearer, (m) => '${m[1]} ${_mask('token', m[2]!)}');
  out = out.replaceAllMapped(_assignment, (m) {
    final value = m[3]!;
    if (value.startsWith('[redacted')) return m[0]!;
    return '${m[1]}${m[2]}[redacted]';
  });
  out = out.replaceAllMapped(_longHex, (m) => _mask('hex', m[0]!));
  out = out.replaceAllMapped(_longOpaque, (m) {
    final v = m[0]!;
    if (v.startsWith('redacted') || !RegExp('[0-9]').hasMatch(v) || !RegExp('[A-Za-z]').hasMatch(v)) return v;
    return _mask('token', v);
  });
  return out;
}

/// True when [text] still contains something secret-shaped after the given
/// exact [secrets] are considered: use as an assertion before logging.
bool cheContainsSecret(String text, {Iterable<String> secrets = const []}) => cheRedact(text, secrets: secrets) != text;

/// Masks a profile value for display on the owner's own screen:
/// email → j•••@example.com, phone → •••• 1234, others → first char + •••.
String cheMaskValue(String value, {String kind = ''}) {
  final v = value.trim();
  if (v.isEmpty) return '';
  if (kind == 'email' || (v.contains('@') && !v.contains(' '))) {
    final at = v.indexOf('@');
    if (at > 0) return '${v[0]}•••${v.substring(at)}';
  }
  final digits = v.replaceAll(RegExp(r'\D'), '');
  if (kind == 'tel' || kind == 'x-ein' || kind == 'bday' || (digits.length >= 6 && digits.length >= v.length - 4)) {
    return digits.length >= 4 ? '•••• ${digits.substring(digits.length - 2)}' : '••••';
  }
  if (v.length <= 2) return '••';
  return '${v[0]}•••';
}
