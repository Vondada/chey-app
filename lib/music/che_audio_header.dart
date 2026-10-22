// Reads the real format of a song file from its header: no decoding, no
// copying, no audio engine. Used by the Music catalog so the owner's original
// file is described exactly as recorded (format, sample rate, bit depth, length).
//
// Supported: WAV (incl. WAVE_FORMAT_EXTENSIBLE), AIFF, FLAC. MP3 and M4A are
// recognized by signature but their duration is not read here (null), because
// it needs a frame or box walk that belongs with the playback engine.

import 'dart:typed_data';

class CheAudioInfo {
  const CheAudioInfo({
    required this.format,
    this.sampleRate,
    this.channels,
    this.bitDepth,
    this.frames,
  });

  /// 'WAV', 'AIFF', 'FLAC', 'MP3' or 'M4A'.
  final String format;
  final int? sampleRate;
  final int? channels;
  final int? bitDepth;

  /// Total sample frames per channel, when the header states it.
  final int? frames;

  /// Length in seconds, or null when the header does not state it.
  double? get durationSeconds {
    final f = frames;
    final r = sampleRate;
    if (f == null || r == null || r == 0) return null;
    return f / r;
  }
}

/// Parses [bytes] (at least the file's header) into [CheAudioInfo], or null
/// when the bytes are not a recognized song file.
CheAudioInfo? parseAudioHeader(Uint8List bytes) {
  if (bytes.length < 12) return null;
  final tag = String.fromCharCodes(bytes.sublist(0, 4));
  if (tag == 'RIFF' && _ascii(bytes, 8, 4) == 'WAVE') return _wav(bytes);
  if (tag == 'FORM' && _ascii(bytes, 8, 4) == 'AIFF') return _aiff(bytes);
  if (tag == 'fLaC') return _flac(bytes);
  if (_ascii(bytes, 0, 3) == 'ID3' || (bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0)) {
    return const CheAudioInfo(format: 'MP3');
  }
  if (_ascii(bytes, 4, 4) == 'ftyp') return const CheAudioInfo(format: 'M4A');
  return null;
}

String _ascii(Uint8List b, int at, int len) =>
    at + len <= b.length ? String.fromCharCodes(b.sublist(at, at + len)) : '';

int _u32le(Uint8List b, int at) => ByteData.sublistView(b, at, at + 4).getUint32(0, Endian.little);
int _u16le(Uint8List b, int at) => ByteData.sublistView(b, at, at + 2).getUint16(0, Endian.little);

CheAudioInfo? _wav(Uint8List b) {
  int? sampleRate, channels, bitDepth, dataBytes, blockAlign;
  var at = 12;
  while (at + 8 <= b.length) {
    final id = _ascii(b, at, 4);
    final size = _u32le(b, at + 4);
    final body = at + 8;
    if (id == 'fmt ' && body + 16 <= b.length) {
      channels = _u16le(b, body + 2);
      sampleRate = _u32le(b, body + 4);
      blockAlign = _u16le(b, body + 12);
      bitDepth = _u16le(b, body + 14);
    } else if (id == 'data') {
      dataBytes = size;
      break;
    }
    at = body + size + (size.isOdd ? 1 : 0);
  }
  if (channels == null || sampleRate == null) return null;
  final frames = (dataBytes != null && blockAlign != null && blockAlign > 0) ? dataBytes ~/ blockAlign : null;
  return CheAudioInfo(
    format: 'WAV',
    sampleRate: sampleRate,
    channels: channels,
    bitDepth: bitDepth,
    frames: frames,
  );
}

CheAudioInfo? _aiff(Uint8List b) {
  var at = 12;
  while (at + 8 <= b.length) {
    final id = _ascii(b, at, 4);
    final size = ByteData.sublistView(b, at + 4, at + 8).getUint32(0);
    final body = at + 8;
    if (id == 'COMM' && body + 18 <= b.length) {
      final view = ByteData.sublistView(b, body, body + 18);
      final channels = view.getInt16(0);
      final frames = view.getUint32(2);
      final bits = view.getInt16(6);
      final rate = _extended80(b, body + 8);
      return CheAudioInfo(
        format: 'AIFF',
        sampleRate: rate.round(),
        channels: channels,
        bitDepth: bits,
        frames: frames,
      );
    }
    at = body + size + (size.isOdd ? 1 : 0);
  }
  return null;
}

/// Reads an IEEE 80-bit extended float (big-endian), as AIFF stores its sample rate.
double _extended80(Uint8List b, int at) {
  final view = ByteData.sublistView(b, at, at + 10);
  final exponent = view.getUint16(0) & 0x7FFF;
  final mantissa = view.getUint32(2) * 4294967296.0 + view.getUint32(6);
  return mantissa * _pow2(exponent - 16383 - 63);
}

double _pow2(int n) {
  var v = 1.0;
  final step = n >= 0 ? 2.0 : 0.5;
  for (var i = 0; i < n.abs(); i++) {
    v *= step;
  }
  return v;
}

CheAudioInfo? _flac(Uint8List b) {
  // The first metadata block must be STREAMINFO (type 0), 34 bytes of body.
  if (b.length < 4 + 4 + 18) return null;
  final body = 8;
  final packed = ByteData.sublistView(b, body + 10, body + 18).getUint64(0);
  final sampleRate = (packed >> 44) & 0xFFFFF;
  final channels = ((packed >> 41) & 0x7) + 1;
  final bitDepth = ((packed >> 36) & 0x1F) + 1;
  final frames = packed & 0xFFFFFFFFF;
  return CheAudioInfo(
    format: 'FLAC',
    sampleRate: sampleRate,
    channels: channels,
    bitDepth: bitDepth,
    frames: frames == 0 ? null : frames,
  );
}
