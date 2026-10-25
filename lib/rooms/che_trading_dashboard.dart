// The Trading Room dashboard (owner, 2026-10-25, Trading Room v3): the SELECTED account's realized P&L, win rate and
// W/L, open positions and max drawdown, its latest trades and journal entries. Every figure comes from that one
// account's records through cheComputeAccountStats (lib/trading/che_account_stats.dart); accounts are never mixed and
// backtests never enter. Records:
//   CHE PAPER · iPhone     — ChePaperEngine (simulated MNQ on live Rithmic prices), updated the moment a trade opens or
//                            closes (the engine notifies);
//   FORWARD PAPER futures, FORWARD PAPER crypto, SIMULATION (R) — GET /api/trading/calendar?view=accounts, refreshed
//                            every minute and on Refresh;
//   MY TRADES              — the trades the owner entered on this phone (CheMyTradesStore).
// Each tile opens its explanation in place (VoiceOver: "Realized P&L: … Double tap to explain"); voice asks the same
// ("explain win rate", "what's my drawdown") through [CheTradingDashboard.latest]. Silent on open: it reads aloud
// only when the owner presses Read aloud.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';
import '../trading/che_account_stats.dart';
import '../trading/che_paper_account.dart';
import '../trading/che_my_trades.dart';
import '../trading/che_paper_engine.dart';
import '../trading/che_trade_replay.dart';
import 'che_trading_hud.dart';

const _up = Color(0xFF3DDC97);
const _down = Color(0xFFFF6B6B);
final _dim = CheColors.textDim;

/// One account's records as the dashboard holds them.
class CheAccountRecords {
  const CheAccountRecords({required this.trades, this.open, this.journal = const [], this.unavailable, this.checkedAt});
  final List<CheStatTrade> trades;
  final int? open;
  final List<({DateTime? at, String text})> journal;
  final String? unavailable;
  final DateTime? checkedAt;
}

class CheTradingDashboard extends StatefulWidget {
  const CheTradingDashboard({
    super.key,
    required this.baseUrl,
    required this.headers,
    this.client,
    this.onRead,
    this.engine,
    this.myTrades,
    this.refresh = const Duration(seconds: 60),
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  final void Function(String text)? onRead;

  /// Tests pass an account; the app uses ChePaperEngine.shared().
  final ChePaperEngine? engine;
  final CheMyTradesStore? myTrades;
  final Duration refresh;

  /// The figures on screen right now, for the voice routes ("explain win rate"). Null until an account has loaded.
  static final latest = ValueNotifier<CheAccountStats?>(null);

  @override
  State<CheTradingDashboard> createState() => _CheTradingDashboardState();
}

class _CheTradingDashboardState extends State<CheTradingDashboard> {
  late final http.Client _http = widget.client ?? http.Client();
  final _records = <CheAccountSource, CheAccountRecords>{};
  CheAccountSource? _source;
  CheStat? _open;
  ChePaperEngine? _engine;
  Timer? _timer;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_loadAll());
    _timer = Timer.periodic(widget.refresh, (_) => unawaited(_loadWorker()));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _engine?.removeListener(_onEngine);
    if (widget.client == null) _http.close();
    super.dispose();
  }

  Future<void> _loadAll() async {
    await Future.wait([_loadWorker(), _loadEngine(), _loadMine()]);
    if (!mounted) return;
    setState(() {
      _loading = false;
      // The first account with closed trades, in the owner's order; forward paper futures when none has any.
      _source ??= [CheAccountSource.chePaper, CheAccountSource.forwardPaperFutures, CheAccountSource.forwardPaperCrypto, CheAccountSource.simulation, CheAccountSource.ownerTrades]
              .where((s) => (_records[s]?.trades ?? const []).any((t) => t.closed))
              .firstOrNull ??
          CheAccountSource.forwardPaperFutures;
    });
    _publish();
  }

  Future<void> _loadWorker() async {
    final checked = DateTime.now().toUtc();
    void fail(String why) {
      for (final s in [CheAccountSource.forwardPaperFutures, CheAccountSource.forwardPaperCrypto, CheAccountSource.simulation]) {
        _records[s] = CheAccountRecords(trades: const [], unavailable: why, checkedAt: checked);
      }
    }

    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl()}/api/trading/calendar').replace(queryParameters: {'view': 'accounts'}), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map || j['accounts'] is! List) {
        fail(j is Map && j['detail'] != null ? '${j['detail']}' : 'CHE answered ${r.statusCode}');
      } else {
        for (final a in (j['accounts'] as List).whereType<Map>()) {
          final source = CheAccountSource.values.where((s) => s.workerId == a['id']).firstOrNull;
          if (source == null) continue;
          final unit = source.unit;
          _records[source] = CheAccountRecords(
            trades: [for (final t in (a['trades'] as List? ?? const []).whereType<Map>()) CheStatTrade.fromWorker(Map<String, dynamic>.from(t), unit)],
            open: a['open_positions'] is num ? (a['open_positions'] as num).toInt() : null,
            journal: [
              for (final e in (a['journal'] as List? ?? const []).whereType<Map>())
                (at: DateTime.tryParse('${e['time'] ?? ''}'), text: '${e['strategy'] ?? ''}: ${e['reason'] ?? ''}'),
            ],
            unavailable: a['read'] == false ? '${a['error'] ?? 'the records could not be read'}' : null,
            checkedAt: DateTime.tryParse('${j['checked_at'] ?? ''}') ?? checked,
          );
        }
      }
    } on FormatException {
      fail('CHE sent an answer that could not be read');
    } catch (_) {
      fail('CHE could not be reached');
    }
    if (mounted && !_loading) setState(() {});
    _publish();
  }

  Future<void> _loadEngine() async {
    try {
      final e = widget.engine ?? await ChePaperEngine.shared();
      if (!identical(e, _engine)) {
        _engine?.removeListener(_onEngine);
        _engine = e..addListener(_onEngine);
      }
      _fromEngine();
    } catch (err) {
      _records[CheAccountSource.chePaper] = CheAccountRecords(trades: const [], unavailable: 'the CHE paper account could not be opened on this phone', checkedAt: DateTime.now().toUtc());
    }
  }

  /// A trade opened or closed: the figures recompute at once.
  void _onEngine() {
    _fromEngine();
    if (mounted) setState(() {});
    _publish();
  }

  void _fromEngine() {
    final e = _engine;
    if (e == null) return;
    _records[CheAccountSource.chePaper] = CheAccountRecords(
      trades: [
        for (final p in e.positions)
          CheStatTrade(
            id: p.id, instrument: p.contract.root, market: 'futures', strategy: p.signal.strategy, side: p.side.label,
            entryAt: p.entryAt, exitAt: p.status.isOpen ? null : p.exitAt, value: p.netPnl, kind: 'che_paper', replay: false,
          ),
      ],
      open: e.openPositions.length,
      journal: [for (final j in e.journal.reversed.take(5)) (at: j.at, text: j.text)],
      checkedAt: DateTime.now().toUtc(),
    );
  }

  Future<void> _loadMine() async {
    final list = await (widget.myTrades ?? CheMyTradesStore()).load();
    _records[CheAccountSource.ownerTrades] = CheAccountRecords(
      trades: [
        for (final t in list)
          CheStatTrade(id: t.id, instrument: t.symbol, market: 'futures', strategy: t.setup, side: t.side, entryAt: t.openedAt, exitAt: t.closedAt, value: t.realized, kind: 'owner', replay: false),
      ],
      open: list.where((t) => t.isOpen).length,
      checkedAt: DateTime.now().toUtc(),
    );
  }

  CheAccountStats? get _stats {
    final s = _source;
    if (s == null) return null;
    final r = _records[s];
    if (r == null) return cheComputeAccountStats(s, const [], unavailable: 'the records are still loading');
    return cheComputeAccountStats(s, r.trades, openPositions: r.open, checkedAt: r.checkedAt, unavailable: r.unavailable);
  }

  void _publish() => CheTradingDashboard.latest.value = _stats;

  void _choose(CheAccountSource s) {
    HapticFeedback.selectionClick();
    setState(() {
      _source = s;
      _open = null;
    });
    _publish();
  }

  void _replay(CheStatTrade t) {
    HapticFeedback.selectionClick();
    unawaited(Navigator.of(context).push(MaterialPageRoute<void>(
      settings: RouteSettings(name: 'trade_replay/${t.id}'),
      builder: (_) => CheTradeReplayPage(tradeId: t.id, baseUrl: widget.baseUrl, headers: widget.headers, onRead: widget.onRead, client: widget.client),
    )));
  }

  Widget _chips() => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: [
          for (final s in CheAccountSource.values)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Semantics(
                button: true,
                selected: s == _source,
                label: 'Account ${s.label}${s == _source ? ', selected' : ''}',
                excludeSemantics: true,
                child: ChoiceChip(
                  key: Key('dash_account_${s.name}'),
                  label: Text(s.label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
                  selected: s == _source,
                  onSelected: (_) => _choose(s),
                ),
              ),
            ),
        ]),
      );

  Widget _tile(CheAccountStats s, CheStat stat) {
    final value = cheStatValue(s, stat);
    final words = value == 'No recorded trades' || value == 'Data unavailable' || value == 'Not reported' || value == 'No P&L recorded';
    final tone = stat == CheStat.pnl && s.realized != null && s.realized != 0 ? (s.realized! > 0 ? _up : _down) : Colors.white;
    final open = _open == stat;
    return Semantics(
      button: true,
      expanded: open,
      label: '${cheStatTitle(stat)}: $value. ${open ? 'Explanation open' : 'Double tap to explain'}.',
      excludeSemantics: true,
      child: InkWell(
        key: Key('dash_stat_${stat.name}'),
        borderRadius: BorderRadius.circular(10),
        onTap: () => setState(() => _open = open ? null : stat),
        child: Container(
          constraints: const BoxConstraints(minHeight: 64),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: open ? CheHud.ice : (cheHudActive ? CheHud.ice.withValues(alpha: 0.28) : CheColors.stroke)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
            Row(children: [
              Expanded(child: Text(cheStatTitle(stat).toUpperCase(), maxLines: 1, overflow: TextOverflow.ellipsis, style: CheHud.label.copyWith(fontSize: 10.5))),
              Icon(open ? Icons.expand_less_rounded : Icons.info_outline_rounded, size: 15, color: Colors.white54),
            ]),
            const SizedBox(height: 2),
            Text(value,
                maxLines: 2,
                style: TextStyle(color: words ? Colors.white70 : tone, fontSize: words ? 14 : 18, fontWeight: words ? FontWeight.w600 : FontWeight.w800, fontFeatures: const [FontFeature.tabularFigures()])),
          ]),
        ),
      ),
    );
  }

  String _clock(DateTime? t) {
    if (t == null) return '—';
    final ny = cheNewYork(t);
    final h = ny.hour % 12 == 0 ? 12 : ny.hour % 12;
    return '${ny.month}/${ny.day} $h:${ny.minute.toString().padLeft(2, '0')} ${ny.hour < 12 ? 'AM' : 'PM'} ET';
  }

  Widget _recent(CheAccountStats s) {
    final r = _records[s.source];
    final trades = [...?r?.trades.where((t) => t.closed)]..sort((a, b) => b.exitAt!.compareTo(a.exitAt!));
    final journal = r?.journal ?? const [];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const SizedBox(height: 12),
      Semantics(header: true, child: Text('RECENT TRADES · ${s.source.label}', style: CheHud.label.copyWith(fontSize: 11.5))),
      const SizedBox(height: 4),
      if (s.unavailable != null)
        Text('Data unavailable (${s.unavailable}).', style: TextStyle(color: _dim, fontSize: 14))
      else if (trades.isEmpty)
        Text('No recorded trades in this account yet.', key: const Key('dash_no_trades'), style: TextStyle(color: _dim, fontSize: 14))
      else
        for (final t in trades.take(5))
          Semantics(
            button: t.replay,
            label: '${t.instrument} ${t.side} ${t.strategy}, ${t.value == null ? 'no result recorded' : cheStatAmount(t.value!, s.unit)}, closed ${_clock(t.exitAt)}.${t.replay ? ' Double tap to replay.' : ''}',
            excludeSemantics: true,
            child: InkWell(
              key: Key('dash_trade_${t.id}'),
              onTap: t.replay ? () => _replay(t) : null,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Row(children: [
                  SizedBox(width: 44, child: Text(t.instrument, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 14))),
                  Expanded(
                    child: Text('${t.side.toUpperCase()} · ${t.strategy}\n${_clock(t.exitAt)}', maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: _dim, fontSize: 12.5)),
                  ),
                  Text(t.value == null ? 'no result' : cheStatAmount(t.value!, s.unit),
                      style: TextStyle(color: (t.value ?? 0) > 0 ? _up : ((t.value ?? 0) < 0 ? _down : Colors.white70), fontWeight: FontWeight.w800, fontSize: 14)),
                  if (t.replay) const Padding(padding: EdgeInsets.only(left: 4), child: Icon(Icons.replay_rounded, size: 16, color: Colors.white54)),
                ]),
              ),
            ),
          ),
      if (journal.isNotEmpty) ...[
        const SizedBox(height: 10),
        Semantics(header: true, child: Text('LATEST JOURNAL ENTRIES', style: CheHud.label.copyWith(fontSize: 11.5))),
        const SizedBox(height: 4),
        for (final e in journal.take(3))
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text('${_clock(e.at)} · ${e.text}', style: const TextStyle(color: Colors.white, fontSize: 13.5)),
          ),
      ],
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final s = _stats;
    return CheTradingPanel(
      key: const Key('trading_dashboard'),
      padding: const EdgeInsets.all(12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(child: Semantics(header: true, child: Text('ACCOUNT', style: CheHud.label.copyWith(fontSize: 12.5, color: cheHudActive ? CheHud.ice : Colors.white)))),
          IconButton(
            tooltip: 'Refresh the account figures',
            onPressed: () => unawaited(_loadAll()),
            icon: const Icon(Icons.refresh_rounded, color: Colors.white70),
          ),
          if (widget.onRead != null && s != null)
            IconButton(
              key: const Key('dash_read'),
              tooltip: 'Read the account figures aloud',
              onPressed: () => widget.onRead!([for (final st in CheStat.values) cheStatExplain(s, st)].join(' ')),
              icon: const Icon(Icons.record_voice_over_rounded, color: Colors.white70),
            ),
        ]),
        _chips(),
        const SizedBox(height: 8),
        if (s == null)
          Text(_loading ? 'Reading the account records…' : 'Choose an account.', style: TextStyle(color: _dim, fontSize: 15))
        else ...[
          LayoutBuilder(builder: (context, box) {
            final w = (box.maxWidth - 8) / 2;
            return Wrap(spacing: 8, runSpacing: 8, children: [for (final stat in CheStat.values) SizedBox(width: w, child: _tile(s, stat))]);
          }),
          if (_open != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Semantics(
                container: true,
                label: cheStatExplain(s, _open!),
                excludeSemantics: true,
                child: Container(
                  key: const Key('dash_explain'),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), color: Colors.white.withValues(alpha: 0.05)),
                  child: Text(cheStatExplain(s, _open!), style: const TextStyle(color: Colors.white, fontSize: 15, height: 1.35)),
                ),
              ),
            ),
          const SizedBox(height: 6),
          Text(
            s.unavailable != null
                ? 'Data unavailable (${s.unavailable}).'
                : '${s.closed == 0 ? 'No recorded trades' : 'Latest trade closed ${_clock(s.updatedAt)}'} · read ${_clock(s.checkedAt)} · ${s.unit == 'R' ? 'in R, no dollars' : 'dollars after costs'} · backtests never included',
            key: const Key('dash_as_of'),
            style: TextStyle(color: _dim, fontSize: 12.5),
          ),
          _recent(s),
        ],
      ]),
    );
  }
}
