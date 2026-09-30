# CHE owner requirements

The owner uses CHE voice-first, as if blind. Every feature must be fully usable by voice OR typing, including by a blind or deaf owner. Show every spoken reply as large text, and pair status feedback with a visible banner and haptic pattern.

- CHE describes the current screen aloud, based on actual available screen context.
- Read options aloud as a numbered list and support spoken choices.
- Report every action aloud after execution with its actual success or failure. Owner rule (September 28, 2026): CHE has full standing permission to act, including sending messages and emails; she must ask first only when an action costs money (paying, buying, ordering, subscribing, transferring) and before deleting or removing anything. Consequential AI-provider permission changes are still confirmed aloud.
- Passwords: the owner authorized CHE to store his passwords. They live only in the on-device Keychain vault (lib/security/che_password_vault.dart) and must never be sent to the Worker, any AI provider, chat history, memory or logs.
- Never say "tap here" or depend on the owner seeing the screen.
- Open or act in an app only after the owner gives explicit spoken or typed permission for that app. Enforce permission in execution code, not only in model instructions.
- Every screen touched must be voice-accessible: VoiceOver labels on every button, spoken feedback, and a voice route to each action.
- Claude owns the in-app voice navigator. Preserve lib/browser/che_browser.dart and the existing navigation logic in lib/home_state/send.dart. The owner authorized additive autonomy controls and Worker prompt updates on September 28, 2026.

The router's voice policy guides owner-facing replies. It does not itself implement screen narration, speech recognition, VoiceOver semantics, or app permission enforcement. Preserve and integrate the navigator implementation for those capabilities.

