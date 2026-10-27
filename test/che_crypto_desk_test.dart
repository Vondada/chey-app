// Orion's crypto desk (owner master mission, 2026-10-23): the CRYPTO market in the Trading Room shows the Worker's
// crypto records only, every status as a word (never colour alone), pause/resume by button, and Read aloud on demand.
import 'dart:convert';

import 'package:chey/rooms/che_trading_room.dart';
import 'package:chey/trading/che_crypto_desk.dart';
import 'package:chey/che_ui/che_chrome_status.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _desk({bool enabled = true, bool down = false}) => {
      'market': 'crypto',
      'enabled': enabled,
      'schedule': {'last_run_at': '2026-10-24T15:00:20Z', 'next_at': '2026-10-24T15:05:20Z', 'runs_recorded': 12, 'model_calls': 0},
      'budget': {'day': '2026-10-24', 'requests': 40, 'limit': 3000},
      'feeds': [
        {'coin': 'BTC', 'tf': '5m', 'status': down ? 'DISCONNECTED' : 'LIVE', 'reason': down ? 'Coinbase answered HTTP 503' : null, 'last_bar': down ? null : '2026-10-24T14:55:00Z', 'last_close': down ? null : 101234.5},
        {'coin': 'ETH', 'tf': '5m', 'status': 'DELAYED', 'last_bar': '2026-10-24T14:45:00Z', 'last_close': 4012.25},
        {'coin': 'BTC', 'tf': '1h', 'status': 'LIVE', 'last_bar': '2026-10-24T14:00:00Z', 'last_close': 101000.0},
      ],
      'simulated': {
        'open_positions': [],
        'closed_trades': 2,
        'net_pnl': -14.2,
        'expectancy_r': null,
        'enough_data': false,
        'recent': [
          {'coin': 'BTC', 'tf': '5m', 'strategy': 'ema-pullback-5m', 'side': 'long', 'entry': 101000.5, 'exit': 100500.0, 'reason': 'stop', 'net_pnl': -17.1, 'exit_time': '2026-10-24T14:40:00Z'},
        ],
      },
      'research': [],
      'funding': {'status': 'MISSING'},
      'spoken': 'Orion\'s crypto desk is on. Simulated trades closed: 2.',
    };

class _Server {
  bool enabled = true;
  bool down = false;
  final posts = <Map<String, dynamic>>[];
  late final client = MockClient((r) async {
    if (r.url.path == '/api/trading/crypto') {
      if (r.method == 'POST') {
        final body = jsonDecode(r.body) as Map<String, dynamic>;
        posts.add(body);
        enabled = body['action'] == 'resume';
      }
      return http.Response(jsonEncode(_desk(enabled: enabled, down: down)), 200);
    }
    if (r.url.path == '/api/trading/chart') return http.Response(jsonEncode({'ok': true, 'bars': [], 'markers': [], 'feed': {'status': 'DELAYED'}}), 200);
    return http.Response(jsonEncode({'ok': true}), 200);
  });
}

Future<void> _pumpDesk(WidgetTester tester, _Server s, {List<String>? spoken}) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData.dark(),
    home: Scaffold(body: SingleChildScrollView(child: CheCryptoDeskPanel(baseUrl: () => 'https://che.example', headers: () => const {}, client: s.client, onRead: spoken?.add))),
  ));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('shows each feed status as a word, the real counts, and "not enough data" under 30 trades', (tester) async {
    final s = _Server();
    await _pumpDesk(tester, s);
    expect(find.text('LIVE'), findsWidgets);
    expect(find.text('DELAYED'), findsOneWidget);
    expect(find.textContaining('101234.5'), findsOneWidget);
    expect(find.text('Closed 2'), findsOneWidget);
    expect(find.text('Not enough data: 2 of 30'), findsOneWidget);
    expect(find.textContaining('Paper only'), findsOneWidget);
    expect(find.textContaining('Funding rates: MISSING'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'BTC 5-minute feed LIVE, last close 101234\.5')), findsOneWidget);
  });

  testWidgets('an exchange outage reads DISCONNECTED with its reason', (tester) async {
    final s = _Server()..down = true;
    await _pumpDesk(tester, s);
    expect(find.text('DISCONNECTED'), findsOneWidget);
    expect(find.textContaining('HTTP 503'), findsOneWidget);
  });

  testWidgets('Pause and Resume post the action; Read aloud reads only when pressed', (tester) async {
    final s = _Server();
    final spoken = <String>[];
    await _pumpDesk(tester, s, spoken: spoken);
    expect(spoken, isEmpty, reason: 'silent on open');
    await tester.tap(find.byKey(const Key('crypto_toggle')));
    await tester.pump(const Duration(milliseconds: 50));
    expect(s.posts.single['action'], 'pause');
    expect(find.text('Resume'), findsOneWidget);
    await tester.tap(find.byKey(const Key('crypto_read')));
    expect(spoken.single, contains('Simulated trades closed: 2'));
  });

  test('status tones: green LIVE, amber DELAYED, red DISCONNECTED', () {
    expect(cheCryptoTone('LIVE'), CheStatusTone.success);
    expect(cheCryptoTone('DELAYED'), CheStatusTone.warning);
    expect(cheCryptoTone('DISCONNECTED'), CheStatusTone.failure);
    expect(cheCryptoTone('NOT STARTED'), CheStatusTone.neutral);
  });

  testWidgets('the Trading Room has a CRYPTO section that opens the crypto desk, and voice names reach it', (tester) async {
    final s = _Server();
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    expect(cheTradingSectionNamed('crypto'), CheTradingSection.crypto);
    expect(cheTradingSectionNamed('Orion'), CheTradingSection.crypto);
    expect(kTradingSectionLabels[CheTradingSection.crypto], 'CRYPTO');
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: Scaffold(body: CheTradingRoom(baseUrl: () => 'https://che.example', headers: () => const {}, onAsk: (_) {}, client: s.client, initialSection: CheTradingSection.crypto)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('crypto_desk')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^CRYPTO section, open')), findsOneWidget);
  });
}
