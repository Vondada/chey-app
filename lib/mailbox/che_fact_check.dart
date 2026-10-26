// The fact-check request for CHE's replies (owner, 2026-10-26): the owner copies a reply and pastes it into any AI.
// The request asks for what can be checked, not for a confident verdict, and it keeps CHE's words exactly as written.

/// The text copied to the clipboard for one CHE reply.
String cheFactCheckRequest(String reply) => '''Fact-check the reply below. For each factual claim, say whether it is correct, wrong, or cannot be verified. Name the source I can check for each one. Do not guess: if you are not sure, say so. Ignore style.

Reply to check:
"""
${reply.trim()}
"""''';
