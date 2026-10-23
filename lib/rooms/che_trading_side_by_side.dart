// Side-by-side trading (owner, 2026-10-23): MY ACCOUNT beside the CHE PAPER ACCOUNT — charts, positions,
// trade details, a comparison of the two trades, both accounts' summaries, and the Live Order Preview.
//
// Data comes only from records: CHE's paper journal (/api/trading/live), trades the owner entered
// himself (che_my_trades.dart), and the live market feed (che_market_feed.dart) for the current price
// and its source label. The owner's funded account is not connected (CHE's Rithmic link is market data
// only), so its balance reads "not connected", never a number. Every pane, position, balance and
// figure is labelled MY ACCOUNT, CHE PAPER ACCOUNT or LIVE ACCOUNT in words and an icon. Silent on
// open; Read Aloud reads the summary only when pressed.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_account_bridge.dart';
import '../trading/che_paper_account.dart';
import '../trading/che_paper_compare.dart';
import '../trading/che_paper_engine.dart';
import '../trading/che_account_kind.dart';
import '../trading/che_live_order.dart';
import '../trading/che_market_feed.dart';
import '../trading/che_my_trades.dart';
import '../trading/che_trade_compare.dart';
import 'che_trading_chart.dart';

const _dim = Color(0xFFB8C2CC);
const _panel = Color(0xFF0E1418);
const _stroke = Color(0xFF2A3540);

/// The account and position switcher.
enum CheTradingView { mine, chePaper, allOpen, closed, pending, watchlist }

const kCheTradingViewLabels = <CheTradingView, String>{
  CheTradingView.mine: 'My account',
  CheTradingView.chePaper: 'CHE paper account',
  CheTradingView.allOpen: 'All open positions',
  CheTradingView.closed: 'Closed trades',
  CheTradingView.pending: 'Pending orders',
  CheTradingView.watchlist: 'Watchlisted setups',
};

/// Phone under 600 points wide: one pane at a time or both stacked. Wider: side by side.
enum CheSideBySideLayout { phone, tablet, desktop }

CheSideBySideLayout cheSideBySideLayoutFor(double width) =>
    width < 600 ? CheSideBySideLayout.phone : width < 1000 ? CheSideBySideLayout.tablet : CheSideBySideLayout.desktop;

String cheMoney(double? v) => v == null ? 'unknown' : '${v < 0 ? '−' : ''}\$${v.abs().toStringAsFixed(2)}';
String _signedMoney(double? v) => v == null ? 'unknown' : '${v > 0 ? '+' : v < 0 ? '−' : ''}\$${v.abs().toStringAsFixed(2)}';
String _price(double? v) => v == null ? 'unknown' : (v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2));
String _signed(double? v, {String unit = ''}) => v == null ? 'unknown' : '${v > 0 ? '+' : v < 0 ? '−' : ''}${_price(v.abs())}$unit';
String _pct(double? v) => v == null ? 'unknown' : '${v.toStringAsFixed(1)}%';
String cheDuration(Duration? d) {
  if (d == null) return 'unknown';
  final neg = d.isNegative;
  final a = d.abs();
  final s = a.inHours > 0 ? '${a.inHours}h ${a.inMinutes % 60}m' : '${a.inMinutes}m';
  return neg ? '−$s' : s;
}

String _clock(DateTime? t) {
  if (t == null) return 'unknown';
  final l = t.toLocal();
  return '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}:${l.second.toString().padLeft(2, '0')}';
}

typedef CheSideChartBuilder = Widget Function(BuildContext context, CheAccountKind account, CheTradingChartController controller, double height);

class CheSideBySideView extends StatefulWidget {
  const CheSideBySideView({
    super.key,
    required this.baseUrl,
    required this.headers,
    this.client,
    this.onRead,
    this.chartBuilder,
    this.store,
    this.snapshots,
    this.currentSnapshot,
    this.faceId,
    this.audit,
    this.now,
    this.paperEngine,
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;

  /// Reads text aloud, only when the owner presses a Read button.
  final void Function(String text)? onRead;

  /// Builds each pane's chart; defaults to the Trading Room chart on MNQ.
  final CheSideChartBuilder? chartBuilder;
  final CheMyTradesStore? store;
  final Stream<CheMarketSnapshot>? snapshots;
  final CheMarketSnapshot? Function()? currentSnapshot;
  final CheFaceIdCheck? faceId;
  final CheLiveOrderAudit? audit;
  final DateTime Function()? now;

  /// CHE's own paper account on this phone (tests pass one; the app loads the shared one).
  final ChePaperEngine? paperEngine;

  @override
  State<CheSideBySideView> createState() => CheSideBySideViewState();
}

class CheSideBySideViewState extends State<CheSideBySideView> {
  late final http.Client _http = widget.client ?? http.Client();
  late final CheMyTradesStore _store = widget.store ?? CheMyTradesStore();
  final _mineChart = CheTradingChartController();
  final _cheChart = CheTradingChartController();
  StreamSubscription<CheMarketSnapshot>? _feedSub;
  CheMarketSnapshot? _snap;

  Map<String, dynamic>? _live;
  ChePaperEngine? _paper;
  String _liveError = '';
  List<CheTradeView> _mine = const [];
  bool _loading = true;

  CheTradingView _view = CheTradingView.allOpen;
  String _symbol = ''; // '' = every symbol
  bool _sync = true;
  String _tf = '5m';
  String _syncSymbol = 'MNQ';
  int _phonePane = 0; // 0 both stacked, 1 mine, 2 CHE
  String? _selMine, _selChe;

  DateTime get _now => (widget.now ?? () => DateTime.now().toUtc())();

  @override
  void initState() {
    super.initState();
    try {
      _snap = (widget.currentSnapshot ?? () => CheMarketFeed.instance.current)();
      _feedSub = (widget.snapshots ?? CheMarketFeed.instance.snapshots).listen((s) {
        if (mounted) setState(() => _snap = s);
      });
    } catch (_) {
      _snap = null;
    }
    unawaited(load());
    unawaited(_loadPaper());
  }

  Future<void> _loadPaper() async {
    try {
      final e = widget.paperEngine ?? await ChePaperEngine.shared();
      if (!mounted) return;
      e.addListener(_paperChanged);
      setState(() => _paper = e);
    } catch (_) {
      ChePaperEngine.forgetShared();
    }
  }

  void _paperChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _paper?.removeListener(_paperChanged);
    unawaited(_feedSub?.cancel());
    _mineChart.dispose();
    _cheChart.dispose();
    if (widget.client == null) _http.close();
    super.dispose();
  }

  Future<void> load() async {
    final mine = await _store.load();
    Map<String, dynamic>? live;
    var error = '';
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl()}/api/trading/live'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode == 200 && j is Map && j['account'] != null) {
        live = Map<String, dynamic>.from(j);
      } else {
        error = 'CHE\'s paper records are not available (${r.statusCode}).';
      }
    } catch (_) {
      error = 'CHE\'s paper records could not be loaded. Check the connection and try again.';
    }
    if (!mounted) return;
    setState(() {
      _mine = mine;
      _live = live;
      _liveError = error;
      _loading = false;
    });
  }

  // ─── Records ────────────────────────────────────────────────────────────────────────────────────

  /// A live Rithmic price only; a recorded or delayed price never marks the owner's P&L.
  double? get _livePrice => _snap != null && _snap!.isLive ? _snap!.lastPrice : null;

  List<CheTradeView> get _minePositions => [for (final t in _mine) t.isOpen ? t.withUnrealized(cheUnrealizedAt(t, _livePrice)) : t];

  List<CheTradeView> get _chePositions => [
        // The CHE PAPER ACCOUNT on live Rithmic prices first, then the delayed forward-paper journal (each labelled by source).
        for (final p in _paper?.openPositions ?? const <ChePaperPosition>[]) cheTradeViewFromPaper(p),
        for (final p in _live?['positions'] as List? ?? const []) if (p is Map) CheTradeView.fromLivePosition(Map<String, dynamic>.from(p)),
      ];

  List<CheTradeView> get _cheClosed => [
        for (final p in _paper?.closedPositions ?? const <ChePaperPosition>[]) cheTradeViewFromPaper(p),
        for (final t in _live?['trades'] as List? ?? const []) if (t is Map) CheTradeView.fromLiveTrade(Map<String, dynamic>.from(t)),
      ];

  List<Map<String, dynamic>> get _cheSignals => [
        for (final s in _live?['signals'] as List? ?? const []) if (s is Map) Map<String, dynamic>.from(s),
      ].reversed.toList();

  bool _symbolOk(CheTradeView t) => _symbol.isEmpty || cheContractRoot(t.symbol) == _symbol;

  /// What each pane lists for the switcher's choice.
  List<CheTradeView> tradesFor(CheAccountKind account) {
    final all = account == CheAccountKind.mine ? _minePositions : [..._chePositions, ..._cheClosed];
    final mine = account == CheAccountKind.mine;
    return switch (_view) {
      CheTradingView.mine => mine ? all.where((t) => t.isOpen && _symbolOk(t)).toList() : const [],
      CheTradingView.chePaper => mine ? const [] : all.where((t) => t.isOpen && _symbolOk(t)).toList(),
      CheTradingView.allOpen => all.where((t) => t.isOpen && _symbolOk(t)).toList(),
      CheTradingView.closed => all.where((t) => !t.isOpen && _symbolOk(t)).toList(),
      CheTradingView.pending || CheTradingView.watchlist => const [],
    };
  }

  CheTradeView? _find(List<CheTradeView> list, String? id) {
    for (final t in list) {
      if (t.id == id) return t;
    }
    return null;
  }

  /// The pair to compare: the trades the owner picked, else his newest open trade and CHE's open
  /// position on the same contract root.
  (CheTradeView, CheTradeView)? get comparisonPair {
    final mineAll = _minePositions, cheAll = [..._chePositions, ..._cheClosed];
    var a = _find(mineAll, _selMine), b = _find(cheAll, _selChe);
    if (a == null) {
      final open = mineAll.where((t) => t.isOpen).toList();
      a = open.isEmpty ? null : open.last;
    }
    if (a != null && b == null) {
      for (final p in _chePositions) {
        if (cheContractRoot(p.symbol) == cheContractRoot(a.symbol)) b = p;
      }
    }
    return a == null || b == null ? null : (a, b);
  }

  CheAccountSummary get _mineSummary => CheAccountSummary.fromOwnerTrades(_minePositions);
  // The CHE PAPER ACCOUNT holds a balance; the delayed journal does not, so it is the fallback only.
  CheAccountSummary? get _cheSummary => _paper != null ? cheAccountSummaryFromPaper(_paper!) : _live == null ? null : CheAccountSummary.fromLiveDashboard(_live!);

  // ─── Sync ───────────────────────────────────────────────────────────────────────────────────────

  void _setTf(String tf) {
    setState(() => _tf = tf);
    _mineChart.showTimeframe(tf);
    _cheChart.showTimeframe(tf);
  }

  void _setSyncSymbol(String s) {
    setState(() => _syncSymbol = s);
    _mineChart.show(account: 'futures_paper', symbol: s);
    _cheChart.show(account: 'futures_paper', symbol: s);
  }

  void _zoom(double f) {
    _mineChart.zoomBy(f);
    _cheChart.zoomBy(f);
  }

  // ─── Read aloud ─────────────────────────────────────────────────────────────────────────────────

  String spokenSummary() {
    final m = _mineSummary, c = _cheSummary;
    final pair = comparisonPair;
    return [
      'Market: ${_snap?.sourceLabel ?? 'No live feed'}, ${_snap?.statusLabel ?? 'not connected'}, last price ${_price(_snap?.lastPrice)}.',
      '${CheAccountKind.mine.label}: ${m.openPositions ?? 0} open trades you entered, realized ${cheMoney(m.realized)}. Your broker balance is not connected.',
      c == null
          ? '${CheAccountKind.chePaper.label}: records not loaded.'
          : '${CheAccountKind.chePaper.label}: ${c.openPositions} open, realized ${cheMoney(c.realized)}, unrealized ${cheMoney(c.unrealized)}.',
      if (pair != null)
        'Comparison: entry difference ${_signed(CheTradeComparison(pair.$1, pair.$2, now: _now).entryDiff)} points, P&L difference ${_signedMoney(CheTradeComparison(pair.$1, pair.$2, now: _now).pnlDiff)}.',
      'Live orders are disabled.',
    ].join(' ');
  }

  // ─── UI ─────────────────────────────────────────────────────────────────────────────────────────

  Widget _chip(String label, bool on, VoidCallback onTap, {String? semantics, Key? key}) => Semantics(
        button: true,
        selected: on,
        label: '${semantics ?? label}${on ? ', selected' : ''}',
        excludeSemantics: true,
        child: InkWell(
          key: key,
          borderRadius: BorderRadius.circular(18),
          onTap: () {
            HapticFeedback.selectionClick();
            onTap();
          },
          child: Container(
            constraints: const BoxConstraints(minHeight: 40),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: on ? Colors.white : Colors.transparent,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: on ? Colors.white : _stroke, width: on ? 2 : 1),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              if (on) const Padding(padding: EdgeInsets.only(right: 4), child: Icon(Icons.check, size: 16, color: Colors.black)),
              Text(label, style: TextStyle(color: on ? Colors.black : Colors.white, fontWeight: FontWeight.w700, fontSize: 13)),
            ]),
          ),
        ),
      );

  Widget _feedLine() {
    final s = _snap;
    final text = s == null
        ? 'Market feed: no live feed on this phone.'
        : 'Market feed: ${s.sourceLabel} · ${s.statusLabel} · last ${_price(s.lastPrice)} · updated ${_clock(s.lastUpdate)}';
    return Semantics(
      label: text,
      excludeSemantics: true,
      child: Text(text, key: const Key('sbs_feed_line'), style: const TextStyle(color: _dim, fontSize: 13)),
    );
  }

  Widget _switcher() {
    final symbols = <String>{
      for (final t in [..._minePositions, ..._chePositions, ..._cheClosed]) cheContractRoot(t.symbol),
    }.toList()
      ..sort();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Semantics(header: true, child: const Text('SHOW', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 12, letterSpacing: 1.1))),
      const SizedBox(height: 6),
      Wrap(spacing: 6, runSpacing: 6, children: [
        for (final e in kCheTradingViewLabels.entries)
          _chip(e.value, _view == e.key, () => setState(() => _view = e.key), key: Key('sbs_view_${e.key.name}')),
      ]),
      if (symbols.isNotEmpty) ...[
        const SizedBox(height: 6),
        Wrap(spacing: 6, runSpacing: 6, children: [
          _chip('Every symbol', _symbol.isEmpty, () => setState(() => _symbol = ''), key: const Key('sbs_symbol_all')),
          for (final s in symbols) _chip(s, _symbol == s, () => setState(() => _symbol = s), semantics: 'Only $s', key: Key('sbs_symbol_$s')),
        ]),
      ],
    ]);
  }

  Widget _syncControls() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Semantics(
              toggled: _sync,
              label: 'Sync both charts: symbol, timeframe and zoom. ${_sync ? 'On' : 'Off: each chart has its own controls'}',
              excludeSemantics: true,
              child: SwitchListTile(
                key: const Key('sbs_sync'),
                contentPadding: EdgeInsets.zero,
                title: Text(_sync ? 'Charts synced' : 'Charts independent', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
                subtitle: const Text('Symbol, timeframe and zoom', style: TextStyle(color: _dim)),
                value: _sync,
                onChanged: (v) => setState(() => _sync = v),
              ),
            ),
          ),
        ]),
        if (_sync)
          Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
            for (final s in const ['MNQ', 'NQ']) _chip(s, _syncSymbol == s, () => _setSyncSymbol(s), semantics: 'Both charts $s', key: Key('sbs_sync_symbol_$s')),
            for (final t in const ['1m', '5m', '15m', '1h', '1d']) _chip(t, _tf == t, () => _setTf(t), semantics: 'Both charts timeframe $t', key: Key('sbs_tf_$t')),
            _iconButton(Icons.zoom_in_rounded, 'Zoom both charts in', () => _zoom(1.5)),
            _iconButton(Icons.zoom_out_rounded, 'Zoom both charts out', () => _zoom(1 / 1.5)),
          ]),
        const Padding(
          padding: EdgeInsets.only(top: 6),
          child: Text('Indicator overlays: each chart shows trade markers. EMA and VWAP lines are not drawn on these charts yet.',
              style: TextStyle(color: _dim, fontSize: 12)),
        ),
      ]);

  Widget _iconButton(IconData icon, String label, VoidCallback onTap) => Semantics(
        button: true,
        label: label,
        excludeSemantics: true,
        child: IconButton(onPressed: onTap, icon: Icon(icon, color: Colors.white), tooltip: label),
      );

  Widget _chart(CheAccountKind account, double height) {
    final controller = account == CheAccountKind.mine ? _mineChart : _cheChart;
    final builder = widget.chartBuilder;
    if (builder != null) return builder(context, account, controller, height);
    return CheTradingChart(
      key: Key('sbs_chart_${account.name}'),
      baseUrl: widget.baseUrl,
      headers: widget.headers,
      client: widget.client,
      controller: controller,
      initialAccount: 'futures_paper',
      initialSymbol: _syncSymbol,
      height: height,
    );
  }

  Widget _tradeTile(CheTradeView t, {required bool selected, required VoidCallback onTap}) {
    final dir = t.isLong ? 'LONG' : 'SHORT';
    final pnl = t.pnl;
    final label = '${t.account.label}. $dir ${_price(t.qty)} ${t.symbol}${t.setup.isEmpty ? '' : ', ${t.setup}'}, ${t.isOpen ? 'open' : 'closed'}. '
        'Entry ${_price(t.entry)}, stop ${_price(t.stop)}, target ${_price(t.target)}. '
        '${t.isOpen ? 'Unrealized' : 'Realized'} ${cheMoney(pnl)}. Risk ${cheMoney(t.dollarRisk)}, reward ${cheMoney(t.dollarReward)}. '
        'Time in trade ${cheDuration(t.timeInTrade(_now))}.${selected ? ' Selected for comparison.' : ''}';
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      excludeSemantics: true,
      child: InkWell(
        key: Key('sbs_trade_${t.id}'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          margin: const EdgeInsets.only(top: 6),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: _panel,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: selected ? t.account.color : _stroke, width: selected ? 2.5 : 1),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(t.isLong ? Icons.north_east : Icons.south_east, color: Colors.white, size: 18),
              const SizedBox(width: 6),
              Expanded(
                child: Text('$dir ${_price(t.qty)} ${t.symbol}${t.setup.isEmpty ? '' : ' · ${t.setup}'}',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
              ),
              Text(t.isOpen ? 'OPEN' : 'CLOSED', style: const TextStyle(color: _dim, fontWeight: FontWeight.w700, fontSize: 12)),
              if (selected) const Padding(padding: EdgeInsets.only(left: 6), child: Icon(Icons.compare_arrows_rounded, color: Colors.white, size: 18)),
            ]),
            const SizedBox(height: 4),
            Text(
              'Entry ${_price(t.entry)} · Stop ${_price(t.stop)} · Target ${_price(t.target)}'
              '${t.exit == null ? '' : ' · Exit ${_price(t.exit)}'}\n'
              '${t.isOpen ? 'Unrealized' : 'Realized'} ${cheMoney(pnl)} · Risk ${cheMoney(t.dollarRisk)} · Reward ${cheMoney(t.dollarReward)}\n'
              'Time in trade ${cheDuration(t.timeInTrade(_now))}${t.timeframe.isEmpty ? '' : ' · ${t.timeframe}'}${t.adjusted ? ' · ADJUSTED' : ''} · ${t.source}',
              style: const TextStyle(color: _dim, fontSize: 13, height: 1.35),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _emptyNote(String text, {Key? key}) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(text, key: key, style: const TextStyle(color: _dim, fontSize: 13)),
      );

  Widget _paneList(CheAccountKind account) {
    if (_view == CheTradingView.pending) {
      return _emptyNote(
          account == CheAccountKind.mine
              ? 'No pending orders can be shown: CHE has no connection to your broker\'s orders.'
              : 'CHE\'s paper account has no resting orders: a paper trade fills at its recorded signal.',
          key: Key('sbs_pending_${account.name}'));
    }
    if (_view == CheTradingView.watchlist) {
      if (account == CheAccountKind.mine) return _emptyNote('Setups are CHE\'s; they show in the CHE pane.');
      final signals = _cheSignals.where((s) => _symbol.isEmpty || _symbol == 'MNQ').take(12).toList();
      if (signals.isEmpty) return _emptyNote('No recorded setups yet.', key: const Key('sbs_watchlist_empty'));
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final s in signals)
          Semantics(
            label: 'Recorded setup ${s['strategy']}, ${s['side']}, at ${s['time']}, stop ${s['stop']}, target ${s['target']}. ${s['why'] ?? ''}',
            excludeSemantics: true,
            child: Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('${'${s['side']}'.toUpperCase()} · ${s['strategy']} · ${s['time']} · stop ${s['stop']} · target ${s['target']}',
                  style: const TextStyle(color: Colors.white, fontSize: 13)),
            ),
          ),
      ]);
    }
    if (account == CheAccountKind.chePaper && _live == null) {
      return _emptyNote(_liveError.isEmpty ? 'Loading CHE\'s paper records…' : _liveError, key: const Key('sbs_che_error'));
    }
    final list = tradesFor(account);
    if (list.isEmpty) {
      final hidden = (_view == CheTradingView.mine && account != CheAccountKind.mine) || (_view == CheTradingView.chePaper && account == CheAccountKind.mine);
      return _emptyNote(
          hidden
              ? 'Hidden: the switcher shows ${kCheTradingViewLabels[_view]} only.'
              : account == CheAccountKind.mine
                  ? 'No trades here. Add a trade you took with "Add my trade"; your broker account itself is not connected.'
                  : 'No CHE paper trades here.',
          key: Key('sbs_empty_${account.name}'));
    }
    return Column(children: [
      for (final t in list)
        _tradeTile(t,
            selected: account == CheAccountKind.mine ? _selMine == t.id : _selChe == t.id,
            onTap: () => setState(() => account == CheAccountKind.mine ? _selMine = t.id : _selChe = t.id)),
    ]);
  }

  Widget _pane(CheAccountKind account, double chartHeight) {
    final detail = account == CheAccountKind.mine ? 'Trades entered by you' : (_live == null ? 'records not loaded' : 'paper journal');
    return Container(
      key: Key('sbs_pane_${account.name}'),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: Colors.black, borderRadius: BorderRadius.circular(12), border: Border.all(color: account.color.withValues(alpha: 0.6))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        CheAccountBand(kind: account, detail: detail),
        const SizedBox(height: 8),
        _chart(account, chartHeight),
        const SizedBox(height: 6),
        Text(account == CheAccountKind.mine ? 'MY ACCOUNT positions' : 'CHE PAPER ACCOUNT positions',
            style: TextStyle(color: account.color, fontWeight: FontWeight.w800, fontSize: 13)),
        _paneList(account),
        if (account == CheAccountKind.mine) ...[
          const SizedBox(height: 8),
          Semantics(
            button: true,
            label: 'Add my trade. Records a trade you took, for comparison. Nothing is sent to a broker.',
            excludeSemantics: true,
            child: OutlinedButton.icon(
              key: const Key('sbs_add_mine'),
              onPressed: _addMyTrade,
              icon: const Icon(Icons.add),
              label: const Text('Add my trade'),
            ),
          ),
        ],
      ]),
    );
  }

  Widget _panes(CheSideBySideLayout layout) {
    final h = layout == CheSideBySideLayout.desktop ? 340.0 : layout == CheSideBySideLayout.tablet ? 260.0 : 240.0;
    if (layout != CheSideBySideLayout.phone) {
      return Row(crossAxisAlignment: CrossAxisAlignment.start, key: const Key('sbs_side_by_side'), children: [
        Expanded(child: _pane(CheAccountKind.mine, h)),
        const SizedBox(width: 10),
        Expanded(child: _pane(CheAccountKind.chePaper, h)),
      ]);
    }
    return Column(key: const Key('sbs_stacked'), crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(spacing: 6, runSpacing: 6, children: [
        _chip('Both', _phonePane == 0, () => setState(() => _phonePane = 0), semantics: 'Show both accounts stacked', key: const Key('sbs_phone_both')),
        _chip('Mine', _phonePane == 1, () => setState(() => _phonePane = 1), semantics: 'Show my account only', key: const Key('sbs_phone_mine')),
        _chip('CHE paper', _phonePane == 2, () => setState(() => _phonePane = 2), semantics: 'Show CHE paper account only', key: const Key('sbs_phone_che')),
      ]),
      const SizedBox(height: 8),
      if (_phonePane != 2) _pane(CheAccountKind.mine, h),
      if (_phonePane == 0) const SizedBox(height: 10),
      if (_phonePane != 1) _pane(CheAccountKind.chePaper, h),
    ]);
  }

  Widget _comparison() {
    final pair = comparisonPair;
    if (pair == null) {
      return _emptyNote('Compare: pick one of your trades and one of CHE\'s. Your trade needs to be added first; CHE needs an open or closed paper trade.',
          key: const Key('sbs_compare_empty'));
    }
    return CheTradeComparisonPanel(comparison: CheTradeComparison(pair.$1, pair.$2, now: _now));
  }

  Future<void> _addMyTrade() async {
    final added = await showDialog<CheTradeView>(context: context, builder: (_) => _AddMyTradeDialog(store: _store, defaultSymbol: _snap?.symbol ?? 'MNQ'));
    if (added == null) return;
    await load();
    if (mounted) setState(() => _selMine = added.id);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
    return LayoutBuilder(builder: (context, box) {
      final layout = cheSideBySideLayoutFor(box.maxWidth);
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Semantics(
                header: true,
                child: const Text('SIDE BY SIDE', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 14, letterSpacing: 1.2))),
          ),
          if (widget.onRead != null)
            Semantics(
              button: true,
              label: 'Read aloud: both accounts and the comparison',
              excludeSemantics: true,
              child: TextButton.icon(
                key: const Key('sbs_read'),
                onPressed: () => widget.onRead!(spokenSummary()),
                icon: const Icon(Icons.volume_up_rounded, color: Colors.white),
                label: const Text('Read', style: TextStyle(color: Colors.white)),
              ),
            ),
          _iconButton(Icons.refresh, 'Refresh both accounts', () => unawaited(load())),
        ]),
        _feedLine(),
        const SizedBox(height: 10),
        CheAccountsSummaryPanel(mine: _mineSummary, che: _cheSummary, wide: layout != CheSideBySideLayout.phone, cheError: _liveError),
        const SizedBox(height: 10),
        _switcher(),
        const SizedBox(height: 8),
        _syncControls(),
        const SizedBox(height: 8),
        _panes(layout),
        const SizedBox(height: 12),
        Semantics(header: true, child: const Text('COMPARE MY TRADE WITH CHE\'S', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 13, letterSpacing: 1.1))),
        _comparison(),
        const SizedBox(height: 12),
        Semantics(
          button: true,
          label: 'Open Live Order Preview. Shows what a live order would be; sending is disabled.',
          excludeSemantics: true,
          child: OutlinedButton.icon(
            key: const Key('sbs_open_live_preview'),
            style: OutlinedButton.styleFrom(foregroundColor: CheAccountKind.live.color, side: BorderSide(color: CheAccountKind.live.color, width: 2)),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
              settings: const RouteSettings(name: 'live_order_preview'),
              builder: (_) => CheLiveOrderPreviewPage(
                faceId: widget.faceId,
                audit: widget.audit,
                contract: _snap?.symbol.isNotEmpty == true ? _snap!.symbol : 'MNQ',
                lastPrice: _snap?.lastPrice,
                priceSource: _snap?.sourceLabel ?? 'No live feed',
              ),
            )),
            icon: const Icon(Icons.warning_amber),
            label: const Text('Live Order Preview (sending disabled)'),
          ),
        ),
      ]);
    });
  }
}

class CheTradeComparisonPanel extends StatelessWidget {
  const CheTradeComparisonPanel({super.key, required this.comparison});

  final CheTradeComparison comparison;

  @override
  Widget build(BuildContext context) {
    final c = comparison;
    final rows = <(String, String)>[
      ('Trades', '${CheAccountKind.mine.label}: ${c.mine.isLong ? 'LONG' : 'SHORT'} ${_price(c.mine.qty)} ${c.mine.symbol} · ${CheAccountKind.chePaper.label}: ${c.che.isLong ? 'LONG' : 'SHORT'} ${_price(c.che.qty)} ${c.che.symbol}'),
      ('Entry difference', '${_signed(c.entryDiff)} points (mine ${_price(c.mine.entry)}, CHE ${_price(c.che.entry)})'),
      ('Stop difference', '${_signed(c.stopDiff)} points'),
      ('Target difference', '${_signed(c.targetDiff)} points'),
      ('Quantity difference', _signed(c.qtyDiff, unit: ' contracts')),
      ('Dollar-risk difference', '${_signedMoney(c.dollarRiskDiff)} (mine ${cheMoney(c.mine.dollarRisk)}, CHE ${cheMoney(c.che.dollarRisk)})'),
      ('Current P&L difference', '${_signedMoney(c.pnlDiff)} (mine ${cheMoney(c.mine.pnl)}, CHE ${cheMoney(c.che.pnl)})'),
      ('Return on risk difference', c.returnPctDiff == null ? 'unknown' : '${_signed(c.returnPctDiff)} percentage points'),
      ('Time-in-trade difference', cheDuration(c.timeInTradeDiff)),
      ('Same setup', c.sameSetup ? 'Yes: ${c.che.setup}' : 'No${c.mine.setup.isEmpty ? ' (your trade names no setup)' : ''}'),
      ('Same direction', c.sameDirection ? 'Yes' : 'No'),
      ('Adjusted', 'Mine: ${c.mine.adjusted ? 'yes' : 'no'} · CHE: ${c.che.adjusted ? 'yes' : 'no'}'),
    ];
    return Container(
      key: const Key('sbs_compare'),
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: _panel, borderRadius: BorderRadius.circular(10), border: Border.all(color: _stroke)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final r in rows)
          Semantics(
            label: '${r.$1}: ${r.$2}',
            excludeSemantics: true,
            child: Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text.rich(TextSpan(children: [
                TextSpan(text: '${r.$1}: ', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
                TextSpan(text: r.$2, style: const TextStyle(color: _dim)),
              ])),
            ),
          ),
        const Text('Differences are mine minus CHE\'s. P&L comes from each record; your P&L is marked at the live Rithmic price only, before fees.',
            style: TextStyle(color: _dim, fontSize: 12)),
      ]),
    );
  }
}

class CheAccountsSummaryPanel extends StatelessWidget {
  const CheAccountsSummaryPanel({super.key, required this.mine, required this.che, this.wide = true, this.cheError = ''});

  final CheAccountSummary mine;
  final CheAccountSummary? che;
  final bool wide;
  final String cheError;

  Widget _card(CheAccountSummary? s, CheAccountKind kind) {
    final rows = s == null
        ? <(String, String)>[('Status', cheError.isEmpty ? 'Loading' : cheError)]
        : <(String, String)>[
            ('Current balance', s.balance == null ? (kind == CheAccountKind.mine ? 'not connected' : 'not set') : cheMoney(s.balance)),
            ('Available balance', s.available == null ? (kind == CheAccountKind.mine ? 'not connected' : 'not set') : cheMoney(s.available)),
            ('Equity', s.equity == null ? (kind == CheAccountKind.mine ? 'not connected' : 'not set') : cheMoney(s.equity)),
            ('Realized P&L', cheMoney(s.realized)),
            ('Unrealized P&L', cheMoney(s.unrealized)),
            ('Open positions', '${s.openPositions ?? 'unknown'}'),
            ('Win rate', _pct(s.winRate)),
            ('Average win', cheMoney(s.avgWin)),
            ('Average loss', cheMoney(s.avgLoss)),
            ('Maximum drawdown', cheMoney(s.maxDrawdown)),
            ('Current daily risk', cheMoney(s.dailyRisk)),
            ('Active setups', '${s.activeSetups ?? (kind == CheAccountKind.mine ? 'not tracked' : 'unknown')}'),
            ('Active trades', '${s.activeTrades ?? 'unknown'}'),
          ];
    return Container(
      key: Key('sbs_summary_${kind.name}'),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: _panel, borderRadius: BorderRadius.circular(10), border: Border.all(color: kind.color.withValues(alpha: 0.6))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        CheAccountBand(kind: kind),
        const SizedBox(height: 6),
        for (final r in rows)
          Semantics(
            label: '${kind.label}, ${r.$1}: ${r.$2}',
            excludeSemantics: true,
            child: Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Row(children: [
                Expanded(child: Text(r.$1, style: const TextStyle(color: _dim, fontSize: 13))),
                Text(r.$2, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13, fontFeatures: [FontFeature.tabularFigures()])),
              ]),
            ),
          ),
        if (s != null && s.note.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(s.note, style: const TextStyle(color: _dim, fontSize: 12))),
        if (s != null && s.source.isNotEmpty) Text('Source: ${s.source}', style: const TextStyle(color: _dim, fontSize: 12)),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final a = _card(mine, CheAccountKind.mine), b = _card(che, CheAccountKind.chePaper);
    return wide
        ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: a), const SizedBox(width: 10), Expanded(child: b)])
        : Column(children: [a, const SizedBox(height: 10), b]);
  }
}

class _AddMyTradeDialog extends StatefulWidget {
  const _AddMyTradeDialog({required this.store, required this.defaultSymbol});
  final CheMyTradesStore store;
  final String defaultSymbol;

  @override
  State<_AddMyTradeDialog> createState() => _AddMyTradeDialogState();
}

class _AddMyTradeDialogState extends State<_AddMyTradeDialog> {
  late final _symbol = TextEditingController(text: widget.defaultSymbol);
  final _qty = TextEditingController(text: '1');
  final _entry = TextEditingController();
  final _stop = TextEditingController();
  final _target = TextEditingController();
  final _setup = TextEditingController();
  String _side = 'long';
  String _error = '';

  @override
  void dispose() {
    for (final c in [_symbol, _qty, _entry, _stop, _target, _setup]) {
      c.dispose();
    }
    super.dispose();
  }

  Widget _field(String label, TextEditingController c, {bool number = true, Key? key}) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: TextField(
          key: key,
          controller: c,
          keyboardType: number ? const TextInputType.numberWithOptions(decimal: true) : TextInputType.text,
          decoration: InputDecoration(labelText: label, border: const OutlineInputBorder()),
        ),
      );

  Future<void> _save() async {
    final entry = double.tryParse(_entry.text.replaceAll(',', ''));
    final qty = double.tryParse(_qty.text);
    if (entry == null || qty == null || qty <= 0) {
      setState(() => _error = 'Entry price and a quantity of at least 1 are needed.');
      return;
    }
    final t = await widget.store.add(
      symbol: _symbol.text.trim().isEmpty ? 'MNQ' : _symbol.text.trim(),
      side: _side,
      qty: qty,
      entry: entry,
      stop: double.tryParse(_stop.text.replaceAll(',', '')),
      target: double.tryParse(_target.text.replaceAll(',', '')),
      setup: _setup.text.trim(),
    );
    if (mounted) Navigator.of(context).pop(t);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('MY ACCOUNT · add a trade you took'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('For comparison only. It is recorded on this phone as entered by you; nothing is sent to a broker.'),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [ButtonSegment(value: 'long', label: Text('Long')), ButtonSegment(value: 'short', label: Text('Short'))],
              selected: {_side},
              onSelectionChanged: (s) => setState(() => _side = s.first),
            ),
            const SizedBox(height: 8),
            _field('Symbol or contract', _symbol, number: false, key: const Key('add_symbol')),
            _field('Quantity', _qty, key: const Key('add_qty')),
            _field('Entry price', _entry, key: const Key('add_entry')),
            _field('Stop loss', _stop, key: const Key('add_stop')),
            _field('Take profit', _target, key: const Key('add_target')),
            _field('Setup name (optional)', _setup, number: false, key: const Key('add_setup')),
            if (_error.isNotEmpty) Text(_error, style: const TextStyle(fontWeight: FontWeight.w700)),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(key: const Key('add_save'), onPressed: () => unawaited(_save()), child: const Text('Save my trade')),
        ],
      );
}

/// The Live Order Preview: what a real-money order would be. Sending is disabled; Approve runs the per-order
/// Face ID check and the refusal, and both go into the audit log.
class CheLiveOrderPreviewPage extends StatefulWidget {
  const CheLiveOrderPreviewPage({
    super.key,
    this.faceId,
    this.audit,
    this.contract = 'MNQ',
    this.lastPrice,
    this.priceSource = '',
    this.accountName = 'FundYourEdge (Rithmic)',
  });

  final CheFaceIdCheck? faceId;
  final CheLiveOrderAudit? audit;
  final String contract, priceSource, accountName;
  final double? lastPrice;

  @override
  State<CheLiveOrderPreviewPage> createState() => CheLiveOrderPreviewPageState();
}

class CheLiveOrderPreviewPageState extends State<CheLiveOrderPreviewPage> {
  late final CheLiveOrderGate _gate = CheLiveOrderGate(
    // A fresh Face ID prompt for each order: requireFaceId forces the system sheet every time.
    faceId: widget.faceId ?? (reason) => CheAccountBridge.authenticate(reason: reason, requireFaceId: true),
    audit: widget.audit,
  );
  late final _contract = TextEditingController(text: widget.contract);
  final _qty = TextEditingController(text: '1');
  late final _entry = TextEditingController(text: widget.lastPrice == null ? '' : widget.lastPrice!.toStringAsFixed(2));
  final _stop = TextEditingController();
  final _target = TextEditingController();
  String _side = 'buy';
  CheLiveOrderOutcome? _outcome;
  bool _busy = false;
  CheLiveOrderTicket? _previewed;

  @override
  void dispose() {
    for (final c in [_contract, _qty, _entry, _stop, _target]) {
      c.dispose();
    }
    super.dispose();
  }

  CheLiveOrderTicket? get ticket {
    final entry = double.tryParse(_entry.text.replaceAll(',', ''));
    final qty = int.tryParse(_qty.text);
    if (entry == null || qty == null) return null;
    return CheLiveOrderTicket(
      accountName: widget.accountName,
      contract: _contract.text.trim().toUpperCase(),
      side: _side,
      qty: qty,
      entry: entry,
      stop: double.tryParse(_stop.text.replaceAll(',', '')),
      target: double.tryParse(_target.text.replaceAll(',', '')),
    );
  }

  Future<void> _preview() async {
    final t = ticket;
    if (t == null) {
      setState(() => _outcome = const CheLiveOrderOutcome(sent: false, step: CheLiveOrderStep.blocked, message: 'Enter an entry price and a whole-number quantity.'));
      return;
    }
    await _gate.recordPreview(t);
    if (mounted) {
      setState(() {
        _previewed = t;
        _outcome = null;
      });
    }
  }

  Future<void> _approve() async {
    final t = _previewed;
    if (t == null || _busy) return;
    setState(() => _busy = true);
    final outcome = await _gate.approve(t);
    if (!mounted) return;
    HapticFeedback.heavyImpact();
    setState(() {
      _busy = false;
      _outcome = outcome;
    });
  }

  Widget _field(String label, TextEditingController c, Key key, {bool number = true}) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: TextField(
          key: key,
          controller: c,
          onChanged: (_) => setState(() => _previewed = null),
          keyboardType: number ? const TextInputType.numberWithOptions(decimal: true) : TextInputType.text,
          style: const TextStyle(color: Colors.white),
          decoration: InputDecoration(labelText: label, labelStyle: const TextStyle(color: _dim), border: const OutlineInputBorder()),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final t = _previewed;
    final live = CheAccountKind.live;
    final rows = t == null
        ? const <(String, String)>[]
        : <(String, String)>[
            ('Account', '${live.label} · ${t.accountName}'),
            ('Contract', t.contract),
            ('Side', t.side.toUpperCase()),
            ('Quantity', '${t.qty}'),
            ('Entry', _price(t.entry)),
            ('Stop', _price(t.stop)),
            ('Target', _price(t.target)),
            ('Dollar risk', '${cheMoney(t.dollarRisk)} (at the stop, before fees and slippage)'),
            ('Reward to risk', t.riskReward == null ? 'unknown' : '${t.riskReward!.toStringAsFixed(2)} to 1'),
            ('Estimated fees', '${cheMoney(t.estimatedFees)} round turn (an estimate; your firm\'s fees may differ)'),
          ];
    return Scaffold(
      backgroundColor: const Color(0xFF05080A),
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: const Text('Live Order Preview'),
        leading: IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(16), children: [
          CheAccountBand(kind: live, detail: widget.accountName),
          const SizedBox(height: 10),
          Semantics(
            container: true,
            label: 'Status: sending is disabled. $kCheLiveOrderDisabledReason',
            excludeSemantics: true,
            child: Container(
              key: const Key('live_disabled_banner'),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(border: Border.all(color: live.color, width: 2), borderRadius: BorderRadius.circular(10)),
              child: const Text('SENDING DISABLED — PREVIEW ONLY\n$kCheLiveOrderDisabledReason',
                  style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, height: 1.35)),
            ),
          ),
          const SizedBox(height: 10),
          if (widget.lastPrice != null)
            Text('Entry prefilled from ${widget.priceSource}: ${_price(widget.lastPrice)}', style: const TextStyle(color: _dim, fontSize: 13)),
          const SizedBox(height: 8),
          SegmentedButton<String>(
            segments: const [ButtonSegment(value: 'buy', label: Text('Buy')), ButtonSegment(value: 'sell', label: Text('Sell'))],
            selected: {_side},
            onSelectionChanged: (s) => setState(() {
              _side = s.first;
              _previewed = null;
            }),
          ),
          const SizedBox(height: 8),
          _field('Contract', _contract, const Key('live_contract'), number: false),
          _field('Quantity (contracts)', _qty, const Key('live_qty')),
          _field('Entry price', _entry, const Key('live_entry')),
          _field('Stop loss', _stop, const Key('live_stop')),
          _field('Take profit', _target, const Key('live_target')),
          Semantics(
            button: true,
            label: 'Preview order. Shows the numbers; nothing is sent.',
            excludeSemantics: true,
            child: FilledButton(key: const Key('live_preview'), onPressed: () => unawaited(_preview()), child: const Text('Preview order')),
          ),
          for (final r in rows)
            Semantics(
              label: '${r.$1}: ${r.$2}',
              excludeSemantics: true,
              child: Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text.rich(TextSpan(children: [
                  TextSpan(text: '${r.$1}: ', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
                  TextSpan(text: r.$2, style: const TextStyle(color: _dim)),
                ])),
              ),
            ),
          if (t != null) ...[
            for (final p in t.problems) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Problem: $p', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700))),
            const SizedBox(height: 10),
            Semantics(
              button: true,
              label: 'Approve with Face ID. Asks Face ID for this one order. Sending is disabled, so nothing will be sent.',
              excludeSemantics: true,
              child: OutlinedButton.icon(
                key: const Key('live_approve'),
                style: OutlinedButton.styleFrom(foregroundColor: live.color, side: BorderSide(color: live.color, width: 2)),
                onPressed: _busy ? null : () => unawaited(_approve()),
                icon: const Icon(Icons.face_retouching_natural),
                label: Text(_busy ? 'Checking Face ID…' : 'Approve with Face ID (sending disabled)'),
              ),
            ),
          ],
          if (_outcome != null) ...[
            const SizedBox(height: 10),
            Semantics(
              liveRegion: true,
              label: 'Result: ${_outcome!.message} ${_outcome!.broker.summary}',
              excludeSemantics: true,
              child: Container(
                key: const Key('live_outcome'),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: _panel, borderRadius: BorderRadius.circular(10), border: Border.all(color: _stroke)),
                child: Text('${_outcome!.sent ? 'SENT' : 'NOT SENT'}: ${_outcome!.message}\n${_outcome!.broker.summary}',
                    style: const TextStyle(color: Colors.white, height: 1.35)),
              ),
            ),
          ],
        ]),
      ),
    );
  }
}
