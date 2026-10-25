// Trading Room v3 regressions (owner, 2026-10-25: "fix, simplify and verify"). Each test reproduces a failure the
// owner recorded, first failing on the old code.
import 'package:chey/rooms/che_trading_room.dart';
import 'package:chey/trading/che_crypto_desk.dart';
import 'package:chey/trading/che_paper_engine.dart';
import 'package:chey/trading/che_setup_desk.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'trading_room_v3_fixture.dart';

Future<void> pumpRoom(WidgetTester tester, {http.Client? client, CheTradingSection section = CheTradingSection.chart}) async {
  await tester.binding.setSurfaceSize(const Size(440, 956));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  ChePaperEngine.sharedForTest = ChePaperEngine.load(ChePaperMemoryStore(), clock: () => kFixtureNow);
  addTearDown(() => ChePaperEngine.sharedForTest = null);
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData.dark(),
    home: Scaffold(
      body: CheTradingRoom(
        baseUrl: () => 'https://che.test',
        headers: () => const {},
        onAsk: (_) {},
        onRead: (_) {},
        client: client ?? fixtureWorker(),
        initialSection: section,
        setupDesk: CheSetupDesk(),
      ),
    ),
  ));
  await settle(tester);
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
  }
}

/// No widget in the tree threw while building: a release build paints a thrown build as a flat gray box.
void expectNoGrayBox(WidgetTester tester) {
  expect(tester.takeException(), isNull);
  expect(find.byType(ErrorWidget), findsNothing);
}

void main() {
  // Owner recording 2026-10-25 06:16: a flat gray box under "CHE positions" and under the crypto desk's
  // "R per trade" line. Both sit right above an ExpansionTile. The room's ListView carried the app's only
  // PageStorageKey, so its saved scroll offset (a double) and every ExpansionTile inside it (which restores a bool)
  // shared one storage slot: after the owner scrolled, the tile's `as bool?` threw and release builds painted gray.
  testWidgets('scrolling the room, then opening the crypto desk and the journal, builds without a gray box', (tester) async {
    await pumpRoom(tester, client: fixtureWorker(overrides: {'/api/trading/crypto': fixtureCryptoOwner()}));
    await tester.drag(find.byType(ListView).first, const Offset(0, -400));
    await settle(tester);
    CheTradingRoom.requestedSection.value = CheTradingSection.crypto; // the voice route; the nav row is scrolled away
    await settle(tester);
    expectNoGrayBox(tester);
    expect(find.textContaining('Recent simulated trades'), findsOneWidget);
    await tester.drag(find.byType(ListView).first, const Offset(0, -300));
    await settle(tester);
    CheTradingRoom.requestedSection.value = CheTradingSection.cheTrades;
    await settle(tester);
    expectNoGrayBox(tester);
    expect(find.byKey(const Key('paper_journal')), findsOneWidget);
  });

  // Owner recording: "Open 16" on the crypto desk beside "No open CHE paper positions", and "-6.5935 R per trade".
  // Two different accounts, now named; R to two decimals with the reason it is so negative (fees vs a 5-minute stop:
  // the math in trading_evidence.settleTrade is right, 1 R being the stop distance before costs).
  testWidgets('the crypto desk names its account and shows R to two decimals with the fee explanation', (tester) async {
    await pumpRoom(tester, section: CheTradingSection.crypto, client: fixtureWorker(overrides: {'/api/trading/crypto': fixtureCryptoOwner()}));
    expectNoGrayBox(tester);
    expect(find.text('ORION CRYPTO PAPER · WORKER'), findsOneWidget);
    expect(find.text('−6.59 R per trade'), findsOneWidget);
    expect(find.textContaining('6.5935'), findsNothing);
    expect(find.byKey(const Key('crypto_r_note')), findsOneWidget);
    expect(cheCryptoR(-6.5935), '−6.59 R');
    expect(cheCryptoR(0.4, spoken: true), 'plus 0.40 R');
    expect(cheCryptoRNote(-0.5), isEmpty);
  });

  testWidgets('the CHE paper account says which account has no open positions', (tester) async {
    await pumpRoom(tester, section: CheTradingSection.cheTrades);
    expectNoGrayBox(tester);
    expect(find.textContaining('No open positions in the CHE PAPER ACCOUNT (MNQ on this iPhone)'), findsOneWidget);
  });
}
