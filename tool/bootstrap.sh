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
info['CFBundleName'] = 'CHE'
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

@available(iOS 16.0, *)
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
  private let audioEngine = AVAudioEngine()
  private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var utteranceTimer: Timer?
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

      let nativeShell = FlutterMethodChannel(
        name: "che/native_shell",
        binaryMessenger: controller.binaryMessenger
      )
      nativeShell.setMethodCallHandler { call, result in
        switch call.method {
        case "requestNotifications":
          UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound, .badge]
          ) { granted, _ in
            DispatchQueue.main.async { result(granted) }
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
        default:
          result(FlutterMethodNotImplemented)
        }
      }

      let accountBridge = FlutterMethodChannel(
        name: "che/account_bridge",
        binaryMessenger: controller.binaryMessenger
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
          self.authenticateOwner(reason: reason, result: result)

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
    result: @escaping FlutterResult
  ) {
    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    var error: NSError?

    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      result(false)
      return
    }

    context.evaluatePolicy(
      .deviceOwnerAuthentication,
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

  private func configureAudioSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.defaultToSpeaker, .allowBluetooth]
      )
      try session.setActive(true)
    } catch {
      voiceStreamHandler.emit([
        "type": "error",
        "message": "CHE could not configure iPhone voice audio."
      ])
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
      try? inputNode.setVoiceProcessingEnabled(true)
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

    recognitionTask = speechRecognizer.recognitionTask(with: request) {
      [weak self] result, error in
      guard let self, self.nativeVoiceRunning else { return }
      guard generation == self.recognitionGeneration else { return }

      if let result {
        self.handleRecognition(result)
      }

      if error != nil && generation == self.recognitionGeneration {
        self.restartRecognitionSoon(delay: 0.35)
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

    let wordCount = heard.split(separator: " ").count
    if wordCount <= 1 {
      return spoken.contains(heard)
    }

    return spoken.contains(heard) || heard.contains(spoken)
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
      ignoreBargeInUntil = Date().addingTimeInterval(0.28)
      return
    }

    let wasBargeIn = bargeInDetected
    assistantSpeaking = false
    ignoreBargeInUntil = .distantPast

    if !wasBargeIn && nativeVoiceRunning {
      latestTranscript = ""
      restartRecognitionSoon(delay: 0.08)
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
    configureAudioSession()

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

  private func play(data: Data, result: @escaping FlutterResult) {
    stopAllAudio()
    configureAudioSession()
    assistantText = ""

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
    if let pending = pendingAudioResult {
      pendingAudioResult = nil
      pending(flag)
    }
  }
}
SWIFT
fi
