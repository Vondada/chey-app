// WAV in and out for the Recording Studio: 16-bit PCM RIFF, the format the iPhone's take recorder writes and the one
// every editor and DAW opens. Pure Dart, no plugin.
import 'dart:typed_data';

/// One decoded sound: [channels] planes of samples in -1..1 at [sampleRate].
class CheAudio {
  CheAudio(this.channels, this.sampleRate);
  final List<Float32List> channels;
  final int sampleRate;

  int get length => channels.isEmpty ? 0 : channels.first.length;
  double get seconds => sampleRate == 0 ? 0 : length / sampleRate;

  /// One plane (the average of all channels).
  Float32List mono() {
    if (channels.length == 1) return channels.first;
    final out = Float32List(length);
    for (final c in channels) {
      for (var i = 0; i < out.length; i++) {
        out[i] += c[i] / channels.length;
      }
    }
    return out;
  }
}

/// Why a file could not be read, in plain words.
class CheWavException implements Exception {
  CheWavException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// 16-bit PCM WAV of [channels] (all the same length) at [sampleRate]. Samples are clipped to -1..1.
Uint8List cheEncodeWav(List<Float32List> channels, int sampleRate) {
  final n = channels.isEmpty ? 0 : channels.first.length;
  final ch = channels.length;
  final dataBytes = n * ch * 2;
  final b = ByteData(44 + dataBytes);
  void tag(int at, String s) {
    for (var i = 0; i < 4; i++) {
      b.setUint8(at + i, s.codeUnitAt(i));
    }
  }

  tag(0, 'RIFF');
  b.setUint32(4, 36 + dataBytes, Endian.little);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  b.setUint32(16, 16, Endian.little);
  b.setUint16(20, 1, Endian.little);
  b.setUint16(22, ch, Endian.little);
  b.setUint32(24, sampleRate, Endian.little);
  b.setUint32(28, sampleRate * ch * 2, Endian.little);
  b.setUint16(32, ch * 2, Endian.little);
  b.setUint16(34, 16, Endian.little);
  tag(36, 'data');
  b.setUint32(40, dataBytes, Endian.little);
  var at = 44;
  for (var i = 0; i < n; i++) {
    for (var c = 0; c < ch; c++) {
      final v = channels[c][i].clamp(-1.0, 1.0);
      b.setInt16(at, (v < 0 ? v * 32768 : v * 32767).round(), Endian.little);
      at += 2;
    }
  }
  return b.buffer.asUint8List();
}

/// Reads a PCM WAV (8, 16, 24 or 32-bit integer, or 32-bit float). Anything else (MP3, M4A, compressed WAV) is refused
/// with the reason, never guessed.
CheAudio cheDecodeWav(Uint8List bytes) {
  if (bytes.length < 12) throw CheWavException('That file is too short to be a WAV.');
  final b = ByteData.sublistView(bytes);
  String tag(int at) => String.fromCharCodes(bytes.sublist(at, at + 4));
  if (tag(0) != 'RIFF' || tag(8) != 'WAVE') {
    throw CheWavException('That is not a WAV file. The studio imports WAV; MP3 and M4A need converting to WAV first.');
  }
  int? format, channels, rate, bits;
  var at = 12;
  while (at + 8 <= bytes.length) {
    final id = tag(at);
    final size = b.getUint32(at + 4, Endian.little);
    final body = at + 8;
    if (id == 'fmt ') {
      format = b.getUint16(body, Endian.little);
      channels = b.getUint16(body + 2, Endian.little);
      rate = b.getUint32(body + 4, Endian.little);
      bits = b.getUint16(body + 14, Endian.little);
      if (format == 0xFFFE && size >= 26) format = b.getUint16(body + 24, Endian.little);
    } else if (id == 'data') {
      if (format == null || channels == null || rate == null || bits == null || channels == 0) {
        throw CheWavException('That WAV has no format header.');
      }
      if (format != 1 && format != 3) throw CheWavException('That WAV is compressed (format $format); only PCM WAV is supported.');
      final end = (body + size).clamp(body, bytes.length);
      final step = bits ~/ 8;
      final frames = (end - body) ~/ (step * channels);
      final planes = List.generate(channels, (_) => Float32List(frames));
      var p = body;
      for (var i = 0; i < frames; i++) {
        for (var c = 0; c < channels; c++) {
          double v;
          if (format == 3 && bits == 32) {
            v = b.getFloat32(p, Endian.little);
          } else if (bits == 16) {
            v = b.getInt16(p, Endian.little) / 32768;
          } else if (bits == 24) {
            var x = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
            if (x & 0x800000 != 0) x -= 0x1000000;
            v = x / 8388608;
          } else if (bits == 32) {
            v = b.getInt32(p, Endian.little) / 2147483648;
          } else if (bits == 8) {
            v = (bytes[p] - 128) / 128;
          } else {
            throw CheWavException('That WAV uses $bits-bit samples, which the studio does not read.');
          }
          planes[c][i] = v;
          p += step;
        }
      }
      return CheAudio(planes, rate);
    }
    at = body + size + (size.isOdd ? 1 : 0);
  }
  throw CheWavException('That WAV has no audio data.');
}

/// Linear-interpolation resample of one plane from [from] Hz to [to] Hz.
Float32List cheResample(Float32List x, int from, int to) {
  if (from == to || x.isEmpty) return x;
  final n = (x.length * to / from).round();
  final out = Float32List(n);
  final ratio = from / to;
  for (var i = 0; i < n; i++) {
    final pos = i * ratio;
    final j = pos.floor();
    final f = pos - j;
    final a = x[j.clamp(0, x.length - 1)];
    final c = x[(j + 1).clamp(0, x.length - 1)];
    out[i] = a + (c - a) * f;
  }
  return out;
}
