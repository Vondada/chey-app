// Pins the voice fixes of 2026-10-24:
// 1. Passive polls (finished jobs, pending approvals, the first poll at
//    launch) never start CHE speech unless the owner is in a live voice
//    conversation (owner rule 2026-10-11).
// 2. A password turn never stays on live voice (OpenAI Realtime): CHE drops it
//    from the live session, switches to the iPhone recognizer and holds live
//    voice off; a password or vault surface never opens live voice.
// 3. Deleting a memory, project, vault note or Brain fact asks first.
// 4. Replies spoken without a chat bubble are also shown as large text.
// 5. The IPA workflow builds without cross-app screen broadcast by default.
import 'dart:io';

import 'package:chey/che_voice_health.dart';
import 'package:chey/security/che_password_vault.dart';
import 'package:flutter_test/flutter_test.dart';

String _body(String source, String signature) {
  final start = source.indexOf(signature);
  expect(start, greaterThanOrEqualTo(0), reason: 'missing $signature');
  final end = source.indexOf(RegExp(r'\n  (?:Future<|void |bool |String |Widget )'), start + signature.length);
  return source.substring(start, end < 0 ? source.length : end);
}

void main() {
  group('passive notices', () {
    test('speak only in an active voice conversation with nothing else speaking', () {
      expect(chePassiveNoticeMaySpeak(activeConversation: false, speaking: false, sending: false), isFalse,
          reason: 'launch and passive screens stay silent');
      expect(chePassiveNoticeMaySpeak(activeConversation: true, speaking: true, sending: false), isFalse);
      expect(chePassiveNoticeMaySpeak(activeConversation: true, speaking: false, sending: true), isFalse);
      expect(chePassiveNoticeMaySpeak(activeConversation: true, speaking: false, sending: false), isTrue);
    });

    test('finished jobs and new approvals are gated, and keep their notification and haptic', () {
      final main = File('lib/main.dart').readAsStringSync();
      final jobs = _body(main, 'Future<void> _notifyFinishedJobs()');
      expect(jobs, contains('chePassiveNoticeMaySpeak('));
      expect(jobs, isNot(contains('if (!_isSpeaking && !_isSending) await speakText(text);')));
      expect(jobs, contains('CheNotifications.show('));
      expect(jobs, contains('_statusHaptic('));
      expect(jobs, contains(r"RegExp(r'\s+')"), reason: 'collapse whitespace, not a literal backslash-s');
      expect(jobs, isNot(contains(r"RegExp(r'\\s+')")));
      expect(main, contains('bool get _inActiveVoiceConversation => openConversation && !cheSleeping;'));

      final security = File('lib/home_state/security.dart').readAsStringSync();
      final approvalAt = security.indexOf("speakText('Approval needed.");
      expect(approvalAt, greaterThan(0));
      final before = security.substring(approvalAt - 400, approvalAt);
      expect(before, contains('chePassiveNoticeMaySpeak(activeConversation: _inActiveVoiceConversation'));
      expect(security, contains("title: 'CHE needs your approval'"));
    });
  });

  group('passwords and live voice', () {
    test('password turns are recognized, ordinary turns are not', () {
      for (final turn in [
        'save my Gmail password hunter2',
        "what's my Netflix password",
        'I want to save a password',
        'my PIN is 4821',
        'chay, store my bank passcode',
        'here is my api key sk-abcdefghijklmnop1234',
      ]) {
        expect(cheIsPasswordTurn(turn), isTrue, reason: turn);
      }
      for (final turn in ['what is the weather', 'pin this note to the top', 'open the storage vault room', '']) {
        expect(cheIsPasswordTurn(turn), isFalse, reason: turn);
      }
    });

    test('live voice never starts on a password surface', () {
      final now = DateTime(2026, 10, 24);
      final never = DateTime.fromMillisecondsSinceEpoch(0);
      expect(cheUseLiveVoice(liveConfigured: true, skipUntil: never, now: now, passwordSurface: true), isFalse);
      expect(cheUseLiveVoice(liveConfigured: true, skipUntil: never, now: now), isTrue);
      expect(chePasswordVoiceHold, greaterThanOrEqualTo(const Duration(minutes: 5)));
      final security = File('lib/home_state/security.dart').readAsStringSync();
      expect(security, contains('passwordSurface: CheScreenCapture.blocked'));
    });

    test('a realtime password turn leaves live voice before anything else runs', () {
      final security = File('lib/home_state/security.dart').readAsStringSync();
      final body = _body(security, 'Future<void> _onRealtimeUserTranscript(');
      final guard = body.indexOf('if (cheIsPasswordTurn(clean))');
      expect(guard, greaterThan(0));
      expect(guard, lessThan(body.indexOf('await sendMessage(fromVoice: true);')),
          reason: 'switch away from live voice before the turn is handled');
      final guarded = body.substring(guard);
      expect(guarded, contains('_realtimeVoice?.forgetUserItem(itemId);'));
      expect(guarded, contains('_realtimeSkipUntil = DateTime.now().add(chePasswordVoiceHold);'));
      expect(guarded, contains('_fallbackAfterRealtimeLoss('));
      expect(body, contains('Residual limit'), reason: 'the limit is documented honestly');

      final realtime = File('lib/che_realtime_voice.dart').readAsStringSync();
      final forget = _body(realtime, 'void forgetUserItem(');
      expect(forget, contains("'type': 'conversation.item.delete'"));
      expect(forget, contains("'item_id': id"));

      // The vault and secret checks still run before the Worker in sendMessage.
      final send = File('lib/home_state/send.dart').readAsStringSync();
      final sendBody = _body(send, 'Future<void> sendMessage(');
      expect(sendBody.indexOf('CheVaultCommand.parse(message)'), lessThan(sendBody.indexOf('_streamCheResponse')));
    });
  });

  test('deletes ask first and report the result', () {
    final memory = File('lib/home_state/memory.dart').readAsStringSync();
    expect(memory, contains('Future<bool> _confirmDelete(String what)'));
    expect(memory, contains("if (!await _confirmDelete('this memory')) return;"));
    expect(memory, contains("if (!await _confirmDelete('this project')) return;"));
    expect(memory, contains("if (!await _confirmDelete('this vault note')) return;"));
    expect(memory, contains("'Deleted that memory, sir.'"));
    final brain = File('lib/che_ui/che_brain.dart').readAsStringSync();
    expect(brain, contains('confirmDismiss: (_) => _confirmForgetFact(context, f.text),'));
    expect(brain, isNot(contains('onPressed: () => brain.removeFact(f.id),')));
  });

  test('replies spoken without a chat bubble are also shown as large text', () {
    final voice = File('lib/home_state/voice.dart').readAsStringSync();
    expect(voice, contains('bool show = false'));
    expect(voice, contains('if (show) _showSpokenReply(text);'));
    final send = File('lib/home_state/send.dart').readAsStringSync();
    expect(send, contains("Keys go in the Keys tab.', record: false, show: true);"));
  });

  test('the IPA workflow builds without the screen broadcast extension by default', () {
    final workflow = File('.github/workflows/che-iphone-ipa.yml').readAsStringSync();
    expect(workflow, contains("CHE_SCREEN_BROADCAST: \${{ vars.CHE_SCREEN_BROADCAST || 'off' }}"));
    final bootstrap = File('tool/bootstrap.sh').readAsStringSync();
    expect(bootstrap, contains(r'"${CHE_SCREEN_BROADCAST:-off}" == "on"'));
  });
}
