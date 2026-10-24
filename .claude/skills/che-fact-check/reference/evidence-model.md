# CHE evidence model: details

## Where each rule lives

| Concern | Code | Notes |
|---|---|---|
| "What did I confirm/say/approve…?" | `memory_provenance.js` `ownerMemoryQuestion` → `answerOwnerMemoryQuestion` | Answered from owner-attested active records only, with the date and how it was recorded. Makes 0 model calls. |
| "How do you know that?" / "The last one…" | `evidenceQuestion`, `evidenceRequestSplit`, `evidenceReferent`, `explainEvidenceFor` | Explains that answer's own ledger entry (`che_answer_ledger_v1`). An unsupported owner claim is retracted (`che_retracted_claims_v1`). |
| Unsupported "you told me / you confirmed" | `guardOwnerAttributions` | Removes the sentence and says so. Questions, hypotheticals and requested fiction pass. |
| Model-invented memories | `guardRememberBlock` | Keeps only `che-remember` lines found in the owner's own words that were not retracted. |
| "What memories / records do you have about X?", "which memory IDs did you retrieve?" | `owner_recall.js` `ownerMemorySearchIntent` → `ownerSearchTurn` (route `che_memory_search`, 0 model calls) | Reads the stores this turn; names only real ids, newest confirmed value first with what it replaced; `done.read_receipt` is the proof. Numbered memory records in model text are removed (`truth_layer.js` rule `memory_id`). |
| Claimed search, compare, verify or review | `truth_layer.js` `guardClaimedResearchActions` | Needs a successful tool, research sources or a document read from this turn. |
| "Research a fact" with no subject | `vagueResearchRequest` | Asks which fact. Nothing is researched. |
| Owner corrects his own fact | `ownerFactCorrection` + `addOwnerMemory` | The old record is kept as history (`superseded_by`). |
| Record provenance | `research_memory.js` `addOwnerMemory` | Default source `che_note`. `owner_attested` only for owner sources. |
| One-time audit | `auditMemoryProvenance` | Downgrades and never deletes. Runs once per record. |
| News question ("biggest AI story today") | `source_verification.js` `newsQuestion` → `newsResearch` (via `optionalResearch`) | GDELT and Hacker News listings; each article is opened and must exist, carry its headline and fall in the asked days. Only those are receipts (`research.articles`). |
| Links, headlines, outlets, publication dates in a reply | `guardCitations` | Every link is opened. A citation counts only when its page exists, is from the named outlet, carries the quoted headline and date, and says the sentence's specific terms. A news answer's events must appear in an article opened this turn. Removed sentences are named in the reply; "Sources I opened" and corroboration ("2 independent outlets" / "only one outlet") are added. |
| A broken citation or a claim shown false | `recordDisproven`, `downgradeDisproven`, `invalidateKnowledge` | `che_disproven_claims_v1`. Research notes become `disproven`, learned lines move to `invalidated_knowledge`, cached answers become `invalidated`. Nothing is deleted. The claim needs a fresh source before CHE says it again. |
| Owner says "that link is a 404" / "is that article real?" | `externalCorrection` → `recheckExternalClaim` (route `che_source_check`, 0 model calls) | Re-opens the earlier answer's links and searches for its coined names. Admits and records a failure; keeps a claim whose source holds up. |
| Prompt separation | `memoryPromptContext` | `OWNER-STATED MEMORIES` vs `CHE NOTES AND INFERENCES`. |

## Final boundary order in `worker.js`
Each reply passes through these steps, in this order:
1. `guardClaimedResearchActions`
2. `guardCitations` (source_verification.js)
3. `guardOwnerAttributions`
4. `guardRememberBlock`
5. `sanitizeOwnerText`
6. `recordAnswerEvidence`

`claim_check.mjs` runs steps 1, 3 and 4. Step 2 opens pages, so it is tested through `/api/chat` against a simulated web in `server/cloudflare/source_verification.test.mjs`. Other guards, such as location/weather and `guardOwnerReply`, run on their own paths.

A fake search, browse or comparison claim replaces the **whole** reply. Anything else in it may rest on the search that never ran, so harmless lines are lost as well. An unsupported owner attribution removes only its sentence.

## Contradictions
- A newer owner statement about the same subject supersedes the older one. Both stay; answers use the newer one and can mention the history.
- A source that contradicts an owner statement does not overwrite it. Report both, with their tiers.
- A model answer that contradicts a record loses to the record. Say "my earlier answer was wrong".

## Production proof
`POST /api/memory/probe` is token-gated and runs in an isolated Durable Object. The deploy workflow calls it on every Worker deploy and fails on any memory-step failure. Read the result with `che-release`.
