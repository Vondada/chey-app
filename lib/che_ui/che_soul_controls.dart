import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_soul.dart';
import 'che_theme.dart';

/// The owner's personality controls: six traits, the notes, Save, and the version history with Restore.
/// Every control has a spoken label; a failed call shows its reason as text and changes nothing.
class CheSoulControls extends StatefulWidget {
  const CheSoulControls({super.key});

  @override
  State<CheSoulControls> createState() => _CheSoulControlsState();
}

class _CheSoulControlsState extends State<CheSoulControls> {
  final _notes = TextEditingController();
  CheSoulProfile? _profile;
  Map<String, int> _traits = cheSoulDefaultTraits();
  bool _loading = true;
  bool _busy = false;
  String? _error;
  String? _notice;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  void _apply(CheSoulProfile profile) {
    setState(() {
      _profile = profile;
      _traits = Map.of(profile.traits);
      _notes.text = profile.text;
    });
  }

  String _message(Object error) => error is CheSoulException ? error.message : 'The Soul could not be reached. Nothing was changed.';

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      _apply(await CheSoulClient.load());
    } catch (error) {
      if (mounted) setState(() => _error = _message(error));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final saved = await CheSoulClient.save(traits: _traits, text: _notes.text);
      _apply(saved);
      HapticFeedback.mediumImpact();
      if (mounted) setState(() => _notice = 'Saved as Soul version ${saved.version}. The next reply uses it.');
    } catch (error) {
      if (mounted) setState(() => _error = _message(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _restore(CheSoulVersion version) async {
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final restored = await CheSoulClient.restore(version.version);
      _apply(restored);
      HapticFeedback.mediumImpact();
      if (mounted) setState(() => _notice = 'Version ${version.version} is back as version ${restored.version}. Nothing was deleted.');
    } catch (error) {
      if (mounted) setState(() => _error = _message(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _useBuiltIn() {
    setState(() {
      _traits = cheSoulDefaultTraits();
      _notice = 'Built-in traits are set. Press Save Soul to keep them.';
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _profile == null) {
      return Center(child: Text('Loading CHE\'s Soul…', style: CheType.bodyDim));
    }
    final profile = _profile;
    return ListView(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.lg),
      children: [
        if (_error != null)
          Semantics(
            liveRegion: true,
            label: 'Error: $_error',
            child: Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(_error!, style: CheType.body.copyWith(color: CheColors.amber)),
            ),
          ),
        if (_notice != null)
          Semantics(
            liveRegion: true,
            label: _notice,
            child: Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(_notice!, style: CheType.bodyDim),
            ),
          ),
        if (profile != null)
          Text(
            profile.isDefault ? 'Built-in Soul (version ${profile.version})' : 'Soul version ${profile.version} · ${profile.hash}',
            style: CheType.caption,
          ),
        const SizedBox(height: 12),
        for (final trait in kCheSoulTraits) _traitRow(trait),
        const SizedBox(height: 8),
        Text('Notes for CHE\'s manner', style: CheType.label),
        const SizedBox(height: 6),
        Semantics(
          label: 'Notes for CHE\'s manner. Manner only; they never override evidence, permissions or numbers.',
          textField: true,
          child: TextField(
            controller: _notes,
            maxLength: 1500,
            minLines: 3,
            maxLines: 6,
            style: CheType.body,
            decoration: const InputDecoration(
              hintText: 'For example: call me by my first name when it fits.',
              border: OutlineInputBorder(),
            ),
          ),
        ),
        const SizedBox(height: 12),
        Wrap(spacing: 12, runSpacing: 8, children: [
          FilledButton(
            onPressed: _busy ? null : _save,
            child: Text(_busy ? 'Saving…' : 'Save Soul'),
          ),
          TextButton(
            onPressed: _busy ? null : _useBuiltIn,
            child: Text('Use built-in traits', style: CheType.label),
          ),
        ]),
        const SizedBox(height: 24),
        Text('Version history', style: CheType.label),
        const SizedBox(height: 6),
        if (profile == null || profile.history.isEmpty)
          Text('No earlier versions yet. Each save keeps the one before it here.', style: CheType.bodyDim)
        else
          for (final version in profile.history)
            Semantics(
              button: true,
              label: 'Restore Soul version ${version.version}, saved ${version.savedAt.isEmpty ? 'at an unknown time' : version.savedAt.substring(0, version.savedAt.length.clamp(0, 10))}',
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('Version ${version.version}', style: CheType.body),
                subtitle: Text(
                  '${version.savedAt.isEmpty ? 'built-in' : version.savedAt.substring(0, version.savedAt.length.clamp(0, 10))} · ${version.reason}',
                  style: CheType.caption,
                ),
                trailing: TextButton(
                  onPressed: _busy ? null : () => _restore(version),
                  child: Text('Restore', style: CheType.label),
                ),
              ),
            ),
      ],
    );
  }

  Widget _traitRow(CheSoulTrait trait) {
    final value = _traits[trait.key] ?? trait.defaultValue;
    return Semantics(
      label: '${trait.label}, $value of 10. ${trait.hint}',
      value: '$value of 10',
      slider: true,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(trait.label, style: CheType.body)),
            Text('$value of 10', style: CheType.caption),
          ]),
          Text(trait.hint, style: CheType.caption),
          Slider(
            min: 0,
            max: 10,
            divisions: 10,
            value: value.toDouble(),
            label: '$value',
            onChanged: _busy ? null : (next) => setState(() => _traits[trait.key] = next.round()),
          ),
        ]),
      ),
    );
  }
}
