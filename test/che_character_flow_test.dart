// Create Person, full character flow in the Live Studio (lib/create/che_live_studio.dart) and the Create room
// (che_creative_studio.dart): reference photo with consent read as a numbered list, its thumbnail's VoiceOver label,
// Remove, the device and fit lines as quiet text (never spoken by themselves), the voice and typed routes, character
// voice samples only on request, "make another one", and play animation -> save -> close -> reopen the same saved
// character with the same GLB. The Worker is a MockClient that answers like creation_studio.js. Synthetic data only.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:chey/che_native_voice.dart';
import 'package:chey/create/che_creative_studio.dart';
import 'package:chey/create/che_live_studio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _Viewport implements CheViewportDriver {
  _Viewport(this.onMessage);
  final void Function(Map<String, dynamic>) onMessage;
  final List<String> clips = const ['idle', 'walk'];
  final loads = <String>[];
  final cmds = <Map<String, Object>>[];
  @override
  Widget build(BuildContext context) => const ColoredBox(color: Color(0xFF101418));
  @override
  Future<void> load(Uint8List glb, String label) async {
    loads.add(label);
    onMessage({'type': 'model', 'meshes': 4, 'vertices': 30904, 'triangles': 51000, 'clips': clips, 'morphs': const [], 'mouth_morph': null});
  }

  @override
  Future<void> command(Map<String, Object> cmd) async {
    cmds.add(cmd);
    onMessage({'type': 'done', 'action': cmd['action'], 'ok': true, 'playing': cmd['action'] == 'animate' ? cmd['clip'] : null});
  }

  @override
  Future<void> pause(bool paused) async {}
  @override
  void dispose() {}
}

final _glb = Uint8List.fromList([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 32, 0, 0, 0, ...List.filled(20, 0)]);
final _jpeg = Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 9, 9, 0xff, 0xd9]);
final _heic = Uint8List.fromList([0, 0, 0, 24, ...'ftypheic'.codeUnits, 0, 0, 0, 0]);

const _deviceLine = 'Built on the free GitHub cloud CPU worker, a CPU, not a GPU, 4 threads, Standard quality: 64 samples, '
    'measured 23.4 min. No GPU worker was online when it started (only the CPU worker was connected), so the CPU built it.';
const _fitLine = 'Reference fit, an approximate likeness, not an exact copy (landmarks): 478 landmarks, fit error 0.04. '
    'Colours from the photo: skin #8d5524.';

Map<String, dynamic> _job({String state = 'completed'}) => {
      'id': 'gpu_abc',
      'kind': 'person_model',
      'state': state,
      'display_state': state == 'completed' ? 'Completed' : 'Waiting for Resources',
      'status_line': state == 'completed' ? 'Completed at 18:20 UTC on the free GitHub cloud CPU runner gha-1-1.' : 'Waiting since 18:00 UTC.',
      'progress': {'pct': state == 'completed' ? 100 : 0, 'views_done': []},
      'previews': {},
      'worker_class': 'github_cpu',
      'worker_name': 'free GitHub cloud CPU runner gha-1-1 (GitHub Actions run 1)',
      'model': state == 'completed' ? {'bytes': 1463972, 'sha256': 'aa11', 'uploaded_at': '2026-10-25T18:10:00Z', 'url': '/api/gpu/jobs/gpu_abc/model.glb'} : null,
    };

class _Worker {
  _Worker({Map<String, dynamic>? job, this.withDevice = true}) : _jobMap = job;
  final Map<String, dynamic>? _jobMap;
  final bool withDevice;
  int version = 1;
  int count = 1;
  String? savedAt;
  Map<String, dynamic>? ref;
  Map<String, dynamic>? voice;
  final requests = <String>[];
  final bodies = <Map<String, dynamic>>[];
  final modelUrls = <String>[];

  Map<String, dynamic> project() => {
        'id': 'cr_1',
        'kind': 'person',
        'title': 'Tall athletic man',
        'base_id': 'orion',
        'version': version,
        'versions_count': count,
        'can_undo': version > 1,
        'can_redo': version < count,
        'saved_at': savedAt,
        'job': _jobMap,
        'stages': const [],
        'reference': ref,
        'reference_line': ref != null && withDevice ? _fitLine : '',
        'device_line': withDevice ? _deviceLine : 'No GPU is connected: your Colab GPU notebook is not open, so only the free GitHub cloud CPU worker is available.',
        'voice': voice,
        'last_model': _jobMap?['model'] == null ? null : {'version': 1, 'job_id': 'gpu_abc', 'url': '/api/gpu/jobs/gpu_abc/model.glb', 'sha256': 'aa11', 'current': true},
        'engine': {'status': 'cloud', 'online': false, 'paired': true, 'automatic': true, 'workers_online': 0, 'max_concurrent': 3},
      };

  http.Client client() => MockClient((r) async {
        final p = r.url.path;
        requests.add('${r.method} ${r.url.path}${r.url.query.isEmpty ? '' : '?${r.url.query}'}');
        if (r.method == 'GET' && p == '/api/creations/cr_1') return _res(jsonEncode({'ok': true, 'project': project()}), 200);
        if (r.method == 'GET' && p.endsWith('/model.glb')) {
          modelUrls.add(p);
          return http.Response.bytes(_glb, 200);
        }
        final body = r.body.isEmpty ? <String, dynamic>{} : Map<String, dynamic>.from(jsonDecode(r.body) as Map);
        bodies.add(body);
        if (r.method == 'POST' && p == '/api/creations/cr_1/reference') {
          if (body['consent'] != 'self' && body['consent'] != 'fictional') {
            return _res(jsonEncode({'ok': false, 'detail': 'Not added.'}), 422);
          }
          version += 1;
          count = version;
          ref = {'sha256': 'f' * 64, 'bytes': base64Decode('${body['image_base64']}').length, 'content_type': 'image/jpeg', 'consent': body['consent'],
            'at': '2026-10-25T18:30:00Z', 'url': '/api/creations/cr_1/reference'};
          return _res(jsonEncode({'ok': true, 'changed': true, 'spoken': 'Reference photo added: 1 KB JPEG, this is me. Saved as version $version.', 'project': project()}), 201);
        }
        if (r.method == 'DELETE' && p == '/api/creations/cr_1/reference') {
          final purge = r.url.queryParameters['purge'] == '1';
          ref = null;
          if (!purge) {
            version += 1;
            count = version;
          }
          return _res(jsonEncode({'ok': true, 'spoken': purge
              ? "Deleted the reference photo from every version of this character and from CHE's storage, as you asked. Undo cannot bring it back."
              : 'Removed the reference photo from this character, as you asked. Saved as version $version; say undo to bring it back.', 'project': project()}), 200);
        }
        if (r.method == 'POST' && p == '/api/creations/cr_1/save') {
          savedAt = '2026-10-25T18:40:00Z';
          return _res(jsonEncode({'ok': true, 'spoken': 'Saved Tall athletic man, version $version.', 'project': project()}), 200);
        }
        if (r.method == 'POST' && p == '/api/creations/cr_1/edit') {
          final t = '${body['text']}'.toLowerCase();
          if (t.contains('play the voice')) {
            return _res(jsonEncode({'ok': true, 'changed': false, 'spoken': 'Playing voice 2, American Feminine — Bella.',
              'play_voice': {'id': 1, 'name': 'American Feminine — Bella', 'speaker': 'af_bella', 'text': "Hi, I'm Tall athletic man. This is my voice."}, 'project': project()}), 200);
          }
          if (t.contains('voice 2')) {
            version += 1;
            count = version;
            voice = {'id': 1, 'name': 'American Feminine — Bella', 'speaker': 'af_bella'};
            return _res(jsonEncode({'ok': true, 'changed': true, 'spoken': 'Voice set to 2, American Feminine — Bella. Saved as version $version.', 'project': project()}), 200);
          }
          if (t == 'make another one') {
            version += 1;
            count = version;
            return _res(jsonEncode({'ok': true, 'changed': true, 'spoken': 'Made variation 1 as version $version.', 'project': project()}), 200);
          }
        }
        return http.Response('{"detail":"not found"}', 404);
      });
}

/// A Worker reply as the real Worker sends it: UTF-8 JSON bytes with no charset in the header.
http.Response _res(String body, int status) => http.Response.bytes(utf8.encode(body), status, headers: {'content-type': 'application/json'});

Future<void> _phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

void main() {
  Widget studio(_Worker w, {List<String>? spoken, List<String>? read, List<_Viewport>? vp, Future<Uint8List?> Function(String)? pick, Future<bool> Function(int, String)? play}) =>
      MaterialApp(
        theme: ThemeData(brightness: Brightness.dark),
        home: CheLiveStudio(
          baseUrl: 'https://che.test',
          headers: const {},
          projectId: 'cr_1',
          client: w.client(),
          onRead: read?.add,
          onSpeak: spoken?.add,
          viewport: (m) {
            final v = _Viewport(m);
            vp?.add(v);
            return v;
          },
          loadBundled: (_) async => _glb,
          pickReference: pick,
          playVoiceSample: play,
        ),
      );

  test('consent words: 1 or "this is me" is self, 2 or "fictional" is fictional, anyone else is refused', () {
    expect(cheReferenceConsent('1'), 'self');
    expect(cheReferenceConsent('this is me'), 'self');
    expect(cheReferenceConsent('two'), 'fictional');
    expect(cheReferenceConsent('fictional or generated'), 'fictional');
    expect(cheReferenceConsent("it's my friend"), 'refuse');
    expect(cheReferenceConsent('my daughter'), 'refuse');
    expect(cheReferenceConsent('a child'), 'refuse');
    expect(cheReferenceConsent('what'), isNull);
    expect(cheImageType(_jpeg), 'image/jpeg');
    expect(cheImageType(_heic), 'image/heic');
    expect(cheDescribedPersonFromWords('create a person: a tall woman in her 30s, green eyes'), 'a tall woman in her 30s, green eyes');
    expect(cheDescribedPersonFromWords('describe a character, a slim man with an afro'), 'a slim man with an afro');
    expect(cheDescribedPersonFromWords('create a person'), isNull);
  });

  test('the character voice catalog on the Worker is CHE\'s own on-device voice list, same ids and names', () {
    final js = File('server/cloudflare/creation_studio.js').readAsStringSync();
    for (final v in CheNativeVoice.localVoiceOptions) {
      final name = '${v['name']}'.replaceAll('—', r'—');
      expect(js.contains("{ id: ${v['id']}, name: '$name', speaker: '${v['speaker']}' }"), isTrue, reason: '$v');
    }
  });

  testWidgets('reference photo: the consent list is read as numbers, then camera or library; the thumbnail has a VoiceOver label; Remove', (tester) async {
    await _phone(tester);
    final spoken = <String>[];
    final picks = <String>[];
    final w = _Worker(job: _job());
    await tester.pumpWidget(studio(w, spoken: spoken, pick: (s) async {
      picks.add(s);
      return _jpeg;
    }));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'opening never speaks');
    final add = find.bySemanticsLabel('Add a reference photo: your own photo, or a fictional or generated image');
    expect(add, findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey('live-Add reference photo')));
    await tester.tap(find.byKey(const ValueKey('live-Add reference photo')));
    await tester.pumpAndSettle();
    expect(spoken.last, startsWith('Who is in the photo? 1. This is me. 2. Fictional or generated. Say 1 or 2.'));
    expect(find.text(cheReferenceChoices), findsOneWidget);
    expect(find.bySemanticsLabel('Choice 1: this is me'), findsOneWidget);
    expect(find.bySemanticsLabel('Choice 2: fictional or generated'), findsOneWidget);
    // By voice: "1", then "library".
    final s1 = await CheLiveStudio.voiceHandler!('1');
    await tester.pumpAndSettle();
    expect(s1, contains('Where is the photo? 1. Take a photo with the camera. 2. Choose from the photo library.'));
    expect(find.bySemanticsLabel('Choice 1: take a photo with the camera'), findsOneWidget);
    final before = spoken.length;
    final s2 = await CheLiveStudio.voiceHandler!('choose from the library');
    await tester.pumpAndSettle();
    expect(picks, ['library']);
    expect(s2, startsWith('Reference photo added'));
    expect(spoken.length, before, reason: 'the voice route speaks its own reply');
    final post = w.bodies.firstWhere((b) => b.containsKey('image_base64'));
    expect(post['consent'], 'self');
    expect(base64Decode('${post['image_base64']}'), _jpeg);
    final thumb = tester.getSemantics(find.byKey(const ValueKey('live-ref-thumb')));
    expect(thumb.label, startsWith('Reference photo, this is you, 0 KB JPEG, added'));
    expect(thumb.label, contains('approximate likeness, not an exact copy'));
    expect(find.text(_fitLine), findsOneWidget);
    // Remove by button: spoken once, confirms the removal and how to undo it.
    await tester.ensureVisible(find.byKey(const ValueKey('live-Remove photo')));
    await tester.tap(find.byKey(const ValueKey('live-Remove photo')));
    await tester.pumpAndSettle();
    expect(w.requests, contains('DELETE /api/creations/cr_1/reference'));
    expect(spoken.last, startsWith('Removed the reference photo from this character, as you asked.'));
    expect(find.byKey(const ValueKey('live-ref-thumb')), findsNothing);
  });

  testWidgets('consent for someone else is refused with the reason; a HEIC the phone could not convert is not sent', (tester) async {
    await _phone(tester);
    final w = _Worker(job: _job());
    await tester.pumpWidget(studio(w, pick: (_) async => _heic));
    await tester.pumpAndSettle();
    await CheLiveStudio.voiceHandler!('use a reference photo');
    await tester.pumpAndSettle();
    final no = await CheLiveStudio.voiceHandler!("it's my friend");
    expect(no, contains('No photo was added. $cheReferenceRule'));
    expect(w.bodies.where((b) => b.containsKey('image_base64')), isEmpty);
    await CheLiveStudio.voiceHandler!('add a reference photo');
    await CheLiveStudio.voiceHandler!('2');
    await tester.pumpAndSettle();
    final heic = await CheLiveStudio.voiceHandler!('1');
    expect(heic, contains('HEIC and the phone could not convert it to JPEG, so it was not sent'));
    expect(w.bodies.where((b) => b.containsKey('image_base64')), isEmpty);
    expect(await CheLiveStudio.voiceHandler!('delete the reference photo completely'), contains('Undo cannot bring it back'));
    expect(w.requests, contains('DELETE /api/creations/cr_1/reference?purge=1'));
  });

  testWidgets('device, limits and measured time are quiet text; "what device built it" answers only when asked', (tester) async {
    await _phone(tester);
    final spoken = <String>[];
    final read = <String>[];
    await tester.pumpWidget(studio(_Worker(job: _job()), spoken: spoken, read: read));
    await tester.pumpAndSettle();
    expect(find.text(_deviceLine), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const ValueKey('live-device'))).style?.color, CheStudioColors.dim);
    expect(spoken, isEmpty);
    expect(read, isEmpty, reason: 'no passive speech, including the device line');
    final said = await CheLiveStudio.voiceHandler!('what device built it');
    expect(said, startsWith('Built on the free GitHub cloud CPU worker, a CPU, not a GPU, 4 threads'));
    expect(said, isNot(contains('on the GPU')));
    await tester.tap(find.byKey(const ValueKey('live-read')));
    expect(read.single, contains('measured 23.4 min'));
    expect(read.single, contains('No reference photo; say use a reference photo to add one.'));
    // Before any build: which compute is there now, and the CPU is never called a GPU.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(studio(_Worker(withDevice: false), spoken: spoken));
    await tester.pumpAndSettle();
    expect(find.textContaining('No GPU is connected: your Colab GPU notebook is not open'), findsOneWidget);
    expect(spoken, isEmpty);
  });

  testWidgets('character voice: choose by number, the sample plays only when asked, through the injected player', (tester) async {
    await _phone(tester);
    final played = <(int, String)>[];
    final w = _Worker(job: _job());
    await tester.pumpWidget(studio(w, play: (id, text) async {
      played.add((id, text));
      return true;
    }));
    await tester.pumpAndSettle();
    expect(played, isEmpty);
    expect(await CheLiveStudio.voiceHandler!('choose voice 2'), startsWith('Voice set to 2'));
    await tester.pumpAndSettle();
    expect(find.text('Voice: American Feminine — Bella. Say play the voice to hear it.'), findsOneWidget);
    expect(played, isEmpty, reason: 'choosing does not play');
    expect(await CheLiveStudio.voiceHandler!('play the voice'), 'Playing voice 2, American Feminine — Bella.');
    expect(played.single.$1, 1);
    // A voice pack that is not ready is reported as a failure, never as played.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(studio(_Worker(job: _job()), play: (_, _) async => false));
    await tester.pumpAndSettle();
    expect(await CheLiveStudio.voiceHandler!('play the voice'), contains('could not play: the on-device voice pack is not installed or not ready yet'));
  });

  testWidgets('"make another one" makes a new version through the Worker; its button has a VoiceOver label', (tester) async {
    await _phone(tester);
    final w = _Worker(job: _job());
    await tester.pumpWidget(studio(w));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('Make another one: a new variation of this character, built at once'), findsOneWidget);
    expect(await CheLiveStudio.voiceHandler!('make another one'), 'Made variation 1 as version 2.');
    expect(w.bodies.last['text'], 'make another one');
  });

  testWidgets('play animation, save, close the viewer, reopen the same saved character: same version, same GLB', (tester) async {
    await _phone(tester);
    final spoken = <String>[];
    final vp = <_Viewport>[];
    final w = _Worker(job: _job());
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(navigatorKey: nav, home: const Scaffold(body: Text('Create room'))));
    Widget page() => CheLiveStudio(
          baseUrl: 'https://che.test',
          headers: const {},
          projectId: 'cr_1',
          client: w.client(),
          onSpeak: spoken.add,
          viewport: (m) {
            final v = _Viewport(m);
            vp.add(v);
            return v;
          },
          loadBundled: (_) async => _glb,
        );
    unawaited(nav.currentState!.push(MaterialPageRoute<void>(builder: (_) => page())));
    await tester.pumpAndSettle();
    expect(vp.single.loads.last, startsWith('Version 1 model, exported by Blender'));
    expect(w.modelUrls, ['/api/gpu/jobs/gpu_abc/model.glb']);
    // Play the walk animation (button), then save (button): each outcome spoken once.
    await tester.ensureVisible(find.byKey(const ValueKey('live-tool-Animate')));
    await tester.tap(find.byKey(const ValueKey('live-tool-Animate')));
    await tester.pumpAndSettle();
    expect(vp.single.cmds.last, {'action': 'animate', 'clip': 'idle'});
    expect(spoken.last, 'Playing the idle animation on the model.');
    await tester.ensureVisible(find.byKey(const ValueKey('live-Save')));
    await tester.tap(find.byKey(const ValueKey('live-Save')));
    await tester.pumpAndSettle();
    expect(spoken.last, 'Saved Tall athletic man, version 1.');
    expect(find.textContaining('saved'), findsWidgets);
    // Close the viewer.
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    expect(find.text('Create room'), findsOneWidget);
    expect(CheLiveStudio.voiceHandler, isNull, reason: 'the closed studio no longer takes voice');
    // Reopen the same saved character.
    final heard = spoken.length;
    unawaited(nav.currentState!.push(MaterialPageRoute<void>(builder: (_) => page())));
    await tester.pumpAndSettle();
    expect(vp.length, 2);
    expect(vp.last.loads.last, startsWith('Version 1 model, exported by Blender'));
    expect(w.modelUrls, ['/api/gpu/jobs/gpu_abc/model.glb', '/api/gpu/jobs/gpu_abc/model.glb'], reason: 'the same GLB URL');
    expect(find.textContaining('Version 1 of 1'), findsOneWidget);
    expect(spoken.length, heard, reason: 'reopening is silent');
  });

  testWidgets('Create Person offers "Describe your character"; the dialog sends the words to the Worker, which builds at once', (tester) async {
    await _phone(tester);
    final calls = <String>[];
    final actions = CheStudioActions(
      onOpenFilmStudio: () {}, onNewVideo: () {}, onOpenTheater: () {}, onOpenMusic: () {}, onNewSong: () {}, onNewApp: () {},
      onOpenCommandCenter: () {}, onOpenOffice: () {}, onCharacterGenerator: () {}, onOpenArtStudio: () {}, onNewImage: () {},
      onNewProject: () {}, onOpenProject: (_) async {}, onVault: () {}, onResearch: () {},
      loadPeople: () async => const [('che', 'CHE', 'Office Boss')],
      onCreatePerson: (b) => calls.add('person $b'),
      onCreateThing: (kind, base, viaVoice) async {
        calls.add('$kind $base${viaVoice ? ' (voice)' : ''}');
        return 'Tall woman started. Queued.';
      },
    );
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheCreativeStudio(actions: actions, projects: const [], vaultCount: 0))));
    await tester.pumpAndSettle();
    // By voice, anywhere in the room.
    expect(await CheCreativeStudio.voiceHandler!('create a person: a tall woman in her 30s, long wavy dark hair'), 'Tall woman started. Queued.');
    expect(calls.last, 'person describe:a tall woman in her 30s, long wavy dark hair (voice)');
    // By touch: Create Person -> Describe your character -> type -> Create character.
    await CheCreativeStudio.voiceHandler!('create a person');
    await tester.pumpAndSettle();
    expect(find.text('Describe your character'), findsOneWidget);
    await tester.tap(find.text('Describe your character'));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('Who should CHE build? Describe the person.'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('describe-person-text')), 'a slim young adult, afro, hoodie, cartoon look');
    await tester.tap(find.byKey(const ValueKey('describe-person-create')));
    await tester.pumpAndSettle();
    expect(calls.last, 'person describe:a slim young adult, afro, hoodie, cartoon look');
  });
}
