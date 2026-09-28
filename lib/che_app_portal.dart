import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'che_theme.dart';

class CheAppDefinition {
  const CheAppDefinition({
    required this.name,
    required this.webUrl,
    required this.icon,
    required this.aliases,
  });

  final String name;
  final String webUrl;
  final IconData icon;
  final List<String> aliases;
}

const List<CheAppDefinition> cheAppCatalog = [
  CheAppDefinition(name: 'YouTube', webUrl: 'https://www.youtube.com', icon: Icons.play_circle_fill, aliases: ['youtube', 'yt']),
  CheAppDefinition(name: 'Instagram', webUrl: 'https://www.instagram.com', icon: Icons.camera_alt_outlined, aliases: ['instagram', 'insta', 'ig']),
  CheAppDefinition(name: 'Snapchat', webUrl: 'https://web.snapchat.com', icon: Icons.chat_bubble_outline, aliases: ['snapchat', 'snap']),
  CheAppDefinition(name: 'TikTok', webUrl: 'https://www.tiktok.com', icon: Icons.music_video_outlined, aliases: ['tiktok', 'tik tok']),
  CheAppDefinition(name: 'Facebook', webUrl: 'https://www.facebook.com', icon: Icons.people_outline, aliases: ['facebook', 'fb']),
  CheAppDefinition(name: 'Threads', webUrl: 'https://www.threads.com', icon: Icons.alternate_email, aliases: ['threads']),
  CheAppDefinition(name: 'X', webUrl: 'https://x.com', icon: Icons.tag, aliases: ['x', 'twitter']),
  CheAppDefinition(name: 'Reddit', webUrl: 'https://www.reddit.com', icon: Icons.forum_outlined, aliases: ['reddit']),
  CheAppDefinition(name: 'Spotify', webUrl: 'https://open.spotify.com', icon: Icons.headphones_outlined, aliases: ['spotify']),
  CheAppDefinition(name: 'Discord', webUrl: 'https://discord.com/app', icon: Icons.groups_outlined, aliases: ['discord']),
  CheAppDefinition(name: 'Twitch', webUrl: 'https://www.twitch.tv', icon: Icons.live_tv_outlined, aliases: ['twitch']),
  CheAppDefinition(name: 'LinkedIn', webUrl: 'https://www.linkedin.com', icon: Icons.work_outline, aliases: ['linkedin', 'linked in']),
  CheAppDefinition(name: 'GitHub', webUrl: 'https://github.com', icon: Icons.code, aliases: ['github', 'git hub']),
  CheAppDefinition(name: 'TradingView', webUrl: 'https://www.tradingview.com', icon: Icons.show_chart, aliases: ['tradingview', 'trading view']),
  CheAppDefinition(name: 'NinjaTrader', webUrl: 'https://ninjatrader.com', icon: Icons.candlestick_chart, aliases: ['ninjatrader', 'ninja trader']),
];

CheAppDefinition? cheAppForName(String input) {
  final value = input.toLowerCase().trim();
  for (final app in cheAppCatalog) {
    if (app.name.toLowerCase() == value ||
        app.aliases.any((alias) => value == alias || value.contains(alias))) {
      return app;
    }
  }
  return null;
}

typedef CheLearnPageCallback = Future<void> Function(
  String title,
  String url,
  String pageText,
);

class CheAppsHubTab extends StatefulWidget {
  const CheAppsHubTab({super.key, this.onLearnPage});

  final CheLearnPageCallback? onLearnPage;

  @override
  State<CheAppsHubTab> createState() => _CheAppsHubTabState();
}

class _CheAppsHubTabState extends State<CheAppsHubTab> {
  final TextEditingController _urlController = TextEditingController();

  @override
  void dispose() {
    _urlController.dispose();
    super.dispose();
  }

  Future<void> _openCustom() async {
    var raw = _urlController.text.trim();
    if (raw.isEmpty) return;
    if (!raw.contains('://')) raw = 'https://$raw';
    final uri = Uri.tryParse(raw);
    if (uri == null || (uri.scheme != 'https' && uri.scheme != 'http')) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter a valid web address.')),
      );
      return;
    }
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CheEmbeddedAppScreen(
          app: CheAppDefinition(
            name: uri.host.isEmpty ? 'Web App' : uri.host,
            webUrl: uri.toString(),
            icon: Icons.language,
            aliases: const [],
          ),
          onLearnPage: widget.onLearnPage,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        const Text('Apps inside CHE', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        const Text(
          'Web-capable services open without leaving CHE. Native-only features use the official app when iOS or the service requires it.',
          style: TextStyle(color: CheColors.textDim),
        ),
        const SizedBox(height: 16),
        GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: cheAppCatalog.length,
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            childAspectRatio: 0.95,
          ),
          itemBuilder: (context, index) {
            final app = cheAppCatalog[index];
            return InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => CheEmbeddedAppScreen(
                    app: app,
                    onLearnPage: widget.onLearnPage,
                  ),
                ),
              ),
              child: Container(
                decoration: BoxDecoration(
                  color: CheColors.panel,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: Colors.white10),
                ),
                padding: const EdgeInsets.all(10),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(app.icon, size: 28, color: CheColors.accent),
                    const SizedBox(height: 8),
                    Text(
                      app.name,
                      textAlign: TextAlign.center,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
        const SizedBox(height: 18),
        const Text('ADD A WEB APP', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 1.2)),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _urlController,
                keyboardType: TextInputType.url,
                textInputAction: TextInputAction.go,
                onSubmitted: (_) => _openCustom(),
                decoration: const InputDecoration(hintText: 'example.com', prefixIcon: Icon(Icons.language)),
              ),
            ),
            const SizedBox(width: 8),
            FilledButton(onPressed: _openCustom, child: const Text('OPEN')),
          ],
        ),
      ],
    );
  }
}

class CheEmbeddedAppScreen extends StatefulWidget {
  const CheEmbeddedAppScreen({
    super.key,
    required this.app,
    this.onLearnPage,
  });
  final CheAppDefinition app;
  final CheLearnPageCallback? onLearnPage;

  @override
  State<CheEmbeddedAppScreen> createState() => _CheEmbeddedAppScreenState();
}

class _CheEmbeddedAppScreenState extends State<CheEmbeddedAppScreen> {
  late final WebViewController _controller;
  int _progress = 0;
  String _currentUrl = '';

  @override
  void initState() {
    super.initState();
    _currentUrl = widget.app.webUrl;
    _controller = WebViewController()
      ..setBackgroundColor(CheColors.bgDeep)
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (value) {
            if (mounted) setState(() => _progress = value);
          },
          onPageStarted: (url) {
            if (mounted) setState(() => _currentUrl = url);
          },
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            if (uri == null) return NavigationDecision.prevent;
            if (uri.scheme == 'http' || uri.scheme == 'https' || uri.scheme == 'about') {
              return NavigationDecision.navigate;
            }
            launchUrl(uri, mode: LaunchMode.externalApplication);
            return NavigationDecision.prevent;
          },
        ),
      )
      ..loadRequest(Uri.parse(widget.app.webUrl));
  }

  Future<void> _openExternal() async {
    final uri = Uri.tryParse(_currentUrl) ?? Uri.parse(widget.app.webUrl);
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  Future<void> _teachCheThisPage() async {
    final callback = widget.onLearnPage;
    if (callback == null) return;

    final title = (await _controller.getTitle())?.trim();
    String pageText = '';
    try {
      final raw = await _controller.runJavaScriptReturningResult(
        'document.body ? document.body.innerText : ""',
      );
      pageText = raw.toString();
      try {
        final decoded = jsonDecode(pageText);
        if (decoded is String) pageText = decoded;
      } catch (_) {}
    } catch (_) {}

    await callback(
      title?.isNotEmpty == true ? title! : widget.app.name,
      _currentUrl,
      pageText,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bgDeep,
      appBar: AppBar(
        title: Text(widget.app.name),
        actions: [
          IconButton(
            tooltip: 'Back',
            onPressed: () async {
              if (await _controller.canGoBack()) await _controller.goBack();
            },
            icon: const Icon(Icons.arrow_back_ios_new, size: 18),
          ),
          IconButton(
            tooltip: 'Forward',
            onPressed: () async {
              if (await _controller.canGoForward()) await _controller.goForward();
            },
            icon: const Icon(Icons.arrow_forward_ios, size: 18),
          ),
          IconButton(tooltip: 'Reload', onPressed: () => _controller.reload(), icon: const Icon(Icons.refresh)),
          if (widget.onLearnPage != null)
            IconButton(
              tooltip: 'Teach CHE this page',
              onPressed: _teachCheThisPage,
              icon: const Icon(Icons.psychology_alt_outlined),
            ),
          IconButton(tooltip: 'Open official app/browser', onPressed: _openExternal, icon: const Icon(Icons.open_in_new)),
        ],
      ),
      body: Column(
        children: [
          if (_progress < 100) LinearProgressIndicator(value: _progress / 100.0, minHeight: 2),
          Expanded(child: WebViewWidget(controller: _controller)),
        ],
      ),
    );
  }
}
