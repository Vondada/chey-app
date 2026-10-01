import 'dart:convert';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'che_app_portal.dart';

/// The catalog lives on CHE's server; the phone only displays approved entries.
class ChePluginManager extends StatefulWidget {
  const ChePluginManager({
    super.key,
    required this.baseUrl,
    required this.deviceToken,
  });

  final String baseUrl;
  final String deviceToken;

  static Future<void> open(BuildContext context, String baseUrl, String token) async {
    await Navigator.of(context).push<void>(CupertinoPageRoute(
      builder: (_) => ChePluginManager(baseUrl: baseUrl, deviceToken: token),
    ));
  }

  @override
  State<ChePluginManager> createState() => _ChePluginManagerState();
}

class _ChePluginManagerState extends State<ChePluginManager> {
  List<Map<String, dynamic>> plugins = [];
  String? error;
  String? busyId;
  bool loading = true;

  Map<String, String> get headers => {
    'Authorization': 'Bearer ${widget.deviceToken}',
    'Content-Type': 'application/json',
  };

  @override
  void initState() {
    super.initState();
    refresh();
  }

  void updateFromResponse(http.Response response) {
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode != 200) {
      throw Exception(data['detail']?.toString() ?? 'CHE could not load plugins.');
    }
    plugins = (data['plugins'] as List? ?? const [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  Future<void> refresh() async {
    try {
      final response = await http.get(
        Uri.parse('${widget.baseUrl}/api/plugins'), headers: headers,
      ).timeout(const Duration(seconds: 12));
      if (!mounted) return;
      setState(() {
        updateFromResponse(response);
        error = null;
        loading = false;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          error = 'Could not load plugins. Check CHE’s connection and pairing.';
          loading = false;
        });
      }
    }
  }

  Future<void> toggle(String id, bool enabled) async {
    setState(() { busyId = id; error = null; });
    try {
      final response = await http.post(
        Uri.parse('${widget.baseUrl}/api/plugins/toggle'),
        headers: headers,
        body: jsonEncode({'id': id, 'enabled': enabled}),
      ).timeout(const Duration(seconds: 12));
      if (!mounted) return;
      setState(() { updateFromResponse(response); busyId = null; });
    } catch (e) {
      if (mounted) {
        setState(() {
          error = e.toString().replaceFirst('Exception: ', '');
          busyId = null;
        });
      }
    }
  }

  String? twilioStatusLine;
  String? stripeStatusLine;

  Future<void> testTwilio() async {
    setState(() { busyId = 'twilio_sms'; error = null; twilioStatusLine = null; });
    try {
      final response = await http.get(
        Uri.parse('${widget.baseUrl}/api/twilio/status'),
        headers: headers,
      ).timeout(const Duration(seconds: 12));
      if (!mounted) return;
      final data = jsonDecode(response.body);
      if (data is! Map) throw Exception('Bad status response.');
      final connected = data['connected'] == true;
      final missing = (data['missing_secrets'] as List? ?? const []).map((e) => e.toString()).join(', ');
      setState(() {
        busyId = null;
        twilioStatusLine = connected
            ? 'Twilio connected for CHE (secrets present; values never shown).'
            : 'Not connected. Set via wrangler secret put: ${missing.isEmpty ? 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER' : missing}. See docs/TWILIO_CHE.md.';
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          busyId = null;
          error = e.toString().replaceFirst('Exception: ', '');
        });
      }
    }
  }

  Future<void> testStripe() async {
    setState(() { busyId = 'stripe_payments'; error = null; stripeStatusLine = null; });
    try {
      final response = await http.get(
        Uri.parse('${widget.baseUrl}/api/stripe/status'),
        headers: headers,
      ).timeout(const Duration(seconds: 12));
      if (!mounted) return;
      final data = jsonDecode(response.body);
      if (data is! Map) throw Exception('Bad status response.');
      final connected = data['connected'] == true;
      final missing = (data['missing_secrets'] as List? ?? const []).map((e) => e.toString()).join(', ');
      final mode = data['mode']?.toString() ?? 'unknown';
      final webhook = data['webhook_configured'] == true;
      setState(() {
        busyId = null;
        stripeStatusLine = connected
            ? 'Stripe connected for CHE (mode: $mode; secret values never shown). Webhook secret: ${webhook ? 'set' : 'missing — paste STRIPE_WEBHOOK_SECRET after Dashboard webhook'}.'
            : 'Not connected. Paste via wrangler secret put: ${missing.isEmpty ? 'STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET' : missing}. See docs/STRIPE_CHE.md.';
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          busyId = null;
          error = e.toString().replaceFirst('Exception: ', '');
        });
      }
    }
  }

  Future<void> showStripePasteHint() async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Paste Stripe keys'),
        content: const SingleChildScrollView(
          child: Text(
            'Keys stay on the Worker — never commit them.\n\n'
            'From server/cloudflare (Node 22+):\n'
            '  npx wrangler secret put STRIPE_SECRET_KEY\n'
            '  npx wrangler secret put STRIPE_PUBLISHABLE_KEY\n'
            '  npx wrangler secret put STRIPE_WEBHOOK_SECRET\n\n'
            'Dashboard → Developers → Webhooks → Add endpoint:\n'
            '  https://chey-app.henryjavoni.workers.dev/api/stripe/webhook\n'
            'Events: charge.succeeded, charge.refunded\n'
            'Copy Signing secret → STRIPE_WEBHOOK_SECRET.\n\n'
            'Then tap Test connection. See docs/STRIPE_CHE.md.',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('CHE Plugins')),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text('CHE capabilities live here. Enable only the services you want CHE to use. CHE is Office Boss — only she sends SMS.'),
            const SizedBox(height: 12),
            if (error != null) Text(error!, style: const TextStyle(color: Colors.orangeAccent)),
            if (twilioStatusLine != null) Text(twilioStatusLine!, style: const TextStyle(color: Colors.lightBlueAccent)),
            if (stripeStatusLine != null) Text(stripeStatusLine!, style: const TextStyle(color: Colors.lightBlueAccent)),
            if (loading) const Center(child: CircularProgressIndicator()),
            if (!loading && plugins.isEmpty)
              const ListTile(
                title: Text('No plugins connected yet'),
                subtitle: Text('Add CHE_PLUGIN_CATALOG on the Worker, or install Skill plugins (Weather, Crypto, Wikipedia) from the Plugins room.'),
              ),
            for (final plugin in plugins)
              Card(
                child: Column(
                  children: [
                    SwitchListTile(
                      title: Text(plugin['name']?.toString() ?? plugin['id'].toString()),
                      subtitle: Text(
                        '${plugin['description'] ?? ''}\n'
                        '${plugin['kind'] == 'skill' ? 'Builtin skill · install from Skill plugins' : (plugin['ready'] == true ? 'Ready' : 'Needs secure server setup')}'
                        ' · ${(plugin['mode'] ?? 'read').toString().toUpperCase()}'
                        '${plugin['requires_confirmation'] == true ? ' · Confirms before actions' : ''}'
                        '\n${plugin['security'] ?? 'HTTPS connector · secrets stay server-side'}',
                      ),
                      isThreeLine: true,
                      value: plugin['enabled'] == true,
                      onChanged: plugin['ready'] == true &&
                              plugin['toggleable'] != false &&
                              plugin['kind'] != 'skill' &&
                              busyId == null
                          ? (value) => toggle(plugin['id'].toString(), value)
                          : null,
                    ),
                    if ((plugin['ui_url']?.toString() ?? '').startsWith('https://'))
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton.icon(
                          onPressed: plugin['enabled'] == true
                              ? () {
                                  final app = CheAppDefinition(
                                    name: plugin['name']?.toString() ?? 'CHE Plugin',
                                    webUrl: plugin['ui_url'].toString(),
                                    icon: Icons.extension,
                                    aliases: const [],
                                  );
                                  CheEmbeddedAppScreen.open(context, app: app);
                                }
                              : null,
                          icon: const Icon(Icons.open_in_new),
                          label: const Text('OPEN PLUGIN UI'),
                        ),
                      ),
                    if (plugin['id']?.toString() == 'twilio_sms') ...[
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                        child: Text(
                          plugin['connect_hint']?.toString() ??
                              'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER with wrangler secret put. Values never leave the Worker. See docs/TWILIO_CHE.md.',
                          style: const TextStyle(fontSize: 12, color: Colors.white70),
                        ),
                      ),
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton.icon(
                          onPressed: busyId == null ? testTwilio : null,
                          icon: Icon(busyId == 'twilio_sms' ? Icons.hourglass_top : Icons.health_and_safety_outlined),
                          label: Text(busyId == 'twilio_sms' ? 'TESTING…' : 'TEST CONNECTION'),
                        ),
                      ),
                    ],
                    if (plugin['id']?.toString() == 'stripe_payments') ...[
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                        child: Text(
                          plugin['connect_hint']?.toString() ??
                              'Paste STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET with wrangler secret put. Values never leave the Worker. See docs/STRIPE_CHE.md.',
                          style: const TextStyle(fontSize: 12, color: Colors.white70),
                        ),
                      ),
                      Align(
                        alignment: Alignment.centerRight,
                        child: Wrap(
                          spacing: 8,
                          children: [
                            TextButton.icon(
                              onPressed: busyId == null ? showStripePasteHint : null,
                              icon: const Icon(Icons.content_paste_go_outlined),
                              label: const Text('PASTE KEYS'),
                            ),
                            TextButton.icon(
                              onPressed: busyId == null ? testStripe : null,
                              icon: Icon(busyId == 'stripe_payments' ? Icons.hourglass_top : Icons.health_and_safety_outlined),
                              label: Text(busyId == 'stripe_payments' ? 'TESTING…' : 'TEST CONNECTION'),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
