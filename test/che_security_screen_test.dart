import 'dart:convert';

import 'package:chey/security/che_secret_scan.dart';
import 'package:chey/security/che_security_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

void main() {
  test('Face ID contract: only the OS result (ok + method), the nonce and the scope are sent; nothing biometric', () async {
    final sent = <Map<String, dynamic>>[];
    final client = CheSecurityClient(
      baseUrl: 'https://che.test',
      headers: () => {},
      biometric: (_) async => true,
      client: MockClient((req) async {
        if (req.url.path.endsWith('/nonce')) return _json({'nonce': 'n1'});
        sent.add(Map<String, dynamic>.from(jsonDecode(req.body) as Map));
        return _json({'ok': true, 'session': 's1'});
      }),
    );
    expect(await client.faceIdSession('restore', 'why'), 's1');
    expect(sent.single.keys.toSet(), {'nonce', 'scope', 'assertion'});
    expect(sent.single['assertion'], {'ok': true, 'method': 'face_id'});
  });

  test('a failed or cancelled Face ID sends nothing and creates no session', () async {
    var calls = 0;
    final client = CheSecurityClient(
      baseUrl: 'https://che.test',
      headers: () => {},
      biometric: (_) async => false,
      client: MockClient((_) async { calls++; return _json({}); }),
    );
    expect(await client.faceIdSession('restore', 'why'), isNull);
    expect(calls, 0);
  });

  test('the phone-side secret check catches keys and plain password forms, not ordinary words', () {
    expect(cheLooksSecret('password hunter2'), isTrue);
    expect(cheLooksSecret('use ghp_${'a' * 30}'), isTrue);
    expect(cheLooksSecret('plan my week'), isFalse);
  });

  test('ordinary chat: passwords and keys are caught before sending; normal sentences about passwords are not', () {
    for (final s in ['my password hunter2', 'my gmail password is Tr0ub4dor!', 'password: s3cretvalue', 'the key is sk-proj-aB3dE6gH9jK2mN5pQ8sT', 'use ghp_${'a' * 32}']) {
      expect(cheChatLooksSecret(s), isTrue, reason: s);
    }
    for (final s in ['send me a password reset email', 'what is my password manager called', 'my pin code expired', 'plan my week']) {
      expect(cheChatLooksSecret(s), isFalse, reason: s);
    }
  });

  testWidgets('Security page: status as large text, Read Aloud on request, actions report real results', (tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    String? spoken;
    final posts = <String>[];
    final client = CheSecurityClient(
      baseUrl: 'https://che.test',
      headers: () => {},
      biometric: (_) async => false,
      client: MockClient((req) async {
        if (req.method == 'GET') {
          return _json({'status': 'Lockdown is off. No serious security events in the last day.', 'internal_only': true, 'events': [{'severity': 'medium', 'classification': 'contained', 'evidence': '1 credential-shaped value was redacted from chat history.', 'at': '2026-10-22T21:00:00.000Z'}]});
        }
        posts.add(req.url.path);
        return _json({'revoked': 2});
      }),
    );
    await tester.pumpWidget(MaterialApp(home: CheSecurityScreen(client: client, onSpeak: (t) => spoken = t)));
    await tester.pumpAndSettle();
    expect(find.text('Lockdown is off. No serious security events in the last day.'), findsOneWidget);
    expect(spoken, isNull, reason: 'nothing is spoken on open');
    await tester.tap(find.text('Read Aloud'));
    expect(spoken, contains('No serious security events'));
    expect(find.bySemanticsLabel(RegExp(r'^medium contained: 1 credential-shaped value')), findsOneWidget);
    await tester.tap(find.text('Revoke Sessions'));
    await tester.pumpAndSettle();
    expect(find.text('Revoked 2 Face ID sessions.'), findsOneWidget);
    // Turning external services back on needs Face ID; a failed Face ID changes nothing and sends nothing.
    await tester.tap(find.text('Allow External Services (Face ID)'));
    await tester.pumpAndSettle();
    expect(find.text('Face ID did not confirm, so nothing was changed.'), findsOneWidget);
    expect(posts, ['/api/security/revoke_sessions']);
  });
}
