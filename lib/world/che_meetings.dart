// CHE Meetings (owner, 2026-10-20: "once I left, I couldn't find my way
// back"). One list of the meetings the Worker already keeps (GET
// /api/meetings, same ids), grouped Active, Recent and Completed, each opening
// the same visual Meeting Room for that meeting id. Nothing is restarted or
// copied: the room reads the meeting's existing scene. The only thing kept on
// the phone is the id of the last meeting opened, so "take me back to my last
// meeting" works after leaving, switching rooms or restarting CHE.
//
// Also: plain-language text for meeting cards. Agents' drafts can be raw JSON
// or Markdown; cards show a short readable sentence and the full sourced text
// stays one tap away.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../agents/che_agent_runtime.dart';
import 'che_meeting_room.dart';

const _lastMeetingKey = 'che.meetings.lastOpenedId';

/// Remembers the meeting the owner opened last (only its id).
Future<void> cheRememberMeeting(String id) async {
  if (id.isEmpty) return;
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_lastMeetingKey, id);
  } catch (_) {}
}

Future<String?> cheLastMeetingId() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final id = prefs.getString(_lastMeetingKey);
    return id == null || id.isEmpty ? null : id;
  } catch (_) {
    return null;
  }
}

// ── Plain language ─────────────────────────────────────────────────────────────

String _sentence(String s, int max) {
  var t = s.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (t.length <= max) return t;
  final cut = t.substring(0, max);
  final end = cut.lastIndexOf(RegExp(r'[.!?](\s|$)'));
  if (end > max * 0.5) return cut.substring(0, end + 1);
  final space = cut.lastIndexOf(' ');
  return '${cut.substring(0, space > 0 ? space : max).trimRight()}…';
}

String _fromJson(Object? v) {
  if (v is Map) {
    for (final k in const ['summary', 'recommendation', 'answer', 'text', 'message', 'title', 'objective', 'plan', 'description']) {
      final x = v[k];
      if (x is String && x.trim().isNotEmpty) return x;
    }
    final parts = <String>[];
    for (final e in v.entries) {
      final x = e.value;
      if (x is String && x.trim().isNotEmpty) parts.add('${'${e.key}'.replaceAll('_', ' ')}: $x');
      if (x is List) parts.add('${x.length} ${'${e.key}'.replaceAll('_', ' ')}');
      if (parts.length == 3) break;
    }
    return parts.isEmpty ? 'Structured notes with ${v.length} fields.' : parts.join('. ');
  }
  if (v is List) {
    final strings = [for (final x in v) if (x is String) x else if (x is Map) _fromJson(x)];
    return strings.isEmpty ? 'A list of ${v.length} items.' : '${v.length} points. First: ${strings.first}';
  }
  return '$v';
}

/// A short, plain-language version of meeting text: no Markdown symbols, no
/// raw JSON, at most [max] characters, ending on a sentence where it can.
String chePlainText(String raw, {int max = 160}) {
  var t = raw.trim();
  if (t.isEmpty) return '';
  // A fenced JSON block or a bare JSON value becomes its readable fields.
  final fenced = RegExp(r'```(?:json)?\s*([\s\S]*?)```').firstMatch(t);
  final candidate = (fenced?.group(1) ?? t).trim();
  if (candidate.startsWith('{') || candidate.startsWith('[')) {
    try {
      t = _fromJson(jsonDecode(candidate));
    } catch (_) {
      // Not valid JSON: fall through to the Markdown cleanup.
    }
  }
  t = t
      .replaceAll(RegExp(r'```[\s\S]*?```'), ' ')
      .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m[1]!)
      .replaceAll(RegExp(r'^\s{0,3}#{1,6}\s*', multiLine: true), '')
      .replaceAll(RegExp(r'^\s*(?:[-*+]|\d+[.)])\s+', multiLine: true), '')
      .replaceAll(RegExp(r'^\s*>\s?', multiLine: true), '')
      .replaceAll(RegExp(r'(\*\*|__|\*|_|`|~~)'), '')
      .replaceAll(RegExp(r'^\s*\|.*\|\s*$', multiLine: true), '')
      .replaceAll(RegExp(r'[{}\[\]"]'), '')
      .replaceAll(RegExp(r'\n{2,}'), '. ')
      .replaceAll('\n', ' ')
      .replaceAll(RegExp(r'\.\s*\.'), '.');
  return _sentence(t, max);
}

// ── Dates and grouping ─────────────────────────────────────────────────────────

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "Today, 2:14 PM", "Yesterday, 9:05 AM" or "Oct 18, 4:30 PM".
String cheMeetingDate(DateTime? at, {DateTime? now}) {
  if (at == null) return 'Date unknown';
  final local = at.toLocal();
  final n = (now ?? DateTime.now()).toLocal();
  final h = local.hour % 12 == 0 ? 12 : local.hour % 12;
  final time = '$h:${local.minute.toString().padLeft(2, '0')} ${local.hour < 12 ? 'AM' : 'PM'}';
  final day = DateTime(local.year, local.month, local.day);
  final today = DateTime(n.year, n.month, n.day);
  final diff = today.difference(day).inDays;
  if (diff == 0) return 'Today, $time';
  if (diff == 1) return 'Yesterday, $time';
  return '${_months[local.month - 1]} ${local.day}, $time';
}

/// Active (still working), Recent (finished in the last 24 hours) and Completed (older).
({List<CheMeetingSummary> active, List<CheMeetingSummary> recent, List<CheMeetingSummary> completed}) cheGroupMeetings(List<CheMeetingSummary> all, {DateTime? now}) {
  final n = now ?? DateTime.now();
  final active = <CheMeetingSummary>[];
  final recent = <CheMeetingSummary>[];
  final completed = <CheMeetingSummary>[];
  for (final m in all) {
    if (m.live) {
      active.add(m);
    } else if (n.difference(m.updatedAt ?? m.createdAt ?? DateTime(2000)).inHours < 24) {
      recent.add(m);
    } else {
      completed.add(m);
    }
  }
  return (active: active, recent: recent, completed: completed);
}

String cheMeetingName(CheMeetingSummary m) => chePlainText(m.objective, max: 70);

String cheMeetingStatusSpoken(CheMeetingSummary m) => switch (m.status) {
      'drafting' => 'in progress: agents drafting',
      'cross_check' => 'in progress: cross-checking',
      'synthesizing' => 'in progress: CHE writing the plan',
      'complete' => 'finished, with a recommended path',
      'failed' => 'stopped with an error',
      _ => m.status,
    };

// ── Voice ──────────────────────────────────────────────────────────────────────

/// "Take me back to my last meeting" → last; "show my meetings" → list;
/// "open the meeting about my app" → about (topic "my app"). Null otherwise.
({String kind, String topic})? cheMeetingNavIntent(String raw) {
  final t = raw.trim().toLowerCase().replaceAll('’', "'").replaceAll(RegExp(r'[.?!]+$'), '')
      .replaceFirst(RegExp(r'^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?(?:please\s+|can you\s+|could you\s+)*'), '').trim();
  if (RegExp(r"^(?:take me |bring me |go |get me )?back to (?:my |the )?(?:last |latest |previous |current )?meeting(?: room)?$|^(?:return to|reopen|resume|rejoin) (?:my |the )?(?:last |latest |previous )?meeting(?: room)?$|^(?:open|show me) (?:my |the )?(?:last|latest|previous) meeting$").hasMatch(t)) {
    return (kind: 'last', topic: '');
  }
  if (RegExp(r"^(?:show|list|open|read)(?: me)? (?:all )?(?:my |the )?meetings$|^(?:what|which) meetings (?:do i have|are there)$|^where are my meetings$").hasMatch(t)) {
    return (kind: 'list', topic: '');
  }
  final about = RegExp(r"^(?:open|show(?: me)?|take me to|go to|reopen|return to) (?:my |the )?meeting (?:about|on|for) (.+)$").firstMatch(t);
  if (about != null) return (kind: 'about', topic: about.group(1)!.trim());
  return null;
}

const _stop = {'the', 'a', 'an', 'my', 'our', 'to', 'of', 'for', 'and', 'on', 'about', 'with', 'in', 'plan', 'meeting'};
Set<String> _words(String s) => {
      for (final w in s.toLowerCase().split(RegExp(r'[^a-z0-9]+')))
        if (w.length > 1 && !_stop.contains(w)) w.endsWith('s') && w.length > 3 ? w.substring(0, w.length - 1) : w,
    };

/// The meeting whose objective best matches [topic], newest first on ties; null when no word matches.
CheMeetingSummary? cheMatchMeeting(List<CheMeetingSummary> meetings, String topic) {
  final want = _words(topic);
  if (want.isEmpty) return null;
  CheMeetingSummary? best;
  var bestScore = 0;
  for (final m in meetings) {
    final score = _words(m.objective).intersection(want).length;
    if (score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

/// Opens the visual Meeting Room for [id] and remembers it as the last meeting.
Future<void> cheOpenMeetingRoom(BuildContext context, {required CheAgentRuntimeClient client, required String id, required Future<void> Function(String) onSpeak, VoidCallback? onBackToOffice}) async {
  await cheRememberMeeting(id);
  if (!context.mounted) return;
  await Navigator.of(context).push(CheMeetingRoom.route(client: client, meetingId: id, onSpeak: onSpeak, onBackToOffice: onBackToOffice));
}

// ── The list ───────────────────────────────────────────────────────────────────

class CheMeetingsPage extends StatefulWidget {
  const CheMeetingsPage({super.key, required this.client, required this.onSpeak, this.onBackToOffice, this.load});

  final CheAgentRuntimeClient client;
  final Future<void> Function(String text) onSpeak;
  final VoidCallback? onBackToOffice;

  /// For tests; defaults to client.meetings.
  final Future<List<CheMeetingSummary>> Function()? load;

  static Route<void> route({required CheAgentRuntimeClient client, required Future<void> Function(String) onSpeak, VoidCallback? onBackToOffice}) =>
      MaterialPageRoute<void>(builder: (_) => CheMeetingsPage(client: client, onSpeak: onSpeak, onBackToOffice: onBackToOffice));

  @override
  State<CheMeetingsPage> createState() => _CheMeetingsPageState();
}

class _CheMeetingsPageState extends State<CheMeetingsPage> {
  List<CheMeetingSummary>? _meetings;
  String? _lastId;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await (widget.load ?? widget.client.meetings)();
      final last = await cheLastMeetingId();
      if (!mounted) return;
      setState(() {
        _meetings = list;
        _lastId = last;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not load your meetings: $e');
    }
  }

  Future<void> _open(CheMeetingSummary m) async {
    HapticFeedback.selectionClick();
    await cheOpenMeetingRoom(context, client: widget.client, id: m.id, onSpeak: widget.onSpeak, onBackToOffice: widget.onBackToOffice);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final all = _meetings;
    final last = all?.where((m) => m.id == _lastId).firstOrNull;
    final groups = all == null ? null : cheGroupMeetings(all);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Meetings'),
        leading: BackButton(onPressed: () => Navigator.of(context).maybePop()),
        actions: [
          if (widget.onBackToOffice != null)
            TextButton(onPressed: widget.onBackToOffice, child: const Text('Back to Office', style: TextStyle(fontSize: 16))),
        ],
      ),
      body: all == null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error ?? 'Loading your meetings…', style: const TextStyle(fontSize: 18), textAlign: TextAlign.center)))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                children: [
                  if (last != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                        onPressed: () => _open(last),
                        icon: const Icon(Icons.meeting_room_rounded),
                        label: Text('Return to meeting: ${cheMeetingName(last)}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 18)),
                      ),
                    ),
                  if (all.isEmpty)
                    const Text('No meetings yet. Say "start a meeting about" and a topic to convene the team.', style: TextStyle(fontSize: 18)),
                  if (groups != null) ...[
                    ..._section('Active', groups.active),
                    ..._section('Recent', groups.recent),
                    ..._section('Completed', groups.completed),
                  ],
                ],
              ),
            ),
    );
  }

  List<Widget> _section(String title, List<CheMeetingSummary> list) => [
        Padding(
          padding: const EdgeInsets.only(top: 12, bottom: 4),
          child: Semantics(header: true, child: Text('$title (${list.length})', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700))),
        ),
        if (list.isEmpty) Text('None.', style: const TextStyle(fontSize: 16, color: Colors.white60)),
        for (final m in list)
          Semantics(
            button: true,
            label: '${cheMeetingName(m)}. ${cheMeetingStatusSpoken(m)}. ${cheMeetingDate(m.updatedAt ?? m.createdAt)}. With ${m.participantNames.join(', ')}. Opens the meeting room.',
            excludeSemantics: true,
            child: Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                minVerticalPadding: 12,
                onTap: () => _open(m),
                leading: Icon(m.live ? Icons.groups_rounded : (m.status == 'failed' ? Icons.error_outline_rounded : Icons.fact_check_rounded), size: 30),
                title: Text(cheMeetingName(m), style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w600)),
                subtitle: Text('${_cap(cheMeetingStatusSpoken(m))}\n${cheMeetingDate(m.updatedAt ?? m.createdAt)} · ${m.participantNames.join(', ')}', style: const TextStyle(fontSize: 15)),
                isThreeLine: true,
                trailing: const Icon(Icons.chevron_right_rounded),
              ),
            ),
          ),
      ];

  static String _cap(String s) => s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';
}
