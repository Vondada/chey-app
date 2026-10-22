// CHE voice picker: the selected cloud voice is stored by the existing
// authenticated Worker; the iPhone keeps no ElevenLabs/Fish keys or voice IDs.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'che_native_voice.dart';
import 'che_ui/che_theme.dart';

/// Spoken control for the picker while it is on screen; null when it is closed.
class CheCloudVoicePickerVoice {
  CheCloudVoicePickerVoice._();
  static Future<String?> Function(String words)? handler;
}

class CheCloudVoicePicker extends StatefulWidget {
  const CheCloudVoicePicker({super.key, this.client, this.onSpeak, this.onListen});
  final http.Client? client;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;

  @override
  State<CheCloudVoicePicker> createState() => _CheCloudVoicePickerState();
}

class _CheCloudVoicePickerState extends State<CheCloudVoicePicker> {
  late final http.Client _client = widget.client ?? http.Client();
  bool _loading = true;
  bool _busy = false;
  String _error = '';
  String _status = '';
  String _elevenState = 'Unavailable';
  String _fishState = 'Unavailable';
  List<Map<String, dynamic>> _voices = [];
  // The saved voice's name when the provider's list does not include it now.
  String _savedUnlisted = '';
  String _provider = '';
  String _id = '';
  double _speed = 1.0;
  // The owner's speech model and controls, kept so saving here does not reset them.
  String _modelId = '';
  Map<String, dynamic>? _settings;
  String _base = '';
  String _token = '';
  bool _pendingPreview = false;

  @override
  void initState() {
    super.initState();
    CheCloudVoicePickerVoice.handler = _voice;
    unawaited(_load());
  }

  @override
  void dispose() {
    if (CheCloudVoicePickerVoice.handler == _voice) CheCloudVoicePickerVoice.handler = null;
    if (widget.client == null) _client.close();
    super.dispose();
  }

  Future<void> _load({bool announce = false}) async {
    setState(() { _loading = true; _error = ''; });
    try {
      final prefs = await SharedPreferences.getInstance();
      _base = (prefs.getString('che_agent_base_url') ??
        const String.fromEnvironment('CHE_AGENT_URL', defaultValue: 'https://chey-app.henryjavoni.workers.dev')).replaceAll(RegExp(r'/+$'), '');
      _token = prefs.getString('che_agent_device_token') ?? '';
      if (_token.isEmpty) throw StateError('Pair this iPhone with CHE before changing the cloud voice.');
      final r = await _client.get(Uri.parse('$_base/api/voice/choices'),
        headers: {'authorization': 'Bearer $_token'}).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map) {
        throw StateError(j is Map ? (j['detail'] ?? 'CHE did not return voice choices.').toString()
          : 'CHE did not return voice choices.');
      }
      if (!mounted) return;
      final options = j['options'] is List ? (j['options'] as List)
        .whereType<Map>().map((v) => Map<String, dynamic>.from(v)).toList() : <Map<String, dynamic>>[];
      final selected = j['selected'] is Map ? Map<String, dynamic>.from(j['selected'] as Map) : <String, dynamic>{};
      setState(() {
        _voices = options;
        _elevenState = (j['elevenlabs'] ?? 'Unavailable').toString();
        _fishState = (j['fish'] ?? 'Unavailable').toString();
        final savedProvider = (selected['provider'] ?? '').toString();
        final savedId = (selected['id'] ?? '').toString();
        // The saved voice stays selected until the owner picks another
        // (owner, 2026-10-18). A voice the provider's list does not show right
        // now is still his choice; nothing else is preselected in its place.
        final listed = options.any((v) => v['provider'] == savedProvider && v['id'] == savedId);
        // With nothing saved yet (CHE's built-in voice), the first listed voice
        // is offered, as before; saving is still the owner's own step.
        final first = savedId.isEmpty && options.isNotEmpty ? options.first : null;
        _provider = first == null ? savedProvider : (first['provider'] ?? '').toString();
        _id = first == null ? savedId : (first['id'] ?? '').toString();
        _savedUnlisted = savedId.isNotEmpty && !listed
            ? ((selected['name'] ?? '').toString().trim().isEmpty ? 'your saved voice' : (selected['name'] ?? '').toString())
            : '';
        _speed = ((selected['speed'] is num ? selected['speed'] as num : 1).toDouble()).clamp(0.7, 1.2).toDouble();
        _modelId = (selected['model_id'] ?? '').toString();
        _settings = selected['settings'] is Map ? Map<String, dynamic>.from(selected['settings'] as Map) : null;
      });
      // Only an owner-requested refresh announces; the first load stays silent.
      if (announce) {
        HapticFeedback.selectionClick();
        _say(_voices.isEmpty
            ? 'No cloud voices are verified right now. ElevenLabs: $_elevenState. Fish: $_fishState.'
            : 'Voices refreshed. ${_voices.length} verified. ElevenLabs: $_elevenState. Fish: $_fishState.');
      }
    } on Object catch (e) {
      if (mounted) setState(() { _voices = []; _error = e.toString().replaceFirst('Bad state: ', ''); });
      if (announce) {
        HapticFeedback.heavyImpact();
        _say('Voices not refreshed: ${e.toString().replaceFirst('Bad state: ', '')}');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // Save and preview results are shown and spoken, never only shown.
  void _say(String line) {
    if (!mounted) return;
    setState(() => _status = line);
    widget.onSpeak?.call(line);
  }

  static const _numberWords = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10};

  String _numbered() => [
    for (var i = 0; i < _voices.length; i++) '${i + 1}, ${_voices[i]['name'] ?? 'voice'}',
  ].join('; ');

  Map<String, dynamic>? _voiceNamed(String wanted) {
    Map<String, dynamic>? partial;
    for (final v in _voices) {
      final name = (v['name'] ?? '').toString().toLowerCase();
      if (name == wanted) return v;
      if (partial == null && name.contains(wanted)) partial = v;
    }
    return partial;
  }

  void _choose(Map<String, dynamic> v) {
    setState(() {
      _provider = (v['provider'] ?? '').toString();
      _id = (v['id'] ?? '').toString();
    });
    _say('Selected ${v['name'] ?? 'voice'}. Say preview voice to hear it, or save voice to use it.');
  }

  // Spoken control while the picker is open. Each route says its real result
  // and shows it on screen. Speech it does not recognize goes to Chat (null).
  Future<String?> _voice(String words) async {
    if (ModalRoute.of(context)?.isCurrent == false) return null;
    final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '')
        .replaceFirst(RegExp(r'^(?:hey\s+)?(?:che|chay|chey)[,:]?\s+'), '').trim();
    if (_pendingPreview) {
      _pendingPreview = false;
      if (RegExp(r'^(?:yes|yeah|yep|go ahead|do it|preview)$').hasMatch(t)) {
        await _preview(confirmed: true);
        return '';
      }
      if (RegExp(r'^(?:no|nope|cancel|never mind|stop)$').hasMatch(t)) {
        _say('Preview cancelled. Nothing was played.');
        return '';
      }
    }
    if (RegExp(r'^(?:go back|back|close)$').hasMatch(t)) {
      final speak = widget.onSpeak;
      final closed = await Navigator.of(context).maybePop();
      if (closed) {
        HapticFeedback.selectionClick();
        speak?.call('Closed the CHE voice choices.');
      } else {
        HapticFeedback.heavyImpact();
        _say('I could not close the voice choices.');
      }
      return '';
    }
    if (RegExp(r'^(?:list|read|show|what are|which are)\s+(?:the\s+|my\s+|available\s+)?voices$').hasMatch(t) ||
        RegExp(r'^what voices (?:do i have|are there|can i use)$').hasMatch(t)) {
      _say(_voices.isEmpty
          ? 'No cloud voices are verified right now. Check pairing and provider keys in CHE Connections.'
          : 'Available voices: ${_numbered()}. Say choose and a name, or choose number and a number.');
      return '';
    }
    if (RegExp(r'^(?:refresh|reload|check)\s+(?:the\s+)?voices$').hasMatch(t)) {
      await _load(announce: true);
      return '';
    }
    final typedSpeed = RegExp(r'^(?:set\s+)?(?:voice\s+)?speed\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*x?$').firstMatch(t);
    final faster = RegExp(r'^(?:faster|speed up)$').hasMatch(t);
    final slower = RegExp(r'^(?:slower|slow down)$').hasMatch(t);
    if (typedSpeed != null || faster || slower) {
      final requested = typedSpeed != null ? double.parse(typedSpeed.group(1)!) : _speed + (faster ? 0.05 : -0.05);
      if (typedSpeed != null && (requested < 0.7 || requested > 1.2)) {
        _say('Speed must be between 0.7 and 1.2. It is ${_speed.toStringAsFixed(2)} now.');
        return '';
      }
      setState(() => _speed = requested.clamp(0.7, 1.2).toDouble());
      _say('Voice speed is ${_speed.toStringAsFixed(2)}. Say save voice to keep it.');
      return '';
    }
    if (RegExp(r'^(?:preview|test|play|hear)\s+(?:this\s+|that\s+|the\s+|my\s+|your\s+)?voice$').hasMatch(t)) {
      if (_id.isEmpty) {
        _say('Choose a voice first. Say list voices to hear the choices.');
        return '';
      }
      _pendingPreview = true;
      _say('One short preview may use credits from your connected voice provider. Say yes to preview, or no to cancel.');
      return '';
    }
    if (RegExp(r'^(?:save|keep|use|apply)\s+(?:this\s+|that\s+|the\s+|my\s+)?(?:voice|choice|selection)$').hasMatch(t) ||
        RegExp(r'^(?:save|use|keep)\s+(?:it|this|that)$').hasMatch(t)) {
      if (_id.isEmpty) {
        _say('Choose a voice first. Say list voices to hear the choices.');
        return '';
      }
      await _save();
      return '';
    }
    final number = RegExp(r'^(?:choose|pick|select|use|switch to)\s+(?:number\s+|voice\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d+)$').firstMatch(t);
    final named = RegExp(r'^(?:choose|pick|select|switch to|use)\s+(?:the\s+|voice\s+)?(.+?)(?:\s+voice)?$').firstMatch(t);
    if (number != null || named != null) {
      final spoken = (number ?? named)!.group(1)!;
      final index = number == null ? null : (_numberWords[spoken] ?? int.tryParse(spoken));
      final chosen = number != null
          ? (index != null && index >= 1 && index <= _voices.length ? _voices[index - 1] : null)
          : _voiceNamed(spoken);
      if (chosen == null) {
        _say(_voices.isEmpty
            ? 'No cloud voices are verified right now.'
            : 'I did not find that voice. Available voices: ${_numbered()}.');
      } else {
        _choose(chosen);
      }
      return '';
    }
    return null;
  }

  Map<String, dynamic> get _choice => {
    'provider': _provider,
    'id': _id,
    'speed': _speed,
    if (_provider == 'elevenlabs' && _modelId.isNotEmpty) 'model_id': _modelId,
    if (_provider == 'elevenlabs' && _modelId.isNotEmpty && _settings != null) 'settings': _settings,
  };
  Map<String, String> get _headers => {'authorization': 'Bearer $_token', 'content-type': 'application/json'};

  Future<void> _save() async {
    if (_busy || _id.isEmpty) return;
    setState(() { _busy = true; _status = ''; });
    try {
      final r = await _client.post(Uri.parse('$_base/api/voice/choice'),
        headers: _headers, body: jsonEncode(_choice)).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map || j['ok'] != true) {
        throw StateError(j is Map ? (j['detail'] ?? 'Voice change was not saved.').toString() : 'Voice change was not saved.');
      }
      HapticFeedback.selectionClick();
      if (mounted) setState(() => _savedUnlisted = '');
      _say('Voice saved for CHE Chat and Read This. Test it with Read This.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('Voice not saved: ${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // [confirmed] is true only after the owner said yes to the spoken credit notice.
  Future<void> _preview({bool confirmed = false}) async {
    if (_busy || _id.isEmpty) return;
    // Previewing uses the existing provider's account credits; no new
    // subscription is activated and no arbitrary text is sent.
    final allowed = confirmed ? true : await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Preview cloud voice?'),
      content: const Text('One short preview may use credits from your connected voice provider. Continue?'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Preview')),
      ],
    ));
    if (allowed != true || !mounted) return;
    setState(() { _busy = true; _status = 'Requesting a real voice preview…'; });
    try {
      // The owner has just confirmed the credit notice here, so the request carries that consent.
      final r = await _client.post(Uri.parse('$_base/api/voice/preview'),
        headers: _headers, body: jsonEncode({..._choice, 'confirm_credits': true})).timeout(const Duration(seconds: 55));
      if (r.statusCode != 200 || !((r.headers['content-type'] ?? '').contains('audio'))) {
        String reason = 'This voice did not return playable audio.';
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
      _say('Preview played. Select Save Voice to use it for future replies.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('Preview failed: ${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.screen,
      appBar: AppBar(title: const Text('CHE Natural Voice'),
        actions: [
          if (widget.onListen != null)
            IconButton(tooltip: 'Speak to CHE', icon: const Icon(Icons.mic_rounded), onPressed: widget.onListen),
          IconButton(tooltip: 'Refresh voices', icon: const Icon(Icons.refresh),
            onPressed: _busy || _loading ? null : () => unawaited(_load(announce: true))),
        ]),
      body: SafeArea(child: ListView(padding: const EdgeInsets.all(18), children: [
        const Text('Choose how CHE speaks', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        Text('These are the real cloud voices for normal Chat and Read This, not the iPhone fallback voices. Choose and save one here; do not open the providers’ apps.', style: TextStyle(color: CheColors.textDim)),
        const SizedBox(height: 12),
        Text('ElevenLabs: $_elevenState    Fish Audio: $_fishState',
          style: TextStyle(color: CheColors.accent)),
        if (_loading) const Padding(padding: EdgeInsets.all(12), child: LinearProgressIndicator()),
        if (_error.isNotEmpty) Text(_error, style: const TextStyle(color: CheColors.warning)),
        if (!_loading && _voices.isEmpty) const Padding(
          padding: EdgeInsets.symmetric(vertical: 14),
          child: Text('No available cloud voices were verified. Check pairing, provider keys, and account access in CHE Connections.', style: TextStyle(color: CheColors.warning)),
        ),
        if (_savedUnlisted.isNotEmpty) Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text('CHE keeps using $_savedUnlisted. It is not in the provider\'s list right now, so it is not shown below.',
            style: TextStyle(color: CheColors.textDim)),
        ),
        for (final v in _voices)
          ListTile(
            leading: Icon(_provider == v['provider'] && _id == v['id']
              ? Icons.radio_button_checked : Icons.radio_button_unchecked,
              color: CheColors.accent),
            title: Text((v['name'] ?? '').toString()),
            subtitle: Text(v['provider'] == 'fish' ? 'Fish Audio — configured voice' : 'ElevenLabs'),
            onTap: _busy ? null : () => _choose(v),
          ),
        const SizedBox(height: 12),
        Text('Speaking speed: ${_speed.toStringAsFixed(2)}×'),
        Slider(value: _speed, min: 0.7, max: 1.2, divisions: 10,
          label: _speed.toStringAsFixed(2), onChanged: _busy ? null : (v) => setState(() => _speed = v)),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: OutlinedButton.icon(onPressed: _busy || _loading || _id.isEmpty ? null : _preview,
            icon: const Icon(Icons.play_arrow_rounded), label: const Text('Preview'))),
          const SizedBox(width: 10),
          Expanded(child: FilledButton.icon(onPressed: _busy || _loading || _id.isEmpty ? null : _save,
            icon: const Icon(Icons.check), label: const Text('Save Voice'))),
        ]),
        if (_status.isNotEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 14),
          child: Semantics(liveRegion: true, child: Text(_status, style: TextStyle(color: CheColors.accent, fontSize: 18, height: 1.3)))),
        const SizedBox(height: 18),
        Text('Only account-authorized voices are listed. Fish currently exposes its configured voice, not an invented catalog. If a provider fails, CHE tries the other connected provider.', style: TextStyle(color: CheColors.textDim, fontSize: 12)),
      ])),
    );
  }
}
