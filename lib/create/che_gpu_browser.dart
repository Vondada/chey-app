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

class _CheGpuBrowserState extends State<CheGpuBrowser> {
  late final http.Client _http = widget.client ?? http.Client();
  String _status = 'GPU status not checked.';
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
  Future<String?> _voice(String words) async {
    if (!(ModalRoute.of(context)?.isCurrent ?? true)) return null;
    final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '');
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
      await open(cheGpuNotebookUrl(cheGpuDefaultAccount));
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
      // the panel left no room for the web page, so Open and Refresh only reloaded a strip).
      ConstrainedBox(
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
      Expanded(child: widget.browser ?? CheBrowserScreen(initialUrl: cheGpuNotebookUrl(cheGpuDefaultAccount), title: 'Colab', sessionKey: cheGpuSessionKey, appMode: false, googleSignInInPage: true)),
    ]),
  );
}
