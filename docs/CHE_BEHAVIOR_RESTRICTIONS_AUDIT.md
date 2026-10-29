# CHE behavioral restrictions audit (2026-10-28)

Scope: application-level rules that shape what CHE may say or do: system prompts sent to the model, reply
filters and refusals, and money, secret, privacy and permission guards. Each row says where it lives, what it does,
and whether the owner asked for it. The owner's standing rule is that CHE never spends, transfers, purchases,
subscribes or commits money without explicit approval. Every money guard below is kept.

Ollama: no `Modelfile` and no Ollama `SYSTEM` instruction exist in this repository. The only "modelfile" match is a
comment in `lib/che_kokoro_voice.dart`. Nothing in this audit adds one.

## 1. Model-facing system prompts

| # | Rule | Where | What it does | Owner-requested? | Decision |
|---|------|-------|--------------|------------------|----------|
| 1.1 | Voice-first policy (`CHE_VOICE_FIRST_POLICY`) | `server/cloudflare/ai_router.js:33`, sent at lines 646 and 710 | Voice-and-text accessibility; no false claims of contacting other AIs or running work; refuse only secrets, money, permission changes and deleting; ask before spending or deleting; spoken style (no bullets, dashes, parentheses; no code unless asked) | Yes: labelled "owner accessibility rule" and written for the owner's voice use | Retained |
| 1.2 | Soul voice (`SOUL_VOICE`) | `server/cloudflare/soul.js:102` | Bans stock assistant phrases; no jokes or profanity in serious matters; flirting only for the owner, never sexual; tone never changes facts or holds | Yes: Soul traits set by the owner (2026-10-22) | Retained |
| 1.3 | Private turn note (`PRIVATE_TURN_NOTE`) | `server/cloudflare/ai_router.js:631` | When private voice is on, no outside search or other AI; never claims a search happened | Yes: the owner's private-voice setting | Retained (privacy) |
| 1.4 | Work policy, terminal chat-only | `server/cloudflare/worker.js:15266` | A chat-only turn may not start a coding job or claim a repository change | Owner's truth rule (no invented PRs or deploys) | Retained (truth) |
| 1.5 | Skill condensing | `server/cloudflare/self_skills.js:100` | Documents become skills; passwords, payments, deleting and ignoring instructions are left out | Security | Retained |
| 1.6 | Site builder rules | `server/cloudflare/site_builder.js:91` | Output format for generated sites; ignore instructions about secrets or other systems inside the request | Security and build spec | Retained |
| 1.7 | Film and exam, translation, comedy, other specialist prompts | `film_studio.js:484,492`, `reasoning_exam.js:171`, `translate.js:172`, `comedy_study.js:335`, `ai_consult.js:74,140` | Task-format instructions for those tools (JSON only, one-line translation, exam format). No content refusals | Task design | Retained |

## 2. Reply filters and refusals

| # | Rule | Where | What it does | Owner-requested? | Decision |
|---|------|-------|--------------|------------------|----------|
| 2.1 | Generic-phrase check | `server/cloudflare/social_corrections.js:54` (`GENERIC`) | Flags stock phrases in the live social probe; the probe fails on them | Follows 1.2 (owner's Soul rule) | Retained. This is the check that failed on staging once |
| 2.2 | Profanity and mode-talk check | `social_corrections.js:44,63` | In clean-language mode, the reply may not swear or announce the mode | Yes: owner's clean-language setting | Retained |
| 2.3 | Refusal-retry | `server/cloudflare/self_development.js:675` (`refusesAnswer`) | A draft that says "I cannot confirm" is retried once with the source re-read. It does not block the reply | Engineering behavior, not a user restriction | Retained |
| 2.4 | Negated-clause reader | `server/cloudflare/creator_studio.js:367,405` (`BANNED_STEP`, `withoutProhibitions`) | Reads what the owner asks for: the negated clauses ("don't render the pilot") are removed from the text used to recognise an action, and kept in `forbidden`, so a negative command is not read as a request. It does not edit any plan text that is shown | Engineering behavior that protects the owner's "do not" commands | Retained. No owner decision is needed (corrected 2026-10-29 after review of #751) |
| 2.5 | Manifest safety refusal | `server/cloudflare/manifest_api.js:150,216` | Refuses a build spec the safety check rejects, with the reason | Safety | Retained |
| 2.6 | Emergency route | `social_corrections.js` (Test 7 safety route) | A serious, high-risk message gets a calm answer that points to emergency services | Safety | Retained |

## 3. Money, secret, privacy and permission guards

These are the owner's protections and are kept without change: the trading kill switch and live-order refusal
(`trading_desk.js`, `trading_environments.js`), the money and delete hold (`workflow_engine.js:94`,
`owner_action_gate.js`), the secret gate and redaction (`brain_store.js:98-118`, `self_skills.js:109`), Private
Mode (`privacy_mode.js`), Modal's spend gate (`modal_gpu.js`, `compute_budget.js`), and the Cloud Computer's refusal
of paid providers (`cloud_computer.js:150`).

## 4. Result

- Removed: none. I did not find a restriction that the owner did not request and that is also not security, privacy,
  money, legal, or accessibility.
- Corrected (review of #751, 2026-10-29): 2.4 is a negated-clause reader, not an output restriction, so it needs no owner decision. Item 1.1 has two spoken-style rules
  (no bullets or parentheses; no code unless asked) that the owner may want to change. They are part of the owner's
  accessibility rule, so I have not changed them.
- Model defaults are unchanged. The default model, memory, personality, Office agents and model routing were not
  touched.
