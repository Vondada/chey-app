import 'dart:convert';

import 'package:chey/rooms/che_usage_center_room.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// The Worker's real shape (server/cloudflare/usage_center.js usageView), trimmed to one row per provenance kind.
Map<String, dynamic> _view({bool withSub = true}) => {
      'at': '2026-10-25T15:00:00.000Z',
      'spoken': 'Usage Center. 2 services connected: Groq, Kaggle. No usage alerts.',
      'alerts': [
        {'id': 'quota:kaggle', 'kind': 'quota', 'severity': 'warning', 'provenance': 'OBSERVED', 'text': "Kaggle's free GPU quota is 87% used this week (4 hours left)."},
      ],
      'totals': [
        {'id': 'tokens_today', 'label': 'CHE tokens today, all engines', 'value': 1200, 'unit': 'tokens', 'provenance': 'ESTIMATED', 'source': "CHE's router count", 'text': "CHE tokens today, all engines: 1,200 tokens (estimated; CHE's router count)."},
      ],
      'rows': [
        {
          'id': 'ai:groq', 'group': 'ai', 'name': 'Groq', 'status': 'connected', 'status_id': 'connected', 'evidence': 'Key test passed at 2026-10-25 13:00 UTC.',
          'purpose': 'Language engine for chat, research and coding', 'scopes': 'API key ending abcd; the provider reports no scopes',
          'metrics': [
            {'id': 'tokens_today', 'label': 'Groq tokens today', 'value': 900, 'unit': 'tokens', 'provenance': 'ESTIMATED', 'source': "CHE's router count", 'text': "Groq tokens today: 900 tokens (estimated; CHE's router count)."},
            {'id': 'token_charge', 'label': 'Token charge', 'value': null, 'unit': '', 'provenance': 'UNAVAILABLE', 'why': 'CHE reads no billing data from Groq.', 'text': 'Token charge: unavailable. CHE reads no billing data from Groq.'},
          ],
        },
        {
          'id': 'compute:kaggle', 'group': 'compute', 'name': 'Kaggle GPU kernel', 'status': 'connected', 'status_id': 'connected', 'evidence': 'Token saved.', 'purpose': 'Free weekly Kaggle GPU quota', 'scopes': 'KAGGLE_API_TOKEN',
          'metrics': [
            {'id': 'quota_left', 'label': 'GPU hours left this week', 'value': 4, 'unit': 'h', 'provenance': 'OBSERVED', 'source': 'Kaggle API', 'text': 'GPU hours left this week: 4 h (observed; Kaggle API).'},
          ],
        },
        {
          'id': 'compute:modal', 'group': 'compute', 'name': 'Modal GPU functions', 'status': 'not connected', 'status_id': 'not_connected', 'evidence': 'No Modal key is saved.', 'purpose': 'GPU functions (not wired yet)', 'scopes': 'none',
          'metrics': [
            {'id': 'credits', 'label': 'Free credits left', 'value': null, 'unit': '', 'provenance': 'UNAVAILABLE', 'why': 'CHE has no Modal API read.', 'text': 'Free credits left: unavailable. CHE has no Modal API read.'},
          ],
        },
        if (withSub)
          {
            'id': 'subscription:sub_1', 'sub_id': 'sub_1', 'group': 'subscription', 'name': 'ChatGPT', 'status': 'user entered', 'status_id': 'user_entered',
            'purpose': 'A subscription you told CHE about.', 'scopes': 'none (no account access)', 'said': 'You said at 2026-10-24 15:00 UTC: "my ChatGPT subscription is \$20 a month"',
            'metrics': [
              {'id': 'price', 'label': 'Price', 'value': 20, 'unit': 'usd', 'provenance': 'USER_ENTERED', 'words': 'my ChatGPT subscription is \$20 a month', 'source': 'per month', 'text': 'Price: \$20.00 (you told me; per month).'},
            ],
          },
      ],
    };

void main() {
  final calls = <String>[];
  late MockClient client;
  var hasSub = true;
  setUp(() {
    calls.clear();
    hasSub = true;
    client = MockClient((r) async {
      calls.add('${r.method} ${r.url.path} ${r.body}');
      if (r.url.path == '/api/usage') return http.Response(jsonEncode(_view(withSub: hasSub)), 200);
      if (r.url.path == '/api/usage/subscriptions/remove') {
        final b = jsonDecode(r.body) as Map;
        if (b['confirm'] != true) return http.Response(jsonEncode({'ok': false, 'needs_confirmation': true}), 409);
        hasSub = false;
        return http.Response(jsonEncode({'ok': true, 'spoken': 'Removed the ChatGPT record from your Usage Center.'}), 200);
      }
      if (r.url.path == '/api/usage/subscriptions') {
        return http.Response(jsonEncode({'ok': true, 'spoken': 'Saved at 15:00 UTC, as you said it: Netflix, \$15.49 a month.'}), 200);
      }
      return http.Response('{}', 404);
    });
  });

  Future<List<String>> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1170, 2532 * 8); // tall, so the lazy list builds every row
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: CheUsageCenterRoom(client: CheUsageCenterClient(baseUrl: 'https://che.test', headers: () => const {}, client: client), onSpeak: spoken.add),
    ));
    await tester.pumpAndSettle();
    return spoken;
  }

  testWidgets('renders every provenance as a word badge, labels every row and number, and stays silent on open', (tester) async {
    final semantics = tester.ensureSemantics();
    final spoken = await open(tester);
    expect(spoken, isEmpty, reason: 'passive screens stay silent');
    expect(find.byKey(const ValueKey('usage-banner')), findsNothing, reason: 'opening shows no result banner');
    expect(calls.single, startsWith('GET /api/usage'));
    for (final badge in ['OBSERVED', 'ESTIMATED', 'YOU TOLD ME', 'UNAVAILABLE']) {
      expect(find.text(badge), findsWidgets, reason: badge);
    }
    expect(find.text('unavailable'), findsNWidgets(2), reason: 'an unknown number is shown as unavailable, never as zero');
    expect(find.text('\$20.00'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Groq: connected\. Key test passed')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Modal GPU functions: not connected\.')), findsOneWidget);
    expect(find.bySemanticsLabel('Groq tokens today: 900 tokens (estimated; CHE\'s router count).'), findsOneWidget);
    expect(find.bySemanticsLabel('Token charge: unavailable. CHE reads no billing data from Groq.'), findsOneWidget);
    expect(find.bySemanticsLabel('Price: \$20.00 (you told me; per month).'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Alert: Kaggle')), findsOneWidget);
    expect(find.bySemanticsLabel('Read the Usage Center aloud'), findsOneWidget);
    expect(find.bySemanticsLabel('Refresh the Usage Center'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Save the subscription')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Remove the ChatGPT subscription record\. Asks you first')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^New subscription, in your own words')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('usage-read')));
    expect(spoken.single, startsWith('Usage Center. 2 services connected'), reason: 'Read Aloud speaks only when asked');
    semantics.dispose();
  });

  testWidgets('removing a subscription asks first; Keep removes nothing, Remove posts confirm and reports the real result', (tester) async {
    final spoken = await open(tester);
    await tester.tap(find.byKey(const ValueKey('usage-remove-sub_1')));
    await tester.pumpAndSettle();
    expect(spoken.last, startsWith('Remove your ChatGPT subscription record'), reason: 'the confirmation question is spoken');
    await tester.tap(find.byKey(const ValueKey('usage-remove-keep')));
    await tester.pumpAndSettle();
    expect(calls.where((c) => c.contains('/remove')), isEmpty);
    expect(find.text('Kept. Nothing was removed.'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('usage-remove-sub_1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('usage-remove-yes')));
    await tester.pumpAndSettle();
    expect(calls.where((c) => c.contains('/remove')).single, contains('"confirm":true'));
    expect(spoken.last, 'Removed the ChatGPT record from your Usage Center.');
    expect(find.byKey(const ValueKey('usage-banner')), findsOneWidget);
    expect(find.text('ChatGPT'), findsNothing, reason: 'reloaded after the removal');
  });

  testWidgets('voice routes on the open screen read on request and save a spoken subscription', (tester) async {
    final spoken = await open(tester);
    final state = tester.state<CheUsageCenterRoomState>(find.byType(CheUsageCenterRoom));
    expect(CheUsageCenterRoom.voiceHandler, isNotNull);
    expect(await state.voice('read aloud'), startsWith('Usage Center.'));
    expect(await state.voice('read my alerts'), startsWith('1 alert: 1. Kaggle'));
    expect(await state.voice('what subscriptions do I have'), contains('1. ChatGPT'));
    expect(spoken, isEmpty, reason: 'the voice handler returns text; the caller speaks it');
    final said = await state.voice('my Netflix subscription is 15.49 dollars a month');
    await tester.pumpAndSettle();
    expect(said, startsWith('Saved at 15:00 UTC'));
    expect(calls.any((c) => c.startsWith('POST /api/usage/subscriptions ') && c.contains('Netflix')), isTrue);
    expect(await state.voice('open the trading room'), isNull, reason: 'not for this screen');
  });

  testWidgets('a failed load shows quiet text, says nothing, and Read Aloud still works', (tester) async {
    client = MockClient((r) async => http.Response(jsonEncode({'detail': 'Only the CHE owner can read the Usage Center.'}), 403));
    final spoken = await open(tester);
    expect(spoken, isEmpty);
    expect(find.byKey(const ValueKey('usage-error')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('usage-read')));
    expect(spoken.single, contains('could not load: Only the CHE owner'));
  });
}
