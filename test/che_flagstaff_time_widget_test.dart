import 'dart:convert';

import 'package:chey/mailbox/che_mail_time.dart';
import 'package:chey/mailbox/che_mailbox_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// The real Flagstaff screen with a fake Worker: conversations are ordered by the instant of their last message,
// not by the text of its timestamp, and times are the device-zone times of the UTC values.
void main() {
  final claude = {'id': 'c1', 'at': '2026-10-24T12:16:00-05:00', 'from': 'claude', 'to': 'che', 'text': 'Claude at 12:16 PM Central'};
  final chatgpt = {'id': 'g1', 'at': '2026-10-24T17:00:00Z', 'from': 'chatgpt', 'to': 'che', 'text': 'ChatGPT at 12:00 PM Central'};
  final client = MockClient((request) async {
    final body = switch (request.url.path) {
      '/api/flagstaff' => {'open': true, 'link': 'https://che.test/flagstaff/abcdefgh', 'messages': [claude, chatgpt], 'unread': 0},
      '/api/flagstaff/archive' => {
          'sessions': [
            {'id': 's1', 'locked_at': '2026-10-24T17:16:00.000Z', 'count': 1, 'messages': [claude]},
          ],
        },
      _ => <String, Object>{},
    };
    return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
  });

  Future<void> pump(WidgetTester tester, {int tab = 0}) async {
    await http.runWithClient(() async {
      await tester.pumpWidget(MaterialApp(
        home: CheMailboxScreen(baseUrl: 'https://che.test', headers: () => const {}, onSpeak: (_) {}, initialTab: tab),
      ));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
    }, () => client);
    await tester.pumpAndSettle();
  }

  testWidgets('the newest conversation by instant is listed first', (tester) async {
    await pump(tester);
    final claudeTop = tester.getTopLeft(find.text('Claude').first).dy;
    final chatgptTop = tester.getTopLeft(find.text('Chatgpt').first).dy;
    // As text, "2026-10-24T17:00:00Z" sorts after "2026-10-24T12:16:00-05:00"; as instants 17:16Z is newer.
    expect(claudeTop, lessThan(chatgptTop));
    expect(find.text(cheMailWhen(claude)), findsWidgets);
  });

  testWidgets('an archived session is titled in the device zone, not raw UTC', (tester) async {
    tester.view.physicalSize = const Size(1000, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await pump(tester, tab: 1);
    final title = find.text('Session ${cheMailStamp('2026-10-24T17:16:00.000Z')}');
    expect(find.textContaining('Session 2026-10-24 17:16'), findsNothing);
    expect(title, findsOneWidget);
  });
}
