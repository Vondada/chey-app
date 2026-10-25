// The Trading Room (owner, 2026-10-20 Build 1; simplified 2026-10-23). CHART is home: the NQ | MNQ toggle, a compact live
// chart that expands to a large portrait chart, one status row (P&L, win rate, open, drawdown), BEST NOW and small
// strategy cards that expand in place. One-tap buttons open Setups, the Journal, Trade History, the Strategy Lab, the
// Account, Replay and Side by Side; their panels are small expandable cards, essentials first. Each section holds panels
// that already exist; nothing here reads or trades on its own. The Markets tab shows it, and voice ("Open Alpaca chart",
// "CHE, show EMA trades", "Show strategy progress") opens it as a page on the section asked for. Silent on open.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'dart:async';

import '../trading/che_crypto_desk.dart';
import '../trading/che_setup_board.dart';
import '../trading/che_setup_desk.dart';
import '../trading/che_trading_calendar.dart';
import 'che_alpaca_paper.dart';
import 'che_fye_draft.dart';
import 'che_live_paper.dart';
import 'che_strategy_controls.dart';
import 'che_trading_chart.dart';
import 'che_trading_connections.dart';
import 'che_trading_dashboard.dart';
import 'che_trading_expanded.dart';
import 'che_trading_intelligence.dart';
import 'che_trading_ledgers.dart';
import 'che_trading_research.dart';
import 'che_trading_side_by_side.dart';
import 'che_ticker_selector.dart';
import '../che_ui/che_hud.dart';
import '../trading/che_paper_account_panel.dart';
import '../che_ui/che_screen_awareness.dart';
import '../che_ui/che_ui_preferences.dart';
import '../che_ui/che_theme.dart';
import 'che_trading_hud.dart';

const _gold = CheColors.markets;
final _stroke = CheColors.stroke;

enum CheTradingSection { chart, setups, cheTrades, history, strategies, account, compare, crypto }

const kTradingSectionLabels = <CheTradingSection, String>{
  CheTradingSection.chart: 'CHART',
  CheTradingSection.setups: 'SETUPS',
  CheTradingSection.cheTrades: 'JOURNAL',
  CheTradingSection.history: 'HISTORY',
  CheTradingSection.strategies: 'STRATEGY LAB',
  CheTradingSection.account: 'ACCOUNT',
  // MY ACCOUNT beside the CHE PAPER ACCOUNT, and the Live Order Preview (owner, 2026-10-23).
  CheTradingSection.compare: 'SIDE BY SIDE',
  // Orion's crypto desk: BTC and ETH, researched and paper traded around the clock (owner master mission, 2026-10-23).
  CheTradingSection.crypto: 'CRYPTO',
};

const _sectionIcons = <CheTradingSection, IconData>{
  CheTradingSection.chart: Icons.candlestick_chart_rounded,
  CheTradingSection.setups: Icons.insights_rounded,
  CheTradingSection.cheTrades: Icons.menu_book_rounded,
  CheTradingSection.history: Icons.history_rounded,
  CheTradingSection.strategies: Icons.show_chart_rounded,
  CheTradingSection.account: Icons.account_balance_wallet_outlined,
  CheTradingSection.compare: Icons.compare_arrows_rounded,
  CheTradingSection.crypto: Icons.currency_bitcoin_rounded,
};

/// The section a Worker reply names ("chart", "strategies", ...); chart when unknown.
CheTradingSection cheTradingSectionNamed(String? name) => switch ((name ?? '').toLowerCase().replaceAll(RegExp(r'[^a-z]'), '')) {
      'chetrades' || 'trades' || 'journal' => CheTradingSection.cheTrades,
      'history' || 'tradehistory' => CheTradingSection.history,
      'setups' || 'setup' || 'signals' || 'signal' => CheTradingSection.setups,
      'strategies' || 'strategy' || 'strategylab' || 'lab' => CheTradingSection.strategies,
      'account' => CheTradingSection.account,
      'compare' || 'sidebyside' || 'side' => CheTradingSection.compare,
      'crypto' || 'bitcoin' || 'btc' || 'eth' || 'orion' => CheTradingSection.crypto,
      _ => CheTradingSection.chart,
    };

class CheTradingRoom extends StatefulWidget {
  const CheTradingRoom({
    super.key,
    required this.baseUrl,
    required this.headers,
    required this.onAsk,
    this.client,
    this.onRead,
    this.initialSection = CheTradingSection.chart,
    this.chartController,
    this.initialAccount = 'futures_paper',
    this.initialSymbol = '',
    this.initialStrategy,
    this.initialTimeframe,
    this.header,
    this.chartExtras = const [],
    this.accountExtras = const [],
    this.chartHeight = 340,
    this.setupDesk,
  });

  /// The Signal Mode desk (tests pass their own; the app uses the shared one on the live feed).
  final CheSetupDesk? setupDesk;

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  final http.Client? client;
  /// Reads text aloud, only when the owner presses a Read button.
  final void Function(String text)? onRead;
  final CheTradingSection initialSection;
  final CheTradingChartController? chartController;
  final String initialAccount, initialSymbol;
  final String? initialStrategy;

  /// The bar size CHE named when she opened the room by voice ('15m'); the chart starts on it.
  final String? initialTimeframe;
  final Widget? header;

  /// The market overview under the chart, and the extra cards under the account panels.
  final List<Widget> chartExtras, accountExtras;
  final double chartHeight;

  /// A voice reply that opens the Trading Room on a section ("Show strategy progress" → STRATEGIES)
  /// sets this; the open room switches to it, and a room built afterwards starts on it.
  static final requestedSection = ValueNotifier<CheTradingSection?>(null);


  @override
  State<CheTradingRoom> createState() => _CheTradingRoomState();
}

class _CheTradingRoomState extends State<CheTradingRoom> {
  late CheTradingSection _section = CheTradingRoom.requestedSection.value ?? widget.initialSection;

  @override
  void initState() {
    super.initState();
    if (widget.setupDesk == null) _desk.attach();
    // Audible alerts (only the types the owner turned on) speak through the room's reader.
    final read = widget.onRead;
    if (read != null) _desk.alerts.speak ??= (t) async => read(t);
    unawaited(_loadEvidence());
    unawaited(_restoreTicker());
    CheTradingRoom.requestedSection.value = null;
    CheTradingRoom.requestedSection.addListener(_onRequest);
    CheUiPreferences.instance.addListener(_onPrefs);
    _screen = CheScreenAwareness.register(context, () => CheScreenReport(page: 'Trading Room', tab: _section.name));
  }

  Object? _screen;
  void _onPrefs() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    CheTradingRoom.requestedSection.removeListener(_onRequest);
    CheUiPreferences.instance.removeListener(_onPrefs);
    CheScreenAwareness.unregister(_screen);
    super.dispose();
  }

  void _onRequest() {
    final s = CheTradingRoom.requestedSection.value;
    if (s == null || !mounted) return;
    setState(() => _section = s);
    CheTradingRoom.requestedSection.value = null;
  }
  late final CheTradingChartController _chart = widget.chartController ?? CheTradingChartController();
  late final CheSetupDesk _desk = widget.setupDesk ?? CheSetupDesk.instance;

  /// Recorded strategy evidence for the setup badges; without it they say "No recorded evidence".
  Future<void> _loadEvidence() async {
    try {
      _desk.applyEvidence(await _research.overview(_market));
    } catch (_) {}
  }
  late final CheTradingResearchClient _research = CheTradingResearchClient(baseUrl: widget.baseUrl, headers: widget.headers, client: widget.client);

  /// The futures market the research and the live chart follow.
  late String _market = const {'NQ', 'MNQ'}.contains(widget.initialSymbol.toUpperCase()) ? widget.initialSymbol.toUpperCase() : 'MNQ';

  /// The ticker on the chart (owner, 2026-10-24): any universe id. MNQ stays on CHE's MNQ PAPER chart (Rithmic and her
  /// journal); every other market opens the Markets chart on public data. Research follows NQ and MNQ only.
  late String _ticker = _market == 'NQ' ? 'futures:NQ' : 'futures:MNQ';

  void _setMarket(String id) {
    final m = id == 'futures:NQ' ? 'NQ' : id == 'futures:MNQ' ? 'MNQ' : _market;
    setState(() {
      _ticker = id;
      _market = m;
    });
    unawaited(CheTickerPrefs.instance.choose(id));
    if (id == 'futures:MNQ') {
      _chart.show(account: 'futures_paper', symbol: 'MNQ');
    } else {
      _chart.show(account: 'market', symbol: id);
    }
  }

  /// Opens on the owner's last ticker when it is not the MNQ default.
  Future<void> _restoreTicker() async {
    final prefs = CheTickerPrefs.instance;
    await prefs.load();
    if (!mounted || widget.initialSymbol.isNotEmpty || widget.initialAccount != 'futures_paper') return;
    if (prefs.last != _ticker) _setMarket(prefs.last);
  }

  // The owner's layout density (Owner Improvements: "this page is too cramped") scales the room's spacing.
  Widget _pad(Widget child) {
    final g = 12 * CheUiPreferences.instance.spacing;
    return Padding(padding: EdgeInsets.fromLTRB(g, g, g, 0), child: child);
  }

  /// A small expandable card: its title and one line first, the full panel only when opened (owner, 2026-10-23).
  Widget _fold(String key, String title, String summary, Widget child, {bool open = false, String id = ''}) => _pad(CheTradingFold(
        key: Key('fold_$key'),
        id: id,
        title: title,
        summary: summary,
        initiallyExpanded: open,
        child: child,
      ));

  /// A titled card on the first screen.
  Widget _card(String key, String title, Widget child) => _pad(CheTradingPanel(
        key: Key('card_$key'),
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Semantics(header: true, child: Text(title, style: CheHud.label.copyWith(fontSize: 12.5, color: cheHudActive ? CheHud.ice : Colors.white))),
          const SizedBox(height: 6),
          child,
        ]),
      ));

  /// The compact chart's height from the space it gets: a preview, never a full screen.
  double _chartHeight(BoxConstraints box, Size screen) {
    final byWidth = box.maxWidth * 0.56;
    final byScreen = screen.height * 0.38;
    return (byWidth < byScreen ? byWidth : byScreen).clamp(170.0, widget.chartHeight);
  }

  void _expandChart() {
    HapticFeedback.selectionClick();
    // Portrait-first: the expanded chart follows the orientation the owner holds; it never rotates the phone.
    Navigator.of(context).push(MaterialPageRoute<void>(
      settings: const RouteSettings(name: 'trading_chart_expanded'),
      builder: (_) => CheTradingChartExpandedPage(
        baseUrl: widget.baseUrl,
        headers: widget.headers,
        client: widget.client,
        onRead: widget.onRead,
        account: _compact.currentState?.account ?? widget.initialAccount,
        symbol: _compact.currentState?.symbol ?? widget.initialSymbol,
        strategy: widget.initialStrategy,
        timeframe: _compact.currentState?.timeframe ?? widget.initialTimeframe,
        signalMarkers: _desk.markerFeed,
      ),
    ));
  }

  /// REPLAY opens Trade Replay on CHE's latest recorded closed trade on the chart; with none, it says so in History.
  void _openReplay() {
    HapticFeedback.selectionClick();
    final exits = [
      for (final m in _compact.currentState?.shownMarkers ?? const <ChartMarker>[])
        if (m.source.startsWith('che_') && m.kind == 'exit' && m.tradeId.isNotEmpty) m,
    ]..sort((a, b) => (b.time ?? DateTime(0)).compareTo(a.time ?? DateTime(0)));
    if (exits.isNotEmpty) {
      unawaited(_compact.currentState!.openRecord(exits.first));
      return;
    }
    setState(() {
      _section = CheTradingSection.history;
      _note = 'No closed CHE trade is on the chart to replay. Ask "replay my last trade", or tap a W or L marker.';
    });
  }

  String _note = '';
  final _compact = GlobalKey<CheTradingChartState>();

  List<Widget> _sectionChildren() {
    final p = (baseUrl: widget.baseUrl, headers: widget.headers, onAsk: widget.onAsk, client: widget.client);
    switch (_section) {
      // Trading Room v3 (owner, 2026-10-25), the first screen in this order: the chart with its source and time, the
      // selected account's P&L, win rate, open positions and drawdown, its recent trades and journal, the unified
      // P&L calendar, the strategy slot, then research, backtesting, replay and advanced controls folded.
      case CheTradingSection.chart:
        return [
          _pad(CheTickerSelector(selected: _ticker, onSelect: _setMarket, baseUrl: p.baseUrl, headers: p.headers, client: p.client)),
          if (_ticker != 'futures:MNQ' && _ticker != 'futures:NQ')
            _pad(Text('Strategy research below is for $_market.',
                key: const Key('research_market_note'), style: const TextStyle(color: Colors.white70, fontSize: 13))),
          _pad(LayoutBuilder(
            builder: (context, box) => CheTradingChart(
              key: _compact,
              baseUrl: p.baseUrl,
              headers: p.headers,
              client: p.client,
              onSpeak: widget.onRead,
              controller: _chart,
              initialAccount: widget.initialAccount,
              initialSymbol: widget.initialSymbol.isEmpty && widget.initialAccount == 'futures_paper' ? 'MNQ' : widget.initialSymbol,
              initialStrategy: widget.initialStrategy,
              initialTimeframe: widget.initialTimeframe,
              height: _chartHeight(box, MediaQuery.sizeOf(context)),
              signalMarkers: _desk.markerFeed,
              compact: true,
              onExpand: _expandChart,
            ),
          )),
          _pad(CheTradingDashboard(baseUrl: p.baseUrl, headers: p.headers, client: p.client, onRead: widget.onRead)),
          _card('calendar', 'P&L CALENDAR', CheUnifiedCalendar(baseUrl: p.baseUrl, headers: p.headers, client: p.client, onRead: widget.onRead)),
          // The strategy rankings slot: the integrator swaps the Strategy Matrix widget in here (lane trading-strategy-v3).
          KeyedSubtree(
            key: const Key('strategy_matrix_slot'),
            child: CheTradingResearchStrip(key: const Key('research_strip'), client: _research, market: _market, onRead: widget.onRead, showStatusRow: false),
          ),
          const SizedBox(height: 4),
          _fold('research', 'RESEARCH & BACKTESTING', 'Evidence by strategy and timeframe, historical study',
              Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                CheTradingResearchDashboard(client: _research, market: _market, onRead: widget.onRead),
                const SizedBox(height: 8),
                CheTradingIntelligencePanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, onRead: widget.onRead, client: p.client),
              ]),
              id: 'research'),
          _fold('replay', 'REPLAY', 'Replay CHE\'s latest closed trade on the chart',
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(
                  key: const Key('replay_latest'),
                  onPressed: _openReplay,
                  icon: const Icon(Icons.replay_rounded),
                  label: const Text('Replay the latest closed trade', semanticsLabel: 'Replay CHE\'s latest closed trade'),
                ),
              ),
              id: 'replay'),
          _fold('advanced', 'ADVANCED CONTROLS', 'Strategy limits and the market overview',
              Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                CheStrategyControlsPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client),
                // The older overview (index chart, quotes, 3D scene) builds only when this fold is opened.
                ...widget.chartExtras,
              ]),
              id: 'advanced'),
        ];
      case CheTradingSection.setups:
        return [_pad(CheSetupBoard(desk: _desk, onRead: widget.onRead))];
      case CheTradingSection.cheTrades:
        return [
          // CHE's own simulated account on live Rithmic prices (owner, 2026-10-23): balance, positions, trade details.
          _fold('che_paper', 'CHE PAPER ACCOUNT', 'Simulated balance and positions on live Rithmic prices',
              ChePaperAccountPanel(key: const Key('che_paper_account'), onRead: widget.onRead), open: true),
          _fold('journal', 'PAPER JOURNAL', 'CHE PAPER ACCOUNT trades and totals',
              CheLivePaperPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, onRead: widget.onRead, client: p.client), open: true),
          _fold('fye', 'FUNDYOUREDGE DRAFT', 'Order drafts; nothing is sent', CheFyeDraftCard(baseUrl: p.baseUrl, headers: p.headers, client: p.client)),
        ];
      case CheTradingSection.history:
        return [
          if (_note.isNotEmpty) _pad(Text(_note, key: const Key('trading_note'), style: const TextStyle(color: Colors.white, fontSize: 15))),
          // The P&L calendar and "Is CHE improving?" (owner, 2026-10-24): sim, paper and broker kept apart.
          _pad(Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton.icon(
              key: const Key('trading_calendar_button'),
              onPressed: () => unawaited(Navigator.of(context).push(CheTradingCalendarPage.route(baseUrl: p.baseUrl, headers: p.headers, onRead: widget.onRead))),
              icon: const Icon(Icons.calendar_month_rounded),
              label: const Text('Per-source calendar and "Is CHE improving?"'),
            ),
          )),
          _fold('history', 'TRADE HISTORY', 'Simulation, paper journal and broker ledgers, each labelled',
              CheTradingLedgersPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client), open: true),
        ];
      case CheTradingSection.strategies:
        // The research dashboard first; limits, the registry and the historical study fold under it.
        return [
          _fold('research', 'RESEARCH', 'Evidence by strategy and timeframe',
              CheTradingResearchDashboard(client: _research, market: _market, onRead: widget.onRead), open: true),
          _fold('controls', 'CONTROLS', 'Enable, pause and limits per strategy',
              CheStrategyControlsPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client)),
          // Historical trading intelligence (owner, 2026-10-22): decades of history, out-of-sample ranking, paper signals.
          _fold('intelligence', 'HISTORICAL INTELLIGENCE', 'Decades of history, out-of-sample ranking',
              CheTradingIntelligencePanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, onRead: widget.onRead, client: p.client)),
        ];
      case CheTradingSection.account:
        return [
          _fold('che_paper_compact', 'CHE PAPER ACCOUNT', 'Simulated balance and limits',
              ChePaperAccountPanel(key: const Key('che_paper_account_compact'), onRead: widget.onRead, compact: true), open: true),
          // Hidden while kShowAlpacaPaper is false (owner, 2026-10-23); the panel and its data path are kept.
          if (kShowAlpacaPaper) _fold('alpaca', 'ALPACA PAPER', 'Paper balance, orders and fills (delayed data)',
              CheAlpacaPaperPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client), open: true),
          // Rithmic and Coinbase market data as separate facts (Trading Room v3); open by default.
          _fold('feeds', 'MARKET DATA FEEDS', 'Rithmic session, subscription, trades and freshness; Coinbase public data', const CheMarketDataFeedsCard(), open: true),
          _fold('connections', 'CONNECTIONS', 'Broker and data connections',
              CheTradingConnectionsPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client)),
          ...widget.accountExtras,
        ];
      case CheTradingSection.compare:
        return [_pad(CheSideBySideView(baseUrl: p.baseUrl, headers: p.headers, client: p.client, onRead: widget.onRead))];
      case CheTradingSection.crypto:
        return [_pad(CheCryptoDeskPanel(baseUrl: p.baseUrl, headers: p.headers, client: p.client, onRead: widget.onRead))];
    }
  }

  void _go(CheTradingSection s) {
    if (s == _section) return;
    HapticFeedback.selectionClick();
    setState(() {
      _section = s;
      _note = '';
    });
  }

  Widget _navButton(String label, IconData icon, bool selected, VoidCallback onTap, {Key? key}) {
    final hud = cheHudActive;
    return Semantics(
      button: true,
      selected: selected,
      label: '$label${label == 'REPLAY' ? '' : ' section'}${selected ? ', open' : ''}',
      excludeSemantics: true,
      child: InkWell(
        key: key,
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: 6),
          decoration: BoxDecoration(
            color: selected ? (hud ? CheHud.ice.withValues(alpha: 0.16) : _gold.withValues(alpha: 0.2)) : Colors.transparent,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: selected ? (hud ? CheHud.ice : _gold) : (hud ? CheHud.ice.withValues(alpha: 0.24) : _stroke)),
            boxShadow: hud && selected ? [BoxShadow(color: CheHud.ice.withValues(alpha: 0.3), blurRadius: 10)] : null,
          ),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(icon, size: 16, color: selected ? (hud ? CheHud.ice : Colors.white) : CheHud.chromeMid),
            const SizedBox(width: 4),
            Flexible(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(label, maxLines: 1, style: CheHud.label.copyWith(fontSize: 11.5, color: selected ? (hud ? CheHud.ice : Colors.white) : CheHud.chromeMid)),
              ),
            ),
          ]),
        ),
      ),
    );
  }

  /// One-tap access in one row that scrolls sideways on a phone (v3: three rows of buttons pushed the chart down);
  /// all in one fixed row when the screen is wide.
  Widget _nav() => _pad(LayoutBuilder(builder: (context, box) {
        final items = <(String, IconData, bool, VoidCallback, Key)>[
          for (final e in kTradingSectionLabels.entries)
            (e.value, _sectionIcons[e.key]!, e.key == _section, () => _go(e.key), Key('trading_nav_${e.key.name}')),
          ('REPLAY', Icons.replay_rounded, false, _openReplay, const Key('trading_nav_replay')),
        ];
        if (box.maxWidth >= 720) {
          final w = (box.maxWidth - (items.length - 1) * 6) / items.length;
          return Row(children: [
            for (final (i, (label, icon, sel, tap, key)) in items.indexed) ...[
              if (i > 0) const SizedBox(width: 6),
              SizedBox(width: w, child: _navButton(label, icon, sel, tap, key: key)),
            ],
          ]);
        }
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            for (final (label, icon, sel, tap, key) in items)
              Padding(padding: const EdgeInsets.only(right: 6), child: SizedBox(width: 118, child: _navButton(label, icon, sel, tap, key: key))),
          ]),
        );
      }));

  @override
  Widget build(BuildContext context) {
    return ListView(
      // A plain key, never a PageStorageKey: under one, the list's saved scroll offset (a double) and every
      // ExpansionTile inside it (which restores a bool) share one storage slot, so after a scroll the tile threw and a
      // release build painted a flat gray box (owner recording, 2026-10-25). See che_trading_room_v3_test.dart.
      key: const ValueKey('trading_room_list'),
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        ?widget.header,
        _nav(),
        ..._sectionChildren(),
      ],
    );
  }
}

/// The Trading Room as its own page, opened by voice on the section and chart asked for.
class CheTradingRoomPage extends StatelessWidget {
  const CheTradingRoomPage({
    super.key,
    required this.baseUrl,
    required this.headers,
    required this.onAsk,
    this.onRead,
    this.section = CheTradingSection.chart,
    this.account,
    this.symbol,
    this.strategy,
    this.timeframe,
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  /// Reads text aloud, only when the owner presses a Read button.
  final void Function(String text)? onRead;
  final CheTradingSection section;
  final String? account, symbol, strategy;

  /// The bar size the Worker's reply named ("Opening the Alpaca PAPER chart for AAPL on 15-minute bars"); the chart starts on it.
  final String? timeframe;

  /// Route for a Worker reply's `chart` object: {section, account, symbol, filter: {strategy}, timeframe}.
  static Route<void> route({
    required String Function() baseUrl,
    required Map<String, String> Function() headers,
    required void Function(String) onAsk,
    void Function(String)? onRead,
    Map<String, dynamic>? chart,
  }) {
    final c = chart ?? const {};
    final filter = c['filter'] is Map ? c['filter'] as Map : const {};
    return MaterialPageRoute(
      settings: const RouteSettings(name: 'trading_room'),
      builder: (_) => CheTradingRoomPage(
        baseUrl: baseUrl,
        headers: headers,
        onAsk: onAsk,
        onRead: onRead,
        section: cheTradingSectionNamed(c['section']?.toString()),
        account: c['account']?.toString(),
        symbol: c['symbol']?.toString(),
        strategy: filter['strategy']?.toString(),
        timeframe: c['timeframe']?.toString(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: cheTradingPage(const Color(0xFF05080A)),
        appBar: AppBar(
          backgroundColor: cheTradingPage(Colors.black),
          foregroundColor: Colors.white,
          title: cheHudActive
              ? const CheChromeText('Trading Room', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800))
              : const Text('Trading Room'),
          leading: IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.of(context).maybePop()),
        ),
        body: SafeArea(
          child: CheTradingRoom(
            baseUrl: baseUrl,
            headers: headers,
            onAsk: onAsk,
            onRead: onRead,
            initialSection: section,
            // The live futures feed is the default; Alpaca (delayed) only when asked for by name.
            initialAccount: account ?? 'futures_paper',
            initialSymbol: symbol ?? '',
            initialStrategy: strategy,
            initialTimeframe: timeframe,
          ),
        ),
      );
}
