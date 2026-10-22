// One phone-side secret check for CHE (Security Intelligence). It mirrors the Worker's BROAD_SECRET_RE in
// server/cloudflare/security_intelligence.js; text that matches is never sent or imported.

/// Password-, key- and token-shaped text (mirrors the Worker's BROAD_SECRET_RE, including the plain "password hunter2" form).
final _secretPattern = RegExp(
  r'\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})'
  r'|\b(?:password|passcode|passphrase|api[ _-]?key|secret[ _-]?key|access[ _-]?token|auth[ _-]?token|token|pin)\s*(?:is\s+|=\s*|:\s*|\s)\s*(?!is\b|for\b|the\b|a\b|to\b|and\b|of\b)\S{4,}',
  caseSensitive: false,
);
bool cheLooksSecret(String text) => _secretPattern.hasMatch(text);
