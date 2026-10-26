// The fact-check request for CHE's replies (owner, 2026-10-26): the reply goes to Claude's mailbox, and Claude answers
// Verified, False or Can't verify for each claim with a source. It keeps CHE's words exactly as written.

/// The text copied to the clipboard for one CHE reply.
String cheFactCheckRequest(String reply) => '''Fact-check the CHE reply below. For each factual claim, answer one word: Verified, False, or Can't verify. After each verdict, give the source the owner can check. Do not guess: say Can't verify when you are not sure. Ignore style.

Reply to check:
"""
${reply.trim()}
"""''';
