// Privacy Center on the phone (owner, 2026-10-25; docs/CHE_PRIVACY_CENTER.md): the SSN guard before text leaves
// the iPhone, consent gating, the k-anonymity password check, stored actions, voice routes and the room's
// VoiceOver semantics with no speech on open.
import 'dart:convert';

import 'package:chey/main.dart';
import 'package:chey/rooms/che_privacy_center_room.dart';
import 'package:chey/security/che_password_vault.dart';
import 'package:chey/security/che_privacy_center.dart';
import 'package:chey/security/che_ssn_guard.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const ssn = '123-45-6789';

ChePrivacyCenter center({
  ChePrivacyStore? store,
  http.Client? client,
  List<CheVaultEntry> vault = const [],
  List<Uri>? opened,
  List<ChePrivacyService> connected = const [],
}) =>
    ChePrivacyCenter(
      store: store ?? ChePrivacyMemoryStore(),
      checker: CheBreachChecker(client: client ?? MockClient((_) async => http.Response('', 500))),
      vaultEntries: () async => vault,
      connectedServices: () async => connected,
      openLink: (uri) async {
        opened?.add(uri);
        return true;
      },
      now: () => DateTime.utc(2026, 10, 25, 12, 30),
    );

void main() {
  group('SSN guard (mirrors server/cloudflare/security_core/ssn.js)', () {
    test('finds formatted, spaced, bare and spoken SSNs with an SSN word', () {
      for (final text in [
        'My SSN is $ssn',
        'my social security number is 123 45 6789',
        'ssn 123456789',
        'my social is one two three four five six seven eight nine',
        'Social security: 1 2 3 dash 4 5 dash 6 7 8 9',
        '$ssn is my social',
        'ITIN 912-70-1234',
      ]) {
        expect(cheContainsSsn(text), isTrue, reason: text);
      }
      expect(cheRedactSsn('My SSN is $ssn, thanks'), 'My SSN is $cheSsnRedaction, thanks');
    });

    test('leaves phone numbers, last four, dates and plain nine-digit numbers alone', () {
      for (final text in [
        'Call me at 555-123-4567',
        'my phone is 555 123 4567',
        'the last four of my social are 6789',
        'order number 123456789 shipped',
        'meeting on 2026-10-25 at 10:30',
        'invalid shape 000-12-3456',
        'tracking 666-12-3456',
        'my social media has 123,456,789 views',
        'my social security office is on Main Street',
      ]) {
        expect(cheContainsSsn(text), isFalse, reason: text);
      }
    });

    test('a turn that starts an SSN hands live voice to the iPhone recognizer', () {
      expect(cheIsSsnTurn('my social security number is'), isTrue);
      expect(cheIsSsnTurn('what is the weather'), isFalse);
    });
  });

  group('consent', () {
    test('off by default: nothing is kept, inventory, actions and the password check refuse', () async {
      final store = ChePrivacyMemoryStore();
      final c = center(store: store, vault: const [CheVaultEntry(site: 'gmail', password: 'hunter2')]);
      await c.load();
      expect(c.state.on, isFalse);
      expect(await c.addService('Chase'), contains('is off'));
      expect(await c.act('spokeo', 'Spokeo', 'monitor'), contains('is off'));
      expect(await c.checkPasswords(), contains('is off'));
      expect(store.value, isNull, reason: 'nothing written while off');
    });

    test('"turn on" records the time and the owner\'s words; "turn off" deletes only after yes', () async {
      final store = ChePrivacyMemoryStore();
      final c = center(store: store, connected: const [ChePrivacyService(name: 'Gmail', source: 'Connected in CHE')]);
      final command = cheParsePrivacyVoice('CHE, turn on Privacy Center.')!;
      expect(command.op, ChePrivacyOp.turnOn);
      final on = await c.handle(command);
      expect(on, contains('2026-10-25T12:30:00.000Z'));
      expect(on, contains('"CHE, turn on Privacy Center."'));
      expect(c.inventory.map((s) => s.name), ['Gmail']);
      final saved = jsonDecode(store.value!) as Map;
      expect(saved['consent'], {'at': '2026-10-25T12:30:00.000Z', 'words': 'CHE, turn on Privacy Center.'});
      expect(store.value, isNot(contains('token')));

      await c.addService('Chase');
      expect(await c.handle(cheParsePrivacyVoice('turn off privacy center')!), contains('Say yes to delete it'));
      expect(cheParsePrivacyVoice('yes', awaitingYes: c.awaitingTurnOff)!.op, ChePrivacyOp.yes);
      expect(await c.handle(cheParsePrivacyVoice('no', awaitingYes: true)!), contains('nothing was deleted'));
      expect(store.value, isNotNull);
      await c.requestTurnOff();
      expect(await c.handle(cheParsePrivacyVoice('yes', awaitingYes: true)!), contains('nothing is left'));
      expect(store.value, isNull);
      expect(c.state.on, isFalse);
      expect(cheParsePrivacyVoice('yes'), isNull, reason: 'a bare yes means nothing when no question is waiting');
    });
  });

  group('password breach check (Have I Been Pwned range API, k-anonymity)', () {
    test('only the first five hex characters of the SHA-1 leave the phone; the match is made here', () async {
      final requests = <http.Request>[];
      const password = 'P@ssw0rd-Example';
      final hash = CheBreachChecker.sha1Hex(password);
      final client = MockClient((r) async {
        requests.add(r);
        // A real match, a non-match and a padding row (count 0).
        return http.Response('${hash.substring(5)}:42\r\n0000000000000000000000000000000000A:3\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0', 200);
      });
      final store = ChePrivacyMemoryStore();
      final c = center(store: store, client: client, vault: const [CheVaultEntry(site: 'gmail', password: password, username: 'me@example.com')]);
      await c.turnOn('turn on Privacy Center');
      final spoken = await c.checkPasswords();
      expect(requests, hasLength(1));
      final r = requests.single;
      expect(r.url.toString(), 'https://api.pwnedpasswords.com/range/${hash.substring(0, 5)}');
      expect(r.url.pathSegments.last, matches(RegExp(r'^[0-9A-F]{5}$')));
      expect(r.headers['Add-Padding'], 'true');
      final wire = '${r.url} ${r.headers} ${r.body}';
      expect(wire, isNot(contains(password)));
      expect(wire, isNot(contains(hash.substring(5))), reason: 'the suffix never leaves the phone');
      expect(wire, isNot(contains('me@example.com')));
      expect(spoken, contains('gmail, seen 42 times'));
      expect(spoken, isNot(contains(password)));
      expect(store.value, isNot(contains(password)));
      expect(store.value, isNot(contains(hash)));
    });

    test('a password that is not in the corpus, and a failed request, are reported honestly', () async {
      final client = MockClient((r) async => r.url.path.endsWith(CheBreachChecker.sha1Hex('ok-one').substring(0, 5))
          ? http.Response('0123456789ABCDEF0123456789ABCDEF012:7', 200)
          : http.Response('busy', 503));
      final c = center(client: client, vault: const [CheVaultEntry(site: 'a.com', password: 'ok-one'), CheVaultEntry(site: 'b.com', password: 'other')]);
      await c.turnOn('turn on Privacy Center');
      final spoken = await c.checkPasswords();
      expect(spoken, contains('1 not found in any known breach'));
      expect(spoken, contains('Could not check b.com: Have I Been Pwned answered 503'));
    });
  });

  group('per-item actions', () {
    test('MONITOR / REQUEST REMOVAL / IGNORE / MARK RESOLVED persist with timestamps across a restart', () async {
      final store = ChePrivacyMemoryStore();
      final opened = <Uri>[];
      final c = center(store: store, opened: opened);
      await c.turnOn('turn on Privacy Center');
      c.speakBrokers();
      final removal = await c.handle(cheParsePrivacyVoice('request removal for number 2', inRoom: true)!);
      expect(opened.single.toString(), 'https://www.spokeo.com/optout');
      expect(removal, contains('I did not submit anything'));
      expect(removal, isNot(contains('removed from')));
      await c.handle(cheParsePrivacyVoice('monitor number 3', inRoom: true)!);
      await c.handle(cheParsePrivacyVoice('ignore number 4', inRoom: true)!);
      expect(await c.handle(cheParsePrivacyVoice('mark number 2 resolved', inRoom: true)!), contains('on your word'));

      final again = center(store: store);
      await again.load();
      expect(again.state.latest('spokeo')!.action, 'resolved');
      expect(again.state.actions['spokeo']!.map((a) => a.action), ['request_removal', 'resolved']);
      expect(again.state.latest('peoplefinders')!.action, 'monitor');
      expect(again.state.latest('whitepages')!.at, '2026-10-25T12:30:00.000Z');
    });

    test('services added by voice are names only and take actions too', () async {
      final c = center();
      await c.turnOn('turn on Privacy Center');
      expect((await c.handle(cheParsePrivacyVoice('add chase bank to my privacy list', inRoom: true)!)), contains('Added Chase Bank'));
      c.speakServices();
      expect(await c.handle(cheParsePrivacyVoice('monitor number 1', inRoom: true)!), contains('Monitor: Chase Bank'));
    });
  });

  test('every broker and official link is https, and unconfirmed addresses say so', () {
    for (final l in [...cheDataBrokers, ...cheOfficialPrivacyLinks]) {
      expect(Uri.parse(l.url).scheme, 'https', reason: l.name);
    }
    expect(cheDataBrokers.where((b) => !b.verified).every((b) => b.verification.contains('not confirmed')), isTrue);
  });

  group('room', () {
    testWidgets('opens silently, labels every control for VoiceOver, and speaks only on Read Aloud or an action', (tester) async {
      final spoken = <String>[];
      final c = center();
      await tester.pumpWidget(MaterialApp(home: ChePrivacyCenterRoom(center: c, onSpeak: spoken.add, onListen: () {})));
      await tester.pumpAndSettle();
      expect(spoken, isEmpty, reason: 'no speech on open');
      expect(ChePrivacyCenterRoom.isOpen, isTrue);
      expect(find.bySemanticsLabel(RegExp('^Read Aloud')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('^Turn on Privacy Center')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('^Open Equifax security freeze')), findsOneWidget);
      expect(find.textContaining('CHE never keeps a Social Security number'), findsOneWidget);

      await tester.tap(find.text('Read Aloud'));
      await tester.pumpAndSettle();
      expect(spoken.single, startsWith('Privacy Center. It is off'));

      await tester.tap(find.text('Turn on'));
      await tester.pumpAndSettle();
      expect(spoken.last, startsWith('The Privacy Center is on.'));
      final scroller = find.byType(Scrollable).first;
      await tester.scrollUntilVisible(find.bySemanticsLabel(RegExp('^Check my passwords for breaches')), 200, scrollable: scroller);
      expect(find.bySemanticsLabel(RegExp('^Check my passwords for breaches')), findsOneWidget);
      await tester.scrollUntilVisible(find.bySemanticsLabel(RegExp('^Request removal from Spokeo')), 300, scrollable: find.byType(Scrollable).first);
      expect(find.bySemanticsLabel(RegExp('^Monitor Spokeo')), findsOneWidget);

      // Every tappable control carries a label.
      final buttons = find.byWidgetPredicate((w) => w is OutlinedButton, skipOffstage: false).evaluate().length;
      final wrapped = tester
          .widgetList<Semantics>(find.byWidgetPredicate((w) => w is Semantics && w.child is OutlinedButton, skipOffstage: false))
          .where((s) => s.properties.button == true && (s.properties.label ?? '').isNotEmpty)
          .length;
      expect(buttons, greaterThan(4));
      expect(find.byTooltip('Talk to CHE about the Privacy Center'), findsOneWidget, reason: 'the mic button is labelled by its tooltip');
      expect(wrapped, buttons, reason: 'every button in the room has its own VoiceOver label');

      // A voice action while the room is open: answered by the room, with a banner.
      final reply = await ChePrivacyCenterVoice.handler!('monitor number 2');
      await tester.pumpAndSettle();
      expect(reply, contains('Monitor: Spokeo'));
      expect(spoken.where((s) => s.contains('Monitor: Spokeo')), isEmpty, reason: 'chat speaks a voice reply once; the room only shows it');
      await tester.scrollUntilVisible(find.text(reply!), -300, scrollable: scroller);
      expect(find.text(reply), findsOneWidget, reason: 'the result is shown as a banner too');
    });
  });

  group('chat send pipeline', () {
    testWidgets('an SSN typed in chat never reaches the server; Privacy Center turns stay on the phone', (tester) async {
      SharedPreferences.setMockInitialValues({'che_agent_base_url': 'https://che.test', 'che_agent_device_token': 'test-device'});
      FlutterSecureStorage.setMockInitialValues({});
      final bodies = <String>[];
      final client = MockClient((r) async {
        bodies.add('${r.url} ${r.body}');
        if (r.url.path == '/api/chat') return http.Response('{"type":"delta","delta":"ok"}\n{"type":"done"}\n', 200, headers: {'content-type': 'application/x-ndjson'});
        return http.Response('{}', 200, headers: {'content-type': 'application/json'});
      });
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      // The iPhone's voice, on-device model and WebRTC plugins, idle here (as in che_barge_in_hold_test).
      final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      const channels = ['che/native_voice', 'FlutterWebRTC.Method', 'che/local_ai'];
      for (final name in channels) {
        messenger.setMockMethodCallHandler(MethodChannel(name), (call) async => null);
      }
      addTearDown(() {
        for (final name in channels) {
          messenger.setMockMethodCallHandler(MethodChannel(name), null);
        }
      });
      await http.runWithClient(() async {
        await tester.pumpWidget(const CHEApp());
        for (var i = 0; i < 15; i++) {
          await tester.pump(const Duration(milliseconds: 200));
        }
        await tester.tap(find.text('Chat'));
        await tester.pump(const Duration(milliseconds: 500));
        await tester.tap(find.byTooltip('Show keyboard'));
        await tester.pump(const Duration(milliseconds: 300));
        Future<void> send(String words) async {
          await tester.enterText(find.byType(TextField).last, words);
          await tester.testTextInput.receiveAction(TextInputAction.send);
          for (var i = 0; i < 20; i++) {
            await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
            await tester.pump(const Duration(milliseconds: 150));
          }
        }

        bool reachedChat(String words) => bodies.any((b) => b.contains('/api/chat') && b.contains(words));

        bodies.clear();
        await send('Tell me a fun fact about owls');
        expect(reachedChat('fun fact about owls'), isTrue, reason: 'the pipeline sends ordinary words');

        bodies.clear();
        await send('My SSN is $ssn, remember it');
        expect(bodies.where((b) => b.contains('6789')), isEmpty, reason: 'the SSN never left the phone');
        expect(find.textContaining('never stores a Social Security number'), findsWidgets);
        await send('Tell me a fun fact about otters');
        expect(reachedChat('fun fact about otters'), isTrue, reason: 'chat still works after the SSN turn');

        bodies.clear();
        await send('my social security number is one two three four five six seven eight nine');
        expect(bodies.where((b) => b.contains('seven eight nine')), isEmpty, reason: 'the spoken SSN never left the phone');

        bodies.clear();
        await send('turn on Privacy Center');
        expect(bodies.where((b) => b.contains('/api/chat')), isEmpty, reason: 'consent is recorded on the phone, not sent to the server');
        expect(find.textContaining('The Privacy Center is on.', skipOffstage: false), findsWidgets);
        expect(find.byType(ChePrivacyCenterRoom), findsOneWidget, reason: 'the room opened');
      }, () => client);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    });
  });
}
