# Repo integration mission: plan and live status (Claude, started 2026-10-04 23:55 UTC)

The owner asked: "Read and study all of these repositories, then integrate them into CHE. Pick the best qualities. Enhance what she already has, and add what she doesn't. Make it additive and useful for our goal." He sent the list as screenshots.

**If you are ChatGPT, Codex, CHE or another AI picking this up:** continue from the "Status" column below. Trust git over this file. Owner rules in AGENTS.md always win:
- voice-first accessibility;
- no secrets in the app;
- money and deletion need owner confirmation;
- merge only on the owner's "merge";
- `[worker-deploy]` in the title of any PR that changes the Worker.

## How the repos were studied
- Each repo was shallow-cloned anonymously, read-only, into `/home/user/study/<owner>_<repo>` (README, LICENSE and file tree).
- The license decides what may be done:
  - **MIT, Apache-2.0, BSD:** code and ideas may be adapted, with credit.
  - **GPL, AGPL, LGPL, Commons Clause:** learn the technique only and write CHE's own implementation. Never copy their code.

## Repos, licenses and what CHE gets

| Repo | License | Integration into CHE | Phase | Status |
|---|---|---|---|---|
| public-apis/public-apis | MIT | Resource finder: "find a free API for X" | 1 | planned |
| ripienaar/free-for-dev | none stated | Resource finder: "free hosting / free tier for X" (facts and links only) | 1 | planned |
| punkpeye/awesome-mcp-servers | MIT | Resource finder: "is there an MCP server for X" | 1 | planned |
| jaywcjlove/awesome-mac | CC0/MIT | Resource finder: "best Mac app for X" | 1 | planned |
| fffaraz/awesome-cpp | MIT | Resource finder: "C++ library for X" | 1 | planned |
| Hack-with-Github/Awesome-Hacking | CC0/MIT | Resource finder: defensive security learning only | 1 | planned |
| EbookFoundation/free-programming-books | CC-BY | Resource finder: "free book on X" | 1 | planned |
| openai/whisper | MIT | Audio attachments and voice notes transcribed by Whisper on Workers AI (free tier, no key). `/api/transcribe` | 2 | planned |
| QuantConnect/Lean, nautechsystems/nautilus_trader (LGPL), kernc/backtesting.py (AGPL), microsoft/qlib | various | Trading realism, techniques only: commissions and slippage in $, SQN, profit factor, longest losing streak | 3 | planned |
| TauricResearch/TradingAgents | Apache-2.0 | Deterministic analyst / bull / bear / risk checklist spoken with every entry alert (no tokens) | 3 | planned |
| prop-firm rules (FundYourEdge) + Lean risk management | n/a | Trading desk daily loss limit, read from the broker's realized P&L; blocks new orders past the limit | 3 | planned |
| Panniantong/Agent-Reach | MIT | "Reach" channels without API fees: Hacker News search (Algolia), RSS/Atom reading, Jina Reader fallback for hard web pages | 4 | planned |
| emilkowalski/skills | MIT | Import its SKILL.md files with CHE's existing skill import (license-checked) for UI, motion and Apple-design taste in her coding crew | 5 | planned |
| usestrix/strix | Apache-2.0 | Defensive security review of CHE's own code proposals: deterministic checks added to her validation (eval/new Function, TLS off, auth bypass, secrets) | 5 | planned |
| affaan-m/ECC, DietrichGebert/ponytail, donnemartin/system-design-primer | MIT | Coding-crew guidance (verification loop, simplest change first). Mostly already in STARRED_FOCUS (#178); her live-stars study covers them | 5 | partly done |
| shiyu-coder/Kronos | MIT | Learn only for now: needs a GPU Python host. Possible later: an owner-hosted forecast endpoint | — | study-only |
| debpalash/VoiceStudio | AGPL | Learn only: local voice cloning needs a desktop or Pi host. CHE keeps Kokoro | — | study-only |
| NaiboWang/EasySpider | AGPL | Learn only: visual recorded scraping. Concept noted for CHE's browser agent | — | study-only |
| freqtrade (GPL), FinRL, vectorbt (Commons Clause), stefan-jansen ML-for-trading | various | Techniques already used in trading_lab (#178/#179). No code copied | — | done (ideas) |
| papers-we-love, coding-interview-university, developer-roadmap, openclaw, cursor/plugins, flutter_scene | various | Covered by her live starred-repo study and STARRED_FOCUS (#178) | — | done |

## Execution order (one PR per phase; tests with every PR)
1. **Phase 1, Resource finder.** New file `server/cloudflare/resource_catalogs.js`.
   - Fetch each list's raw README, parse it into entries (name, url, description, category), cache in Durable Object storage for 7 days.
   - Deterministic search. Answers are spoken as a numbered top-5 list naming the source list.
2. **Phase 2, Whisper.** `transcribeAudio(env, base64)` using `@cf/openai/whisper-large-v3-turbo` (fallback `@cf/openai/whisper`).
   - Audio attachments in chat and owner-context are transcribed first.
   - `/api/transcribe` returns `{ text, language, duration }`.
3. **Phase 3, Trading realism and risk.** In `trading_lab.js` and `trading_desk.js`:
   - costs and slippage per futures contract;
   - SQN and longest losing streak;
   - spoken analyst checklist;
   - daily loss limit by voice: "set my daily loss limit to 500 dollars".
4. **Phase 4, Reach.** HN search, RSS reading, and Jina Reader fallback in `library.fetchReadable`.
5. **Phase 5, Coding crew.**
   - Strix-style deterministic security checks in the self-development validation.
   - Import emilkowalski/skills through the existing skill import.

## Where I am right now
- 2026-10-04 23:59 UTC: #185 merged (faster exam).
- Repos studied (READMEs, licenses, trees). This plan written.
- Next: Phase 1 on branch `claude/che-repo-integration`.

## Update 2026-10-05 ~04:50 UTC
- PAUSED for the owner's Super-AI control plane (#193).
- Phase 1 WIP is committed on `claude/che-repo-integration`: `server/cloudflare/resource_catalogs.js`. It has the parser, search and spoken answers, verified by hand on the real lists (public-apis: 2050 entries, awesome-mcp-servers: 4101, awesome-mac: 1349, awesome-cpp: 1393, free-for-dev: 1320, free-programming-books: 838).
- **Next step:**
  1. Fix `resourceIntent` for "security learning resources for X" (it currently returns null).
  2. Add tests.
  3. Wire `resourceIntent` into the `/api/chat` intents before AI, using `loadCatalog(this.ctx.storage, id)`.
  4. Open a PR with `[worker-deploy]`.
