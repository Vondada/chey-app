#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
main_path = ROOT / 'lib' / 'main.dart'
app_delegate_path = ROOT / 'ios' / 'Runner' / 'AppDelegate.swift'


def patch_main() -> None:
    text = main_path.read_text()

    if "import 'che_local_ai.dart';" not in text:
        anchor = "import 'che_native_voice.dart';\n"
        if anchor not in text:
            raise SystemExit('CHE local-AI patch: native voice import anchor not found')
        text = text.replace(anchor, anchor + "import 'che_local_ai.dart';\n", 1)

    text = text.replace(
        'bool freeNativeVoiceMode = false;',
        'bool freeNativeVoiceMode = true;',
        1,
    )

    old = """    if (response.statusCode != 200) {
      final body = await response.stream.bytesToString();
      throw _CHEAgentException(
        'CHE Agent error ${response.statusCode}: $body',
      );
    }
"""
    new = """    if (response.statusCode != 200) {
      final body = await response.stream.bytesToString();
      final lower = body.toLowerCase();
      final cloudQuotaFailure = response.statusCode == 429 ||
          response.statusCode == 503 ||
          lower.contains('quota') ||
          lower.contains('neurons') ||
          lower.contains('daily limit');

      if (!kIsWeb &&
          defaultTargetPlatform == TargetPlatform.iOS &&
          cloudQuotaFailure) {
        final local = await CheLocalAI.respond(
          trimmedRequest,
          history: history,
        );
        if (local != null && local.trim().isNotEmpty) {
          onPartial(local.trim());
          return;
        }
      }

      throw _CHEAgentException(
        'CHE Agent error ${response.statusCode}: $body',
      );
    }
"""
    if old in text:
        text = text.replace(old, new, 1)
    elif 'cloudQuotaFailure' not in text:
        raise SystemExit('CHE local-AI patch: agent error block not found')

    main_path.write_text(text)


def patch_app_delegate() -> None:
    if not app_delegate_path.exists():
        raise SystemExit('CHE local-AI patch: AppDelegate.swift was not generated')

    text = app_delegate_path.read_text()
    import_block = """#if canImport(FoundationModels)
import FoundationModels
#endif
"""
    if import_block not in text:
        anchor = 'import BackgroundTasks\n'
        if anchor not in text:
            raise SystemExit('CHE local-AI patch: BackgroundTasks import anchor not found')
        text = text.replace(anchor, anchor + import_block, 1)

    marker = '      let nativeShell = FlutterMethodChannel(\n'
    if 'name: "che/local_ai"' not in text:
        if marker not in text:
            raise SystemExit('CHE local-AI patch: nativeShell channel anchor not found')

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
            let history = rawHistory.suffix(8).compactMap { item -> String? in
              guard
                let role = item["role"] as? String,
                let text = item["text"] as? String,
                !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              else { return nil }
              return "\(role): \(text)"
            }.joined(separator: "\n")

            let fullPrompt = history.isEmpty
              ? prompt
              : "Recent conversation:\n\(history)\n\nOwner: \(prompt)"

            Task {
              do {
                let session = LanguageModelSession(instructions: """
                  You are CHE, the owner's concise personal AI assistant.
                  Answer directly and naturally. Preserve the owner's intent.
                  Do not mention Apple, Foundation Models, Cloudflare, quotas,
                  providers, or that you are a fallback unless explicitly asked.
                  Do not claim an external action happened unless the prompt
                  itself includes confirmation that it happened.
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

    app_delegate_path.write_text(text)


if __name__ == '__main__':
    patch_main()
    patch_app_delegate()
    print('CHE free local AI + local neural voice mode enabled')
