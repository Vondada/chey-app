# CHE evidence model: details

## Where each rule lives

| Concern | Code | Notes |
|---|---|---|
| "What did I confirm/say/approve…?" | `memory_provenance.js` `ownerMemoryQuestion` → `answerOwnerMemoryQuestion` | Answered from owner-attested active records only, with the date and how it was recorded. Makes 0 model calls. |
| "How do you know that?" / "The last one…" | `evidenceQuestion`, `evidenceRequestSplit`, `evidenceReferent`, `explainEvidenceFor` | Explains that answer's own ledger entry (`che_answer_ledger_v1`). An unsupported owner claim is retracted (`che_retracted_claims_v1`). |
| Unsupported "you told me / you confirmed" | `guardOwnerAttributions` | Removes the sentence and says so. Questions, hypotheticals and requested fiction pass. |
| Model-invented memories | `guardRememberBlock` | Keeps only `che-remember` lines found in the owner's own words that were not retracted. |
| Claimed search, compare, verify or review | `truth_layer.js` `guardClaimedResearchActions` | Needs a successful tool, research sources or a document read from this turn. |
| "Research a fact" with no subject | `vagueResearchRequest` | Asks which fact. Nothing is researched. |
| Owner corrects his own fact | `ownerFactCorrection` + `addOwnerMemory` | The old record is kept as history (`superseded_by`). |
| Record provenance | `research_memory.js` `addOwnerMemory` | Default source `che_note`. `owner_attested` only for owner sources. |
| One-time audit | `auditMemoryProvenance` | Downgrades and never deletes. Runs once per record. |
| Prompt separation | `memoryPromptContext` | `OWNER-STATED MEMORIES` vs `CHE NOTES AND INFERENCES`. |

## Final boundary order in `worker.js`
Each reply passes through these steps, in this order:
1. `guardClaimedResearchActions`
2. `guardOwnerAttributions`
3. `guardRememberBlock`
4. `sanitizeOwnerText`
5. `recordAnswerEvidence`

`claim_check.mjs` runs steps 1–3. Other guards, such as location/weather and `guardOwnerReply`, run on their own paths.

## Contradictions
- A newer owner statement about the same subject supersedes the older one. Both stay; answers use the newer one and can mention the history.
- A source that contradicts an owner statement does not overwrite it. Report both, with their tiers.
- A model answer that contradicts a record loses to the record. Say "my earlier answer was wrong".

## Production proof
`POST /api/memory/probe` is token-gated and runs in an isolated Durable Object. The deploy workflow calls it on every Worker deploy and fails on any memory-step failure. Read the result with `che-release`.
