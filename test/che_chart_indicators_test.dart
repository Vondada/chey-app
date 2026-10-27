// Chart indicators and the universal ticker selector (owner, 2026-10-24).
import 'dart:convert';

import 'package:chey/rooms/che_chart_indicators.dart';
import 'package:chey/rooms/che_live_chart.dart';
import 'package:chey/rooms/che_ticker_selector.dart';
import 'package:chey/rooms/che_trading_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

List<CheIndicatorBar> _bars(List<double> closes, {DateTime? start, Duration step = const Duration(minutes: 5), double v = 10}) {
  final t0 = start ?? DateTime.utc(2026, 10, 24, 13);
  return [for (var i = 0; i < closes.length; i++) CheIndicatorBar(t0.add(step * i), closes[i], closes[i] + 1, closes[i] - 1, closes[i], v)];
}

void main() {
  test('EMA is seeded with the simple average and null until it has enough bars', () {
    final e = ema([1, 2, 3, 4, 5], 3);
    expect(e.take(2), [null, null]);
    expect(e[2], 2);
    expect(e[3], closeTo(3, 1e-9));
    expect(e[4], closeTo(4, 1e-9));
    expect(ema([1, 2], 200).every((v) => v == null), isTrue, reason: 'never a guess on too little history');
  });

  test('RSI: 100 on only gains, 0 on only losses, null before 15 closes', () {
    expect(rsi([for (var i = 0; i < 20; i++) i.toDouble()]).last, 100);
    expect(rsi([for (var i = 20; i > 0; i--) i.toDouble()]).last, 0);
    expect(rsi([for (var i = 0; i < 14; i++) i.toDouble()]).every((v) => v == null), isTrue);
  });

  test('Bollinger bands on a flat series collapse onto the average', () {
    final b = bollinger(List.filled(25, 10.0));
    expect(b.mid.last, 10);
    expect(b.upper.last, 10);
    expect(b.lower.last, 10);
    expect(b.mid[18], isNull);
  });

  test('VWAP resets each session; session high/low and the 30-minute opening range use the latest session', () {
    final day1 = _bars([100, 102], start: DateTime.utc(2026, 10, 23, 15));
    final day2 = _bars([200, 210, 205, 220, 230, 240, 250, 260], start: DateTime.utc(2026, 10, 24, 0));
    final bars = [...day1, ...day2];
    final w = vwap(bars);
    expect(w[1], closeTo(101, 1e-9));
    expect(w[2], closeTo(200, 1e-9), reason: 'a new UTC day starts a new crypto session');
    final s = sessionHighLow(bars)!;
    expect(s.high, 261);
    expect(s.low, 199);
    final r = openingRange(bars)!;
    expect(r.high, 241, reason: 'first six 5-minute bars of the session');
    expect(r.low, 199);
    expect(openingRange(_bars([1, 2, 3], step: const Duration(hours: 1))), isNull, reason: 'hourly bars cannot show a 30-minute range');
  });

  test('the opening range is anchored to the session start and needs the whole opening interval loaded', () {
    final closes = <double>[200, 210, 205, 220, 230, 240, 250, 260];
    final midSession = _bars(closes, start: DateTime.utc(2026, 10, 24, 0, 10));
    expect(openingRange(midSession), isNull, reason: 'history that starts at 00:10 does not hold the 00:00 open');
    final gap = _bars(closes, start: DateTime.utc(2026, 10, 24))..removeAt(2);
    expect(openingRange(gap), isNull, reason: 'a missing bar inside the first 30 minutes leaves the range incomplete');
    final forming = _bars([200, 210, 205], start: DateTime.utc(2026, 10, 24));
    expect(openingRange(forming), isNull, reason: 'the range is not finished at 00:15');
    // Futures: the session opens at 22:00 UTC the evening before.
    final futures = _bars(closes, start: DateTime.utc(2026, 10, 23, 22));
    expect(sessionStartOf(futures.last.t, futures: true), DateTime.utc(2026, 10, 23, 22));
    expect(openingRange(futures, futures: true), (high: 241.0, low: 199.0));
    expect(openingRange(_bars(closes, start: DateTime.utc(2026, 10, 23, 22, 30)), futures: true), isNull, reason: 'futures history from 22:30 misses the open');
  });

  test('the spoken summary names each switched-on indicator and says they are not signals', () {
    final text = indicatorSummary(_bars([for (var i = 0; i < 30; i++) 100.0 + i]), {'ema9', 'ema200', 'rsi'});
    expect(text, startsWith('Indicators (drawing aids, not signals):'));
    expect(text, contains('EMA 9 '));
    expect(text, contains('EMA 200 needs more bars'));
    expect(text, contains('RSI 100.0'));
  });

  test('ticker labels', () {
    expect(tickerLabel('futures:ES'), 'ES');
    expect(tickerLabel('coinbase:BTC-USD'), 'BTC');
    expect(tickerLabel('coinbase:BTC-USDT'), 'BTC-USDT');
    expect(tickerLabel('kraken:KAS-USD'), 'KAS');
  });

  testWidgets('quick chips switch markets; search lists the universe with filters, favorites and recents', (tester) async {
    SharedPreferences.setMockInitialValues({});
    CheTickerPrefs.instance.reset();
    await CheTickerPrefs.instance.load();
    final asked = <Uri>[];
    final client = MockClient((r) async {
      asked.add(r.url);
      final all = [
        {'id': 'futures:GC', 'symbol': 'GC', 'name': 'Gold', 'category': 'futures', 'exchange': 'COMEX', 'contract': 'GCZ6', 'market': 'COMEX GC continuous front month (research chart)'},
        {'id': 'coinbase:BTC-USDT', 'symbol': 'BTC-USDT', 'name': 'Bitcoin', 'category': 'crypto', 'exchange': 'Coinbase Exchange', 'market': 'Coinbase Exchange spot BTC/USDT'},
      ];
      final cat = r.url.queryParameters['category'];
      return http.Response(jsonEncode({'ok': true, 'results': [for (final x in all) if (cat == null || x['category'] == cat) x], 'problems': ['Kraken pairs: HTTP 451']}), 200);
    });
    final chosen = <String>[];
    var selected = 'futures:MNQ';
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: StatefulBuilder(
          builder: (context, set) => CheTickerSelector(
            selected: selected,
            baseUrl: () => 'https://che.example',
            headers: () => const {},
            client: client,
            onSelect: (id) {
              chosen.add(id);
              set(() => selected = id);
            },
          ),
        ),
      ),
    ));
    expect(find.bySemanticsLabel('MNQ market, selected'), findsOneWidget);
    await tester.tap(find.byKey(const Key('market_ES')));
    await tester.pump();
    expect(chosen.last, 'futures:ES');
    expect(find.bySemanticsLabel('ES market, selected'), findsOneWidget);

    await tester.tap(find.byKey(const Key('ticker_search')));
    await tester.pumpAndSettle();
    expect(find.text('GC · Gold'), findsOneWidget);
    expect(find.textContaining('front month GCZ6'), findsOneWidget);
    expect(find.text('Kraken pairs: HTTP 451'), findsOneWidget, reason: 'discovery problems are shown, never hidden');
    await tester.tap(find.byKey(const Key('ticker_category_crypto')));
    await tester.pumpAndSettle();
    expect(asked.last.queryParameters['category'], 'crypto');
    expect(find.text('GC · Gold'), findsNothing);
    await tester.tap(find.byTooltip('Add BTC-USDT to favorites'));
    await tester.pumpAndSettle();
    expect(CheTickerPrefs.instance.favorites, ['coinbase:BTC-USDT']);
    expect(find.byKey(const Key('ticker_row_favorite_coinbase:BTC-USDT')), findsOneWidget, reason: 'favorites are listed first');
    await tester.tap(find.byKey(const Key('ticker_row_coinbase:BTC-USDT')));
    await tester.pumpAndSettle();
    expect(chosen.last, 'coinbase:BTC-USDT');
    expect(find.byKey(const Key('market_BTC-USDT')), findsOneWidget, reason: 'a favorite gets its own quick chip');
    await CheTickerPrefs.instance.choose('coinbase:BTC-USDT');
    final saved = await SharedPreferences.getInstance();
    expect(saved.getString('trading_ticker_last'), 'coinbase:BTC-USDT');
    expect(saved.getStringList('trading_ticker_recents'), ['coinbase:BTC-USDT']);
  });

  testWidgets('the Markets chart sends the saved ticker, shows the exchange market, and saves indicator toggles', (tester) async {
    SharedPreferences.setMockInitialValues({'trading_ticker_last': 'coinbase:ETH-USD', 'trading_ticker_tf': '15m'});
    CheTickerPrefs.instance.reset();
    final asked = <Uri>[];
    final t0 = DateTime.utc(2026, 10, 24, 10);
    final client = MockClient((r) async {
      asked.add(r.url);
      return http.Response(jsonEncode({
        'ok': true, 'account': 'market', 'timeframe': '15m', 'timeframes': ['1m', '5m', '15m', '1h', '4h', '1d'], 'symbol': 'ETH-USD',
        'ticker': {'id': 'coinbase:ETH-USD', 'symbol': 'ETH-USD', 'category': 'crypto', 'exchange': 'Coinbase Exchange', 'market': 'Coinbase Exchange spot ETH/USD'},
        'bars': [for (var i = 0; i < 40; i++) {'t': t0.add(Duration(minutes: 15 * i)).toIso8601String(), 'o': 3000 + i, 'h': 3002 + i, 'l': 2999 + i, 'c': 3001 + i, 'v': 5}],
        'feed': {'provider': 'Coinbase Exchange', 'status': 'LIVE', 'age_s': 20, 'stale': false},
        'markers': [], 'entries_allowed': false, 'entries_blocked_reason': 'Research chart on Coinbase Exchange public data.',
      }), 200);
    });
    final key = GlobalKey<CheTradingChartState>();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheTradingChart(key: key, baseUrl: () => 'https://che.example', headers: () => const {}, client: client, initialAccount: 'market'))),
    ));
    await tester.pumpAndSettle();
    expect(asked.first.queryParameters, containsPair('symbol', 'coinbase:ETH-USD'));
    expect(asked.first.queryParameters, containsPair('tf', '15m'));
    expect(find.text('Coinbase Exchange spot ETH/USD'), findsOneWidget);
    expect(find.textContaining('Coinbase Exchange: LIVE'), findsOneWidget);
    expect(key.currentState!.symbolLabel, 'ETH');
    await tester.ensureVisible(find.byKey(const Key('indicator_ema9')));
    await tester.tap(find.byKey(const Key('indicator_ema9')));
    await tester.ensureVisible(find.byKey(const Key('indicator_rsi')));
    await tester.tap(find.byKey(const Key('indicator_rsi')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('chart_rsi')), findsOneWidget);
    expect(key.currentState!.summary, contains('Indicators (drawing aids, not signals): EMA 9 '));
    expect((await SharedPreferences.getInstance()).getStringList('trading_chart_indicators'), ['ema9', 'rsi']);
    expect(CheLiveChart.indicators.value, {'ema9', 'rsi'}, reason: 'taps are shared with voice');
    // "CHE, turn off RSI and turn on VWAP" from chat: the open chart follows and saves it.
    CheLiveChart.indicators.value = CheChartCommand.parse('turn off RSI and turn on VWAP')!.applyIndicators(CheLiveChart.indicators.value);
    await tester.pumpAndSettle();
    expect(key.currentState!.indicators, {'ema9', 'vwap'});
    expect(find.byKey(const Key('chart_rsi')), findsNothing);
    expect((await SharedPreferences.getInstance()).getStringList('trading_chart_indicators'), ['ema9', 'vwap']);
    await tester.pumpWidget(const SizedBox());
    CheLiveChart.indicators.value = <String>{};
  });
}
