// CHE War Room: a glass conference room where agents draft, cross-check each
// other in character, and CHE chairs and makes the final synthesis. Every line
// on the board is a real message produced by the backend Agent Runtime.

import 'dart:async';

import 'package:flutter/material.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_rooms.dart';
import '../che_ui/che_theme.dart';
import 'che_agent_runtime.dart';
import '../widgets/che_3d_room_view.dart';

class CheWarRoomScreen extends StatefulWidget {
  const CheWarRoomScreen({super.key, required this.client, required this.meetingId});
  final CheAgentRuntimeClient client;
  final String meetingId;
  @override
  State<CheWarRoomScreen> createState() => _CheWarRoomScreenState();
}

class _CheWarRoomScreenState extends State<CheWarRoomScreen> {
  static const _amber = Color(0xFFE8B04A);

  CheMeeting? _meeting;
  Map<String, CheAgent> _agents = const {};
  String? _error;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([widget.client.meeting(widget.meetingId), widget.client.roster()]);
      final meeting = results[0] as CheMeeting;
      final roster = results[1] as Map<String, dynamic>;
      _agents = {
        for (final a in (roster['agents'] as List? ?? const []))
          if (a is Map<String, dynamic>) '${a['id']}': CheAgent.fromJson(a),
      };
      _meeting = meeting;
      _error = null;
    } catch (e) {
      _error = '$e';
    }
    if (!mounted) return;
    setState(() {});
    _timer?.cancel();
    if (_meeting?.summary.live ?? true) {
      _timer = Timer(const Duration(milliseconds: 1500), () => unawaited(_load()));
    }
  }

  CheAgent _seat(({String agentId, String name, String role, String responsibility}) p) =>
      _agents[p.agentId] ??
      CheAgent(id: p.agentId, name: p.name, role: p.role, status: CheAgentStatus.offline);

  @override
  Widget build(BuildContext context) {
    final m = _meeting;
    // The most recent speaker on the board is highlighted at the table.
    final speaking = m?.board.isNotEmpty == true ? m!.board.last.from : null;
    return Theme(
      data: CheTheme.dark(),
      child: Scaffold(
        backgroundColor: CheColors.bg,
        appBar: AppBar(backgroundColor: Colors.transparent, title: const Text('War Room')),
        body: SafeArea(
          top: false,
          child: m == null
              ? Center(
                  child: _error == null
                      ? const CircularProgressIndicator()
                      : Padding(padding: const EdgeInsets.all(CheSpace.xl), child: Text(_error!, style: CheType.bodyDim)),
                )
              : ListView(
                  padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl),
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(CheRadius.xl),
                      child: CheRoomBackdrop(
                        room: CheRoom.conference,
                        scrim: 0.45,
                        child: Padding(
                          padding: const EdgeInsets.all(CheSpace.md),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                            Text('OBJECTIVE', style: CheType.overline.copyWith(color: _amber)),
                            const SizedBox(height: CheSpace.xs),
                            Text(m.summary.objective, style: CheType.headline.copyWith(color: Colors.white)),
                            const SizedBox(height: CheSpace.md),
                            _WarRoom3D(
                              meeting: m,
                              agents: _agents,
                              speaking: speaking,
                              onFallbackSeats: () => Wrap(
                                alignment: WrapAlignment.center,
                                spacing: CheSpace.sm,
                                runSpacing: CheSpace.sm,
                                children: [
                                  _Seat(agent: CheAgent.che(status: m.summary.status == 'synthesizing' ? CheAgentStatus.reviewing : CheAgentStatus.meeting), speaking: speaking == 'CHE', role: 'Office Boss'),
                                  for (final p in m.participants) _Seat(agent: _seat(p), speaking: speaking == p.name, role: p.role),
                                ],
                              ),
                            ),
                            const SizedBox(height: CheSpace.md),
                            Row(children: [
                              Expanded(
                                child: Text(m.summary.statusLabel,
                                    maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(color: Colors.white)),
                              ),
                              Text('${(m.summary.progress * 100).round()}%', style: CheType.caption.copyWith(color: Colors.white70)),
                            ]),
                            const SizedBox(height: CheSpace.xs),
                            LinearProgressIndicator(value: m.summary.progress, color: _amber, backgroundColor: Colors.white12),
                          ]),
                        ),
                      ),
                    ),
                    if (m.error.isNotEmpty) ...[
                      const SizedBox(height: CheSpace.md),
                      Text(m.error, style: CheType.label.copyWith(color: CheColors.danger)),
                    ],
                    if (m.finalPlan.isNotEmpty) ...[
                      const SizedBox(height: CheSpace.lg),
                      _Block(title: 'FINAL PLAN', color: CheColors.accent, child: SelectableText(m.finalPlan, style: CheType.body)),
                    ],
                    if (m.decisions.isNotEmpty) _ListBlock(title: 'DECISIONS', color: CheColors.success, items: m.decisions),
                    if (m.conflicts.isNotEmpty) _ListBlock(title: 'CONFLICTS', color: CheColors.warning, items: m.conflicts),
                    if (m.recommendations.isNotEmpty) _ListBlock(title: 'RECOMMENDATIONS', color: CheColors.accentAlt, items: m.recommendations),
                    const SizedBox(height: CheSpace.lg),
                    Text('RESPONSIBILITIES', style: CheType.overline),
                    const SizedBox(height: CheSpace.xs),
                    for (final p in m.participants)
                      Padding(
                        padding: const EdgeInsets.only(bottom: CheSpace.xs),
                        child: Text('${p.name} — ${p.responsibility}', style: CheType.bodyDim),
                      ),
                    const SizedBox(height: CheSpace.lg),
                    Text('MEETING BOARD', style: CheType.overline),
                    const SizedBox(height: CheSpace.sm),
                    for (final post in m.board) _Post(post: post, agent: post.agentId == null ? null : _agents[post.agentId]),
                    if (m.summary.live)
                      Padding(
                        padding: const EdgeInsets.all(CheSpace.md),
                        child: Row(children: [
                          const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: _amber)),
                          const SizedBox(width: CheSpace.sm),
                          Expanded(child: Text('${m.summary.statusLabel}…', style: CheType.caption)),
                        ]),
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _Seat extends StatelessWidget {
  const _Seat({required this.agent, required this.speaking, required this.role});
  final CheAgent agent;
  final bool speaking;
  final String role;
  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: CheMotion.base,
      width: 84,
      padding: const EdgeInsets.all(CheSpace.xs),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: speaking ? const Color(0xFFE8B04A) : Colors.white12, width: speaking ? 2 : 1),
      ),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        CheMiniPerson(agent: agent, size: 48),
        Text(agent.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(color: Colors.white)),
        Text(role, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption.copyWith(color: Colors.white60, fontSize: 10)),
      ]),
    );
  }
}

class _Post extends StatelessWidget {
  const _Post({required this.post, this.agent});
  final CheMeetingPost post;
  final CheAgent? agent;
  @override
  Widget build(BuildContext context) {
    final isChe = post.from == 'CHE';
    final color = isChe ? CheColors.accent : (agent?.color ?? CheColors.office);
    final label = switch (post.kind) {
      'draft' => 'draft',
      'critique' => post.to != null ? '→ ${post.to}' : 'cross-check',
      'synthesis' => 'final synthesis',
      'brief' => 'brief',
      _ => post.kind,
    };
    return Container(
      margin: const EdgeInsets.only(bottom: CheSpace.sm),
      padding: const EdgeInsets.all(CheSpace.md),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Flexible(child: Text(post.from, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(color: color))),
          const SizedBox(width: CheSpace.sm),
          Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption)),
        ]),
        const SizedBox(height: CheSpace.xs),
        SelectableText(post.text, style: CheType.body),
      ]),
    );
  }
}

class _Block extends StatelessWidget {
  const _Block({required this.title, required this.color, required this.child});
  final String title;
  final Color color;
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: CheSpace.md),
        padding: const EdgeInsets.all(CheSpace.md),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.07),
          borderRadius: BorderRadius.circular(CheRadius.md),
          border: Border.all(color: color.withValues(alpha: 0.4)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: CheType.overline.copyWith(color: color)),
          const SizedBox(height: CheSpace.xs),
          child,
        ]),
      );
}

class _ListBlock extends StatelessWidget {
  const _ListBlock({required this.title, required this.color, required this.items});
  final String title;
  final Color color;
  final List<String> items;
  @override
  Widget build(BuildContext context) => _Block(
        title: title,
        color: color,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [for (final i in items) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text('• $i', style: CheType.body))],
        ),
      );
}


class _WarRoom3D extends StatefulWidget {
  const _WarRoom3D({
    required this.meeting,
    required this.agents,
    required this.speaking,
    required this.onFallbackSeats,
  });
  final CheMeeting meeting;
  final Map<String, CheAgent> agents;
  final String? speaking;
  final Widget Function() onFallbackSeats;
  @override
  State<_WarRoom3D> createState() => _WarRoom3DState();
}

class _WarRoom3DState extends State<_WarRoom3D> {
  bool _flat = false;

  Map<String, dynamic> _payload() {
    final m = widget.meeting;
    final speaking = widget.speaking;
    final agents = <Map<String, dynamic>>[
      {
        'id': 'che',
        'name': 'CHE',
        'role': 'Chair',
        'status': m.summary.status == 'synthesizing' ? 'thinking' : 'working',
        'isChe': true,
        'speaking': speaking == 'CHE',
      },
      for (final p in m.participants)
        {
          'id': p.agentId,
          'name': p.name,
          'role': p.role,
          'status': speaking == p.name ? 'talking' : 'working',
          'speaking': speaking == p.name,
          'isChe': false,
        },
    ];
    return {
      'objective': m.summary.objective,
      'status': m.summary.status,
      'progress': m.summary.progress,
      'agents': agents,
    };
  }

  @override
  Widget build(BuildContext context) {
    if (_flat) return widget.onFallbackSeats();
    return Column(
      children: [
        Che3DRoomView(
          assetPath: 'assets/office3d/warroom.html',
          updateFunction: 'updateMeeting',
          payload: _payload(),
          height: 360,
          semanticsLabel: '3D War Room conference table',
          fallbackMessage: '3D War Room unavailable — showing seats.',
          onTapId: (_) {},
        ),
        TextButton(
          onPressed: () => setState(() => _flat = true),
          child: const Text('Flat seats'),
        ),
      ],
    );
  }
}
