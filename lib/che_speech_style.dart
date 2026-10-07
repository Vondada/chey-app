// Spoken CHE. Sir stays. Only a doubled space is cleaned.

String stripButler(String text) {
  return text.replaceAll(RegExp(r'\s{2,}'), ' ').trim();
}
