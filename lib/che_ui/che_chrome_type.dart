// CHE's chrome lettering as one shared typography system (owner, 2026-10-23: apply the Home "Good morning" chrome
// throughout CHE). Two weights of the same chrome:
// - strong: CheHud.chrome, the Home greeting's white → ice → lilac reflection, for titles and headings;
// - subtle: the same hues pulled toward silver, for small labels, numbers, buttons and body text, so long text stays
//   calm and readable.
// Both paint through the text's own foreground Paint (one shader per paragraph, no ShaderMask layer), so the text
// stays an ordinary Text: VoiceOver reads it, Dynamic Type scales it, and selection and ellipsis work as usual.
import 'package:flutter/material.dart';

import 'che_hud.dart';

/// Chrome text styles. Use [CheChrome.style] where a [TextStyle] is needed, or [CheChromeLabel] as a widget.
abstract final class CheChrome {
  /// Titles and headings: the Home greeting's chrome, repeated once per line.
  static final LinearGradient strong = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: CheHud.chrome.colors,
    stops: CheHud.chrome.stops,
    tileMode: TileMode.repeated,
  );

  /// Small labels, numbers, buttons and body text: silver with a trace of ice and lilac. Every stop keeps at least
  /// 9:1 contrast on CHE's dark backgrounds (checked in test/che_chrome_type_test.dart).
  static const LinearGradient subtle = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFFF7FBFF), Color(0xFFDCE9F4), Color(0xFFC3D9EA), Color(0xFFD2CCEE), Color(0xFFEEF5FC)],
    stops: [0.0, 0.3, 0.56, 0.8, 1.0],
    tileMode: TileMode.repeated,
  );

  /// Small HUD labels, exactly the Home greeting's caps lines.
  static TextStyle label({double? fontSize}) => fontSize == null ? CheHud.label : CheHud.label.copyWith(fontSize: fontSize);

  /// The darkest colour each chrome reaches, for contrast checks.
  static Color darkest(LinearGradient g) =>
      g.colors.reduce((a, b) => a.computeLuminance() <= b.computeLuminance() ? a : b);

  /// [base] lettered in chrome. [scale] is the text scale factor the text is drawn at (from
  /// `MediaQuery.textScalerOf`), so the reflection spans one rendered line.
  static TextStyle style(TextStyle base, {bool subtle = false, double scale = 1}) {
    final size = (base.fontSize ?? 14) * scale;
    final line = size * (base.height ?? 1.2);
    // copyWith drops [base.color] once a foreground is set, and a parent DefaultTextStyle's colour gives way to it.
    return base.copyWith(
      foreground: Paint()..shader = (subtle ? CheChrome.subtle : strong).createShader(Rect.fromLTWH(0, 0, 1, line)),
    );
  }
}

/// A line of chrome lettering: [CheChrome.style] sized to the current text scale.
class CheChromeLabel extends StatelessWidget {
  const CheChromeLabel(this.text, {super.key, required this.style, this.subtle = true, this.maxLines, this.textAlign, this.semanticsLabel});

  final String text;
  final TextStyle style;
  final bool subtle;
  final int? maxLines;
  final TextAlign? textAlign;
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(style.fontSize ?? 14) / (style.fontSize ?? 14);
    return Text(
      text,
      maxLines: maxLines,
      textAlign: textAlign,
      semanticsLabel: semanticsLabel,
      overflow: maxLines == null ? null : TextOverflow.ellipsis,
      style: CheChrome.style(style, subtle: subtle, scale: scale),
    );
  }
}
