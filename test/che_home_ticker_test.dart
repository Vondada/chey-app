// Home's live chart switches tickers in place (owner, 2026-10-25): MNQ and NQ on the Rithmic feed, BTC and ETH on the
// public exchange stream, one status model for both; "connected" is never shown without data.
import 'dart:async';
import 'dart:convert';

import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_live.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:chey/trading/che_crypto_stream.dart';
import 'package:chey/trading/che_live_chart_card.dart';
import 'package:chey/trading/che_live_feed_hub.dart';
import 'package:chey/trading/che_market_feed.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Feed implements RithmicMarketFeed {
  final _trades = StreamController<RithmicLastTrade>.broadcast();
  @override
  Stream<RithmicLastTrade> get trades => _trades.stream;
  @override
  Stream<RithmicBestBidOffer> get quotes => const Stream.empty();
  @override
  bool get subscriptionConfirmed => false;
  @override
  Future<void> connect({required String user, required String password, required String systemName, required String appName, required String appVersion, required String symbol, required String exchange}) async {}
  @override
  Future<void> close() async {}
}

class _Socket implements CryptoSocket {
  final _in = StreamController<dynamic>();
  @override
  Stream<dynamic> get messages => _in.stream;
  @override
  void send(String text) {}
  @override
  Future<void> close() async {
    if (!_in.isClosed) unawaited(_in.close());
  }

  void trade(String product, double price, DateTime at) => _in.add(jsonEncode({
        'channel': 'market_trades',
        'events': [
          {
            'type': 'update',
            'trades': [
              {'trade_id': '${at.microsecondsSinceEpoch}', 'product_id': product, 'price': '$price', 'size': '0.01', 'side': 'BUY', 'time': at.toIso8601String()},
            ],
          },
        ],
      }));
}

// Thursday Oct 22 2026, 10:00 AM New York: futures open.
final _open = DateTime.utc(2026, 10, 22, 14);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('MNQ, NQ, BTC and ETH switch in place, each with its own truthful status', (tester) async {
    var now = _open;
    final live = CheRithmicLive(clock: () => now);
    final hub = CheLiveFeedHub(feed: CheMarketFeed(live: live, clock: () => now), throttle: Duration.zero);
    live.attach(_Feed(), symbol: 'MNQZ6', exchange: 'CME');
    final sockets = <String, _Socket>{};
    final crypto = CheCryptoStreamHub(
      create: (product, first) => CheCryptoStream(
        product: product,
        now: () => now,
        open: (uri, timeout) async => sockets[product] = _Socket(),
      ),
    );
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: Padding(padding: const EdgeInsets.all(16), child: CheLiveChartCard(hub: hub, now: () => now, cryptoHub: crypto))))));
    await tester.pump();

    // MNQ: signed in, no trade yet → WAITING with the plain reason; never "connected" or "connecting".
    expect(find.text('WAITING'), findsOneWidget);
    expect(find.text('Signed in to Rithmic — no market data received yet. Market-data subscription not confirmed yet.'), findsOneWidget);
    expect(find.textContaining(RegExp(r'\bconnect(ed|ing)\b', caseSensitive: false)), findsNothing);
    for (final t in kLiveChartTickers) {
      expect(find.bySemanticsLabel(RegExp('^$t chart')), findsOneWidget, reason: '$t has a VoiceOver label');
    }

    // NQ: Rithmic streams one contract; the card says which, and draws nothing wrong.
    await tester.tap(find.byKey(const ValueKey('che-live-ticker-NQ')));
    await tester.pump();
    expect(find.textContaining('Rithmic is streaming MNQZ6, not NQ'), findsOneWidget);

    // BTC: the public stream. LIVE only once a trade arrives.
    await tester.tap(find.byKey(const ValueKey('che-live-ticker-BTC')));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump();
    expect(crypto.watchers('BTC-USD'), 1);
    expect(find.text('LIVE'), findsNothing);
    await tester.runAsync(() async {
      sockets['BTC-USD']!.trade('BTC-USD', 80228, now);
      await Future<void>.delayed(const Duration(milliseconds: 400));
    });
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('LIVE'), findsOneWidget);
    expect(find.textContaining('public data, no account'), findsOneWidget);
    expect(find.textContaining('BTC-USD'), findsWidgets);

    // ETH releases BTC's stream; the choice is remembered.
    await tester.tap(find.byKey(const ValueKey('che-live-ticker-ETH')));
    await tester.pump();
    expect(crypto.watchers('BTC-USD'), 0);
    expect(crypto.watchers('ETH-USD'), 1);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    expect((await SharedPreferences.getInstance()).getString(kLiveChartTickerPref), 'ETH');
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 2));
    expect(crypto.watchers('ETH-USD'), 0, reason: 'a disposed card releases its stream');
  });
}
