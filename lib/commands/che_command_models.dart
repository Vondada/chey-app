// CHE Command Center data, exactly as the Worker serves it from
// server/cloudflare/command_catalog.js (GET /api/commands). The phone never
// invents a command, a status or a result: everything here is parsed from
// CHE's own responses.

String _s(Object? v) => v?.toString() ?? '';
List<Map<String, dynamic>> _maps(Object? v) => [
      if (v is List)
        for (final item in v)
          if (item is Map) Map<String, dynamic>.from(item),
    ];
List<String> _strings(Object? v) => [if (v is List) for (final item in v) item.toString()];

class CheCommandCategory {
  const CheCommandCategory({required this.id, required this.title, required this.summary});
  final String id;
  final String title;
  final String summary;

  factory CheCommandCategory.fromJson(Map<String, dynamic> j) =>
      CheCommandCategory(id: _s(j['id']), title: _s(j['title']), summary: _s(j['summary']));
}

class CheCommandInput {
  const CheCommandInput({required this.name, required this.required, required this.hint});
  final String name;
  final bool required;
  final String hint;
}

/// What a command still needs before it can run.
class CheCommandMissing {
  const CheCommandMissing({required this.id, required this.label, required this.state, required this.setup, required this.detail});
  final String id;
  final String label;
  final String state;
  final String setup;
  final String detail;

  factory CheCommandMissing.fromJson(Map<String, dynamic> j) => CheCommandMissing(
        id: _s(j['id']), label: _s(j['label']), state: _s(j['state']), setup: _s(j['setup']), detail: _s(j['detail']));
}

enum CheCommandStatus { available, setupRequired, unsupported, temporarilyUnavailable, unknown }

CheCommandStatus cheCommandStatusFrom(String raw) => switch (raw) {
      'available' => CheCommandStatus.available,
      'setup_required' => CheCommandStatus.setupRequired,
      'unsupported' => CheCommandStatus.unsupported,
      'temporarily_unavailable' => CheCommandStatus.temporarilyUnavailable,
      _ => CheCommandStatus.unknown,
    };

/// Short, plain words for a status, used on screen and by VoiceOver.
String cheCommandStatusLabel(CheCommandStatus status) => switch (status) {
      CheCommandStatus.available => 'Ready',
      CheCommandStatus.setupRequired => 'Needs setup',
      CheCommandStatus.unsupported => 'Not supported yet',
      CheCommandStatus.temporarilyUnavailable => 'Unavailable right now',
      CheCommandStatus.unknown => 'Status unknown',
    };

String cheModeLabel(String mode) => switch (mode) {
      'EXPLORE' => 'Explore · read only',
      'PLAN' => 'Plan · no actions',
      'BUILD' => 'Build · takes action',
      _ => mode,
    };

class CheCommandInfo {
  const CheCommandInfo({
    required this.id,
    required this.category,
    required this.title,
    required this.summary,
    required this.does,
    required this.mode,
    required this.approvalRequired,
    required this.approvalReason,
    required this.input,
    required this.examples,
    required this.needs,
    required this.optional,
    required this.handler,
    required this.route,
    required this.produces,
    required this.evidence,
    required this.cost,
    required this.keywords,
    required this.status,
    required this.missing,
  });

  final String id;
  final String category;
  final String title;
  final String summary;
  final String does;
  final String mode;
  final bool approvalRequired;
  final String approvalReason;
  final CheCommandInput? input;
  final List<String> examples;
  final List<String> needs;
  final List<String> optional;
  final String handler;
  final String route;
  final String produces;
  final String evidence;
  final String cost;
  final List<String> keywords;
  final CheCommandStatus status;
  final List<CheCommandMissing> missing;

  String get slash => '/$id';
  bool get canRun => status == CheCommandStatus.available;

  /// What CHE says (or VoiceOver reads) for this command, from its own data.
  String get spoken {
    final parts = <String>[
      '$slash. $summary',
      does,
      cheCommandStatusLabel(status),
      if (approvalRequired) 'Needs your approval: $approvalReason',
      if (missing.isNotEmpty) 'Missing: ${missing.map((m) => m.label).join(', ')}.',
      if (examples.isNotEmpty) 'You can say: ${examples.first}',
    ];
    return parts.join(' ');
  }

  factory CheCommandInfo.fromJson(Map<String, dynamic> j) {
    final approval = j['approval'] is Map ? Map<String, dynamic>.from(j['approval'] as Map) : const <String, dynamic>{};
    final input = j['input'] is Map ? Map<String, dynamic>.from(j['input'] as Map) : null;
    return CheCommandInfo(
      id: _s(j['id']),
      category: _s(j['category']),
      title: _s(j['title']),
      summary: _s(j['summary']),
      does: _s(j['does']),
      mode: _s(j['mode']),
      approvalRequired: approval['required'] == true,
      approvalReason: _s(approval['reason']),
      input: input == null
          ? null
          : CheCommandInput(name: _s(input['name']), required: input['required'] == true, hint: _s(input['hint'])),
      examples: _strings(j['examples']),
      needs: _strings(j['needs']),
      optional: _strings(j['optional']),
      handler: _s(j['handler']),
      route: _s(j['route']),
      produces: _s(j['produces']),
      evidence: _s(j['evidence']),
      cost: _s(j['cost']),
      keywords: _strings(j['keywords']),
      status: cheCommandStatusFrom(_s(j['status'])),
      missing: [for (final m in _maps(j['missing'])) CheCommandMissing.fromJson(m)],
    );
  }
}

class CheConnectorState {
  const CheConnectorState({required this.id, required this.label, required this.state, required this.setup, required this.detail});
  final String id;
  final String label;
  final String state;
  final String setup;
  final String detail;
  bool get ready => state == 'ready';
}

class CheWorkflowStepDraft {
  CheWorkflowStepDraft({required this.command, this.input = '', this.parallel = false});
  String command;
  String input;
  bool parallel;

  Map<String, dynamic> toJson() => {'command': command, 'input': input, 'parallel': parallel};
  factory CheWorkflowStepDraft.fromJson(Map<String, dynamic> j) =>
      CheWorkflowStepDraft(command: _s(j['command']), input: _s(j['input']), parallel: j['parallel'] == true);
  CheWorkflowStepDraft copy() => CheWorkflowStepDraft(command: command, input: input, parallel: parallel);
}

class CheSavedWorkflow {
  CheSavedWorkflow({this.id = '', required this.name, required this.steps, this.updatedAt = ''});
  final String id;
  final String name;
  final List<CheWorkflowStepDraft> steps;
  final String updatedAt;

  Map<String, dynamic> toJson() => {
        if (id.isNotEmpty) 'id': id,
        'name': name,
        'steps': [for (final s in steps) s.toJson()],
        if (updatedAt.isNotEmpty) 'updated_at': updatedAt,
      };
  factory CheSavedWorkflow.fromJson(Map<String, dynamic> j) => CheSavedWorkflow(
        id: _s(j['id']),
        name: _s(j['name']),
        steps: [for (final s in _maps(j['steps'])) CheWorkflowStepDraft.fromJson(s)],
        updatedAt: _s(j['updated_at']),
      );
}

/// One step as CHE validated it (POST /api/commands/workflow/describe).
class CheWorkflowPlanStep {
  const CheWorkflowPlanStep({
    required this.id,
    required this.command,
    required this.title,
    required this.purpose,
    required this.mode,
    required this.input,
    required this.dependsOn,
    required this.produces,
    required this.connectors,
    required this.approvalRequired,
    required this.approvalReason,
    required this.status,
    required this.cost,
    required this.valid,
  });
  final String id;
  final String command;
  final String title;
  final String purpose;
  final String mode;
  final String input;
  final List<String> dependsOn;
  final String produces;
  final List<CheConnectorState> connectors;
  final bool approvalRequired;
  final String approvalReason;
  final CheCommandStatus status;
  final String cost;
  final bool valid;

  factory CheWorkflowPlanStep.fromJson(Map<String, dynamic> j) {
    final approval = j['approval'] is Map ? Map<String, dynamic>.from(j['approval'] as Map) : const <String, dynamic>{};
    return CheWorkflowPlanStep(
      id: _s(j['id']),
      command: _s(j['command']),
      title: _s(j['title']),
      purpose: _s(j['purpose']),
      mode: _s(j['mode']),
      input: _s(j['input']),
      dependsOn: _strings(j['depends_on']),
      produces: _s(j['produces']),
      connectors: [
        for (final c in _maps(j['connectors']))
          CheConnectorState(id: _s(c['id']), label: _s(c['label']), state: c['ready'] == true ? 'ready' : 'not_ready', setup: '', detail: ''),
      ],
      approvalRequired: approval['required'] == true,
      approvalReason: _s(approval['reason']),
      status: cheCommandStatusFrom(_s(j['status'])),
      cost: _s(j['cost']),
      valid: j['valid'] == true,
    );
  }
}

class CheWorkflowPlan {
  const CheWorkflowPlan({required this.name, required this.steps, required this.issues, required this.ok, required this.runnable, required this.approvals});
  final String name;
  final List<CheWorkflowPlanStep> steps;
  final List<String> issues;
  final bool ok;
  final bool runnable;
  final List<String> approvals;

  factory CheWorkflowPlan.fromJson(Map<String, dynamic> j) => CheWorkflowPlan(
        name: _s(j['name']),
        steps: [for (final s in _maps(j['steps'])) CheWorkflowPlanStep.fromJson(s)],
        issues: _strings(j['issues']),
        ok: j['ok'] == true,
        runnable: j['runnable'] == true,
        approvals: _strings(j['approvals']),
      );
}

/// One command the owner ran, with its real outcome (newest first).
class CheCommandRun {
  const CheCommandRun({required this.command, required this.input, required this.status, required this.source, required this.reply, required this.at});
  final String command;
  final String input;
  final String status;
  final String source;
  final String reply;
  final String at;

  factory CheCommandRun.fromJson(Map<String, dynamic> j) => CheCommandRun(
        command: _s(j['command']), input: _s(j['input']), status: _s(j['status']), source: _s(j['source']), reply: _s(j['reply']), at: _s(j['at']));
}

class CheMissionStep {
  const CheMissionStep({
    required this.id,
    required this.command,
    required this.title,
    required this.status,
    required this.dependsOn,
    required this.needsApproval,
    required this.output,
    required this.evidence,
    required this.recovery,
    required this.verifiedBy,
  });
  final String id;
  final String command;
  final String title;
  final String status;
  final List<String> dependsOn;
  final bool needsApproval;
  final String output;
  final List<String> evidence;
  final String recovery;
  final String verifiedBy;

  bool get awaitingApproval => status == 'awaiting_approval';
  bool get failed => status == 'failed';

  factory CheMissionStep.fromJson(Map<String, dynamic> j) => CheMissionStep(
        id: _s(j['id']),
        command: _s(j['command']),
        title: _s(j['title']),
        status: _s(j['status']),
        dependsOn: _strings(j['depends_on']),
        needsApproval: j['needs_approval'] == true,
        output: _s(j['output']),
        evidence: _strings(j['evidence']),
        recovery: _s(j['recovery']),
        verifiedBy: _s(j['verified_by']),
      );
}

/// A workflow run on CHE's objective graph.
class CheMission {
  const CheMission({required this.id, required this.name, required this.status, required this.paused, required this.steps, required this.spoken});
  final String id;
  final String name;
  final String status;
  final bool paused;
  final List<CheMissionStep> steps;
  final String spoken;

  bool get finished => status == 'complete' || status == 'cancelled';

  factory CheMission.fromJson(Map<String, dynamic> j) => CheMission(
        id: _s(j['id']),
        name: _s(j['name']),
        status: _s(j['status']),
        paused: j['paused'] == true,
        steps: [for (final s in _maps(j['steps'])) CheMissionStep.fromJson(s)],
        spoken: _s(j['spoken']),
      );
}

/// Plain words for a step or run state.
String cheStepStatusLabel(String status) => switch (status) {
      'complete' || 'completed' => 'Completed',
      'running' => 'Running',
      'pending' => 'Waiting',
      'blocked' => 'Blocked by a failed step',
      'failed' => 'Failed',
      'cancelled' => 'Cancelled',
      'awaiting_approval' => 'Needs your approval',
      'paused' => 'Paused',
      'active' => 'Running',
      'needs_replan' => 'Stopped: needs you',
      _ => status,
    };

/// One suggestion card attached to a CHE reply.
class CheSuggestionCard {
  const CheSuggestionCard({required this.id, required this.label, required this.commands});
  final String id;
  final String label;
  final List<({String id, String title, String summary, bool approval, CheCommandStatus status})> commands;

  factory CheSuggestionCard.fromJson(Map<String, dynamic> j) => CheSuggestionCard(
        id: _s(j['id']),
        label: _s(j['label']),
        commands: [
          for (final c in _maps(j['commands']))
            (
              id: _s(c['id']),
              title: _s(c['title']),
              summary: _s(c['summary']),
              approval: c['approval'] == true,
              status: cheCommandStatusFrom(_s(c['status'])),
            ),
        ],
      );
}

List<CheSuggestionCard> cheSuggestionsFrom(Object? event) {
  if (event is! Map || event['type'] != 'command_suggestions') return const [];
  return [for (final c in _maps(event['suggestions'])) CheSuggestionCard.fromJson(c)].where((c) => c.commands.isNotEmpty).take(2).toList();
}

class CheCommandCatalog {
  const CheCommandCatalog({
    required this.categories,
    required this.commands,
    required this.connectors,
    required this.templates,
    required this.workflows,
    required this.runs,
    required this.missions,
  });

  final List<CheCommandCategory> categories;
  final List<CheCommandInfo> commands;
  final Map<String, CheConnectorState> connectors;
  final List<CheSavedWorkflow> templates;
  final List<CheSavedWorkflow> workflows;
  final List<CheCommandRun> runs;
  final List<CheMission> missions;

  static const empty = CheCommandCatalog(categories: [], commands: [], connectors: {}, templates: [], workflows: [], runs: [], missions: []);

  bool get isEmpty => commands.isEmpty;

  CheCommandInfo? byId(String id) {
    final clean = id.toLowerCase().replaceFirst('/', '');
    for (final c in commands) {
      if (c.id == clean) return c;
    }
    return null;
  }

  List<CheCommandInfo> inCategory(String id) => [for (final c in commands) if (c.category == id) c];

  factory CheCommandCatalog.fromJson(Map<String, dynamic> j) {
    final connectors = <String, CheConnectorState>{};
    final rawConnectors = j['connectors'];
    if (rawConnectors is Map) {
      rawConnectors.forEach((key, value) {
        if (value is Map) {
          connectors[key.toString()] = CheConnectorState(
            id: key.toString(), label: _s(value['label']), state: _s(value['state']), setup: _s(value['setup']), detail: _s(value['detail']));
        }
      });
    }
    return CheCommandCatalog(
      categories: [for (final c in _maps(j['categories'])) CheCommandCategory.fromJson(c)],
      commands: [for (final c in _maps(j['commands'])) CheCommandInfo.fromJson(c)],
      connectors: connectors,
      templates: [for (final t in _maps(j['templates'])) CheSavedWorkflow.fromJson(t)],
      workflows: [for (final w in _maps(j['workflows'])) CheSavedWorkflow.fromJson(w)],
      runs: [for (final r in _maps(j['runs'])) CheCommandRun.fromJson(r)],
      missions: [for (final m in _maps(j['missions'])) CheMission.fromJson(m)],
    );
  }

  /// The category these words name ("YouTube", "trading", "money
  /// management"), or null. Only a whole name counts, so "price a website"
  /// is a search, not the Websites category.
  CheCommandCategory? categoryNamed(String words) {
    final said = words.toLowerCase().replaceAll('&', ' and ').replaceAll(RegExp(r'[^a-z0-9 ]+'), ' ').split(RegExp(r'\s+'))
        .where((w) => w.isNotEmpty && !_generic.contains(w)).join(' ');
    if (said.isEmpty) return null;
    for (final c in categories) {
      final title = c.title.toLowerCase().replaceAll('&', ' and ').replaceAll(RegExp(r'[^a-z0-9 ]+'), ' ').split(RegExp(r'\s+')).where((w) => w.isNotEmpty).join(' ');
      if (said == c.id || said == title || (_categoryAliases[c.id]?.contains(said) ?? false)) return c;
    }
    return null;
  }

  /// Search by command name or by goal ("find website clients"), the same
  /// deterministic word overlap the Worker uses (command_catalog.js). On the
  /// phone a category's name also counts: "YouTube" lists every YouTube
  /// command, and a goal that names a category ("publish faceless YouTube
  /// videos") puts that category's commands first.
  List<CheCommandInfo> search(String query, {int limit = 20}) {
    final raw = query.trim().toLowerCase();
    if (raw.isEmpty) return const [];
    final whole = categoryNamed(raw);
    if (whole != null) return inCategory(whole.id).take(limit).toList();
    final dashed = raw.replaceFirst(RegExp(r'^/'), '').replaceAll(RegExp(r'\s+'), '-');
    final terms = {for (final w in _words(raw)) _stem(w)};
    final named = {
      for (final w in raw.replaceAll(RegExp(r'[^a-z0-9 ]+'), ' ').split(RegExp(r'\s+')))
        for (final c in categories)
          if (w == c.id || (_categoryAliases[c.id]?.contains(w) ?? false)) c.id,
    };
    final scored = <(CheCommandInfo, int)>[];
    for (final c in commands) {
      var score = 0;
      if (c.id == dashed) score += 100;
      if (c.id.contains(dashed)) score += 20;
      final name = {for (final w in _words(c.id)) _stem(w)};
      final body = {for (final w in _words('${c.title} ${c.summary} ${c.does}')) _stem(w)};
      final keys = c.keywords.join(' ').toLowerCase();
      for (final t in terms) {
        if (name.contains(t)) score += 6;
        if (body.contains(t)) score += 2;
        if (RegExp('\\b${RegExp.escape(t)}').hasMatch(keys)) score += 4;
      }
      for (final k in c.keywords) {
        if (k.contains(' ') && raw.contains(k)) score += 8;
      }
      if (named.contains(c.category)) score += 30;
      if (score > 0) scored.add((c, score));
    }
    scored.sort((a, b) {
      final byScore = b.$2.compareTo(a.$2);
      return byScore != 0 ? byScore : commands.indexOf(a.$1).compareTo(commands.indexOf(b.$1));
    });
    return [for (final s in scored.take(limit)) s.$1];
  }
}

// Other words people use for a category's name, keyed by the Worker's
// category ids. A missing id is simply never matched.
const _categoryAliases = {
  'youtube': {'yt', 'youtube videos', 'videos', 'faceless youtube', 'faceless videos', 'youtube channel'},
  'trading': {'trade', 'trades', 'futures'},
  'build': {'websites', 'websites and apps', 'apps', 'websites apps and ai'},
  'money': {'finance', 'finances', 'money management'},
  'clients': {'client', 'client scouting', 'leads'},
  'marketing': {'marketing and sales', 'sales'},
  'office': {'office and automation', 'automation'},
  'intelligence': {'intelligence and control'},
};

// Words that do not change which category is meant.
const _generic = {'the', 'my', 'your', 'all', 'every', 'commands', 'command', 'category', 'section', 'tools', 'che', 'ches', 's'};

const _stop = {
  'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'my', 'me', 'i', 'is', 'it', 'with', 'how', 'can', 'do', 'what',
  'some', 'want', 'make', 'get', 'che', 'please', 'help', 'your', 'you', 'about',
};
Iterable<String> _words(String text) => text
    .toLowerCase()
    .replaceAll(RegExp(r'[^a-z0-9/& -]+'), ' ')
    .split(RegExp(r'[\s/-]+'))
    .where((w) => w.length > 1 && !_stop.contains(w));
String _stem(String w) => w.replaceFirst(RegExp(r'ies$'), 'y').replaceFirst(RegExp(r'(?:ing|ed|es|s)$'), '');
