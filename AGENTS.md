# CHE owner requirements

The owner uses CHE voice-first, as if blind. Every feature must be fully usable by voice.

- CHE describes the current screen aloud, based on actual available screen context.
- Read options aloud as a numbered list and support spoken choices.
- Confirm every action aloud before and after execution; report actual success or failure.
- Never say "tap here" or depend on the owner seeing the screen.
- Open or act in an app only after the owner gives explicit spoken permission for that app. Enforce permission in execution code, not only in model instructions.
- Every screen touched must be voice-accessible: VoiceOver labels on every button, spoken feedback, and a voice route to each action.
- Claude owns the in-app voice navigator. Do not edit lib/browser/che_browser.dart, lib/home_state/send.dart, or the prompt in server/cloudflare/worker.js while that work is in progress.

The router's voice policy guides owner-facing replies. It does not itself implement screen narration, speech recognition, VoiceOver semantics, or app permission enforcement. Preserve and integrate the navigator implementation for those capabilities.
