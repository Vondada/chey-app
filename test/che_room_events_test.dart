// Build 2 (owner, 2026-10-20): the phone's rooms post their activity to CHE's
// Brain. The payloads match the Worker's allowlist, a screen event carries only
// its name, and a failed post is silent (false, never an exception).
import 'dart:convert';

import 'package:chey/brain/che_room_events.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  final at = DateTime.utc(2026, 10, 20, 12);
  const headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer t'};

  test('payloads use the Worker\'s rooms, kinds and key shape', () {
    final music = CheRoomEvents.music('Blue in Green Miles Davis', detail: 'Opened a search.', at: at)!;
    expect(music['room'], 'music');
    expect(music['kind'], 'played');
    expect(music['title'], 'Blue in Green Miles Davis');
    expect(RegExp(r'^[A-Za-z0-9:._-]{4,80}$').hasMatch(music['key']!), isTrue);
    expect(CheRoomEvents.music('', at: at), isNull);
    expect(CheRoomEvents.music('x', kind: 'deleted', at: at), isNull);

    final help = CheRoomEvents.help('What does Emergency Stop do?', screen: 'Trading Room', at: at)!;
    expect(help['kind'], 'explained');
    expect(help['detail'], contains('Trading Room'));
    final walk = CheRoomEvents.help('walk me through this screen', walkthrough: true, screen: 'Trading Room', at: at)!;
    expect(walk['kind'], 'walkthrough');
    expect(walk['title'], 'Walkthrough of Trading Room');

    final screen = CheRoomEvents.screen('Trading Room', at: at)!;
    expect(screen.keys.toSet(), {'room', 'kind', 'key', 'title'}, reason: 'a screen event carries only its name');
    expect(CheRoomEvents.music('a' * 400, at: at)!['title']!.length, 200);
    expect(CheRoomEvents.keyFor('help', at), isNot(CheRoomEvents.keyFor('help', at)), reason: 'two activities never share a key');
  });

  test('post sends one authenticated request and is silent on failure', () async {
    final seen = <http.Request>[];
    final ok = await CheRoomEvents.post(
      baseUrl: 'https://che.example/',
      headers: headers,
      event: CheRoomEvents.screen('Music Room', at: at),
      client: MockClient((request) async {
        seen.add(request);
        return http.Response('{"ok":true,"queued":true}', 200);
      }),
    );
    expect(ok, isTrue);
    expect(seen.single.url.toString(), 'https://che.example/api/brain/room-event');
    expect(seen.single.headers['Authorization'], 'Bearer t');
    expect(jsonDecode(seen.single.body)['room'], 'screen');

    expect(await CheRoomEvents.post(baseUrl: 'https://che.example', headers: headers, event: CheRoomEvents.screen('x', at: at),
        client: MockClient((_) async => http.Response('{"detail":"no"}', 403))), isFalse);
    expect(await CheRoomEvents.post(baseUrl: 'https://che.example', headers: headers, event: CheRoomEvents.screen('x', at: at),
        client: MockClient((_) async => throw http.ClientException('offline'))), isFalse);
    // No device token, no request.
    var calls = 0;
    expect(await CheRoomEvents.post(baseUrl: 'https://che.example', headers: const {'Content-Type': 'application/json'}, event: CheRoomEvents.screen('x', at: at),
        client: MockClient((_) async { calls++; return http.Response('{}', 200); })), isFalse);
    expect(calls, 0);
  });
}
