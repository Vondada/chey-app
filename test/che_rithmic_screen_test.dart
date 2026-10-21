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
  FakeFeed({this.error});
  final Object? error;
  final _trades = StreamController<RithmicLastTrade>.broadcast();
  final _quotes = StreamController<RithmicBestBidOffer>.broadcast();
  String? connectedUser;
  String? connectedPassword;
  bool closed = false;
  @override
  Stream<RithmicLastTrade> get trades => _trades.stream;
  @override
  Stream<RithmicBestBidOffer> get quotes => _quotes.stream;
  @override
  Future<void> connect({required String user, required String password, required String systemName, required String appName, required String appVersion, required String symbol, required String exchange}) async {
    if (error != null) throw error!;
    connectedUser = user;
    connectedPassword = password;
  }
  void tick(double price) => _trades.add(RithmicLastTrade(symbol: 'MNQZ6', exchange: 'CME', price: price, size: 1, ssboe: 0));
  @override
  Future<void> close() async {
    closed = true;
  }
}

Future<void> pump(WidgetTester tester, Widget screen) async {
  tester.view.physicalSize = const Size(900, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: screen));
  await tester.pumpAndSettle();
}

Future<void> fill(WidgetTester tester, String label, String value) async {
  await tester.enterText(find.byWidgetPredicate((w) => w is TextField && w.decoration?.labelText == label), value);
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('save keeps the password in the vault and never in preferences', (tester) async {
    final store = FakeStore();
    await pump(tester, CheRithmicScreen(store: store));
    await fill(tester, 'Gateway address (wss://…)', 'wss://gateway.example/ws');
    await fill(tester, 'System name', 'Test System');
    await fill(tester, 'Login', 'trader1');
    await fill(tester, 'Password', 'pw-secret-1');
    await fill(tester, 'Developer key (optional)', 'key-secret-2');
    await tester.tap(find.widgetWithText(OutlinedButton, 'Save'));
    await tester.pumpAndSettle();
    expect(store.saved['rithmic']?.username, 'trader1');
    expect(store.saved['rithmic']?.password, 'pw-secret-1');
    expect(store.saved['rithmic-developer-key']?.password, 'key-secret-2');
    final prefs = await SharedPreferences.getInstance();
    final kept = prefs.getKeys().map((k) => prefs.get(k).toString()).join(' ');
    expect(kept, isNot(contains('pw-secret-1')));
    expect(kept, isNot(contains('key-secret-2')));
    expect(kept, contains('wss://gateway.example/ws'));
  });

  testWidgets('connect uses the saved login and shows live prices; disconnect stops', (tester) async {
    final store = FakeStore()..saved['rithmic'] = const CheVaultEntry(site: 'rithmic', username: 'trader1', password: 'pw');
    final feed = FakeFeed();
    await pump(tester, CheRithmicScreen(store: store, feedFactory: () => feed));
    await fill(tester, 'Gateway address (wss://…)', 'wss://gateway.example/ws');
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pumpAndSettle();
    expect(feed.connectedUser, 'trader1');
    expect(feed.connectedPassword, 'pw');
    expect(find.textContaining('Connected: live market data for MNQZ6 on CME'), findsOneWidget);
    feed.tick(20123.5);
    await tester.pumpAndSettle();
    expect(find.text('Last trade: 20123.50'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, 'Disconnect'));
    await tester.pumpAndSettle();
    expect(feed.closed, isTrue);
    expect(find.textContaining('Nothing is streaming'), findsOneWidget);
  });

  testWidgets('a refused login shows the exact Rithmic error and stays disconnected', (tester) async {
    final store = FakeStore()..saved['rithmic'] = const CheVaultEntry(site: 'rithmic', username: 'trader1', password: 'pw');
    await pump(tester, CheRithmicScreen(store: store, feedFactory: () => FakeFeed(error: StateError('Rithmic refused the login: 3 (login denied)'))));
    await fill(tester, 'Gateway address (wss://…)', 'wss://gateway.example/ws');
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Rithmic refused the login: 3 (login denied)'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Connect'), findsOneWidget);
  });

  testWidgets('an address that is not wss is refused before any connection is tried', (tester) async {
    final store = FakeStore()..saved['rithmic'] = const CheVaultEntry(site: 'rithmic', username: 'trader1', password: 'pw');
    var tried = false;
    await pump(tester, CheRithmicScreen(store: store, feedFactory: () {
      tried = true;
      return FakeFeed();
    }));
    await fill(tester, 'Gateway address (wss://…)', 'https://gateway.example');
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pumpAndSettle();
    expect(tried, isFalse);
    expect(find.textContaining('must start with wss://'), findsOneWidget);
  });

  testWidgets('connecting with no saved login says what to do, and nothing is read from the network', (tester) async {
    var tried = false;
    await pump(tester, CheRithmicScreen(store: FakeStore(), feedFactory: () {
      tried = true;
      return FakeFeed();
    }));
    await fill(tester, 'Gateway address (wss://…)', 'wss://gateway.example/ws');
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pumpAndSettle();
    expect(tried, isFalse);
    expect(find.textContaining('No Rithmic login is saved'), findsOneWidget);
  });
}
