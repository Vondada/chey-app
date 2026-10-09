import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:webview_flutter/webview_flutter.dart';

// CHE and her office crew as 3D characters (assets/characters/app). The page
// loads through loadFlutterAsset like the Office. The WebView cannot read the
// bundle itself, so each character's GLB is read here and handed to the page
// as base64.
const List<String> cheCrewModelIds = ['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris'];

class CheCharactersRoom extends StatefulWidget {
  const CheCharactersRoom({super.key});

  static Future<void> open(BuildContext context) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const CheCharactersRoom()),
    );
  }

  @override
  State<CheCharactersRoom> createState() => _CheCharactersRoomState();
}

class _CheCharactersRoomState extends State<CheCharactersRoom> {
  WebViewController? _controller;
  String _status = 'Loading the crew.';

  @override
  void initState() {
    super.initState();
    try {
      _controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(const Color(0xFF07090C))
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

  Future<void> _sendModels() async {
    final controller = _controller;
    if (controller == null) return;
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
    if (mounted) setState(() => _status = 'The crew is ready. Tap a name to hear about them.');
  }

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
