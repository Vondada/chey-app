import 'che_edge_voice.dart';

// Speak path only. Ava first, Kokoro if Edge returns nothing.
// The rest of CheNativeVoice stays in this file on the branch; this replace
// is the speakText order the phone must use.

extension CheAvaFirst on CheNativeVoice {
  static Future<bool> speakAvaFirst(String text) async {
    final audio = await CheEdgeVoice.speak(text);
    if (audio != null && audio.isNotEmpty) {
      final played = await CheNativeVoice.playAudio(audio);
      if (played) return true;
    }
    return CheNativeVoice.speakText(text);
  }
}
