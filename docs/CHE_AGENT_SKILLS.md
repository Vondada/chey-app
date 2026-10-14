# CHE's approved installed agent skills

## Reviewed installation

`find-skills` is installed at `.opencode/skills/find-skills/SKILL.md` from
`vercel-labs/skills`, commit `e878c4502674f84094dc27b5ad94ddaf64f22551`.
Upstream path: `skills/find-skills/SKILL.md`; Git blob:
`a41bdd074bb587afd861332cf2f473f3154de4d7`. MIT license included alongside it.
The file was read before copying; its blob is checked by a regression test.

The package directory contains only Markdown, no scripts. Its instructions
include `npx skills add ... -g -y` and update commands. Those can download and
install arbitrary third-party packages; they are **not** authorized executable
capabilities. The upstream CLI also sends search telemetry. Installation here
copies the reviewed document and license without invoking that CLI.

## CHE runtime, not just OpenCode

Cloudflare has no checkout filesystem. `server/cloudflare/installed_skills.js`
is the explicit deployment-time approval registry and reviewed adapter for the
installed skill. Its provenance, intended use and supported capability are
available to CHE's prompt and to owner chat. Tests tie the adapter to the exact
installed document. Merely adding a file under `.opencode/skills`, changing
AGENTS.md, or teaching CHE prose through `self_skills.js` cannot approve tools.
The existing `opensrc` and `ponytail` files are not runtime-approved.

Approved capability: `find-skills/search`. It implements the upstream search
workflow through the existing `runPluginTool` HTTPS GET executor, using the
same public search API verified in upstream `src/find.ts`. It checks source
repository identity and stars on GitHub and reports index install counts.
The adapter searches directly rather than scraping the HTML leaderboard or
running the CLI. Results remain unreviewed candidates, never recommendations
claimed to be safe and never automatic installations.

The executor keeps its HTTPS/host permissions, manual redirect rejection,
8-second timeout and 12KB response bound. Requests supply public task keywords,
not history or attachments. Returned names and source paths are validated;
remote prose never enters model instructions. Only paired owner requests may
use this adapter; owner money/delete gates precede the chat route. No app is
opened by a search. Numbered link choices reuse the existing resource finder.
No new command runner, paid provider, dependency or background schedule exists.

## Voice or typed use

- `List installed skills`
- `Find a skill for React testing`
- `Is there a skill for accessibility?`
- `Use find-skills for Flutter testing`
- `Open number one` immediately after the results (existing numbered choices)

The chat response reports actual tool success/failure and a structured receipt;
Flutter uses its existing caption, speech, banner and haptic path. An unsupported
skill or command returns an explicit refusal to execute, never a pretend receipt.

## Adding another capability

Review its pinned contents and license, obtain owner authorization for its
actual operations, then add a bounded adapter through existing tools and tests.
Do not parse and execute shell examples or trust a skill's claimed permissions.

## Verification

Run `node --test server/cloudflare/*.test.mjs`, Flutter analysis and tests.
The Worker integration tests exercise paired chat, denied access, real adapter
dispatch, numbered choices, upstream failure and unknown-command rejection.
For production acceptance, send the commands above through a paired CHE chat
and check `done.source = che_installed_skills` and its `skill_receipt` against
live index results. A local HTTP test is not proof of production deployment.

## Development skills for Claude Code (`.claude/skills/`)

These are workflow skills for the AIs that build CHE. They are **not** CHE runtime capabilities. Adding them changed nothing in `APPROVED_SKILLS`, and CHE does not load them in chat.

| Skill | Use it for | Deterministic scripts |
|---|---|---|
| `che-fact-check` | What CHE may present as true: evidence tiers, owner-confirmed memories, retractions, tool-claim receipts | `claim_check.mjs` runs CHE's own truth guards on a draft reply, or shows a message's route. `cases/` holds the owner's real screenshot conversations. |
| `che-debug` | Reproduce → locate → narrow fix → prove → review | `replay_chat.mjs` replays turns through the real `/api/chat` offline. `run_checks.sh` runs the CI checks for changed paths. `check_workflows.py` checks workflow YAML and inline scripts. |
| `che-release` | PR checks, merge, Worker deploy, live commit, probes, Shorebird, IPA | `release_status.mjs` is read-only status. Each consequential action needs the owner's authorization. |
| `che-youtube` | Sourced faceless-video packages for the existing video line | `check_package.mjs` checks sources, YouTube and CHE uploader limits, thumbnail honesty and publish approval. |

### How to invoke them
- **In Claude Code:** type `/che-fact-check`, `/che-debug`, `/che-release` or `/che-youtube`. Claude also picks one when the task matches its description: only the name and description load up front, and the body loads on demand.
- **Other AIs (Codex, Gemini, Cursor, OpenCode):** read `.claude/skills/<name>/SKILL.md` and run its scripts directly. Any of the scripts can be run by hand as well.
- **CHE's own coding crew:** the OpenCode runner's preamble (`che-opencode-runtime.yml`) points it to che-debug and che-fact-check. That is the existing mechanism, the same one that loads `ponytail`.

### Runtime integration
CHE's runtime enforces the fact-check rules in code (`memory_provenance.js`, `truth_layer.js`), not through a skill file. While che-fact-check was being written, `claim_check.mjs` found a production defect: the attribution guard dropped the rest of a short reply. It was fixed in `memory_provenance.js`, with a regression test.

Measured on 2026-10-14:
- CHE's compact chat prompt (2,911 characters) carries no skills list.
- The full prompt (31,176 characters) includes the 461-character installed-skills context (1.5%).
- Learned skills are already selected per message.

So no runtime prompt change was made for skills.

### Measured with and without each skill (2026-10-14)
**Agent A/B.** Each skill got the same task twice, on the same code, from a fresh agent: once told to use the skill, once with `.claude/` off limits. These are single runs, so treat them as indications, not averages. Tokens are the agent's full usage, including its fixed system prompt.

| Skill | Task | With skill | Without | Tokens | Time | Both correct |
|---|---|---|---|---|---|---|
| che-fact-check | What does the owner see for a draft reply? | 57,167 tok · 8 calls · 25 s | 72,958 tok · 9 calls · 44 s | −22% | −44% | yes |
| che-debug | Reproduce two chat turns through `/api/chat` | 51,137 · 6 · 19 s | 61,823 · 10 · 54 s | −17% | −64% | yes |
| che-release | Is #300 merged and live, and did the probes pass? | 55,888 · 8 · 34 s | 108,534 · 21 · 124 s | −49% | −72% | yes |
| che-youtube | Is a video package ready to render or publish? | 61,995 · 10 · 106 s | 76,815 · 13 · 72 s | −19% | **+47% (slower)** | yes |
| **Total** | | **226,187** | **320,130** | **−29%** | | |

**First round.** It ran in worktrees made from `main`, so the with-skill agents had to find the skill elsewhere. Results:

| Skill | Tokens with skill | Tokens without |
|---|---|---|
| fact-check | 69,473 | 76,098 |
| debug | 59,366 | 57,854 (the skill run used **more**) |

That run led to two fixes: the scripts now use the checkout they run in, and the replay lists refused network hosts per turn.

**Context bytes** (`node .claude/skills/tests/measure.mjs`; tokens ≈ bytes/4, an estimate):

| Question | Without the skill | With the skill |
|---|---|---|
| Worker suite pass/fail | 291,218 B of TAP | 21 B |
| Is #300 merged and live? | 436,533 B of raw API JSON | 839 B |
| What does the owner see? | 70,567 B of guard source | 270 B |
| Is the package ready? | 11,216 B of pipeline source | 738 B |
| Skill instructions held before use | 2.9–4.7 KB each | 453–573 B each (name and description only) |

### Tests
`node --test .claude/skills/tests/*.test.mjs` runs in CI (`flutter-check.yml`, Worker job). It covers:
- skill selection by description;
- script execution on the owner's real cases;
- evidence integrity;
- token budgets;
- failure recovery.
