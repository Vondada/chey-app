// CHE's forward recorder for Rithmic market data (owner research-partner rule, 2026-10-23).
//
// CHE had no tick or bid/ask history of its own, only Yahoo and third-party bars. While the Rithmic feed runs on this
// iPhone, this records:
// - every real trade that entered the candle book, and every best bid/offer update, in day files on this phone,
//   capped at [maxBytes] in total; when the cap is reached the oldest day files go first, so the newest data is kept;
// - each CLOSED 1-minute candle (OHLCV, trade count, buy/sell aggressor volume, delta when flagged), queued and sent
//   to the Worker as source=rithmic, so CHE's own verified MNQ dataset grows over time.
// Only market data leaves the phone. Credentials never reach this file; a candle that was never closed (the feed
// paused or dropped) is never sent, and nothing is filled in across a gap.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../trading/che_market_feed.dart';
import 'rithmic_candles.dart';
import 'rithmic_live.dart';
import 'rithmic_wire.dart';

/// One closed 1-minute candle as the Worker stores it.
Map<String, dynamic> rithmicCandleJson(CheCandle c, {required String exchange}) => {
      't': c.start.toUtc().toIso8601String(),
      'symbol': c.symbol,
      'exchange': exchange,
      'o': c.open,
      'h': c.high,
      'l': c.low,
      'c': c.close,
      'v': c.volume,
      'trades': c.trades,
      'buy_volume': c.buyVolume,
      'sell_volume': c.sellVolume,
      'delta': c.delta,
      'source': 'rithmic',
    };

class CheRithmicRecorder {
  CheRithmicRecorder({
    CheRithmicLive? live,
    CheMarketFeed? feed,
    Future<Directory> Function()? directory,
    Future<SharedPreferences> Function()? preferences,
    http.Client? client,
    this.maxBytes = 50 * 1024 * 1024,
    this.flushEvery = const Duration(seconds: 2),
    this.syncEvery = const Duration(seconds: 60),
  })  : _live = live ?? CheRithmicLive.instance,
        _feed = feed ?? CheMarketFeed.instance,
        _directory = directory ?? _defaultDirectory,
        _preferences = preferences ?? SharedPreferences.getInstance,
        _http = client ?? http.Client();

  static final instance = CheRithmicRecorder();

  /// What is kept on the phone, for the Rithmic screen and "what do you record?".
  static const keptNote = 'CHE keeps the Rithmic trades and best bid/offer it received on this iPhone, up to 50 MB '
      '(the oldest days go first), and sends each closed 1-minute candle to the Worker. No login details are stored here.';

  static const _queueKey = 'che_rithmic_candle_queue';
  static const maxQueue = 4320; // three days of 1-minute candles waiting for the Worker

  final CheRithmicLive _live;
  final CheMarketFeed _feed;
  final Future<Directory> Function() _directory;
  final Future<SharedPreferences> Function() _preferences;
  final http.Client _http;
  final int maxBytes;
  final Duration flushEvery, syncEvery;

  String Function() _baseUrl = () => '';
  Map<String, String> Function() _headers = () => const {};
  StreamSubscription<RithmicLastTrade>? _trades;
  StreamSubscription<RithmicBestBidOffer>? _quotes;
  StreamSubscription<CheCandle>? _closed;
  Timer? _flushTimer, _syncTimer;
  final _pendingLines = <String, List<String>>{};
  bool _started = false, _syncing = false;

  /// Candles sent and acknowledged by the Worker in this run; the last sync answer.
  int sent = 0;
  String lastSync = '';

  static Future<Directory> _defaultDirectory() async {
    final base = await getApplicationSupportDirectory();
    return Directory('${base.path}/rithmic_recorder').create(recursive: true);
  }

  void configure({required String Function() baseUrl, required Map<String, String> Function() headers}) {
    _baseUrl = baseUrl;
    _headers = headers;
    // Nothing runs until a Rithmic session exists: no timers, no files, no network.
    _live.removeListener(_maybeStart);
    _live.addListener(_maybeStart);
    _maybeStart();
  }

  void _maybeStart() {
    if (_live.attached && !_started) start();
  }

  void start() {
    if (_started) return;
    _started = true;
    _trades = _live.acceptedTrades.listen(_onTrade);
    _quotes = _live.quotes.listen(_onQuote);
    _closed = _feed.candles(1).where((c) => c.closed).listen((c) => unawaited(_enqueue(c)));
    _flushTimer = Timer.periodic(flushEvery, (_) => unawaited(flush()));
    _syncTimer = Timer.periodic(syncEvery, (_) => unawaited(sync()));
  }

  String _day(DateTime t) => t.toUtc().toIso8601String().substring(0, 10);

  void _line(String file, String line) => (_pendingLines[file] ??= []).add(line);

  void _onTrade(RithmicLastTrade t) {
    final at = rithmicTradeTime(t);
    if (at == null || t.price == null) return;
    // micros since epoch, price, size, aggressor (1 buy, 2 sell, blank unknown)
    _line('${_live.symbol}-${_day(at)}-trades.csv', '${at.microsecondsSinceEpoch},${t.price},${t.size ?? ''},${t.aggressor ?? ''}');
  }

  void _onQuote(RithmicBestBidOffer q) {
    final s = q.ssboe;
    if (s == null || s <= 0) return;
    final at = DateTime.fromMillisecondsSinceEpoch(s * 1000, isUtc: true);
    _line('${_live.symbol}-${_day(at)}-bbo.csv', '${s * 1000000},${q.bidPrice ?? ''},${q.bidSize ?? ''},${q.askPrice ?? ''},${q.askSize ?? ''}');
  }

  /// Appends what arrived to the day files, then keeps the total under [maxBytes].
  Future<void> flush() async {
    if (_pendingLines.isEmpty) return;
    final batch = Map.of(_pendingLines);
    _pendingLines.clear();
    final dir = await _directory();
    for (final e in batch.entries) {
      await File('${dir.path}/${e.key}').writeAsString('${e.value.join('\n')}\n', mode: FileMode.append, flush: true);
    }
    await _enforceCap(dir);
  }

  Future<void> _enforceCap(Directory dir) async {
    final files = [
      for (final f in dir.listSync()) if (f is File && f.path.endsWith('.csv')) f,
    ]..sort((a, b) => _dayOf(a).compareTo(_dayOf(b)));
    var total = files.fold<int>(0, (n, f) => n + f.lengthSync());
    while (total > maxBytes && files.length > 1) {
      final oldest = files.removeAt(0);
      total -= oldest.lengthSync();
      oldest.deleteSync();
    }
  }

  static String _dayOf(File f) => RegExp(r'(\d{4}-\d{2}-\d{2})').firstMatch(f.uri.pathSegments.last)?.group(1) ?? '';

  /// What is on the phone now: file name to size in bytes.
  Future<Map<String, int>> stored() async {
    final dir = await _directory();
    return {for (final f in dir.listSync()) if (f is File) f.uri.pathSegments.last: f.lengthSync()};
  }

  Future<void> _enqueue(CheCandle c) async {
    final prefs = await _preferences();
    final queue = prefs.getStringList(_queueKey) ?? <String>[];
    queue.add(jsonEncode(rithmicCandleJson(c, exchange: _live.exchange)));
    // A queue that cannot reach the Worker for days keeps the newest candles.
    await prefs.setStringList(_queueKey, queue.length > maxQueue ? queue.sublist(queue.length - maxQueue) : queue);
  }

  Future<int> queued() async => ((await _preferences()).getStringList(_queueKey) ?? const []).length;

  /// Sends the queued closed candles. Only the ones the Worker accepted leave the queue.
  Future<void> sync() async {
    final base = _baseUrl();
    if (_syncing || base.isEmpty) return;
    _syncing = true;
    try {
      final prefs = await _preferences();
      final queue = prefs.getStringList(_queueKey) ?? <String>[];
      if (queue.isEmpty) return;
      final batch = queue.take(500).toList();
      final r = await _http
          .post(Uri.parse('$base/api/trading/rithmic/candles'), headers: {..._headers(), 'Content-Type': 'application/json'}, body: jsonEncode({'candles': [for (final c in batch) jsonDecode(c)]}))
          .timeout(const Duration(seconds: 20));
      final j = jsonDecode(r.body);
      if (r.statusCode != 200 || j is! Map || j['ok'] != true) {
        lastSync = 'The Worker did not take the candles (${r.statusCode}); they stay queued on this phone.';
        return;
      }
      // Accepted, duplicates and refused candles all leave the queue; refused ones are reported, never retried forever.
      final done = batch.toSet();
      final rest = (prefs.getStringList(_queueKey) ?? <String>[]).where((c) => !done.contains(c)).toList();
      await prefs.setStringList(_queueKey, rest);
      sent += (j['stored'] as num? ?? 0).toInt();
      lastSync = 'Sent ${j['stored'] ?? 0} closed 1-minute candles; ${j['duplicates'] ?? 0} already stored; ${j['refused'] ?? 0} refused.';
    } catch (e) {
      lastSync = 'Could not reach the Worker ($e); the candles stay queued on this phone.';
    } finally {
      _syncing = false;
    }
  }

  Future<void> stop() async {
    _flushTimer?.cancel();
    _syncTimer?.cancel();
    await _trades?.cancel();
    await _quotes?.cancel();
    await _closed?.cancel();
    await flush();
    _started = false;
  }
}
