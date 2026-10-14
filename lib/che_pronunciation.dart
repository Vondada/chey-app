/// CHE is written "CHE" and said "Chay". Only the words handed to a voice
/// change; the transcript keeps "CHE". The Worker applies the same rule.
String cheSpokenText(String text) => text
    .replaceAll(RegExp(r'\bCHE\b'), 'Chay')
    .replaceAll(RegExp(r'\bChe\b'), 'Chay');
