// Visual Studio on the iPhone: every control sends a real operation to the project, VoiceOver hears useful
// labels ("Brightness, 15 percent", "Picture clip 1, Intro, 6.0 seconds", "Trim start"), and labels are not cut off
// at larger text on an iPhone-width screen.
import 'dart:convert';

import 'package:chey/visual/che_image_editor.dart';
import 'package:chey/visual/che_video_editor.dart';
import 'package:chey/visual/che_visual_client.dart';
import 'package:chey/visual/che_visual_studio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> imageView() => {
      'project': {'id': 'p1', 'title': 'Cover', 'kind': 'image', 'can_undo': true, 'can_redo': false, 'versions': [{'id': 'v0', 'label': 'Original'}]},
      'doc': {
        'kind': 'image', 'preset': 'square', 'canvas': {'w': 1080, 'h': 1080, 'background': '#000000'},
        'adjust': {'brightness': 15, 'contrast': 0}, 'filter': 'original',
        'transform': {'crop': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'rotate': 0, 'straighten': 0, 'flip_h': false, 'flip_v': false},
        'layers': [
          {'id': 'l1', 'type': 'text', 'name': 'Title', 'x': 0.1, 'y': 0.1, 'w': 0.8, 'h': 0.1, 'opacity': 1, 'hidden': false, 'text': {'value': 'NIGHT SHIFT', 'size': 0.08, 'weight': 800, 'color': '#FFFFFF', 'align': 'center'}},
        ],
      },
      'timeline': [],
      'suggestions': [
        {'id': 'readable_l1', 'text': '"NIGHT SHIFT" has no outline.', 'fix': 'Fix', 'ops': [{'op': 'edit_layer', 'id': 'l1'}]},
      ],
    };

Map<String, dynamic> videoView() => {
      'project': {'id': 'v1', 'title': 'Promo', 'kind': 'video', 'can_undo': false, 'can_redo': false, 'versions': [], 'render': {'stage': 'failed', 'error': 'The render failed on GitHub (Actions run 9).'}},
      'doc': {
        'kind': 'video', 'preset': 'tiktok', 'canvas': {'w': 1080, 'h': 1920, 'fps': 30}, 'adjust': {}, 'filter': 'original',
        'clips': [
          {'id': 'c1', 'asset': 'img1', 'kind': 'image', 'name': 'Intro', 'in': 0, 'out': 6, 'speed': 1, 'volume': 1, 'transition': {'type': 'cut', 'duration': 0}, 'adjust': {}},
          {'id': 'c2', 'asset': 'img2', 'kind': 'image', 'name': 'Verse', 'in': 0, 'out': 4, 'speed': 1, 'volume': 1, 'transition': {'type': 'cut', 'duration': 0}, 'adjust': {}},
        ],
        'audio': [{'id': 'a1', 'asset': 'song', 'name': 'Night Shift', 'role': 'music', 'volume': 0.8, 'start': 0}],
        'text': [{'id': 't1', 'text': 'HOOK', 'start': 0, 'end': 3, 'layer': {'id': 't1', 'type': 'text', 'name': 'Hook', 'x': 0.1, 'y': 0.1, 'w': 0.8, 'h': 0.1, 'text': {'value': 'HOOK', 'size': 0.06}}}],
        'captions': {'cues': [{'id': 'k1', 'start': 1, 'end': 2, 'text': 'hello'}], 'style': 'caption_clean', 'position': 0.78},
      },
      'timeline': [
        {'id': 'c1', 'start': 0, 'end': 6, 'length': 6, 'index': 0},
        {'id': 'c2', 'start': 6, 'end': 10, 'length': 4, 'index': 1},
      ],
      'suggestions': [],
    };

class FakeCheServer {
  final posts = <Map<String, dynamic>>[];
  late final http.Client client = MockClient((req) async {
    if (req.method == 'POST') {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      posts.add(body);
      if (body['action'] == 'waveform') return http.Response(jsonEncode({'peaks': [0.1, 0.5, 0.9, 0.4]}), 200);
      if (body['action'] == 'compare') return http.Response(jsonEncode({'a': imageView()['doc']}), 200);
      if (body['action'] == 'create') return http.Response(jsonEncode(imageView()), 200);
      final view = body['project_id'] == 'v1' ? videoView() : imageView();
      return http.Response(jsonEncode({...view, 'said': 'Done.'}), 200);
    }
    if (req.url.path == '/api/media') return http.Response(jsonEncode({'items': []}), 200);
    if (req.url.queryParameters['project_id'] == 'v1') return http.Response(jsonEncode(videoView()), 200);
    if (req.url.queryParameters['project_id'] == 'p1') return http.Response(jsonEncode(imageView()), 200);
    if (req.url.path.startsWith('/api/media/')) return http.Response('', 404);
    return http.Response(jsonEncode({
      'projects': [imageView()['project'], videoView()['project']],
      'templates': [
        {'id': 'album-cover', 'name': 'Album Cover', 'category': 'Album Cover', 'kind': 'image', 'system': true, 'doc': imageView()['doc']},
        {'id': 'tiktok-hook', 'name': 'TikTok Hook', 'category': 'TikTok', 'kind': 'video', 'system': true, 'doc': videoView()['doc']},
      ],
    }), 200);
  });
  CheVisualClient get visual => CheVisualClient(baseUrl: () => 'https://che.test', headers: () => const {}, client: client);
}

Widget app(Widget child, {double textScale = 1.0}) => MaterialApp(
      theme: ThemeData.dark(useMaterial3: true),
      home: MediaQuery(data: MediaQueryData(size: const Size(390, 844), textScaler: TextScaler.linear(textScale)), child: child),
    );

Future<void> tapVisible(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f.first);
  await tester.pumpAndSettle();
  await tester.tap(f.first);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('image editor: adjustments speak their value and send real operations; undo, text and layers work', (tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final server = FakeCheServer();
    await tester.pumpWidget(app(CheImageEditor(client: server.visual, projectId: 'p1')));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('Brightness, 15 percent'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Title text, NIGHT SHIFT')), findsOneWidget);
    await tapVisible(tester, find.text('Brightness up'));
    expect(server.posts.last, {'action': 'op', 'project_id': 'p1', 'op': {'op': 'adjust', 'key': 'brightness', 'delta': 5}});
    await tapVisible(tester, find.byTooltip('Undo'));
    expect(server.posts.last['action'], 'undo');
    await tapVisible(tester, find.text('Fix'));
    expect(server.posts.last['action'], 'ops', reason: 'a suggestion runs its real operations');
    await tapVisible(tester, find.text('Text'));
    await tapVisible(tester, find.text('Add text'));
    await tester.enterText(find.byType(TextField).last, 'NEW SINGLE');
    await tapVisible(tester, find.text('Done'));
    final added = server.posts.last['op'] as Map;
    expect(added['op'], 'add_layer');
    expect((added['layer'] as Map)['value'], 'NEW SINGLE');
    await tapVisible(tester, find.text('Layers'));
    await tester.tap(find.byTooltip('Bring forward').first);
    await tester.pumpAndSettle();
    expect((server.posts.last['op'] as Map)['dir'], 'forward');
    await tapVisible(tester, find.text('Looks'));
    await tapVisible(tester, find.text('Cinematic'));
    expect(server.posts.last['op'], {'op': 'filter', 'name': 'cinematic'});
  });

  testWidgets('image editor: CHE edits from words go to the open project', (tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final server = FakeCheServer();
    await tester.pumpWidget(app(CheImageEditor(client: server.visual, projectId: 'p1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'make the text easier to read');
    await tapVisible(tester, find.byTooltip('Send edit to CHE'));
    expect(server.posts.last['action'], 'words');
    expect(server.posts.last['text'], 'make the text easier to read');
  });

  testWidgets('video editor: visual timeline speaks clips; transport, split, trim, reorder, captions and a failed render with Retry', (tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final server = FakeCheServer();
    await tester.pumpWidget(app(CheVideoEditor(client: server.visual, projectId: 'v1')));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel(RegExp(r'^Picture clip 1, Intro, 6\.0 seconds, selected')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Picture clip 2, Verse, 4\.0 seconds')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'music track Night Shift, volume 80 percent')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Caption: hello, 1\.0 to 2\.0 seconds')), findsOneWidget);
    for (final t in ['Back 15 seconds', 'Back 10 seconds', 'Play', 'Forward 10 seconds', 'Forward 15 seconds']) {
      expect(find.byTooltip(t), findsOneWidget, reason: t);
    }
    await tester.tap(find.byTooltip('Forward 10 seconds'));
    await tester.pump();
    expect(find.bySemanticsLabel('Playhead 10.0 of 10.0 seconds'), findsOneWidget);
    await tester.tap(find.byTooltip('Back 10 seconds'));
    await tester.pump();
    expect(find.bySemanticsLabel('Playhead 0.0 of 10.0 seconds'), findsOneWidget);
    await tester.tap(find.byTooltip('Play'));
    await tester.pump();
    expect(find.byTooltip('Pause'), findsOneWidget);
    await tester.tap(find.byTooltip('Pause'));
    await tester.pump();
    await tapVisible(tester, find.text('Trim start'));
    expect(server.posts.last['op'], {'op': 'trim', 'clip': 'c1', 'trim_start': 0.5});
    await tapVisible(tester, find.text('Move clip right'));
    expect(server.posts.last['op'], {'op': 'reorder', 'clip': 'c1', 'dir': 'right'});
    await tapVisible(tester, find.text('Split'));
    expect((server.posts.last['op'] as Map)['op'], 'split');
    expect(find.textContaining('Render: FAILED'), findsOneWidget);
    await tapVisible(tester, find.text('Retry'));
    expect(server.posts.last['action'], 'retry_render');
    await tapVisible(tester, find.text('Audio'));
    await tapVisible(tester, find.text('music volume down'));
    expect(server.posts.last['op'], {'op': 'audio', 'audio': 'a1', 'volume_delta': -0.1});
    await tapVisible(tester, find.text('Effects'));
    await tapVisible(tester, find.text('Cross dissolve'));
    expect(server.posts.last['op'], {'op': 'transition', 'clip': 'c1', 'type': 'dissolve', 'duration': 0.5});
    await tapVisible(tester, find.text('Captions'));
    await tapVisible(tester, find.text('Auto captions'));
    expect(server.posts.last['text'], 'add captions');
    // Stop any timers before the test ends.
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Visual Studio: four tabs; templates draw a preview and Use Template creates the project', (tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final server = FakeCheServer();
    await tester.pumpWidget(app(CheVisualStudio(client: server.visual)));
    await tester.pumpAndSettle();
    for (final t in ['Images', 'Video', 'Templates', 'Projects']) {
      expect(find.text(t), findsOneWidget);
    }
    await tapVisible(tester, find.text('Templates'));
    expect(find.bySemanticsLabel(RegExp(r'^Template Album Cover, Album Cover')), findsOneWidget);
    expect(find.byType(CheTemplatePreview), findsWidgets);
    await tapVisible(tester, find.text('Album Cover').last);
    await tapVisible(tester, find.text('Use Template'));
    expect(server.posts.firstWhere((p) => p['action'] == 'create')['template_id'], 'album-cover');
  });

  testWidgets('no important editor label is cut off at larger text on an iPhone-width screen', (tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final server = FakeCheServer();
    await tester.pumpWidget(app(CheVideoEditor(client: server.visual, projectId: 'v1'), textScale: 1.3));
    await tester.pumpAndSettle();
    for (final label in ['Split', 'Trim start', 'Trim end', 'Edit', 'Adjust', 'Audio', 'Captions']) {
      final finder = find.text(label);
      expect(finder, findsWidgets, reason: label);
      final text = tester.widget<Text>(finder.first);
      final painter = TextPainter(text: TextSpan(text: label, style: DefaultTextStyle.of(tester.element(finder.first)).style.merge(text.style)), textDirection: TextDirection.ltr, textScaler: const TextScaler.linear(1.3), maxLines: 1)..layout();
      expect(tester.getSize(finder.first).width + 0.5 >= painter.width, isTrue, reason: '"$label" is not truncated');
    }
    expect(tester.takeException(), isNull, reason: 'no overflow at 1.3x text');
    await tester.pumpWidget(const SizedBox());
  });
}
