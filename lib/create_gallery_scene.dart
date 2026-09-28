import 'dart:math' as math;
import 'package:flutter/material.dart';

class CreateGalleryScene extends StatefulWidget {
  const CreateGalleryScene({
    super.key,
    required this.active,
    required this.projects,
    required this.vaultCount,
    required this.researchConnected,
    required this.imageConnected,
    required this.videoConnected,
    required this.onNewProject,
    required this.onOpenProject,
    required this.onVault,
    required this.onResearch,
    required this.onImage,
    required this.onVideo,
  });

  final bool active;
  final List<Map<String, dynamic>> projects;
  final int vaultCount;
  final bool researchConnected;
  final bool imageConnected;
  final bool videoConnected;
  final VoidCallback onNewProject;
  final Future<void> Function(Map<String, dynamic> project) onOpenProject;
  final VoidCallback onVault;
  final VoidCallback onResearch;
  final VoidCallback onImage;
  final VoidCallback onVideo;

  @override
  State<CreateGalleryScene> createState() => _CreateGallerySceneState();
}

class _CreateGallerySceneState extends State<CreateGalleryScene>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  static const _teal = Color(0xFF67E8D1);

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 8),
    );
    if (widget.active) _controller.repeat();
  }

  @override
  void didUpdateWidget(covariant CreateGalleryScene oldWidget) {
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

  String _projectDate(Map<String, dynamic> project) {
    final raw = project['updated_at']?.toString() ??
        project['created_at']?.toString() ??
        '';
    final date = DateTime.tryParse(raw);
    if (date == null) return 'CHE COLLECTION';
    const months = [
      'JAN',
      'FEB',
      'MAR',
      'APR',
      'MAY',
      'JUN',
      'JUL',
      'AUG',
      'SEP',
      'OCT',
      'NOV',
      'DEC',
    ];
    return '${months[date.month - 1]} ${date.day}, ${date.year}';
  }

  Future<void> _showProject(Map<String, dynamic> project, int index) async {
    final tag = 'che-project-${project['id'] ?? index}';
    await Navigator.of(context).push(
      PageRouteBuilder<void>(
        transitionDuration: const Duration(milliseconds: 420),
        reverseTransitionDuration: const Duration(milliseconds: 320),
        pageBuilder: (context, animation, secondaryAnimation) {
          return FadeTransition(
            opacity: animation,
            child: _GalleryProjectPage(
              heroTag: tag,
              project: project,
              dateLabel: _projectDate(project),
              onEdit: () async {
                Navigator.of(context).pop();
                await widget.onOpenProject(project);
              },
            ),
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final phase = _controller.value;
        return DecoratedBox(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              colors: [
                Color(0xFF242422),
                Color(0xFF171A1C),
              ],
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
            ),
          ),
          child: SafeArea(
            top: false,
            child: Stack(
              children: [
                Positioned.fill(
                  child: CustomPaint(
                    painter: _GalleryRoomPainter(phase: phase),
                  ),
                ),
                SingleChildScrollView(
                  physics: const BouncingScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(16, 15, 16, 32),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'CHE ART GALLERY',
                                  style: TextStyle(
                                    color: _teal,
                                    fontSize: 12,
                                    fontWeight: FontWeight.w900,
                                    letterSpacing: 1.5,
                                  ),
                                ),
                                SizedBox(height: 3),
                                Text(
                                  'Projects hang here like finished and evolving pieces.',
                                  style: TextStyle(
                                    color: Colors.white60,
                                    fontSize: 11.5,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          FilledButton.icon(
                            onPressed: widget.onNewProject,
                            icon: const Icon(Icons.add, size: 18),
                            label: const Text('NEW'),
                          ),
                        ],
                      ),
                      const SizedBox(height: 18),
                      if (widget.projects.isEmpty)
                        const _EmptyGalleryFrame()
                      else
                        GridView.builder(
                          shrinkWrap: true,
                          physics: const NeverScrollableScrollPhysics(),
                          itemCount: widget.projects.length,
                          gridDelegate:
                              const SliverGridDelegateWithFixedCrossAxisCount(
                            crossAxisCount: 2,
                            childAspectRatio: .72,
                            crossAxisSpacing: 14,
                            mainAxisSpacing: 18,
                          ),
                          itemBuilder: (context, index) {
                            final project = widget.projects[index];
                            final tag =
                                'che-project-${project['id'] ?? index}';
                            return _GalleryFrame(
                              project: project,
                              dateLabel: _projectDate(project),
                              heroTag: tag,
                              phase: phase,
                              index: index,
                              onTap: () => _showProject(project, index),
                            );
                          },
                        ),
                      const SizedBox(height: 26),
                      const Text(
                        'GALLERY WORKBENCH',
                        style: TextStyle(
                          color: Colors.white60,
                          fontSize: 10,
                          fontWeight: FontWeight.w900,
                          letterSpacing: 1.2,
                        ),
                      ),
                      const SizedBox(height: 10),
                      _WorkbenchRow(
                        icon: Icons.inventory_2_outlined,
                        title: 'CHE Core Data Vault',
                        subtitle:
                            '${widget.vaultCount} saved vault item${widget.vaultCount == 1 ? '' : 's'}',
                        active: true,
                        onTap: widget.onVault,
                      ),
                      _WorkbenchRow(
                        icon: Icons.science_outlined,
                        title: 'Innovation Mode',
                        subtitle:
                            'CHE can develop concepts, feasibility assumptions, prototypes and test plans inside a saved project.',
                        active: true,
                        onTap: () {
                          showModalBottomSheet<void>(
                            context: context,
                            backgroundColor: const Color(0xF51A1D20),
                            showDragHandle: true,
                            builder: (context) => const Padding(
                              padding: EdgeInsets.fromLTRB(20, 4, 20, 28),
                              child: Text(
                                'Innovation mode\n\nCHE can develop concepts, feasibility assumptions, prototypes and test plans inside a saved project.',
                                style: TextStyle(
                                  color: Colors.white70,
                                  height: 1.5,
                                ),
                              ),
                            ),
                          );
                        },
                      ),
                      _WorkbenchRow(
                        icon: Icons.public,
                        title: 'Novelty + Feasibility Research',
                        subtitle: widget.researchConnected
                            ? 'Live research connected.'
                            : 'Research service not connected yet.',
                        active: widget.researchConnected,
                        onTap: widget.onResearch,
                      ),
                      _WorkbenchRow(
                        icon: Icons.image_outlined,
                        title: 'Image Generation',
                        subtitle: widget.imageConnected
                            ? 'Image generation ready.'
                            : 'Connect image compute to create visual assets.',
                        active: widget.imageConnected,
                        onTap: widget.onImage,
                      ),
                      _WorkbenchRow(
                        icon: Icons.movie_creation_outlined,
                        title: 'Video Generation',
                        subtitle: widget.videoConnected
                            ? 'Video generation ready.'
                            : 'Connect video compute to create clips.',
                        active: widget.videoConnected,
                        onTap: widget.onVideo,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _GalleryFrame extends StatelessWidget {
  const _GalleryFrame({
    required this.project,
    required this.dateLabel,
    required this.heroTag,
    required this.phase,
    required this.index,
    required this.onTap,
  });

  final Map<String, dynamic> project;
  final String dateLabel;
  final String heroTag;
  final double phase;
  final int index;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final title = project['title']?.toString() ?? 'Untitled project';
    final type = project['type']?.toString() ?? 'project';
    final glow = .13 +
        .05 * math.sin((phase * math.pi * 2) + index * .7).abs();

    return GestureDetector(
      onTap: onTap,
      child: Column(
        children: [
          Expanded(
            child: Hero(
              tag: heroTag,
              child: Container(
                padding: const EdgeInsets.all(7),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [
                      Color(0xFFD1A85E),
                      Color(0xFF6F4A24),
                      Color(0xFFE0BE7A),
                    ],
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.white.withValues(alpha: glow),
                      blurRadius: 24,
                      offset: const Offset(0, -5),
                    ),
                    const BoxShadow(
                      color: Colors.black45,
                      blurRadius: 16,
                      offset: Offset(0, 10),
                    ),
                  ],
                ),
                child: Container(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [
                        const Color(0xFF173336),
                        const Color(0xFF3A2540),
                        Color.lerp(
                          const Color(0xFF462E24),
                          const Color(0xFF15252E),
                          (index % 4) / 4,
                        )!,
                      ],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                  ),
                  child: Center(
                    child: Icon(
                      type.contains('book') || type.contains('screen')
                          ? Icons.menu_book_rounded
                          : type.contains('app') || type.contains('web')
                              ? Icons.widgets_rounded
                              : type.contains('invention')
                                  ? Icons.lightbulb_rounded
                                  : Icons.auto_awesome_rounded,
                      size: 40,
                      color: Colors.white70,
                    ),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
            decoration: BoxDecoration(
              color: const Color(0xFFE7E0D1),
              borderRadius: BorderRadius.circular(3),
              boxShadow: const [
                BoxShadow(
                  color: Colors.black26,
                  blurRadius: 6,
                  offset: Offset(0, 3),
                ),
              ],
            ),
            child: Column(
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: Color(0xFF27241F),
                    fontWeight: FontWeight.w800,
                    fontSize: 10.5,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  dateLabel,
                  style: const TextStyle(
                    color: Color(0xFF6E675D),
                    fontSize: 8,
                    letterSpacing: .7,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyGalleryFrame extends StatelessWidget {
  const _EmptyGalleryFrame();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SizedBox(
        width: 230,
        height: 300,
        child: Column(
          children: [
            Expanded(
              child: Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [
                      Color(0xFFD1A85E),
                      Color(0xFF75502A),
                      Color(0xFFDAB870),
                    ],
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.white.withValues(alpha: .15),
                      blurRadius: 34,
                      offset: const Offset(0, -8),
                    ),
                  ],
                ),
                child: Container(
                  color: const Color(0xFF242422),
                  child: const Center(
                    child: Icon(
                      Icons.add_photo_alternate_outlined,
                      color: Colors.white24,
                      size: 48,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 10),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(9),
              color: const Color(0xFFE7E0D1),
              child: const Column(
                children: [
                  Text(
                    'Your first piece goes here.',
                    style: TextStyle(
                      color: Color(0xFF27241F),
                      fontWeight: FontWeight.w800,
                      fontSize: 11,
                    ),
                  ),
                  SizedBox(height: 3),
                  Text(
                    'No projects yet',
                    style: TextStyle(
                      color: Color(0xFF6E675D),
                      fontSize: 9,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _WorkbenchRow extends StatelessWidget {
  const _WorkbenchRow({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.active,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    const teal = Color(0xFF67E8D1);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: const Color(0xCC15191B),
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(11),
            child: Row(
              children: [
                Icon(
                  icon,
                  color: active ? teal : Colors.white38,
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        style: const TextStyle(
                          color: Colors.white54,
                          fontSize: 10,
                        ),
                      ),
                    ],
                  ),
                ),
                const Icon(
                  Icons.chevron_right,
                  size: 18,
                  color: Colors.white30,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _GalleryRoomPainter extends CustomPainter {
  const _GalleryRoomPainter({
    required this.phase,
  });

  final double phase;

  @override
  void paint(Canvas canvas, Size size) {
    final floorY = size.height * .83;
    final wall = Paint()..color = const Color(0xFF222321);
    canvas.drawRect(Rect.fromLTWH(0, 0, size.width, floorY), wall);

    final floor = Paint()
      ..shader = const LinearGradient(
        colors: [
          Color(0xFF5E422D),
          Color(0xFF2D2119),
        ],
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
      ).createShader(
        Rect.fromLTWH(0, floorY, size.width, size.height - floorY),
      );
    canvas.drawRect(
      Rect.fromLTWH(0, floorY, size.width, size.height - floorY),
      floor,
    );

    for (var i = 0; i < 8; i++) {
      final x = size.width * (i / 7);
      canvas.drawLine(
        Offset(x, floorY),
        Offset(size.width / 2 + (x - size.width / 2) * 1.7, size.height),
        Paint()..color = Colors.black.withValues(alpha: .16),
      );
    }

    final spotlight = Paint()
      ..shader = LinearGradient(
        colors: [
          Colors.white.withValues(
            alpha: .07 + .02 * math.sin(phase * math.pi * 2).abs(),
          ),
          Colors.transparent,
        ],
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
      ).createShader(
        Rect.fromLTWH(size.width * .08, 0, size.width * .84, floorY),
      );

    final cone = Path()
      ..moveTo(size.width * .34, 0)
      ..lineTo(size.width * .10, floorY)
      ..lineTo(size.width * .90, floorY)
      ..lineTo(size.width * .66, 0)
      ..close();

    canvas.drawPath(cone, spotlight);
  }

  @override
  bool shouldRepaint(covariant _GalleryRoomPainter oldDelegate) =>
      oldDelegate.phase != phase;
}

class _GalleryProjectPage extends StatelessWidget {
  const _GalleryProjectPage({
    required this.heroTag,
    required this.project,
    required this.dateLabel,
    required this.onEdit,
  });

  final String heroTag;
  final Map<String, dynamic> project;
  final String dateLabel;
  final Future<void> Function() onEdit;

  @override
  Widget build(BuildContext context) {
    final title = project['title']?.toString() ?? 'Untitled project';
    final content = project['content']?.toString() ?? '';
    final type = project['type']?.toString() ?? 'project';

    return Scaffold(
      backgroundColor: const Color(0xFF171918),
      appBar: AppBar(
        title: const Text('CHE GALLERY'),
      ),
      body: SafeArea(
        child: ListView(
          physics: const BouncingScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 30),
          children: [
            Hero(
              tag: heroTag,
              child: Container(
                height: 300,
                padding: const EdgeInsets.all(10),
                decoration: const BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      Color(0xFFD1A85E),
                      Color(0xFF6F4A24),
                      Color(0xFFE0BE7A),
                    ],
                  ),
                ),
                child: Container(
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      colors: [
                        Color(0xFF18373A),
                        Color(0xFF432C4A),
                        Color(0xFF2D2520),
                      ],
                    ),
                  ),
                  child: Center(
                    child: Icon(
                      type.contains('book') || type.contains('screen')
                          ? Icons.menu_book_rounded
                          : type.contains('app') || type.contains('web')
                              ? Icons.widgets_rounded
                              : Icons.auto_awesome_rounded,
                      size: 76,
                      color: Colors.white70,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 18),
            Text(
              title,
              style: const TextStyle(
                fontSize: 25,
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(height: 5),
            Text(
              dateLabel,
              style: const TextStyle(
                color: Color(0xFFD7B26D),
                fontSize: 10,
                letterSpacing: 1.2,
              ),
            ),
            const SizedBox(height: 18),
            Text(
              content.isEmpty
                  ? 'This piece is ready for CHE to develop.'
                  : content,
              style: const TextStyle(
                color: Colors.white70,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 22),
            FilledButton.icon(
              onPressed: () => onEdit(),
              icon: const Icon(Icons.edit_outlined),
              label: const Text('EDIT IN CHE CREATOR STUDIO'),
            ),
          ],
        ),
      ),
    );
  }
}
