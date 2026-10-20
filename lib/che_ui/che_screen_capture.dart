// "Look at my screen" (owner, 2026-10-20): CHE takes a picture of her own
// screen, the page really in front of the owner, and sends it with the
// turn as an image, together with the page's own report and its room, so
// the Worker's vision reads what is actually there instead of guessing.
//
// Only CHE's own app is captured: another app's screen needs the iOS
// ReplayKit broadcast extension (native, a new IPA). A page that shows a
// password or vault note wraps itself in [CheSensitiveScreen], and while
// one is shown nothing is captured, so a password never reaches the Worker
// or a vision provider (owner rule: passwords stay on the iPhone).
// Web pages and videos are drawn by iOS, not Flutter, so they come out
// blank in the picture; the browser already sends its page text.

import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/// One capture of CHE's screen: a PNG as base64, or the reason there is none.
class CheScreenShot {
  const CheScreenShot._({this.base64 = '', this.width = 0, this.height = 0, this.reason = '', this.shared = false, this.at, this.beforeSwitch = false});
  const CheScreenShot.refused(String reason) : this._(reason: reason);

  /// A frame of the whole iPhone screen from the screen-sharing broadcast
  /// (che_screen_share.dart), not a picture of CHE's own app.
  const CheScreenShot.shared({required String base64, required int width, required int height, DateTime? at, bool beforeSwitch = false})
      : this._(base64: base64, width: width, height: height, shared: true, at: at, beforeSwitch: beforeSwitch);

  final String base64;
  final int width;
  final int height;

  /// True for a broadcast frame of the whole screen (any app).
  final bool shared;

  /// When a shared frame was taken.
  final DateTime? at;

  /// The shared frame is from just before the owner switched back to CHE.
  final bool beforeSwitch;

  /// Why nothing was captured, in words CHE can say aloud.
  final String reason;

  bool get ok => base64.isNotEmpty;
}

class CheScreenCapture {
  CheScreenCapture._();

  /// Wraps the whole app (MaterialApp.builder), so pages, sheets and
  /// dialogs are all in the picture.
  static final boundaryKey = GlobalKey(debugLabel: 'che-screen-capture');

  static int _sensitive = 0;

  /// True while a page showing a password or vault note is on screen.
  static bool get blocked => _sensitive > 0;

  /// The longest side of the picture, in pixels: enough to read text, small
  /// enough to send quickly.
  static const maxSide = 1400.0;

  static Widget wrap(Widget child) => RepaintBoundary(key: boundaryKey, child: child);

  /// Takes the picture. Never throws: a failure comes back as [CheScreenShot.reason].
  static Future<CheScreenShot> capture({double maxSide = maxSide}) async {
    if (blocked) {
      return const CheScreenShot.refused('a password or vault note is on screen, and those never leave this iPhone');
    }
    try {
      // Let a frame that is being drawn, or about to be, finish first.
      final scheduler = SchedulerBinding.instance;
      // A frame takes milliseconds; the cap keeps a stalled one from hanging the turn.
      if (scheduler.hasScheduledFrame || scheduler.schedulerPhase != SchedulerPhase.idle) {
        await scheduler.endOfFrame.timeout(const Duration(milliseconds: 300), onTimeout: () {});
      }
      final boundary = boundaryKey.currentContext?.findRenderObject();
      if (boundary is! RenderRepaintBoundary || !boundary.hasSize) {
        return const CheScreenShot.refused('the screen is not ready to capture');
      }
      final size = boundary.size;
      final view = WidgetsBinding.instance.platformDispatcher.views.firstOrNull;
      final deviceRatio = view?.devicePixelRatio ?? 2.0;
      final longest = math.max(size.width, size.height);
      final ratio = longest <= 0 ? 1.0 : math.min(deviceRatio, maxSide / longest);
      final ui.Image image = await boundary.toImage(pixelRatio: ratio);
      try {
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        if (data == null) return const CheScreenShot.refused('the picture could not be encoded');
        return CheScreenShot._(
          base64: base64Encode(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes)),
          width: image.width,
          height: image.height,
        );
      } finally {
        image.dispose();
      }
    } catch (error) {
      return CheScreenShot.refused('the capture failed ($error)');
    }
  }
}

/// Marks a password, vault or other private surface: while it is mounted,
/// [CheScreenCapture.capture] refuses.
class CheSensitiveScreen extends StatefulWidget {
  const CheSensitiveScreen({super.key, required this.child});

  final Widget child;

  @override
  State<CheSensitiveScreen> createState() => _CheSensitiveScreenState();
}

class _CheSensitiveScreenState extends State<CheSensitiveScreen> {
  @override
  void initState() {
    super.initState();
    CheScreenCapture._sensitive += 1;
  }

  @override
  void dispose() {
    CheScreenCapture._sensitive -= 1;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// "Look at my screen" and the ways it is said: the owner wants CHE to see
/// the screen, not hear its page name. "What is on my screen?" stays with
/// the page report (cheAsksAboutScreen), which is instant and free.
bool cheAsksToLookAtScreen(String raw) {
  final t = raw.trim().toLowerCase().replaceAll('’', "'").replaceAll(RegExp(r'[.!?]+$'), '')
      .replaceFirst(RegExp(r'^(?:(?:hey|hi|ok|okay)[\s,]+)?(?:che|chay|chey|shay)[\s,.:!]+'), '')
      .replaceFirst(RegExp(r'^(?:please|can you|could you|would you)\s+'), '').trim();
  return RegExp(
    r"^(?:(?:take a )?look at (?:my|the|this) screen(?: (?:now|for me))?"
    r"|(?:can you |do you )?see (?:my|the|this) screen"
    r"|what do you see(?: (?:here|now))?"
    r"|(?:read|analy[sz]e|check|scan) (?:my|the|this) (?:whole )?screen"
    r"|look at (?:this|what i'm looking at|what i am looking at))$",
  ).hasMatch(t);
}
