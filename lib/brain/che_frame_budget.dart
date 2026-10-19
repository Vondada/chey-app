import 'dart:math' as math;

/// How much of the Brain's live rendering runs this frame.
enum CheRenderLevel { full, economy }

/// Adaptive frame budget for the Brain's live rendering.
///
/// Decided from measured frame times only (Flutter's `FrameTiming`: build plus raster), never
/// from the device model. Full rate while frames fit the 60 Hz budget; economy (the painter
/// runs every other tick, skips the blurred bokeh pass and labels fewer nodes) after a run of
/// slow frames; back to full once frames have been cheap for a while. Every re-entry into
/// economy doubles the recovery wait, so the level never flickers between the two.
class CheFrameBudget {
  CheFrameBudget({this.slowMs = 20, this.fastMs = 12, this.slowFrames = 20, this.recoverFrames = 120, this.maxBackoff = 8});

  /// A frame slower than this (ms) counts toward economy; one faster than [fastMs] toward recovery.
  final double slowMs;
  final double fastMs;

  /// Consecutive slow frames before economy; consecutive fast frames (times the backoff) before full.
  final int slowFrames;
  final int recoverFrames;
  final int maxBackoff;

  CheRenderLevel level = CheRenderLevel.full;

  /// How many times the level changed; the bench and the status line report it.
  int switches = 0;
  double lastFrameMs = 0;
  int _backoff = 1;
  int _slow = 0;
  int _fast = 0;
  int _tick = 0;

  bool get economy => level == CheRenderLevel.economy;

  /// A finished frame's total time in milliseconds.
  void observe(double frameMs) {
    lastFrameMs = frameMs;
    if (frameMs > slowMs) {
      _slow++;
      _fast = 0;
    } else if (frameMs < fastMs) {
      _fast++;
      _slow = 0;
    } else {
      _slow = 0;
      _fast = 0;
    }
    if (level == CheRenderLevel.full && _slow >= slowFrames) {
      if (switches > 0) _backoff = math.min(maxBackoff, _backoff * 2);
      level = CheRenderLevel.economy;
      switches++;
      _slow = 0;
      _fast = 0;
    } else if (level == CheRenderLevel.economy && _fast >= recoverFrames * _backoff) {
      level = CheRenderLevel.full;
      switches++;
      _slow = 0;
      _fast = 0;
    }
  }

  /// Whether this ticker tick paints: every tick at full rate, every other one in economy. The
  /// camera and the animations still advance on every tick, so nothing slows down visibly.
  bool admitTick() {
    _tick++;
    return level == CheRenderLevel.full || _tick.isEven;
  }

  /// Spoken or shown on demand only (no automatic speech).
  String describe() => level == CheRenderLevel.full
      ? 'Rendering at full rate.'
      : 'Rendering in economy after slow frames (last ${lastFrameMs.toStringAsFixed(1)} ms): every other frame, fewer effects.';
}
