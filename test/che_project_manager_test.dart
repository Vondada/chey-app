// Create → Active Projects (lib/create/che_project_manager.dart) and Create → Code Studio
// (lib/create/che_code_workspace.dart), against the Worker answers they read (project_library.js, /api/chat,
// /api/job/cancel, /api/gpu/jobs/*). Every control posts to its owning route and reports the Worker's own answer;
// Delete asks first; the Code Studio stays on its own page. The data below is test data only.
import 'dart:convert';

import 'package:chey/create/che_code_workspace.dart';
import 'package:chey/create/che_project_manager.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _card(String id, String title, {String category = 'roblox', bool creative = true, String state = 'active', int copies = 1, List<String>? ids, String source = 'project', int luau = 0, String? jobId, String status = 'in_progress', String? model}) => {
  'id': id, 'ids': ids ?? [id], 'copies': copies, 'title': title, 'request': category == 'roblox' ? 'obby with a sword shop' : '',
  'category': category, 'category_label': category == 'roblox' ? 'Roblox games' : category == 'research' ? 'AI and research' : 'Characters and 3D',
  'creative': creative, 'state': state, 'state_label': state[0].toUpperCase() + state.substring(1), 'status': status,
  'last_activity': '2026-10-24T20:00:00.000Z', 'source': source, 'job_id': ?jobId,
  'output': {'line': luau > 0 ? '$luau Luau scripts, 2 crew results' : 'No output yet', 'luau': luau, 'model_url': model},
  'next_action': luau > 0 ? 'Download the place file and open it in Roblox Studio to playtest.' : 'Say continue to start it.',
};

final _library = {
  'ok': true,
  'cards': [
    _card('r2', 'Roblox game studio — tonight', copies: 2, ids: ['r2', 'r3'], luau: 3),
    _card('cr_1', 'Hero', category: 'character', source: 'creation', jobId: 'gpu_1', status: 'rendering'),
    _card('ml1', 'ML classification · 3 labels', category: 'research', creative: false, state: 'completed', status: 'complete'),
  ],
  'counts': {
    'creative': {'active': 2, 'paused': 0, 'completed': 0, 'archived': 0},
    'ai_code_research': {'active': 0, 'paused': 0, 'completed': 1, 'archived': 0},
  },
  'spoken': '2 creative projects.',
};

// UTF-8 bodies, as the Worker sends them (titles carry an em dash).
http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

class _Worker {
  final posts = <(String, Map<String, dynamic>)>[];
  late final client = MockClient((req) async {
    final path = req.url.path;
    if (req.method == 'GET' && path == '/api/projects/library') return _json(_library);
    if (req.method == 'GET' && path == '/api/projects/roblox/place.rbxlx') return http.Response('<roblox version="4"></roblox>', 200);
    final body = req.body.isEmpty ? <String, dynamic>{} : Map<String, dynamic>.from(jsonDecode(req.body) as Map);
    posts.add((path, body));
    if (path == '/api/projects/state') return _json({'ok': true, 'spoken': 'Roblox game studio — tonight is now ${body['state']} (all 2 copies). Saved.'});
    if (path == '/api/projects/continue') return _json({'ok': true, 'spoken': 'Atlas is writing the Luau for Roblox game studio — tonight.'});
    if (path.startsWith('/api/gpu/jobs/')) return http.Response(jsonEncode({'ok': true, 'job': {'id': body['id'], 'state': path.endsWith('cancel') ? 'cancelled' : 'paused'}}), 200);
    if (path == '/api/project/delete') return http.Response(jsonEncode({'ok': true}), 200);
    return http.Response('{}', 404);
  });
}

Future<void> _tap(WidgetTester t, String key) async {
  final f = find.byKey(ValueKey(key));
  await t.ensureVisible(f);
  // The previous action's receipt banner can sit over the button.
  ScaffoldMessenger.of(t.element(f)).removeCurrentSnackBar(reason: SnackBarClosedReason.remove);
  await t.pumpAndSettle();
  await t.tap(f);
  await t.pumpAndSettle();
}

Future<void> _phone(WidgetTester t) async {
  t.view.physicalSize = const Size(1170, 2532);
  t.view.devicePixelRatio = 3;
  addTearDown(t.view.reset);
}

void main() {
  testWidgets('cards: creative and research apart, copies shown once, real outputs and next actions', (tester) async {
    await _phone(tester);
    final w = _Worker();
    await tester.pumpWidget(MaterialApp(home: CheProjectManager(baseUrl: 'https://che.test', headers: () => const {}, client: w.client)));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('pm-card-r2')), findsOneWidget);
    expect(find.textContaining('2 copies kept'), findsOneWidget);
    expect(find.text('Output: 3 Luau scripts, 2 crew results'), findsOneWidget);
    expect(find.byKey(const ValueKey('pm-card-ml1')), findsNothing, reason: 'ML runs are not creative work');
    await tester.tap(find.text('AI, code & research'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('pm-card-ml1')), findsNothing, reason: 'it is completed, not active');
    await tester.tap(find.byKey(const ValueKey('pm-state-completed')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('pm-card-ml1')), findsOneWidget);
  });

  testWidgets('every control posts to its own route and reports the Worker\'s answer aloud', (tester) async {
    await _phone(tester);
    final w = _Worker();
    final said = <String>[];
    final saved = <String, int>{};
    await tester.pumpWidget(MaterialApp(home: CheProjectManager(baseUrl: 'https://che.test', headers: () => const {}, client: w.client, onSpeak: said.add,
      saveFile: (name, bytes) async { saved[name] = bytes.length; return 'Files, CHE, Roblox'; })));
    await tester.pumpAndSettle();
    await _tap(tester, 'pm-pause-r2');
    expect(w.posts.last.$1, '/api/projects/state');
    expect(w.posts.last.$2, {'ids': ['r2', 'r3'], 'state': 'paused'}, reason: 'every stored copy');
    expect(said.last, contains('is now paused (all 2 copies). Saved.'));
    await _tap(tester, 'pm-continue-r2');
    expect(w.posts.last.$1, '/api/projects/continue');
    expect(w.posts.last.$2, {'id': 'r2'});
    expect(said.last, startsWith('Atlas is writing the Luau'));
    await _tap(tester, 'pm-place-file-r2');
    expect(saved.keys.single, 'Roblox-game-studio-tonight.rbxlx');
    expect(said.last, contains('It has not been playtested.'));
    // A 3D creation's job: Stop is the real queue cancel; Pause is the queue's pause.
    await _tap(tester, 'pm-stop-cr_1');
    expect(w.posts.last.$1, '/api/gpu/jobs/cancel');
    expect(w.posts.last.$2, {'id': 'gpu_1'});
    expect(said.last, contains('Stopped Hero. The job is now cancelled'));
    await _tap(tester, 'pm-pause-cr_1');
    expect(w.posts.last.$1, '/api/gpu/jobs/pause');
    expect(w.posts.last.$2, {'id': 'gpu_1'});
  });

  testWidgets('Delete asks first: Cancel deletes nothing; Delete removes every stored copy', (tester) async {
    await _phone(tester);
    final w = _Worker();
    final said = <String>[];
    await tester.pumpWidget(MaterialApp(home: CheProjectManager(baseUrl: 'https://che.test', headers: () => const {}, client: w.client, onSpeak: said.add)));
    await tester.pumpAndSettle();
    await _tap(tester, 'pm-delete-r2');
    expect(find.textContaining('and its 2 stored copies? This cannot be undone.'), findsOneWidget);
    await _tap(tester, 'pm-delete-cancel');
    expect(w.posts.where((p) => p.$1 == '/api/project/delete'), isEmpty);
    expect(said.last, 'Not deleted.');
    await _tap(tester, 'pm-delete-r2');
    await _tap(tester, 'pm-delete-yes');
    expect(w.posts.where((p) => p.$1 == '/api/project/delete').map((p) => p.$2['id']), ['r2', 'r3']);
    expect(said.last, 'Deleted Roblox game studio — tonight (2 stored copies).');
  });

  testWidgets('voice: read, show a list, act on a number, and delete only after yes', (tester) async {
    await _phone(tester);
    final w = _Worker();
    await tester.pumpWidget(MaterialApp(home: CheProjectManager(baseUrl: 'https://che.test', headers: () => const {}, client: w.client)));
    await tester.pumpAndSettle();
    final voice = CheProjectManager.voiceHandler!;
    expect(await voice('tell me a joke'), isNull);
    expect(await voice('read'), startsWith('Creative projects, Active: 1. Roblox game studio — tonight, 3 Luau scripts'));
    expect(await voice('archive 1'), contains('is now archived'));
    expect(w.posts.last.$2['state'], 'archived');
    expect(await voice('delete 1'), contains('This cannot be undone. Say yes, delete, or say cancel.'));
    expect(w.posts.where((p) => p.$1 == '/api/project/delete'), isEmpty);
    expect(await voice('cancel'), 'Not deleted.');
    expect(await voice('delete 1'), contains('Say yes, delete'));
    expect(await voice('yes, delete'), startsWith('Deleted'));
    expect(await voice('show research'), startsWith('AI, code and research, Active: none.'));
    expect(await voice('show completed'), contains('ML classification'));
    expect(await voice('pause 9'), 'There is no project 9 here.');
  });

  group('Code Studio', () {
    final jobs = [
      {'id': 'j1', 'kind': 'self_development', 'title': 'Recipe app', 'status': 'queued', 'created_at': '2026-10-24T19:00:00Z'},
      {'id': 'j2', 'kind': 'self_development', 'title': 'Fix login', 'status': 'running', 'created_at': '2026-10-24T18:00:00Z'},
      {'id': 'j3', 'kind': 'chat', 'title': 'Answer a question', 'status': 'done'},
    ];
    late List<(String, Map<String, dynamic>)> posts;
    http.Client client() {
      posts = [];
      return MockClient((req) async {
        final body = Map<String, dynamic>.from(jsonDecode(req.body) as Map);
        posts.add((req.url.path, body));
        if (req.url.path == '/api/chat') {
          final reply = body['message'] == 'coding status' ? 'Coding job: queued.' : 'Coding job started: c1a2b3c4. I will tell you when the draft pull request is open.';
          return http.Response('${jsonEncode({'type': 'delta', 'delta': reply})}\n${jsonEncode({'type': 'done'})}\n', 200);
        }
        if (req.url.path == '/api/job/cancel') return http.Response(jsonEncode({'job': {'id': body['id'], 'status': 'cancelled'}}), 200);
        return http.Response('{}', 404);
      });
    }

    testWidgets('a dedicated workspace: real coding jobs, start a job and hear CHE\'s answer here, stop a queued one', (tester) async {
      await _phone(tester);
      final said = <String>[];
      var opened = 0;
      await tester.pumpWidget(MaterialApp(
        home: CheCodeWorkspace(baseUrl: 'https://che.test', headers: () => const {}, client: client(), onSpeak: said.add,
          loadJobs: () async => jobs, onOpenOffice: () => opened++),
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('code-workspace')), findsOneWidget);
      expect(find.text('Coding job: queued.'), findsOneWidget, reason: 'the Worker\'s coding status route');
      expect(find.text('1. Recipe app'), findsOneWidget);
      expect(find.text('2. Fix login'), findsOneWidget);
      expect(find.textContaining('Answer a question'), findsNothing, reason: 'only coding jobs');
      expect(said, isEmpty, reason: 'nothing is spoken on open');
      await tester.enterText(find.byKey(const ValueKey('code-request')), 'a Roblox obby with a sword shop');
      await tester.tap(find.byKey(const ValueKey('code-start')));
      await tester.pumpAndSettle();
      expect(posts.where((p) => p.$1 == '/api/chat').map((p) => p.$2['message']), contains('Start a coding job: a Roblox obby with a sword shop'));
      expect(find.byKey(const ValueKey('code-reply')), findsOneWidget);
      expect(said.last, startsWith('Coding job started: c1a2b3c4.'));
      expect(find.byKey(const ValueKey('code-workspace')), findsOneWidget, reason: 'still in the Code Studio, not Chat');
      await _tap(tester, 'code-stop-j1');
      expect(posts.where((p) => p.$1 == '/api/job/cancel').single.$2, {'id': 'j1'});
      expect(said.last, 'Stopped Recipe app. It was cancelled before it started; its record is kept.');
      expect(find.byKey(const ValueKey('code-stop-j2')), findsNothing, reason: 'a running job is not cancellable here');
      final voice = CheCodeWorkspace.voiceHandler!;
      expect(await voice('stop job 2'), 'Fix login is running; only a queued coding job can be stopped from here.');
      expect(await voice('read'), contains('1. Recipe app, Queued; 2. Fix login, Running'));
      expect(await voice('open the office'), 'Opening the Office.');
      expect(opened, 1);
      expect(await voice('build a budget tracker'), startsWith('Coding job started'));
      expect(posts.where((p) => p.$1 == '/api/chat').map((p) => p.$2['message']), contains('Start a coding job: a budget tracker'));
    });
  });
}
