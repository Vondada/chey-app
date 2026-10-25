// CHE service onboarding on the iPhone: "CHE, connect Hugging Face."
//
// The Worker (server/cloudflare/service_onboarding.js) owns the state machine.
// This file is the device half: it drives CHE's own WebView on the owner's
// signed-in Hugging Face session to create a minimum-permission token, reads
// the token ONCE from the page and posts it straight to
// /api/onboarding/huggingface/secret over TLS.
//
// The token never enters widget state, Navigator arguments, speech, chat,
// memory or logs. It lives only in [CheHeldTokens] (process memory, keyed by
// its fingerprint) until the Worker confirms it stored it, so a retry posts
// the same token instead of creating a second one. If it cannot be stored, the
// device revokes it with Hugging Face's documented revoke endpoint.
//
// Sign-in, two-factor codes, captchas and account sign-up are the owner's:
// CHE pauses with the exact step and resumes when he says "connect Hugging
// Face" again or presses Continue.

import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:webview_flutter/webview_flutter.dart';

import '../security/che_app_permissions.dart';
import '../security/che_redact.dart';

/// The page CHE drives: load a URL, run JavaScript and get its string result.
abstract class CheOnboardingPage {
  Future<void> load(String url);
  Future<String> run(String js);
}

/// One Worker reply.
class CheServerReply {
  const CheServerReply(this.status, this.body);
  final int status;
  final Map<String, dynamic> body;
}

/// CHE's Worker, as the onboarding driver uses it.
abstract class CheOnboardingServer {
  Future<CheServerReply> post(String path, Map<String, Object?> body);
}

/// The real Worker client: the paired device's base URL and auth headers.
class CheHttpOnboardingServer implements CheOnboardingServer {
  CheHttpOnboardingServer({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  @override
  Future<CheServerReply> post(String path, Map<String, Object?> body) async {
    final response = await _client
        .post(Uri.parse('$baseUrl$path'), headers: {...headers(), 'Content-Type': 'application/json'}, body: jsonEncode(body))
        .timeout(const Duration(seconds: 40));
    final decoded = jsonDecode(response.body);
    return CheServerReply(response.statusCode, decoded is Map ? Map<String, dynamic>.from(decoded) : const {});
  }
}

enum CheOnboardingStatus { connected, paused, needsAccountApproval, failed, guided }

/// What the owner hears and reads. Built only from the Worker's redacted replies.
class CheOnboardingResult {
  const CheOnboardingResult({required this.status, required this.speech, this.lines = const [], this.pauseStep = '', this.openUrl = '', this.guidedSteps = const []});
  final CheOnboardingStatus status;
  final String speech;
  final List<String> lines;
  final String pauseStep;
  final String openUrl;
  final List<String> guidedSteps;

  bool get connected => status == CheOnboardingStatus.connected;
}

/// Same fingerprint as the Worker: sha256 prefix (12 hex) and the last four characters.
({String fingerprint, String last4}) cheTokenFingerprint(String token) {
  final digest = sha256.convert(utf8.encode(token)).toString();
  return (fingerprint: 'sha256:${digest.substring(0, 12)}', last4: token.length >= 4 ? token.substring(token.length - 4) : token);
}

/// Tokens CHE created and has not yet seen stored, in memory only.
class CheHeldTokens {
  CheHeldTokens._();
  static final Map<String, String> _held = {};
  static void hold(String fingerprint, String token) => _held[fingerprint] = token;
  static String? peek(String fingerprint) => _held[fingerprint];
  static void drop(String fingerprint) => _held.remove(fingerprint);
  @visibleForTesting
  static void clear() => _held.clear();
  @visibleForTesting
  static int get count => _held.length;
}

/// Revokes a token by value at Hugging Face (POST /api/credentials/revoke, always 202).
typedef CheTokenRevoker = Future<bool> Function(String token);

Future<bool> cheRevokeHuggingFaceToken(String token) async {
  try {
    final r = await http
        .post(Uri.parse('https://huggingface.co/api/credentials/revoke'), headers: {'Content-Type': 'application/json'}, body: jsonEncode({'credentials': [token]}))
        .timeout(const Duration(seconds: 20));
    return r.statusCode == 202 || r.statusCode == 200;
  } catch (_) {
    return false;
  }
}

/// Hugging Face end to end on the device.
class CheHuggingFaceOnboarding {
  CheHuggingFaceOnboarding({
    required this.server,
    required this.page,
    required this.driverJs,
    required this.isPermitted,
    this.revoke = cheRevokeHuggingFaceToken,
    Future<void> Function(Duration)? wait,
    this.log,
  }) : _wait = wait ?? Future<void>.delayed;

  static const String provider = 'huggingface';
  static const String appName = 'hugging face';
  final CheOnboardingServer server;
  final CheOnboardingPage page;
  final String driverJs;
  final Future<bool> Function(String app) isPermitted;
  final CheTokenRevoker revoke;
  final Future<void> Function(Duration) _wait;
  final void Function(String line)? log;

  String get _base => '/api/onboarding/$provider';

  void _log(String line, [List<String> secrets = const []]) => log?.call(cheRedact(line, secrets: secrets));

  Future<Map<String, dynamic>> _step(String call) async {
    final raw = await page.run('$driverJs\n$call');
    final decoded = jsonDecode(raw);
    return decoded is Map ? Map<String, dynamic>.from(decoded) : const {};
  }

  CheOnboardingResult _fromReply(Map<String, dynamic> body, {CheOnboardingStatus? status}) {
    final outcomes = body['outcomes'];
    final verified = outcomes is Map && outcomes['connection_verified'] == true;
    final lines = (body['lines'] is List) ? (body['lines'] as List).map((e) => '$e').toList() : const <String>[];
    final state = '${body['state'] ?? ''}';
    final speech = '${body['speech'] ?? body['detail'] ?? 'Hugging Face setup did not finish.'}';
    return CheOnboardingResult(
      status: verified ? CheOnboardingStatus.connected : status ?? (state == 'paused' ? CheOnboardingStatus.paused : CheOnboardingStatus.failed),
      // "Connected" is only ever said when the Worker verified it.
      speech: verified ? speech : speech.replaceFirst(RegExp(r'^Connected:\s*'), 'Not verified yet: '),
      lines: lines,
      pauseStep: body['pause'] is Map ? '${(body['pause'] as Map)['step'] ?? ''}' : '',
    );
  }

  Future<CheOnboardingResult> _pause(String capability, String reason, String step, String detail, {String openUrl = ''}) async {
    final reply = await server.post('$_base/event', {'capability': capability, 'kind': 'paused', 'reason': reason, 'step': step, 'detail': detail});
    final r = _fromReply(reply.body, status: CheOnboardingStatus.paused);
    return CheOnboardingResult(status: CheOnboardingStatus.paused, speech: r.speech, lines: r.lines, pauseStep: step, openUrl: openUrl);
  }

  /// Runs (or resumes) onboarding. [startReply] is the Worker's chat reply when
  /// the owner's words started it; [approveAccount] is his spoken yes for an account.
  Future<CheOnboardingResult> run({String capability = 'inference', Map<String, dynamic>? startReply, String approveAccount = ''}) async {
    // Permission is enforced here, not only in the model or the Worker.
    if (!await isPermitted(appName) && !await isPermitted(provider)) {
      return const CheOnboardingResult(
        status: CheOnboardingStatus.failed,
        speech: 'I need your permission before I open Hugging Face. Say "connect Hugging Face" and I will start.',
      );
    }
    var start = startReply;
    if (start == null || approveAccount.isNotEmpty) {
      final reply = await server.post('$_base/start', {'capability': capability, if (approveAccount.isNotEmpty) 'account': approveAccount});
      if (reply.status == 423) return CheOnboardingResult(status: CheOnboardingStatus.failed, speech: '${reply.body['detail'] ?? 'Lockdown is on.'}');
      start = reply.body;
    }
    final action = '${start['action'] ?? 'none'}';
    if (action == 'none') return _fromReply(start);
    if (action == 'post_held_token') {
      final fp = '${start['fingerprint'] ?? ''}';
      final held = CheHeldTokens.peek(fp);
      if (held != null) return _store(capability, fp, held);
      // The token is gone from this phone: say so, and only then ask for a new one.
      _log('Hugging Face onboarding: outstanding token $fp is no longer on this phone; reporting it lost.');
      final again = await server.post('$_base/start', {'capability': capability, 'lost_fingerprint': fp, 'revoked': false});
      start = again.body;
      if ('${start['action']}' != 'create_token') return _fromReply(start);
    }
    final plan = start['plan'] is Map ? Map<String, dynamic>.from(start['plan'] as Map) : const <String, dynamic>{};
    final url = '${plan['url'] ?? ''}';
    if (!url.startsWith('https://huggingface.co/')) {
      return const CheOnboardingResult(status: CheOnboardingStatus.failed, speech: 'My server did not give a Hugging Face page to open, so I opened nothing.');
    }
    await page.load(url);
    await _wait(const Duration(milliseconds: 800));

    final seen = await _step('window.__cheHf.detect()');
    switch ('${seen['page']}') {
      case 'captcha':
        return _pause(capability, 'captcha', 'captcha', 'Hugging Face is showing a check only you can solve. Solve it on this screen, then say "connect Hugging Face"');
      case 'owner_auth':
        final twoFactor = seen['step'] == 'two_factor';
        return _pause(capability, 'owner_auth', '${seen['step']}', twoFactor
            ? 'Hugging Face needs your two-factor code. Enter it on this screen, then say "connect Hugging Face"'
            : 'Hugging Face needs you to sign in. Sign in on this screen, then say "connect Hugging Face". If you have no account, creating one is yours to do at huggingface.co/join',
            openUrl: '${plan['signin_url'] ?? ''}');
      case 'signup':
        return _pause(capability, 'owner_auth', 'sign_up', 'Creating a Hugging Face account is yours to do (their sign-up has checks only you may complete). When you are signed in, say "connect Hugging Face"',
            openUrl: '${plan['signup_url'] ?? ''}');
      case 'token_form':
        break;
      default:
        return _pause(capability, 'missing_info', 'unknown_page', 'The Hugging Face token page did not look as expected, so I created nothing');
    }

    // The signed-in account must be the owner's approved one.
    final account = await server.post('$_base/event', {'capability': capability, 'kind': 'account_seen', 'username': '${seen['user'] ?? ''}'});
    if (account.status == 409) return _fromReply(account.body);
    if (account.body['needs_approval'] == true) {
      final r = _fromReply(account.body, status: CheOnboardingStatus.needsAccountApproval);
      return CheOnboardingResult(status: CheOnboardingStatus.needsAccountApproval, speech: r.speech, lines: r.lines, pauseStep: 'confirm_account');
    }

    final name = '${plan['token_name'] ?? 'CHE token'}';
    final perms = (plan['permissions'] is List) ? (plan['permissions'] as List).map((e) => '$e').toList() : const <String>[];
    final filled = await _step('window.__cheHf.fill(${jsonEncode(name)}, ${jsonEncode(perms)})');
    if (filled['ok'] != true) {
      final missing = (filled['missing'] is List) ? (filled['missing'] as List).join(', ') : '';
      return _pause(capability, 'missing_info', 'permissions', 'The token form is missing ${missing.isEmpty ? 'the name field' : missing}, so I created nothing');
    }
    final pressed = await _step('window.__cheHf.submit()');
    if (pressed['clicked'] != true) return _pause(capability, 'missing_info', 'create_button', 'I could not press Create token, so nothing was created');

    String? token;
    for (var i = 0; i < 20 && token == null; i++) {
      await _wait(const Duration(milliseconds: 500));
      final read = await _step('window.__cheHf.readToken()');
      if (read['found'] == true) token = '${read['token']}';
    }
    if (token == null || !RegExp(r'^hf_[A-Za-z0-9]{30,64}$').hasMatch(token)) {
      return _pause(capability, 'missing_info', 'read_token', 'Hugging Face did not show a new token, so nothing was stored');
    }
    final fp = cheTokenFingerprint(token);
    CheHeldTokens.hold(fp.fingerprint, token);
    final announced = await server.post('$_base/event', {'capability': capability, 'kind': 'token_created', 'fingerprint': fp.fingerprint, 'last4': fp.last4, 'name': name});
    if (announced.status != 200) _log('Hugging Face onboarding: token_created was not recorded (HTTP ${announced.status}).', [token]);
    return _store(capability, fp.fingerprint, token);
  }

  /// The one POST that carries the token. Retried on network errors; revoked if it cannot be stored.
  Future<CheOnboardingResult> _store(String capability, String fingerprint, String token) async {
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        final reply = await server.post('$_base/secret', {'capability': capability, 'token': token});
        // Any answer from the Worker settles it: stored, refused or duplicate. Drop the token either way.
        CheHeldTokens.drop(fingerprint);
        return _fromReply(reply.body);
      } catch (_) {
        await _wait(Duration(seconds: 1 << attempt));
      }
    }
    final revoked = await revoke(token);
    CheHeldTokens.drop(fingerprint);
    try {
      await server.post('$_base/start', {'capability': capability, 'lost_fingerprint': fingerprint, 'revoked': revoked});
    } catch (_) {}
    _log('Hugging Face onboarding: could not reach CHE to store token $fingerprint; revoked: $revoked.', [token]);
    return CheOnboardingResult(
      status: CheOnboardingStatus.failed,
      speech: revoked
          ? 'Token created, but I could not reach my server to store it, so I revoked it at Hugging Face. Nothing is connected. Say "connect Hugging Face" to try again.'
          : 'Token created, but I could not reach my server to store it, and I could not revoke it. Delete the token named for CHE in your Hugging Face settings. Nothing is connected.',
      lines: const ['Token created: yes.', 'Secret configured: no.', 'Connection verified: no.'],
    );
  }
}

/// The WebView behind [CheServiceOnboardingScreen]. It shares the website data
/// store with CHE's browser, so the owner's Hugging Face sign-in is reused.
class CheWebViewOnboardingPage implements CheOnboardingPage {
  CheWebViewOnboardingPage(this.controller) {
    controller.setNavigationDelegate(NavigationDelegate(onPageFinished: (_) {
      if (!(_loaded?.isCompleted ?? true)) _loaded!.complete();
    }));
  }
  final WebViewController controller;
  Completer<void>? _loaded;

  @override
  Future<void> load(String url) async {
    _loaded = Completer<void>();
    await controller.loadRequest(Uri.parse(url));
    await _loaded!.future.timeout(const Duration(seconds: 30), onTimeout: () {});
  }

  @override
  Future<String> run(String js) async {
    final raw = await controller.runJavaScriptReturningResult(js);
    final text = '$raw';
    // iOS returns the string itself; Android returns it JSON-quoted.
    if (text.startsWith('"')) {
      try {
        return '${jsonDecode(text)}';
      } catch (_) {}
    }
    return text;
  }
}

/// The onboarding screen: the provider page (so the owner can sign in or solve a
/// check himself), the result in large text, and labelled controls. Every
/// action is also reachable by voice ("connect Hugging Face", "continue", "stop").
class CheServiceOnboardingScreen extends StatefulWidget {
  const CheServiceOnboardingScreen({super.key, required this.baseUrl, required this.headers, required this.provider, required this.capability, required this.startReply, required this.onSpeak});

  final String baseUrl;
  final Map<String, String> Function() headers;
  final String provider;
  final String capability;
  final Map<String, dynamic> startReply;
  final void Function(String text) onSpeak;

  static Route<void> route({required String baseUrl, required Map<String, String> Function() headers, required Map<String, dynamic> onboarding, required void Function(String) onSpeak}) {
    return MaterialPageRoute<void>(
      builder: (_) => CheServiceOnboardingScreen(
        baseUrl: baseUrl,
        headers: headers,
        provider: '${onboarding['provider'] ?? 'huggingface'}',
        capability: '${onboarding['capability'] ?? ''}',
        startReply: onboarding,
        onSpeak: onSpeak,
      ),
    );
  }

  @override
  State<CheServiceOnboardingScreen> createState() => _CheServiceOnboardingScreenState();
}

class _CheServiceOnboardingScreenState extends State<CheServiceOnboardingScreen> {
  late final WebViewController _controller = WebViewController()..setJavaScriptMode(JavaScriptMode.unrestricted);
  late final CheWebViewOnboardingPage _page = CheWebViewOnboardingPage(_controller);
  late final CheHttpOnboardingServer _server = CheHttpOnboardingServer(baseUrl: widget.baseUrl, headers: widget.headers);
  final TextEditingController _secure = TextEditingController();
  String _status = 'Starting.';
  List<String> _lines = const [];
  bool _busy = false;
  bool get _guided => widget.startReply['action'] == 'guided';

  @override
  void initState() {
    super.initState();
    final plan = widget.startReply['plan'];
    if (_guided && plan is Map) {
      _status = 'Create the key on the page, then paste it into the secure field. It goes straight to my server.';
      final url = '${plan['url'] ?? ''}';
      if (url.startsWith('https://')) unawaited(_controller.loadRequest(Uri.parse(url)));
    } else {
      unawaited(_run(widget.startReply));
    }
  }

  @override
  void dispose() {
    _secure.dispose();
    super.dispose();
  }

  void _report(CheOnboardingResult result) {
    if (!mounted) return;
    setState(() {
      _status = result.speech;
      _lines = result.lines;
      _busy = false;
    });
    // Status feedback: haptic pattern, visible banner (the status text) and the spoken result the owner asked for.
    result.connected ? HapticFeedback.mediumImpact() : HapticFeedback.heavyImpact();
    widget.onSpeak(result.speech);
  }

  Future<void> _run(Map<String, dynamic>? start) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _status = 'Working on it.';
    });
    final driverJs = await rootBundle.loadString('assets/browser/che_hf_token_page.js');
    final driver = CheHuggingFaceOnboarding(
      server: _server,
      page: _page,
      driverJs: driverJs,
      isPermitted: (app) async => (await CheAppPermissions.granted()).contains(app),
      log: debugPrint,
    );
    try {
      _report(await driver.run(capability: widget.capability.isEmpty ? 'inference' : widget.capability, startReply: start));
    } catch (_) {
      _report(const CheOnboardingResult(status: CheOnboardingStatus.failed, speech: 'Hugging Face setup stopped because of an error on this phone. Nothing was claimed as connected.'));
    }
  }

  Future<void> _saveGuided() async {
    final key = _secure.text.trim();
    _secure.clear();
    if (key.isEmpty) return;
    setState(() => _busy = true);
    try {
      final reply = await _server.post('/api/onboarding/${widget.provider}/secret', {'capability': widget.capability, 'token': key});
      final verified = reply.body['outcomes'] is Map && (reply.body['outcomes'] as Map)['connection_verified'] == true;
      final lines = reply.body['lines'] is List ? (reply.body['lines'] as List).map((e) => '$e').toList() : const <String>[];
      _report(CheOnboardingResult(status: verified ? CheOnboardingStatus.connected : CheOnboardingStatus.failed, speech: '${reply.body['speech'] ?? reply.body['detail'] ?? 'That key did not work.'}', lines: lines));
    } catch (_) {
      _report(const CheOnboardingResult(status: CheOnboardingStatus.failed, speech: 'I could not reach my server, so nothing was stored.'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final big = Theme.of(context).textTheme.titleLarge;
    return Scaffold(
      appBar: AppBar(title: Semantics(header: true, child: Text('Connect ${widget.provider == 'huggingface' ? 'Hugging Face' : widget.provider}'))),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Semantics(liveRegion: true, label: 'Status: $_status', excludeSemantics: true, child: Text(_status, style: big)),
                  for (final line in _lines)
                    Padding(padding: const EdgeInsets.only(top: 6), child: Text(line, style: Theme.of(context).textTheme.titleMedium)),
                  const SizedBox(height: 12),
                  if (_guided)
                    Row(children: [
                      Expanded(
                        child: Semantics(
                          label: 'Secure key field. The key goes straight to CHE\'s server, never into chat.',
                          textField: true,
                          child: TextField(controller: _secure, obscureText: true, autocorrect: false, enableSuggestions: false, decoration: const InputDecoration(labelText: 'Paste key')),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Semantics(button: true, label: 'Save and verify the key', child: FilledButton(onPressed: _busy ? null : _saveGuided, child: const Text('Save and verify'))),
                    ])
                  else
                    Wrap(spacing: 12, children: [
                      Semantics(button: true, label: 'Continue Hugging Face setup after signing in', child: FilledButton(onPressed: _busy ? null : () => _run(null), child: const Text('Continue'))),
                      Semantics(button: true, label: 'Stop setup and go back', child: OutlinedButton(onPressed: () => Navigator.of(context).maybePop(), child: const Text('Stop'))),
                      Semantics(button: true, label: 'Read the status aloud', child: OutlinedButton(onPressed: () => widget.onSpeak([_status, ..._lines].join(' ')), child: const Text('Read aloud'))),
                    ]),
                ],
              ),
            ),
            Expanded(child: Semantics(label: 'Provider page. CHE fills it; sign in or solve checks here yourself.', child: WebViewWidget(controller: _controller))),
          ],
        ),
      ),
    );
  }
}

