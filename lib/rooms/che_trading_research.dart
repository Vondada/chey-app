// Trading research on the Trading Room (owner, 2026-10-22): which strategy works on which market, timeframe,
// session and regime, with how much evidence. Everything here is read from the Worker's research API
// (/api/trading/research…); the phone never computes or invents a number. Evidence is per timeframe:
// a strategy with 18 trades on 4h shows "18 / 30 · NOT READY" for 4h, never a global "30 trades".
// Silent on open; the owner presses Read Aloud to hear a summary.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_theme.dart';

const _gold = CheColors.markets;
const _up = Color(0xFF3DDC97);
const _down = Color(0xFFFF6B6B);
const _dim = Color(0xFF9AA6AE);

/// The evidence ladder; reaching 30 trades is only the second step, and none of them authorizes live trading.
const kReadinessLadder = ['LEARNING', '30+ SAMPLE', 'OOS VERIFIED', 'PAPER VERIFIED', 'READY FOR OWNER REVIEW'];

/// Every research timeframe, in order: id → short label and spoken name.
const kResearchTimeframes = <String, (String, String)>{
  '15s': ('15s', '15 second'),
  '30s': ('30s', '30 second'),
  '1m': ('1m', '1 minute'),
  '2m': ('2m', '2 minute'),
  '5m': ('5m', '5 minute'),
  '15m': ('15m', '15 minute'),
  '30m': ('30m', '30 minute'),
  '1h': ('1h', '1 hour'),
  '4h': ('4h', '4 hour'),
  '1D': ('1D', 'daily'),
  '1W': ('1W', 'weekly'),
  '1M': ('1M', 'monthly'),
};

/// Session and regime ids from the Worker ("ny_morning", "trend_up") in words.
const _sessionWords = {
  'overnight': 'Overnight', 'globex': 'Globex overnight', 'pre_ny': 'Pre-New York', 'ny_open': 'NY Open', 'ny_morning': 'NY Morning',
  'lunch': 'Lunch', 'ny_afternoon': 'NY Afternoon', 'close': 'Close', 'ny_rth': 'New York RTH', 'after_hours': 'After hours',
};
String researchWords(Object? id, [String fallback = '—']) {
  final s = _str(id);
  if (s.isEmpty) return fallback;
  if (_sessionWords[s] != null) return _sessionWords[s]!;
  if (!s.contains('_')) return s;
  final w = s.replaceAll('_', ' ');
  return w[0].toUpperCase() + w.substring(1);
}

String researchTfLabel(String tf) => kResearchTimeframes[tf]?.$1 ?? tf;
String researchTfSpoken(String tf) => kResearchTimeframes[tf]?.$2 ?? tf;

num? _num(Object? v) => v is num ? v : (v is String ? num.tryParse(v) : null);
int _int(Object? v) => _num(v)?.toInt() ?? 0;
String _str(Object? v, [String d = '']) => v == null ? d : '$v';
Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
List<Map<String, dynamic>> _list(Object? v) => [for (final e in (v is List ? v : const [])) if (e is Map) Map<String, dynamic>.from(e)];

/// "+0.38R" / "−0.08R"; "—" when the Worker has no value.
String fmtR(Object? v) {
  final n = _num(v);
  if (n == null) return '—';
  return '${n >= 0 ? '+' : '−'}${n.abs().toStringAsFixed(2)}R';
}

/// "plus 0.38 R" for VoiceOver.
String spokenR(Object? v) {
  final n = _num(v);
  if (n == null) return 'no expectancy yet';
  return '${n >= 0 ? 'plus' : 'minus'} ${n.abs().toStringAsFixed(2)} R';
}

String fmtPct(Object? v) {
  final n = _num(v);
  if (n == null) return '—';
  // The Worker may send a fraction (0.55) or a percent (55).
  return '${(n.abs() <= 1 ? n * 100 : n).round()}%';
}

String _humanStatus(String s) => s.replaceAll('_', ' ').toUpperCase();

Color statusColor(String status) {
  final s = status.toUpperCase();
  if (s.contains('NOT READY') || s.contains('LEARNING') || s.contains('INSUFFICIENT')) return _dim;
  if (s.contains('STRONG') || s.contains('QUALIFIED') || s.contains('VERIFIED') || s.contains('READY') || s.contains('GOOD') || s.contains('IMPROVING') || s.contains('STABLE')) return _up;
  if (s.contains('WEAK') || s.contains('POOR') || s.contains('RETIRED') || s.contains('DEPRIORITIZED')) return _down;
  return _gold;
}

class CheResearchException implements Exception {
  const CheResearchException(this.message);
  final String message;
  @override
  String toString() => message;
}

class CheTradingResearchClient {
  CheTradingResearchClient({required this.baseUrl, required this.headers, http.Client? client}) : _http = client ?? http.Client();
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _http;

  Future<Map<String, dynamic>> _send(Future<http.Response> Function() req) async {
    final http.Response r;
    try {
      r = await req().timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw const CheResearchException('CHE did not answer within 20 seconds.');
    } catch (_) {
      throw const CheResearchException('The connection to CHE failed.');
    }
    Object? body;
    try {
      body = r.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } on FormatException {
      body = null;
    }
    final m = _map(body);
    if (r.statusCode >= 400 || m['ok'] == false) throw CheResearchException(_str(m['detail'] ?? m['error'], 'CHE answered ${r.statusCode}.'));
    return m;
  }

  Uri _u(String path, [Map<String, String>? q]) => Uri.parse('${baseUrl()}$path').replace(queryParameters: q);

  Future<Map<String, dynamic>> overview(String market) => _send(() => _http.get(_u('/api/trading/research', {'market': market}), headers: headers()));
  Future<Map<String, dynamic>> strategy(String id, String market) => _send(() => _http.get(_u('/api/trading/research/strategy', {'id': id, 'market': market}), headers: headers()));
  Future<Map<String, dynamic>> matrix(String market) => _send(() => _http.get(_u('/api/trading/research/matrix', {'market': market}), headers: headers()));
  Future<Map<String, dynamic>> action(String name, Map<String, dynamic> body) => _send(() => _http.post(
        _u('/api/trading/research/$name'),
        headers: {...headers(), 'Content-Type': 'application/json'},
        body: jsonEncode(body),
      ));
}

/// One strategy's per-timeframe evidence, as the card and drill-down show it.
class ResearchBucket {
  ResearchBucket(Map<String, dynamic> j)
      : tf = _str(j['tf'] ?? j['timeframe']),
        trades = _int(j['trades'] ?? j['closed_trades']),
        min = _int(j['min_required'] ?? j['min'] ?? 30) == 0 ? 30 : _int(j['min_required'] ?? j['min'] ?? 30),
        winRate = j['win_rate'],
        avgR = j['avg_r'] ?? j['expectancy_r'],
        pf = j['pf'] ?? j['profit_factor'],
        drawdownR = j['max_dd_r'] ?? j['max_drawdown_r'],
        status = _str(j['evidence'] ?? j['status'] ?? j['state'], 'NOT READY'),
        why = j['why'] == null ? null : '${j['why']}',
        available = j['available'] != false;
  final String tf;
  final int trades, min;
  final Object? winRate, avgR, pf, drawdownR;
  final String status;

  /// The Worker's reason when a timeframe has no legitimate data.
  final String? why;

  /// False when the data for this timeframe does not exist (e.g. no 15-second history).
  final bool available;
  bool get ready => trades >= min;

  /// "18 / 30 trades · NOT READY" or "143 trades · QUALIFIED".
  String get evidenceLine => !available
      ? 'No data${why == null ? ' for this timeframe' : ': $why'}'
      : ready
          ? '$trades trades · ${_humanStatus(status)}'
          : '$trades / $min trades · NOT READY';

  String spoken(String strategy) => !available
      ? '$strategy, ${researchTfSpoken(tf)}, no data available for this timeframe${why == null ? '' : ', $why'}'
      : ready
          ? '$strategy, ${researchTfSpoken(tf)}, ${_humanStatus(status).toLowerCase()}, $trades trades, ${spokenR(avgR)}${_num(winRate) == null ? '' : ', ${fmtPct(winRate)} win rate'}'
          : '$strategy, ${researchTfSpoken(tf)}, not ready, $trades of $min trades';
}

class ResearchStrategy {
  ResearchStrategy(Map<String, dynamic> j)
      : id = _str(j['id'] ?? j['strategy_id']),
        name = _str(j['name'] ?? j['id']),
        bestTf = _str(j['best_timeframe']),
        bestTrades = _num(j['best_trades'] ?? j['qualified_trades'])?.toInt(),
        qualifiedBuckets = _int(j['qualified_buckets']),
        expectancy = j['expectancy_r'] ?? j['expectancy'],
        winRate = j['win_rate'],
        defined = j['defined'] != false,
        status = _str(j['readiness'] ?? j['status'], 'LEARNING');
  final String id, name, bestTf, status;

  /// Closed trades on the best timeframe, when the Worker reports it.
  final int? bestTrades;

  /// How many timeframes reached the 30-trade threshold with positive out-of-sample expectancy.
  final int qualifiedBuckets;
  final Object? expectancy, winRate;

  /// False for a named strategy with no explicit rules; it is never tested.
  final bool defined;

  String get bestLine => !defined
      ? 'Rules not defined; not tested'
      : bestTf.isEmpty
          ? 'No qualified timeframe yet'
          : 'Best ${researchTfLabel(bestTf)} · ${bestTrades != null ? '$bestTrades trades' : '$qualifiedBuckets timeframe${qualifiedBuckets == 1 ? '' : 's'} qualified'}';

  String get spoken => !defined
      ? '$name. Its rules are not defined, so it is not tested.'
      : '$name. ${bestTf.isEmpty ? 'No qualified timeframe yet' : 'Best on ${researchTfSpoken(bestTf)}, ${bestTrades != null ? '$bestTrades trades on that timeframe' : '$qualifiedBuckets timeframe${qualifiedBuckets == 1 ? '' : 's'} qualified'}, ${spokenR(expectancy)}, ${fmtPct(winRate)} win rate'}. Evidence ${_humanStatus(status).toLowerCase()}.';
}

/// The first BEST NOW entry: the Worker sends a ranked list (possibly empty).
Map<String, dynamic> researchBest(Map<String, dynamic> j) => j['best_now'] is List ? (_list(j['best_now']).firstOrNull ?? {}) : _map(j['best_now']);

/// The research totals and jobs.
Map<String, dynamic> researchDashboard(Map<String, dynamic> j) => _map(j['dashboard'] ?? j['research']);

/// The spoken summary of the research overview; only read when the owner presses Read Aloud.
String researchSummary(Map<String, dynamic> j, String market) {
  final best = researchBest(j);
  final r = researchDashboard(j);
  final parts = <String>[];
  if (best.isNotEmpty && _str(best['name']).isNotEmpty) {
    parts.add('Strongest evidence right now on $market: ${best['name']}, ${researchTfSpoken(_str(best['timeframe']))}, ${researchWords(best['session'], 'any session')}${best['regime'] == null ? '' : ', ${researchWords(best['regime'])}'}. '
        'Evidence score ${_str(best['evidence_score'] ?? best['score'], 'unknown')}${best['sample'] == null ? '' : ', from ${best['sample']} trades'}${best['confidence'] == null ? '' : ', confidence ${best['confidence']}'}. This is evidence, not a guarantee.');
  } else {
    parts.add('No strategy currently meets your threshold on $market.${j['best_now_reason'] == null ? '' : ' ${j['best_now_reason']}'}');
  }
  if (r.isNotEmpty) {
    parts.add('${_int(r['strategies_tested'])} strategies tested, ${_int(r['buckets_qualified'])} strategy timeframe buckets qualified, '
        '${_int(r['backtest_trades'])} backtest trades and ${_int(r['forward_paper_trades'] ?? r['paper_trades'])} forward paper trades.');
  }
  return parts.join(' ');
}

/// Large status text with a haptic and a VoiceOver announcement: every control's real result.
void _announce(BuildContext context, String said, {required bool ok}) {
  if (ok) {
    HapticFeedback.mediumImpact();
  } else {
    HapticFeedback.heavyImpact();
  }
  SemanticsService.sendAnnouncement(View.of(context), said, TextDirection.ltr);
}

Widget _overline(String text) => Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Semantics(header: true, child: Text(text, style: const TextStyle(color: _gold, fontWeight: FontWeight.w800, fontSize: 13, letterSpacing: 1.1))),
    );

// A Material (not a coloured box) so list tiles and ink inside it paint correctly.
Widget _panel({required Widget child, Key? key}) => Material(
      key: key,
      color: const Color(0xFF0B1217),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: CheColors.stroke)),
      child: Padding(padding: const EdgeInsets.all(12), child: child),
    );

/// NQ | MNQ, the market the research and the live chart follow.
class CheMarketToggle extends StatelessWidget {
  const CheMarketToggle({super.key, required this.market, required this.onChanged});
  final String market;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) => Wrap(spacing: 8, runSpacing: 6, children: [
        for (final m in const ['NQ', 'MNQ'])
          Padding(
            padding: EdgeInsets.zero,
            child: Semantics(
        container: true,
              button: true,
              selected: m == market,
              label: '$m market${m == market ? ', selected' : ''}',
              excludeSemantics: true,
              child: ChoiceChip(
                key: Key('market_$m'),
                label: Text(m, style: TextStyle(fontWeight: FontWeight.w800, color: m == market ? Colors.black : Colors.white)),
                selected: m == market,
                selectedColor: _gold,
                onSelected: (_) {
                  if (m == market) return;
                  HapticFeedback.selectionClick();
                  onChanged(m);
                },
              ),
            ),
          ),
      ]);
}

/// The research part of the CHART section: status row, BEST NOW and the strategy cards. Loads once per market.
class CheTradingResearchStrip extends StatefulWidget {
  const CheTradingResearchStrip({super.key, required this.client, required this.market, this.onRead});
  final CheTradingResearchClient client;
  final String market;
  final void Function(String text)? onRead;

  @override
  State<CheTradingResearchStrip> createState() => _CheTradingResearchStripState();
}

class _CheTradingResearchStripState extends State<CheTradingResearchStrip> {
  Map<String, dynamic>? _data;
  String? _error;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant CheTradingResearchStrip old) {
    super.didUpdateWidget(old);
    if (old.market != widget.market) unawaited(_load());
  }

  Future<void> _load() async {
    final seq = ++_seq;
    try {
      final d = await widget.client.overview(widget.market);
      if (!mounted || seq != _seq) return;
      setState(() { _data = d; _error = null; });
    } catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() => _error = '$e');
    }
  }

  void _openStrategy(String id, String name) => Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => CheStrategyDetailPage(client: widget.client, id: id, name: name, market: widget.market, onRead: widget.onRead),
      ));

  @override
  Widget build(BuildContext context) {
    final d = _data;
    if (d == null) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
        child: Text(_error == null ? 'Loading strategy research…' : 'Strategy research is unavailable: $_error',
            style: const TextStyle(color: _dim, fontSize: 15)),
      );
    }
    final strategies = <String, ResearchStrategy>{};
    for (final s in _list(d['strategies']).map(ResearchStrategy.new)) {
      if (s.id.isNotEmpty) strategies.putIfAbsent(s.id, () => s); // one card per strategy, never duplicated
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(padding: const EdgeInsets.fromLTRB(12, 10, 12, 0), child: CheTradingStatusRow(data: d)),
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
        child: CheBestNowCard(
          data: d,
          market: widget.market,
          onOpen: (id, name) => _openStrategy(id, name),
          onRead: widget.onRead == null ? null : () => widget.onRead!(researchSummary(d, widget.market)),
        ),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 16, 12, 0),
        child: Wrap(alignment: WrapAlignment.spaceBetween, crossAxisAlignment: WrapCrossAlignment.center, spacing: 8, children: [
          _overline('STRATEGIES'),
          TextButton(
            key: const Key('open_matrix'),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CheStrategyMatrixPage(client: widget.client, market: widget.market))),
            child: const Text('Strategy Matrix', semanticsLabel: 'Open the Strategy Matrix'),
          ),
        ]),
      ),
      if (strategies.isEmpty)
        const Padding(padding: EdgeInsets.fromLTRB(12, 0, 12, 0), child: Text('No strategy has research results yet.', style: TextStyle(color: _dim, fontSize: 15)))
      else
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: LayoutBuilder(builder: (context, box) {
            // Two cards per row when each still has room for its numbers; one per row on narrow or large-text screens.
            final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
            final perRow = box.maxWidth / scale >= 340 ? 2 : 1;
            final w = (box.maxWidth - (perRow - 1) * 10) / perRow;
            return Wrap(spacing: 10, runSpacing: 10, children: [
              for (final s in strategies.values) SizedBox(width: w, child: CheStrategyCard(strategy: s, onTap: () => _openStrategy(s.id, s.name))),
            ]);
          }),
        ),
    ]);
  }
}

/// Mode, Data, P&L, Win Rate, Open, Current Regime: a compact row of what the Worker reports.
class CheTradingStatusRow extends StatelessWidget {
  const CheTradingStatusRow({super.key, required this.data});
  final Map<String, dynamic> data;

  @override
  Widget build(BuildContext context) {
    final live = data['live'] is Map ? _map(data['live']) : data;
    final pnl = live['pnl_today'] ?? (live['pnl'] is Map ? _map(live['pnl'])['today'] : live['pnl']);
    final regime = live['regime'] is Map ? _map(live['regime'])['label'] : live['regime'];
    final dataLabel = live['data_source'] ?? _map(live['data'])['status'];
    final items = <(String, String)>[
      ('Mode', _str(live['mode'], '—')),
      ('Data', '${_str(dataLabel, '—')}${live['stale'] == true ? ' · STALE' : ''}'),
      ('P&L', _num(pnl) == null ? '—' : '${_num(pnl)! >= 0 ? '+' : '−'}\$${_num(pnl)!.abs().toStringAsFixed(2)}'),
      ('Win Rate', fmtPct(live['win_rate'])),
      ('Open', _str(live['open_positions'], '—')),
      ('Regime', researchWords(regime)),
    ];
    return Wrap(spacing: 8, runSpacing: 8, children: [
      for (final (k, v) in items)
        Semantics(
        container: true,
          label: '$k: $v',
          excludeSemantics: true,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: CheColors.stroke)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(k.toUpperCase(), style: const TextStyle(color: _dim, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.8)),
              Text(v, style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800)),
            ]),
          ),
        ),
    ]);
  }
}

/// BEST NOW: the strongest qualified evidence for the current session and regime, or an honest "none".
class CheBestNowCard extends StatelessWidget {
  const CheBestNowCard({super.key, required this.data, required this.market, required this.onOpen, this.onRead});
  final Map<String, dynamic> data;
  final String market;
  final void Function(String id, String name) onOpen;
  final VoidCallback? onRead;

  @override
  Widget build(BuildContext context) {
    final b = researchBest(data);
    final has = _str(b['name']).isNotEmpty;
    final line = has
        ? '${researchTfLabel(_str(b['timeframe']))} · ${researchWords(b['session'], 'any session')}${b['regime'] == null ? '' : ' · ${researchWords(b['regime'])}'}'
        : '';
    final evidence = has ? 'Evidence ${_str(b['evidence_score'] ?? b['score'], '—')}/100${b['sample'] == null ? '' : ' · ${b['sample']} trades'}${_num(b['expectancy_r']) == null ? '' : ' · ${fmtR(b['expectancy_r'])}'}' : '';
    return _panel(
      key: const Key('best_now'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _overline('BEST NOW · $market'),
        if (has) ...[
          Semantics(
        container: true,
            label: 'Best now: ${b['name']}, ${researchTfSpoken(_str(b['timeframe']))}, ${researchWords(b['session'], 'any session')}. $evidence.${b['confidence'] == null ? '' : ' Confidence ${b['confidence']}.'}',
            excludeSemantics: true,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_str(b['name']), style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800)),
              const SizedBox(height: 2),
              Text(line, style: const TextStyle(color: Colors.white, fontSize: 16)),
              Text(evidence, style: const TextStyle(color: _gold, fontSize: 16, fontWeight: FontWeight.w700)),
              if (b['window'] != null) Text('Evidence window: ${b['window']}', style: const TextStyle(color: _dim, fontSize: 14)),
            ]),
          ),
        ] else
          Text(
            // The Worker's own reason, which usually starts with this same sentence.
            _str(data['best_now_reason']).startsWith('No strategy')
                ? _str(data['best_now_reason'])
                : 'No strategy currently meets your threshold.${data['best_now_reason'] == null ? '' : ' ${data['best_now_reason']}'}',
            style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600),
          ),
        const SizedBox(height: 8),
        Wrap(spacing: 8, children: [
          if (has)
            FilledButton(
              key: const Key('best_now_open'),
              onPressed: () => onOpen(_str(b['strategy_id'] ?? b['id']), _str(b['name'])),
              child: Text('Open ${_str(b['name'])}', semanticsLabel: 'Open ${_str(b['name'])} details'),
            ),
          if (onRead != null)
            OutlinedButton.icon(
              onPressed: onRead,
              icon: const Icon(Icons.record_voice_over_rounded),
              label: const Text('Read Aloud', semanticsLabel: 'Read the research summary aloud'),
            ),
        ]),
      ]),
    );
  }
}

/// One strategy: best timeframe, qualified trades on that timeframe, expectancy, win rate, evidence status.
class CheStrategyCard extends StatelessWidget {
  const CheStrategyCard({super.key, required this.strategy, required this.onTap});
  final ResearchStrategy strategy;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = strategy;
    return Semantics(
        container: true,
      button: true,
      label: '${s.spoken} Opens details.',
      excludeSemantics: true,
      child: InkWell(
        key: Key('strategy_card_${s.id}'),
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: _panel(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(s.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text(s.bestLine, style: const TextStyle(color: Colors.white, fontSize: 14)),
            Text('${fmtR(s.expectancy)} · ${fmtPct(s.winRate)} WR', style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(_humanStatus(s.status), style: TextStyle(color: statusColor(s.status), fontSize: 13, fontWeight: FontWeight.w800, letterSpacing: 0.6)),
          ]),
        ),
      ),
    );
  }
}

/// A strategy's drill-down: overview, every timeframe, sessions, history windows, decay and readiness.
class CheStrategyDetailPage extends StatefulWidget {
  const CheStrategyDetailPage({super.key, required this.client, required this.id, required this.name, required this.market, this.onRead});
  final CheTradingResearchClient client;
  final String id, name, market;
  final void Function(String text)? onRead;

  @override
  State<CheStrategyDetailPage> createState() => _CheStrategyDetailPageState();
}

class _CheStrategyDetailPageState extends State<CheStrategyDetailPage> {
  Map<String, dynamic>? _s;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(() async {
      try {
        final d = await widget.client.strategy(widget.id, widget.market);
        // The contract puts the definition under `strategy` and the evidence beside it.
        if (mounted) setState(() => _s = {...d, ..._map(d['strategy']), 'overview': d['overview'] ?? _map(d['strategy'])['overview']});
      } catch (e) {
        if (mounted) setState(() => _error = '$e');
      }
    }());
  }

  String _summary(Map<String, dynamic> s) {
    final o = _map(s['overview']);
    return '${widget.name} on ${widget.market}. Best timeframe ${researchTfSpoken(_str(o['best_timeframe'], 'none yet'))}, best session ${_str(o['best_session'], 'unknown')}, '
        'best regime ${researchWords(o['best_regime'], 'unknown')}. Historical expectancy ${spokenR(o['historical_expectancy_r'] ?? o['historical_exp'])}, recent ${spokenR(o['recent_expectancy_r'] ?? o['recent_exp'])}. '
        'Edge ${_str(s['decay'], 'unknown').toLowerCase()}${s['readiness'] == null ? '' : ', readiness ${_str(s['readiness']).toLowerCase()}'}.';
  }

  Widget _kv(String k, String v) => Semantics(
        container: true,
        label: '$k: $v',
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(flex: 5, child: Text(k, style: const TextStyle(color: _dim, fontSize: 15))),
            Expanded(flex: 6, child: Text(v, style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700))),
          ]),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final s = _s;
    return Scaffold(
      backgroundColor: const Color(0xFF05080A),
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(widget.name),
        leading: IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.of(context).maybePop()),
        actions: [
          if (widget.onRead != null && s != null)
            IconButton(tooltip: 'Read this strategy aloud', icon: const Icon(Icons.record_voice_over_rounded), onPressed: () => widget.onRead!(_summary(s))),
        ],
      ),
      body: s == null
          ? Center(child: Text(_error == null ? 'Loading ${widget.name}…' : 'Could not load ${widget.name}: $_error', style: const TextStyle(color: Colors.white, fontSize: 16)))
          : _body(s),
    );
  }

  Widget _body(Map<String, dynamic> s) {
    final o = _map(s['overview']);
    final paper = _map(o['paper']);
    final buckets = {for (final b in _list(s['timeframes']).map(ResearchBucket.new)) b.tf: b};
    final windows = _list(s['periods'] ?? s['windows']);
    final ladder = [for (final l in (s['ladder'] is List ? s['ladder'] as List : kReadinessLadder)) '$l'];
    // The real span of the data: the "max" window's years, never a label longer than the data.
    final maxWindow = windows.where((w) => _str(w['window'] ?? w['label']).toLowerCase() == 'max').firstOrNull;
    final maxYears = _num(s['max_available_years'] ?? maxWindow?['years_available']);
    final hist = o['historical_expectancy_r'] ?? o['historical_exp'];
    final recent = o['recent_expectancy_r'] ?? o['recent_exp'];
    return ListView(padding: const EdgeInsets.fromLTRB(12, 12, 12, 32), children: [
      _overline('OVERVIEW · ${widget.market}'),
      _panel(
        child: Column(children: [
          _kv('Best timeframe', o['best_timeframe'] == null ? 'None qualified yet' : researchTfLabel(_str(o['best_timeframe']))),
          _kv('Best session', researchWords(o['best_session'])),
          _kv('Best regime', researchWords(o['best_regime'])),
          _kv('Historical expectancy', fmtR(hist)),
          _kv('Recent expectancy', fmtR(recent)),
          _kv('Paper results', paper.isEmpty ? 'No paper trades yet' : '${_int(paper['trades'])} trades · ${fmtR(paper['expectancy_r'] ?? paper['exp'])} · ${fmtPct(paper['win_rate'])} WR'),
          _kv('Edge trend', _humanStatus(_str(s['decay'], 'INSUFFICIENT DATA'))),
          if (s['readiness'] != null) _kv('Readiness', _humanStatus(_str(s['readiness']))),
        ]),
      ),
      if (ladder.isNotEmpty && s['readiness'] != null) ...[
        const SizedBox(height: 8),
        Semantics(
        container: true,
          label: 'Readiness ladder: ${ladder.join(', then ')}. Current: ${_humanStatus(_str(s['readiness'], 'LEARNING')).toLowerCase()}.',
          excludeSemantics: true,
          child: Wrap(spacing: 6, runSpacing: 6, children: [
            for (final step in ladder)
              Chip(
                label: Text(_humanStatus(step), style: TextStyle(fontSize: 12, color: step.toUpperCase() == _str(s['readiness']).toUpperCase() ? Colors.black : Colors.white)),
                backgroundColor: step.toUpperCase() == _str(s['readiness']).toUpperCase() ? _gold : Colors.transparent,
              ),
          ]),
        ),
      ],
      const SizedBox(height: 16),
      _overline('TIMEFRAMES · 30 closed trades each before a timeframe counts'),
      for (final tf in kResearchTimeframes.keys)
        if (buckets[tf] != null) _bucketRow(buckets[tf]!) else _bucketRow(ResearchBucket({'tf': tf, 'trades': 0, 'available': true})),
      for (final (title, key, field) in const [('SESSIONS', 'sessions', 'session'), ('REGIMES', 'regimes', 'regime'), ('HOURS (exchange time)', 'hours', 'hour'), ('WEEKDAYS', 'weekdays', 'weekday')])
        if (_list(s[key]).isNotEmpty) ...[
          const SizedBox(height: 16),
          _overline(title),
          for (final row in _list(s[key]))
            _kv(key == 'hours' ? '${_str(row[field])}:00' : researchWords(row[field]),
                '${_int(row['trades'])} trades · ${fmtR(row['expectancy_r'])}${_num(row['win_rate']) == null ? '' : ' · ${fmtPct(row['win_rate'])} WR'}'),
        ],
      const SizedBox(height: 16),
      _overline('HISTORY'),
      if (maxYears != null) _kv('Maximum available', '${maxYears.toStringAsFixed(1)} years'),
      // A window longer than the real history is never shown; the maximum available is shown instead.
      for (final w in windows)
        if (w['available'] != false && _str(w['window'] ?? w['label']).toLowerCase() != 'max')
          _kv(_str(w['window'] ?? w['label']).toUpperCase(), '${_int(w['trades'])} trades · ${fmtR(w['expectancy_r'])}'),
      if (maxWindow != null && maxWindow['trades'] != null) _kv('Maximum window', '${_int(maxWindow['trades'])} trades · ${fmtR(maxWindow['expectancy_r'])}'),
      for (final r in _list(s['receipts']).take(3))
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text('Receipt ${researchTfLabel(_str(r['timeframe']))}: ${_str(r['provider'])} · cost ${_str(r['cost_model'])} · look-ahead ${_str(r['look_ahead'])}',
              style: const TextStyle(color: _dim, fontSize: 13)),
        ),
      if (s['provenance'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Data: ${s['provenance']}', style: const TextStyle(color: _dim, fontSize: 13))),
    ]);
  }

  Widget _bucketRow(ResearchBucket b) => Semantics(
        container: true,
        key: Key('tf_row_${b.tf}'),
        label: b.spoken(widget.name),
        excludeSemantics: true,
        child: Container(
          margin: const EdgeInsets.only(bottom: 6),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: CheColors.stroke)),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 44, child: Text(researchTfLabel(b.tf), style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800))),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(b.evidenceLine, style: TextStyle(color: b.ready ? statusColor(b.status) : _dim, fontWeight: FontWeight.w800, fontSize: 14)),
                if (b.ready)
                  Text('${fmtPct(b.winRate)} WR · ${fmtR(b.avgR)} · PF ${_num(b.pf)?.toStringAsFixed(2) ?? '—'} · DD ${fmtR(b.drawdownR)}',
                      style: const TextStyle(color: Colors.white, fontSize: 14)),
              ]),
            ),
          ]),
        ),
      );
}

/// Strategies × timeframes, each cell an evidence state. Every cell reads in full for VoiceOver.
class CheStrategyMatrixPage extends StatefulWidget {
  const CheStrategyMatrixPage({super.key, required this.client, required this.market});
  final CheTradingResearchClient client;
  final String market;

  @override
  State<CheStrategyMatrixPage> createState() => _CheStrategyMatrixPageState();
}

class _CheStrategyMatrixPageState extends State<CheStrategyMatrixPage> {
  Map<String, dynamic>? _m;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(() async {
      try {
        final d = await widget.client.matrix(widget.market);
        if (mounted) setState(() => _m = d);
      } catch (e) {
        if (mounted) setState(() => _error = '$e');
      }
    }());
  }

  @override
  Widget build(BuildContext context) {
    final m = _m;
    final tfs = m == null ? const <String>[] : [for (final t in (m['timeframes'] is List ? m['timeframes'] as List : kResearchTimeframes.keys)) '$t'];
    final rows = m == null ? const <Map<String, dynamic>>[] : _list(m['rows']);
    return Scaffold(
      backgroundColor: const Color(0xFF05080A),
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text('Strategy Matrix · ${widget.market}'),
        leading: IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: m == null
          ? Center(child: Text(_error == null ? 'Loading the matrix…' : 'Could not load the matrix: $_error', style: const TextStyle(color: Colors.white, fontSize: 16)))
          : rows.isEmpty
              ? const Center(child: Text('No strategy has research results yet.', style: TextStyle(color: Colors.white, fontSize: 16)))
              : ListView.builder(
                  padding: const EdgeInsets.all(12),
                  itemCount: rows.length,
                  itemBuilder: (context, i) {
                    final r = rows[i];
                    final name = _str(r['name'] ?? r['strategy_id'] ?? r['id']);
                    // Cells arrive keyed by timeframe ({"5m": {...}}), or as a list with a tf field.
                    final cells = r['cells'] is Map
                        ? {for (final e in _map(r['cells']).entries) e.key: _map(e.value)}
                        : {for (final c in _list(r['cells'])) _str(c['tf']): c};
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Semantics(header: true, child: Text(name, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800))),
                        const SizedBox(height: 6),
                        Wrap(spacing: 6, runSpacing: 6, children: [
                          for (final tf in tfs) _cell(name, tf, cells[tf]),
                        ]),
                      ]),
                    );
                  },
                ),
    );
  }

  Widget _cell(String name, String tf, Map<String, dynamic>? c) {
    final state = c == null ? 'Learning' : _str(c['state'] ?? c['status'], 'Learning');
    if (state.toLowerCase() == 'no data') {
      return Semantics(
        container: true,
        key: Key('cell_${name}_$tf'),
        label: '$name, ${researchTfSpoken(tf)}, no data',
        excludeSemantics: true,
        child: Container(
          width: 74,
          padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(8), border: Border.all(color: CheColors.stroke)),
          child: Column(children: [
            Text(researchTfLabel(tf), style: const TextStyle(color: _dim, fontSize: 12, fontWeight: FontWeight.w700)),
            const Text('No data', style: TextStyle(color: _dim, fontSize: 13)),
          ]),
        ),
      );
    }
    final trades = c == null ? 0 : _int(c['trades']);
    final ready = trades >= 30;
    final spoken = c == null || !ready
        ? '$name, ${researchTfSpoken(tf)}, ${state.toLowerCase()}, $trades of 30 trades'
        : '$name, ${researchTfSpoken(tf)}, $state, $trades trades, ${spokenR(c['expectancy_r'])}';
    return Semantics(
        container: true,
      key: Key('cell_${name}_$tf'),
      label: spoken,
      excludeSemantics: true,
      child: Container(
        width: 74,
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(8), border: Border.all(color: statusColor(state).withValues(alpha: 0.7))),
        child: Column(children: [
          Text(researchTfLabel(tf), style: const TextStyle(color: _dim, fontSize: 12, fontWeight: FontWeight.w700)),
          FittedBox(fit: BoxFit.scaleDown, child: Text(state, style: TextStyle(color: statusColor(state), fontSize: 13, fontWeight: FontWeight.w800))),
          Text(ready ? '$trades' : '$trades/30', style: const TextStyle(color: Colors.white, fontSize: 12)),
        ]),
      ),
    );
  }
}

/// RESEARCH: what has been tested, how much data really exists, the jobs, and the owner's controls.
class CheTradingResearchDashboard extends StatefulWidget {
  const CheTradingResearchDashboard({super.key, required this.client, required this.market, this.onRead});
  final CheTradingResearchClient client;
  final String market;
  final void Function(String text)? onRead;

  @override
  State<CheTradingResearchDashboard> createState() => _CheTradingResearchDashboardState();
}

class _CheTradingResearchDashboardState extends State<CheTradingResearchDashboard> {
  Map<String, dynamic>? _d;
  String? _error;
  String _status = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final d = await widget.client.overview(widget.market);
      if (mounted) setState(() { _d = d; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  /// A control's real result: the Worker's own words when it gives them, then a reload so the screen shows the new state.
  Future<void> _act(String name, Map<String, dynamic> body, String done) async {
    if (_busy) return;
    setState(() => _busy = true);
    String said;
    var ok = false;
    try {
      final out = await widget.client.action(name, body);
      said = _str(out['spoken'] ?? out['said'], done);
      ok = true;
    } catch (e) {
      said = 'That did not work: $e. Nothing was changed.';
    }
    if (!mounted) return;
    setState(() { _busy = false; _status = said; });
    _announce(context, said, ok: ok);
    if (ok) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    if (d == null) {
      return Text(_error == null ? 'Loading research…' : 'Research is unavailable: $_error', style: const TextStyle(color: _dim, fontSize: 15));
    }
    final r = researchDashboard(d);
    final controls = _map(d['controls']);
    final pl = d['paper_learning'] ?? controls['paper_learning'];
    final learning = pl is Map ? pl['enabled'] == true : pl == true;
    final profile = _str(d['profile'] ?? controls['profile'], 'NORMAL').toUpperCase();
    final coverage = _list(r['coverage']);
    final jobs = _list(d['jobs'] ?? r['jobs']);
    final paperTrades = r['forward_paper_trades'] ?? r['paper_trades'];
    final summary = '${_int(r['strategies_tested'])} strategies tested. ${_int(r['buckets_qualified'])} strategy and timeframe buckets qualified. '
        '${_int(r['backtest_trades'])} backtest trades. ${_int(paperTrades)} forward paper trades.';
    return _panel(
      key: const Key('research_dashboard'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _overline('RESEARCH · ${widget.market}'),
        Semantics(
        container: true,
          label: summary,
          excludeSemantics: true,
          child: Wrap(spacing: 14, runSpacing: 8, children: [
            for (final (k, v) in [
              ('Strategies tested', r['strategies_tested']),
              ('Buckets qualified', r['buckets_qualified']),
              ('Backtest trades', r['backtest_trades']),
              ('Paper trades', paperTrades),
            ])
              Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text('${_int(v)}', style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800)),
                Text(k, style: const TextStyle(color: _dim, fontSize: 13)),
              ]),
          ]),
        ),
        if (widget.onRead != null)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => widget.onRead!(summary),
              icon: const Icon(Icons.record_voice_over_rounded),
              label: const Text('Read Aloud', semanticsLabel: 'Read the research totals aloud'),
            ),
          ),
        if (coverage.isNotEmpty) ...[
          const SizedBox(height: 10),
          const Text('Real data coverage', style: TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800)),
          for (final c in coverage)
            Semantics(
        container: true,
              label: '${c['market']} ${researchTfSpoken(_str(c['resolution']))} data: ${_str(c['years'], 'unknown')} years, from ${_str(c['first'], 'unknown')} to ${_str(c['last'], 'unknown')}, ${_str(c['provider'], 'unknown provider')}${c['proxy'] == true ? ', proxy data' : ''}.',
              excludeSemantics: true,
              child: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  '${c['market']} · ${researchTfLabel(_str(c['resolution']))} · ${_str(c['years'], '?')} yrs · ${_str(c['provider'], '?')}${c['proxy'] == true ? ' · PROXY' : ''}',
                  style: const TextStyle(color: Colors.white, fontSize: 14),
                ),
              ),
            ),
        ],
        if (jobs.isNotEmpty) ...[
          const SizedBox(height: 10),
          const Text('Research jobs', style: TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800)),
          for (final j in jobs) _job(j),
        ],
        const SizedBox(height: 12),
        Semantics(
          toggled: learning,
          label: 'Paper learning, ${learning ? 'on' : 'off'}',
          child: SwitchListTile(
            key: const Key('paper_learning_switch'),
            contentPadding: EdgeInsets.zero,
            title: const Text('Paper learning', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
            subtitle: const Text('PAPER only. Never places real-money orders.', style: TextStyle(color: _dim, fontSize: 13)),
            value: learning,
            onChanged: _busy ? null : (on) => unawaited(_act('paper_learning', {'enabled': on, 'market': widget.market}, 'Paper learning is ${on ? 'on' : 'off'}.')),
          ),
        ),
        const Text('Resource profile', style: TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        Wrap(spacing: 8, children: [
          for (final p in const ['LIGHT', 'NORMAL', 'DEEP'])
            Semantics(
        container: true,
              button: true,
              selected: p == profile,
              label: '$p resource profile${p == profile ? ', selected' : ''}',
              excludeSemantics: true,
              child: ChoiceChip(
                key: Key('profile_$p'),
                label: Text(p),
                selected: p == profile,
                selectedColor: _gold,
                onSelected: _busy || p == profile ? null : (_) => unawaited(_act('profile', {'profile': p}, 'Resource profile is $p.')),
              ),
            ),
        ]),
        if (_status.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Semantics(liveRegion: true, child: Text(_status, style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w700))),
          ),
      ]),
    );
  }

  Widget _job(Map<String, dynamic> j) {
    final progress = _num(j['progress'])?.toDouble();
    final running = ['running', 'queued'].contains(_str(j['status']).toLowerCase());
    final done = j['completed'] is List ? (j['completed'] as List).length : _num(j['done'])?.toInt();
    final total = j['completed'] is List ? done! + (j['remaining'] is List ? (j['remaining'] as List).length : 0) : _num(j['total'])?.toInt();
    final errors = j['errors'] is List ? (j['errors'] as List).length : 0;
    final label = '${_str(j['name'] ?? j['label'] ?? j['id'])}: ${_str(j['status'])}${done == null ? '' : ', $done of $total combinations'}${errors > 0 ? ', $errors errors' : ''}';
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(children: [
        Expanded(
          child: Semantics(
        container: true,
            label: label,
            excludeSemantics: true,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: const TextStyle(color: Colors.white, fontSize: 14)),
              if (progress != null) LinearProgressIndicator(value: progress.clamp(0, 1), color: _gold, backgroundColor: CheColors.stroke),
            ]),
          ),
        ),
        if (running)
          TextButton(
            onPressed: _busy ? null : () => unawaited(_act('cancel_job', {'id': j['id']}, 'Cancelled ${_str(j['name'] ?? j['label'] ?? j['id'])}.')),
            child: Text('Cancel', semanticsLabel: 'Cancel ${_str(j['name'] ?? j['label'] ?? j['id'])}'),
          ),
      ]),
    );
  }
}
