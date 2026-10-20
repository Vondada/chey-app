// Trade records by source in the Trading Room (owner, 2026-10-20): every record
// set CHE keeps, read from /api/trading/ledgers and shown separately, each
// labelled with its source, its own count, win rate, net or expectancy, feed
// health, per-strategy rows and an equity curve. Nothing here adds two sets
// together, computes a result of its own, or speaks by itself. "Read aloud"
// asks CHE, who answers from the same records. Paper only.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
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

String _r(Object? v) {
  final x = _num(v);
  if (x == null) return '—';
  return '${x >= 0 ? '+' : '−'}${x.abs().toStringAsFixed(2)} R';
}

String _clock(Object? iso) {
  final t = DateTime.tryParse('${iso ?? ''}');
  if (t == null) return '—';
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.month}/${l.day} ${two(l.hour)}:${two(l.minute)}';
}

/// The spoken request that reads the same record sets aloud (the Worker's
/// che_trading_ledgers route: the simulation and the paper journal, separately).
const kReadLedgersAloud = 'Read me the simulation and the paper journal records.';

class CheTradingLedgersPanel extends StatefulWidget {
  const CheTradingLedgersPanel({super.key, required this.baseUrl, required this.headers, required this.onAsk, this.client, this.refresh = const Duration(seconds: 60)});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  final http.Client? client;
  final Duration refresh;

  @override
  State<CheTradingLedgersPanel> createState() => _CheTradingLedgersPanelState();
}

class _CheTradingLedgersPanelState extends State<CheTradingLedgersPanel> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic>? _d;
  String _error = '';
  Timer? _timer;

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
      final r = await _http.get(Uri.parse('${widget.baseUrl()}/api/trading/ledgers'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (!mounted) return;
      if (r.statusCode != 200 || j is! Map || j['ledgers'] is! List) {
        // An older CHE server has no record-set view yet: say so in one quiet line.
        setState(() => _error = j is Map && j['detail'] != null ? '${j['detail']}' : 'Trade record sets are not available from CHE yet (${r.statusCode}).');
        return;
      }
      setState(() { _d = Map<String, dynamic>.from(j); _error = ''; });
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not reach CHE for the trade record sets.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    if (d == null) {
      return Padding(
        padding: const EdgeInsets.all(12),
        child: Text(_error.isEmpty ? 'Loading trade record sets…' : _error, style: const TextStyle(color: _dim, fontSize: 16)),
      );
    }
    final ledgers = (d['ledgers'] as List).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        const Expanded(child: Text('Trade records by source', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800))),
        Semantics(
          label: 'Paper only',
          excludeSemantics: true,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(border: Border.all(color: _gold), borderRadius: BorderRadius.circular(6), color: _gold.withValues(alpha: 0.12)),
            child: const Text('PAPER', style: TextStyle(color: _gold, fontWeight: FontWeight.w800, fontSize: 12, letterSpacing: 0.6)),
          ),
        ),
      ]),
      const SizedBox(height: 4),
      Text('${d['note'] ?? 'Each count is that record set\'s own closed trades; the sets are never summed.'}', style: const TextStyle(color: _dim, fontSize: 13)),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [
        Semantics(button: true, label: 'Read the trade record sets aloud',
          child: OutlinedButton.icon(onPressed: () => widget.onAsk(kReadLedgersAloud), icon: const Icon(Icons.record_voice_over_outlined), label: const Text('Read aloud'))),
        Semantics(button: true, label: 'Refresh the trade record sets',
          child: OutlinedButton.icon(onPressed: _load, icon: const Icon(Icons.refresh), label: const Text('Refresh'))),
      ]),
      const SizedBox(height: 12),
      for (final l in ledgers) Padding(padding: const EdgeInsets.only(bottom: 12), child: _LedgerCard(ledger: l)),
    ]);
  }
}

class _LedgerCard extends StatelessWidget {
  const _LedgerCard({required this.ledger});
  final Map<String, dynamic> ledger;

  String get _label {
    final s = '${ledger['label'] ?? ledger['id'] ?? 'record set'}';
    return s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';
  }

  @override
  Widget build(BuildContext context) {
    final id = '${ledger['id'] ?? ''}';
    final unavailable = ledger['unavailable'] == true;
    final trades = ledger['trades'];
    final status = '${ledger['status'] ?? ''}';
    final what = '${ledger['what'] ?? ''}';
    final keys = ((ledger['storage_keys'] as List?) ?? const []).map((k) => '$k').join(', ');
    final best = ledger['best'] is Map ? Map<String, dynamic>.from(ledger['best'] as Map) : null;
    final feeds = ((ledger['feeds'] as List?) ?? const []).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
    final rows = ((ledger['by_strategy'] as List?) ?? const []).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
    final equity = ledger['equity'] is Map ? Map<String, dynamic>.from(ledger['equity'] as Map) : null;
    final points = ((equity?['points'] as List?) ?? const []).whereType<Map>().map((p) => _num(p['v']) ?? 0).toList();
    final unit = '${equity?['unit'] ?? 'R'}';
    final broker = id == 'broker_alpaca_paper';
    final statusColor = unavailable ? _down : (status == 'paused' || status == 'off' || status == 'not run yet') ? _gold : _up;

    final summary = StringBuffer('$_label. $what. ');
    if (unavailable) {
      summary.write('Could not read this record set; no number is shown.');
    } else if (broker) {
      summary.write('${ledger['rule'] ?? ''}');
    } else {
      summary.write('${trades ?? 0} closed trades, status $status. ');
      if (ledger['win_rate'] != null) summary.write('Win rate ${ledger['win_rate']} percent. ');
      if (ledger['net_pnl'] != null) summary.write('Net ${_money(ledger['net_pnl'])}. ');
      if (best != null) summary.write('Leading strategy ${best['name']}, ${best['trades']} trades. ');
      if (points.isNotEmpty) summary.write('Equity curve ends at ${unit == r'$' ? _money(points.last) : _r(points.last)}. ');
      for (final f in feeds) {
        summary.write('Feed ${f['symbol']} ${f['status']}. ');
      }
    }

    return Semantics(
      label: summary.toString(),
      container: true,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: _panel, border: Border.all(color: _stroke), borderRadius: BorderRadius.circular(12)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(_label, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800))),
            ExcludeSemantics(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(border: Border.all(color: statusColor), borderRadius: BorderRadius.circular(6), color: statusColor.withValues(alpha: 0.12)),
                child: Text(unavailable ? 'UNREADABLE' : status.toUpperCase(), style: TextStyle(color: statusColor, fontWeight: FontWeight.w800, fontSize: 11, letterSpacing: 0.6)),
              ),
            ),
          ]),
          const SizedBox(height: 2),
          ExcludeSemantics(child: Text(what, style: const TextStyle(color: _dim, fontSize: 13))),
          if (unavailable) const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('Could not read this record set just now; no number is shown for it.', style: TextStyle(color: _down, fontSize: 14)),
          ) else if (broker) Padding(
            padding: const EdgeInsets.only(top: 8),
            child: ExcludeSemantics(child: Text('${ledger['rule'] ?? ''}', style: const TextStyle(color: _dim, fontSize: 14))),
          ) else ...[
            const SizedBox(height: 10),
            ExcludeSemantics(
              child: Wrap(spacing: 8, runSpacing: 8, children: [
                _stat('Closed trades', '${trades ?? 0}'),
                if (ledger['wins'] != null) _stat('Won / lost', '${ledger['wins']} / ${ledger['losses'] ?? 0}'),
                if (ledger['win_rate'] != null) _stat('Win rate', '${ledger['win_rate']}%'),
                if (ledger['net_pnl'] != null) _stat('Net after costs', _money(ledger['net_pnl']), color: (_num(ledger['net_pnl']) ?? 0) >= 0 ? _up : _down),
                if (ledger['expectancy_r'] != null) _stat('Expectancy', _r(ledger['expectancy_r'])),
                if (ledger['open'] != null) _stat('Open now', '${ledger['open']}'),
                if (ledger['profitable'] != null) _stat('Proven profitable', '${ledger['profitable']} of ${ledger['strategies'] ?? 0}'),
              ]),
            ),
            if (best != null) Padding(
              padding: const EdgeInsets.only(top: 8),
              child: ExcludeSemantics(
                child: Text(
                  '${best['label'] == 'profitable' || best['ranked'] == true ? 'Best' : 'Leading, not proven'}: ${best['name']} · ${best['trades']} trades'
                  '${best['win_rate'] != null ? ' · ${best['win_rate']}%' : ''}'
                  '${best['net_pnl'] != null ? ' · ${_money(best['net_pnl'])}' : best['out_of_sample_expectancy_r'] != null ? ' · ${_r(best['out_of_sample_expectancy_r'])} out of sample' : ''}',
                  style: const TextStyle(color: Colors.white, fontSize: 14),
                ),
              ),
            ),
            if (feeds.isNotEmpty) Padding(
              padding: const EdgeInsets.only(top: 8),
              child: ExcludeSemantics(
                child: Wrap(spacing: 6, runSpacing: 6, children: [
                  for (final f in feeds) _feedChip(f),
                ]),
              ),
            ),
            if (points.length >= 2) Padding(
              padding: const EdgeInsets.only(top: 10),
              child: ExcludeSemantics(
                child: SizedBox(
                  height: 72,
                  width: double.infinity,
                  child: CustomPaint(painter: EquityCurvePainter(points: points, unit: unit)),
                ),
              ),
            ) else if (!unavailable) const Padding(
              padding: EdgeInsets.only(top: 8),
              child: ExcludeSemantics(child: Text('No closed trade yet, so there is no equity curve.', style: TextStyle(color: _dim, fontSize: 13))),
            ),
            if (rows.isNotEmpty) ...[
              const SizedBox(height: 8),
              for (final s in rows.take(5))
                ExcludeSemantics(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(children: [
                      Expanded(child: Text('${s['name'] ?? s['strategy']}${s['filter'] != null && '${s['filter']}'.isNotEmpty ? ' · ${s['filter']}' : ''}', style: const TextStyle(color: Colors.white, fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis)),
                      Text(
                        '${s['trades']} tr${s['win_rate'] != null ? ' · ${s['win_rate']}%' : ''}${s['net_pnl'] != null ? ' · ${_money(s['net_pnl'])}' : s['expectancy_r'] != null ? ' · ${_r(s['expectancy_r'])}' : ''}',
                        style: const TextStyle(color: _dim, fontSize: 13, fontFeatures: [FontFeature.tabularFigures()]),
                      ),
                      if (s['label'] == 'profitable' || s['ranked'] == true) const Text(' ✓', style: TextStyle(color: _up, fontSize: 13)),
                    ]),
                  ),
                ),
            ],
          ],
          if (keys.isNotEmpty) Padding(
            padding: const EdgeInsets.only(top: 8),
            child: ExcludeSemantics(child: Text('Stored under $keys', style: const TextStyle(color: _dim, fontSize: 11))),
          ),
        ]),
      ),
    );
  }

  Widget _stat(String label, String value, {Color? color}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(border: Border.all(color: _stroke), borderRadius: BorderRadius.circular(8)),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: const TextStyle(color: _dim, fontSize: 11)),
          Text(value, style: TextStyle(color: color ?? Colors.white, fontSize: 16, fontWeight: FontWeight.w800, fontFeatures: const [FontFeature.tabularFigures()])),
        ]),
      );

  Widget _feedChip(Map<String, dynamic> f) {
    final status = '${f['status'] ?? 'unknown'}';
    final live = status.toUpperCase() == 'LIVE';
    final waiting = status.startsWith('waiting') || status == 'unknown';
    final color = f['error'] != null ? _down : live ? _up : waiting ? _dim : _gold;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(border: Border.all(color: color), borderRadius: BorderRadius.circular(6)),
      child: Text('${f['symbol']} · $status${f['last_bar'] != null ? ' · ${_clock(f['last_bar'])}' : ''}', style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w700)),
    );
  }
}

/// The cumulative result of one record set, oldest trade on the left. Green
/// when it ends above zero, red below; the dotted line is zero.
class EquityCurvePainter extends CustomPainter {
  EquityCurvePainter({required this.points, required this.unit});
  final List<double> points;
  final String unit;

  @override
  void paint(Canvas canvas, Size size) {
    if (points.length < 2 || size.width <= 0 || size.height <= 0) return;
    var lo = 0.0;
    var hi = 0.0;
    for (final v in points) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi == lo) hi = lo + 1;
    final pad = 6.0;
    double x(int i) => pad + (size.width - 2 * pad) * i / (points.length - 1);
    double y(double v) => pad + (size.height - 2 * pad) * (1 - (v - lo) / (hi - lo));
    final zero = Paint()..color = _stroke..strokeWidth = 1;
    final zy = y(0);
    for (var px = pad; px < size.width - pad; px += 6) {
      canvas.drawLine(Offset(px, zy), Offset(px + 3, zy), zero);
    }
    final path = Path()..moveTo(x(0), y(points[0]));
    for (var i = 1; i < points.length; i++) {
      path.lineTo(x(i), y(points[i]));
    }
    final color = points.last >= 0 ? _up : _down;
    canvas.drawPath(path, Paint()..color = color..strokeWidth = 2..style = PaintingStyle.stroke..strokeJoin = StrokeJoin.round);
    final fill = Path.from(path)..lineTo(x(points.length - 1), zy)..lineTo(x(0), zy)..close();
    canvas.drawPath(fill, Paint()..color = color.withValues(alpha: 0.12)..style = PaintingStyle.fill);
    final label = TextPainter(
      text: TextSpan(text: unit == r'$' ? _money(points.last) : _r(points.last), style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w800)),
      textDirection: TextDirection.ltr,
    )..layout();
    label.paint(canvas, Offset(size.width - label.width - pad, pad));
  }

  @override
  bool shouldRepaint(covariant EquityCurvePainter old) => !listEquals(old.points, points) || old.unit != unit;
}
