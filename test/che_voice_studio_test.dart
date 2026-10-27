import 'dart:convert';

import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/che_voice_studio.dart';
import 'package:chey/security/che_session_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _connie = 'GO6k0TLODKW6FuTZ6xO5';
const _mike = 'zfc8CJQpe8Kqyl0vvCzo';

Map<String, Object?> _list({Map<String, Object?>? active}) => {
      'saved': [
        {'provider': 'elevenlabs', 'id': _connie, 'name': 'Connie', 'state': 'verified', 'reason': ''},
        {
          'provider': 'elevenlabs',
          'id': _mike,
          'name': 'Mike',
          'state': 'paid_plan',
          'reason': 'This voice needs a paid ElevenLabs plan before it can speak through the API.',
        },
      ],
      'active': active,
    };

http.Response _json(Object body, {int status = 200}) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Future<void> _pump(WidgetTester tester, http.Client client, {List<String>? spoken}) async {
  await tester.pumpWidget(MaterialApp(
    theme: CheTheme.dark(),
    home: Scaffold(body: CheVoiceIdsPanel(client: client, onSpeak: spoken?.add)),
  ));
  await tester.pumpAndSettle();
}

void main() {
  // Widget tests have no Keychain plugin: the sign-in lives in memory, fresh for every test.
  setUp(() => CheSessionStore.instance = CheSessionStore(kv: CheMemoryKv()));

  setUp(() {
    SharedPreferences.setMockInitialValues({
      'che_agent_base_url': 'https://che.test',
      'che_agent_device_token': 'mock-owner-token',
    });
  });

  testWidgets('Voice IDs lists saved voices with their checked state, and says why one cannot be used', (tester) async {
    final semantics = tester.ensureSemantics();
    final client = MockClient((r) async => _json(_list()));
    await _pump(tester, client);
    expect(find.text('Connie'), findsOneWidget);
    expect(find.text('Mike'), findsOneWidget);
    expect(find.textContaining('Checked: available to CHE'), findsOneWidget);
    // VoiceOver reads the name with each button, so "Use" alone is not announced.
    expect(find.bySemanticsLabel('Use Connie'), findsOneWidget);
    expect(find.bySemanticsLabel('Remove Connie'), findsOneWidget);
    expect(find.textContaining('paid ElevenLabs plan before it can speak'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('Save & Use Voice sends the pasted ID and name, with use set, and reports the saved name', (tester) async {
    final posted = <String>[];
    final spoken = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        posted.add(r.body);
        return _json({
          'ok': true,
          'state': 'verified',
          'saved': [
            {'provider': 'elevenlabs', 'id': 'NEWvoiceABCDEF12', 'name': 'Rachel', 'state': 'verified', 'reason': ''},
          ],
          'active': {'provider': 'elevenlabs', 'id': 'NEWvoiceABCDEF12', 'name': 'Rachel'},
          'message': 'Rachel is CHE’s voice now.',
        });
      }
      return _json(_list());
    });
    await _pump(tester, client, spoken: spoken);
    await tester.enterText(find.byType(TextField).at(0), 'NEWvoiceABCDEF12');
    await tester.enterText(find.byType(TextField).at(1), 'Rachel');
    await tester.scrollUntilVisible(find.text('Save & Use Voice'), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Save & Use Voice'));
    await tester.pumpAndSettle();
    expect(posted, hasLength(1));
    final body = jsonDecode(posted.single) as Map<String, dynamic>;
    expect(body['provider'], 'elevenlabs');
    expect(body['id'], 'NEWvoiceABCDEF12');
    expect(body['name'], 'Rachel');
    expect(body['use'], isTrue);
    expect(spoken.last, startsWith('Rachel is CHE’s voice now'));
    expect(find.textContaining('Using Rachel'), findsOneWidget);
  });

  testWidgets('a voice the provider cannot find is refused with its reason, and nothing is saved', (tester) async {
    final posted = <String>[];
    final spoken = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        posted.add(r.body);
        return _json({'ok': false, 'state': 'not_found', 'detail': 'ElevenLabs has no voice with this ID on your account. Check the ID.'}, status: 404);
      }
      return _json(_list());
    });
    await _pump(tester, client, spoken: spoken);
    await tester.enterText(find.byType(TextField).at(0), 'NOTonACCOUNT00000');
    await tester.enterText(find.byType(TextField).at(1), 'Ghost');
    await tester.scrollUntilVisible(find.text('Save & Use Voice'), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Save & Use Voice'));
    await tester.pumpAndSettle();
    expect(posted, hasLength(1));
    expect(spoken.last, 'Not saved: ElevenLabs has no voice with this ID on your account. Check the ID.');
    expect(find.textContaining('Using CHE’s built-in voice.'), findsOneWidget, reason: 'nothing was switched');
  });

  testWidgets('Remove asks first: cancelling sends nothing', (tester) async {
    final posted = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') posted.add(r.body);
      return _json(_list());
    });
    await _pump(tester, client);
    await tester.scrollUntilVisible(find.text('Remove').first, 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Remove').first);
    await tester.pumpAndSettle();
    expect(find.text('Remove Connie?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(posted, isEmpty, reason: 'nothing is removed without the owner\'s confirmation');
  });
}
