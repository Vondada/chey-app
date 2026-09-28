// Runs a plugin's "webapp" screen (a self-contained HTML mini app or an
// HTTPS URL) inside CHE. Mini apps can send a prompt to CHE with
// `CHE.postMessage("text")`.

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

class ChePluginWebApp extends StatefulWidget {
  const ChePluginWebApp({super.key, this.html, this.url, this.onPrompt});
  final String? html;
  final String? url;
  final void Function(String prompt)? onPrompt;
  @override
  State<ChePluginWebApp> createState() => _ChePluginWebAppState();
}

class _ChePluginWebAppState extends State<ChePluginWebApp> {
  late final WebViewController _controller;
  String? _error;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF030607))
      ..addJavaScriptChannel('CHE', onMessageReceived: (message) {
        final text = message.message.trim();
        if (text.isNotEmpty) widget.onPrompt?.call(text.length > 2000 ? text.substring(0, 2000) : text);
      })
      ..setNavigationDelegate(NavigationDelegate(
        // Mini apps stay on HTTPS pages; no file:, javascript: or http: hops.
        onNavigationRequest: (request) {
          final uri = Uri.tryParse(request.url);
          if (uri == null) return NavigationDecision.prevent;
          if (uri.scheme == 'https' || uri.scheme == 'about' || uri.scheme == 'data') {
            return NavigationDecision.navigate;
          }
          return NavigationDecision.prevent;
        },
        onWebResourceError: (error) {
          if (mounted && error.isForMainFrame == true) setState(() => _error = error.description);
        },
      ));
    final url = widget.url == null ? null : Uri.tryParse(widget.url!);
    if (url != null && url.scheme == 'https') {
      _controller.loadRequest(url);
    } else if ((widget.html ?? '').isNotEmpty) {
      _controller.loadHtmlString(widget.html!);
    } else {
      _error = 'This plugin has no web app to show.';
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70)),
        ),
      );
    }
    return WebViewWidget(controller: _controller);
  }
}
