import 'dart:async';

import 'package:flutter/material.dart';

import '../che_ui/che_theme.dart';

/// The Flagstaff banner at the top of the screen: it shows the new message, fades away by itself after a few seconds,
/// and goes at once when swiped up. Tapping it opens the Mailbox. It is visual and haptic only; it never speaks.
void showCheFlagstaffBanner(BuildContext context, {required String title, String? detail, required VoidCallback onOpen}) {
  final overlay = Overlay.maybeOf(context);
  if (overlay == null) return;
  late OverlayEntry entry;
  entry = OverlayEntry(
    builder: (_) => _FlagstaffBanner(
      title: title,
      detail: detail,
      onOpen: onOpen,
      onGone: () => entry.remove(),
    ),
  );
  overlay.insert(entry);
}

class _FlagstaffBanner extends StatefulWidget {
  const _FlagstaffBanner({required this.title, required this.detail, required this.onOpen, required this.onGone});

  final String title;
  final String? detail;
  final VoidCallback onOpen;
  final VoidCallback onGone;

  @override
  State<_FlagstaffBanner> createState() => _FlagstaffBannerState();
}

class _FlagstaffBannerState extends State<_FlagstaffBanner> {
  bool _visible = false;
  Timer? _hide;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _visible = true);
    });
    _hide = Timer(const Duration(seconds: 5), _dismiss);
  }

  void _dismiss() {
    _hide?.cancel();
    if (!mounted) return;
    setState(() => _visible = false);
    Future<void>.delayed(const Duration(milliseconds: 350), () {
      if (mounted) widget.onGone();
    });
  }

  @override
  void dispose() {
    _hide?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
          child: AnimatedOpacity(
            opacity: _visible ? 1 : 0,
            duration: const Duration(milliseconds: 300),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onVerticalDragEnd: (d) {
                if ((d.primaryVelocity ?? 0) < -120) _dismiss();
              },
              child: Semantics(
                container: true,
                button: true,
                label: '${widget.title}. ${widget.detail ?? ''} Double tap to open Flagstaff. Swipe up to dismiss.',
                excludeSemantics: true,
                child: Material(
                  color: Colors.transparent,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(16),
                    onTap: () {
                      _dismiss();
                      widget.onOpen();
                    },
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      decoration: BoxDecoration(
                        color: CheColors.surface,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: CheColors.success.withValues(alpha: 0.6)),
                        boxShadow: [BoxShadow(color: CheColors.success.withValues(alpha: 0.25), blurRadius: 14)],
                      ),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                        Text(widget.title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
                        if (widget.detail != null && widget.detail!.trim().isNotEmpty)
                          Text(widget.detail!, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: CheColors.textDim)),
                      ]),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
