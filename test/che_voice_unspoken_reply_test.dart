// Voice reliability (docs/CHE_VOICE_RELIABILITY_AUDIT.md, findings F1-F3): a
// reply that is not spoken stays on screen, a long unheard text can be read
// in full, and a device-voice chunk that cannot speak shows the banner.
// HomeState is a private part of main.dart, so these are source checks.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  final voice = File('lib/home_state/voice.dart').readAsStringSync();

  test('F1: a speakText that opens no speech turn shows the words when nothing else does', () {
    final start = voice.indexOf('final turn = _openSpeechTurn(readOnDemand: readOnDemand);');
    final end = voice.indexOf('// CHE is written', start);
    expect(start, greaterThan(0));
    expect(end, greaterThan(start));
    final gate = voice.substring(start, end);
    expect(gate, contains('if (turn == null) {'));
    expect(gate, contains('if (!record && !show) _showSpokenReply(text);'),
        reason: 'voice off or realtime speaking must not drop the reply');
    expect(gate, contains('return;'));
  });

  test('F1: the spoken-reply banner scrolls, so a long read-on-demand text is not cut off', () {
    final start = voice.indexOf('void _showSpokenReply(String text)');
    final body = voice.substring(start, voice.indexOf('/// [show]', start));
    expect(body, contains('SingleChildScrollView('));
    expect(body, contains('ConstrainedBox('));
  });

  test('F2: a long unheard text can be read in full from the silent banner', () {
    final start = voice.indexOf('void _showSilentBanner(CheVoiceTurnOutcome outcome)');
    final body = voice.substring(start, voice.indexOf('/// Every unheard word', start));
    expect(body, contains("final shown = unspoken.length > 600 ? '\${unspoken.substring(0, 600)}…' : unspoken;"));
    expect(body, contains("SnackBarAction(label: 'Read all', onPressed: () => _showUnheardText(outcome))"));
    expect(body, contains('action: unspoken.length > 600'));

    final full = voice.substring(voice.indexOf('void _showUnheardText('));
    expect(full, contains("SelectableText(outcome.silentText.join(' '),"));
    expect(full, contains('SingleChildScrollView('));
  });

  test('F3: a device-voice chunk that could not speak shows the silent banner', () {
    final start = voice.indexOf('onUnspoken: (text) async {');
    expect(start, greaterThan(0), reason: 'the pipeline must be told about unspoken chunks');
    final body = voice.substring(start, voice.indexOf('onComplete: (cancelled)', start));
    expect(body, contains("outcome.stayedSilent(text, 'the device voice could not speak');"));
    expect(body, contains('_showSilentBanner(outcome);'));
  });
}
