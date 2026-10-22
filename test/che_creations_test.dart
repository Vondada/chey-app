import 'package:flutter/material.dart';
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
}
