// Live paper trading in the Trading Room (owner, 2026-10-18): what CHE's forward
// paper engine is doing, from its records only. The chart, positions, history and
// statistics all come from /api/trading/live; nothing here computes a result of
// its own or claims a trade the journal does not hold. Refreshes quietly; it never
// speaks by itself. "Read aloud" asks CHE, who answers from the same records.

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

const _up = Color(0xFF3DDC97);
const _down = Color(0xFFFF5C7A);
const _gold = Color(0xFFE8B04A);
const _dim = Color(0xFF8FA4A1);
const _panel = Color(0xFF0A1214);
const _stroke = Color(0xFF1B2A2D);

double? _num(Object? v) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}');
String _money(Object? v) {
  final x = _num(v);
  if (x == null) return '—';
  return '${x < 0 ? '−' : ''}\$${x.abs().toStringAsFixed(2)}';
}

String _clock(Object? iso) {
  final t = DateTime.tryParse('${iso ?? ''}');
  if (t == null) return '—';
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.month}/${l.day} ${two(l.hour)}:${two(l.minute)}';
}

class CheLivePaperPanel extends StatefulWidget {
  const CheLivePaperPanel({super.key, required this.baseUrl, required this.headers, required this.onAsk, this.client, this.refresh = const Duration(seconds: 30)});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  final http.Client? client;
  final Duration refresh;

  @override
  State<CheLivePaperPanel> createState() => _CheLivePaperPanelState();
}

class _CheLivePaperPanelState extends State<CheLivePaperPanel> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic>? _d;
  String _error = '';
  String _status = '';
  bool _busy = false;
  bool _showFeedDetails = false;
  Timer? _timer;
  final Set<String> _open = {};

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(widget.refresh, (_) => _load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl()}/api/trading/live'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (!mounted) return;
      if (r.statusCode != 200 || j is! Map || j['account'] == null) {
        // An older CHE server has no paper trading records yet: say so in one quiet line.
        setState(() => _error = j is Map && j['detail'] != null ? '${j['detail']}' : 'Paper trading records are not available from CHE yet (${r.statusCode}).');
        return;
      }
      setState(() { _d = Map<String, dynamic>.from(j); _error = ''; });
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not reach CHE for the paper trading records.');
    }
  }

  Future<void> _switch(bool on) async {
    if (_busy) return;
    setState(() { _busy = true; _status = ''; });
    try {
      final r = await _http.post(Uri.parse('${widget.baseUrl()}/api/trading/live'),
          headers: {...widget.headers(), 'content-type': 'application/json'}, body: jsonEncode({'action': on ? 'start' : 'stop'})).timeout(const Duration(seconds: 30));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      final ok = r.statusCode == 200 && j is Map && j['ok'] == true;
      HapticFeedback.mediumImpact();
      if (!mounted) return;
      setState(() {
        _status = ok ? (on ? 'Paper trading is on.' : 'Paper trading is off. Every record is kept.') : 'Not changed: ${j is Map ? j['detail'] ?? r.statusCode : r.statusCode}.';
        if (ok && j['dashboard'] is Map) _d = Map<String, dynamic>.from(j['dashboard'] as Map);
      });
    } catch (_) {
      HapticFeedback.heavyImpact();
      if (mounted) setState(() => _status = 'Not changed: CHE did not answer.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _badge(String text, Color color, {String? label}) => Semantics(
        label: label ?? text,
        excludeSemantics: true,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(border: Border.all(color: color), borderRadius: BorderRadius.circular(6), color: color.withValues(alpha: 0.12)),
          child: Text(text, style: TextStyle(color: color, fontWeight: FontWeight.w800, fontSize: 12, letterSpacing: 0.6)),
        ),
      );

  Widget _stat(String label, String value, {Color? color}) => Semantics(
        label: '$label: $value',
        excludeSemantics: true,
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: _panel, border: Border.all(color: _stroke), borderRadius: BorderRadius.circular(10)),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: _dim, fontSize: 12)),
            const SizedBox(height: 2),
            FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft,
              child: Text(value, style: TextStyle(color: color ?? Colors.white, fontSize: 18, fontWeight: FontWeight.w800, fontFeatures: const [FontFeature.tabularFigures()]))),
          ]),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final d = _d;
    if (d == null) {
      return Padding(
        padding: const EdgeInsets.all(12),
        child: Text(_error.isEmpty ? 'Loading paper trading records…' : _error, style: const TextStyle(color: _dim, fontSize: 16)),
      );
    }
    final feed = d['feed'] is Map ? Map<String, dynamic>.from(d['feed'] as Map) : <String, dynamic>{};
    final status = '${feed['status'] ?? 'NO DATA'}';
    final statusColor = status == 'LIVE' ? _up : status == 'DELAYED' ? _gold : _down;
    final state = d['state'] is Map ? Map<String, dynamic>.from(d['state'] as Map) : <String, dynamic>{};
    final enabled = state['enabled'] == true;
    final totals = d['totals'] is Map ? Map<String, dynamic>.from(d['totals'] as Map) : <String, dynamic>{};
    final counts = d['counts'] is Map ? Map<String, dynamic>.from(d['counts'] as Map) : <String, dynamic>{};
    final positions = (d['positions'] as List? ?? const []).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
    final trades = (d['trades'] as List? ?? const []).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
    final ranking = (d['by_strategy'] as List? ?? const []).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
    final session = d['session'] is Map ? '${(d['session'] as Map)['state'] ?? ''}' : '';
    final contract = d['contract'] is Map ? '${(d['contract'] as Map)['code'] ?? ''}' : '';
    final lagMin = _num(feed['latency_s']) == null ? null : (_num(feed['latency_s'])! / 60).round();
    final minTrades = (d['min_trades'] as num?)?.toInt() ?? 30;
    final n = (totals['trades'] as num?)?.toInt() ?? 0;
    final broker = d['broker'] is Map ? Map<String, dynamic>.from(d['broker'] as Map) : <String, dynamic>{};
    final tradovate = broker['tradovate'] is Map ? Map<String, dynamic>.from(broker['tradovate'] as Map) : <String, dynamic>{};
    final backtest = d['backtest'] is Map ? Map<String, dynamic>.from(d['backtest'] as Map) : null;

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Text('CHE PAPER CHART', style: TextStyle(color: Colors.white, fontSize: 21, fontWeight: FontWeight.w900)),
      const SizedBox(height: 6),
      Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
        _badge('PAPER', _up, label: 'Simulated trades; no real money'),
        _badge(status, statusColor, label: 'Market data: $status'),
        Text('Engine ${enabled ? 'running' : 'stopped'}', style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700)),
      ]),
      const SizedBox(height: 8),
      Semantics(
        liveRegion: false,
        child: Text(
          '${feed['provider_symbol'] ?? 'MNQ'} · $contract · 5-minute candles\n'
          'Last closed bar: ${_clock(feed['last_bar_time'])}${lagMin == null ? '' : ' · about $lagMin min old'}\n'
          'Source: ${feed['provider'] ?? 'not connected'} · market $session',
          style: const TextStyle(color: Colors.white70, fontSize: 15, height: 1.45),
        ),
      ),
      if (status != 'LIVE') ...[
        const SizedBox(height: 8),
        Text(
          status == 'DELAYED'
              ? 'Prices are delayed. The chart and paper fills update from recorded bars, not a live CME quote.'
              : 'No verified market feed is available. Any chart still visible shows previously saved bars.',
          style: const TextStyle(color: _gold, fontSize: 15, fontWeight: FontWeight.w700, height: 1.35),
        ),
        TextButton.icon(
          onPressed: () => setState(() => _showFeedDetails = !_showFeedDetails),
          icon: Icon(_showFeedDetails ? Icons.expand_less : Icons.info_outline),
          label: Text(_showFeedDetails ? 'Hide live-feed requirements' : status == 'DELAYED' ? 'Why are prices delayed?' : 'Why is the feed unavailable?'),
        ),
        if (_showFeedDetails)
          Text('${d['feed_blocker'] ?? 'A real-time market-data subscription and verified broker feed are required.'}'
            '${feed['error'] == null ? '' : ' Last error: ${feed['error']}.'}',
            style: const TextStyle(color: _dim, fontSize: 14, height: 1.4)),
      ],
      const SizedBox(height: 4),
      Text('Chart refreshes every ${widget.refresh.inSeconds} seconds when open; new candles appear only when the source supplies a closed bar.',
        style: const TextStyle(color: _dim, fontSize: 13)),
      const SizedBox(height: 10),
      Semantics(
        label: 'Candlestick chart of ${feed['provider_symbol'] ?? 'MNQ'} five-minute bars with paper entries, exits, stops and targets marked. '
            '${positions.isEmpty ? 'No open position.' : '${positions.length} open positions.'} Ask CHE "show the chart where you entered" to hear the levels.',
        excludeSemantics: true,
        child: SizedBox(height: math.max(300.0, MediaQuery.sizeOf(context).height * 0.36), child: CustomPaint(painter: _PaperChartPainter(d))),
      ),
      const SizedBox(height: 10),
      Wrap(spacing: 8, runSpacing: 8, children: [
        Semantics(
          button: true,
          label: enabled ? 'Stop paper trading' : 'Start paper trading',
          child: FilledButton.icon(
            onPressed: _busy ? null : () => _switch(!enabled),
            icon: Icon(enabled ? Icons.stop_circle_outlined : Icons.play_circle_outline),
            label: Text(enabled ? 'Stop paper trading' : 'Start paper trading'),
          ),
        ),
        Semantics(button: true, label: 'Read trading performance aloud',
          child: OutlinedButton.icon(onPressed: () => widget.onAsk('Read me your trading performance.'), icon: const Icon(Icons.record_voice_over_outlined), label: const Text('Read aloud'))),
        Semantics(button: true, label: 'Refresh paper trading records',
          child: OutlinedButton.icon(onPressed: _load, icon: const Icon(Icons.refresh), label: const Text('Refresh'))),
      ]),
      if (_status.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_status, style: const TextStyle(color: Colors.white, fontSize: 16))),
      const SizedBox(height: 12),
      GridView.count(
        crossAxisCount: 2, shrinkWrap: true, physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 8, crossAxisSpacing: 8, childAspectRatio: 2.0,
        children: [
          _stat('Closed trades', '$n'),
          _stat('Win rate', totals['win_rate'] == null ? '—' : '${totals['win_rate']}%'),
          _stat('Net after costs', _money(totals['net_pnl']), color: (_num(totals['net_pnl']) ?? 0) >= 0 ? _up : _down),
          _stat('Open now', '${positions.length}'),
        ],
      ),
      ExpansionTile(
        title: const Text('More performance numbers', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
        children: [
          GridView.count(
            crossAxisCount: 2, shrinkWrap: true, physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: 8, crossAxisSpacing: 8, childAspectRatio: 2.0,
            children: [
              _stat('Won / lost', '${totals['wins'] ?? 0} / ${totals['losses'] ?? 0}'),
              _stat('Profit factor', '${totals['profit_factor'] ?? '—'}'),
              _stat('Expectancy', totals['expectancy_r'] == null ? '—' : '${totals['expectancy_r']} R'),
              _stat('Max drawdown', _money(totals['max_drawdown'])),
              _stat('Signals', '${counts['signals'] ?? 0}'),
            ],
          ),
        ],
      ),
      if (n < minTrades) Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Text('$n of $minTrades closed trades: not yet evidence. Nothing here is a profitability claim.', style: const TextStyle(color: _dim, fontSize: 13)),
      ),
      const SizedBox(height: 14),
      const Text('Open positions', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
      if (positions.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 6), child: Text('None open.', style: TextStyle(color: _dim))),
      for (final p in positions)
        Semantics(
          label: '${p['side']} ${p['qty']} ${p['contract']}, ${p['name']}, entry ${p['entry']}, stop ${p['stop']}, target ${p['target']}, unrealized ${_money(p['unrealized'])}',
          excludeSemantics: true,
          child: ListTile(
            dense: true, contentPadding: EdgeInsets.zero,
            leading: Icon(p['side'] == 'short' ? Icons.south_east : Icons.north_east, color: p['side'] == 'short' ? _down : _up),
            title: Text('${'${p['side']}'.toUpperCase()} ${p['qty']} ${p['contract']} · ${p['name']}', style: const TextStyle(color: Colors.white)),
            subtitle: Text('Entry ${p['entry']} at ${_clock(p['entry_time'])} · stop ${p['stop']} · target ${p['target']}\n${p['why'] ?? ''}', style: const TextStyle(color: _dim)),
            trailing: Text(_money(p['unrealized']), style: TextStyle(color: (_num(p['unrealized']) ?? 0) >= 0 ? _up : _down, fontWeight: FontWeight.w800)),
          ),
        ),
      ExpansionTile(
        title: const Text('Strategies', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
        subtitle: const Text('Review forward-paper strategy results', style: TextStyle(color: _dim, fontSize: 14)),
        children: [
      const SizedBox(height: 12),
      const Text('Strategies (forward paper)', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
      if (ranking.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 6), child: Text('No strategy has closed a trade yet.', style: TextStyle(color: _dim))),
      for (final s in ranking.take(12))
        Semantics(
          label: '${s['name']}, ${s['filter']}, ${s['target_r']} R target: ${s['trades']} trades, win rate ${s['win_rate'] ?? 'not measured'} percent, net ${_money(s['net_pnl'])}${s['ranked'] == true ? '' : ', too few trades to rank'}',
          excludeSemantics: true,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(children: [
              Expanded(child: Text('${s['name']} · ${s['filter']} · ${s['target_r']}R', style: const TextStyle(color: Colors.white))),
              Text('${s['trades']} tr · ${s['win_rate'] ?? '—'}% · ${_money(s['net_pnl'])}${s['ranked'] == true ? '' : ' ·'}', style: const TextStyle(color: _dim, fontFeatures: [FontFeature.tabularFigures()])),
              if (s['ranked'] != true) const Text(' small sample', style: TextStyle(color: _gold, fontSize: 12)),
            ]),
          ),
        ),
        ],
      ),
      ExpansionTile(
        title: const Text('Trade history', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
        subtitle: Text('$n closed trades · select a trade for its receipt', style: const TextStyle(color: _dim, fontSize: 14)),
        children: [
      const SizedBox(height: 12),
      Text('Trade history (${trades.length})', style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
      if (trades.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 6), child: Text('No paper trade has closed yet. Each one appears here with its receipt the moment it is recorded.', style: TextStyle(color: _dim))),
      for (final t in trades.take(60)) _tradeTile(t),
        ],
      ),
      ExpansionTile(
        title: const Text('Broker status and backtests', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
        subtitle: const Text('Connections, requirements and historical tests', style: TextStyle(color: _dim, fontSize: 14)),
        children: [
      const SizedBox(height: 12),
      const Text('Broker and accounts', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
      Text(
        'Tradovate / NinjaTrader: ${tradovate['signed_in'] == true ? 'signed in' : tradovate['expired'] == true ? 'sign-in expired, reconnect in Connections' : tradovate['app_configured'] == true ? 'not signed in; sign in from Connections' : 'not set up on the server'}.\n'
        'FundYourEdge: ${(broker['fundyouredge'] is Map ? (broker['fundyouredge'] as Map)['why'] : null) ?? 'not linked'}\n'
        'Live orders: ${broker['live_orders'] ?? 'disabled'}',
        style: const TextStyle(color: _dim, fontSize: 14),
      ),
      if (backtest != null && backtest['ok'] == true) ...[
        const SizedBox(height: 12),
        const Text('Historical baseline (backtest, not forward evidence)', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
        Text('${backtest['data'] ?? ''}', style: const TextStyle(color: _dim, fontSize: 12)),
        for (final row in ((backtest['rows'] as List?) ?? const []).whereType<Map>().take(8))
          Text('${row['name']} · ${row['filter']} · ${row['target_r']}R: ${(row['stats'] as Map?)?['trades'] ?? 0} trades, ${(row['stats'] as Map?)?['expectancy_r'] ?? '—'} R each, net ${_money((row['stats'] as Map?)?['net_pnl'])}',
              style: const TextStyle(color: _dim, fontSize: 13)),
      ],
        ],
      ),
      const SizedBox(height: 6),
      Text('${d['isolation'] ?? ''}', style: const TextStyle(color: _dim, fontSize: 12)),
    ]);
  }

  Widget _tradeTile(Map<String, dynamic> t) {
    final key = '${t['portfolio']}|${(t['entry'] as Map?)?['time']}';
    final entry = Map<String, dynamic>.from((t['entry'] as Map?) ?? const {});
    final exit = Map<String, dynamic>.from((t['exit'] as Map?) ?? const {});
    final review = Map<String, dynamic>.from((t['review'] as Map?) ?? const {});
    final net = _num(t['net_pnl']) ?? 0;
    final open = _open.contains(key);
    final summary = '${'${t['side']}'.toUpperCase()} ${t['qty']} ${t['contract']} · ${t['strategy']} · ${entry['fill']} → ${exit['fill']} (${exit['reason']}) · ${_money(net)}';
    return Semantics(
      button: true,
      label: '$summary. Entered ${_clock(entry['time'])}, exited ${_clock(exit['time'])}. Double tap for the receipt.',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => setState(() => open ? _open.remove(key) : _open.add(key)),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(net > 0 ? Icons.check_circle : net < 0 ? Icons.cancel : Icons.remove_circle_outline, color: net > 0 ? _up : net < 0 ? _down : _dim, size: 18),
              const SizedBox(width: 6),
              Expanded(child: Text(summary, style: const TextStyle(color: Colors.white))),
            ]),
            Text('${_clock(entry['time'])} → ${_clock(exit['time'])} · ${t['session']}', style: const TextStyle(color: _dim, fontSize: 12)),
            if (open) Padding(
              padding: const EdgeInsets.only(top: 4, left: 24),
              child: Text(
                [
                  'Trade ${t['portfolio']} @ ${entry['time']}',
                  'Strategy ${t['strategy']} ${t['strategy_version']} (${t['filter']})',
                  'Signal ${(t['signal'] as Map?)?['time']}: ${(t['signal'] as Map?)?['why']}',
                  'Entry ${entry['fill']} (open ${entry['raw']}), stop ${t['stop']}, target ${t['target']}, exit ${exit['fill']} on ${exit['reason']}',
                  'Gross ${_money(t['gross_before_costs'])}, costs ${_money(((t['costs'] as Map?)?.values.whereType<num>().fold<num>(0, (a, b) => a + b)))}, net ${_money(net)}, ${t['r_net']} R',
                  'Data: ${(t['data'] as Map?)?['label']}; ${((t['data'] as Map?)?['feed'] as Map?)?['status'] ?? ''} ${((t['data'] as Map?)?['feed'] as Map?)?['provider_symbol'] ?? ''}',
                  ...((review['facts'] as List?) ?? const []).map((f) => 'Fact: $f'),
                  ...((review['hypotheses'] as List?) ?? const []).map((h) => 'Possible reason (not proven): $h'),
                ].join('\n'),
                style: const TextStyle(color: _dim, fontSize: 13, height: 1.3),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Five-minute candles with paper marks: signals (dots), entries (triangles),
/// exits (crosses), and each open position's entry, stop and target lines.
class _PaperChartPainter extends CustomPainter {
  _PaperChartPainter(this.d);
  final Map<String, dynamic> d;

  @override
  void paint(Canvas canvas, Size size) {
    final bars = (d['bars'] as List? ?? const []).whereType<Map>().toList();
    final bg = Paint()..color = const Color(0xFF05080A);
    canvas.drawRect(Offset.zero & size, bg);
    if (bars.isEmpty) {
      final tp = TextPainter(text: const TextSpan(text: 'No bars yet', style: TextStyle(color: _dim)), textDirection: TextDirection.ltr)..layout();
      tp.paint(canvas, Offset(size.width / 2 - tp.width / 2, size.height / 2));
      return;
    }
    final shown = bars.length > 90 ? bars.sublist(bars.length - 90) : bars;
    final times = shown.map((b) => '${b['t']}').toList();
    final positions = (d['positions'] as List? ?? const []).whereType<Map>().toList();
    final trades = (d['trades'] as List? ?? const []).whereType<Map>().toList();
    var lo = double.infinity; var hi = -double.infinity;
    for (final b in shown) { lo = math.min(lo, _num(b['l']) ?? lo); hi = math.max(hi, _num(b['h']) ?? hi); }
    for (final p in positions) { for (final k in ['stop', 'target']) { final v = _num(p[k]); if (v != null) { lo = math.min(lo, v); hi = math.max(hi, v); } } }
    if (!(hi > lo)) { hi = lo + 1; }
    final pad = (hi - lo) * 0.06;
    lo -= pad; hi += pad;
    const right = 52.0;
    final w = (size.width - right) / shown.length;
    double y(double v) => size.height - (v - lo) / (hi - lo) * size.height;
    double? xOf(String time) {
      final i = times.indexWhere((t) => t.compareTo(time) >= 0);
      if (i < 0) return null;
      return i * w + w / 2;
    }
    final grid = Paint()..color = _stroke..strokeWidth = 1;
    for (var k = 0; k <= 4; k++) {
      final v = lo + (hi - lo) * k / 4;
      canvas.drawLine(Offset(0, y(v)), Offset(size.width - right, y(v)), grid);
      final tp = TextPainter(text: TextSpan(text: v.toStringAsFixed(2), style: const TextStyle(color: _dim, fontSize: 10)), textDirection: TextDirection.ltr)..layout();
      tp.paint(canvas, Offset(size.width - right + 4, y(v) - 6));
    }
    for (var i = 0; i < shown.length; i++) {
      final b = shown[i];
      final o = _num(b['o'])!, h = _num(b['h'])!, l = _num(b['l'])!, c = _num(b['c'])!;
      final x = i * w + w / 2;
      final color = c >= o ? _up : _down;
      final p = Paint()..color = color..strokeWidth = 1;
      canvas.drawLine(Offset(x, y(h)), Offset(x, y(l)), p);
      final top = y(math.max(o, c)); final bottom = y(math.min(o, c));
      canvas.drawRect(Rect.fromLTRB(x - w * 0.35, top, x + w * 0.35, math.max(bottom, top + 1)), p..style = PaintingStyle.fill);
    }
    void tri(double x, double yy, bool upward, Color color) {
      final path = Path();
      if (upward) { path.moveTo(x, yy - 7); path.lineTo(x - 5, yy + 2); path.lineTo(x + 5, yy + 2); } else { path.moveTo(x, yy + 7); path.lineTo(x - 5, yy - 2); path.lineTo(x + 5, yy - 2); }
      canvas.drawPath(path..close(), Paint()..color = color);
    }
    for (final s in (d['signals'] as List? ?? const []).whereType<Map>()) {
      final x = xOf('${s['time']}');
      final v = _num(s['ref']);
      if (x != null && v != null) canvas.drawCircle(Offset(x, y(v)), 2.5, Paint()..color = _gold);
    }
    for (final t in trades) {
      final e = t['entry'] as Map?; final x = t['exit'] as Map?;
      final ex = xOf('${e?['time']}'); final xx = xOf('${x?['time']}');
      final long = t['side'] != 'short';
      if (ex != null && _num(e?['fill']) != null) tri(ex, y(_num(e!['fill'])!), long, long ? _up : _down);
      if (xx != null && _num(x?['fill']) != null) {
        final yy = y(_num(x!['fill'])!);
        final p = Paint()..color = Colors.white..strokeWidth = 1.6;
        canvas.drawLine(Offset(xx - 4, yy - 4), Offset(xx + 4, yy + 4), p);
        canvas.drawLine(Offset(xx - 4, yy + 4), Offset(xx + 4, yy - 4), p);
      }
    }
    for (final pos in positions) {
      final ex = xOf('${pos['entry_time']}') ?? 0;
      void level(Object? v, Color color) {
        final n = _num(v);
        if (n == null) return;
        final p = Paint()..color = color..strokeWidth = 1.2;
        for (var x = ex; x < size.width - right; x += 8) {
          canvas.drawLine(Offset(x, y(n)), Offset(math.min(x + 4, size.width - right), y(n)), p);
        }
      }
      level(pos['target'], _up);
      level(pos['stop'], _down);
      level(pos['entry'], Colors.white70);
      if (_num(pos['entry']) != null) tri(ex, y(_num(pos['entry'])!), pos['side'] != 'short', pos['side'] == 'short' ? _down : _up);
    }
  }

  @override
  bool shouldRepaint(covariant _PaperChartPainter old) => !identical(old.d, d);
}
