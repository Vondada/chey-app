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
// The look comes from the shared chrome status components (lib/che_ui/che_chrome_status.dart) through [CheLiveTone].
import 'package:flutter/material.dart';

import '../che_ui/che_chrome_status.dart';
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

/// The chrome status tone and activity for a state (lib/che_ui/che_chrome_status.dart, #488): success-green live,
/// active-cyan connecting, amber reconnecting or delayed, silver quiet, red disconnected. Only states that are really
/// changing animate: live data arriving, or a connection in progress.
class CheLiveTone {
  CheLiveTone._();

  static CheStatusTone tone(CheLiveState s) => switch (s) {
        CheLiveState.live => CheStatusTone.success,
        CheLiveState.connecting => CheStatusTone.active,
        CheLiveState.reconnecting => CheStatusTone.warning,
        CheLiveState.delayed => CheStatusTone.warning,
        CheLiveState.quiet => CheStatusTone.neutral,
        CheLiveState.disconnected => CheStatusTone.failure,
      };

  static CheActivity activity(CheLiveState s) => switch (s) {
        CheLiveState.live || CheLiveState.connecting || CheLiveState.reconnecting => CheActivity.running,
        CheLiveState.disconnected => CheActivity.disconnected,
        CheLiveState.quiet => CheActivity.paused,
        CheLiveState.delayed => CheActivity.idle,
      };

  static Color color(CheLiveState s) => CheStatusPalette.of(tone(s)).base;

  static bool pulses(CheLiveState s) => activity(s) == CheActivity.running;
}

/// The state as a chrome status pill with its word, and the detail beneath. Silent: it never speaks.
class CheLiveStatusBadge extends StatelessWidget {
  const CheLiveStatusBadge({super.key, required this.status, this.showDetail = true});

  final CheLiveStatus status;
  final bool showDetail;

  @override
  Widget build(BuildContext context) {
    final s = status;
    return Semantics(
      container: true,
      label: '${s.word.toLowerCase()}. ${s.detail}',
      excludeSemantics: true,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        CheStatusPill(key: const ValueKey('che-live-word'), label: s.word, tone: CheLiveTone.tone(s.state), activity: CheLiveTone.activity(s.state), compact: true),
        if (showDetail && s.detail.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(s.detail, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheHud.label.copyWith(fontSize: 9.5, letterSpacing: 0.8, color: CheHud.chromeMid)),
        ],
      ]),
    );
  }
}
