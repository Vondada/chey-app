// The Recording Studio's link to the iPhone's audio hardware, over CHE's existing native voice channel
// (tool/bootstrap.sh, AppDelegate): playClip and stopAudio play rendered mixes (present on every installed build),
// and recordStart / recordStop / recordLevel record a take from the microphone or an audio interface (added
// 2026-10-24, so they exist only on builds made after that; an older build answers "not implemented" and the
// studio says recording needs the next app build instead of pretending).
import 'package:flutter/services.dart';

/// A finished take: the WAV the iPhone wrote and the latencies it measured while recording.
class CheTake {
  const CheTake({required this.wav, required this.seconds, this.inputLatency = 0, this.outputLatency = 0, this.route = '', this.input = ''});
  final Uint8List wav;
  final double seconds;
  final double inputLatency;
  final double outputLatency;
  final String route;
  final String input;
}

/// Why the hardware said no, in words the owner can act on.
class CheAudioUnavailable implements Exception {
  CheAudioUnavailable(this.message);
  final String message;
  @override
  String toString() => message;
}

abstract class CheStudioAudio {
  /// Starts a take. Returns the measured latencies and route, or throws [CheAudioUnavailable].
  Future<Map<String, dynamic>> startRecording();

  /// Stops the take and returns it, or null when nothing was recording.
  Future<CheTake?> stopRecording();

  /// The live input level while recording (dBFS), or null.
  Future<double?> level();

  /// Plays WAV bytes; completes when playback ends (true) or was stopped or failed (false).
  Future<bool> play(Uint8List wav);

  Future<void> stop();

  /// Where sound is going: "speaker", "bluetooth", "headphones", "usb", ... and the measured output latency.
  Future<Map<String, dynamic>> route();
}

const _recordingNeedsBuild =
    'Recording needs the next CHE app build: this installed version has no microphone recorder yet. Playback, the Beat Maker, effects, mixing, mastering, importing WAV files and exporting all work now.';

class CheNativeStudioAudio implements CheStudioAudio {
  CheNativeStudioAudio([MethodChannel? channel]) : _ch = channel ?? const MethodChannel('che/native_voice');
  final MethodChannel _ch;

  @override
  Future<Map<String, dynamic>> startRecording() async {
    try {
      final v = await _ch.invokeMethod<Object?>('recordStart', {'sample_rate': 44100});
      if (v is Map) return Map<String, dynamic>.from(v);
      throw CheAudioUnavailable('The microphone did not start.');
    } on MissingPluginException {
      throw CheAudioUnavailable(_recordingNeedsBuild);
    } on PlatformException catch (e) {
      throw CheAudioUnavailable(e.message ?? 'The microphone did not start.');
    }
  }

  @override
  Future<CheTake?> stopRecording() async {
    try {
      final v = await _ch.invokeMethod<Object?>('recordStop');
      if (v is! Map || v['wav'] is! Uint8List) return null;
      double n(Object? x) => (x as num?)?.toDouble() ?? 0;
      return CheTake(
        wav: v['wav'] as Uint8List,
        seconds: n(v['seconds']),
        inputLatency: n(v['input_latency']),
        outputLatency: n(v['output_latency']),
        route: '${v['route'] ?? ''}',
        input: '${v['input'] ?? ''}',
      );
    } on MissingPluginException {
      return null;
    } on PlatformException catch (e) {
      throw CheAudioUnavailable(e.message ?? 'The take could not be read back.');
    }
  }

  @override
  Future<double?> level() async {
    try {
      final v = await _ch.invokeMethod<Object?>('recordLevel');
      return v is Map && v['recording'] == true ? (v['db'] as num?)?.toDouble() : null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<bool> play(Uint8List wav) async {
    try {
      // Music plays at full level with no loudness normalisation (that is for CHE's voice clips).
      final v = await _ch.invokeMethod<Object?>('playClip', {'bytes': wav, 'text': '', 'volume': 1.0, 'normalize': false});
      return v is Map ? v['played'] == true : v == true;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> stop() async {
    try {
      await _ch.invokeMethod<Object?>('stopAudio');
    } catch (_) {}
  }

  @override
  Future<Map<String, dynamic>> route() async {
    try {
      final v = await _ch.invokeMethod<Object?>('audioRoute');
      return v is Map ? Map<String, dynamic>.from(v) : const {};
    } catch (_) {
      return const {};
    }
  }
}

/// The warning for the current output, or empty. Bluetooth audio adds roughly 150 to 300 ms, so a take recorded
/// against it lands late unless it is compensated.
String cheLatencyWarning(Map<String, dynamic> route, {double measuredOutput = 0}) {
  if ('${route['route']}' != 'bluetooth') return '';
  final ms = measuredOutput > 0 ? ' The iPhone measured ${(measuredOutput * 1000).round()} ms of output delay, and CHE shifts takes back by that.' : '';
  return 'Bluetooth headphones are connected. They delay what you hear, so recording against the beat can drift.$ms For the tightest takes, use wired headphones.';
}
