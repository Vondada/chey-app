// Usage Center (Stage 4, docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md): one evidence-backed view of CHE's providers,
// subscriptions, credits, quotas, AI tokens, GPU seconds, CPU hours, jobs, and estimated vs invoiced cost, read from
// GET /api/usage (server/cloudflare/usage_center.js). Every number shows its provenance: OBSERVED, ESTIMATED,
// YOU TOLD ME (user-entered) or UNAVAILABLE, with its source or reason.
// Owner rule (2026-10-11): opening is silent. Loading is muted text; Read Aloud speaks the summary when he asks.
// Saving or removing a subscription speaks its real result with a banner and a haptic; removing asks first.
// Voice and typed words reach the open screen through [CheUsageCenterRoom.voiceHandler]; from anywhere, "what's my
// usage" opens it through the Command Center's /usage-center.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

class CheUsageCenterClient {
  CheUsageCenterClient({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  Map<String, dynamic> _decode(http.Response r) {
    Object? body;
    try {
      body = r.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } on FormatException {
      body = null;
    }
    return body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{};
  }

  Future<CheUsageView> load() async {
    if (baseUrl.isEmpty) throw Exception('CHE is not connected on this iPhone yet.');
    final http.Response r;
    try {
      r = await _client.get(Uri.parse('$baseUrl/api/usage'), headers: headers()).timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw Exception('CHE did not answer within 20 seconds.');
    }
    final map = _decode(r);
    if (r.statusCode >= 400) throw Exception(map['detail']?.toString() ?? 'CHE answered ${r.statusCode}.');
    return CheUsageView.fromJson(map);
  }

  Future<({bool ok, String spoken})> _post(String path, Map<String, dynamic> body) async {
    if (baseUrl.isEmpty) return (ok: false, spoken: 'CHE is not connected on this iPhone yet. Nothing changed.');
    try {
      final r = await _client
          .post(Uri.parse('$baseUrl$path'), headers: {...headers(), 'Content-Type': 'application/json'}, body: jsonEncode(body))
          .timeout(const Duration(seconds: 20));
      final map = _decode(r);
      return (ok: map['ok'] == true, spoken: '${map['spoken'] ?? map['detail'] ?? 'CHE answered ${r.statusCode}.'}');
    } on TimeoutException {
      return (ok: false, spoken: 'CHE did not answer within 20 seconds, so I cannot say whether it was saved.');
    } catch (_) {
      return (ok: false, spoken: 'I could not reach CHE. Nothing changed.');
    }
  }

  /// The owner's own words, parsed by the Worker exactly as when he says them.
  Future<({bool ok, String spoken})> addSubscription(String words) => _post('/api/usage/subscriptions', {'text': words});

  /// Only after the owner confirmed on this screen (AGENTS.md delete rule).
  Future<({bool ok, String spoken})> removeSubscription(String id) => _post('/api/usage/subscriptions/remove', {'id': id, 'confirm': true});
}

List<Map<String, dynamic>> _maps(Object? v) => (v as List? ?? const []).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();

/// The badge words for each provenance; never just a colour.
const cheProvenanceWords = {'OBSERVED': 'OBSERVED', 'ESTIMATED': 'ESTIMATED', 'USER_ENTERED': 'YOU TOLD ME', 'UNAVAILABLE': 'UNAVAILABLE'};

class CheUsageMetric {
  const CheUsageMetric({required this.id, required this.label, required this.provenance, required this.text, required this.value, required this.unit, required this.detail});
  final String id, label, provenance, text, unit, detail;
  final Object? value;
  factory CheUsageMetric.fromJson(Map<String, dynamic> j) {
    final detail = [j['source'], j['price_source'] == null ? null : 'price: ${j['price_source']}', j['why'], j['words'] == null ? null : 'your words: "${j['words']}"']
        .where((e) => e != null && '$e'.isNotEmpty)
        .join('; ');
    return CheUsageMetric(
      id: '${j['id'] ?? ''}', label: '${j['label'] ?? ''}', provenance: '${j['provenance'] ?? 'UNAVAILABLE'}', text: '${j['text'] ?? ''}',
      value: j['value'], unit: '${j['unit'] ?? ''}', detail: detail,
    );
  }
  String get badge => cheProvenanceWords[provenance] ?? provenance;

  /// The number as shown; "unavailable" when it is not known (never a zero in its place).
  String get shown {
    final v = value;
    if (provenance == 'UNAVAILABLE' || v == null) return 'unavailable';
    if (unit == 'usd' && v is num) return '\$${v.toStringAsFixed(2)}';
    if (v is num) return '${_grouped(v)}${unit.isEmpty ? '' : ' $unit'}';
    return '$v${unit.isEmpty ? '' : ' $unit'}';
  }
}

String _grouped(num v) {
  if (v is double && v != v.roundToDouble()) return v.toString();
  final s = v.round().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return b.toString();
}

class CheUsageRow {
  const CheUsageRow({required this.id, required this.group, required this.name, required this.status, required this.statusId, required this.evidence, required this.purpose, required this.scopes, required this.metrics, required this.subId});
  final String id, group, name, status, statusId, evidence, purpose, scopes, subId;
  final List<CheUsageMetric> metrics;
  factory CheUsageRow.fromJson(Map<String, dynamic> j) => CheUsageRow(
        id: '${j['id'] ?? ''}', group: '${j['group'] ?? ''}', name: '${j['name'] ?? ''}', status: '${j['status'] ?? ''}', statusId: '${j['status_id'] ?? ''}',
        evidence: '${j['evidence'] ?? j['said'] ?? ''}', purpose: '${j['purpose'] ?? ''}', scopes: '${j['scopes'] ?? ''}', subId: '${j['sub_id'] ?? ''}',
        metrics: _maps(j['metrics']).map(CheUsageMetric.fromJson).toList(),
      );
}

class CheUsageView {
  const CheUsageView({required this.at, required this.rows, required this.alerts, required this.totals, required this.spoken});
  final String at, spoken;
  final List<CheUsageRow> rows;
  final List<Map<String, dynamic>> alerts;
  final List<CheUsageMetric> totals;
  factory CheUsageView.fromJson(Map<String, dynamic> j) => CheUsageView(
        at: '${j['at'] ?? ''}', spoken: '${j['spoken'] ?? ''}', rows: _maps(j['rows']).map(CheUsageRow.fromJson).toList(), alerts: _maps(j['alerts']),
        totals: _maps(j['totals']).map(CheUsageMetric.fromJson).toList(),
      );
  List<CheUsageRow> group(String g) => rows.where((r) => r.group == g).toList();
}

class CheUsageCenterRoom extends StatefulWidget {
  const CheUsageCenterRoom({super.key, required this.client, this.onSpeak, this.onListen});

  final CheUsageCenterClient client;

  /// Speaks only what the owner asked for (Read Aloud, a voice request) or an action's real result.
  final void Function(String text)? onSpeak;
  final VoidCallback? onListen;

  static Route<void> route({required CheUsageCenterClient client, void Function(String text)? onSpeak, VoidCallback? onListen}) =>
      MaterialPageRoute<void>(builder: (_) => CheUsageCenterRoom(client: client, onSpeak: onSpeak, onListen: onListen));

  /// While the screen is open, typed or spoken words reach it first. Null = not for it.
  static Future<String?> Function(String words)? voiceHandler;

  @override
  State<CheUsageCenterRoom> createState() => CheUsageCenterRoomState();
}

class CheUsageCenterRoomState extends State<CheUsageCenterRoom> {
  CheUsageView? view;
  bool loading = true;
  String? loadError;
  String? banner;
  bool bannerOk = true;
  final _words = TextEditingController();

  @override
  void initState() {
    super.initState();
    CheUsageCenterRoom.voiceHandler = voice;
    unawaited(load());
  }

  @override
  void dispose() {
    if (CheUsageCenterRoom.voiceHandler == voice) CheUsageCenterRoom.voiceHandler = null;
    _words.dispose();
    super.dispose();
  }

  /// Quiet: no speech, no banner on success (owner rule for passive screens).
  Future<void> load() async {
    if (mounted) setState(() => loading = true);
    try {
      final v = await widget.client.load();
      if (!mounted) return;
      setState(() {
        view = v;
        loading = false;
        loadError = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        loading = false;
        loadError = '$e'.replaceFirst('Exception: ', '');
      });
    }
  }

  String get spokenSummary {
    if (loading && view == null) return 'The Usage Center is loading.';
    if (view == null) return 'The Usage Center could not load: ${loadError ?? 'no answer from CHE'}.';
    return view!.spoken.isNotEmpty ? view!.spoken : 'Usage Center. ${view!.rows.length} rows.';
  }

  String get alertsSummary {
    final a = view?.alerts ?? const [];
    if (a.isEmpty) return 'No usage alerts.';
    return '${a.length} alert${a.length == 1 ? '' : 's'}: ${[for (var i = 0; i < a.length; i++) '${i + 1}. ${a[i]['text']}'].join(' ')}';
  }

  String get subscriptionsSummary {
    final subs = view?.group('subscription') ?? const [];
    if (subs.isEmpty) return 'You have not told me any subscriptions, so I list none.';
    return 'Subscriptions you told me: ${[for (var i = 0; i < subs.length; i++) '${i + 1}. ${subs[i].name}. ${subs[i].metrics.map((m) => m.text).join(' ')}'].join(' ')}';
  }

  void _report(bool ok, String text, {bool speak = true}) {
    if (ok) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    if (mounted) {
      setState(() {
        banner = text;
        bannerOk = ok;
      });
    }
    if (speak) widget.onSpeak?.call(text);
  }

  Future<void> addSubscription([String? said]) async {
    final words = (said ?? _words.text).trim();
    if (words.isEmpty) {
      _report(false, 'Say or type the subscription first, for example: my ChatGPT subscription is 20 dollars a month, renews on the 3rd.');
      return;
    }
    final out = await widget.client.addSubscription(words);
    if (out.ok) _words.clear();
    _report(out.ok, out.spoken);
    await load();
  }

  /// Asks first (spoken and on screen); removes only on an explicit yes.
  Future<void> removeSubscription(CheUsageRow row) async {
    final question = 'Remove your ${row.name} subscription record from the Usage Center? This does not cancel anything at ${row.name}.';
    widget.onSpeak?.call(question);
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Semantics(header: true, child: const Text('Remove this record?')),
        content: Text(question, style: const TextStyle(fontSize: 20)),
        actions: [
          Semantics(
            button: true,
            label: 'Keep the ${row.name} record',
            excludeSemantics: true,
            child: TextButton(key: const ValueKey('usage-remove-keep'), onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Keep', style: TextStyle(fontSize: 18))),
          ),
          Semantics(
            button: true,
            label: 'Yes, remove the ${row.name} record',
            excludeSemantics: true,
            child: FilledButton(key: const ValueKey('usage-remove-yes'), onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Remove', style: TextStyle(fontSize: 18))),
          ),
        ],
      ),
    );
    if (yes != true) {
      _report(true, 'Kept. Nothing was removed.');
      return;
    }
    final out = await widget.client.removeSubscription(row.subId);
    _report(out.ok, out.spoken);
    await load();
  }

  /// Voice and typed routes while the screen is open.
  Future<String?> voice(String words) async {
    var t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '');
    t = t.replaceFirst(RegExp(r'^(?:hey\s+)?(?:che|chey|chay)[,:]?\s+'), '').trim();
    if (RegExp(r"^(?:read(?: aloud| it| this| the screen)?|what(?:'s| is) on (?:the |this )?screen|describe (?:the |this )?screen|what(?:'s| is) my usage)$").hasMatch(t)) return spokenSummary;
    if (RegExp(r'^(?:read|what are)(?: me)?(?: my| the)? (?:usage )?alerts$').hasMatch(t)) return alertsSummary;
    if (RegExp(r'^(?:read(?: me)?(?: my| the)? subscriptions|what subscriptions do i have)$').hasMatch(t)) return subscriptionsSummary;
    if (RegExp(r'^(?:refresh|reload|update)(?: the)?(?: usage| usage center)?$').hasMatch(t)) {
      await load();
      return view == null ? 'The Usage Center could not load: ${loadError ?? 'no answer'}.' : 'Refreshed. ${view!.rows.length} rows, ${view!.alerts.length} alerts.';
    }
    if (RegExp(r'\bsubscription\b').hasMatch(t) && !t.startsWith('remove') && !t.startsWith('delete')) {
      await addSubscription(words);
      return banner;
    }
    return null;
  }

  static const _bg = Color(0xFF07090C);
  static const _card = Color(0xFF11161C);

  Color _badgeColor(String p) => switch (p) {
        'OBSERVED' => const Color(0xFF1F6F5C),
        'ESTIMATED' => const Color(0xFF7A5A12),
        'USER_ENTERED' => const Color(0xFF2E4C8C),
        _ => const Color(0xFF4A4F57),
      };

  @override
  Widget build(BuildContext context) {
    const quiet = TextStyle(color: Colors.white70, fontSize: 16, height: 1.4);
    final v = view;
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _bg,
        foregroundColor: Colors.white,
        title: Semantics(header: true, child: const Text('Usage Center', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700))),
        actions: [
          Semantics(
            button: true,
            label: 'Read the Usage Center aloud',
            excludeSemantics: true,
            child: IconButton(
              key: const ValueKey('usage-read'),
              tooltip: 'Read aloud',
              iconSize: 30,
              icon: const Icon(Icons.volume_up_rounded),
              // Never disabled to keep the screen quiet; it reads whatever is known, even while loading.
              onPressed: widget.onSpeak == null ? null : () => widget.onSpeak!(spokenSummary),
            ),
          ),
          Semantics(
            button: true,
            label: 'Refresh the Usage Center',
            excludeSemantics: true,
            child: IconButton(key: const ValueKey('usage-refresh'), tooltip: 'Refresh', iconSize: 30, icon: const Icon(Icons.refresh_rounded), onPressed: () => unawaited(load())),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (banner != null)
              Semantics(
                liveRegion: true,
                label: banner,
                excludeSemantics: true,
                child: Container(
                  key: const ValueKey('usage-banner'),
                  padding: const EdgeInsets.all(14),
                  margin: const EdgeInsets.only(bottom: 12),
                  decoration: BoxDecoration(color: bannerOk ? const Color(0xFF12352E) : const Color(0xFF3A1616), borderRadius: BorderRadius.circular(12)),
                  child: Text(banner!, style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w600)),
                ),
              ),
            if (loading && v == null) const Text('Loading the Usage Center…', key: ValueKey('usage-loading'), style: quiet),
            if (loadError != null && v == null) Text('The Usage Center could not load: $loadError', key: const ValueKey('usage-error'), style: quiet),
            if (v != null) ...[
              Semantics(
                label: 'What the badges mean. Observed: read from a provider or measured by CHE. Estimated: measured use times a published price, or CHE\'s own approximate count. You told me: what you said, with your words and the time. Unavailable: not known, with the reason.',
                excludeSemantics: true,
                child: const Text('OBSERVED = read from a provider or measured by CHE · ESTIMATED = measured use × published price · YOU TOLD ME = your words · UNAVAILABLE = not known, with why', style: quiet),
              ),
              const SizedBox(height: 12),
              _section('Alerts', Icons.warning_amber),
              if (v.alerts.isEmpty) const Text('No usage alerts.', style: quiet),
              for (final a in v.alerts) _alert(a),
              _section('Totals', Icons.receipt_long_rounded),
              for (final m in v.totals) _metric(m),
              _section('AI engines', Icons.memory_rounded),
              for (final r in v.group('ai')) _row(r),
              _section('Compute', Icons.cloud_rounded),
              for (final r in v.group('compute')) _row(r),
              for (final r in v.group('budget')) _row(r),
              _section('Subscriptions you told me', Icons.payments_outlined),
              if (v.group('subscription').isEmpty)
                const Text('None. CHE lists only subscriptions you tell her; none of your connected providers reports subscriptions.', style: quiet),
              for (final r in v.group('subscription')) _row(r, removable: true),
              const SizedBox(height: 8),
              Semantics(
                textField: true,
                label: 'New subscription, in your own words. For example: my ChatGPT subscription is 20 dollars a month, renews on the 3rd',
                child: TextField(
                  key: const ValueKey('usage-sub-words'),
                  controller: _words,
                  style: const TextStyle(color: Colors.white, fontSize: 20),
                  decoration: const InputDecoration(
                    hintText: 'my ChatGPT subscription is \$20 a month, renews on the 3rd',
                    hintStyle: TextStyle(color: Colors.white38, fontSize: 18),
                    filled: true,
                    fillColor: _card,
                  ),
                  onSubmitted: (_) => unawaited(addSubscription()),
                ),
              ),
              const SizedBox(height: 10),
              Wrap(spacing: 10, runSpacing: 10, children: [
                _button('usage-sub-add', 'Save subscription', 'Save the subscription you typed or said', Icons.add_rounded, () => addSubscription()),
                if (widget.onListen != null)
                  _button('usage-listen', 'Speak instead', 'Speak to CHE instead of typing', Icons.volume_up_rounded, () async => widget.onListen!()),
              ]),
              const SizedBox(height: 12),
              Text('Updated ${v.at.replaceFirst('T', ' ').split('.').first} UTC. CHE never buys, cancels or changes an account from here.', style: quiet),
            ],
          ],
        ),
      ),
    );
  }

  Widget _section(String title, IconData icon) => Padding(
        padding: const EdgeInsets.only(top: 18, bottom: 8),
        child: Semantics(
          header: true,
          child: Row(children: [
            Icon(icon, color: const Color(0xFF2FD6C8), size: 26),
            const SizedBox(width: 8),
            Expanded(child: Text(title, style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700))),
          ]),
        ),
      );

  Widget _alert(Map<String, dynamic> a) {
    final text = '${a['text'] ?? ''}';
    final p = '${a['provenance'] ?? ''}';
    return Semantics(
      container: true,
      label: 'Alert: $text Basis: ${cheProvenanceWords[p] ?? p}.',
      excludeSemantics: true,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: a['severity'] == 'warning' ? const Color(0xFF3A2A10) : _card, borderRadius: BorderRadius.circular(12)),
        child: Text(text, style: const TextStyle(color: Colors.white, fontSize: 18, height: 1.35)),
      ),
    );
  }

  Widget _row(CheUsageRow r, {bool removable = false}) => Container(
        key: ValueKey('usage-row-${r.id}'),
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: _card, borderRadius: BorderRadius.circular(12)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(
            container: true,
            label: '${r.name}: ${r.status}. ${r.evidence} Purpose: ${r.purpose}.${r.scopes.isEmpty ? '' : ' Access: ${r.scopes}.'}',
            excludeSemantics: true,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Icon(
                  r.statusId == 'connected' ? Icons.check_circle_rounded : r.statusId == 'needs_owner_sign_in' ? Icons.error_outline_rounded : Icons.help_outline_rounded,
                  color: r.statusId == 'connected' ? const Color(0xFF2FD6C8) : Colors.white60,
                  size: 24,
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(r.name, style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700))),
              ]),
              Text(r.status, style: const TextStyle(color: Colors.white, fontSize: 18)),
              if (r.evidence.isNotEmpty) Text(r.evidence, style: const TextStyle(color: Colors.white70, fontSize: 16)),
            ]),
          ),
          const SizedBox(height: 6),
          for (final m in r.metrics) _metric(m),
          if (removable)
            _button('usage-remove-${r.subId}', 'Remove record', 'Remove the ${r.name} subscription record. Asks you first.', Icons.delete_outline_rounded, () => removeSubscription(r)),
        ]),
      );

  Widget _metric(CheUsageMetric m) => Semantics(
        key: ValueKey('usage-metric-${m.id}'),
        container: true,
        label: m.text.isNotEmpty ? m.text : '${m.label}: ${m.shown}. ${m.badge}.',
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(m.label, style: const TextStyle(color: Colors.white70, fontSize: 17))),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(color: _badgeColor(m.provenance), borderRadius: BorderRadius.circular(8)),
                child: Text(m.badge, style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
              ),
            ]),
            Text(m.shown, style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w700)),
            if (m.detail.isNotEmpty) Text(m.detail, style: const TextStyle(color: Colors.white60, fontSize: 15)),
          ]),
        ),
      );

  Widget _button(String key, String label, String semantics, IconData icon, Future<void> Function() onTap) => Semantics(
        button: true,
        label: semantics,
        excludeSemantics: true,
        child: FilledButton.icon(
          key: ValueKey(key),
          onPressed: () => unawaited(onTap()),
          icon: Icon(icon),
          label: Text(label, style: const TextStyle(fontSize: 18)),
        ),
      );
}
