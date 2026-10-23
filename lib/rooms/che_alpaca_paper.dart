// The Alpaca PAPER dashboard in the Trading Room (owner, 2026-10-20): CHE's
// Alpaca paper stock account as Alpaca reports it, read from
// /api/trading/alpaca/dashboard. Account equity, open positions, orders by
// status, 5-minute candles with order and fill markers, and the account's
// equity history. An execution marker (a filled triangle) is drawn only from a
// fill Alpaca confirmed; an order that has not filled is a hollow ring at its
// limit price, coloured by its status, and never an execution. Tapping a
// marker, or its row in the list for VoiceOver, opens the receipt. Refreshes
// quietly while open so the owner can watch an order progress; nothing here
// speaks by itself or places an order. Alpaca stocks only: CHE's MNQ/NQ futures
// paper simulations and Tradovate are separate panels.

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_responsive.dart';
import '../che_ui/che_help.dart';
import 'che_trading_ledgers.dart' show EquityCurvePainter;
import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';
import 'che_trading_hud.dart';

const _up = Color(0xFF3DDC97);
const _down = Color(0xFFFF5C7A);
const _gold = CheColors.markets;
final _dim = CheColors.textDim;
final _panel = CheColors.surface;
final _stroke = CheColors.stroke;
const _blue = Color(0xFF6CB4FF);

double? _num(Object? v) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}');
String _money(Object? v) {
  final x = _num(v);
  if (x == null) return '—';
  final s = x.abs().toStringAsFixed(2).replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return '${x < 0 ? '−' : ''}\$$s';
}

String _clock(Object? iso) {
  final t = DateTime.tryParse('${iso ?? ''}');
  if (t == null) return '—';
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.month}/${l.day} ${two(l.hour)}:${two(l.minute)}';
}

/// Alpaca's order status groups, in the order the owner reads them, with a
/// plain-English label and a colour. The label always accompanies the colour.
final kAlpacaStatusGroups = <String, (String, Color)>{
  'submitted': ('Submitted', _blue),
  'accepted': ('Accepted, waiting', _blue),
  'partially_filled': ('Partially filled', _gold),
  'filled': ('Filled', _up),
  'canceled': ('Canceled', _dim),
  'rejected': ('Rejected', _down),
  'expired': ('Expired', _dim),
  'other': ('Other status', _dim),
};

/// What CHE is asked when the owner taps Read aloud (the Worker's Alpaca dashboard route).
const kReadAlpacaAloud = 'Show me my Alpaca trades.';

const kAlpacaHelp = CheHelpTopic(
  title: 'Alpaca stocks (PAPER)',
  summary: 'Your Alpaca paper account as Alpaca reports it. No real money; separate from CHE\'s MNQ/NQ simulations and Tradovate.',
  items: [
    CheControlHelp(name: 'PAPER badge', does: 'Marks everything here as Alpaca\'s paper account: no real money'),
    CheControlHelp(name: 'Symbol chips', does: 'Choose which stock the chart shows'),
    CheControlHelp(name: 'Chart markers', does: 'A filled dot is a fill Alpaca confirmed; a ring is an order that has not filled, at its limit or stop price. Each opens its receipt'),
    CheControlHelp(name: 'Order list', does: 'Every order with its status: submitted, accepted, partially filled, filled, canceled, rejected or expired. Each opens its receipt'),
    CheControlHelp(name: 'Read aloud', does: 'Reads a short summary of the account and the latest orders', say: 'show me my Alpaca trades'),
  ],
);

/// One marker on the chart: a confirmed fill, or an order shown by its status.
class AlpacaMarker {
  const AlpacaMarker({required this.time, required this.price, required this.fill, required this.order, this.fillRecord});
  final DateTime time;
  final double price;
  final bool fill;
  final Map<String, dynamic> order;
  final Map<String, dynamic>? fillRecord;

  String get label {
    final side = '${order['side']}' == 'sell' ? 'Sell' : 'Buy';
    if (fill) return '$side fill, ${_num(fillRecord?['qty'])?.toStringAsFixed(0) ?? '?'} shares of ${order['symbol'] ?? fillRecord?['symbol']} at ${_money(price)}, ${_clock(fillRecord?['time'])}, confirmed by Alpaca';
    final group = kAlpacaStatusGroups['${order['status_group']}']?.$1 ?? '${order['status']}';
    return '$side order, ${_num(order['qty'])?.toStringAsFixed(0) ?? '?'} shares of ${order['symbol']} at limit ${_money(price)}, ${_clock(order['submitted_at'])}, $group, not an execution';
  }
}

/// The markers for one symbol: fills from Alpaca's FILL activities, and each
/// unfilled order with a limit price. Market orders that never filled have no
/// price to draw and appear only in the order list.
List<AlpacaMarker> alpacaMarkers(Map<String, dynamic> d, String symbol) {
  final orders = {for (final o in (d['orders'] as List? ?? const []).whereType<Map>()) '${o['id']}': o.cast<String, dynamic>()};
  final out = <AlpacaMarker>[];
  for (final f in (d['fills'] as List? ?? const []).whereType<Map>()) {
    if ('${f['symbol']}' != symbol) continue;
    final t = DateTime.tryParse('${f['time']}');
    final p = _num(f['price']);
    if (t == null || p == null) continue;
    out.add(AlpacaMarker(time: t, price: p, fill: true, order: orders['${f['order_id']}'] ?? {'symbol': f['symbol'], 'side': f['side'], 'id': f['order_id']}, fillRecord: f.cast<String, dynamic>()));
  }
  for (final o in orders.values) {
    if ('${o['symbol']}' != symbol || o['status_group'] == 'filled') continue;
    final t = DateTime.tryParse('${o['submitted_at']}');
    final p = _num(o['limit_price']) ?? _num(o['stop_price']);
    if (t == null || p == null) continue;
    out.add(AlpacaMarker(time: t, price: p, fill: false, order: o));
  }
  out.sort((a, b) => a.time.compareTo(b.time));
  return out;
}

class CheAlpacaPaperPanel extends StatefulWidget {
  const CheAlpacaPaperPanel({super.key, required this.baseUrl, required this.headers, required this.onAsk, this.client, this.refresh = const Duration(seconds: 15)});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  final http.Client? client;
  final Duration refresh;

  @override
  State<CheAlpacaPaperPanel> createState() => _CheAlpacaPaperPanelState();
}

class _CheAlpacaPaperPanelState extends State<CheAlpacaPaperPanel> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic>? _d;
  String _error = '';
  String _symbol = '';
  DateTime? _readAt;
  bool _stale = false;
  Timer? _timer;
  Object? _help;

  @override
  void initState() {
    super.initState();
    _help = CheHelp.register(context, () => kAlpacaHelp);
    _load();
    _timer = Timer.periodic(widget.refresh, (_) => _load());
  }

  @override
  void dispose() {
    CheHelp.unregister(_help);
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final q = _symbol.isEmpty ? '' : '?symbol=${Uri.encodeQueryComponent(_symbol)}';
      final r = await _http.get(Uri.parse('${widget.baseUrl()}/api/trading/alpaca/dashboard$q'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(r.body);
      if (!mounted) return;
      if (r.statusCode != 200 || j is! Map) {
        setState(() { _error = j is Map ? '${j['detail'] ?? 'HTTP ${r.statusCode}'}' : 'HTTP ${r.statusCode}'; _stale = _d != null; });
        return;
      }
      setState(() { _d = j.cast<String, dynamic>(); _error = ''; _stale = false; _readAt = DateTime.now(); });
    } catch (e) {
      if (mounted) setState(() { _error = 'Could not reach CHE ($e)'; _stale = _d != null; });
    }
  }

  void _pick(String symbol) {
    setState(() => _symbol = symbol);
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    // A Material (not a decorated box) so the receipt rows' ink shows on the panel.
    return Material(
      color: _panel,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: _stroke)),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _header(d),
          const SizedBox(height: 8),
          if (d == null && _error.isEmpty) Padding(padding: EdgeInsets.all(12), child: Text('Reading the Alpaca paper account…', style: TextStyle(color: _dim))),
          if (d == null && _error.isNotEmpty) Text('I could not read the Alpaca paper account: $_error', style: const TextStyle(color: _down)),
          if (d != null) ..._body(d),
        ]),
      ),
    );
  }

  Widget _header(Map<String, dynamic>? d) {
    final age = _readAt == null ? null : DateTime.now().difference(_readAt!);
    final fresh = _readAt == null
        ? 'Not read yet'
        : _stale
            ? 'Last read ${_clock(_readAt!.toIso8601String())}; the latest refresh failed, so these may be out of date'
            : 'Read from Alpaca ${age!.inSeconds < 60 ? '${age.inSeconds} seconds' : '${age.inMinutes} minutes'} ago';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      CheTitleRow(
        leading: [
          Semantics(
            label: 'Paper account. No real money.',
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: _gold.withValues(alpha: 0.18), borderRadius: BorderRadius.circular(6), border: Border.all(color: _gold)),
              child: const ExcludeSemantics(child: Text('PAPER', style: TextStyle(color: _gold, fontWeight: FontWeight.w900, letterSpacing: 1.2))),
            ),
          ),
        ],
        title: const Text('Alpaca stocks', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800)),
        actions: [
          CheHelpButton(color: _dim, dense: true),
          TextButton.icon(
            style: TextButton.styleFrom(minimumSize: const Size(44, 44), padding: const EdgeInsets.symmetric(horizontal: 6)),
            onPressed: () => widget.onAsk(kReadAlpacaAloud),
            icon: const Icon(Icons.record_voice_over, size: 18),
            label: const Text('Read aloud'),
          ),
        ],
      ),
      Semantics(
        liveRegion: false,
        child: Row(children: [
          Icon(_stale ? Icons.warning_amber : Icons.circle, size: 10, color: _stale ? _gold : _up),
          const SizedBox(width: 6),
          Expanded(child: Text(fresh, style: TextStyle(color: _stale ? _gold : _dim, fontSize: 12))),
        ]),
      ),
      Text('Separate from CHE\'s MNQ/NQ futures paper simulations and from Tradovate. Nothing here is summed with them.', style: TextStyle(color: _dim, fontSize: 12)),
    ]);
  }

  List<Widget> _body(Map<String, dynamic> d) {
    final state = '${d['state']}';
    if (state == 'not_configured') {
      return const [Text('Alpaca paper is not connected. Add your Alpaca paper key in Trading Connections below; CHE checks it with Alpaca and refuses live keys. Until then there is nothing to show, and nothing is invented.', style: TextStyle(color: Colors.white))];
    }
    if (state != 'verified') {
      return [Text('Alpaca did not answer as expected (${d['error'] ?? state}). No numbers are shown for it.', style: const TextStyle(color: _down))];
    }
    final a = (d['account'] as Map?)?.cast<String, dynamic>() ?? const {};
    final orders = (d['orders'] as List? ?? const []).whereType<Map>().map((o) => o.cast<String, dynamic>()).toList();
    final fills = (d['fills'] as List? ?? const []).whereType<Map>().toList();
    final positions = (d['positions'] as List? ?? const []).whereType<Map>().map((p) => p.cast<String, dynamic>()).toList();
    final chart = (d['chart'] as Map?)?.cast<String, dynamic>() ?? const {};
    final symbol = '${chart['symbol'] ?? ''}';
    final symbols = <String>{for (final f in fills) '${f['symbol']}', for (final o in orders) '${o['symbol']}', for (final p in positions) '${p['symbol']}'}..removeWhere((s) => s.isEmpty || s == 'null');
    final markers = symbol.isEmpty ? <AlpacaMarker>[] : alpacaMarkers(d, symbol);
    final counts = (d['order_counts'] as Map?)?.cast<String, dynamic>() ?? const {};
    final realized = (d['realized'] as Map?)?.cast<String, dynamic>() ?? const {};
    final history = (d['history'] as List? ?? const []).whereType<Map>().map((p) => _num(p['profit_loss'])).whereType<double>().toList();
    return [
      Wrap(spacing: 8, runSpacing: 8, children: [
        _tile('Equity', _money(a['equity'])),
        _tile('Cash', _money(a['cash'])),
        _tile('Buying power', _money(a['buying_power'])),
        _pnl('Today', a['day_change']),
        _pnl('Unrealized', d['unrealized_pl']),
        _pnl('Realized (from fills)', realized['realized_pl'], note: '${realized['basis'] ?? ''}'),
      ]),
      const SizedBox(height: 12),
      if (orders.isEmpty && fills.isEmpty && positions.isEmpty)
        const Text('No trades yet on this paper account: no orders, no fills and no positions. When you approve a paper order, it appears here with its status as Alpaca confirms it.', style: TextStyle(color: Colors.white))
      else ...[
        if (symbols.length > 1)
          Wrap(spacing: 6, children: [
            for (final s in symbols)
              ChoiceChip(label: Text(s), selected: s == symbol, onSelected: (_) => _pick(s), tooltip: 'Chart $s'),
          ]),
        const SizedBox(height: 6),
        Text(symbol.isEmpty ? 'No symbol to chart yet.' : '$symbol, 5-minute candles (Alpaca IEX data)', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
        if (symbol.isNotEmpty) _chart(chart, markers),
        if ('${chart['error'] ?? ''}'.isNotEmpty && chart['error'] != null) Text('Candles unavailable: ${chart['error']}. Orders and fills are still listed below.', style: const TextStyle(color: _gold, fontSize: 12)),
        _legend(counts),
        if (markers.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text('On this chart', style: TextStyle(color: _dim, fontWeight: FontWeight.w700)),
          for (final m in markers.reversed.take(12))
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: Icon(m.fill ? Icons.change_history : Icons.radio_button_unchecked, color: m.fill ? (m.order['side'] == 'sell' ? _down : _up) : kAlpacaStatusGroups['${m.order['status_group']}']?.$2 ?? _dim),
              title: Text(m.label, style: const TextStyle(color: Colors.white, fontSize: 13)),
              onTap: () => _receipt(m.order, m.fillRecord),
            ),
        ],
        const SizedBox(height: 10),
        Text('Open positions', style: TextStyle(color: _dim, fontWeight: FontWeight.w700)),
        if (positions.isEmpty) const Text('No open positions.', style: TextStyle(color: Colors.white)),
        for (final p in positions) _position(p),
        const SizedBox(height: 10),
        Text('Orders, newest first', style: TextStyle(color: _dim, fontWeight: FontWeight.w700)),
        for (final o in orders.take(20)) _order(o),
      ],
      if (history.length >= 2) ...[
        const SizedBox(height: 10),
        Text('Account profit and loss, last month (Alpaca portfolio history)', style: TextStyle(color: _dim, fontWeight: FontWeight.w700)),
        Semantics(
          label: 'Account profit and loss over the last month, ending at ${_money(history.last)}',
          child: SizedBox(height: 90, child: CustomPaint(painter: EquityCurvePainter(points: history, unit: r'$'), size: Size.infinite)),
        ),
      ],
    ];
  }

  Widget _tile(String label, String value) => Semantics(
        label: '$label $value',
        child: ExcludeSemantics(
          child: Container(
            constraints: const BoxConstraints(minWidth: 130),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(border: Border.all(color: _stroke), borderRadius: BorderRadius.circular(10)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: TextStyle(color: _dim, fontSize: 12)),
              Text(value, style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w800)),
            ]),
          ),
        ),
      );

  /// Profit or loss: colour plus words ("up", "down", "flat"), never colour alone.
  Widget _pnl(String label, Object? value, {String note = ''}) {
    final x = _num(value);
    final word = x == null ? 'not measured' : x > 0 ? 'up' : x < 0 ? 'down' : 'flat';
    final color = x == null || x == 0 ? _dim : x > 0 ? _up : _down;
    return Tooltip(
      message: note,
      child: Semantics(
        label: '$label: $word ${x == null ? '' : _money(x.abs())}${note.isEmpty ? '' : '. $note'}',
        child: ExcludeSemantics(
          child: Container(
            constraints: const BoxConstraints(minWidth: 130),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(border: Border.all(color: color.withValues(alpha: 0.6)), borderRadius: BorderRadius.circular(10)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: TextStyle(color: _dim, fontSize: 12)),
              Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(x == null || x == 0 ? Icons.remove : x > 0 ? Icons.arrow_upward : Icons.arrow_downward, size: 16, color: color),
                Text(' $word ${x == null ? '' : _money(x.abs())}', style: TextStyle(color: color, fontSize: 16, fontWeight: FontWeight.w800)),
              ]),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _legend(Map<String, dynamic> counts) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Wrap(spacing: 10, runSpacing: 4, children: [
          for (final e in kAlpacaStatusGroups.entries)
            if ((_num(counts[e.key]) ?? 0) > 0 || e.key == 'filled')
              Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(e.key == 'filled' ? Icons.change_history : Icons.radio_button_unchecked, size: 14, color: e.value.$2),
                Text(' ${e.value.$1}: ${(_num(counts[e.key]) ?? 0).toStringAsFixed(0)}', style: const TextStyle(color: Colors.white, fontSize: 12)),
              ]),
        ]),
      );

  Widget _chart(Map<String, dynamic> chart, List<AlpacaMarker> markers) {
    final bars = (chart['bars'] as List? ?? const []).whereType<Map>().toList();
    return LayoutBuilder(builder: (context, box) {
      final size = Size(box.maxWidth, 240);
      final painter = AlpacaChartPainter(bars: bars, markers: markers);
      return Semantics(
        label: '${chart['symbol']} candles with ${markers.where((m) => m.fill).length} confirmed fills and ${markers.where((m) => !m.fill).length} unfilled orders. The markers are listed below the chart.',
        child: GestureDetector(
          onTapUp: (details) {
            final hit = painter.markerAt(details.localPosition, size);
            if (hit != null) _receipt(hit.order, hit.fillRecord);
          },
          child: CustomPaint(size: size, painter: painter),
        ),
      );
    });
  }

  Widget _position(Map<String, dynamic> p) {
    final pl = _num(p['unrealized_pl']);
    final color = pl == null || pl == 0 ? _dim : pl > 0 ? _up : _down;
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      title: Text('${p['symbol']} · ${p['side']} ${_num(p['qty'])?.toStringAsFixed(0)} shares at ${_money(p['avg_entry_price'])}', style: const TextStyle(color: Colors.white)),
      subtitle: Text('Now ${_money(p['current_price'])} · value ${_money(p['market_value'])}', style: TextStyle(color: _dim)),
      trailing: Text('${pl == null ? '' : pl >= 0 ? 'up ' : 'down '}${_money(pl?.abs())}', style: TextStyle(color: color, fontWeight: FontWeight.w800)),
    );
  }

  Widget _order(Map<String, dynamic> o) {
    final g = kAlpacaStatusGroups['${o['status_group']}'] ?? kAlpacaStatusGroups['other']!;
    final price = _num(o['filled_avg_price']) ?? _num(o['limit_price']);
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(o['status_group'] == 'filled' ? Icons.check_circle : Icons.radio_button_unchecked, color: g.$2),
      title: Text('${o['side'] == 'sell' ? 'Sell' : 'Buy'} ${_num(o['qty'])?.toStringAsFixed(0)} ${o['symbol']} · ${o['type']}${price == null ? '' : ' · ${_money(price)}'}', style: const TextStyle(color: Colors.white)),
      subtitle: Text('${g.$1} · ${_clock(o['submitted_at'])}${(_num(o['filled_qty']) ?? 0) > 0 && o['status_group'] != 'filled' ? ' · ${_num(o['filled_qty'])!.toStringAsFixed(0)} filled so far' : ''}', style: TextStyle(color: g.$2)),
      onTap: () => _receipt(o, null),
    );
  }

  void _receipt(Map<String, dynamic> order, Map<String, dynamic>? fill) {
    final fills = (_d?['fills'] as List? ?? const []).whereType<Map>().where((f) => '${f['order_id']}' == '${order['id']}').toList();
    final g = kAlpacaStatusGroups['${order['status_group']}']?.$1 ?? '${order['status'] ?? 'unknown'}';
    final rows = <(String, String)>[
      ('Symbol', '${order['symbol'] ?? fill?['symbol'] ?? '—'}'),
      ('Side', '${order['side'] ?? fill?['side'] ?? '—'}'),
      ('Quantity', '${_num(order['qty'])?.toStringAsFixed(0) ?? '—'} shares'),
      ('Type', '${order['type'] ?? '—'}${_num(order['limit_price']) != null ? ', limit ${_money(order['limit_price'])}' : ''}'),
      ('Status (Alpaca)', '$g (${order['status'] ?? '—'})'),
      ('Submitted', _clock(order['submitted_at'])),
      ('Filled', '${_num(order['filled_qty'])?.toStringAsFixed(0) ?? '0'} shares${_num(order['filled_avg_price']) != null ? ' at an average ${_money(order['filled_avg_price'])}' : ''}${order['filled_at'] != null ? ', ${_clock(order['filled_at'])}' : ''}'),
      if (order['canceled_at'] != null) ('Canceled', _clock(order['canceled_at'])),
      if (order['expired_at'] != null) ('Expired', _clock(order['expired_at'])),
      ('Alpaca order id', '${order['id'] ?? '—'}'),
      ('Request id', '${order['client_order_id'] ?? '—'}'),
    ];
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: _panel,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Order receipt (Alpaca PAPER)', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            for (final r in rows)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  SizedBox(width: 130, child: Text(r.$1, style: TextStyle(color: _dim))),
                  Expanded(child: Text(r.$2, style: const TextStyle(color: Colors.white))),
                ]),
              ),
            const SizedBox(height: 8),
            Text(fills.isEmpty ? 'Fills: none confirmed by Alpaca.' : 'Fills confirmed by Alpaca:', style: TextStyle(color: _dim, fontWeight: FontWeight.w700)),
            for (final f in fills) Text('${_num(f['qty'])?.toStringAsFixed(0)} shares at ${_money(f['price'])}, ${_clock(f['time'])} (${f['kind']})', style: const TextStyle(color: Colors.white)),
            const SizedBox(height: 8),
            Text('Paper money only. CHE shows what Alpaca reports and never marks an order as executed before Alpaca confirms a fill.', style: TextStyle(color: _dim, fontSize: 12)),
            Align(alignment: Alignment.centerRight, child: TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Close receipt'))),
          ]),
        ),
      ),
    );
  }
}

/// Five-minute candles with Alpaca markers: a filled triangle per confirmed
/// fill (up for a buy, down for a sell) and a hollow ring per unfilled order at
/// its limit price, coloured by status.
class AlpacaChartPainter extends CustomPainter {
  AlpacaChartPainter({required this.bars, required this.markers});
  final List<Map> bars;
  final List<AlpacaMarker> markers;
  static const _right = 56.0;

  ({double lo, double hi, List<DateTime> times})? _frame() {
    if (bars.isEmpty) return null;
    var lo = double.infinity;
    var hi = -double.infinity;
    for (final b in bars) {
      lo = math.min(lo, _num(b['l']) ?? lo);
      hi = math.max(hi, _num(b['h']) ?? hi);
    }
    for (final m in markers) {
      lo = math.min(lo, m.price);
      hi = math.max(hi, m.price);
    }
    if (!(hi > lo)) hi = lo + 1;
    final pad = (hi - lo) * 0.06;
    return (lo: lo - pad, hi: hi + pad, times: [for (final b in bars) DateTime.tryParse('${b['t']}') ?? DateTime(1970)]);
  }

  Offset? _at(AlpacaMarker m, Size size) {
    final f = _frame();
    if (f == null) return null;
    final w = (size.width - _right) / bars.length;
    var i = f.times.lastIndexWhere((t) => !t.isAfter(m.time));
    if (i < 0) return null; // before the first candle shown: listed, not drawn
    i = math.min(i, bars.length - 1);
    return Offset(i * w + w / 2, size.height - (m.price - f.lo) / (f.hi - f.lo) * size.height);
  }

  AlpacaMarker? markerAt(Offset p, Size size) {
    AlpacaMarker? best;
    var bestD = 20.0;
    for (final m in markers) {
      final o = _at(m, size);
      if (o == null) continue;
      final dd = (o - p).distance;
      if (dd < bestD) { bestD = dd; best = m; }
    }
    return best;
  }

  @override
  void paint(Canvas canvas, Size size) {
    // In the HUD look the plot is a darkened window, so the backdrop still reads through it.
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFF05080A).withValues(alpha: cheHudActive ? 0.55 : 1));
    final f = _frame();
    if (f == null) {
      final tp = TextPainter(text: TextSpan(text: 'No candles for this symbol yet', style: TextStyle(color: _dim)), textDirection: TextDirection.ltr)..layout();
      tp.paint(canvas, Offset(size.width / 2 - tp.width / 2, size.height / 2));
      return;
    }
    double y(double v) => size.height - (v - f.lo) / (f.hi - f.lo) * size.height;
    final w = (size.width - _right) / bars.length;
    final grid = Paint()..color = _stroke..strokeWidth = 1;
    for (var k = 0; k <= 4; k++) {
      final v = f.lo + (f.hi - f.lo) * k / 4;
      canvas.drawLine(Offset(0, y(v)), Offset(size.width - _right, y(v)), grid);
      final tp = TextPainter(text: TextSpan(text: v.toStringAsFixed(2), style: TextStyle(color: _dim, fontSize: 10)), textDirection: TextDirection.ltr)..layout();
      tp.paint(canvas, Offset(size.width - _right + 4, y(v) - 6));
    }
    for (var i = 0; i < bars.length; i++) {
      final b = bars[i];
      final o = _num(b['o']), h = _num(b['h']), l = _num(b['l']), c = _num(b['c']);
      if (o == null || h == null || l == null || c == null) continue;
      final x = i * w + w / 2;
      final p = Paint()..color = c >= o ? _up : _down..strokeWidth = 1;
      canvas.drawLine(Offset(x, y(h)), Offset(x, y(l)), p);
      final top = y(math.max(o, c));
      canvas.drawRect(Rect.fromLTRB(x - w * 0.35, top, x + w * 0.35, math.max(y(math.min(o, c)), top + 1)), p..style = PaintingStyle.fill);
    }
    for (final m in markers) {
      final at = _at(m, size);
      if (at == null) continue;
      if (m.fill) {
        final buy = m.order['side'] != 'sell';
        final path = Path();
        if (buy) { path.moveTo(at.dx, at.dy - 8); path.lineTo(at.dx - 6, at.dy + 3); path.lineTo(at.dx + 6, at.dy + 3); } else { path.moveTo(at.dx, at.dy + 8); path.lineTo(at.dx - 6, at.dy - 3); path.lineTo(at.dx + 6, at.dy - 3); }
        canvas.drawPath(path..close(), Paint()..color = buy ? _up : _down);
        canvas.drawPath(path, Paint()..color = Colors.white..style = PaintingStyle.stroke..strokeWidth = 1);
      } else {
        final color = kAlpacaStatusGroups['${m.order['status_group']}']?.$2 ?? _dim;
        canvas.drawCircle(at, 6, Paint()..color = color..style = PaintingStyle.stroke..strokeWidth = 2);
      }
    }
  }

  @override
  bool shouldRepaint(covariant AlpacaChartPainter old) => !identical(old.bars, bars) || !identical(old.markers, markers);
}

/// The Alpaca PAPER dashboard as its own page: opened when the owner asks
/// "show me my Alpaca trades". Back returns to where the owner was.
class CheAlpacaPaperPage extends StatelessWidget {
  const CheAlpacaPaperPage({super.key, required this.baseUrl, required this.headers, required this.onAsk, this.client});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  final http.Client? client;

  static Route<void> route({required String Function() baseUrl, required Map<String, String> Function() headers, required void Function(String prompt) onAsk, http.Client? client}) =>
      MaterialPageRoute<void>(builder: (_) => CheAlpacaPaperPage(baseUrl: baseUrl, headers: headers, onAsk: onAsk, client: client), settings: const RouteSettings(name: 'alpaca_paper'));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: cheTradingPage(const Color(0xFF05080A)),
      appBar: AppBar(
        backgroundColor: cheTradingPage(const Color(0xFF05080A)),
        title: cheHudActive
            ? const CheChromeText('Alpaca paper trades', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800))
            : const Text('Alpaca paper trades'),
        actions: const [CheHelpButton()],
        leading: IconButton(tooltip: 'Back to where you were', icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        CheAlpacaPaperPanel(baseUrl: baseUrl, headers: headers, onAsk: onAsk, client: client),
      ]),
    );
  }
}
