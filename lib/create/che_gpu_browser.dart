import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:http/http.dart' as http;
import '../browser/che_browser.dart';
import '../che_gpu_jobs.dart' show cheGpuWorkerOnline;
import 'che_gpu_connect.dart';
import 'che_live_studio.dart' show cheColabNotebookUrl;

/// One retained session in CHE's existing browser. This never starts or keeps a Colab runtime alive.
class CheGpuBrowser extends StatefulWidget {
  const CheGpuBrowser({super.key, required this.baseUrl, required this.headers, this.onRead, this.client, this.browser, this.connect, this.authenticate});
  final String baseUrl;
  final Map<String, String> headers;
  final void Function(String)? onRead;
  final http.Client? client;
  final Widget? browser;
  final Future<bool> Function(Uri)? authenticate;

  /// The Connect GPU flow; defaults to the app's one instance, which outlives this screen.
  final CheGpuConnect? connect;
  static Future<String?> Function(String)? voiceHandler;

  /// Whether a GPU Browser screen is built (Connect GPU brings it to the front instead of pushing another).
  static int openCount = 0;
  @override
  State<CheGpuBrowser> createState() => _CheGpuBrowserState();
}

/// A spoken command about the screen itself (owner, 2026-10-25: "pull up the browser", "get this stuff out of the way").
/// These change what is on screen and never start a GPU connection. Null when the words are not a screen command.
enum CheGpuUiCommand { open, expand, minimize, close, back, forward, refresh, showStatus, hideStatus, signOutGoogle, checkGoogleSignIn }

/// Google's own sign-out page. It signs out the Google session in the browser that opens it, and nothing else.
const cheGpuGoogleSignOutUrl = 'https://accounts.google.com/Logout';

CheGpuUiCommand? cheGpuUiCommand(String words) {
  final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?,]+$'), '').replaceAll(RegExp(r'\s+'), ' ');
  if (RegExp(r'^(?:open|pull up|bring up|show|go to) (?:the |my )?(?:gpu )?browser$').hasMatch(t)) return CheGpuUiCommand.open;
  if (RegExp(r'^(?:make|expand|enlarge|maximi[sz]e) (?:the |my )?(?:gpu )?browser(?: (?:bigger|larger|up|full ?screen))?$|^(?:expand|maximi[sz]e|full ?screen) (?:the |my )?(?:gpu )?browser$|^full ?screen$').hasMatch(t)) {
    return CheGpuUiCommand.expand;
  }
  if (RegExp(r'^(?:minimi[sz]e|shrink|restore) (?:the |my )?(?:gpu )?browser(?: smaller)?$|^make (?:the |my )?(?:gpu )?browser smaller$').hasMatch(t)) {
    return CheGpuUiCommand.minimize;
  }
  if (RegExp(r'^(?:close|exit) (?:the |my )?(?:gpu )?browser$').hasMatch(t)) return CheGpuUiCommand.close;
  if (RegExp(r'^(?:go )?back$').hasMatch(t)) return CheGpuUiCommand.back;
  if (RegExp(r'^(?:go )?forward$').hasMatch(t)) return CheGpuUiCommand.forward;
  if (RegExp(r'^(?:refresh|reload)(?: (?:the )?(?:page|browser))?$').hasMatch(t)) return CheGpuUiCommand.refresh;
  if (RegExp(r'^(?:sign|log) ?out (?:of|from) google(?: (?:in|on) (?:the |my )?(?:gpu )?browser)?$|^(?:sign|log) ?out google$').hasMatch(t)) {
    return CheGpuUiCommand.signOutGoogle;
  }
  // The spoken way to check the sign-out: CHE reads Google's page aloud, so nobody has to look at it.
  if (RegExp(r'^(?:check|read) (?:my |the )?google sign ?-?(?:in|out)(?: status)?$|^am i (?:still )?signed (?:in|out)(?: of google)?$|^did (?:it|google) sign (?:me )?out$').hasMatch(t)) {
    return CheGpuUiCommand.checkGoogleSignIn;
  }
  if (RegExp(r'^(?:show|bring back|open) (?:the |my )?(?:gpu )?status(?: panel)?$').hasMatch(t)) return CheGpuUiCommand.showStatus;
  if (RegExp(r'^(?:hide|collapse) (?:the |my )?(?:gpu )?status(?: panel)?$|^get (?:this|that|the|all (?:this|the)|all of this|all that) (?:stuff|info|information|status|text|clutter|messages?|instructions?) (?:out of the way|away|aside)$').hasMatch(t)) {
    return CheGpuUiCommand.hideStatus;
  }
  return null;
}

class _CheGpuBrowserState extends State<CheGpuBrowser> with WidgetsBindingObserver {
  // The owner's saved Colab account (or the default), read once. Both the first page and Reopen use it (review of #536).
  Future<String> get _account => CheGpuAccount.read();
  late final http.Client _http = widget.client ?? http.Client();
  String _status = 'Setup Required: checking GPU heartbeat.';
  String _officeAccount = '';
  String _officeStatus = 'Checking CHE Office account.';
  bool _officeConnected = false;
  bool _connecting = false;
  bool _allowClose = false;
  String? _loadedAccount;
  // The GPU details above the browser. Hidden, the Colab page fills the screen (owner, 2026-10-25).
  bool _statusVisible = true;
  Timer? _timer;
  bool _checking = false;
  CheGpuConnect get _connect => widget.connect ?? CheGpuConnect.instance;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    CheGpuBrowser.openCount++;
    CheGpuBrowser.voiceHandler = _voice;
    if (_connect.worker == null || widget.client != null) {
      _connect.configure(worker: CheGpuHttpWorker(baseUrl: widget.baseUrl, headers: widget.headers, client: widget.client));
    }
    _connect.browser ??= CheGpuSessionBrowser(front: () async {});
    unawaited(_check());
    _timer = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(_check()));
  }
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_check());
  }
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    CheGpuBrowser.openCount--;
    if (CheGpuBrowser.voiceHandler == _voice) CheGpuBrowser.voiceHandler = null;
    // The flow's worker keeps its own client: the flow outlives this screen.
    if (widget.client == null) _http.close();
    super.dispose();
  }
  Future<Map> _get(String path) async {
    final r = await _http.get(Uri.parse('${widget.baseUrl}$path'), headers: widget.headers)
        .timeout(const Duration(seconds: 12));
    if (r.statusCode != 200) throw StateError('status ${r.statusCode}');
    final d = jsonDecode(r.body);
    if (d is! Map) throw StateError('invalid status');
    return d;
  }
  Future<String> _check() async {
    if (_checking) return _status;
    _checking = true;
    // A failed check never retains a previously Connected label.
    var message = 'Disconnected: GPU status unavailable. Try GPU Status again.';
    try {
      final d = await _get('/api/gpu');
      if (d['workers'] is! List) throw StateError('invalid workers');
      final gpu = (d['workers'] as List).whereType<Map>().where(cheGpuWorkerOnline).toList();
      final jobs = (d['jobs'] as List? ?? []).whereType<Map>();
      if (gpu.isEmpty) {
        message = '${d['worker_paired'] == false ? 'Setup Required' : 'Disconnected'}: No GPU heartbeat online. Saved jobs remain in CHE; free CPU workers handle supported jobs.';
        if (jobs.any((j) => ['queued', 'paused'].contains(j['state']) && j['cloud']?['state'] == 'dispatching')) {
          message += ' Reconnecting compute: the backend requested a cloud CPU worker; GPU remains disconnected.';
        }
      } else {
        final rendering = jobs.any((j) => j['state'] == 'rendering' && gpu.any((w) => w['job_id'] == j['id']));
        message = '${rendering ? 'Rendering' : 'Connected'}: GPU heartbeat online: ${gpu.first['gpu'] ?? 'GPU'}. Last seen: ${gpu.first['last_seen'] ?? 'unknown'}.';
      }
    } catch (_) {}
    try {
      final data = await _get('/api/google/status');
      final office = data['services']?['office'];
      if (office is Map) {
        _officeAccount = office['account']?.toString() ?? '';
        _officeConnected = office['connected'] == true;
        _officeStatus = _officeConnected ? 'CHE Office: $_officeAccount'
            : '${_officeAccount.isEmpty ? 'Setup Required' : 'Reauthentication required'}: connect your CHE Office Google account.';
      } else {
        _officeConnected = false;
        _officeStatus = 'Setup Required: CHE Office account is not connected.';
      }
    } catch (_) {
      _officeConnected = false;
      _officeStatus = 'CHE Office status unavailable. Check again before connecting.';
    }
    if (mounted && _officeConnected && _loadedAccount != _officeAccount && widget.browser == null) {
      final open = CheBrowserActions.openUrl;
      if (open != null) {
        _loadedAccount = _officeAccount;
        await CheGpuAccount.save(_officeAccount);
        try { await open(_notebookUrl); } catch (_) { _loadedAccount = null; }
      }
    }
    _checking = false;
    if (mounted) setState(() => _status = message);
    return '$_officeStatus $message';
  }
  String get _notebookUrl {
    if (!_officeConnected || _officeAccount.isEmpty) return cheColabNotebookUrl;
    final uri = Uri.parse(cheColabNotebookUrl);
    return uri.replace(queryParameters: {...uri.queryParameters, 'authuser': _officeAccount}).toString();
  }
  Future<String> _connectOffice() async {
    if (_connecting) return 'CHE Office sign-in is already opening.';
    setState(() => _connecting = true);
    try {
      final r = await _http.post(Uri.parse('${widget.baseUrl}/api/google/connect/start'),
        headers: {...widget.headers, 'Content-Type': 'application/json'}, body: jsonEncode({'service': 'office'}))
          .timeout(const Duration(seconds: 15));
      final data = jsonDecode(r.body);
      final uri = Uri.tryParse(data['url']?.toString() ?? '');
      if (r.statusCode != 200 || uri == null || uri.scheme != 'https' || uri.host != 'accounts.google.com' || uri.userInfo.isNotEmpty) {
        return data['detail']?.toString() ?? 'CHE Office sign-in could not start. Check Google configuration.';
      }
      final opened = await (widget.authenticate?.call(uri) ?? launchUrl(uri, mode: LaunchMode.inAppBrowserView));
      return opened ? 'Choose your CHE Office account in Google. Return to CHE after approval; your verified selection is saved securely.'
          : 'Google sign-in could not open. Try Connect CHE Office again.';
    } catch (_) {
      return 'CHE Office sign-in is unavailable. Try again.';
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }
  Future<void> _close() async {
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() => _allowClose = true);
    await WidgetsBinding.instance.endOfFrame;
    if (mounted) Navigator.of(context).pop();
  }
  /// Runs a screen command and reports only what actually happened.
  Future<String?> _screen(CheGpuUiCommand command) async {
    void showStatus(bool visible) {
      if (mounted) setState(() => _statusVisible = visible);
    }
    switch (command) {
      case CheGpuUiCommand.open:
        final open = CheBrowserActions.openUrl;
        if (open == null) return 'The Colab page is not ready yet. Try again in a moment.';
        try {
          await open(cheGpuNotebookUrl(_officeConnected ? _officeAccount : await _account));
        } catch (_) {
          return 'I could not open Colab. Try again in a moment.';
        }
        showStatus(false);
        return _statusVisible ? 'Colab did not open.' : 'Colab is open and fills the screen. Say "show status" for the GPU details.';
      case CheGpuUiCommand.expand:
        showStatus(false);
        return _statusVisible ? 'The browser did not expand.' : 'The browser fills the screen. Say "show status" for the GPU details.';
      case CheGpuUiCommand.hideStatus:
        showStatus(false);
        return _statusVisible ? 'The status did not hide.' : 'Status hidden. Say "show status" to see it.';
      case CheGpuUiCommand.minimize:
      case CheGpuUiCommand.showStatus:
        showStatus(true);
        return _statusVisible ? 'Showing the GPU status above the browser.' : 'The status did not show.';
      case CheGpuUiCommand.close:
        if (!Navigator.of(context).canPop()) return 'There is no browser screen to close.';
        await _close();
        return 'Closed the GPU browser.';
      case CheGpuUiCommand.signOutGoogle:
        // Google's own sign-out page, opened in CHE's browser. It signs out only the Google session.
        final open = CheBrowserActions.openUrl;
        if (open == null) return 'The browser is not ready yet. Try again in a moment.';
        try {
          await open(cheGpuGoogleSignOutUrl);
        } catch (_) {
          return 'I could not open Google\'s sign-out page. Nothing was signed out.';
        }
        return 'Opened Google\'s sign-out page in CHE\'s browser. I cannot tell yet whether it finished. Say "check Google sign-in" and I will read Google\'s page to you before you connect.';
      case CheGpuUiCommand.checkGoogleSignIn:
        // CHE's browser reads its own page text; CHE says only what the page says, never that sign-out worked.
        final read = CheBrowserActions.voice;
        if (read == null) return 'The browser is not ready yet. Try again in a moment.';
        final page = await read('read the page');
        if (page == null || page.trim().isEmpty) return 'I could not read Google\'s page, so I cannot say whether you are signed out.';
        return 'Google\'s page says: ${page.trim()}';
      case CheGpuUiCommand.back:
      case CheGpuUiCommand.forward:
      case CheGpuUiCommand.refresh:
        // The Colab page's own controls answer for themselves: "This is the first page." is the browser's real answer.
        final words = {CheGpuUiCommand.back: 'back', CheGpuUiCommand.forward: 'forward', CheGpuUiCommand.refresh: 'refresh'}[command]!;
        return await CheBrowserActions.voice?.call(words) ?? 'The Colab page is not ready yet.';
    }
  }
  Future<String?> _voice(String words) async {
    if (!(ModalRoute.of(context)?.isCurrent ?? true)) return null;
    final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '');
    if (RegExp(r'^(?:connect|switch)(?: (?:che )?office(?: account)?)?$').hasMatch(t)) return _connectOffice();
    if (t == 'read status') return _check();
    // Screen commands come first, so "open the browser" never reaches the GPU connection flow.
    final ui = cheGpuUiCommand(words);
    if (ui != null) return _screen(ui);
    if (cheGpuConnectCommand(words)) return _connect.start(words);
    if (_connect.waitingForOwner && cheGpuContinueCommand(words)) return _connect.ownerContinue();
    if (RegExp(r'^(?:stop|cancel)(?: connecting)?(?: (?:the|my) gpu)?$').hasMatch(t) && _connect.busy) return _connect.cancel();
    if (RegExp(r'^(?:read|check)(?: the| my)? (?:gpu )?connection(?: checks)?$').hasMatch(t)) return _connect.summary();
    final email = cheGpuAccountFromWords(words);
    if (email != null) {
      await CheGpuAccount.save(email);
      return 'Saved. CHE uses $email for Colab.';
    }
    if (RegExp(r'^(?:gpu status|check (?:the )?gpu(?: status)?)$').hasMatch(t)) return _check();
    if (RegExp(r'^(?:reconnect(?: (?:the )?gpu)?|open(?: (?:the )?(?:notebook|colab))?)$').hasMatch(t)) {
      final open = CheBrowserActions.openUrl;
      if (open == null) return 'The notebook browser is not ready. Try Open again.';
      await open(cheGpuNotebookUrl(_officeConnected ? _officeAccount : await _account));
      return 'Notebook refreshed. Choose Runtime, Reconnect or Run all in Colab. CHE cannot start the GPU herself. ${await _check()}';
    }
    return null;
  }
  Future<void> _action(String command) async {
    unawaited(HapticFeedback.selectionClick());
    final result = command == 'refresh'
        ? await CheBrowserActions.voice?.call('refresh')
        : await _voice(command);
    if (result != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(result)));
      widget.onRead?.call(result);
    }
  }
  @override
  Widget build(BuildContext context) => PopScope(
    canPop: _allowClose,
    onPopInvokedWithResult: (didPop, result) { if (!didPop) unawaited(_action('back')); },
    child: Scaffold(
    appBar: AppBar(title: const Text('GPU Browser'),
      leading: IconButton(tooltip: 'Back in browser history', icon: const Icon(Icons.arrow_back), onPressed: () => unawaited(_action('back'))),
      actions: [TextButton(onPressed: () => unawaited(_action('close the browser')), child: const Text('Close'))]),
    body: Column(children: [
      // The status takes at most 25% of the screen and scrolls; the Colab page keeps the rest (owner, 2026-10-25:
      // the panel left no room for the web page, so Open and Refresh only reloaded a strip). Hidden, it takes no room.
      if (_statusVisible) ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.25),
        child: SingleChildScrollView(padding: const EdgeInsets.all(8), child: Column(children: [
          Text(_officeStatus),
          TextButton(onPressed: _connecting ? null : () => unawaited(_action('connect office')), child: Text(_officeConnected ? 'Switch CHE Office account' : 'Connect CHE Office')),
          CheGpuConnectPanel(controller: _connect, onRead: widget.onRead),
          Text(_status),
          const Text('Google decides whether it allows signing in here; if it refuses, CHE opens the notebook in Safari. '
              'Colab can end a runtime at any time; jobs resume from their checkpoints.'),
        ])),
      ),
      // The controls stay on screen whatever the status above is (they were inside the scroll area before).
      Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Wrap(spacing: 8, children: [
        for (final command in const ['back', 'forward', 'open', 'refresh', 'reconnect', 'gpu status', 'read status'])
          TextButton(onPressed: () => unawaited(_action(command)),
              child: Text(const {'back': 'Back', 'forward': 'Forward', 'read status': 'Read status', 'open': 'Open', 'refresh': 'Refresh', 'reconnect': 'Reconnect', 'gpu status': 'GPU Status'}[command]!)),
      ])),
      Expanded(child: widget.browser ?? FutureBuilder<String>(
        future: _account,
        builder: (context, saved) => saved.hasData
            ? CheBrowserScreen(initialUrl: cheGpuNotebookUrl(saved.data!), title: 'Colab', sessionKey: cheGpuSessionKey, historyOnlyBack: true, onClose: _close, appMode: false, googleSignInInPage: true)
            : const Center(child: CircularProgressIndicator()),
      )),
    ]),
  ),
  );
}
