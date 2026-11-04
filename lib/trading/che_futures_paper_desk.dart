// Paper Futures (owner, 2026-11-04): manual paper trading of MNQ, NQ, MES and ES on CHE's own futures paper simulator
// (server/cloudflare/futures_paper.js), from the iPhone.
//
// - Big, labelled controls: a market picker, a contract stepper, Market / Limit / Stop, optional Stop Loss and Take
//   Profit, BUY and SELL, Cancel on each working order, and FLATTEN ALL. Every control has a VoiceOver label and works
//   at large text sizes (everything wraps; nothing is fixed to one line).
// - Every order is confirmed on a sheet first ("Buy 1 MNQ market on paper?"). One ticket keeps one client order id, so
//   a double tap or a retry after a dropped connection can never place it twice (the simulator refuses the repeat).
// - Everything shown comes from the Worker's account view: positions, P&L, working orders, fills and the feed's own
//   label. The feed is always named: DELAYED (Yahoo's public CME data) or UNAVAILABLE. Nothing here says live.
// - Voice: every order, cancel and flatten outcome (success, rejection or a dropped connection) is spoken through
//   onRead, the Trading Room's reader. Passive refreshes (the feed line, the connection notice) stay silent: they are
//   ordinary text, not live regions (AGENTS.md: no forced announcements for passive status).
// - The view refreshes every 5 seconds while open. A failed refresh shows "Connection lost" and keeps the last
//   account it read, marked as old; nothing is guessed.
// - No broker, no money: the header says so, and live orders are off in CHE's code.
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

const kFuturesPaperRoots = ['MNQ', 'NQ', 'MES', 'ES'];
const _green = Color(0xFF1FA463);
const _red = Color(0xFFD64545);
const _panel = Color(0xFF15181F);

/// One order ticket. Its client id stays the same until the order is answered, so a repeat is refused, not placed.
class CheFuturesTicket {
  CheFuturesTicket({required this.root, required this.side, required this.qty, required this.type, this.price, this.stopLoss, this.takeProfit, String? clientId})
      : clientId = clientId ?? 'app-${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(1 << 30)}';
  final String root;
  final String side;
  final int qty;
  final String type;
  final double? price;
  final double? stopLoss;
  final double? takeProfit;
  final String clientId;

  Map<String, dynamic> toJson() => {
        'root': root, 'side': side, 'qty': qty, 'type': type, 'client_id': clientId,
        if (type != 'market' && price != null) 'price': price,
        if (stopLoss != null) 'stop_loss': stopLoss,
        if (takeProfit != null) 'take_profit': takeProfit,
      };

  /// "Buy 1 MNQ market", "Sell 2 ES limit 5000, stop loss 5010, take profit 4980", as the confirmation reads it.
  String spoken() {
    final parts = ['${side == 'buy' ? 'Buy' : 'Sell'} $qty $root ${type == 'market' ? 'market' : '$type ${_num(price)}'}'];
    if (stopLoss != null) parts.add('stop loss ${_num(stopLoss)}');
    if (takeProfit != null) parts.add('take profit ${_num(takeProfit)}');
    return parts.join(', ');
  }
}

String _num(num? v) {
  if (v == null) return '—';
  final s = v.toStringAsFixed(2);
  return s.endsWith('.00') ? s.substring(0, s.length - 3) : (s.endsWith('0') ? s.substring(0, s.length - 1) : s);
}

String _money(num? v) => v == null ? 'unknown' : '${v < 0 ? '−' : ''}\$${_num(v.abs())}';

class CheFuturesPaperDesk extends StatefulWidget {
  const CheFuturesPaperDesk({super.key, required this.baseUrl, required this.headers, this.client, this.onRead, this.refreshEvery = const Duration(seconds: 5)});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  /// Speaks an action's actual outcome. Never called for passive refreshes.
  final void Function(String text)? onRead;
  final Duration refreshEvery;

  @override
  State<CheFuturesPaperDesk> createState() => CheFuturesPaperDeskState();
}

class CheFuturesPaperDeskState extends State<CheFuturesPaperDesk> {
  late final http.Client _http = widget.client ?? http.Client();
  Timer? _timer;
  String _root = 'MNQ';
  int _qty = 1;
  String _type = 'market';
  final _price = TextEditingController();
  final _stop = TextEditingController();
  final _target = TextEditingController();
  Map<String, dynamic>? _view;
  DateTime? _readAt;
  String _connection = '';
  String _result = '';
  bool _busy = false;
  CheFuturesTicket? _pending;

  @override
  void initState() {
    super.initState();
    refresh();
    _timer = Timer.periodic(widget.refreshEvery, (_) => refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _price.dispose();
    _stop.dispose();
    _target.dispose();
    if (widget.client == null) _http.close();
    super.dispose();
  }

  Uri _u(String path, [Map<String, String>? q]) => Uri.parse('${widget.baseUrl()}$path').replace(queryParameters: q);

  Future<void> refresh() async {
    try {
      final r = await _http.get(_u('/api/futures/paper', {'root': _root}), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(r.body);
      if (!mounted) return;
      if (r.statusCode != 200 || j is! Map<String, dynamic>) {
        setState(() => _connection = 'Connection problem: the Worker answered ${r.statusCode}. Showing the last account read.');
        return;
      }
      setState(() {
        _view = j;
        _readAt = DateTime.now();
        _connection = '';
      });
    } catch (_) {
      if (mounted) setState(() => _connection = 'Connection lost. Retrying every ${widget.refreshEvery.inSeconds} seconds; the account below is the last one read.');
    }
  }

  Future<Map<String, dynamic>?> _post(String path, Map<String, dynamic> body) async {
    setState(() => _busy = true);
    try {
      final r = await _http
          .post(_u(path), headers: {...widget.headers(), 'Content-Type': 'application/json'}, body: jsonEncode(body))
          .timeout(const Duration(seconds: 30));
      final j = jsonDecode(r.body);
      if (!mounted || j is! Map<String, dynamic>) return null;
      if (j['account'] is Map<String, dynamic>) {
        _view = j['account'] as Map<String, dynamic>;
        _readAt = DateTime.now();
      }
      return j;
    } catch (_) {
      if (mounted) _report('No answer from CHE: the connection dropped. Nothing is assumed placed; the ticket keeps its id, so sending it again cannot place it twice.');
      return null;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Shows an action's outcome and speaks it. Callers check `mounted` first.
  void _report(String text) {
    setState(() => _result = text);
    widget.onRead?.call(text);
  }

  double? _field(TextEditingController c) {
    final t = c.text.trim().replaceAll(',', '');
    return t.isEmpty ? null : double.tryParse(t);
  }

  Future<void> _order(String side) async {
    final ticket = (_pending != null && _pending!.side == side && _pending!.root == _root)
        ? _pending!
        : CheFuturesTicket(root: _root, side: side, qty: _qty, type: _type, price: _field(_price), stopLoss: _field(_stop), takeProfit: _field(_target));
    _pending = ticket;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: _panel,
      builder: (context) => _ConfirmSheet(
        title: '${ticket.spoken()} on paper?',
        detail: 'CHE\'s paper simulator, filled against delayed CME prices. No broker, no money.',
        confirm: side == 'buy' ? 'Place paper buy' : 'Place paper sell',
        color: side == 'buy' ? _green : _red,
      ),
    );
    if (ok != true || !mounted) return;
    HapticFeedback.mediumImpact();
    final j = await _post('/api/futures/paper/order', ticket.toJson());
    if (j == null || !mounted) return;
    _pending = null;
    _report('${j['text'] ?? 'The order was answered without text.'}');
  }

  Future<void> _cancel(String id, String what) async {
    final j = await _post('/api/futures/paper/cancel', {'id': id});
    if (j != null && mounted) _report('${j['text'] ?? 'Cancel answered.'}');
  }

  Future<void> _flatten() async {
    final ok = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: _panel,
      builder: (context) => const _ConfirmSheet(
        title: 'Flatten everything on paper?',
        detail: 'Cancels every working paper order and closes every paper position at the latest delayed price.',
        confirm: 'Flatten all',
        color: _red,
      ),
    );
    if (ok != true || !mounted) return;
    HapticFeedback.heavyImpact();
    final j = await _post('/api/futures/paper/flatten', {});
    if (j != null && mounted) _report('${j['text'] ?? 'Flatten answered.'}');
  }

  Map<String, dynamic> get _feed => ((_view?['feeds'] as Map?)?[_root] as Map?)?.cast<String, dynamic>() ?? const {};

  @override
  Widget build(BuildContext context) {
    final view = _view;
    final feed = _feed;
    final positions = ((view?['positions'] as List?) ?? const []).cast<Map>();
    final working = ((view?['working'] as List?) ?? const []).cast<Map>();
    final fills = ((view?['recent_fills'] as List?) ?? const []).cast<Map>();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: const Text('PAPER FUTURES', key: Key('futures_paper_title'), style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w700)),
        ),
        const SizedBox(height: 4),
        const Text('CHE\'s paper simulator. No broker, no money. Live orders are off.',
            key: Key('futures_paper_banner'), style: TextStyle(color: Colors.white70, fontSize: 15)),
        if (_connection.isNotEmpty) ...[
          const SizedBox(height: 8),
          _Notice(key: const Key('futures_paper_connection'), text: _connection, color: _red, live: false),
        ],
        const SizedBox(height: 12),
        Semantics(
          label: 'Market',
          child: Wrap(spacing: 8, runSpacing: 8, children: [
            for (final r in kFuturesPaperRoots)
              ChoiceChip(
                key: Key('futures_root_$r'),
                label: Padding(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8), child: Text(r, style: const TextStyle(fontSize: 18))),
                selected: _root == r,
                onSelected: (_) {
                  setState(() {
                    _root = r;
                    _pending = null;
                  });
                  refresh();
                },
              ),
          ]),
        ),
        const SizedBox(height: 10),
        _FeedLine(root: _root, feed: feed),
        const SizedBox(height: 12),
        Wrap(spacing: 12, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          const Text('Contracts', style: TextStyle(color: Colors.white, fontSize: 17)),
          _BigIcon(key: const Key('futures_qty_minus'), icon: Icons.remove, label: 'One contract fewer', onTap: _qty > 1 ? () => setState(() { _qty -= 1; _pending = null; }) : null),
          Semantics(label: '$_qty contracts', child: Text('$_qty', key: const Key('futures_qty'), style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w700))),
          _BigIcon(key: const Key('futures_qty_plus'), icon: Icons.add, label: 'One contract more', onTap: () => setState(() { _qty += 1; _pending = null; })),
        ]),
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final t in const ['market', 'limit', 'stop'])
            ChoiceChip(
              key: Key('futures_type_$t'),
              label: Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6), child: Text(t[0].toUpperCase() + t.substring(1), style: const TextStyle(fontSize: 17))),
              selected: _type == t,
              onSelected: (_) => setState(() { _type = t; _pending = null; }),
            ),
        ]),
        if (_type != 'market') _PriceField(key: const Key('futures_price'), controller: _price, label: '${_type == 'limit' ? 'Limit' : 'Stop'} price', onChanged: () => _pending = null),
        _PriceField(key: const Key('futures_stop_loss'), controller: _stop, label: 'Stop loss (optional)', onChanged: () => _pending = null),
        _PriceField(key: const Key('futures_take_profit'), controller: _target, label: 'Take profit (optional)', onChanged: () => _pending = null),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: _BigButton(key: const Key('futures_buy'), label: 'BUY', semantics: 'Buy $_qty $_root on paper', color: _green, onTap: _busy ? null : () => _order('buy'))),
          const SizedBox(width: 12),
          Expanded(child: _BigButton(key: const Key('futures_sell'), label: 'SELL', semantics: 'Sell $_qty $_root on paper', color: _red, onTap: _busy ? null : () => _order('sell'))),
        ]),
        if (_result.isNotEmpty) ...[
          const SizedBox(height: 10),
          // Spoken through onRead when the room provides it; otherwise VoiceOver announces the outcome itself.
          _Notice(key: const Key('futures_paper_result'), text: _result, color: Colors.white24, live: widget.onRead == null),
        ],
        const SizedBox(height: 16),
        _Section(title: 'POSITIONS', children: [
          if (positions.isEmpty) const Text('No open paper positions.', style: TextStyle(color: Colors.white70, fontSize: 16)),
          for (final p in positions)
            Text(
              '${(p['qty'] as num) > 0 ? 'Long' : 'Short'} ${(p['qty'] as num).abs()} ${p['root']} at ${_num(p['avg'] as num?)}; mark ${_num(p['mark'] as num?)}; open P&L ${_money(p['open_pnl'] as num?)}',
              key: Key('futures_position_${p['root']}'),
              style: const TextStyle(color: Colors.white, fontSize: 17),
            ),
        ]),
        _Section(title: 'WORKING ORDERS', children: [
          if (working.isEmpty) const Text('No working paper orders.', style: TextStyle(color: Colors.white70, fontSize: 16)),
          for (final o in working)
            Wrap(spacing: 10, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Text('${o['id']}: ${o['side']} ${o['qty']} ${o['root']} ${o['type']} ${_num(o['price'] as num?)}${o['role'] != null && o['role'] != 'entry' ? ' (${'${o['role']}'.replaceAll('_', ' ')})' : ''}',
                  style: const TextStyle(color: Colors.white, fontSize: 16)),
              _SmallButton(key: Key('futures_cancel_${o['id']}'), label: 'Cancel', semantics: 'Cancel paper order ${o['id']}', onTap: _busy ? null : () => _cancel('${o['id']}', '${o['root']}')),
            ]),
        ]),
        _Section(title: 'ACCOUNT', children: [
          Text(
            view == null
                ? 'Reading the paper account…'
                : 'Cash ${_money(view['cash'] as num?)} · realized ${_money(view['realized'] as num?)} · open ${_money(view['open_pnl'] as num?)} · equity ${_money(view['equity'] as num?)} · commissions ${_money(view['commissions'] as num?)}',
            key: const Key('futures_account_line'),
            style: const TextStyle(color: Colors.white, fontSize: 16),
          ),
          if (view != null)
            Text('Today ${_money(((view['limits'] as Map?)?['today']) as num?)} against a ${_money(((view['limits'] as Map?)?['daily_loss']) as num?)} daily loss limit.',
                style: const TextStyle(color: Colors.white70, fontSize: 15)),
          if (_readAt != null)
            Text('Read ${_readAt!.toLocal().toIso8601String().substring(11, 19)}${_connection.isNotEmpty ? ' (old)' : ''}.', style: const TextStyle(color: Colors.white54, fontSize: 14)),
        ]),
        _Section(title: 'RECENT FILLS', children: [
          if (fills.isEmpty) const Text('No paper fills yet.', style: TextStyle(color: Colors.white70, fontSize: 16)),
          for (final f in fills.take(8))
            Text('${f['id']}: ${f['side']} ${f['qty']} ${f['root']} at ${_num(f['price'] as num?)} · ${'${f['time']}'.replaceFirst('T', ' ').substring(0, 16)} UTC', style: const TextStyle(color: Colors.white, fontSize: 15)),
        ]),
        const SizedBox(height: 12),
        _BigButton(key: const Key('futures_flatten'), label: 'FLATTEN ALL', semantics: 'Flatten all paper positions and cancel every paper order', color: _red, onTap: _busy ? null : _flatten),
      ],
    );
  }
}

class _FeedLine extends StatelessWidget {
  const _FeedLine({required this.root, required this.feed});
  final String root;
  final Map<String, dynamic> feed;
  @override
  Widget build(BuildContext context) {
    final status = '${feed['status'] ?? 'NOT READ'}';
    final age = feed['age_s'] is num ? ' (${((feed['age_s'] as num) / 60).round()} min old)' : '';
    final fresh = feed['fresh'] == true;
    final text = status == 'DELAYED'
        ? 'DELAYED · ${feed['source'] ?? ''} · ${feed['contract'] ?? ''} · ${_num(feed['price'] as num?)} at ${'${feed['bar_time'] ?? ''}'.replaceFirst('T', ' ').replaceFirst(':00.000Z', ' UTC')}$age · ${fresh ? 'market orders allowed' : 'too old for market orders'}'
        : '$status · ${feed['error'] ?? 'no price read yet'} · market orders refused';
    return Semantics(
      label: '$root data: $text',
      child: Text(text, key: const Key('futures_feed_line'), style: TextStyle(color: status == 'DELAYED' && fresh ? const Color(0xFFFFC857) : _red, fontSize: 16, fontWeight: FontWeight.w600)),
    );
  }
}

class _PriceField extends StatelessWidget {
  const _PriceField({super.key, required this.controller, required this.label, required this.onChanged});
  final TextEditingController controller;
  final String label;
  final VoidCallback onChanged;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 10),
        child: TextField(
          controller: controller,
          onChanged: (_) => onChanged(),
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          style: const TextStyle(color: Colors.white, fontSize: 18),
          decoration: InputDecoration(labelText: label, labelStyle: const TextStyle(color: Colors.white70, fontSize: 16), border: const OutlineInputBorder(), contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16)),
        ),
      );
}

class _BigButton extends StatelessWidget {
  const _BigButton({super.key, required this.label, required this.semantics, required this.color, required this.onTap});
  final String label;
  final String semantics;
  final Color color;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        enabled: onTap != null,
        label: semantics,
        onTap: onTap,
        excludeSemantics: true,
        child: FilledButton(
          onPressed: onTap,
          style: FilledButton.styleFrom(backgroundColor: color, minimumSize: const Size.fromHeight(64), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
          child: Text(label, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Colors.white)),
        ),
      );
}

class _SmallButton extends StatelessWidget {
  const _SmallButton({super.key, required this.label, required this.semantics, required this.onTap});
  final String label;
  final String semantics;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        enabled: onTap != null,
        label: semantics,
        onTap: onTap,
        excludeSemantics: true,
        child: OutlinedButton(onPressed: onTap, style: OutlinedButton.styleFrom(minimumSize: const Size(96, 48)), child: Text(label, style: const TextStyle(fontSize: 16))),
      );
}

class _BigIcon extends StatelessWidget {
  const _BigIcon({super.key, required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => IconButton.filledTonal(onPressed: onTap, iconSize: 28, constraints: const BoxConstraints(minWidth: 52, minHeight: 52), tooltip: label, icon: Icon(icon, semanticLabel: label));
}

class _Notice extends StatelessWidget {
  const _Notice({super.key, required this.text, required this.color, required this.live});
  final String text;
  final Color color;
  final bool live;
  @override
  Widget build(BuildContext context) => Semantics(
        liveRegion: live,
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: color.withValues(alpha: 0.18), border: Border.all(color: color), borderRadius: BorderRadius.circular(10)),
          child: Text(text, style: const TextStyle(color: Colors.white, fontSize: 16)),
        ),
      );
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});
  final String title;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(header: true, child: Text(title, style: const TextStyle(color: Colors.white54, fontSize: 14, fontWeight: FontWeight.w700, letterSpacing: 1.2))),
          const SizedBox(height: 6),
          ...children.map((w) => Padding(padding: const EdgeInsets.only(bottom: 6), child: w)),
        ]),
      );
}

class _ConfirmSheet extends StatelessWidget {
  const _ConfirmSheet({required this.title, required this.detail, required this.confirm, required this.color});
  final String title;
  final String detail;
  final String confirm;
  final Color color;
  @override
  Widget build(BuildContext context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(title, key: const Key('futures_confirm_title'), style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text(detail, style: const TextStyle(color: Colors.white70, fontSize: 16)),
            const SizedBox(height: 16),
            _BigButton(key: const Key('futures_confirm'), label: confirm, semantics: confirm, color: color, onTap: () => Navigator.of(context).pop(true)),
            const SizedBox(height: 10),
            _SmallButton(key: const Key('futures_confirm_cancel'), label: 'Not now', semantics: 'Not now; nothing is placed', onTap: () => Navigator.of(context).pop(false)),
          ]),
        ),
      );
}
