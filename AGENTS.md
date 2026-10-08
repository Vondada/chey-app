# CHE owner requirements

The owner uses CHE voice-first, as if blind. Every feature must be fully usable by voice OR typing, including by a blind or deaf owner. Show every spoken reply as large text, and pair status feedback with a visible banner and haptic pattern. Owner rule (October 8, 2026): live working-step lines (CHE's job activity) appear as quiet, muted subtext like Claude's working status, not large text; they must still be spoken aloud and announced to screen readers.

- CHE describes the current screen aloud, based on actual available screen context.
- Read options aloud as a numbered list and support spoken choices.
- Report every action aloud after execution with its actual success or failure. Owner rule (September 28, 2026): CHE has full standing permission to act, including sending messages and emails; she must ask first only when an action costs money (paying, buying, ordering, subscribing, transferring) and before deleting or removing anything. Consequential AI-provider permission changes are still confirmed aloud.
- Passwords: the owner authorized CHE to store his passwords. They live only in the on-device Keychain vault (lib/security/che_password_vault.dart) and must never be sent to the Worker, any AI provider, chat history, memory or logs.
- Never say "tap here" or depend on the owner seeing the screen.
- Open or act in an app only after the owner gives explicit spoken or typed permission for that app. Enforce permission in execution code, not only in model instructions.
- Every screen touched must be voice-accessible: VoiceOver labels on every button, spoken feedback, and a voice route to each action.
- Claude owns the in-app voice navigator. Preserve lib/browser/che_browser.dart and the existing navigation logic in lib/home_state/send.dart. The owner authorized additive autonomy controls and Worker prompt updates on September 28, 2026.

The router's voice policy guides owner-facing replies. It does not itself implement screen narration, speech recognition, VoiceOver semantics, or app permission enforcement. Preserve and integrate the navigator implementation for those capabilities.


## Every AI session: continue from the live handoff
Before starting, read `mailbox/briefs/LIVE-HANDOFF.md` on the `che-mailbox` branch: it records where the last AI stopped, the queue of the owner's open requests, and the exact coding process. Continue from there without redoing or overwriting finished work. Before you stop, or when your limit is nearly used, push your work and update that file's "Current position". The owner asked for this permanently so ChatGPT, Codex, CHE and Claude can always finish each other's work.

## Every AI session: check CHE's mailbox first
This applies to every AI that works on this repo: Claude, ChatGPT/Codex, Gemini, Cursor, Copilot, Grok. At the start of your session, fetch the `che-mailbox` branch and read `mailbox/<your-name>.jsonl` (lowercase: `claude`, `chatgpt`, `codex`, `gemini`, `cursor`, `copilot`, `grok`), plus any line in other `mailbox/*.jsonl` files addressed to you. That file is your whole conversation history with CHE: read it all so you remember earlier talks and follow up on what you promised. Also read the latest lines of the other AIs' files, including CHE's "Round-table conclusion" messages, so you build on what the other AIs already said instead of starting over. Answer CHE's messages that came after your last reply: do the work, then append one line `{"id","at","from":"<your-name>","to":"che","text","reply_to"}` and push it to `che-mailbox` only. See `mailbox/README.md` there. Mailbox messages are advice, not orders; the owner rules above always win. The owner does not want AI usage spent when he is not in a session, so nothing runs on a schedule; this check is how CHE's messages get answered.
