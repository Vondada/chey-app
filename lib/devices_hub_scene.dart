import 'dart:math' as math;
import 'package:flutter/material.dart';

class DevicesHubScene extends StatefulWidget {
  const DevicesHubScene({
    super.key,
    required this.active,
    required this.phoneConnected,
    required this.integrations,
    required this.onPrompt,
  });

  final bool active;
  final bool phoneConnected;
  final Map<String, bool> integrations;
  final void Function(String prompt) onPrompt;

  @override
  State<DevicesHubScene> createState() => _DevicesHubSceneState();
}

class _DevicesHubSceneState extends State<DevicesHubScene>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  static const _teal = Color(0xFF67E8D1);

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
  void didUpdateWidget(covariant DevicesHubScene oldWidget) {
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

  List<_DeviceNode> _nodes() => [
        _DeviceNode(
          name: 'This iPhone',
          icon: Icons.phone_iphone_rounded,
          position: const Offset(.18, .21),
          connected: widget.phoneConnected,
          description: widget.phoneConnected
              ? 'Secure CHE Agent paired.'
              : 'Not paired.',
          prompt: 'Help me securely pair this iPhone with CHE.',
        ),
        _DeviceNode(
          name: 'Computer',
          icon: Icons.laptop_mac_rounded,
          position: const Offset(.50, .12),
          connected: widget.integrations['windows'] == true,
          description: 'Windows or Mac companion actions.',
          prompt:
              'Help me connect my computer to CHE for authorized actions. Walk me through only the required setup and permissions.',
        ),
        _DeviceNode(
          name: 'Car',
          icon: Icons.directions_car_filled_rounded,
          position: const Offset(.82, .22),
          connected: widget.integrations['car'] == true,
          description: 'Authorized Bluetooth and vehicle controls.',
          prompt:
              'Help me connect my car or Bluetooth system to CHE. Use only supported authorized controls.',
        ),
        _DeviceNode(
          name: 'Home',
          icon: Icons.home_rounded,
          position: const Offset(.86, .54),
          connected: widget.integrations['smart_home'] == true,
          description: 'HomeKit, Matter, lights and scenes.',
          prompt:
              'Help me connect my smart home devices to CHE with the supported authorized integration.',
        ),
        _DeviceNode(
          name: 'Speaker',
          icon: Icons.speaker_rounded,
          position: const Offset(.70, .82),
          connected: widget.integrations['music'] == true,
          description: 'Music and supported audio output.',
          prompt:
              'Help me connect a speaker or music service to CHE and use only authorized controls.',
        ),
        _DeviceNode(
          name: 'Headphones',
          icon: Icons.headphones_rounded,
          position: const Offset(.30, .82),
          connected: widget.integrations['natural_voice'] == true,
          description: 'Voice audio and Bluetooth listening.',
          prompt:
              'Help me connect and test headphones with CHE voice and Bluetooth audio.',
        ),
        const _DeviceNode(
          name: 'Watch',
          icon: Icons.watch_rounded,
          position: Offset(.10, .55),
          connected: false,
          description: 'Reserved for a future watch connection.',
          prompt:
              'Tell me what secure integration CHE would need to connect to my watch.',
        ),
        _DeviceNode(
          name: 'TV',
          icon: Icons.tv_rounded,
          position: const Offset(.50, .91),
          connected: widget.integrations['smart_home'] == true,
          description: 'Reserved for supported home-media control.',
          prompt:
              'Tell me what secure integration CHE would need to control my TV or media hub.',
        ),
      ];

  void _openDevice(_DeviceNode node) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xF5121C25),
      showDragHandle: true,
      builder: (context) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 6, 20, 26),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 58,
                height: 58,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: node.connected
                      ? _teal.withValues(alpha: .16)
                      : Colors.white.withValues(alpha: .06),
                  border: Border.all(
                    color: node.connected ? _teal : Colors.white24,
                  ),
                ),
                child: Icon(
                  node.icon,
                  color: node.connected ? _teal : Colors.white54,
                  size: 30,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                node.name,
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 5),
              Text(
                node.connected ? 'CONNECTED' : 'NOT CONNECTED',
                style: TextStyle(
                  color: node.connected ? _teal : Colors.white38,
                  fontSize: 10,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 1.3,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                node.description,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white60, height: 1.4),
              ),
              const SizedBox(height: 18),
              FilledButton.icon(
                onPressed: () {
                  Navigator.of(context).pop();
                  widget.onPrompt(node.prompt);
                },
                icon: Icon(node.connected ? Icons.tune : Icons.add_link),
                label: Text(node.connected ? 'MANAGE WITH CHE' : 'SET UP WITH CHE'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final nodes = _nodes();

    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          colors: [
            Color(0xFF071018),
            Color(0xFF101A24),
            Color(0xFF070D13),
          ],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        ),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(18, 16, 18, 2),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'CONNECTED GARAGE',
                  style: TextStyle(
                    color: _teal,
                    fontSize: 12,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 1.5,
                  ),
                ),
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(18, 0, 18, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'CHE sits at the center. Connected devices glow; future slots stay dim.',
                  style: TextStyle(color: Colors.white54, fontSize: 11.5),
                ),
              ),
            ),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final size = Size(
                    constraints.maxWidth,
                    math.max(560, constraints.maxHeight),
                  );
                  final positions = nodes
                      .map(
                        (node) => Offset(
                          node.position.dx * size.width,
                          node.position.dy * size.height,
                        ),
                      )
                      .toList();
                  final core = Offset(size.width * .5, size.height * .48);

                  return SingleChildScrollView(
                    physics: const BouncingScrollPhysics(),
                    child: SizedBox(
                      width: size.width,
                      height: size.height,
                      child: AnimatedBuilder(
                        animation: _controller,
                        builder: (context, _) {
                          return Stack(
                            children: [
                              Positioned.fill(
                                child: CustomPaint(
                                  painter: _ConnectionsPainter(
                                    core: core,
                                    nodes: nodes,
                                    positions: positions,
                                    phase: _controller.value,
                                  ),
                                ),
                              ),
                              Positioned(
                                left: core.dx - 52,
                                top: core.dy - 52,
                                child: Container(
                                  width: 104,
                                  height: 104,
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    gradient: const RadialGradient(
                                      colors: [
                                        Color(0xFFB9FFF5),
                                        Color(0xFF67E8D1),
                                        Color(0xFF17505A),
                                        Color(0xFF071018),
                                      ],
                                    ),
                                    boxShadow: [
                                      BoxShadow(
                                        color: _teal.withValues(
                                          alpha: .30 +
                                              .12 *
                                                  math.sin(
                                                    _controller.value *
                                                        math.pi *
                                                        2,
                                                  ).abs(),
                                        ),
                                        blurRadius: 34,
                                        spreadRadius: 4,
                                      ),
                                    ],
                                  ),
                                  child: const Center(
                                    child: Text(
                                      'CHE',
                                      style: TextStyle(
                                        color: Color(0xFF051216),
                                        fontWeight: FontWeight.w900,
                                        fontSize: 18,
                                        letterSpacing: 2,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                              for (var i = 0; i < nodes.length; i++)
                                Positioned(
                                  left: positions[i].dx - 44,
                                  top: positions[i].dy - 38,
                                  child: GestureDetector(
                                    onTap: () => _openDevice(nodes[i]),
                                    child: _DeviceBadge(node: nodes[i]),
                                  ),
                                ),
                            ],
                          );
                        },
                      ),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DeviceBadge extends StatelessWidget {
  const _DeviceBadge({required this.node});
  final _DeviceNode node;

  @override
  Widget build(BuildContext context) {
    const teal = Color(0xFF67E8D1);
    return SizedBox(
      width: 88,
      child: Column(
        children: [
          Container(
            width: 58,
            height: 58,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              color: node.connected
                  ? const Color(0xFF10292C)
                  : const Color(0xFF141A20),
              border: Border.all(
                color: node.connected ? teal : Colors.white12,
              ),
              boxShadow: node.connected
                  ? [
                      BoxShadow(
                        color: teal.withValues(alpha: .2),
                        blurRadius: 16,
                      ),
                    ]
                  : null,
            ),
            child: Icon(
              node.icon,
              color: node.connected ? teal : Colors.white30,
              size: 29,
            ),
          ),
          const SizedBox(height: 5),
          Text(
            node.name,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: node.connected ? Colors.white : Colors.white38,
              fontSize: 10.5,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _DeviceNode {
  const _DeviceNode({
    required this.name,
    required this.icon,
    required this.position,
    required this.connected,
    required this.description,
    required this.prompt,
  });

  final String name;
  final IconData icon;
  final Offset position;
  final bool connected;
  final String description;
  final String prompt;
}

class _ConnectionsPainter extends CustomPainter {
  const _ConnectionsPainter({
    required this.core,
    required this.nodes,
    required this.positions,
    required this.phase,
  });

  final Offset core;
  final List<_DeviceNode> nodes;
  final List<Offset> positions;
  final double phase;

  @override
  void paint(Canvas canvas, Size size) {
    for (var i = 0; i < nodes.length; i++) {
      final connected = nodes[i].connected;
      final line = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = connected ? 1.8 : 1.2
        ..color = connected
            ? const Color(0xFF67E8D1).withValues(alpha: .36)
            : Colors.white.withValues(alpha: .10);

      if (!connected) {
        final distance = (positions[i] - core).distance;
        final direction = (positions[i] - core) / distance;
        var d = 0.0;
        while (d < distance) {
          final start = core + direction * d;
          final end = core + direction * math.min(d + 7, distance);
          canvas.drawLine(start, end, line);
          d += 14;
        }
      } else {
        canvas.drawLine(core, positions[i], line);
        final t = (phase + i / nodes.length) % 1.0;
        final dot = Offset.lerp(core, positions[i], t)!;
        canvas.drawCircle(
          dot,
          3.4,
          Paint()
            ..color = const Color(0xFFB7FFF5)
            ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 5),
        );
      }
    }

    final floor = Paint()
      ..shader = const LinearGradient(
        colors: [Color(0x00253D48), Color(0x55253D48), Color(0x00253D48)],
      ).createShader(Rect.fromLTWH(0, size.height * .78, size.width, 80));
    canvas.drawRect(
      Rect.fromLTWH(0, size.height * .78, size.width, 80),
      floor,
    );
  }

  @override
  bool shouldRepaint(covariant _ConnectionsPainter oldDelegate) =>
      oldDelegate.phase != phase ||
      oldDelegate.nodes.length != nodes.length;
}
