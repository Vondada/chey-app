import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'che_theme.dart';

class CheLiveVoiceScreen extends StatefulWidget {
  const CheLiveVoiceScreen({
    super.key,
    required this.baseUrl,
    required this.deviceToken,
  });

  final String baseUrl;
  final String deviceToken;

  @override
  State<CheLiveVoiceScreen> createState() => _CheLiveVoiceScreenState();
}

class _CheLiveVoiceScreenState extends State<CheLiveVoiceScreen> {
  late final WebViewController controller;
  int progress = 0;

  @override
  void initState() {
    super.initState();
    final base = widget.baseUrl.replaceFirst(RegExp(r'/$'), '');
    final uri = Uri.parse(
      '$base/live-voice#token=${Uri.encodeComponent(widget.deviceToken)}',
    );
    controller = WebViewController()
      ..setBackgroundColor(CheColors.bgDeep)
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (value) {
            if (mounted) setState(() => progress = value);
          },
        ),
      )
      ..loadRequest(uri);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bgDeep,
      appBar: AppBar(
        title: const Text('CHE Live Voice'),
        actions: [
          IconButton(
            tooltip: 'Reload',
            onPressed: controller.reload,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: Column(
        children: [
          if (progress < 100)
            LinearProgressIndicator(value: progress / 100, minHeight: 2),
          Expanded(child: WebViewWidget(controller: controller)),
        ],
      ),
    );
  }
}
