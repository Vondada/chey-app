// Read-only visual receipts from Alpaca PAPER; no broker order action.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../che_ui/che_screen_awareness.dart';
import '../che_wake_match.dart';
import 'package:http/http.dart' as http;

class CheAlpacaPaperPanel extends StatefulWidget {
  const CheAlpacaPaperPanel({
    super.key, required this.baseUrl, required this.headers,
    this.client, this.onRead, this.refresh = const Duration(seconds: 30),
  });
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  final void Function(String)? onRead;
  final Duration refresh;

  @override
  State<CheAlpacaPaperPanel> createState() => _CheAlpacaPaperPanelState();
}

class _CheAlpacaPaperPanelState extends State<CheAlpacaPaperPanel> {
  late final http.Client _client = widget.client ?? http.Client();
  Timer? _timer;
  List<Map<String, dynamic>> _orders = const [];
  String _notice = 'Reading broker-confirmed paper orders…';
  String? _equity;
  DateTime? _checked;
  bool _loading = false;
  bool _stale = false;
  Object? _voiceToken;

  @override
  void initState() {
    super.initState();
    _voiceToken = CheScreenAwareness.registerVoice(context, _voice);
    unawaited(_load());
    _timer = Timer.periodic(widget.refresh, (_) => unawaited(_load()));
  }

  @override
  void dispose() {
    CheScreenAwareness.unregister(_voiceToken);
    _timer?.cancel();
    if (widget.client == null) _client.close();
    super.dispose();
  }

  Future<Map<String, dynamic>> _get(String path) async {
    final r = await _client.get(Uri.parse(widget.baseUrl() + path),
        headers: widget.headers()).timeout(const Duration(seconds: 20));
    final decoded = jsonDecode(utf8.decode(r.bodyBytes));
    if (r.statusCode != 200 || decoded is! Map) {
      throw StateError('CHE could not read the Alpaca paper account.');
    }
    return Map<String, dynamic>.from(decoded);
  }

  Future<void> _load({bool requested = false}) async {
    if (_loading) return;
    _loading = true;
    var verified = false;
    try {
      final responses = await Future.wait([
        _get('/api/trading/alpaca/orders'),
        _get('/api/trading/connections').catchError((Object _) => <String, dynamic>{}),
      ]);
      final orders = responses[0];
      final connections = (responses[1]['cards'] as List? ?? const []);
      final alpaca = connections.whereType<Map>().firstWhere(
        (v) => v['id'] == 'alpaca', orElse: () => const {},
      );
      final account = alpaca['account'];
      if (!mounted) return;
      if (orders['ok'] != true) {
        setState(() {
          _orders = const [];
          _equity = null;
          _notice = orders['state'] == 'not_configured'
              ? 'Connect Alpaca PAPER in Trading connections to view orders.'
              : 'Alpaca paper orders could not be verified just now.';
        });
        return;
      }
      setState(() {
        verified = true;
        _stale = false;
        _orders = (orders['orders'] as List? ?? const []).whereType<Map>()
            .map((m) => Map<String, dynamic>.from(m)).toList();
        _equity = alpaca['state'] == 'verified' && account is Map && account['equity'] != null
            ? _money(account['equity']) : null;
        _checked = DateTime.now();
        _notice = _orders.isEmpty ? 'No Alpaca paper orders recorded by the broker.' : '';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _stale = true;
        _notice = 'Refresh failed. Any orders below are old, not a live status.';
      });
    } finally {
      _loading = false;
      if (requested && mounted) {
        final text = verified ? 'Alpaca PAPER refreshed: ${_orders.length} broker orders reported. An order is not a fill.' : _notice;
        widget.onRead?.call(text);
        if (verified) { HapticFeedback.mediumImpact(); } else { HapticFeedback.heavyImpact(); }
      }
    }
  }

  String _money(Object? amount) {
    final n = amount is num ? amount.toDouble() : double.tryParse('$amount');
    return n == null || !n.isFinite ? 'Not reported' : '\$${n.toStringAsFixed(2)}';
  }

  String _receipt(Map<String, dynamic> order) {
    return <String>[
      'Broker: Alpaca PAPER',
      'Client snapshot check: ${_checked?.toIso8601String() ?? 'Not verified'}',
      'Symbol: ${order['symbol'] ?? 'Unknown'}',
      'Side: ${order['side'] ?? 'Unknown'}',
      'Status: ${order['status'] ?? 'Unknown'}',
      'Requested: ${order['qty'] ?? 'Unknown'}',
      'Filled: ${order['filled_qty'] ?? 'Unknown'}',
      'Average fill: ${_money(order['filled_avg_price'])}',
      'Limit price: ${_money(order['limit_price'])}',
      'Submitted: ${order['submitted_at'] ?? 'Not reported'}',
      'Filled at: ${order['filled_at'] ?? 'Not filled'}',
      'Alpaca order ID: ${order['id'] ?? 'Not reported'}',
      'Client order ID: ${order['client_order_id'] ?? 'Not reported'}',
    ].join('\n');
  }

  Future<String?> _voice(String raw) async {
    final text = (cheWakeRemainder(raw) ?? raw).toLowerCase().replaceAll(RegExp(r'[.,!?]'), '').trim();
    if (RegExp(r'^refresh (?:my |the )?alpaca (?:paper )?(?:orders|trades)$').hasMatch(text)) {
      await _load();
      return _stale || _notice.isNotEmpty ? _notice : 'Alpaca PAPER refreshed: ${_orders.length} broker orders reported.';
    }
    final match = RegExp(r'^(open|show|read)(?: me)? (?:the )?(first|second|third|fourth|fifth|[1-9][0-9]?) alpaca (?:paper )?receipt$').firstMatch(text)
      ?? RegExp(r'^(open|show|read)(?: me)? (?:the )?alpaca (?:paper )?receipt (?:number )?(first|second|third|fourth|fifth|[1-9][0-9]?)$').firstMatch(text);
    if (match == null) return null;
    const ordinals = {'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5};
    final index = (ordinals[match[2]] ?? int.tryParse(match[2]!) ?? 0) - 1;
    if (index < 0 || index >= _orders.length) return 'That Alpaca receipt is not in the broker records shown here. Refresh the orders first.';
    final order = _orders[index];
    if (match[1] != 'read') { _showReceipt(order); }
    return '${_stale ? 'Previously verified, not current. ' : ''}${_receipt(order)}';
  }

  void _showReceipt(Map<String, dynamic> order) {
    final receipt = _receipt(order);
    final lines = receipt.split('\n');
    Object? receiptVoice;
    showModalBottomSheet<void>(
      context: context, isScrollControlled: true,
      builder: (context) {
        receiptVoice ??= CheScreenAwareness.registerVoice(context, (raw) async {
          final text = (cheWakeRemainder(raw) ?? raw).toLowerCase().replaceAll(RegExp(r'[.!?,]'), '').trim();
          if (RegExp(r'^(?:close (?:the )?receipt|go back)$').hasMatch(text)) { Navigator.pop(context); return 'Closed the Alpaca receipt.'; }
          if (RegExp(r'^read (?:this|(?:the )?receipt)$').hasMatch(text)) return receipt;
          return null;
        });
        return SafeArea(child: SingleChildScrollView(
        padding: const EdgeInsets.all(22),
        child: Column(mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_stale ? 'Previously verified paper-order receipt' : 'Verified paper-order receipt',
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
          const SizedBox(height: 12),
          for (final line in lines) Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: SelectableText(line, style: const TextStyle(fontSize: 16))),
          const Text('An accepted order is not a fill. Only the filled quantity is executed.'),
          if (widget.onRead != null) TextButton(onPressed: () => widget.onRead!(receipt), child: const Text('Read receipt aloud')),
          TextButton(onPressed: () => Navigator.pop(context),
            child: const Text('Close receipt')),
        ]),
      ));
      },
    ).whenComplete(() => CheScreenAwareness.unregister(receiptVoice));
  }

  @override
  Widget build(BuildContext context) {
    const green = Color(0xFF3DDC97);
    const amber = Color(0xFFFFC26E);
    const red = Color(0xFFFF7893);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF162532),
        border: Border.all(color: const Color(0xFF34505C)),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          const Expanded(child: Text('Alpaca paper orders',
            style: TextStyle(color: Colors.white, fontSize: 19,
              fontWeight: FontWeight.bold))),
          const Text('PAPER', style: TextStyle(color: amber)),
          IconButton(onPressed: () => _load(requested: true), tooltip: 'Refresh Alpaca paper orders',
            icon: const Icon(Icons.refresh, color: Colors.white)),
        ]),
        const Text('Broker-verified stock orders · separate from MNQ simulations',
          style: TextStyle(color: Colors.white70)),
        if (_equity != null) Text('Paper account equity: ${_equity!}',
          style: const TextStyle(color: Colors.white, fontSize: 16)),
        if (_checked != null) Text('Last order check: ${_checked!.toLocal()}',
          style: const TextStyle(color: Colors.white70, fontSize: 12)),
        if (_notice.isNotEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 10),
          child: Text(_notice, style: const TextStyle(color: amber))),
        for (final order in _orders.take(20))
          Padding(padding: const EdgeInsets.only(top: 8),
            child: Builder(builder: (context) {
              final status = (order['status'] ?? 'unknown').toString();
              final color = status == 'filled' ? green
                : ['canceled', 'rejected', 'expired'].contains(status) ? red : amber;
              final symbol = (order['symbol'] ?? 'Unknown').toString();
              final side = (order['side'] ?? 'Unknown').toString().toUpperCase();
              final filled = (order['filled_qty'] ?? 0).toString();
              final requested = (order['qty'] ?? '?').toString();
              return Semantics(button: true,
                label: '$symbol $side, $filled of $requested filled; $status. Open paper broker receipt.',
                child: OutlinedButton(onPressed: () => _showReceipt(order),
                  child: Row(children: [
                    Icon(status == 'filled' ? Icons.check_circle
                      : Icons.radio_button_unchecked, color: color),
                    const SizedBox(width: 10),
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('$symbol · $side',
                          style: const TextStyle(color: Colors.white,
                            fontWeight: FontWeight.bold, fontSize: 17)),
                        Text('$filled / $requested filled',
                          style: const TextStyle(color: Colors.white70)),
                      ])),
                    Text(status, style: TextStyle(color: color)),
                  ])),
              );
            }),
          ),
        if (widget.onRead != null) TextButton.icon(
          onPressed: () => widget.onRead!([
            if (_stale) 'These are old records. The refresh failed.',
            _notice,
            for (final order in _orders) '${order['symbol']}, ${order['side']}, ${order['filled_qty']} of ${order['qty']} filled, ${order['status']}, average fill ${_money(order['filled_avg_price'])}.',
          ].where((line) => line.isNotEmpty).join(' ')),
          icon: const Icon(Icons.record_voice_over_outlined),
          label: const Text('Read Alpaca paper orders aloud'),
        ),
        const SizedBox(height: 8),
        const Text('No order is placed here. Chart markers require a verified stock price feed.',
          style: TextStyle(color: Colors.white70, fontSize: 12)),
      ]),
    );
  }
}
