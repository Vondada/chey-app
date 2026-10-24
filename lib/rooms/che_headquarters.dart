// CHE's headquarters (owner mission, 2026-10-24): every room with its department head, the head's real status from
// the Office records, and a conversation with the head inside the room. The 3D crew is one tap away; this list is the
// accessible version of the same rooms and works without it. Nothing here shows work that the records do not hold.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../agents/che_agent_runtime.dart';
import '../che_ui/che_theme.dart';

class CheHeadquartersScreen extends StatefulWidget {
  const CheHeadquartersScreen({super.key, required this.client, this.onOpen3D, this.onPreviewRoom, this.embedded = false});

  final CheAgentRuntimeClient client;

  /// Opens the 3D crew (CheCharactersRoom). Shown only when the caller has one.
  final VoidCallback? onOpen3D;

  /// Shows a room CHE proposed in the 3D scene so the owner can walk through it. Shown only when the caller has one.
  final void Function(Map<String, dynamic> proposal)? onPreviewRoom;

  /// True inside the Office tab: no second app bar; the title and actions sit in a row above the rooms.
  final bool embedded;

  @override
  State<CheHeadquartersScreen> createState() => _CheHeadquartersScreenState();
}

class _CheHeadquartersScreenState extends State<CheHeadquartersScreen> {
  Map<String, dynamic>? _view;
  String? _error;
  bool _loading = true;
  List<Map<String, dynamic>> _proposals = const [];
  String? _proposalError;
  String? _notice;
  bool _busy = false;

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
      await _loadProposals();
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
    final open = [for (final p in _proposals) if (p['status'] == 'proposed' || p['status'] == 'failed_verification') p];
    final preview = widget.onPreviewRoom;
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
                  FilledButton.icon(
                    onPressed: _busy ? null : _askForRoom,
                    icon: const Icon(Icons.add_rounded),
                    label: const Text('Ask CHE for a room'),
                  ),
                  if (_notice != null) ...[
                    const SizedBox(height: CheSpace.md),
                    Semantics(liveRegion: true, child: Text(_notice!, style: CheType.body)),
                  ],
                  if (_proposalError != null) ...[
                    const SizedBox(height: CheSpace.sm),
                    Text(_proposalError!, style: CheType.bodyDim),
                  ],
                  if (open.isNotEmpty) ...[
                    const SizedBox(height: CheSpace.lg),
                    Text('PROPOSED ROOMS', style: CheType.overline.copyWith(color: CheColors.accent)),
                    const SizedBox(height: CheSpace.xs),
                    for (final p in open)
                      _ProposalCard(
                        proposal: p,
                        busy: _busy,
                        onPreview: preview == null ? null : () => preview(p),
                        onApprove: () => _approve(p),
                        onChangeName: () => _changeName(p),
                        onReject: () => _reject(p),
                      ),
                  ],
                  const SizedBox(height: CheSpace.lg),
                  Text('ROOMS', style: CheType.overline.copyWith(color: CheColors.accent)),
                  const SizedBox(height: CheSpace.xs),
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

  Future<void> _openRoom(Map<String, dynamic> room) async {
    final notice = await Navigator.of(context).push<String>(MaterialPageRoute<String>(
      builder: (_) => _HeadquartersRoomPage(client: widget.client, roomId: '${room['id']}', initial: room),
    ));
    if (!mounted) return;
    if (notice != null) setState(() => _notice = notice);
    await _load();
  }

  Future<void> _loadProposals() async {
    try {
      final out = await widget.client.roomProposals();
      if (!mounted) return;
      setState(() {
        _proposals = [for (final p in (out['proposals'] as List? ?? const [])) Map<String, dynamic>.from(p as Map)];
        _proposalError = null;
      });
    } catch (_) {
      if (mounted) setState(() => _proposalError = 'The room proposals could not be read. Refresh to try again.');
    }
  }

  /// One owner decision: a busy lock, one reported result, then a reload of the records it changed.
  Future<void> _act(Future<Map<String, dynamic>> Function() call, String Function(Map<String, dynamic> out) report) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    var succeeded = false;
    try {
      final out = await call();
      if (mounted) setState(() => _notice = report(out));
      succeeded = true;
    } on CheAgentRuntimeException catch (e) {
      if (mounted) setState(() => _notice = e.message);
    } catch (_) {
      if (mounted) setState(() => _notice = 'Nothing changed. The request did not reach CHE. Check the connection and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (succeeded) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.vibrate();
    }
    await _load();
  }

  Future<void> _askForRoom() async {
    final need = await showDialog<String>(
      context: context,
      builder: (_) => const _TextPromptDialog(
        title: 'Ask CHE for a room',
        label: 'Describe the room',
        hint: 'For example: a robotics lab',
        action: 'Ask CHE',
      ),
    );
    if (need == null || !mounted) return;
    await _act(() => widget.client.proposeRoom(need), (out) {
      final name = _roomName(_asMap(out['proposal']));
      return out['reused'] == true
          ? 'CHE already has an open proposal for the $name. Review it below.'
          : "Sir, I've developed a proposal for a new $name. Would you like to review it?";
    });
  }

  Future<void> _approve(Map<String, dynamic> proposal) async {
    final name = _roomName(proposal);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Build the $name?'),
        content: Text(
          'CHE builds the room with ${_leadName(proposal)} as lead, runs its checks, and adds it to the headquarters only if every check passes. Nothing is bought, ordered or connected.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Not yet')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Build and verify')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    await _act(() => widget.client.decideRoomProposal('${proposal['id']}', 'approve'), (out) {
      final p = _asMap(out['proposal']);
      if (p['status'] == 'active') {
        final count = _checksOf(p).length;
        return 'Verified: $count of $count checks passed. The ${_roomName(p)} is in the headquarters.';
      }
      return _notActivatedLine(p);
    });
  }

  Future<void> _changeName(Map<String, dynamic> proposal) async {
    final current = _roomName(proposal);
    final name = await showDialog<String>(
      context: context,
      builder: (_) => _TextPromptDialog(title: 'Change the room name', label: 'Room name', initial: current, action: 'Save name'),
    );
    if (name == null || name == current || !mounted) return;
    await _act(
      () => widget.client.decideRoomProposal('${proposal['id']}', 'modify', changes: {'name': name}),
      (out) => 'Changed the name to ${_roomName(_asMap(out['proposal']))}. Waiting for your approval again.',
    );
  }

  Future<void> _reject(Map<String, dynamic> proposal) => _act(
        () => widget.client.decideRoomProposal('${proposal['id']}', 'reject'),
        (_) => 'Rejected the ${_roomName(proposal)} proposal. Nothing was built.',
      );
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

  Future<void> _rollBack(Map<String, dynamic> room) async {
    final name = '${room['name']}';
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Roll back the $name?'),
        content: const Text('CHE restores the room to its earlier version. A room with no earlier version leaves the headquarters. Nothing is deleted.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Not now')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Roll back')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final out = await widget.client.rollBackRoom('${room['id']}');
      if (!mounted) return;
      HapticFeedback.mediumImpact();
      final report = out['rolled_back_to'] != null ? 'Rolled back the $name to version ${out['rolled_back_to']}.' : '${out['note'] ?? 'Rolled back.'}';
      Navigator.of(context).pop(report);
      return;
    } on CheAgentRuntimeException catch (e) {
      if (mounted) setState(() => _notice = e.message);
    } catch (_) {
      if (mounted) setState(() => _notice = 'Nothing was rolled back. The request did not reach CHE. Check the connection and try again.');
    }
    HapticFeedback.vibrate();
    if (mounted) setState(() => _busy = false);
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
            if (room['custom'] == true) ...[
              const SizedBox(height: CheSpace.lg),
              Text('BUILT FROM AN APPROVED PROPOSAL', style: CheType.overline.copyWith(color: CheColors.accent)),
              const SizedBox(height: CheSpace.xs),
              Text(
                "Rolling back restores the room's earlier version. A room with no earlier version leaves the headquarters.",
                style: CheType.bodyDim,
              ),
              const SizedBox(height: CheSpace.sm),
              Semantics(
                button: true,
                label: 'Roll back ${room['name']}',
                child: OutlinedButton.icon(
                  onPressed: _busy ? null : () => _rollBack(room),
                  icon: const Icon(Icons.undo_rounded),
                  label: Text('Roll back ${room['name']}'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

Map<String, dynamic> _asMap(Object? value) => value is Map ? Map<String, dynamic>.from(value) : const <String, dynamic>{};

String _roomName(Map<String, dynamic> proposal) => '${_asMap(proposal['room'])['name']}';

String _leadName(Map<String, dynamic> proposal) => '${_asMap(proposal['lead'])['name']}';

/// The checks CHE ran on a room, each with its pass or fail.
List<Map<String, dynamic>> _checksOf(Map<String, dynamic> proposal) => [
      for (final c in (_asMap(proposal['verification'])['checks'] as List? ?? const [])) _asMap(c),
    ];

/// What the owner hears and reads when a room is not activated: the checks that failed.
String _notActivatedLine(Map<String, dynamic> proposal) {
  final failed = _checksOf(proposal).where((c) => c['passed'] != true).map((c) => '${c['check']}').join('; ');
  return 'Not activated. Failed: ${failed.isEmpty ? 'verification did not finish' : failed}.';
}

/// A room CHE proposed, in words the owner can hear and read: its layout, tools, equipment, cost and what waits for approval.
class _ProposalCard extends StatelessWidget {
  const _ProposalCard({
    required this.proposal,
    required this.busy,
    required this.onPreview,
    required this.onApprove,
    required this.onChangeName,
    required this.onReject,
  });

  final Map<String, dynamic> proposal;
  final bool busy;
  final VoidCallback? onPreview;
  final VoidCallback onApprove;
  final VoidCallback onChangeName;
  final VoidCallback onReject;

  @override
  Widget build(BuildContext context) {
    final room = _asMap(proposal['room']);
    final lead = _asMap(proposal['lead']);
    final name = _roomName(proposal);
    final layout = [for (final item in (proposal['layout'] as List? ?? const [])) '${_asMap(item)['label']}'];
    final tools = [
      for (final t in (proposal['tools'] as List? ?? const []))
        '${_asMap(t)['name']} ${_asMap(t)['connected'] == true ? 'connected' : 'not connected'}',
    ];
    final approvals = [for (final a in (proposal['approvals'] as List? ?? const [])) '$a'];
    final pending = proposal['status'] == 'proposed';
    final rosterNote = lead['on_roster'] == true ? '' : ' ${lead['name']} is not on the roster yet.';
    return Padding(
      padding: const EdgeInsets.only(bottom: CheSpace.sm),
      child: Container(
        padding: const EdgeInsets.all(CheSpace.md),
        decoration: BoxDecoration(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.xl),
          border: Border.all(color: CheColors.accent),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(header: true, child: Text(name, style: CheType.body.copyWith(fontWeight: FontWeight.w700))),
          const SizedBox(height: CheSpace.xxs),
          Text('Asked for: ${proposal['need']}', style: CheType.bodyDim),
          Text('Purpose: ${room['purpose']}', style: CheType.bodyDim),
          Text('Lead: ${lead['name']}. ${lead['reason']}$rosterNote', style: CheType.bodyDim),
          Text('Layout: ${layout.join(', ')}.', style: CheType.bodyDim),
          Text('Tools: ${tools.join('; ')}.', style: CheType.bodyDim),
          Text('Cost: ${_asMap(proposal['cost'])['note']}', style: CheType.bodyDim),
          Text('Needs your approval: ${approvals.join('; ')}.', style: CheType.bodyDim),
          const SizedBox(height: CheSpace.xs),
          Text(
            pending
                ? 'Waiting for your decision: approve, change the name, or reject.'
                : proposal['status'] == 'failed_verification'
                    ? _notActivatedLine(proposal)
                    : 'Status: ${proposal['status']}.',
            style: CheType.body.copyWith(color: CheColors.accent),
          ),
          if (pending) ...[
            const SizedBox(height: CheSpace.sm),
            Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.sm, children: [
              if (onPreview != null)
                Semantics(
                  button: true,
                  label: 'Preview the $name in 3D',
                  child: OutlinedButton.icon(onPressed: onPreview, icon: const Icon(Icons.view_in_ar), label: const Text('Preview in 3D')),
                ),
              Semantics(
                button: true,
                label: 'Approve the $name',
                child: FilledButton(onPressed: busy ? null : onApprove, child: const Text('Approve')),
              ),
              Semantics(
                button: true,
                label: 'Change the name of the $name',
                child: OutlinedButton(onPressed: busy ? null : onChangeName, child: const Text('Change name')),
              ),
              Semantics(
                button: true,
                label: 'Reject the $name proposal',
                child: OutlinedButton(onPressed: busy ? null : onReject, child: const Text('Reject')),
              ),
            ]),
          ],
        ]),
      ),
    );
  }
}

/// A one-field prompt in a dialog: the owner types or dictates the words, then confirms or cancels.
class _TextPromptDialog extends StatefulWidget {
  const _TextPromptDialog({required this.title, required this.label, required this.action, this.initial = '', this.hint});

  final String title;
  final String label;
  final String action;
  final String initial;
  final String? hint;

  @override
  State<_TextPromptDialog> createState() => _TextPromptDialogState();
}

class _TextPromptDialogState extends State<_TextPromptDialog> {
  late final _text = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _submit() {
    final value = _text.text.trim();
    Navigator.pop(context, value.isEmpty ? null : value);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _text,
        autofocus: true,
        minLines: 1,
        maxLines: 3,
        style: CheType.body,
        decoration: InputDecoration(labelText: widget.label, hintText: widget.hint),
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _submit, child: Text(widget.action)),
      ],
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
