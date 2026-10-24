// Cloud Computer Room: shows the Worker's real environments, jobs, approvals and what is missing, stays quiet while it
// loads, labels every control for VoiceOver, and speaks each action's real result with a banner.
import 'dart:convert';

import 'package:chey/rooms/che_cloud_computer_room.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> _view() => {
      'environments': [
        {'id': 'worker_internal', 'label': 'CHE Worker (Cloudflare)', 'status': 'operational', 'software': ['Workers AI'], 'cost': 'included', 'billing': 'existing Worker; no new charge', 'limits': 'No shell, no GPU.'},
        {'id': 'github_ubuntu', 'label': 'GitHub runner (ubuntu-latest)', 'status': 'unverified', 'software': ['Flutter (flutter-check.yml)', 'ffmpeg and ffprobe'], 'cost': 'unverified', 'billing': 'requires_verified_free_usage', 'limits': 'CPU only (no GPU).'},
      ],
      'software': ['Workers AI', 'Flutter (flutter-check.yml)', 'ffmpeg and ffprobe'],
      'jobs': [
        {'id': 'aaaaaaaa-1111', 'kind': 'repo_tests', 'title': 'Repository tests', 'agent': 'Vale', 'provider': 'github_ubuntu', 'tools': ['flutter-check.yml'], 'created_at': '2026-10-24T10:00:00Z', 'status': 'awaiting_approval',
          'logs': [], 'outputs': [], 'evidence': 'unverified', 'approval': {'required': true, 'reason': 'GitHub minutes are not verified as free.'}, 'controls': {'approve': true, 'cancel': true, 'stop': false, 'retry': false}, 'error': ''},
        {'id': 'bbbbbbbb-2222', 'kind': 'repo_tests', 'title': 'Repository tests', 'agent': 'Vale', 'provider': 'github_ubuntu', 'tools': ['flutter-check.yml'], 'created_at': '2026-10-24T09:00:00Z', 'status': 'failed',
          'logs': ['10:00:00 Dispatched'], 'outputs': [{'kind': 'url', 'url': 'https://github.com/x/runs/7', 'label': 'GitHub run 7'}], 'evidence': 'unverified',
          'controls': {'approve': false, 'cancel': false, 'stop': false, 'retry': true}, 'error': 'The repository tests did not pass: failed steps: analyze: flutter test.'},
      ],
      'approvals': [{'id': 'aaaaaaaa-1111', 'title': 'Repository tests', 'reason': 'GitHub minutes are not verified as free.'}],
      'missing': [{'capability': 'blender', 'reason': 'No provider has Blender.', 'existing': 'A bpy pipeline exists.', 'smallest_addition': 'One new workflow with bpy.'}],
      'costs': {'summary': 'Nothing paid is ever started.'},
      'spoken': 'My cloud computer has 2 environments: 1 operational, 1 unverified.',
    };

void main() {
  test('the model keeps statuses, controls and the approval reason exactly', () {
    final v = CheCloudView.fromJson(_view());
    expect(v.environments.last.billingLabel, 'free usage not verified; asks first');
    expect(v.approvals.single.shortId, 'aaaaaaaa');
    expect(v.jobs.last.canRetry, isTrue);
    expect(v.jobs.last.canStop, isFalse);
    expect(cheCloudSummary(v), startsWith('My cloud computer has 2 environments'));
    expect(cheCloudSummary(v), contains('1. Repository tests, by Vale on github_ubuntu: waiting for your approval.'));
  });

  testWidgets('quiet on open; every control is labelled; an action speaks its real result with a banner', (tester) async {
    tester.view.physicalSize = const Size(1200, 3200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    final posts = <String>[];
    final client = CheCloudComputerClient(
      baseUrl: 'https://che.example',
      headers: () => {'Authorization': 'Bearer t'},
      client: MockClient((req) async {
        expect(req.headers['Authorization'], 'Bearer t');
        if (req.method == 'GET') {
          expect(req.url.path, '/api/cloud-computer');
          return _json(_view());
        }
        posts.add('${req.url.path} ${jsonDecode(req.body)['id']}');
        return _json({'ok': true, 'spoken': 'Approved, sir. Cloud job aaaaaaaa is queued.'});
      }),
    );
    await tester.pumpWidget(MaterialApp(home: CheCloudComputerRoom(client: client, onSpeak: spoken.add)));
    await tester.pumpAndSettle();

    expect(spoken, isEmpty, reason: 'passive loading is silent');
    expect(find.text('Waiting for your approval'), findsOneWidget);
    expect(find.text('Not available yet'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^GitHub runner \(ubuntu-latest\): unverified\. Software: Flutter')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^blender: No provider has Blender\.')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Approve cloud job aaaaaaaa')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Retry job bbbbbbbb')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Read Aloud')), findsOneWidget);
    expect(find.byTooltip('Reload the cloud computer'), findsOneWidget);
    expect(find.byTooltip('Talk to CHE about the cloud computer'), findsOneWidget);
    expect(find.textContaining('Problem: The repository tests did not pass'), findsOneWidget);

    await tester.tap(find.text('Read Aloud'));
    expect(spoken.single, startsWith('My cloud computer has 2 environments'));

    await tester.tap(find.bySemanticsLabel(RegExp(r'^Approve cloud job aaaaaaaa')));
    await tester.pumpAndSettle();
    expect(posts, ['/api/cloud-computer/approve aaaaaaaa-1111']);
    expect(spoken.last, 'Approved, sir. Cloud job aaaaaaaa is queued.');
    expect(find.bySemanticsLabel('Approved, sir. Cloud job aaaaaaaa is queued.'), findsOneWidget, reason: 'the result is shown as a banner too');
  });

  testWidgets('a load failure is said in words, not a blank screen', (tester) async {
    final client = CheCloudComputerClient(baseUrl: 'https://che.example', headers: () => {}, client: MockClient((_) async => _json({'detail': 'Only the CHE owner can use the cloud computer.'}, 403)));
    await tester.pumpWidget(MaterialApp(home: CheCloudComputerRoom(client: client)));
    await tester.pumpAndSettle();
    expect(find.text('I could not load the cloud computer: Only the CHE owner can use the cloud computer.'), findsOneWidget);
  });
}
