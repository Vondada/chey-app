import 'dart:math' as math;
import 'package:flutter/material.dart';

class MusicStudioScene extends StatefulWidget {
  const MusicStudioScene({
    super.key,
    required this.active,
    required this.musicConnected,
    required this.carConnected,
    required this.onMusic,
    required this.onCar,
  });

  final bool active;
  final bool musicConnected;
  final bool carConnected;
  final VoidCallback onMusic;
  final VoidCallback onCar;

  @override
  State<MusicStudioScene> createState() => _MusicStudioSceneState();
}

class _MusicStudioSceneState extends State<MusicStudioScene>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  static const _teal = Color(0xFF67E8D1);
  static const _amber = Color(0xFFFFB45F);
  static const _purple = Color(0xFF9B6DFF);

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 5),
    );
    if (widget.active) _controller.repeat();
  }

  @override
  void didUpdateWidget(covariant MusicStudioScene oldWidget) {
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

  Widget _studioObject({
    required IconData icon,
    required String title,
    required String subtitle,
    required bool connected,
    required VoidCallback onTap,
    double phase = 0,
    bool spin = false,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 94),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: connected
                ? [
                    const Color(0xFF171C27),
                    const Color(0xFF21253A),
                  ]
                : [
                    const Color(0xFF15171E),
                    const Color(0xFF101218),
                  ],
          ),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: connected
                ? _teal.withValues(alpha: .42)
                : Colors.white12,
          ),
          boxShadow: [
            BoxShadow(
              color: connected
                  ? _teal.withValues(alpha: .09)
                  : Colors.black26,
              blurRadius: 18,
              offset: const Offset(0, 8),
            ),
          ],
        ),
        child: Row(
          children: [
            Container(
              width: 54,
              height: 54,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: const Color(0xFF090B10),
                border: Border.all(
                  color: connected ? _purple : Colors.white12,
                  width: 2,
                ),
              ),
              child: Transform.rotate(
                angle: spin && connected ? phase * math.pi * 2 : 0,
                child: Icon(
                  icon,
                  color: connected ? _amber : Colors.white38,
                  size: 26,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontWeight: FontWeight.w800,
                      fontSize: 14,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    subtitle,
                    style: const TextStyle(
                      color: Colors.white54,
                      fontSize: 11,
                      height: 1.3,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 6),
            Text(
              connected ? 'LIVE' : 'SET UP',
              style: TextStyle(
                color: connected ? _teal : Colors.white30,
                fontSize: 9,
                fontWeight: FontWeight.w900,
                letterSpacing: 1,
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final playing = widget.musicConnected;

    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final phase = _controller.value;

        return DecoratedBox(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              colors: [
                Color(0xFF120F18),
                Color(0xFF17121E),
                Color(0xFF0A1017),
              ],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
          ),
          child: SafeArea(
            top: false,
            child: SingleChildScrollView(
              physics: const BouncingScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 26),
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
                              'RECORDING STUDIO',
                              style: TextStyle(
                                color: _teal,
                                fontSize: 12,
                                fontWeight: FontWeight.w900,
                                letterSpacing: 1.5,
                              ),
                            ),
                            SizedBox(height: 3),
                            Text(
                              'Music, voice, and connected audio live here.',
                              style: TextStyle(
                                color: Colors.white54,
                                fontSize: 11.5,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 7,
                        ),
                        decoration: BoxDecoration(
                          color: const Color(0xFF2A0D0D),
                          borderRadius: BorderRadius.circular(8),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.redAccent.withValues(
                                alpha: .18 + .12 * math.sin(phase * math.pi * 2).abs(),
                              ),
                              blurRadius: 18,
                            ),
                          ],
                        ),
                        child: Text(
                          'ON AIR',
                          style: TextStyle(
                            color: Colors.redAccent.withValues(
                              alpha: .72 + .28 * math.sin(phase * math.pi * 2).abs(),
                            ),
                            fontWeight: FontWeight.w900,
                            fontSize: 11,
                            letterSpacing: 1.3,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Container(
                    height: 110,
                    clipBehavior: Clip.antiAlias,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(16),
                      color: const Color(0xFF15111A),
                      border: Border.all(color: Colors.white10),
                    ),
                    child: CustomPaint(
                      painter: _FoamWallPainter(
                        phase: phase,
                      ),
                      child: const SizedBox.expand(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.fromLTRB(12, 14, 12, 12),
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [
                          Color(0xFF20242B),
                          Color(0xFF111318),
                        ],
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                      ),
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(color: Colors.white12),
                    ),
                    child: Column(
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: List<Widget>.generate(
                            6,
                            (i) => Expanded(
                              child: _ChannelStrip(
                                phase: phase,
                                index: i,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            Expanded(
                              child: Container(
                                height: 7,
                                decoration: BoxDecoration(
                                  borderRadius: BorderRadius.circular(99),
                                  gradient: const LinearGradient(
                                    colors: [
                                      Color(0xFF67E8D1),
                                      Color(0xFFFFC85F),
                                      Color(0xFFFF6B72),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 12),
                            _StudioMonitor(
                              active: playing,
                              phase: phase,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  _studioObject(
                    icon: playing ? Icons.album_rounded : Icons.music_note_rounded,
                    title: 'Apple Music',
                    subtitle:
                        'Search, playlists, play/pause and queue control through an authorized connection.',
                    connected: widget.musicConnected,
                    onTap: widget.onMusic,
                    phase: phase,
                    spin: true,
                  ),
                  const SizedBox(height: 10),
                  _studioObject(
                    icon: Icons.directions_car_filled_rounded,
                    title: 'Car Audio',
                    subtitle: 'Use supported car audio for CHE and music.',
                    connected: widget.carConnected,
                    onTap: widget.onCar,
                  ),
                  const SizedBox(height: 10),
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: const Color(0xFF241B27),
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(
                        color: _purple.withValues(alpha: .24),
                      ),
                    ),
                    child: const Row(
                      children: [
                        Icon(
                          Icons.mic_external_on_rounded,
                          color: _amber,
                        ),
                        SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            '“Chay, open music.”   “Chay, play my playlist.”   “Chay, next song.”',
                            style: TextStyle(
                              color: Colors.white70,
                              fontSize: 11,
                              height: 1.45,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _ChannelStrip extends StatelessWidget {
  const _ChannelStrip({
    required this.phase,
    required this.index,
  });

  final double phase;
  final int index;

  @override
  Widget build(BuildContext context) {
    final meter = .18 +
        .72 *
            math.sin(
              (phase * math.pi * 2) + index * .8,
            ).abs();
    final fader = .18 +
        .64 *
            math.sin(
              (phase * math.pi) + index * .45,
            ).abs();

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 3),
      child: Column(
        children: [
          Container(
            height: 44,
            width: 12,
            alignment: Alignment.bottomCenter,
            decoration: BoxDecoration(
              color: const Color(0xFF080A0E),
              borderRadius: BorderRadius.circular(4),
            ),
            child: FractionallySizedBox(
              heightFactor: meter,
              child: Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(3),
                  gradient: const LinearGradient(
                    colors: [
                      Color(0xFFFF625F),
                      Color(0xFFFFD36B),
                      Color(0xFF67E8D1),
                    ],
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 7),
          SizedBox(
            height: 56,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Container(
                  width: 3,
                  color: Colors.white12,
                ),
                Positioned(
                  bottom: 4 + 40 * fader,
                  child: Container(
                    width: 22,
                    height: 9,
                    decoration: BoxDecoration(
                      color: const Color(0xFFC7CBD3),
                      borderRadius: BorderRadius.circular(3),
                    ),
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

class _StudioMonitor extends StatelessWidget {
  const _StudioMonitor({
    required this.active,
    required this.phase,
  });

  final bool active;
  final double phase;

  @override
  Widget build(BuildContext context) {
    final pulse = active
        ? 1 + .06 * math.sin(phase * math.pi * 2).abs()
        : 1.0;

    return Transform.scale(
      scale: pulse,
      child: Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          color: const Color(0xFF090A0D),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Colors.white12),
        ),
        child: Center(
          child: Container(
            width: 24,
            height: 24,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: const Color(0xFF151A1E),
              border: Border.all(
                color: active
                    ? const Color(0xFF67E8D1)
                    : Colors.white24,
                width: 2,
              ),
              boxShadow: active
                  ? [
                      BoxShadow(
                        color: const Color(0xFF67E8D1).withValues(alpha: .18),
                        blurRadius: 12,
                      ),
                    ]
                  : null,
            ),
          ),
        ),
      ),
    );
  }
}

class _FoamWallPainter extends CustomPainter {
  const _FoamWallPainter({
    required this.phase,
  });

  final double phase;

  @override
  void paint(Canvas canvas, Size size) {
    final base = Paint()..color = const Color(0xFF15111A);
    canvas.drawRect(Offset.zero & size, base);

    const tile = 22.0;
    for (var y = -1; y < (size.height / tile).ceil() + 1; y++) {
      for (var x = -1; x < (size.width / tile).ceil() + 1; x++) {
        final rect = Rect.fromLTWH(
          x * tile,
          y * tile,
          tile - 2,
          tile - 2,
        );
        canvas.drawRRect(
          RRect.fromRectAndRadius(rect, const Radius.circular(3)),
          Paint()
            ..color = (x + y).isEven
                ? const Color(0xFF21172A)
                : const Color(0xFF18131F),
        );
      }
    }

    final amberGlow = Paint()
      ..shader = RadialGradient(
        colors: [
          const Color(0xFFFFB45F).withValues(
            alpha: .14 + .05 * math.sin(phase * math.pi * 2).abs(),
          ),
          Colors.transparent,
        ],
      ).createShader(
        Rect.fromCircle(
          center: Offset(size.width * .23, size.height * .5),
          radius: size.width * .38,
        ),
      );

    final purpleGlow = Paint()
      ..shader = RadialGradient(
        colors: [
          const Color(0xFF9B6DFF).withValues(alpha: .13),
          Colors.transparent,
        ],
      ).createShader(
        Rect.fromCircle(
          center: Offset(size.width * .78, size.height * .35),
          radius: size.width * .42,
        ),
      );

    canvas.drawRect(Offset.zero & size, amberGlow);
    canvas.drawRect(Offset.zero & size, purpleGlow);
  }

  @override
  bool shouldRepaint(covariant _FoamWallPainter oldDelegate) =>
      oldDelegate.phase != phase;
}
