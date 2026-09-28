import 'dart:math' as math;
import 'package:flutter/material.dart';

class OfficeScene extends StatefulWidget {
  const OfficeScene({
    super.key,
    required this.active,
    required this.team,
    required this.teamTasks,
    required this.backgroundJobs,
    required this.onAddPartner,
    required this.onOpenPartner,
    this.onOpenFloor,
  });

  final bool active;
  final List<Map<String, dynamic>> team;
  final List<Map<String, dynamic>> teamTasks;
  final List<Map<String, dynamic>> backgroundJobs;
  final VoidCallback onAddPartner;
  final void Function(Map<String, dynamic> partner) onOpenPartner;

  /// Opens the live Office floor (agents at desks, War Room).
  final VoidCallback? onOpenFloor;

  @override
  State<OfficeScene> createState() => _OfficeSceneState();
}

class _OfficeSceneState extends State<OfficeScene>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 7),
    );
    if (widget.active) _controller.repeat();
  }

  @override
  void didUpdateWidget(covariant OfficeScene oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !_controller.isAnimating) {
      _controller.repeat();
    } else if (!widget.active && _controller.isAnimating) {
      _controller.stop();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Color _skyTop() {
    final hour = DateTime.now().hour;
    if (hour >= 6 && hour < 10) return const Color(0xFFD89476);
    if (hour >= 10 && hour < 17) return const Color(0xFF5798C3);
    if (hour >= 17 && hour < 20) return const Color(0xFF8A567B);
    return const Color(0xFF14294A);
  }

  @override
  Widget build(BuildContext context) {
    final newPartners = widget.team.where((item) => item['introduced'] != true).length;
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        final phase = _controller.value;
        return DecoratedBox(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              colors: [Color(0xFF11171D), Color(0xFF0B1116)],
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
            ),
          ),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 16, 14, 28),
            children: [
              Row(
                children: [
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'REAL WORKPLACE',
                          style: TextStyle(
                            color: Color(0xFF67E8D1),
                            fontSize: 12,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 1.5,
                          ),
                        ),
                        SizedBox(height: 4),
                        Text(
                          'CHE’s internal AI coworkers for delegated and parallel work.',
                          style: TextStyle(color: Colors.white54, fontSize: 12),
                        ),
                      ],
                    ),
                  ),
                  if (newPartners > 0)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
                      decoration: BoxDecoration(
                        color: const Color(0xFF67E8D1),
                        borderRadius: BorderRadius.circular(99),
                      ),
                      child: Text(
                        '$newPartners NEW',
                        style: const TextStyle(
                          color: Color(0xFF071318),
                          fontSize: 9,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 14),
              Container(
                height: 220,
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: const Color(0xFF202930),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: Colors.white10),
                ),
                child: Stack(
                  children: [
                    Positioned(
                      right: 14,
                      top: 12,
                      width: 116,
                      height: 76,
                      child: Container(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            colors: [_skyTop(), const Color(0xFF263A4A)],
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                          ),
                          borderRadius: BorderRadius.circular(5),
                          border: Border.all(color: Colors.white24),
                        ),
                      ),
                    ),
                    Positioned(
                      left: 18,
                      top: 27,
                      width: 186,
                      height: 108,
                      child: Container(
                        decoration: BoxDecoration(
                          color: const Color(0xFF0E1318),
                          borderRadius: BorderRadius.circular(9),
                          border: Border.all(color: const Color(0xFF465461)),
                        ),
                        child: Stack(
                          children: [
                            const Center(
                              child: Text(
                                'CHE OFFICE',
                                style: TextStyle(
                                  color: Color(0xFF67E8D1),
                                  fontWeight: FontWeight.w900,
                                  letterSpacing: 1.4,
                                ),
                              ),
                            ),
                            for (var i = 0;
                                i < math.min(widget.teamTasks.length, 3);
                                i++)
                              Positioned(
                                left: 10.0 + i * 52,
                                bottom: 8,
                                child: _StickyNote(
                                  text: widget.teamTasks[i]['task']?.toString() ??
                                      'Task',
                                  compact: true,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      height: 76,
                      child: Container(
                        decoration: const BoxDecoration(
                          gradient: LinearGradient(
                            colors: [Color(0xFF70472C), Color(0xFF382416)],
                          ),
                        ),
                      ),
                    ),
                    Positioned(
                      right: 22,
                      bottom: 21,
                      child: _CoffeeMug(phase: phase),
                    ),
                    Positioned(
                      left: 225,
                      bottom: 25,
                      child: _DeskLamp(phase: phase),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              if (widget.onOpenFloor != null) ...[
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: widget.onOpenFloor,
                    icon: const Icon(Icons.meeting_room_rounded),
                    label: const Text('ENTER THE OFFICE FLOOR + WAR ROOM'),
                  ),
                ),
                const SizedBox(height: 10),
              ],
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '${widget.team.length} AI coworker${widget.team.length == 1 ? '' : 's'} • ${widget.teamTasks.length} tracked assignment${widget.teamTasks.length == 1 ? '' : 's'}',
                      style: const TextStyle(color: Colors.white54, fontSize: 11),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: widget.onAddPartner,
                    icon: const Icon(Icons.person_add_alt_1_outlined, size: 18),
                    label: const Text('ADD PARTNER'),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              if (widget.team.isEmpty)
                const _DeskPaper(
                  title: 'Office is ready',
                  body:
                      'CHE will staff specialist AI coworkers when a task benefits from delegation, or you can add one yourself.',
                  icon: Icons.groups_outlined,
                )
              else
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: widget.team.map((partner) {
                    return SizedBox(
                      width: (MediaQuery.sizeOf(context).width - 38) / 2,
                      child: _PartnerFolder(
                        partner: partner,
                        onTap: () => widget.onOpenPartner(partner),
                      ),
                    );
                  }).toList(),
                ),
              if (widget.backgroundJobs.isNotEmpty) ...[
                const SizedBox(height: 18),
                const Text(
                  'BACKGROUND WORK',
                  style: TextStyle(
                    color: Colors.white54,
                    fontSize: 11,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 1.1,
                  ),
                ),
                const SizedBox(height: 8),
                ...widget.backgroundJobs.take(6).map((job) {
                  final status = job['status']?.toString() ?? 'queued';
                  final result = job['result']?.toString() ?? '';
                  final error = job['error']?.toString() ?? '';
                  return _DeskPaper(
                    title: job['title']?.toString() ?? 'CHE background job',
                    body: result.isNotEmpty
                        ? '$status\n$result'
                        : error.isNotEmpty
                            ? '$status\n$error'
                            : status,
                    icon: status == 'complete'
                        ? Icons.check_circle_outline
                        : status == 'failed'
                            ? Icons.error_outline
                            : Icons.sync,
                  );
                }),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _PartnerFolder extends StatelessWidget {
  const _PartnerFolder({required this.partner, required this.onTap});

  final Map<String, dynamic> partner;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final name = partner['name']?.toString() ?? 'CHE Partner';
    final role = partner['role']?.toString() ?? 'AI coworker';
    final specialty = partner['specialty']?.toString() ?? '';
    final isNew = partner['introduced'] != true;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 122,
        padding: const EdgeInsets.fromLTRB(12, 15, 12, 10),
        decoration: BoxDecoration(
          color: const Color(0xFFB98C50),
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(4),
            topRight: Radius.circular(12),
            bottomLeft: Radius.circular(6),
            bottomRight: Radius.circular(6),
          ),
          boxShadow: const [
            BoxShadow(color: Colors.black38, blurRadius: 12, offset: Offset(0, 7)),
          ],
        ),
        child: Stack(
          children: [
            Positioned(
              left: 0,
              top: -9,
              child: Container(
                width: 56,
                height: 15,
                decoration: const BoxDecoration(
                  color: Color(0xFFD4AA6A),
                  borderRadius: BorderRadius.vertical(top: Radius.circular(5)),
                ),
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.smart_toy_outlined, size: 18),
                    if (isNew) ...[
                      const Spacer(),
                      const Text(
                        'NEW',
                        style: TextStyle(fontSize: 8, fontWeight: FontWeight.w900),
                      ),
                    ],
                  ],
                ),
                const Spacer(),
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF27180D),
                    fontSize: 12,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                Text(
                  specialty.isEmpty ? role : '$role • $specialty',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xAA27180D),
                    fontSize: 9.5,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _DeskPaper extends StatelessWidget {
  const _DeskPaper({
    required this.title,
    required this.body,
    required this.icon,
  });

  final String title;
  final String body;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 9),
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: const Color(0xFFF2E7CF).withValues(alpha: .12),
        borderRadius: BorderRadius.circular(5),
        border: Border.all(color: Colors.white12),
      ),
      child: Row(
        children: [
          Icon(icon, color: const Color(0xFFFFD38D), size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
                const SizedBox(height: 3),
                Text(
                  body,
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white54, fontSize: 11),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StickyNote extends StatelessWidget {
  const _StickyNote({required this.text, this.compact = false});
  final String text;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Transform.rotate(
      angle: -.03,
      child: Container(
        width: compact ? 42 : 74,
        height: compact ? 32 : 62,
        padding: const EdgeInsets.all(4),
        color: const Color(0xFFFFE17B),
        child: Text(
          text,
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: const Color(0xFF302B16),
            fontSize: compact ? 5.8 : 9,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}

class _CoffeeMug extends StatelessWidget {
  const _CoffeeMug({required this.phase});
  final double phase;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 56,
      height: 66,
      child: Stack(
        children: [
          Positioned(
            left: 14,
            top: 0,
            child: Transform.translate(
              offset: Offset(math.sin(phase * math.pi * 2) * 3, -phase * 7),
              child: const Text(
                '~~~',
                style: TextStyle(color: Colors.white24, fontSize: 12),
              ),
            ),
          ),
          Positioned(
            left: 5,
            bottom: 0,
            child: Container(
              width: 42,
              height: 36,
              decoration: BoxDecoration(
                color: const Color(0xFF27313B),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.white12),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DeskLamp extends StatelessWidget {
  const _DeskLamp({required this.phase});
  final double phase;

  @override
  Widget build(BuildContext context) {
    final glow = .16 + math.sin(phase * math.pi * 2) * .03;
    return SizedBox(
      width: 62,
      height: 86,
      child: Stack(
        children: [
          Positioned(
            left: 28,
            top: 20,
            child: Container(width: 4, height: 51, color: Colors.white24),
          ),
          Positioned(
            left: 12,
            top: 0,
            child: Container(
              width: 38,
              height: 24,
              decoration: const BoxDecoration(
                color: Color(0xFF272A2D),
                borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
              ),
            ),
          ),
          Positioned(
            left: 0,
            top: 10,
            child: Container(
              width: 60,
              height: 72,
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: Alignment.topCenter,
                  colors: [
                    const Color(0xFFFFD28B).withValues(alpha: glow),
                    Colors.transparent,
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
