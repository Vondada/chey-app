// Ava first. Kokoro only if Edge returns no audio.

import 'dart:typed_data';

import 'che_edge_voice.dart';
import 'che_native_voice.dart';

Future<bool> speakAvaThenKokoro(String text) async {
  final said = text.trim();
  if (said.isEmpty) return false;
  final Uint8List? audio = await CheEdgeVoice.speak(said);
  if (audio != null && audio.isNotEmpty) {
    final played = await CheNativeVoice.playAudio(audio);
    if (played) return true;
  }
  return CheNativeVoice.speakText(said);
}
