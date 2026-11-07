import 'dart:async';
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
    expect(cheCrewCommand('Show Nova'), ('show', 'nova', null));
    expect(cheCrewCommand('edit knox'), ('show', 'knox', null));
    expect(cheCrewCommand('Che, go to Chay'), ('show', 'che', null));
    expect(cheCrewCommand('next'), ('next', null, null));
    expect(cheCrewCommand('Add the picture'), ('add_picture', null, null));
    expect(cheCrewCommand('upload a reference photo from photos'), ('add_picture', null, null));
    expect(cheCrewCommand('use the newest picture'), ('use_newest', null, null));
    expect(cheCrewCommand('Undo.'), ('undo', null, null));
    expect(cheCrewCommand('save'), ('save', null, null));
    expect(cheCrewCommand('read it aloud'), ('read', null, null));
    // Every screen action by voice, numbered like the screen's lists (Codex #968).
    expect(cheCrewCommand('use picture 2 as the face'), ('face', null, 2));
    expect(cheCrewCommand('make picture two her face'), ('face', null, 2));
    expect(cheCrewCommand('remove picture 3'), ('remove', null, 3));
    expect(cheCrewCommand('go back to version 4'), ('revert', null, 4));
    expect(cheCrewCommand('revert to version two'), ('revert', null, 2));
    expect(cheCrewCommand('read the pictures'), ('read_pictures', null, null));
    expect(cheCrewCommand('read the versions'), ('read_versions', null, null));
    expect(cheCrewCommand('yes'), ('yes', null, null));
    expect(cheCrewCommand('no, keep it'), ('no', null, null));
    expect(cheCrewCommand('keep it'), ('no', null, null));
    for (final other in ['make a short story about the office', 'show me the news', 'what is the weather']) {
      expect(cheCrewCommand(other), isNull, reason: other);
    }
    expect(cheCrewMemberIn('give Vale goggles'), 'vale');
    expect(cheCrewIds.length, 10);
  });

  testWidgets('a member with no picture shows "Add the reference picture"; a picked JPEG is sent; Save sends the words',
      (tester) async {
    // Tall enough that the lazily built list builds every field and the Save button.
    tester.view.physicalSize = const Size(900, 4000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
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
    expect(CheCrewCreatorScreen.voiceHandler, isNotNull, reason: 'the screen takes spoken commands while open');
    await tester.tap(find.text('Add the reference picture'));
    await tester.pumpAndSettle();
    expect(base64Decode(posts['/api/crew/knox/reference']!['image_base64'] as String), jpeg);
    expect(find.textContaining("Added Knox's reference picture."), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('crew-catchphrase')));
    await tester.enterText(find.byKey(const Key('crew-catchphrase')), 'Nobody gets past me.');
    await tester.ensureVisible(find.byKey(const Key('crew-save')));
    await tester.tap(find.byKey(const Key('crew-save')));
    await tester.pumpAndSettle();
    expect(posts['/api/crew/knox']!['catchphrase'], 'Nobody gets past me.');
    expect(posts['/api/crew/knox']!['colours'], ['black', 'gunmetal']);
    await tester.pumpWidget(const SizedBox());
    expect(CheCrewCreatorScreen.voiceHandler, isNull, reason: 'closed: chat words go back to the chat');
  });

  testWidgets('removing a picture asks first, by voice and by touch; nothing is removed until yes (Codex #968)', (tester) async {
    tester.view.physicalSize = const Size(900, 4000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final posts = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'GET' && r.url.path == '/api/crew') return http.Response(jsonEncode({'crew': [_profile('knox', picture: true)], 'said': ''}), 200);
      if (r.method == 'GET' && r.url.path == '/api/crew/knox') return http.Response(jsonEncode({'profile': _profile('knox', picture: true)}), 200);
      if (r.method == 'POST') {
        posts.add(r.url.path);
        return http.Response(jsonEncode({'ok': true, 'said': 'Removed that picture from Knox. Say undo to bring it back.', 'profile': _profile('knox', version: 2)}), 200);
      }
      return http.Response('{}', 404);
    });
    await tester.pumpWidget(MaterialApp(
      home: CheCrewCreatorScreen(
        client: CheCrewClient(baseUrl: 'https://che.test', headers: () => const {}, client: client),
        initialMember: 'knox',
      ),
    ));
    await tester.pumpAndSettle();
    final voice = CheCrewCreatorScreen.voiceHandler!;
    expect(await voice('read the pictures'), "Knox's pictures: 1. poster (the face in films).");
    final asked = await voice('remove picture 1');
    expect(asked, "Remove Knox's picture 1? It is his face in films. Say yes to remove it, or no to keep it.");
    expect(posts, isEmpty, reason: 'nothing removed while waiting for an answer');
    expect(await voice('no'), "Kept Knox's picture 1.");
    expect(posts, isEmpty);

    // By touch: the chip's delete button opens a dialog; Keep it keeps it.
    await tester.tap(find.byTooltip('Remove picture 1 (asks first)'));
    await tester.pumpAndSettle();
    expect(find.text("Remove Knox's picture 1?"), findsOneWidget);
    await tester.tap(find.text('Keep it'));
    await tester.pumpAndSettle();
    expect(posts, isEmpty);

    await voice('remove picture 1');
    await voice('yes');
    await tester.pumpAndSettle();
    expect(posts, ['/api/crew/knox/remove-reference']);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('switching members: a slow answer for an earlier member never shows under another name (Codex #968)', (tester) async {
    tester.view.physicalSize = const Size(900, 4000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final slowNova = Completer<http.Response>();
    final client = MockClient((r) async {
      if (r.url.path == '/api/crew') return http.Response(jsonEncode({'crew': [_profile('che'), _profile('nova'), _profile('knox')], 'said': ''}), 200);
      if (r.url.path == '/api/crew/che') return http.Response(jsonEncode({'profile': {..._profile('che'), 'catchphrase': 'I see it all.'}}), 200);
      if (r.url.path == '/api/crew/nova') return slowNova.future;
      if (r.url.path == '/api/crew/knox') return http.Response(jsonEncode({'profile': _profile('knox')}), 200);
      return http.Response('{}', 404);
    });
    await tester.pumpWidget(MaterialApp(
      home: CheCrewCreatorScreen(client: CheCrewClient(baseUrl: 'https://che.test', headers: () => const {}, client: client)),
    ));
    await tester.pumpAndSettle();
    final voice = CheCrewCreatorScreen.voiceHandler!;
    unawaited(voice('show Nova'));
    await tester.pump();
    expect(tester.widget<FilledButton>(find.byKey(const Key('crew-save'))).onPressed, isNull, reason: 'no saving while a member loads');
    await voice('show Knox');
    await tester.pumpAndSettle();
    expect(find.text('Knox · Security & Defense'), findsOneWidget);
    slowNova.complete(http.Response(jsonEncode({'profile': {..._profile('nova'), 'catchphrase': 'stale'}}), 200));
    await tester.pumpAndSettle();
    expect(find.text('Knox · Security & Defense'), findsOneWidget, reason: 'the stale Nova answer is ignored');
    expect(find.text('stale'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
