// Chat turns for capabilities CHE already had but no chat route reached. Each returns [reply, meta] for ndjsonReply,
// with an execution receipt in meta, or null when the turn is not one of them. The logic lives here, not in worker.js.
//
// Office: a desk named by its role ("ask the writing agent to ..."), the queue read back, or a desk's queue moved to
// another desk. Each is done in durable state first; the receipt carries the task ids it touched. `che` is the
// CheState Durable Object (staffOffice, queueOfficeStep, scheduleWork, broadcastAgents, ctx.storage).

import { reassignAgentQueue, TASK_OPEN } from './agent_runtime.js';
import { speakOfficeQueue } from './office_phrases.js';
import { repoSearchIntent, repoSearchTurn } from './repo_search.js';
import { executeWithReceipt, recordReceipt } from './truth_layer.js';

export const OFFICE_ROLE_ROUTES = new Set(['delegateAgent', 'officeQueue', 'reassignQueue']);

function readQueue(data) {
  const open = (data.team_tasks || []).filter((t) => TASK_OPEN.has(t.status));
  return { reply: speakOfficeQueue(data.team_tasks, TASK_OPEN), record: { ok: true, open: open.length, task_ids: open.map((t) => t.id) } };
}

async function reassign(che, data, phrase) {
  const { from, to, moved, kept } = reassignAgentQueue(data, phrase.from, phrase.to);
  if (moved.length) await che.ctx.storage.put('che', data);
  const list = moved.slice(0, 8).map((t) => `"${String(t.task || '').slice(0, 70)}" (task ${t.id.slice(0, 8)})`).join(', ');
  const keptNote = kept.length ? ` ${kept.length === 1 ? 'One task' : `${kept.length} tasks`} already started or in review stayed with ${from.name}.` : '';
  const reply = !from || !to
    ? `CHE here. ${phrase.from} or ${phrase.to} is not on the Office roster, so nothing was reassigned.`
    : moved.length
      ? `CHE here. I reassigned ${from.name}'s queue to ${to.name}: ${moved.length === 1 ? 'one task' : `${moved.length} tasks`} moved, ${list}.${keptNote}`
      : `CHE here. ${from.name} has no queued task, so nothing was reassigned to ${to.name}.${keptNote}`;
  return { reply, record: { ok: Boolean(from && to), moved: moved.map((t) => t.id), kept: kept.map((t) => t.id), from: from?.name || '', to: to?.name || '' } };
}

async function delegate(che, data, phrase) {
  const agent = (data.team || []).find((a) => a.name === phrase.agent && !a.retired);
  if (!agent) return { reply: `CHE here. ${phrase.agent} is not on the Office roster right now, so nothing was started.`, record: { ok: false } };
  const text = phrase.task.charAt(0).toUpperCase() + phrase.task.slice(1);
  const task = che.queueOfficeStep(data, agent, text, 'owner_goal');
  await che.ctx.storage.put('che', data);
  const reply = task.status === 'blocked'
    ? `CHE here. ${agent.name} (${agent.role}) could not start "${text}": ${task.error}. Nothing was done.`
    : `CHE here. I gave the ${phrase.role} task to ${agent.name} (${agent.role}): "${text}". Office task ${task.id.slice(0, 8)} is queued. Nothing is finished yet; I review ${agent.name}'s result before it reaches you.`;
  return { reply, record: { ok: task.status === 'queued', task_id: task.id, agent: agent.name, status: task.status } };
}

/** One Office role turn, or null when the phrase is not one. */
export async function officeRoleTurn(che, data, phrase) {
  if (!OFFICE_ROLE_ROUTES.has(phrase?.type)) return null;
  await che.staffOffice(data);
  const request_id = crypto.randomUUID();
  let reply = '';
  const { result, receipt } = await executeWithReceipt({
    tool: 'office', operation: phrase.type, source: 'durable_object:che.team_tasks', request_id,
    run: async () => {
      const done = phrase.type === 'officeQueue' ? readQueue(data)
        : phrase.type === 'reassignQueue' ? await reassign(che, data, phrase) : await delegate(che, data, phrase);
      reply = done.reply;
      return done.record;
    },
    response: ({ ok: _ok, ...record }) => record,
  });
  await recordReceipt(che.ctx.storage, { ...receipt, key: `execution:${receipt.invocation_id}` });
  if (phrase.type !== 'officeQueue' && receipt.status === 'success') {
    if (phrase.type === 'delegateAgent') await che.scheduleWork();
    che.broadcastAgents(data);
  }
  return [
    reply || `CHE here. That Office step could not be completed: ${receipt.error} Nothing changed.`,
    { source: 'office', office: phrase.type, model_calls: 0, ok: receipt.status === 'success', execution_receipts: [receipt], request_id, ...(result?.task_id ? { task_id: result.task_id } : {}) },
  ];
}

/** "Search the repo for X": a read-only repository search (repo_search.js), owner only, or null for other messages. */
export async function repoSearchChat(env, storage, message, ownerDevice) {
  const intent = repoSearchIntent(message);
  if (!intent) return null;
  if (!ownerDevice) return ['Only the CHE owner can search CHE\'s code, sir. No search was run.', { source: 'che_repo_search', ok: false, model_calls: 0 }];
  const turn = await repoSearchTurn(env, storage, intent.needle);
  return [turn.reply, turn.meta];
}
