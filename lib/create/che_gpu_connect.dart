// Connect GPU (owner, 2026-10-25): CHE operates Colab's Connect for the owner through her existing browser session
// ('creation-gpu', che_browser.dart), then proves the connection from her own Worker. Four separate checks, each with
// its own state and reason:
//   1. the right Google account (the owner's CHE Office account, an on-device setting, never a password);
//   2. Colab has a connected GPU runtime;
//   3. CHE's Worker has a fresh heartbeat from a Colab GPU worker (< 90 s, gpu_queue.ONLINE_MS);
//   4. a real test job (one small face preview) completes and its picture opens in CHE.
// "GPU connected" is said only after check 3 passes. An open page or a pressed button proves nothing.
// CHE never types a password, never answers a CAPTCHA, 2-step verification, consent or warning dialog: she brings the
// owner to that exact step, says what Google needs, and resumes on "continue" or when the page moves on. She never
// clicks to keep Colab alive; Colab can end a runtime at any time and jobs resume from their checkpoints.
// Passive progress is quiet text; only required steps and the final results are spoken (AGENTS.md).
import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../browser/che_browser.dart';
import '../che_gpu_jobs.dart' show cheGpuWorkerOnline;
import '../security/che_app_permissions.dart';
import 'che_live_studio.dart' show cheColabNotebookUrl;

/// The browser session that holds the notebook (shared with CheGpuBrowser).
const cheGpuSessionKey = 'creation-gpu';

/// What the owner hears when the GPU is lost. Matches gpu_queue.js: a lease expires 3 minutes after the last
/// heartbeat, the job is paused with its checkpoints, and the next compatible worker resumes it.
const cheGpuDisconnectedText = 'GPU disconnected. Your jobs are kept and will resume from their last checkpoint on the '
    'next worker. A running job pauses within 3 minutes; GPU-only jobs wait until a GPU connects again.';

/// Whether [words] ask CHE to connect the GPU ("Connect GPU", "connect the GPU", "start my GPU", "/cloud-gpu connect").
bool cheGpuConnectCommand(String words) {
  final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '')
      .replaceFirst(RegExp(r'^(?:(?:hey|ok|okay)[\s,]+)?(?:che|chey|chay)[,:]?\s+'), '')
      .replaceFirst(RegExp(r'^(?:please|can you|could you)\s+'), '').replaceFirst(RegExp(r'\s+please$'), '').trim();
  return RegExp(r'^(?:connect|start|turn on|reconnect)\s+(?:(?:my|the|your)\s+)?(?:colab\s+)?gpu(?:\s+(?:runtime|worker|now))?$').hasMatch(t) ||
      t == '/cloud-gpu connect';
}

/// "continue", "done", "I'm signed in": the owner finished the step CHE handed him.
bool cheGpuContinueCommand(String words) => RegExp(r"^(?:continue|go on|resume|done|i'?m done|ok(?:ay)? done|i(?:'?ve| have|'?m| am)? signed in|signed in|ready|next)$")
    .hasMatch(words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), ''));

/// "my CHE Office Google account is name at gmail dot com" → the address, or null.
String? cheGpuAccountFromWords(String words) {
  final m = RegExp(r"^(?:(?:my|the)\s+(?:che office|office|gpu|colab)\s+(?:google\s+)?account\s+is|use|set\s+(?:my\s+)?(?:gpu|colab|che office)\s+(?:google\s+)?account\s+to)\s+(.+?)(?:\s+for\s+(?:the\s+)?(?:gpu|colab))?$")
      .firstMatch(words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), ''));
  if (m == null) return null;
  final email = m.group(1)!.replaceAll(RegExp(r'\s+at\s+'), '@').replaceAll(RegExp(r'\s+dot\s+'), '.').replaceAll(' ', '');
  return cheValidEmail(email) ? email : null;
}

bool cheValidEmail(String s) => RegExp(r'^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$', caseSensitive: false).hasMatch(s);

/// The notebook URL for [email]: Google's authuser parameter picks that signed-in account.
String cheGpuNotebookUrl(String email) =>
    email.isEmpty ? cheColabNotebookUrl : '$cheColabNotebookUrl?authuser=${Uri.encodeQueryComponent(email)}';

/// The Google account Colab opens with unless the owner sets another (owner, 2026-10-25: his CHE Office account).
const cheGpuDefaultAccount = 'chetheoffice@gmail.com';

/// What CHE says for the signed-in Colab account. A real address is spoken as written. A page initial or name that
/// CHE cannot match to an address is never spoken as the account; it is said as an unreadable account.
String cheGpuAccountLabel(String shown) => cheValidEmail(shown) ? shown : 'an account I cannot read';

/// The owner's preferred Google account for Colab (his CHE Office account). An address only, kept on this iPhone.
class CheGpuAccount {
  CheGpuAccount._();
  static const key = 'che_gpu_google_account';
  static Future<String> read() async {
    try {
      final saved = ((await SharedPreferences.getInstance()).getString(key) ?? '').trim().toLowerCase();
      return saved.isEmpty ? cheGpuDefaultAccount : saved;
    } catch (_) {
      return cheGpuDefaultAccount;
    }
  }

  static Future<bool> save(String email) async {
    final e = email.trim().toLowerCase();
    if (!cheValidEmail(e)) return false;
    await (await SharedPreferences.getInstance()).setString(key, e);
    return true;
  }
}

/// What CHE can see and do in the notebook page. The real one drives CHE's own browser session; tests fake it.
abstract class CheGpuConnectBrowser {
  Future<bool> open(String url);
  String? currentUrl();

  /// One reading of the page (cheGpuProbeJs), or null when no page can be read.
  Future<Map<String, dynamic>?> probe();

  /// 'connect' or 'runall'; returns what happened ('clicked', 'shortcut_sent', 'not_found').
  Future<String> act(String action);
  Future<void> bringToFront();
  Future<bool> openInSafari(String url);
}

/// CHE's Worker routes the flow uses (all existing): GET /api/gpu, the face preview queue and the media store.
abstract class CheGpuConnectWorker {
  Future<Map<String, dynamic>?> status();

  /// Queues the smallest real GPU job; returns its id, or null with [reason] filled.
  Future<({String? id, String reason})> queueTestJob();
  Future<Uint8List?> image(String mediaId);
}

/// Reads Colab's page without changing it. Colab's markup is not a public API: every field is best effort and the
/// flow treats a missing field as "unknown", never as success.
const cheGpuProbeJs = r'''(function(){
var t=function(e){try{return ((e&&(e.innerText||e.textContent))||'').trim();}catch(x){return '';}};
var body=t(document.body).slice(0,30000);var host=location.host;var o={url:location.href,host:host};
o.blocked=/browser or app may not be secure|disallowed_useragent|Couldn.t sign you in/i.test(body);
var a=document.querySelector('a[aria-label*="Google Account"],[aria-label^="Google Account"]');
var l=a?(a.getAttribute('aria-label')||''):'';var m=l.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
o.account=m?m[0].toLowerCase():'';
o.signInRequired=host==='accounts.google.com'||(!o.account&&Array.prototype.some.call(document.querySelectorAll('a,button,colab-toolbar-button'),function(e){return /^sign in$/i.test(t(e));}));
var ds=Array.prototype.filter.call(document.querySelectorAll('mwc-dialog[open],md-dialog[open],paper-dialog[opened],[role=dialog],[role=alertdialog]'),function(d){return d.offsetParent!==null||d.hasAttribute('open')||d.hasAttribute('opened');});
var dt=ds.map(t).join(' ').slice(0,600);o.dialog=dt;
o.dialogKind=/not authored by Google/i.test(dt)?'not_authored':/Google Drive/i.test(dt)?'drive':/GPU backend|usage limit|GPU.{0,40}not available/i.test(dt)?'gpu_unavailable':(dt?'other':'');
var cb=document.querySelector('colab-connect-button');var r=cb&&cb.shadowRoot?(cb.shadowRoot.querySelector('#connect')||cb.shadowRoot):cb;
var ct=t(r);o.connectText=ct.slice(0,80);o.connected=/RAM|Disk|Connected/i.test(ct);
var outs=Array.prototype.map.call(document.querySelectorAll('.output,.outputview,colab-static-output-renderer,.output_text'),t).join('\n');
var g=outs.match(/\b(?:Tesla|NVIDIA|GeForce|Quadro)\b[^\n,]*|\b(?:T4|L4|A100|V100|P100)\b[^\n,]*/);o.gpuLine=g?g[0].slice(0,80):'';
o.noGpu=/No GPU: Runtime/.test(outs);
return JSON.stringify(o);})()''';

const _cheGpuActJs = {
  'connect': r'''(function(){var cb=document.querySelector('colab-connect-button');var b=cb&&cb.shadowRoot?cb.shadowRoot.querySelector('#connect'):null;b=b||cb;if(!b)return 'not_found';b.click();return 'clicked';})()''',
  'runall': r'''(function(){var i=document.querySelector('[command="runall"]');if(i){i.click();return 'clicked';}
var n=window.colab&&colab.global&&colab.global.notebook;if(n&&typeof n.runAll==='function'){n.runAll();return 'clicked';}
if(!document.querySelector('colab-connect-button'))return 'not_found';
document.dispatchEvent(new KeyboardEvent('keydown',{key:'F9',code:'F9',keyCode:120,ctrlKey:true,bubbles:true}));return 'shortcut_sent';})()''',
};

/// The real browser: CHE's existing browser session 'creation-gpu', on screen or retained (che_browser.dart).
class CheGpuSessionBrowser implements CheGpuConnectBrowser {
  CheGpuSessionBrowser({required this.front});

  /// Shows the GPU Browser screen (pushes it when it is not on top). The app supplies it.
  final Future<void> Function() front;

  @override
  Future<bool> open(String url) => cheBrowserSessionLoad(cheGpuSessionKey, url);
  @override
  String? currentUrl() => cheBrowserSessionUrl(cheGpuSessionKey);
  @override
  Future<Map<String, dynamic>?> probe() async {
    final raw = await cheBrowserSessionEval(cheGpuSessionKey, cheGpuProbeJs);
    if (raw == null) return null;
    try {
      final d = jsonDecode(raw);
      return d is Map ? Map<String, dynamic>.from(d) : null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<String> act(String action) async => await cheBrowserSessionEval(cheGpuSessionKey, _cheGpuActJs[action] ?? "'not_found'") ?? 'not_found';
  @override
  Future<void> bringToFront() => front();
  @override
  Future<bool> openInSafari(String url) => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication).catchError((_) => false);
}

/// The real Worker: the same routes the Creation Room uses.
class CheGpuHttpWorker implements CheGpuConnectWorker {
  CheGpuHttpWorker({required this.baseUrl, required this.headers, http.Client? client}) : _http = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> headers;
  final http.Client _http;

  @override
  Future<Map<String, dynamic>?> status() async {
    try {
      final r = await _http.get(Uri.parse('$baseUrl/api/gpu'), headers: headers).timeout(const Duration(seconds: 12));
      final d = jsonDecode(r.body);
      return r.statusCode == 200 && d is Map ? Map<String, dynamic>.from(d) : null;
    } catch (_) {
      return null;
    }
  }

  /// One front view of CHE's own preset at 160 px and 16 samples: the smallest real GPU-only job (face previews never
  /// run on a CPU), queued first (priority high) through the existing preview route.
  @override
  Future<({String? id, String reason})> queueTestJob() async {
    try {
      final r = await _http.post(Uri.parse('$baseUrl/api/gpu/identities/preview'),
          headers: {...headers, 'Content-Type': 'application/json'},
          body: jsonEncode({'preset_id': 'che', 'styles': ['stylized'], 'views': [0], 'samples': 16, 'res': 160, 'priority': 'high'}))
          .timeout(const Duration(seconds: 15));
      final d = jsonDecode(r.body);
      final jobs = d is Map && d['jobs'] is List ? d['jobs'] as List : const [];
      final id = jobs.isNotEmpty && jobs.first is Map && (jobs.first as Map)['job'] is Map ? '${((jobs.first as Map)['job'] as Map)['id'] ?? ''}' : '';
      if (r.statusCode < 300 && id.isNotEmpty) return (id: id, reason: '');
      return (id: null, reason: d is Map ? '${d['detail'] ?? 'status ${r.statusCode}'}' : 'status ${r.statusCode}');
    } catch (_) {
      return (id: null, reason: 'CHE could not be reached');
    }
  }

  @override
  Future<Uint8List?> image(String mediaId) async {
    try {
      final r = await _http.get(Uri.parse('$baseUrl/api/media/$mediaId/image'), headers: headers).timeout(const Duration(seconds: 20));
      return r.statusCode == 200 && r.bodyBytes.isNotEmpty ? r.bodyBytes : null;
    } catch (_) {
      return null;
    }
  }
}

enum CheGpuCheckState { pending, running, passed, failed, unverified }

class CheGpuCheck {
  CheGpuCheck(this.id, this.title);
  final String id;
  final String title;
  CheGpuCheckState state = CheGpuCheckState.pending;
  String detail = 'Not checked yet.';
  String get stateWord => switch (state) {
        CheGpuCheckState.pending => 'pending',
        CheGpuCheckState.running => 'checking',
        CheGpuCheckState.passed => 'passed',
        CheGpuCheckState.failed => 'failed',
        CheGpuCheckState.unverified => 'not verified',
      };
  String get line => '$title: $stateWord. $detail';
}

enum CheGpuPhase { idle, opening, waitingForOwner, connecting, waitingForWorker, connected, testing, done, failed, disconnected }

/// The Connect GPU flow. One instance for the app ([instance]), so it keeps running while the owner navigates.
class CheGpuConnect extends ChangeNotifier {
  CheGpuConnect({
    this.poll = const Duration(seconds: 5),
    this.pageTries = 24,
    this.runTries = 36,
    this.heartbeatTries = 240,
    this.ownerTries = 180,
    this.jobTries = 300,
    this.monitorEvery = const Duration(seconds: 20),
    Future<void> Function(Duration)? wait,
    this.decode = cheDecodeImage,
    this.grant = CheAppPermissions.grant,
    this.readAccount = CheGpuAccount.read,
  }) : _wait = wait ?? ((d) => Future<void>.delayed(d));

  static CheGpuConnect instance = CheGpuConnect();

  final Duration poll;
  final int pageTries, runTries, heartbeatTries, ownerTries, jobTries;
  final Duration monitorEvery;
  final Future<void> Function(Duration) _wait;
  final Future<String?> Function(Uint8List bytes) decode;
  final Future<Set<String>> Function(String app) grant;
  final Future<String> Function() readAccount;

  CheGpuConnectBrowser? browser;
  CheGpuConnectWorker? worker;

  /// Speaks a required step or a final result. The app wires it to speakText; nothing passive goes through it.
  void Function(String text)? speak;

  final account = CheGpuCheck('account', 'Google account');
  final runtime = CheGpuCheck('runtime', 'Colab GPU runtime');
  final heartbeat = CheGpuCheck('heartbeat', 'CHE worker heartbeat');
  final testJob = CheGpuCheck('test', 'Test job completed and opened');
  List<CheGpuCheck> get checks => [account, runtime, heartbeat, testJob];

  CheGpuPhase phase = CheGpuPhase.idle;
  String status = 'Say Connect GPU, or use the Connect GPU button.';
  String ownerStep = '';
  String mode = 'in_app';
  String email = '';
  String gpuName = '';
  Uint8List? testImage;
  final List<String> permissionLog = [];
  Future<void>? running;
  bool _continued = false;
  bool _cancelled = false;
  Timer? _monitor;

  bool get busy => running != null;
  bool get waitingForOwner => phase == CheGpuPhase.waitingForOwner;

  /// True only while CHE's Worker holds a verified, fresh GPU heartbeat for this flow.
  bool get connected => heartbeat.state == CheGpuCheckState.passed &&
      const [CheGpuPhase.connected, CheGpuPhase.testing, CheGpuPhase.done].contains(phase);

  void configure({CheGpuConnectBrowser? browser, CheGpuConnectWorker? worker, void Function(String)? speak}) {
    if (browser != null) this.browser = browser;
    if (worker != null) this.worker = worker;
    if (speak != null) this.speak = speak;
  }

  /// The four checks as one answer, for Read aloud.
  String summary() => [status, if (ownerStep.isNotEmpty && waitingForOwner) ownerStep, for (final c in checks) c.line].join(' ');

  /// Starts the flow. [ownerWords] must be the owner's own Connect GPU command (spoken, typed or the button's label):
  /// it is his explicit permission to open Colab, recorded before anything opens. Returns what CHE says now.
  String start(String ownerWords) {
    if (!cheGpuConnectCommand(ownerWords)) {
      return 'I open Colab only when you ask me to connect the GPU. Say Connect GPU.';
    }
    if (busy) return 'I am already connecting your GPU. ${status.isEmpty ? '' : status}';
    _cancelled = false;
    _continued = false;
    running = _run(ownerWords).whenComplete(() => running = null);
    return 'Connecting your GPU. I will tell you when CHE\'s worker confirms it.';
  }

  /// The owner finished the step CHE handed him.
  String ownerContinue() {
    if (!waitingForOwner) return 'There is no step waiting for you right now.';
    _continued = true;
    return 'Thanks. Checking again.';
  }

  String cancel() {
    if (!busy && phase != CheGpuPhase.connected && phase != CheGpuPhase.done) return 'Nothing is connecting right now.';
    _cancelled = true;
    _monitor?.cancel();
    _set(CheGpuPhase.idle, 'Stopped. Colab was left as it is; nothing was closed or deleted.');
    return status;
  }

  void _set(CheGpuPhase p, String text) {
    phase = p;
    status = text;
    notifyListeners();
  }

  void _check(CheGpuCheck c, CheGpuCheckState s, String detail) {
    c.state = s;
    c.detail = detail;
    notifyListeners();
  }

  void _say(String text) {
    HapticFeedback.mediumImpact();
    speak?.call(text);
  }

  Future<void> _run(String ownerWords) async {
    for (final c in checks) {
      c.state = CheGpuCheckState.pending;
      c.detail = 'Not checked yet.';
    }
    testImage = null;
    gpuName = '';
    ownerStep = '';
    mode = 'in_app';
    _monitor?.cancel();
    final b = browser, w = worker;
    if (b == null || w == null) {
      _set(CheGpuPhase.failed, 'Connect GPU is not ready in this screen. Open the GPU Browser and try again.');
      _say(status);
      return;
    }
    // AGENTS.md: open or act in an app only with the owner's explicit permission, enforced here, in code.
    await grant('colab');
    permissionLog.add('${DateTime.now().toIso8601String()} colab: owner said "${ownerWords.trim()}"');
    email = await readAccount();
    _set(CheGpuPhase.opening, 'Opening your notebook${email.isEmpty ? '' : ' as $email'}.');

    var fresh = _freshGpu(await w.status());
    if (fresh != null) _heartbeatPassed(fresh, already: true);

    // 1. The notebook in CHE's browser with the preferred account.
    final url = cheGpuNotebookUrl(email);
    await b.bringToFront();
    final here = b.currentUrl() ?? '';
    final onNotebook = here.contains('CHE_GPU_Face_Preview.ipynb') && (email.isEmpty || here.contains(Uri.encodeQueryComponent(email)));
    if (!(fresh != null && onNotebook)) {
      var opened = false;
      // The GPU Browser may still be appearing: its session exists once the screen is built.
      for (var i = 0; i < 5 && !opened && !_cancelled; i++) {
        opened = await b.open(url);
        if (!opened) await _wait(const Duration(milliseconds: 400));
      }
      if (!opened) {
        await _safari(url, 'CHE\'s browser could not open the notebook');
        return;
      }
    }
    if (_cancelled) return;
    final page = await _accountStep(b, url);
    if (_cancelled) return;
    if (page == null) {
      // Google refused sign-in inside CHE's browser (or no page could be read): the honest fallback.
      await _safari(url, 'Google does not allow signing in inside CHE\'s browser');
      return;
    }

    // 2. Connect and Run all, unless a GPU worker is already checking in.
    if (fresh == null) {
      final ok = await _runNotebook(b, w);
      if (_cancelled || !ok) return;
    } else {
      final g = '${page['gpuLine'] ?? ''}';
      _check(runtime, CheGpuCheckState.passed, g.isNotEmpty ? 'Colab shows $g.' : 'The worker in your Colab runtime reports ${fresh['gpu']}.');
    }

    // 3. The Worker's own heartbeat.
    fresh ??= await _awaitHeartbeat(w);
    if (_cancelled || fresh == null) return;
    await _afterConnected(w, fresh);
  }

  Map? _freshGpu(Map<String, dynamic>? s) {
    final list = s?['workers'] is List ? (s!['workers'] as List).whereType<Map>().where(cheGpuWorkerOnline).toList() : const <Map>[];
    return list.isEmpty ? null : list.first;
  }

  void _heartbeatPassed(Map w, {bool already = false}) {
    gpuName = '${w['gpu'] ?? 'GPU'}';
    _check(heartbeat, CheGpuCheckState.passed,
        '${already ? 'Already online: ' : ''}fresh heartbeat from $gpuName (worker ${w['id'] ?? 'unknown'}, last seen ${w['last_seen'] ?? 'just now'}, under 90 seconds).');
  }

  /// Reads the signed-in account; hands the owner sign-in, account choice or Google's blocks. Null means fall back.
  Future<Map<String, dynamic>?> _accountStep(CheGpuConnectBrowser b, String url) async {
    _check(account, CheGpuCheckState.running, 'Reading the account Colab shows.');
    var switched = false;
    for (var i = 0; i < pageTries && !_cancelled; i++) {
      final p = await b.probe();
      if (p == null) return null;
      if (p['blocked'] == true) {
        _check(account, CheGpuCheckState.unverified, 'Google refused to sign in inside CHE\'s browser ("This browser or app may not be secure").');
        return null;
      }
      final shown = '${p['account'] ?? ''}';
      if (p['signInRequired'] == true) {
        final ok = await _askOwner(b, 'Google needs you to sign in here${email.isEmpty ? '' : ' with $email'}. CHE never types your password. Say continue when you are done.',
            cleared: (q) => q['signInRequired'] != true || q['blocked'] == true);
        if (!ok) return _fail(account, 'You were not signed in to Google in time.');
        continue;
      }
      if (shown.isEmpty) {
        await _wait(poll);
        continue;
      }
      if (email.isEmpty) {
        _check(account, CheGpuCheckState.unverified,
            'Colab is signed in, but no CHE Office Google account is set, so I cannot check which account it is. Say "my CHE Office Google account is" and the address.');
        return p;
      }
      if (shown == email) {
        _check(account, CheGpuCheckState.passed, 'Colab is signed in as $email.');
        return p;
      }
      if (!switched) {
        // Google's account chooser for the preferred address, then back to the notebook. The owner picks or signs in.
        switched = true;
        await b.open('https://accounts.google.com/AccountChooser?Email=${Uri.encodeQueryComponent(email)}&continue=${Uri.encodeQueryComponent(url)}');
        final ok = await _askOwner(b, 'Colab is signed in as ${cheGpuAccountLabel(shown)}, not your CHE Office account $email. Google\'s account chooser is open: choose $email, or sign in to it. Say continue when you are done.',
            cleared: (q) => '${q['account'] ?? ''}' == email || q['blocked'] == true);
        if (!ok) return _fail(account, 'Colab stayed on $shown instead of $email.');
        continue;
      }
      _check(account, CheGpuCheckState.failed, 'Colab is signed in as ${cheGpuAccountLabel(shown)}, not $email.');
      _set(CheGpuPhase.failed, 'Colab is still signed in as ${cheGpuAccountLabel(shown)}, not your CHE Office account $email. I stopped before connecting.');
      _say(status);
      _cancelled = true;
      return p;
    }
    if (!_cancelled) return _fail(account, 'The notebook page did not show a Google account.');
    return null;
  }

  Map<String, dynamic>? _fail(CheGpuCheck c, String why) {
    _check(c, CheGpuCheckState.failed, why);
    if (!_cancelled) {
      _set(CheGpuPhase.failed, '$why GPU not connected.');
      _say(status);
    }
    _cancelled = true;
    return null;
  }

  /// Connect + Run all, the dialogs only the owner may answer, and the notebook's own GPU line.
  Future<bool> _runNotebook(CheGpuConnectBrowser b, CheGpuConnectWorker w) async {
    _set(CheGpuPhase.connecting, 'Starting the notebook: Run all.');
    _check(runtime, CheGpuCheckState.running, 'Asking Colab for its GPU runtime.');
    var pressed = await b.act('runall');
    if (pressed == 'not_found') pressed = await b.act('connect');
    var askedRunAll = false;
    for (var i = 0; i < runTries && !_cancelled; i++) {
      await _wait(poll);
      final p = await b.probe() ?? const <String, dynamic>{};
      final kind = '${p['dialogKind'] ?? ''}';
      if (kind == 'gpu_unavailable') {
        _fail(runtime, 'Colab says no GPU is available for your account right now: ${p['dialog']}'.trim());
        return false;
      }
      if (kind == 'not_authored') {
        await _askOwner(b, 'Colab warns that this notebook was not authored by Google. It is CHE\'s notebook from your own repository. If you agree, choose Run anyway, then say continue.',
            cleared: (q) => q['dialogKind'] != 'not_authored');
        continue;
      }
      if (kind == 'drive') {
        await _askOwner(b, 'Colab asks to connect Google Drive. Choose Connect and pick ${email.isEmpty ? 'your account' : email}, then say continue. '
            'If Google\'s window cannot open here, the notebook carries on without Drive after two minutes.',
            cleared: (q) => q['dialogKind'] != 'drive');
        continue;
      }
      if (p['noGpu'] == true) {
        final ok = await _askOwner(b, 'Colab gave a runtime without a GPU. Choose Runtime, Change runtime type, T4 GPU, Save, then say continue.',
            cleared: (_) => false);
        if (!ok) {
          _fail(runtime, 'The runtime has no GPU.');
          return false;
        }
        await b.act('runall');
        continue;
      }
      final g = '${p['gpuLine'] ?? ''}';
      if (g.isNotEmpty && runtime.state != CheGpuCheckState.passed) _check(runtime, CheGpuCheckState.passed, 'Colab shows $g.');
      final fresh = _freshGpu(await w.status());
      if (fresh != null) {
        if (runtime.state != CheGpuCheckState.passed) _check(runtime, CheGpuCheckState.passed, 'The worker in your Colab runtime reports ${fresh['gpu']}.');
        return true;
      }
      // No sign that Run all happened (no connect meter, no output): hand the owner the menu once.
      if (!askedRunAll && i >= 3 && p['connected'] != true && g.isEmpty) {
        askedRunAll = true;
        final ok = await _askOwner(b, pressed == 'not_found'
            ? 'I could not find Colab\'s Run all here. Choose Runtime, then Run all, then say continue.'
            : 'I pressed Run all, but Colab has not started. Choose Runtime, then Run all, then say continue.',
            cleared: (q) => q['connected'] == true || '${q['gpuLine'] ?? ''}'.isNotEmpty);
        if (!ok) {
          _fail(runtime, 'Run all did not start.');
          return false;
        }
      }
      if (p['connected'] == true || g.isNotEmpty) return true;   // started; the heartbeat wait takes over
    }
    if (_cancelled) return false;
    return true;   // the notebook may still be installing; the heartbeat decides
  }

  Future<Map?> _awaitHeartbeat(CheGpuConnectWorker w) async {
    _set(CheGpuPhase.waitingForWorker, 'Waiting for the notebook\'s worker to check in with CHE. The first run installs Blender and can take several minutes.');
    _check(heartbeat, CheGpuCheckState.running, 'Waiting for a heartbeat under 90 seconds old from a Colab GPU worker.');
    Map<String, dynamic>? last;
    for (var i = 0; i < heartbeatTries && !_cancelled; i++) {
      last = await w.status();
      final fresh = _freshGpu(last);
      if (fresh != null) {
        _heartbeatPassed(fresh);
        if (runtime.state != CheGpuCheckState.passed) _check(runtime, CheGpuCheckState.passed, 'The worker in your Colab runtime reports ${fresh['gpu']}.');
        return fresh;
      }
      await _wait(poll);
    }
    if (_cancelled) return null;
    final paired = last?['worker_paired'] != false;
    _check(heartbeat, CheGpuCheckState.failed, 'No fresh heartbeat from a Colab GPU worker. ${paired ? 'Look at the notebook\'s last cell for an error; Colab may also have ended the runtime.' : 'CHE has no Colab pairing: use Pair Colab and save the token in Colab Secrets as CHE_GPU_TOKEN.'}');
    if (runtime.state == CheGpuCheckState.running) _check(runtime, CheGpuCheckState.unverified, 'No GPU line or worker report reached CHE.');
    _set(CheGpuPhase.failed, 'GPU not connected: CHE\'s worker never received a heartbeat from your Colab GPU. Nothing was lost; jobs keep waiting.');
    _say(status);
    return null;
  }

  Future<void> _afterConnected(CheGpuConnectWorker w, Map fresh) async {
    _set(CheGpuPhase.connected, 'GPU connected: $gpuName, verified by CHE\'s worker heartbeat.');
    _say('GPU connected: $gpuName. CHE\'s worker has a fresh heartbeat from it. Colab can end the runtime at any time; '
        'jobs then resume from their checkpoints. Now running a small test job.');
    _startMonitor();
    // 4. One real job end to end.
    _set(CheGpuPhase.testing, 'GPU connected: $gpuName. Running a small test job.');
    _check(testJob, CheGpuCheckState.running, 'Queuing one front view at 160 pixels.');
    final q = await w.queueTestJob();
    if (q.id == null) return _testFailed('The test job could not be queued: ${q.reason}.');
    for (var i = 0; i < jobTries && !_cancelled; i++) {
      final s = await w.status();
      final jobs = s?['jobs'] is List ? (s!['jobs'] as List).whereType<Map>() : const <Map>[];
      final job = jobs.where((j) => j['id'] == q.id).firstOrNull;
      final state = '${job?['state'] ?? ''}';
      if (state == 'failed' || state == 'cancelled') {
        final h = job?['history'] is List && (job!['history'] as List).isNotEmpty ? '${((job['history'] as List).last as Map)['note'] ?? ''}' : '';
        return _testFailed('Test job ${q.id} $state. $h'.trim());
      }
      if (state == 'completed') {
        final previews = job?['previews'] is Map ? job!['previews'] as Map : const {};
        final media = '${previews['0'] ?? previews.values.firstOrNull ?? ''}';
        if (media.isEmpty) return _testFailed('Test job ${q.id} completed without a picture.');
        final bytes = await w.image(media);
        if (bytes == null) return _testFailed('Test job ${q.id} completed, but its picture did not download.');
        final size = await decode(bytes);
        if (size == null) return _testFailed('Test job ${q.id} completed, but its picture could not be opened.');
        testImage = bytes;
        final on = '${job?['worker_name'] ?? job?['device_line'] ?? gpuName}';
        _check(testJob, CheGpuCheckState.passed, 'Job ${q.id} completed on $on; its $size picture opened in CHE.');
        _set(CheGpuPhase.done, 'GPU connected: $gpuName. Test job completed and opened.');
        _say('Test job completed and opened: its picture is on screen.');
        return;
      }
      if (job != null) testJob.detail = 'Job ${q.id}: ${job['display'] ?? state}.';
      notifyListeners();
      await _wait(poll);
    }
    if (!_cancelled) _testFailed('Test job ${q.id} did not finish in time. It stays queued and resumes on the next GPU worker.');
  }

  void _testFailed(String why) {
    _check(testJob, CheGpuCheckState.failed, why);
    // The GPU check stands on its own: the connection is still verified, only the test failed.
    status = 'GPU connected: $gpuName. The test job did not complete: $why';
    if (phase == CheGpuPhase.testing) phase = CheGpuPhase.connected;
    notifyListeners();
    _say('The test job failed: $why');
  }

  /// Watches CHE's own status route while connected. Reads only; it never touches Colab to keep it alive.
  void _startMonitor() {
    _monitor?.cancel();
    _monitor = Timer.periodic(monitorEvery, (_) => unawaited(checkStillConnected()));
  }

  /// One status read: a stale heartbeat turns the state into Disconnected (quiet banner and haptic, no speech).
  Future<void> checkStillConnected() async {
    final w = worker;
    if (w == null || !const [CheGpuPhase.connected, CheGpuPhase.testing, CheGpuPhase.done].contains(phase)) return;
    final s = await w.status();
    if (s == null) return;   // CHE unreachable is not evidence the GPU left
    if (_freshGpu(s) != null) return;
    _monitor?.cancel();
    _check(heartbeat, CheGpuCheckState.failed, 'The heartbeat is older than 90 seconds: the Colab worker stopped.');
    HapticFeedback.heavyImpact();
    _set(CheGpuPhase.disconnected, cheGpuDisconnectedText);
  }

  /// Hands the owner the exact screen and waits for "continue", the page moving on, or a fresh GPU heartbeat.
  Future<bool> _askOwner(CheGpuConnectBrowser b, String instruction, {required bool Function(Map<String, dynamic>) cleared}) async {
    final before = phase;
    final beforeStatus = status;
    ownerStep = instruction;
    _continued = false;
    _set(CheGpuPhase.waitingForOwner, instruction);
    if (mode == 'in_app') await b.bringToFront();
    _say(instruction);
    var ok = false;
    for (var i = 0; i < ownerTries && !_cancelled; i++) {
      await _wait(poll);
      if (_continued) {
        ok = true;
        break;
      }
      if (mode == 'in_app') {
        final p = await b.probe();
        if (p != null && cleared(p)) {
          ok = true;
          break;
        }
      } else if (_freshGpu(await worker?.status()) != null) {
        ok = true;
        break;
      }
    }
    ownerStep = '';
    if (!_cancelled) _set(before == CheGpuPhase.waitingForOwner ? CheGpuPhase.connecting : before, ok ? 'Resuming.' : beforeStatus);
    return ok;
  }

  /// Google will not sign in inside CHE's browser: Safari, where the owner's Google sign-in already works. CHE
  /// cannot read or press anything in Safari, so the account check is not verified; the worker proves the rest.
  Future<void> _safari(String url, String why) async {
    mode = 'safari';
    _check(account, CheGpuCheckState.unverified, '$why, so the notebook opened in Safari. Apps cannot read Safari pages; check the account picture in Colab yourself.');
    final opened = await browser!.openInSafari(url);
    if (!opened) {
      _fail(runtime, 'Safari did not open the notebook.');
      return;
    }
    _check(runtime, CheGpuCheckState.running, 'Waiting for the worker in your Colab runtime to report its GPU.');
    final ok = await _askOwner(browser!, '$why, so I opened your notebook in Safari. Sign in${email.isEmpty ? '' : ' with $email'} if Google asks, '
        'choose Runtime, then Run all, and Run anyway if Colab warns you. Then come back to CHE and say continue. I verify the GPU from CHE\'s worker.',
        cleared: (_) => false);
    if (_cancelled) return;
    if (!ok) {
      _fail(heartbeat, 'No GPU worker checked in while I waited.');
      return;
    }
    final fresh = await _awaitHeartbeat(worker!);
    if (_cancelled || fresh == null) return;
    await _afterConnected(worker!, fresh);
  }

  @override
  void dispose() {
    _monitor?.cancel();
    super.dispose();
  }
}

/// Decodes [bytes] as an image, as Flutter will show it; "W by H pixels", or null when it is not a picture.
Future<String?> cheDecodeImage(Uint8List bytes) async {
  try {
    final codec = await ui.instantiateImageCodec(bytes);
    final frame = await codec.getNextFrame();
    final s = '${frame.image.width} by ${frame.image.height} pixels';
    frame.image.dispose();
    codec.dispose();
    return s;
  } catch (_) {
    return null;
  }
}

/// The four checks, the step waiting for the owner, and the controls. Quiet: it never speaks by itself.
class CheGpuConnectPanel extends StatefulWidget {
  const CheGpuConnectPanel({super.key, required this.controller, this.onRead});
  final CheGpuConnect controller;
  final void Function(String text)? onRead;
  @override
  State<CheGpuConnectPanel> createState() => _CheGpuConnectPanelState();
}

class _CheGpuConnectPanelState extends State<CheGpuConnectPanel> {
  final _email = TextEditingController();
  String _saved = '';

  @override
  void initState() {
    super.initState();
    unawaited(CheGpuAccount.read().then((e) {
      if (!mounted) return;
      setState(() {
        _saved = e;
        _email.text = e;
      });
    }));
  }

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _saveEmail() async {
    final ok = await CheGpuAccount.save(_email.text);
    HapticFeedback.selectionClick();
    if (!mounted) return;
    setState(() => _saved = ok ? _email.text.trim().toLowerCase() : _saved);
    widget.onRead?.call(ok ? 'Saved. CHE uses ${_email.text.trim()} for Colab.' : 'That is not a full email address.');
  }

  static const _icons = {
    CheGpuCheckState.pending: (Icons.radio_button_unchecked, Colors.white54),
    CheGpuCheckState.running: (Icons.hourglass_top, Colors.amberAccent),
    CheGpuCheckState.passed: (Icons.check_circle_rounded, Colors.greenAccent),
    CheGpuCheckState.failed: (Icons.cancel, Colors.redAccent),
    CheGpuCheckState.unverified: (Icons.help_outline_rounded, Colors.orangeAccent),
  };

  Widget _button(String label, String semantics, VoidCallback? onTap, {Key? key}) => Semantics(
        button: true, label: semantics, excludeSemantics: true,
        child: OutlinedButton(key: key, onPressed: onTap, child: Text(label)),
      );

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: widget.controller,
        builder: (context, _) {
          final c = widget.controller;
          final banner = switch (c.phase) {
            CheGpuPhase.disconnected || CheGpuPhase.failed => Colors.redAccent.withValues(alpha: 0.18),
            CheGpuPhase.connected || CheGpuPhase.done => Colors.green.withValues(alpha: 0.18),
            CheGpuPhase.waitingForOwner => Colors.amber.withValues(alpha: 0.22),
            _ => Colors.white10,
          };
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Container(
              key: const ValueKey('gpu-connect-banner'),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: banner, borderRadius: BorderRadius.circular(12)),
              child: Semantics(label: 'Connect GPU status: ${c.status}', excludeSemantics: true,
                  child: Text(c.status, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600))),
            ),
            if (c.waitingForOwner && c.ownerStep.isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 6), child: Semantics(
                label: 'Your step: ${c.ownerStep}', excludeSemantics: true,
                child: Text(c.ownerStep, key: const ValueKey('gpu-connect-owner-step'), style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
              )),
            const SizedBox(height: 6),
            for (final check in c.checks)
              Semantics(
                key: ValueKey('gpu-check-${check.id}'),
                label: check.line, excludeSemantics: true,
                child: Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Icon(_icons[check.state]!.$1, color: _icons[check.state]!.$2, size: 20),
                  const SizedBox(width: 8),
                  Expanded(child: Text('${check.title}: ${check.stateWord}. ${check.detail}', style: const TextStyle(fontSize: 15))),
                ])),
              ),
            if (c.testImage != null)
              Padding(padding: const EdgeInsets.only(top: 6), child: Semantics(
                image: true, label: 'Test job picture from your GPU, front view',
                child: ClipRRect(borderRadius: BorderRadius.circular(10),
                    child: Image.memory(c.testImage!, key: const ValueKey('gpu-test-image'), height: 120, fit: BoxFit.contain,
                        errorBuilder: (_, _, _) => const Text('The picture could not be shown.'))),
              )),
            const SizedBox(height: 6),
            Wrap(spacing: 8, runSpacing: 4, children: [
              _button('Connect GPU', 'Connect GPU: CHE opens your notebook and verifies the GPU', c.busy ? null : () {
                HapticFeedback.mediumImpact();
                widget.onRead?.call(c.start('Connect GPU'));
              }, key: const ValueKey('gpu-connect-start')),
              if (c.waitingForOwner)
                _button('Continue', 'Continue: I finished the step', () => widget.onRead?.call(c.ownerContinue()), key: const ValueKey('gpu-connect-continue')),
              if (c.busy) _button('Stop', 'Stop connecting the GPU', () => widget.onRead?.call(c.cancel())),
              _button('Read aloud', 'Read the GPU connection checks aloud', () => widget.onRead?.call(c.summary())),
            ]),
            Row(children: [
              Expanded(child: TextField(
                key: const ValueKey('gpu-connect-email'),
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                decoration: InputDecoration(
                  labelText: 'CHE Office Google account for Colab',
                  helperText: _saved.isEmpty ? 'Default: $cheGpuDefaultAccount. Or say: my CHE Office Google account is, then the address.' : 'Saved on this iPhone: $_saved',
                ),
                onSubmitted: (_) => unawaited(_saveEmail()),
              )),
              _button('Save', 'Save the Google account for Colab', () => unawaited(_saveEmail())),
            ]),
          ]);
        },
      );
}
