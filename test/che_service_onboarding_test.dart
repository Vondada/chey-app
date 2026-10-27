// Device half of "CHE, connect Hugging Face." with a fake WebView and a fake
// Worker: the token string appears only in the single /secret POST body,
// "Connected" only after the Worker verified, and pause/resume works.
import 'dart:convert';
import 'dart:io';

import 'package:chey/connect/che_service_onboarding.dart';
import 'package:flutter_test/flutter_test.dart';

const token = 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

class FakePage implements CheOnboardingPage {
  FakePage({this.pages = const ['token_form'], this.user = 'vondada', this.fillOk = true});
  List<String> pages;
  String user;
  bool fillOk;
  final List<String> loaded = [];
  final List<String> calls = [];
  int _detects = 0;

  @override
  Future<void> load(String url) async => loaded.add(url);

  @override
  Future<String> run(String js) async {
    final call = js.split('\n').last;
    calls.add(call);
    if (call.contains('detect()')) {
      final page = pages[_detects < pages.length ? _detects : pages.length - 1];
      _detects++;
      return jsonEncode({'page': page, 'step': page == 'owner_auth' ? 'sign_in' : page, 'user': page == 'token_form' ? user : ''});
    }
    if (call.contains('fill(')) return jsonEncode({'ok': fillOk, 'name_set': true, 'checked': ['Make calls to Inference Providers'], 'unticked': [], 'missing': fillOk ? [] : ['Make calls to Inference Providers']});
    if (call.contains('submit()')) return jsonEncode({'clicked': true});
    if (call.contains('readToken()')) return jsonEncode({'found': true, 'token': token});
    return '{}';
  }
}

const plan = {
  'kind': 'device_browser',
  'url': 'https://huggingface.co/settings/tokens/new?tokenType=fineGrained',
  'signin_url': 'https://huggingface.co/login',
  'token_name': 'CHE inference 2026-10-25',
  'permissions': ['Make calls to Inference Providers'],
};

/// A Worker stand-in that records every request body as sent on the wire.
class FakeServer implements CheOnboardingServer {
  FakeServer({this.verified = true, this.failSecret = 0, this.approval = false, this.heldFingerprint = ''});
  bool verified;
  int failSecret;
  bool approval;
  String heldFingerprint;
  final List<(String, String)> wire = [];

  Map<String, dynamic> _outcome() => {
        'state': verified ? 'verified' : 'failed',
        'outcomes': {'token_created': true, 'secret_configured': ['worker'], 'connection_verified': verified},
        'lines': ['Token created: yes, "CHE inference 2026-10-25", ending 6789.', 'Secret configured: CHE Worker runtime key store.', verified ? 'Connection verified: Hugging Face account vondada.' : 'Connection verified: no. the router refused the token.'],
        // A misbehaving server could still say "Connected"; the device must not repeat it unverified.
        'speech': 'Connected: Hugging Face account vondada, token fine-grained. I can use Inference Providers.',
      };

  @override
  Future<CheServerReply> post(String path, Map<String, Object?> body) async {
    wire.add((path, jsonEncode(body)));
    if (path.endsWith('/start')) {
      if (heldFingerprint.isNotEmpty && body['lost_fingerprint'] == null) return CheServerReply(200, {'action': 'post_held_token', 'fingerprint': heldFingerprint});
      return const CheServerReply(200, {'action': 'create_token', 'state': 'token_requested', 'plan': plan});
    }
    if (path.endsWith('/event')) {
      if (body['kind'] == 'account_seen' && approval) {
        return const CheServerReply(200, {'needs_approval': true, 'state': 'paused', 'speech': 'Hugging Face setup is paused: I\'m signed in to Hugging Face as vondada. Say "yes, use vondada on Hugging Face" to approve it.', 'pause': {'step': 'confirm_account'}});
      }
      if (body['kind'] == 'paused') return CheServerReply(200, {'state': 'paused', 'speech': 'Hugging Face setup is paused: ${body['detail']}.', 'pause': {'step': body['step']}});
      return const CheServerReply(200, {'state': 'token_created'});
    }
    if (path.endsWith('/secret')) {
      if (failSecret > 0) {
        failSecret--;
        throw const SocketException('offline');
      }
      return CheServerReply(200, _outcome());
    }
    return const CheServerReply(404, {});
  }
}

CheHuggingFaceOnboarding driver(FakeServer server, FakePage page, {List<String>? logs, List<String>? revoked, bool permitted = true}) => CheHuggingFaceOnboarding(
      server: server,
      page: page,
      driverJs: '/* driver */',
      isPermitted: (app) async => permitted && app == 'hugging face',
      revoke: (t) async {
        revoked?.add(t);
        return true;
      },
      wait: (_) async {},
      log: logs?.add,
    );

void main() {
  setUp(CheHeldTokens.clear);

  test('the token string appears only in the single /secret POST body; Connected only because the Worker verified', () async {
    final server = FakeServer();
    final page = FakePage();
    final logs = <String>[];
    final result = await driver(server, page, logs: logs).run();
    expect(result.status, CheOnboardingStatus.connected);
    expect(result.speech, startsWith('Connected: Hugging Face account vondada'));
    expect(result.lines, hasLength(3));
    final carrying = server.wire.where((w) => w.$2.contains(token)).toList();
    expect(carrying, hasLength(1));
    expect(carrying.single.$1, '/api/onboarding/huggingface/secret');
    final announced = server.wire.firstWhere((w) => w.$2.contains('token_created'));
    expect(announced.$2, contains(cheTokenFingerprint(token).fingerprint));
    expect(announced.$2, isNot(contains(token)));
    expect('${result.speech}${result.lines.join()}${logs.join()}', isNot(contains(token)));
    expect(CheHeldTokens.count, 0, reason: 'dropped once the Worker answered');
    expect(page.loaded, [plan['url']]);
  });

  test('fingerprints match the Worker: sha256 prefix and the last four', () {
    final fp = cheTokenFingerprint(token);
    expect(fp.fingerprint, matches(RegExp(r'^sha256:[0-9a-f]{12}$')));
    expect(fp.last4, '6789');
  });

  test('an unverified reply is never spoken as "Connected"', () async {
    final result = await driver(FakeServer(verified: false), FakePage()).run();
    expect(result.status, CheOnboardingStatus.failed);
    expect(result.speech, isNot(startsWith('Connected')));
    expect(result.lines.last, startsWith('Connection verified: no.'));
  });

  test('sign-in pauses with the exact step and fills nothing; "connect" again resumes and finishes', () async {
    final server = FakeServer();
    final page = FakePage(pages: ['owner_auth', 'token_form']);
    final paused = await driver(server, page).run();
    expect(paused.status, CheOnboardingStatus.paused);
    expect(paused.pauseStep, 'sign_in');
    expect(paused.speech, contains('Hugging Face needs you to sign in'));
    expect(page.calls.any((c) => c.contains('fill(') || c.contains('submit()')), isFalse);
    final event = server.wire.lastWhere((w) => w.$1.endsWith('/event'));
    expect(jsonDecode(event.$2), containsPair('reason', 'owner_auth'));
    final resumed = await driver(server, page).run();
    expect(resumed.status, CheOnboardingStatus.connected);
  });

  test('a captcha is the owner\'s: CHE pauses and never tries to solve it', () async {
    final page = FakePage(pages: ['captcha']);
    final result = await driver(FakeServer(), page).run();
    expect(result.status, CheOnboardingStatus.paused);
    expect(result.pauseStep, 'captcha');
    expect(page.calls, hasLength(1));
  });

  test('an unapproved account pauses for the owner\'s yes before any token is created', () async {
    final page = FakePage();
    final result = await driver(FakeServer(approval: true), page).run();
    expect(result.status, CheOnboardingStatus.needsAccountApproval);
    expect(result.speech, contains('Say "yes, use vondada on Hugging Face"'));
    expect(page.calls.any((c) => c.contains('submit()')), isFalse);
  });

  test('retry after a lost POST: the held token is posted again, no page is opened, no second token', () async {
    final fp = cheTokenFingerprint(token).fingerprint;
    CheHeldTokens.hold(fp, token);
    final server = FakeServer(heldFingerprint: fp);
    final page = FakePage();
    final result = await driver(server, page).run();
    expect(result.status, CheOnboardingStatus.connected);
    expect(page.loaded, isEmpty);
    expect(server.wire.where((w) => w.$2.contains(token)), hasLength(1));
  });

  test('a held token gone from the phone is reported lost before a new one is made', () async {
    final server = FakeServer(heldFingerprint: 'sha256:aaaaaaaaaaaa');
    final result = await driver(server, FakePage()).run();
    expect(result.status, CheOnboardingStatus.connected);
    final lost = server.wire.firstWhere((w) => w.$2.contains('lost_fingerprint'));
    expect(jsonDecode(lost.$2), containsPair('revoked', false));
  });

  test('if the token cannot reach CHE\'s server it is revoked at Hugging Face and nothing is claimed', () async {
    final revoked = <String>[];
    final server = FakeServer(failSecret: 3);
    final result = await driver(server, FakePage(), revoked: revoked).run();
    expect(result.status, CheOnboardingStatus.failed);
    expect(revoked, [token]);
    expect(result.speech, contains('so I revoked it at Hugging Face. Nothing is connected.'));
    expect(result.speech, isNot(contains(token)));
    expect(result.lines, ['Token created: yes.', 'Secret configured: no.', 'Connection verified: no.']);
    expect(CheHeldTokens.count, 0);
  });

  test('without the owner\'s permission for Hugging Face nothing is opened or sent', () async {
    final server = FakeServer();
    final page = FakePage();
    final result = await driver(server, page, permitted: false).run();
    expect(result.status, CheOnboardingStatus.failed);
    expect(page.loaded, isEmpty);
    expect(server.wire, isEmpty);
  });

  test('a changed token form pauses without creating anything', () async {
    final page = FakePage(fillOk: false);
    final result = await driver(FakeServer(), page).run();
    expect(result.status, CheOnboardingStatus.paused);
    expect(result.pauseStep, 'permissions');
    expect(page.calls.any((c) => c.contains('submit()')), isFalse);
  });

  // GPU providers (RunPod, Vast.ai, Modal, Kaggle) use the guided screen: the owner's key goes from the secure field
  // or the clipboard straight to the Worker; the reply decides what CHE says.
  test('guided GPU replies: Connected only when verified; a stored key without a free check is saved-not-verified', () {
    expect(cheGuidedStatus({'state': 'verified', 'outcomes': {'connection_verified': true, 'secret_configured': ['worker']}}), CheOnboardingStatus.connected);
    expect(cheGuidedStatus({'state': 'secret_configured', 'outcomes': {'connection_verified': false, 'secret_configured': ['worker']}}), CheOnboardingStatus.savedNotVerified);
    expect(cheGuidedStatus({'state': 'failed', 'outcomes': {'connection_verified': false, 'secret_configured': <String>[]}}), CheOnboardingStatus.failed);
    expect(cheGuidedStatus({'detail': 'That does not look like a Modal token.'}), CheOnboardingStatus.failed);
  });

  test('guided steps are read as a numbered list and provider names are spoken properly', () {
    expect(cheGuidedSteps({'plan': {'steps': ['Sign in at runpod.io.', 'Add prepaid credit yourself.']}}), ['1. Sign in at runpod.io.', '2. Add prepaid credit yourself.']);
    expect(cheGuidedSteps({'plan': null}), isEmpty);
    expect(cheOnboardingProviderName('runpod'), 'RunPod');
    expect(cheOnboardingProviderName('vast'), 'Vast.ai');
    expect(cheOnboardingProviderName('huggingface'), 'Hugging Face');
    expect(cheOnboardingProviderName('groq'), 'Groq');
  });
}
