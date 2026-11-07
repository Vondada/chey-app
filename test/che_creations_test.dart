import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/che_creations.dart';

const base = 'https://worker.example';

void main() {
  test('only pictures and videos with an id are kept, in the library order', () {
    final items = cheCreationsFrom({
      'items': [
        {'id': 'v1', 'kind': 'video', 'title': 'Sunrise'},
        {'id': 'i1', 'kind': 'image', 'title': 'Logo'},
        {'id': 'u1', 'kind': 'upload', 'title': 'Notes'},
        {'kind': 'video', 'title': 'No id'},
        'not a map',
      ],
    });
    expect(items.map((item) => item['id']), ['v1', 'i1']);
    expect(cheCreationsFrom('not json'), isEmpty);
    expect(cheCreationsFrom({'items': 'nope'}), isEmpty);
  });

  test('an uploaded picture is a creation; an uploaded document is not', () {
    final items = cheCreationsFrom({
      'items': [
        {'id': 'p1', 'kind': 'upload', 'mime_type': 'image/png', 'title': 'cat.png'},
        {'id': 'd1', 'kind': 'upload', 'mime_type': 'application/pdf', 'title': 'Notes.pdf'},
      ],
    });
    expect(items.map((item) => item['id']), ['p1']);
    expect(cheCreationFileUrl(base, items.single), '$base/api/media/p1/image');
  });

  test('a video plays its own file and shows its saved thumbnail; a picture is its own file', () {
    expect(cheCreationFileUrl(base, {'id': 'v1', 'kind': 'video'}), '$base/api/media/v1/video');
    expect(cheCreationFileUrl(base, {'id': 'i1', 'kind': 'image'}), '$base/api/media/i1/image');
    expect(cheCreationFileUrl(base, {'kind': 'image'}), isNull);
    expect(cheCreationThumbUrl(base, {'id': 'v1', 'kind': 'video', 'thumbnail_media_id': 't1'}), '$base/api/media/t1/image');
    expect(cheCreationThumbUrl(base, {'id': 'v1', 'kind': 'video'}), isNull);
    expect(cheCreationThumbUrl(base, {'id': 'i1', 'kind': 'image'}), '$base/api/media/i1/image');
  });

  testWidgets('each tile says what it is, and that a tap plays or views it', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheCreationsTiles(
          items: const [
            {'id': 'v1', 'kind': 'video', 'title': 'Sunrise'},
            {'id': 'i1', 'kind': 'image', 'title': 'Logo'},
          ],
          baseUrl: base,
          headers: const {},
        ),
      ),
    ));
    expect(find.bySemanticsLabel('Video: Sunrise. Tap to play.'), findsOneWidget);
    expect(find.bySemanticsLabel('Picture: Logo. Tap to view.'), findsOneWidget);
    expect(find.byIcon(Icons.play_circle_fill), findsOneWidget);
  });

  test('a saved video plays from its signed play link, asked for with the device token (the iPhone player drops headers)', () async {
    final seen = <String>[];
    final client = MockClient((req) async {
      seen.add('${req.method} ${req.url} ${req.headers['Authorization']}');
      return http.Response(jsonEncode({'url': '$base/api/media/v1/video?exp=1&sig=abc'}), 200);
    });
    final url = await cheVideoPlayUrl('$base/api/media/v1/video', {'Authorization': 'Bearer t'}, client: client);
    expect(url, '$base/api/media/v1/video?exp=1&sig=abc');
    expect(seen, ['POST $base/api/media/v1/link Bearer t']);
  });

  test('no play link is asked for without a token or for a non-video address, and a refused link is an error', () async {
    final client = MockClient((req) async => http.Response('{"detail":"no"}', 404));
    expect(await cheVideoPlayUrl('https://cdn.example/v.mp4', {'Authorization': 'Bearer t'}, client: client), 'https://cdn.example/v.mp4');
    expect(await cheVideoPlayUrl('$base/api/media/v1/video', const {}, client: client), '$base/api/media/v1/video');
    expect(cheVideoPlayUrl('$base/api/media/v1/video', {'Authorization': 'Bearer t'}, client: client), throwsException);
  });

  test('voice: a failed video is retried or read by words, and other words go to the chat', () {
    for (final w in ['try again', 'Try it again', 'CHE, retry', 'reload the video', 'play the video again please']) {
      expect(cheVideoLinkCommand(w), 'retry', reason: w);
    }
    for (final w in ['what happened?', "what's wrong", 'read the error']) {
      expect(cheVideoLinkCommand(w), 'read', reason: w);
    }
    for (final w in ['make a new video', 'try again tomorrow with Nova', 'open my scene']) {
      expect(cheVideoLinkCommand(w), isNull, reason: w);
    }
  });
}
