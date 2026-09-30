// CHE Client Pipeline: leads → proposal → your approval → build → review →
// Stripe payment link → paid. CHE drafts and builds; you approve anything that
// reaches a real person or real money, and you send messages yourself.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

class ChePipelineRoom extends StatefulWidget {
  const ChePipelineRoom({
    super.key,
    required this.baseUrl,
    required this.headers,
    required this.onAsk,
    this.client,
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  final http.Client? client;

  @override
  State<ChePipelineRoom> createState() => _ChePipelineRoomState();
}

class _ChePipelineRoomState extends State<ChePipelineRoom> {
  static const _teal = Color(0xFF34E0B8);
  static const _stageLabels = {
    'lead': 'LEAD',
    'proposal': 'PROPOSAL · NEEDS YOU',
    'approved': 'APPROVED · SEND IT',
    'building': 'BUILDING',
    'review': 'REVIEW · NEEDS YOU',
    'invoiced': 'PAYMENT LINK SENT',
    'paid': 'PAID',
    'lost': 'LOST',
  };

  late final http.Client _http = widget.client ?? http.Client();
  List<Map<String, dynamic>> _deals = const [];
  String? _error;
  bool _loading = true;
  final Set<String> _busy = {};
  final Map<String, TextEditingController> _priceEdits = {};

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  @override
  void dispose() {
    for (final c in _priceEdits.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<Map<String, dynamic>> _call(String method, String path, [Map<String, dynamic>? body]) async {
    final uri = Uri.parse('${widget.baseUrl()}$path');
    final headers = {...widget.headers(), 'Content-Type': 'application/json'};
    final r = method == 'GET'
        ? await _http.get(uri, headers: headers).timeout(const Duration(seconds: 30))
        : await _http
            .post(uri, headers: headers, body: jsonEncode(body ?? const {}))
            .timeout(const Duration(seconds: 90));
    final decoded = jsonDecode(r.body);
    final j = decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
    if (r.statusCode != 200) throw Exception('${j['detail'] ?? 'Pipeline request failed (${r.statusCode}).'}');
    return j;
  }

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _refresh() async {
    try {
      final j = await _call('GET', '/api/pipeline');
      _deals = [
        for (final d in (j['deals'] as List? ?? const []))
          if (d is Map<String, dynamic>) d,
      ];
      _error = null;
    } catch (e) {
      _error = '$e'.replaceFirst('Exception: ', '');
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

  Future<void> _step(String id, String step, {Map<String, dynamic>? body, String? done}) async {
    setState(() => _busy.add(id));
    try {
      final j = await _call('POST', '/api/pipeline/$id/$step', body);
      if (step == 'check-paid') {
        _toast(j['paid'] == true ? 'Stripe confirmed the payment.' : 'No payment in Stripe yet.');
      } else if (done != null) {
        _toast(done);
      }
      await _refresh();
    } catch (e) {
      _toast('$e'.replaceFirst('Exception: ', ''));
    }
    if (mounted) setState(() => _busy.remove(id));
  }

  Future<void> _copy(String text, String label) async {
    await Clipboard.setData(ClipboardData(text: text));
    _toast('$label copied.');
  }

  Future<void> _email(Map<String, dynamic> d, String subject, String text) async {
    final contact = '${d['contact'] ?? ''}'.trim();
    final uri = Uri(
      scheme: 'mailto',
      path: contact.contains('@') ? contact : '',
      query: 'subject=${Uri.encodeComponent(subject)}&body=${Uri.encodeComponent(text)}',
    );
    final opened = await launchUrl(uri);
    if (!opened) await _copy(text, 'Message');
  }

  Future<void> _addLead() async {
    final name = TextEditingController();
    final contact = TextEditingController();
    final source = TextEditingController();
    final need = TextEditingController();
    final notes = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF101821),
        title: const Text('New lead'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: name, decoration: const InputDecoration(labelText: 'Client or business name')),
              TextField(controller: contact, decoration: const InputDecoration(labelText: 'Email or contact (optional)')),
              TextField(controller: source, decoration: const InputDecoration(labelText: 'Where you found them (optional)')),
              TextField(
                controller: need,
                maxLines: 3,
                decoration: const InputDecoration(labelText: 'What they want built'),
              ),
              TextField(controller: notes, maxLines: 2, decoration: const InputDecoration(labelText: 'Notes (optional)')),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Add lead')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _call('POST', '/api/pipeline', {
        'client_name': name.text,
        'contact': contact.text,
        'source': source.text,
        'need': need.text,
        'notes': notes.text,
        'added_by': 'owner',
      });
      await _refresh();
    } catch (e) {
      _toast('$e'.replaceFirst('Exception: ', ''));
    }
  }

  List<Widget> _actions(Map<String, dynamic> d) {
    final id = '${d['id']}';
    final busy = _busy.contains(id);
    final stage = '${d['stage']}';
    final proposal = '${d['proposal_text'] ?? ''}';
    final payUrl = (d['payment'] as Map?)?['url']?.toString();
    Widget btn(String label, VoidCallback onTap, {bool primary = true}) => Padding(
          padding: const EdgeInsets.only(right: 8, top: 8),
          child: primary
              ? FilledButton(onPressed: busy ? null : onTap, child: Text(busy ? 'Working…' : label))
              : OutlinedButton(onPressed: busy ? null : onTap, child: Text(label)),
        );
    switch (stage) {
      case 'lead':
        return [btn('CHE: draft proposal', () => _step(id, 'draft', done: 'Draft ready for your review.'))];
      case 'proposal':
        final price = _priceEdits.putIfAbsent(
          id,
          () => TextEditingController(text: d['price_usd'] == null ? '' : '${d['price_usd']}'),
        );
        return [
          const SizedBox(height: 8),
          TextField(
            controller: price,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Price you agree to (USD)', prefixText: r'$'),
          ),
          Wrap(
            children: [
              btn('Approve', () => _step(id, 'approve',
                  body: {'price_usd': double.tryParse(price.text.trim())},
                  done: 'Approved. Now send it to the client.')),
              btn('Redraft', () => _step(id, 'draft'), primary: false),
            ],
          ),
        ];
      case 'approved':
        return [
          Wrap(
            children: [
              btn('Email proposal', () => _email(d, 'Proposal: ${d['client_name']}', proposal)),
              btn('Copy', () => _copy(proposal, 'Proposal'), primary: false),
              btn('Client agreed → start build', () => _step(id, 'build', done: 'The Office started building.'), primary: false),
            ],
          ),
        ];
      case 'building':
        return [
          Text(
            '${d['builder'] ?? 'The Office'} is building. Check their work in the Office, then mark it ready.',
            style: const TextStyle(color: Colors.white54, fontSize: 12),
          ),
          btn('Work is ready → review', () => _step(id, 'review')),
        ];
      case 'review':
        return [
          const Text(
            'Check the finished work yourself before asking for payment.',
            style: TextStyle(color: Colors.white54, fontSize: 12),
          ),
          btn('I checked it → create payment link', () async {
            final ok = await _confirmMoney(
              'Create Stripe payment link?',
              'CHE will create a real Stripe payment link for the agreed price. Confirm only if the work is ready to invoice.',
            );
            if (!ok) return;
            await _step(id, 'invoice', body: const {'confirmed': true}, done: 'Stripe payment link created.');
          }),
        ];
      case 'invoiced':
        return [
          if (payUrl != null) SelectableText(payUrl, style: const TextStyle(color: _teal)),
          Wrap(
            children: [
              if (payUrl != null)
                btn('Email payment link', () => _email(d, 'Payment for your project',
                    'Hi ${d['client_name']},\n\nYour project is ready. You can pay securely here:\n$payUrl\n\nThank you!')),
              if (payUrl != null) btn('Copy link', () => _copy(payUrl, 'Payment link'), primary: false),
              btn('Check payment', () => _step(id, 'check-paid'), primary: false),
            ],
          ),
        ];
      default:
        return const [];
    }
  }

  Widget _dealCard(Map<String, dynamic> d) {
    final id = '${d['id']}';
    final stage = '${d['stage']}';
    final history = (d['history'] as List? ?? const []).whereType<Map>().toList();
    final price = d['price_usd'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('${d['client_name']}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                ),
                if (price != null) Text('\$$price', style: const TextStyle(color: _teal, fontWeight: FontWeight.bold)),
              ],
            ),
            const SizedBox(height: 2),
            Text(
              _stageLabels[stage] ?? stage.toUpperCase(),
              style: TextStyle(
                color: stage == 'paid' ? _teal : (stage == 'proposal' || stage == 'review' ? Colors.amberAccent : Colors.white38),
                fontSize: 11,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 6),
            Text('${d['need']}', style: const TextStyle(color: Colors.white70)),
            if ('${d['proposal_text'] ?? ''}'.isNotEmpty && ['proposal', 'approved'].contains(stage)) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(8)),
                child: Text('${d['proposal_text']}', style: const TextStyle(fontSize: 13)),
              ),
              if ('${d['price_reasoning'] ?? ''}'.isNotEmpty && stage == 'proposal')
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text('CHE’s price note (suggestion): ${d['price_reasoning']}',
                      style: const TextStyle(color: Colors.white38, fontSize: 12)),
                ),
            ],
            ..._actions(d),
            if (history.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text('${history.first['text']}', style: const TextStyle(color: Colors.white38, fontSize: 11)),
              ),
            if (!['paid', 'lost'].contains(stage))
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: _busy.contains(id) ? null : () => _step(id, 'lost'),
                  child: const Text('Mark lost', style: TextStyle(color: Colors.white38)),
                ),
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final active = _deals.where((d) => !['paid', 'lost'].contains(d['stage'])).toList();
    final done = _deals.where((d) => ['paid', 'lost'].contains(d['stage'])).toList();
    return Scaffold(
      backgroundColor: const Color(0xFF0B1118),
      appBar: AppBar(backgroundColor: const Color(0xFF0B1118), title: const Text('Client Pipeline')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _addLead,
        icon: const Icon(Icons.person_add_alt_1),
        label: const Text('New lead'),
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
          children: [
            if (_loading) const LinearProgressIndicator(),
            if (_error != null)
              Card(child: ListTile(leading: const Icon(Icons.error_outline), title: const Text('Pipeline unavailable'), subtitle: Text(_error!))),
            const Text(
              'CHE drafts and builds. You approve prices, send messages and check work before anyone pays.',
              style: TextStyle(color: Colors.white54),
            ),
            const SizedBox(height: 8),
            Card(
              child: ListTile(
                leading: const Icon(Icons.travel_explore),
                title: const Text('Ask CHE where to find clients'),
                subtitle: const Text('Honest places and ways to find people who need apps or sites.'),
                onTap: () => widget.onAsk(
                  'I build apps and websites through CHE Studio. Tell me specific, legitimate places and ways to find clients who need app or website work (no spam, no fake accounts, no bots on freelance sites), and draft one short, honest outreach message I could send myself. Label anything you are unsure about. Do not claim you contacted anyone.',
                ),
              ),
            ),
            const SizedBox(height: 8),
            if (_deals.isEmpty && !_loading)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('No leads yet. Tap New lead when you find someone who needs an app or site.',
                    style: TextStyle(color: Colors.white54)),
              ),
            for (final d in active) _dealCard(d),
            if (done.isNotEmpty) ...[
              const Padding(
                padding: EdgeInsets.fromLTRB(4, 16, 4, 8),
                child: Text('Finished', style: TextStyle(color: Colors.white54, fontWeight: FontWeight.bold)),
              ),
              for (final d in done) _dealCard(d),
            ],
          ],
        ),
      ),
    );
  }
}
