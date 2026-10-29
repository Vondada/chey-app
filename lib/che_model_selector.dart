// The model selector: which engine answers a request, and the one line that says so. Pure Dart: no network, no model load.
//
// Rules (owner, 2026-10-29): Auto uses the on-device model for everyday turns and a stronger online provider only for
// hard turns when the internet is available. Offline never uses the internet. Online never falls back to the device
// without saying so. Nothing switches engine silently: the reason is always returned for the answer to show.

enum CheModelMode { auto, offline, online }

enum CheEngine { onDevice, online, none }

class CheEngineChoice {
  const CheEngineChoice(this.engine, this.reason, {this.label = ''});

  final CheEngine engine;

  /// Why this engine was chosen, or why none was: shown to the owner, never a guess.
  final String reason;

  /// The name shown on the answer ("answered by ..."). Empty when no engine answered.
  final String label;
}

/// The engine for one request.
///
/// [internetAvailable] is what the phone can reach now. [onDeviceReady] is true only when the chosen on-device model is
/// installed and loaded. [hardTurn] is true for a turn that needs the stronger online provider.
CheEngineChoice chooseCheEngine({
  required CheModelMode mode,
  required bool internetAvailable,
  required bool onDeviceReady,
  required String onDeviceName,
  bool hardTurn = false,
  String onlineName = 'online provider',
}) {
  switch (mode) {
    case CheModelMode.offline:
      if (onDeviceReady) {
        return CheEngineChoice(CheEngine.onDevice, 'Offline mode: answered on this iPhone.', label: onDeviceName);
      }
      return const CheEngineChoice(
        CheEngine.none,
        'Offline mode is on, but no offline model is loaded on this iPhone. Nothing was sent online.',
      );
    case CheModelMode.online:
      if (internetAvailable) {
        return CheEngineChoice(CheEngine.online, 'Online mode: answered by the online provider.', label: onlineName);
      }
      return const CheEngineChoice(
        CheEngine.none,
        'Online mode is on, but there is no internet connection, so nothing was answered. Switch to Auto or Offline to use the phone.',
      );
    case CheModelMode.auto:
      if (hardTurn && internetAvailable) {
        return CheEngineChoice(CheEngine.online, 'Auto: a hard question, so the online provider answered.', label: onlineName);
      }
      if (onDeviceReady) {
        return CheEngineChoice(CheEngine.onDevice, 'Auto: answered on this iPhone.', label: onDeviceName);
      }
      if (internetAvailable) {
        return CheEngineChoice(CheEngine.online, 'Auto: no offline model is loaded, so the online provider answered.', label: onlineName);
      }
      return const CheEngineChoice(
        CheEngine.none,
        'No internet and no offline model is loaded, so nothing was answered.',
      );
  }
}

/// The owner's word for a mode, as the selector shows it.
String cheModelModeName(CheModelMode mode) => switch (mode) {
      CheModelMode.auto => 'Auto',
      CheModelMode.offline => 'Offline',
      CheModelMode.online => 'Online',
    };
