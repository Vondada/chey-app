import 'package:flutter/material.dart';

import 'browser/che_browser.dart';
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

/// The app's real icon (the site's own favicon), with the old symbol only as
/// a fallback when there's no connection.
String cheAppIconUrl(String webUrl) {
  final host = Uri.tryParse(webUrl)?.host ?? '';
  final domain = host.replaceFirst(RegExp(r'^(www|open|web)\.'), '');
  return 'https://www.google.com/s2/favicons?sz=128&domain=${Uri.encodeComponent(domain)}';
}

class CheAppIcon extends StatelessWidget {
  const CheAppIcon({super.key, required this.app, this.size = 40});
  final CheAppDefinition app;
  final double size;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(size * 0.22),
      child: Image.network(
        cheAppIconUrl(app.webUrl),
        width: size,
        height: size,
        fit: BoxFit.cover,
        filterQuality: FilterQuality.high,
        errorBuilder: (context, error, stackTrace) => Icon(app.icon, size: size * 0.7, color: CheColors.accent),
      ),
    );
  }
}

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
                    CheAppIcon(app: app, size: 40),
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
  @override
  void initState() {
    super.initState();
    // Page-level "Teach CHE" from this entry point, if the app didn't set one.
    if (widget.onLearnPage != null) CheBrowserActions.learn ??= widget.onLearnPage;
  }

  @override
  Widget build(BuildContext context) {
    return CheBrowserScreen(initialUrl: widget.app.webUrl, title: widget.app.name);
  }
}
