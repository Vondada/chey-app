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
  const size = Math.max(1, Math.min(Number(limit) || 500, 5000));
  // A cursor over seq, persisted between nights, so every record is reached in turn; a re-score moves
  // a record to a new seq and it is seen again only after the rest. Exhausted: start over.
  const cursor = Number(store.meta('brain_audit_cursor', 0)) || 0;
  let rows = store.rows('SELECT id, seq FROM brain_records WHERE deleted = 0 AND seq > ? ORDER BY seq ASC LIMIT ?', cursor, size);
  if (rows.length < size && cursor > 0) rows = rows.concat(store.rows('SELECT id, seq FROM brain_records WHERE deleted = 0 AND seq <= ? ORDER BY seq ASC LIMIT ?', cursor, size - rows.length));
  const records = rows.map((row) => store.get(row.id)).filter(Boolean);
  const lastSeq = rows.length ? Math.max(...rows.map((r) => Number(r.seq) || 0)) : 0;
  const wrapped = rows.length && rows.some((r) => Number(r.seq) <= cursor);
  store.setMeta('brain_audit_cursor', wrapped || rows.length < size ? 0 : lastSeq);
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
  const persisted = !since && store.meta('brain_review_since');
  const sinceIso = since || persisted || new Date(nowMs - DAY_MS).toISOString();
  const sinceMs = Date.parse(sinceIso) || (nowMs - DAY_MS);
  const day = dayOf(now);
  const id = `review:brain:${day}`;
  // The Brain's own bookkeeping is never activity: yesterday's computed review, significance audits,
  // the model's nightly review projected from the state blob, and anything the auditor wrote. A
  // review that counted those would write itself again every morning.
  // A persisted boundary is the last review's own instant: records written in that same millisecond were already counted.
  // Fresh records first on the page: an import night (the first production night projects every
  // legacy row at once) must not push the day's few real records off the 2000-record page.
  const activity = store.changedSince(sinceIso, { createdFirst: sinceIso }).filter((r) => !isBookkeeping(r) && r.id !== id && (!persisted || r.updated_at > sinceIso));
  if (!activity.length) {
    // A quiet first night still fixes the boundary (a meta value, not a record): without it the next
    // night's window would start a day before that night and miss what happened in between.
    if (!since && !persisted) store.setMeta('brain_review_since', now);
    return { written: false, reason: 'No Brain activity since the last review.', since: sinceIso };
  }
  const total = Number(store.rows(`SELECT COUNT(*) AS n FROM brain_records WHERE updated_at ${persisted ? '>' : '>='} ? AND deleted = 0 AND kind NOT IN ('daily_review', 'audit') AND origin != 'auditor' AND id NOT LIKE 'review:%' AND id NOT LIKE 'audit:%'`, sinceIso)[0]?.n) || activity.length;
  // Created before the window: an import, backfill or edit of something older, not a new event. A task's
  // first Brain copy (rev 1) of an old task is an import too; a status change since keeps rev > 1 and counts.
  const imported = activity.filter((r) => r.created_at && (Date.parse(r.created_at) || nowMs) < sinceMs && (r.kind !== 'task' || r.rev === 1));
  const fresh = activity.filter((r) => !imported.includes(r));

  const attested = fresh.filter((r) => ['owner_attested', 'verified_source'].includes(r.verification));
  const conversations = count(attested, (r) => r.kind === 'conversation');
  const corrections = count(attested, (r) => r.kind === 'correction');
  const memories = count(attested, (r) => r.kind === 'memory' && r.origin !== 'auditor');
  const lessons = count(fresh, (r) => r.kind === 'lesson');
  const tasks = fresh.filter((r) => r.kind === 'task');
  const tasksDone = count(tasks, (r) => ['done', 'completed', 'succeeded', 'success'].includes(String(r.source?.status || '')));
  const tasksFailed = count(tasks, (r) => ['failed', 'error', 'cancelled', 'canceled'].includes(String(r.source?.status || '')));
  const tasksLive = count(tasks, (r) => ['queued', 'running', 'reviewing'].includes(String(r.source?.status || '')));
  const queued = activity.filter((r) => r.kind === 'queued_request' && ['queued', ''].includes(String(r.source?.status || '')));
  const tasksOther = tasks.length - tasksDone - tasksFailed - tasksLive;
  const hypotheses = activity.filter((r) => ['hypothesis', 'model_opinion'].includes(r.verification) && r.kind !== 'daily_review');
  const fromPhone = count(activity, (r) => r.origin && !['cloud', 'auditor', 'owner'].includes(r.origin));
  const openConflicts = store.conflicts().length;
  const flagged = Array.isArray(audit?.flagged) ? audit.flagged : [];
  const regions = {};
  for (const r of activity) regions[r.region] = (regions[r.region] || 0) + 1;
  const busiest = Object.entries(regions).sort((a, b) => b[1] - a[1])[0];

  const facts = [
    `${total} Brain record${total === 1 ? '' : 's'} changed since ${sinceIso.slice(0, 16).replace('T', ' ')} UTC${total > activity.length ? ` (details below from the newest ${activity.length})` : ''}.`,
    imported.length ? `${imported.length} older record${imported.length === 1 ? '' : 's'} (created before this window) ${imported.length === 1 ? 'was' : 'were'} rewritten or brought in: edits, imports or backfill, not new events.` : '',
    conversations ? `${conversations} conversation${conversations === 1 ? '' : 's'} with the owner kept word for word.` : '',
    corrections ? `${corrections} correction${corrections === 1 ? '' : 's'} from the owner.` : '',
    memories ? `${memories} owner ${memories === 1 ? 'memory' : 'memories'} saved.` : '',
    lessons ? `${lessons} lesson${lessons === 1 ? '' : 's'} recorded.` : '',
    tasks.length ? `${tasks.length} agent task${tasks.length === 1 ? '' : 's'} touched: ${tasksDone} done, ${tasksFailed} failed, ${tasksLive} still live${tasksOther > 0 ? `, ${tasksOther} with another status` : ''}.` : '',
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
  if (openConflicts) recommendations.push(`Settle the ${openConflicts} open conflict${openConflicts === 1 ? '' : 's'} in the Brain screen's Conflicts list; both copies are kept until you choose.`);
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
  if (result.outcome !== 'rejected') store.setMeta('brain_review_since', now);

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
  // A noun that names CHE's own review: "brain review", "morning review", "your audit". A bare "the
  // review", "my review" or "the last review" may be anyone's (a doctor's, an accountant's, Amazon's).
  const BRAIN_NOUN = "(?:(?:brain|morning|daily|nightly|night['’]?s|today['’]?s|todays|yesterday['’]?s|this\\s+morning['’]?s|last\\s+night['’]?s|your)\\s+(?:brain\\s+)?(?:review|audit))";
  // An explicit request to hear it wins over everything below (review of #337): "read me my brain
  // review", "thanks, read me my brain review", "I skipped the brain review, give it to me now", "did
  // your audit find anything wrong", "what did I miss in my morning review", "what did yesterday's
  // audit find". "Read it" counts only after that noun, never in "find the review in my inbox and read it".
  const asks = new RegExp(`\\b${BRAIN_NOUN}\\b`, 'i').test(text) && (
    // The verb starts its clause ("read me", "now read", "can you read"), so "I've read the brain review" is not asking.
    new RegExp(`(?:^|[,.;:!?]\\s*|\\b(?:please|can\\s+you|could\\s+you|would\\s+you|will\\s+you|now|then|and|just|want\\s+to|let\\s+me|like\\s+to)\\s+)(?:read|give|tell|show|hear|play)\\b[\\s\\S]{0,20}\\b${BRAIN_NOUN}\\b`, 'i').test(text)
    || new RegExp(`\\b${BRAIN_NOUN}\\b[\\s\\S]{0,40}\\b(?:read|give|tell|show|play|send)\\s+(?:me\\s+)?(?:it|that)\\b`, 'i').test(text)
    || /\bwhat\s+did\b[\s\S]{0,40}\b(?:audit|review)\b[\s\S]{0,12}\b(?:find|say|conclude|flag)\b/i.test(text)
    || /\bwhat\s+did\s+i\s+miss\s+in\b/i.test(text)
    || /\bdid\s+(?:i\s+miss\s+anything\s+in|(?:your|the)\s+(?:brain\s+)?(?:audit|review)\s+find)\b/i.test(text));
  // "Your review of the contract", "yesterday's review from the doctor": CHE reviewing something else
  // (third review of #337). "Of my brain" is still hers.
  const aboutOther = new RegExp(`\\b${BRAIN_NOUN}\\s+(?:of|from|on|for|about)\\b(?!\\s+(?:my|the|your)\\s+brain\\b)`, 'i').test(text);
  if (asks && !aboutOther) return true;
  // "What did the last audit find?" with nothing after it can only mean CHE's; "... about my business taxes" is not.
  if (/^what\s+did\s+(?:the\s+)?last\s+(?:audit|review)\s+(?:find|say|flag|conclude)\s*\??\s*$/i.test(text)) return true;
  if (/\b(?:review|audit)\s+(?:is|was|seems)\s+wrong\b|\b(?:disagree|don['’]?t\s+agree|do\s+not\s+agree)\b/i.test(text)) return false;
  if (/\b(?:cancel|stop|pause|disable|enable|skip|turn\s+(?:off|on)|switch\s+(?:off|on)|reschedule|schedule|move)\s+(?:my|the|this|tomorrow['’]?s|tonight['’]?s|the\s+next)?\s*(?:brain\s+|daily\s+|nightly\s+|morning\s+)?(?:review|audit)\b/i.test(text)) return false;
  if (/^(?:i|we)(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:read|heard|seen|saw|got|missed|skipped)\b(?![\s\S]*\bread\s+it\b)/i.test(text) && !/\?\s*$/.test(text)) return false;
  // Thanking counts only as the whole sentence or "thanks for ...": "thank you CHE, now the brain review please" asks.
  if (/\b(?:thanks|thank\s+you)\s+(?:so\s+much\s+|very\s+much\s+)?for\b|^(?:thanks|thank\s+you)(?:\s+(?:che|chey|so\s+much|very\s+much))?[\s!.,]*$/i.test(text)) return false;
  if (/\bhow\s+does\b[\s\S]{0,30}\b(?:work|run)\b|\b(?:runs?\s+at|when\s+(?:does|is|will|do)|what\s+time)\b|\b(?:remember\s+(?:that|this)|note\s+that)\b/i.test(text)) return false;
  if (/\bwhat\s+did\s+(?:last\s+night['’]?s|this\s+morning['’]?s|the\s+(?:nightly|morning|daily))\s+(?:audit|review)\s+(?:find|say|conclude|flag)\b/i.test(text)) return true;
  // Only a Brain-qualified noun, "your/the audit found", or a sentence that ends at the noun: "the review
  // John left", "my daily review at 9" and "what did you find about the brain tumor study" are something else.
  // The sentence ends at the noun (a tail like "John left", "at 9", "from the accountant" makes it something else).
  const END = "(?:\\s+(?:please|today|now|for\\s+me|this\\s+morning))*[.!?]?\\s*$";
  const DET = "(?:my|the|today['’]?s|todays|this\\s+morning['’]?s)";
  if (/\bbrain[\s-]+(?:review|audit|conclusions?)\b/i.test(text)) return true;
  if (new RegExp(`^(?:(?:brain|daily|morning|significance)\\s+)?(?:review|audit|conclusions)${END}`, 'i').test(text)) return true;
  if (new RegExp(`\\b(?:read|give|tell|show|hear)\\s+(?:me\\s+)?${DET}\\s+(?:review|audit)${END}`, 'i').test(text)) return true;
  if (new RegExp(`\\b(?:daily|morning|nightly|night['’]?s|today['’]?s|todays|this\\s+morning['’]?s)\\s+(?:review|audit)${END}`, 'i').test(text)) return true;
  if (/\byour\s+(?:audit|auditor|review)\s+(?:find|found|say|said|conclude[ds]?|flag(?:ged)?)\b/i.test(text)) return true;
  // "the audit found a tax error, remember that" is the owner telling CHE about someone's audit; only a
  // question about "the audit/review" is a request to hear hers.
  if (/\bthe\s+(?:audit|auditor|review)\s+(?:find|found|say|said|conclude[ds]?|flag(?:ged)?)\b/i.test(text) && (/^(?:what|did|has|any(?:thing)?|which|so)\b/i.test(text) || /\?\s*$/.test(text))) return true;
  if (new RegExp(`\\b(?:review|audit)\\s+(?:of\\s+)?my\\s+brain${END}`, 'i').test(text)) return true;
  if (new RegExp(`\\b(?:conclusions|what\\s+happened(?:\\s+\\w+)?)\\s+(?:from|in)\\s+(?:my|the|your)\\s+brain${END}`, 'i').test(text)) return true;
  if (new RegExp(`\\bwhat\\s+did\\s+you\\s+(?:conclude|learn|find)\\s+(?:last\\s+night|overnight|this\\s+morning)${END}`, 'i').test(text)) return true;
  if (new RegExp(`\\bwhich\\s+records\\s+need\\s+verification\\b|\\bis\\s+there\\s+a\\s+review\\s+today${END}`, 'i').test(text)) return true;
  return false;
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
  const inferences = section('INFERENCE').filter((l) => l !== 'None drawn.');
  const hypotheses = section('HYPOTHESIS').filter((l) => l !== 'None recorded.');
  const recommendations = section('RECOMMENDATION').filter((l) => l !== 'Nothing to do from the Brain’s side.');
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
