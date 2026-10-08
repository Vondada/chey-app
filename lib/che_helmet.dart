// CHE helmet visor. A screen, not a suit.
// Shows the last receipt and the live status line. It does not control hardware.

import 'package:flutter/material.dart';

class CheHelmet extends StatelessWidget {
  const CheHelmet({
    super.key,
    this.status = 'Standing by.',
    this.receipt = 'No receipt yet.',
  });

  final String status;
  final String receipt;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Center(
          child: AspectRatio(
            aspectRatio: 1,
            child: CustomPaint(
              painter: _VisorPainter(),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(48, 72, 48, 72),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('CHE', style: TextStyle(color: Color(0xFF7DF9FF), fontSize: 28, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 12),
                    Text(status, style: const TextStyle(color: Color(0xFF7DF9FF), fontSize: 16)),
                    const Spacer(),
                    Text(receipt, style: const TextStyle(color: Color(0xFF9AA4B2), fontSize: 14)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _VisorPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0xFF7DF9FF)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    final rect = Rect.fromLTWH(18, 28, size.width - 36, size.height - 56);
    canvas.drawRRect(RRect.fromRectAndRadius(rect, const Radius.circular(80)), paint);
    canvas.drawLine(Offset(36, size.height * 0.42), Offset(size.width - 36, size.height * 0.42), paint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
