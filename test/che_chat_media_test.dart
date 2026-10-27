import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/che_creations.dart';
import 'package:chey/home/che_chat_media.dart';

const videoId = '11111111-0000-4000-8000-000000000001';
const thumbId = '11111111-0000-4000-8000-0000000000aa';
const otherVideoId = '22222222-0000-4000-8000-000000000002';
const pictureId = 'f9e8d7c6-0000-4000-8000-000000000004';
const base = 'https://worker.example';

/// Records each screen pushed on the app's navigator, so a test can check which screen a tap opened.
class _PushRecorder extends NavigatorObserver {
  final List<Route<dynamic>> pushed = [];

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => pushed.add(route);
}

void main() {
  test('a reply carries only well-formed saved IDs, and a library list keeps only its videos', () {
    final extra = cheChatMediaExtra({
      'media_id': videoId,
      'media_type': 'video',
      'media_title': 'Harbour at dawn',
      'thumbnail_media_id': thumbId,
      'media': [
        {'media_id': videoId, 'media_type': 'video', 'title': 'Harbour at dawn', 'thumbnail_media_id': thumbId},
        {'media_id': otherVideoId, 'media_type': 'video', 'title': 'Night market'},
        {'media_id': pictureId, 'media_type': 'image', 'title': 'A picture'},
        {'media_id': 'javascript:alert(1)', 'media_type': 'video'},
        'not a map',
      ],
    });
    expect(extra['media_id'], videoId);
    expect(extra['thumbnail_media_id'], thumbId);
    expect(extra['media_title'], 'Harbour at dawn');
    final list = extra['media_list']!;
    expect(list, contains(videoId));
    expect(list, contains(otherVideoId));
    expect(list, isNot(contains(pictureId)));
    expect(list, isNot(contains('javascript')));

    expect(cheChatMediaExtra({'media_id': 'not an id!', 'media_type': 'video'}), isEmpty);
    expect(cheChatMediaExtra({'media_url': 'https://example.com/x.mp4'}), isEmpty);
  });

  test('the chat videos are the single video and the library list, one entry per ID, each with its thumbnail', () {
    final videos = cheChatVideos({
      'media_type': 'video',
      'media_id': videoId,
      'media_title': 'Harbour at dawn',
      'thumbnail_media_id': thumbId,
      'media_list': '[{"media_id":"$videoId","title":"Harbour at dawn","thumbnail_media_id":"$thumbId"},'
          '{"media_id":"$otherVideoId","title":"Night market"}]',
    });
    expect(videos.map((v) => v['id']), [videoId, otherVideoId]);
    expect(videos.first['thumbnail_media_id'], thumbId);
    expect(cheCreationThumbUrl(base, videos.first), '$base/api/media/$thumbId/image');
    expect(cheCreationThumbUrl(base, videos.last), isNull, reason: 'no thumbnail is invented when none is saved');
    expect(cheChatVideos({'media_type': 'image', 'media_id': pictureId}), isEmpty);
    expect(cheChatVideos({'media_list': 'not json'}), isEmpty);
  });

  testWidgets('a video in the chat shows its thumbnail as a tappable tile, labelled for VoiceOver', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheChatMediaExtras(
          item: const {'media_type': 'video', 'media_id': videoId, 'media_title': 'Harbour at dawn', 'thumbnail_media_id': thumbId},
          baseUrl: base,
          headers: const {},
        ),
      ),
    ));
    expect(find.bySemanticsLabel('Video: Harbour at dawn. Tap to play.'), findsOneWidget);
    expect(find.byIcon(Icons.play_circle_fill), findsOneWidget);
    // The thumbnail is an image widget that loads the saved thumbnail from CHE's own media route.
    final thumb = tester.widget<Image>(find.descendant(of: find.byType(CheCreationsTiles), matching: find.byType(Image)));
    final provider = thumb.image is ResizeImage ? (thumb.image as ResizeImage).imageProvider : thumb.image;
    expect((provider as NetworkImage).url, '$base/api/media/$thumbId/image');
  });

  testWidgets('a tap on a chat video opens it in the Creation viewer (the Create room)', (tester) async {
    final pushes = _PushRecorder();
    await tester.pumpWidget(MaterialApp(
      navigatorObservers: [pushes],
      home: Scaffold(
        body: CheChatMediaExtras(
          item: const {'media_type': 'video', 'media_id': videoId, 'media_title': 'Harbour at dawn', 'thumbnail_media_id': thumbId},
          baseUrl: base,
          headers: const {},
        ),
      ),
    ));
    await tester.tap(find.bySemanticsLabel('Video: Harbour at dawn. Tap to play.'));
    // The viewer's video player needs a WebView platform, which a unit test does not have. Building the pushed route
    // is what names the screen; the player build error is cleared here, not hidden from the route check below.
    tester.takeException();
    // The app's home route is the first push; the tap's screen is the last one.
    final route = pushes.pushed.last as MaterialPageRoute<void>;
    expect(route.settings.name, isNot('/'), reason: 'the tap opened a new screen, not the home route');
    final viewer = route.builder(tester.element(find.byType(MaterialApp))) as CheCreationViewer;
    expect(viewer.item['id'], videoId);
    expect(viewer.item['kind'], 'video');
    expect(viewer.baseUrl, base);
  });

  testWidgets('a saved picture in the chat has an "Open in Create room" button that opens that picture', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheChatMediaExtras(
          item: const {'media_type': 'image', 'media_id': pictureId, 'media_title': 'a lighthouse at dusk'},
          baseUrl: base,
          headers: const {},
        ),
      ),
    ));
    expect(find.byType(CheCreationsTiles), findsNothing, reason: 'a picture is shown by the chat image, not a video tile');
    await tester.tap(find.text('Open in Create room'));
    await tester.pumpAndSettle();
    final viewer = tester.widget<CheCreationViewer>(find.byType(CheCreationViewer));
    expect(viewer.item['id'], pictureId);
    expect(viewer.item['kind'], 'image');
    expect(find.text('a lighthouse at dusk'), findsOneWidget, reason: 'the viewer shows the picture title');
  });

  testWidgets('a reply with no saved media shows nothing extra', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheChatMediaExtras(item: const {'media_type': 'video', 'media_url': 'https://example.com/x.mp4'}, baseUrl: base, headers: const {}),
      ),
    ));
    expect(find.byType(CheCreationsTiles), findsNothing);
    expect(find.text('Open in Create room'), findsNothing);
  });
}
