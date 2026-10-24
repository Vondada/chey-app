import 'dart:convert';

import 'package:chey/avatar/che_character_generator.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _preset(String id, String name, {Map<String, dynamic>? face}) => {
      'id': id, 'name': name, 'role': 'role of $name', 'sheet': id,
      'body': {'sex': 0, 'age': 0.1, 'race': {'african': 1}},
      'face': face ?? {'eyefold': 0.4},
      'skin': {'tone': '#502e20', 'pores': 0.2}, 'eyes': {'iris': '#3a2216', 'brightness': 2.5},
      'brows': {'density': 1000, 'width': 1.8}, 'lashes': {'length': 0.55},
      'hair': {'style': 'long_wavy', 'color': '#1c1210', 'density': 90}, 'outfit': {'top': 'jacket'},
    };

class _Fake {
  final calls = <(String, String, Map<String, dynamic>?)>[];
  bool failSave = false;
  late final client = MockClient((r) async {
    final body = r.body.isEmpty ? null : Map<String, dynamic>.from(jsonDecode(r.body) as Map);
    calls.add((r.method, r.url.path, body));
    final path = r.url.path;
    if (r.method == 'GET' && path == '/api/gpu/identities') {
      return http.Response(jsonEncode({
        'presets': [_preset('che', 'CHE'), _preset('nova', 'Nova', face: {'eye_size': 0.2})],
        'active': {'che': 'che'},
        'styles': ['photoreal', 'hybrid', 'stylized'],
        'face_sliders': ['eye_size', 'eyefold', 'face_round'],
        'hair_styles': ['long_wavy', 'bun_high', 'close_crop'],
        'hair_built': ['long_wavy'],
        'spoken': 'Ten presets.',
      }), 200);
    }
    if (path == '/api/gpu/identities/generate') {
      return http.Response(jsonEncode({'ok': true, 'preset': {..._preset('che_v1', 'CHE variant 1'), 'base': 'che'}}), 200);
    }
    if (path == '/api/gpu/identities/preview') {
      final styles = (body!['styles'] as List);
      return http.Response(jsonEncode({
        'ok': true,
        'jobs': [for (final s in styles) {'id': 'gpu_$s', 'title': 'CHE, $s', 'state': 'queued', 'previews': {}}],
      }), 202);
    }
    if (path == '/api/gpu/identities' && r.method == 'POST') {
      if (failSave) return http.Response(jsonEncode({'ok': false, 'detail': 'face.eye_size must be -1..1'}), 422);
      return http.Response(jsonEncode({'ok': true, 'preset': {...(body!['preset'] as Map), 'id': 'che_custom1', 'name': 'CHE custom 1'}}), 200);
    }
    if (path == '/api/gpu/identities/apply') {
      return http.Response(jsonEncode({'ok': true, 'active': {'che': body!['preset_id']}}), 200);
    }
    return http.Response('{}', 404);
  });
}

Future<(_Fake, List<String>)> _pump(WidgetTester tester, {_Fake? fake}) async {
  final f = fake ?? _Fake();
  final spoken = <String>[];
  tester.view.physicalSize = const Size(1200, 4000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    home: CheCharacterGenerator(baseUrl: 'https://che.test', headers: const {'X-Owner': 't'}, client: f.client, onRead: spoken.add),
  ));
  await tester.pumpAndSettle();
  return (f, spoken);
}

String _banner(WidgetTester tester) => tester.widget<Text>(find.descendant(of: find.byKey(const ValueKey('generator-banner')), matching: find.byType(Text))).data!;

void main() {
  testWidgets('loads the presets, shows the characters and never speaks on open', (tester) async {
    final (f, spoken) = await _pump(tester);
    expect(f.calls.first.$2, '/api/gpu/identities');
    expect(find.text('CHE'), findsOneWidget);
    expect(find.text('Nova'), findsOneWidget);
    expect(find.text('Eye size'), findsOneWidget);
    expect(find.text('High bun (close-cropped until built)'), findsOneWidget);
    expect(spoken, isEmpty);
    expect(find.byKey(const ValueKey('generator-banner')), findsNothing);
  });

  testWidgets('every control has a VoiceOver label', (tester) async {
    final handle = tester.ensureSemantics();
    await _pump(tester);
    for (final label in [
      'Generate a new variant of this character',
      'Preview: queue GPU renders on your Colab T4',
      'Save this preset',
      'Apply this preset to CHE',
      'Read the Character Generator aloud',
      'Edit Nova, role of Nova',
      'Hybrid look',
      'Skin tone deep',
      'Hair style High bun, renders close-cropped until its strands are built',
    ]) {
      expect(find.bySemanticsLabel(label), findsOneWidget, reason: label);
    }
    expect(find.bySemanticsLabel(RegExp('^Eye size')), findsWidgets);
    handle.dispose();
  });

  testWidgets('a slider change updates the working preset and marks it unsaved', (tester) async {
    await _pump(tester);
    final state = tester.state<CheCharacterGeneratorState>(find.byType(CheCharacterGenerator));
    state.setSlider('eye_size', 0.5);
    await tester.pump();
    expect((state.preset['face'] as Map)['eye_size'], 0.5);
    expect(state.dirty, isTrue);
    expect(find.textContaining('(unsaved changes)'), findsOneWidget);
    state.setSlider('eye_size', 0);
    expect((state.preset['face'] as Map).containsKey('eye_size'), isFalse);
  });

  testWidgets('Generate sends the base and a seed and says it is not rendered yet', (tester) async {
    final (f, _) = await _pump(tester);
    await tester.tap(find.byKey(const ValueKey('gen-generate')));
    await tester.pumpAndSettle();
    final call = f.calls.last;
    expect(call.$2, '/api/gpu/identities/generate');
    expect(call.$3, {'base_id': 'che', 'seed': 1, 'amount': 0.3});
    expect(_banner(tester), contains('Not rendered yet'));
  });

  testWidgets('Preview queues all three looks and never claims a render', (tester) async {
    final (f, _) = await _pump(tester);
    await tester.tap(find.byKey(const ValueKey('gen-preview')));
    await tester.pumpAndSettle();
    final call = f.calls.last;
    expect(call.$2, '/api/gpu/identities/preview');
    expect(call.$3!['styles'], ['photoreal', 'hybrid', 'stylized']);
    expect((call.$3!['preset'] as Map)['id'], 'che');
    final text = _banner(tester);
    expect(text, startsWith('Queued for your Colab T4 session: 3 preview jobs'));
    expect(text, contains('Nothing is rendered until the notebook runs'));
    expect(text.toLowerCase(), isNot(contains('rendered on')));
    expect(find.text('Queued: waits for your Colab session'), findsNWidgets(3));
  });

  testWidgets('Preview with one look sends only the chosen look', (tester) async {
    final (f, _) = await _pump(tester);
    await tester.tap(find.byKey(const ValueKey('all-looks')));
    await tester.tap(find.byKey(const ValueKey('look-stylized')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('gen-preview')));
    await tester.pumpAndSettle();
    expect(f.calls.last.$3!['styles'], ['stylized']);
  });

  testWidgets('Apply needs a save first; Save then Apply send the right bodies', (tester) async {
    final (f, _) = await _pump(tester);
    final state = tester.state<CheCharacterGeneratorState>(find.byType(CheCharacterGenerator));
    state.setSlider('eye_size', 0.3);
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('gen-apply')));
    await tester.pumpAndSettle();
    expect(_banner(tester), contains('unsaved changes'));
    expect(f.calls.where((c) => c.$2 == '/api/gpu/identities/apply'), isEmpty);

    await tester.tap(find.byKey(const ValueKey('gen-save')));
    await tester.pumpAndSettle();
    final save = f.calls.last;
    expect(save.$2, '/api/gpu/identities');
    expect(((save.$3!['preset'] as Map)['face'] as Map)['eye_size'], 0.3);
    expect(_banner(tester), 'Saved the preset CHE custom 1.');

    await tester.tap(find.byKey(const ValueKey('gen-apply')));
    await tester.pumpAndSettle();
    expect(f.calls.last.$3, {'agent': 'che', 'preset_id': 'che_custom1'});
    expect(_banner(tester), 'CHE now uses the preset CHE custom 1.');
  });

  testWidgets('a failed save shows the real failure', (tester) async {
    final (_, _) = await _pump(tester, fake: _Fake()..failSave = true);
    await tester.tap(find.byKey(const ValueKey('gen-save')));
    await tester.pumpAndSettle();
    expect(_banner(tester), 'Save did not work: face.eye_size must be -1..1.');
  });

  testWidgets('choosing a character, a colour and a hair style edits that character', (tester) async {
    await _pump(tester);
    final state = tester.state<CheCharacterGeneratorState>(find.byType(CheCharacterGenerator));
    await tester.tap(find.byKey(const ValueKey('char-nova')));
    await tester.pump();
    expect(state.agent, 'nova');
    expect(state.sliderValue('eye_size'), 0.2);
    await tester.tap(find.byKey(const ValueKey('swatch-hair-#8d64d6')));
    await tester.tap(find.byKey(const ValueKey('hair-bun_high')));
    await tester.pump();
    expect((state.preset['hair'] as Map)['color'], '#8d64d6');
    expect((state.preset['hair'] as Map)['style'], 'bun_high');
  });

  testWidgets('Read aloud speaks the current state only when pressed', (tester) async {
    final (_, spoken) = await _pump(tester);
    expect(spoken, isEmpty);
    await tester.tap(find.bySemanticsLabel('Read the Character Generator aloud'));
    await tester.pump();
    expect(spoken.single, contains('Editing CHE'));
    expect(spoken.single, contains('1 Generate, 2 Preview, 3 Save, 4 Apply'));
  });

  testWidgets('a load failure is shown, not hidden', (tester) async {
    final f = _Fake();
    await tester.pumpWidget(MaterialApp(
      home: CheCharacterGenerator(
        baseUrl: 'https://che.test',
        headers: const {},
        client: MockClient((_) async => http.Response('nope', 500)),
      ),
    ));
    await tester.pumpAndSettle();
    expect(f.calls, isEmpty);
    expect(_banner(tester), contains('Could not load the character presets'));
  });
}
