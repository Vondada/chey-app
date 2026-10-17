// REA investigation records as the Worker serves them
// (test/fixtures/rea_investigations.json follows the REA 2.0 contract),
// parsed tolerantly; the client's REA routes; and the voice words the REA
// pages answer.
import 'dart:convert';
import 'dart:io';

import 'package:chey/commands/che_command_client.dart';
import 'package:chey/commands/che_command_voice.dart';
import 'package:chey/commands/che_rea_models.dart';
import 'package:chey/commands/che_rea_view.dart';
import 'package:chey/commands/che_rea_voice.dart';
import 'package:chey/home/screen_command.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final Map<String, dynamic> reaFixture = jsonDecode(File('test/fixtures/rea_investigations.json').readAsStringSync()) as Map<String, dynamic>;

Map<String, dynamic> reaRecord(int i) => Map<String, dynamic>.from((reaFixture['investigations'] as List)[i] as Map);

void main() {
  test('a full record: every field, all 13 stages in order, the current stage', () {
    final list = CheReaInvestigationList.fromJson(reaFixture);
    expect(list.investigations.length, 2);
    expect(list.capabilities.map((c) => (c.id, c.available)), [('npm', true), ('app_store', false)]);
    expect(list.capabilities.last.needs, ['an App Store link']);

    final i = list.investigations.first;
    expect(i.id, 'rea-1a2b3c4d');
    expect(i.target.kind, CheReaTargetKind.website);
    expect(i.target.label, 'Example Notes');
    expect(i.target.url, 'https://notes.example.com/');
    expect(i.target.version, 'sha256:9f2c41d0');
    expect(i.state, CheReaState.running);
    expect(i.createdAt, DateTime.utc(2026, 10, 16, 9));
    expect(i.updatedAt, DateTime.utc(2026, 10, 16, 9, 30));
    expect(i.stages.map((s) => s.id), [for (final s in cheReaStageOrder) s.$1]);
    expect(i.stages.length, 13);
    expect(i.stages[3].label, 'Map behavior');
    expect(i.stages[3].state, CheReaStageState.done);
    expect(i.stages[10].state, CheReaStageState.skipped);
    expect(i.stages[12].state, CheReaStageState.blocked);
    expect(i.stages[12].note, 'Waits for verification.');
    expect(i.currentStage?.number, 5);
    expect(i.stageText, 'Stage 5 of 13, Architecture');
    expect(i.sources.map((s) => s.label), ['Home page', 'Help center']);
    expect(i.screenshots, isEmpty);

    expect(i.features.map((f) => f.id), ['f1', 'f2', 'f3']);
    final f1 = i.features.first;
    expect(f1.name, 'Quick search');
    expect(f1.userSees, 'A search box at the top of every page.');
    expect(f1.operatedBy, startsWith('Typing in the search box'));
    expect(f1.inputs, ['search words']);
    expect(f1.outputs, ['matching notes']);
    expect(f1.components, ['search box', 'results list']);
    expect(f1.evidence.single.url, 'https://notes.example.com/#search');
    expect(f1.unknowns, ['Whether search covers attachments.']);
    expect(f1.complexity, CheReaComplexity.low);
    expect(f1.che.status, CheReaCheStatus.partial);
    expect(f1.che.evidence.single.label, 'CHE searches memories, not notes');
    expect(f1.feasibleOk, isTrue);
    expect(f1.feasibleNote, "Fits CHE's existing search.");
    expect(i.features[1].dependencies, ['local storage']);
    expect(i.features[2].che.status, CheReaCheStatus.has);

    expect(i.architecture.map((a) => a.kind), [CheReaFindingKind.observed, CheReaFindingKind.observed, CheReaFindingKind.inferred, CheReaFindingKind.unknown]);
    expect(i.architecture.first.evidence.single.label, 'Page source');
    expect([i.comparison!.has, i.comparison!.partial, i.comparison!.missing, i.comparison!.unknown], [1, 1, 1, 0]);
    expect(i.proposals.single.featureId, 'f2');
    expect(i.plan!.features, ['f1', 'f2']);
    expect(i.plan!.steps.length, 2);
    expect(i.plan!.acceptance.length, 2);
    expect(i.plan!.approved, isFalse);
    expect(i.build, isNull);
    expect(i.verification, isNull);
    expect(i.limitations.single, startsWith('Only the public pages'));

    final done = list.investigations.last;
    expect(done.target.kind, CheReaTargetKind.npm);
    expect(done.stages[0].label, 'Understand the request', reason: 'no label from CHE: the stage keeps its own name');
    expect(done.screenshots.single.file, 'desktop.jpg');
    expect(done.build!.jobId, 'job-77');
    expect(done.build!.prNumber, 412);
    expect(done.build!.prUrl, 'https://github.com/Vondada/chey-app/pull/412');
    expect(done.verification!.state, CheReaVerificationState.passed);
    expect(done.verification!.checks.single.name, 'flutter test');
  });

  test('missing fields never throw: everything is empty or "not reported"', () {
    final i = CheReaInvestigation.fromJson(const {});
    expect(i.id, '');
    expect(i.target.kind, CheReaTargetKind.unknown);
    expect(i.state, CheReaState.unknown);
    expect(i.stages.length, 13);
    expect(i.stages.every((s) => s.state == CheReaStageState.unknown), isTrue);
    expect(cheReaStageStateLabel(i.stages.first.state), 'not reported');
    expect(i.currentStage, isNull);
    expect(i.stageText, 'No current stage reported');
    expect([i.sources, i.screenshots, i.features, i.architecture, i.proposals, i.limitations].every((l) => l.isEmpty), isTrue);
    expect([i.comparison, i.plan, i.build, i.verification], everyElement(isNull));
    expect(i.createdAt, isNull);
    expect(cheReaSummary(i), contains('No features mapped yet. No plan yet. No build started. Not verified yet.'));

    final odd = CheReaInvestigationList.fromJson(const {'investigations': 'none', 'capabilities': 5});
    expect(odd.investigations, isEmpty);
    expect(odd.capabilities, isEmpty);
    // A record without an id cannot be opened or acted on, so the list leaves it out.
    expect(CheReaInvestigationList.fromJson(const {'investigations': [{'state': 'running'}, 'x', null]}).investigations, isEmpty);

    final partial = CheReaInvestigation.fromJson(const {
      'id': 'rea-00000001',
      'target': 'not a map',
      'stages': [{'state': 'done'}, 'x'],
      'features': [{'name': 'No id'}, 7],
      'plan': {'features': 'f1'},
      'build': {},
      'screenshots': [{'label': 'no file'}],
      'sources': [{}, {'url': 'https://a.example'}],
    });
    expect(partial.title, 'rea-00000001');
    expect(partial.reportedStages, isEmpty, reason: 'a stage without an id is not a stage');
    expect(partial.features.single.id, 'f1', reason: 'a feature without an id is numbered by its place');
    expect(partial.features.single.che.status, CheReaCheStatus.unknown);
    expect(partial.features.single.feasibleOk, isNull);
    expect(partial.plan!.features, isEmpty);
    expect(partial.build!.prNumber, isNull);
    expect(partial.screenshots, isEmpty, reason: 'a screenshot with no file was not captured');
    expect(partial.sources.single.text, 'https://a.example');
  });

  test('unknown words map to unknown; odd types are read sensibly', () {
    final i = CheReaInvestigation.fromJson(const {
      'id': 'rea-00000002',
      'target': {'kind': 'chrome_extension', 'label': 'X'},
      'state': 'exploding',
      'stage': 'MAP',
      'stages': [
        {'id': 'MAP', 'state': 'weird'},
        {'id': 'deploy', 'label': 'Deploy', 'state': 'done'},
      ],
      'features': [
        {
          'id': 'f9', 'complexity': 'extreme', 'inputs': ['a', null, {'x': 1}, 3, ''],
          'che': {'status': 'maybe'}, 'feasible': {'ok': 'true'},
        },
      ],
      'architecture': [{'label': 'A', 'kind': 'guessed'}],
      'comparison': {'has': '2', 'partial': 1.0, 'missing': null, 'unknown': 'x'},
      'build': {'pr_number': '#412'},
      'verification': {'state': 'flaky', 'checks': 'none'},
      'plan': {'approved': 'true'},
    });
    expect(i.target.kind, CheReaTargetKind.unknown);
    expect(cheReaTargetKindLabel(i.target.kind), 'unknown kind');
    expect(i.state, CheReaState.unknown);
    expect(cheReaStateLabel(i.state), 'State unknown');
    expect(i.stages[3].state, CheReaStageState.unknown);
    expect(i.stages.length, 14, reason: 'a stage the phone does not know still shows, after the 13');
    expect(i.stages.last.label, 'Deploy');
    expect(i.stageText, 'Stage 4 of 14, Map behavior');
    final f = i.features.single;
    expect(f.complexity, CheReaComplexity.unknown);
    expect(f.inputs, ['a', '3']);
    expect(f.che.status, CheReaCheStatus.unknown);
    expect(f.feasibleOk, isTrue);
    expect(i.architecture.single.kind, CheReaFindingKind.unknown);
    expect([i.comparison!.has, i.comparison!.partial, i.comparison!.missing, i.comparison!.unknown], [2, 1, 0, 0]);
    expect(i.build!.prNumber, 412);
    expect(i.verification!.state, CheReaVerificationState.unknown);
    expect(i.verification!.checks, isEmpty);
    expect(i.plan!.approved, isTrue);
  });

  test('Read this: target, state, stage, features, CHE counts, plan, build, checks', () {
    final list = CheReaInvestigationList.fromJson(reaFixture);
    expect(
      cheReaSummary(list.investigations.first),
      'Example Notes, website, version sha256:9f2c41d0. Running. Stage 5 of 13, Architecture. 3 features mapped. '
      'Compared with CHE: she has 1, partly has 1, is missing 1. Plan: 2 features, 2 steps, not approved yet. '
      'No build started. Not verified yet. 1 limitation recorded.',
    );
    expect(
      cheReaSummary(list.investigations.last),
      'semver, npm package, version 7.7.2. Complete. Stage 13 of 13, Remember. 1 feature mapped. '
      'Compared with CHE: she has 0, partly has 0, is missing 1. Plan: 1 feature, 1 step, approved. '
      'Build: draft_pr_open, draft pull request 412. Verification passed: 1 of 1 checks passed.',
    );
  });

  group('client', () {
    final requests = <http.Request>[];
    CheCommandClient client({String baseUrl = 'https://che.test', bool drop = false}) => CheCommandClient(
          baseUrl: baseUrl,
          headers: () => const {'Authorization': 'Bearer paired'},
          client: MockClient((r) async {
            requests.add(r);
            if (drop) throw http.ClientException('Connection reset by peer', r.url);
            final body = switch (r.url.path) {
              '/api/rea/investigations' => reaFixture,
              '/api/rea/investigations/rea-1a2b3c4d' => {'investigation': reaRecord(0)},
              _ => {'detail': 'No investigation rea-ffffffff.'},
            };
            return http.Response.bytes(utf8.encode(jsonEncode(body)), body.containsKey('detail') ? 404 : 200, headers: {'content-type': 'application/json'});
          }),
        );
    setUp(requests.clear);

    test('reads the list and one record with the paired-device headers', () async {
      final list = await client().reaInvestigations();
      expect(list.investigations.length, 2);
      final one = await client().reaInvestigation('rea-1a2b3c4d');
      expect(one.title, 'Example Notes');
      expect(requests.map((r) => '${r.method} ${r.url.path}'), ['GET /api/rea/investigations', 'GET /api/rea/investigations/rea-1a2b3c4d']);
      expect(requests.every((r) => r.headers['Authorization'] == 'Bearer paired'), isTrue);
    });

    test('a 404 and a dropped connection are CheCommandExceptions with the reason', () async {
      await expectLater(client().reaInvestigation('rea-ffffffff'), throwsA(isA<CheCommandException>().having((e) => e.message, 'message', 'No investigation rea-ffffffff.')));
      await expectLater(client(drop: true).reaInvestigations(), throwsA(isA<CheCommandException>().having((e) => e.message, 'message', contains('the connection failed'))));
      await expectLater(client(baseUrl: '').reaInvestigations(), throwsA(isA<CheCommandException>()));
    });

    test('screenshot addresses stay inside the investigation\'s folder', () {
      final c = client();
      expect(c.reaFileUri('rea-1a2b3c4d', 'desktop.jpg').toString(), 'https://che.test/api/rea/files/rea-1a2b3c4d/desktop.jpg');
      expect(c.reaFileHeaders(), {'Authorization': 'Bearer paired'});
      for (final bad in ['../secret', 'a/b.jpg', '', '.hidden', 'x..jpg', 'a b.jpg']) {
        expect(c.reaFileUri('rea-1a2b3c4d', bad), isNull, reason: bad);
      }
      expect(c.reaFileUri('../rea', 'desktop.jpg'), isNull);
      expect(client(baseUrl: '').reaFileUri('rea-1a2b3c4d', 'desktop.jpg'), isNull);
    });
  });

  test('voice: the REA pages\' words; their own slash commands go on to Chat', () {
    CheReaVoiceOp? op(String w) => CheReaVoiceRequest.parse(w)?.op;
    for (final c in ['/rea-build rea-1a2b3c4d', '/rea-features rea-1a2b3c4d', '/rea-rebuild rea-1a2b3c4d f1 f3']) {
      expect(CheReaVoiceRequest.parse(c), isNull, reason: c);
      expect(CheCommandVoice.parse(c), isNull, reason: 'the Command Center must not take "$c" on its way to Chat');
      expect(parseScreenCommand(c), isNull, reason: 'Chat sends "$c" to CHE, not to an on-device screen command');
    }
    expect(op('Read this'), CheReaVoiceOp.describe);
    expect(op("What's on my screen?"), CheReaVoiceOp.describe);
    expect(op('map features'), CheReaVoiceOp.mapFeatures);
    expect(op('compare with CHE'), CheReaVoiceOp.compare);
    expect(op('build it'), CheReaVoiceOp.build);
    expect(op('verify'), CheReaVoiceOp.verify);
    expect(op('refresh'), CheReaVoiceOp.refresh);
    expect(op('read the features'), CheReaVoiceOp.listFeatures);
    expect(op('yes'), CheReaVoiceOp.yes);
    expect(op('cancel'), CheReaVoiceOp.no);
    expect(op('go back'), CheReaVoiceOp.back);
    expect(CheReaVoiceRequest.parse('select features 1 and 3')?.numbers, [1, 3]);
    expect(CheReaVoiceRequest.parse('select features f1, f3')?.numbers, [1, 3]);
    final plan = CheReaVoiceRequest.parse('plan features one and three');
    expect(plan?.op, CheReaVoiceOp.plan);
    expect(plan?.numbers, [1, 3]);
    expect(CheReaVoiceRequest.parse('plan selected')?.op, CheReaVoiceOp.plan);
    expect(CheReaVoiceRequest.parse('feature 2')?.numbers, [2]);
    expect(CheReaVoiceRequest.parse('number two')?.numbers, [2]);
    expect(CheReaVoiceRequest.parse('search for YouTube'), isNull, reason: 'the Command Center answers it');
    expect(CheCommandVoice.parse('open investigations')?.op, CheCommandVoiceOp.investigations);
    expect(CheCommandVoice.parse('show me the REA investigations')?.op, CheCommandVoiceOp.investigations);
  });

  test('needs_choice is its own state, and only https choices CHE sent are kept, numbered', () {
    final i = CheReaInvestigation.fromJson({
      'id': 'rea-0a1b2c3d', 'state': 'needs_choice', 'target': {'label': 'Doodle', 'kind': 'app_name'},
      'choices': [
        {'number': 1, 'label': 'GitHub repository acme/sketchpad', 'url': 'https://github.com/acme/sketchpad'},
        {'label': 'Second', 'url': 'https://apps.apple.com/us/app/x/id1'},
        {'number': 3, 'label': 'Bad', 'url': 'http://insecure.example'},
        {'number': 4, 'label': 'Spaced', 'url': 'https://a b'},
      ],
    });
    expect(i.state, CheReaState.needsChoice);
    expect(cheReaStateLabel(i.state), 'Needs your choice: no exact match');
    expect([for (final c in i.choices) '${c.number} ${c.url}'], ['1 https://github.com/acme/sketchpad', '2 https://apps.apple.com/us/app/x/id1']);
    expect(CheReaInvestigation.fromJson({'id': 'rea-0a1b2c3e', 'state': 'complete'}).choices, isEmpty);
  });
}
