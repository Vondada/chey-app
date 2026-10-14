// CHE Connections: one honest view over the EXISTING Command Center and
// OAuth connectors. No bank/broker secrets enter the iPhone UI or AI context.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../che_ui/che_theme.dart';

class CheConnectionsScreen extends StatefulWidget {
  const CheConnectionsScreen({
    super.key,
    required this.baseUrl,
    required this.headers,
    required this.onBrokerConnect,
    required this.onVoiceSettings,
    required this.onKeys,
  });

  final String baseUrl;
  final Map<String, String> Function() headers;
  final VoidCallback onBrokerConnect;
  final VoidCallback onVoiceSettings;
  final VoidCallback onKeys;

  @override
  State<CheConnectionsScreen> createState() => _CheConnectionsScreenState();
}

class _CheConnectionsScreenState extends State<CheConnectionsScreen> {
  Map<String, dynamic> _connectors = {};
  bool _loading = true;
  bool _connecting = false;
  String _error = '';
  String _message = '';

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    setState(() { _loading = true; _error = ''; });
    try {
      final r = await http.get(
        Uri.parse(widget.baseUrl + '/api/commands'),
        headers: widget.headers(),
      ).timeout(const Duration(seconds: 18));
      if (r.statusCode != 200) {
        throw StateError(r.statusCode == 401 ? 'Pair this iPhone to CHE first.' : 'CHE returned HTTP ' + r.statusCode.toString());
      }
      final raw = jsonDecode(utf8.decode(r.bodyBytes));
      if (raw is! Map || raw['connectors'] is! Map) {
        throw const FormatException('CHE did not return verified connector states.');
      }
      if (!mounted) return;
      setState(() { _connectors = Map<String, dynamic>.from(raw['connectors'] as Map); });
    } on Object catch (e) {
      if (!mounted) return;
      // Never reuse stale "Connected" labels after a network/auth error.
      setState(() {
        _connectors = {};
        _error = e is TimeoutException ? 'CHE did not answer in time.' : e.toString().replaceFirst('Bad state: ', '');
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Map<String, dynamic> _actual(String id) {
    final value = _connectors[id];
    return value is Map ? Map<String, dynamic>.from(value) : {};
  }

  String _status(String? connector) {
    if (connector == null) return 'Unsupported';
    if (_error.isNotEmpty || _loading && _connectors.isEmpty) return 'Unavailable';
    return switch (_actual(connector)['state']?.toString()) {
      'ready' => connector == 'youtube' || connector == 'broker' ? 'Connected' : 'Configured',
      'needs_reconnect' => 'Needs Reconnect',
      'not_connected' => 'Needs Setup',
      'unavailable' => 'Unavailable',
      'none' => 'Unsupported',
      _ => 'Unavailable',
    };
  }

  String _detail(String? connector, String fallback) {
    if (connector == null) return fallback;
    if (_error.isNotEmpty) return 'Cannot verify connection: ' + _error;
    final actual = _actual(connector);
    if (actual.isEmpty) return _loading ? 'Checking with CHE…' : 'CHE has not confirmed this service.';
    final detail = (actual['detail'] ?? '').toString().trim();
    if (detail.isNotEmpty) return detail;
    return _status(connector) == 'Configured'
        ? 'Server credentials exist; a live account session has not been verified.'
        : fallback;
  }

  Future<void> _connectYoutube() async {
    if (_connecting) return;
    setState(() { _connecting = true; _message = ''; });
    try {
      final r = await http.post(
        Uri.parse(widget.baseUrl + '/api/youtube/connect/start'),
        headers: {...widget.headers(), 'content-type': 'application/json'},
        body: '{}',
      ).timeout(const Duration(seconds: 18));
      final raw = jsonDecode(utf8.decode(r.bodyBytes));
      final data = raw is Map ? raw : <String, dynamic>{};
      final address = (data['url'] ?? '').toString();
      final uri = Uri.tryParse(address);
      if (r.statusCode != 200 || uri == null || uri.scheme != 'https' ||
          (uri.host != 'accounts.google.com' && uri.host != 'google.com')) {
        throw StateError((data['detail'] ?? 'Google sign-in is not configured. Open Keys for setup.').toString());
      }
      // Google requires trusted browser authentication. No Google password
      // or refresh token may be collected by the CHE Flutter view.
      final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!opened) throw StateError('Could not open the official Google sign-in page.');
      if (mounted) setState(() => _message = 'Approve YouTube on Google’s secure page, then return to CHE and press Refresh. No channel connection is claimed yet.');
    } on Object catch (e) {
      if (mounted) {
        HapticFeedback.heavyImpact();
        setState(() => _message = 'YouTube: ' + e.toString().replaceFirst('Bad state: ', ''));
      }
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Widget _card(String title, IconData icon, String? connector, String explanation,
      {VoidCallback? onAction, String action = 'Connect'}) {
    final status = _status(connector);
    final color = switch (status) {
      'Connected' => CheColors.success,
      'Configured' => CheColors.accent,
      'Needs Reconnect' => CheColors.warning,
      'Needs Setup' => CheColors.warning,
      'Unsupported' => CheColors.textDim,
      _ => CheColors.danger,
    };
    return Semantics(
      label: '$title. $status. ' + _detail(connector, explanation),
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        decoration: BoxDecoration(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: CheColors.stroke),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(icon, color: CheColors.accent, size: 22),
              const SizedBox(width: 10),
              Expanded(child: Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700))),
              Text(status, style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w700)),
            ]),
            const SizedBox(height: 7),
            Text(_detail(connector, explanation), style: const TextStyle(color: CheColors.textDim, height: 1.3)),
            if (onAction != null) ...[
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: _loading || _connecting ? null : onAction,
                child: Text(action),
              ),
            ],
          ]),
        ),
      ),
    );
  }

  Widget _heading(String text) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: Text(text.toUpperCase(), style: const TextStyle(fontWeight: FontWeight.w800, color: CheColors.accent, letterSpacing: 1.2)),
  );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(
        title: const Text('Connections'),
        actions: [
          IconButton(
            tooltip: 'Refresh verified connections',
            onPressed: _loading ? null : _refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: SafeArea(child: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          const Text('One app. Real connections.', style: TextStyle(fontSize: 23, fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          const Text('CHE verifies status with her Worker. A configured API key is not proof of a signed-in account. Account passwords stay with their providers.',
            style: TextStyle(color: CheColors.textDim)),
          if (_loading) const LinearProgressIndicator(),
          if (_error.isNotEmpty) Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text('Connection check failed: ' + _error, style: const TextStyle(color: CheColors.warning)),
          ),
          if (_message.isNotEmpty) Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(_message, style: const TextStyle(color: CheColors.accent)),
          ),
          _heading('Google & creators'),
          _card('YouTube channel', Icons.play_circle_outline_rounded, 'youtube',
              'Use CHE’s existing Google OAuth connection. Publishing still requires approval.',
              onAction: _connectYoutube, action: 'Connect with Google'),
          _card('Google Drive', Icons.folder_outlined, null,
              'Google Drive OAuth and file permissions are not implemented in CHE yet.'),
          _card('Gmail', Icons.mail_outline_rounded, null,
              'Gmail access is not configured. YouTube permissions do not grant email access.'),
          _card('Google Calendar', Icons.event_note_rounded, null,
              'Calendar OAuth and event permissions are not implemented yet.'),
          _heading('Trading'),
          _card('NinjaTrader / Tradovate', Icons.candlestick_chart_rounded, 'broker',
              'Use the existing Tradovate sign-in route. Orders require your separate approval.',
              onAction: widget.onBrokerConnect, action: 'Connect NinjaTrader'),
          _heading('Banks & finances'),
          _card('Bank accounts — read only', Icons.account_balance_outlined, null,
              'No secure bank-link provider is configured. CHE cannot see balances or transactions. Do not enter bank passwords in Chat.'),
          _card('Payments / Stripe', Icons.receipt_long_rounded, 'stripe',
              'Stripe API configuration only. No bank account access or permission to move money.',
              onAction: widget.onKeys, action: 'Review Keys'),
          _heading('Business & development'),
          _card('GitHub code integration', Icons.code_rounded, 'github',
              'Code credentials may be configured. Verify each action and deployment receipt.',
              onAction: widget.onKeys, action: 'Review Keys'),
          _card('Website hosting', Icons.language_rounded, 'site_hosting',
              'CHE can serve sites in her existing system; no external hosting account is implied.'),
          _card('Client scouting', Icons.groups_outlined, 'research',
              'Public research is available. CHE cannot access private customer accounts without authorization.'),
          _heading('Voice'),
          _card('CHE voice', Icons.record_voice_over_outlined, 'voice',
              'Natural voice keys may be configured. Change local voices, or select a supported cloud voice inside CHE.',
              onAction: widget.onVoiceSettings, action: 'Change CHE’s voice'),
          const SizedBox(height: 10),
          const Text('Secure Google or broker login may temporarily open the provider’s official consent screen. CHE cannot bypass that requirement.', style: TextStyle(color: CheColors.textDim, fontSize: 12)),
          const SizedBox(height: 24),
        ]),
      )),
    );
  }
}
