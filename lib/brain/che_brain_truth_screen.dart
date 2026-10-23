// More → Brain → Truth & Verification: what CHE's hallucination auditor checked, kept, labelled inference or removed,
// and which actions have a real receipt (/api/brain/truth, server/cloudflare/brain_truth.js). Every number is a count
// of real ledger rows or receipts; no accuracy percentage is invented. Loading is quiet; only Read Aloud speaks.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

class CheBrainTruthClient {
  CheBrainTruthClient({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  Future<CheBrainTruthView> load() async {
    if (baseUrl.isEmpty) throw Exception('CHE is not connected on this iPhone yet.');
    final http.Response r;
    try {
      r = await _client.get(Uri.parse('$baseUrl/api/brain/truth'), headers: headers()).timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw Exception('CHE did not answer within 20 seconds.');
    }
    Object? body;
    try {
      body = r.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } on FormatException {
      body = null;
    }
    final map = body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{};
    if (r.statusCode >= 400) throw Exception(map['detail']?.toString() ?? 'CHE answered ${r.statusCode}.');
    return CheBrainTruthView.fromJson(map);
  }
}

/// One audited claim, as the ledger keeps it: labels and a time, never the sentence itself.
class CheBrainTruthRow {
  const CheBrainTruthRow({required this.at, required this.claimType, required this.verdict, required this.outcome});
  final String at;
  final String claimType;
  final String verdict;
  final String outcome;

  factory CheBrainTruthRow.fromJson(Map<String, dynamic> j) => CheBrainTruthRow(
        at: '${j['at'] ?? ''}',
        claimType: '${j['claim_type'] ?? ''}',
        verdict: '${j['verdict'] ?? ''}',
        outcome: '${j['outcome'] ?? ''}',
      );

  /// "pr merged" for "pr_merged", "truth layer, deployed" for "truth_layer:deployed".
  String get claimLabel => claimType.replaceAll(':', ', ').replaceAll('_', ' ');
  String get timeLabel {
    final t = DateTime.tryParse(at)?.toLocal();
    if (t == null) return 'unknown time';
    final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
    return '${t.month}/${t.day} ${h}:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
  }
}

/// The /api/brain/truth payload.
class CheBrainTruthView {
  const CheBrainTruthView({
    required this.checked,
    required this.verified,
    required this.inferred,
    required this.unverified,
    required this.contradicted,
    required this.stale,
    required this.corrected,
    required this.evidenceCoverage,
    required this.verifiedActions,
    required this.failedTools,
    required this.recent,
    required this.windowDays,
  });
  final int checked;
  final int verified;
  final int inferred;
  final int unverified;
  final int contradicted;
  final int stale;
  final int corrected;
  final double? evidenceCoverage;
  final int verifiedActions;
  final int failedTools;
  final List<CheBrainTruthRow> recent;
  final int windowDays;

  factory CheBrainTruthView.fromJson(Map<String, dynamic> j) {
    final h = Map<String, dynamic>.from(j['health'] as Map? ?? const {});
    final r = Map<String, dynamic>.from(j['receipts'] as Map? ?? const {});
    final actions = Map<String, dynamic>.from(r['verified_actions'] as Map? ?? const {});
    int n(Object? v) => (v as num?)?.toInt() ?? 0;
    return CheBrainTruthView(
      checked: n(h['checked']),
      verified: n(h['verified']),
      inferred: n(h['inferred']),
      unverified: n(h['unverified']),
      contradicted: n(h['contradicted']),
      stale: n(h['stale']),
      corrected: n(h['corrected']),
      evidenceCoverage: (h['evidence_coverage'] as num?)?.toDouble(),
      verifiedActions: n(actions['total']),
      failedTools: n(r['failed_tools']),
      recent: [for (final row in (j['recent'] as List? ?? const [])) CheBrainTruthRow.fromJson(Map<String, dynamic>.from(row as Map))],
      windowDays: n(j['window_days']) == 0 ? 7 : n(j['window_days']),
    );
  }

  bool get isEmpty => checked == 0 && verifiedActions == 0 && failedTools == 0;
  String get coverageLabel => evidenceCoverage == null ? 'no data' : '${(evidenceCoverage! * 100).round()}% of checked claims';
}

/// The spoken overview: the same facts the tiles show.
String cheBrainTruthSummary(CheBrainTruthView v) {
  if (v.isEmpty) return 'No audit records yet. Nothing has been checked or verified in the last ${v.windowDays} days.';
  return 'In the last ${v.windowDays} days my auditor checked ${v.checked} ${v.checked == 1 ? 'claim' : 'claims'}: '
      '${v.verified} verified, ${v.inferred} labelled inference, ${v.unverified} unverified removed, ${v.contradicted} contradicted, ${v.stale} stale. '
      '${v.verifiedActions} verified ${v.verifiedActions == 1 ? 'action' : 'actions'} by receipt and ${v.failedTools} failed tool ${v.failedTools == 1 ? 'execution' : 'executions'}. '
      'Evidence coverage ${v.coverageLabel}.';
}

class CheBrainTruthScreen extends StatefulWidget {
  const CheBrainTruthScreen({super.key, required this.client, this.onSpeak, this.onListen});
  final CheBrainTruthClient client;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;

  @override
  State<CheBrainTruthScreen> createState() => _CheBrainTruthScreenState();
}

class _CheBrainTruthScreenState extends State<CheBrainTruthScreen> {
  CheBrainTruthView? _view;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final v = await widget.client.load();
      if (!mounted) return;
      setState(() { _view = v; _error = null; });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'I could not load the truth records: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final theme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Truth & Verification'),
        actions: [
          IconButton(tooltip: 'Ask CHE what she knows versus what she is guessing', icon: const Icon(Icons.mic_rounded), onPressed: widget.onListen),
          IconButton(tooltip: 'Reload the truth records', icon: const Icon(Icons.refresh_rounded), onPressed: () => unawaited(_load())),
        ],
      ),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: theme.titleMedium)))
          : v == null
              // Passive loading stays quiet: muted text, no announcement.
              ? Center(child: Text('Loading the truth records…', style: theme.bodyLarge?.copyWith(color: Theme.of(context).hintColor)))
              : _body(context, v),
    );
  }

  Widget _body(BuildContext context, CheBrainTruthView v) {
    final theme = Theme.of(context).textTheme;
    final summary = cheBrainTruthSummary(v);
    final readAloud = OutlinedButton.icon(
      icon: const Icon(Icons.record_voice_over_rounded),
      label: const Text('Read Aloud'),
      onPressed: widget.onSpeak == null ? null : () => widget.onSpeak!(summary),
    );
    if (v.isEmpty) {
      return ListView(padding: const EdgeInsets.all(16), children: [
        Semantics(container: true, label: 'No audit records yet. Nothing has been checked or verified in the last ${v.windowDays} days.',
            child: ExcludeSemantics(child: Text('No audit records yet', style: theme.titleLarge))),
        const SizedBox(height: 8),
        Text('Nothing has been checked or verified in the last ${v.windowDays} days. Counts appear here only after real audit rows and receipts exist.', style: theme.bodyLarge),
        const SizedBox(height: 8),
        readAloud,
      ]);
    }
    final tiles = <(IconData, String, String, String)>[
      (Icons.verified_rounded, 'Verified actions', '${v.verifiedActions}', 'merges, deploys, saved memories, finished videos and placed trades with a receipt in the last ${v.windowDays} days'),
      (Icons.remove_circle_outline_rounded, 'Unverified claims removed', '${v.unverified}', 'claims with no receipt behind them'),
      (Icons.warning_amber_rounded, 'Contradictions', '${v.contradicted}', 'claims a real failure receipt contradicted'),
      (Icons.error_outline_rounded, 'Failed tool executions', '${v.failedTools}', 'tool runs that did not succeed'),
      (Icons.edit_note_rounded, 'Corrected responses', '${v.corrected}', 'replies changed before you saw them'),
      (Icons.health_and_safety_rounded, 'Auditor health', '${v.checked} checked', 'claims checked; ${v.inferred} labelled inference, ${v.stale} stale'),
      (Icons.fact_check_rounded, 'Evidence coverage', v.coverageLabel, 'verified claims out of all checked claims'),
    ];
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(summary, style: theme.titleMedium),
        const SizedBox(height: 8),
        readAloud,
        const SizedBox(height: 20),
        for (final (icon, title, value, detail) in tiles) _tile(icon, title, value, detail),
        if (v.recent.isNotEmpty) ...[
          const SizedBox(height: 20),
          Text('Recent audit history', style: theme.titleLarge),
          for (final row in v.recent) _row(row),
        ],
      ],
    );
  }

  Widget _tile(IconData icon, String title, String value, String detail) {
    return Semantics(
      container: true,
      label: '$title: $value. $detail.',
      child: ExcludeSemantics(
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(icon),
          title: Text(title),
          subtitle: Text(detail),
          trailing: Text(value, style: Theme.of(context).textTheme.titleMedium),
          onTap: widget.onSpeak == null ? null : () { HapticFeedback.selectionClick(); widget.onSpeak!('$title: $value. $detail.'); },
        ),
      ),
    );
  }

  Widget _row(CheBrainTruthRow row) {
    final spoken = '${row.claimLabel}, ${row.verdict.toLowerCase()}, ${row.outcome.replaceAll('_', ' ')}, ${row.timeLabel}.';
    return Semantics(
      container: true,
      label: spoken,
      child: ExcludeSemantics(
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(row.verdict == 'VERIFIED'
              ? Icons.verified_rounded
              : row.verdict == 'INFERRED'
                  ? Icons.lightbulb_outline_rounded
                  : row.verdict == 'CONTRADICTED'
                      ? Icons.warning_amber_rounded
                      : Icons.remove_circle_outline_rounded),
          title: Text(row.claimLabel),
          subtitle: Text('${row.verdict} · ${row.outcome.replaceAll('_', ' ')} · ${row.timeLabel}'),
          onTap: widget.onSpeak == null ? null : () { HapticFeedback.selectionClick(); widget.onSpeak!(spoken); },
        ),
      ),
    );
  }
}
