// Live preview of CHE's adjustment parameters on the phone. The same parameters drive the export renderer
// (tools/che_edit_render.py); the preview is an approximation for editing, the export is the real file.
import 'dart:math' as math;

/// A 5x4 colour matrix for brightness, contrast, exposure, saturation, vibrance, temperature, tint and fade.
/// Sharpness, clarity, highlights and shadows are applied in the export only; blur and vignette are drawn
/// separately by the canvas.
List<double> cheColorMatrix(Map<String, dynamic> a) {
  double v(String k) => ((a[k] ?? 0) as num).toDouble();
  final b = v('brightness') / 100 * 0.25 * 255;
  final c = 1 + v('contrast') / 100 * 0.6;
  final e = 1 + v('exposure') / 100 * 0.5;
  final s = math.max(0.0, 1 + (v('saturation') + 0.5 * v('vibrance')) / 100);
  final t = v('temperature');
  final tint = v('tint');
  final fade = v('fade') / 100 * 0.2 * 255;
  // Saturation around luminance weights.
  const lr = 0.2126, lg = 0.7152, lb = 0.0722;
  final sr = (1 - s) * lr, sg = (1 - s) * lg, sb = (1 - s) * lb;
  final rGain = (1 + t / 400) * e * c;
  final gGain = (1 - tint / 500) * e * c;
  final bGain = (1 - t / 400) * e * c;
  final off = 128 * (1 - c) + b + fade;
  return [
    (sr + s) * rGain, sg * rGain, sb * rGain, 0, off,
    sr * gGain, (sg + s) * gGain, sb * gGain, 0, off,
    sr * bGain, sg * bGain, (sb + s) * bGain, 0, off,
    0, 0, 0, 1, 0,
  ];
}

/// Spoken value for an adjustment slider: "Brightness, 15 percent".
String cheAdjustLabel(String key, num value) => '${key[0].toUpperCase()}${key.substring(1)}, ${value.round()} percent';
