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

import '../trading/che_setup_board.dart';
import '../trading/che_setup_desk.dart';
import 'che_alpaca_paper.dart';
import 'che_fye_draft.dart';
import 'che_live_paper.dart';
import 'che_strategy_controls.dart';
import 'che_trading_chart.dart';
import 'che_trading_connections.dart';
import 'che_trading_expanded.dart';
import 'che_trading_intelligence.dart';
import 'che_trading_ledgers.dart';
import 'che_trading_research.dart';
import 'che_trading_side_by_side.dart';
import '../che_ui/che_hud.dart';
import '../trading/che_paper_account_panel.dart';
import '../che_ui/che_screen_awareness.dart';
import '../che_ui/che_ui_preferences.dart';
import '../che_ui/che_theme.dart';
import 'che_trading_hud.dart';

const _gold = CheColors.markets;
final _stroke = CheColors.stroke;

enum CheTradingSection { chart, setups, cheTrades, history, strategies, account, compare }

const kTradingSectionLabels = <CheTradingSection, String>{
  CheTradingSection.chart: 'CHART',
  CheTradingSection.setups: 'SETUPS',
  CheTradingSection.cheTrades: 'JOURNAL',
  CheTradingSection.history: 'HISTORY',
  CheTradingSection.strategies: 'STRATEGY LAB',
  CheTradingSection.account: 'ACCOUNT',
  // MY ACCOUNT beside the CHE PAPER ACCOUNT, and the Live Order Preview (owner, 2026-10-23).
  CheTradingSection.compare: 'SIDE BY SIDE',
};

const _sectionIcons = <CheTradingSection, IconData>{
  CheTradingSection.chart: Icons.candlestick_chart_rounded,
  CheTradingSection.setups: Icons.insights_rounded,
  CheTradingSection.cheTrades: Icons.menu_book_rounded,
  CheTradingSection.history: Icons.history_rounded,
  CheTradingSection.strategies: Icons.show_chart_rounded,
  CheTradingSection.account: Icons.account_balance_wallet_outlined,
  CheTradingSection.compare: Icons.compare_arrows_rounded,
};

/// The section a Worker reply names ("chart", "strategies", ...); chart when unknown.
CheTradingSection cheTradingSectionNamed(String? name) => switch ((name ?? '').toLowerCase().replaceAll(RegExp(r'[^a-z]'), '')) {
      'chetrades' || 'trades' || 'journal' => CheTradingSection.cheTrades,
      'history' || 'tradehistory' => CheTradingSection.history,
      'setups' || 'setup' || 'signals' || 'signal' => CheTradingSection.setups,
      'strategies' || 'strategy' || 'strategylab' || 'lab' => CheTradingSection.strategies,
      'account' => CheTradingSection.account,
      'compare' || 'sidebyside' || 'side' => CheTradingSection.compare,
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

  void _setMarket(String m) {
    setState(() => _market = m);
    // CHE's live futures feed is MNQ; the chart shows MNQ for both, and says so when NQ research is chosen.
    _chart.show(account: 'futures_paper', symbol: 'MNQ');
  }

  // The owner's layout density (Owner Improvements: "this page is too cramped") scales the room's spacing.
  Widget _pad(Widget child) {
    final g = 12 * CheUiPreferences.instance.spacing;
    return Padding(padding: EdgeInsets.fromLTRB(g, g, g, 0), child: child);
  }

  /// A small expandable card: its title and one line first, the full panel only when opened (owner, 2026-10-23).
  Widget _fold(String key, String title, String summary, Widget child, {bool open = false}) => _pad(CheTradingFold(
        key: Key('fold_$key'),
        title: title,
        summary: summary,
        initiallyExpanded: open,
        child: child,
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
      case CheTradingSection.chart:
        return [
          _pad(Wrap(spacing: 10, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Semantics(header: true, child: Text('LIVE MARKET', style: CheHud.label.copyWith(fontSize: 12))),
            CheMarketToggle(market: _market, onChanged: _setMarket),
            if (_market == 'NQ')
              const Text('Chart: MNQ live feed. Research: NQ history.',
                  key: Key('nq_chart_note'), style: TextStyle(color: Colors.white70, fontSize: 13)),
          ])),
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
              height: _chartHeight(box, MediaQuery.sizeOf(context)),
              signalMarkers: _desk.markerFeed,
              compact: true,
              onExpand: _expandChart,
            ),
          )),
          CheTradingResearchStrip(key: const Key('research_strip'), client: _research, market: _market, onRead: widget.onRead),
          // The older overview (index chart, quotes, 3D scene) is folded so nothing heavy builds until asked for.
          if (widget.chartExtras.isNotEmpty)
            _fold('market_overview', 'MARKET OVERVIEW', 'Index chart and quotes', Column(children: widget.chartExtras)),
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
          _fold('alpaca', 'ALPACA PAPER', 'Paper balance, orders and fills (delayed data)',
              CheAlpacaPaperPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client), open: true),
          _fold('connections', 'CONNECTIONS', 'Broker and data connections',
              CheTradingConnectionsPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client)),
          ...widget.accountExtras,
        ];
      case CheTradingSection.compare:
        return [_pad(CheSideBySideView(baseUrl: p.baseUrl, headers: p.headers, client: p.client, onRead: widget.onRead))];
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

  /// One-tap access: four per row on a phone, all in one row when the screen is wide.
  Widget _nav() => _pad(LayoutBuilder(builder: (context, box) {
        final items = <(String, IconData, bool, VoidCallback, Key)>[
          for (final e in kTradingSectionLabels.entries)
            (e.value, _sectionIcons[e.key]!, e.key == _section, () => _go(e.key), Key('trading_nav_${e.key.name}')),
          ('REPLAY', Icons.replay_rounded, false, _openReplay, const Key('trading_nav_replay')),
        ];
        final perRow = box.maxWidth >= 720 ? items.length : 4;
        final w = (box.maxWidth - (perRow - 1) * 6) / perRow;
        return Wrap(spacing: 6, runSpacing: 6, children: [
          for (final (label, icon, sel, tap, key) in items) SizedBox(width: w, child: _navButton(label, icon, sel, tap, key: key)),
        ]);
      }));

  @override
  Widget build(BuildContext context) {
    return ListView(
      key: const PageStorageKey('trading_room_list'),
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
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  /// Reads text aloud, only when the owner presses a Read button.
  final void Function(String text)? onRead;
  final CheTradingSection section;
  final String? account, symbol, strategy;

  /// Route for a Worker reply's `chart` object: {section, account, symbol, filter: {strategy}}.
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
          ),
        ),
      );
}
