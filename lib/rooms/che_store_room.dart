// CHE Studio Store: products CHE or the owner propose, approved one tap at a
// time, then created in Stripe with a real payment link. Sales and balance come
// straight from Stripe. There is no refund, payout or spend control here.

import 'dart:async';
import 'dart:convert';
import '../widgets/che_native_scene_world.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

class CheStoreRoom extends StatefulWidget {
  const CheStoreRoom({
    super.key,
    required this.baseUrl,
    required this.headers,
    required this.onAsk,
    this.client,
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;

  /// Sends a prompt to CHE (e.g. "Suggest three products I could sell").
  final void Function(String prompt) onAsk;
  final http.Client? client;

  @override
  State<CheStoreRoom> createState() => _CheStoreRoomState();
}

class _CheStoreRoomState extends State<CheStoreRoom> {
  static const _teal = Color(0xFF34E0B8);

  late final http.Client _http = widget.client ?? http.Client();
  String _mode = 'not_connected';
  List<Map<String, dynamic>> _proposals = const [];
  Map<String, dynamic>? _sales;
  String? _error;
  String? _salesError;
  bool _loading = true;
  final Set<String> _busy = {};

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  Future<Map<String, dynamic>> _call(String method, String path, [Map<String, dynamic>? body]) async {
    final uri = Uri.parse('${widget.baseUrl()}$path');
    final headers = {...widget.headers(), 'Content-Type': 'application/json'};
    final r = method == 'GET'
        ? await _http.get(uri, headers: headers).timeout(const Duration(seconds: 30))
        : await _http
            .post(uri, headers: headers, body: jsonEncode(body ?? const {}))
            .timeout(const Duration(seconds: 45));
    final decoded = jsonDecode(r.body);
    final j = decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
    if (r.statusCode != 200) throw Exception('${j['detail'] ?? 'Store request failed (${r.statusCode}).'}');
    return j;
  }

  Future<void> _refresh() async {
    try {
      final j = await _call('GET', '/api/stripe/proposals');
      _mode = '${j['mode'] ?? 'not_connected'}';
      _proposals = [
        for (final p in (j['proposals'] as List? ?? const []))
          if (p is Map<String, dynamic>) p,
      ];
      _error = null;
    } catch (e) {
      _error = '$e'.replaceFirst('Exception: ', '');
    }
    if (_mode != 'not_connected') {
      try {
        _sales = await _call('GET', '/api/stripe/sales');
        _salesError = null;
      } catch (e) {
        _salesError = '$e'.replaceFirst('Exception: ', '');
      }
    }
    _loading = false;
    if (mounted) setState(() {});
  }

  Future<bool> _confirmMoney(String title, String body) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF101821),
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Confirm')),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _act(String id, String action) async {
    if (action == 'approve') {
      Map<String, dynamic>? proposal;
      for (final p in _proposals) {
        if ('${p['id']}' == id) {
          proposal = p;
          break;
        }
      }
      final name = '${proposal?['name'] ?? 'this product'}';
      final cents = (proposal?['unit_amount'] as num?)?.toInt();
      final price = cents == null ? '' : '\$${(cents / 100).toStringAsFixed(2)}';
      final ok = await _confirmMoney(
        'Create in Stripe?',
        'CHE will create "$name"${price.isEmpty ? '' : ' at $price'} as a Stripe product with a payment link. '
        'Nothing is charged until a customer pays. Confirm only if you want this live.',
      );
      if (!ok) return;
    }
    setState(() => _busy.add(id));
    try {
      await _call(
        'POST',
        '/api/stripe/proposals/$id/$action',
        action == 'approve' ? const {'confirmed': true} : null,
      );
      await _refresh();
      if (mounted && action == 'approve') {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Created in Stripe. The payment link is on the card.')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$e'.replaceFirst('Exception: ', ''))),
        );
      }
    }
    if (mounted) setState(() => _busy.remove(id));
  }

  Future<void> _newProduct() async {
    final name = TextEditingController();
    final description = TextEditingController();
    final price = TextEditingController();
    var kind = 'digital_product';
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          backgroundColor: const Color(0xFF101821),
          title: const Text('New product'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: name, decoration: const InputDecoration(labelText: 'Name')),
                TextField(
                  controller: description,
                  maxLines: 3,
                  decoration: const InputDecoration(labelText: 'What the buyer gets'),
                ),
                TextField(
                  controller: price,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'Price (USD)', prefixText: r'$'),
                ),
                const SizedBox(height: 8),
                SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(value: 'digital_product', label: Text('Digital')),
                    ButtonSegment(value: 'class', label: Text('Class')),
                  ],
                  selected: {kind},
                  onSelectionChanged: (s) => setLocal(() => kind = s.first),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Save for approval')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    try {
      await _call('POST', '/api/stripe/proposals', {
        'name': name.text,
        'description': description.text,
        'price_usd': double.tryParse(price.text.replaceAll(r'$', '').trim()),
        'kind': kind,
        'proposed_by': 'owner',
      });
      await _refresh();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$e'.replaceFirst('Exception: ', ''))),
        );
      }
    }
  }

  String _money(num? cents) => cents == null ? '—' : '\$${(cents / 100).toStringAsFixed(2)}';

  Widget _modeBadge() {
    final (label, color) = switch (_mode) {
      'live' => ('LIVE PAYMENTS', Colors.redAccent),
      'test' => ('TEST MODE', Colors.amberAccent),
      'not_connected' => ('NOT CONNECTED', Colors.white38),
      _ => ('CHECK KEY', Colors.white38),
    };
    return Text(label, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.bold));
  }

  Widget _salesCard() {
    if (_mode == 'not_connected') {
      return const Card(
        child: ListTile(
          leading: Icon(Icons.link_off),
          title: Text('Stripe not connected'),
          subtitle: Text('Add STRIPE_SECRET_KEY to the CHE Worker. Until then nothing can be sold.'),
        ),
      );
    }
    if (_salesError != null) {
      return Card(child: ListTile(leading: const Icon(Icons.error_outline), title: const Text('Sales'), subtitle: Text(_salesError!)));
    }
    final s = _sales;
    final balance = s?['balance'] as Map<String, dynamic>?;
    final sales = (s?['sales'] as List? ?? const []).whereType<Map<String, dynamic>>().toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Sales (from Stripe)', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            Text('Recent sales: ${_money(s?['recent_total_cents'] as num?)}  •  ${sales.length} orders'),
            Text('Available: ${_money(balance?['available_cents'] as num?)}  •  Pending: ${_money(balance?['pending_cents'] as num?)}'),
            for (final sale in sales.take(5))
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  '${_money(sale['amount'] as num?)}  ${sale['description'] ?? ''}  ${'${sale['created_at'] ?? ''}'.split('T').first}',
                  style: const TextStyle(color: Colors.white70, fontSize: 13),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _proposalCard(Map<String, dynamic> p) {
    final id = '${p['id']}';
    final status = '${p['status']}';
    final receipt = p['receipt'] as Map<String, dynamic>?;
    final link = receipt?['payment_link_url']?.toString();
    final busy = _busy.contains(id);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text('${p['name']}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16))),
                Text(_money(p['unit_amount'] as num?), style: const TextStyle(color: _teal, fontWeight: FontWeight.bold)),
              ],
            ),
            if ('${p['description'] ?? ''}'.isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 4), child: Text('${p['description']}', style: const TextStyle(color: Colors.white70))),
            const SizedBox(height: 6),
            Text(
              '${p['kind'] == 'class' ? 'Class' : 'Digital product'} • proposed by ${p['proposed_by'] ?? 'owner'} • ${status.toUpperCase()}',
              style: const TextStyle(color: Colors.white38, fontSize: 12),
            ),
            if ('${p['error'] ?? ''}'.isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 6), child: Text('Stripe said: ${p['error']}', style: const TextStyle(color: Colors.redAccent, fontSize: 12))),
            if (status == 'pending') ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  FilledButton(
                    onPressed: busy || _mode == 'not_connected' ? null : () => _act(id, 'approve'),
                    child: Text(busy ? 'Working…' : 'Approve & create'),
                  ),
                  const SizedBox(width: 10),
                  TextButton(onPressed: busy ? null : () => _act(id, 'reject'), child: const Text('Reject')),
                ],
              ),
            ],
            if (link != null) ...[
              const SizedBox(height: 8),
              SelectableText(link, style: const TextStyle(color: _teal)),
              TextButton.icon(
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: link));
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Payment link copied.')));
                  }
                },
                icon: const Icon(Icons.copy, size: 16),
                label: const Text('Copy payment link'),
              ),
            ],
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0B1118),
      appBar: AppBar(
        backgroundColor: const Color(0xFF0B1118),
        title: const Text('CHE Studio Store'),
        actions: [Padding(padding: const EdgeInsets.only(right: 16), child: Center(child: _modeBadge()))],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _newProduct,
        icon: const Icon(Icons.add),
        label: const Text('New product'),
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
          children: [
            if (_loading) const LinearProgressIndicator(),
            if (_error != null)
              Card(child: ListTile(leading: const Icon(Icons.error_outline), title: const Text('Store unavailable'), subtitle: Text(_error!))),
            ValueListenableBuilder<CheSceneQuality>(
              valueListenable: CheSceneQualityStore.value,
              builder: (context, quality, _) => CheNativeSceneWorld(
                mode: CheSceneMode.store,
                quality: quality,
                height: 240,
                semanticsLabel: 'Immersive CHE Studio Store',
                entities: [
                  for (final product in _proposals.take(12))
                    CheSceneEntity(
                      id: '${product['id']}',
                      label: '${product['name'] ?? product['title'] ?? 'Product'}',
                      description: '${product['status'] ?? 'pending'}',
                      color: _teal,
                      state: '${product['status'] ?? 'pending'}',
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            const Text(
              'Nothing goes to Stripe until you tap Approve. CHE cannot refund, move money or spend.',
              style: TextStyle(color: Colors.white54),
            ),
            const SizedBox(height: 12),
            _salesCard(),
            const SizedBox(height: 8),
            Card(
              child: ListTile(
                leading: const Icon(Icons.lightbulb_outline),
                title: const Text('Ask CHE for product ideas'),
                subtitle: const Text('She drafts ideas; you add the ones you like here.'),
                onTap: () => widget.onAsk(
                  'Suggest three digital products or classes I could sell through CHE Studio. For each give a name, what the buyer gets, and a suggested price with your reasoning. Label anything you are unsure about. Do not claim anything was created or sold.',
                ),
              ),
            ),
            const SizedBox(height: 8),
            if (_proposals.isEmpty && !_loading)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('No products yet. Tap New product to add one.', style: TextStyle(color: Colors.white54)),
              ),
            for (final p in _proposals) _proposalCard(p),
          ],
        ),
      ),
    );
  }
}
