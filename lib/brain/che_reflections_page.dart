// CHE daily reflections page, opened from the Brain. Pick a day, see its items by category, and for each item
// Reply (saves the owner's words) or Skip. "Make today's reflection" calls the Worker on demand only; nothing is
// generated or spoken on load. Every control has a text label and a 48dp target. Status is plain text, never colour alone.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_theme.dart';
import 'che_reflections_model.dart';

enum _Status { loading, ready, empty, modelUnavailable, error }

const _weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const _months = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November',
  'December',
];

String _dayLabel(DateTime d) => '${_weekdays[d.weekday - 1]} ${d.day} ${_months[d.month - 1]} ${d.year}';

DateTime _dateOnly(DateTime d) => DateTime(d.year, d.month, d.day);

class CheReflectionsPage extends StatefulWidget {
  const CheReflectionsPage({super.key, required this.baseUrl, required this.headers, this.client, this.now});

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;

  /// Clock for "today"; the device clock when null.
  final DateTime Function()? now;

  @override
  State<CheReflectionsPage> createState() => _CheReflectionsPageState();
}

class _CheReflectionsPageState extends State<CheReflectionsPage> {
  late final http.Client _client = widget.client ?? http.Client();
  late final DateTime _today = _dateOnly(widget.now?.call() ?? DateTime.now());
  late DateTime _day = _today;

  ReflectionDay? _reflection;
  // Room filter: null shows every room. A room that is not in the loaded day is ignored.
  String? _room;
  _Status _status = _Status.loading;
  String _message = '';
  // Action results (saved, skipped, failed, made) are live for VoiceOver; quiet loading text is not.
  bool _messageIsAction = false;
  bool _working = false;
  int _requestSerial = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    if (widget.client == null) _client.close();
    super.dispose();
  }

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('${widget.baseUrl()}$path').replace(queryParameters: query);

  void _fail(String text) {
    HapticFeedback.heavyImpact();
    setState(() {
      _status = _Status.error;
      _message = text;
      _messageIsAction = false;
    });
  }

  Future<void> _load() async {
    final serial = ++_requestSerial;
    final key = reflectionDayKey(_day);
    setState(() {
      _status = _Status.loading;
      _reflection = null;
      _message = '';
    });
    try {
      final res = await _client
          .get(_uri('/api/reflections', {'day': key}), headers: widget.headers())
          .timeout(const Duration(seconds: 30));
      if (!mounted || serial != _requestSerial) return;
      if (res.statusCode != 200) {
        _fail('Could not load the reflection for $key (error ${res.statusCode}). Try again.');
        return;
      }
      final day = reflectionDayFromResponse(jsonDecode(res.body));
      setState(() {
        _reflection = day;
        _status = day == null ? _Status.empty : _Status.ready;
      });
    } catch (_) {
      if (!mounted || serial != _requestSerial) return;
      _fail('Could not reach CHE to load reflections. Check the connection and try again.');
    }
  }

  void _shiftDay(int days) {
    final next = DateTime(_day.year, _day.month, _day.day + days);
    if (next.isAfter(_today)) return;
    setState(() => _day = next);
    _load();
  }

  Future<void> _pickDay() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _day,
      firstDate: DateTime(2024),
      lastDate: _today,
    );
    if (picked == null || !mounted) return;
    setState(() => _day = _dateOnly(picked));
    _load();
  }

  /// Generates today's reflection on demand. Never called automatically.
  Future<void> _makeToday() async {
    if (_working) return;
    final key = reflectionDayKey(_today);
    setState(() {
      _working = true;
      _day = _today;
      _status = _Status.loading;
      _reflection = null;
      _message = '';
    });
    try {
      final res = await _client
          .post(_uri('/api/reflections/generate'), headers: widget.headers(), body: jsonEncode({'day': key}))
          .timeout(const Duration(seconds: 120));
      if (!mounted) return;
      final json = jsonDecode(res.body);
      if (isReflectionModelUnavailable(json)) {
        HapticFeedback.heavyImpact();
        setState(() {
          _status = _Status.modelUnavailable;
          _message = kReflectionModelUnavailableMessage;
          _messageIsAction = true;
        });
        return;
      }
      if (res.statusCode != 200) {
        _actionFailed("CHE could not make today's reflection (error ${res.statusCode}).");
        return;
      }
      final day = reflectionDayFromResponse(json);
      if (day == null) {
        _actionFailed("CHE made no reflection for $key.");
        return;
      }
      HapticFeedback.lightImpact();
      setState(() {
        _reflection = day;
        _status = _Status.ready;
        _message = "Today's reflection is ready: ${day.items.length} items.";
        _messageIsAction = true;
      });
    } catch (_) {
      if (!mounted) return;
      _actionFailed("Could not reach CHE to make today's reflection. Try again.");
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  void _actionFailed(String text) {
    HapticFeedback.heavyImpact();
    setState(() {
      _status = _Status.error;
      _message = text;
      _messageIsAction = true;
    });
  }

  Future<bool> _post(String path, Map<String, Object?> body) async {
    try {
      final res = await _client
          .post(_uri(path), headers: widget.headers(), body: jsonEncode(body))
          .timeout(const Duration(seconds: 30));
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  void _report(String text, {required bool ok}) {
    if (ok) {
      HapticFeedback.lightImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    setState(() {
      _message = text;
      _messageIsAction = true;
    });
  }

  /// Saves the owner's words. Shows the reply at once; restores the item if the Worker refuses it.
  Future<bool> _saveReply(int index, String text) async {
    final before = _reflection;
    if (before == null) return false;
    final original = before.items[index];
    final next = before.withReply(index, text);
    if (identical(next, before)) return false;
    setState(() => _reflection = next);
    final ok = await _post('/api/reflections/reply', {
      'id': before.id,
      'item_index': index,
      'reply': 'replied',
      'reply_text': text.trim(),
    });
    if (!mounted) return ok;
    if (!ok) setState(() => _reflection = _reflection?.withItem(index, (_) => original));
    _report(
      ok ? 'Reply saved for ${original.categoryLabel.toLowerCase()} item ${index + 1}.'
          : 'Reply was not saved. Your words are still in the box. Try again or cancel.',
      ok: ok,
    );
    return ok;
  }

  Future<void> _skip(int index) async {
    final before = _reflection;
    if (before == null) return;
    final original = before.items[index];
    setState(() => _reflection = before.withSkip(index));
    final ok = await _post('/api/reflections/reply', {
      'id': before.id,
      'item_index': index,
      'reply': 'skipped',
      'reply_text': '',
    });
    if (!mounted) return;
    if (!ok) setState(() => _reflection = _reflection?.withItem(index, (_) => original));
    _report(
      ok ? 'Skipped ${original.categoryLabel.toLowerCase()} item ${index + 1}.'
          : 'Skip was not saved. Try again.',
      ok: ok,
    );
  }

  Future<void> _reply(ReflectionEntry entry) async {
    await showDialog<void>(
      context: context,
      builder: (_) => _ReplyDialog(
        category: entry.item.categoryLabel,
        prompt: entry.item.text,
        initial: entry.item.replyText,
        onSave: (text) => _saveReply(entry.index, text),
      ),
    );
  }

  Widget _messageBanner() {
    if (_message.isEmpty) return const SizedBox.shrink();
    final isError = _status == _Status.error || _status == _Status.modelUnavailable;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: CheSpace.md),
      padding: const EdgeInsets.all(CheSpace.md),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: isError ? CheColors.danger : CheColors.accent),
      ),
      child: Semantics(
        liveRegion: _messageIsAction,
        child: Text(_message, style: CheType.bodyDim),
      ),
    );
  }

  Widget _itemCard(ReflectionEntry e) {
    final item = e.item;
    final replied = item.reply == ReflectionReply.replied;
    return Container(
      margin: const EdgeInsets.only(bottom: CheSpace.md),
      padding: const EdgeInsets.all(CheSpace.md),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: CheColors.stroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Room: ${item.roomLabel}', style: CheType.overline),
          const SizedBox(height: CheSpace.xs),
          Text(item.text, style: CheType.body),
          const SizedBox(height: CheSpace.xs),
          Text(item.stateText, style: CheType.caption),
          const SizedBox(height: CheSpace.sm),
          Wrap(
            spacing: CheSpace.sm,
            runSpacing: CheSpace.sm,
            children: [
              OutlinedButton(
                style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
                onPressed: () => _reply(e),
                child: Text(replied ? 'Change reply' : 'Reply'),
              ),
              if (item.reply != ReflectionReply.skipped)
                TextButton(
                  style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                  onPressed: () => _skip(e.index),
                  child: const Text('Skip'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _roomChip(String? room, String label, bool selected) {
    return Semantics(
      button: true,
      selected: selected,
      label: 'Show ${room == null ? 'all rooms' : '$label items'}',
      child: ChoiceChip(
        materialTapTargetSize: MaterialTapTargetSize.padded,
        label: Text(label),
        selected: selected,
        onSelected: (_) => setState(() => _room = room),
      ),
    );
  }

  Widget _body() {
    switch (_status) {
      case _Status.loading:
        return Text('Loading reflection for ${reflectionDayKey(_day)}...', style: CheType.caption);
      case _Status.empty:
        return Text(kReflectionEmptyMessage, style: CheType.bodyDim);
      case _Status.modelUnavailable:
        return const SizedBox.shrink();
      case _Status.error:
        return OutlinedButton(
          style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: _load,
          child: const Text('Try again'),
        );
      case _Status.ready:
        final day = _reflection!;
        final open = day.openCount;
        final room = day.rooms.contains(_room) ? _room : null;
        final groups = day.groupsFor(room: room);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(open == 0 ? 'Every item is answered or skipped.' : '$open still open.', style: CheType.caption),
            const SizedBox(height: CheSpace.md),
            Wrap(
              spacing: CheSpace.sm,
              runSpacing: CheSpace.sm,
              children: [
                _roomChip(null, 'All rooms', room == null),
                for (final r in day.rooms) _roomChip(r, reflectionRoomLabel(r), room == r),
              ],
            ),
            const SizedBox(height: CheSpace.md),
            if (groups.isEmpty)
              Text('No items from this room today.', style: CheType.bodyDim),
            for (final group in groups) ...[
              Padding(
                padding: const EdgeInsets.only(bottom: CheSpace.sm),
                child: Text('${group.label} (${group.entries.length})', style: CheType.overline),
              ),
              for (final e in group.entries) _itemCard(e),
              const SizedBox(height: CheSpace.sm),
            ],
          ],
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final isToday = reflectionDayKey(_day) == reflectionDayKey(_today);
    return Scaffold(
      appBar: AppBar(title: const Text('Daily reflections')),
      body: ListView(
        padding: const EdgeInsets.all(CheSpace.gutter),
        children: [
          Row(
            children: [
              IconButton(
                tooltip: 'Previous day',
                onPressed: () => _shiftDay(-1),
                icon: const Icon(Icons.chevron_left_rounded),
              ),
              Expanded(
                child: Text(_dayLabel(_day), textAlign: TextAlign.center, style: CheType.label),
              ),
              IconButton(
                tooltip: 'Next day',
                onPressed: isToday ? null : () => _shiftDay(1),
                icon: const Icon(Icons.chevron_right_rounded),
              ),
            ],
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton(
              style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
              onPressed: _pickDay,
              child: const Text('Pick a day'),
            ),
          ),
          const SizedBox(height: CheSpace.md),
          FilledButton(
            style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
            onPressed: _working ? null : _makeToday,
            child: Text(_working ? "Making today's reflection..." : "Make today's reflection"),
          ),
          const SizedBox(height: CheSpace.md),
          _messageBanner(),
          _body(),
        ],
      ),
    );
  }
}

class _ReplyDialog extends StatefulWidget {
  const _ReplyDialog({
    required this.category,
    required this.prompt,
    required this.initial,
    required this.onSave,
  });

  final String category;
  final String prompt;
  final String initial;
  final Future<bool> Function(String text) onSave;

  @override
  State<_ReplyDialog> createState() => _ReplyDialogState();
}

class _ReplyDialogState extends State<_ReplyDialog> {
  late final TextEditingController _controller = TextEditingController(text: widget.initial);
  bool _saving = false;
  String _error = '';

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final text = _controller.text.trim();
    if (text.isEmpty) {
      setState(() => _error = 'Type your reply first, or cancel and tap Skip.');
      return;
    }
    setState(() {
      _saving = true;
      _error = '';
    });
    final ok = await widget.onSave(text);
    if (!mounted) return;
    if (ok) {
      Navigator.of(context).pop();
    } else {
      setState(() {
        _saving = false;
        _error = 'Not saved. Your words are still here. Try again, or cancel.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Reply: ${widget.category}'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(widget.prompt, style: CheType.bodyDim),
            const SizedBox(height: CheSpace.md),
            TextField(
              controller: _controller,
              autofocus: true,
              minLines: 2,
              maxLines: 6,
              decoration: const InputDecoration(labelText: 'Your reply'),
            ),
            if (_error.isNotEmpty) ...[
              const SizedBox(height: CheSpace.sm),
              Text(_error, style: CheType.caption),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: _saving ? null : () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: _saving ? null : _save,
          child: Text(_saving ? 'Saving...' : 'Save reply'),
        ),
      ],
    );
  }
}
