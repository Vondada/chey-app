// CHE's rooms as workflows: Gmail, Calendar, Drive, YouTube, the Trading Room, and so on. Each room lists its
// actions with a risk class, and each workflow is an ordered list of actions. Every action passes the gate
// below before it runs, and a workflow reports only what each step actually returned.
//
// Risk classes (owner rules, AGENTS.md):
//   read          runs now
//   send          runs now (standing permission to send messages and emails); reported after
//   create        runs now (adds something, such as a calendar event or a file); reported after
//   delete        held until the owner says yes
//   spend         held until the owner says yes (money)
//   paper_trade   held until the owner says yes (paper trading only)
//   publish       held until the owner says yes (public posts and videos)
//   live_trade    never runs: live trading is not allowed
export const ROOM_RISK_KINDS = Object.freeze(['read', 'send', 'create', 'delete', 'spend', 'paper_trade', 'publish', 'live_trade']);

export const ROOMS = Object.freeze({
  gmail: { id: 'gmail', app: 'Gmail', name: 'Gmail', actions: {
    list_unread: { kind: 'read', does: 'Lists unread emails, newest first.' },
    read_message: { kind: 'read', does: 'Reads one email in full.' },
    send_email: { kind: 'send', does: 'Sends an email.' },
    reply: { kind: 'send', does: 'Replies to an email.' },
    trash: { kind: 'delete', does: 'Moves an email to the trash.' },
  } },
  calendar: { id: 'calendar', app: 'Google Calendar', name: 'Calendar', actions: {
    list_events: { kind: 'read', does: 'Lists upcoming events.' },
    create_event: { kind: 'create', does: 'Creates an event.' },
    delete_event: { kind: 'delete', does: 'Deletes an event.' },
  } },
  drive: { id: 'drive', app: 'Google Drive', name: 'Drive', actions: {
    list_files: { kind: 'read', does: 'Lists files.' },
    read_file: { kind: 'read', does: 'Reads a file.' },
    create_file: { kind: 'create', does: 'Creates a file.' },
    delete_file: { kind: 'delete', does: 'Deletes a file.' },
  } },
  youtube: { id: 'youtube', app: 'YouTube', name: 'YouTube', actions: {
    list_channel_videos: { kind: 'read', does: 'Lists the channel\'s videos.' },
    publish_video: { kind: 'publish', does: 'Publishes a video.' },
  } },
  trading: { id: 'trading', app: 'Trading Room', name: 'Trading Room', actions: {
    show_positions: { kind: 'read', does: 'Shows open paper positions.' },
    show_journal: { kind: 'read', does: 'Shows the paper trade journal.' },
    place_paper_order: { kind: 'paper_trade', does: 'Places a paper order.' },
    place_live_order: { kind: 'live_trade', does: 'Places a live order. Not allowed.' },
  } },
});

// Each workflow runs in order. A step that needs the owner stops the workflow; nothing after it runs.
export const WORKFLOWS = Object.freeze({
  gmail_newest_unread: { room: 'gmail', name: 'Newest unread email', steps: [
    { action: 'list_unread', input: { limit: 5 } },
    { action: 'read_message', input: { which: 'newest' } },
  ] },
  calendar_next: { room: 'calendar', name: 'Next events', steps: [
    { action: 'list_events', input: { limit: 5 } },
  ] },
  drive_find_and_read: { room: 'drive', name: 'Find and read a file', steps: [
    { action: 'list_files', input: {} },
    { action: 'read_file', input: { which: 'best_match' } },
  ] },
  trading_status: { room: 'trading', name: 'Paper trading status', steps: [
    { action: 'show_positions', input: {} },
    { action: 'show_journal', input: {} },
  ] },
});

export function roomAction(roomId, actionId) {
  const room = ROOMS[roomId];
  if (!room) return null;
  const action = room.actions[actionId];
  return action ? { room, action, id: actionId } : null;
}

/**
 * The gate for one room action. Returns { held: false, kind } when it may run now, or { held: true, kind, reason }
 * when it waits for the owner. Throws a 403 for an unknown room or action, an app without a grant, or live trading.
 */
export function assertRoomActionMayRun(roomId, actionId, { grants = [], ownerConfirmed = false } = {}) {
  const found = roomAction(roomId, actionId);
  if (!found) {
    throw Object.assign(new Error(`CHE has no "${actionId}" action in the ${roomId || 'unknown'} room.`), { status: 403 });
  }
  const { room, action } = found;
  if (action.kind === 'live_trade') {
    throw Object.assign(new Error('Live trading is not allowed. CHE trades on paper only.'), { status: 403 });
  }
  if (!grants.includes(room.app)) {
    throw Object.assign(new Error(`CHE has no permission to act in ${room.app} yet. Grant it first.`), { status: 403 });
  }
  if (['delete', 'spend', 'paper_trade', 'publish'].includes(action.kind) && !ownerConfirmed) {
    const reason = {
      delete: 'Deleting or removing needs your yes first.',
      spend: 'Spending money needs your yes first.',
      paper_trade: 'Placing a paper order needs your yes first.',
      publish: 'Publishing needs your yes first.',
    }[action.kind];
    return { held: true, kind: action.kind, reason };
  }
  return { held: false, kind: action.kind };
}

/**
 * Runs a workflow. executor(roomId, actionId, input) -> { ok, summary, data?, error? } calls the room's real
 * connector. Returns { status, receipts, reason? }, with status completed | held | refused | failed.
 */
export async function runRoomWorkflow(workflowId, { executor, grants = [], ownerConfirmed = false, workflows = WORKFLOWS } = {}) {
  const workflow = workflows[workflowId];
  if (!workflow) return { status: 'refused', receipts: [], reason: `CHE has no "${workflowId}" workflow.` };
  const receipts = [];
  for (const step of workflow.steps) {
    let gate;
    try {
      gate = assertRoomActionMayRun(workflow.room, step.action, { grants, ownerConfirmed });
    } catch (error) {
      return { status: 'refused', receipts, reason: error.message };
    }
    if (gate.held) return { status: 'held', receipts, reason: gate.reason, kind: gate.kind };
    let outcome;
    try {
      outcome = await executor(workflow.room, step.action, step.input || {});
    } catch (error) {
      outcome = { ok: false, error: error?.message || String(error) };
    }
    receipts.push({ room: workflow.room, action: step.action, kind: gate.kind, ok: Boolean(outcome?.ok), summary: String(outcome?.summary || ''), data: outcome?.data ?? null, error: outcome?.error || null });
    if (!outcome?.ok) return { status: 'failed', receipts, reason: `The ${step.action} step failed: ${outcome?.error || 'no result'}.` };
  }
  return { status: 'completed', receipts };
}
