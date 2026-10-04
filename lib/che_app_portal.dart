import 'package:flutter/material.dart';

import 'browser/che_browser.dart';
import 'browser/che_embedded_app_shell.dart';
import 'che_theme.dart';
import 'home/che_grok_chat_screen.dart';

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
  CheAppDefinition(name: 'NinjaTrader', webUrl: 'https://web-trader.ninjatrader.com/', icon: Icons.candlestick_chart, aliases: ['ninjatrader', 'ninja trader']),
  CheAppDefinition(name: 'TradeSea', webUrl: 'https://app.tradesea.ai/login?theme=dark', icon: Icons.ssid_chart, aliases: ['tradesea', 'trade sea', 'trade sea ai']),
  // Web versions CHE can use when a phone app can't be controlled directly.
  CheAppDefinition(name: 'Gmail', webUrl: 'https://mail.google.com', icon: Icons.mail_outline, aliases: ['gmail', 'google mail']),
  CheAppDefinition(name: 'Outlook', webUrl: 'https://outlook.live.com/mail', icon: Icons.mark_email_unread_outlined, aliases: ['outlook', 'hotmail']),
  CheAppDefinition(name: 'Yahoo Mail', webUrl: 'https://mail.yahoo.com', icon: Icons.mail_outline, aliases: ['yahoo mail']),
  CheAppDefinition(name: 'Google Calendar', webUrl: 'https://calendar.google.com', icon: Icons.calendar_month_outlined, aliases: ['google calendar']),
  CheAppDefinition(name: 'Google Drive', webUrl: 'https://drive.google.com', icon: Icons.folder_open_outlined, aliases: ['google drive', 'drive']),
  CheAppDefinition(name: 'Google Docs', webUrl: 'https://docs.google.com', icon: Icons.description_outlined, aliases: ['google docs']),
  CheAppDefinition(name: 'Google Maps', webUrl: 'https://www.google.com/maps', icon: Icons.map_outlined, aliases: ['google maps']),
  CheAppDefinition(name: 'WhatsApp', webUrl: 'https://web.whatsapp.com', icon: Icons.chat_outlined, aliases: ['whatsapp', 'whats app']),
  CheAppDefinition(name: 'Messenger', webUrl: 'https://www.messenger.com', icon: Icons.messenger_outline, aliases: ['messenger', 'facebook messenger']),
  CheAppDefinition(name: 'Telegram', webUrl: 'https://web.telegram.org', icon: Icons.send_outlined, aliases: ['telegram']),
  CheAppDefinition(name: 'Slack', webUrl: 'https://app.slack.com', icon: Icons.tag_outlined, aliases: ['slack']),
  CheAppDefinition(name: 'Microsoft Teams', webUrl: 'https://teams.microsoft.com', icon: Icons.groups_2_outlined, aliases: ['teams', 'microsoft teams']),
  CheAppDefinition(name: 'Zoom', webUrl: 'https://app.zoom.us', icon: Icons.videocam_outlined, aliases: ['zoom']),
  CheAppDefinition(name: 'Netflix', webUrl: 'https://www.netflix.com', icon: Icons.movie_outlined, aliases: ['netflix']),
  CheAppDefinition(name: 'Hulu', webUrl: 'https://www.hulu.com', icon: Icons.live_tv_outlined, aliases: ['hulu']),
  CheAppDefinition(name: 'Prime Video', webUrl: 'https://www.primevideo.com', icon: Icons.ondemand_video_outlined, aliases: ['prime video', 'amazon prime video']),
  CheAppDefinition(name: 'Disney+', webUrl: 'https://www.disneyplus.com', icon: Icons.movie_filter_outlined, aliases: ['disney plus', 'disney+']),
  CheAppDefinition(name: 'Max', webUrl: 'https://play.max.com', icon: Icons.tv_outlined, aliases: ['hbo max', 'hbo']),
  CheAppDefinition(name: 'Tubi', webUrl: 'https://tubitv.com', icon: Icons.tv_outlined, aliases: ['tubi']),
  CheAppDefinition(name: 'Pluto TV', webUrl: 'https://pluto.tv', icon: Icons.tv_outlined, aliases: ['pluto', 'pluto tv']),
  CheAppDefinition(name: 'Amazon', webUrl: 'https://www.amazon.com', icon: Icons.shopping_cart_outlined, aliases: ['amazon']),
  CheAppDefinition(name: 'PayPal', webUrl: 'https://www.paypal.com', icon: Icons.account_balance_wallet_outlined, aliases: ['paypal', 'pay pal']),
  CheAppDefinition(name: 'Notion', webUrl: 'https://www.notion.so', icon: Icons.notes_outlined, aliases: ['notion']),
  CheAppDefinition(name: 'Pinterest', webUrl: 'https://www.pinterest.com', icon: Icons.push_pin_outlined, aliases: ['pinterest']),
  CheAppDefinition(name: 'ChatGPT', webUrl: 'https://chatgpt.com', icon: Icons.smart_toy_outlined, aliases: ['chatgpt', 'chat gpt']),
  CheAppDefinition(name: 'Grok', webUrl: 'https://grok.com', icon: Icons.smart_toy_outlined, aliases: ['grok']),
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
  // Whole-word matches only, so "netflix" never matches the "x" alias.
  bool mentions(String alias) =>
      value == alias || RegExp('(^|[^a-z0-9])${RegExp.escape(alias)}(\$|[^a-z0-9])').hasMatch(value);
  for (final app in cheAppCatalog) {
    if (app.name.toLowerCase() == value) return app;
  }
  for (final app in cheAppCatalog) {
    if (app.aliases.any(mentions)) return app;
  }
  return null;
}

/// True when [url] is on TradeSea (app.tradesea.ai or sibling tradesea.ai hosts).
bool cheIsTradeSeaUrl(String url) {
  final host = Uri.tryParse(url)?.host.toLowerCase() ?? '';
  return host.contains('tradesea.ai');
}

/// TradeSea's web app shows phones a "download the app" sheet, and its
/// `source=mobile-app` / `window.__webView` mode expects TradeSea's own native
/// app around it: signed in, the trading area stayed empty and the balance
/// read "--". CHE opens TradeSea as the regular web app instead (desktop
/// Safari user agent, see [cheTradeSeaUserAgent]) and strips the embed flag,
/// including from older saved links.
String cheTradeSeaEmbedUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null || !cheIsTradeSeaUrl(url)) return url;
  if (uri.queryParameters['source'] != 'mobile-app') return uri.toString();
  final next = Map<String, String>.from(uri.queryParameters)..remove('source');
  if (next.isNotEmpty) return uri.replace(queryParameters: next).toString();
  return Uri(scheme: uri.scheme, host: uri.host, port: uri.hasPort ? uri.port : null, path: uri.path, fragment: uri.hasFragment ? uri.fragment : null).toString();
}

/// The user agent CHE's browser uses on TradeSea: the full web app, as Safari
/// on a Mac gets it.
const String cheTradeSeaUserAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

/// Phone apps with no usable web version. CHE says so plainly instead of
/// pretending she can get in.
const Map<String, String> cheAppsWithoutWeb = {
  'imessage': 'iMessage has no web version, so I can only draft the text and open Messages for you to send.',
  'facetime': 'FaceTime has no web version I can use, sir.',
  'iwebtv': 'iWebTV has no web version. I can open the app itself once you say yes, or play a video page in CHE\'s Theater.',
};

String? cheNoWebVersionReason(String input) {
  final value = input.toLowerCase();
  for (final entry in cheAppsWithoutWeb.entries) {
    if (value.contains(entry.key) || (entry.key == 'iwebtv' && value.contains('iweb'))) return entry.value;
  }
  return null;
}

typedef CheLearnPageCallback = Future<void> Function(
  String title,
  String url,
  String pageText,
);

class CheAppsHubTab extends StatefulWidget {
  const CheAppsHubTab({
    super.key,
    this.onLearnPage,
    this.agentBaseUrl = '',
    this.deviceToken = '',
  });

  final CheLearnPageCallback? onLearnPage;

  /// CHE Worker base URL + paired device token for native Grok chat.
  final String agentBaseUrl;
  final String deviceToken;

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
    await CheEmbeddedAppScreen.open(
      context,
      app: CheAppDefinition(
        name: uri.host.isEmpty ? 'Web App' : uri.host,
        webUrl: uri.toString(),
        icon: Icons.language,
        aliases: const [],
      ),
      onLearnPage: widget.onLearnPage,
    );
  }

  Future<void> _openEmbeddedWeb(CheAppDefinition app) async {
    await CheEmbeddedAppScreen.open(
      context,
      app: app,
      onLearnPage: widget.onLearnPage,
    );
  }

  Future<void> _openCatalogApp(CheAppDefinition app) async {
    // Grok opens the native Worker→xAI chat. Long-press (or overflow in
    // that screen) still opens grok.com in the in-app browser.
    if (app.name == 'Grok') {
      await CheGrokChatScreen.open(
        context,
        baseUrl: widget.agentBaseUrl,
        deviceToken: widget.deviceToken,
        onOpenWeb: () {
          CheEmbeddedAppScreen.open(
            context,
            app: app,
            onLearnPage: widget.onLearnPage,
          );
        },
      );
      return;
    }
    await _openEmbeddedWeb(app);
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        const Text('Apps inside CHE', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        const Text(
          'Web-capable services open without leaving CHE. Tap Grok for native Worker chat (long-press for grok.com). Native-only features use the official app when iOS or the service requires it.',
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
              onTap: () => _openCatalogApp(app),
              onLongPress: app.name == 'Grok'
                  ? () => _openEmbeddedWeb(app)
                  : null,
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
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    if (app.name == 'Grok')
                      const Text(
                        'Native',
                        style: TextStyle(fontSize: 10, color: CheColors.accent, fontWeight: FontWeight.w700),
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

  /// Shared launch for Apps, Trading, voice, and plugin UI.
  /// Expands open inside CHE. Does not leave for Safari unless the owner asks.
  static Future<void> open(
    BuildContext context, {
    required CheAppDefinition app,
    CheLearnPageCallback? onLearnPage,
  }) {
    return Navigator.of(context).push<void>(
      CheEmbeddedAppRoute<void>(
        settings: RouteSettings(name: 'che-embedded-app', arguments: app.name),
        builder: (_) => CheEmbeddedAppScreen(app: app, onLearnPage: onLearnPage),
      ),
    );
  }

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
