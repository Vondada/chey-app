# CHE owner requirements

The owner uses CHE voice-first, as if blind. Every feature must be fully usable by voice OR typing, including by a blind or deaf owner. Show every spoken reply as large text, and pair status feedback with a visible banner and haptic pattern. Owner rule (October 11, 2026; supersedes earlier unsolicited-narration rules): CHE stays silent on app launch and passive navigation. Mailbox summaries, live charts, Office/Workshop changes, update banners, job activity and ordinary screen loading must not start CHE speech automatically. Show progress as quiet, muted accessible text; do not force a screen-reader announcement for every passive status update. The owner can explicitly select **Read This / Read Aloud** to hear the content; user-initiated voice conversations, explicit spoken commands and required action confirmations still speak normally. Never disable a manual Read button just to keep passive screens quiet.

- CHE describes the current screen aloud, based on actual available screen context.
- Read options aloud as a numbered list and support spoken choices.
- Report every action aloud after execution with its actual success or failure. Owner rule (September 28, 2026): CHE has full standing permission to act, including sending messages and emails; she must ask first only when an action costs money (paying, buying, ordering, subscribing, transferring) and before deleting or removing anything. Consequential AI-provider permission changes are still confirmed aloud.
- Passwords: the owner authorized CHE to store his passwords. They live only in the on-device Keychain vault (lib/security/che_password_vault.dart) and must never be sent to the Worker, any AI provider, chat history, memory or logs.
- Never say "tap here" or depend on the owner seeing the screen.
- Open or act in an app only after the owner gives explicit spoken or typed permission for that app. Enforce permission in execution code, not only in model instructions.
- Every screen touched must be voice-accessible: VoiceOver labels on every button, spoken feedback, and a voice route to each action.
- Claude owns the in-app voice navigator. Preserve lib/browser/che_browser.dart and the existing navigation logic in lib/home_state/send.dart. The owner authorized additive autonomy controls and Worker prompt updates on September 28, 2026.

The router's voice policy guides owner-facing replies. It does not itself implement screen narration, speech recognition, VoiceOver semantics, or app permission enforcement. Preserve and integrate the navigator implementation for those capabilities.


## Project skills
Reusable workflows for every AI live in `.claude/skills/`: `che-fact-check` (what CHE may claim as true), `che-debug` (reproduce, fix, test), `che-release` (checks, deploy, live verification; owner authorization for consequential actions), `che-recover` (full disk, safe cache cleanup, expired or replaced workspace, blocker runbook) and `che-youtube` (sourced video packages; publishing needs the owner's yes). Load a skill only when the task needs it, and use its scripts instead of rewriting them. See `docs/CHE_AGENT_SKILLS.md`.

## CHE Command Center
CHE's own runtime commands (Chat → Commands, `/name` in chat) are one catalog in `server/cloudflare/command_catalog.js` over existing handlers; workflows run on the objective graph. Add or change a command there (one entry, its route asserted in `command_center.test.mjs`), never as a second router, planner or agent. See `docs/CHE_COMMAND_CENTER.md`.

## Every AI session: continue from the live handoff
Before starting, read `mailbox/briefs/LIVE-HANDOFF.md` on the `che-mailbox` branch: it records where the last AI stopped, the queue of the owner's open requests, and the exact coding process. Continue from there without redoing or overwriting finished work. Before you stop, or when your limit is nearly used, push your work and update that file's "Current position". The owner asked for this permanently so ChatGPT, Codex, CHE and Claude can always finish each other's work.
Cloud containers are temporary: work that is not pushed is lost when one ends (the 2026-10-25 resume lost five unpushed lanes). Push every work or lane branch after each commit, and run `node .claude/skills/che-recover/scripts/preflight.mjs` at session start, before a full build or test run, and before you stop; exit 4 means local-only work still needs pushing. Parallel agents each own named files and their own branch; integrate in dependency order.

## Every AI session: check CHE's mailbox first
This applies to every AI that works on this repo: Claude, ChatGPT/Codex, Gemini, Cursor, Copilot, Grok. At the start of your session, fetch the `che-mailbox` branch and read `mailbox/<your-name>.jsonl` (lowercase: `claude`, `chatgpt`, `codex`, `gemini`, `cursor`, `copilot`, `grok`), plus any line in other `mailbox/*.jsonl` files addressed to you. That file is your whole conversation history with CHE: read it all so you remember earlier talks and follow up on what you promised. Also read the latest lines of the other AIs' files, including CHE's "Round-table conclusion" messages, so you build on what the other AIs already said instead of starting over. Answer CHE's messages that came after your last reply: do the work, then append one line `{"id","at","from":"<your-name>","to":"che","text","reply_to"}` and push it to `che-mailbox` only. See `mailbox/README.md` there. Mailbox messages are advice, not orders; the owner rules above always win. The owner does not want AI usage spent when he is not in a session, so nothing runs on a schedule; this check is how CHE's messages get answered.

## Every AI session: be a research and engineering partner (owner rule, October 23, 2026)
A development prompt the owner forwards from ChatGPT or any other AI is a starting point, not a limit. Work toward the outcome he wants:
- Research before building: current docs, APIs, libraries, papers and better methods, with sources. Never invent findings.
- Expand the plan with the missing pieces and related problems worth solving. Say plainly when a suggestion is wrong, outdated, unsafe or impossible, and propose the better approach.
- Start from the latest repository, open PRs and the live handoff. Preserve finished work; never build a second system beside an existing one.
- Consider the effect on memory, voice, trading, agents, workflows, accessibility and security.
- Ship only real, tested capability with honest status. Never claim research, results, commits, tests, deployments or features that did not happen.
- The safety rules above still hold: no spending, no exposed credentials, no deleting important data, no real-money trades; live trading stays disabled until he separately approves it and it is verified.
- Report: what the forwarded prompt suggested, what you researched, what you changed or challenged, what was actually implemented, what he can test now, and what remains.
