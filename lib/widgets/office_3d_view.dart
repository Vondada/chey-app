import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// Live 3D Office surface for CHE's "La Agencia" scene.
///
/// [agents] is sent verbatim to JavaScript. Each item should contain:
/// id, name, role and status. Supported scene statuses are:
/// idle, working, thinking, celebrating and blocked.
class Office3DView extends StatefulWidget {
  const Office3DView({
    super.key,
    required this.agents,
    this.onAgentTap,
    this.height = 560,
  });

  final List<Map<String, dynamic>> agents;
  final ValueChanged<String>? onAgentTap;
  final double height;

  @override
  State<Office3DView> createState() => _Office3DViewState();
}

class _Office3DViewState extends State<Office3DView> {
  WebViewController? _controller;
  bool _ready = false;
  String? _lastPayload;

  @override
  void initState() {
    super.initState();
    try {
      final controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(const Color(0xFFF7ECD9))
        ..addJavaScriptChannel(
          'OfficeBridge',
          onMessageReceived: _handleBridgeMessage,
        )
        ..setNavigationDelegate(
          NavigationDelegate(
            onPageFinished: (_) async {
              if (!mounted) return;
              _ready = true;
              await _pushAgents(force: true);
            },
          ),
        )
        ..loadFlutterAsset('assets/office3d/index.html');
      _controller = controller;
    } catch (_) {
      // Flutter widget tests and unsupported runtimes may not provide a
      // WebViewPlatform. Keep the Office usable instead of crashing.
      _controller = null;
      _ready = false;
    }
  }

  @override
  void didUpdateWidget(covariant Office3DView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_ready) {
      _pushAgents();
    }
  }

  void _handleBridgeMessage(JavaScriptMessage message) {
    try {
      final decoded = jsonDecode(message.message);
      if (decoded is Map &&
          decoded['type'] == 'agentTap' &&
          decoded['id'] != null) {
        HapticFeedback.selectionClick();
        widget.onAgentTap?.call(decoded['id'].toString());
      }
    } catch (_) {
      // Ignore malformed page messages. Only structured agentTap messages
      // trigger an action in Flutter.
    }
  }

  Future<void> _pushAgents({bool force = false}) async {
    if (!_ready) return;
    final payload = jsonEncode(widget.agents);
    if (!force && payload == _lastPayload) return;
    _lastPayload = payload;

    // Encode the JSON string again so arbitrary task/name text cannot break
    // the JavaScript source passed to the WebView.
    final escapedPayload = jsonEncode(payload);
    final controller = _controller;
    if (controller == null) return;
    await controller.runJavaScript(
      'window.updateAgents && window.updateAgents(JSON.parse($escapedPayload));',
    );
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label:
          'La Agencia 3D Office. ${widget.agents.length} visible team members. Double tap a character to open that agent.',
      child: ClipRRect(
        borderRadius: BorderRadius.circular(24),
        child: SizedBox(
          height: widget.height,
          width: double.infinity,
          child: _controller == null
              ? Container(
                  color: const Color(0xFFF7ECD9),
                  alignment: Alignment.center,
                  child: const Text(
                    'La Agencia 3D view is unavailable on this device.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Color(0xFF6F534A)),
                  ),
                )
              : WebViewWidget(controller: _controller!),
        ),
      ),
    );
  }
}
