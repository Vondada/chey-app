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
