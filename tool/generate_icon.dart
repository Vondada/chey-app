import 'dart:io';
import 'dart:typed_data';

const int size = 1024;

int _crc32(List<int> bytes) {
  var crc = 0xffffffff;
  for (final byte in bytes) {
    crc ^= byte;
    for (var i = 0; i < 8; i++) {
      final mask = -(crc & 1);
      crc = (crc >> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) & 0xffffffff;
}

void _writeU32(BytesBuilder out, int value) {
  out.add([
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ]);
}

void _chunk(BytesBuilder out, String type, List<int> data) {
  _writeU32(out, data.length);
  final typeBytes = type.codeUnits;
  out.add(typeBytes);
  out.add(data);
  _writeU32(out, _crc32([...typeBytes, ...data]));
}

void main() {
  final rgba = Uint8List(size * size * 4);

  void setPixel(int x, int y, int r, int g, int b, [int a = 255]) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    final i = (y * size + x) * 4;
    rgba[i] = r.clamp(0, 255).toInt();
    rgba[i + 1] = g.clamp(0, 255).toInt();
    rgba[i + 2] = b.clamp(0, 255).toInt();
    rgba[i + 3] = a.clamp(0, 255).toInt();
  }

  // Deep navy/black radial background with a controlled aqua glow.
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      final dx = (x - size / 2) / (size / 2);
      final dy = (y - size / 2) / (size / 2);
      final d = (dx * dx + dy * dy).clamp(0.0, 1.4);
      final glow = ((1.0 - d.clamp(0.0, 1.0)) * 32).round();
      setPixel(x, y, 8 + glow ~/ 6, 14 + glow ~/ 2, 24 + glow);
    }
  }

  void rect(int x, int y, int w, int h, int r, int g, int b) {
    for (var yy = y; yy < y + h; yy++) {
      for (var xx = x; xx < x + w; xx++) {
        setPixel(xx, yy, r, g, b);
      }
    }
  }

  // Minimal luminous frame.
  rect(126, 126, 772, 8, 54, 226, 204);
  rect(126, 890, 772, 8, 54, 226, 204);

  // Geometric CHE wordmark.
  const y = 350;
  const h = 324;
  const t = 48;
  const letterW = 200;
  const gap = 56;
  const start = 124;
  const whiteR = 232, whiteG = 247, whiteB = 247;
  const tealR = 83, tealG = 232, tealB = 210;

  void glowRect(int x, int yy, int w, int hh) {
    rect(x - 8, yy - 8, w + 16, hh + 16, 22, 74, 78);
    rect(x - 4, yy - 4, w + 8, hh + 8, tealR ~/ 2, tealG ~/ 2, tealB ~/ 2);
    rect(x, yy, w, hh, whiteR, whiteG, whiteB);
  }

  // C
  var x = start;
  glowRect(x, y, letterW, t);
  glowRect(x, y, t, h);
  glowRect(x, y + h - t, letterW, t);

  // H
  x += letterW + gap;
  glowRect(x, y, t, h);
  glowRect(x + letterW - t, y, t, h);
  glowRect(x, y + (h - t) ~/ 2, letterW, t);

  // E
  x += letterW + gap;
  glowRect(x, y, t, h);
  glowRect(x, y, letterW, t);
  glowRect(x, y + (h - t) ~/ 2, letterW - 18, t);
  glowRect(x, y + h - t, letterW, t);

  final raw = BytesBuilder();
  for (var y = 0; y < size; y++) {
    raw.addByte(0); // PNG filter: none
    final start = y * size * 4;
    raw.add(rgba.sublist(start, start + size * 4));
  }

  final png = BytesBuilder();
  png.add([137, 80, 78, 71, 13, 10, 26, 10]);

  final ihdr = BytesBuilder();
  _writeU32(ihdr, size);
  _writeU32(ihdr, size);
  ihdr.add([8, 6, 0, 0, 0]); // RGBA
  _chunk(png, 'IHDR', ihdr.takeBytes());
  _chunk(png, 'IDAT', ZLibEncoder().convert(raw.takeBytes()));
  _chunk(png, 'IEND', const []);

  final file = File('assets/icon/icon.png');
  file.parent.createSync(recursive: true);
  file.writeAsBytesSync(png.takeBytes(), flush: true);
  stdout.writeln('Generated sleek CHE app icon at ${file.path}');
}
