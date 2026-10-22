// Song-file headers: the catalog must describe the real file, never guess.
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:chey/music/che_audio_header.dart';

Uint8List _wav({required int rate, required int channels, required int bits, required int frames, bool extensible = false}) {
  final blockAlign = channels * bits ~/ 8;
  final dataBytes = frames * blockAlign;
  final fmtSize = extensible ? 40 : 16;
  final out = BytesBuilder();
  void str(String s) => out.add(s.codeUnits);
  void u32(int v) => out.add((ByteData(4)..setUint32(0, v, Endian.little)).buffer.asUint8List());
  void u16(int v) => out.add((ByteData(2)..setUint16(0, v, Endian.little)).buffer.asUint8List());
  str('RIFF');
  u32(4 + (8 + fmtSize) + (8 + dataBytes));
  str('WAVE');
  str('fmt ');
  u32(fmtSize);
  u16(extensible ? 0xFFFE : 1);
  u16(channels);
  u32(rate);
  u32(rate * blockAlign);
  u16(blockAlign);
  u16(bits);
  if (extensible) out.add(Uint8List(fmtSize - 16));
  str('data');
  u32(dataBytes);
  out.add(Uint8List(dataBytes));
  return out.toBytes();
}

Uint8List _aiff({required int rate, required int channels, required int bits, required int frames}) {
  final out = BytesBuilder();
  final comm = ByteData(18)
    ..setInt16(0, channels)
    ..setUint32(2, frames)
    ..setInt16(6, bits);
  // 80-bit extended float for [rate]: exponent then 64-bit mantissa with explicit leading 1.
  final exponent = 16383 + (rate.bitLength - 1);
  final mantissa = BigInt.from(rate) << (63 - (rate.bitLength - 1));
  comm.setUint16(8, exponent);
  comm.setUint32(10, (mantissa >> 32).toInt());
  comm.setUint32(14, (mantissa & BigInt.from(0xFFFFFFFF)).toInt());
  out.add('FORM'.codeUnits);
  out.add(Uint8List(4));
  out.add('AIFF'.codeUnits);
  out.add('COMM'.codeUnits);
  out.add((ByteData(4)..setUint32(0, 18)).buffer.asUint8List());
  out.add(comm.buffer.asUint8List());
  return out.toBytes();
}

Uint8List _flac({required int rate, required int channels, required int bits, required int samples}) {
  final packed = (BigInt.from(rate) << 44) |
      (BigInt.from(channels - 1) << 41) |
      (BigInt.from(bits - 1) << 36) |
      BigInt.from(samples);
  final streamInfo = Uint8List(34);
  ByteData.sublistView(streamInfo, 10, 18).setUint64(0, packed.toUnsigned(64).toInt());
  return Uint8List.fromList([
    ...'fLaC'.codeUnits,
    0x00, 0x00, 0x00, 34, // STREAMINFO block, last-block flag clear, length 34
    ...streamInfo,
  ]);
}

void main() {
  test('WAV: 16-bit stereo 44.1 kHz reports format, bit depth and exact duration', () {
    final info = parseAudioHeader(_wav(rate: 44100, channels: 2, bits: 16, frames: 44100 * 3))!;
    expect(info.format, 'WAV');
    expect(info.sampleRate, 44100);
    expect(info.channels, 2);
    expect(info.bitDepth, 16);
    expect(info.durationSeconds, 3.0);
  });

  test('WAV: 24-bit 48 kHz via WAVE_FORMAT_EXTENSIBLE', () {
    final info = parseAudioHeader(_wav(rate: 48000, channels: 2, bits: 24, frames: 48000, extensible: true))!;
    expect(info.format, 'WAV');
    expect(info.sampleRate, 48000);
    expect(info.bitDepth, 24);
    expect(info.durationSeconds, 1.0);
  });

  test('AIFF: sample rate is read from the 80-bit extended field', () {
    final info = parseAudioHeader(_aiff(rate: 44100, channels: 1, bits: 16, frames: 22050))!;
    expect(info.format, 'AIFF');
    expect(info.sampleRate, 44100);
    expect(info.channels, 1);
    expect(info.bitDepth, 16);
    expect(info.durationSeconds, 0.5);
  });

  test('FLAC: STREAMINFO gives rate, channels, bit depth and total samples', () {
    final info = parseAudioHeader(_flac(rate: 44100, channels: 2, bits: 16, samples: 44100 * 2))!;
    expect(info.format, 'FLAC');
    expect(info.sampleRate, 44100);
    expect(info.channels, 2);
    expect(info.bitDepth, 16);
    expect(info.durationSeconds, 2.0);
  });

  test('MP3 and M4A are recognized, but their length is not invented', () {
    final mp3 = parseAudioHeader(Uint8List.fromList([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]))!;
    expect(mp3.format, 'MP3');
    expect(mp3.durationSeconds, isNull);
    final m4a = parseAudioHeader(Uint8List.fromList([0, 0, 0, 0x20, ...'ftypM4A '.codeUnits, 0, 0, 0, 0]))!;
    expect(m4a.format, 'M4A');
    expect(m4a.durationSeconds, isNull);
  });

  test('unknown or truncated bytes are not a song', () {
    expect(parseAudioHeader(Uint8List.fromList('hello world, not audio'.codeUnits)), isNull);
    expect(parseAudioHeader(Uint8List(4)), isNull);
  });

  test('a WAV whose data chunk is missing still reports format without a length', () {
    final full = _wav(rate: 44100, channels: 2, bits: 16, frames: 10);
    final noData = Uint8List.sublistView(full, 0, 36);
    final info = parseAudioHeader(noData)!;
    expect(info.sampleRate, 44100);
    expect(info.frames, isNull);
    expect(info.durationSeconds, isNull);
  });
}
