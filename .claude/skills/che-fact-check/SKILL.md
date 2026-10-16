---
name: che-fact-check
description: Evidence rules for what CHE presents as true. Covers owner-confirmed memories vs source-backed facts vs model-only text, provenance, contradictions, corrections, retractions and hallucination prevention. Use when changing or reviewing code or prompts that decide what CHE claims (memory_provenance.js, truth_layer.js, knowledge_cache.js, research_memory.js, brain guide), when a screenshot shows CHE inventing a memory, an owner confirmation, a source or a tool action, or when checking a drafted CHE reply before the owner sees it.
---

# CHE fact-check

## The evidence model (enforced in code, not prompts)
These are the evidence tiers, strongest first. A reply must name its tier when that matters.
1. **Owner-confirmed.** The owner's own words or explicit approval:
   - The record has `source` ∈ {owner, owner_chat, explicit_memory, owner_approved} and `verification_status` = `owner_attested`.
   - It is active, not superseded, and has a date.
2. **Independently corroborated.** Two or more independent sources from a real research receipt in this turn agree.
3. **Source-backed, not fully verified.** A real source URL from a receipt. A link is not proof of every sentence.
4. **Inference.** Model reasoning, labelled as such.
5. **Unknown.** Say it cannot be established. Never fill the gap with a plausible story.

None of these is ever owner evidence:
- AI summaries.
- Vector-similarity hits.
- CHE's earlier replies, or repeated generations.
- Office or agent reports.
- `che-remember` lines the model wrote.

A claim to have searched, browsed, compared, verified or reviewed documents needs a tool or research receipt from **this** turn.

A link, headline, outlet or publication date counts only when a page CHE opened this turn says it (`source_verification.js`). A 404 is never a verified article. News answers rest only on articles opened this turn, and CHE's earlier replies are never evidence.

The full rules, the file map and the final-boundary order are in `reference/evidence-model.md`.

## Check a drafted reply (deterministic: CHE's own guards, no model)
```
node .claude/skills/che-fact-check/scripts/claim_check.mjs --reply "…" [--owner "his own words"]… [--records records.json] [--tool plugin/tool]… [--source https://…]… [--document-read] [--message "what the owner asked"]
```
It prints `PASS` or `BLOCKED`, each removed sentence, and the exact text the owner would see. Exit 1 means blocked.

## Check where a message goes
```
node .claude/skills/che-fact-check/scripts/claim_check.mjs --route "owner message"
```
It shows which route the message takes, and whether a model is involved:
- the evidence explanation;
- evidence plus a second request;
- an owner-memory answer;
- an owner correction;
- "which fact?";
- the general pipeline.

## Reproduce a conversation
Run a case with che-debug's replay: `node .claude/skills/che-debug/scripts/replay_chat.mjs .claude/skills/che-fact-check/cases/owner-12-34.json`. The `cases/` folder holds the owner's real screenshot conversations, with expectations.

## Rules when changing truth code
1. Fix the general mechanism. An exact-phrase special case (#298) silently dropped half of the owner's message.
2. An evidence ask must match a whole clause from its start. Test ordinary sentences that share its words, such as "Can you verify that my order shipped?" and "Octopuses have nine brains, is that true?".
3. Every guard needs the owner-device path and the guest path. Fiction or brainstorming the owner asked for stays untouched.
4. A correction ("Actually, my X is Y") updates only the owner's own fact. It never confirms an objective claim.
5. Never delete memory. Downgrade it (unverified_reference, disputed, superseded, invalidated) and keep the history.
6. Prove every change with a replay plus a test through `/api/chat`. In production, prove it with the deploy's live memory probe (see che-release).

## Lessons
- A fake search claim replaces the whole reply. An unsupported owner attribution removes only its sentence.
- Probing the guards with `claim_check.mjs` found three real gaps on 2026-10-14. Probe new phrasings the same way before you trust a guard.
- Dated lessons and measurements are in `reference/lessons.md`. Append new ones there.
