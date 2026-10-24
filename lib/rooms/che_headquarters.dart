// CHE's headquarters (owner mission, 2026-10-24): every room with its department head, the head's real status from
// the Office records, and a conversation with the head inside the room. The 3D crew is one tap away; this list is the
// accessible version of the same rooms and works without it. Nothing here shows work that the records do not hold.

import 'package:flutter/material.dart';

import '../agents/che_agent_runtime.dart';
import '../che_ui/che_theme.dart';

class CheHeadquartersScreen extends StatefulWidget {
  const CheHeadquartersScreen({super.key, required this.client, this.onOpen3D, this.embedded = false});

  final CheAgentRuntimeClient client;

  /// Opens the 3D crew (CheCharactersRoom). Shown only when the caller has one.
  final VoidCallback? onOpen3D;

  /// True inside the Office tab: no second app bar; the title and actions sit in a row above the rooms.
  final bool embedded;

  @override
  State<CheHeadquartersScreen> createState() => _CheHeadquartersScreenState();
}

class _CheHeadquartersScreenState extends State<CheHeadquartersScreen> {
  Map<String, dynamic>? _view;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final view = await widget.client.hqView();
      if (!mounted) return;
      setState(() => _view = view);
    } on CheAgentRuntimeException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'The headquarters could not be read. Check the connection and try again.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final view = _view;
    final rooms = [for (final r in (view?['rooms'] as List? ?? const [])) Map<String, dynamic>.from(r as Map)];
    final body = _loading && view == null
        ? const Center(child: CircularProgressIndicator())
        : _error != null && view == null
            ? Padding(
                padding: const EdgeInsets.all(CheSpace.lg),
                child: Semantics(liveRegion: true, child: Text(_error!, style: CheType.body)),
              )
            : ListView(
                padding: const EdgeInsets.fromLTRB(CheSpace.lg, CheSpace.sm, CheSpace.lg, CheSpace.xl),
                children: [
                  Semantics(
                    liveRegion: true,
                    child: Text(view?['summary']?.toString() ?? '', style: CheType.body),
                  ),
                  const SizedBox(height: CheSpace.md),
                  for (final room in rooms) _RoomTile(room: room, onOpen: () => _openRoom(room)),
                ],
              );
    if (widget.embedded) {
      return ColoredBox(
        color: CheColors.screen,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(CheSpace.lg, CheSpace.xs, CheSpace.xs, 0),
            child: Row(children: [
              Expanded(
                child: Text('Headquarters', style: CheType.title, maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
              ..._actions(),
            ]),
          ),
          Expanded(child: body),
        ]),
      );
    }
    return Scaffold(
      backgroundColor: CheColors.screen,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: Text('Headquarters', style: CheType.title),
        actions: _actions(),
      ),
      body: SafeArea(child: body),
    );
  }

  List<Widget> _actions() => [
        if (widget.onOpen3D != null)
          TextButton.icon(
            onPressed: widget.onOpen3D,
            icon: const Icon(Icons.view_in_ar),
            label: const Text('Open 3D crew'),
          ),
        IconButton(
          tooltip: 'Refresh the headquarters',
          icon: const Icon(Icons.refresh_rounded),
          onPressed: _loading ? null : _load,
        ),
      ];

  void _openRoom(Map<String, dynamic> room) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => _HeadquartersRoomPage(client: widget.client, roomId: '${room['id']}', initial: room),
    ));
  }
}

class _RoomTile extends StatelessWidget {
  const _RoomTile({required this.room, required this.onOpen});
  final Map<String, dynamic> room;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final name = '${room['name']}';
    final lead = '${room['lead']}';
    final status = '${room['status']}';
    final task = room['task']?.toString();
    final label = '$name, led by $lead. Status: $status.${task == null || task.isEmpty ? '' : ' Current task: $task.'}';
    return Padding(
      padding: const EdgeInsets.only(bottom: CheSpace.sm),
      child: Semantics(
        button: true,
        label: label,
        excludeSemantics: true,
        child: Material(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.xl),
          child: InkWell(
            borderRadius: BorderRadius.circular(CheRadius.xl),
            onTap: onOpen,
            child: Container(
              constraints: const BoxConstraints(minHeight: 44),
              padding: const EdgeInsets.all(CheSpace.md),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(CheRadius.xl),
                border: Border.all(color: CheColors.stroke),
              ),
              child: Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(name, style: CheType.body.copyWith(fontWeight: FontWeight.w700)),
                    const SizedBox(height: CheSpace.xxs),
                    Text('Led by $lead', style: CheType.bodyDim),
                    if (task != null && task.isNotEmpty)
                      Text(task, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.bodyDim),
                  ]),
                ),
                const SizedBox(width: CheSpace.sm),
                Text(status, style: CheType.body.copyWith(color: CheColors.accent, fontWeight: FontWeight.w700)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _HeadquartersRoomPage extends StatefulWidget {
  const _HeadquartersRoomPage({required this.client, required this.roomId, required this.initial});
  final CheAgentRuntimeClient client;
  final String roomId;
  final Map<String, dynamic> initial;

  @override
  State<_HeadquartersRoomPage> createState() => _HeadquartersRoomPageState();
}

class _HeadquartersRoomPageState extends State<_HeadquartersRoomPage> {
  final _text = TextEditingController();
  Map<String, dynamic>? _detail;
  String? _notice;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final detail = await widget.client.hqRoom(widget.roomId);
      if (mounted) setState(() => _detail = detail);
    } catch (_) {
      if (mounted) setState(() => _notice = 'Could not read this room. It may need a fresh connection.');
    }
  }

  void _openJob(String jobId) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => _HeadquartersJobPage(client: widget.client, jobId: jobId),
    ));
  }

  Future<void> _send({required String mode}) async {
    final said = _text.text.trim();
    if (said.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final out = await widget.client.hqTalk(room: widget.roomId, text: said, mode: mode);
      _text.clear();
      if (mounted) setState(() => _notice = out['reply']?.toString());
      await _load();
    } on CheAgentRuntimeException catch (e) {
      if (mounted) setState(() => _notice = e.message);
    } catch (_) {
      if (mounted) setState(() => _notice = 'The message did not reach the room. Nothing was sent or queued.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final room = _detail?['room'] is Map ? Map<String, dynamic>.from(_detail!['room'] as Map) : widget.initial;
    final lead = '${room['lead']}';
    final facts = [for (final f in (_detail?['facts'] as List? ?? const [])) '$f'];
    final conversation = [for (final m in (_detail?['conversation'] as List? ?? const [])) Map<String, dynamic>.from(m as Map)];
    final jobs = [for (final j in (_detail?['jobs'] as List? ?? const [])) Map<String, dynamic>.from(j as Map)];
    return Scaffold(
      backgroundColor: CheColors.screen,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: Text('${room['name']}', style: CheType.title),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(CheSpace.lg, CheSpace.sm, CheSpace.lg, CheSpace.xl),
          children: [
            Semantics(
              header: true,
              child: Text('LEAD: $lead', style: CheType.body.copyWith(fontWeight: FontWeight.w700)),
            ),
            Text('STATUS: ${room['status'] ?? 'Unknown'}', style: CheType.body),
            if (_notice != null) ...[
              const SizedBox(height: CheSpace.md),
              Semantics(liveRegion: true, child: Text(_notice!, style: CheType.body)),
            ],
            const SizedBox(height: CheSpace.lg),
            Text('FROM THE RECORDS', style: CheType.overline.copyWith(color: CheColors.accent)),
            for (final f in facts) Padding(padding: const EdgeInsets.only(top: CheSpace.xs), child: Text(f, style: CheType.bodyDim)),
            const SizedBox(height: CheSpace.lg),
            if (jobs.isNotEmpty) ...[
              Text('OFFICE WORK', style: CheType.overline.copyWith(color: CheColors.accent)),
              for (final j in jobs) _JobCard(job: j, onOpen: () => _openJob('${j['id']}')),
              const SizedBox(height: CheSpace.lg),
            ],
            Text('CONVERSATION', style: CheType.overline.copyWith(color: CheColors.accent)),
            for (final m in conversation)
              Padding(
                padding: const EdgeInsets.only(top: CheSpace.xs),
                child: Text('${m['from'] == 'owner' ? 'You' : m['from']}: ${m['text']}', style: CheType.body),
              ),
            const SizedBox(height: CheSpace.lg),
            TextField(
              controller: _text,
              minLines: 1,
              maxLines: 4,
              style: CheType.body,
              decoration: InputDecoration(labelText: 'Message $lead', hintText: 'Ask $lead, or assign a task'),
            ),
            const SizedBox(height: CheSpace.sm),
            Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.sm, children: [
              FilledButton(
                onPressed: _busy ? null : () => _send(mode: 'talk'),
                child: Text('Send to $lead'),
              ),
              Semantics(
                button: true,
                label: 'Assign a task to $lead',
                child: OutlinedButton(
                  onPressed: _busy ? null : () => _send(mode: 'assign'),
                  child: Text('Assign to $lead'),
                ),
              ),
            ]),
          ],
        ),
      ),
    );
  }
}

/// An Office job the room's head is accountable for: its goal, its stage chain and whether Vale has verified it.
class _JobCard extends StatelessWidget {
  const _JobCard({required this.job, required this.onOpen});
  final Map<String, dynamic> job;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final goal = '${job['goal']}';
    final verification = Map<String, dynamic>.from(job['verification'] as Map? ?? const {});
    final stages = [for (final st in (job['stages'] as List? ?? const [])) Map<String, dynamic>.from(st as Map)];
    final chain = stages.map((st) => '${st['agent']} (${st['discipline']}): ${st['status']}').join(' → ');
    final verified = '${verification['status']}' == 'verified';
    final status = verified ? 'Verified by ${verification['by']}' : 'Not verified yet (${job['status']})';
    return Padding(
      padding: const EdgeInsets.only(bottom: CheSpace.sm),
      child: Semantics(
        button: true,
        label: 'Open result for $goal. $status.',
        excludeSemantics: true,
        child: Material(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.xl),
          child: InkWell(
            borderRadius: BorderRadius.circular(CheRadius.xl),
            onTap: onOpen,
            child: Container(
              constraints: const BoxConstraints(minHeight: 44),
              padding: const EdgeInsets.all(CheSpace.md),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(CheRadius.xl),
                border: Border.all(color: CheColors.stroke),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(goal, style: CheType.body.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: CheSpace.xxs),
                Text(status, style: CheType.bodyDim.copyWith(color: verified ? CheColors.accent : null)),
                Text(chain, style: CheType.bodyDim),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// One Office job in full: the goal, whether it is verified, and each stage's own result.
class _HeadquartersJobPage extends StatefulWidget {
  const _HeadquartersJobPage({required this.client, required this.jobId});
  final CheAgentRuntimeClient client;
  final String jobId;

  @override
  State<_HeadquartersJobPage> createState() => _HeadquartersJobPageState();
}

class _HeadquartersJobPageState extends State<_HeadquartersJobPage> {
  Map<String, dynamic>? _detail;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final detail = await widget.client.hqJob(widget.jobId);
      if (mounted) setState(() => _detail = detail);
    } on CheAgentRuntimeException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'The result could not be read. Check the connection and try again.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final job = _detail?['job'] is Map ? Map<String, dynamic>.from(_detail!['job'] as Map) : const <String, dynamic>{};
    final results = [for (final r in (_detail?['stage_results'] as List? ?? const [])) Map<String, dynamic>.from(r as Map)];
    final verification = Map<String, dynamic>.from(job['verification'] as Map? ?? const {});
    final verified = '${verification['status']}' == 'verified';
    return Scaffold(
      backgroundColor: CheColors.screen,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: Text('Office result', style: CheType.title),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(CheSpace.lg, CheSpace.sm, CheSpace.lg, CheSpace.xl),
          children: [
            if (_error != null) Semantics(liveRegion: true, child: Text(_error!, style: CheType.body)),
            if (_detail == null && _error == null) const Center(child: CircularProgressIndicator()),
            if (_detail != null) ...[
              Semantics(
                header: true,
                child: Text('${job['goal']}', style: CheType.body.copyWith(fontWeight: FontWeight.w700)),
              ),
              Text('STATUS: ${job['status']}', style: CheType.body),
              const SizedBox(height: CheSpace.sm),
              Semantics(
                liveRegion: true,
                child: Text(
                  verified
                      ? 'VERIFIED by ${verification['by']}: ${verification['basis']}'
                      : 'NOT VERIFIED YET. CHE does not report this as done until Vale records a PASS.',
                  style: CheType.body,
                ),
              ),
              const SizedBox(height: CheSpace.lg),
              Text('STAGES', style: CheType.overline.copyWith(color: CheColors.accent)),
              for (final r in results) ...[
                Padding(
                  padding: const EdgeInsets.only(top: CheSpace.sm),
                  child: Text('${r['agent']} (${r['discipline']}): ${r['status']}', style: CheType.body.copyWith(fontWeight: FontWeight.w700)),
                ),
                if ('${r['result']}'.isNotEmpty) SelectableText('${r['result']}', style: CheType.bodyDim),
                if ('${r['error']}'.isNotEmpty) Text('Problem: ${r['error']}', style: CheType.bodyDim),
              ],
            ],
          ],
        ),
      ),
    );
  }
}
