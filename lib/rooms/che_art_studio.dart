// CHE Art / Visual Studio: warm artist loft with a gallery wall of real
// generated pieces. Every piece keeps its versions (new, variation, refine,
// upscale). Highest quality by default; draft only when the owner picks it.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_rooms.dart';
import '../che_ui/che_theme.dart';
import '../widgets/che_3d_room_view.dart';

class CheArtPiece {
  const CheArtPiece(this.raw);
  final Map<String, dynamic> raw;
  String get id => '${raw['id']}';
  String get rootId => '${raw['root_id'] ?? raw['id']}';
  String get title => '${raw['title'] ?? 'Untitled'}';
  String get prompt => '${raw['prompt'] ?? ''}';
  String get mode => '${raw['mode'] ?? 'new'}';
  String get engine => '${raw['engine'] ?? ''}';
  int get version => (raw['version'] as num?)?.toInt() ?? 1;
  bool get draft => raw['draft'] == true;
  DateTime? get createdAt => DateTime.tryParse('${raw['created_at'] ?? ''}');
}

class CheArtStudio extends StatefulWidget {
  const CheArtStudio({
    super.key,
    required this.baseUrl,
    required this.headers,
    required this.onSaveToVault,
    this.client,
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;

  /// Saves a piece reference (title, prompt, link) to CHE's Data Vault.
  final Future<void> Function(String name, String content) onSaveToVault;
  final http.Client? client;

  @override
  State<CheArtStudio> createState() => _CheArtStudioState();
}

class _CheArtStudioState extends State<CheArtStudio> {
  static const _warm = Color(0xFFFF8A4C);

  late final http.Client _http = widget.client ?? http.Client();
  List<CheArtPiece> _items = const [];
  String _engine = 'none';
  bool _upscaler = false;
  bool _loading = true;
  bool _working = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<Map<String, dynamic>> _call(String method, String path, [Map<String, dynamic>? body]) async {
    final request = http.Request(method, Uri.parse('${widget.baseUrl()}$path'))..headers.addAll(widget.headers());
    if (body != null) request.body = jsonEncode(body);
    final response = await http.Response.fromStream(await _http.send(request).timeout(const Duration(seconds: 90)));
    final j = jsonDecode(response.body);
    if (response.statusCode != 200 || j is! Map<String, dynamic>) {
      throw Exception(j is Map ? '${j['detail'] ?? 'Art Studio error'}' : 'Art Studio error ${response.statusCode}');
    }
    return j;
  }

  Future<void> _load() async {
    try {
      final j = await _call('GET', '/api/media');
      _items = [for (final i in (j['items'] as List? ?? const [])) if (i is Map<String, dynamic>) CheArtPiece(i)];
      _engine = '${j['engine'] ?? 'none'}';
      _upscaler = j['upscaler'] == true;
      _error = null;
    } catch (e) {
      _error = '$e'.replaceFirst('Exception: ', '');
    }
    if (mounted) setState(() => _loading = false);
  }

  String imageUrl(CheArtPiece p) => '${widget.baseUrl()}/api/media/${p.id}/image';

  List<CheArtPiece> get _roots {
    final latest = <String, CheArtPiece>{};
    for (final p in _items) {
      latest.putIfAbsent(p.rootId, () => p); // items are newest first
    }
    return latest.values.toList();
  }

  List<CheArtPiece> versionsOf(String rootId) =>
      _items.where((p) => p.rootId == rootId).toList()..sort((a, b) => a.version.compareTo(b.version));

  Future<CheArtPiece?> _generate(Map<String, dynamic> body) async {
    setState(() {
      _working = true;
      _error = null;
    });
    CheArtPiece? made;
    try {
      final j = await _call('POST', '/api/media/generate', body);
      made = CheArtPiece(j['item'] as Map<String, dynamic>);
      HapticFeedback.mediumImpact();
      await _load();
    } catch (e) {
      _error = '$e'.replaceFirst('Exception: ', '');
    }
    if (mounted) setState(() => _working = false);
    return made;
  }

  Future<void> _newPiece() async {
    final prompt = TextEditingController();
    var draft = false;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) => AlertDialog(
          title: const Text('New piece'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: prompt,
              autofocus: true,
              maxLines: 4,
              decoration: const InputDecoration(hintText: 'Describe it: subject, style, light, mood…'),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: draft,
              onChanged: (v) => setLocal(() => draft = v),
              title: const Text('Draft mode (faster, lower quality)'),
            ),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Create')),
          ],
        ),
      ),
    );
    if (ok != true || prompt.text.trim().isEmpty) return;
    final made = await _generate({'prompt': prompt.text.trim(), 'draft': draft});
    if (made != null && mounted) await _openPiece(made.rootId);
  }

  Future<void> _openPiece(String rootId) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => _PieceScreen(studio: this, rootId: rootId),
    ));
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final roots = _roots;
    return Material(
      color: const Color(0xFF120C08),
      child: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl),
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(CheRadius.lg),
              child: CheRoomBackdrop(
                room: CheRoom.art,
                scrim: 0.45,
                child: Padding(
                  padding: const EdgeInsets.all(CheSpace.md),
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('CHE ART STUDIO', style: CheType.overline.copyWith(color: Colors.white)),
                        const SizedBox(height: 4),
                        Text(
                          _engine == 'none'
                              ? 'Image engine not connected'
                              : _engine == 'connector'
                                  ? 'Your image engine · highest quality'
                                  : 'CHE image engine · highest quality',
                          maxLines: 2,
                          style: CheType.caption.copyWith(color: Colors.white70),
                        ),
                      ]),
                    ),
                    FilledButton.icon(
                      style: FilledButton.styleFrom(backgroundColor: _warm, foregroundColor: Colors.black),
                      onPressed: _working || _engine == 'none' ? null : _newPiece,
                      icon: _working
                          ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.add_rounded),
                      label: const Text('New'),
                    ),
                  ]),
                ),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: CheSpace.sm),
                child: Text(_error!, style: CheType.caption.copyWith(color: CheColors.warning)),
              ),
            const SizedBox(height: CheSpace.md),
            Che3DRoomView(
              assetPath: 'assets/office3d/artstudio.html',
              updateFunction: 'updateScene',
              payload: {
                'agents': [
                  {'id': 'che', 'name': 'CHE', 'role': 'Curator', 'status': _working ? 'working' : 'idle', 'isChe': true},
                ],
                'pieces': [
                  for (final p in roots.take(6))
                    {'id': p.rootId, 'title': p.title, 'mode': p.mode},
                ],
              },
              height: 340,
              backgroundColor: const Color(0xFF1A100C),
              semanticsLabel: '3D Art Studio gallery',
              onTapId: (id) {
                final match = roots.where((p) => p.rootId == id || p.id == id);
                if (match.isNotEmpty) unawaited(_openPiece(match.first.rootId));
              },
            ),
            const SizedBox(height: CheSpace.md),
            Text('GALLERY WALL', style: CheType.overline.copyWith(color: _warm)),
            const SizedBox(height: CheSpace.sm),
            if (_loading)
              const Padding(padding: EdgeInsets.all(CheSpace.xl), child: Center(child: CircularProgressIndicator()))
            else if (roots.isEmpty)
              Text('No pieces yet. Tap New and describe what you want to see.', style: CheType.bodyDim)
            else
              GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: roots.length,
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 2,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 14,
                  childAspectRatio: 0.78,
                ),
                itemBuilder: (_, i) {
                  final p = roots[i];
                  final count = versionsOf(p.rootId).length;
                  return GestureDetector(
                    onTap: () => _openPiece(p.rootId),
                    child: Container(
                      padding: const EdgeInsets.all(6),
                      decoration: BoxDecoration(
                        color: const Color(0xFF3A2A1C),
                        borderRadius: BorderRadius.circular(6),
                        boxShadow: const [BoxShadow(color: Colors.black54, blurRadius: 10, offset: Offset(0, 5))],
                      ),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        Expanded(
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(3),
                            child: Image.network(
                              imageUrl(p),
                              headers: widget.headers(),
                              fit: BoxFit.cover,
                              errorBuilder: (_, _, _) => const ColoredBox(
                                color: Color(0xFF24190F),
                                child: Icon(Icons.broken_image_outlined, color: Colors.white38),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(p.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label),
                        Text('v${p.version}${count > 1 ? ' · $count versions' : ''}',
                            maxLines: 1, style: CheType.caption.copyWith(fontSize: 10)),
                      ]),
                    ),
                  );
                },
              ),
          ],
        ),
      ),
    );
  }
}

class _PieceScreen extends StatefulWidget {
  const _PieceScreen({required this.studio, required this.rootId});
  final _CheArtStudioState studio;
  final String rootId;
  @override
  State<_PieceScreen> createState() => _PieceScreenState();
}

class _PieceScreenState extends State<_PieceScreen> {
  String? _selected;

  _CheArtStudioState get s => widget.studio;

  List<CheArtPiece> get _versions => s.versionsOf(widget.rootId);

  CheArtPiece? get _current {
    final v = _versions;
    if (v.isEmpty) return null;
    return v.firstWhere((p) => p.id == _selected, orElse: () => v.last);
  }

  void _snack(String t) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(t)));

  Future<void> _variation() async {
    final p = _current;
    if (p == null) return;
    final made = await s._generate({'mode': 'variation', 'parent_id': p.id});
    if (made != null) setState(() => _selected = made.id);
    if (s._error != null) _snack(s._error!);
  }

  Future<void> _refine() async {
    final p = _current;
    if (p == null) return;
    final ctrl = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Refine'),
        content: TextField(controller: ctrl, autofocus: true, maxLines: 3, decoration: const InputDecoration(hintText: 'What should change?')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, ctrl.text), child: const Text('Refine')),
        ],
      ),
    );
    if (text == null || text.trim().isEmpty) return;
    final made = await s._generate({'mode': 'refine', 'parent_id': p.id, 'prompt': text.trim()});
    if (made != null) setState(() => _selected = made.id);
    if (s._error != null) _snack(s._error!);
  }

  Future<void> _upscale() async {
    final p = _current;
    if (p == null) return;
    try {
      final j = await s._call('POST', '/api/media/${p.id}/upscale');
      await s._load();
      setState(() => _selected = '${(j['item'] as Map)['id']}');
    } catch (e) {
      _snack('$e'.replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _delete() async {
    final p = _current;
    if (p == null) return;
    try {
      await s._call('DELETE', '/api/media/${p.id}');
      await s._load();
      if (_versions.isEmpty && mounted) {
        Navigator.of(context).pop();
        return;
      }
      setState(() => _selected = null);
    } catch (e) {
      _snack('$e'.replaceFirst('Exception: ', ''));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _current;
    final versions = _versions;
    return Scaffold(
      backgroundColor: const Color(0xFF120C08),
      appBar: AppBar(title: Text(p?.title ?? 'Piece', maxLines: 1, overflow: TextOverflow.ellipsis)),
      body: p == null
          ? const Center(child: Text('This piece was deleted.'))
          : ListView(
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.xxl),
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(CheRadius.md),
                  child: AspectRatio(
                    aspectRatio: 1,
                    child: InteractiveViewer(
                      child: Image.network(
                        s.imageUrl(p),
                        headers: s.widget.headers(),
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => const Center(child: Icon(Icons.broken_image_outlined)),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: CheSpace.sm),
                SizedBox(
                  height: 64,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: versions.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 8),
                    itemBuilder: (_, i) {
                      final v = versions[i];
                      final on = v.id == p.id;
                      return GestureDetector(
                        onTap: () => setState(() => _selected = v.id),
                        child: Container(
                          width: 64,
                          decoration: BoxDecoration(
                            border: Border.all(color: on ? const Color(0xFFFF8A4C) : Colors.white12, width: on ? 2 : 1),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          clipBehavior: Clip.antiAlias,
                          child: Stack(fit: StackFit.expand, children: [
                            Image.network(s.imageUrl(v), headers: s.widget.headers(), fit: BoxFit.cover,
                                errorBuilder: (_, _, _) => const SizedBox()),
                            Align(
                              alignment: Alignment.bottomRight,
                              child: Container(
                                color: Colors.black54,
                                padding: const EdgeInsets.symmetric(horizontal: 4),
                                child: Text('v${v.version}', style: const TextStyle(fontSize: 10)),
                              ),
                            ),
                          ]),
                        ),
                      );
                    },
                  ),
                ),
                const SizedBox(height: CheSpace.md),
                Text('v${p.version} · ${p.mode}${p.draft ? ' · draft' : ''} · ${p.engine}', style: CheType.caption),
                const SizedBox(height: CheSpace.xs),
                SelectableText(p.prompt, style: CheType.body),
                const SizedBox(height: CheSpace.md),
                if (s._working) const LinearProgressIndicator(),
                Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.sm, children: [
                  FilledButton.icon(
                    onPressed: s._working ? null : _refine,
                    icon: const Icon(Icons.tune_rounded, size: 18),
                    label: const Text('Refine'),
                  ),
                  OutlinedButton.icon(
                    onPressed: s._working ? null : _variation,
                    icon: const Icon(Icons.auto_awesome_mosaic_outlined, size: 18),
                    label: const Text('Variation'),
                  ),
                  OutlinedButton.icon(
                    onPressed: s._working ? null : _upscale,
                    icon: const Icon(Icons.hd_outlined, size: 18),
                    label: Text(s._upscaler ? 'Upscale 4×' : 'Upscale (connect)'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () async {
                      await s.widget.onSaveToVault(
                        'Art: ${p.title} v${p.version}',
                        'Prompt: ${p.prompt}\nEngine: ${p.engine}\nImage: ${s.imageUrl(p)}',
                      );
                      if (mounted) _snack('Saved to the Data Vault.');
                    },
                    icon: const Icon(Icons.inventory_2_outlined, size: 18),
                    label: const Text('Save to Vault'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () {
                      Clipboard.setData(ClipboardData(text: p.prompt));
                      _snack('Prompt copied.');
                    },
                    icon: const Icon(Icons.copy_rounded, size: 18),
                    label: const Text('Copy prompt'),
                  ),
                  OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(foregroundColor: CheColors.danger),
                    onPressed: s._working ? null : _delete,
                    icon: const Icon(Icons.delete_outline_rounded, size: 18),
                    label: const Text('Delete version'),
                  ),
                ]),
              ],
            ),
    );
  }
}
