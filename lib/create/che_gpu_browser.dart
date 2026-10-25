import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import '../browser/che_browser.dart';
import '../che_gpu_jobs.dart' show cheGpuWorkerOnline;
import 'che_gpu_connect.dart';

/// One retained session in CHE's existing browser. This never starts or keeps a Colab runtime alive.
class CheGpuBrowser extends StatefulWidget {
  const CheGpuBrowser({super.key, required this.baseUrl, required this.headers, this.onRead, this.client, this.browser, this.connect});
  final String baseUrl;
  final Map<String, String> headers;
  final void Function(String)? onRead;
  final http.Client? client;
  final Widget? browser;

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
enum CheGpuUiCommand { open, expand, minimize, close, back, forward, refresh, showStatus, hideStatus }

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
  if (RegExp(r'^(?:show|bring back|open) (?:the |my )?(?:gpu )?status(?: panel)?$').hasMatch(t)) return CheGpuUiCommand.showStatus;
  if (RegExp(r'^(?:hide|collapse) (?:the |my )?(?:gpu )?status(?: panel)?$|^get (?:this|that|the|all (?:this|the)|all of this|all that) (?:stuff|info|information|status|text|clutter|messages?|instructions?) (?:out of the way|away|aside)$').hasMatch(t)) {
    return CheGpuUiCommand.hideStatus;
  }
  return null;
}

class _CheGpuBrowserState extends State<CheGpuBrowser> {
  // The owner's saved Colab account (or the default), read once. Both the first page and Reopen use it (review of #536).
  late final Future<String> _account = CheGpuAccount.read();
  late final http.Client _http = widget.client ?? http.Client();
  String _status = 'GPU status not checked.';
  // The GPU details above the browser. Hidden, the Colab page fills the screen (owner, 2026-10-25).
  bool _statusVisible = true;
  Timer? _timer;
  bool _checking = false;
  CheGpuConnect get _connect => widget.connect ?? CheGpuConnect.instance;
  @override
  void initState() {
    super.initState();
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
  void dispose() {
    _timer?.cancel();
    CheGpuBrowser.openCount--;
    if (CheGpuBrowser.voiceHandler == _voice) CheGpuBrowser.voiceHandler = null;
    // The flow's worker keeps its own client: the flow outlives this screen.
    if (widget.client == null) _http.close();
    super.dispose();
  }
  Future<String> _check() async {
    if (_checking) return _status;
    _checking = true;
    var message = 'GPU status unavailable. Try GPU Status again.';
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl}/api/gpu'), headers: widget.headers)
          .timeout(const Duration(seconds: 12));
      if (r.statusCode != 200) throw StateError('status ${r.statusCode}');
      final d = jsonDecode(r.body);
      if (d is! Map || d['workers'] is! List) throw StateError('invalid status');
      final gpu = (d['workers'] as List).whereType<Map>().where(cheGpuWorkerOnline).toList();
      message = gpu.isEmpty ? 'No GPU heartbeat online. Saved jobs remain in CHE; free CPU workers handle supported jobs.'
          : 'GPU heartbeat online: ${gpu.first['gpu'] ?? 'GPU'}. Last seen: ${gpu.first['last_seen'] ?? 'unknown'}.';
    } catch (_) {}
    _checking = false;
    if (mounted) setState(() => _status = message);
    return message;
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
          await open(cheColabNotebookUrl);
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
        Navigator.of(context).pop();
        return 'Closed the GPU browser.';
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
      await open(cheGpuNotebookUrl(await _account));
      return 'Notebook refreshed. Choose Runtime, Reconnect or Run all in Colab. CHE cannot start the GPU herself. ${await _check()}';
    }
    return null;
  }
  Future<void> _action(String command) async {
    final result = command == 'refresh'
        ? await CheBrowserActions.voice?.call('refresh')
        : await _voice(command);
    if (result != null && mounted) {
      setState(() => _status = result);
      widget.onRead?.call(result);
    }
  }
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('GPU Browser')),
    body: Column(children: [
      // The status takes at most 30% of the screen and scrolls; the Colab page keeps the rest (owner, 2026-10-25:
      // the panel left no room for the web page, so Open and Refresh only reloaded a strip). Hidden, it takes no room.
      if (_statusVisible) ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.3),
        child: SingleChildScrollView(padding: const EdgeInsets.all(8), child: Column(children: [
          CheGpuConnectPanel(controller: _connect, onRead: widget.onRead),
          Text(_status),
          const Text('Google decides whether it allows signing in here; if it refuses, CHE opens the notebook in Safari. '
              'Colab can end a runtime at any time; jobs resume from their checkpoints.'),
        ])),
      ),
      // The controls stay on screen whatever the status above is (they were inside the scroll area before).
      Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Wrap(spacing: 8, children: [
        for (final command in const ['open', 'refresh', 'reconnect', 'gpu status'])
          TextButton(onPressed: () => unawaited(_action(command)),
              child: Text(const {'open': 'Open', 'refresh': 'Refresh', 'reconnect': 'Reconnect', 'gpu status': 'GPU Status'}[command]!)),
      ])),
      Expanded(child: widget.browser ?? FutureBuilder<String>(
        future: _account,
        builder: (context, saved) => saved.hasData
            ? CheBrowserScreen(initialUrl: cheGpuNotebookUrl(saved.data!), title: 'Colab', sessionKey: cheGpuSessionKey, appMode: false, googleSignInInPage: true)
            : const Center(child: CircularProgressIndicator()),
      )),
    ]),
  );
}
