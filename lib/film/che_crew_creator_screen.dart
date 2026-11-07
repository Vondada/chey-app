// Office → Crew Creator (also "open the crew creator", "edit Nova's look" and "use this picture for Nova" in chat).
// A create-a-player screen over CHE's /api/crew (server/cloudflare/crew_creator.js). For each crew member: the owner's
// own reference picture, kept privately in CHE, which every film draws that face from; the look in words, outfit,
// hair, colours, signature item, personality, tells, voice and catchphrase; and the version history, with undo and
// revert. Voice first: while the screen is open, CheCrewCreatorScreen.voiceHandler takes "show Nova", "next",
// "add the picture", "use the newest picture", "undo", "read" and "save" (lib/home_state/send.dart asks it first).
// Touch works too, and every result is plain text on screen; nothing is spoken unless the owner asks.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../create/che_live_studio.dart' show cheDefaultPickReference, cheImageType, cheMaxReferenceBytes;

/// The crew, in the poster's order (crew_creator.js CREW).
const cheCrewIds = ['che', 'nova', 'mira', 'lyra', 'iris', 'sage', 'atlas', 'orion', 'knox', 'vale'];

/// The editable words, in the order shown, with their limits (crew_creator.js FIELDS).
const cheCrewFields = <(String, String, int)>[
  ('look', 'Look', 160),
  ('outfit', 'Outfit', 120),
  ('hair', 'Hair', 80),
  ('signature', 'Signature item', 120),
  ('personality', 'Personality', 160),
  ('tells', 'Tells', 160),
  ('voice', 'Voice', 120),
  ('catchphrase', 'Catchphrase', 80),
];

class CheCrewClient {
  CheCrewClient({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  Future<Map<String, dynamic>> _decode(Future<http.Response> Function() send) async {
    if (baseUrl.isEmpty) throw Exception('CHE is not connected on this iPhone yet.');
    final http.Response r;
    try {
      r = await send().timeout(const Duration(seconds: 60));
    } on TimeoutException {
      throw Exception('CHE did not answer within a minute.');
    }
    Object? body;
    try {
      body = r.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } on FormatException {
      body = null;
    }
    final map = body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{};
    if (r.statusCode >= 400) throw Exception(map['detail']?.toString() ?? 'CHE answered ${r.statusCode}.');
    return map;
  }

  Map<String, String> get _json => {...headers(), 'Content-Type': 'application/json'};
  Future<Map<String, dynamic>> list() => _decode(() => _client.get(Uri.parse('$baseUrl/api/crew'), headers: headers()));
  Future<Map<String, dynamic>> member(String id) => _decode(() => _client.get(Uri.parse('$baseUrl/api/crew/$id'), headers: headers()));
  Future<Map<String, dynamic>> post(String id, String action, Map<String, Object?> body) => _decode(
      () => _client.post(Uri.parse('$baseUrl/api/crew/$id${action.isEmpty ? '' : '/$action'}'), headers: _json, body: jsonEncode(body)));
  Future<Map<String, dynamic>> update(String id, Map<String, Object?> fields) => post(id, '', fields);
  Future<Map<String, dynamic>> addPicture(String id, Uint8List bytes, {bool primary = true}) =>
      post(id, 'reference', {'image_base64': base64Encode(bytes), 'primary': primary});
  Future<Map<String, dynamic>> newestLibraryPicture(String id) => post(id, 'reference/media', {});
  Future<Map<String, dynamic>> setPrimary(String id, String sha) => post(id, 'primary', {'sha256': sha});
  Future<Map<String, dynamic>> remove(String id, String sha) => post(id, 'remove-reference', {'sha256': sha});
  Future<Map<String, dynamic>> undo(String id) => post(id, 'undo', {});
  Future<Map<String, dynamic>> revert(String id, int version) => post(id, 'revert', {'version': version});
  String pictureUrl(String id, String sha) => '$baseUrl/api/crew/$id/reference/$sha';
}

/// The crew member a phrase names (CHE also answers to Chay and Chey), or null.
String? cheCrewMemberIn(String words) {
  final t = words.toLowerCase();
  for (final id in cheCrewIds) {
    final name = id == 'che' ? '(?:che|chay|chey)' : id;
    if (RegExp('\\b$name\\b').hasMatch(t)) return id;
  }
  return null;
}

/// A spoken command while the Crew Creator is open: (action, member) or null for words it does not take.
/// Actions: show, next, previous, add_picture, use_newest, undo, save, read.
(String, String?)? cheCrewCommand(String words) {
  final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '').replaceFirst(RegExp(r'^(?:hey\s+)?(?:che|chay|chey)\s*[,:!]\s*'), '');
  if (RegExp(r'^(?:next|next one|next member)$').hasMatch(t)) return ('next', null);
  if (RegExp(r'^(?:previous|back one|go back one|previous member)$').hasMatch(t)) return ('previous', null);
  if (RegExp(r'^(?:undo|undo that|go back a version)$').hasMatch(t)) return ('undo', null);
  if (RegExp(r'^(?:save|save it|save changes|save that)$').hasMatch(t)) return ('save', null);
  if (RegExp(r'^(?:read|read it|read (?:it|this) (?:out|aloud)|what does (?:she|he) look like)$').hasMatch(t)) return ('read', null);
  if (RegExp(r'^(?:add|upload|choose|pick)(?: (?:the|a|her|his))? (?:reference )?(?:picture|photo)(?: from (?:my )?photos)?$').hasMatch(t)) return ('add_picture', null);
  if (RegExp(r'^use (?:the )?(?:newest|latest|last) (?:library )?(?:picture|photo|image)$').hasMatch(t)) return ('use_newest', null);
  final show = RegExp(r'^(?:show|open|edit|select|go to)\s+(\w+)').firstMatch(t);
  if (show != null && cheCrewMemberIn(show.group(1)!) != null) return ('show', cheCrewMemberIn(show.group(1)!));
  return null;
}

class CheCrewCreatorScreen extends StatefulWidget {
  const CheCrewCreatorScreen({
    super.key,
    required this.client,
    this.initialMember,
    this.onSpeak,
    this.pickPicture = cheDefaultPickReference,
  });

  final CheCrewClient client;
  final String? initialMember;
  final void Function(String text)? onSpeak;
  final Future<Uint8List?> Function(String source) pickPicture;

  /// Set while the screen is open, so chat words reach it first (lib/home_state/send.dart).
  static Future<String?> Function(String words)? voiceHandler;

  @override
  State<CheCrewCreatorScreen> createState() => _CheCrewCreatorScreenState();
}

class _CheCrewCreatorScreenState extends State<CheCrewCreatorScreen> {
  List<Map<String, dynamic>> _crew = [];
  Map<String, dynamic>? _member;
  String _selected = 'che';
  String _status = 'Loading the crew…';
  bool _busy = false;
  final Map<String, TextEditingController> _text = {for (final f in cheCrewFields) f.$1: TextEditingController()};
  final _colours = TextEditingController();

  @override
  void initState() {
    super.initState();
    _selected = cheCrewIds.contains(widget.initialMember) ? widget.initialMember! : 'che';
    CheCrewCreatorScreen.voiceHandler = _voice;
    unawaited(_load());
  }

  @override
  void dispose() {
    if (CheCrewCreatorScreen.voiceHandler == _voice) CheCrewCreatorScreen.voiceHandler = null;
    for (final c in _text.values) {
      c.dispose();
    }
    _colours.dispose();
    super.dispose();
  }

  String get _name => '${_member?['name'] ?? _selected}';

  void _say(String text, {bool announce = true}) {
    if (!mounted) return;
    setState(() => _status = text);
    if (announce) SemanticsService.announce(text, TextDirection.ltr);
  }

  Future<void> _run(Future<Map<String, dynamic>> Function() action, {String? done}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final out = await action();
      if (out['profile'] is Map) _show(Map<String, dynamic>.from(out['profile'] as Map));
      HapticFeedback.lightImpact();
      _say(done ?? '${out['said'] ?? 'Done.'}');
      unawaited(_refreshList());
    } catch (e) {
      HapticFeedback.heavyImpact();
      _say('${e.toString().replaceFirst('Exception: ', '')} Nothing was changed.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshList() async {
    try {
      final out = await widget.client.list();
      if (!mounted) return;
      setState(() => _crew = [for (final c in (out['crew'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)]);
    } catch (_) {}
  }

  Future<void> _load() async {
    try {
      final out = await widget.client.list();
      if (!mounted) return;
      setState(() => _crew = [for (final c in (out['crew'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)]);
      _say('${out['said'] ?? ''}', announce: false);
      await _open(_selected, quiet: true);
    } catch (e) {
      _say(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _open(String id, {bool quiet = false}) async {
    setState(() => _selected = id);
    try {
      final out = await widget.client.member(id);
      _show(Map<String, dynamic>.from(out['profile'] as Map));
      if (!quiet) _say('$_name. ${_summary()}');
    } catch (e) {
      _say(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  void _show(Map<String, dynamic> p) {
    if (!mounted) return;
    setState(() {
      _member = p;
      for (final f in cheCrewFields) {
        _text[f.$1]!.text = '${p[f.$1] ?? ''}';
      }
      _colours.text = (p['colours'] as List? ?? const []).join(', ');
    });
  }

  String _summary() {
    final p = _member;
    if (p == null) return '';
    final pic = p['has_reference'] == true ? 'Has a reference picture.' : 'No reference picture yet: add one.';
    return '$pic ${p['look'] ?? ''}. ${p['personality'] ?? ''}. Catchphrase: ${p['catchphrase'] ?? ''}.';
  }

  Future<void> _addPicture() async {
    final bytes = await widget.pickPicture('gallery');
    if (bytes == null) return _say('No picture was chosen. Nothing was changed.');
    final type = cheImageType(bytes);
    if (type != 'image/jpeg' && type != 'image/png') return _say('Only JPEG or PNG pictures can be used. Nothing was changed.');
    if (bytes.length > cheMaxReferenceBytes) return _say('That picture is larger than 8 MB. Nothing was changed.');
    await _run(() => widget.client.addPicture(_selected, bytes));
  }

  Future<void> _save() async {
    final fields = <String, Object?>{for (final f in cheCrewFields) f.$1: _text[f.$1]!.text.trim()};
    fields['colours'] = _colours.text.split(',').map((c) => c.trim()).where((c) => c.isNotEmpty).toList();
    await _run(() => widget.client.update(_selected, fields));
  }

  void _step(int by) {
    final i = cheCrewIds.indexOf(_selected);
    unawaited(_open(cheCrewIds[(i + by + cheCrewIds.length) % cheCrewIds.length]));
  }

  Future<String?> _voice(String words) async {
    final cmd = cheCrewCommand(words);
    if (cmd == null) return null;
    switch (cmd.$1) {
      case 'show':
        await _open(cmd.$2!);
        return '$_name. ${_summary()}';
      case 'next':
        _step(1);
        return '';
      case 'previous':
        _step(-1);
        return '';
      case 'add_picture':
        await _addPicture();
        return _status;
      case 'use_newest':
        await _run(() => widget.client.newestLibraryPicture(_selected));
        return _status;
      case 'undo':
        await _run(() => widget.client.undo(_selected));
        return _status;
      case 'save':
        await _save();
        return _status;
      case 'read':
        final text = '$_name. ${_summary()}';
        widget.onSpeak?.call(text);
        return '';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final p = _member;
    final refs = [for (final r in (p?['references'] as List? ?? const [])) Map<String, dynamic>.from(r as Map)];
    final primary = p?['primary']?.toString();
    final history = [for (final h in (p?['history'] as List? ?? const [])) Map<String, dynamic>.from(h as Map)];
    return Scaffold(
      appBar: AppBar(title: const Text('Crew Creator')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            Semantics(liveRegion: false, child: Text(_status, style: Theme.of(context).textTheme.bodySmall)),
            const SizedBox(height: 8),
            SizedBox(
              height: 44,
              child: ListView(
                scrollDirection: Axis.horizontal,
                children: [
                  for (final id in cheCrewIds)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        label: Text(_crewName(id)),
                        avatar: _crewHasPicture(id) ? const Icon(Icons.check_circle, size: 16) : null,
                        selected: id == _selected,
                        onSelected: (_) => unawaited(_open(id)),
                        tooltip: '${_crewName(id)}${_crewHasPicture(id) ? ', has a reference picture' : ', no reference picture yet'}',
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            if (p != null) ...[
              Text('${p['name']} · ${p['role'] ?? ''}', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              if (primary != null && primary.isNotEmpty)
                Semantics(
                  image: true,
                  label: '${p['name']}\'s reference picture',
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.network(widget.client.pictureUrl(_selected, primary), headers: widget.client.headers(), height: 220, fit: BoxFit.contain,
                        errorBuilder: (_, _, _) => const SizedBox(height: 60, child: Center(child: Text('The picture could not be loaded.')))),
                  ),
                )
              else
                FilledButton.icon(
                  onPressed: _busy ? null : () => unawaited(_addPicture()),
                  icon: const Icon(Icons.add_a_photo),
                  label: const Text('Add the reference picture'),
                ),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                OutlinedButton.icon(onPressed: _busy ? null : () => unawaited(_addPicture()), icon: const Icon(Icons.photo_library), label: const Text('From Photos')),
                OutlinedButton.icon(
                    onPressed: _busy ? null : () => unawaited(_run(() => widget.client.newestLibraryPicture(_selected))),
                    icon: const Icon(Icons.collections),
                    label: const Text('Newest library picture')),
                OutlinedButton.icon(onPressed: _busy ? null : () => unawaited(_run(() => widget.client.undo(_selected))), icon: const Icon(Icons.undo), label: const Text('Undo')),
              ]),
              if (refs.length > 1) ...[
                const SizedBox(height: 8),
                Text('Pictures (tap one to make it the face)', style: Theme.of(context).textTheme.labelLarge),
                const SizedBox(height: 4),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final r in refs)
                    InputChip(
                      label: Text('${r['label']?.toString().isNotEmpty == true ? r['label'] : 'Picture'}${r['primary'] == true ? ' (face)' : ''}'),
                      selected: r['primary'] == true,
                      onPressed: _busy ? null : () => unawaited(_run(() => widget.client.setPrimary(_selected, '${r['sha256']}'))),
                      onDeleted: _busy ? null : () => unawaited(_run(() => widget.client.remove(_selected, '${r['sha256']}'))),
                      deleteButtonTooltipMessage: 'Remove this picture (undo brings it back)',
                    ),
                ]),
              ],
              const SizedBox(height: 16),
              for (final f in cheCrewFields)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: TextField(
                    controller: _text[f.$1],
                    maxLength: f.$3,
                    maxLines: f.$3 > 100 ? 3 : 1,
                    minLines: 1,
                    decoration: InputDecoration(labelText: f.$2, border: const OutlineInputBorder()),
                  ),
                ),
              TextField(
                controller: _colours,
                decoration: const InputDecoration(labelText: 'Colours (comma separated)', border: OutlineInputBorder()),
              ),
              const SizedBox(height: 12),
              FilledButton(onPressed: _busy ? null : () => unawaited(_save()), child: const Text('Save')),
              if (history.isNotEmpty) ...[
                const SizedBox(height: 20),
                Text('Versions', style: Theme.of(context).textTheme.labelLarge),
                for (final h in history.take(12))
                  ListTile(
                    dense: true,
                    title: Text('Version ${h['n']}: ${h['change']}'),
                    subtitle: Text('${h['at']}'),
                    trailing: h['n'] == p['version']
                        ? const Text('current')
                        : TextButton(onPressed: _busy ? null : () => unawaited(_run(() => widget.client.revert(_selected, (h['n'] as num).toInt()))), child: const Text('Go back')),
                  ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  String _crewName(String id) => '${_crew.firstWhere((c) => c['id'] == id, orElse: () => {'name': id == 'che' ? 'CHE' : id[0].toUpperCase() + id.substring(1)})['name']}';
  bool _crewHasPicture(String id) => _crew.any((c) => c['id'] == id && c['has_reference'] == true);
}
