import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import '../browser/che_browser.dart';
import 'che_live_studio.dart' show cheColabNotebookUrl;

/// One retained session in CHE's existing browser. This never starts or keeps a Colab runtime alive.
class CheGpuBrowser extends StatefulWidget {
  const CheGpuBrowser({super.key, required this.baseUrl, required this.headers, this.onRead, this.client, this.browser});
  final String baseUrl;
  final Map<String, String> headers;
  final void Function(String)? onRead;
  final http.Client? client;
  final Widget? browser;
  static Future<String?> Function(String)? voiceHandler;
  @override
  State<CheGpuBrowser> createState() => _CheGpuBrowserState();
}

class _CheGpuBrowserState extends State<CheGpuBrowser> {
  late final http.Client _http = widget.client ?? http.Client();
  String _status = 'GPU status not checked.';
  Timer? _timer;
  bool _checking = false;
  @override
  void initState() {
    super.initState();
    CheGpuBrowser.voiceHandler = _voice;
    unawaited(_check());
    _timer = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(_check()));
  }
  @override
  void dispose() {
    _timer?.cancel();
    if (CheGpuBrowser.voiceHandler == _voice) CheGpuBrowser.voiceHandler = null;
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
      final gpu = (d['workers'] as List).whereType<Map>().where((w) =>
          w['online'] == true && w['class'] != 'github_cpu' &&
          !'${w['device'] ?? w['gpu'] ?? ''}'.toLowerCase().startsWith('cpu')).toList();
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
    if (RegExp(r'^(?:gpu status|check (?:the )?gpu(?: status)?)$').hasMatch(t)) return _check();
    if (RegExp(r'^(?:reconnect(?: (?:the )?gpu)?|open(?: (?:the )?(?:notebook|colab))?)$').hasMatch(t)) {
      final open = CheBrowserActions.openUrl;
      if (open == null) return 'The notebook browser is not ready. Try Open again.';
      await open(cheColabNotebookUrl);
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
      Padding(padding: const EdgeInsets.all(8), child: Column(children: [
        Text(_status),
        const Text('Google sign-in opens a secure system browser. Its cookies may not transfer to CHE. Colab may stop an idle runtime.'),
        Wrap(spacing: 8, children: [
          for (final command in const ['open', 'refresh', 'reconnect', 'gpu status'])
            TextButton(onPressed: () => unawaited(_action(command)),
                child: Text(const {'open': 'Open', 'refresh': 'Refresh', 'reconnect': 'Reconnect', 'gpu status': 'GPU Status'}[command]!)),
        ]),
      ])),
      Expanded(child: widget.browser ?? const CheBrowserScreen(initialUrl: cheColabNotebookUrl, title: 'Colab', sessionKey: 'creation-gpu', appMode: false)),
    ]),
  );
}
