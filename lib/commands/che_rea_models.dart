// REA investigations, exactly as the Worker serves them (GET
// /api/rea/investigations and /api/rea/investigations/<id>). Parsing is
// tolerant: a missing or odd field becomes empty, and a word the phone does
// not know becomes `unknown`, so a newer Worker never breaks this page. The
// phone never invents a stage, a feature, a screenshot or a result.

String _s(Object? v) => v == null ? '' : v.toString().trim();
List<Map<String, dynamic>> _maps(Object? v) => [
      if (v is List)
        for (final item in v)
          if (item is Map) Map<String, dynamic>.from(item),
    ];
List<String> _strings(Object? v) => [
      if (v is List)
        for (final item in v)
          if (item != null && item is! Map && item is! List && item.toString().trim().isNotEmpty) item.toString().trim(),
    ];
Map<String, dynamic>? _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : null;
int _int(Object? v) => v is num ? v.toInt() : int.tryParse(_s(v)) ?? 0;
int? _intOrNull(Object? v) => v is num ? v.toInt() : int.tryParse(_s(v).replaceFirst('#', ''));
bool _bool(Object? v) => v == true || v == 1 || _s(v).toLowerCase() == 'true';
String _lower(Object? v) => _s(v).toLowerCase();

/// The 13 REA stages in order, with the words used when CHE sends no label.
const cheReaStageOrder = <(String, String)>[
  ('understand', 'Understand the request'),
  ('discover', 'Discover sources'),
  ('inspect', 'Inspect'),
  ('map', 'Map behavior'),
  ('architecture', 'Architecture'),
  ('compare', 'Compare with CHE'),
  ('plan', 'Plan'),
  ('build', 'Build'),
  ('test', 'Test'),
  ('review', 'Review'),
  ('integrate', 'Integrate'),
  ('verify', 'Verify'),
  ('remember', 'Remember'),
];

enum CheReaTargetKind { npm, github, website, appStore, privateApp, unknown }

CheReaTargetKind cheReaTargetKindFrom(Object? raw) => switch (_lower(raw)) {
      'npm' => CheReaTargetKind.npm,
      'github' => CheReaTargetKind.github,
      'website' => CheReaTargetKind.website,
      'app_store' => CheReaTargetKind.appStore,
      'private_app' => CheReaTargetKind.privateApp,
      _ => CheReaTargetKind.unknown,
    };

String cheReaTargetKindLabel(CheReaTargetKind kind) => switch (kind) {
      CheReaTargetKind.npm => 'npm package',
      CheReaTargetKind.github => 'GitHub repository',
      CheReaTargetKind.website => 'website',
      CheReaTargetKind.appStore => 'App Store app',
      CheReaTargetKind.privateApp => 'private app',
      CheReaTargetKind.unknown => 'unknown kind',
    };

enum CheReaState { queued, running, complete, failed, stalled, limited, unknown }

CheReaState cheReaStateFrom(Object? raw) => switch (_lower(raw)) {
      'queued' => CheReaState.queued,
      'running' => CheReaState.running,
      'complete' => CheReaState.complete,
      'failed' => CheReaState.failed,
      'stalled' => CheReaState.stalled,
      'limited' => CheReaState.limited,
      _ => CheReaState.unknown,
    };

String cheReaStateLabel(CheReaState state) => switch (state) {
      CheReaState.queued => 'Queued',
      CheReaState.running => 'Running',
      CheReaState.complete => 'Complete',
      CheReaState.failed => 'Failed',
      CheReaState.stalled => 'Stalled',
      // CHE could not inspect it all, and says what else it can do.
      CheReaState.limited => 'Limited: could not inspect everything',
      CheReaState.unknown => 'State unknown',
    };

enum CheReaStageState { done, running, pending, skipped, blocked, failed, unknown }

CheReaStageState cheReaStageStateFrom(Object? raw) => switch (_lower(raw)) {
      'done' => CheReaStageState.done,
      'running' => CheReaStageState.running,
      'pending' => CheReaStageState.pending,
      'skipped' => CheReaStageState.skipped,
      'blocked' => CheReaStageState.blocked,
      'failed' => CheReaStageState.failed,
      _ => CheReaStageState.unknown,
    };

String cheReaStageStateLabel(CheReaStageState state) => switch (state) {
      CheReaStageState.done => 'done',
      CheReaStageState.running => 'running',
      CheReaStageState.pending => 'pending',
      CheReaStageState.skipped => 'skipped',
      CheReaStageState.blocked => 'blocked',
      CheReaStageState.failed => 'failed',
      CheReaStageState.unknown => 'not reported',
    };

enum CheReaComplexity { low, medium, high, unknown }

CheReaComplexity cheReaComplexityFrom(Object? raw) => switch (_lower(raw)) {
      'low' => CheReaComplexity.low,
      'medium' => CheReaComplexity.medium,
      'high' => CheReaComplexity.high,
      _ => CheReaComplexity.unknown,
    };

/// Whether CHE already has a feature, as the comparison found it.
enum CheReaCheStatus { has, partial, missing, unknown }

CheReaCheStatus cheReaCheStatusFrom(Object? raw) => switch (_lower(raw)) {
      'has' => CheReaCheStatus.has,
      'partial' => CheReaCheStatus.partial,
      'missing' => CheReaCheStatus.missing,
      _ => CheReaCheStatus.unknown,
    };

String cheReaCheStatusLabel(CheReaCheStatus status) => switch (status) {
      CheReaCheStatus.has => 'CHE has it',
      CheReaCheStatus.partial => 'CHE partly has it',
      CheReaCheStatus.missing => 'CHE is missing it',
      CheReaCheStatus.unknown => 'Not known whether CHE has it',
    };

/// How an architecture finding is known.
enum CheReaFindingKind { observed, inferred, unknown }

CheReaFindingKind cheReaFindingKindFrom(Object? raw) => switch (_lower(raw)) {
      'observed' => CheReaFindingKind.observed,
      'inferred' => CheReaFindingKind.inferred,
      _ => CheReaFindingKind.unknown,
    };

enum CheReaVerificationState { passed, failed, pending, notStarted, unknown }

CheReaVerificationState cheReaVerificationStateFrom(Object? raw) => switch (_lower(raw)) {
      'passed' => CheReaVerificationState.passed,
      'failed' => CheReaVerificationState.failed,
      'pending' => CheReaVerificationState.pending,
      'not_started' => CheReaVerificationState.notStarted,
      _ => CheReaVerificationState.unknown,
    };

String cheReaVerificationStateLabel(CheReaVerificationState state) => switch (state) {
      CheReaVerificationState.passed => 'passed',
      CheReaVerificationState.failed => 'failed',
      CheReaVerificationState.pending => 'pending',
      CheReaVerificationState.notStarted => 'not started',
      CheReaVerificationState.unknown => 'state unknown',
    };

/// A labelled link: a source or a piece of evidence.
class CheReaLink {
  const CheReaLink({required this.label, required this.url});
  final String label;
  final String url;

  /// What is shown and read: the label, or the link when there is none.
  String get text => label.isNotEmpty ? label : url;

  static List<CheReaLink> listFrom(Object? v) => [
        for (final j in _maps(v))
          if (_s(j['label']).isNotEmpty || _s(j['url']).isNotEmpty) CheReaLink(label: _s(j['label']), url: _s(j['url'])),
      ];
}

class CheReaTarget {
  const CheReaTarget({required this.kind, required this.label, required this.url, required this.version});
  final CheReaTargetKind kind;
  final String label;
  final String url;

  /// An npm version, a commit, an app version or a page content hash.
  final String version;

  static const empty = CheReaTarget(kind: CheReaTargetKind.unknown, label: '', url: '', version: '');

  factory CheReaTarget.fromJson(Map<String, dynamic>? j) => j == null
      ? empty
      : CheReaTarget(kind: cheReaTargetKindFrom(j['kind']), label: _s(j['label']), url: _s(j['url']), version: _s(j['version']));
}

class CheReaStage {
  const CheReaStage({required this.id, required this.label, required this.state, required this.note});
  final String id;
  final String label;
  final CheReaStageState state;
  final String note;
}

class CheReaScreenshot {
  const CheReaScreenshot({required this.label, required this.file});
  final String label;

  /// The file name under `GET /api/rea/files/<investigation id>/`.
  final String file;
}

/// Whether CHE has a feature, and the evidence for that answer.
class CheReaCheMatch {
  const CheReaCheMatch({required this.status, required this.evidence});
  final CheReaCheStatus status;
  final List<CheReaLink> evidence;
}

class CheReaFeature {
  const CheReaFeature({
    required this.id,
    required this.name,
    required this.purpose,
    required this.userSees,
    required this.operatedBy,
    required this.inputs,
    required this.outputs,
    required this.components,
    required this.dependencies,
    required this.evidence,
    required this.unknowns,
    required this.complexity,
    required this.cost,
    required this.che,
    required this.feasibleOk,
    required this.feasibleNote,
  });

  final String id;
  final String name;
  final String purpose;
  final String userSees;
  final String operatedBy;
  final List<String> inputs;
  final List<String> outputs;
  final List<String> components;
  final List<String> dependencies;
  final List<CheReaLink> evidence;
  final List<String> unknowns;
  final CheReaComplexity complexity;
  final String cost;
  final CheReaCheMatch che;

  /// Null when CHE did not say whether it can be built.
  final bool? feasibleOk;
  final String feasibleNote;

  /// The name, or the id when CHE sent no name.
  String get title => name.isNotEmpty ? name : id;

  factory CheReaFeature.fromJson(Map<String, dynamic> j, int index) {
    final che = _map(j['che']);
    final feasible = _map(j['feasible']);
    final id = _s(j['id']);
    return CheReaFeature(
      id: id.isNotEmpty ? id : 'f${index + 1}',
      name: _s(j['name']),
      purpose: _s(j['purpose']),
      userSees: _s(j['user_sees']),
      operatedBy: _s(j['operated_by']),
      inputs: _strings(j['inputs']),
      outputs: _strings(j['outputs']),
      components: _strings(j['components']),
      dependencies: _strings(j['dependencies']),
      evidence: CheReaLink.listFrom(j['evidence']),
      unknowns: _strings(j['unknowns']),
      complexity: cheReaComplexityFrom(j['complexity']),
      cost: _s(j['cost']),
      che: CheReaCheMatch(status: cheReaCheStatusFrom(che?['status']), evidence: CheReaLink.listFrom(che?['evidence'])),
      feasibleOk: feasible == null || feasible['ok'] == null ? null : _bool(feasible['ok']),
      feasibleNote: _s(feasible?['note']),
    );
  }
}

class CheReaFinding {
  const CheReaFinding({required this.label, required this.detail, required this.kind, required this.evidence});
  final String label;
  final String detail;
  final CheReaFindingKind kind;
  final List<CheReaLink> evidence;
}

class CheReaComparison {
  const CheReaComparison({required this.has, required this.partial, required this.missing, required this.unknown});
  final int has;
  final int partial;
  final int missing;
  final int unknown;

  static CheReaComparison? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : CheReaComparison(has: _int(j['has']), partial: _int(j['partial']), missing: _int(j['missing']), unknown: _int(j['unknown']));
}

class CheReaProposal {
  const CheReaProposal({required this.featureId, required this.name, required this.why});
  final String featureId;
  final String name;
  final String why;
}

class CheReaPlan {
  const CheReaPlan({required this.features, required this.steps, required this.acceptance, required this.approved});

  /// Feature ids ("f1", "f3").
  final List<String> features;
  final List<String> steps;
  final List<String> acceptance;
  final bool approved;

  static CheReaPlan? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : CheReaPlan(
          features: _strings(j['features']),
          steps: _strings(j['steps']),
          acceptance: _strings(j['acceptance']),
          approved: _bool(j['approved']),
        );
}

class CheReaBuild {
  const CheReaBuild({required this.jobId, required this.state, required this.prNumber, required this.prUrl, required this.note});
  final String jobId;
  final String state;
  final int? prNumber;
  final String prUrl;
  final String note;

  static CheReaBuild? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : CheReaBuild(jobId: _s(j['job_id']), state: _s(j['state']), prNumber: _intOrNull(j['pr_number']), prUrl: _s(j['pr_url']), note: _s(j['note']));
}

class CheReaCheck {
  const CheReaCheck({required this.name, required this.state, required this.url});
  final String name;
  final String state;
  final String url;
}

class CheReaVerification {
  const CheReaVerification({required this.state, required this.checks, required this.note});
  final CheReaVerificationState state;
  final List<CheReaCheck> checks;
  final String note;

  static CheReaVerification? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : CheReaVerification(
          state: cheReaVerificationStateFrom(j['state']),
          checks: [
            for (final c in _maps(j['checks'])) CheReaCheck(name: _s(c['name']), state: _s(c['state']), url: _s(c['url'])),
          ],
          note: _s(j['note']),
        );
}

/// What REA can inspect on this CHE, from the list response.
class CheReaCapability {
  const CheReaCapability({required this.id, required this.label, required this.available, required this.needs});
  final String id;
  final String label;
  final bool available;
  final List<String> needs;

  factory CheReaCapability.fromJson(Map<String, dynamic> j) {
    final needs = j['needs'];
    return CheReaCapability(
      id: _s(j['id']),
      label: _s(j['label']),
      available: _bool(j['available']),
      needs: needs is List ? _strings(needs) : [if (_s(needs).isNotEmpty) _s(needs)],
    );
  }
}

class CheReaInvestigation {
  const CheReaInvestigation({
    required this.id,
    required this.target,
    required this.state,
    required this.stageId,
    required this.reportedStages,
    required this.createdAt,
    required this.updatedAt,
    required this.sources,
    required this.screenshots,
    required this.features,
    required this.architecture,
    required this.comparison,
    required this.proposals,
    required this.plan,
    required this.build,
    required this.verification,
    required this.limitations,
  });

  final String id;
  final CheReaTarget target;
  final CheReaState state;

  /// The current stage's id ('map').
  final String stageId;

  /// The stages exactly as CHE sent them.
  final List<CheReaStage> reportedStages;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final List<CheReaLink> sources;

  /// Only screenshots the browser run actually captured.
  final List<CheReaScreenshot> screenshots;
  final List<CheReaFeature> features;
  final List<CheReaFinding> architecture;
  final CheReaComparison? comparison;
  final List<CheReaProposal> proposals;
  final CheReaPlan? plan;
  final CheReaBuild? build;
  final CheReaVerification? verification;
  final List<String> limitations;

  /// What the target is called, or the id when CHE sent no label.
  String get title => target.label.isNotEmpty ? target.label : (target.url.isNotEmpty ? target.url : id);

  /// All 13 stages in order, with CHE's state for each; a stage CHE did not
  /// report says "not reported". Stages the phone does not know follow.
  List<CheReaStage> get stages {
    final byId = {for (final s in reportedStages) s.id: s};
    return [
      for (final (id, label) in cheReaStageOrder)
        CheReaStage(
          id: id,
          label: byId[id]?.label.isNotEmpty == true ? byId[id]!.label : label,
          state: byId[id]?.state ?? CheReaStageState.unknown,
          note: byId[id]?.note ?? '',
        ),
      for (final s in reportedStages)
        if (!cheReaStageOrder.any((o) => o.$1 == s.id)) s,
    ];
  }

  /// The current stage, with its 1-based number, or null when CHE named none.
  ({int number, int total, CheReaStage stage})? get currentStage {
    final all = stages;
    for (final (i, s) in all.indexed) {
      if (s.id == stageId) return (number: i + 1, total: all.length, stage: s);
    }
    return null;
  }

  /// "Stage 4 of 13, Map behavior".
  String get stageText {
    final c = currentStage;
    if (c != null) return 'Stage ${c.number} of ${c.total}, ${c.stage.label}';
    return stageId.isEmpty ? 'No current stage reported' : 'Current stage: $stageId';
  }

  CheReaFeature? featureById(String id) => features.where((f) => f.id == id).firstOrNull;

  int countWith(CheReaCheStatus status) => features.where((f) => f.che.status == status).length;

  factory CheReaInvestigation.fromJson(Map<String, dynamic> j) => CheReaInvestigation(
        id: _s(j['id']),
        target: CheReaTarget.fromJson(_map(j['target'])),
        state: cheReaStateFrom(j['state']),
        stageId: _lower(j['stage']),
        reportedStages: [
          for (final s in _maps(j['stages']))
            if (_s(s['id']).isNotEmpty)
              CheReaStage(id: _lower(s['id']), label: _s(s['label']), state: cheReaStageStateFrom(s['state']), note: _s(s['note'])),
        ],
        createdAt: DateTime.tryParse(_s(j['created_at'])),
        updatedAt: DateTime.tryParse(_s(j['updated_at'])),
        sources: CheReaLink.listFrom(j['sources']),
        screenshots: [
          for (final s in _maps(j['screenshots']))
            if (_s(s['file']).isNotEmpty) CheReaScreenshot(label: _s(s['label']), file: _s(s['file'])),
        ],
        features: [for (final (i, f) in _maps(j['features']).indexed) CheReaFeature.fromJson(f, i)],
        architecture: [
          for (final a in _maps(j['architecture']))
            CheReaFinding(label: _s(a['label']), detail: _s(a['detail']), kind: cheReaFindingKindFrom(a['kind']), evidence: CheReaLink.listFrom(a['evidence'])),
        ],
        comparison: CheReaComparison.fromJson(_map(j['comparison'])),
        proposals: [
          for (final p in _maps(j['proposals'])) CheReaProposal(featureId: _s(p['feature_id']), name: _s(p['name']), why: _s(p['why'])),
        ],
        plan: CheReaPlan.fromJson(_map(j['plan'])),
        build: CheReaBuild.fromJson(_map(j['build'])),
        verification: CheReaVerification.fromJson(_map(j['verification'])),
        limitations: _strings(j['limitations']),
      );
}

/// GET /api/rea/investigations: newest first, with REA's capabilities.
class CheReaInvestigationList {
  const CheReaInvestigationList({required this.investigations, required this.capabilities});
  final List<CheReaInvestigation> investigations;
  final List<CheReaCapability> capabilities;

  factory CheReaInvestigationList.fromJson(Map<String, dynamic> j) => CheReaInvestigationList(
        investigations: [
          for (final i in _maps(j['investigations']))
            if (_s(i['id']).isNotEmpty) CheReaInvestigation.fromJson(i),
        ],
        capabilities: [for (final c in _maps(j['capabilities'])) CheReaCapability.fromJson(c)],
      );
}
