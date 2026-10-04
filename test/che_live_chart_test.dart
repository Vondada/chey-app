import 'package:chey/browser/che_embedded_app_shell.dart';
import 'package:chey/rooms/che_live_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  setUp(() {
    CheLiveChart.symbol.value = cheLiveSymbols.first;
    CheLiveChart.interval.value = '5';
  });

  group('symbols', () {
    test('names, aliases and tickers resolve; nonsense does not', () {
      expect(cheResolveLiveSymbol('the E-mini')!.tv, 'CME_MINI:ES1!');
      expect(cheResolveLiveSymbol('Nasdaq futures')!.id, 'NQ');
      expect(cheResolveLiveSymbol('gold')!.tv, 'COMEX:GC1!');
      expect(cheResolveLiveSymbol('Tesla stock')!.id, 'TSLA');
      expect(cheResolveLiveSymbol('AMD')!.tv, 'AMD');
      expect(cheResolveLiveSymbol(r'$pltr')!.id, 'PLTR');
      expect(cheResolveLiveSymbol('my photos'), isNull);
      expect(cheResolveLiveSymbol('photos', allowTicker: false), isNull);
    });
  });

  group('voice', () {
    test('switch symbol and timeframe by voice', () {
      final a = CheChartCommand.parse('Che, show me the E-mini')!;
      expect(a.symbol!.id, 'ES');
      final b = CheChartCommand.parse('switch to Tesla on the 1 minute')!;
      expect(b.symbol!.id, 'TSLA');
      expect(b.interval, '1');
      expect(CheChartCommand.parse('put gold on the chart')!.symbol!.id, 'GC');
      expect(CheChartCommand.parse('chart AMD')!.symbol!.id, 'AMD');
      expect(CheChartCommand.parse('show me 15 minute candles')!.interval, '15');
      expect(CheChartCommand.parse('switch to the daily chart')!.interval, 'D');
    });

    test('read the price', () {
      expect(CheChartCommand.parse('read the price')!.readPrice, isTrue);
      expect(CheChartCommand.parse("what's the price of bitcoin")!.symbol!.id, 'BTC');
      expect(CheChartCommand.parse('what is the price of AMD')!.symbol!.id, 'AMD', reason: 'tickers resolve');
      expect(CheChartCommand.parse('what is the price of my house'), isNull, reason: 'never reads a different symbol instead');
    });

    test('never hijacks other commands', () {
      for (final other in ['show me my photos', 'show me the brain', 'open YouTube', 'what time is it', 'show me', 'open trading']) {
        expect(CheChartCommand.parse(other), isNull, reason: other);
      }
    });

    test('spoken description is honest about delayed futures', () {
      expect(CheLiveChart.describe(cheLiveSymbols.first, '5'), contains('about 10 minutes delayed'));
      expect(CheLiveChart.describe(cheResolveLiveSymbol('Tesla')!, '1'), 'Showing Tesla, 1-minute candles, live.');
    });
  });

  group('price readout', () {
    test('reads a real price and never invents one', () async {
      final ok = MockClient((r) async => http.Response('{"price":6712.25,"change_pct":0.18,"as_of":"2026-10-03 22:59:00"}', 200));
      expect(await CheLiveChart.readPrice('https://che', {}, cheLiveSymbols.first, client: ok),
          'E-mini S&P 500 futures: 6712.25, up 0.18 percent since the open. Delayed quote as of 2026-10-03 22:59:00.');
      final none = MockClient((r) async => http.Response('{"error":"No price available right now."}', 200));
      expect(await CheLiveChart.readPrice('https://che', {}, cheLiveSymbols.first, client: none), startsWith('I could not get a price'));
      final down = MockClient((r) async => throw Exception('offline'));
      expect(await CheLiveChart.readPrice('https://che', {}, cheLiveSymbols.first, client: down), startsWith('I could not reach'));
    });
  });

  testWidgets('panel switches symbol and timeframe, reloads the chart page, and announces it', (tester) async {
    final urls = <String>[];
    final spoken = <String>[];
    CheEmbeddedAppAnnouncer.speak = spoken.add;
    addTearDown(() => CheEmbeddedAppAnnouncer.speak = null);
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: CheLiveChartPanel(
            baseUrl: () => 'https://che.example',
            headers: () => const {},
            height: 300,
            chartBuilder: (context, url) { urls.add(url); return Text(url); },
          ),
        ),
      ),
    ));
    expect(urls.last, 'https://che.example/markets/chart?symbol=CME_MINI%3AES1%21&interval=5');
    await tester.tap(find.text('NQ'));
    await tester.pump();
    expect(urls.last, contains('NQ1'));
    expect(spoken, isEmpty, reason: 'nothing is announced until the chart reports it loaded');
    await tester.tap(find.text('1m'));
    await tester.pump();
    expect(urls.last, endsWith('interval=1'));
    await tester.enterText(find.byType(TextField), 'tsla');
    await tester.testTextInput.receiveAction(TextInputAction.go);
    await tester.pump();
    expect(urls.last, contains('NASDAQ%3ATSLA'));
    expect(find.bySemanticsLabel(RegExp(r'^Live candlestick chart of Tesla, 1-minute candles')), findsOneWidget);
    expect(find.bySemanticsLabel('Read the price of Tesla aloud'), findsOneWidget);
    handle.dispose();
  });
}
