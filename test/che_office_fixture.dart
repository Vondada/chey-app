// Sample Worker answers for the Office screens, shaped like the real routes:
//   GET /api/agents          (agent_runtime.runtimeSnapshot)
//   GET /api/agents/:id      (agent_runtime.agentDetail, with work_log)
//   GET /api/office/today    (office_board.officeToday)
// Sample records only, used by tests and the owner's review screenshots. Nothing here is shown in the app.
import 'dart:convert';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/home/che_projects_board.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _agent(String id, String name, String role, String status, {String? task, String? latest, String specialty = '', String color = '7C8CFF', String dept = ''}) => {
      'id': id,
      'name': name,
      'role': role,
      'specialty': specialty,
      'status': status,
      'color': '#$color',
      'task': ?task,
      if (dept.isNotEmpty) 'department': {'id': dept.toLowerCase(), 'title': dept},
      if (latest != null) 'latest_assignment': {'id': 't-$id', 'task': task ?? 'Earlier task', 'status': latest},
    };

/// The seven core desks with every real work state: working, queued, blocked, finished and available.
final List<Map<String, dynamic>> cheFixtureRoster = [
  _agent('nova', 'Nova', 'Office Coordinator', 'building', task: 'Coordinate the Houston launch plan', latest: 'running', specialty: 'Runs multi-department jobs', color: '9B7CFF', dept: 'Operations'),
  _agent('atlas', 'Atlas', 'Research', 'researching', task: 'Research competitors in Houston', latest: 'running', specialty: 'Sourced market research', color: '5CC8FF'),
  _agent('mira', 'Mira', 'Creative Director', 'waiting', task: 'Draft launch video storyboard', latest: 'queued', specialty: 'Video, music and design', color: 'FF6FA8'),
  _agent('knox', 'Knox', 'Office Security Chief', 'waiting', task: 'Build a landing page', latest: 'blocked', specialty: 'Security and engineering checks', color: 'FFB84D', dept: 'Security'),
  _agent('sage', 'Sage', 'Trading Analyst', 'idle', latest: 'complete', specialty: 'Paper trading research, never real money', color: '3DDC97'),
  _agent('lyra', 'Lyra', 'Content / social', 'idle', specialty: 'Captions, FAQ replies, posts', color: 'FF8A5C'),
  _agent('iris', 'Iris', 'Ad Studio', 'idle', specialty: 'Ad concepts and scouting', color: 'C9A0FF'),
];

final Map<String, dynamic> cheFixtureBoard = {
  'started': [
    {'id': 't-nova', 'agent': 'Nova', 'task': 'Coordinate the Houston launch plan', 'status': 'running'},
    {'id': 't-atlas', 'agent': 'Atlas', 'task': 'Research competitors in Houston', 'status': 'running'},
    {'id': 't-mira', 'agent': 'Mira', 'task': 'Draft launch video storyboard', 'status': 'queued'},
    {'id': 't-knox', 'agent': 'Knox', 'task': 'Build a landing page', 'status': 'blocked'},
  ],
  'shipped': [
    {'id': 't-sage', 'agent': 'Sage', 'task': 'Backtest the ES opening range'},
    {'id': 't-lyra0', 'agent': 'Lyra', 'task': 'Write FAQ replies'},
  ],
  'blockers': [
    {'id': 't-knox', 'agent': 'Knox', 'task': 'Build a landing page', 'detail': 'Blocked: tool not configured (Codex)'},
  ],
  'stalled': [],
  'agents_working': 2,
  'agents': [
    {'id': 'nova', 'name': 'Nova', 'role': 'Office Coordinator', 'state': 'working', 'status': 'Working: Coordinate the Houston launch plan', 'job': 'Coordinate the Houston launch plan'},
    {'id': 'atlas', 'name': 'Atlas', 'role': 'Research', 'state': 'working', 'status': 'Working: Research competitors in Houston', 'job': 'Research competitors in Houston'},
    {'id': 'mira', 'name': 'Mira', 'role': 'Creative Director', 'state': 'queued', 'status': 'Up next: Draft launch video storyboard', 'job': 'Draft launch video storyboard'},
    {'id': 'knox', 'name': 'Knox', 'role': 'Office Security Chief', 'state': 'blocked', 'status': 'Blocked: tool not configured (Codex)', 'job': 'Build a landing page'},
    {'id': 'sage', 'name': 'Sage', 'role': 'Trading Analyst', 'state': 'done', 'status': 'Finished: Backtest the ES opening range', 'job': 'Backtest the ES opening range'},
    {'id': 'lyra', 'name': 'Lyra', 'role': 'Content / social', 'state': 'idle', 'status': 'Idle', 'job': ''},
    {'id': 'iris', 'name': 'Iris', 'role': 'Ad Studio', 'state': 'idle', 'status': 'Idle', 'job': ''},
  ],
  'stripe': {'connected': false, 'charges_cents': 0, 'refunds_cents': 0, 'net_cents': 0, 'status': 'not_connected'},
};

final Map<String, dynamic> cheEmptyBoard = {
  'started': [],
  'shipped': [],
  'blockers': [],
  'stalled': [],
  'agents_working': 0,
  'agents': [],
  'stripe': {'connected': false},
};

final List<Map<String, dynamic>> cheFixtureMeetings = [
  {
    'id': 'm1',
    'objective': 'Plan the Houston launch. Pick the first three offers.',
    'status': 'cross_check',
    'progress': 0.6,
    'participants': [
      {'name': 'Nova'},
      {'name': 'Atlas'},
      {'name': 'Mira'},
    ],
  },
  {
    'id': 'm0',
    'objective': 'Choose the FAQ tone for the store.',
    'status': 'complete',
    'progress': 1,
    'participants': [
      {'name': 'Lyra'},
    ],
  },
];

Map<String, dynamic> cheFixtureDetail(String id) {
  final a = cheFixtureRoster.firstWhere((x) => x['id'] == id, orElse: () => cheFixtureRoster.first);
  return {
    'agent': {...a, 'mission': 'Do real Office work and report to CHE.', 'responsibilities': ['Report to CHE']},
    'history': [
      if (a['latest_assignment'] case final Map<String, dynamic> l)
        {'id': l['id'], 'task': l['task'], 'status': l['status'], 'result': '', 'che_review': '', 'verified_by_che': l['status'] == 'complete', 'error': '', 'created_at': '2026-10-25T14:00:00Z'},
    ],
    'work_log': [
      if (id == 'sage') {'agent': 'Sage', 'agent_id': 'sage', 'task_id': 't-sage', 'task': 'See owner-authorized task history', 'status': 'complete', 'verified_by_che': true, 'memory_note_id': 'note-77', 'error': '', 'at': '2026-10-25T15:10:00Z'},
    ],
    'meetings': [],
    'skills': [],
  };
}

/// A Worker double for the Office routes. [requests] records what the screen sent.
CheAgentRuntimeClient cheFixtureClient({bool empty = false, List<http.Request>? requests}) => CheAgentRuntimeClient(
      baseUrl: () => 'https://che.test',
      headers: () => const {},
      client: MockClient((request) async {
        requests?.add(request);
        final path = request.url.path;
        if (path == '/api/agents' && request.method == 'GET') {
          return http.Response(jsonEncode({
            'che': empty ? {'status': 'idle'} : {'status': 'reviewing', 'task': 'Review Atlas research'},
            'agents': empty ? [] : cheFixtureRoster,
            'working': empty ? 0 : 2,
            'meetings': empty ? [] : cheFixtureMeetings,
          }), 200);
        }
        if (path.startsWith('/api/agents/') && path.endsWith('/task')) {
          return http.Response(jsonEncode({'task': {'id': 't-new', 'status': 'queued'}}), 200);
        }
        if (path.startsWith('/api/agents/') && request.method == 'GET') {
          return http.Response(jsonEncode(cheFixtureDetail(path.split('/').last)), 200);
        }
        if (path == '/api/meetings' && request.method == 'POST') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          return http.Response(jsonEncode({'meeting': {'id': 'm9', 'objective': body['objective'], 'status': 'drafting', 'progress': 0.1, 'participants': []}}), 200);
        }
        if (path == '/api/office/today') return http.Response(jsonEncode({'board': empty ? cheEmptyBoard : cheFixtureBoard}), 200);
        if (path == '/api/chat') return http.Response('', 200);
        return http.Response('{}', 404);
      }),
    );

/// Projects-board items like the Office tab's Projects page builds from /api/state.
const List<CheBoardItem> cheFixtureProjects = [
  CheBoardItem(id: 'p1', title: 'Houston launch', kind: CheBoardKind.goal, typeLabel: 'Office goal', statusLabel: 'Working', progress: 0.45, subtitle: '3 of 7 jobs done'),
  CheBoardItem(id: 'p2', title: 'FAQ store', kind: CheBoardKind.project, typeLabel: 'Business', statusLabel: 'Review', progress: 0.8),
  CheBoardItem(id: 'p3', title: 'Old idea', kind: CheBoardKind.project, typeLabel: 'Creator project', statusLabel: 'Complete', progress: 1),
];
