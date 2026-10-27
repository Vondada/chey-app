// A deterministic Office roster for tests (no live Worker needed). The names, roles and departments match
// server/cloudflare/office_company.js (LA_AGENCIA_ROLES). Used by the simulator gate and by widget tests, so the
// Office's real layout (pager, empty state) is exercised with realistic data instead of an empty CI roster.
import 'dart:convert';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const List<Map<String, dynamic>> kFixtureAgents = [
  {'id': 'agent-nova-0001', 'name': 'Nova', 'role': 'Operations / coordination', 'specialty': 'Coordinates Office jobs', 'mission': 'Keep jobs moving.', 'personality': 'Calm and organised.', 'color': '5CC8FF', 'hair': '2B1D14', 'skin': 'C68B59', 'status': 'idle', 'task': '', 'responsibilities': ['Own coordination'], 'model_tier': 'fast', 'temporary': false},
  {'id': 'agent-atlas-0002', 'name': 'Atlas', 'role': 'Engineering / Codex jobs', 'specialty': 'Implementation', 'mission': 'Build what is asked.', 'personality': 'Direct and precise.', 'color': 'FFB84D', 'hair': '1A1A1A', 'skin': 'E0AC69', 'status': 'idle', 'task': '', 'responsibilities': ['Own engineering'], 'model_tier': 'fast', 'temporary': false},
  {'id': 'agent-mira-0003', 'name': 'Mira', 'role': 'Research / education', 'specialty': 'Research and sourcing', 'mission': 'Find the facts.', 'personality': 'Patient and thorough.', 'color': '9B8CFF', 'hair': '4B2E1E', 'skin': 'C68B59', 'status': 'idle', 'task': '', 'responsibilities': ['Own research'], 'model_tier': 'fast', 'temporary': false},
  {'id': 'agent-knox-0004', 'name': 'Knox', 'role': 'Security / protection', 'specialty': 'Security reviews', 'mission': 'Protect the owner.', 'personality': 'Watchful and careful.', 'color': 'FF6B6B', 'hair': '222222', 'skin': '8D5524', 'status': 'idle', 'task': '', 'responsibilities': ['Own security'], 'model_tier': 'fast', 'temporary': false},
  {'id': 'agent-orion-0005', 'name': 'Orion', 'role': 'Markets / trading research', 'specialty': 'Paper trading research', 'mission': 'Study the markets. Paper only.', 'personality': 'Analytical and steady.', 'color': '4CD19A', 'hair': '3A2A1A', 'skin': 'F1C27D', 'status': 'idle', 'task': '', 'responsibilities': ['Own markets research'], 'model_tier': 'fast', 'temporary': false},
];

/// A client whose Worker answers come from memory. [agents] decides the roster; everything else is an empty, valid reply.
CheAgentRuntimeClient fixtureOfficeClient({List<Map<String, dynamic>> agents = kFixtureAgents}) {
  final http.Client mock = MockClient((request) async {
    final path = request.url.path;
    Object body;
    if (path == '/api/agents' && request.method == 'GET') {
      body = {'che': {'status': 'idle', 'task': ''}, 'agents': agents, 'working': 0, 'meetings': <Object>[]};
    } else if (path == '/api/office/today') {
      body = {'board': {'started': <Object>[], 'shipped': <Object>[], 'blockers': <Object>[], 'agents_working': 0, 'agents': <Object>[], 'stripe': {'connected': false}}};
    } else if (RegExp(r'^/api/agents/[^/]+$').hasMatch(path)) {
      body = {'agent': agents.firstWhere((a) => path.endsWith(a['id'] as String), orElse: () => agents.first), 'history': <Object>[], 'meetings': <Object>[]};
    } else {
      body = <String, Object>{};
    }
    return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
  });
  return CheAgentRuntimeClient(baseUrl: () => 'http://fixture.invalid', headers: () => const {}, client: mock);
}
