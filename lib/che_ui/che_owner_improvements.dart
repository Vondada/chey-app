// Owner Improvements (owner, 2026-10-23): what the owner asked CHE to change, where each request stands, and the
// evidence (server/cloudflare/owner_improvements.js). Compact chrome HUD cards grouped by status; each opens to its
// id, history, evidence and acceptance criteria, with Undo for a setting change and "Send to engineers" for a logged
// coding task. Loading is quiet; Read Aloud and the owner's own actions speak. Every action also works by voice:
// "open owner improvements", "what improvements are open", "undo that", "start coding task imp-…".
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'che_chrome_status.dart';
import 'che_hud.dart';
import 'che_screen_awareness.dart';
import 'che_ui_preferences.dart';

class CheOwnerImprovementsClient {
  CheOwnerImprovementsClient({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  Future<Map<String, dynamic>> _decode(Future<http.Response> Function() send) async {
    if (baseUrl.isEmpty) throw Exception('CHE is not connected on this iPhone yet.');
    final http.Response r;
    try {
      r = await send().timeout(const Duration(seconds: 20));
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
    if (r.statusCode >= 400 && map['spoken'] == null) throw Exception(map['detail']?.toString() ?? 'CHE answered ${r.statusCode}.');
    return map;
  }

  Future<Map<String, dynamic>> view() => _decode(() => _client.get(Uri.parse('$baseUrl/api/owner/improvements'), headers: headers()));
  Future<Map<String, dynamic>> uiConfig() => _decode(() => _client.get(Uri.parse('$baseUrl/api/owner/ui-config'), headers: headers()));
  Future<Map<String, dynamic>> act(String id, String action, [Map<String, dynamic> body = const {}]) => _decode(() => _client.post(
        Uri.parse('$baseUrl/api/owner/improvements/$id/$action'),
        headers: {...headers(), 'Content-Type': 'application/json'},
        body: jsonEncode(body),
      ));
}

/// Applies the owner's preferences from CHE's server to this app with no new build, and, for a change CHE just
/// made, reports back what the app now uses so the improvement can be marked Verified (or reverted). Quiet: it never
/// speaks; the caller shows a banner for an owner-requested change.
class CheOwnerConfigSync {
  CheOwnerConfigSync._();

  /// Startup and refresh: newer server preferences apply; nothing is reported.
  static Future<void> refresh(CheOwnerImprovementsClient client, {CheUiPreferences? prefs}) async {
    try {
      final c = await client.uiConfig();
      final values = c['values'];
      if (values is Map) await (prefs ?? CheUiPreferences.instance).applyOwnerConfig(Map<String, dynamic>.from(values), rev: (c['rev'] as num?)?.toInt() ?? 0);
    } catch (_) {
      // Offline or unpaired: the preferences saved on this iPhone stay as they are.
    }
  }

  /// A reply's `ui_config`: apply it, then tell CHE what the app really uses now. Returns that report's status
  /// ('verified', 'failed') or null when there was nothing to confirm.
  static Future<String?> applyReply(Map<String, dynamic> uiConfig, CheOwnerImprovementsClient client, {CheUiPreferences? prefs, String build = ''}) async {
    final p = prefs ?? CheUiPreferences.instance;
    final values = uiConfig['values'];
    if (values is! Map) return null;
    final applied = await p.applyOwnerConfig(Map<String, dynamic>.from(values), rev: (uiConfig['rev'] as num?)?.toInt() ?? 0, force: true);
    final id = uiConfig['task_id']?.toString() ?? '';
    if (id.isEmpty) return null;
    try {
      final out = await client.act(id, 'applied', {'applied': applied, if (build.isNotEmpty) 'build': build});
      return out['status']?.toString();
    } catch (_) {
      return null;
    }
  }
}

const kImprovementGroups = <(String, String)>[
  ('requested', 'Requested'),
  ('investigating', 'Investigating'),
  ('configuring', 'Configuring'),
  ('coding', 'Coding'),
  ('testing', 'Testing'),
  ('awaiting_approval', 'Awaiting approval'),
  ('verified', 'Verified'),
  ('failed', 'Failed or blocked'),
];

String cheImprovementStatusLabel(String status) =>
    kImprovementGroups.firstWhere((g) => g.$1 == status, orElse: () => (status, status)).$2;

/// The spoken overview: the same facts the page shows.
String cheImprovementsSummary(Map<String, dynamic> v) {
  final tasks = [for (final t in (v['tasks'] as List? ?? const [])) Map<String, dynamic>.from(t as Map)];
  if (tasks.isEmpty) return 'There are no owner improvements yet. Tell me what feels wrong and I will take it from there.';
  final parts = <String>[];
  for (final (id, label) in kImprovementGroups) {
    final n = tasks.where((t) => t['status'] == id).length;
    if (n > 0) parts.add('$n $label');
  }
  return '${tasks.length} improvement${tasks.length == 1 ? '' : 's'}: ${parts.join(', ')}.';
}

class CheOwnerImprovementsScreen extends StatefulWidget {
  const CheOwnerImprovementsScreen({super.key, required this.client, this.onSpeak, this.onListen, this.prefs});
  final CheOwnerImprovementsClient client;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;
  final CheUiPreferences? prefs;

  @override
  State<CheOwnerImprovementsScreen> createState() => _CheOwnerImprovementsScreenState();
}

class _CheOwnerImprovementsScreenState extends State<CheOwnerImprovementsScreen> {
  Map<String, dynamic>? _view;
  String? _error;
  String? _busy;
  Object? _screen;

  CheUiPreferences get _prefs => widget.prefs ?? CheUiPreferences.instance;

  @override
  void initState() {
    super.initState();
    _screen = CheScreenAwareness.register(context, _report);
    unawaited(_load());
  }

  @override
  void dispose() {
    CheScreenAwareness.unregister(_screen);
    super.dispose();
  }

  CheScreenReport _report() => CheScreenReport(
        page: 'Owner Improvements',
        detail: _view == null ? 'Loading.' : cheImprovementsSummary(_view!),
        controls: const ['Read aloud', 'Refresh', 'Talk to CHE'],
      );

  Future<void> _load() async {
    try {
      final v = await widget.client.view();
      if (!mounted) return;
      setState(() {
        _view = v;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'I could not load Owner Improvements: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  Future<void> _act(String id, String action) async {
    HapticFeedback.selectionClick();
    setState(() => _busy = id);
    try {
      final out = await widget.client.act(id, action);
      final config = out['ui_config'];
      if (config is Map) {
        await _prefs.applyOwnerConfig(Map<String, dynamic>.from(config['values'] as Map? ?? const {}), rev: (config['rev'] as num?)?.toInt() ?? 0, force: true);
      }
      final said = out['spoken']?.toString() ?? '';
      // The owner pressed this: the result is spoken and shown.
      if (said.isNotEmpty) widget.onSpeak?.call(said);
      if (mounted && said.isNotEmpty) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(said, style: const TextStyle(fontSize: 17))));
      unawaited(HapticFeedback.mediumImpact());
    } catch (e) {
      final said = 'That did not work: ${e.toString().replaceFirst('Exception: ', '')}. Nothing was changed.';
      widget.onSpeak?.call(said);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(said, style: const TextStyle(fontSize: 17))));
      unawaited(HapticFeedback.heavyImpact());
    } finally {
      if (mounted) setState(() => _busy = null);
      unawaited(_load());
    }
  }

  @override
  Widget build(BuildContext context) {
    final tasks = [for (final t in (_view?['tasks'] as List? ?? const [])) Map<String, dynamic>.from(t as Map)];
    return ListenableBuilder(
      listenable: _prefs,
      builder: (context, _) {
        final gap = 12 * _prefs.spacing;
        return Scaffold(
          backgroundColor: CheHud.space,
          appBar: AppBar(
            backgroundColor: CheHud.navyTop,
            foregroundColor: Colors.white,
            title: const CheChromeText('OWNER IMPROVEMENTS', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            actions: [
              IconButton(
                tooltip: 'Read aloud',
                icon: const Icon(Icons.volume_up_rounded),
                onPressed: _view == null ? null : () => widget.onSpeak?.call(cheImprovementsSummary(_view!)),
              ),
              IconButton(tooltip: 'Refresh', icon: const Icon(Icons.refresh_rounded), onPressed: () => unawaited(_load())),
              if (widget.onListen != null) IconButton(tooltip: 'Talk to CHE', icon: const Icon(Icons.mic_rounded), onPressed: widget.onListen),
            ],
          ),
          body: CheHudBackdrop(
            floor: 0.4,
            child: _error != null
                ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: const TextStyle(color: Colors.white, fontSize: 17))))
                : _view == null
                    ? const Center(child: Text('Loading…', style: TextStyle(color: Colors.white70, fontSize: 16)))
                    : ListView(
                        key: const Key('owner_improvements_list'),
                        padding: EdgeInsets.all(gap),
                        children: [
                          Semantics(
                            liveRegion: false,
                            child: Text(cheImprovementsSummary(_view!), style: const TextStyle(color: Colors.white, fontSize: 16, height: 1.35)),
                          ),
                          SizedBox(height: gap),
                          if (tasks.isEmpty)
                            const Text('Say what feels wrong — "this page is too cramped", "make the chart smaller" — and it appears here.',
                                style: TextStyle(color: Colors.white70, fontSize: 15)),
                          for (final (id, label) in kImprovementGroups)
                            if (tasks.any((t) => t['status'] == id)) ...[
                              Padding(
                                padding: EdgeInsets.only(top: gap, bottom: gap / 2),
                                child: Semantics(header: true, child: Text(label.toUpperCase(), style: CheHud.label.copyWith(fontSize: 12))),
                              ),
                              for (final t in tasks.where((t) => t['status'] == id)) _card(t, gap),
                            ],
                        ],
                      ),
          ),
        );
      },
    );
  }

  Widget _card(Map<String, dynamic> t, double gap) {
    final id = t['id']?.toString() ?? '';
    final status = t['status']?.toString() ?? '';
    final verified = status == 'verified';
    final failed = status == 'failed';
    final tone = verified
        ? CheStatusTone.success
        : failed
            ? CheStatusTone.failure
            : status == 'awaiting_approval'
                ? CheStatusTone.warning
                : status == 'requested'
                    ? CheStatusTone.neutral
                    : CheStatusTone.active;
    // Verified uses the owner's success color; the other tones come from the shared chrome status palette.
    final color = verified ? _prefs.successColor : CheStatusPalette.of(tone).base;
    // Motion only for real work in progress: a coding job the queue reports as running.
    final activity = t['job_status'] == 'running' ? CheActivity.running : verified ? CheActivity.done : failed ? CheActivity.failed : CheActivity.idle;
    final icon = verified ? Icons.verified_rounded : failed ? Icons.error_outline_rounded : status == 'coding' ? Icons.build_rounded : status == 'awaiting_approval' ? Icons.schedule_rounded : status == 'investigating' ? Icons.search_rounded : Icons.tune_rounded;
    final history = [for (final h in (t['history'] as List? ?? const [])) Map<String, dynamic>.from(h as Map)];
    final evidence = [for (final e in (t['evidence'] as List? ?? const [])) e.toString()];
    final acceptance = [for (final a in (t['acceptance'] as List? ?? const [])) a.toString()];
    final canUndo = (t['undo'] is Map) && (t['undo'] as Map)['available'] == true;
    final canStart = t['kind'] == 'code' && (t['job_id'] == null) && (status == 'requested' || status == 'awaiting_approval');
    final busy = _busy == id;
    const body = TextStyle(color: Colors.white, fontSize: 15, height: 1.35);
    return Padding(
      key: Key('improvement_$id'),
      padding: EdgeInsets.only(bottom: gap * 0.75),
      child: CheGlass(
        radius: 14,
        shadow: false,
        glow: color,
        child: Theme(
          data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
          child: ExpansionTile(
            tilePadding: EdgeInsets.symmetric(horizontal: gap, vertical: 0),
            childrenPadding: EdgeInsets.fromLTRB(gap, 0, gap, gap),
            iconColor: Colors.white,
            collapsedIconColor: Colors.white70,
            leading: Icon(icon, color: color, semanticLabel: cheImprovementStatusLabel(status)),
            title: Text(t['request']?.toString() ?? '', style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600), maxLines: 2, overflow: TextOverflow.ellipsis),
            subtitle: Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                CheStatusPill(label: cheImprovementStatusLabel(status), tone: tone, activity: activity, compact: true),
                Text('$id${t['screen'] != null && '${t['screen']}'.isNotEmpty ? ' · ${t['screen']}' : ''}',
                    style: CheHud.label.copyWith(fontSize: 11, color: color)),
              ]),
            ),
            expandedCrossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (t['job_id'] != null) Text('Coding job ${t['job_id']}${t['job_status'] != null ? ' (${t['job_status']})' : ''}', style: body),
              if (acceptance.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text('ACCEPTANCE', style: CheHud.label),
                for (final a in acceptance) Text('• $a', style: body),
              ],
              if (evidence.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text('EVIDENCE', style: CheHud.label),
                for (final e in evidence) Text('• $e', style: body),
              ],
              const SizedBox(height: 6),
              Text('HISTORY', style: CheHud.label),
              for (final h in history) Text('${_time(h['at'])} · ${cheImprovementStatusLabel('${h['status']}')}: ${h['note'] ?? ''}', style: body.copyWith(color: Colors.white70)),
              if (canUndo || canStart) const SizedBox(height: 8),
              Wrap(spacing: 8, children: [
                if (canUndo)
                  Semantics(
                    button: true,
                    label: 'Undo $id',
                    child: OutlinedButton.icon(
                      onPressed: busy ? null : () => unawaited(_act(id, 'undo')),
                      icon: const Icon(Icons.undo_rounded),
                      label: const Text('Undo'),
                      style: OutlinedButton.styleFrom(foregroundColor: Colors.white),
                    ),
                  ),
                if (canStart)
                  Semantics(
                    button: true,
                    label: 'Send $id to CHE\'s engineers',
                    child: OutlinedButton.icon(
                      onPressed: busy ? null : () => unawaited(_act(id, 'start')),
                      icon: const Icon(Icons.build_rounded),
                      label: const Text('Send to engineers'),
                      style: OutlinedButton.styleFrom(foregroundColor: Colors.white),
                    ),
                  ),
              ]),
            ],
          ),
        ),
      ),
    );
  }

  static String _time(Object? iso) {
    final at = DateTime.tryParse('${iso ?? ''}')?.toLocal();
    if (at == null) return '';
    String two(int n) => n.toString().padLeft(2, '0');
    return '${at.month}/${at.day} ${two(at.hour)}:${two(at.minute)}';
  }
}
