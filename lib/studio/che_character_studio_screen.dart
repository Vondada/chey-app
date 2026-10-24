import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../agents/che_agent_runtime.dart';
import '../rooms/che_characters_room.dart';
import 'che_character_studio.dart';

/// Character Studio: per-agent Animation & Personality controls with presets, a live 3D preview, saved versions
/// and rollback. Every control carries a VoiceOver label and speaks its new value; Read Aloud speaks the current
/// settings. Presentation only: changing a look or a motion style never grants an agent anything.
class CheCharacterStudioScreen extends StatefulWidget {
  const CheCharacterStudioScreen({super.key, required this.store, required this.onSpeak, required this.onListen, this.runtime, this.initialAgent = 'che'});

  final CheCharacterStudioStore store;
  final void Function(String text) onSpeak;
  final VoidCallback onListen;
  final CheAgentRuntimeController? runtime;
  final String initialAgent;

  @override
  State<CheCharacterStudioScreen> createState() => _CheCharacterStudioScreenState();
}

class _CheCharacterStudioScreenState extends State<CheCharacterStudioScreen> {
  late String _agent = widget.initialAgent;
  late CheAnimationSettings _draft;
  final GlobalKey<State<CheCharactersRoom>> _previewKey = GlobalKey<State<CheCharactersRoom>>();
  String _banner = '';
  Timer? _previewDebounce;

  @override
  void initState() {
    super.initState();
    _draft = widget.store.current(_agent);
    widget.store.addListener(_onStore);
    if (!widget.store.loaded) unawaited(widget.store.load().then((_) { if (mounted) setState(() => _draft = widget.store.current(_agent)); }));
  }

  @override
  void dispose() {
    widget.store.removeListener(_onStore);
    _previewDebounce?.cancel();
    super.dispose();
  }

  void _onStore() { if (mounted) setState(() {}); }

  void _set(CheAnimationSettings next, String spoken) {
    setState(() { _draft = next; _banner = spoken; });
    HapticFeedback.selectionClick();
    unawaited(SemanticsService.sendAnnouncement(View.of(context), spoken, TextDirection.ltr));
    _previewDebounce?.cancel();
    _previewDebounce = Timer(const Duration(milliseconds: 150), _pushPreview);
  }

  void _pushPreview() {
    final state = _previewKey.currentState;
    if (state is CheCharactersRoomPreviewHost) unawaited((state as CheCharactersRoomPreviewHost).sendAnimationSettings(_draft.toJson(), preset: _draft.preset == 'custom' ? null : _draft.preset));
  }

  Future<void> _save() async {
    final v = await widget.store.save(_agent, _draft, source: 'studio');
    final spoken = 'Saved version ${v.version} for ${_label(_agent)}. ${_draft.describe()}';
    setState(() => _banner = spoken);
    widget.onSpeak(spoken);
  }

  Future<void> _rollback(CheStudioVersion v) async {
    final restored = await widget.store.rollback(_agent, v.version);
    if (restored == null) return;
    setState(() { _draft = restored.settings; _banner = 'Restored version ${v.version} as version ${restored.version}.'; });
    widget.onSpeak(_banner);
    _pushPreview();
  }

  String _label(String id) => id == 'che' ? 'CHE' : id[0].toUpperCase() + id.substring(1);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final history = widget.store.history(_agent);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Character Studio'),
        actions: [
          IconButton(
            tooltip: 'Read Aloud',
            icon: const Icon(Icons.record_voice_over_rounded),
            onPressed: () => widget.onSpeak('Character Studio for ${_label(_agent)}. ${_draft.describe()} ${history.isEmpty ? 'No saved versions yet.' : '${history.length} saved versions; the newest is ${history.last.version}.'}'),
          ),
          IconButton(tooltip: 'Talk to CHE', icon: const Icon(Icons.mic_rounded), onPressed: widget.onListen),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          if (_banner.isNotEmpty)
            Semantics(liveRegion: true, child: Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_banner, style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)))),
          SizedBox(
            height: 300,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Semantics(
                label: 'Live preview of ${_label(_agent)} with the current animation settings',
                child: CheCharactersRoom(key: _previewKey, runtime: widget.runtime, embedded: true, focusAgent: _agent),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text('Agent', style: theme.textTheme.titleMedium),
          Wrap(
            spacing: 8,
            children: [
              for (final id in cheStudioAgents)
                ChoiceChip(
                  label: Text(_label(id)),
                  selected: _agent == id,
                  onSelected: (_) => setState(() { _agent = id; _draft = widget.store.current(id); _banner = '${_label(id)} selected. ${_draft.describe()}'; _pushPreview(); }),
                ),
            ],
          ),
          const SizedBox(height: 16),
          Text('Animation & Personality', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text('Presentation only. These change how ${_label(_agent)} moves and looks, never what ${_agent == 'che' ? 'she' : 'they'} may do.', style: theme.textTheme.bodySmall),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              for (final p in CheAnimationSettings.presets.keys)
                Semantics(
                  button: true,
                  label: 'Preset ${p[0].toUpperCase()}${p.substring(1)}',
                  selected: _draft.preset == p,
                  child: ChoiceChip(label: Text(p[0].toUpperCase() + p.substring(1)), selected: _draft.preset == p, onSelected: (_) => _set(CheAnimationSettings.presets[p]!, 'Preset $p. ${CheAnimationSettings.presets[p]!.describe()}')),
                ),
            ],
          ),
          _slider('Fluidity', _draft.fluidity, (v) => _set(_draft.copyWith(fluidity: v), 'Fluidity ${(v * 100).round()} percent')),
          _slider('Gesture intensity', _draft.gesture, (v) => _set(_draft.copyWith(gesture: v), 'Gesture intensity ${(v * 100).round()} percent')),
          _slider('Facial expressiveness', _draft.expressiveness, (v) => _set(_draft.copyWith(expressiveness: v), 'Facial expressiveness ${(v * 100).round()} percent')),
          _slider('Idle variety', _draft.idleVariety, (v) => _set(_draft.copyWith(idleVariety: v), 'Idle variety ${(v * 100).round()} percent')),
          _slider('Eye contact', _draft.eyeContact, (v) => _set(_draft.copyWith(eyeContact: v), 'Eye contact ${(v * 100).round()} percent')),
          _slider('Hair and cloth motion', _draft.hairCloth, (v) => _set(_draft.copyWith(hairCloth: v), 'Hair and cloth motion ${(v * 100).round()} percent')),
          _slider('Animation speed', (_draft.speed - 0.5) / 1.0, (v) => _set(_draft.copyWith(speed: 0.5 + v), 'Animation speed ${((0.5 + v) * 100).round()} percent'), valueLabel: '${(_draft.speed * 100).round()}%'),
          const SizedBox(height: 8),
          Text('Walking style', style: theme.textTheme.titleSmall),
          Wrap(
            spacing: 8,
            children: [
              for (final w in CheAnimationSettings.walks)
                ChoiceChip(label: Text(w[0].toUpperCase() + w.substring(1)), selected: _draft.walk == w, onSelected: (_) => _set(_draft.copyWith(walk: w), '$w walk')),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              FilledButton.icon(onPressed: _save, icon: const Icon(Icons.save_rounded), label: Text('Save as version ${history.isEmpty ? 1 : history.last.version + 1}')),
              const SizedBox(width: 12),
              OutlinedButton(onPressed: () => _set(widget.store.current(_agent), 'Draft reset to the saved settings'), child: const Text('Reset')),
            ],
          ),
          const SizedBox(height: 20),
          Text('Saved versions', style: theme.textTheme.titleMedium),
          if (history.isEmpty) Text('No saved versions yet for ${_label(_agent)}. The natural preset is in use.', style: theme.textTheme.bodySmall),
          for (final v in history.reversed.take(12))
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text('Version ${v.version} · ${v.source}${v.note.isEmpty ? '' : ' · ${v.note}'}'),
              subtitle: Text('${v.at.toLocal().toString().substring(0, 16)} · ${v.settings.preset} preset'),
              trailing: v == history.last
                  ? const Text('current')
                  : TextButton(onPressed: () => _rollback(v), child: const Text('Roll back')),
              onTap: () => widget.onSpeak('Version ${v.version}, from ${v.source}. ${v.settings.describe()}'),
            ),
        ],
      ),
    );
  }

  Widget _slider(String label, double value, ValueChanged<double> onChanged, {String? valueLabel}) {
    final pct = valueLabel ?? '${(value * 100).round()}%';
    return Semantics(
      slider: true,
      label: label,
      value: pct,
      child: Row(
        children: [
          SizedBox(width: 150, child: Text(label)),
          Expanded(child: Slider(value: value.clamp(0.0, 1.0), onChanged: onChanged, divisions: 20, label: pct, semanticFormatterCallback: (v) => '$label ${(v * 100).round()} percent')),
          SizedBox(width: 44, child: Text(pct, textAlign: TextAlign.end)),
        ],
      ),
    );
  }
}
