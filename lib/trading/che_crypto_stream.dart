// Live BTC and ETH trades streamed to this phone from the exchanges' public WebSockets (owner, 2026-10-25).
//
// The phone connects straight to the exchange: no Worker CPU, no account, no key. Market data only; nothing here can
// place, change or cancel an order, and live trading stays off.
//
// Sources (checked 2026-10-25):
// - Coinbase Advanced Trade WebSocket, public market data: wss://advanced-trade-ws.coinbase.com. The `market_trades`
//   and `heartbeats` channels need no authentication. Subscribe with
//   {"type":"subscribe","product_ids":["BTC-USD"],"channel":"market_trades"}, one message per channel, within 5 seconds
//   of connecting. Trades arrive as events of type "snapshot" (recent trades, re-sent on every subscribe) or "update",
//   each trade {trade_id, product_id, price, size, side, time}, batched over about 250 ms. Heartbeats arrive every
//   second with a heartbeat_counter; Coinbase closes idle channels after 60 to 90 seconds without them.
//   https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels
//   https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview
//   https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/advanced-trade-asyncapi.json
//   (also Coinbase's own client, coinbase-advanced-py 1.8.4: WS_BASE_URL, MARKET_TRADES, HEARTBEATS and the subscribe
//   message shape above.)
// - Kraken WebSocket v2, public `trade` channel, the fallback: wss://ws.kraken.com/v2. Subscribe with
//   {"method":"subscribe","params":{"channel":"trade","symbol":["BTC/USD"],"snapshot":true}}. Updates carry
//   data: [{symbol, side, price, qty, ord_type, trade_id, timestamp (RFC 3339)}]; several trades may come in one
//   message. Once subscribed, Kraken sends {"channel":"heartbeat"} about once a second.
//   https://docs.kraken.com/api/docs/websocket-v2/trade
//   https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade.md
//   https://docs.kraken.com/websockets-v2
//
// Status, never stronger than the evidence:
// - LIVE: the connection spoke within [CheCryptoStream.liveWithin] AND the newest trade is within
//   [CheCryptoStream.tradeLiveWithin]. A heartbeat proves the socket, not the candles: heartbeats alone are never LIVE.
// - STALE: connected but silent beyond that, or connected with no recent trade; the label shows how long. Silent past
//   [CheCryptoStream.silentReconnect], the socket is closed and reopened.
// - DELAYED: not streaming; the chart shows the Worker's polled REST candles, labelled as such.
// - DISCONNECTED: not streaming and no REST candles either, with the reason.
// Nothing here speaks. The chart shows the label quietly; "Read chart" reads it only when the owner asks.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'che_crypto_candles.dart';

final kCoinbaseMarketWs = Uri.parse('wss://advanced-trade-ws.coinbase.com');
final kKrakenMarketWs = Uri.parse('wss://ws.kraken.com/v2');

enum CryptoVenue { coinbase, kraken }

extension CryptoVenueName on CryptoVenue {
  String get id => name;
  String get label => this == CryptoVenue.coinbase ? 'Coinbase' : 'Kraken';
}

/// The streamed product for a chart ticker: 'BTC-USD' or 'ETH-USD' for "coinbase:BTC-USD", "kraken:ETH-USD" and the
/// like; null for anything else (other coins and futures stay on the polled chart).
String? cryptoStreamProduct(String tickerId) {
  final m = RegExp(r'^(coinbase|kraken):(BTC|XBT|ETH)[-/]USD$', caseSensitive: false).firstMatch(tickerId.trim());
  if (m == null) return null;
  final base = m.group(2)!.toUpperCase();
  return '${base == 'XBT' ? 'BTC' : base}-USD';
}

/// The venue tried first for a ticker: Kraken for a Kraken pair, Coinbase otherwise.
CryptoVenue cryptoStreamVenue(String tickerId) => tickerId.toLowerCase().startsWith('kraken:') ? CryptoVenue.kraken : CryptoVenue.coinbase;

// ─── Socket ──────────────────────────────────────────────────────────────

/// One text WebSocket. Tests supply a fake.
abstract class CryptoSocket {
  Stream<dynamic> get messages;
  void send(String text);
  Future<void> close();
}

typedef CryptoSocketOpener = Future<CryptoSocket> Function(Uri uri, Duration timeout);

class _IoCryptoSocket implements CryptoSocket {
  _IoCryptoSocket(this._socket);
  final WebSocket _socket;
  @override
  Stream<dynamic> get messages => _socket;
  @override
  void send(String text) => _socket.add(text);
  @override
  Future<void> close() => _socket.close();
}

Future<CryptoSocket> openCryptoWebSocket(Uri uri, Duration timeout) async {
  final s = await WebSocket.connect(uri.toString()).timeout(timeout);
  s.pingInterval = const Duration(seconds: 20);
  return _IoCryptoSocket(s);
}

// ─── Wire formats ────────────────────────────────────────────────────────

/// The subscribe messages for [product] on [venue], in the order they are sent.
List<String> cryptoSubscribeMessages(CryptoVenue venue, String product) => switch (venue) {
      CryptoVenue.coinbase => [
          jsonEncode({'type': 'subscribe', 'product_ids': [product], 'channel': 'market_trades'}),
          jsonEncode({'type': 'subscribe', 'product_ids': [product], 'channel': 'heartbeats'}),
        ],
      CryptoVenue.kraken => [
          jsonEncode({
            'method': 'subscribe',
            'params': {'channel': 'trade', 'symbol': [product.replaceFirst('-', '/')], 'snapshot': true},
          }),
        ],
    };

/// What one exchange message said.
class CryptoMessage {
  const CryptoMessage({this.trades = const [], this.heartbeat = false, this.error});
  final List<CryptoTrade> trades;
  final bool heartbeat;

  /// The exchange reported an error (bad subscription, rate limit); the stream reconnects.
  final String? error;
  bool get isEmpty => trades.isEmpty && !heartbeat && error == null;
}

double? _d(Object? v) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}');

/// Parses one message from [venue]. Trades for other products, or without a trade id, price, size or exchange time,
/// are left out: never guessed.
CryptoMessage parseCryptoMessage(CryptoVenue venue, String product, Object? raw) {
  Object? j;
  try {
    j = raw is String ? jsonDecode(raw) : raw;
  } on FormatException {
    return const CryptoMessage();
  }
  if (j is! Map) return const CryptoMessage();
  final trades = <CryptoTrade>[];
  if (venue == CryptoVenue.coinbase) {
    if (j['type'] == 'error') return CryptoMessage(error: '${j['message'] ?? 'Coinbase reported an error'}');
    final channel = j['channel'];
    if (channel == 'heartbeats') return const CryptoMessage(heartbeat: true);
    if (channel != 'market_trades') return const CryptoMessage();
    for (final e in (j['events'] is List ? j['events'] as List : const [])) {
      if (e is! Map) continue;
      for (final t in (e['trades'] is List ? e['trades'] as List : const [])) {
        if (t is! Map || t['product_id'] != product) continue;
        final price = _d(t['price']), size = _d(t['size']);
        final at = DateTime.tryParse('${t['time'] ?? ''}');
        final id = '${t['trade_id'] ?? ''}';
        if (price == null || size == null || at == null || id.isEmpty) continue;
        trades.add(CryptoTrade(venue: 'coinbase', product: product, tradeId: id, price: price, size: size, time: at.toUtc()));
      }
    }
    // A trade batch also proves the connection is alive.
    return CryptoMessage(trades: trades, heartbeat: true);
  }
  final channel = j['channel'];
  if (j['method'] == 'subscribe' && j['success'] == false) return CryptoMessage(error: '${j['error'] ?? 'Kraken refused the subscription'}');
  if (channel == 'heartbeat') return const CryptoMessage(heartbeat: true);
  if (channel != 'trade') return const CryptoMessage();
  final symbol = product.replaceFirst('-', '/');
  for (final t in (j['data'] is List ? j['data'] as List : const [])) {
    if (t is! Map || t['symbol'] != symbol) continue;
    final price = _d(t['price']), size = _d(t['qty']);
    final at = DateTime.tryParse('${t['timestamp'] ?? ''}');
    final id = '${t['trade_id'] ?? ''}';
    if (price == null || size == null || at == null || id.isEmpty) continue;
    trades.add(CryptoTrade(venue: 'kraken', product: product, tradeId: id, price: price, size: size, time: at.toUtc()));
  }
  return CryptoMessage(trades: trades, heartbeat: true);
}

// ─── Status ──────────────────────────────────────────────────────────────

enum CryptoFeedState { live, stale, delayed, disconnected }

/// What the chart shows for the stream.
class CryptoFeedView {
  const CryptoFeedView(this.state, this.label, this.spoken);
  final CryptoFeedState state;

  /// The short visible line, e.g. "LIVE · Coinbase trades · last trade 2s ago".
  final String label;

  /// The same in words for VoiceOver and Read chart.
  final String spoken;

  String get word => state.name.toUpperCase();
}

String _ago(Duration d) {
  final s = d.inSeconds < 0 ? 0 : d.inSeconds;
  if (s < 120) return '${s}s';
  if (s < 7200) return '${s ~/ 60}m';
  return '${s ~/ 3600}h';
}

String _agoWords(Duration d) {
  final s = d.inSeconds < 0 ? 0 : d.inSeconds;
  if (s < 120) return '$s second${s == 1 ? '' : 's'}';
  if (s < 7200) return '${s ~/ 60} minutes';
  return '${s ~/ 3600} hours';
}

// ─── The stream ──────────────────────────────────────────────────────────

/// One product's live trades, with reconnects, failover and a status. Listen for changes (coalesced to at most one
/// per [notifyEvery]); read candles with [candles].
class CheCryptoStream extends ChangeNotifier {
  CheCryptoStream({
    required this.product,
    CryptoVenue firstVenue = CryptoVenue.coinbase,
    CryptoSocketOpener? open,
    DateTime Function()? now,
    math.Random? random,
    this.liveWithin = const Duration(seconds: 10),
    this.tradeLiveWithin = const Duration(seconds: 60),
    this.silentReconnect = const Duration(seconds: 30),
    this.connectTimeout = const Duration(seconds: 10),
    this.backoffBase = const Duration(seconds: 1),
    this.backoffCap = const Duration(seconds: 30),
    this.failoverAfter = 3,
    this.notifyEvery = const Duration(milliseconds: 250),
  })  : _venue = firstVenue,
        _open = open ?? openCryptoWebSocket,
        _now = now ?? DateTime.now,
        _random = random ?? math.Random();

  final String product;
  final CryptoSocketOpener _open;
  final DateTime Function() _now;
  final math.Random _random;

  /// LIVE needs a message (trade or heartbeat) within this...
  final Duration liveWithin;

  /// ...and a trade, by its exchange time, within this. BTC and ETH trade every few seconds on both venues, so a
  /// minute without one means the trade channel is not delivering, whatever the heartbeats say.
  final Duration tradeLiveWithin;

  /// Connected but silent this long: the socket is closed and reopened.
  final Duration silentReconnect;
  final Duration connectTimeout;

  /// Reconnect delay: [backoffBase] doubled per consecutive failure, capped at [backoffCap], with jitter (a random
  /// point between half the delay and the full delay) so many phones never reconnect in step.
  final Duration backoffBase, backoffCap;

  /// Consecutive failures on one venue before switching to the other.
  final int failoverAfter;
  final Duration notifyEvery;

  CryptoVenue _venue;
  CryptoSocket? _socket;
  StreamSubscription<dynamic>? _sub;
  Timer? _retry, _watchdog, _notify;
  bool _running = false, _connected = false, _disposed = false;
  int _failures = 0, _connectSeq = 0;
  DateTime? _lastMessageAt, _connectedAt, _retryAt;
  String _reason = 'not started';
  final _books = <CryptoVenue, CryptoCandleAggregator>{};

  /// How many connections were opened, and how many venue switches happened (for tests and diagnostics).
  int connects = 0, failovers = 0;

  CryptoVenue get venue => _venue;
  bool get running => _running;
  bool get connected => _connected;
  int get failures => _failures;
  String get reason => _reason;
  DateTime? get lastMessageAt => _lastMessageAt;
  DateTime? get retryAt => _retryAt;

  /// The active venue's candles. Venues are never mixed: after a failover the chart shows the new venue's candles over
  /// the REST history.
  CryptoCandleAggregator get book => _books.putIfAbsent(_venue, CryptoCandleAggregator.new);
  CryptoCandleAggregator bookFor(CryptoVenue v) => _books.putIfAbsent(v, CryptoCandleAggregator.new);
  List<CryptoCandle> candles(int minutes) => book.candles(minutes);
  CryptoTrade? get lastTrade => book.last;

  /// The reconnect delay after [failures] consecutive failures (before jitter).
  Duration backoffFor(int failures) {
    final ms = backoffBase.inMilliseconds * math.pow(2, math.max(0, failures - 1));
    return Duration(milliseconds: math.min(backoffCap.inMilliseconds, ms.round()));
  }

  void start() {
    if (_running || _disposed) return;
    _running = true;
    _failures = 0;
    _watchdog = Timer.periodic(const Duration(seconds: 1), (_) => _check());
    unawaited(_connect());
  }

  Future<void> stop() async {
    _running = false;
    _retry?.cancel();
    _watchdog?.cancel();
    _retry = _watchdog = null;
    _retryAt = null;
    _reason = 'stopped';
    _drop();
    _changed(now: true);
  }

  Future<void> _connect() async {
    if (!_running) return;
    final seq = ++_connectSeq;
    _retryAt = null;
    _reason = 'connecting to ${_venue.label}';
    _changed(now: true);
    final uri = _venue == CryptoVenue.coinbase ? kCoinbaseMarketWs : kKrakenMarketWs;
    try {
      connects++;
      final s = await _open(uri, connectTimeout);
      if (!_running || seq != _connectSeq) {
        unawaited(s.close());
        return;
      }
      _socket = s;
      _connected = true;
      _connectedAt = _now();
      _sub = s.messages.listen(_onMessage, onError: (Object e) => _fail('${_venue.label} stream error: $e'), onDone: () => _fail('${_venue.label} closed the stream'));
      // Coinbase closes a connection that has not subscribed within 5 seconds: subscribe at once.
      for (final m in cryptoSubscribeMessages(_venue, product)) {
        s.send(m);
      }
      _reason = 'subscribed to ${_venue.label} $product trades';
      _changed(now: true);
    } catch (e) {
      if (seq != _connectSeq) return;
      _fail('could not reach ${_venue.label}: ${e is TimeoutException ? 'timed out' : e}');
    }
  }

  void _onMessage(dynamic raw) {
    final m = parseCryptoMessage(_venue, product, raw);
    if (m.error != null) {
      _fail('${_venue.label} said: ${m.error}');
      return;
    }
    if (m.isEmpty) return;
    _lastMessageAt = _now();
    // The first proof of life on this connection ends the failure streak.
    _failures = 0;
    final b = book;
    for (final t in m.trades) {
      b.add(t);
    }
    _changed();
  }

  /// Closes the socket and forgets it. Never waits on the exchange: a dead connection cannot hold up a reconnect.
  void _drop() {
    _connected = false;
    _connectSeq++;
    final sub = _sub, s = _socket;
    _sub = null;
    _socket = null;
    if (sub != null) unawaited(sub.cancel().catchError((Object _) {}));
    if (s != null) unawaited(Future.sync(s.close).catchError((Object _) {}));
  }

  void _fail(String why) {
    if (!_running) return;
    _drop();
    _failures++;
    _reason = why;
    if (_failures >= failoverAfter) {
      _venue = _venue == CryptoVenue.coinbase ? CryptoVenue.kraken : CryptoVenue.coinbase;
      _failures = 0;
      failovers++;
      _reason = '$why; switching to ${_venue.label}';
    }
    final base = backoffFor(math.max(1, _failures));
    final jittered = Duration(milliseconds: (base.inMilliseconds / 2 + _random.nextDouble() * base.inMilliseconds / 2).round());
    _retryAt = _now().add(jittered);
    _retry?.cancel();
    _retry = Timer(jittered, () => unawaited(_connect()));
    _changed(now: true);
  }

  String? _shown;

  void _check() {
    if (_running && _connected) {
      final since = _now().difference(_lastMessageAt ?? _connectedAt ?? _now());
      if (since >= silentReconnect) {
        _fail('${_venue.label} sent nothing for ${_agoWords(since)}');
        return;
      }
    }
    // Only when the visible line would change (state, age, retry countdown). Quiet: no speech, no announcement.
    final label = describe(restAvailable: true).label;
    if (label != _shown) {
      _shown = label;
      _changed();
    }
  }

  void _changed({bool now = false}) {
    if (_disposed) return;
    if (now) {
      _notify?.cancel();
      _notify = null;
      notifyListeners();
      return;
    }
    _notify ??= Timer(notifyEvery, () {
      _notify = null;
      if (!_disposed) notifyListeners();
    });
  }

  /// The status for the chart. [restAvailable]: the chart has the Worker's polled candles to fall back on.
  CryptoFeedView describe({required bool restAvailable, String restProvider = 'Worker REST'}) {
    final now = _now();
    final coin = product.split('-').first;
    final trade = lastTrade;
    final tradeAge = trade == null ? '' : ' · last trade ${_ago(now.difference(trade.time))} ago';
    final tradeWords = trade == null ? 'No trade received yet.' : 'Last trade ${trade.price} at ${_agoWords(now.difference(trade.time))} ago.';
    if (_running && _connected && _lastMessageAt != null) {
      final silent = now.difference(_lastMessageAt!);
      if (silent <= liveWithin) {
        final sinceTrade = trade == null ? null : now.difference(trade.time);
        if (sinceTrade != null && sinceTrade <= tradeLiveWithin) {
          return CryptoFeedView(CryptoFeedState.live, 'LIVE · ${_venue.label} trades$tradeAge',
              '$coin live stream: LIVE from ${_venue.label} trades. $tradeWords');
        }
        // Heartbeats only: the socket is up, but the candles are not being fed.
        return sinceTrade == null
            ? CryptoFeedView(CryptoFeedState.stale, 'STALE · ${_venue.label} connected, no trade yet',
                '$coin live stream: STALE. ${_venue.label} is connected, but no trade has arrived yet.')
            : CryptoFeedView(CryptoFeedState.stale, 'STALE · ${_venue.label} connected, no trade for ${_ago(sinceTrade)}',
                '$coin live stream: STALE. ${_venue.label} is connected, but no trade has arrived for ${_agoWords(sinceTrade)}. $tradeWords');
      }
      return CryptoFeedView(CryptoFeedState.stale, 'STALE · ${_venue.label} silent ${_ago(silent)}$tradeAge',
          '$coin live stream: STALE. ${_venue.label} is connected but has sent nothing for ${_agoWords(silent)}. $tradeWords');
    }
    final waiting = _running && _connected ? 'subscribed, waiting for the first message' : _reason;
    final retry = _retryAt == null ? '' : ', retrying in ${_ago(_retryAt!.difference(now))}';
    final retryWords = _retryAt == null ? '' : ' Retrying in ${_agoWords(_retryAt!.difference(now))}.';
    if (restAvailable) {
      return CryptoFeedView(CryptoFeedState.delayed, 'DELAYED · $restProvider candles · stream: $waiting$retry',
          '$coin live stream is not streaming ($waiting). The chart shows $restProvider polled candles, which are delayed.$retryWords');
    }
    return CryptoFeedView(CryptoFeedState.disconnected, 'DISCONNECTED · $waiting$retry', '$coin live stream: DISCONNECTED, $waiting. No candles are available.$retryWords');
  }

  @override
  void dispose() {
    _disposed = true;
    _running = false;
    _retry?.cancel();
    _watchdog?.cancel();
    _notify?.cancel();
    _drop();
    super.dispose();
  }
}

// ─── Shared streams ──────────────────────────────────────────────────────

/// One stream per product for the whole app, counted by who is watching: the compact and expanded charts share it,
/// and the last chart to leave closes the socket.
class CheCryptoStreamHub {
  CheCryptoStreamHub({CheCryptoStream Function(String product, CryptoVenue first)? create})
      : _create = create ?? ((p, v) => CheCryptoStream(product: p, firstVenue: v));

  static final instance = CheCryptoStreamHub();

  /// The hub a chart uses when it was given none: [instance] in the app, null under `flutter test` (FLUTTER_TEST),
  /// where there is no network and a widget test must never open a real exchange socket. Tests pass their own hub.
  static CheCryptoStreamHub? get appWide => _underTest ? null : instance;
  static final bool _underTest = !kIsWeb && Platform.environment.containsKey('FLUTTER_TEST');

  final CheCryptoStream Function(String product, CryptoVenue first) _create;
  final _streams = <String, CheCryptoStream>{};
  final _refs = <String, int>{};

  CheCryptoStream acquire(String product, {CryptoVenue first = CryptoVenue.coinbase}) {
    _refs[product] = (_refs[product] ?? 0) + 1;
    return _streams.putIfAbsent(product, () => _create(product, first)..start());
  }

  void release(CheCryptoStream stream) {
    final p = stream.product;
    final left = (_refs[p] ?? 1) - 1;
    if (left > 0) {
      _refs[p] = left;
      return;
    }
    _refs.remove(p);
    _streams.remove(p)?.dispose();
  }

  int watchers(String product) => _refs[product] ?? 0;

  /// The running stream for [product] if a chart has it open, without opening one (the status card reads it).
  CheCryptoStream? peek(String product) => _streams[product];
}
