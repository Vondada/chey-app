// CHE Connections: one honest view over the EXISTING Command Center and
// OAuth connectors. No bank/broker secrets enter the iPhone UI or AI context.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../che_ui/che_theme.dart';

/// Spoken control for the Connections page while it is the open route.
class CheConnectionsVoice {
  CheConnectionsVoice._();
  static Future<String?> Function(String words)? handler;
}

// Google services: one sign-in each, with only that service's permissions.
const _googleLabels = {
  'gmail': 'Gmail',
  'drive': 'Google Drive',
  'calendar': 'Google Calendar',
  'google_ads': 'Google Ads',
};

// Connectors CHE has verified as signed in (never a key alone).
const _signedIn = {'youtube', 'broker', 'gmail', 'drive', 'calendar', 'google_ads'};

String _googleIdFor(String spoken) => spoken.contains('drive') ? 'drive'
    : spoken.contains('calendar') ? 'calendar'
    : spoken.contains('ads') ? 'google_ads'
    : 'gmail';

class CheConnectionsScreen extends StatefulWidget {
  const CheConnectionsScreen({
    super.key,
    required this.baseUrl,
    required this.headers,
    required this.onVoiceSettings,
    required this.onKeys,
    this.client,
    this.onSpeak,
    this.autoConnect = '',
  });

  final String baseUrl;
  final Map<String, String> Function() headers;
  final VoidCallback onVoiceSettings;
  final VoidCallback onKeys;
  final http.Client? client;
  final ValueChanged<String>? onSpeak;
  /// 'youtube' or 'broker' starts that one official sign-in once the page opens.
  final String autoConnect;

  @override
  State<CheConnectionsScreen> createState() => _CheConnectionsScreenState();
}

class _CheConnectionsScreenState extends State<CheConnectionsScreen> {
  late final http.Client _client = widget.client ?? http.Client();

  @override
  void dispose() {
    if (CheConnectionsVoice.handler == _voice) CheConnectionsVoice.handler = null;
    if (widget.client == null) _client.close();
    super.dispose();
  }
  Map<String, dynamic> _connectors = {};
  bool _loading = true;
  bool _connecting = false;
  // A spoken disconnect waits for its own yes before anything is removed.
  String? _pendingDisconnect;
  String _error = '';
  String _message = '';

  @override
  void initState() {
    super.initState();
    CheConnectionsVoice.handler = _voice;
    unawaited(_refresh());
    if (widget.autoConnect == 'youtube') {
      WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_connectYoutube()));
    } else if (widget.autoConnect == 'broker') {
      WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_connectBroker()));
    } else if (_googleLabels.containsKey(widget.autoConnect)) {
      final service = widget.autoConnect;
      WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_connectGoogle(service)));
    }
  }

  Future<void> _refresh({bool announce = false}) async {
    setState(() { _loading = true; _error = ''; _message = ''; });
    try {
      final r = await _client.get(
        Uri.parse('${widget.baseUrl}/api/commands'),
        headers: widget.headers(),
      ).timeout(const Duration(seconds: 18));
      if (r.statusCode != 200) {
        throw StateError(r.statusCode == 401 ? 'Pair this iPhone to CHE first.' : 'CHE returned HTTP ${r.statusCode}');
      }
      final raw = jsonDecode(utf8.decode(r.bodyBytes));
      if (raw is! Map || raw['connectors'] is! Map) {
        throw const FormatException('CHE did not return verified connector states.');
      }
      if (!mounted) return;
      setState(() { _connectors = Map<String, dynamic>.from(raw['connectors'] as Map); });
      if (announce) {
        HapticFeedback.selectionClick();
        final youtube = _status('youtube');
        final broker = _status('broker');
        final note = 'Connection check complete. YouTube: $youtube. NinjaTrader: $broker. Bank linking remains unavailable.';
        setState(() => _message = note);
        widget.onSpeak?.call(note);
      }
    } on Object catch (e) {
      if (!mounted) return;
      // Never reuse stale "Connected" labels after a network/auth error.
      setState(() {
        _connectors = {};
        _error = e is TimeoutException ? 'CHE did not answer in time.' : e.toString().replaceFirst('Bad state: ', '');
      });
      if (announce) {
        HapticFeedback.heavyImpact();
        widget.onSpeak?.call('I could not verify the connections, sir. $_error');
      }
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
      'ready' => _signedIn.contains(connector) ? 'Connected' : 'Configured',
      'needs_reconnect' => 'Needs Reconnect',
      'not_connected' => 'Needs Setup',
      'unavailable' => 'Unavailable',
      'none' => 'Unsupported',
      _ => 'Unavailable',
    };
  }

  String _detail(String? connector, String fallback) {
    if (connector == null) return fallback;
    if (_error.isNotEmpty) return 'Cannot verify connection: $_error';
    final actual = _actual(connector);
    if (actual.isEmpty) return _loading ? 'Checking with CHE…' : 'CHE has not confirmed this service.';
    final detail = (actual['detail'] ?? '').toString().trim();
    if (detail.isNotEmpty) return detail;
    return _status(connector) == 'Configured'
        ? 'Server credentials exist; a live account session has not been verified.'
        : fallback;
  }

  // Spoken control while this page is the open route. Unrecognized speech goes to Chat.
  Future<String?> _voice(String words) async {
    if (ModalRoute.of(context)?.isCurrent == false) return null;
    final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '')
        .replaceFirst(RegExp(r'^(?:hey\s+)?(?:che|chay|chey)[,:]?\s+'), '').trim();
    if (RegExp(r'^(?:go back|back|close)$').hasMatch(t)) {
      final speak = widget.onSpeak;
      final closed = await Navigator.of(context).maybePop();
      if (closed) {
        HapticFeedback.selectionClick();
        speak?.call('Closed CHE Connections.');
      } else {
        HapticFeedback.heavyImpact();
        _say('I could not close CHE Connections.');
      }
      return '';
    }
    if (RegExp(r'^(?:refresh|reload|check|verify)\s+(?:my\s+|the\s+)?(?:connections?|connected accounts|integrations?|status)$').hasMatch(t)) {
      await _refresh(announce: true);
      return '';
    }
    if (RegExp(r'^connect\s+(?:my\s+)?(?:youtube(?: channel)?|google account)$').hasMatch(t)) {
      await _connectYoutube();
      return '';
    }
    final pending = _pendingDisconnect;
    if (pending != null) {
      _pendingDisconnect = null;
      if (RegExp(r'^(?:yes|yeah|yep|do it|go ahead)$').hasMatch(t)) {
        await _runDisconnect(pending);
        return '';
      }
      if (RegExp(r'^(?:no|nope|cancel|never mind|stop)$').hasMatch(t)) {
        _say('Disconnect cancelled. Nothing was removed.');
        return '';
      }
    }
    final disconnect = RegExp(r'^(?:disconnect|remove|sign out of)\s+(?:my\s+|the\s+)?(gmail|(?:google\s+)?drive|(?:google\s+)?calendar|google ads)$').firstMatch(t);
    if (disconnect != null) {
      final service = _googleIdFor(disconnect.group(1)!);
      _pendingDisconnect = service;
      _say('Disconnect ${_googleLabels[service]}? CHE revokes its access at Google. Say yes to disconnect, or no to cancel.');
      return '';
    }
    final google = RegExp(r'^connect\s+(?:my\s+|the\s+)?(gmail|(?:google\s+)?drive|(?:google\s+)?calendar|google ads)$').firstMatch(t);
    if (google != null) {
      await _connectGoogle(_googleIdFor(google.group(1)!));
      return '';
    }
    if (RegExp(r'^connect\s+(?:my\s+)?(?:ninjatrader|tradovate)(?: account)?$').hasMatch(t)) {
      await _connectBroker();
      return '';
    }
    return null;
  }

  // Every owner-triggered connect result is shown and spoken, never only shown.
  void _say(String line) {
    if (mounted) setState(() => _message = line);
    widget.onSpeak?.call(line);
  }

  Future<void> _connectYoutube() async {
    if (_connecting) return;
    setState(() { _connecting = true; _message = ''; });
    try {
      final r = await _client.post(
        Uri.parse('${widget.baseUrl}/api/youtube/connect/start'),
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
      final opened = await launchUrl(uri, mode: LaunchMode.externalApplication).catchError((_) => false);
      if (!opened) throw StateError('Could not open the official Google sign-in page.');
      HapticFeedback.selectionClick();
      _say('Approve YouTube on Google’s secure page, then return to CHE and press Refresh. No channel connection is claimed yet.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('YouTube: ${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  // Gmail, Drive, Calendar and Google Ads: each its own Google sign-in.
  Future<void> _connectGoogle(String service) async {
    if (_connecting) return;
    final label = _googleLabels[service] ?? 'Google';
    setState(() { _connecting = true; _message = ''; });
    try {
      final r = await _client.post(
        Uri.parse('${widget.baseUrl}/api/google/connect/start'),
        headers: {...widget.headers(), 'content-type': 'application/json'},
        body: jsonEncode({'service': service}),
      ).timeout(const Duration(seconds: 18));
      final raw = jsonDecode(utf8.decode(r.bodyBytes));
      final data = raw is Map ? raw : <String, dynamic>{};
      final uri = Uri.tryParse((data['url'] ?? '').toString());
      if (r.statusCode != 200 || uri == null || uri.scheme != 'https' ||
          (uri.host != 'accounts.google.com' && uri.host != 'google.com')) {
        throw StateError((data['detail'] ?? '$label sign-in is not configured. Open Keys for setup.').toString());
      }
      final opened = await launchUrl(uri, mode: LaunchMode.externalApplication).catchError((_) => false);
      if (!opened) throw StateError('Could not open the official Google sign-in page.');
      HapticFeedback.selectionClick();
      _say('Approve $label on Google’s secure page, then return to CHE and press Refresh. Only $label permissions are requested. No access is claimed until Refresh confirms it.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('$label: ${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  // Removing a Google connection asks first, by button or by voice.
  Future<void> _disconnectGoogle(String service) async {
    final label = _googleLabels[service] ?? 'Google';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Disconnect $label?'),
        content: Text('CHE revokes its $label access at Google and stops using it. Nothing is deleted from $label.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Disconnect')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    await _runDisconnect(service);
  }

  Future<void> _runDisconnect(String service) async {
    final label = _googleLabels[service] ?? 'Google';
    setState(() { _connecting = true; _message = ''; });
    try {
      final r = await _client.post(
        Uri.parse('${widget.baseUrl}/api/google/disconnect'),
        headers: {...widget.headers(), 'content-type': 'application/json'},
        body: jsonEncode({'service': service}),
      ).timeout(const Duration(seconds: 18));
      final raw = jsonDecode(utf8.decode(r.bodyBytes));
      final data = raw is Map ? raw : <String, dynamic>{};
      if (r.statusCode != 200) throw StateError((data['detail'] ?? 'CHE could not disconnect $label.').toString());
      final revoked = data['revoked_at_google'] == true;
      await _refresh();
      HapticFeedback.selectionClick();
      _say(revoked
          ? '$label disconnected. Google access was revoked.'
          : '$label removed from CHE. Google did not confirm the revoke, so check your Google Account permissions.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('$label: ${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Future<void> _connectBroker() async {
    if (_connecting) return;
    setState(() { _connecting = true; _message = ''; });
    try {
      final r = await _client.post(
        Uri.parse('${widget.baseUrl}/api/broker/tradovate/connect/start'),
        headers: {...widget.headers(), 'content-type': 'application/json'},
        body: '{}',
      ).timeout(const Duration(seconds: 18));
      final raw = jsonDecode(utf8.decode(r.bodyBytes));
      final data = raw is Map ? raw : <String, dynamic>{};
      final uri = Uri.tryParse((data['url'] ?? '').toString());
      if (r.statusCode != 200 || uri == null || uri.scheme != 'https' ||
          uri.host != 'trader.tradovate.com') {
        throw StateError((data['detail'] ?? 'Tradovate OAuth application is not configured.').toString());
      }
      final opened = await launchUrl(uri, mode: LaunchMode.externalApplication).catchError((_) => false);
      if (!opened) throw StateError('Could not open the official Tradovate sign-in.');
      HapticFeedback.selectionClick();
      _say('Authorize with Tradovate, then return to CHE and Refresh. No broker connection or trade is claimed until confirmed.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('NinjaTrader: ${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Widget _card(String title, IconData icon, String? connector, String explanation,
      {VoidCallback? onAction, String action = 'Connect', VoidCallback? onDisconnect}) {
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
      label: '$title. $status. ${_detail(connector, explanation)}',
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
            if (onDisconnect != null && _status(connector) == 'Connected') ...[
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: _loading || _connecting ? null : onDisconnect,
                child: const Text('Disconnect'),
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
            onPressed: _loading ? null : () => unawaited(_refresh(announce: true)),
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: SafeArea(child: RefreshIndicator(
        onRefresh: () => _refresh(announce: true),
        child: ListView(padding: const EdgeInsets.all(16), children: [
          const Text('One app. Real connections.', style: TextStyle(fontSize: 23, fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          const Text('CHE verifies status with her Worker. A configured API key is not proof of a signed-in account. Account passwords stay with their providers.',
            style: TextStyle(color: CheColors.textDim)),
          if (_loading) const LinearProgressIndicator(),
          if (_error.isNotEmpty) Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text('Connection check failed: $_error', style: const TextStyle(color: CheColors.warning)),
          ),
          if (_message.isNotEmpty) Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Semantics(liveRegion: true,
              child: Text(_message, style: const TextStyle(color: CheColors.accent, fontSize: 18, height: 1.3))),
          ),
          _heading('Google & creators'),
          _card('YouTube channel', Icons.play_circle_outline_rounded, 'youtube',
              'Use CHE’s existing Google OAuth connection. Publishing still requires approval.',
              onAction: _connectYoutube, action: 'Connect with Google'),
          _card('Gmail', Icons.mail_outline_rounded, 'gmail',
              'Reads your mail and sends email only when you say yes. Approved separately from YouTube.',
              onAction: () => _connectGoogle('gmail'), action: 'Connect Gmail',
              onDisconnect: () => _disconnectGoogle('gmail')),
          _card('Google Drive', Icons.folder_outlined, 'drive',
              'Sees only files CHE creates or you open with it. Creating a doc waits for your yes.',
              onAction: () => _connectGoogle('drive'), action: 'Connect Drive',
              onDisconnect: () => _disconnectGoogle('drive')),
          _card('Google Calendar', Icons.event_note_rounded, 'calendar',
              'Reads your primary calendar. Adding an event waits for your yes.',
              onAction: () => _connectGoogle('calendar'), action: 'Connect Calendar',
              onDisconnect: () => _disconnectGoogle('calendar')),
          _heading('Trading'),
          _card('NinjaTrader / Tradovate', Icons.candlestick_chart_rounded, 'broker',
              'Use the existing Tradovate sign-in route. Orders require your separate approval.',
              onAction: _connectBroker, action: 'Connect NinjaTrader'),
          _card('FundYourEdge funded account', Icons.account_balance_wallet_outlined, 'fundyouredge',
              'Rithmic account. CHE cannot read or trade it until a licensed Rithmic connection exists.'),
          _heading('Banks & finances'),
          _card('Bank accounts — read only', Icons.account_balance_outlined, null,
              'No secure bank-link provider is configured. CHE cannot see balances or transactions. Do not enter bank passwords in Chat.'),
          _card('Payments / Stripe', Icons.receipt_long_rounded, 'stripe',
              'Stripe API configuration only. No bank account access or permission to move money.',
              onAction: widget.onKeys, action: 'Review Keys'),
          _heading('Business & development'),
          _card('Google Ads', Icons.campaign_outlined, 'google_ads',
              'Read-only campaign results. Needs Setup until Google confirms CHE’s access to your accounts.',
              onAction: () => _connectGoogle('google_ads'), action: 'Connect Google Ads',
              onDisconnect: () => _disconnectGoogle('google_ads')),
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
