// CHE truth pipeline: the owner-facing reply boundary as one ordered list of stages.
//
// Before this module, worker.js called fourteen guards one after another at the end of /api/chat, each added after
// a dated incident. They still run here, in the same order, with the same inputs and the same log lines, so
// behavior is unchanged. What is new: one place that names the order, one request id, one ledger write, and a
// stage that throws fails closed (the reply keeps going through the later stages, and the auditor sees it).
//
// A stage is { name, run(reply, ctx) -> { text, removed?, earlyResponse? } }. `removed` becomes ledger rows under
// the stage's name (hallucination_auditor.js keeps labels only, never the sentence). `earlyResponse` ends the
// pipeline with a finished Response (the pretend-tool picture path).

import { adRequest, adStatusLines, assetTruthReply } from './asset_truth.js';
import { replyRepeatsAgentTask } from './agent_task_guard.js';
import { capabilityGap, capabilityReply } from './capability_gap.js';
import { CHAT_IMAGE_SOURCE, chatImageInline, chatImageMedia, chatImageReply, makeChatImages, pretendToolCall } from './chat_images.js';
import { sanitizeOwnerText } from './che_errors.js';
import { auditEvidenceFrom, auditReply, claimKindsIn, guardRemovalEntries, recordAudit } from './hallucination_auditor.js';
import { answerEvidenceReceipt, LAST_ANSWER_EVIDENCE_KEY } from './knowledge_cache.js';
import { brainRecordForProvenance, guardOwnerAttributions, guardRememberBlock, guardSpeakerAttributions, loadRetractions, ownerWords, storyRequested } from './memory_provenance.js';
import { groundedReply } from './personal_recall.js';
import { redactGoogleIds } from './research_memory.js';
import { guardEngineClaims, guardSoulClaims } from './soul.js';
import { guardCitations } from './source_verification.js';
import { guardClaimedOwnerActions, guardClaimedResearchActions, guardExecutionClaims, guardOwnerReply, recordReceipt, verifiedStatusText } from './truth_layer.js';

const userTurns = (history, n) => (Array.isArray(history) ? history : []).filter((turn) => turn?.role === 'user').slice(-n).map((turn) => String(turn.content ?? turn.text ?? ''));

export const TRUTH_STAGES = Object.freeze([
  // Truth layer: a model sentence can never promote execution state. Unsupported action claims and owner
  // "homework" are removed and replaced with what the receipts actually show.
  { name: 'truth_layer', async run(reply, ctx) {
    const { self, data, env, message, officeResults, skillResults, turnActionPolicy, chatOnlyEvaluation } = ctx;
    const state = await self.currentVerifiedState(data);
    const guarded = guardOwnerReply(reply, state, {
      repoAvailable: Boolean(env.CHE_GITHUB_TOKEN && env.CHE_GITHUB_REPO),
      turnEvidence: officeResults.length > 0 || skillResults.length > 0,
    });
    if (!guarded.removed.length) return { text: reply, removed: [] };
    console.log('CHE truth layer removed claims', JSON.stringify(guarded.removed).slice(0, 1500));
    let note = '';
    if (guarded.homework) {
      const last = await Promise.resolve().then(() => ctx.storage.get(ctx.keys.LAST_ENGINEERING_REQUEST_KEY)).catch(() => null);
      const lastAt = Date.parse(last?.at || '');
      const lastAuthorized = Boolean(last?.request && last?.integrate === true && (!Number.isFinite(lastAt) || Date.now() - lastAt < 6 * 3600_000));
      const explicitContinuation = /\b(?:what\s+do\s+you\s+need\s+from\s+me|continue|resume|finish|repo\s+upgrade|coding\s+job|engineering\s+job)\b/i.test(message);
      if (last?.request && env.CHE_GITHUB_TOKEN && (turnActionPolicy.codingJobAllowed || (!chatOnlyEvaluation && lastAuthorized && explicitContinuation))) {
        const queued = await self.queueSelfDevelopment({ request: last.request, groundedRequest: last.request });
        await recordReceipt(ctx.storage, { kind: 'job_started', key: `job:${queued.job.id}`, job_id: queued.job.id, job_kind: 'self_development' });
        note = `I'll read my own source from GitHub. Coding job ${queued.job.id.slice(0, 8)} is ${queued.job.status === 'running' ? 'running' : 'queued'} for your request.`;
      } else {
        note = 'I read my own source from GitHub myself; you never need to paste code for me.';
      }
    }
    const statusNow = verifiedStatusText(await self.currentVerifiedState(data));
    const text = [guarded.text, note, guarded.text.length < 40 || guarded.removed.some((r) => r.rule !== 'owner_homework') ? statusNow : ''].filter(Boolean).join(' ').trim();
    return { text, removed: guarded.removed };
  } },
  // A chat model cannot create execution evidence by claiming it searched or compared sources. Text the owner
  // pasted (code, an article) has been read: it is in his own words in this conversation.
  { name: 'research_actions', run(reply, ctx) {
    ctx.shared.pastedText = [ctx.rawMessage, ...userTurns(ctx.ownerHistory, 4)]
      .some((words) => words.length > 400 || /```|^\s*(?:def |function |class |import |const |let |var |final |public |<\w+)/m.test(words));
    ctx.shared.documentRead = Boolean(ctx.multimodal?.summary || ctx.body.screen_context || ctx.shared.pastedText);
    return { text: guardClaimedResearchActions(reply, { research: ctx.research, tools: ctx.skillResults, documentRead: ctx.shared.documentRead, message: ctx.rawMessage }).text, removed: [] };
  } },
  // Nothing on this path sends, buys, deletes, uploads, renders, trades or opens anything, so a model sentence saying
  // it did is removed. This turn's connector, tool and screen results are the only records that can back "according to your calendar".
  { name: 'owner_actions', run(reply, ctx) {
    const unclaimed = guardClaimedOwnerActions(reply, {
      message: ctx.rawMessage,
      records: [ctx.body.screen_context, JSON.stringify(ctx.skillResults), JSON.stringify(ctx.actionResults), JSON.stringify(ctx.plugins), JSON.stringify(ctx.officeResults)],
    });
    if (unclaimed.removed.length) console.log('CHE truth layer removed action claims', JSON.stringify(unclaimed.removed).slice(0, 800));
    return { text: unclaimed.text, removed: unclaimed.removed };
  } },
  // Every link, headline, outlet and date must match a page CHE opened this turn. A broken citation is recorded so
  // it is never repeated as fact. Links the owner gave or a connector returned are their own receipts.
  { name: 'citations', async run(reply, ctx) {
    const sourced = await guardCitations(reply, {
      research: ctx.research, message: ctx.rawMessage, disproven: ctx.disproven, fiction: storyRequested(ctx.rawMessage),
      trusted: [ctx.rawMessage, ctx.body.screen_context, JSON.stringify(ctx.skillResults), JSON.stringify(ctx.actionResults), JSON.stringify(ctx.plugins), ...userTurns(ctx.ownerHistory, 6)],
    }).catch((error) => {
      console.log('CHE source check failed', error?.message || error);
      return { text: reply, removed: [], used: [], disproven: [] };
    });
    if (sourced.removed.length) console.log('CHE source check removed', JSON.stringify(sourced.removed).slice(0, 1500));
    // Bookkeeping never decides what the owner reads: a failed disproven-claim write is logged, and the sanitized
    // reply still goes on (Codex, #511: the old inline chain let the fabricated claim through when this threw).
    if (sourced.disproven.length) {
      try { await ctx.self.recordDisprovenClaims(ctx.data, sourced.disproven); } catch (error) {
        console.log('CHE disproven claims not recorded', error?.message || error);
      }
    }
    ctx.shared.sourced = sourced;
    return { text: sourced.text, removed: sourced.removed };
  } },
  // Every date in a reply must be one a stored record holds (personal_recall.js). An invented date is never shown.
  { name: 'grounding', run(reply, ctx) {
    const grounded = groundedReply(reply, { records: ctx.data.memory_records || [], message: ctx.rawMessage });
    if (grounded.removed.length) console.log('CHE grounding removed dates', JSON.stringify(grounded.removed));
    return { text: grounded.text, removed: grounded.removed };
  } },
  // A visual exists only when a record of this request made it, and a post only when one was published.
  // An ad request always ends with the three facts: copy written, visuals made, nothing scheduled or published.
  { name: 'asset_truth', run(reply, ctx) {
    const asset = assetTruthReply(reply, { made: 0, published: 0 });
    if (asset.removed.length) console.log('CHE asset check removed', JSON.stringify(asset.removed).slice(0, 800));
    const text = adRequest(ctx.rawMessage) ? [asset.text, adStatusLines({ copy: Boolean(asset.text), made: 0, published: 0 })].filter(Boolean).join('\n') : asset.text;
    return { text, removed: asset.removed };
  } },
  // A missing ability is never refused: CHE queues it for herself as a self-development job and says so.
  // Owner only; money, deletion and secrets are never queued.
  { name: 'capability_gap', async run(reply, ctx) {
    const gap = ctx.ownerDevice ? capabilityGap(ctx.rawMessage, reply) : null;
    if (!gap) return { text: reply, removed: [] };
    const { job } = ctx.helpers.enqueueJob(ctx.data, gap.fields);
    await ctx.storage.put('che', ctx.data);
    await ctx.self.scheduleWork();
    return { text: capabilityReply(job.id), removed: [] };
  } },
  // Nothing the owner did not say becomes "you told me". Owner evidence: his own turns, the owner-attested memory
  // records and the owner-attested Brain records retrieved this turn. Every other named speaker needs its own record.
  { name: 'attribution', async run(reply, ctx) {
    const ownerTurnsNow = ownerWords(ctx.ownerHistory, ctx.rawMessage);
    const provenanceRecords = [...(ctx.data.memory_records || []), ...ctx.workerBrainHits.map(brainRecordForProvenance)];
    const attribution = guardOwnerAttributions(reply, { records: provenanceRecords, ownerTurns: ownerTurnsNow, message: ctx.rawMessage });
    const speakers = guardSpeakerAttributions(attribution.text, { records: provenanceRecords, message: ctx.rawMessage });
    const removed = [...attribution.removed, ...speakers.removed];
    if (removed.length) console.log('CHE memory truth removed', redactGoogleIds(JSON.stringify(removed)).slice(0, 800));
    ctx.shared.attributionRemoved = attribution.removed.length;
    const text = guardRememberBlock(speakers.text, { ownerTurns: ownerTurnsNow, retracted: await loadRetractions(ctx.storage) }).text;
    return { text, removed };
  } },
  // An Office task is never shown as CHE's own reply; the owner finds it in the Office view.
  { name: 'agent_task', run(reply, ctx) {
    return { text: replyRepeatsAgentTask(reply, ctx.data.team_tasks || []) ? 'That is an internal Office task, sir, so I am not repeating it here. It is in the Office view.' : reply, removed: [] };
  } },
  // Persist the actual answer-provenance receipt, not a model-invented bibliography.
  { name: 'answer_receipt', async run(reply, ctx) {
    const sourced = ctx.shared.sourced;
    ctx.shared.answerReceipt = answerEvidenceReceipt({
      research: sourced.used.length ? { ...ctx.research, sources: sourced.used.map((page) => page.final_url || page.url) } : ctx.research,
      tools: ctx.skillResults,
    });
    await Promise.resolve().then(() => ctx.storage.put(LAST_ANSWER_EVIDENCE_KEY, ctx.shared.answerReceipt)).catch(() => null);
    return { text: reply, removed: [] };
  } },
  // A leaked wake-word template is never shown.
  { name: 'wake_text', run(reply) {
    const leaked = /\[assistant name\]/i.test(reply) || (/start the conversation/i.test(reply) && /say\s+[“"'']?hey\b/i.test(reply));
    return { text: leaked ? 'I’m awake, sir. What do you need?' : reply, removed: [] };
  } },
  // A reply that is only a pretend tool call is never shown (owner, 2026-10-22: a "dalle.text2im" JSON object appeared
  // instead of a dog picture). When the owner asked for a picture, the real engine makes it from the model's own prompt.
  { name: 'pretend_tool_call', async run(reply, ctx) {
    const pretend = pretendToolCall(reply);
    if (!pretend) return { text: reply, removed: [] };
    if (pretend.picture && pretend.prompt && ctx.ownerDevice && !ctx.body.attachment && /\b(pictures?|images?|photos?|pics?|draw|paint|sketch|illustrat\w*|portraits?)\b/i.test(ctx.rawMessage)) {
      const results = await makeChatImages(ctx.keyEnv || ctx.env, ctx.storage, { message: pretend.prompt, count: 1 });
      const earlyResponse = ctx.helpers.ndjsonReply(chatImageReply(results), { source: CHAT_IMAGE_SOURCE, ok: results.some((r) => r.ok), model_calls: 1, media: chatImageMedia(results), ...chatImageInline(results, new URL(ctx.request.url).origin), served_by: ctx.answer?.served_by || null });
      return { text: reply, removed: [], earlyResponse };
    }
    return { text: 'That came out as an internal tool request instead of an answer, sir, so nothing was run. Ask me again and I will answer it directly.', removed: [] };
  } },
  // Final owner-facing boundary: keep internal provider/model failover chatter out of chat and TTS.
  { name: 'execution_claims', run(reply, ctx) {
    const guard = guardExecutionClaims(sanitizeOwnerText(reply, { truncate: false }), { message: ctx.rawMessage, receipts: ctx.skillResults.map((r) => r.execution_receipt), documentRead: ctx.shared.documentRead, verifiedText: ctx.brainContext });
    return { text: guard.text, removed: guard.removed };
  } },
  // Hallucination auditor: each completion claim must match a receipt from this request. An unreadable evidence
  // list fails closed. This stage writes the one ledger entry for the whole pipeline.
  // A story the owner asked for keeps its narrator's deeds (the same storyRequested exemption the earlier guards use).
  { name: 'auditor', async run(reply, ctx) {
    const fiction = storyRequested(ctx.rawMessage);
    try {
      const audit = auditReply(reply, { evidence: await auditEvidenceFrom(ctx.storage, { executions: ctx.skillResults.map((r) => r.execution_receipt) }), requestId: ctx.requestId, fiction });
      if (audit.outcome === 'corrected' || audit.outcome === 'blocked') console.log('CHE hallucination auditor', audit.outcome, JSON.stringify(audit.claims).slice(0, 400));
      await recordAudit(ctx.storage, [...ctx.shared.removals, ...audit.entries]);
      ctx.shared.audit = audit;
      return { text: audit.text, removed: [] };
    } catch (error) {
      console.log('CHE hallucination auditor unavailable', error?.message || error);
      const text = claimKindsIn(reply).length ? auditReply(reply, { evidence: null, requestId: ctx.requestId, fiction }).text : reply;
      await recordAudit(ctx.storage, ctx.shared.removals).catch(() => null);
      ctx.shared.audit = { outcome: 'unavailable', claims: [], entries: [] };
      return { text, removed: [] };
    }
  } },
  // A model cannot see its own routing: "the engine was CHE itself" becomes this reply's real engine (soul.js).
  { name: 'engine_claims', run(reply, ctx) {
    return { text: ctx.answer?.served_by ? guardSoulClaims(guardEngineClaims(reply, ctx.answer.served_by).text, ctx.soulProfile).text : reply, removed: [] };
  } },
  // The owner hears which vision engine saw the attachment, or that none did (owner, 2026-10-20).
  { name: 'vision_note', run(reply, ctx) {
    if (!ctx.body.attachment) return { text: reply, removed: [] };
    const m = ctx.multimodal;
    return { text: `${reply} ${m?.summary ? `(Seen with ${m.engine || 'the connected vision engine'}.)` : `(Vision: the attachment was not analyzed${m?.error ? `: ${m.error}` : ''})`}`.trim(), removed: [] };
  } },
]);

export const TRUTH_STAGE_ORDER = Object.freeze(TRUTH_STAGES.map((s) => s.name));

/** The step lines the phone shows before the reply, from this turn's real Office and tool results. */
export function replySteps({ createdPartners = [], officeResults = [], officePeerReview = false, skillResults = [] } = {}) {
  const list = (value) => (Array.isArray(value) ? value : []);
  [createdPartners, officeResults, skillResults] = [list(createdPartners), list(officeResults), list(skillResults)];
  return [
    ...createdPartners.map((item) => ({ type: 'step', text: `Added ${item.name} (${item.role}) to the Office` })),
    ...officeResults.map((item) => ({ type: 'step', agent_id: item.partner_id, agent: item.partner_name, text: item.error ? `${item.partner_name} couldn’t finish` : `✓ ${item.partner_name} delivered (${item.role})` })),
    ...(officePeerReview ? [{ type: 'step', text: '✓ Cross-checked the team’s findings' }] : []),
    ...skillResults.map((item) => ({ type: 'step', text: item.ok ? `✓ Used ${item.plugin} · ${item.tool}` : `${item.plugin} · ${item.tool} failed: ${item.error}` })),
  ];
}

/**
 * Run every stage in order. `stages` defaults to TRUTH_STAGES; tests pass their own.
 * A stage that throws is logged and skipped, so the reply still reaches the auditor (fail closed, never fail open).
 * Returns { text, removals, audit, steps, answerReceipt, attributionRemoved, sourced, earlyResponse }.
 */
export async function verifyReply(reply, ctx, { stages = TRUTH_STAGES } = {}) {
  const requestId = ctx.requestId || crypto.randomUUID();
  const shared = { removals: [], pastedText: false, documentRead: false, sourced: { used: [], removed: [], disproven: [] }, answerReceipt: null, attributionRemoved: 0, audit: null };
  const run = { ...ctx, requestId, shared, storage: ctx.storage || ctx.self?.ctx?.storage, skillResults: ctx.skillResults || [], officeResults: ctx.officeResults || [], actionResults: ctx.actionResults || [], plugins: ctx.plugins || [], workerBrainHits: ctx.workerBrainHits || [], ownerHistory: ctx.ownerHistory || [], body: ctx.body || {}, data: ctx.data || {}, env: ctx.env || {}, helpers: ctx.helpers || {}, keys: ctx.keys || {} };
  let text = String(reply ?? '');
  for (const stage of stages) {
    try {
      const out = await stage.run(text, run);
      if (out?.removed?.length) shared.removals.push(...guardRemovalEntries(stage.name, out.removed, { requestId }));
      if (out?.earlyResponse) return { text, removals: shared.removals, audit: shared.audit, steps: replySteps(run), answerReceipt: shared.answerReceipt, attributionRemoved: shared.attributionRemoved, sourced: shared.sourced, earlyResponse: out.earlyResponse };
      if (typeof out?.text === 'string') text = out.text;
    } catch (error) {
      console.log(`CHE truth stage ${stage.name} failed`, error?.message || error);
    }
  }
  return { text, removals: shared.removals, audit: shared.audit, steps: replySteps(run), answerReceipt: shared.answerReceipt, attributionRemoved: shared.attributionRemoved, sourced: shared.sourced, earlyResponse: null };
}
