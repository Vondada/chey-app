import 'dart:js_interop';

@JS('cheCaptureSpeech')
external JSPromise<JSString> _captureSpeech(
  JSString agentBaseUrl,
  JSString deviceToken,
);

@JS('chePrimeSpeech')
external void _primeSpeech();

@JS('cheSpeakText')
external JSPromise<JSBoolean> _speakText(JSString text);

@JS('cheStopSpeech')
external void _stopSpeech();

Future<String> captureSpeech(String agentBaseUrl, String deviceToken) async {
  final transcript = await _captureSpeech(
    agentBaseUrl.toJS,
    deviceToken.toJS,
  ).toDart;
  return transcript.toDart;
}

Future<bool> speakText(String text) async {
  final played = await _speakText(text.toJS).toDart;
  return played.toDart;
}
void primeSpeech() => _primeSpeech();

void stopSpeech() => _stopSpeech();
