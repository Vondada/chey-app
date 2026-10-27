// Live words from the iPhone's native recognizer (handoff 8f, owner: "my words are not transcribed live").
// tool/bootstrap.sh emits {type: "partial", text} while the owner speaks; this decides what the composer shows.

/// The composer text for a native partial transcript, or null to leave the composer as it is.
///
/// Partials replace only what an earlier partial wrote ([lastShown]) or an empty composer: anything the owner typed is
/// never overwritten. Nothing shows while a turn is being sent, or while CHE sleeps waiting for her wake word (what the
/// room says then is not the owner talking to her).
String? cheComposerForPartial({
  required String partial,
  required String composer,
  required String lastShown,
  required bool sending,
  required bool asleepForWake,
}) {
  final words = partial.trim();
  if (words.isEmpty || sending || asleepForWake) return null;
  if (composer.isNotEmpty && composer != lastShown) return null;
  return words == composer ? null : words;
}
