// CHE World population (owner, 2026-10-25): how many characters live in CHE World, with three numbers that are never
// mixed up:
//   1. Character records: seeded descriptions on the Worker (server/cloudflare/world_population.js). Cheap; not models.
//   2. Generated models: real rigged GLBs built by Blender on the CPU worker, one per shared bucket (288 at most).
//   3. Active now: residents animated on screen this second, reported by the crowd viewer
//      (assets/characters/app/world_crowd.html) only while it is open.
// The panel never speaks on open (owner rule, 2026-10-11); Read aloud speaks the counts when he asks. Typed or spoken
// words reach it through [CheWorldPopulationPanel.voiceHandler] while it is open, and from anywhere through the
// Command Center's /world-population ("how many characters live in CHE World").
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:webview_flutter/webview_flutter.dart';

/// The bridge to the crowd page. The real one drives a WebView (world_crowd.html); tests use a fake.
abstract class CheCrowdDriver {
  Widget build(BuildContext context);
  Future<void> setPopulation(List<Map<String, dynamic>> records);
  Future<void> provideBucket(String key, List<int>? glb);
  void dispose();
}

CheCrowdDriver cheWebCrowd(void Function(Map<String, dynamic>) onMessage) => _WebCrowdDriver(onMessage);

class _WebCrowdDriver implements CheCrowdDriver {
  _WebCrowdDriver(this.onMessage) {
    try {
      _controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(const Color(0xFF0A0D12))
        ..addJavaScriptChannel('CheBridge', onMessageReceived: (m) {
          try {
            final d = jsonDecode(m.message);
            if (d is Map) {
              if (d['type'] == 'page_ready' && !_ready.isCompleted) _ready.complete();
              onMessage(Map<String, dynamic>.from(d));
            }
          } catch (_) {}
        })
        ..loadFlutterAsset('assets/characters/app/world_crowd.html');
    } catch (_) {
      _controller = null; // widget tests have no WebView platform
    }
  }

  final void Function(Map<String, dynamic>) onMessage;
  WebViewController? _controller;
  final _ready = Completer<void>();

  Future<void> _js(String code) async {
    final c = _controller;
    if (c == null) return;
    await _ready.future.timeout(const Duration(seconds: 20));
    await c.runJavaScript(code);
  }

  @override
  Widget build(BuildContext context) => _controller == null
      ? const Center(child: Text('The crowd viewer needs the iPhone app.', style: TextStyle(color: Colors.white60)))
      : WebViewWidget(controller: _controller!);

  @override
  Future<void> setPopulation(List<Map<String, dynamic>> records) => _js('window.CHE.setPopulation(${jsonEncode(records)});');

  @override
  Future<void> provideBucket(String key, List<int>? glb) =>
      _js('window.CHE.provideBucket(${jsonEncode(key)}, ${glb == null ? 'null' : "'${base64Encode(glb)}'"});');

  @override
  void dispose() {}
}

String _n(num v) {
  final s = v.round().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return b.toString();
}

class CheWorldPopulationPanel extends StatefulWidget {
  const CheWorldPopulationPanel({super.key, required this.baseUrl, required this.headers, this.client, this.onRead, this.crowd});

  final String baseUrl;
  final Map<String, String> headers;
  final http.Client? client;

  /// Speaks text only when the owner asks (Read aloud, or "read" by voice).
  final void Function(String text)? onRead;

  /// Builds the crowd viewer driver; null uses the WebView. Tests pass a fake.
  final CheCrowdDriver Function(void Function(Map<String, dynamic>) onMessage)? crowd;

  static Route<void> route({required String baseUrl, required Map<String, String> headers, void Function(String text)? onRead}) =>
      MaterialPageRoute<void>(builder: (_) => CheWorldPopulationPanel(baseUrl: baseUrl, headers: headers, onRead: onRead));

  /// While the panel is open, typed or spoken words reach it first (lib/home_state/send.dart). Null = not for it.
  static Future<String?> Function(String words)? voiceHandler;

  @override
  State<CheWorldPopulationPanel> createState() => CheWorldPopulationPanelState();
}

class CheWorldPopulationPanelState extends State<CheWorldPopulationPanel> {
  late final http.Client _http = widget.client ?? http.Client();
  bool loading = true;
  String? banner;
  bool bannerOk = true;
  Map<String, dynamic> counts = const {};
  String world = 'che_world';

  /// The crowd viewer's latest status (type: status), or null while it is closed.
  Map<String, dynamic>? viewer;
  CheCrowdDriver? _crowd;
  final _served = <String>{};

  @override
  void initState() {
    super.initState();
    CheWorldPopulationPanel.voiceHandler = voice;
    unawaited(load());
  }

  @override
  void dispose() {
    if (CheWorldPopulationPanel.voiceHandler == voice) CheWorldPopulationPanel.voiceHandler = null;
    _crowd?.dispose();
    super.dispose();
  }

  int get records => (counts['records'] as num?)?.toInt() ?? 0;
  int get modelsGenerated => (counts['models_generated'] as num?)?.toInt() ?? 0;
  int get modelsBuilding => (counts['models_building'] as num?)?.toInt() ?? 0;
  int get bucketsTotal => (counts['buckets_total'] as num?)?.toInt() ?? 288;
  int? get active => viewer == null ? null : (viewer!['active_animated'] as num?)?.toInt();

  String get recordsLine => '${_n(records)} character records. Seeded descriptions, not built models.';
  String get modelsLine => '${_n(modelsGenerated)} of ${_n(bucketsTotal)} shared base models generated'
      '${modelsBuilding > 0 ? ', ${_n(modelsBuilding)} building' : ''}. Every record reuses one of them.';
  String get activeLine => active == null
      ? 'Active now: unknown. The crowd viewer is closed; open it to count the residents animated on screen.'
      : '${_n(active!)} active now: animated on screen this second, of ${_n((viewer!['records_in_view'] as num?) ?? 0)} residents in view. '
          '${_n((viewer!['models_loaded'] as num?) ?? 0)} base models loaded on this phone, ${viewer!['fps'] ?? 0} frames a second.';

  String get spokenSummary => loading
      ? 'CHE World population is loading.'
      : 'CHE World population. 1. $recordsLine 2. $modelsLine 3. $activeLine';

  void _report(bool ok, String text) {
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
  }

  Future<void> load({bool announce = false}) async {
    setState(() => loading = true);
    try {
      final r = await _http
          .get(Uri.parse('${widget.baseUrl}/api/world/population?world=$world&limit=0'), headers: widget.headers)
          .timeout(const Duration(seconds: 20));
      final d = jsonDecode(r.body);
      if (r.statusCode != 200 || d is! Map || d['counts'] is! Map) throw StateError('${d is Map ? d['detail'] : r.statusCode}');
      setState(() {
        counts = Map<String, dynamic>.from(d['counts'] as Map);
        loading = false;
      });
      // Opening is silent; only an owner-asked refresh shows a result banner.
      if (announce) _report(true, 'Refreshed. ${_n(records)} records, ${_n(modelsGenerated)} generated models.');
    } catch (e) {
      if (mounted) setState(() => loading = false);
      _report(false, 'Could not read CHE World: $e');
    }
  }

  /// Opens the crowd viewer with one page of records; base models are fetched only when the page asks for them.
  Future<void> openCrowd() async {
    if (_crowd != null) return;
    final crowd = (widget.crowd ?? cheWebCrowd)(_onCrowd);
    setState(() => _crowd = crowd);
    try {
      final r = await _http
          .get(Uri.parse('${widget.baseUrl}/api/world/population?world=$world&limit=200'), headers: widget.headers)
          .timeout(const Duration(seconds: 20));
      final d = jsonDecode(r.body);
      if (r.statusCode != 200 || d is! Map) throw StateError('status ${r.statusCode}');
      final recs = [
        for (final x in (d['records'] as List? ?? const []))
          if (x is Map) {'seed': x['seed'], 'bucket': x['bucket'], 'variation': x['variation']},
      ];
      await crowd.setPopulation(recs);
      _report(true, 'Crowd viewer open with ${_n(recs.length)} residents. Generated base models load as residents come near.');
    } catch (e) {
      _report(false, 'The crowd viewer could not load residents: $e');
    }
  }

  void closeCrowd() {
    _crowd?.dispose();
    setState(() {
      _crowd = null;
      viewer = null;
      _served.clear();
    });
    _report(true, 'Crowd viewer closed.');
  }

  void _onCrowd(Map<String, dynamic> m) {
    if (m['type'] == 'status') {
      if (mounted) setState(() => viewer = m);
    } else if (m['type'] == 'need_bucket') {
      unawaited(_serveBucket('${m['bucket']}'));
    }
  }

  /// Answers the page's request for one bucket: the generated GLB when the Worker has it, otherwise null (the
  /// residents stay low-poly; nothing is invented).
  Future<void> _serveBucket(String key) async {
    final crowd = _crowd;
    if (crowd == null || !_served.add(key)) return;
    List<int>? bytes;
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl}/api/world/buckets'), headers: widget.headers).timeout(const Duration(seconds: 20));
      final d = jsonDecode(r.body);
      final list = d is Map ? (d['buckets'] as List? ?? const []) : const [];
      final b = list.cast<Object?>().whereType<Map>().firstWhere((x) => x['key'] == key, orElse: () => const {});
      final url = (b['model'] is Map) ? '${(b['model'] as Map)['url']}' : '';
      if (url.isNotEmpty) {
        final g = await _http.get(Uri.parse('${widget.baseUrl}$url'), headers: widget.headers).timeout(const Duration(seconds: 60));
        if (g.statusCode == 200) bytes = g.bodyBytes;
      }
    } catch (_) {}
    await crowd.provideBucket(key, bytes);
  }

  /// Voice and typed routes: "read", "refresh", "open the crowd", "close the crowd", "how many characters…".
  Future<String?> voice(String words) async {
    var t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '');
    t = t.replaceFirst(RegExp(r'^(?:hey\s+)?(?:che|chey|chay)[,:]?\s+'), '').trim();
    if (RegExp(r"^(?:read(?: aloud| it| this| the screen)?|what(?:'s| is) on (?:the |this )?screen|describe (?:the |this )?screen|how many characters.*|world population)$").hasMatch(t)) {
      return spokenSummary;
    }
    final n = RegExp(r'^(?:option |number |button )?([1-3])$').firstMatch(t)?.group(1);
    if (n == '1' || RegExp(r'^(?:refresh|reload|update)(?: the)?(?: counts| population)?$').hasMatch(t)) {
      await load(announce: true);
      return banner ?? '';
    }
    if (n == '2' || RegExp(r'^(?:open|show)(?: the)? (?:crowd|world viewer|crowd viewer|residents)$').hasMatch(t)) {
      await openCrowd();
      return banner ?? '';
    }
    if (n == '3' || RegExp(r'^(?:close|hide)(?: the)? (?:crowd|world viewer|crowd viewer|residents)$').hasMatch(t)) {
      if (_crowd == null) return 'The crowd viewer is already closed.';
      closeCrowd();
      return banner ?? '';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    const quiet = TextStyle(color: Colors.white60, fontSize: 14, height: 1.4);
    return Scaffold(
      backgroundColor: const Color(0xFF07090C),
      appBar: AppBar(
        backgroundColor: const Color(0xFF07090C),
        foregroundColor: Colors.white,
        title: Semantics(header: true, child: const Text('CHE World population')),
        actions: [
          Semantics(
            button: true,
            label: 'Read the CHE World population aloud',
            excludeSemantics: true,
            child: IconButton(
              key: const ValueKey('population-read'),
              tooltip: 'Read aloud',
              icon: const Icon(Icons.volume_up_rounded),
              // Never disabled to keep the screen quiet; it reads whatever is known, even while loading.
              onPressed: widget.onRead == null ? null : () => widget.onRead!(spokenSummary),
            ),
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
                  key: const ValueKey('population-banner'),
                  padding: const EdgeInsets.all(14),
                  margin: const EdgeInsets.only(bottom: 12),
                  decoration: BoxDecoration(
                    color: bannerOk ? const Color(0xFF12352E) : const Color(0xFF3A1616),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(banner!, style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w600)),
                ),
              ),
            if (loading) const Text('Loading CHE World…', style: quiet),
            _count('population-records', '1. Character records', _n(records), recordsLine, Icons.description_outlined),
            _count('population-models', '2. Generated models', '${_n(modelsGenerated)} of ${_n(bucketsTotal)}', modelsLine, Icons.view_in_ar_rounded),
            _count('population-active', '3. Active now', active == null ? 'unknown' : _n(active!), activeLine, Icons.directions_walk_rounded),
            const SizedBox(height: 8),
            const Text(
              'Records cost almost nothing and can number in the millions. A generated model takes minutes of CPU time, so '
              'records share 288 base models with their own colours and height. How many can be active at once depends on '
              'the phone; the crowd viewer measures it.',
              style: quiet,
            ),
            const SizedBox(height: 16),
            Wrap(spacing: 10, runSpacing: 10, children: [
              _button('population-refresh', 'Refresh', 'Refresh the CHE World counts', Icons.refresh_rounded, () => load(announce: true)),
              if (_crowd == null)
                _button('population-open-crowd', 'Open the crowd viewer', 'Open the crowd viewer to see and count active residents', Icons.groups_rounded, openCrowd)
              else
                _button('population-close-crowd', 'Close the crowd viewer', 'Close the crowd viewer', Icons.close_rounded, () async => closeCrowd()),
            ]),
            if (_crowd != null) ...[
              const SizedBox(height: 12),
              Semantics(
                label: 'Crowd viewer. $activeLine',
                excludeSemantics: true,
                child: ClipRRect(borderRadius: BorderRadius.circular(12), child: SizedBox(height: 340, child: _crowd!.build(context))),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _count(String key, String title, String value, String sentence, IconData icon) => Semantics(
        key: ValueKey(key),
        label: '$title: $sentence',
        excludeSemantics: true,
        child: Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: const Color(0xFF11161C), borderRadius: BorderRadius.circular(12)),
          child: Row(children: [
            Icon(icon, color: const Color(0xFF2FD6C8), size: 28),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: const TextStyle(color: Colors.white70, fontSize: 15)),
                Text(value, style: const TextStyle(color: Colors.white, fontSize: 30, fontWeight: FontWeight.w700)),
                Text(sentence, style: const TextStyle(color: Colors.white60, fontSize: 13)),
              ]),
            ),
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
          label: Text(label, style: const TextStyle(fontSize: 16)),
        ),
      );
}
