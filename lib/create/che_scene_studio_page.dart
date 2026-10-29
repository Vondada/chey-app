// CHE Create Studio, scene editor (M2c, owner 2026-10-28). Opens a saved scene, or makes one from a template, lets the
// owner edit a selected object's declared properties with sliders, undo and redo, and save. Saves go to the Worker with
// the version the page loaded at, so a conflict is shown, never overwritten. Closing and reopening the same scene loads
// what was saved. Every control has a label for VoiceOver.

import 'package:flutter/material.dart';

import 'che_scene_client.dart';
import 'che_scene_document.dart';

/// Editable numeric properties shown as sliders, per kind: name, label, min, max.
const sliderSpecs = <String, List<(String, String)>>{
  'character': [
    ('height_m', 'Height (m)'),
    ('skin_tone', 'Skin tone'),
    ('pore_detail', 'Skin pores'),
    ('hair_length', 'Hair length'),
  ],
  'object': [
    ('roughness', 'Roughness'),
    ('metallic', 'Metallic'),
  ],
};

class CheSceneStudioPage extends StatefulWidget {
  const CheSceneStudioPage({super.key, required this.client, this.sceneId, this.template = 'person', this.name = 'My character'});

  /// The scene to open. When null, a new scene is made from [template] first.
  final String? sceneId;
  final String template;
  final String name;
  final CheSceneClient client;

  @override
  State<CheSceneStudioPage> createState() => _CheSceneStudioPageState();
}

class _CheSceneStudioPageState extends State<CheSceneStudioPage> {
  SceneHistory? _history;
  int _version = 0;
  String? _sceneId;
  String? _selectedId;
  String _status = 'Loading…';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _open();
  }

  Future<void> _open() async {
    setState(() => _busy = true);
    try {
      final LoadedScene loaded;
      if (widget.sceneId == null) {
        loaded = await widget.client.create(name: widget.name, template: widget.template);
      } else {
        loaded = await widget.client.load(widget.sceneId!);
      }
      setState(() {
        _sceneId = loaded.scene.id;
        _version = loaded.version;
        _history = SceneHistory.start(loaded.scene);
        _selectedId = loaded.scene.objects.isEmpty ? null : loaded.scene.objects.first.id;
        _status = 'Saved version $_version';
      });
    } catch (e) {
      setState(() => _status = 'Could not open the scene. $e');
    } finally {
      setState(() => _busy = false);
    }
  }

  SceneObject? get _selected {
    final h = _history;
    if (h == null || _selectedId == null) return null;
    for (final o in h.present.objects) {
      if (o.id == _selectedId) return o;
    }
    return null;
  }

  void _edit(String name, double value) {
    final h = _history;
    final o = _selected;
    if (h == null || o == null) return;
    try {
      setState(() {
        _history = h.setProperty(o.id, name, value);
        _status = 'Changed, not saved yet';
      });
    } on SceneException catch (e) {
      setState(() => _status = e.message);
    }
  }

  void _undo() => setState(() {
        _history = _history?.undo();
        _status = 'Undone, not saved yet';
      });

  void _redo() => setState(() {
        _history = _history?.redo();
        _status = 'Redone, not saved yet';
      });

  Future<void> _save() async {
    final h = _history;
    final id = _sceneId;
    if (h == null || id == null) return;
    setState(() => _busy = true);
    try {
      final saved = await widget.client.save(id, h.present, _version);
      setState(() {
        _version = saved.version;
        _status = 'Saved version $_version';
      });
    } on SceneConflict catch (c) {
      setState(() => _status = 'This scene was changed somewhere else (version ${c.storedVersion}). Reopen it to see that copy.');
    } on SceneRequestFailed catch (f) {
      setState(() => _status = 'Not saved. ${f.detail}');
    } catch (e) {
      setState(() => _status = 'Not saved. Check the connection and try again.');
    } finally {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final h = _history;
    final selected = _selected;
    final specs = selected == null ? const <(String, String)>[] : (sliderSpecs[selected.kind] ?? const []);
    return Scaffold(
      appBar: AppBar(
        title: Semantics(header: true, child: Text(h?.present.name ?? 'Create Studio')),
        actions: [
          IconButton(
            tooltip: 'Undo',
            icon: const Icon(Icons.undo),
            onPressed: h != null && h.canUndo && !_busy ? _undo : null,
          ),
          IconButton(
            tooltip: 'Redo',
            icon: Transform.flip(flipX: true, child: const Icon(Icons.undo_rounded)),
            onPressed: h != null && h.canRedo && !_busy ? _redo : null,
          ),
          IconButton(
            tooltip: 'Save',
            icon: const Icon(Icons.save_rounded),
            onPressed: h != null && !_busy ? _save : null,
          ),
        ],
      ),
      body: SafeArea(
        child: h == null
            ? Center(child: Semantics(liveRegion: true, child: Text(_status)))
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Semantics(liveRegion: true, child: Text(_status, style: Theme.of(context).textTheme.bodySmall)),
                  const SizedBox(height: 12),
                  Text('Objects', style: Theme.of(context).textTheme.titleMedium),
                  for (final o in h.present.objects)
                    Semantics(
                      button: true,
                      selected: o.id == _selectedId,
                      label: '${o.name}, ${o.kind}',
                      child: ListTile(
                        title: Text(o.name),
                        subtitle: Text(o.kind),
                        selected: o.id == _selectedId,
                        onTap: () => setState(() => _selectedId = o.id),
                      ),
                    ),
                  if (selected != null) ...[
                    const Divider(height: 32),
                    Text(selected.name, style: Theme.of(context).textTheme.titleMedium),
                    for (final (name, label) in specs) _slider(selected, name, label),
                  ],
                ],
              ),
      ),
    );
  }

  Widget _slider(SceneObject o, String name, String label) {
    final current = (o.props[name] as num?)?.toDouble();
    final range = properties[o.kind]?[name] as List?;
    if (current == null || range == null) return const SizedBox.shrink();
    final min = (range[0] as num).toDouble();
    final max = (range[1] as num).toDouble();
    return Semantics(
      slider: true,
      label: label,
      value: current.toStringAsFixed(2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('$label: ${current.toStringAsFixed(2)}'),
          Slider(
            min: min,
            max: max,
            value: current.clamp(min, max),
            onChanged: _busy ? null : (v) => _edit(name, v),
          ),
        ],
      ),
    );
  }
}

/// The list of saved scenes, for reopening the same project.
class CheSceneListPage extends StatefulWidget {
  const CheSceneListPage({super.key, required this.client});
  final CheSceneClient client;

  @override
  State<CheSceneListPage> createState() => _CheSceneListPageState();
}

class _CheSceneListPageState extends State<CheSceneListPage> {
  late Future<List<SceneSummary>> _scenes = widget.client.list();

  Future<void> _newCharacter() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => CheSceneStudioPage(client: widget.client, template: 'person')),
    );
    if (mounted) {
      setState(() {
        _scenes = widget.client.list();
      });
    }
  }

  Future<void> _openScene(String id) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => CheSceneStudioPage(client: widget.client, sceneId: id)),
    );
    if (mounted) {
      setState(() {
        _scenes = widget.client.list();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Create Studio projects')),
      floatingActionButton: Semantics(
        button: true,
        label: 'New character',
        child: FloatingActionButton.extended(
          onPressed: _newCharacter,
          icon: const Icon(Icons.person_add_alt_1_rounded),
          label: const Text('New character'),
        ),
      ),
      body: FutureBuilder<List<SceneSummary>>(
        future: _scenes,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
          if (snap.hasError) return Center(child: Text('Could not load projects. ${snap.error}'));
          final list = snap.data ?? const [];
          if (list.isEmpty) return const Center(child: Text('No projects yet.'));
          return ListView(
            children: [
              for (final s in list)
                Semantics(
                  button: true,
                  label: '${s.name}, ${s.objects} objects, version ${s.version}',
                  child: ListTile(
                    title: Text(s.name),
                    subtitle: Text('${s.objects} objects · version ${s.version}'),
                    onTap: () => _openScene(s.id),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}
