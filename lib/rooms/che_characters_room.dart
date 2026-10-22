import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:webview_flutter/webview_flutter.dart';

import '../agents/che_agent_runtime.dart';
import '../che_ui/che_agents.dart';
import 'che_crew_states.dart';

export 'che_crew_states.dart' show cheCrewModelIds;

// CHE and her office crew as 3D characters (assets/characters/app). The page
// loads through loadFlutterAsset like the Office. The WebView cannot read the
// bundle itself, so each character's GLB is read here and handed to the page
// as base64. Each character plays the clip for its real runtime status
// (che_crew_states.dart); the page says when every model has really loaded,
// and its render loop stops while the room is hidden or the app is in the background.
class CheCharactersRoom extends StatefulWidget {
  const CheCharactersRoom({super.key, this.runtime});

  /// The Office's live runtime. Without it every character stands idle: nothing is shown as working.
  final CheAgentRuntimeController? runtime;

  static Future<void> open(BuildContext context, {CheAgentRuntimeController? runtime}) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => CheCharactersRoom(runtime: runtime)),
    );
  }

  @override
  State<CheCharactersRoom> createState() => _CheCharactersRoomState();
}

class _CheCharactersRoomState extends State<CheCharactersRoom> with WidgetsBindingObserver {
  WebViewController? _controller;
  String _status = 'Loading the crew.';
  Map<String, CheCrewState> _sent = const {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.runtime?.addListener(_sendStates);
    try {
      _controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(const Color(0xFF07090C))
        ..addJavaScriptChannel('CheBridge', onMessageReceived: _onPageMessage)
        ..setNavigationDelegate(
          NavigationDelegate(onPageFinished: (_) => _sendModels()),
        )
        ..loadFlutterAsset('assets/characters/app/index.html');
    } catch (_) {
      // Unsupported runtimes (widget tests) have no WebView platform.
      _controller = null;
      _status = 'The 3D crew needs the iPhone app.';
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.runtime?.removeListener(_sendStates);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // No GPU work while CHE is in the background.
    final paused = state != AppLifecycleState.resumed;
    unawaited(_controller?.runJavaScript('window.CHE && window.CHE.pause && window.CHE.pause($paused);'));
  }

  void _onPageMessage(JavaScriptMessage message) {
    Map<String, dynamic>? msg;
    try {
      final decoded = jsonDecode(message.message);
      if (decoded is Map<String, dynamic>) msg = decoded;
    } catch (_) {}
    if (msg == null || !mounted) return;
    if (msg['type'] == 'ready') {
      setState(() => _status = widget.runtime == null
          ? 'The crew is ready. Each one stands idle until the Office reports their work.'
          : 'The crew is ready. Each one shows their real work right now.');
    } else if (msg['type'] == 'error') {
      setState(() => _status = 'Could not load the ${msg!['id']} character.');
    }
  }

  Future<void> _sendModels() async {
    final controller = _controller;
    if (controller == null) return;
    // Real states first, so no character starts on a clip that is not true.
    _sent = const {};
    await _sendStates();
    for (final id in cheCrewModelIds) {
      try {
        final data = await rootBundle.load('assets/characters/crew/$id.glb');
        final b64 = base64Encode(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
        await controller.runJavaScript("window.CHE && window.CHE.supplyGlb('$id', '$b64');");
      } catch (_) {
        if (mounted) setState(() => _status = 'Could not load the $id character.');
        return;
      }
    }
    // "Ready" is said only when the page reports every model parsed (_onPageMessage).
    if (mounted) setState(() => _status = 'Building the crew.');
  }

  /// Sends each character's clip from the live runtime, only when something changed.
  Future<void> _sendStates() async {
    final controller = _controller;
    if (controller == null) return;
    final runtime = widget.runtime;
    final states = runtime == null
        ? cheCrewStates(CheAgent.che(), const [])
        : cheCrewStates(runtime.che, [for (final p in runtime.agents) p.agent]);
    if (_mapEquals(states, _sent)) return;
    _sent = states;
    final json = jsonEncode({for (final e in states.entries) e.key: e.value.toJson()});
    try {
      await controller.runJavaScript('window.CHE && window.CHE.setStates && window.CHE.setStates($json);');
    } catch (_) {}
  }

  static bool _mapEquals(Map<String, CheCrewState> a, Map<String, CheCrewState> b) =>
      a.length == b.length && a.entries.every((e) => b[e.key] == e.value);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF07090C),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: const Text('CHE office crew'),
      ),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              liveRegion: true,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                child: Text(
                  _status,
                  style: const TextStyle(fontSize: 18, color: Colors.white),
                ),
              ),
            ),
            Expanded(
              child: _controller == null
                  ? const SizedBox.shrink()
                  : WebViewWidget(controller: _controller!),
            ),
          ],
        ),
      ),
    );
  }
}
