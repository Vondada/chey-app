import 'package:chey/che_video_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('Recent Videos lists only media_url receipts', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: CheVideoPage(
          videos: [
            {'title': 'Rendered', 'media_url': 'https://example.com/video.mp4'},
            {'title': 'Pending', 'link': 'https://example.com/not-a-file'},
          ],
        ),
      ),
    );

    expect(find.text('Rendered'), findsOneWidget);
    expect(find.text('https://example.com/video.mp4'), findsOneWidget);
    expect(find.text('Pending'), findsNothing);
  });

  testWidgets('Recent Videos keeps the exact empty state when no file exists',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: CheVideoPage(
          videos: [
            {'title': 'Pending'},
          ],
        ),
      ),
    );

    expect(find.text('No videos yet.'), findsOneWidget);
  });
}
