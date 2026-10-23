// The Trading Room in sections (owner, 2026-10-20, Build 1): CHART, CHE TRADES, STRATEGIES
// ACCOUNT and SIDE BY SIDE (2026-10-23). CHART leads with the live market (NQ | MNQ), then the status row, BEST NOW and the
// strategy cards with per-timeframe evidence (owner, 2026-10-22); the older market overview is folded. Each section holds panels that already exist; nothing here reads or trades on its
// own. The Markets tab shows it, and voice ("Open Alpaca chart", "CHE, show EMA trades", "Show
// strategy progress") opens it as a page on the section asked for. Silent on open.
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
import 'che_trading_intelligence.dart';
import 'che_trading_ledgers.dart';
import 'che_trading_research.dart';
import 'che_trading_side_by_side.dart';
import '../che_ui/che_hud.dart';
import '../che_ui/che_screen_awareness.dart';
import '../che_ui/che_ui_preferences.dart';
import '../che_ui/che_theme.dart';
import 'che_trading_hud.dart';

const _gold = CheColors.markets;
final _stroke = CheColors.stroke;

enum CheTradingSection { chart, setups, cheTrades, strategies, account, compare }

const kTradingSectionLabels = <CheTradingSection, String>{
  CheTradingSection.chart: 'CHART',
  CheTradingSection.setups: 'SETUPS',
  CheTradingSection.cheTrades: 'CHE TRADES',
  CheTradingSection.strategies: 'STRATEGIES',
  CheTradingSection.account: 'ACCOUNT',
  // MY ACCOUNT beside the CHE PAPER ACCOUNT, and the Live Order Preview (owner, 2026-10-23).
  CheTradingSection.compare: 'SIDE BY SIDE',
};

/// The section a Worker reply names ("chart", "strategies", ...); chart when unknown.
CheTradingSection cheTradingSectionNamed(String? name) => switch ((name ?? '').toLowerCase().replaceAll(RegExp(r'[^a-z]'), '')) {
      'chetrades' || 'trades' => CheTradingSection.cheTrades,
      'setups' || 'setup' || 'signals' || 'signal' => CheTradingSection.setups,
      'strategies' || 'strategy' => CheTradingSection.strategies,
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
    this.initialAccount = 'alpaca_paper',
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

  /// Technical diagnostics sit under one collapsed "Details" section (owner, 2026-10-21), so the screen stays short.
  Widget _details(Widget child) => Padding(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
        child: ExpansionTile(
          key: const Key('trading_details'),
          title: const Text('Details', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
          iconColor: Colors.white,
          collapsedIconColor: Colors.white70,
          initiallyExpanded: false,
          children: [child],
        ),
      );

  List<Widget> _sectionChildren() {
    final p = (baseUrl: widget.baseUrl, headers: widget.headers, onAsk: widget.onAsk, client: widget.client);
    switch (_section) {
      case CheTradingSection.chart:
        return [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
            child: Wrap(spacing: 12, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Semantics(header: true, child: const Text('LIVE MARKET', style: TextStyle(color: _gold, fontWeight: FontWeight.w800, fontSize: 13, letterSpacing: 1.1))),
              CheMarketToggle(market: _market, onChanged: _setMarket),
              if (_market == 'NQ')
                const Text('Live chart: MNQ (CHE\'s live futures feed). Research below uses NQ history.',
                    key: Key('nq_chart_note'), style: TextStyle(color: Colors.white, fontSize: 14)),
            ]),
          ),
          _pad(CheTradingChart(
            baseUrl: p.baseUrl,
            headers: p.headers,
            client: p.client,
            onSpeak: widget.onRead,
            controller: _chart,
            initialAccount: widget.initialAccount,
            initialSymbol: widget.initialSymbol,
            initialStrategy: widget.initialStrategy,
            height: widget.chartHeight,
            signalMarkers: _desk.markerFeed,
          )),
          CheTradingResearchStrip(key: const Key('research_strip'), client: _research, market: _market, onRead: widget.onRead),
          // The older overview (index chart, quotes, 3D scene) is folded so nothing heavy builds until asked for.
          if (widget.chartExtras.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
              child: ExpansionTile(
                key: const Key('market_overview'),
                title: const Text('Market overview', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
                iconColor: Colors.white,
                collapsedIconColor: Colors.white70,
                tilePadding: EdgeInsets.zero,
                children: widget.chartExtras,
              ),
            ),
        ];
      case CheTradingSection.setups:
        return [_pad(CheSetupBoard(desk: _desk, onRead: widget.onRead))];
      case CheTradingSection.cheTrades:
        return [
          _pad(CheLivePaperPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, onRead: widget.onRead, client: p.client)),
          _pad(CheFyeDraftCard(baseUrl: p.baseUrl, headers: p.headers, client: p.client)),
          _pad(CheTradingLedgersPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client)),
        ];
      case CheTradingSection.strategies:
        // Limits and the registry, the historical study, then each strategy's learning progress (#382), from the same panel CHE TRADES uses.
        return [
          _pad(CheTradingResearchDashboard(client: _research, market: _market, onRead: widget.onRead)),
          _pad(CheStrategyControlsPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client)),
          // Historical trading intelligence (owner, 2026-10-22): decades of history, out-of-sample ranking, paper signals.
          _pad(CheTradingIntelligencePanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, onRead: widget.onRead, client: p.client)),
          _pad(CheLivePaperPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, onRead: widget.onRead, client: p.client)),
        ];
      case CheTradingSection.account:
        return [
          _pad(CheAlpacaPaperPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client)),
          _details(CheTradingConnectionsPanel(baseUrl: p.baseUrl, headers: p.headers, onAsk: p.onAsk, client: p.client)),
          ...widget.accountExtras,
        ];
      case CheTradingSection.compare:
        return [_pad(CheSideBySideView(baseUrl: p.baseUrl, headers: p.headers, client: p.client, onRead: widget.onRead))];
    }
  }

  void _go(CheTradingSection s) {
    if (s == _section) return;
    HapticFeedback.selectionClick();
    setState(() => _section = s);
  }

  @override
  Widget build(BuildContext context) {
    final hud = cheHudActive;
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        ?widget.header,
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
          child: Row(children: [
            for (final e in kTradingSectionLabels.entries)
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 3),
                  child: Semantics(
                    button: true,
                    selected: e.key == _section,
                    label: '${e.value} section${e.key == _section ? ', open' : ''}',
                    excludeSemantics: true,
                    child: InkWell(
                      borderRadius: BorderRadius.circular(10),
                      onTap: () => _go(e.key),
                      child: Container(
                        height: 46,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: e.key == _section ? (hud ? CheHud.ice.withValues(alpha: 0.18) : _gold) : Colors.transparent,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: e.key == _section ? (hud ? CheHud.ice : _gold) : (hud ? CheHud.ice.withValues(alpha: 0.28) : _stroke)),
                          boxShadow: hud && e.key == _section ? [BoxShadow(color: CheHud.ice.withValues(alpha: 0.35), blurRadius: 12)] : null,
                        ),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 4),
                            child: Text(e.value,
                                style: hud
                                    ? CheHud.label.copyWith(fontSize: 12.5, color: e.key == _section ? CheHud.ice : CheHud.chromeMid)
                                    : TextStyle(color: e.key == _section ? Colors.black : Colors.white, fontWeight: FontWeight.w800, fontSize: 13, letterSpacing: 0.6)),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ]),
        ),
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
            initialAccount: account ?? (strategy != null ? 'futures_paper' : 'alpaca_paper'),
            initialSymbol: symbol ?? '',
            initialStrategy: strategy,
          ),
        ),
      );
}
