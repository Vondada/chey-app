// One connection state for every live chart in CHE (owner, 2026-10-23, "Live MCP Trading"; reworded 2026-10-25,
// Trading Room v3): Home and the Trading Room read the same words from the same rules, so a delayed chart can never look
// live on one screen and not the other. Five words, the shared model ([CheFeedKind]):
//
// - LIVE: fresh trades are arriving right now (Rithmic on this phone, or the exchange's public crypto stream).
// - DELAYED: a delayed source the owner chose on purpose, with its delay. Never called live.
// - WAITING: a session is up but no trade has arrived yet, and the words say why ("Signed in to Rithmic — no market data
//   received yet. CME is closed until Sunday 6:00 PM ET."), or the market is closed. Signing in is never "connected"
//   as if candles were flowing.
// - STALE: the newest data is older than the threshold while the market is open; the age is shown.
// - DISCONNECTED: no session, with the actual error (Rithmic not connected, login refused, connection dropped).
//
// Authentication, the market-data subscription, the first trade received and freshness are separate facts on the
// snapshot (che_market_feed.dart); the Trading Room lists them one per line (che_trading_connections.dart).
// Times are New York time (ET), the CME's own clock. The look comes from the shared chrome status components
// (lib/che_ui/che_chrome_status.dart) through [CheLiveTone].
import 'package:flutter/material.dart';

import '../che_ui/che_chrome_status.dart';
import '../che_ui/che_clock.dart';
import 'che_account_stats.dart' show cheNewYork;
import 'che_crypto_stream.dart' show CryptoFeedState, CryptoFeedView;
import '../che_ui/che_hud.dart';
import 'che_market_feed.dart';

enum CheLiveState { connecting, live, quiet, reconnecting, disconnected, delayed }

/// The five words every live chart uses (Home and the Trading Room).
enum CheFeedKind { live, delayed, waiting, stale, disconnected }

/// "10:42 AM ET".
String cheEtClock(DateTime t) {
  final ny = cheNewYork(t);
  final h = ny.hour % 12 == 0 ? 12 : ny.hour % 12;
  return '$h:${ny.minute.toString().padLeft(2, '0')} ${ny.hour < 12 ? 'AM' : 'PM'} ET';
}

/// When CME futures next open, in words: "Sunday 6:00 PM ET" over the weekend, "6:00 PM ET" in the daily break.
String cheCmeReopens(DateTime now) {
  final next = cheNextSessionChange('MNQ futures', now);
  if (next == null) return 'its next session';
  final ny = cheNewYork(next);
  final days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  final sameDay = cheNewYork(now).day == ny.day;
  return '${sameDay ? '' : '${days[ny.weekday - 1]} '}${cheEtClock(next)}';
}

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

  /// The shared five-word model.
  CheFeedKind get kind => switch (word) {
        'LIVE' => CheFeedKind.live,
        'DELAYED' => CheFeedKind.delayed,
        'STALE' => CheFeedKind.stale,
        'DISCONNECTED' => CheFeedKind.disconnected,
        _ => CheFeedKind.waiting,
      };

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
    final lastTrade = last == null ? '' : ' · last trade ${cheEtClock(last)}';
    final open = cheFuturesOpen(now);
    final hours = open ? '' : ' CME is closed until ${cheCmeReopens(now)}.';
    final subscription = s.subscriptionConfirmed == false ? ' Market-data subscription not confirmed yet.' : '';
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
        return make(CheLiveState.live, 'LIVE', 'Rithmic trades arriving$lastTrade');
      case CheFeedConnection.waiting:
        return hasCandles
            ? make(CheLiveState.reconnecting, 'WAITING', 'Signed in to Rithmic again — no new trade yet; earlier candles are not current.$subscription$hours')
            : make(CheLiveState.connecting, 'WAITING', 'Signed in to Rithmic — no market data received yet.$subscription$hours');
      case CheFeedConnection.quiet:
        final age = last == null ? null : now.difference(last);
        final mins = age == null ? 0 : age.inMinutes;
        return open
            ? make(CheLiveState.quiet, 'STALE', 'No trade for $mins min$lastTrade')
            : make(CheLiveState.quiet, 'WAITING', 'Market closed$lastTrade.$hours');
      case CheFeedConnection.off:
        return make(CheLiveState.disconnected, 'DISCONNECTED', '${s.statusLabel.startsWith('Rithmic not connected: ') ? s.statusLabel : 'Rithmic not connected'}$lastTrade');
      case CheFeedConnection.disconnected:
        return make(CheLiveState.disconnected, 'DISCONNECTED', '${_reason(s.statusLabel, 'Connection dropped')}$lastTrade');
      case CheFeedConnection.failed:
        return make(CheLiveState.disconnected, 'DISCONNECTED', '${_reason(s.statusLabel, 'Login refused')}$lastTrade');
    }
  }

  /// The public crypto stream (che_crypto_stream.dart) in the same five words. No account is involved.
  factory CheLiveStatus.fromCrypto(CryptoFeedView v, {required String symbol, double? lastPrice, DateTime? lastTradeAt}) {
    final (state, word) = switch (v.state) {
      CryptoFeedState.live => (CheLiveState.live, 'LIVE'),
      CryptoFeedState.stale => (CheLiveState.quiet, 'STALE'),
      CryptoFeedState.delayed => (CheLiveState.delayed, 'DELAYED'),
      CryptoFeedState.disconnected => (CheLiveState.disconnected, 'DISCONNECTED'),
    };
    final i = v.label.indexOf(' · ');
    return CheLiveStatus(
      state: state,
      word: word,
      detail: '${i < 0 ? v.label : v.label.substring(i + 3)} · public data, no account',
      source: 'Coinbase public',
      symbol: symbol,
      lastPrice: lastPrice,
      lastMarketAt: lastTradeAt,
      lastUpdate: lastTradeAt,
    );
  }

  /// Delayed data the owner chose on purpose. [provider] is the Worker's feed provider (for example "Yahoo MNQ=F").
  factory CheLiveStatus.delayed({required String symbol, String provider = '', double? lastPrice, DateTime? lastBarAt}) =>
      CheLiveStatus(
        state: CheLiveState.delayed,
        word: 'DELAYED',
        detail: lastBarAt == null ? 'Not live: delayed data you chose' : 'Not live · last bar ${cheEtClock(lastBarAt)}',
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
          Text(s.detail, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheHud.label.copyWith(fontSize: 9.5, letterSpacing: 0.8, color: CheHud.chromeMid)),
        ],
      ]),
    );
  }
}
