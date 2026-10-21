// Wires each room action in agent_rooms.js to the existing handler that does the real work. The handlers are
// passed in (defaults are the real functions), so the wiring is tested without the owner's accounts. An action
// with no handler yet fails honestly ("not connected yet"); it never reports a result it did not get.
import { gmailList, gmailRead, gmailSend, driveList, driveCreateDoc, calendarList, calendarCreate } from './google_services.js';
import { youtubeUploads } from './youtube_connection.js';
import { readLedgers } from './trading_ledgers.js';

const DAY = 24 * 60 * 60 * 1000;

export function realHandlers() {
  return {
    gmailList, gmailRead, gmailSend, driveList, driveCreateDoc, calendarList, calendarCreate, youtubeUploads, readLedgers,
  };
}

/**
 * The executor for runRoomWorkflow: executor(roomId, actionId, input) -> { ok, summary, data?, error? }.
 * ctx: { env, data (the Worker's state, for connected accounts), storage (trading ledgers), fetcher, now, handlers }.
 */
export function roomExecutor(ctx = {}) {
  const h = { ...realHandlers(), ...(ctx.handlers || {}) };
  const now = ctx.now ?? Date.now();
  const fetcher = ctx.fetcher || fetch;

  const actions = {
    gmail: {
      async list_unread(input) {
        const r = await h.gmailList(ctx.env, ctx.data, { query: 'is:unread', max: input.limit || 5 }, fetcher);
        if (!r.ok) return r;
        const n = r.messages.length;
        const first = r.messages[0];
        return { ok: true, data: r.messages, summary: n ? `${r.approximate ? 'About ' : ''}${r.total} unread. Newest: "${first.subject}" from ${first.from}.` : 'No unread email.' };
      },
      async read_message(input) {
        const list = await h.gmailList(ctx.env, ctx.data, { query: 'is:unread', max: 1 }, fetcher);
        if (!list.ok) return list;
        const target = list.messages[0]; // the newest unread message
        if (!target) return { ok: true, summary: 'No unread email to read.' };
        const r = await h.gmailRead(ctx.env, ctx.data, { id: target.id }, fetcher);
        if (!r.ok) return r;
        return { ok: true, data: { id: target.id }, summary: `"${r.subject}" from ${r.from}: ${r.body}` };
      },
      async send_email(input) {
        const r = await h.gmailSend(ctx.env, ctx.data, { to: input.to, subject: input.subject, body: input.body }, fetcher);
        return r.ok ? { ok: true, summary: `Sent to ${input.to}: "${input.subject}".` } : r;
      },
    },
    calendar: {
      async list_events(input) {
        const r = await h.calendarList(ctx.env, ctx.data, { timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * DAY).toISOString(), max: input.limit || 5 }, fetcher);
        if (!r.ok) return r;
        return { ok: true, data: r.events, summary: r.events.length ? `${r.events.length} upcoming: ${r.events.map((e) => e.summary).join('; ')}.` : 'Nothing on the calendar for the next 7 days.' };
      },
      async create_event(input) {
        const r = await h.calendarCreate(ctx.env, ctx.data, { summary: input.summary, date: input.date, time: input.time, durationMinutes: input.durationMinutes, timeZone: input.timeZone }, fetcher);
        return r.ok ? { ok: true, summary: `Created "${input.summary}" on ${input.date} at ${input.time}.` } : r;
      },
    },
    drive: {
      async list_files(input) {
        const r = await h.driveList(ctx.env, ctx.data, { max: input.limit || 10 }, fetcher);
        if (!r.ok) return r;
        return { ok: true, data: r.files, summary: r.files.length ? `${r.files.length} files, newest: ${r.files[0].name}.` : 'No files found.' };
      },
      async create_file(input) {
        const r = await h.driveCreateDoc(ctx.env, ctx.data, { name: input.name, text: input.text }, fetcher);
        return r.ok ? { ok: true, summary: `Created "${input.name}".` } : r;
      },
      async read_file() {
        return { ok: false, error: 'Reading a Drive file is not connected yet.' };
      },
    },
    youtube: {
      async list_channel_videos() {
        const uploads = h.youtubeUploads(ctx.data || {});
        return { ok: true, data: uploads, summary: uploads.length ? `${uploads.length} recent uploads, newest: ${uploads[0].title || 'untitled'}.` : 'No uploads recorded yet.' };
      },
      async publish_video() {
        return { ok: false, error: 'Publishing is not connected to this room yet.' };
      },
    },
    trading: {
      async show_positions() {
        const ledgers = await h.readLedgers(ctx.storage, { now });
        const sim = ledgers?.strategy_simulation || ledgers?.sim || null;
        return { ok: true, data: ledgers, summary: sim ? `Strategy simulation: ${sim.open} open, ${sim.trades} trades stored.` : 'No simulation ledger yet.' };
      },
      async show_journal() {
        const ledgers = await h.readLedgers(ctx.storage, { now });
        return { ok: true, data: ledgers, summary: 'Paper journal read from the ledgers.' };
      },
      async place_paper_order() {
        return { ok: false, error: 'Paper orders are placed by the Trading Room engine; this room does not place them yet.' };
      },
    },
  };

  return async function executor(roomId, actionId, input = {}) {
    const fn = actions[roomId]?.[actionId];
    if (!fn) return { ok: false, error: `${roomId}.${actionId} is not connected yet.` };
    return fn(input || {});
  };
}
