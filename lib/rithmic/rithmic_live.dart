// The one live Rithmic market-data session on this phone, shared by the Rithmic screen (which connects it) and the
// Trading Room chart (which draws its candles). Read-only prices: no orders, no balances, no fills. Credentials
// never reach this object; it only receives the already-connected feed.
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'rithmic_candles.dart';
import 'rithmic_client.dart';
import 'rithmic_wire.dart';

enum RithmicLiveStatus { off, connected, waiting, quiet, disconnected, loginFailed }

class CheRithmicLive extends ChangeNotifier {
  CheRithmicLive({DateTime Function()? clock}) : _clock = clock ?? DateTime.now;

  static final instance = CheRithmicLive();

  final DateTime Function() _clock;
  final book = RithmicCandleBook();
  RithmicMarketFeed? _feed;
  StreamSubscription<RithmicLastTrade>? _sub;
  String symbol = '', exchange = '';
  String detail = '';
  bool _attached = false, _dropped = false, _loginFailed = false;

  /// When this phone last received a trade from Rithmic (device clock), and when that trade happened (Rithmic time).
  DateTime? lastReceivedAt;
  DateTime? get lastTradeAt => book.lastTradeAt;

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
        RithmicLiveStatus.off => 'Rithmic not connected',
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
    if (symbol != this.symbol) {
      book.clear();
      lastReceivedAt = null;
    }
    _feed = feed;
    this.symbol = symbol;
    this.exchange = exchange;
    _attached = true;
    _dropped = false;
    _loginFailed = false;
    detail = '';
    _sub = feed.trades.listen(_onTrade);
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
    notifyListeners();
  }

  void _drop(String why) {
    unawaited(_sub?.cancel());
    _sub = null;
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
