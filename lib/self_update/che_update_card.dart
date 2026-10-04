// "Update ready" card for CHE's self-development. CHE proposes complete safe
// source files in a ```che-update block; nothing happens until the owner taps
// Approve. Approve opens a pull request (never a direct push), then the card
// follows CI and the merge.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../che_ui/che_theme.dart';

class CheUpdateProposal {
  const CheUpdateProposal({
    required this.summary,
    required this.files,
    this.expectedBaseSha,
    this.baseFiles,
  });
  final String summary;
  final List<({String path, String content})> files;

  /// GitHub commit and per-file blob identity the reviewed proposal was built
  /// from. Sent back on approval so the Worker refuses to write over source
  /// that changed after review.
  final String? expectedBaseSha;
  final Map<String, dynamic>? baseFiles;

  /// Stable key so an approved/dismissed card stays that way on rebuild.
  String get key => '${summary.hashCode}:${files.map((f) => f.path).join(',')}';

  static final _block = RegExp(r'```che-update\s*\n([\s\S]*?)```');

  static List<CheUpdateProposal> findInText(String text) {
    final out = <CheUpdateProposal>[];
    for (final m in _block.allMatches(text)) {
      try {
        final j = jsonDecode(m.group(1)!);
        if (j is! Map) continue;
        final files = [
          for (final f in (j['files'] as List? ?? const []))
            if (f is Map && f['path'] is String && f['content'] is String)
              (path: f['path'] as String, content: f['content'] as String),
        ];
        if (files.isEmpty) continue;
        out.add(CheUpdateProposal(
          summary: '${j['summary'] ?? 'CHE update'}',
          files: files,
          expectedBaseSha: j['expected_base_sha'] is String ? j['expected_base_sha'] as String : null,
          baseFiles: j['base_files'] is Map ? Map<String, dynamic>.from(j['base_files'] as Map) : null,
        ));
      } catch (_) {}
    }
    return out;
  }

  static String stripBlocks(String text) => text.replaceAll(RegExp(r'```che-update[\s\S]*?(```|$)'), '').trim();

  /// Client-side checks mirroring Worker `validateUpdateFiles` (server is source of truth).
  List<String> get problems {
    final out = <String>[];
    if (files.isEmpty) out.add('An update needs at least one file.');
    if (files.length > 12) out.add('An update may change at most 12 files (keep the slice narrow).');
    final seen = <String>{};
    for (final f in files) {
      final editable = RegExp(
        r'^(?:'
        r'lib/[A-Za-z0-9_./-]+\.dart|'
        r'(?:test|integration_test)/[A-Za-z0-9_./-]+\.dart|'
        r'server/cloudflare/[A-Za-z0-9_./-]+\.(?:js|mjs)|'
        r'assets/office3d/[A-Za-z0-9_./-]+\.(?:html|js|css|json)|'
        r'web/[A-Za-z0-9_./-]+\.(?:html|js|css|json)|'
        r'docs/[A-Za-z0-9_./ -]+\.(?:md|txt)|'
        r'ios/Runner/[A-Za-z0-9_./-]+\.(?:swift|m|mm|h)|'
        r'android/app/src/main/(?:kotlin|java)/[A-Za-z0-9_./-]+\.(?:kt|java)'
        r')$',
      ).hasMatch(f.path);
      final protected = f.path.startsWith('.github/') ||
          RegExp(r'(?:^|/)(?:\.env|secrets?\b|credentials?\b)', caseSensitive: false).hasMatch(f.path) ||
          RegExp(r'\.(?:pem|p12|mobileprovision|key|keystore|jks)$', caseSensitive: false).hasMatch(f.path);
      if (!editable || protected || f.path.contains('..') || f.path.contains('//')) {
        out.add('${f.path}: this path is protected or outside CHE’s owner-approved self-update lane');
        continue;
      }
      if (!seen.add(f.path)) out.add('${f.path} appears twice.');
      final text = f.content;
      if (RegExp(r'BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY').hasMatch(text) ||
          RegExp(r'(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}').hasMatch(text) ||
          RegExp(r'(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}').hasMatch(text) ||
          RegExp(r'(?:CHE_GITHUB_TOKEN|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|OLLAMA_API_KEY|CHE_OPENAI_API_KEY|XAI_API_KEY)\s*[:=]').hasMatch(text)) {
        out.add('${f.path}: looks like a secret or private key.');
      }
      if (RegExp(r'<\?xml[\s\S]{0,200}<(?:plist|dict)\b', caseSensitive: false).hasMatch(text) ||
          text.contains('CODE_SIGN_ENTITLEMENTS=')) {
        out.add('${f.path}: self-update cannot touch native iOS entitlements or Info.plist.');
      }
    }
    return out;
  }
}

/// Remembers per-proposal state across chat rebuilds.
class CheUpdateTracker extends ChangeNotifier {
  final Map<String, String> _state = {}; // key → dismissed | pr:<number>|<url>
  String? stateOf(CheUpdateProposal p) => _state[p.key];
  void set(CheUpdateProposal p, String v) {
    _state[p.key] = v;
    notifyListeners();
  }
}

class CheUpdateCard extends StatefulWidget {
  const CheUpdateCard({
    super.key,
    required this.proposal,
    required this.tracker,
    required this.baseUrl,
    required this.headers,
  });

  final CheUpdateProposal proposal;
  final CheUpdateTracker tracker;
  final String Function() baseUrl;
  final Map<String, String> Function() headers;

  @override
  State<CheUpdateCard> createState() => _CheUpdateCardState();
}

class _CheUpdateCardState extends State<CheUpdateCard> {
  bool _busy = false;
  String? _error;
  Map<String, dynamic>? _status;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _resumePolling();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  int? get _prNumber {
    final s = widget.tracker.stateOf(widget.proposal);
    if (s == null || !s.startsWith('pr:')) return null;
    return int.tryParse(s.substring(3).split('|').first);
  }

  String? get _prUrl {
    final s = widget.tracker.stateOf(widget.proposal);
    if (s == null || !s.startsWith('pr:')) return null;
    final parts = s.substring(3).split('|');
    return parts.length > 1 ? parts[1] : null;
  }

  void _resumePolling() {
    if (_prNumber == null) return;
    unawaited(_refresh());
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(_refresh()));
  }

  Future<void> _refresh() async {
    final n = _prNumber;
    if (n == null) return;
    try {
      final r = await http
          .get(Uri.parse('${widget.baseUrl()}/api/self-update/$n'), headers: widget.headers())
          .timeout(const Duration(seconds: 15));
      final j = jsonDecode(r.body);
      if (r.statusCode == 200 && j is Map<String, dynamic>) {
        _status = j;
        if (j['state'] == 'merged' || j['state'] == 'closed') _poll?.cancel();
      }
    } catch (_) {}
    if (mounted) setState(() {});
  }

  Future<void> _approve() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await http
          .post(
            Uri.parse('${widget.baseUrl()}/api/self-update'),
            headers: widget.headers(),
            body: jsonEncode({
              'summary': widget.proposal.summary,
              'files': [for (final f in widget.proposal.files) {'path': f.path, 'content': f.content}],
              if (widget.proposal.expectedBaseSha != null) 'expected_base_sha': widget.proposal.expectedBaseSha,
              if (widget.proposal.baseFiles != null) 'base_files': widget.proposal.baseFiles,
              // One tap: open the PR and authorize the merge once every
              // required check passes; CHE then delivers it herself.
              'ship': true,
            }),
          )
          .timeout(const Duration(seconds: 60));
      final j = jsonDecode(r.body);
      if (r.statusCode == 409 && j is Map && j['stale_source'] == true) {
        throw Exception(
          'The code changed on GitHub after this update was reviewed, so nothing was written. '
          'Ask CHE to "create the PR" and she will rebuild it against the current code for your approval.',
        );
      }
      if (r.statusCode != 200 || j is! Map) {
        throw Exception(j is Map ? '${j['detail'] ?? 'Update failed.'}' : 'Update failed (${r.statusCode}).');
      }
      widget.tracker.set(widget.proposal, 'pr:${j['number']}|${j['url']}');
      _resumePolling();
    } catch (e) {
      _error = '$e'.replaceFirst('Exception: ', '');
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.proposal;
    final state = widget.tracker.stateOf(p);
    final problems = p.problems;
    final dismissed = state == 'dismissed';
    final pr = _prNumber;
    final ci = _status?['ci']?.toString();
    final prState = _status?['state']?.toString();
    final statusLine = pr == null
        ? null
        : prState == 'merged'
            ? 'Merged. The appropriate app/Worker delivery pipeline can apply it.'
            : prState == 'closed'
                ? 'Pull request closed without merging.'
                : switch (ci) {
                    'passed' => 'Checks passed on PR #$pr. CHE is merging and delivering it.',
                    'failed' => 'Checks failed: ${(_status?['failed_checks'] as List?)?.join(', ') ?? ''}. CHE is repairing it.',
                    'running' => 'Checks running on PR #$pr. CHE merges it when they pass.',
                    _ => 'PR #$pr opened. CHE merges it when the checks pass.',
                  };
    final color = problems.isNotEmpty ? CheColors.danger : CheColors.accentAlt;
    return Container(
      margin: const EdgeInsets.only(top: CheSpace.sm),
      padding: const EdgeInsets.all(CheSpace.md),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: color.withValues(alpha: 0.6)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(Icons.system_update_rounded, color: color, size: 20),
          const SizedBox(width: CheSpace.sm),
          Expanded(
            child: Text(dismissed ? 'Update dismissed' : 'Update ready',
                maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(color: color)),
          ),
          Text('${p.files.length} file${p.files.length == 1 ? '' : 's'}', style: CheType.caption),
        ]),
        const SizedBox(height: CheSpace.xs),
        Text(p.summary, style: CheType.body),
        const SizedBox(height: CheSpace.xs),
        for (final f in p.files) Text('• ${f.path}', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
        if (problems.isNotEmpty) ...[
          const SizedBox(height: CheSpace.xs),
          Text(problems.join('\n'), style: CheType.caption.copyWith(color: CheColors.danger)),
        ],
        if (_error != null) ...[
          const SizedBox(height: CheSpace.xs),
          Text(_error!, style: CheType.caption.copyWith(color: CheColors.danger)),
        ],
        if (statusLine != null) ...[
          const SizedBox(height: CheSpace.sm),
          Text(statusLine, style: CheType.caption.copyWith(color: ci == 'failed' ? CheColors.danger : CheColors.text)),
        ],
        const SizedBox(height: CheSpace.sm),
        if (pr == null && !dismissed && problems.isEmpty)
          Row(children: [
            Expanded(
              child: OutlinedButton(
                onPressed: _busy ? null : () => widget.tracker.set(p, 'dismissed'),
                child: const Text('Dismiss'),
              ),
            ),
            const SizedBox(width: CheSpace.sm),
            Expanded(
              child: Semantics(
                button: true,
                label: 'Update CHE. Approves this change; CHE merges and delivers it after every check passes.',
                excludeSemantics: true,
                child: FilledButton(
                  onPressed: _busy ? null : _approve,
                  child: _busy
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('Update CHE'),
                ),
              ),
            ),
          ]),
        if (_prUrl != null)
          TextButton.icon(
            onPressed: () => launchUrl(Uri.parse(_prUrl!), mode: LaunchMode.externalApplication),
            icon: const Icon(Icons.open_in_new_rounded, size: 16),
            label: Text('Open PR #$pr'),
          ),
      ]),
    );
  }
}
