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

class CheCloudVoicePicker extends StatefulWidget {
  const CheCloudVoicePicker({super.key, this.client});
  final http.Client? client;

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
  String _provider = '';
  String _id = '';
  double _speed = 1.0;
  String _base = '';
  String _token = '';

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    if (widget.client == null) _client.close();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = ''; });
    try {
      final prefs = await SharedPreferences.getInstance();
      _base = (prefs.getString('che_agent_base_url') ??
        const String.fromEnvironment('CHE_AGENT_URL', defaultValue: 'https://chey-app.henryjavoni.workers.dev')).replaceAll(RegExp(r'/+$'), '');
      _token = prefs.getString('che_agent_device_token') ?? '';
      if (_token.isEmpty) throw StateError('Pair this iPhone with CHE before changing the cloud voice.');
      final r = await _client.get(Uri.parse(_base + '/api/voice/choices'),
        headers: {'authorization': 'Bearer ' + _token}).timeout(const Duration(seconds: 20));
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
        final match = options.where((v) => v['provider'] == savedProvider && v['id'] == savedId);
        final current = match.isNotEmpty ? match.first : (options.isNotEmpty ? options.first : null);
        _provider = (current?['provider'] ?? '').toString();
        _id = (current?['id'] ?? '').toString();
        _speed = ((selected['speed'] is num ? selected['speed'] as num : 1).toDouble()).clamp(0.7, 1.2);
      });
    } on Object catch (e) {
      if (mounted) setState(() { _voices = []; _error = e.toString().replaceFirst('Bad state: ', ''); });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Map<String, dynamic> get _choice => {'provider': _provider, 'id': _id, 'speed': _speed};
  Map<String, String> get _headers => {'authorization': 'Bearer ' + _token, 'content-type': 'application/json'};

  Future<void> _save() async {
    if (_busy || _id.isEmpty) return;
    setState(() { _busy = true; _status = ''; });
    try {
      final r = await _client.post(Uri.parse(_base + '/api/voice/choice'),
        headers: _headers, body: jsonEncode(_choice)).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map || j['ok'] != true) {
        throw StateError(j is Map ? (j['detail'] ?? 'Voice change was not saved.').toString() : 'Voice change was not saved.');
      }
      HapticFeedback.selectionClick();
      if (mounted) setState(() => _status = 'Voice saved for CHE Chat and Read This. Test it with Read This.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      if (mounted) setState(() => _status = 'Voice not saved: ' + e.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _preview() async {
    if (_busy || _id.isEmpty) return;
    // Previewing uses the existing provider's account credits; no new
    // subscription is activated and no arbitrary text is sent.
    final allowed = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
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
      final r = await _client.post(Uri.parse(_base + '/api/voice/preview'),
        headers: _headers, body: jsonEncode(_choice)).timeout(const Duration(seconds: 55));
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
      if (mounted) setState(() => _status = 'Preview played. Select Save Voice to use it for future replies.');
    } on Object catch (e) {
      if (mounted) setState(() => _status = 'Preview failed: ' + e.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(title: const Text('CHE Natural Voice'),
        actions: [IconButton(tooltip: 'Refresh voices', icon: const Icon(Icons.refresh), onPressed: _busy || _loading ? null : _load)]),
      body: SafeArea(child: ListView(padding: const EdgeInsets.all(18), children: [
        const Text('Choose how CHE speaks', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        const Text('These are the real cloud voices for normal Chat and Read This, not the iPhone fallback voices. Choose and save one here; do not open the providers’ apps.', style: TextStyle(color: CheColors.textDim)),
        const SizedBox(height: 12),
        Text('ElevenLabs: ' + _elevenState + '    Fish Audio: ' + _fishState,
          style: const TextStyle(color: CheColors.accent)),
        if (_loading) const Padding(padding: EdgeInsets.all(12), child: LinearProgressIndicator()),
        if (_error.isNotEmpty) Text(_error, style: const TextStyle(color: CheColors.warning)),
        if (!_loading && _voices.isEmpty) const Padding(
          padding: EdgeInsets.symmetric(vertical: 14),
          child: Text('No available cloud voices were verified. Check pairing, provider keys, and account access in CHE Connections.', style: TextStyle(color: CheColors.warning)),
        ),
        for (final v in _voices)
          RadioListTile<String>(
            title: Text((v['name'] ?? '').toString()),
            subtitle: Text(v['provider'] == 'fish' ? 'Fish Audio — configured voice' : 'ElevenLabs'),
            value: (v['provider'] ?? '').toString() + ':' + (v['id'] ?? '').toString(),
            groupValue: _provider + ':' + _id,
            onChanged: _busy ? null : (_) => setState(() {
              _provider = (v['provider'] ?? '').toString();
              _id = (v['id'] ?? '').toString();
              _status = '';
            }),
          ),
        const SizedBox(height: 12),
        Text('Speaking speed: ' + _speed.toStringAsFixed(2) + '×'),
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
          child: Semantics(liveRegion: true, child: Text(_status, style: const TextStyle(color: CheColors.accent)))),
        const SizedBox(height: 18),
        const Text('Only account-authorized voices are listed. Fish currently exposes its configured voice, not an invented catalog. If a provider fails, CHE tries the other connected provider.', style: TextStyle(color: CheColors.textDim, fontSize: 12)),
      ])),
    );
  }
}
