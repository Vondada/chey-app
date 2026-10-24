// The one live Rithmic market-data session on this phone, shared by the Rithmic screen (which connects it) and the
// Trading Room chart (which draws its candles). Read-only prices: no orders, no balances, no fills. Credentials
// never reach this object; it only receives the already-connected feed.
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'rithmic_candles.dart';
import 'rithmic_client.dart';
import 'rithmic_wire.dart';

enum RithmicLiveStatus { off, connected, waiting, quiet, disconnected, loginFailed }

/// A stretch with no live data: CHE was in the background, or the connection was down. Candles are never filled in
/// across it, with Yahoo or anything else.
class RithmicFeedGap {
  RithmicFeedGap(this.from, this.reason, [this.to]);
  final DateTime from;
  DateTime? to;
  final String reason;

  @override
  String toString() => 'No live data from ${from.toIso8601String()} to ${to?.toIso8601String() ?? 'now'}: $reason';
}

class CheRithmicLive extends ChangeNotifier {
  CheRithmicLive({DateTime Function()? clock}) : _clock = clock ?? DateTime.now;

  static final instance = CheRithmicLive();

  final DateTime Function() _clock;
  final book = RithmicCandleBook();
  RithmicMarketFeed? _feed;
  StreamSubscription<RithmicLastTrade>? _sub;
  StreamSubscription<RithmicBestBidOffer>? _quoteSub;
  final _accepted = StreamController<RithmicLastTrade>.broadcast();
  final _quotes = StreamController<RithmicBestBidOffer>.broadcast();

  /// Every real trade that entered the candle book (the forward recorder stores these).
  Stream<RithmicLastTrade> get acceptedTrades => _accepted.stream;

  /// Best bid/offer updates for this contract, as Rithmic sends them.
  Stream<RithmicBestBidOffer> get quotes => _quotes.stream;
  String symbol = '', exchange = '';
  String detail = '';
  bool _attached = false, _dropped = false, _loginFailed = false;

  /// When this phone last received a trade from Rithmic (device clock), and when that trade happened (Rithmic time).
  DateTime? lastReceivedAt;
  DateTime? get lastTradeAt => book.lastTradeAt;

  /// The Rithmic socket lives in this app on the iPhone (the password never leaves the phone, so the Worker cannot hold
  /// the session). CHE declares only the audio and fetch background modes (tool/bootstrap.sh), and iOS suspends an
  /// app shortly after it leaves the screen unless audio is playing, so the feed stops then.
  static const backgroundNote = 'Live feed pauses when CHE is in the background.';

  /// Stretches without live data, newest last (at most [maxGaps]).
  final gaps = <RithmicFeedGap>[];
  static const maxGaps = 200;
  RithmicFeedGap? _open;
  bool _background = false;

  /// True while CHE is off screen.
  bool get inBackground => _background;

  void _openGap(String reason) {
    if (_open != null) return;
    _open = RithmicFeedGap(_clock().toUtc(), reason);
    gaps.add(_open!);
    if (gaps.length > maxGaps) gaps.removeAt(0);
  }

  void _closeGap() {
    _open?.to = _clock().toUtc();
    _open = null;
  }

  /// Called from the app's lifecycle (lib/main.dart). Leaving the screen opens a gap while a session exists; coming
  /// back closes it. If iOS dropped the socket meanwhile, the connection reads as disconnected.
  void appLifecycle({required bool foreground}) {
    if (!foreground && !_background) {
      _background = true;
      if (_attached) _openGap('CHE was in the background; iOS pauses the live feed');
    } else if (foreground && _background) {
      _background = false;
      if (_attached) _closeGap();
    }
    notifyListeners();
  }

  /// No trade for this long while connected reads "no trades": the market may be closed or paused.
  static const quietAfter = Duration(seconds: 90);

  bool get attached => _attached;

  RithmicLiveStatus get status {
    if (_loginFailed) return RithmicLiveStatus.loginFailed;
    if (_dropped) return RithmicLiveStatus.disconnected;
    if (!_attached) return RithmicLiveStatus.off;
    final got = lastReceivedAt;
    if (got == null) return RithmicLiveStatus.waiting;
    return _clock().difference(got) > quietAfter ? RithmicLiveStatus.quiet : RithmicLiveStatus.connected;
  }

  /// True only while trades are actually arriving: the one state the chart may call live.
  bool get isLive => status == RithmicLiveStatus.connected;

  /// The header text for the status, never stronger than the evidence.
  String get statusLabel => switch (status) {
        RithmicLiveStatus.off => 'Rithmic not connected${detail.isEmpty ? '' : ': $detail'}',
        RithmicLiveStatus.connected => 'Rithmic live — $symbol · connected',
        RithmicLiveStatus.waiting => 'Rithmic $symbol · connected, waiting for the first trade',
        RithmicLiveStatus.quiet => 'Rithmic $symbol · connected, no trades for ${_clock().difference(lastReceivedAt!).inMinutes} min (market may be closed)',
        RithmicLiveStatus.disconnected => 'Rithmic $symbol · disconnected${detail.isEmpty ? '' : ': $detail'}',
        RithmicLiveStatus.loginFailed => 'Rithmic did not connect${detail.isEmpty ? '' : ': $detail'}',
      };

  /// Takes over a connected feed. A different contract starts a fresh candle book.
  void attach(RithmicMarketFeed feed, {required String symbol, required String exchange}) {
    unawaited(_sub?.cancel());
    if (!identical(feed, _feed) && _feed != null) unawaited(_feed!.close());
    if (symbol != this.symbol) book.clear();
    // A new session is not live until its own first trade arrives (the candles from before stay).
    lastReceivedAt = null;
    _closeGap();
    _feed = feed;
    this.symbol = symbol;
    this.exchange = exchange;
    _attached = true;
    _dropped = false;
    _loginFailed = false;
    detail = '';
    _sub = feed.trades.listen(_onTrade);
    unawaited(_quoteSub?.cancel());
    _quoteSub = feed.quotes.listen((q) {
      if (q.symbol.isEmpty || q.symbol == this.symbol) _quotes.add(q);
    });
    if (feed is RithmicClient) {
      unawaited(feed.done.then((_) {
        if (identical(_feed, feed) && _attached) _drop('the connection closed');
      }));
    }
    notifyListeners();
  }

  void _onTrade(RithmicLastTrade t) {
    if (t.symbol.isNotEmpty && symbol.isNotEmpty && t.symbol != symbol) return;
    if (!book.addTrade(t)) return;
    lastReceivedAt = _clock();
    _accepted.add(t);
    notifyListeners();
  }

  void _drop(String why) {
    _closeGap();
    _openGap('Rithmic $why');
    unawaited(_sub?.cancel());
    _sub = null;
    unawaited(_quoteSub?.cancel());
    _quoteSub = null;
    _feed = null;
    _attached = false;
    _dropped = true;
    detail = why;
    notifyListeners();
  }

  /// The owner pressed Disconnect: the feed closes and the chart stops calling anything live.
  Future<void> disconnect() async {
    final feed = _feed;
    _drop('disconnected on this phone');
    await feed?.close();
  }

  /// Why no session was started on its own (no saved login, the automatic reconnect is off), so "not connected" says
  /// why. Only while nothing is attached and no drop or refusal is being reported.
  void notConnected(String why) {
    if (_attached || _dropped || _loginFailed || detail == why) return;
    detail = why;
    notifyListeners();
  }

  /// A refused login. While an earlier connection is still streaming, that connection's state stands.
  void loginFailed(String why) {
    if (_attached) return;
    _loginFailed = true;
    detail = why;
    notifyListeners();
  }

  /// Rebuilds of the status line (quiet after 90 s) need a tick even when no trade arrives.
  @visibleForTesting
  void poke() => notifyListeners();
}
