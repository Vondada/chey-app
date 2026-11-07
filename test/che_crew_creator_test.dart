import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:chey/film/che_crew_creator_screen.dart';

Map<String, dynamic> _profile(String id, {bool picture = false, int version = 0}) => {
      'id': id,
      'name': id == 'che' ? 'CHE' : '${id[0].toUpperCase()}${id.substring(1)}',
      'role': 'Security & Defense',
      'look': 'Black man in his 30s, black eye patch',
      'personality': 'protector of few words',
      'catchphrase': 'I watch. I protect.',
      'tells': 'a slow single nod',
      'voice': 'low and quiet',
      'signature': 'the eye patch',
      'outfit': '',
      'hair': '',
      'colours': ['black', 'gunmetal'],
      'accessories': <String>[],
      'references': picture ? [{'sha256': 'a' * 64, 'content_type': 'image/jpeg', 'bytes': 10, 'label': 'poster', 'primary': true}] : <Object>[],
      'primary': picture ? 'a' * 64 : null,
      'has_reference': picture,
      'version': version,
      'needs': picture ? '' : 'Add the reference picture',
      'history': <Object>[],
    };

void main() {
  test('spoken commands while the Crew Creator is open; other words fall through to the chat', () {
    expect(cheCrewCommand('Show Nova'), ('show', 'nova'));
    expect(cheCrewCommand('edit knox'), ('show', 'knox'));
    expect(cheCrewCommand('Che, go to Chay'), ('show', 'che'));
    expect(cheCrewCommand('next'), ('next', null));
    expect(cheCrewCommand('Add the picture'), ('add_picture', null));
    expect(cheCrewCommand('upload a reference photo from photos'), ('add_picture', null));
    expect(cheCrewCommand('use the newest picture'), ('use_newest', null));
    expect(cheCrewCommand('Undo.'), ('undo', null));
    expect(cheCrewCommand('save'), ('save', null));
    expect(cheCrewCommand('read it aloud'), ('read', null));
    for (final other in ['make a short story about the office', 'show me the news', 'what is the weather']) {
      expect(cheCrewCommand(other), isNull, reason: other);
    }
    expect(cheCrewMemberIn('give Vale goggles'), 'vale');
    expect(cheCrewIds.length, 10);
  });

  testWidgets('a member with no picture shows "Add the reference picture"; a picked JPEG is sent; Save sends the words',
      (tester) async {
    final posts = <String, Map<String, dynamic>>{};
    final client = MockClient((r) async {
      if (r.method == 'GET' && r.url.path == '/api/crew') {
        return http.Response(jsonEncode({'crew': [_profile('che'), _profile('knox')], 'said': '0 of 10 crew have their reference picture.'}), 200);
      }
      if (r.method == 'GET' && r.url.path == '/api/crew/knox') return http.Response(jsonEncode({'profile': _profile('knox')}), 200);
      if (r.method == 'POST') {
        posts[r.url.path] = Map<String, dynamic>.from(jsonDecode(r.body) as Map);
        final picture = r.url.path.endsWith('/reference');
        return http.Response(jsonEncode({'ok': true, 'said': picture ? "Added Knox's reference picture." : 'Saved.', 'profile': _profile('knox', picture: picture, version: 1)}), 200);
      }
      return http.Response('{}', 404);
    });
    final jpeg = Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    await tester.pumpWidget(MaterialApp(
      home: CheCrewCreatorScreen(
        client: CheCrewClient(baseUrl: 'https://che.test', headers: () => const {'Authorization': 'Bearer t'}, client: client),
        initialMember: 'knox',
        pickPicture: (_) async => jpeg,
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Add the reference picture'), findsOneWidget);
    expect(CheCrewCreatorScreen.voiceHandler, isNotNull, 'the screen takes spoken commands while open');
    await tester.tap(find.text('Add the reference picture'));
    await tester.pumpAndSettle();
    expect(base64Decode(posts['/api/crew/knox/reference']!['image_base64'] as String), jpeg);
    expect(find.textContaining("Added Knox's reference picture."), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'Catchphrase'), 'Nobody gets past me.');
    await tester.ensureVisible(find.text('Save'));
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(posts['/api/crew/knox']!['catchphrase'], 'Nobody gets past me.');
    expect(posts['/api/crew/knox']!['colours'], ['black', 'gunmetal']);
    await tester.pumpWidget(const SizedBox());
    expect(CheCrewCreatorScreen.voiceHandler, isNull, 'closed: chat words go back to the chat');
  });
}
