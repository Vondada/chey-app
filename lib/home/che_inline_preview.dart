// Shows a page, video or site right inside the chat bubble, so the owner sees
// what CHE or her crew rendered without leaving the conversation.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../browser/che_embedded_app_shell.dart';
import '../che_app_portal.dart';
import '../che_ui/che_theme.dart';

class CheInlinePreview extends StatefulWidget {
  const CheInlinePreview({
    super.key,
    required this.url,
    this.height = 300,
    this.headers = const {},
    this.label = 'Preview',
  });

  final String url;
  final double height;
  final Map<String, String> headers;
  final String label;

  /// YouTube watch/short links become embeddable players.
  static String embeddable(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null) return url;
    String? id;
    if (uri.host.contains('youtu.be') && uri.pathSegments.isNotEmpty) {
      id = uri.pathSegments.first;
    } else if (uri.host.contains('youtube.com')) {
      id = uri.queryParameters['v'] ??
          (uri.pathSegments.length > 1 && uri.pathSegments.first == 'shorts' ? uri.pathSegments[1] : null);
    }
    return id == null || id.isEmpty ? url : 'https://www.youtube.com/embed/$id?playsinline=1';
  }

  @override
  State<CheInlinePreview> createState() => _CheInlinePreviewState();
}

class _CheInlinePreviewState extends State<CheInlinePreview> {
  WebViewController? _controller;

  @override
  void initState() {
    super.initState();
    if (!kIsWeb) {
      _controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(Colors.black)
        ..loadRequest(Uri.parse(CheInlinePreview.embeddable(widget.url)), headers: widget.headers);
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    return Semantics(
      label: '${widget.label} shown in chat',
      child: Padding(
        padding: const EdgeInsets.only(top: 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (controller != null)
            ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: SizedBox(
                height: widget.height,
                child: WebViewWidget(
                  controller: controller,
                  // Parent chat scroll wins. Do not eagerly claim the drag.
                  gestureRecognizers: cheEmbeddedParentFriendlyGestures(),
                ),
              ),
            ),
          TextButton.icon(
            onPressed: () {
              if (kIsWeb) {
                launchUrl(Uri.parse(widget.url), mode: LaunchMode.externalApplication);
                return;
              }
              final uri = Uri.tryParse(widget.url);
              final name = uri?.host.isNotEmpty == true ? uri!.host : widget.label;
              CheEmbeddedAppScreen.open(
                context,
                app: CheAppDefinition(
                  name: name,
                  webUrl: widget.url,
                  icon: Icons.language,
                  aliases: const [],
                ),
              );
            },
            icon: const Icon(Icons.open_in_full_rounded, size: 18),
            label: Text(controller == null ? 'Open ${widget.label.toLowerCase()}' : 'Open inside CHE', style: CheType.caption),
          ),
        ]),
      ),
    );
  }
}
