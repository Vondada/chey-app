import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:webview_flutter/webview_flutter.dart';

import '../agents/che_agent_runtime.dart';
import '../che_ui/che_agents.dart';
import '../studio/che_character_studio.dart';
import 'che_crew_states.dart';
import 'che_voice_activity.dart';

export 'che_crew_states.dart' show cheCrewModelIds;

// CHE and her office crew as 3D characters (assets/characters/app). The page
// loads through loadFlutterAsset like the Office. The WebView cannot read the
// bundle itself, so each character's GLB is read here and handed to the page
// as base64. Each character plays the clip for its real runtime status
// (che_crew_states.dart); the page says when every model has really loaded,
// and its render loop stops while the room is hidden or the app is in the background.
/// What the Character Studio needs from a live crew page: apply animation settings as the owner adjusts them.
abstract class CheCharactersRoomPreviewHost {
  Future<void> sendAnimationSettings(Map<String, Object?> settings, {String? preset});
}

class CheCharactersRoom extends StatefulWidget {
  const CheCharactersRoom({super.key, this.runtime, this.previewProposal, this.embedded = false, this.focusAgent});

  /// The Office's live runtime. Without it every character stands idle: nothing is shown as working.
  final CheAgentRuntimeController? runtime;

  /// A room CHE proposed (from the Worker's record). Drawn in the scene once the page is ready, never built.
  final Map<String, dynamic>? previewProposal;

  /// Inside another screen (the Character Studio preview): no app bar, the status as a small line.
  final bool embedded;

  /// The agent the camera follows when embedded ('che' or a crew id).
  final String? focusAgent;

  static Future<void> open(BuildContext context, {CheAgentRuntimeController? runtime, Map<String, dynamic>? previewProposal}) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => CheCharactersRoom(runtime: runtime, previewProposal: previewProposal)),
    );
  }

  @override
  State<CheCharactersRoom> createState() => _CheCharactersRoomState();
}

class _CheCharactersRoomState extends State<CheCharactersRoom> with WidgetsBindingObserver implements CheCharactersRoomPreviewHost {
  WebViewController? _controller;
  String _status = 'Loading the crew.';
  Map<String, CheCrewState> _sent = const {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.runtime?.addListener(_sendStates);
    cheVoiceActivity.addListener(_sendVoiceActivity);
    cheCharacterStudio.addListener(_sendStudioSettings);
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
    cheVoiceActivity.removeListener(_sendVoiceActivity);
    cheCharacterStudio.removeListener(_sendStudioSettings);
    super.dispose();
  }

  /// The saved Animation & Personality settings for CHE reach the page before her model, and again on every save.
  Future<void> _sendStudioSettings() async {
    if (!cheCharacterStudio.loaded) await cheCharacterStudio.load();
    final s = cheCharacterStudio.current('che');
    await sendAnimationSettings(s.toJson(), preset: s.preset == 'custom' ? null : s.preset);
  }

  @override
  Future<void> sendAnimationSettings(Map<String, Object?> settings, {String? preset}) async {
    final controller = _controller;
    if (controller == null) return;
    try {
      if (preset != null) await controller.runJavaScript('window.CHE && window.CHE.animPreset && window.CHE.animPreset(${jsonEncode(preset)});');
      if (settings.isNotEmpty) await controller.runJavaScript('window.CHE && window.CHE.animSettings && window.CHE.animSettings(${jsonEncode(settings)});');
    } catch (_) {}
  }

  /// CHE's real voice activity reaches her character: the clip's words and length start the lip sync, the end of
  /// playback closes her mouth, and the microphone state turns her attentive. JSON-encoded, so the words are data.
  Future<void> _sendVoiceActivity() async {
    final controller = _controller;
    if (controller == null) return;
    final a = cheVoiceActivity.value;
    final js = a.speaking
        ? 'window.CHE && window.CHE.speak && window.CHE.speak(${jsonEncode({'text': a.text, 'durationMs': a.durationMs})});'
        : 'window.CHE && window.CHE.stopSpeaking && window.CHE.stopSpeaking(); window.CHE && window.CHE.listen && window.CHE.listen(${a.listening});';
    try {
      await controller.runJavaScript(js);
    } catch (_) {}
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
    final preview = widget.previewProposal;
    if (preview != null) {
      // The proposal is JSON from the Worker; as JavaScript it is an object literal.
      unawaited(controller.runJavaScript('window.CHE && window.CHE.preview && window.CHE.preview(${jsonEncode(preview)});'));
    }
    // Real states first, so no character starts on a clip that is not true; then the saved animation settings.
    _sent = const {};
    await _sendStates();
    await _sendStudioSettings();
    if (widget.focusAgent != null && widget.focusAgent != 'che') {
      unawaited(controller.runJavaScript('window.CHE && window.CHE.focus && window.CHE.focus(${jsonEncode(widget.focusAgent)});'));
    }
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
    if (widget.embedded) {
      return ColoredBox(
        color: const Color(0xFF07090C),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(liveRegion: true, child: Padding(padding: const EdgeInsets.fromLTRB(12, 4, 12, 4), child: Text(_status, style: const TextStyle(fontSize: 13, color: Colors.white70)))),
            Expanded(child: _controller == null ? const SizedBox.shrink() : WebViewWidget(controller: _controller!)),
          ],
        ),
      );
    }
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
