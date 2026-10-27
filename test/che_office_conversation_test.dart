import 'dart:convert';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/agents/che_office_conversation.dart';
import 'package:chey/agents/che_office_conversation_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// Shaped exactly like the `conversation` record in GET /api/agents/:id (server/cloudflare/office_conversation.js).
Map<String, dynamic> _message({
  required int seq,
  required String kind,
  required String text,
  String speaker = 'Owner',
  String to = 'Atlas',
  String? at,
  String taskTitle = 'Research competitors in Houston',
  String taskState = 'Queued',
  String taskRaw = 'queued',
  Map<String, dynamic> details = const {},
}) =>
    {
      'seq': seq,
      'kind': kind,
      'speaker': speaker,
      'to': to,
      'at': at,
      'text': text,
      'task_id': 'task-atlas-0001',
      'task_title': taskTitle,
      'task_state': taskState,
      'task_raw_status': taskRaw,
      'details': {'record_id': 'task-atlas-0001', ...details},
    };

Map<String, dynamic> _queuedAtlas({List<Map<String, dynamic>>? messages}) => {
      'conversation': {
        'scope': 'agent',
        'generated_at': '2026-10-26T12:00:00.000Z',
        'agent': {
          'id': 'agent-atlas-0001',
          'name': 'Atlas',
          'role': 'Research',
          'status': 'Queued',
          'status_raw': 'queued',
          'status_reason': 'Waiting to start. Nothing has run for this task yet.',
          'active_task': {
            'id': 'task-atlas-0001',
            'title': 'Research competitors in Houston',
            'state': 'Queued',
            'raw_status': 'queued',
            'reason': 'Waiting to start. Nothing has run for this task yet.',
            'partner_name': 'Atlas',
            'verified_by_che': false,
            'created_at': '2026-10-26T10:00:00.000Z',
            'updated_at': '2026-10-26T10:00:00.000Z',
          },
          'current_step': 'Queued. Not started yet.',
          'last_completed': null,
          'next_scheduled': null,
          'blockers': [],
          'last_update_at': '2026-10-26T10:00:00.000Z',
          'last_verified_at': null,
        },
        'task': null,
        'tasks': [],
        'messages': messages ??
            [
              _message(seq: 1, kind: 'request', text: 'Research competitors in Houston', at: '2026-10-26T10:00:00.000Z'),
            ],
        'meetings': [],
        'notes': [],
      },
    };

Future<void> _pump(WidgetTester tester, CheOfficeConversation c) => tester.pumpWidget(
      MaterialApp(home: CheOfficeConversationScreen(conversation: c)),
    );

/// The SelectableText that shows exactly this text (message bodies are SelectableText, never clipped).
Finder _bodyWith(String text) => find.byWidgetPredicate((w) => w is SelectableText && w.data == text);

void main() {
  group('six states', () {
    test('a queued task is Queued, never Running', () {
      expect(cheOfficeStateForTaskStatus('queued', verified: false)?.label, 'Queued');
      expect(cheOfficeStateForTaskStatus('queued', verified: true)?.label, 'Queued');
    });

    test('every stored status maps to the same state the Worker uses', () {
      const expected = {
        'queued': 'Queued',
        'running': 'Running',
        'reviewing': 'Running',
        'review_pending': 'Waiting',
        'needs_review': 'Waiting',
        'advisory': 'Waiting',
        'blocked': 'Blocked',
        'failed': 'Failed',
        'rejected': 'Failed',
        'cancelled': 'Failed',
      };
      expected.forEach((status, label) {
        expect(cheOfficeStateForTaskStatus(status, verified: false)?.label, label, reason: status);
      });
      expect(cheOfficeStateForTaskStatus('complete', verified: true)?.label, 'Completed');
      expect(cheOfficeStateForTaskStatus('complete', verified: false)?.label, 'Waiting');
    });

    test('an unknown status is null, so the raw value is shown instead of a guessed state', () {
      expect(cheOfficeStateForTaskStatus('mystery', verified: false), isNull);
    });
  });

  group('desk headline precedence (Codex review on PR #666)', () {
    CheAgentTask t(String id, String status) => CheAgentTask(
        id: id, task: id, status: status, result: '', cheReview: '', verifiedByChe: false, error: '', createdAt: null);

    test('an older running task outranks a newer queued one', () {
      // History is newest first, as GET /api/agents/:id returns it.
      final pick = cheHeadlineTask([t('newer-queued', 'queued'), t('older-running', 'running')]);
      expect(pick?.id, 'older-running');
      expect(cheOfficeStateForTaskStatus(pick!.status, verified: false), CheOfficeState.running);
    });

    test('reviewing outranks queued; waiting-for-review and blocked outrank queued', () {
      expect(cheHeadlineTask([t('q', 'queued'), t('rv', 'reviewing')])?.id, 'rv');
      expect(cheHeadlineTask([t('q', 'queued'), t('rp', 'review_pending')])?.id, 'rp');
      expect(cheHeadlineTask([t('q', 'queued'), t('b', 'blocked')])?.id, 'b');
      expect(cheHeadlineTask([t('rp', 'review_pending'), t('r', 'running')])?.id, 'r');
    });

    test('with only queued tasks, the oldest (started next) is the headline; with none open, the newest task', () {
      expect(cheHeadlineTask([t('q3', 'queued'), t('q2', 'queued'), t('q1', 'queued')])?.id, 'q1');
      expect(cheHeadlineTask([t('done-new', 'complete'), t('done-old', 'failed')])?.id, 'done-new');
      expect(cheHeadlineTask(const []), isNull);
    });
  });

  test('time since last activity reads from the real timestamp', () {
    final now = DateTime.utc(2026, 10, 26, 12, 0);
    expect(cheTimeAgo(null, now: now), 'Not recorded');
    expect(cheTimeAgo(now.subtract(const Duration(seconds: 20)), now: now), 'just now');
    expect(cheTimeAgo(now.subtract(const Duration(minutes: 5)), now: now), '5 min ago');
    expect(cheTimeAgo(now.subtract(const Duration(hours: 3, minutes: 12)), now: now), '3 h 12 min ago');
    expect(cheTimeAgo(now.subtract(const Duration(days: 2)), now: now), '2 days ago');
  });

  test('the response parses into agent state and messages, oldest first', () {
    final c = CheOfficeConversation.fromResponse(_queuedAtlas(messages: [
      _message(seq: 1, kind: 'request', text: 'first', at: '2026-10-26T10:00:00.000Z'),
      _message(seq: 2, kind: 'result', text: 'second', speaker: 'Atlas', to: 'CHE', at: '2026-10-26T10:05:00.000Z'),
    ]));
    expect(c.agent?.status, CheOfficeState.queued);
    expect(c.agent?.activeTask?.title, 'Research competitors in Houston');
    expect(c.messages.map((m) => m.text), ['first', 'second']);
    expect(c.messages.last.kindLabel, 'Result');
  });

  test('search matches the message words, the speaker, the task and the record id', () {
    final m = CheOfficeConversation.fromResponse(_queuedAtlas(messages: [
      _message(seq: 1, kind: 'request', text: 'Find the Houston pricing page'),
    ])).messages.single;
    expect(cheConversationMatches(m, ''), isTrue);
    expect(cheConversationMatches(m, 'pricing'), isTrue);
    expect(cheConversationMatches(m, 'OWNER'), isTrue);
    expect(cheConversationMatches(m, 'task-atlas-0001'), isTrue);
    expect(cheConversationMatches(m, 'lobster'), isFalse);
  });

  testWidgets('a long message shows its full text, not truncated', (tester) async {
    final longText = 'Finding ${List.generate(120, (i) => 'word$i').join(' ')} END-OF-RESULT.';
    expect(longText.length, greaterThan(140));
    await _pump(
      tester,
      CheOfficeConversation.fromResponse(_queuedAtlas(messages: [
        _message(seq: 1, kind: 'result', text: longText, speaker: 'Atlas', to: 'CHE', at: '2026-10-26T10:05:00.000Z'),
      ])),
    );
    await tester.pumpAndSettle();
    final body = tester.widget<SelectableText>(_bodyWith(longText));
    expect(body.maxLines, isNull, reason: 'the body must not be limited to a number of lines');
    expect(longText.endsWith('END-OF-RESULT.'), isTrue);
    expect(find.textContaining('…'), findsNothing);
  });

  testWidgets('search filters messages to the ones that match', (tester) async {
    await _pump(
      tester,
      CheOfficeConversation.fromResponse(_queuedAtlas(messages: [
        _message(seq: 1, kind: 'request', text: 'Look at the needle in the haystack', at: '2026-10-26T10:00:00.000Z'),
        _message(seq: 2, kind: 'request', text: 'An unrelated line about bread', at: '2026-10-26T10:01:00.000Z'),
      ])),
    );
    await tester.pumpAndSettle();
    expect(_bodyWith('An unrelated line about bread'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'needle');
    await tester.pumpAndSettle();
    expect(_bodyWith('Look at the needle in the haystack'), findsOneWidget);
    expect(_bodyWith('An unrelated line about bread'), findsNothing);
    expect(find.text('Showing 1 of 2 messages. Oldest first; newest at the bottom.'), findsOneWidget);
  });

  testWidgets('a queued task is labelled Queued and never Running', (tester) async {
    await _pump(tester, CheOfficeConversation.fromResponse(_queuedAtlas()));
    await tester.pumpAndSettle();
    // The newest message is scrolled into view on open, so the header sits above the viewport. skipOffstage is off so
    // the whole tree is checked, including the header, not only what is on screen.
    expect(find.textContaining('Queued', skipOffstage: false), findsWidgets);
    expect(find.textContaining('Running', skipOffstage: false), findsNothing);
    expect(find.text('CURRENT STEP', skipOffstage: false), findsOneWidget);
    expect(find.text('Queued. Not started yet.', skipOffstage: false), findsOneWidget);
  });

  testWidgets('fields with no record show Not recorded', (tester) async {
    await _pump(tester, CheOfficeConversation.fromResponse(_queuedAtlas()));
    await tester.pumpAndSettle();
    // Tool calls, files changed and test runs are not stored anywhere, so each reads Not recorded.
    expect(find.text('Not recorded'), findsWidgets);
    expect(find.text('TOOL CALLS'), findsOneWidget);
    expect(find.text('FILES CHANGED'), findsOneWidget);
    expect(find.text('TESTS RUN'), findsOneWidget);
  });

  testWidgets('the error filter shows only error messages', (tester) async {
    await _pump(
      tester,
      CheOfficeConversation.fromResponse(_queuedAtlas(messages: [
        _message(seq: 1, kind: 'request', text: 'Do the thing', at: '2026-10-26T10:00:00.000Z'),
        _message(seq: 2, kind: 'error', text: 'Permission denied on the repo', speaker: 'Office runtime', to: 'CHE', at: '2026-10-26T10:02:00.000Z'),
      ])),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilterChip, 'Errors'));
    await tester.pumpAndSettle();
    expect(_bodyWith('Permission denied on the repo'), findsOneWidget);
    expect(_bodyWith('Do the thing'), findsNothing);
  });

  testWidgets('the view opens scrolled to the newest message', (tester) async {
    final many = [
      for (var i = 1; i <= 60; i++)
        _message(seq: i, kind: 'meeting', text: 'Line $i of the record', speaker: 'Atlas', to: 'War Room', at: '2026-10-26T10:${(i % 60).toString().padLeft(2, '0')}:00.000Z'),
      _message(seq: 61, kind: 'result', text: 'NEWEST MESSAGE LAST', speaker: 'Atlas', to: 'CHE', at: '2026-10-26T12:00:00.000Z'),
    ];
    await _pump(tester, CheOfficeConversation.fromResponse(_queuedAtlas(messages: many)));
    await tester.pumpAndSettle();
    final newest = _bodyWith('NEWEST MESSAGE LAST');
    expect(newest, findsOneWidget);
    final rect = tester.getRect(newest);
    final viewport = tester.getRect(find.byType(ListView));
    expect(rect.top, greaterThanOrEqualTo(viewport.top));
    expect(rect.bottom, lessThanOrEqualTo(viewport.bottom));
  });

  test('the client reads the conversation from the agent record, and a task view keeps only that task', () async {
    final body = _queuedAtlas(messages: [
      _message(seq: 1, kind: 'request', text: 'First task', at: '2026-10-26T10:00:00.000Z', details: {'record_id': 'task-a'}),
      _message(seq: 2, kind: 'request', text: 'Second task', taskTitle: 'Second', at: '2026-10-26T10:01:00.000Z', details: {'record_id': 'task-b'}),
    ]);
    // The second message belongs to another task id, so the task view must drop it.
    (body['conversation'] as Map<String, dynamic>)['messages'] = [
      {...(body['conversation'] as Map)['messages'][0] as Map<String, dynamic>, 'task_id': 'task-a'},
      {...(body['conversation'] as Map)['messages'][1] as Map<String, dynamic>, 'task_id': 'task-b'},
    ];
    final client = CheAgentRuntimeClient(
      baseUrl: () => 'https://worker.example',
      headers: () => const {},
      client: MockClient((request) async {
        expect(request.url.path, '/api/agents/agent-atlas-0001');
        return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
      }),
    );
    final whole = await client.conversation(agentId: 'agent-atlas-0001');
    expect(whole.messages.length, 2);
    final one = await client.conversation(agentId: 'agent-atlas-0001', taskId: 'task-a');
    expect(one.scope, 'task');
    expect(one.messages.map((m) => m.text), ['First task']);
  });
}
