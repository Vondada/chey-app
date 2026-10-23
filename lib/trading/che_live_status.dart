// One connection state for every live chart in CHE (owner, 2026-10-23, "Live MCP Trading"): Home and the Trading Room
// read the same words from the same rules, so a delayed chart can never look live on one screen and not the other.
//
// The live source is the Rithmic feed on this phone (lib/trading/che_market_feed.dart). There is no MCP market-data
// source in CHE; the owner's "live MCP" chart is this feed, and it is labelled for what it is: Rithmic.
//
// - LIVE only while Rithmic trades are actually arriving ([CheMarketSnapshot.isLive]).
// - CONNECTING before the first trade of a session; RECONNECTING when a session restarts over candles already on
//   screen (they stay, marked not current).
// - MARKET CLOSED / NO TRADES when connected but quiet: never "live", never a spinner.
// - DISCONNECTED with the reason (Rithmic not connected, login refused, connection dropped).
// - DELAYED only when the owner chose delayed data on purpose. It is never called live.
//
// The look (colour, pulse) goes through [CheLiveTone], a thin adapter over the HUD palette that the shared chrome status
// components can replace without touching the states.
import 'package:flutter/material.dart';

import '../che_ui/che_clock.dart';
import '../che_ui/che_hud.dart';
import 'che_market_feed.dart';

enum CheLiveState { connecting, live, quiet, reconnecting, disconnected, delayed }

class CheLiveStatus {
  const CheLiveStatus({
    required this.state,
    required this.word,
    required this.detail,
    required this.source,
    required this.symbol,
    this.lastPrice,
    this.lastMarketAt,
    this.lastUpdate,
  });

  final CheLiveState state;

  /// The state in one upper-case word or two: LIVE, CONNECTING, RECONNECTING, MARKET CLOSED, NO TRADES, DISCONNECTED,
  /// DELAYED. Colour never carries the meaning alone.
  final String word;

  /// Why, in a short sentence: "Rithmic not connected", "Market closed · last update 4:59 PM CDT".
  final String detail;

  /// "Rithmic" or "Delayed (Yahoo MNQ=F)".
  final String source;
  final String symbol;
  final double? lastPrice;

  /// The newest trade's time (Rithmic's clock), and when this phone last received one.
  final DateTime? lastMarketAt, lastUpdate;

  bool get isLive => state == CheLiveState.live;

  /// True when the candles on screen are the current market. Everything else is drawn dimmed and says so.
  bool get isCurrent => state == CheLiveState.live;

  /// The one line VoiceOver reads.
  String get spoken => [
        symbol.isEmpty ? 'Live chart' : '$symbol chart',
        word.toLowerCase(),
        if (detail.isNotEmpty) detail,
        'Source $source',
      ].join('. ');

  /// The live feed's state. [hasCandles] says whether candles from an earlier session are on screen (a restart over them
  /// is a reconnect). [now] decides whether the futures market is open.
  factory CheLiveStatus.fromFeed(CheMarketSnapshot s, {required bool hasCandles, required DateTime now}) {
    final symbol = s.symbol;
    final last = s.lastUpdate ?? s.lastTradeAt;
    final since = last == null ? '' : ' · last update ${CheChicagoTime.at(last).text}';
    CheLiveStatus make(CheLiveState state, String word, String detail) => CheLiveStatus(
          state: state,
          word: word,
          detail: detail,
          source: 'Rithmic',
          symbol: symbol,
          lastPrice: s.lastPrice,
          lastMarketAt: s.lastTradeAt,
          lastUpdate: s.lastUpdate,
        );
    switch (s.connection) {
      case CheFeedConnection.connected:
        return make(CheLiveState.live, 'LIVE', 'Rithmic trades arriving');
      case CheFeedConnection.waiting:
        return hasCandles
            ? make(CheLiveState.reconnecting, 'RECONNECTING', 'Waiting for the first trade$since')
            : make(CheLiveState.connecting, 'CONNECTING', 'Connected, waiting for the first trade');
      case CheFeedConnection.quiet:
        return cheFuturesOpen(now)
            ? make(CheLiveState.quiet, 'NO TRADES', 'Connected, no trades lately$since')
            : make(CheLiveState.quiet, 'MARKET CLOSED', 'Market closed$since');
      case CheFeedConnection.off:
        return make(CheLiveState.disconnected, 'DISCONNECTED', 'Rithmic not connected$since');
      case CheFeedConnection.disconnected:
        return make(CheLiveState.disconnected, 'DISCONNECTED', '${_reason(s.statusLabel, 'Connection dropped')}$since');
      case CheFeedConnection.failed:
        return make(CheLiveState.disconnected, 'DISCONNECTED', '${_reason(s.statusLabel, 'Login refused')}$since');
    }
  }

  /// Delayed data the owner chose on purpose. [provider] is the Worker's feed provider (for example "Yahoo MNQ=F").
  factory CheLiveStatus.delayed({required String symbol, String provider = '', double? lastPrice, DateTime? lastBarAt}) =>
      CheLiveStatus(
        state: CheLiveState.delayed,
        word: 'DELAYED',
        detail: lastBarAt == null ? 'Not live: delayed data you chose' : 'Not live · last bar ${CheChicagoTime.at(lastBarAt).text}',
        source: provider.isEmpty ? 'Delayed' : 'Delayed ($provider)',
        symbol: symbol,
        lastPrice: lastPrice,
        lastMarketAt: lastBarAt,
      );

  static String _reason(String label, String fallback) {
    final i = label.indexOf(': ');
    return i < 0 ? fallback : label.substring(i + 2);
  }
}

/// The colour and motion for a state. A thin adapter over the HUD palette, swappable for the shared chrome status
/// components: green-mint live, ice connecting, amber reconnecting or delayed, silver quiet, red disconnected.
class CheLiveTone {
  CheLiveTone._();

  static const amber = Color(0xFFFFC46B);
  static const red = Color(0xFFFF7A90);

  static Color color(CheLiveState s) => switch (s) {
        CheLiveState.live => CheHud.mint,
        CheLiveState.connecting => CheHud.ice,
        CheLiveState.reconnecting => amber,
        CheLiveState.delayed => amber,
        CheLiveState.quiet => CheHud.chromeMid,
        CheLiveState.disconnected => red,
      };

  /// Only states that are really changing pulse: live data arriving, or a connection in progress.
  static bool pulses(CheLiveState s) => s == CheLiveState.live || s == CheLiveState.connecting || s == CheLiveState.reconnecting;
}

/// The state as a dot and its word, with the detail beneath. Pulses gently while live or connecting; still with Reduce
/// Motion. Silent: it never speaks.
class CheLiveStatusBadge extends StatefulWidget {
  const CheLiveStatusBadge({super.key, required this.status, this.showDetail = true});

  final CheLiveStatus status;
  final bool showDetail;

  @override
  State<CheLiveStatusBadge> createState() => _CheLiveStatusBadgeState();
}

class _CheLiveStatusBadgeState extends State<CheLiveStatusBadge> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(CheLiveStatusBadge old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (!still && CheLiveTone.pulses(widget.status.state)) {
      if (!_pulse.isAnimating) _pulse.repeat(reverse: true);
    } else {
      _pulse.stop();
      _pulse.value = 1;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.status;
    final color = CheLiveTone.color(s.state);
    return Semantics(
      container: true,
      liveRegion: false,
      label: '${s.word.toLowerCase()}. ${s.detail}',
      excludeSemantics: true,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Row(mainAxisSize: MainAxisSize.min, children: [
          RepaintBoundary(
            child: AnimatedBuilder(
              animation: _pulse,
              builder: (_, _) {
                final t = 0.45 + 0.55 * _pulse.value;
                return Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: t),
                    shape: BoxShape.circle,
                    boxShadow: [BoxShadow(color: color.withValues(alpha: 0.6 * t), blurRadius: 8)],
                  ),
                );
              },
            ),
          ),
          const SizedBox(width: 7),
          Flexible(
            child: Text(s.word, key: const ValueKey('che-live-word'), maxLines: 1, overflow: TextOverflow.ellipsis, style: CheHud.label.copyWith(fontSize: 11, letterSpacing: 1.8, color: color)),
          ),
        ]),
        if (widget.showDetail && s.detail.isNotEmpty) ...[
          const SizedBox(height: 3),
          Text(s.detail, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheHud.label.copyWith(fontSize: 9.5, letterSpacing: 0.8, color: CheHud.chromeMid)),
        ],
      ]),
    );
  }
}
