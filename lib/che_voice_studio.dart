// Voice Studio in Chat: the owner's ElevenLabs and Fish Audio voices, read live from the
// connected accounts through the Worker. Search, favourites, the provider's free samples,
// the speech models with their own explanations, and the controls each model allows.
// Nothing here keeps a key or a provider voice ID: the Worker stores the owner's choice.
// Collapsed, the section builds nothing, so nothing loads or speaks until it is opened.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'che_native_voice.dart';
import 'che_ui/che_theme.dart';

const _studioFallbackBase = 'https://chey-app.henryjavoni.workers.dev';

Future<({String base, String token})> _studioConnection() async {
  final prefs = await SharedPreferences.getInstance();
  final base = (prefs.getString('che_agent_base_url') ??
      const String.fromEnvironment('CHE_AGENT_URL', defaultValue: _studioFallbackBase)).replaceAll(RegExp(r'/+$'), '');
  return (base: base, token: prefs.getString('che_agent_device_token') ?? '');
}

List<Map<String, dynamic>> _maps(Object? value) => value is List
    ? value.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList()
    : <Map<String, dynamic>>[];

double _unit(Object? value, double fallback) => value is num ? value.toDouble().clamp(0.0, 1.0).toDouble() : fallback;

/// Plays the free sample the owner asked for in Chat ("preview number three").
class CheVoiceStudioPreview {
  CheVoiceStudioPreview._();

  static Future<bool> play({required String voiceId, http.Client? client}) async {
    final own = client == null;
    final c = client ?? http.Client();
    try {
      final conn = await _studioConnection();
      if (conn.token.isEmpty) return false;
      final r = await c.get(
        Uri.parse('${conn.base}/api/voice/library/preview?voice_id=${Uri.encodeQueryComponent(voiceId)}'),
        headers: {'authorization': 'Bearer ${conn.token}'},
      ).timeout(const Duration(seconds: 30));
      if (r.statusCode != 200 || !(r.headers['content-type'] ?? '').contains('audio')) return false;
      await CheNativeVoice.stopAudio();
      return await CheNativeVoice.playAudioBounded(r.bodyBytes);
    } on Object {
      return false;
    } finally {
      if (own) c.close();
    }
  }
}

/// The expandable Voice Studio row at the top of Chat.
class CheVoiceStudioSection extends StatelessWidget {
  const CheVoiceStudioSection({super.key, this.onSpeak});

  /// Speaks an action's real result. Only owner actions call it; opening the panel is silent.
  final ValueChanged<String>? onSpeak;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          leading: const Icon(Icons.record_voice_over_rounded, color: CheColors.accent),
          title: const Text('Voice Studio', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          subtitle: const Text('Choose and preview CHE’s voice without leaving Chat',
              style: TextStyle(fontSize: 14, color: CheColors.textDim)),
          childrenPadding: const EdgeInsets.fromLTRB(4, 0, 4, 12),
          children: [
            SizedBox(height: 480, child: CheVoiceStudioPanel(onSpeak: onSpeak)),
          ],
        ),
      ),
    );
  }
}

class CheVoiceStudioPanel extends StatefulWidget {
  const CheVoiceStudioPanel({super.key, this.client, this.onSpeak});
  final http.Client? client;
  final ValueChanged<String>? onSpeak;

  @override
  State<CheVoiceStudioPanel> createState() => _CheVoiceStudioPanelState();
}

class _CheVoiceStudioPanelState extends State<CheVoiceStudioPanel> {
  late final http.Client _client = widget.client ?? http.Client();
  bool _loading = false;
  bool _busy = false;
  String _error = '';
  String _status = '';
  String _base = '';
  String _token = '';
  String _elevenState = 'Unavailable';
  String _elevenReason = '';
  String _fishState = 'Unavailable';
  String _fishReason = '';
  List<Map<String, dynamic>> _voices = [];
  List<Map<String, dynamic>> _models = [];
  List<Map<String, dynamic>> _fishModels = [];
  Set<String> _favorites = {};
  String _query = '';
  String _source = 'all';
  bool _favoritesOnly = false;
  String _provider = 'elevenlabs';
  String _id = '';
  String _name = '';
  String _modelId = '';
  double _speed = 1.0;
  double _stability = 0.6;
  double _similarity = 0.82;
  double _style = 0.15;
  bool _speakerBoost = true;

  @override
  void initState() {
    super.initState();
    // Built only when the owner opens the section, so this load is owner-started and silent.
    unawaited(_load());
  }

  @override
  void dispose() {
    if (widget.client == null) _client.close();
    super.dispose();
  }

  Map<String, String> get _auth => {'authorization': 'Bearer $_token'};
  Map<String, String> get _json => {..._auth, 'content-type': 'application/json'};

  void _say(String line) {
    if (!mounted) return;
    setState(() => _status = line);
    widget.onSpeak?.call(line);
  }

  void _applySettings(Map<String, dynamic> selected) {
    final chosenModel = (selected['model_id'] ?? '').toString();
    _modelId = chosenModel.isNotEmpty ? chosenModel : _defaultModelId();
    final settings = selected['settings'] is Map ? Map<String, dynamic>.from(selected['settings'] as Map) : <String, dynamic>{};
    _stability = _unit(settings['stability'], 0.6);
    _similarity = _unit(settings['similarity_boost'], 0.82);
    _style = _unit(settings['style'], 0.15);
    _speakerBoost = settings['use_speaker_boost'] is bool ? settings['use_speaker_boost'] as bool : true;
  }

  String _defaultModelId() {
    for (final m in _models) {
      if (m['id'] == 'eleven_flash_v2_5') return 'eleven_flash_v2_5';
    }
    return _models.isEmpty ? '' : (_models.first['id'] ?? '').toString();
  }

  Map<String, dynamic> get _model => _models.firstWhere((m) => m['id'] == _modelId, orElse: () => <String, dynamic>{});

  Map<String, dynamic> get _controls {
    final raw = _model['controls'];
    return raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
  }

  List<Map<String, dynamic>> get _visible {
    final words = _query.trim().toLowerCase();
    return _voices.where((v) {
      if (_source != 'all' && v['source'] != _source) return false;
      if (_favoritesOnly && !_favorites.contains(v['id'])) return false;
      if (words.isEmpty) return true;
      final labels = v['labels'] is Map ? (v['labels'] as Map).values.join(' ') : '';
      return '${v['name']} ${v['category']} $labels'.toLowerCase().contains(words);
    }).toList();
  }

  Map<String, dynamic> get _choice {
    final eleven = _provider == 'elevenlabs';
    return {
      'provider': _provider,
      'id': _id,
      'speed': _speed,
      if (eleven && _modelId.isNotEmpty) 'model_id': _modelId,
      if (eleven && _modelId.isNotEmpty)
        'settings': {
          'stability': _stability,
          'similarity_boost': _similarity,
          if (_controls['style'] == true) 'style': _style,
          if (_controls['use_speaker_boost'] == true) 'use_speaker_boost': _speakerBoost,
        },
    };
  }

  Future<void> _load({bool announce = false}) async {
    setState(() { _loading = true; _error = ''; });
    try {
      final conn = await _studioConnection();
      _base = conn.base;
      _token = conn.token;
      if (_token.isEmpty) throw StateError('Pair this iPhone with CHE before using Voice Studio.');
      final r = await _client.get(Uri.parse('$_base/api/voice/library'), headers: _auth).timeout(const Duration(seconds: 30));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map) {
        throw StateError(j is Map ? (j['detail'] ?? 'CHE did not return your voices.').toString() : 'CHE did not return your voices.');
      }
      if (!mounted) return;
      final voices = _maps(j['voices']);
      final fish = j['fish'] is Map ? Map<String, dynamic>.from(j['fish'] as Map) : <String, dynamic>{};
      final models = j['models'] is Map ? Map<String, dynamic>.from(j['models'] as Map) : <String, dynamic>{};
      final selected = j['selected'] is Map ? Map<String, dynamic>.from(j['selected'] as Map) : <String, dynamic>{};
      setState(() {
        _voices = voices;
        _models = _maps(models['elevenlabs']);
        _fishModels = _maps(fish['models']);
        _favorites = {for (final f in (j['favorites'] is List ? j['favorites'] as List : const [])) f.toString()};
        _elevenState = (j['state'] ?? 'Unavailable').toString();
        _elevenReason = (j['reason'] ?? '').toString();
        _fishState = (fish['state'] ?? 'Unavailable').toString();
        _fishReason = (fish['reason'] ?? '').toString();
        _provider = (selected['provider'] ?? 'elevenlabs').toString();
        _id = (selected['id'] ?? '').toString();
        _name = (selected['name'] ?? '').toString();
        _speed = ((selected['speed'] is num ? selected['speed'] as num : 1).toDouble()).clamp(0.7, 1.2).toDouble();
        _applySettings(selected);
      });
      if (announce) {
        HapticFeedback.selectionClick();
        _say('Voice library refreshed: ${voices.length} voices. ElevenLabs: $_elevenState.');
      }
    } on Object catch (e) {
      if (mounted) setState(() => _error = e.toString().replaceFirst('Bad state: ', ''));
      if (announce) {
        HapticFeedback.heavyImpact();
        _say('Voice library not refreshed: ${e.toString().replaceFirst('Bad state: ', '')}');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _toggleFavorite(Map<String, dynamic> v) async {
    final id = v['id'].toString();
    final on = !_favorites.contains(id);
    try {
      final r = await _client.post(Uri.parse('$_base/api/voice/favorite'), headers: _json,
          body: jsonEncode({'voice_id': id, 'on': on})).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map) throw StateError('the favourite was not saved');
      if (!mounted) return;
      setState(() => _favorites = {for (final f in (j['favorites'] as List)) f.toString()});
      _say(on ? '${v['name']} is a favourite.' : '${v['name']} is no longer a favourite.');
    } on Object catch (e) {
      _say('Favourite not saved: ${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  // Reads the response as audio, or the owner's reason in plain words.
  Future<void> _playBytes(http.Response r, String label) async {
    if (r.statusCode != 200 || !(r.headers['content-type'] ?? '').contains('audio')) {
      var reason = 'This voice did not return playable audio.';
      try {
        final j = jsonDecode(utf8.decode(r.bodyBytes));
        if (j is Map) reason = (j['detail'] ?? reason).toString();
      } catch (_) {}
      throw StateError(reason);
    }
    await CheNativeVoice.stopAudio();
    final played = await CheNativeVoice.playAudioBounded(r.bodyBytes);
    if (!played) throw StateError('CHE received audio but your iPhone could not play it.');
    HapticFeedback.selectionClick();
    _say('Playing the $label.');
  }

  // A free sample from the provider's own preview. No credits are used.
  Future<void> _playFreeSample(Map<String, dynamic> v) async {
    final sample = v['preview'] is String ? v['preview'] as String : '';
    if (_busy) return;
    if (sample.isEmpty) {
      _say('${v['name']} has no free sample from ElevenLabs. Nothing was played and no credits were used.');
      return;
    }
    setState(() { _busy = true; _status = 'Loading the free sample…'; });
    try {
      final r = await _client.get(
        Uri.parse('$_base/api/voice/library/preview?voice_id=${Uri.encodeQueryComponent(v['id'].toString())}'),
        headers: _auth,
      ).timeout(const Duration(seconds: 30));
      await _playBytes(r, 'free sample of ${v['name']}');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('Sample failed: ${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // A generated sample spends the provider's credits, so the owner confirms it first.
  Future<void> _generatePaidSample() async {
    if (_busy || _id.isEmpty) return;
    final allowed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Generate a paid sample?'),
        content: const Text('A generated sample uses credits from your voice provider. Continue?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Generate')),
        ],
      ),
    );
    if (allowed != true || !mounted) return;
    setState(() { _busy = true; _status = 'Generating a sample…'; });
    try {
      final r = await _client.post(Uri.parse('$_base/api/voice/preview'), headers: _json,
          body: jsonEncode({..._choice, 'confirm_credits': true})).timeout(const Duration(seconds: 55));
      await _playBytes(r, 'generated sample');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('Sample failed: ${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // Choosing a voice saves it: the Worker checks the account first and keeps the choice.
  Future<void> _saveChoice() async {
    if (_busy || _id.isEmpty) return;
    final label = _name.isEmpty ? 'This voice' : _name;
    setState(() { _busy = true; _status = ''; });
    try {
      final r = await _client.post(Uri.parse('$_base/api/voice/choice'), headers: _json,
          body: jsonEncode(_choice)).timeout(const Duration(seconds: 25));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map || j['ok'] != true) {
        throw StateError(j is Map ? (j['detail'] ?? 'the voice was not saved').toString() : 'the voice was not saved');
      }
      HapticFeedback.selectionClick();
      _say('$label is CHE’s voice now, for Chat, voice conversations and Read This.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('Not saved: ${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _pick(Map<String, dynamic> v) {
    setState(() {
      _provider = (v['provider'] ?? 'elevenlabs').toString();
      _id = (v['id'] ?? '').toString();
      _name = (v['name'] ?? '').toString();
    });
    _say('${v['name']} is selected. Press Save to use it, or Sample to hear the free sample.');
  }

  Widget _providerLine() {
    final lines = <String>[
      'ElevenLabs: $_elevenState${_elevenReason.isEmpty ? '' : '. $_elevenReason'}',
      'Fish Audio: $_fishState${_fishReason.isEmpty ? '' : '. $_fishReason'}',
    ];
    return Semantics(
      liveRegion: true,
      child: Text(lines.join('\n'), style: const TextStyle(color: CheColors.textDim, fontSize: 15, height: 1.35)),
    );
  }

  Widget _voiceRow(Map<String, dynamic> v) {
    final selected = _provider == v['provider'] && _id == v['id'];
    final favorite = _favorites.contains(v['id']);
    final group = {'mine': 'My Voices', 'library': 'Voice Library', 'default': 'Built in'}[v['source']] ?? '';
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: selected ? CheColors.surfaceHi : CheColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: selected ? CheColors.accent : CheColors.stroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Expanded(child: Semantics(
              label: '${v['name']}, $group${selected ? ', selected' : ''}',
              child: Text(v['name'].toString(), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            )),
            IconButton(
              tooltip: favorite ? 'Remove ${v['name']} from favourites' : 'Add ${v['name']} to favourites',
              icon: Icon(favorite ? Icons.star_rounded : Icons.star_border_rounded, color: CheColors.accent),
              onPressed: _busy ? null : () => _toggleFavorite(v),
            ),
          ]),
          Text(group, style: const TextStyle(color: CheColors.textDim, fontSize: 14)),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: FilledButton(
              onPressed: _busy ? null : () => _pick(v),
              child: Text(selected ? 'Selected' : 'Choose'),
            )),
            const SizedBox(width: 8),
            Expanded(child: OutlinedButton(
              onPressed: _busy ? null : () => _playFreeSample(v),
              child: const Text('Sample'),
            )),
          ]),
        ],
      ),
    );
  }

  Widget _filters() {
    const sources = {'all': 'All', 'mine': 'My Voices', 'library': 'Voice Library', 'default': 'Built in'};
    return Wrap(spacing: 8, runSpacing: 8, children: [
      for (final entry in sources.entries)
        ChoiceChip(
          label: Text(entry.value),
          selected: _source == entry.key,
          onSelected: (_) => setState(() => _source = entry.key),
        ),
      FilterChip(
        label: const Text('Favourites'),
        selected: _favoritesOnly,
        onSelected: (on) => setState(() => _favoritesOnly = on),
      ),
    ]);
  }

  Widget _modelSection() {
    final explanation = (_model['explanation'] ?? '').toString();
    final credits = (_model['credits'] ?? '').toString();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 12),
        if (_provider == 'elevenlabs' && _models.isNotEmpty)
          DropdownButtonFormField<String>(
            key: ValueKey('model-$_modelId'),
            initialValue: _models.any((m) => m['id'] == _modelId) ? _modelId : null,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Speech model'),
            items: [
              for (final m in _models)
                DropdownMenuItem<String>(value: m['id'].toString(), child: Text((m['name'] ?? m['id']).toString())),
            ],
            onChanged: _busy ? null : (value) => setState(() => _modelId = value ?? _modelId),
          ),
        if (explanation.isNotEmpty) Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text('$explanation Credits: $credits.', style: const TextStyle(color: CheColors.textDim, fontSize: 14, height: 1.35)),
        ),
      ],
    );
  }

  Widget _controlsSection() {
    if (_provider == 'fish') {
      return const Padding(
        padding: EdgeInsets.only(top: 12),
        child: Text('Fish Audio offers speed only here. Stability, similarity and style are not offered for Fish.',
            style: TextStyle(color: CheColors.textDim, fontSize: 14)),
      );
    }
    Widget slider(String label, double value, ValueChanged<double> onChanged) => Semantics(
      label: label,
      value: '${(value * 100).round()} percent',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('$label: ${value.toStringAsFixed(2)}', style: const TextStyle(fontSize: 15)),
        Slider(value: value, min: 0, max: 1, divisions: 20, label: value.toStringAsFixed(2),
            onChanged: _busy ? null : onChanged),
      ]),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        slider('Stability', _stability, (x) => setState(() => _stability = x)),
        slider('Similarity', _similarity, (x) => setState(() => _similarity = x)),
        if (_controls['style'] == true) slider('Style', _style, (x) => setState(() => _style = x)),
        if (_controls['use_speaker_boost'] == true)
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Speaker boost'),
            value: _speakerBoost,
            onChanged: _busy ? null : (on) => setState(() => _speakerBoost = on),
          ),
        Semantics(
          label: 'Speaking speed',
          value: '${_speed.toStringAsFixed(2)} times',
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Speaking speed: ${_speed.toStringAsFixed(2)}×', style: const TextStyle(fontSize: 15)),
            Slider(value: _speed, min: 0.7, max: 1.2, divisions: 10, label: _speed.toStringAsFixed(2),
                onChanged: _busy ? null : (x) => setState(() => _speed = x)),
          ]),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final visible = _visible;
    return ListView(
      padding: const EdgeInsets.fromLTRB(8, 4, 8, 12),
      children: [
        _providerLine(),
        if (_error.isNotEmpty) Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(_error, style: const TextStyle(color: CheColors.warning, fontSize: 15)),
        ),
        const SizedBox(height: 10),
        TextField(
          decoration: const InputDecoration(labelText: 'Search voices', prefixIcon: Icon(Icons.search)),
          onChanged: (text) => setState(() => _query = text),
        ),
        const SizedBox(height: 10),
        _filters(),
        const SizedBox(height: 10),
        OutlinedButton.icon(
          onPressed: _busy || _loading ? null : () => _load(announce: true),
          icon: const Icon(Icons.refresh),
          label: Text(_loading ? 'Refreshing…' : 'Refresh library'),
        ),
        const SizedBox(height: 12),
        if (!_loading && visible.isEmpty) const Text(
          'No voices match. Refresh, or clear the search and filters.',
          style: TextStyle(color: CheColors.textDim, fontSize: 15),
        ),
        for (final v in visible) _voiceRow(v),
        if (_provider == 'fish' || _fishModels.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text('Fish Audio voices on this account: ${_fishModels.length}',
              style: const TextStyle(color: CheColors.textDim, fontSize: 14)),
        ],
        _modelSection(),
        _controlsSection(),
        const SizedBox(height: 14),
        FilledButton.icon(
          onPressed: _busy || _id.isEmpty ? null : _saveChoice,
          icon: const Icon(Icons.check),
          label: const Text('Save as CHE’s voice'),
        ),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: _busy || _id.isEmpty ? null : _generatePaidSample,
          icon: const Icon(Icons.graphic_eq),
          label: const Text('Generate a paid sample (uses credits)'),
        ),
        if (_status.isNotEmpty) Padding(
          padding: const EdgeInsets.only(top: 14),
          child: Semantics(
            liveRegion: true,
            child: Text(_status, style: const TextStyle(color: CheColors.accent, fontSize: 18, height: 1.3)),
          ),
        ),
      ],
    );
  }
}
