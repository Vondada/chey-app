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

# CHE requires iOS 16+ for the Porcupine 4.x on-device wake-word engine.
# Apple Vocal Shortcuts remains the iPhone-level trigger; Porcupine is used
# only while CHE is active/asleep, and Realtime owns the mic after wake.
if [[ -f ios/Podfile ]]; then
  python3 - <<'PY'
from pathlib import Path
import re
p = Path('ios/Podfile')
text = p.read_text()
if re.search(r"^\s*#?\s*platform\s+:ios", text, flags=re.M):
    text = re.sub(r"^\s*#?\s*platform\s+:ios,\s*'[^']+'", "platform :ios, '16.0'", text, flags=re.M)
else:
    text = "platform :ios, '16.0'\n" + text
p.write_text(text)
PY
fi
if [[ -f ios/Runner.xcodeproj/project.pbxproj ]]; then
  python3 - <<'PY'
from pathlib import Path
import re
p = Path('ios/Runner.xcodeproj/project.pbxproj')
text = p.read_text()
text = re.sub(r"IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;", "IPHONEOS_DEPLOYMENT_TARGET = 16.0;", text)
p.write_text(text)
PY
fi

# Build the source icon inside CI so the repository stays text-only while every
# IPA still gets the same bold CHE icon.
dart run tool/generate_icon.dart

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
# Flutter Scene renders natively through Flutter GPU / Impeller.
info['FLTEnableFlutterGPU'] = True
info['CFBundleName'] = 'CHE'
# Flutter Scene renders through Flutter GPU/Impeller on iOS.
info['FLTEnableFlutterGPU'] = True
info['NSMicrophoneUsageDescription'] = 'CHE uses your microphone when you speak to your assistant or capture audio.'
info['NSSpeechRecognitionUsageDescription'] = 'CHE converts your speech to text when you use voice chat.'
info['NSCameraUsageDescription'] = 'CHE uses the camera only when you choose to capture a photo or video for CHE to analyze.'
info['NSPhotoLibraryUsageDescription'] = 'CHE accesses selected photos or videos only when you choose them for CHE to analyze.'
info['NSPhotoLibraryAddUsageDescription'] = 'CHE saves generated or edited media to Photos only when you choose Save.'
info['NSFaceIDUsageDescription'] = 'CHE uses Face ID to unlock your private connected-account vault.'
info['NSContactsUsageDescription'] = 'CHE accesses contacts only when you explicitly authorize a contact-based action.'
info['NSCalendarsUsageDescription'] = 'CHE accesses your calendar only for owner-authorized scheduling and calendar actions.'
info['NSCalendarsFullAccessUsageDescription'] = 'CHE accesses your calendar only for owner-authorized scheduling and calendar actions.'
info['NSRemindersUsageDescription'] = 'CHE accesses reminders only for owner-authorized reminder actions.'
info['NSRemindersFullAccessUsageDescription'] = 'CHE accesses reminders only for owner-authorized reminder actions.'
info['NSBluetoothAlwaysUsageDescription'] = 'CHE uses Bluetooth only for owner-authorized accessories, audio, and supported devices.'
info['NSLocalNetworkUsageDescription'] = 'CHE uses the local network only to connect to owner-authorized devices and services.'
info['NSAppleMusicUsageDescription'] = 'CHE accesses your media library only for owner-authorized music actions.'
info['NSLocationWhenInUseUsageDescription'] = 'CHE uses your location only while you are using location-aware features.'
info['CFBundleURLTypes'] = [{'CFBundleURLName': 'CHE', 'CFBundleURLSchemes': ['che']}]
# CHE can hand a verified IPA URL directly to SideStore. This only declares
# the URL scheme for canOpenURL; it does not grant SideStore any CHE data.
schemes = set(info.get('LSApplicationQueriesSchemes', []))
schemes.add('sidestore')
info['LSApplicationQueriesSchemes'] = sorted(schemes)
info['BGTaskSchedulerPermittedIdentifiers'] = ['com.cheyapp.che.refresh']
info['UIBackgroundModes'] = ['audio', 'fetch']
# Conversation logs (Documents/che_logs) show in Files → On My iPhone → CHE.
info['UIFileSharingEnabled'] = True
info['LSSupportsOpeningDocumentsInPlace'] = True
with path.open('wb') as stream:
    plistlib.dump(info, stream)
PY
fi


# Install the CHE native iPhone voice bridge after Flutter creates ios/.
# FREE VOICE MODE: iOS Speech + premium AVSpeechSynthesizer. This keeps the
# voice layer on-device / Apple-provided and adds hands-free barge-in so the
# owner can interrupt CHE while she is speaking without paying a voice API.
if [[ -f ios/Runner/AppDelegate.swift ]]; then
  cat > ios/Runner/AppDelegate.swift <<'SWIFT'
import Flutter
import UIKit
import AVFoundation
import Speech
import AppIntents
import LocalAuthentication
import Security
import UserNotifications
import BackgroundTasks

private final class CHEVoiceStreamHandler: NSObject, FlutterStreamHandler {
  private var sink: FlutterEventSink?

  func onListen(
    withArguments arguments: Any?,
    eventSink events: @escaping FlutterEventSink
  ) -> FlutterError? {
    sink = events
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    sink = nil
    return nil
  }

  func emit(_ event: [String: Any]) {
    DispatchQueue.main.async { [weak self] in
      self?.sink?(event)
    }
  }
}

@available(iOS 17.0, *)
struct WakeCHEIntent: AppIntent {
  static let title: LocalizedStringResource = "Wake CHE"
  static let description = IntentDescription(
    "Opens CHE for a hands-free conversation. Assign this action to an Apple Vocal Shortcut such as Hey CHE or Chay."
  )

  static var authenticationPolicy: IntentAuthenticationPolicy {
    .alwaysAllowed
  }

  static var openAppWhenRun: Bool { true }

  @MainActor
  func perform() async throws -> some IntentResult & ProvidesDialog {
    UserDefaults.standard.set(true, forKey: "flutter.che_wake_requested")
    return .result(dialog: "Opening CHE.")
  }
}

@available(iOS 17.0, *)
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
  private let audioEngine = AVAudioEngine()
  private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var utteranceTimer: Timer?
  private var keepAliveTimer: Timer?
  private var hasInputTap = false
  private var nativeVoiceRunning = false
  private var assistantSpeaking = false
  private var bargeInDetected = false
  private var latestTranscript = ""
  private var lastDeliveredTranscript = ""
  private var lastDeliveredAt = Date.distantPast
  private var assistantText = ""
  private var ignoreBargeInUntil = Date.distantPast
  private var recognitionGeneration = 0
  private var wakeSignalSent = false
  // Where CHE's voice plays: "auto" (the loudspeaker, or the headphones,
  // Bluetooth, AirPlay or car the owner has connected), "speaker" (always the
  // loudspeaker) or "receiver" (the earpiece, for privacy).
  private var outputPreference =
    UserDefaults.standard.string(forKey: "che.voice.outputPreference") ?? "auto"
  private var audioObserversInstalled = false
  // True while a loudspeaker override from the Speaker choice may be in
  // place; Automatic and Earpiece clear it.
  private var speakerForced = false
  private var playbackGeneration = 0
  private var pendingClipInfo: [String: Any]?
  private var normalizedClipURL: URL?
  private var lastStreamStart = Date.distantPast

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    synthesizer.delegate = self
    if #available(iOS 13.0, *) {
      BGTaskScheduler.shared.register(
        forTaskWithIdentifier: "com.cheyapp.che.refresh",
        using: nil
      ) { task in
        task.setTaskCompleted(success: true)
      }
    }

    // Flutter's UIScene lifecycle creates the window after launch, so
    // window.rootViewController is nil here and channels built from it never
    // existed: the iPhone could not play CHE's server voice and spoke with the
    // system voice instead (owner's voice diagnostics, 2026-10-14). The app
    // delegate's plugin registrar has the engine's messenger in both lifecycles.
    if let messenger = (window?.rootViewController as? FlutterViewController)?.binaryMessenger
      ?? self.registrar(forPlugin: "CHENativeBridge")?.messenger() {
      let methods = FlutterMethodChannel(
        name: "che/native_voice",
        binaryMessenger: messenger
      )
      let events = FlutterEventChannel(
        name: "che/native_voice_events",
        binaryMessenger: messenger
      )
      events.setStreamHandler(voiceStreamHandler)

      let nativeShell = FlutterMethodChannel(
        name: "che/native_shell",
        binaryMessenger: messenger
      )
      nativeShell.setMethodCallHandler { call, result in
        switch call.method {
        case "requestNotifications":
          UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound, .badge]
          ) { granted, _ in
            DispatchQueue.main.async { result(granted) }
          }
        case "showNotification":
          guard
            let args = call.arguments as? [String: Any],
            let title = args["title"] as? String,
            let body = args["body"] as? String,
            !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          else {
            result(false)
            break
          }
          let content = UNMutableNotificationContent()
          content.title = String(title.prefix(120))
          content.body = String(body.prefix(1000))
          content.sound = .default
          content.badge = 1
          let identifier = (args["id"] as? String) ?? UUID().uuidString
          let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.2, repeats: false)
          let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
          UNUserNotificationCenter.current().add(request) { error in
            DispatchQueue.main.async { result(error == nil) }
          }
        case "scheduleRefresh":
          if #available(iOS 13.0, *) {
            let request = BGAppRefreshTaskRequest(
              identifier: "com.cheyapp.che.refresh"
            )
            request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
            do {
              try BGTaskScheduler.shared.submit(request)
              result(true)
            } catch {
              result(false)
            }
          } else {
            result(false)
          }
        case "appVersion":
          result([
            "version": Bundle.main.object(
              forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String ?? "",
            "build": Bundle.main.object(
              forInfoDictionaryKey: "CFBundleVersion"
            ) as? String ?? "",
          ])
        default:
          result(FlutterMethodNotImplemented)
        }
      }

      let accountBridge = FlutterMethodChannel(
        name: "che/account_bridge",
        binaryMessenger: messenger
      )
      accountBridge.setMethodCallHandler { [weak self] call, result in
        guard let self else {
          result(false)
          return
        }

        switch call.method {
        case "authenticate":
          let args = call.arguments as? [String: Any]
          let reason = (args?["reason"] as? String) ?? "Unlock CHE"
          let requireFaceId = (args?["requireFaceId"] as? Bool) ?? false
          self.authenticateOwner(
            reason: reason,
            requireFaceId: requireFaceId,
            result: result
          )

        case "secureSet":
          guard
            let args = call.arguments as? [String: Any],
            let key = args["key"] as? String,
            let value = args["value"] as? String
          else {
            result(false)
            return
          }
          result(self.keychainSet(key: key, value: value))

        case "secureGet":
          guard
            let args = call.arguments as? [String: Any],
            let key = args["key"] as? String
          else {
            result(nil)
            return
          }
          result(self.keychainGet(key: key))

        case "secureDelete":
          guard
            let args = call.arguments as? [String: Any],
            let key = args["key"] as? String
          else {
            result(false)
            return
          }
          result(self.keychainDelete(key: key))

        default:
          result(FlutterMethodNotImplemented)
        }
      }

      methods.setMethodCallHandler { [weak self] call, result in
        guard let self else {
          result(FlutterError(
            code: "voice_unavailable",
            message: "CHE voice unavailable.",
            details: nil
          ))
          return
        }

        switch call.method {
        case "start":
          self.startNativeRecognition(result: result)

        case "stop":
          self.stopNativeRecognition()
          self.stopAllAudio()
          result(true)

        case "sleep":
          result(true)

        case "wake":
          if !self.nativeVoiceRunning {
            self.startNativeRecognition(result: result)
          } else {
            result(true)
          }

        case "assistantSpeaking":
          let speaking = (call.arguments as? Bool) ?? false
          self.setAssistantSpeaking(speaking)
          result(nil)

        case "status":
          result([
            "native_tts": true,
            "neural_audio_playback": true,
            "premium_voice_selection": true,
            "native_recognition": true,
            "barge_in": true,
            "free_voice_mode": true,
            "output_route_control": true,
            "loudness_normalization": true,
            "on_device_recognition":
              self.speechRecognizer?.supportsOnDeviceRecognition == true,
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

        case "playClip":
          // One ElevenLabs or Fish clip with its words (so CHE never takes her
          // own voice for an interruption), the owner's Voice Volume and his
          // output choice. Answers with what was measured and where it played.
          guard
            let args = call.arguments as? [String: Any],
            let typed = args["bytes"] as? FlutterStandardTypedData
          else {
            result(false)
            return
          }
          if let output = args["output"] as? String, !self.setOutputPreference(output) {
            result(FlutterError(code: "audio_route_failed", message: "CHE could not safely route this voice clip.", details: nil))
            return
          }
          self.play(
            data: typed.data,
            text: (args["text"] as? String) ?? "",
            volume: (args["volume"] as? NSNumber)?.floatValue ?? 1.0,
            normalize: (args["normalize"] as? Bool) ?? true,
            clip: true,
            result: result
          )

        case "audioRoute":
          result(self.routeSummary())

        case "setAudioOutput":
          if self.setOutputPreference((call.arguments as? String) ?? "auto") {
            result(self.routeSummary())
          } else {
            result(FlutterError(code: "audio_route_failed", message: "CHE could not change audio output. The previous choice is unchanged.", details: nil))
          }

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

  private let accountService = "com.cheyapp.che.accountbridge"

  private func authenticateOwner(
    reason: String,
    requireFaceId: Bool,
    result: @escaping FlutterResult
  ) {
    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    context.localizedFallbackTitle = requireFaceId ? "" : "Use Passcode"
    var error: NSError?

    let policy: LAPolicy
    if requireFaceId {
      guard context.canEvaluatePolicy(
        .deviceOwnerAuthenticationWithBiometrics,
        error: &error
      ) else {
        result(false)
        return
      }
      guard context.biometryType == .faceID else {
        result(false)
        return
      }
      policy = .deviceOwnerAuthenticationWithBiometrics
    } else {
      guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
        result(false)
        return
      }
      policy = .deviceOwnerAuthentication
    }

    context.evaluatePolicy(
      policy,
      localizedReason: reason
    ) { success, _ in
      DispatchQueue.main.async {
        result(success)
      }
    }
  }

  private func keychainSet(key: String, value: String) -> Bool {
    guard !key.isEmpty, key.count <= 160,
          let data = value.data(using: .utf8) else {
      return false
    }

    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: accountService,
      kSecAttrAccount as String: key,
    ]
    SecItemDelete(query as CFDictionary)

    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
  }

  private func keychainGet(key: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: accountService,
      kSecAttrAccount as String: key,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  private func keychainDelete(key: String) -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: accountService,
      kSecAttrAccount as String: key,
    ]
    let status = SecItemDelete(query as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }

  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    UserDefaults.standard.set(
      url.absoluteString,
      forKey: "flutter.che_pending_deep_link"
    )
    return super.application(app, open: url, options: options)
  }

  // The same options the Flutter side's WebRTC helper sets, so the two never
  // flip the session back and forth. A2DP lets Bluetooth headphones play
  // CHE in full quality; the earpiece choice drops defaultToSpeaker.
  private var desiredCategoryOptions: AVAudioSession.CategoryOptions {
    var options: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP, .allowAirPlay]
    if outputPreference != "receiver" {
      options.insert(.defaultToSpeaker)
    }
    return options
  }

  @discardableResult
  private func configureAudioSession() -> Bool {
    let session = AVAudioSession.sharedInstance()
    installAudioObservers()
    // Re-applying an unchanged category/mode for every clip interrupts
    // recognition and adds a route change between sentences; only set it
    // when it actually differs, and keep the session active for the turn.
    let options = desiredCategoryOptions
    if session.category != .playAndRecord || session.mode != .voiceChat || session.categoryOptions != options {
      do {
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
      } catch {
        voiceStreamHandler.emit([
          "type": "error",
          "message": "CHE could not configure iPhone voice audio."
        ])
        return false
      }
    }
    do {
      try session.setActive(true)
    } catch {
      voiceStreamHandler.emit(["type": "error", "message": "CHE could not activate iPhone voice audio."])
      return false
    }
    return applyOutputRoute()
  }

  /// Puts CHE's voice where the owner wants it. Automatic replaces only the
  /// quiet built-in earpiece with the loudspeaker; headphones, Bluetooth,
  /// AirPlay or a car the owner connected keep playing her.
  @discardableResult
  private func applyOutputRoute(newDevice: Bool = false) -> Bool {
    let session = AVAudioSession.sharedInstance()
    do {
      switch outputPreference {
      case "speaker":
        if routeKind(session.currentRoute) != "speaker" {
          try session.overrideOutputAudioPort(.speaker)
        }
        speakerForced = true
      case "receiver":
        if speakerForced || routeKind(session.currentRoute) == "speaker" {
          try session.overrideOutputAudioPort(.none)
        }
        speakerForced = false
      default:
        // Automatic never keeps a loudspeaker override left by the Speaker
        // choice, or one set before a device was connected: the owner's
        // headphones, Bluetooth, AirPlay or car then play her.
        if speakerForced || newDevice {
          try session.overrideOutputAudioPort(.none)
          speakerForced = false
        }
        if routeKind(session.currentRoute) == "receiver" {
          try session.overrideOutputAudioPort(.speaker)
        }
      }
      return true
    } catch {
      voiceStreamHandler.emit([
        "type": "error",
        "message": "CHE could not switch the iPhone speaker: \(error.localizedDescription)"
      ])
      return false
    }
  }

  @discardableResult
  private func setOutputPreference(_ value: String) -> Bool {
    let preference = ["auto", "speaker", "receiver"].contains(value) ? value : "auto"
    let previous = outputPreference
    outputPreference = preference
    // Validate and apply the route BEFORE persisting it. A failed native
    // override must never look like a successful private-earpiece choice.
    guard configureAudioSession() else {
      outputPreference = previous
      _ = configureAudioSession()
      return false
    }
    if preference != previous {
      UserDefaults.standard.set(preference, forKey: "che.voice.outputPreference")
    }
    return true
  }

  /// The kind of output CHE is playing through right now.
  private func routeKind(_ route: AVAudioSessionRouteDescription) -> String {
    guard let port = route.outputs.first?.portType else { return "none" }
    switch port {
    case .builtInReceiver: return "receiver"
    case .builtInSpeaker: return "speaker"
    case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE: return "bluetooth"
    case .headphones: return "headphones"
    case .airPlay: return "airplay"
    case .carAudio: return "car"
    case .usbAudio: return "usb"
    case .HDMI, .lineOut: return "external"
    default: return "other"
    }
  }

  private func routeSummary() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    return [
      "route": routeKind(session.currentRoute),
      "outputs": session.currentRoute.outputs.map { ["type": $0.portType.rawValue, "name": $0.portName] },
      "preference": outputPreference,
      "category": session.category.rawValue,
      "mode": session.mode.rawValue,
      "default_to_speaker": session.categoryOptions.contains(.defaultToSpeaker),
      "bluetooth_a2dp": session.categoryOptions.contains(.allowBluetoothA2DP),
      // The iPhone's own volume (0 to 1). CHE reports it; only the owner's
      // volume buttons change it.
      "output_volume": Double(session.outputVolume),
      "listening": nativeVoiceRunning,
      "voice_processing": nativeVoiceRunning && audioEngine.inputNode.isVoiceProcessingEnabled,
    ]
  }

  private func installAudioObservers() {
    guard !audioObserversInstalled else { return }
    audioObserversInstalled = true
    let center = NotificationCenter.default
    center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] note in
      guard let self else { return }
      let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
      let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
      // Headphones unplugged or Bluetooth gone: iOS falls back to the
      // earpiece, so CHE moves her voice back to the loudspeaker. A device
      // connected in Automatic plays her. Her own override also posts a
      // route change; that one is left alone.
      if reason == .newDeviceAvailable || reason == .oldDeviceUnavailable || reason == .routeConfigurationChange || reason == .categoryChange {
        self.applyOutputRoute(newDevice: reason == .newDeviceAvailable)
      }
      self.voiceStreamHandler.emit([
        "type": "audio_route",
        "route": self.routeKind(AVAudioSession.sharedInstance().currentRoute),
      ])
    }
    center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: .main
    ) { [weak self] note in
      guard let self else { return }
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
      guard let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
      if type == .began {
        // A call or Siri took the audio: the clip ends here and Flutter
        // shows its words, instead of waiting for a player iOS paused.
        if self.player != nil {
          self.stopAllAudio()
        }
      } else {
        try? AVAudioSession.sharedInstance().setActive(true)
        self.applyOutputRoute()
        if self.nativeVoiceRunning && !self.assistantSpeaking {
          self.restartRecognitionSoon(delay: 0.3)
        }
      }
    }
    center.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: audioEngine,
      queue: .main
    ) { [weak self] _ in
      // A route change stops the engine; listening resumes on the new route.
      // A notice that arrives while the engine still runs, or right after a
      // (re)start, is the start itself, not a stopped microphone.
      guard let self, self.nativeVoiceRunning, !self.assistantSpeaking,
            !self.audioEngine.isRunning,
            Date().timeIntervalSince(self.lastStreamStart) > 1.0 else { return }
      self.restartRecognitionSoon(delay: 0.2)
    }
  }

  private func startNativeRecognition(result: @escaping FlutterResult) {
    if nativeVoiceRunning {
      result(true)
      return
    }

    SFSpeechRecognizer.requestAuthorization { [weak self] status in
      guard let self else { return }
      DispatchQueue.main.async {
        guard status == .authorized else {
          result(false)
          self.voiceStreamHandler.emit([
            "type": "error",
            "message": "Speech Recognition permission is required for hands-free CHE voice."
          ])
          return
        }

        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] allowed in
          guard let self else { return }
          DispatchQueue.main.async {
            guard allowed else {
              result(false)
              self.voiceStreamHandler.emit([
                "type": "error",
                "message": "Microphone permission is required for hands-free CHE voice."
              ])
              return
            }

            self.nativeVoiceRunning = true
            self.startKeepAlive()
            do {
              try self.beginRecognitionStream()
              self.voiceStreamHandler.emit([
                "type": "state",
                "running": true,
                "listening": true,
              ])
              result(true)
            } catch {
              self.nativeVoiceRunning = false
              self.cancelRecognitionResources()
              self.voiceStreamHandler.emit([
                "type": "error",
                "message": "CHE could not start native speech recognition."
              ])
              result(false)
            }
          }
        }
      }
    }
  }

  private func beginRecognitionStream() throws {
    recognitionGeneration += 1
    let generation = recognitionGeneration

    utteranceTimer?.invalidate()
    utteranceTimer = nil
    latestTranscript = ""
    wakeSignalSent = false
    cancelRecognitionResources(keepGeneration: true)

    configureAudioSession()

    guard let speechRecognizer, speechRecognizer.isAvailable else {
      throw NSError(
        domain: "CHEVoice",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Speech recognition unavailable."]
      )
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    if speechRecognizer.supportsOnDeviceRecognition {
      request.requiresOnDeviceRecognition = true
    }
    recognitionRequest = request

    let inputNode = audioEngine.inputNode
    if #available(iOS 13.0, *) {
      // Echo cancellation: CHE doesn't hear her own voice as the owner.
      try? inputNode.setVoiceProcessingEnabled(true)
    }
    if #available(iOS 17.0, *) {
      // CHE's own voice plays through AVAudioPlayer, which voice processing
      // counts as "other audio". Maximum ducking (2026-09-30) turned Connie
      // down to a whisper whenever the mic was open (owner, 2026-10-15).
      // CHE's session already stops other apps' audio, so nothing else
      // needs ducking: keep it at the minimum.
      inputNode.voiceProcessingOtherAudioDuckingConfiguration =
        AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
          enableAdvancedDucking: false,
          duckingLevel: .min
        )
    }

    let format = inputNode.outputFormat(forBus: 0)
    inputNode.installTap(
      onBus: 0,
      bufferSize: 1024,
      format: format
    ) { [weak self] buffer, _ in
      self?.recognitionRequest?.append(buffer)
    }
    hasInputTap = true

    audioEngine.prepare()
    try audioEngine.start()
    lastStreamStart = Date()

    recognitionTask = speechRecognizer.recognitionTask(with: request) {
      [weak self] result, error in
      guard let self, self.nativeVoiceRunning else { return }
      guard generation == self.recognitionGeneration else { return }

      if let result {
        self.handleRecognition(result)
      }

      if error != nil && generation == self.recognitionGeneration {
        self.restartRecognitionSoon(delay: 0.35)
      } else if result?.isFinal == true && generation == self.recognitionGeneration && !self.assistantSpeaking {
        // Recognizer finished a segment; reopen so wake listening never stops.
        self.restartRecognitionSoon(delay: 0.15)
      }
    }
  }

  private func handleRecognition(_ result: SFSpeechRecognitionResult) {
    let transcript = result.bestTranscription.formattedString
      .trimmingCharacters(in: .whitespacesAndNewlines)

    guard !transcript.isEmpty else { return }
    guard transcript != latestTranscript else { return }

    latestTranscript = transcript

    // Wake CHE immediately from a partial recognition result instead of
    // waiting for Apple's final transcript. Flutter decides whether this is
    // actually a sleeping/wake-word turn, so normal open conversation stays
    // unchanged.
    let wakeCandidate = normalizedWords(transcript)
    let wakeWords = ["chay", "chey", "shay", "chai", "chee", "chi", "che", "c h e", "hey chay", "hey chey", "hey shay", "hey chai", "hey chee", "hey chi", "hey che"]
    let heardWake = wakeWords.contains { word in
      wakeCandidate == word || wakeCandidate.hasPrefix(word + " ")
    }
    if !assistantSpeaking && !wakeSignalSent && heardWake {
      wakeSignalSent = true
      voiceStreamHandler.emit([
        "type": "wake_signal",
        "text": transcript,
      ])
    }

    if assistantSpeaking &&
        !bargeInDetected &&
        Date() >= ignoreBargeInUntil &&
        !looksLikeAssistantEcho(transcript) {
      bargeInDetected = true
      assistantSpeaking = false
      stopAllAudio()
      voiceStreamHandler.emit([
        "type": "barge_in",
        "text": transcript,
      ])
    }

    if assistantSpeaking && !bargeInDetected {
      return
    }

    utteranceTimer?.invalidate()

    if result.isFinal {
      deliverTranscript(transcript)
      return
    }

    // Natural end-of-turn (free, on-device): a finished sentence gets a short
    // pause, a thought that trails off ("and…", "um…", "so…") gets a long one,
    // everything else sits in between. Stops CHE from cutting the owner off.
    utteranceTimer = Timer.scheduledTimer(
      withTimeInterval: endOfTurnPause(for: transcript),
      repeats: false
    ) { [weak self] _ in
      guard let self else { return }
      guard self.nativeVoiceRunning else { return }
      guard !self.assistantSpeaking else { return }
      guard self.latestTranscript == transcript else { return }
      self.deliverTranscript(transcript)
    }
  }

  private func endOfTurnPause(for transcript: String) -> TimeInterval {
    let words = normalizedWords(transcript).split(separator: " ").map(String.init)
    let last = words.last ?? ""
    let unfinished: Set<String> = [
      "and", "or", "but", "so", "um", "uh", "like", "because", "cause", "the", "a", "an",
      "to", "with", "of", "if", "when", "then", "that", "which", "for", "my", "your",
      "i", "we", "you", "is", "was", "are", "about", "into", "from", "just", "also",
      "maybe", "gonna", "wanna", "need", "want", "can", "could", "should", "would",
    ]
    if unfinished.contains(last) { return 3.6 }
    let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    let endsSentence = trimmed.hasSuffix(".") || trimmed.hasSuffix("?") || trimmed.hasSuffix("!")
    if endsSentence && words.count >= 4 { return 1.6 }
    if words.count <= 2 { return 1.8 }
    return 2.4
  }

  private func deliverTranscript(_ text: String) {
    let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleaned.isEmpty else { return }

    let now = Date()
    if cleaned.caseInsensitiveCompare(lastDeliveredTranscript) == .orderedSame &&
        now.timeIntervalSince(lastDeliveredAt) < 1.25 {
      restartRecognitionSoon(delay: 0.12)
      return
    }

    lastDeliveredTranscript = cleaned
    lastDeliveredAt = now
    latestTranscript = ""
    utteranceTimer?.invalidate()
    utteranceTimer = nil

    voiceStreamHandler.emit([
      "type": "utterance",
      "text": cleaned,
    ])

    bargeInDetected = false
    restartRecognitionSoon(delay: 0.12)
  }

  private func looksLikeAssistantEcho(_ candidate: String) -> Bool {
    let heard = normalizedWords(candidate)
    let spoken = normalizedWords(assistantText)
    guard !heard.isEmpty, !spoken.isEmpty else { return false }

    let interruptionWords = [
      "stop", "wait", "no", "pause", "hold on", "chay", "chey", "shay", "chai", "chee", "chi", "che", "hey chay", "hey che"
    ]
    if interruptionWords.contains(heard) {
      return false
    }

    let heardWords = heard.split(separator: " ").map(String.init)
    let spokenWords = Set(spoken.split(separator: " ").map(String.init))
    // "Stop" or her name said over her own voice is the owner, not an echo.
    let stopWords: Set<String> = ["stop", "wait", "pause", "chay", "chey", "shay", "chai", "che"]
    if heardWords.contains(where: { stopWords.contains($0) && !spokenWords.contains($0) }) {
      return false
    }
    if heardWords.count <= 1 {
      return spoken.contains(heard)
    }
    if spoken.contains(heard) || heard.contains(spoken) {
      return true
    }
    // Her words as the recognizer heard them through the speaker, with a
    // few misheard: most of the meaningful words are words she is saying.
    // Short common words ("no", "that", "is", "not", "what") say nothing
    // about who spoke, so "no, that is not what I asked" is the owner.
    let common: Set<String> = [
      "a", "an", "the", "and", "or", "but", "so", "of", "to", "in", "on", "at", "for", "with", "is", "are", "was",
      "were", "be", "it", "this", "that", "i", "you", "we", "he", "she", "they", "me", "my", "your", "no", "not",
      "yes", "what", "why", "how", "do", "did", "does", "can", "just", "about", "asked", "ask", "mean", "meant",
    ]
    let meaningful = heardWords.filter { !common.contains($0) }
    guard meaningful.count >= 3 else { return false }
    let matched = meaningful.filter { spokenWords.contains($0) }.count
    return Double(matched) / Double(meaningful.count) >= 0.8
  }

  private func normalizedWords(_ value: String) -> String {
    value
      .lowercased()
      .components(separatedBy: CharacterSet.alphanumerics.inverted)
      .filter { !$0.isEmpty }
      .joined(separator: " ")
  }

  private func setAssistantSpeaking(_ speaking: Bool) {
    if speaking {
      assistantSpeaking = true
      bargeInDetected = false
      latestTranscript = ""
      assistantText = ""
      ignoreBargeInUntil = Date().addingTimeInterval(0.28)
      return
    }

    let wasBargeIn = bargeInDetected
    assistantSpeaking = false
    assistantText = ""
    ignoreBargeInUntil = .distantPast

    if !wasBargeIn && nativeVoiceRunning {
      latestTranscript = ""
      restartRecognitionSoon(delay: 0.08)
    }
  }

  // Apple's speech recognizer stops itself after about a minute of audio, which
  // silently kills the "Chay" wake listener. This refreshes the stream on a
  // schedule (only while she isn't mid-reply) so the wake word keeps working
  // the whole time the app is open. Free, no account, no Picovoice.
  private func startKeepAlive() {
    keepAliveTimer?.invalidate()
    keepAliveTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { [weak self] _ in
      guard let self, self.nativeVoiceRunning else { return }
      guard !self.assistantSpeaking else { return }
      self.restartRecognitionSoon(delay: 0.05)
    }
  }

  private func restartRecognitionSoon(delay: TimeInterval) {
    guard nativeVoiceRunning else { return }
    recognitionGeneration += 1
    let expectedGeneration = recognitionGeneration

    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, self.nativeVoiceRunning else { return }
      guard self.recognitionGeneration == expectedGeneration else { return }

      do {
        try self.beginRecognitionStream()
      } catch {
        self.voiceStreamHandler.emit([
          "type": "error",
          "message": "CHE voice listening paused. Tap the mic to restart it."
        ])
      }
    }
  }

  private func stopNativeRecognition() {
    nativeVoiceRunning = false
    keepAliveTimer?.invalidate()
    keepAliveTimer = nil
    recognitionGeneration += 1
    utteranceTimer?.invalidate()
    utteranceTimer = nil
    latestTranscript = ""
    lastDeliveredTranscript = ""
    bargeInDetected = false
    assistantSpeaking = false
    cancelRecognitionResources()
    voiceStreamHandler.emit([
      "type": "state",
      "running": false,
      "listening": false,
    ])
  }

  private func cancelRecognitionResources(keepGeneration: Bool = false) {
    if !keepGeneration {
      recognitionGeneration += 1
    }

    recognitionRequest?.endAudio()
    recognitionRequest = nil
    recognitionTask?.cancel()
    recognitionTask = nil

    if audioEngine.isRunning {
      audioEngine.stop()
    }

    if hasInputTap {
      audioEngine.inputNode.removeTap(onBus: 0)
      hasInputTap = false
    }
  }

  private func bestEnglishVoice() -> AVSpeechSynthesisVoice? {
    let voices = AVSpeechSynthesisVoice.speechVoices().filter {
      $0.language.lowercased().hasPrefix("en")
    }

    // Prefer Apple's premium/enhanced voices when the owner has them installed.
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
    guard configureAudioSession() else {
      result(FlutterError(code: "audio_route_failed", message: "CHE could not safely route device speech.", details: nil))
      return
    }

    assistantText = text

    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = bestEnglishVoice()
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.94
    utterance.pitchMultiplier = 0.98
    utterance.volume = 1.0
    utterance.preUtteranceDelay = 0.0
    utterance.postUtteranceDelay = 0.0

    pendingSpeechResult = result
    synthesizer.speak(utterance)
  }

  private func play(
    data: Data,
    text: String = "",
    volume: Float = 1.0,
    normalize: Bool = false,
    clip: Bool = false,
    result: @escaping FlutterResult
  ) {
    stopAllAudio()
    guard configureAudioSession() else {
      result(FlutterError(code: "audio_route_failed", message: "CHE could not safely route this voice clip.", details: nil))
      return
    }
    // The words of this turn so far, so the recognizer's copy of her own
    // voice is never taken for the owner interrupting.
    assistantText = assistantSpeaking ? String((assistantText + " " + text).suffix(1600)) : text
    playbackGeneration += 1
    let generation = playbackGeneration
    pendingAudioResult = result
    pendingClipInfo = clip ? [:] : nil

    // Measuring (and, for an unusually quiet clip, raising) the loudness
    // decodes the audio, so it runs off the main thread.
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      let prepared: (url: URL?, info: [String: Any]) = normalize ? self.loudnessNormalized(data) : (nil, [:])
      DispatchQueue.main.async {
        guard generation == self.playbackGeneration, self.pendingAudioResult != nil else {
          if let url = prepared.url { try? FileManager.default.removeItem(at: url) }
          return
        }
        self.startPlayer(data: data, prepared: prepared, volume: volume)
      }
    }
  }

  private func startPlayer(data: Data, prepared: (url: URL?, info: [String: Any]), volume: Float) {
    do {
      let audioPlayer: AVAudioPlayer
      if let url = prepared.url {
        normalizedClipURL = url
        audioPlayer = try AVAudioPlayer(contentsOf: url)
      } else {
        // Name the format: raw MP3 without an ID3 tag can otherwise fail with
        // "unsupported file type" (OSStatus 1954115647).
        audioPlayer = try AVAudioPlayer(data: data, fileTypeHint: audioTypeHint(data))
      }
      audioPlayer.delegate = self
      // The owner's Voice Volume. The iPhone's own volume stays his to set.
      audioPlayer.volume = max(0, min(1, volume))
      audioPlayer.prepareToPlay()
      player = audioPlayer
      if pendingClipInfo != nil {
        var info = routeSummary()
        for (key, value) in prepared.info { info[key] = value }
        info["volume"] = Double(audioPlayer.volume)
        pendingClipInfo = info
      }

      guard audioPlayer.play() else {
        player = nil
        finishPlayback(false)
        return
      }
    } catch {
      if let url = prepared.url { try? FileManager.default.removeItem(at: url) }
      normalizedClipURL = nil
      let pending = pendingAudioResult
      pendingAudioResult = nil
      pendingClipInfo = nil
      pending?(FlutterError(
        code: "audio_playback_failed",
        message: "CHE could not play generated voice audio.",
        details: error.localizedDescription
      ))
    }
  }

  /// Answers the pending play call: true/false for playAudio, and for
  /// playClip what was measured and where she played.
  private func finishPlayback(_ played: Bool) {
    if let url = normalizedClipURL {
      try? FileManager.default.removeItem(at: url)
      normalizedClipURL = nil
    }
    guard let pending = pendingAudioResult else { return }
    pendingAudioResult = nil
    if var info = pendingClipInfo {
      pendingClipInfo = nil
      info["played"] = played
      pending(info)
    } else {
      pending(played)
    }
  }

  /// Measures one clip's loudness over the parts where she is speaking. Only
  /// an unusually quiet clip (below -24 dBFS) is raised, toward normal speech
  /// (-19 dBFS), never by more than 12 dB and never past -1 dBFS peak, so it
  /// cannot clip or distort. A normal clip plays exactly as it arrived.
  private func loudnessNormalized(_ data: Data) -> (url: URL?, info: [String: Any]) {
    let folder = FileManager.default.temporaryDirectory
    let ext = audioTypeHint(data) == AVFileType.wav.rawValue ? "wav" : "mp3"
    let source = folder.appendingPathComponent("che-clip-\(UUID().uuidString).\(ext)")
    defer { try? FileManager.default.removeItem(at: source) }
    do {
      try data.write(to: source, options: .atomic)
      let file = try AVAudioFile(forReading: source)
      let format = file.processingFormat
      guard
        file.length > 0,
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(file.length))
      else { return (nil, [:]) }
      try file.read(into: buffer)
      guard let channels = buffer.floatChannelData else { return (nil, [:]) }
      let frames = Int(buffer.frameLength)
      let channelCount = Int(format.channelCount)
      guard frames > 0, channelCount > 0 else { return (nil, [:]) }

      var peak: Float = 0
      var speechEnergy = 0.0
      var speechBlocks = 0
      let block = max(1, Int(format.sampleRate * 0.02))
      var start = 0
      while start < frames {
        let end = min(frames, start + block)
        var energy = 0.0
        for c in 0..<channelCount {
          let samples = channels[c]
          for i in start..<end {
            let value = samples[i]
            peak = max(peak, abs(value))
            energy += Double(value * value)
          }
        }
        let meanSquare = energy / Double((end - start) * channelCount)
        if meanSquare > 1e-5 {
          speechEnergy += meanSquare
          speechBlocks += 1
        }
        start = end
      }
      guard peak > 0, speechBlocks > 0 else { return (nil, ["peak_db": -120.0, "rms_db": -120.0, "gain_db": 0.0]) }
      let peakDb = 20 * log10(Double(peak))
      let rmsDb = 10 * log10(speechEnergy / Double(speechBlocks))
      var info: [String: Any] = [
        "peak_db": (peakDb * 10).rounded() / 10,
        "rms_db": (rmsDb * 10).rounded() / 10,
        "gain_db": 0.0,
      ]
      guard rmsDb < -24 else { return (nil, info) }
      let gainDb = min(-19 - rmsDb, -1 - peakDb, 12)
      guard gainDb >= 1 else { return (nil, info) }
      let gain = Float(pow(10, gainDb / 20))
      for c in 0..<channelCount {
        let samples = channels[c]
        for i in 0..<frames {
          samples[i] *= gain
        }
      }
      // 16-bit PCM: the raised clip still peaks at or below -1 dBFS.
      let output = folder.appendingPathComponent("che-clip-\(UUID().uuidString).wav")
      let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: format.sampleRate,
        AVNumberOfChannelsKey: format.channelCount,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
      ]
      let written = try AVAudioFile(
        forWriting: output,
        settings: settings,
        commonFormat: format.commonFormat,
        interleaved: format.isInterleaved
      )
      try written.write(from: buffer)
      info["gain_db"] = (gainDb * 10).rounded() / 10
      return (output, info)
    } catch {
      return (nil, [:])
    }
  }

  private func audioTypeHint(_ data: Data) -> String? {
    let head = [UInt8](data.prefix(4))
    if head.count == 4, head[0] == 0x52, head[1] == 0x49, head[2] == 0x46, head[3] == 0x46 {
      return AVFileType.wav.rawValue
    }
    if head.count >= 3, head[0] == 0x49, head[1] == 0x44, head[2] == 0x33 {
      return AVFileType.mp3.rawValue
    }
    if head.count >= 2, head[0] == 0xFF, (head[1] & 0xE0) == 0xE0 {
      return AVFileType.mp3.rawValue
    }
    return nil
  }

  private func stopAllAudio() {
    if synthesizer.isSpeaking || synthesizer.isPaused {
      synthesizer.stopSpeaking(at: .immediate)
    }

    player?.stop()
    player = nil
    playbackGeneration += 1

    if let pending = pendingSpeechResult {
      pendingSpeechResult = nil
      pending(false)
    }
    finishPlayback(false)
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    assistantText = ""
    if let pending = pendingSpeechResult {
      pendingSpeechResult = nil
      pending(true)
    }
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    assistantText = ""
    if let pending = pendingSpeechResult {
      pendingSpeechResult = nil
      pending(false)
    }
  }

  func audioPlayerDidFinishPlaying(
    _ player: AVAudioPlayer,
    successfully flag: Bool
  ) {
    self.player = nil
    finishPlayback(flag)
  }
}
SWIFT
fi
