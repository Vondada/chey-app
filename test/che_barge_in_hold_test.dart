// The owner asked "What's my favorite drink?", CHE answered "Sprite", and his
// "No, strawberry Sprite." spoken while she was still answering vanished: the
// iPhone recognizer's words were dropped because a request was in flight
// (voice.dart). Through the real app on a simulated iPhone: the words are held,
// shown in the composer, and sent as the next turn the moment her answer
// finishes, with that answer in the request's history.
import 'dart:async';
import 'dart:convert';

import 'package:chey/che_wake_match.dart';
import 'package:chey/main.dart';
import 'package:chey/security/che_session_store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  // Widget tests have no Keychain plugin: the sign-in lives in memory, fresh for every test.
  setUp(() => CheSessionStore.instance = CheSessionStore(kv: CheMemoryKv()));

  group('held utterance', () {
    test('keeps the newest words without a wake name; the wake name alone or silence is not held', () {
      final held = CheHeldUtterance();
      expect(held.hold('Chay'), isFalse);
      expect(held.hold('   '), isFalse);
      expect(held.isEmpty, isTrue);

      expect(held.hold('Hey Chay, no, strawberry Sprite.'), isTrue);
      expect(held.text, 'no, strawberry Sprite.');
      expect(held.hold('No, strawberry Sprite.'), isTrue, reason: 'newest wins');
      expect(held.text, 'No, strawberry Sprite.');

      expect(held.take(), 'No, strawberry Sprite.');
      expect(held.take(), isNull, reason: 'sent once');

      held.hold('No, strawberry Sprite.');
      held.drop();
      expect(held.isEmpty, isTrue, reason: 'New chat or Stop drops it');
    });
  });

  testWidgets('"No, strawberry Sprite." spoken while CHE answers is sent next, with her "Sprite" in history', (tester) async {
    SharedPreferences.setMockInitialValues({'che_agent_base_url': 'https://che.test', 'che_agent_device_token': 'test-device'});
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    // The iPhone's voice, on-device model and WebRTC plugins, idle here; the
    // recognizer's event stream is ours to speak into.
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    for (final name in ['che/native_voice', 'FlutterWebRTC.Method', 'che/local_ai']) {
      messenger.setMockMethodCallHandler(MethodChannel(name), (call) async => null);
    }
    MockStreamHandlerEventSink? recognizer;
    messenger.setMockStreamHandler(
      const EventChannel('che/native_voice_events'),
      MockStreamHandler.inline(onListen: (_, events) {
        recognizer = events;
      }),
    );
    messenger.setMockStreamHandler(const EventChannel('FlutterWebRTC.Event'), MockStreamHandler.inline(onListen: (_, _) {}));
    addTearDown(() {
      for (final name in ['che/native_voice', 'FlutterWebRTC.Method', 'che/local_ai']) {
        messenger.setMockMethodCallHandler(MethodChannel(name), null);
      }
      for (final name in ['che/native_voice_events', 'FlutterWebRTC.Event']) {
        messenger.setMockStreamHandler(EventChannel(name), null);
      }
    });

    // CHE's server: the owner's two turns are recorded; the first answer stays in
    // flight until the test lets it finish. The app's own startup chat requests
    // (its "coding status" check) get an empty answer and are not recorded.
    final chats = <Map<String, dynamic>>[];
    final firstAnswerMayFinish = Completer<void>();
    http.Response ndjson(String reply) => http.Response.bytes(
          utf8.encode('${jsonEncode({'type': 'delta', 'delta': reply})}\n${jsonEncode({'type': 'done', 'source': 'test'})}\n'),
          200,
          headers: {'content-type': 'application/x-ndjson'},
        );
    final client = MockClient((request) async {
      if (request.url.path == '/api/chat') {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        if (body['message'] == "What's my favorite drink?") {
          chats.add(body);
          await firstAnswerMayFinish.future;
          return ndjson('Sprite');
        }
        if (body['message'] == 'No, strawberry Sprite.') {
          chats.add(body);
          return ndjson('Strawberry Sprite. Noted, sir.');
        }
      }
      return http.Response('{}', 200, headers: {'content-type': 'application/json'});
    });

    Future<void> letTimePass(int rounds, {bool Function()? until}) async {
      for (var i = 0; i < rounds && !(until?.call() ?? false); i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
        await tester.pump(const Duration(milliseconds: 250));
      }
    }

    await http.runWithClient(() async {
      await tester.pumpWidget(const CHEApp());
      for (var i = 0; i < 15; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      await tester.tap(find.text('Chat'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.byTooltip('Show keyboard'));
      await tester.pump(const Duration(milliseconds: 300));

      await tester.enterText(find.byType(TextField).last, "What's my favorite drink?");
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await letTimePass(30, until: () => chats.isNotEmpty);
      expect(chats, hasLength(1), reason: 'the question is in flight');
      expect(chats.single['message'], "What's my favorite drink?");
      expect(recognizer, isNotNull, reason: 'the app listens to the iPhone recognizer');

      // He speaks over her answer.
      recognizer!.success({'type': 'utterance', 'text': 'No, strawberry Sprite.'});
      await letTimePass(4);
      expect(chats, hasLength(1), reason: 'nothing is sent while the first request is in flight');
      expect(tester.widget<TextField>(find.byType(TextField).last).controller!.text, 'No, strawberry Sprite.',
          reason: 'his words are visible in the composer, not lost');

      firstAnswerMayFinish.complete();
      await letTimePass(40, until: () => chats.length >= 2);
      expect(chats, hasLength(2), reason: 'his words were sent right after her answer, without him repeating them');
      final correction = chats[1];
      expect(correction['message'], 'No, strawberry Sprite.');
      final history = (correction['history'] as List).cast<Map>();
      expect(history, containsAllInOrder([
        {'role': 'user', 'content': "What's my favorite drink?"},
        {'role': 'assistant', 'content': 'Sprite'},
      ]));
      expect(history.last, {'role': 'assistant', 'content': 'Sprite'}, reason: 'the Worker sees the answer he is correcting');

      await letTimePass(20, until: () => find.textContaining('Strawberry Sprite. Noted, sir.').evaluate().isNotEmpty);
      expect(find.textContaining('Strawberry Sprite. Noted, sir.'), findsWidgets, reason: 'her new answer is shown as text');
      expect(find.text('No, strawberry Sprite.'), findsWidgets, reason: 'his correction is in the chat');

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    }, () => client);
    debugDefaultTargetPlatformOverride = null;
  });
}
