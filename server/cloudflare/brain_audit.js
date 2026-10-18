// CHE's relevance auditor and next-morning review, over the Brain store.
//
// Both are deterministic bookkeeping over records that exist. No model is
// asked, so nothing here can invent an event, and every score and every line
// of the review carries the reason it is there. When nothing happened, nothing
// is written: a review that exists only to look busy is itself fake activity.
//
// Labels in the review follow the owner's rule: FACT (owner-attested or
// source-backed records and real counts), INFERENCE (a rule applied to those
// facts, named), HYPOTHESIS (records labeled hypothesis or model_opinion),
// RECOMMENDATION (what the counts suggest doing), INTERPRETATION (one plain
// reading, marked as such), UNKNOWN (what the Brain cannot tell).

import { BRAIN_REGIONS, assessSignificance } from './brain_store.js';

const DAY_MS = 24 * 3600_000;
const VERIFY_AFTER_DAYS = 14;

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function dayOf(iso) {
  return String(iso || '').slice(0, 10);
}

/**
 * Re-scores up to [limit] live records with the current rules and keeps every change
 * explained. Records the owner scored are read, never changed. Records that are
 * significant but unverified for VERIFY_AFTER_DAYS days are flagged, not altered.
 */
export function auditSignificance(store, { limit = 500, now = new Date().toISOString() } = {}) {
  if (!store.init()) return { available: false, examined: 0, changed: 0, flagged: [], top: [] };
  const nowMs = Date.parse(now) || Date.now();
  const records = store.rows('SELECT id FROM brain_records WHERE deleted = 0 ORDER BY seq DESC LIMIT ?', Math.max(1, Math.min(Number(limit) || 500, 5000)))
    .map((row) => store.get(row.id)).filter(Boolean);
  let changed = 0;
  const scored = [];
  const flagged = [];
  for (const record of records) {
    const next = assessSignificance(record);
    const current = record.significance || {};
    if (next.auditor !== 'owner' && (current.score !== next.score || JSON.stringify(current.reasons || []) !== JSON.stringify(next.reasons))) {
      const result = store.reassess(record.id, next, { origin: 'auditor', now });
      if (result.outcome === 'reassessed') changed += 1;
    }
    scored.push({ id: record.id, title: record.title, region: record.region, score: next.score, reasons: next.reasons, auditor: next.auditor });
    const ageDays = (nowMs - (Date.parse(record.created_at) || nowMs)) / DAY_MS;
    if (next.score >= 0.5 && ['unknown', 'unverified_reference', 'unverified_research_lead', 'hypothesis', 'model_opinion'].includes(record.verification) && ageDays >= VERIFY_AFTER_DAYS) {
      flagged.push({ id: record.id, title: record.title, verification: record.verification, age_days: Math.floor(ageDays), reason: `significant (${next.score}) but ${record.verification.replace(/_/g, ' ')} for ${Math.floor(ageDays)} days` });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return { available: true, at: now, examined: records.length, changed, top: scored.slice(0, 10), flagged: flagged.slice(0, 50) };
}

/** The owner corrects a score: his number wins from now on, with his words as the reason. */
export function ownerScore(store, id, score, { reason = '', now } = {}) {
  const record = store.get(id);
  if (!record || record.deleted) return { outcome: 'missing', id };
  const value = Math.max(0, Math.min(1, Number(score)));
  if (!Number.isFinite(value)) return { outcome: 'rejected', reason: 'A score is a number from 0 to 1.' };
  const significance = { ...assessSignificance({ ...record, significance: { owner_score: value } }), owner_reason: clip(reason, 200) };
  return store.reassess(id, significance, { origin: 'owner', now });
}

function count(records, test) {
  return records.filter(test).length;
}

/** Records the Brain writes about itself: reviews (computed or the model's nightly one), audits, auditor output. */
export function isBookkeeping(record) {
  if (!record) return false;
  const id = String(record.id || '');
  return record.kind === 'daily_review' || record.kind === 'audit' || record.origin === 'auditor'
    || id.startsWith('review:') || id.startsWith('audit:') || record.source?.kind === 'nightly_review';
}

/**
 * The next-morning review of one day, from the Brain's records only. Returns
 * { written: false, reason } when the day had no activity, so nothing is produced
 * for show. Otherwise writes one record in Daily Audits and Conclusions and returns it
 * with a spoken form.
 */
export function buildDailyReview(store, { now = new Date().toISOString(), since, audit } = {}) {
  if (!store.init()) return { written: false, reason: 'Brain storage is not available.' };
  const nowMs = Date.parse(now) || Date.now();
  const sinceIso = since || new Date(nowMs - DAY_MS).toISOString();
  const day = dayOf(now);
  const id = `review:brain:${day}`;
  // The Brain's own bookkeeping is never activity: yesterday's computed review, significance audits,
  // the model's nightly review projected from the state blob, and anything the auditor wrote. A
  // review that counted those would write itself again every morning.
  const activity = store.changedSince(sinceIso).filter((r) => !isBookkeeping(r) && r.id !== id);
  if (!activity.length) return { written: false, reason: 'No Brain activity since the last review.', since: sinceIso };

  const attested = activity.filter((r) => ['owner_attested', 'verified_source'].includes(r.verification));
  const conversations = count(attested, (r) => r.kind === 'conversation');
  const corrections = count(attested, (r) => r.kind === 'correction');
  const memories = count(attested, (r) => r.kind === 'memory' && r.origin !== 'auditor');
  const lessons = count(activity, (r) => r.kind === 'lesson');
  const tasks = activity.filter((r) => r.kind === 'task');
  const tasksDone = count(tasks, (r) => ['done', 'completed', 'succeeded', 'success'].includes(String(r.source?.status || '')));
  const tasksFailed = count(tasks, (r) => ['failed', 'error', 'cancelled', 'canceled'].includes(String(r.source?.status || '')));
  const tasksLive = count(tasks, (r) => ['queued', 'running', 'reviewing'].includes(String(r.source?.status || '')));
  const queued = activity.filter((r) => r.kind === 'queued_request');
  const hypotheses = activity.filter((r) => ['hypothesis', 'model_opinion'].includes(r.verification) && r.kind !== 'daily_review');
  const fromPhone = count(activity, (r) => r.origin && !['cloud', 'auditor', 'owner'].includes(r.origin));
  const openConflicts = store.conflicts().length;
  const flagged = Array.isArray(audit?.flagged) ? audit.flagged : [];
  const regions = {};
  for (const r of activity) regions[r.region] = (regions[r.region] || 0) + 1;
  const busiest = Object.entries(regions).sort((a, b) => b[1] - a[1])[0];

  const facts = [
    `${activity.length} Brain record${activity.length === 1 ? '' : 's'} changed since ${sinceIso.slice(0, 16).replace('T', ' ')} UTC.`,
    conversations ? `${conversations} conversation${conversations === 1 ? '' : 's'} with the owner kept word for word.` : '',
    corrections ? `${corrections} correction${corrections === 1 ? '' : 's'} from the owner.` : '',
    memories ? `${memories} owner ${memories === 1 ? 'memory' : 'memories'} saved.` : '',
    lessons ? `${lessons} lesson${lessons === 1 ? '' : 's'} recorded.` : '',
    tasks.length ? `${tasks.length} agent task${tasks.length === 1 ? '' : 's'} touched: ${tasksDone} done, ${tasksFailed} failed, ${tasksLive} still live.` : '',
    fromPhone ? `${fromPhone} record${fromPhone === 1 ? '' : 's'} came from the phone.` : '',
    busiest ? `Busiest region: ${busiest[0]} (${busiest[1]}).` : '',
    openConflicts ? `${openConflicts} sync conflict${openConflicts === 1 ? '' : 's'} open.` : 'No sync conflicts open.',
  ].filter(Boolean);

  const inferences = [];
  if (tasks.length >= 3 && tasksFailed > tasksDone) inferences.push(`Most agent work failed today (${tasksFailed} of ${tasks.length}); rule: failed > done.`);
  if (corrections >= 2) inferences.push(`The owner corrected CHE ${corrections} times; rule: two or more corrections in a day means a recurring misunderstanding to look for.`);
  if (conversations >= 10) inferences.push(`A busy day of conversation (${conversations} exchanges); rule: ten or more.`);
  if (openConflicts && fromPhone) inferences.push(`The phone and the cloud edited the same records; rule: conflicts open while phone records arrived.`);

  const hypothesisLines = hypotheses.slice(0, 5).map((r) => `${clip(r.title, 90)} (${r.verification.replace(/_/g, ' ')}, not a fact).`);

  const recommendations = [];
  if (openConflicts) recommendations.push(`Settle the ${openConflicts} open conflict${openConflicts === 1 ? '' : 's'}: say "brain conflicts" to hear both copies.`);
  if (flagged.length) recommendations.push(`${flagged.length} significant record${flagged.length === 1 ? '' : 's'} ${flagged.length === 1 ? 'has' : 'have'} been unverified for over ${VERIFY_AFTER_DAYS} days; the first: ${clip(flagged[0].title, 80)}.`);
  if (queued.length) recommendations.push(`${queued.length} request${queued.length === 1 ? '' : 's'} queued offline ${queued.length === 1 ? 'has' : 'have'} not run; nothing was sent or spent.`);
  if (tasksFailed) recommendations.push(`Read the ${tasksFailed} failed task${tasksFailed === 1 ? '' : 's'} before giving the agents more of the same.`);

  const interpretation = tasksFailed > tasksDone && tasks.length
    ? 'A day where the agents struggled more than they delivered.'
    : corrections >= 2
      ? 'A day of being put right by the owner.'
      : conversations
        ? 'An ordinary day of talking and remembering.'
        : 'A quiet day in the Brain.';

  const unknown = [
    fromPhone ? '' : 'Whether the phone synced today: no record arrived from it.',
    tasks.length ? '' : 'What the Office agents did: no task record changed.',
    'Anything that happened outside the Brain: GitHub runs, trades and messages are only known where a record was written.',
  ].filter(Boolean);

  const body = [
    `Daily review for ${day} (computed from Brain records, no model).`,
    '', 'FACT', ...facts.map((l) => `- ${l}`),
    '', 'INFERENCE', ...(inferences.length ? inferences.map((l) => `- ${l}`) : ['- None drawn.']),
    '', 'HYPOTHESIS', ...(hypothesisLines.length ? hypothesisLines.map((l) => `- ${l}`) : ['- None recorded.']),
    '', 'RECOMMENDATION', ...(recommendations.length ? recommendations.map((l) => `- ${l}`) : ['- Nothing to do from the Brain’s side.']),
    '', 'INTERPRETATION', `- ${interpretation} (an interpretation, not a fact)`,
    '', 'UNKNOWN', ...unknown.map((l) => `- ${l}`),
  ].join('\n');

  const links = [
    ...activity.filter((r) => r.kind === 'correction').slice(0, 10).map((r) => ({ type: 'discovered_by_audit', to: r.id })),
    ...flagged.slice(0, 10).map((f) => ({ type: 'requires_verification', to: f.id })),
  ];
  const result = store.put({
    id,
    kind: 'daily_review',
    region: BRAIN_REGIONS.audits,
    path: 'Daily reviews',
    title: `Daily review ${day}`,
    body,
    source: { kind: 'brain_daily_review', computed: true, since: sinceIso, records: activity.length, counts: { conversations, corrections, memories, lessons, tasks: tasks.length, tasks_done: tasksDone, tasks_failed: tasksFailed, queued: queued.length, open_conflicts: openConflicts, flagged: flagged.length } },
    verification: 'verified_source',
    links,
    created_at: now,
  }, { origin: 'auditor', now });

  const speech = [
    `Good morning, sir. Your Brain review for ${day}.`,
    `Facts: ${facts.slice(0, 4).join(' ')}`,
    inferences.length ? `Inference: ${inferences[0]}` : '',
    recommendations.length ? `Recommendation: ${recommendations[0]}` : '',
    `My reading, which is only a reading: ${interpretation}`,
    unknown.length ? `Unknown: ${unknown[0]}` : '',
  ].filter(Boolean).join(' ');

  return { written: result.outcome !== 'rejected', outcome: result.outcome, record: result.record, speech, counts: { conversations, corrections, memories, lessons, tasks: tasks.length, tasks_done: tasksDone, tasks_failed: tasksFailed, queued: queued.length, open_conflicts: openConflicts, flagged: flagged.length } };
}

/** The audit's own receipt as a Brain record, so the owner can see what the auditor did and why. */
export function recordAudit(store, audit, { now = new Date().toISOString() } = {}) {
  if (!audit?.available || !store.init()) return { written: false };
  const day = dayOf(now);
  const body = [
    `Significance audit ${day}: ${audit.examined} records examined, ${audit.changed} re-scored, ${audit.flagged.length} flagged for verification.`,
    '', 'Highest significance:',
    ...audit.top.slice(0, 5).map((t) => `- ${t.score} ${clip(t.title, 80)} — ${t.reasons.join('; ')}`),
    ...(audit.flagged.length ? ['', 'Needs verification:', ...audit.flagged.slice(0, 5).map((f) => `- ${clip(f.title, 80)} — ${f.reason}`)] : []),
  ].join('\n');
  const result = store.put({
    id: `audit:${day}`,
    kind: 'audit',
    region: BRAIN_REGIONS.audits,
    path: 'Significance audits',
    title: `Significance audit ${day}`,
    body,
    source: { kind: 'brain_audit', computed: true, examined: audit.examined, changed: audit.changed, flagged: audit.flagged.length },
    verification: 'verified_source',
    links: audit.flagged.slice(0, 10).map((f) => ({ type: 'requires_verification', to: f.id })),
    created_at: now,
  }, { origin: 'auditor', now });
  return { written: result.outcome !== 'rejected', outcome: result.outcome, record: result.record };
}

/** The nightly pass: audit, then review. Nothing is written for a day without activity. */
export function runBrainMaintenance(store, { now = new Date().toISOString(), since } = {}) {
  const audit = auditSignificance(store, { now });
  const review = buildDailyReview(store, { now, since, audit });
  const auditRecord = review.written ? recordAudit(store, audit, { now }) : { written: false, reason: 'no activity' };
  return { audit: { examined: audit.examined, changed: audit.changed, flagged: audit.flagged.length, written: auditRecord.written }, review };
}

/** "Read me my brain review", "morning review", "what did your audit find": the owner asks for the review. */
export function brainReviewIntent(message) {
  const text = String(message || '').trim().replace(/^(?:hey|hi|ok|okay)?[,\s]*(?:che|chay|chey|shay)\b[,:]?\s*/i, '');
  if (!text || text.length > 160) return false;
  // Work on the review, or a review of something else (code, a plan, a website), is not a request to hear it.
  if (/\b(?:build|fix|change|implement|delete|remove|clear|run\s+the\s+review\s+again|regenerate|rebuild|redo|rewrite|code|repo|pull\s+request|pr|website|plan|spending|log|logs|trail)\b/i.test(text)) return false;
  // What the owner himself said or asked is an owner-memory question, answered from his own words, never with the review.
  if (/\b(?:what\s+(?:have|did)\s+i\s+(?:told|tell|say|said|ask|asked|mention)|did\s+i\s+(?:ask|say|tell|mention)|have\s+i\s+(?:asked|said|told|mentioned))\b/i.test(text)) return false;
  const notAbout = "(?!\\s+(?:of|about|for|on)\\b)";
  const brainWord = /\b(?:brain|significance|auditor)\b/i.test(text);
  if (brainWord && /\b(?:review|audit|conclusions?|flag(?:ged)?|verification|learn(?:ed|t)?|happened|find|found)\b/i.test(text)) return true;
  if (new RegExp(`\\b(?:daily|morning|nightly|night['’]?s|today['’]?s|todays|this\\s+morning['’]?s)\\s+(?:brain\\s+)?(?:review|audit)\\b${notAbout}`, 'i').test(text)) return true;
  if (new RegExp(`\\b(?:read|give|tell|show)\\s+(?:me\\s+)?(?:my|the|today['’]?s|todays|this\\s+morning['’]?s)\\s+(?:brain\\s+)?(?:review|audit)\\b${notAbout}`, 'i').test(text)) return true;
  if (/\b(?:what\s+)?did\s+(?:your|the)\s+(?:brain\s+)?(?:audit|review|auditor)\s+(?:find|say|conclude|flag)\b/i.test(text)) return true;
  if (new RegExp(`\\bwhat(?:['’]s|\\s+is)\\s+(?:in\\s+)?(?:my|the|today['’]?s|todays)\\s+(?:brain\\s+)?review\\b${notAbout}`, 'i').test(text)) return true;
  if (/\bwhat\s+did\s+you\s+(?:conclude|learn|find)\s+(?:last\s+night|overnight|this\s+morning)\b/i.test(text)) return true;
  if (/\bwhich\s+records\s+need\s+verification\b|\bis\s+there\s+a\s+(?:brain\s+)?review\s+today\b/i.test(text)) return true;
  return /^(?:(?:brain|daily|morning)\s+)?review(?:\s+please)?[.!?]?$/i.test(text);
}

/** The spoken review for the owner, every line from the stored record; honest when there is none. */
export function speakReview(latest) {
  const review = latest?.review;
  if (!review) return 'There is no Brain review yet, sir. One is written each morning from the day’s records, and only when something happened.';
  const section = (name) => {
    const match = new RegExp(`^${name}\\n((?:- .*\\n?)+)`, 'm').exec(`${review.body}\n`);
    return match ? match[1].split('\n').filter(Boolean).map((l) => l.replace(/^- /, '')) : [];
  };
  const facts = section('FACT');
  const inferences = section('INFERENCE').filter((l) => !/^None/.test(l));
  const hypotheses = section('HYPOTHESIS').filter((l) => !/^None/.test(l));
  const recommendations = section('RECOMMENDATION').filter((l) => !/^Nothing/.test(l));
  const interpretation = section('INTERPRETATION');
  const unknown = section('UNKNOWN');
  const day = String(review.title || '').replace(/^Daily review\s*/, '') || review.created_at?.slice(0, 10) || '';
  return [
    `Your Brain review for ${day}, sir, from the records alone.`,
    facts.length ? `Facts: ${facts.join(' ')}` : '',
    inferences.length ? `Inferences, each from a stated rule: ${inferences.join(' ')}` : 'No inferences were drawn.',
    hypotheses.length ? `Hypotheses, not facts: ${hypotheses.join(' ')}` : '',
    recommendations.length ? `Recommendations: ${recommendations.join(' ')}` : 'Nothing to do from the Brain’s side.',
    interpretation.length ? `My reading, which is only a reading: ${interpretation.join(' ')}` : '',
    unknown.length ? `Unknown: ${unknown.join(' ')}` : '',
    latest.audit?.source?.flagged ? `The significance audit flagged ${latest.audit.source.flagged} record${latest.audit.source.flagged === 1 ? '' : 's'} for verification.` : '',
  ].filter(Boolean).join(' ');
}

/** The latest daily review and audit for the morning. */
export function latestReview(store) {
  if (!store.init()) return { review: null, audit: null };
  // Only the computed records: the model's nightly review (review:<time>, model_opinion) is a different
  // thing and is never read out as "the Brain review".
  const pick = (kind, prefix) => {
    const row = store.rows("SELECT id FROM brain_records WHERE kind = ? AND id LIKE ? AND deleted = 0 ORDER BY seq DESC LIMIT 1", kind, `${prefix}%`)[0];
    return row ? store.get(row.id) : null;
  };
  return { review: pick('daily_review', 'review:brain:'), audit: pick('audit', 'audit:') };
}
