// Face ID gate for the vault: the sheet names the action, the approval has a visible lifetime, repeated failures
// pause prompts, backgrounding locks, and every outcome is audited without a secret.
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/security/che_vault_auth.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  nativeKeychainTests();
  const channel = MethodChannel('che/account_bridge');
  final calls = <Map<dynamic, dynamic>>[];
  var answers = <bool>[];

  setUp(() {
    calls.clear();
    answers = <bool>[];
    CheVaultAuth.instance.debugReset();
    CheVaultAuth.instance.onAudit = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method != 'authenticate') return null;
      calls.add(call.arguments as Map);
      return answers.isEmpty ? false : answers.removeAt(0);
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  test('the Face ID sheet names the action and the target', () {
    expect(CheVaultAuth.reasonFor(VaultAction.fill, target: 'example.com'), 'Use Face ID to fill your saved login for example.com');
    expect(CheVaultAuth.reasonFor(VaultAction.reveal), 'Use Face ID to show a saved password');
  });

  test('the pre-prompt says what will be unlocked and how long the approval lasts', () {
    final text = CheVaultAuth.prePrompt(VaultAction.signIn, target: 'bank.example');
    expect(text, contains('sign you in for bank.example'));
    expect(text, contains('lasts ${CheVaultAuth.sessionTtl.inMinutes} minutes'));
  });

  test('a successful Face ID unlock is audited and reused until the session ends', () async {
    answers = [true];
    final events = <String>[];
    CheVaultAuth.instance.onAudit = events.add;

    expect(await CheVaultAuth.instance.ensureUnlocked(action: VaultAction.fill, target: 'a.com', freshFaceId: true), isTrue);
    expect(await CheVaultAuth.instance.ensureUnlocked(action: VaultAction.fill), isTrue, reason: 'valid session, no new prompt');
    expect(calls, hasLength(1));
    expect(calls.single['requireFaceId'], isTrue);
    expect(calls.single['reason'], 'Use Face ID to fill your saved login for a.com');
    expect(events, ['unlocked']);
  });

  test('a fresh Face ID check is always requested for reveal, even with a valid session', () async {
    answers = [true, true];
    await CheVaultAuth.instance.ensureUnlocked(freshFaceId: true, action: VaultAction.reveal);
    await CheVaultAuth.instance.ensureUnlocked(freshFaceId: true, action: VaultAction.reveal);
    expect(calls, hasLength(2));
  });

  test('three failures in a row pause prompts for the cooldown, and the pause is audited', () async {
    answers = [false, false, false];
    final events = <String>[];
    CheVaultAuth.instance.onAudit = events.add;

    for (var i = 0; i < CheVaultAuth.maxFailures; i++) {
      expect(await CheVaultAuth.instance.ensureUnlocked(freshFaceId: true), isFalse);
    }
    expect(CheVaultAuth.instance.cooldownRemaining, greaterThan(Duration.zero));
    expect(await CheVaultAuth.instance.ensureUnlocked(freshFaceId: true), isFalse);
    expect(calls, hasLength(CheVaultAuth.maxFailures), reason: 'no prompt is shown during the cooldown');
    expect(events, ['failed', 'failed', 'failed', 'cooldown', 'cooldown']);
  });

  test('a success resets the failure count', () async {
    answers = [false, false, true];
    await CheVaultAuth.instance.ensureUnlocked(freshFaceId: true);
    await CheVaultAuth.instance.ensureUnlocked(freshFaceId: true);
    expect(await CheVaultAuth.instance.ensureUnlocked(freshFaceId: true), isTrue);
    expect(CheVaultAuth.instance.cooldownRemaining, Duration.zero);
  });

  test('moving to the background locks the vault and audits it', () async {
    answers = [true];
    final events = <String>[];
    CheVaultAuth.instance.onAudit = events.add;
    await CheVaultAuth.instance.ensureUnlocked(freshFaceId: true);

    CheVaultAuth.instance.onAppBackgrounded();

    expect(CheVaultAuth.instance.isSessionValid, isFalse);
    expect(events.last, 'locked');
  });

  test('audit events never carry the target name or any secret', () async {
    answers = [false];
    final events = <String>[];
    CheVaultAuth.instance.onAudit = events.add;
    await CheVaultAuth.instance.ensureUnlocked(action: VaultAction.fill, target: 'secret-site.example', freshFaceId: true);
    expect(events.join(' '), isNot(contains('secret-site')));
  });
}

// The Keychain item itself must need Face ID to read. The native Swift lives in tool/bootstrap.sh (it generates the iOS
// project) and cannot be compiled in every check, so this guards the binding against a silent regression.
void nativeKeychainTests() {
  final source = File('tool/bootstrap.sh').readAsStringSync();

  test('vault items are bound to the current Face ID enrolment inside the Keychain', () {
    expect(source, contains('.biometryCurrentSet'));
    expect(source, contains('kSecAttrAccessControl as String: access'));
  });

  test('a vault write fails closed when the access control cannot be made', () {
    expect(source, contains('guard let access = SecAccessControlCreateWithFlags('));
  });

  test('a vault read runs off the main thread and asks for Face ID with a reason', () {
    expect(source, contains('kSecUseOperationPrompt as String: "Unlock CHE vault'));
    expect(source, contains('DispatchQueue.global(qos: .userInitiated).async'));
  });
}
