// A picture CHE sends in the chat (owner, 2026-10-25: "open and display saved image <id>"). The Worker only retrieves:
// it reads the stored bytes back. Whether the picture is on screen is decided here, by the image actually loading:
// the first decoded frame reports shown, a load or decode error reports failed. Nothing else counts as displayed.
import 'package:flutter/material.dart';

class CheChatImage extends StatefulWidget {
  const CheChatImage({
    super.key,
    required this.image,
    required this.label,
    this.onResult,
  });

  final ImageProvider image;

  /// What VoiceOver reads for the picture, e.g. "Saved image 6e0912e2-…".
  final String label;

  /// Called once: true when the first frame was decoded and painted, false with the error otherwise.
  final void Function(bool shown, String detail)? onResult;

  @override
  State<CheChatImage> createState() => _CheChatImageState();
}

class _CheChatImageState extends State<CheChatImage> {
  bool? _shown;
  String _detail = '';

  void _report(bool shown, String detail) {
    if (_shown != null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _shown != null) return;
      setState(() {
        _shown = shown;
        _detail = detail;
      });
      widget.onResult?.call(shown, detail);
    });
  }

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white60);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          image: true,
          label: widget.label,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: Image(
              image: widget.image,
              fit: BoxFit.cover,
              frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
                if (frame != null || wasSynchronouslyLoaded) _report(true, '');
                return child;
              },
              errorBuilder: (context, error, stack) {
                _report(false, error.toString());
                return const SizedBox(height: 4);
              },
            ),
          ),
        ),
        if (_shown == true)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text('Shown on this screen.', style: muted),
          ),
        if (_shown == false)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              'CHE retrieved this image, but this iPhone could not display it.',
              style: muted,
            ),
          ),
        if (_shown == false && _detail.isNotEmpty)
          ExcludeSemantics(
            child: Text(_detail.length > 120 ? '${_detail.substring(0, 120)}…' : _detail, style: muted),
          ),
      ],
    );
  }
}
