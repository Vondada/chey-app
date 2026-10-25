// Orion's crypto desk in the Trading Room (owner master mission, 2026-10-23): BTC and ETH researched and paper traded
// around the clock by the Worker, shown from its records only (GET /api/trading/crypto). Nothing here computes a result
// or claims a trade the journal does not hold. It refreshes quietly and never speaks by itself; Read aloud is manual.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_chrome_status.dart';
import '../che_ui/che_foreground.dart';
import '../che_ui/che_hud.dart';

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

/// LIVE green, DELAYED amber, DISCONNECTED red, anything else neutral. The word is always shown with the colour.
CheStatusTone cheCryptoTone(String status) => switch (status) {
      'LIVE' => CheStatusTone.success,
      'DELAYED' => CheStatusTone.warning,
      'DISCONNECTED' => CheStatusTone.failure,
      _ => CheStatusTone.neutral,
    };

class CheCryptoDeskPanel extends StatefulWidget {
  const CheCryptoDeskPanel({super.key, required this.baseUrl, required this.headers, this.onRead, this.client, this.refresh = const Duration(seconds: 60)});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String text)? onRead;
  final http.Client? client;
  final Duration refresh;

  @override
  State<CheCryptoDeskPanel> createState() => _CheCryptoDeskPanelState();
}

class _CheCryptoDeskPanelState extends State<CheCryptoDeskPanel> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic>? _d;
  String _error = '';
  bool _busy = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
    // No polling while CHE is in the background (stability mission, 2026-10-23).
    _timer = Timer.periodic(widget.refresh, (_) {
      if (cheAppInForeground()) unawaited(_load());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Uri _uri() => Uri.parse('${widget.baseUrl()}/api/trading/crypto');

  Future<void> _load() async {
    try {
      final r = await _http.get(_uri(), headers: widget.headers()).timeout(const Duration(seconds: 20));
      if (!mounted) return;
      if (r.statusCode != 200) {
        setState(() => _error = 'The crypto desk could not be read (HTTP ${r.statusCode}).');
        return;
      }
      setState(() { _d = jsonDecode(r.body) as Map<String, dynamic>; _error = ''; });
    } catch (_) {
      if (mounted) setState(() => _error = 'The crypto desk could not be reached. Nothing here is current.');
    }
  }

  Future<void> _act(String action) async {
    if (_busy) return;
    HapticFeedback.mediumImpact();
    setState(() => _busy = true);
    try {
      final r = await _http.post(_uri(), headers: {...widget.headers(), 'Content-Type': 'application/json'}, body: jsonEncode({'action': action})).timeout(const Duration(seconds: 30));
      if (!mounted) return;
      if (r.statusCode == 200) {
        setState(() => _d = jsonDecode(r.body) as Map<String, dynamic>);
        HapticFeedback.lightImpact();
      } else {
        setState(() => _error = 'That did not change anything (HTTP ${r.statusCode}).');
        HapticFeedback.heavyImpact();
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'The crypto desk could not be reached; nothing changed.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final enabled = d?['enabled'] == true;
    final feeds = ((d?['feeds'] as List?) ?? const []).whereType<Map>().toList();
    final sim = (d?['simulated'] as Map?) ?? const {};
    final schedule = (d?['schedule'] as Map?) ?? const {};
    final budget = (d?['budget'] as Map?) ?? const {};
    final recent = ((sim['recent'] as List?) ?? const []).whereType<Map>().toList();
    final open = ((sim['open_positions'] as List?) ?? const []).whereType<Map>().toList();
    final closed = (sim['closed_trades'] as num?)?.toInt() ?? 0;
    final research = ((d?['research'] as List?) ?? const []).whereType<Map>().where((r) => r['ok'] == true).toList();
    const body = TextStyle(color: Colors.white, fontSize: 15, height: 1.35);
    final dim = TextStyle(color: CheHud.chromeMid, fontSize: 14, height: 1.35);
    // A Material (not a coloured box) so the expandable rows keep their ink and splashes.
    return Material(
      key: const Key('crypto_desk'),
      color: CheHud.navyMid.withValues(alpha: 0.85),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: CheHud.ice.withValues(alpha: 0.28))),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Semantics(header: true, child: const CheChromeText('ORION CRYPTO DESK', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: 1.2)))),
          CheStatusPill(label: d == null ? 'Loading' : enabled ? 'On' : 'Paused', tone: d == null ? CheStatusTone.neutral : enabled ? CheStatusTone.success : CheStatusTone.warning, compact: true),
        ]),
        const SizedBox(height: 4),
        Text('BTC and ETH paper trading and research, 24/7 including weekends. Paper only: public market data from Coinbase, no trading account, key or order path.', style: dim),
        if (_error.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error, key: const Key('crypto_error'), style: const TextStyle(color: Color(0xFFFFB4B4), fontSize: 15))),
        if (d != null) ...[
          const SizedBox(height: 10),
          for (final f in feeds.where((f) => f['tf'] == '5m'))
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Semantics(
                container: true,
                label: '${f['coin']} 5-minute candles ${cheCryptoBarWord('${f['status']}').toLowerCase()}${f['last_close'] != null ? ', last close ${f['last_close']} at ${_clock(f['last_bar'])}' : ''}, Coinbase public market data, no trading account',
                excludeSemantics: true,
                child: Row(children: [
                  SizedBox(width: 48, child: Text('${f['coin']}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16))),
                  CheStatusPill(label: cheCryptoBarWord('${f['status']}'), tone: cheCryptoTone('${f['status']}'), compact: true),
                  const SizedBox(width: 8),
                  Expanded(child: Text(f['last_close'] != null ? '${f['last_close']}  ·  ${_clock(f['last_bar'])}' : (f['reason']?.toString() ?? 'not read yet'), style: body, overflow: TextOverflow.ellipsis)),
                ]),
              ),
            ),
          Text('Last pass ${_clock(schedule['last_run_at'])} · next ${enabled ? _clock(schedule['next_at']) : 'paused'} · requests today ${budget['requests'] ?? 0} of ${budget['limit'] ?? '—'}', style: dim),
          const SizedBox(height: 10),
          Semantics(
            container: true,
            label: 'Orion crypto paper, BTC and ETH on the Worker, not the CHE paper account: simulated trades closed $closed, open positions ${open.length}, '
                'net ${_money(sim['net_pnl'])}${sim['enough_data'] == true ? ', ${cheCryptoR(sim['expectancy_r'], spoken: true)} per trade' : ', not enough data yet'}. ${cheCryptoRNote(sim['expectancy_r'])}',
            excludeSemantics: true,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              // Which account these figures belong to: Orion's crypto paper portfolios on the Worker. The CHE PAPER
              // ACCOUNT (MNQ on this iPhone) is a different account with its own positions (owner recording, 2026-10-25).
              Text('ORION CRYPTO PAPER · WORKER', key: const Key('crypto_account_label'), style: dim.copyWith(fontSize: 12, letterSpacing: 1)),
              Wrap(spacing: 16, runSpacing: 4, children: [
                Text('Closed $closed', style: body),
                Text('Open ${open.length}', style: body),
                Text('Net ${_money(sim['net_pnl'])}', style: body),
                Text(sim['enough_data'] == true ? '${cheCryptoR(sim['expectancy_r'])} per trade' : 'Not enough data: $closed of 30', style: dim),
              ]),
              if (cheCryptoRNote(sim['expectancy_r']).isNotEmpty) Text(cheCryptoRNote(sim['expectancy_r']), key: const Key('crypto_r_note'), style: dim),
            ]),
          ),
          if (recent.isNotEmpty)
            ExpansionTile(
              key: const Key('crypto_recent'),
              tilePadding: EdgeInsets.zero,
              iconColor: Colors.white,
              collapsedIconColor: Colors.white70,
              title: Text('Recent simulated trades (${recent.length})', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 15)),
              children: [
                for (final t in recent)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Text('${t['coin']} ${t['tf']} ${t['strategy']} ${t['side']}: ${t['entry']} → ${t['exit']} (${t['reason']}), net ${_money(t['net_pnl'])} after fees · ${_clock(t['exit_time'])}', style: body),
                  ),
              ],
            ),
          if (research.isNotEmpty)
            ExpansionTile(
              key: const Key('crypto_research'),
              tilePadding: EdgeInsets.zero,
              iconColor: Colors.white,
              collapsedIconColor: Colors.white70,
              title: const Text('Strategy research (backtest, out of sample)', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 15)),
              children: [
                for (final r in research)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(
                      '${r['coin']} ${r['tf']} · ${((r['study'] as Map?)?['volatility'] as Map?)?['regime'] ?? 'regime unknown'}: '
                      '${(((r['strategies'] as List?) ?? const []).whereType<Map>().take(3).map((s) => '${s['name']} ${s['oos_trades']} OOS trades, ${s['oos_expectancy_r']} R${s['enough_data'] == true ? '' : ' (under 30 trades)'}').join('; '))}',
                      style: body,
                    ),
                  ),
              ],
            ),
          Text('Fees assumed 0.6% taker, 0.4% maker. Funding rates: ${((d['funding'] as Map?)?['status']) ?? 'MISSING'}.', style: dim),
          const SizedBox(height: 10),
          Wrap(spacing: 10, runSpacing: 8, children: [
            Semantics(
              button: true,
              label: enabled ? 'Pause Orion crypto research' : 'Resume Orion crypto research',
              excludeSemantics: true,
              child: OutlinedButton(
                key: const Key('crypto_toggle'),
                onPressed: _busy ? null : () => _act(enabled ? 'pause' : 'resume'),
                style: OutlinedButton.styleFrom(foregroundColor: Colors.white, side: BorderSide(color: CheHud.ice.withValues(alpha: 0.6))),
                child: Text(enabled ? 'Pause' : 'Resume'),
              ),
            ),
            if (widget.onRead != null)
              Semantics(
                button: true,
                label: 'Read the crypto desk aloud',
                excludeSemantics: true,
                child: OutlinedButton(
                  key: const Key('crypto_read'),
                  onPressed: () => widget.onRead!('${d['spoken'] ?? ''}'),
                  style: OutlinedButton.styleFrom(foregroundColor: Colors.white, side: BorderSide(color: CheHud.ice.withValues(alpha: 0.6))),
                  child: const Text('Read aloud'),
                ),
              ),
          ]),
        ],
      ]),
      ),
    );
  }
}


/// Expectancy in R, two decimals: "−6.59 R" (or "minus 6.59 R" spoken). "—" when the Worker has none.
String cheCryptoR(Object? v, {bool spoken = false}) {
  final n = v is num ? v : num.tryParse('${v ?? ''}');
  if (n == null) return spoken ? 'no expectancy' : '—';
  final sign = n < 0 ? (spoken ? 'minus ' : '−') : (spoken ? 'plus ' : '+');
  return '$sign${n.abs().toStringAsFixed(2)} R';
}

/// Why a large negative R is real and not a bug: 1 R is the stop distance before costs (trading_evidence.settleTrade),
/// and Coinbase taker fees of 0.6% a side (1.2% round trip, about 960 dollars on one BTC at 80,000) are several times a
/// typical 5-minute stop of 0.1% to 0.2%. So each trade loses several R to fees alone.
String cheCryptoRNote(Object? v) {
  final n = v is num ? v : num.tryParse('${v ?? ''}');
  if (n == null || n > -2) return '';
  return 'Why so negative: 1 R is the stop distance before costs, and the assumed Coinbase taker fee (0.6% each side) is several times a 5-minute stop, so fees alone cost several R per trade.';
}

/// The Worker's polled 5-minute candles in honest words. Its "LIVE" means the newest closed 5-minute candle is the
/// current one (it gates paper entries), not a stream of trades, so the desk says CURRENT 5M, never LIVE. Live trades
/// are the chart's own stream (che_crypto_stream.dart), which says LIVE only with a trade in the last minute.
String cheCryptoBarWord(String status) => switch (status.toUpperCase()) {
      'LIVE' => 'CURRENT 5M',
      'DELAYED' => 'DELAYED',
      'NOT STARTED' => 'NOT STARTED',
      'DISCONNECTED' => 'DISCONNECTED',
      final s => s,
    };
