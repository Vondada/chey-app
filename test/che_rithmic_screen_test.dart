// Rithmic login is a normal login (ChatGPT report chatgpt-rithmic-simple-login-20261022): label, username, password,
// Connect. The system, gateway and front-month contract are found automatically; Advanced keeps manual overrides.
import 'dart:async';

import 'package:chey/rithmic/che_rithmic_screen.dart';
import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:chey/security/che_password_vault.dart';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class FakeStore implements RithmicCredentialStore {
  final saved = <String, CheVaultEntry>{};
  @override
  Future<CheVaultEntry?> find(String site) async => saved[site];
  @override
  Future<void> save(CheVaultEntry entry) async => saved[entry.site] = entry;
}

class FakeFeed implements RithmicMarketFeed {
  FakeFeed({this.error, this.confirmed = true});
  final Object? error;
  final bool confirmed;
  final _trades = StreamController<RithmicLastTrade>.broadcast();
  final _quotes = StreamController<RithmicBestBidOffer>.broadcast();
  Uri? gateway;
  String? user, password, system, symbol, exchange, appName;
  bool closed = false;
  @override
  Stream<RithmicLastTrade> get trades => _trades.stream;
  @override
  Stream<RithmicBestBidOffer> get quotes => _quotes.stream;
  @override
  bool get subscriptionConfirmed => confirmed;
  @override
  Future<void> connect({required String user, required String password, required String systemName, required String appName, required String appVersion, required String symbol, required String exchange}) async {
    this.user = user;
    this.password = password;
    system = systemName;
    this.symbol = symbol;
    this.exchange = exchange;
    this.appName = appName;
    if (error != null) throw error!;
  }

  void tick(double price) => _trades.add(RithmicLastTrade(symbol: symbol ?? '', exchange: 'CME', price: price, size: 1, ssboe: 0));
  @override
  Future<void> close() async => closed = true;
}

class FakeFinder implements RithmicRouteFinder {
  FakeFinder({this.error});
  final Object? error;
  int calls = 0;
  bool? preferPaper;
  @override
  Future<RithmicRoute> find({required bool preferPaper}) async {
    calls++;
    this.preferPaper = preferPaper;
    if (error != null) throw error!;
    return RithmicRoute(system: 'Rithmic Paper Trading', gatewayName: 'Chicago Area', gatewayUri: Uri.parse('wss://chicago.example:443'));
  }
}

Future<void> pump(WidgetTester tester, Widget screen) async {
  tester.view.physicalSize = const Size(900, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: screen));
  await tester.pumpAndSettle();
}

Finder field(String label) => find.byWidgetPredicate((w) => w is TextField && w.decoration?.labelText == label);

Future<void> fill(WidgetTester tester, String label, String value) => tester.enterText(field(label), value);

Future<void> connect(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
  await tester.pumpAndSettle();
}

final october = DateTime.utc(2026, 10, 22);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('the owner connects with only a username and password: system, gateway and contract are found', (tester) async {
    final store = FakeStore();
    final finder = FakeFinder();
    FakeFeed? feed;
    await pump(tester, CheRithmicScreen(store: store, routeFinder: finder, now: () => october, feedFactory: (uri) => feed = FakeFeed()..gateway = uri));
    // The primary screen has three fields and no developer key, gateway or system field showing.
    expect(field('Account label'), findsOneWidget);
    expect(field('Username or trader code'), findsOneWidget);
    expect(field('Password'), findsOneWidget);
    expect(find.textContaining('Developer key'), findsNothing);
    expect(field('Gateway address override (wss://…)'), findsNothing, reason: 'Advanced is collapsed by default');
    await fill(tester, 'Username or trader code', 'trader1');
    await fill(tester, 'Password', 'pw-secret-1');
    await connect(tester);
    expect(finder.calls, 1);
    expect(finder.preferPaper, isTrue, reason: 'FundYourEdge runs on Rithmic Paper Trading');
    expect(feed!.gateway.toString(), 'wss://chicago.example:443');
    expect(feed!.system, 'Rithmic Paper Trading');
    expect(feed!.symbol, 'MNQZ6', reason: 'the front month in October 2026');
    expect(feed!.appName, 'CHE');
    expect(find.text('Connected.'), findsOneWidget);
    expect(find.text('System: Rithmic Paper Trading'), findsOneWidget);
    expect(find.text('Account: FundYourEdge / Rithmic'), findsOneWidget);
    expect(find.textContaining('MNQZ6 on CME, confirmed by Rithmic'), findsOneWidget);
    expect(find.textContaining('Balances and orders are not connected here'), findsOneWidget);
    // Saved only after Rithmic accepted it, in the vault; never in preferences.
    expect(store.saved['rithmic']?.username, 'trader1');
    expect(store.saved['rithmic']?.password, 'pw-secret-1');
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getKeys().map((k) => '${prefs.get(k)}').join(' '), isNot(contains('pw-secret-1')));
    feed!.tick(20123.5);
    await tester.pumpAndSettle();
    expect(find.text('Last trade: 20123.50'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, 'Disconnect'));
    await tester.pumpAndSettle();
    expect(feed!.closed, isTrue);
    expect(find.textContaining('Nothing is streaming'), findsOneWidget);
  });

  testWidgets('a wrong password saves nothing and never shows a connected state', (tester) async {
    final store = FakeStore();
    final feed = FakeFeed(error: rithmicLoginFailure(['3', 'bad password']));
    await pump(tester, CheRithmicScreen(store: store, routeFinder: FakeFinder(), now: () => october, feedFactory: (_) => feed));
    await fill(tester, 'Username or trader code', 'trader1');
    await fill(tester, 'Password', 'wrong');
    await connect(tester);
    expect(find.textContaining('Rithmic rejected the username or password (3, bad password)'), findsOneWidget);
    expect(find.text('Not connected.'), findsOneWidget);
    expect(find.text('Connected.'), findsNothing);
    expect(store.saved, isEmpty, reason: 'a refused login is never saved');
    expect(feed.closed, isTrue);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getKeys(), isEmpty, reason: 'no connected state or settings written on failure');
  });

  testWidgets('each failure says exactly what went wrong', (tester) async {
    final cases = <Object, String>{
      const RithmicException(RithmicFailure.gatewayDiscovery, 'Could not reach Rithmic to find your gateway (offline). Nothing was saved.'): 'Could not reach Rithmic to find your gateway',
      rithmicLoginFailure(['5', 'system not available'], system: 'Rithmic Paper Trading'): 'The Rithmic system "Rithmic Paper Trading" is not available right now',
      rithmicSubscriptionFailure(['7', 'no market data permission'], symbol: 'MNQZ6', exchange: 'CME'): 'no market-data permission for MNQZ6 on CME',
      rithmicSubscriptionFailure(['4', 'invalid symbol'], symbol: 'MNQZ6', exchange: 'CME'): 'Rithmic would not subscribe to MNQZ6 on CME',
    };
    for (final entry in cases.entries) {
      final discoveryFails = entry.key is RithmicException && (entry.key as RithmicException).kind == RithmicFailure.gatewayDiscovery;
      await pump(tester, CheRithmicScreen(
        key: UniqueKey(),
        store: FakeStore(),
        now: () => october,
        routeFinder: FakeFinder(error: discoveryFails ? entry.key : null),
        feedFactory: (_) => FakeFeed(error: discoveryFails ? null : entry.key),
      ));
      await fill(tester, 'Username or trader code', 'trader1');
      await fill(tester, 'Password', 'pw');
      await connect(tester);
      expect(find.textContaining(entry.value), findsOneWidget, reason: entry.value);
      expect(find.text('Connected.'), findsNothing);
    }
  });

  testWidgets('Advanced keeps manual gateway, system and contract overrides for debugging', (tester) async {
    final finder = FakeFinder();
    FakeFeed? feed;
    await pump(tester, CheRithmicScreen(store: FakeStore(), routeFinder: finder, now: () => october, feedFactory: (uri) => feed = FakeFeed()..gateway = uri));
    await tester.tap(find.text('Advanced'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Contract now: MNQZ6'), findsOneWidget);
    await fill(tester, 'Gateway address override (wss://…)', 'wss://manual.example:443');
    await fill(tester, 'System name override', 'Rithmic Test');
    await fill(tester, 'Contract override', 'nqz6');
    await fill(tester, 'Username or trader code', 'trader1');
    await fill(tester, 'Password', 'pw');
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'Connect'));
    await connect(tester);
    expect(finder.calls, 0, reason: 'a manual gateway skips discovery');
    expect(feed!.gateway.toString(), 'wss://manual.example:443');
    expect(feed!.system, 'Rithmic Test');
    expect(feed!.symbol, 'NQZ6');
  });

  testWidgets('an Advanced address that is not wss is refused before any connection is tried', (tester) async {
    var tried = false;
    await pump(tester, CheRithmicScreen(store: FakeStore(), routeFinder: FakeFinder(), now: () => october, feedFactory: (_) {
      tried = true;
      return FakeFeed();
    }));
    await tester.tap(find.text('Advanced'));
    await tester.pumpAndSettle();
    await fill(tester, 'Gateway address override (wss://…)', 'https://gateway.example');
    await fill(tester, 'Username or trader code', 'trader1');
    await fill(tester, 'Password', 'pw');
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'Connect'));
    await connect(tester);
    expect(tried, isFalse);
    expect(find.textContaining('must start with wss://'), findsOneWidget);
  });

  testWidgets('a saved login reconnects with no typing, and no password means no network call', (tester) async {
    final store = FakeStore()..saved['rithmic'] = const CheVaultEntry(site: 'rithmic', username: 'trader1', password: 'pw');
    FakeFeed? feed;
    await pump(tester, CheRithmicScreen(store: store, routeFinder: FakeFinder(), now: () => october, feedFactory: (_) => feed = FakeFeed()));
    await connect(tester);
    expect(feed!.user, 'trader1');
    expect(feed!.password, 'pw');

    final finder = FakeFinder();
    await pump(tester, CheRithmicScreen(key: UniqueKey(), store: FakeStore(), routeFinder: finder, now: () => october, feedFactory: (_) => FakeFeed()));
    await fill(tester, 'Username or trader code', 'trader1');
    await connect(tester);
    expect(finder.calls, 0);
    expect(find.textContaining('Enter your Rithmic password'), findsOneWidget);
  });

  testWidgets('an unconfirmed subscription is said plainly, never as live data', (tester) async {
    await pump(tester, CheRithmicScreen(store: FakeStore(), routeFinder: FakeFinder(), now: () => october, feedFactory: (_) => FakeFeed(confirmed: false)));
    await fill(tester, 'Username or trader code', 'trader1');
    await fill(tester, 'Password', 'pw');
    await connect(tester);
    expect(find.textContaining('Rithmic has not confirmed it yet'), findsOneWidget);
    expect(find.textContaining('confirmed by Rithmic'), findsNothing);
  });
}
