// Draws a Visual Studio image document: photo layers with crop, rotation, flips and the colour adjustments,
// then text, shape and logo layers as their own widgets so they stay selectable, movable and readable by VoiceOver.
import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'che_visual_adjust.dart';

typedef CheImageResolver = Future<ui.Image?> Function(String assetId);

/// Loads and caches the pictures a document uses.
class CheImageCache {
  CheImageCache(this.url, this.headers);
  final String Function(String id) url;
  final Map<String, String> Function() headers;
  final _images = <String, ui.Image>{};
  final _pending = <String, Future<ui.Image?>>{};

  ui.Image? peek(String id) => _images[id];

  Future<ui.Image?> load(String id) => _pending[id] ??= () async {
        final c = Completer<ui.Image?>();
        final stream = NetworkImage(url(id), headers: headers()).resolve(ImageConfiguration.empty);
        late ImageStreamListener l;
        l = ImageStreamListener((info, _) {
          _images[id] = info.image;
          if (!c.isCompleted) c.complete(info.image);
          stream.removeListener(l);
        }, onError: (_, _) {
          if (!c.isCompleted) c.complete(null);
          stream.removeListener(l);
        });
        stream.addListener(l);
        return c.future;
      }();
}

Color cheHex(String? value, [Color fallback = Colors.white]) {
  final v = (value ?? '').replaceFirst('#', '');
  if (v.length != 6 && v.length != 8) return fallback;
  final rgb = int.tryParse(v.substring(0, 6), radix: 16);
  final a = v.length == 8 ? int.tryParse(v.substring(6, 8), radix: 16) ?? 255 : 255;
  return rgb == null ? fallback : Color((a << 24) | rgb);
}

class CheImageCanvas extends StatefulWidget {
  const CheImageCanvas({
    super.key,
    required this.doc,
    required this.cache,
    this.selected,
    this.onSelect,
    this.onMove,
    this.showOriginal = false,
    this.original,
  });

  final Map<String, dynamic> doc;
  final CheImageCache cache;
  final String? selected;
  final ValueChanged<String?>? onSelect;
  final void Function(String id, double dx, double dy)? onMove;

  /// A/B: draw the Original instead of the edit.
  final bool showOriginal;
  final Map<String, dynamic>? original;

  @override
  State<CheImageCanvas> createState() => _CheImageCanvasState();
}

class _CheImageCanvasState extends State<CheImageCanvas> {
  @override
  void didUpdateWidget(covariant CheImageCanvas old) {
    super.didUpdateWidget(old);
    _preload();
  }

  @override
  void initState() {
    super.initState();
    _preload();
  }

  void _preload() {
    for (final l in (_doc['layers'] as List? ?? const [])) {
      final id = (l as Map)['asset'];
      if (id is String && widget.cache.peek(id) == null) {
        unawaited(widget.cache.load(id).then((_) => mounted ? setState(() {}) : null));
      }
    }
  }

  Map<String, dynamic> get _doc => widget.showOriginal && widget.original != null ? widget.original! : widget.doc;

  @override
  Widget build(BuildContext context) {
    final doc = _doc;
    final canvas = Map<String, dynamic>.from(doc['canvas'] as Map);
    final w = (canvas['w'] as num).toDouble();
    final h = (canvas['h'] as num).toDouble();
    final layers = [for (final l in (doc['layers'] as List? ?? const [])) Map<String, dynamic>.from(l as Map)];
    return AspectRatio(
      aspectRatio: w / h,
      child: LayoutBuilder(builder: (context, box) {
        final scale = box.maxHeight;
        return GestureDetector(
          onTap: () => widget.onSelect?.call(null),
          child: Stack(clipBehavior: Clip.hardEdge, children: [
            Positioned.fill(child: ColoredBox(color: cheHex(canvas['background'] as String?, Colors.black))),
            for (final l in layers)
              if (l['hidden'] != true) _layer(l, doc, box.maxWidth, box.maxHeight, scale),
          ]),
        );
      }),
    );
  }

  Widget _layer(Map<String, dynamic> l, Map<String, dynamic> doc, double cw, double ch, double scale) {
    final x = (l['x'] as num).toDouble() * cw, y = (l['y'] as num).toDouble() * ch;
    final w = (l['w'] as num).toDouble() * cw, h = (l['h'] as num).toDouble() * ch;
    final selected = widget.selected == l['id'];
    final type = '${l['type']}';
    Widget child;
    if (type == 'photo' || type == 'background') {
      child = CustomPaint(painter: _PhotoPainter(widget.cache.peek('${l['asset']}'), doc), size: Size(w, h));
      final blur = ((doc['adjust'] as Map?)?['blur'] as num? ?? 0).toDouble();
      if (blur > 0) child = ImageFiltered(imageFilter: ui.ImageFilter.blur(sigmaX: blur / 100 * 12, sigmaY: blur / 100 * 12), child: child);
      final vig = ((doc['adjust'] as Map?)?['vignette'] as num? ?? 0).toDouble();
      if (vig > 0) {
        child = Stack(fit: StackFit.expand, children: [
          child,
          DecoratedBox(decoration: BoxDecoration(gradient: RadialGradient(colors: [Colors.transparent, Colors.black.withValues(alpha: vig / 100)], stops: const [0.55, 1]))),
        ]);
      }
    } else if (type == 'text') {
      final t = Map<String, dynamic>.from(l['text'] as Map);
      final size = ((t['size'] as num?) ?? 0.05).toDouble() * scale;
      final outline = t['outline'] as Map?;
      final shadow = t['shadow'] as Map?;
      final bg = t['background'] as Map?;
      final style = TextStyle(
        fontSize: size,
        height: 1.1,
        fontWeight: ((t['weight'] as num?) ?? 400) >= 700 ? FontWeight.w800 : FontWeight.w500,
        color: cheHex(t['color'] as String?),
        shadows: shadow == null ? null : [Shadow(color: cheHex(shadow['color'] as String?, Colors.black), blurRadius: ((shadow['blur'] as num?) ?? 6).toDouble())],
      );
      final align = {'center': TextAlign.center, 'right': TextAlign.right}[t['align']] ?? TextAlign.left;
      Widget text = Text('${t['value'] ?? ''}', style: style, textAlign: align);
      if (outline != null) {
        text = Stack(children: [
          Text('${t['value'] ?? ''}', textAlign: align, style: style.copyWith(shadows: const [], foreground: Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = ((outline['width'] as num?) ?? 0.004).toDouble() * scale * 2
            ..color = cheHex(outline['color'] as String?, Colors.black))),
          text,
        ]);
      }
      child = Container(
        alignment: {'center': Alignment.center, 'right': Alignment.centerRight}[t['align']] ?? Alignment.centerLeft,
        decoration: bg == null ? null : BoxDecoration(color: cheHex(bg['color'] as String?, Colors.black54), borderRadius: BorderRadius.circular(size / 4)),
        child: FittedBox(fit: BoxFit.scaleDown, child: text),
      );
    } else if (type == 'logo' || type == 'image' || type == 'sticker') {
      final img = widget.cache.peek('${l['asset']}');
      child = img == null ? const SizedBox.shrink() : RawImage(image: img, fit: BoxFit.contain);
    } else {
      child = CustomPaint(painter: _ShapePainter(type, cheHex((l['shape'] as Map?)?['color'] as String?)));
    }
    final op = ((l['opacity'] as num?) ?? 1).toDouble();
    final label = type == 'text' ? '${l['name']} text, ${(l['text'] as Map)['value']}' : '${l['name']} layer';
    return Positioned(
      left: x,
      top: y,
      width: w,
      height: h,
      child: Semantics(
        label: '$label${selected ? ', selected' : ''}',
        button: true,
        selected: selected,
        child: GestureDetector(
          onTap: () => widget.onSelect?.call('${l['id']}'),
          onPanUpdate: widget.onMove == null || type == 'photo' || type == 'background' ? null : (d) => widget.onMove!('${l['id']}', d.delta.dx / cw, d.delta.dy / ch),
          child: Transform.rotate(
            angle: ((l['rotation'] as num?) ?? 0).toDouble() * math.pi / 180,
            child: Opacity(
              opacity: op.clamp(0, 1),
              child: DecoratedBox(
                position: DecorationPosition.foreground,
                decoration: BoxDecoration(border: selected ? Border.all(color: const Color(0xFF7FF5E6), width: 2) : null),
                child: child,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PhotoPainter extends CustomPainter {
  _PhotoPainter(this.image, this.doc);
  final ui.Image? image;
  final Map<String, dynamic> doc;

  @override
  void paint(Canvas canvas, Size size) {
    final img = image;
    if (img == null) {
      canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFF1B2A33));
      return;
    }
    final tf = Map<String, dynamic>.from(doc['transform'] as Map? ?? const {});
    final crop = Map<String, dynamic>.from(tf['crop'] as Map? ?? const {'x': 0, 'y': 0, 'w': 1, 'h': 1});
    final src = Rect.fromLTWH((crop['x'] as num).toDouble() * img.width, (crop['y'] as num).toDouble() * img.height, (crop['w'] as num).toDouble() * img.width, (crop['h'] as num).toDouble() * img.height);
    final rot = (((tf['rotate'] as num?) ?? 0) + ((tf['straighten'] as num?) ?? 0)).toDouble();
    final quarter = (((tf['rotate'] as num?) ?? 0) % 180) != 0;
    final srcW = quarter ? src.height : src.width;
    final srcH = quarter ? src.width : src.height;
    // Cover: fill the layer, centred.
    final s = math.max(size.width / srcW, size.height / srcH);
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    canvas.translate(size.width / 2, size.height / 2);
    canvas.rotate(rot * math.pi / 180);
    canvas.scale(tf['flip_h'] == true ? -1 : 1, tf['flip_v'] == true ? -1 : 1);
    final dw = src.width * s, dh = src.height * s;
    final paint = Paint()
      ..filterQuality = FilterQuality.medium
      ..colorFilter = ColorFilter.matrix(cheColorMatrix(Map<String, dynamic>.from(doc['adjust'] as Map? ?? const {})));
    canvas.drawImageRect(img, src, Rect.fromCenter(center: Offset.zero, width: dw, height: dh), paint);
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _PhotoPainter old) => old.image != image || old.doc != doc;
}

class _ShapePainter extends CustomPainter {
  _ShapePainter(this.type, this.color);
  final String type;
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = color
      ..strokeWidth = 3
      ..style = PaintingStyle.stroke;
    if (type == 'shape') {
      canvas.drawRect(Offset.zero & size, p);
    } else {
      canvas.drawLine(Offset(0, size.height / 2), Offset(size.width, size.height / 2), p);
      if (type == 'arrow') {
        final path = Path()
          ..moveTo(size.width, size.height / 2)
          ..lineTo(size.width - size.height / 2, 0)
          ..lineTo(size.width - size.height / 2, size.height)
          ..close();
        canvas.drawPath(path, p..style = PaintingStyle.fill);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _ShapePainter old) => old.type != type || old.color != color;
}
