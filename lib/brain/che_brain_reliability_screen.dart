// Brain → Reliability Registry: every recorded test of CHE (sessions, questions, retests, proposed tests never run),
// with the exact question, CHE's actual reply, the grade and its evidence (/api/brain/reliability,
// server/cloudflare/reliability_registry.js). Counts are lower bounds while the history is incomplete, and the page
// says so. Loading is quiet (AGENTS.md); only Read Aloud, "Which test are we on?" and a tapped row speak.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

class CheReliabilityClient {
  CheReliabilityClient({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  Future<CheReliabilityView> load() async {
    if (baseUrl.isEmpty) throw Exception('CHE is not connected on this iPhone yet.');
    final http.Response r;
    try {
      r = await _client.get(Uri.parse('$baseUrl/api/brain/reliability'), headers: headers()).timeout(const Duration(seconds: 20));
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
    return CheReliabilityView.fromJson(map);
  }
}

int _n(Object? v) => (v as num?)?.toInt() ?? 0;
String _s(Object? v) => v == null ? '' : '$v';

/// One test question as the registry keeps it.
class CheTestAttempt {
  const CheTestAttempt({
    required this.key,
    required this.number,
    required this.sessionNumber,
    required this.attemptInSession,
    required this.at,
    required this.question,
    required this.reply,
    required this.outcome,
    required this.category,
    required this.reason,
    required this.retestOf,
    required this.evidence,
  });
  final String key;
  final int number;
  final int sessionNumber;
  final int attemptInSession;
  final String at;
  final String question;
  final String reply;
  final String outcome;
  final String category;
  final String reason;
  final String retestOf;
  final List<String> evidence;

  factory CheTestAttempt.fromJson(Map<String, dynamic> j) => CheTestAttempt(
        key: _s(j['key']),
        number: _n(j['number']),
        sessionNumber: _n(j['session_number']),
        attemptInSession: _n(j['attempt_in_session']),
        at: _s(j['at']),
        question: _s(j['question']),
        reply: _s(j['reply']),
        outcome: _s(j['outcome']).isEmpty ? 'unknown' : _s(j['outcome']),
        category: _s(j['category']).replaceAll('_', ' '),
        reason: _s(j['failure_reason']),
        retestOf: _s(j['retest_of_key']),
        evidence: [for (final e in (j['evidence'] as List? ?? const [])) if (e is Map && _s(e['url']).isNotEmpty) _s(e['url'])],
      );

  String get spoken => 'Test question $number, question $attemptInSession of session $sessionNumber, ${cheDateLabel(at)}. '
      'Category: $category. Result: $outcome${reason.isEmpty ? '' : ', $reason'}.${retestOf.isEmpty ? '' : ' This was a retest.'} '
      'The question was: $question. CHE answered: $reply';
}

class CheTestSession {
  const CheTestSession({required this.id, required this.number, required this.title, required this.firstAt, required this.channel, required this.attempts, required this.outcomes});
  final String id;
  final int number;
  final String title;
  final String firstAt;
  final String channel;
  final int attempts;
  final Map<String, int> outcomes;

  factory CheTestSession.fromJson(Map<String, dynamic> j) => CheTestSession(
        id: _s(j['id']),
        number: _n(j['number']),
        title: _s(j['title']),
        firstAt: _s(j['first_at']),
        channel: _s(j['channel']),
        attempts: _n(j['attempts']),
        outcomes: {for (final e in Map<String, dynamic>.from(j['outcomes'] as Map? ?? const {}).entries) e.key: _n(e.value)},
      );

  String get outcomeLine => '${outcomes['pass'] ?? 0} passed, ${outcomes['partial'] ?? 0} partial, ${outcomes['fail'] ?? 0} failed, '
      '${outcomes['blocked'] ?? 0} blocked, ${outcomes['unknown'] ?? 0} unknown';
}

class CheReliabilityView {
  const CheReliabilityView({
    required this.lowerBound,
    required this.sessions,
    required this.attempts,
    required this.totals,
    required this.outcomes,
    required this.mostFailed,
    required this.summary,
    required this.take,
    required this.inaccessible,
    required this.missing,
  });
  final bool lowerBound;
  final List<CheTestSession> sessions;
  final List<CheTestAttempt> attempts;
  final Map<String, int> totals;
  final Map<String, int> outcomes;
  final List<(String, int)> mostFailed;
  final String summary;
  final String take;
  final List<String> inaccessible;
  final int missing;

  factory CheReliabilityView.fromJson(Map<String, dynamic> j) {
    final t = Map<String, dynamic>.from(j['totals'] as Map? ?? const {});
    final coverage = Map<String, dynamic>.from(j['coverage'] as Map? ?? const {});
    return CheReliabilityView(
      lowerBound: j['lower_bound'] != false,
      sessions: [for (final s in (j['sessions'] as List? ?? const [])) CheTestSession.fromJson(Map<String, dynamic>.from(s as Map))],
      attempts: [for (final a in (j['attempts'] as List? ?? const [])) CheTestAttempt.fromJson(Map<String, dynamic>.from(a as Map))],
      totals: {for (final k in const ['sessions', 'attempts', 'retests', 'proposed_unexecuted', 'verified_results', 'unknown_results', 'fabricated', 'no_answer', 'misrouted']) k: _n(t[k])},
      outcomes: {for (final e in Map<String, dynamic>.from(t['outcomes'] as Map? ?? const {}).entries) e.key: _n(e.value)},
      mostFailed: [for (final m in (t['most_failed'] as List? ?? const [])) if (m is Map) (_s(m['category']).replaceAll('_', ' '), _n(m['count']))],
      summary: _s(j['summary']),
      take: _s(j['take']),
      inaccessible: [for (final s in (coverage['sources_inaccessible'] as List? ?? const [])) _s(s)],
      missing: (j['missing_records'] as List? ?? const []).length,
    );
  }

  bool get isEmpty => attempts.isEmpty;
  List<CheTestAttempt> attemptsOf(int sessionNumber) => [for (final a in attempts) if (a.sessionNumber == sessionNumber) a];
}

/// "October 8, 2026, 11:14 PM" in the phone's time zone, or "an unrecorded time".
String cheDateLabel(String iso) {
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return 'an unrecorded time';
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  return '${months[t.month - 1]} ${t.day}, ${t.year}, $h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
}

class CheBrainReliabilityScreen extends StatefulWidget {
  const CheBrainReliabilityScreen({super.key, required this.client, this.onSpeak, this.onListen});
  final CheReliabilityClient client;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;

  @override
  State<CheBrainReliabilityScreen> createState() => _CheBrainReliabilityScreenState();
}

class _CheBrainReliabilityScreenState extends State<CheBrainReliabilityScreen> {
  CheReliabilityView? _view;
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
      setState(() => _error = 'I could not load the test registry: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  void _say(String text) {
    if (widget.onSpeak == null) return;
    HapticFeedback.selectionClick();
    widget.onSpeak!(text);
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final theme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Reliability Registry'),
        actions: [
          IconButton(tooltip: 'Ask CHE about your tests by voice', icon: const Icon(Icons.mic_rounded), onPressed: widget.onListen),
          IconButton(tooltip: 'Reload the test registry', icon: const Icon(Icons.refresh_rounded), onPressed: () => unawaited(_load())),
        ],
      ),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: theme.titleMedium)))
          : v == null
              // Passive loading stays quiet: muted text, no announcement.
              ? Center(child: Text('Loading the test registry…', style: theme.bodyLarge?.copyWith(color: Theme.of(context).hintColor)))
              : _body(context, v),
    );
  }

  Widget _body(BuildContext context, CheReliabilityView v) {
    final theme = Theme.of(context).textTheme;
    final buttons = Wrap(spacing: 8, runSpacing: 8, children: [
      OutlinedButton.icon(icon: const Icon(Icons.record_voice_over_rounded), label: const Text('Read Aloud'), onPressed: widget.onSpeak == null ? null : () => _say(v.summary)),
      OutlinedButton.icon(icon: const Icon(Icons.tag), label: const Text('Which test are we on?'), onPressed: widget.onSpeak == null || v.take.isEmpty ? null : () => _say(v.take)),
    ]);
    if (v.isEmpty) {
      return ListView(padding: const EdgeInsets.all(16), children: [
        Text('No tests recorded yet', style: theme.titleLarge),
        const SizedBox(height: 8),
        Text('Say "Let\'s test CHE\'s reliability" to start a session. Each question and CHE\'s actual reply will be recorded here.', style: theme.bodyLarge),
        const SizedBox(height: 8),
        buttons,
      ]);
    }
    final t = v.totals;
    final o = v.outcomes;
    final atLeast = v.lowerBound ? 'at least ' : '';
    final tiles = <(IconData, String, String, String)>[
      (Icons.event_note_rounded, 'Testing sessions', '$atLeast${t['sessions']}', 'occasions you tested CHE, counted only when a question was asked'),
      (Icons.help_outline_rounded, 'Questions asked', '$atLeast${t['attempts']}', 'individual test questions, retests included'),
      (Icons.replay_rounded, 'Retests', '${t['retests']}', 'questions asked again on a later occasion; already inside the questions count'),
      (Icons.verified_rounded, 'Graded with evidence', '${t['verified_results']}', 'results with a recorded reply or a grader\'s record'),
      (Icons.help_outline_rounded, 'Unknown results', '${t['unknown_results']}', 'no reply or grade is recorded'),
      (Icons.schedule_rounded, 'Proposed, never run', '${t['proposed_unexecuted']}', 'not counted as tests'),
      (Icons.fact_check_rounded, 'Outcomes', '${o['pass'] ?? 0} pass', '${o['partial'] ?? 0} partial, ${o['fail'] ?? 0} failed, ${o['blocked'] ?? 0} blocked, ${o['unknown'] ?? 0} unknown'),
      (Icons.error_outline_rounded, 'Invented facts', '${t['fabricated']}', 'answers that stated things the records disprove'),
      (Icons.hourglass_empty_rounded, 'No answer', '${t['no_answer']}', '"Working on it" or the failed-answer fallback instead of an answer'),
      (Icons.alt_route_rounded, 'Wrong handler', '${t['misrouted']}', 'answered by an unrelated route'),
    ];
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(v.summary, style: theme.titleMedium),
        const SizedBox(height: 8),
        buttons,
        if (v.lowerBound) ...[
          const SizedBox(height: 12),
          Semantics(
            container: true,
            label: 'These counts are lower bounds. Sources that could not be read: ${v.inaccessible.join('; ')}. ${v.missing} referenced tests are missing their records.',
            child: ExcludeSemantics(
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text('Lower bound: some history could not be read (${v.inaccessible.length} sources), and ${v.missing} referenced tests have no recoverable record.', style: theme.bodyMedium),
                ),
              ),
            ),
          ),
        ],
        const SizedBox(height: 16),
        for (final (icon, title, value, detail) in tiles) _tile(icon, title, value, detail),
        if (v.mostFailed.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text('Most failed', style: theme.titleLarge),
          for (final (name, count) in v.mostFailed) _tile(Icons.trending_down, name, '$count', 'failed or partial answers'),
        ],
        const SizedBox(height: 16),
        Text('Sessions, newest first', style: theme.titleLarge),
        for (final s in v.sessions.reversed) _session(v, s),
      ],
    );
  }

  Widget _tile(IconData icon, String title, String value, String detail) {
    // The tap lives on this Semantics node: ExcludeSemantics below drops the ListTile's own tap action, so without
    // it VoiceOver would announce a button it cannot activate (review of #684).
    return Semantics(
      container: true,
      button: widget.onSpeak != null,
      label: '$title: $value. $detail.',
      onTap: widget.onSpeak == null ? null : () => _say('$title: $value. $detail.'),
      child: ExcludeSemantics(
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(icon),
          title: Text(title),
          subtitle: Text(detail),
          trailing: Text(value, style: Theme.of(context).textTheme.titleMedium),
          onTap: widget.onSpeak == null ? null : () => _say('$title: $value. $detail.'),
        ),
      ),
    );
  }

  Widget _session(CheReliabilityView v, CheTestSession s) {
    final label = 'Session ${s.number}: ${s.title}. ${cheDateLabel(s.firstAt)}. ${s.attempts} ${s.attempts == 1 ? 'question' : 'questions'}: ${s.outcomeLine}.';
    // The label sits inside the header, so it is on the same node as ExpansionTile's own tap (expand/collapse).
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      title: Semantics(label: label, excludeSemantics: true, child: Text('Session ${s.number}: ${s.title}', maxLines: 2, overflow: TextOverflow.ellipsis)),
      subtitle: ExcludeSemantics(child: Text('${cheDateLabel(s.firstAt)} · ${s.outcomeLine}')),
      children: [for (final a in v.attemptsOf(s.number)) _attempt(a)],
    );
  }

  Widget _attempt(CheTestAttempt a) {
    final icon = switch (a.outcome) {
      'pass' => Icons.check_circle_rounded,
      'partial' => Icons.timelapse_rounded,
      'fail' => Icons.cancel,
      'blocked' => Icons.block_rounded,
      _ => Icons.help_outline_rounded,
    };
    return Semantics(
      container: true,
      button: widget.onSpeak != null,
      label: a.spoken,
      onTap: widget.onSpeak == null ? null : () => _say(a.spoken),
      child: ExcludeSemantics(
        child: ListTile(
          leading: Icon(icon),
          title: Text('#${a.number} · ${a.outcome.toUpperCase()} · ${a.category}${a.retestOf.isEmpty ? '' : ' · retest'}'),
          subtitle: Text('Q: ${a.question}\nCHE: ${a.reply}${a.reason.isEmpty ? '' : '\nWhy: ${a.reason}'}', maxLines: 6, overflow: TextOverflow.ellipsis),
          isThreeLine: true,
          onTap: widget.onSpeak == null ? null : () => _say(a.spoken),
        ),
      ),
    );
  }
}
