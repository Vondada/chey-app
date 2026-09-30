// CHE plugin system — add skills to CHE without rebuilding the app.
//
// A plugin is a small JSON "manifest". It can:
//   • add instructions to CHE's brain       (instructions)
//   • give CHE tools to call through the Worker (tools)
//   • add quick-action buttons               (quickActions)
//   • add its own screen: feature cards, or a full mini web app (screen)
//
// Plugins come from 3 places:
//   1. The catalog (GET <catalogUrl> on the Worker → list of manifests)
//   2. CHE herself — when she writes a ```che-plugin block in chat, an
//      "Install plugin" card appears. Nothing installs without your tap.
//   3. Paste a JSON manifest or a link.
//
// Every install keeps the previous version, so any update can be rolled back.
// Stored in the app's Documents folder (no extra packages needed).

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_theme.dart';
import 'che_widgets.dart';
import 'che_office_hub.dart';
import 'che_ai_models_panel.dart';

// ─────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────

class ChePlugin {
  ChePlugin(this.raw);
  final Map<String, dynamic> raw;

  String get id => (raw['id'] ?? '').toString();
  String get name => (raw['name'] ?? id).toString();
  String get version => (raw['version'] ?? '1.0.0').toString();
  String get description => (raw['description'] ?? '').toString();
  String get author => (raw['author'] ?? 'Unknown').toString();
  String get instructions => (raw['instructions'] ?? '').toString();
  IconData get icon => cheIconFromName(raw['icon']?.toString());
  Color get color => _parseColor(raw['color']?.toString()) ?? CheColors.accent;
  List<String> get permissions => _strList(raw['permissions']);
  List<String> get quickActions => _strList(raw['quickActions']);
  List<Map<String, dynamic>> get tools =>
      (raw['tools'] is List) ? (raw['tools'] as List).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList() : const [];
  Map<String, dynamic> get screen => (raw['screen'] is Map) ? (raw['screen'] as Map).cast<String, dynamic>() : const {};

  /// Returns a list of problems; empty list = valid.
  List<String> validate() {
    final p = <String>[];
    if (!RegExp(r'^[a-z0-9][a-z0-9\-]{1,40}$').hasMatch(id)) p.add('id must be lowercase letters, numbers and dashes');
    if (name.trim().isEmpty) p.add('name is required');
    if (!RegExp(r'^\d+\.\d+\.\d+$').hasMatch(version)) p.add('version must look like 1.0.0');
    if (instructions.length > 6000) p.add('instructions are too long (max 6000 chars)');
    final type = screen['type'];
    if (type != null && type != 'cards' && type != 'webapp') p.add('screen.type must be "cards" or "webapp"');
    for (final t in tools) {
      if (t['name'] is! String) p.add('every tool needs a name');
    }
    return p;
  }

  static List<String> _strList(dynamic v) => v is List ? v.map((e) => e.toString()).toList() : const [];
  static Color? _parseColor(String? s) {
    if (s == null) return null;
    final h = s.replaceAll('#', '');
    if (h.length != 6) return null;
    final v = int.tryParse(h, radix: 16);
    return v == null ? null : Color(0xFF000000 | v);
  }

  static ChePlugin? tryParse(String text) {
    try {
      final j = jsonDecode(text);
      if (j is Map) return ChePlugin(j.cast<String, dynamic>());
    } catch (_) {}
    return null;
  }
}

IconData cheIconFromName(String? name) {
  const map = <String, IconData>{
    'extension': Icons.extension_rounded,
    'chart': Icons.show_chart_rounded,
    'show_chart': Icons.show_chart_rounded,
    'money': Icons.attach_money_rounded,
    'crypto': Icons.currency_bitcoin_rounded,
    'music': Icons.music_note_rounded,
    'image': Icons.image_rounded,
    'camera': Icons.photo_camera_rounded,
    'code': Icons.code_rounded,
    'calendar': Icons.calendar_month_rounded,
    'fitness': Icons.fitness_center_rounded,
    'food': Icons.restaurant_rounded,
    'home': Icons.home_rounded,
    'car': Icons.directions_car_rounded,
    'mail': Icons.mail_rounded,
    'chat': Icons.chat_bubble_rounded,
    'search': Icons.search_rounded,
    'news': Icons.newspaper_rounded,
    'weather': Icons.cloud_rounded,
    'shopping': Icons.shopping_bag_rounded,
    'book': Icons.menu_book_rounded,
    'bolt': Icons.bolt_rounded,
    'star': Icons.star_rounded,
    'tool': Icons.build_rounded,
    'brain': Icons.psychology_rounded,
    'game': Icons.sports_esports_rounded,
    'video': Icons.movie_rounded,
    'map': Icons.map_rounded,
    'lock': Icons.lock_rounded,
    'globe': Icons.public_rounded,
  };
  return map[name] ?? Icons.extension_rounded;
}

// ─────────────────────────────────────────────────────────────────────────
// Registry (install / enable / rollback / remove), persisted to Documents.
// ─────────────────────────────────────────────────────────────────────────

class ChePluginRegistry extends ChangeNotifier {
  ChePluginRegistry({this.catalogUrl, this.catalogHeaders = const {}, this.resolveCatalogUrl, this.resolveCatalogHeaders});

  /// Worker route returning `[manifest, manifest, ...]` or `{"plugins":[...]}`.
  final Uri? catalogUrl;
  final Map<String, String> catalogHeaders;

  /// Dynamic versions (the server address / pairing token can change).
  final Uri? Function()? resolveCatalogUrl;
  final Map<String, String> Function()? resolveCatalogHeaders;

  final Map<String, ChePlugin> _installed = {};
  final Map<String, List<Map<String, dynamic>>> _history = {}; // previous versions
  final Set<String> _enabled = {};
  bool loaded = false;

  List<ChePlugin> get installed => _installed.values.toList()..sort((a, b) => a.name.compareTo(b.name));
  List<ChePlugin> get enabled => installed.where((p) => _enabled.contains(p.id)).toList();
  bool isEnabled(String id) => _enabled.contains(id);
  bool canRollback(String id) => (_history[id]?.isNotEmpty ?? false);
  ChePlugin? byId(String id) => _installed[id];

  /// Instructions from enabled plugins → pass to CheAgentController.systemAddons.
  List<String> systemAddons() => [
        for (final p in enabled)
          if (p.instructions.trim().isNotEmpty) '[Plugin: ${p.name} v${p.version}]\n${p.instructions.trim()}',
      ];

  /// Tools from enabled plugins → include in the Worker request body. Each
  /// carries its plugin's declared permissions so the Worker only calls the
  /// hosts the owner approved at install time.
  List<Map<String, dynamic>> tools() => [
        for (final p in enabled)
          for (final t in p.tools) {...t, 'plugin': p.id, 'plugin_name': p.name, 'permissions': p.permissions},
      ];

  List<String> quickActions() => [for (final p in enabled) ...p.quickActions];

  // ── persistence ──
  static Future<File> _file() async {
    final home = Platform.environment['HOME'];
    final dir = (home != null && home.isNotEmpty) ? Directory('$home/Documents/che_plugins') : Directory('${Directory.systemTemp.path}/che_plugins');
    if (!await dir.exists()) await dir.create(recursive: true);
    return File('${dir.path}/registry.json');
  }

  Future<void> load() async {
    try {
      final f = await _file();
      if (await f.exists()) {
        final j = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
        _installed.clear();
        _history.clear();
        _enabled.clear();
        for (final m in (j['installed'] as List? ?? const [])) {
          final p = ChePlugin((m as Map).cast<String, dynamic>());
          _installed[p.id] = p;
        }
        (j['history'] as Map? ?? const {}).forEach((k, v) {
          _history[k.toString()] = (v as List).map((e) => (e as Map).cast<String, dynamic>()).toList();
        });
        _enabled.addAll((j['enabled'] as List? ?? const []).map((e) => e.toString()));
      }
    } catch (_) {/* corrupted file → start clean rather than crash */}
    loaded = true;
    notifyListeners();
  }

  Future<void> _save() async {
    final f = await _file();
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsString(jsonEncode({
      'installed': [for (final p in _installed.values) p.raw],
      'history': _history,
      'enabled': _enabled.toList(),
    }));
    await tmp.rename(f.path); // atomic replace
  }

  Future<void> install(ChePlugin p) async {
    final problems = p.validate();
    if (problems.isNotEmpty) throw FormatException(problems.join('\n'));
    final prev = _installed[p.id];
    if (prev != null) {
      final h = _history.putIfAbsent(p.id, () => []);
      h.add(prev.raw);
      if (h.length > 5) h.removeAt(0);
    }
    _installed[p.id] = p;
    _enabled.add(p.id);
    await _save();
    notifyListeners();
  }

  Future<void> setEnabled(String id, bool on) async {
    on ? _enabled.add(id) : _enabled.remove(id);
    await _save();
    notifyListeners();
  }

  Future<void> rollback(String id) async {
    final h = _history[id];
    if (h == null || h.isEmpty) return;
    _installed[id] = ChePlugin(h.removeLast());
    await _save();
    notifyListeners();
  }

  Future<void> remove(String id) async {
    _installed.remove(id);
    _enabled.remove(id);
    _history.remove(id);
    await _save();
    notifyListeners();
  }

  /// Safe mode: turn every plugin off in one tap.
  Future<void> disableAll() async {
    _enabled.clear();
    await _save();
    notifyListeners();
  }

  // ── catalog / links ──
  static final HttpClient _http = HttpClient()..connectionTimeout = const Duration(seconds: 8);

  Future<dynamic> _getJson(Uri url, [Map<String, String> headers = const {}]) async {
    final r = await _http.getUrl(url);
    headers.forEach((k, v) => r.headers.set(k, v));
    final res = await r.close().timeout(const Duration(seconds: 20));
    final body = await res.transform(utf8.decoder).join();
    if (res.statusCode >= 400) throw HttpException('HTTP ${res.statusCode}');
    return jsonDecode(body);
  }

  Future<List<ChePlugin>> fetchCatalog() async {
    final url = resolveCatalogUrl?.call() ?? catalogUrl;
    if (url == null) return const [];
    final j = await _getJson(url, resolveCatalogHeaders?.call() ?? catalogHeaders);
    final list = j is Map ? (j['plugins'] as List? ?? const []) : (j as List);
    return list.whereType<Map>().map((m) => ChePlugin(m.cast<String, dynamic>())).toList();
  }

  Future<ChePlugin> fetchFromLink(String link) async {
    final j = await _getJson(Uri.parse(link.trim()));
    if (j is! Map) throw const FormatException('That link did not return a plugin.');
    return ChePlugin(j.cast<String, dynamic>());
  }

  /// Finds ```che-plugin blocks that CHE wrote in a chat reply.
  static List<ChePlugin> findInText(String text) {
    final out = <ChePlugin>[];
    final re = RegExp(r'```che-plugin\s*\n([\s\S]*?)```');
    for (final m in re.allMatches(text)) {
      final p = ChePlugin.tryParse(m.group(1)!);
      if (p != null) out.add(p);
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Review + install sheet (always shown before anything installs)
// ─────────────────────────────────────────────────────────────────────────

Future<bool> showChePluginReview(BuildContext context, ChePluginRegistry reg, ChePlugin p) async {
  final problems = p.validate();
  final existing = reg.byId(p.id);
  final ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.lg, CheSpace.gutter, CheSpace.lg),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: p.color.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(CheRadius.md),
                border: Border.all(color: p.color.withValues(alpha: 0.6)),
              ),
              child: Icon(p.icon, color: p.color),
            ),
            const SizedBox(width: CheSpace.md),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(p.name, style: CheType.headline),
                Text(
                  existing == null ? 'v${p.version} · by ${p.author}' : 'Update v${existing.version} → v${p.version} · by ${p.author}',
                  style: CheType.caption,
                ),
              ]),
            ),
          ]),
          const SizedBox(height: CheSpace.md),
          if (p.description.isNotEmpty) Text(p.description, style: CheType.bodyDim),
          const SizedBox(height: CheSpace.md),
          _reviewRow(Icons.psychology_rounded, 'Adds instructions to CHE', p.instructions.isNotEmpty),
          _reviewRow(Icons.build_rounded, 'Tools: ${p.tools.map((t) => t['name']).join(', ')}', p.tools.isNotEmpty),
          _reviewRow(Icons.web_rounded, 'Adds its own screen (${p.screen['type'] ?? 'none'})', p.screen.isNotEmpty),
          for (final perm in p.permissions) _reviewRow(Icons.shield_outlined, 'Permission: $perm', true, warn: true),
          if (problems.isNotEmpty) ...[
            const SizedBox(height: CheSpace.sm),
            Text('Can’t install:\n${problems.join('\n')}', style: CheType.bodyDim.copyWith(color: CheColors.danger)),
          ],
          const SizedBox(height: CheSpace.lg),
          Row(children: [
            Expanded(
              child: OutlinedButton(
                onPressed: () => Navigator.pop(ctx, false),
                style: OutlinedButton.styleFrom(
                  foregroundColor: CheColors.text,
                  side: const BorderSide(color: CheColors.stroke),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CheRadius.md)),
                ),
                child: const Text('Not now'),
              ),
            ),
            const SizedBox(width: CheSpace.md),
            Expanded(
              child: FilledButton(
                onPressed: problems.isEmpty ? () => Navigator.pop(ctx, true) : null,
                style: FilledButton.styleFrom(
                  backgroundColor: CheColors.accent,
                  foregroundColor: const Color(0xFF02110E),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CheRadius.md)),
                ),
                child: Text(existing == null ? 'Install' : 'Update'),
              ),
            ),
          ]),
        ]),
      ),
    ),
  );
  if (ok != true) return false;
  try {
    await reg.install(p);
    HapticFeedback.heavyImpact();
    if (context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('${p.name} installed')));
    }
    return true;
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('Install failed: $e')));
    }
    return false;
  }
}

Widget _reviewRow(IconData icon, String text, bool show, {bool warn = false}) {
  if (!show) return const SizedBox.shrink();
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(children: [
      Icon(icon, size: 16, color: warn ? CheColors.warning : CheColors.accent),
      const SizedBox(width: 8),
      Expanded(child: Text(text, style: CheType.bodyDim.copyWith(fontSize: 13.5))),
    ]),
  );
}

/// Card shown under a chat reply when CHE wrote a plugin.
class ChePluginOfferCard extends StatelessWidget {
  const ChePluginOfferCard({super.key, required this.registry, required this.plugin});
  final ChePluginRegistry registry;
  final ChePlugin plugin;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: registry,
      builder: (context, _) {
        final have = registry.byId(plugin.id);
        final same = have != null && have.version == plugin.version;
        return Padding(
          padding: const EdgeInsets.only(top: CheSpace.sm),
          child: GlowCard(
            active: !same,
            color: plugin.color,
            radius: CheRadius.md,
            child: Row(children: [
              Icon(plugin.icon, color: plugin.color),
              const SizedBox(width: CheSpace.md),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(plugin.name, style: CheType.label),
                  Text(same ? 'Installed · v${plugin.version}' : 'New plugin · v${plugin.version}', style: CheType.caption),
                ]),
              ),
              if (!same)
                FilledButton(
                  onPressed: () => showChePluginReview(context, registry, plugin),
                  style: FilledButton.styleFrom(
                    backgroundColor: plugin.color,
                    foregroundColor: const Color(0xFF02110E),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CheRadius.pill)),
                  ),
                  child: Text(have == null ? 'Review' : 'Update'),
                )
              else
                const Icon(Icons.check_circle_rounded, color: CheColors.success),
            ]),
          ),
        );
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Plugins section screen (use as the "Plugins" tile in the Office hub)
// ─────────────────────────────────────────────────────────────────────────

class ChePluginsScreen extends StatefulWidget {
  const ChePluginsScreen({
    super.key,
    required this.registry,
    required this.onAskCheToBuild,
    this.webAppBuilder,
    this.onRunPrompt,
    this.onOpenLearning,
    this.loadAiOverview,
  });
  final ChePluginRegistry registry;

  /// Loads CHE's AI layer overview (GET /api/ai/overview) for the
  /// AI & Models section. Hidden when null.
  final Future<Map<String, dynamic>> Function()? loadAiOverview;

  /// Opens chat with a prompt like "Build me a plugin that…".
  final VoidCallback onAskCheToBuild;

  /// Builds a WebView for "webapp" plugins (provided by the app, e.g. with
  /// webview_flutter). Receives either html or url.
  final Widget Function(BuildContext context, {String? html, String? url})? webAppBuilder;

  /// Sends a prompt to CHE (used by plugin cards / quick actions).
  final void Function(String prompt)? onRunPrompt;

  /// Opens CHE's owner-approved learning/import controls.
  final VoidCallback? onOpenLearning;

  @override
  State<ChePluginsScreen> createState() => _ChePluginsScreenState();
}

class _ChePluginsScreenState extends State<ChePluginsScreen> {
  Future<List<ChePlugin>>? _catalog;
  String _section = 'discover';
  String _query = '';

  ChePluginRegistry get reg => widget.registry;

  @override
  void initState() {
    super.initState();
    if (!reg.loaded) reg.load();
    _reloadCatalog();
  }

  void _reloadCatalog() {
    _catalog = reg.fetchCatalog();
  }

  Future<void> _addFromPasteOrLink() async {
    final ctrl = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: CheColors.surface,
        title: const Text('Add a plugin', style: CheType.headline),
        content: TextField(
          controller: ctrl,
          minLines: 3,
          maxLines: 8,
          style: CheType.mono,
          decoration: const InputDecoration(
            hintText: 'Paste a secure HTTPS link or plugin JSON',
            hintStyle: CheType.bodyDim,
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Review')),
        ],
      ),
    );
    if (text == null || text.trim().isEmpty || !mounted) return;
    ChePlugin? p;
    try {
      p = text.trim().startsWith('http')
          ? await reg.fetchFromLink(text)
          : ChePlugin.tryParse(text);
    } catch (_) {}
    if (!mounted) return;
    if (p == null) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('That is not a valid CHE plugin.')),
      );
      return;
    }
    await showChePluginReview(context, reg, p);
  }

  void _openPlugin(ChePlugin p) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ChePluginPage(
        plugin: p,
        webAppBuilder: widget.webAppBuilder,
        onRunPrompt: widget.onRunPrompt,
      ),
    ));
  }

  bool _matches(ChePlugin p) {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return true;
    return [
      p.name,
      p.description,
      p.author,
      p.instructions,
      p.permissions.join(' '),
      p.quickActions.join(' '),
    ].join(' ').toLowerCase().contains(q);
  }

  void _runPrompt(String prompt) {
    final run = widget.onRunPrompt;
    if (run != null) run(prompt);
  }

  Widget _navChip(String id, String label, IconData icon) {
    final selected = _section == id;
    return Semantics(
      button: true,
      selected: selected,
      label: '$label section',
      child: ChoiceChip(
        selected: selected,
        onSelected: (_) {
          HapticFeedback.selectionClick();
          setState(() => _section = id);
        },
        avatar: Icon(
          icon,
          size: 16,
          color: selected ? const Color(0xFF03120F) : CheColors.textDim,
        ),
        label: Text(label),
        labelStyle: CheType.label.copyWith(
          color: selected ? const Color(0xFF03120F) : CheColors.text,
        ),
        selectedColor: CheColors.accent,
        backgroundColor: CheColors.surface,
        side: BorderSide(color: selected ? CheColors.accent : CheColors.stroke),
        showCheckmark: false,
        visualDensity: VisualDensity.compact,
      ),
    );
  }

  Widget _statusStrip(List<ChePlugin> installed) {
    final enabled = installed.where((p) => reg.isEnabled(p.id)).length;
    return Semantics(
      label: '$enabled plugins enabled, ${installed.length} installed. Learning tools ready.',
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: CheSpace.md,
          vertical: 12,
        ),
        decoration: BoxDecoration(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.md),
          border: Border.all(color: CheColors.stroke),
        ),
        child: Row(children: [
          const Icon(Icons.hub_rounded, size: 18, color: CheColors.accent),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '$enabled enabled · ${installed.length} installed · learning ready',
              style: CheType.label,
            ),
          ),
          IconButton(
            tooltip: 'Refresh plugin catalog',
            onPressed: () {
              HapticFeedback.selectionClick();
              setState(_reloadCatalog);
            },
            icon: const Icon(Icons.refresh_rounded, size: 19),
          ),
        ]),
      ),
    );
  }

  Widget _searchBox() {
    return TextField(
      onChanged: (value) => setState(() => _query = value),
      style: CheType.body,
      textInputAction: TextInputAction.search,
      decoration: InputDecoration(
        prefixIcon: const Icon(Icons.search_rounded, size: 20),
        hintText: 'Search skills',
        hintStyle: CheType.bodyDim,
        filled: true,
        fillColor: CheColors.surface,
        contentPadding: const EdgeInsets.symmetric(vertical: 12),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(CheRadius.md),
          borderSide: const BorderSide(color: CheColors.stroke),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(CheRadius.md),
          borderSide: const BorderSide(color: CheColors.stroke),
        ),
      ),
    );
  }

  Widget _learningPanel() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        CheFeatureCard(
          icon: Icons.psychology_alt_rounded,
          hue: CheColors.accent,
          title: 'Learning Lab',
          body: 'Teach CHE from files, photos, videos, shared text and browser pages you approve.',
          onTap: widget.onOpenLearning,
        ),
        const SizedBox(height: CheSpace.md),
        CheFeatureCard(
          icon: Icons.tune_rounded,
          hue: CheColors.accentAlt,
          title: 'Fine-Tuning Lab',
          body: 'Prepare clean training sets, evaluate models, and run LoRA/adapter tuning through a connected training service.',
          onTap: widget.onRunPrompt == null
              ? null
              : () => _runPrompt(
                    'Open CHE Fine-Tuning Lab. Help me choose an approved dataset, clean and split it, create an evaluation set, choose a base open model such as a Llama-family model, and prepare a LoRA or adapter fine-tuning job. Prefer my connected VMware Private AI training service when configured; otherwise prepare a Hugging Face compatible job. Never upload private data or spend money without my approval.',
                  ),
        ),
        const SizedBox(height: CheSpace.md),
        CheFeatureCard(
          icon: Icons.dns_rounded,
          hue: CheColors.success,
          title: 'VMware Private AI',
          body: 'Use a connected VMware Cloud Foundation / Private AI GPU endpoint for private model training and evaluation.',
          onTap: widget.onRunPrompt == null
              ? null
              : () => _runPrompt(
                    'Check CHE VMware fine-tuning readiness. If CHE_VMWARE_TRAINING_URL is configured, explain the available private training path and prepare a reversible training job. If it is not configured, tell me exactly what endpoint and server-side credential CHE needs. Do not claim training ran unless the connector confirms it.',
                  ),
        ),
        const SizedBox(height: CheSpace.md),
        CheFeatureCard(
          icon: Icons.manage_search_rounded,
          hue: CheColors.warning,
          title: 'Review what CHE knows',
          body: 'Group learned context into People, Projects, Decisions, Companies, Meetings, Daily and Knowledge.',
          onTap: widget.onRunPrompt == null
              ? null
              : () => _runPrompt(
                    'Review the owner context you have learned. Group it into People, Projects, Decisions, Companies, Meetings, Daily, and Knowledge. Flag uncertainty and duplicates, and tell me what should be corrected or deleted.',
                  ),
        ),
        const SizedBox(height: CheSpace.md),
        CheFeatureCard(
          icon: Icons.auto_graph_rounded,
          hue: CheColors.success,
          title: 'Build reusable knowledge',
          body: 'Turn approved source material into durable, searchable context CHE can use later.',
          onTap: widget.onRunPrompt == null
              ? null
              : () => _runPrompt(
                    'Help me build CHE knowledge from my approved sources. Ask which source I want to import, then organize only what I provide into reusable facts with provenance. Do not invent anything.',
                  ),
        ),
        const SizedBox(height: CheSpace.sm),
        Text(
          'CHE learning uses editable memory and retrieval first. Fine-tuning changes a model only through a connected training backend, so the phone stays fast and the result can be evaluated or rolled back.',
          style: CheType.caption,
        ),
      ],
    );
  }

  Widget _buildPanel() {
    return Column(
      children: [
        CheFeatureCard(
          icon: Icons.sms_outlined,
          hue: const Color(0xFFF22F46),
          title: 'Twilio SMS (CHE)',
          body: 'Connect Twilio so CHE can text. Secrets stay on the Worker (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER). Bulk needs your yes.',
          onTap: widget.onRunPrompt == null
              ? null
              : () => _runPrompt(
                    'Explain how to connect Twilio SMS for CHE using wrangler secret put for TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER. Check GET /api/twilio/status without echoing any secret values. Remind me that only CHE sends, bulk stays Owner decision pending until I confirm, and trial limits are about 5 verified numbers and 100 SMS.',
                  ),
        ),
        const SizedBox(height: CheSpace.md),
        CheFeatureCard(
          icon: Icons.auto_awesome_rounded,
          title: 'Ask CHE to build a plugin',
          body: 'Describe a skill. CHE drafts it, you review permissions, then you approve installation.',
          onTap: widget.onAskCheToBuild,
        ),
        const SizedBox(height: CheSpace.md),
        CheFeatureCard(
          icon: Icons.add_link_rounded,
          hue: CheColors.accentAlt,
          title: 'Add from link or JSON',
          body: 'Import a plugin manifest, inspect its permissions, and keep rollback available.',
          onTap: _addFromPasteOrLink,
        ),
      ],
    );
  }

  Widget _installedPanel(List<ChePlugin> installed) {
    final list = installed.where(_matches).toList();
    if (list.isEmpty) {
      return Text(
        installed.isEmpty
            ? 'No plugins installed yet.'
            : 'No installed plugins match your search.',
        style: CheType.bodyDim,
      );
    }
    return Column(children: [
      for (final p in list)
        Padding(
          padding: const EdgeInsets.only(bottom: CheSpace.md),
          child: _installedTile(p),
        ),
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          onPressed: reg.disableAll,
          icon: const Icon(
            Icons.shield_outlined,
            color: CheColors.warning,
            size: 18,
          ),
          label: Text(
            'Safe mode: turn all plugins off',
            style: CheType.label.copyWith(color: CheColors.warning),
          ),
        ),
      ),
    ]);
  }

  Widget _discoverPanel() {
    return FutureBuilder<List<ChePlugin>>(
      future: _catalog,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Padding(
            padding: EdgeInsets.all(CheSpace.md),
            child: ThinkingShimmer(text: 'Loading skills…'),
          );
        }
        final list = (snap.data ?? const [])
            .where((p) => reg.byId(p.id)?.version != p.version)
            .where(_matches)
            .toList();
        if (list.isEmpty) {
          return Text(
            snap.hasError
                ? 'Skill catalog is unavailable right now.'
                : (_query.isEmpty
                    ? 'You have everything currently in the catalog.'
                    : 'No skills match your search.'),
            style: CheType.bodyDim,
          );
        }
        return Column(children: [
          for (final p in list)
            Padding(
              padding: const EdgeInsets.only(bottom: CheSpace.md),
              child: Semantics(
                button: true,
                label: '${p.name}. ${p.description}. Review plugin.',
                child: CheFeatureCard(
                  icon: p.icon,
                  hue: p.color,
                  title: reg.byId(p.id) == null ? p.name : '${p.name} · update',
                  body: p.description,
                  onTap: () => showChePluginReview(context, reg, p),
                ),
              ),
            ),
        ]);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: reg,
      builder: (context, _) {
        final installed = reg.installed;
        final media = MediaQuery.of(context);
        final scaled = MediaQuery.textScalerOf(context).scale(1);
        final scale = scaled.clamp(1.0, 1.35).toDouble();

        return MediaQuery(
          data: media.copyWith(textScaler: TextScaler.linear(scale)),
          child: CheSectionPage(
            title: 'Plugins & Learning',
            description: 'Skills, tools, model learning and approved knowledge sources in one place.',
            action: Semantics(
              button: true,
              label: 'Add plugin',
              child: CheIconButton(
                icon: Icons.add_rounded,
                onTap: _addFromPasteOrLink,
                size: 40,
              ),
            ),
            children: [
              _statusStrip(installed),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  _navChip('discover', 'Discover', Icons.explore_outlined),
                  _navChip('installed', 'Installed', Icons.extension_rounded),
                  _navChip('learn', 'Learn', Icons.psychology_alt_outlined),
                  _navChip('build', 'Build', Icons.add_circle_outline_rounded),
                  if (widget.loadAiOverview != null)
                    _navChip('models', 'AI & Models', Icons.hub_outlined),
                ],
              ),
              if (_section == 'discover' || _section == 'installed')
                _searchBox(),
              if (_section == 'discover') _discoverPanel(),
              if (_section == 'installed') _installedPanel(installed),
              if (_section == 'learn') _learningPanel(),
              if (_section == 'build') _buildPanel(),
              if (_section == 'models' && widget.loadAiOverview != null)
                CheAiModelsPanel(load: widget.loadAiOverview!, onRunPrompt: widget.onRunPrompt),
            ],
          ),
        );
      },
    );
  }

  Widget _installedTile(ChePlugin p) {
    return Semantics(
      label: '${p.name}, version ${p.version}, ${reg.isEnabled(p.id) ? 'enabled' : 'disabled'}',
      child: Container(
        padding: const EdgeInsets.all(CheSpace.md),
        decoration: BoxDecoration(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.lg),
          border: Border.all(
            color: reg.isEnabled(p.id)
                ? p.color.withValues(alpha: 0.5)
                : CheColors.stroke,
          ),
        ),
        child: Row(children: [
          GestureDetector(
            onTap: () => _openPlugin(p),
            child: Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: p.color.withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(CheRadius.sm),
              ),
              child: Icon(p.icon, color: p.color),
            ),
          ),
          const SizedBox(width: CheSpace.md),
          Expanded(
            child: GestureDetector(
              onTap: () => _openPlugin(p),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    p.name,
                    style: CheType.label,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text('v${p.version}', style: CheType.caption),
                ],
              ),
            ),
          ),
          PopupMenuButton<String>(
            color: CheColors.surfaceHi,
            icon: const Icon(Icons.more_horiz_rounded, color: CheColors.textDim),
            onSelected: (v) {
              if (v == 'open') _openPlugin(p);
              if (v == 'rollback') reg.rollback(p.id);
              if (v == 'remove') reg.remove(p.id);
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'open', child: Text('Open')),
              if (reg.canRollback(p.id))
                const PopupMenuItem(
                  value: 'rollback',
                  child: Text('Roll back to previous version'),
                ),
              const PopupMenuItem(value: 'remove', child: Text('Remove')),
            ],
          ),
          Switch(
            value: reg.isEnabled(p.id),
            activeThumbColor: p.color,
            onChanged: (v) {
              HapticFeedback.selectionClick();
              reg.setEnabled(p.id, v);
            },
          ),
        ]),
      ),
    );
  }
}

/// Renders a plugin's own screen: "cards" (native) or "webapp" (WebView).
class ChePluginPage extends StatelessWidget {
  const ChePluginPage({super.key, required this.plugin, this.webAppBuilder, this.onRunPrompt});
  final ChePlugin plugin;
  final Widget Function(BuildContext context, {String? html, String? url})? webAppBuilder;
  final void Function(String prompt)? onRunPrompt;

  @override
  Widget build(BuildContext context) {
    final s = plugin.screen;
    Widget body;
    if (s['type'] == 'webapp' && webAppBuilder != null) {
      body = webAppBuilder!(context, html: s['html']?.toString(), url: s['url']?.toString());
    } else {
      final cards = (s['cards'] is List) ? (s['cards'] as List).whereType<Map>().toList() : const <Map>[];
      body = CheSectionPage(
        title: (s['title'] ?? plugin.name).toString(),
        description: (s['description'] ?? plugin.description).toString(),
        children: [
          for (final c in cards)
            CheFeatureCard(
              icon: cheIconFromName(c['icon']?.toString()),
              hue: plugin.color,
              title: (c['title'] ?? '').toString(),
              body: (c['body'] ?? '').toString(),
              onTap: c['prompt'] != null && onRunPrompt != null
                  ? () {
                      Navigator.of(context).pop();
                      onRunPrompt!(c['prompt'].toString());
                    }
                  : null,
            ),
          if (cards.isEmpty && plugin.quickActions.isNotEmpty)
            for (final q in plugin.quickActions)
              CheFeatureCard(
                icon: Icons.bolt_rounded,
                hue: plugin.color,
                title: q,
                body: 'Run with CHE',
                onTap: onRunPrompt == null
                    ? null
                    : () {
                        Navigator.of(context).pop();
                        onRunPrompt!(q);
                      },
              ),
        ],
      );
    }
    return Scaffold(
      backgroundColor: CheColors.bg,
      body: CheBackground(
        auraColor: plugin.color,
        child: SafeArea(
          bottom: false,
          child: Column(children: [
            CheHeader(
              compact: true,
              title: plugin.name.toUpperCase(),
              subtitle: 'PLUGIN · v${plugin.version}',
              status: null,
              leading: IconButton(
                icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19, color: CheColors.text),
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(child: body),
          ]),
        ),
      ),
    );
  }
}

/// The instructions CHE's Worker should add to her system prompt so she can
/// write valid plugins on request. (Also used by ChatGPT when wiring the Worker.)
const String chePluginAuthoringGuide = r'''
When the user asks you to build a plugin (a new skill, tool, or screen for CHE),
reply with a short explanation and ONE fenced block tagged che-plugin that
contains a JSON manifest in exactly this shape:

```che-plugin
{
  "id": "lowercase-dashes",
  "name": "Display Name",
  "version": "1.0.0",
  "author": "CHE",
  "description": "One sentence on what it does.",
  "icon": "chart",
  "color": "#34E0B8",
  "permissions": ["network:api.example.com"],
  "instructions": "Extra rules CHE follows when this plugin is on.",
  "quickActions": ["Short prompt the user can tap"],
  "tools": [
    {"name": "get_thing", "description": "What it returns",
     "params": {"q": "string"},
     "request": {"method": "GET", "url": "https://api.example.com/x?q={{q}}"}}
  ],
  "screen": {"type": "cards", "title": "Title", "description": "Subtitle",
             "cards": [{"icon": "bolt", "title": "Card", "body": "What it does", "prompt": "Prompt sent to CHE on tap"}]}
}
```
Field rules:
- id: unique, lowercase letters, numbers and dashes (2-41 chars). To UPDATE a plugin reuse its id and bump version.
- icon: one of extension, chart, money, crypto, music, image, camera, code, calendar, fitness, food, home, car, mail, chat, search, news, weather, shopping, book, bolt, star, tool, brain, game, video, map, lock, globe.
- screen can instead be {"type": "webapp", "html": "<!doctype html>...full self-contained page..."} for a mini app.
- tools, screen, quickActions and permissions are optional.
- Output strict JSON (double quotes, no comments, no trailing commas). No API keys or secrets. Only public HTTPS APIs.
''';
