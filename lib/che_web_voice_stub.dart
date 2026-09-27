Future<String> captureSpeech(String agentBaseUrl, String deviceToken) =>
    throw UnsupportedError('Browser speech is only available on the web.');

Future<bool> speakText(String text) async => false;

void primeSpeech() {}

void stopSpeech() {}
