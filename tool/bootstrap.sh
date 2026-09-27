#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v flutter >/dev/null 2>&1; then
  echo "Flutter is required. Install the stable Flutter SDK first." >&2
  exit 1
fi

missing_platforms=()
[[ -d android ]] || missing_platforms+=(android)
[[ -d ios ]] || missing_platforms+=(ios)

if ((${#missing_platforms[@]} > 0)); then
  platforms=$(IFS=,; echo "${missing_platforms[*]}")
  flutter create \
    --org com.cheyapp \
    --project-name chey \
    --platforms "$platforms" \
    .
fi
rm -f test/widget_test.dart

flutter pub get

# Generate the iOS AppIcon set from assets/icon/icon.png (the "CHE" wordmark
# icon) on every build, so it's never out of sync with the source image.
if [[ -f assets/icon/icon.png && -d ios ]]; then
  dart run flutter_launcher_icons
fi

# Flutter generates ios/ on CI; permissions and display name must be in the
# generated Info.plist before the iPhone build asks for microphone/speech
# access. flutter create defaults CFBundleDisplayName to the project name
# ("chey"); the user-facing app should say CHE on the home screen.
if [[ -f ios/Runner/Info.plist ]]; then
  python3 - <<'PY'
import plistlib
from pathlib import Path

path = Path('ios/Runner/Info.plist')
with path.open('rb') as stream:
    info = plistlib.load(stream)
info['CFBundleDisplayName'] = 'CHE'
info['CFBundleName'] = 'CHE'
info['NSMicrophoneUsageDescription'] = 'CHE uses your microphone when you speak to your assistant or capture audio.'
info['NSSpeechRecognitionUsageDescription'] = 'CHE converts your speech to text when you use voice chat.'
info['NSCameraUsageDescription'] = 'CHE uses the camera only when you choose to capture a photo or video for CHE to analyze.'
info['NSPhotoLibraryUsageDescription'] = 'CHE accesses selected photos or videos only when you choose them for CHE to analyze.'
with path.open('wb') as stream:
    plistlib.dump(info, stream)
PY
fi


# Install the CHE native iPhone voice bridge after Flutter creates ios/.
# It supports provider-generated neural audio when available and a premium
# on-device AVSpeechSynthesizer fallback without adding another Flutter plugin.
if [[ -f ios/Runner/AppDelegate.swift ]]; then
  cat > ios/Runner/AppDelegate.swift <<'SWIFT'
import Flutter
import UIKit
import AVFoundation
import AppIntents

private final class CHEVoiceStreamHandler: NSObject, FlutterStreamHandler {
  func onListen(
    withArguments arguments: Any?,
    eventSink events: @escaping FlutterEventSink
  ) -> FlutterError? {
    nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    nil
  }
}

@available(iOS 16.0, *)
struct WakeCHEIntent: AppIntent {
  static let title: LocalizedStringResource = "Wake CHE"
  static let description = IntentDescription(
    "Opens CHE for a hands-free conversation."
  )

  // Apple allows this intent to be invoked while the device is locked.
  // iOS still decides whether presenting the full app UI requires unlock.
  static var authenticationPolicy: IntentAuthenticationPolicy {
    .alwaysAllowed
  }

  static var openAppWhenRun: Bool { true }

  @MainActor
  func perform() async throws -> some IntentResult & ProvidesDialog {
    // Use the same UserDefaults key Flutter's shared_preferences plugin
    // reads on iOS (it stores under the "flutter." prefix), so the app can
    // actually detect this and auto-resume the conversation on launch —
    // not just come to the foreground silently.
    UserDefaults.standard.set(true, forKey: "flutter.che_wake_requested")
    return .result(dialog: "Opening CHE.")
  }
}

@available(iOS 16.0, *)
struct CHEAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: WakeCHEIntent(),
      phrases: [
        "Wake \(.applicationName)",
        "Talk to \(.applicationName)",
        "Open \(.applicationName)",
      ],
      shortTitle: "Wake CHE",
      systemImageName: "waveform"
    )
  }
}

@main
@objc class AppDelegate: FlutterAppDelegate, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private var player: AVAudioPlayer?
  private var pendingSpeechResult: FlutterResult?
  private var pendingAudioResult: FlutterResult?
  private let voiceStreamHandler = CHEVoiceStreamHandler()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    synthesizer.delegate = self

    if let controller = window?.rootViewController as? FlutterViewController {
      let methods = FlutterMethodChannel(
        name: "che/native_voice",
        binaryMessenger: controller.binaryMessenger
      )
      let events = FlutterEventChannel(
        name: "che/native_voice_events",
        binaryMessenger: controller.binaryMessenger
      )
      events.setStreamHandler(voiceStreamHandler)

      methods.setMethodCallHandler { [weak self] call, result in
        guard let self else {
          result(FlutterError(code: "voice_unavailable", message: "CHE voice unavailable.", details: nil))
          return
        }

        switch call.method {
        case "start":
          // Flutter speech_to_text remains the reliable recognition layer.
          result(false)

        case "stop":
          self.stopAllAudio()
          result(true)

        case "sleep":
          result(true)

        case "wake":
          result(true)

        case "assistantSpeaking":          result(nil)

        case "status":
          result([
            "native_tts": true,
            "neural_audio_playback": true,
            "premium_voice_selection": true,
            "native_recognition": false,
          ])

        case "stopAudio":
          self.stopAllAudio()
          result(true)

        case "speakText":
          guard
            let args = call.arguments as? [String: Any],
            let text = args["text"] as? String,
            !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          else {
            result(false)
            return
          }
          self.speak(text, result: result)

        case "playAudio":
          guard let typed = call.arguments as? FlutterStandardTypedData else {
            result(false)
            return
          }
          self.play(data: typed.data, result: result)

        default:
          result(FlutterMethodNotImplemented)
        }
      }
    }

    return super.application(
      application,
      didFinishLaunchingWithOptions: launchOptions
    )
  }

  private func configureAudioSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
      )
      try session.setActive(true)
    } catch {
      // Speech still gets a chance to play with the system's current session.
    }
  }

  private func bestEnglishVoice() -> AVSpeechSynthesisVoice? {
    let voices = AVSpeechSynthesisVoice.speechVoices().filter {
      $0.language.lowercased().hasPrefix("en")
    }
    let preferred = ["Ava", "Samantha", "Zoe", "Nicky", "Serena"]

    func score(_ voice: AVSpeechSynthesisVoice) -> Int {
      var value = 0
      if voice.quality == .enhanced {
        value += 500
      }
      if #available(iOS 16.0, *), voice.quality == .premium {
        value += 1000
      }
      if let index = preferred.firstIndex(where: {
        voice.name.localizedCaseInsensitiveContains($0)
      }) {
        value += 300 - index
      }
      if voice.language.lowercased().hasPrefix("en-us") {
        value += 100
      }
      return value
    }

    return voices.max { score($0) < score($1) }
  }

  private func speak(_ text: String, result: @escaping FlutterResult) {
    stopAllAudio()
    configureAudioSession()

    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = bestEnglishVoice()
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.86
    utterance.pitchMultiplier = 0.96
    utterance.volume = 1.0
    utterance.preUtteranceDelay = 0.02
    utterance.postUtteranceDelay = 0.03

    pendingSpeechResult = result
    synthesizer.speak(utterance)
  }

  private func play(data: Data, result: @escaping FlutterResult) {
    stopAllAudio()
    configureAudioSession()

    do {
      let audioPlayer = try AVAudioPlayer(data: data)
      audioPlayer.delegate = self
      audioPlayer.prepareToPlay()
      player = audioPlayer
      pendingAudioResult = result

      guard audioPlayer.play() else {
        pendingAudioResult = nil
        result(false)
        return
      }
    } catch {
      result(FlutterError(
        code: "audio_playback_failed",
        message: "CHE could not play generated voice audio.",
        details: error.localizedDescription
      ))
    }
  }

  private func stopAllAudio() {
    if synthesizer.isSpeaking || synthesizer.isPaused {
      synthesizer.stopSpeaking(at: .immediate)
    }
    player?.stop()
    player = nil

    if let pending = pendingSpeechResult {
      pendingSpeechResult = nil
      pending(false)
    }
    if let pending = pendingAudioResult {
      pendingAudioResult = nil
      pending(false)
    }
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    if let pending = pendingSpeechResult {
      pendingSpeechResult = nil
      pending(true)
    }
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    if let pending = pendingSpeechResult {
      pendingSpeechResult = nil
      pending(false)
    }
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    self.player = nil
    if let pending = pendingAudioResult {
      pendingAudioResult = nil
      pending(flag)
    }
  }
}
SWIFT
fi
