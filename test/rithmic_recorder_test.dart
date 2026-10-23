// Forward recorder (owner research-partner rule, 2026-10-23): real Rithmic trades and bid/offer kept on the phone
// under a cap, closed 1-minute candles sent to the Worker as source=rithmic, market data only.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_live.dart';
import 'package:chey/rithmic/rithmic_recorder.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:chey/trading/che_market_feed.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Feed implements RithmicMarketFeed {
  final trades0 = StreamController<RithmicLastTrade>.broadcast();
  final quotes0 = StreamController<RithmicBestBidOffer>.broadcast();
  @override
  Stream<RithmicLastTrade> get trades => trades0.stream;
  @override
  Stream<RithmicBestBidOffer> get quotes => quotes0.stream;
  @override
  bool get subscriptionConfirmed => true;
  @override
  Future<void> connect({required String user, required String password, required String systemName, required String appName, required String appVersion, required String symbol, required String exchange}) async {}
  @override
  Future<void> close() async {}
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('trades and bid/offer go to day files; a closed candle is queued, sent once, and only market data leaves', () async {
    final dir = await Directory.systemTemp.createTemp('che_rithmic_rec');
    addTearDown(() => dir.delete(recursive: true));
    final live = CheRithmicLive();
    final feed = CheMarketFeed(live: live, closeGrace: Duration.zero);
    final posts = <Map<String, dynamic>>[];
    var accept = false;
    final client = MockClient((r) async {
      posts.add(jsonDecode(r.body) as Map<String, dynamic>);
      expect(r.url.path, '/api/trading/rithmic/candles');
      return accept ? http.Response(jsonEncode({'ok': true, 'stored': 1, 'duplicates': 0, 'refused': 0}), 200) : http.Response('{"ok":false}', 503);
    });
    final rec = CheRithmicRecorder(live: live, feed: feed, directory: () async => dir, client: client, flushEvery: const Duration(hours: 1), syncEvery: const Duration(hours: 1));
    rec.configure(baseUrl: () => 'https://che.example', headers: () => const {'Authorization': 'Bearer device-token'});
    final rithmic = _Feed();
    live.attach(rithmic, symbol: 'MNQZ6', exchange: 'CME');

    final old = DateTime.now().toUtc().subtract(const Duration(minutes: 3));
    rithmic.trades0.add(RithmicLastTrade(symbol: 'MNQZ6', exchange: 'CME', price: 21000.25, size: 2, ssboe: old.millisecondsSinceEpoch ~/ 1000, aggressor: 1));
    rithmic.quotes0.add(RithmicBestBidOffer(symbol: 'MNQZ6', exchange: 'CME', bidPrice: 21000, bidSize: 4, askPrice: 21000.25, askSize: 3, ssboe: old.millisecondsSinceEpoch ~/ 1000));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await rec.flush();
    final files = await rec.stored();
    final day = old.toIso8601String().substring(0, 10);
    expect(files.keys, containsAll(['MNQZ6-$day-trades.csv', 'MNQZ6-$day-bbo.csv']));
    final line = File('${dir.path}/MNQZ6-$day-trades.csv').readAsStringSync().trim();
    expect(line.split(','), [isNotEmpty, '21000.25', '2', '1']);

    expect(await rec.queued(), 1, reason: 'the minute is over, so its candle closed and was queued');
    await rec.sync();
    expect(await rec.queued(), 1, reason: 'a refused sync keeps the candle on the phone');
    expect(rec.lastSync, contains('stay queued'));
    accept = true;
    await rec.sync();
    expect(await rec.queued(), 0);
    final sent = posts.last['candles'] as List;
    expect(sent.single['source'], 'rithmic');
    expect(sent.single['buy_volume'], 2);
    expect(sent.single['delta'], 2);
    final body = jsonEncode(posts);
    expect(body, isNot(contains('password')));
    expect(body, isNot(contains('device-token')), reason: 'the token rides in the header, never in the data');
    await rec.stop();
    await feed.dispose();
  });

  test('the phone store is capped: the oldest day files go first', () async {
    final dir = await Directory.systemTemp.createTemp('che_rithmic_cap');
    addTearDown(() => dir.delete(recursive: true));
    File('${dir.path}/MNQZ6-2026-10-20-trades.csv').writeAsStringSync('x' * 600);
    File('${dir.path}/MNQZ6-2026-10-21-trades.csv').writeAsStringSync('x' * 600);
    final live = CheRithmicLive();
    final rec = CheRithmicRecorder(live: live, feed: CheMarketFeed(live: live), directory: () async => dir, maxBytes: 1000, flushEvery: const Duration(hours: 1), syncEvery: const Duration(hours: 1));
    rec.configure(baseUrl: () => '', headers: () => const {});
    final rithmic = _Feed();
    live.attach(rithmic, symbol: 'MNQZ6', exchange: 'CME');
    rithmic.trades0.add(RithmicLastTrade(symbol: 'MNQZ6', exchange: 'CME', price: 21000, size: 1, ssboe: DateTime.utc(2026, 10, 22, 14).millisecondsSinceEpoch ~/ 1000));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await rec.flush();
    expect((await rec.stored()).keys.toSet(), {'MNQZ6-2026-10-21-trades.csv', 'MNQZ6-2026-10-22-trades.csv'});
    await rec.stop();
  });

  test('nothing starts without a Rithmic session', () async {
    final live = CheRithmicLive();
    var touched = false;
    final rec = CheRithmicRecorder(live: live, feed: CheMarketFeed(live: live), directory: () async {
      touched = true;
      return Directory.systemTemp;
    });
    rec.configure(baseUrl: () => 'https://che.example', headers: () => const {});
    await rec.flush();
    expect(touched, isFalse);
    expect(CheRithmicRecorder.keptNote, contains('50 MB'));
  });
}
