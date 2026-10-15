"""Regression checks on CHE's generated iPhone audio code (tool/bootstrap.sh).

The Swift itself is compiled by the CHE iOS native build check on macOS; these
checks pin the audio decisions behind the owner's report of 2026-10-15 that
Connie's ElevenLabs voice was far too quiet. They run anywhere with Python.
"""

import re
import unittest
from pathlib import Path

BOOTSTRAP = Path(__file__).resolve().parent / "bootstrap.sh"


def app_delegate() -> str:
    text = BOOTSTRAP.read_text()
    start = text.index("cat > ios/Runner/AppDelegate.swift <<'SWIFT'\n") + len("cat > ios/Runner/AppDelegate.swift <<'SWIFT'\n")
    return text[start:text.index("\nSWIFT\n", start)]


def function(swift: str, signature: str) -> str:
    start = swift.index(signature)
    depth = 0
    for i in range(swift.index("{", start), len(swift)):
        if swift[i] == "{":
            depth += 1
        elif swift[i] == "}":
            depth -= 1
            if depth == 0:
                return swift[start:i + 1]
    raise AssertionError(f"unterminated {signature}")


class IosAudioSessionTest(unittest.TestCase):
    swift = app_delegate()

    def test_her_own_voice_is_never_ducked_to_a_whisper(self):
        # Voice processing counts CHE's AVAudioPlayer clip as "other audio".
        self.assertNotIn("duckingLevel: .max", self.swift)
        self.assertNotIn("enableAdvancedDucking: true", self.swift)
        self.assertRegex(self.swift, r"enableAdvancedDucking: false,\s*duckingLevel: \.min")
        # Applied on every iPhone that has the setting (iOS 17+), not only iOS 26.
        block = self.swift[self.swift.index("voiceProcessingOtherAudioDuckingConfiguration") - 400:self.swift.index("voiceProcessingOtherAudioDuckingConfiguration")]
        self.assertIn("#available(iOS 17.0, *)", block)

    def test_session_defaults_to_the_loudspeaker_and_full_quality_bluetooth(self):
        options = function(self.swift, "private var desiredCategoryOptions")
        for option in (".allowBluetooth", ".allowBluetoothA2DP", ".allowAirPlay", ".defaultToSpeaker"):
            self.assertIn(option, options)
        self.assertIn('outputPreference != "receiver"', options)
        configure = function(self.swift, "private func configureAudioSession()")
        # The session is reset when its options differ, not only category and mode.
        self.assertIn("session.categoryOptions != options", configure)
        self.assertIn("applyOutputRoute()", configure)

    def test_automatic_output_replaces_only_the_earpiece(self):
        route = function(self.swift, "private func applyOutputRoute(")
        auto = route[route.index("default:"):]
        self.assertIn('routeKind(session.currentRoute) == "receiver"', auto)
        self.assertIn("overrideOutputAudioPort(.speaker)", auto)
        # Codex on #315: Speaker then Automatic, or a device connected later,
        # must not leave a loudspeaker override that keeps her off Bluetooth.
        self.assertRegex(auto, r"if speakerForced \|\| newDevice \{\s*try session\.overrideOutputAudioPort\(\.none\)\s*speakerForced = false")
        self.assertLess(auto.index("overrideOutputAudioPort(.none)"), auto.index("overrideOutputAudioPort(.speaker)"))
        speaker = route[route.index('case "speaker":'):route.index('case "receiver":')]
        self.assertIn("speakerForced = true", speaker)
        receiver = route[route.index('case "receiver":'):route.index("default:")]
        self.assertIn("speakerForced || routeKind", receiver)
        observers = function(self.swift, "private func installAudioObservers()")
        self.assertIn("self.applyOutputRoute(newDevice: reason == .newDeviceAvailable)", observers)
        kinds = function(self.swift, "private func routeKind(")
        for port, kind in ((".builtInReceiver", "receiver"), (".builtInSpeaker", "speaker"), (".bluetoothA2DP", "bluetooth"),
                           (".headphones", "headphones"), (".airPlay", "airplay"), (".carAudio", "car")):
            self.assertRegex(kinds, re.escape(port) + r"[^\n]*return \"" + kind + '"')

    def test_route_changes_and_interruptions_are_handled(self):
        observers = function(self.swift, "private func installAudioObservers()")
        self.assertIn("AVAudioSession.routeChangeNotification", observers)
        self.assertIn("AVAudioSession.interruptionNotification", observers)
        self.assertIn(".categoryChange", observers, "a category reset that falls back to the earpiece is corrected")
        self.assertIn(".AVAudioEngineConfigurationChange", observers)
        # A restart storm is impossible: only a stopped engine, a while after a start.
        self.assertIn("!self.audioEngine.isRunning", observers)
        self.assertIn("timeIntervalSince(self.lastStreamStart) > 1.0", observers)

    def test_clip_playback_uses_voice_volume_words_and_safe_normalization(self):
        self.assertIn('case "playClip":', self.swift)
        self.assertIn('case "playAudio":', self.swift, "older Dart keeps working")
        play = function(self.swift, "private func startPlayer(")
        self.assertIn("audioPlayer.volume = max(0, min(1, volume))", play)
        self.assertNotIn("outputVolume =", self.swift, "CHE never sets the iPhone's own volume")
        loud = function(self.swift, "private func loudnessNormalized(")
        self.assertIn("guard rmsDb < -24", loud, "a normal clip plays exactly as it arrived")
        self.assertIn("min(-19 - rmsDb, -1 - peakDb, 12)", loud, "never past -1 dBFS peak, at most +12 dB")
        echo = function(self.swift, "private func looksLikeAssistantEcho(")
        self.assertIn("stopWords", echo, "the owner's 'stop' over her voice still interrupts")
        # Common words never make an interruption look like her own echo.
        self.assertIn("guard meaningful.count >= 3 else { return false }", echo)
        prefer = function(self.swift, "private func setOutputPreference(")
        self.assertNotIn("guard preference != outputPreference else { return }", prefer, "an unchanged choice still re-applies the route")

    def test_failed_native_audio_route_never_acknowledges_a_private_change(self):
        route = function(self.swift, "private func applyOutputRoute(")
        self.assertIn("return false", route, "an override exception must fail the caller")
        self.assertIn("return true", route)
        output = function(self.swift, "private func setOutputPreference(")
        self.assertIn("guard configureAudioSession() else", output)
        self.assertIn("outputPreference = previous", output)
        self.assertLess(output.index("guard configureAudioSession() else"), output.index("UserDefaults.standard.set"))
        self.assertIn('code: "audio_route_failed"', self.swift)
        method = self.swift[self.swift.index('case "setAudioOutput":'):self.swift.index('case "setAudioOutput":') + 440]
        self.assertIn("if self.setOutputPreference", method)
        self.assertIn("FlutterError(", method)
        clip = self.swift[self.swift.index('case "playClip":'):self.swift.index('case "playClip":') + 900]
        self.assertIn("!self.setOutputPreference(output)", clip)

    def test_status_reports_the_new_abilities(self):
        self.assertIn('"output_route_control": true', self.swift)
        self.assertIn('case "audioRoute":', self.swift)
        self.assertIn('case "setAudioOutput":', self.swift)


if __name__ == "__main__":
    unittest.main()
