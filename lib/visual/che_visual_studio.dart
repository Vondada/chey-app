// Visual Studio inside Create: Images · Video · Templates · Projects. Not a new room: it opens from Create.
// Templates show a real preview drawn from the template's own document; tap to preview, then Use Template.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import 'che_image_canvas.dart';
import 'che_image_editor.dart';
import 'che_video_editor.dart';
import 'che_visual_client.dart';

const _accent = Color(0xFF7FF5E6);

class CheVisualStudio extends StatefulWidget {
  const CheVisualStudio({super.key, required this.client, this.initialTab = 0, this.openProjectId});
  final CheVisualClient client;
  final int initialTab;

  /// Opens this project's editor straight away (from "Edit" in chat).
  final String? openProjectId;

  @override
  State<CheVisualStudio> createState() => _CheVisualStudioState();
}

class _CheVisualStudioState extends State<CheVisualStudio> {
  Map<String, dynamic>? _catalog;
  String _error = '';
  late final CheImageCache _cache = CheImageCache((id) => widget.client.mediaUrl(id), widget.client.headers);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    final id = widget.openProjectId;
    if (id != null) WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_openById(id)));
  }

  Future<void> _load() async {
    try {
      _catalog = await widget.client.catalog();
      _error = '';
    } on CheVisualException catch (e) {
      _error = e.message;
    }
    if (mounted) setState(() {});
  }

  List<Map<String, dynamic>> _list(String key) => [for (final x in (_catalog?[key] as List? ?? const [])) Map<String, dynamic>.from(x as Map)];

  Future<void> _openById(String id) async {
    try {
      final v = await widget.client.project(id);
      if (!mounted) return;
      await _open(Map<String, dynamic>.from(v['project'] as Map));
    } on CheVisualException catch (e) {
      setState(() => _error = e.message);
    }
  }

  Future<void> _open(Map<String, dynamic> p) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => p['kind'] == 'video'
          ? CheVideoEditor(client: widget.client, projectId: '${p['id']}', pickMedia: pickMedia)
          : CheImageEditor(client: widget.client, projectId: '${p['id']}'),
    ));
    await _load();
  }

  Future<void> _create(Map<String, dynamic> body) async {
    try {
      final r = await widget.client.post({'action': 'create', ...body});
      if (!mounted) return;
      await _open(Map<String, dynamic>.from(r['project'] as Map));
    } on CheVisualException catch (e) {
      setState(() => _error = e.message);
    }
  }

  /// The owner's media library, or a photo or video from the iPhone (uploaded into the same library).
  Future<Map<String, dynamic>?> pickMedia(BuildContext context, {required String kind}) async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('From my CHE library'), onTap: () => Navigator.pop(c, 'library')),
          if (kind != 'audio') ListTile(leading: const Icon(Icons.add_photo_alternate_outlined), title: const Text('Photo from iPhone'), onTap: () => Navigator.pop(c, 'photo')),
          if (kind != 'audio') ListTile(leading: const Icon(Icons.video_library_outlined), title: const Text('Video from iPhone'), onTap: () => Navigator.pop(c, 'video')),
        ]),
      ),
    );
    if (choice == null) return null;
    if (choice == 'library') {
      final items = await _libraryItems();
      if (!context.mounted) return null;
      final wanted = items.where((i) {
        final mime = '${i['mime_type'] ?? ''}';
        return kind == 'audio' ? mime.startsWith('audio/') : (mime.startsWith('image/') || mime.startsWith('video/'));
      }).toList();
      return showModalBottomSheet<Map<String, dynamic>>(
        context: context,
        builder: (c) => wanted.isEmpty
            ? const Padding(padding: EdgeInsets.all(24), child: Text('Nothing of that kind in your library yet.'))
            : ListView(children: [
                for (final i in wanted)
                  ListTile(title: Text('${i['title'] ?? 'Untitled'}'), subtitle: Text('${i['mime_type']}'), onTap: () => Navigator.pop(c, i)),
              ]),
      );
    }
    final picker = ImagePicker();
    final file = choice == 'photo' ? await picker.pickImage(source: ImageSource.gallery, maxWidth: 3000) : await picker.pickVideo(source: ImageSource.gallery);
    if (file == null) return null;
    final bytes = await file.readAsBytes();
    try {
      final r = await widget.client.post({'action': 'upload', 'name': file.name, 'media_type': choice == 'photo' ? 'image/jpeg' : 'video/mp4', 'base64': base64Encode(bytes)}, timeout: const Duration(minutes: 3));
      return Map<String, dynamic>.from(r['item'] as Map);
    } on CheVisualException catch (e) {
      if (mounted) setState(() => _error = e.message);
      return null;
    }
  }

  Future<List<Map<String, dynamic>>> _libraryItems() async {
    try {
      return await widget.client.mediaList();
    } on CheVisualException catch (e) {
      if (mounted) setState(() => _error = e.message);
      return const [];
    }
  }

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 4,
      initialIndex: widget.initialTab,
      child: Scaffold(
        backgroundColor: const Color(0xFF071019),
        appBar: AppBar(
          backgroundColor: const Color(0xFF071019),
          title: const Text('Visual Studio'),
          bottom: const TabBar(isScrollable: true, tabs: [Tab(text: 'Images'), Tab(text: 'Video'), Tab(text: 'Templates'), Tab(text: 'Projects')]),
        ),
        body: Column(children: [
          if (_error.isNotEmpty) Padding(padding: const EdgeInsets.all(12), child: Text(_error, style: const TextStyle(color: Colors.redAccent))),
          Expanded(
            child: TabBarView(children: [
              _startTab(kind: 'image'),
              _startTab(kind: 'video'),
              _templatesTab(),
              _projectsTab(),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _startTab({required String kind}) {
    final projects = _list('projects').where((p) => p['kind'] == kind).toList();
    return ListView(padding: const EdgeInsets.all(16), children: [
      Wrap(spacing: 12, runSpacing: 12, children: [
        FilledButton.icon(
          onPressed: () async {
            final item = await pickMedia(context, kind: 'visual');
            if (item == null) return;
            final video = '${item['mime_type']}'.startsWith('video/');
            await _create({'kind': kind, 'asset': item['id'], 'title': '${item['title'] ?? 'Untitled'}', 'preset': kind == 'video' ? 'tiktok' : 'square', 'fill': {'asset_kind': video ? 'video' : 'image', 'duration': item['duration_seconds']}});
          },
          icon: Icon(kind == 'video' ? Icons.movie_creation_outlined : Icons.add_photo_alternate_outlined),
          label: Text(kind == 'video' ? 'New video from media' : 'Edit a photo'),
        ),
        OutlinedButton.icon(onPressed: () => _create({'kind': kind, 'title': kind == 'video' ? 'New video' : 'New image'}), icon: const Icon(Icons.fit_screen_outlined), label: const Text('Blank canvas')),
      ]),
      const SizedBox(height: 16),
      if (projects.isNotEmpty) const Text('RECENT', style: TextStyle(letterSpacing: 2, color: Colors.white60)),
      for (final p in projects.take(8)) _projectTile(p),
    ]);
  }

  Widget _projectTile(Map<String, dynamic> p) {
    final render = p['render'] as Map?;
    final stage = '${render?['stage'] ?? ''}';
    return Semantics(
      button: true,
      label: '${p['kind'] == 'video' ? 'Video' : 'Image'} project ${p['title']}${stage.isEmpty ? '' : ', render $stage'}',
      child: ListTile(
        onTap: () => _open(p),
        leading: Icon(p['kind'] == 'video' ? Icons.movie_outlined : Icons.image_outlined, color: _accent),
        title: Text('${p['title']}', maxLines: 2),
        subtitle: Text([if (p['duration'] != null) '${(p['duration'] as num).toStringAsFixed(1)} s', if (stage.isNotEmpty) 'Render: $stage', '${p['preset'] ?? ''}'].join(' · ')),
        trailing: const Icon(Icons.chevron_right_rounded),
      ),
    );
  }

  Widget _projectsTab() {
    final projects = _list('projects');
    if (projects.isEmpty) return const Center(child: Padding(padding: EdgeInsets.all(24), child: Text('No image or video projects yet.', textAlign: TextAlign.center)));
    return RefreshIndicator(onRefresh: _load, child: ListView(children: [for (final p in projects) _projectTile(p)]));
  }

  Widget _templatesTab() {
    final templates = _list('templates');
    final byCat = <String, List<Map<String, dynamic>>>{};
    for (final t in templates) {
      byCat.putIfAbsent('${t['category']}', () => []).add(t);
    }
    return ListView(padding: const EdgeInsets.all(12), children: [
      for (final e in byCat.entries) ...[
        Padding(padding: const EdgeInsets.fromLTRB(4, 12, 4, 6), child: Text(e.key.toUpperCase(), style: const TextStyle(letterSpacing: 2, color: Colors.white60))),
        SizedBox(
          height: 190,
          child: ListView(scrollDirection: Axis.horizontal, children: [for (final t in e.value) _templateCard(t)]),
        ),
      ],
    ]);
  }

  Widget _templateCard(Map<String, dynamic> t) => Semantics(
        button: true,
        label: 'Template ${t['name']}, ${t['category']}${t['system'] == true ? '' : ', yours'}',
        child: GestureDetector(
          onTap: () => _previewTemplate(t),
          child: Container(
            width: 130,
            margin: const EdgeInsets.only(right: 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(child: Center(child: ExcludeSemantics(child: CheTemplatePreview(doc: Map<String, dynamic>.from(t['doc'] as Map), cache: _cache)))),
              const SizedBox(height: 6),
              ExcludeSemantics(child: Text('${t['name']}', maxLines: 2, style: const TextStyle(fontWeight: FontWeight.w600))),
            ]),
          ),
        ),
      );

  Future<void> _previewTemplate(Map<String, dynamic> t) async {
    final use = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (c) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text('${t['name']}', style: Theme.of(c).textTheme.titleLarge),
            if ('${t['description'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${t['description']}')),
            const SizedBox(height: 12),
            ConstrainedBox(constraints: const BoxConstraints(maxHeight: 360), child: CheTemplatePreview(doc: Map<String, dynamic>.from(t['doc'] as Map), cache: _cache)),
            const SizedBox(height: 12),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Use Template')),
          ]),
        ),
      ),
    );
    if (use == true) await _create({'template_id': t['id'], 'title': '${t['name']}', 'kind': t['kind']});
  }
}

/// A template drawn from its own document: canvas size, background, text in its styles, and placeholder frames.
class CheTemplatePreview extends StatelessWidget {
  const CheTemplatePreview({super.key, required this.doc, required this.cache});
  final Map<String, dynamic> doc;
  final CheImageCache cache;

  @override
  Widget build(BuildContext context) {
    final asImage = doc['kind'] == 'video'
        ? {
            ...doc,
            'transform': const {'crop': {'x': 0, 'y': 0, 'w': 1, 'h': 1}},
            'canvas': {...Map<String, dynamic>.from(doc['canvas'] as Map), 'background': '#14232E'},
            'layers': [for (final t in (doc['text'] as List? ?? const [])) (t as Map)['layer']],
          }
        : {...doc, 'canvas': {...Map<String, dynamic>.from(doc['canvas'] as Map), 'background': '#14232E'}};
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Stack(children: [
        CheImageCanvas(doc: Map<String, dynamic>.from(asImage), cache: cache),
        if (doc['kind'] == 'video') const Positioned(right: 6, top: 6, child: Icon(Icons.play_circle_outline_rounded, color: Colors.white70, size: 20)),
      ]),
    );
  }
}
