#!/usr/bin/env python3
from pathlib import Path

path = Path('ios/Runner/AppDelegate.swift')
if not path.exists():
    raise SystemExit('CHE local runtime patch: AppDelegate.swift not found')

text = path.read_text()

foundation_import = '''#if canImport(FoundationModels)
import FoundationModels
#endif
'''
if foundation_import not in text:
    anchor = 'import BackgroundTasks\n'
    if anchor not in text:
        raise SystemExit('CHE local runtime patch: import anchor not found')
    text = text.replace(anchor, anchor + foundation_import, 1)

if 'name: "che/local_ai"' not in text:
    marker = '      let nativeShell = FlutterMethodChannel(\n'
    if marker not in text:
        raise SystemExit('CHE local runtime patch: native shell anchor not found')
    bridge = r'''      let localAI = FlutterMethodChannel(
        name: "che/local_ai",
        binaryMessenger: controller.binaryMessenger
      )
      localAI.setMethodCallHandler { call, result in
        switch call.method {
        case "available":
          #if canImport(FoundationModels)
          if #available(iOS 26.0, *) {
            result(SystemLanguageModel.default.isAvailable)
          } else {
            result(false)
          }
          #else
          result(false)
          #endif

        case "respond":
          guard
            let args = call.arguments as? [String: Any],
            let prompt = args["prompt"] as? String,
            !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          else {
            result(nil)
            return
          }

          #if canImport(FoundationModels)
          if #available(iOS 26.0, *) {
            let model = SystemLanguageModel.default
            guard model.isAvailable else {
              result(nil)
              return
            }

            let rawHistory = args["history"] as? [[String: Any]] ?? []
            let history = rawHistory.suffix(14).compactMap { item -> String? in
              guard let role = item["role"] as? String else { return nil }
              let value = (item["content"] as? String) ?? (item["text"] as? String) ?? ""
              let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
              guard !clean.isEmpty else { return nil }
              return "\(role): \(clean)"
            }.joined(separator: "\n")

            let memory = (args["memory_context"] as? [String] ?? [])
              .suffix(12)
              .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
              .filter { !$0.isEmpty }
              .joined(separator: "\n")

            var sections: [String] = []
            if !memory.isEmpty {
              sections.append("Relevant local CHE memory:\n\(memory)")
            }
            if !history.isEmpty {
              sections.append("Recent conversation:\n\(history)")
            }
            sections.append("Owner: \(prompt)")
            let fullPrompt = sections.joined(separator: "\n\n")

            Task {
              do {
                let session = LanguageModelSession(instructions: """
                  You are CHE, the owner's concise private personal AI assistant.
                  Answer directly and naturally. Use supplied local memory only when relevant.
                  Never invent a memory that is not present in the supplied context.
                  Do not mention providers, quotas, fallback systems, or implementation details
                  unless the owner explicitly asks. Do not claim external actions happened unless
                  the prompt itself includes confirmation that they happened.
                  """)
                let response = try await session.respond(to: fullPrompt)
                await MainActor.run { result(response.content) }
              } catch {
                await MainActor.run { result(nil) }
              }
            }
          } else {
            result(nil)
          }
          #else
          result(nil)
          #endif

        default:
          result(FlutterMethodNotImplemented)
        }
      }

'''
    text = text.replace(marker, bridge + marker, 1)

if 'case "configureVoice":' not in text:
    marker = '        case "speakText":\n'
    if marker not in text:
        raise SystemExit('CHE local runtime patch: speakText case anchor not found')
    config_case = r'''        case "configureVoice":
          let args = call.arguments as? [String: Any] ?? [:]
          if let pitch = args["pitch"] as? NSNumber {
            UserDefaults.standard.set(pitch.doubleValue, forKey: "che.voice.nativePitch")
          }
          if let rate = args["rate"] as? NSNumber {
            UserDefaults.standard.set(rate.doubleValue, forKey: "che.voice.nativeRate")
          }
          result(true)

'''
    text = text.replace(marker, config_case + marker, 1)

text = text.replace(
    'utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.94',
    'let savedRate = UserDefaults.standard.object(forKey: "che.voice.nativeRate") as? Double ?? 0.94\n    utterance.rate = AVSpeechUtteranceDefaultSpeechRate * Float(savedRate)',
)
text = text.replace(
    'utterance.pitchMultiplier = 0.98',
    'let savedPitch = UserDefaults.standard.object(forKey: "che.voice.nativePitch") as? Double ?? 0.98\n    utterance.pitchMultiplier = Float(savedPitch)',
)

path.write_text(text)
print('CHE local runtime bridge + voice tuning enabled')

# Weak-link Apple's on-device AI framework. It only exists on iOS 26+, and a
# hard link makes CHE close instantly on launch on any older iPhone.
pbx = Path('ios/Runner.xcodeproj/project.pbxproj')
if pbx.exists():
    ptext = pbx.read_text()
    if '-weak_framework' not in ptext:
        anchor = 'PRODUCT_BUNDLE_IDENTIFIER = com.cheyapp.chey;'
        flags = ('OTHER_LDFLAGS = ("$(inherited)", "-weak_framework", '
                 'FoundationModels, );\n\t\t\t\t')
        ptext = ptext.replace(anchor, flags + anchor)
        pbx.write_text(ptext)
