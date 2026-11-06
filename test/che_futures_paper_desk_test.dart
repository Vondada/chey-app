// Paper Futures on the iPhone (lib/trading/che_futures_paper_desk.dart): manual paper trading of MNQ, NQ, MES and ES
// against the Worker's futures paper simulator. The Worker here is a stand-in that keeps its own small ledger and answers
// in the Worker's own JSON shapes; the screen only shows what it answers.
import 'dart:convert';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:chey/trading/che_futures_paper_desk.dart';

class _Worker {
  bool up = true;
  bool loseNextAnswer = false;
  Completer<void>? hold;
  int orders = 0;
  final placedIds = <String>[];
  final working = <Map<String, dynamic>>[];
  final positions = <Map<String, dynamic>>[];
  final posts = <Map<String, dynamic>>[];
  List<Object?> fills = const [];

  Map<String, dynamic> account() => {
        'cash': 50000, 'realized': 0, 'open_pnl': 0, 'equity': 50000, 'commissions': 0,
        'positions': positions, 'working': working, 'recent_fills': fills,
        'feeds': {'MNQ': {'status': 'DELAYED', 'source': 'Yahoo Finance chart (public) MNQ=F', 'contract': 'MNQZ6', 'price': 21000, 'bar_time': '2026-11-04T15:00:00.000Z', 'age_s': 660, 'fresh': true}},
        'limits': {'daily_loss': 500, 'today': 0},
      };

  late final client = MockClient((r) async {
    if (!up) throw http.ClientException('offline');
    if (r.method == 'GET') return http.Response(jsonEncode(account()), 200);
    final body = jsonDecode(r.body) as Map<String, dynamic>;
    posts.add({'path': r.url.path, ...body});
    if (hold != null) await hold!.future;
    if (r.url.path.endsWith('/order')) {
      if (placedIds.contains(body['client_id'])) return http.Response(jsonEncode({'ok': true, 'duplicate': true, 'text': 'That is the same paper order as O-00001 (filled), sir, so I did not place it twice.', 'account': account()}), 200);
      placedIds.add('${body['client_id']}');
      orders += 1;
      // The Worker placed it, but the answer never reached the phone.
      if (loseNextAnswer) {
        loseNextAnswer = false;
        working.add({'id': 'O-0000$orders', 'root': body['root'], 'side': body['side'], 'qty': body['qty'], 'type': body['type'], 'price': body['price'], 'role': 'entry'});
        throw http.ClientException('connection dropped');
      }
      if (body['type'] == 'market') {
        positions.add({'root': body['root'], 'qty': body['qty'], 'avg': 21000.25, 'mark': 21000, 'open_pnl': -0.5});
        return http.Response(jsonEncode({'ok': true, 'receipt': {'status': 'success'}, 'text': 'Paper order O-0000$orders filled, sir: buy ${body['qty']} ${body['root']} at 21000.25.', 'account': account()}), 200);
      }
      working.add({'id': 'O-0000$orders', 'root': body['root'], 'side': body['side'], 'qty': body['qty'], 'type': body['type'], 'price': body['price'], 'role': 'entry'});
      return http.Response(jsonEncode({'ok': true, 'receipt': {'status': 'accepted'}, 'text': 'Paper order O-0000$orders accepted and working, sir.', 'account': account()}), 200);
    }
    if (r.url.path.endsWith('/cancel')) {
      working.removeWhere((o) => o['id'] == body['id']);
      return http.Response(jsonEncode({'ok': true, 'text': 'Paper order ${body['id']} cancelled, sir.', 'account': account()}), 200);
    }
    if (r.url.path.endsWith('/flatten')) {
      working.clear();
      positions.clear();
      return http.Response(jsonEncode({'ok': true, 'text': 'Flattened, sir: no working orders; closed long 1 MNQ at 20999.75. Paper only.', 'account': account()}), 200);
    }
    return http.Response('{}', 404);
  });
}

Future<void> _pump(WidgetTester tester, _Worker w, {double textScale = 1, List<String>? spoken, ValueNotifier<bool>? shown}) async {
  await tester.binding.setSurfaceSize(const Size(390, 2400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData.dark(),
    home: MediaQuery(
      data: MediaQueryData(size: const Size(390, 2400), textScaler: TextScaler.linear(textScale)),
      child: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: ValueListenableBuilder<bool>(
        valueListenable: shown ?? ValueNotifier(true),
        builder: (_, on, _) => on
            ? CheFuturesPaperDesk(baseUrl: () => 'https://che.example', headers: () => const {}, client: w.client, onRead: spoken?.add, refreshEvery: const Duration(hours: 1))
            : const Text('another section'),
      ))),
    ),
  ));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('audit 2026-11-06: a short or missing fill time, numbers sent as text and a stray list item never break the desk', (tester) async {
    final w = _Worker()
      ..positions.add({'root': 'MNQ', 'qty': '1', 'avg': '21000.25', 'mark': null, 'open_pnl': '-0.5'})
      ..fills = [
        {'id': 'F-1', 'side': 'buy', 'qty': 1, 'root': 'MNQ', 'price': '21000.25', 'time': null},
        {'id': 'F-2', 'side': 'sell', 'qty': 1, 'root': 'MNQ', 'price': 21001, 'time': '2026-11'},
        'not a fill',
      ];
    await _pump(tester, w);
    expect(tester.takeException(), isNull);
    expect(find.textContaining('F-1: buy 1 MNQ at 21000.25 · time unknown UTC'), findsOneWidget);
    expect(find.textContaining('F-2: sell 1 MNQ at 21001 · 2026-11 UTC'), findsOneWidget);
    expect(find.textContaining('Long 1 MNQ at 21000.25'), findsOneWidget);
  });

  testWidgets('says paper and delayed plainly; a buy is confirmed first, then placed once and shown as the Worker answered', (tester) async {
    final w = _Worker();
    final spoken = <String>[];
    await _pump(tester, w, spoken: spoken);
    expect(find.text('CHE\'s paper simulator. No broker, no money. Live orders are off.'), findsOneWidget);
    expect(find.textContaining('DELAYED · Yahoo Finance chart (public) MNQ=F · MNQZ6 · 21000'), findsOneWidget);
    expect(find.textContaining('(11 min old) · market orders allowed'), findsOneWidget);
    await tester.tap(find.byKey(const Key('futures_buy')));
    await tester.pumpAndSettle();
    expect(find.text('Buy 1 MNQ market on paper?'), findsOneWidget);
    // "Not now" places nothing.
    await tester.tap(find.byKey(const Key('futures_confirm_cancel')));
    await tester.pumpAndSettle();
    expect(w.posts, isEmpty);
    await tester.tap(find.byKey(const Key('futures_buy')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('futures_confirm')));
    await tester.pumpAndSettle();
    expect(w.posts.single['path'], '/api/futures/paper/order');
    expect(w.posts.single['client_id'], startsWith('app-'));
    expect(find.text('Paper order O-00001 filled, sir: buy 1 MNQ at 21000.25.'), findsOneWidget);
    expect(find.text('Long 1 MNQ at 21000.25; mark 21000; open P&L −\$0.5'), findsOneWidget);
    // The outcome is spoken once; the initial refresh said nothing.
    expect(spoken, ['Paper order O-00001 filled, sir: buy 1 MNQ at 21000.25.']);
  });

  testWidgets('a dropped connection keeps the ticket id, so sending it again is refused as a duplicate, never placed twice', (tester) async {
    final w = _Worker();
    await _pump(tester, w);
    await tester.tap(find.byKey(const Key('futures_type_limit')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('futures_price')), '20900');
    await tester.tap(find.byKey(const Key('futures_buy')));
    await tester.pumpAndSettle();
    expect(find.text('Buy 1 MNQ limit 20900 on paper?'), findsOneWidget);
    w.loseNextAnswer = true;
    await tester.tap(find.byKey(const Key('futures_confirm')));
    await tester.pumpAndSettle();
    final first = w.posts.single['client_id'];
    expect(find.textContaining('No answer from CHE: the connection dropped. Nothing is assumed placed'), findsOneWidget);
    // Sending it again sends the same ticket: the Worker refuses the repeat, so one order exists.
    await tester.tap(find.byKey(const Key('futures_buy')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('futures_confirm')));
    await tester.pumpAndSettle();
    expect(w.posts.length, 2);
    expect(w.posts[1]['client_id'], first);
    expect(w.orders, 1);
    expect(find.textContaining('did not place it twice'), findsOneWidget);
  });

  testWidgets('working orders cancel from their own button; flatten asks first; a lost connection says so', (tester) async {
    final w = _Worker()..working.add({'id': 'O-00007', 'root': 'MNQ', 'side': 'buy', 'qty': 1, 'type': 'limit', 'price': 20800, 'role': 'entry'})
      ..positions.add({'root': 'MNQ', 'qty': 1, 'avg': 21000.25, 'mark': 21000, 'open_pnl': -0.5});
    await _pump(tester, w);
    await tester.tap(find.byKey(const Key('futures_cancel_O-00007')));
    await tester.pumpAndSettle();
    expect(find.text('Paper order O-00007 cancelled, sir.'), findsOneWidget);
    expect(find.text('No working paper orders.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('futures_flatten')));
    await tester.pumpAndSettle();
    expect(find.text('Flatten everything on paper?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('futures_confirm')));
    await tester.pumpAndSettle();
    expect(w.posts.last['path'], '/api/futures/paper/flatten');
    expect(find.textContaining('closed long 1 MNQ at 20999.75'), findsOneWidget);
    expect(find.text('No open paper positions.'), findsOneWidget);
    w.up = false;
    await tester.state<CheFuturesPaperDeskState>(find.byType(CheFuturesPaperDesk)).refresh();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('futures_paper_connection')), findsOneWidget);
    expect(find.textContaining('Connection lost.'), findsOneWidget);
  });

  testWidgets('large text: every control still fits and the buttons are at least 48 points tall', (tester) async {
    final w = _Worker();
    await _pump(tester, w, textScale: 2);
    expect(tester.takeException(), isNull);
    for (final k in ['futures_buy', 'futures_sell', 'futures_flatten']) {
      expect(tester.getSize(find.byKey(Key(k))).height, greaterThanOrEqualTo(48), reason: k);
    }
    final semantics = tester.ensureSemantics();
    expect(find.bySemanticsLabel('Buy 1 MNQ on paper'), findsOneWidget);
    expect(find.bySemanticsLabel('Flatten all paper positions and cancel every paper order'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('Codex on #926: VoiceOver can activate the buttons; the feed is not a live region; a lost connection is spoken only for an action', (tester) async {
    final w = _Worker();
    final spoken = <String>[];
    final semantics = tester.ensureSemantics();
    await _pump(tester, w, spoken: spoken);
    for (final label in ['Buy 1 MNQ on paper', 'Sell 1 MNQ on paper', 'Flatten all paper positions and cancel every paper order']) {
      final node = tester.getSemantics(find.bySemanticsLabel(label));
      expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue, reason: label);
    }
    final feed = tester.getSemantics(find.bySemanticsLabel(RegExp(r'^MNQ data: DELAYED')));
    expect(feed.getSemanticsData().flagsCollection.isLiveRegion, isFalse);
    // Activating BUY through accessibility opens the confirmation, and its confirm button is activatable too.
    tester.semantics.tap(find.semantics.byLabel('Buy 1 MNQ on paper'));
    await tester.pumpAndSettle();
    expect(find.text('Buy 1 MNQ market on paper?'), findsOneWidget);
    tester.semantics.tap(find.semantics.byLabel('Place paper buy'));
    await tester.pumpAndSettle();
    expect(w.orders, 1);
    expect(spoken.single, startsWith('Paper order O-00001 filled'));
    // A passive refresh that fails is shown, not spoken.
    w.up = false;
    await tester.state<CheFuturesPaperDeskState>(find.byType(CheFuturesPaperDesk)).refresh();
    await tester.pumpAndSettle();
    expect(find.textContaining('Connection lost.'), findsOneWidget);
    expect(spoken.length, 1);
    semantics.dispose();
  });

  testWidgets('Codex on #926: leaving the desk while an order is pending does not touch a disposed screen', (tester) async {
    final w = _Worker()..hold = Completer<void>();
    final spoken = <String>[];
    final shown = ValueNotifier(true);
    await _pump(tester, w, spoken: spoken, shown: shown);
    await tester.tap(find.byKey(const Key('futures_buy')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('futures_confirm')));
    await tester.pump();
    expect(w.posts.single['path'], '/api/futures/paper/order');
    shown.value = false;
    await tester.pump();
    expect(find.text('another section'), findsOneWidget);
    w.hold!.complete();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(spoken, isEmpty);
  });
}
