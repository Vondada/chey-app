// Voice IDs in Chat: paste an ElevenLabs or Fish Audio voice ID, name it, and use it. The
// Worker checks each ID with the provider before saving it, and it keeps the keys. This
// screen only sends an ID and a name, and shows the provider's answer in plain words.
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

String _plain(Object error) => error.toString().replaceFirst('Bad state: ', '');

String _providerName(String provider) => provider == 'fish' ? 'Fish Audio' : 'ElevenLabs';

// Fish Audio's IDs are 32 letters and numbers; ElevenLabs' are shorter.
bool _looksFish(String id) => RegExp(r'^[a-fA-F0-9]{32}$').hasMatch(id.trim());

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

/// The expandable Voice IDs section at the top of Chat.
class CheVoiceIdsSection extends StatelessWidget {
  const CheVoiceIdsSection({super.key, this.onSpeak});

  /// Speaks the result of an action the owner started. Opening the section is silent.
  final ValueChanged<String>? onSpeak;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          leading: Icon(Icons.record_voice_over_rounded, color: CheColors.accent),
          title: const Text('Voice IDs', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          subtitle: Text('Paste a voice ID, name it, and use it',
              style: TextStyle(fontSize: 14, color: CheColors.textDim)),
          childrenPadding: const EdgeInsets.fromLTRB(4, 0, 4, 12),
          children: [
            SizedBox(height: 480, child: CheVoiceIdsPanel(onSpeak: onSpeak)),
          ],
        ),
      ),
    );
  }
}

class CheVoiceIdsPanel extends StatefulWidget {
  const CheVoiceIdsPanel({super.key, this.client, this.onSpeak});
  final http.Client? client;
  final ValueChanged<String>? onSpeak;

  @override
  State<CheVoiceIdsPanel> createState() => _CheVoiceIdsPanelState();
}

class _CheVoiceIdsPanelState extends State<CheVoiceIdsPanel> {
  late final http.Client _client = widget.client ?? http.Client();
  final TextEditingController _idField = TextEditingController();
  final TextEditingController _nameField = TextEditingController();
  bool _busy = false;
  bool _loading = false;
  String _base = '';
  String _token = '';
  String _provider = 'elevenlabs';
  // _status is the result the owner hears (live). _progress is quiet text while a step runs.
  String _status = '';
  String _progress = '';
  String _error = '';
  List<Map<String, dynamic>> _saved = [];
  Map<String, dynamic>? _active;

  @override
  void initState() {
    super.initState();
    // Built only when the owner opens the section: this load is owner-started and silent.
    unawaited(_load());
  }

  @override
  void dispose() {
    _idField.dispose();
    _nameField.dispose();
    if (widget.client == null) _client.close();
    super.dispose();
  }

  Map<String, String> get _auth => {'authorization': 'Bearer $_token'};
  Map<String, String> get _json => {..._auth, 'content-type': 'application/json'};

  void _say(String line) {
    if (!mounted) return;
    setState(() { _status = line; _progress = ''; });
    widget.onSpeak?.call(line);
  }

  // The Worker's reason in plain words, or a plain fallback.
  String _reason(http.Response r) {
    try {
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (j is Map && j['detail'] != null) return j['detail'].toString();
    } catch (_) {}
    return 'CHE did not finish that.';
  }

  void _apply(Map j) {
    _saved = _maps(j['saved']);
    _active = j['active'] is Map ? Map<String, dynamic>.from(j['active'] as Map) : null;
  }

  // [verify] asks the Worker to check every saved voice again (details only, no credits).
  Future<void> _load({bool verify = false}) async {
    setState(() { _error = ''; _loading = true; });
    try {
      final conn = await _studioConnection();
      _base = conn.base;
      _token = conn.token;
      if (_token.isEmpty) throw StateError('Pair this iPhone with CHE first.');
      final r = await _client.get(Uri.parse('$_base/api/voice/ids${verify ? '?verify=1' : ''}'), headers: _auth)
          .timeout(const Duration(seconds: 40));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map) throw StateError(_reason(r));
      if (!mounted) return;
      setState(() => _apply(j));
      if (verify) {
        HapticFeedback.selectionClick();
        _say('Voice accounts checked. ${_saved.length} saved.');
      }
    } on Object catch (e) {
      if (!mounted) return;
      if (verify) {
        HapticFeedback.heavyImpact();
        _say('Could not check the voices: ${_plain(e)}');
      } else {
        setState(() => _error = _plain(e));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // The owner's press is the consent. The Worker checks the ID with the provider first and
  // saves it only when the provider confirms it.
  Future<void> _saveAndUse() async {
    if (_busy) return;
    final id = _idField.text.trim();
    final name = _nameField.text.trim();
    if (id.isEmpty) {
      _say('Paste a voice ID first.');
      return;
    }
    if (name.isEmpty) {
      _say('Give this voice a name, for example Connie.');
      return;
    }
    setState(() { _busy = true; _progress = 'Checking the voice with ${_providerName(_provider)}…'; });
    try {
      final r = await _client.post(Uri.parse('$_base/api/voice/ids/save'), headers: _json,
          body: jsonEncode({'provider': _provider, 'id': id, 'name': name, 'use': true}))
          .timeout(const Duration(seconds: 60));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map || j['ok'] != true) throw StateError(_reason(r));
      HapticFeedback.selectionClick();
      if (!mounted) return;
      setState(() {
        _apply(j);
        _idField.clear();
        _nameField.clear();
      });
      _say('$name is CHE’s voice now. Chat, voice conversations and Read This use it.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('Not saved: ${_plain(e)}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // Switching is a save of the choice: nothing is checked again, so it is immediate.
  Future<void> _use(Map<String, dynamic> voice) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = await _client.post(Uri.parse('$_base/api/voice/ids/use'), headers: _json,
          body: jsonEncode({'provider': voice['provider'], 'id': voice['id']})).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map || j['ok'] != true) throw StateError(_reason(r));
      HapticFeedback.selectionClick();
      if (!mounted) return;
      setState(() => _active = j['active'] is Map ? Map<String, dynamic>.from(j['active'] as Map) : null);
      _say('Now using ${voice['name']}.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('Not switched: ${_plain(e)}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove(Map<String, dynamic> voice) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Remove ${voice['name']}?'),
        content: const Text('CHE forgets this saved voice. Nothing is deleted at ElevenLabs or Fish Audio.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Remove')),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final r = await _client.post(Uri.parse('$_base/api/voice/ids/remove'), headers: _json,
          body: jsonEncode({'provider': voice['provider'], 'id': voice['id'], 'confirm': true})).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || j is! Map || j['ok'] != true) throw StateError(_reason(r));
      if (!mounted) return;
      setState(() => _apply(j));
      _say(j['message']?.toString() ?? 'Removed.');
    } on Object catch (e) {
      _say('Not removed: ${_plain(e)}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // A short sample of the voice in use. It spends a few credits, so the owner confirms first.
  Future<void> _previewActive() async {
    final active = _active;
    if (_busy || active == null) return;
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Hear a short sample?'),
        content: Text('A short sample uses a few credits from ${_providerName(active['provider'].toString())}. Continue?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Preview')),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    setState(() { _busy = true; _progress = 'Making a short sample…'; });
    try {
      final r = await _client.post(Uri.parse('$_base/api/voice/preview'), headers: _json,
          body: jsonEncode({'provider': active['provider'], 'id': active['id'], 'speed': 1, 'confirm_credits': true}))
          .timeout(const Duration(seconds: 55));
      if (r.statusCode != 200 || !(r.headers['content-type'] ?? '').contains('audio')) throw StateError(_reason(r));
      await CheNativeVoice.stopAudio();
      final played = await CheNativeVoice.playAudioBounded(r.bodyBytes);
      if (!played) throw StateError('CHE received audio but your iPhone could not play it.');
      _say('Playing a short sample of ${active['name']}.');
    } on Object catch (e) {
      HapticFeedback.heavyImpact();
      _say('Preview failed: ${_plain(e)}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // What the saved voice's state means to the owner, in plain words.
  String _stateLine(Map<String, dynamic> voice) {
    switch (voice['state']) {
      case 'verified':
        return 'Checked: available to CHE';
      case 'unverified':
        return 'Not checked yet';
      case 'needs_check':
        return 'Saves after one short test sentence';
      case 'paid_plan':
        return 'Needs a paid ElevenLabs plan';
      case 'not_found':
        return 'Not found on your account';
      case 'needs_reconnect':
        return 'The key needs attention';
      default:
        return (voice['reason'] ?? '').toString();
    }
  }

  bool _refused(Map<String, dynamic> voice) =>
      const {'not_found', 'paid_plan', 'needs_reconnect', 'invalid'}.contains(voice['state']);

  Widget _savedRow(Map<String, dynamic> voice) {
    final isActive = _active != null && _active!['id'] == voice['id'] && _active!['provider'] == voice['provider'];
    final refused = _refused(voice);
    final canUse = !_busy && !refused && !isActive;
    final reason = (voice['reason'] ?? '').toString();
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isActive ? CheColors.surfaceHi : CheColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: isActive ? CheColors.accent : CheColors.stroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            label: '${voice['name']}, ${_providerName(voice['provider'].toString())}'
                '${isActive ? ', in use' : ''}. ${_stateLine(voice)}',
            child: Text(
              '${voice['name']}${isActive ? '  ·  in use' : ''}',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
          ),
          Text('${_providerName(voice['provider'].toString())} · ${_stateLine(voice)}',
              style: TextStyle(color: refused ? CheColors.warning : CheColors.textDim, fontSize: 14)),
          if (refused && reason.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(reason, style: const TextStyle(color: CheColors.warning, fontSize: 14, height: 1.3)),
            ),
          const SizedBox(height: 8),
          // VoiceOver reads the voice's name with each button, not just "Use" or "Remove".
          Row(children: [
            Expanded(
              child: Semantics(
                button: true,
                enabled: canUse,
                label: isActive ? '${voice['name']}, in use' : 'Use ${voice['name']}',
                onTap: canUse ? () => _use(voice) : null,
                excludeSemantics: true,
                child: FilledButton(
                  onPressed: canUse ? () => _use(voice) : null,
                  child: Text(isActive ? 'In use' : 'Use'),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Semantics(
              button: true,
              label: 'Remove ${voice['name']}',
              onTap: _busy ? null : () => _remove(voice),
              excludeSemantics: true,
              child: TextButton(
                onPressed: _busy ? null : () => _remove(voice),
                child: const Text('Remove'),
              ),
            ),
          ]),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final active = _active;
    return ListView(
      padding: const EdgeInsets.fromLTRB(8, 4, 8, 12),
      children: [
        Text(
          'Paste a voice ID from ElevenLabs or Fish Audio. CHE checks it with the provider before it saves. Your keys stay on the server.',
          style: TextStyle(color: CheColors.textDim, fontSize: 15, height: 1.35),
        ),
        const SizedBox(height: 12),
        Wrap(spacing: 8, children: [
          ChoiceChip(
            label: const Text('ElevenLabs'),
            selected: _provider == 'elevenlabs',
            onSelected: _busy ? null : (_) => setState(() => _provider = 'elevenlabs'),
          ),
          ChoiceChip(
            label: const Text('Fish Audio'),
            selected: _provider == 'fish',
            onSelected: _busy ? null : (_) => setState(() => _provider = 'fish'),
          ),
        ]),
        const SizedBox(height: 10),
        TextField(
          controller: _idField,
          enabled: !_busy,
          decoration: const InputDecoration(labelText: 'Voice ID', prefixIcon: Icon(Icons.key_outlined)),
          onChanged: (text) => setState(() {
            if (text.trim().isNotEmpty) _provider = _looksFish(text) ? 'fish' : 'elevenlabs';
          }),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _nameField,
          enabled: !_busy,
          decoration: const InputDecoration(labelText: 'Name, for example Connie'),
        ),
        const SizedBox(height: 10),
        FilledButton.icon(
          onPressed: _busy ? null : _saveAndUse,
          icon: const Icon(Icons.check),
          label: const Text('Save & Use Voice'),
        ),
        Padding(
          padding: EdgeInsets.only(top: 6),
          child: Text(
            'If the ElevenLabs key cannot read voice details, saving sends one short test sentence (a few credits).',
            style: TextStyle(color: CheColors.textDim, fontSize: 13, height: 1.3),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          active == null
              ? 'Using CHE’s built-in voice.'
              : 'Using ${active['name']} (${_providerName(active['provider'].toString())}).',
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(
            child: OutlinedButton.icon(
              onPressed: _busy || active == null ? null : _previewActive,
              icon: const Icon(Icons.play_arrow_rounded),
              label: const Text('Preview Voice'),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: TextButton.icon(
              onPressed: _busy || _loading ? null : () => _load(verify: true),
              icon: const Icon(Icons.refresh),
              label: const Text('Check accounts'),
            ),
          ),
        ]),
        if (_error.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_error, style: const TextStyle(color: CheColors.warning, fontSize: 15)),
          ),
        const SizedBox(height: 12),
        for (final voice in _saved) _savedRow(voice),
        if (_progress.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(_progress, style: TextStyle(color: CheColors.textDim, fontSize: 15, height: 1.3)),
          ),
        if (_status.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Semantics(
              liveRegion: true,
              child: Text(_status, style: TextStyle(color: CheColors.accent, fontSize: 18, height: 1.3)),
            ),
          ),
      ],
    );
  }

}
