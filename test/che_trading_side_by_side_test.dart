// Side-by-side trading and the Live Order Preview (owner, 2026-10-23): labels on every surface, layouts at
// phone/tablet/desktop widths, comparison math, the per-order Face ID gate and disabled submission.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:chey/rooms/che_trading_chart.dart';
import 'package:chey/rooms/che_trading_room.dart';
import 'package:chey/rooms/che_trading_side_by_side.dart';
import 'package:chey/trading/che_account_kind.dart';
import 'package:chey/trading/che_live_order.dart';
import 'package:chey/trading/che_market_feed.dart';
import 'package:chey/trading/che_my_trades.dart';
import 'package:chey/trading/che_trade_compare.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

final _now = DateTime.utc(2026, 10, 23, 15, 0);

Map<String, dynamic> _live() => {
      'account': 'PAPER',
      'positions': [
        {
          'portfolio': 'ema|all|2',
          'strategy': 'ema_pullback',
          'name': 'EMA 20 pullback',
          'side': 'long',
          'entry_time': _now.subtract(const Duration(minutes: 30)).toIso8601String(),
          'entry': 21445,
          'stop': 21425,
          'target': 21485,
          'unrealized': 10,
          'contract': 'MNQZ6',
          'qty': 1,
          'why': 'Pullback to the 20 EMA in an uptrend.',
        },
      ],
      'trades': [
        {
          'strategy': 'vwap',
          'name': 'VWAP reversion',
          'side': 'short',
          'contract': 'MNQZ6',
          'qty': 1,
          'entry': {'time': '2026-10-23T13:40:00Z', 'fill': 21500},
          'exit': {'time': '2026-10-23T13:55:00Z', 'fill': 21480, 'reason': 'target'},
          'stop': 21515,
          'target': 21480,
          'net_pnl': 38.76,
        },
      ],
      'signals': [
        {'time': '2026-10-23T14:30:00Z', 'side': 'long', 'ref': 21445, 'stop': 21425, 'target': 21485, 'why': 'EMA pullback', 'strategy': 'ema_pullback'},
      ],
      'totals': {'trades': 1, 'wins': 1, 'losses': 0, 'win_rate': 100.0, 'net_pnl': 38.76, 'avg_winner': 38.76, 'avg_loser': 0, 'max_drawdown': 0},
    };

CheMarketSnapshot _snap({bool live = true, double price = 21460}) => CheMarketSnapshot(
      symbol: 'MNQZ6',
      exchange: 'CME',
      source: live ? 'rithmic' : 'none',
      sourceLabel: live ? 'Rithmic live — MNQZ6' : 'No live feed',
      connection: live ? CheFeedConnection.connected : CheFeedConnection.off,
      statusLabel: live ? 'Connected' : 'Not connected',
      isLive: live,
      lastPrice: live ? price : null,
      lastTradeAt: live ? _now : null,
      lastUpdate: live ? _now : null,
    );

http.Client _client({int status = 200}) => MockClient((req) async {
      if (req.url.path == '/api/trading/live') return http.Response(jsonEncode(status == 200 ? _live() : {'detail': 'down'}), status);
      return http.Response('{}', 404);
    });

CheTradeView _mineTrade({double unrealized = 40}) => CheTradeView(
      id: 'm1',
      account: CheAccountKind.mine,
      symbol: 'MNQ',
      side: 'long',
      qty: 2,
      entry: 21450,
      stop: 21430,
      target: 21490,
      openedAt: _now.subtract(const Duration(minutes: 10)),
      setup: 'EMA 20 pullback',
      unrealized: unrealized,
      adjusted: true,
      source: 'entered by you',
    );

Future<List<CheTradingChartController>> _pump(WidgetTester tester, {required Size size, http.Client? client, List<String>? read, CheMyTradesStore? store, CheFaceIdCheck? faceId, CheLiveOrderAudit? audit}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final controllers = <CheTradingChartController>[];
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      backgroundColor: Colors.black,
      body: SingleChildScrollView(
        child: CheSideBySideView(
          baseUrl: () => 'https://che.test',
          headers: () => const {},
          client: client ?? _client(),
          onRead: read?.add,
          store: store ?? CheMyTradesStore(),
          snapshots: const Stream.empty(),
          currentSnapshot: () => _snap(),
          faceId: faceId,
          audit: audit,
          now: () => _now,
          chartBuilder: (context, account, controller, height) {
            controllers.add(controller);
            return SizedBox(height: height, child: Text('chart ${account.label}'));
          },
        ),
      ),
    ),
  ));
  await tester.pumpAndSettle();
  return controllers;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('comparison math', () {
    test('differences are mine minus CHE\'s, from recorded numbers only', () {
      final che = CheTradeView.fromLivePosition(Map<String, dynamic>.from((_live()['positions'] as List).first as Map));
      final c = CheTradeComparison(_mineTrade(), che, now: _now);
      expect(c.entryDiff, 5);
      expect(c.stopDiff, -5 + 10); // 21430 − 21425
      expect(c.targetDiff, 5);
      expect(c.qtyDiff, 1);
      expect(_mineTrade().dollarRisk, 80); // 20 points × 2 contracts × $2
      expect(che.dollarRisk, 40);
      expect(c.dollarRiskDiff, 40);
      expect(c.pnlDiff, 30);
      expect(_mineTrade().returnOnRiskPct, 50);
      expect(che.returnOnRiskPct, 25);
      expect(c.returnPctDiff, 25);
      expect(c.timeInTradeDiff, const Duration(minutes: -20));
      expect(c.sameSetup, isTrue);
      expect(c.eitherAdjusted, isTrue);
      expect(c.sameSymbol, isTrue, reason: 'MNQ and MNQZ6 are the same root');
    });

    test('an unknown value stays unknown instead of becoming zero', () {
      final noStop = CheTradeView(id: 'x', account: CheAccountKind.mine, symbol: 'MNQ', side: 'long', qty: 1, entry: 21400);
      final che = CheTradeView(id: 'y', account: CheAccountKind.chePaper, symbol: 'MNQ', side: 'long', qty: 1, entry: 21400, stop: 21390);
      final c = CheTradeComparison(noStop, che, now: _now);
      expect(c.stopDiff, isNull);
      expect(c.dollarRiskDiff, isNull);
      expect(c.pnlDiff, isNull);
      expect(c.timeInTradeDiff, isNull);
      expect(c.sameSetup, isFalse, reason: 'two unnamed setups are never assumed to be the same');
    });

    test('the owner\'s P&L is marked only at a live price', () {
      final t = _mineTrade();
      expect(cheUnrealizedAt(t, 21460), 40);
      expect(cheUnrealizedAt(t, null), isNull);
    });

    test('summaries never invent a balance', () {
      final che = CheAccountSummary.fromLiveDashboard(_live());
      expect(che.balance, isNull);
      expect(che.equity, isNull);
      expect(che.realized, 38.76);
      expect(che.unrealized, 10);
      expect(che.openPositions, 1);
      expect(che.dailyRisk, 40);
      expect(che.activeSetups, 1);
      final mine = CheAccountSummary.fromOwnerTrades([_mineTrade()]);
      expect(mine.balance, isNull);
      expect(mine.realized, isNull, reason: 'no closed trades yet');
      expect(mine.openPositions, 1);
    });
  });

  group('Live order gate', () {
    const good = CheLiveOrderTicket(accountName: 'FundYourEdge (Rithmic)', contract: 'MNQZ6', side: 'buy', qty: 1, entry: 21450, stop: 21430, target: 21490);

    test('submission is disabled at compile time', () {
      expect(kCheLiveOrderSubmissionEnabled, isFalse);
    });

    test('the preview numbers: risk, reward, R and estimated fees', () {
      expect(good.dollarRisk, 40);
      expect(good.dollarReward, 80);
      expect(good.riskReward, 2);
      expect(good.estimatedFees, 1.24);
      expect(good.problems, isEmpty);
      expect(good.account, CheAccountKind.live);
    });

    test('Face ID runs for EACH order, never reused, and nothing is sent', () async {
      var asked = 0;
      final audit = CheLiveOrderAudit();
      final gate = CheLiveOrderGate(faceId: (_) async {
        asked++;
        return true;
      }, audit: audit);
      final a = await gate.approve(good);
      final b = await gate.approve(good);
      expect(asked, 2, reason: 'a passed Face ID check is not cached for the next order');
      expect(a.sent, isFalse);
      expect(b.sent, isFalse);
      expect(a.step, CheLiveOrderStep.refusedDisabled);
      expect(a.message, contains('Nothing was sent'));
      expect(a.broker.supported, isFalse);
      expect(a.broker.summary, contains('not supported yet'));
      final events = [for (final e in await audit.entries()) e['event']];
      expect(events, ['face_id_passed', 'refused_disabled', 'face_id_passed', 'refused_disabled']);
      expect((await audit.entries()).every((e) => e['account'] == 'LIVE ACCOUNT'), isTrue);
    });

    test('a failed Face ID sends nothing', () async {
      final gate = CheLiveOrderGate(faceId: (_) async => false);
      final o = await gate.approve(good);
      expect(o.sent, isFalse);
      expect(o.step, CheLiveOrderStep.faceIdFailed);
    });

    test('a bad ticket is blocked before Face ID is even asked', () async {
      var asked = 0;
      final gate = CheLiveOrderGate(faceId: (_) async {
        asked++;
        return true;
      });
      const wrongStop = CheLiveOrderTicket(accountName: 'FYE', contract: 'MNQ', side: 'buy', qty: 1, entry: 21450, stop: 21460);
      const noStop = CheLiveOrderTicket(accountName: 'FYE', contract: 'MNQ', side: 'sell', qty: 1, entry: 21450);
      expect((await gate.approve(wrongStop)).step, CheLiveOrderStep.blocked);
      expect((await gate.approve(noStop)).message, contains('needs a stop loss'));
      expect(asked, 0);
    });

    test('even with the flag forced on, no broker path exists, so nothing is sent', () async {
      final gate = CheLiveOrderGate(faceId: (_) async => true, submissionEnabled: true);
      final o = await gate.approve(good);
      expect(o.sent, isFalse);
      expect(o.message, contains('No broker order connection'));
    });

    test('the live-order code has no network path and no order message exists in the Rithmic wire', () {
      final src = File('lib/trading/che_live_order.dart').readAsStringSync();
      expect(src, isNot(contains('package:http')));
      expect(src, isNot(contains('HttpClient')));
      expect(src, isNot(contains('WebSocket')));
      expect(src, contains('const bool kCheLiveOrderSubmissionEnabled = false;'));
      final wire = File('lib/rithmic/rithmic_wire.dart').readAsStringSync();
      expect(wire, contains('deliberately no order-entry message'));
    });

    test('the audit only appends', () {
      final src = File('lib/trading/che_live_order.dart').readAsStringSync();
      final audit = src.substring(src.indexOf('class CheLiveOrderAudit'), src.indexOf('typedef CheFaceIdCheck'));
      expect(audit, isNot(contains('remove(')));
      expect(audit, isNot(contains('clear(')));
    });
  });

  group('side-by-side view', () {
    for (final (name, size, key) in [
      ('phone', const Size(390, 2400), 'sbs_stacked'),
      ('tablet', const Size(820, 2400), 'sbs_side_by_side'),
      ('desktop', const Size(1280, 2400), 'sbs_side_by_side'),
    ]) {
      testWidgets('$name layout labels every surface MY ACCOUNT or CHE PAPER ACCOUNT, silently', (tester) async {
        final read = <String>[];
        await _pump(tester, size: size, read: read);
        expect(find.byKey(Key(key)), findsOneWidget);
        expect(find.byKey(const Key('account_band_mine')), findsWidgets);
        expect(find.byKey(const Key('account_band_chePaper')), findsWidgets);
        expect(find.byKey(const Key('sbs_pane_mine')), findsOneWidget);
        expect(find.byKey(const Key('sbs_pane_chePaper')), findsOneWidget);
        expect(find.text('chart MY ACCOUNT'), findsOneWidget);
        expect(find.text('chart CHE PAPER ACCOUNT'), findsOneWidget);
        expect(find.textContaining('Rithmic live — MNQZ6'), findsOneWidget);
        expect(find.text('not connected'), findsNWidgets(3), reason: 'my balance, available and equity are never invented');
        expect(tester.takeException(), isNull);
        expect(read, isEmpty, reason: 'silent on open');
      });
    }

    testWidgets('CHE positions, switcher and comparison', (tester) async {
      final store = CheMyTradesStore();
      await store.add(symbol: 'MNQ', side: 'long', qty: 2, entry: 21450, stop: 21430, target: 21490, setup: 'EMA 20 pullback', openedAt: _now.subtract(const Duration(minutes: 10)));
      await _pump(tester, size: const Size(1280, 3000), store: store);
      expect(find.textContaining('LONG 1 MNQZ6 · EMA 20 pullback'), findsOneWidget);
      expect(find.textContaining('LONG 2 MNQ · EMA 20 pullback'), findsOneWidget);
      // Compared automatically: my open MNQ trade against CHE's open MNQ position.
      expect(find.byKey(const Key('sbs_compare')), findsOneWidget);
      expect(find.textContaining('+5 points (mine 21450, CHE 21445)'), findsOneWidget);
      expect(find.textContaining('+\$30.00'), findsOneWidget, reason: 'my P&L at the live 21460 is \$40; CHE recorded \$10');
      expect(find.textContaining('Yes: EMA 20 pullback'), findsOneWidget);

      await tester.tap(find.byKey(const Key('sbs_view_closed')));
      await tester.pumpAndSettle();
      expect(find.textContaining('SHORT 1 MNQZ6 · VWAP reversion'), findsOneWidget);
      expect(find.textContaining('Realized \$38.76'), findsOneWidget);

      await tester.tap(find.byKey(const Key('sbs_view_pending')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('sbs_pending_mine')), findsOneWidget);
      expect(find.byKey(const Key('sbs_pending_chePaper')), findsOneWidget);

      await tester.tap(find.byKey(const Key('sbs_view_watchlist')));
      await tester.pumpAndSettle();
      expect(find.textContaining('LONG · ema_pullback'), findsOneWidget);

      await tester.tap(find.byKey(const Key('sbs_view_mine')));
      await tester.pumpAndSettle();
      expect(find.textContaining('LONG 1 MNQZ6 · EMA 20 pullback'), findsNothing);
      expect(find.textContaining('Hidden: the switcher shows My account only.'), findsOneWidget);
    });

    testWidgets('synced controls drive both charts; independent mode hides them', (tester) async {
      final controllers = await _pump(tester, size: const Size(1280, 2400));
      final unique = controllers.toSet().toList();
      expect(unique.length, 2);
      final seen = <String?>[];
      for (final c in unique) {
        c.addListener(() => seen.add(c.timeframe));
      }
      await tester.tap(find.byKey(const Key('sbs_tf_15m')));
      await tester.pump();
      expect(seen, ['15m', '15m']);
      await tester.tap(find.byKey(const Key('sbs_sync')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('sbs_tf_15m')), findsNothing);
    });

    testWidgets('when CHE\'s records are down it says so and shows no numbers for CHE', (tester) async {
      await _pump(tester, size: const Size(1280, 2400), client: _client(status: 503));
      expect(find.textContaining('not available (503)'), findsWidgets);
      expect(find.byKey(const Key('sbs_compare_empty')), findsOneWidget);
    });

    testWidgets('Read aloud reads both accounts only when pressed', (tester) async {
      final read = <String>[];
      await _pump(tester, size: const Size(1280, 2400), read: read);
      await tester.tap(find.byKey(const Key('sbs_read')));
      expect(read.single, contains('MY ACCOUNT'));
      expect(read.single, contains('CHE PAPER ACCOUNT'));
      expect(read.single, contains('Live orders are disabled.'));
    });
  });

  group('Live Order Preview screen', () {
    testWidgets('labelled LIVE ACCOUNT, disabled, Face ID per approval, broker status not invented', (tester) async {
      tester.view.physicalSize = const Size(390, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var asked = 0;
      await tester.pumpWidget(MaterialApp(
        home: CheLiveOrderPreviewPage(
          contract: 'MNQZ6',
          lastPrice: 21450,
          priceSource: 'Rithmic live — MNQZ6',
          faceId: (_) async {
            asked++;
            return true;
          },
        ),
      ));
      expect(find.byKey(const Key('account_band_live')), findsOneWidget);
      expect(find.text('LIVE ACCOUNT'), findsOneWidget);
      expect(find.byKey(const Key('live_disabled_banner')), findsOneWidget);
      expect(find.byKey(const Key('live_approve')), findsNothing, reason: 'no approval before a preview');
      await tester.enterText(find.byKey(const Key('live_stop')), '21430');
      await tester.enterText(find.byKey(const Key('live_target')), '21490');
      await tester.tap(find.byKey(const Key('live_preview')));
      await tester.pumpAndSettle();
      expect(find.textContaining('LIVE ACCOUNT · FundYourEdge (Rithmic)'), findsOneWidget);
      expect(find.textContaining('\$40.00 (at the stop'), findsOneWidget);
      expect(find.textContaining('2.00 to 1'), findsOneWidget);
      expect(find.textContaining('\$1.24 round turn'), findsOneWidget);
      await tester.tap(find.byKey(const Key('live_approve')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live_approve')));
      await tester.pumpAndSettle();
      expect(asked, 2);
      expect(find.textContaining('NOT SENT'), findsOneWidget);
      expect(find.textContaining('not supported yet'), findsOneWidget);
      expect(find.textContaining(RegExp(r'^SENT')), findsNothing);
    });
  });

  test('voice and Worker replies open the SIDE BY SIDE section', () {
    expect(cheTradingSectionNamed('compare'), CheTradingSection.compare);
    expect(cheTradingSectionNamed('side by side'), CheTradingSection.compare);
    expect(kTradingSectionLabels[CheTradingSection.compare], 'SIDE BY SIDE');
  });
}
