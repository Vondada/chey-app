// Owner, 2026-10-25: "Open and display saved image <id>". The Worker retrieves; only the phone's image load proves the
// picture is displayed. These tests drive CheChatImage with real PNG bytes and with a failing image.
import 'dart:convert';
import 'dart:typed_data';

import 'package:chey/widgets/che_chat_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// A real 1x1 PNG (the same bytes the Worker test stores).
final _png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

Widget _host(ImageProvider image, void Function(bool, String) onResult) => MaterialApp(
      home: Scaffold(
        body: CheChatImage(
          image: image,
          label: 'Saved image 6e0912e2-1aa2-438b-8a6e-0602de2218b1',
          onResult: onResult,
        ),
      ),
    );

void main() {
  testWidgets('a decoded image reports shown once, says so quietly, and carries its VoiceOver label', (tester) async {
    final results = <bool>[];
    await tester.runAsync(() async {
      await tester.pumpWidget(_host(MemoryImage(_png), (shown, _) => results.add(shown)));
      for (var i = 0; i < 20 && results.isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
        await tester.pump();
      }
    });
    await tester.pump();
    expect(results, [true]);
    expect(find.text('Shown on this screen.'), findsOneWidget);
    expect(find.bySemanticsLabel('Saved image 6e0912e2-1aa2-438b-8a6e-0602de2218b1'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    expect(results, [true], reason: 'reported once, not on every rebuild');
  });

  testWidgets('bytes that are not an image report failed and never say shown', (tester) async {
    final results = <bool>[];
    await tester.runAsync(() async {
      await tester.pumpWidget(_host(MemoryImage(Uint8List.fromList(utf8.encode('not a picture'))), (shown, _) => results.add(shown)));
      for (var i = 0; i < 20 && results.isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
        await tester.pump();
      }
    });
    await tester.pump();
    expect(results, [false]);
    expect(find.text('Shown on this screen.'), findsNothing);
    expect(find.text('CHE retrieved this image, but this iPhone could not display it.'), findsOneWidget);
  });
}
