import AVFoundation
import Flutter
import Speech
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  private var cheBackgroundVoice: CheBackgroundVoiceManager?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)

    if let controller = window?.rootViewController as? FlutterViewController {
      cheBackgroundVoice = CheBackgroundVoiceManager(
        binaryMessenger: controller.binaryMessenger
      )
    }

    return super.application(
      application,
      didFinishLaunchingWithOptions: launchOptions
    )
  }
}

final class CheBackgroundVoiceManager: NSObject {
    private let methodChannel: FlutterMethodChannel
    private let eventChannel: FlutterEventChannel
    private var eventSink: FlutterEventSink?

    private let audioEngine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    private var utteranceTimer: Timer?
    private var restartTimer: Timer?

    private var running = false
    private var sleeping = false
    private var assistantSpeaking = false
    private var latestTranscript = ""
    private var lastEmittedTranscript = ""

    init(binaryMessenger: FlutterBinaryMessenger) {
        methodChannel = FlutterMethodChannel(
            name: "che/native_voice",
            binaryMessenger: binaryMessenger
        )
        eventChannel = FlutterEventChannel(
            name: "che/native_voice_events",
            binaryMessenger: binaryMessenger
        )
        super.init()

        eventChannel.setStreamHandler(self)

        methodChannel.setMethodCallHandler { [weak self] call, result in
            guard let self else { return }

            switch call.method {
            case "start":
                self.start(result: result)
            case "stop":
                self.stop()
                result(true)
            case "sleep":
                self.sleeping = true
                self.emit(["type": "sleep", "sleeping": true])
                result(true)
            case "wake":
                self.sleeping = false
                self.emit(["type": "wake", "sleeping": false])
                result(true)
            case "assistantSpeaking":
                self.assistantSpeaking = (call.arguments as? Bool) ?? false
                result(true)
            case "status":
                result([
                    "running": self.running,
                    "sleeping": self.sleeping,
                    "onDevice": self.recognizer?.supportsOnDeviceRecognition ?? false
                ])
            default:
                result(FlutterMethodNotImplemented)
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        stop()
    }

    private func emit(_ event: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            self?.eventSink?(event)
        }
    }

    private func start(result: @escaping FlutterResult) {
        guard !running else {
            result(true)
            return
        }

        AVAudioApplication.requestRecordPermission { [weak self] micGranted in
            guard let self else { return }

            guard micGranted else {
                DispatchQueue.main.async {
                    result(FlutterError(
                        code: "MIC_DENIED",
                        message: "Microphone permission was denied.",
                        details: nil
                    ))
                }
                return
            }

            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                guard let self else { return }

                guard status == .authorized else {
                    DispatchQueue.main.async {
                        result(FlutterError(
                            code: "SPEECH_DENIED",
                            message: "Speech-recognition permission was denied.",
                            details: nil
                        ))
                    }
                    return
                }

                DispatchQueue.main.async {
                    do {
                        try self.configureSession()
                        self.running = true
                        try self.startRecognition()
                        self.emit([
                            "type": "state",
                            "running": true,
                            "sleeping": self.sleeping,
                            "onDevice": self.recognizer?.supportsOnDeviceRecognition ?? false
                        ])
                        result(true)
                    } catch {
                        self.running = false
                        result(FlutterError(
                            code: "VOICE_START_FAILED",
                            message: error.localizedDescription,
                            details: nil
                        ))
                    }
                }
            }
        }
    }

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP, .mixWithOthers]
        )
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    private func startRecognition() throws {
        task?.cancel()
        request?.endAudio()

        if audioEngine.isRunning {
            audioEngine.stop()
        }

        audioEngine.inputNode.removeTap(onBus: 0)

        guard let recognizer, recognizer.isAvailable else {
            throw NSError(
                domain: "CHEVoice",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Speech recognition is unavailable."]
            )
        }

        guard recognizer.supportsOnDeviceRecognition else {
            throw NSError(
                domain: "CHEVoice",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey:
                    "This iPhone is not reporting on-device speech-recognition support."]
            )
        }

        let newRequest = SFSpeechAudioBufferRecognitionRequest()
        newRequest.shouldReportPartialResults = true
        newRequest.requiresOnDeviceRecognition = true
        newRequest.taskHint = .dictation
        newRequest.contextualStrings = [
            "CHE",
            "C H E",
            "stand down",
            "go to sleep",
            "wake up"
        ]
        request = newRequest

        latestTranscript = ""
        lastEmittedTranscript = ""

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)

        input.installTap(onBus: 0, bufferSize: 1024, format: format) {
            [weak self] buffer, _ in
            self?.request?.append(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()

        task = recognizer.recognitionTask(with: newRequest) { [weak self] result, error in
            guard let self else { return }

            if let result {
                let text = result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines)

                if !text.isEmpty && text != self.latestTranscript {
                    self.latestTranscript = text
                    self.handleTranscript(text)
                }
            }

            if error != nil && self.running {
                self.restartSoon()
            }
        }

        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) {
            [weak self] _ in
            self?.restartSoon()
        }
    }

    private func normalized(_ text: String) -> String {
        text
            .lowercased()
            .replacingOccurrences(of: ".", with: " ")
            .replacingOccurrences(of: ",", with: " ")
            .replacingOccurrences(of: "!", with: " ")
            .replacingOccurrences(of: "?", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    private func compact(_ text: String) -> String {
        normalized(text).filter { $0.isLetter || $0.isNumber }
    }

    private func isSleep(_ text: String) -> Bool {
        let n = normalized(text)
        let c = compact(text)

        if n.contains("stand down") || n.contains("go to sleep") {
            return true
        }

        return ["standdown", "standown", "standdoun", "gotosleep", "gosleep"]
            .contains { c.contains($0) }
    }

    private func isWake(_ text: String) -> Bool {
        let n = normalized(text)
        let words = n.split(separator: " ").map(String.init)

        guard !words.isEmpty else { return false }
        let last = words.last ?? ""

        if words.count <= 2 && ["che", "she", "chi"].contains(last) {
            return true
        }

        return n == "c h e" || n == "hey che" || n == "okay che" || n == "che"
    }

    private func stripWakePrefix(_ text: String) -> String {
        let n = normalized(text)

        for prefix in ["hey che ", "okay che ", "che ", "c h e "] {
            if n.hasPrefix(prefix) {
                return String(n.dropFirst(prefix.count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func handleTranscript(_ text: String) {
        guard !assistantSpeaking else { return }

        if isSleep(text) {
            sleeping = true
            latestTranscript = ""
            lastEmittedTranscript = ""
            utteranceTimer?.invalidate()
            emit(["type": "sleep", "sleeping": true])
            restartSoon(delay: 0.2)
            return
        }

        if sleeping {
            if isWake(text) {
                sleeping = false
                latestTranscript = ""
                lastEmittedTranscript = ""
                utteranceTimer?.invalidate()
                emit(["type": "wake", "sleeping": false])
                restartSoon(delay: 0.2)
            }
            return
        }

        utteranceTimer?.invalidate()
        utteranceTimer = Timer.scheduledTimer(withTimeInterval: 1.35, repeats: false) {
            [weak self] _ in
            self?.flushUtterance()
        }
    }

    private func flushUtterance() {
        guard !sleeping, !assistantSpeaking else { return }

        var text = latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        if isSleep(text) {
            handleTranscript(text)
            return
        }

        text = stripWakePrefix(text)
        guard !text.isEmpty, text != lastEmittedTranscript else { return }

        lastEmittedTranscript = text
        emit(["type": "utterance", "text": text])
        restartSoon(delay: 0.15)
    }

    private func restartSoon(delay: TimeInterval = 0.45) {
        guard running else { return }

        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) {
            [weak self] _ in
            guard let self, self.running else { return }

            do {
                try self.configureSession()
                try self.startRecognition()
            } catch {
                self.emit(["type": "error", "message": error.localizedDescription])
            }
        }
    }

    func stop() {
        running = false
        utteranceTimer?.invalidate()
        restartTimer?.invalidate()

        task?.cancel()
        task = nil

        request?.endAudio()
        request = nil

        if audioEngine.isRunning {
            audioEngine.stop()
        }

        audioEngine.inputNode.removeTap(onBus: 0)

        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )

        emit(["type": "state", "running": false, "sleeping": sleeping])
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard
            let info = notification.userInfo,
            let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else {
            return
        }

        if type == .began {
            emit(["type": "interruption", "active": true])
        } else {
            emit(["type": "interruption", "active": false])
            if running {
                restartSoon(delay: 0.7)
            }
        }
    }
}

extension CheBackgroundVoiceManager: FlutterStreamHandler {
    func onListen(
        withArguments arguments: Any?,
        eventSink events: @escaping FlutterEventSink
    ) -> FlutterError? {
        eventSink = events
        return nil
    }

    func onCancel(withArguments arguments: Any?) -> FlutterError? {
        eventSink = nil
        return nil
    }
}
