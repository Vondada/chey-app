// Read-only visual receipts from Alpaca PAPER; no broker order action.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

class CheAlpacaPaperPanel extends StatefulWidget {
  const CheAlpacaPaperPanel({
    super.key, required this.baseUrl, required this.headers,
    this.client, this.refresh = const Duration(seconds: 30),
  });
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
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

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    _timer = Timer.periodic(widget.refresh, (_) => unawaited(_load()));
  }

  @override
  void dispose() {
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

  Future<void> _load() async {
    try {
      final responses = await Future.wait([
        _get('/api/trading/alpaca/orders'),
        _get('/api/trading/connections'),
      ]);
      final orders = responses[0];
      final connections = (responses[1]['connections'] as List? ?? const []);
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
        _orders = (orders['orders'] as List? ?? const []).whereType<Map>()
            .map((m) => Map<String, dynamic>.from(m)).toList();
        _equity = account is Map && account['equity'] != null
            ? _money(account['equity']) : null;
        _checked = DateTime.now();
        _notice = _orders.isEmpty ? 'No Alpaca paper orders recorded by the broker.' : '';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _notice = 'Refresh failed. Any orders below are old, not a live status.';
      });
    }
  }

  String _money(Object? amount) {
    final n = amount is num ? amount.toDouble() : double.tryParse('$amount');
    return n == null ? 'Not reported' : '\$' + n.toStringAsFixed(2);
  }

  void _showReceipt(Map<String, dynamic> order) {
    final lines = <String>[
      'Broker: Alpaca PAPER',
      'Symbol: ' + (order['symbol'] ?? 'Unknown').toString(),
      'Side: ' + (order['side'] ?? 'Unknown').toString(),
      'Status: ' + (order['status'] ?? 'Unknown').toString(),
      'Requested: ' + (order['qty'] ?? 'Unknown').toString(),
      'Filled: ' + (order['filled_qty'] ?? 'Unknown').toString(),
      'Average fill: ' + _money(order['filled_avg_price']),
      'Limit price: ' + _money(order['limit_price']),
      'Submitted: ' + (order['submitted_at'] ?? 'Not reported').toString(),
      'Filled at: ' + (order['filled_at'] ?? 'Not filled').toString(),
      'Alpaca order ID: ' + (order['id'] ?? 'Not reported').toString(),
      'Client order ID: ' + (order['client_order_id'] ?? 'Not reported').toString(),
    ];
    showModalBottomSheet<void>(
      context: context, isScrollControlled: true,
      builder: (context) => SafeArea(child: SingleChildScrollView(
        padding: const EdgeInsets.all(22),
        child: Column(mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Verified paper-order receipt',
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
          const SizedBox(height: 12),
          for (final line in lines) Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: SelectableText(line, style: const TextStyle(fontSize: 16))),
          const Text('An accepted order is not a fill. Only the filled quantity is executed.'),
          TextButton(onPressed: () => Navigator.pop(context),
            child: const Text('Close receipt')),
        ]),
      )),
    );
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
          IconButton(onPressed: _load, tooltip: 'Refresh Alpaca paper orders',
            icon: const Icon(Icons.refresh, color: Colors.white)),
        ]),
        const Text('Broker-verified stock orders · separate from MNQ simulations',
          style: TextStyle(color: Colors.white70)),
        if (_equity != null) Text('Paper account equity: ' + _equity!,
          style: const TextStyle(color: Colors.white, fontSize: 16)),
        if (_checked != null) Text('Last order check: ' + _checked!.toLocal().toString(),
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
                label: symbol + ' ' + side + ', ' + filled + ' of ' + requested
                  + ' filled; ' + status + '. Open paper broker receipt.',
                child: OutlinedButton(onPressed: () => _showReceipt(order),
                  child: Row(children: [
                    Icon(status == 'filled' ? Icons.check_circle
                      : Icons.radio_button_unchecked, color: color),
                    const SizedBox(width: 10),
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(symbol + ' · ' + side,
                          style: const TextStyle(color: Colors.white,
                            fontWeight: FontWeight.bold, fontSize: 17)),
                        Text(filled + ' / ' + requested + ' filled',
                          style: const TextStyle(color: Colors.white70)),
                      ])),
                    Text(status, style: TextStyle(color: color)),
                  ])),
                ),
              );
            }),
          ),
        const SizedBox(height: 8),
        const Text('No order is placed here. Chart markers require a verified stock price feed.',
          style: TextStyle(color: Colors.white70, fontSize: 12)),
      ]),
    );
  }
}
