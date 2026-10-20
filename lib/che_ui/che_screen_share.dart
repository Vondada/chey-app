// Screen sharing (owner, 2026-10-20): CHE seeing another app's screen
// through the iOS ReplayKit broadcast extension (CheBroadcast). The owner
// starts and stops the broadcast in the system sheet; iOS never lets an app
// start it alone, and shows a red indicator while it runs. The extension
// keeps the last few frames on the iPhone; CHE sends one to the Worker only
// when the owner asks "look at my screen". Builds without the extension
// (older IPAs receiving this as a Shorebird patch) answer "not available".

import 'dart:convert';

import 'package:flutter/services.dart';

import 'che_screen_capture.dart';

class CheScreenShareStatus {
  const CheScreenShareStatus({this.available = false, this.active = false, this.paused = false});

  /// This build has the extension and the shared folder.
  final bool available;

  /// A broadcast is running right now (its heartbeat is fresh).
  final bool active;
  final bool paused;
}

class CheScreenShare {
  CheScreenShare._();

  static const _channel = MethodChannel('che/screen_share');

  static Future<CheScreenShareStatus> status() async {
    try {
      final raw = await _channel.invokeMapMethod<String, dynamic>('status');
      return CheScreenShareStatus(
        available: raw?['available'] == true,
        active: raw?['active'] == true,
        paused: raw?['paused'] == true,
      );
    } on MissingPluginException {
      return const CheScreenShareStatus();
    } on PlatformException {
      return const CheScreenShareStatus();
    }
  }

  /// The shared screen as CHE should read it: the newest frame from before
  /// the owner came back to CHE (the other app), else the newest one. Null
  /// when nothing is being shared.
  static Future<CheScreenShot?> frame() async {
    try {
      final raw = await _channel.invokeMapMethod<String, dynamic>('latestFrame');
      final bytes = raw?['bytes'];
      if (bytes is! Uint8List || bytes.isEmpty) return null;
      final at = raw?['at'];
      return CheScreenShot.shared(
        base64: base64Encode(bytes),
        width: (raw?['width'] as num?)?.toInt() ?? 0,
        height: (raw?['height'] as num?)?.toInt() ?? 0,
        at: at is num ? DateTime.fromMillisecondsSinceEpoch((at * 1000).round()) : null,
        beforeSwitch: raw?['before_switch'] == true,
      );
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  /// Opens the system "Screen Broadcast" sheet with CHE's extension chosen.
  static Future<bool> showPicker() async {
    try {
      return await _channel.invokeMethod<bool>('showPicker') ?? false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }
}

String _normalize(String raw) => raw.trim().toLowerCase().replaceAll('’', "'").replaceAll(RegExp(r'[.!?]+$'), '')
    .replaceFirst(RegExp(r'^(?:(?:hey|hi|ok|okay)[\s,]+)?(?:che|chay|chey|shay)[\s,.:!]+'), '')
    .replaceFirst(RegExp(r'^(?:please|can you|could you|would you|i want to|let me)\s+'), '').trim();

/// "Share my screen", "start screen sharing", "watch my screen".
bool cheAsksToShareScreen(String raw) => RegExp(
      r"^(?:start |begin |turn on )?(?:sharing (?:my|the) screen|screen ?sharing|sharing my screen)(?: with (?:you|che))?$"
      r"|^share (?:my|the|this) (?:whole )?screen(?: with (?:you|che))?$"
      r"|^(?:watch|follow) (?:my|the) screen$",
    ).hasMatch(_normalize(raw));

/// "Stop sharing my screen", "stop screen sharing", "stop watching my screen".
bool cheAsksToStopSharing(String raw) => RegExp(
      r"^(?:stop|end|turn off) (?:sharing (?:my|the) screen|screen ?sharing|the screen ?share|watching (?:my|the) screen|the broadcast|broadcasting)$",
    ).hasMatch(_normalize(raw));
