// Search bar for the keys page. Suggestions are a catalog, not connected keys.

import 'package:flutter/material.dart';

const keyCatalog = <String>[
  'YouTube', 'Google', 'Gemini', 'Gmail', 'OpenAI', 'Grok', 'xAI', 'Anthropic', 'Claude',
  'GitHub', 'Cloudflare', 'Stripe', 'Pexels', 'Pixabay', 'ElevenLabs', 'DeepSeek',
  'Twilio', 'Shopify', 'Notion', 'Slack', 'Discord', 'Reddit', 'X', 'TikTok',
  'Instagram', 'Meta', 'CapCut', 'Kling', 'Luma', 'Runway', 'Pika', 'Hailuo',
  'Tradovate', 'NinjaTrader', 'TradingView', 'Coinbase', 'Supabase', 'Firebase',
  'AWS', 'Azure', 'Vercel', 'Netlify', 'Resend', 'SendGrid', 'Mapbox', 'Figma',
];

class CheKeySearch extends StatefulWidget {
  const CheKeySearch({super.key, this.onPick});

  final ValueChanged<String>? onPick;

  @override
  State<CheKeySearch> createState() => _CheKeySearchState();
}

class _CheKeySearchState extends State<CheKeySearch> {
  final _controller = TextEditingController();
  var _query = '';

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hits = keyCatalog.where((name) => name.toLowerCase().contains(_query.toLowerCase())).toList();
    return Column(
      children: [
        TextField(
          controller: _controller,
          decoration: const InputDecoration(hintText: 'Search keys', prefixIcon: Icon(Icons.search)),
          onChanged: (value) => setState(() => _query = value.trim()),
        ),
        for (final name in hits.take(12))
          ListTile(
            title: Text(name),
            subtitle: const Text('Not connected. Paste a token to save it.'),
            onTap: () => widget.onPick?.call(name),
          ),
      ],
    );
  }
}
