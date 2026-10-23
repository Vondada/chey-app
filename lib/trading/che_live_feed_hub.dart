// Shared live-chart channels (owner, 2026-10-23): Home and the Trading Room read the same 1- and 5-minute live candles
// through one subscription per timeframe, counted by who is watching.
//
// - The first screen that watches a timeframe opens its channel (one candle subscription and one status
//   subscription); the last one to leave closes it. Nothing keeps running for a screen that is gone.
// - A Rithmic reconnect does not add subscriptions: the feed's streams outlive the Rithmic session.
// - Updates are coalesced (at most one rebuild per [throttle]) so live ticks cannot flood the UI.
// - Read only: no orders.
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'che_market_feed.dart';

/// The candles and the latest snapshot for one timeframe.
class CheLiveChannel extends ChangeNotifier {
  CheLiveChannel._(this._hub, this.minutes);

  final CheLiveFeedHub _hub;
  final int minutes;

  /// Oldest first; the last one may be forming. At most [CheLiveFeedHub.maxCandles].
  final List<CheCandle> candles = [];
  late CheMarketSnapshot snapshot;

  int _refs = 0;
  StreamSubscription<CheCandle>? _candleSub;
  StreamSubscription<CheMarketSnapshot>? _snapSub;
  Timer? _pending;
  bool _dirty = false;

  void _open() {
    final feed = _hub.feed;
    candles
      ..clear()
      ..addAll(_tail(feed.history(minutes)));
    snapshot = feed.current;
    _candleSub = feed.candles(minutes).listen(_onCandle);
    _snapSub = feed.snapshots.listen((s) {
      snapshot = s;
      _changed();
    });
  }

  void _onCandle(CheCandle c) {
    if (candles.isNotEmpty && candles.last.start == c.start) {
      candles[candles.length - 1] = c;
    } else if (candles.isEmpty || c.start.isAfter(candles.last.start)) {
      candles.add(c);
      if (candles.length > CheLiveFeedHub.maxCandles) candles.removeAt(0);
    } else {
      // A late closed candle for an earlier period replaces its own slot; never duplicated.
      final i = candles.indexWhere((x) => x.start == c.start);
      if (i >= 0) candles[i] = c;
    }
    _changed();
  }

  void _changed() {
    final wait = _hub.throttle;
    if (wait == Duration.zero) {
      notifyListeners();
      return;
    }
    _dirty = true;
    _pending ??= Timer(wait, () {
      _pending = null;
      if (_dirty) {
        _dirty = false;
        notifyListeners();
      }
    });
  }

  Future<void> _close() async {
    _pending?.cancel();
    _pending = null;
    await _candleSub?.cancel();
    await _snapSub?.cancel();
    _candleSub = null;
    _snapSub = null;
  }

  /// The feed's status right now (the quiet state depends on the clock, not on a new trade).
  CheMarketSnapshot get current => _hub.feed.current;

  static List<CheCandle> _tail(List<CheCandle> all) =>
      all.length <= CheLiveFeedHub.maxCandles ? all : all.sublist(all.length - CheLiveFeedHub.maxCandles);
}

/// A screen's hold on a channel. Release it in dispose.
class CheLiveLease {
  CheLiveLease._(this.channel, this._hub);

  final CheLiveChannel channel;
  final CheLiveFeedHub _hub;
  bool _released = false;

  void release() {
    if (_released) return;
    _released = true;
    _hub._release(channel);
  }
}

class CheLiveFeedHub {
  CheLiveFeedHub({CheMarketFeed? feed, this.throttle = const Duration(milliseconds: 250)}) : _feed = feed; // ignore: prefer_initializing_formals

  /// The app-wide hub over the app-wide feed.
  static final instance = CheLiveFeedHub();

  static const maxCandles = 300;

  final CheMarketFeed? _feed;
  CheMarketFeed get feed => _feed ?? CheMarketFeed.instance;
  final Duration throttle;

  final _channels = <int, CheLiveChannel>{};

  /// Open channels and how many screens hold each: for tests and diagnostics.
  Map<int, int> get activeRefs => {for (final e in _channels.entries) e.key: e.value._refs};

  /// Live subscriptions held on the feed (two per open channel: candles and status).
  int get subscriptionCount => _channels.values.fold(0, (n, c) => n + (c._candleSub == null ? 0 : 1) + (c._snapSub == null ? 0 : 1));

  CheLiveLease acquire(int minutes) {
    if (!kCheFeedMinutes.contains(minutes)) throw ArgumentError.value(minutes, 'minutes', 'Live charts use ${kCheFeedMinutes.join(' or ')} minutes');
    final ch = _channels.putIfAbsent(minutes, () => CheLiveChannel._(this, minutes).._open());
    ch._refs++;
    return CheLiveLease._(ch, this);
  }

  void _release(CheLiveChannel ch) {
    ch._refs--;
    if (ch._refs > 0) return;
    _channels.remove(ch.minutes);
    unawaited(ch._close());
  }
}
