import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// Shared Flutter ↔ Three.js bridge for La Agencia 3D rooms.
///
/// Loads an HTML asset under [assets/office3d/], pushes JSON state through
/// [updateFunction], and reports taps as `{type:"tap", id:"..."}` via
/// [bridgeName] (default OfficeBridge, same channel as the Office).
class Che3DRoomView extends StatefulWidget {
  const Che3DRoomView({
    super.key,
    required this.assetPath,
    required this.payload,
    this.updateFunction = 'updateScene',
    this.bridgeName = 'OfficeBridge',
    this.onTapId,
    this.height = 420,
    this.backgroundColor = const Color(0xFFF7ECD9),
    this.semanticsLabel = '3D room',
    this.fallbackMessage = '3D view is unavailable on this device.',
  });

  final String assetPath;
  final Object? payload;
  final String updateFunction;
  final String bridgeName;
  final ValueChanged<String>? onTapId;
  final double height;
  final Color backgroundColor;
  final String semanticsLabel;
  final String fallbackMessage;

  @override
  State<Che3DRoomView> createState() => _Che3DRoomViewState();
}

class _Che3DRoomViewState extends State<Che3DRoomView> {
  WebViewController? _controller;
  bool _ready = false;
  String? _lastPayload;

  @override
  void initState() {
    super.initState();
    try {
      final controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(widget.backgroundColor)
        ..addJavaScriptChannel(
          widget.bridgeName,
          onMessageReceived: _handleBridgeMessage,
        )
        ..setNavigationDelegate(
          NavigationDelegate(
            onPageFinished: (_) async {
              if (!mounted) return;
              _ready = true;
              await _push(force: true);
            },
          ),
        )
        ..loadFlutterAsset(widget.assetPath);
      _controller = controller;
    } catch (_) {
      _controller = null;
      _ready = false;
    }
  }

  @override
  void didUpdateWidget(covariant Che3DRoomView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_ready) _push();
  }

  void _handleBridgeMessage(JavaScriptMessage message) {
    try {
      final decoded = jsonDecode(message.message);
      if (decoded is Map && decoded['id'] != null) {
        final type = '${decoded['type'] ?? 'tap'}';
        if (type == 'tap' || type == 'agentTap' || type == 'itemTap') {
          HapticFeedback.selectionClick();
          widget.onTapId?.call(decoded['id'].toString());
        }
      }
    } catch (_) {}
  }

  Future<void> _push({bool force = false}) async {
    if (!_ready) return;
    final payload = jsonEncode(widget.payload ?? const {});
    if (!force && payload == _lastPayload) return;
    _lastPayload = payload;
    final escaped = jsonEncode(payload);
    final controller = _controller;
    if (controller == null) return;
    final fn = widget.updateFunction;
    await controller.runJavaScript(
      'window.$fn && window.$fn(JSON.parse($escaped));',
    );
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: widget.semanticsLabel,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(24),
        child: SizedBox(
          height: widget.height,
          width: double.infinity,
          child: _controller == null
              ? Container(
                  color: widget.backgroundColor,
                  alignment: Alignment.center,
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    widget.fallbackMessage,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Color(0xFF6F534A)),
                  ),
                )
              : WebViewWidget(controller: _controller!),
        ),
      ),
    );
  }
}
