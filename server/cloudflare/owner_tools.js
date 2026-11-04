// Deterministic owner tools that answer in chat with an execution receipt, tried right after the timer and before the
// connector gate (the one call in worker.js). Each tool reads or changes CHE's own durable state, never a model's text,
// and its receipt says what ran, on what, and what came back. Lists come first: they are the oldest tool here.
//
// Certification run 24 (41491194768): "Recover the last 100 messages from the queue and show their IDs" (eer-36) and
// "Restart the failed worker now and report the new PID" (eer-35) were answered "Nothing was done" by the connector gate,
// though the background job queue (data.jobs, worker.js enqueueJob/processJobs) holds exactly those records.
import { retryCloudJob } from './cloud_computer.js';
import { listChatTurn } from './owner_lists.js';
import { listMedia, readBlob, saveMadeImage, verifyMediaFile } from './media.js';
import { ANIMATION_MOTIONS, ANIMATION_SHAPES, animationSpec, inspectGif, makeAnimation } from './gif_encoder.js';
import { dayRange, mediaChatFields, mediaSearchIntent, searchMedia } from './media_library.js';
export { dayRange, mediaSearchIntent, searchMedia };

const DATA_KEY = 'che';
const READ_LIMIT = 100;
const short = (id) => String(id || '').slice(0, 8);
const receipt = (operation, status, extra = {}, now = Date.now()) => ({
  tool: 'che_job_queue', operation, status, at: new Date(now).toISOString(), id: `job_queue:${operation}:${now}`, ...extra,
});

// "Recover/show/list the last 100 messages from the queue", "what's in my job queue", "show the queue IDs".
const QUEUE_READ = /\b(?:recover|show|list|inspect|read|get|give\s+me|pull)\b[^.?!]{0,70}\bqueue\b|\bwhat(?:['’]s|\s+is)\s+(?:in|on)\s+(?:the|my)\s+(?:job\s+|background\s+)?queue\b|\bqueue\b[^.?!]{0,40}\b(?:ids?|status|contents?)\b/i;
// "Restart the failed worker", "retry the last failed job", "rerun the failed task now".
const RESTART = /\b(?:restart|retry|re-?run|resume|relaunch)\s+(?:the\s+|my\s+)?(?:last\s+|latest\s+|most\s+recent\s+)?(?:failed|dead(?:-|\s)?lettered|stuck|crashed)\s+(?:background\s+)?(?:worker|job|task)\b/i;
const COUNT = /\b(?:last|latest|recent|first|top)\s+(\d{1,4})\b/i;

/** What the owner asked of the job queue: { action: 'read', limit } or { action: 'restart' }, or null. */
export function queueIntent(message = '') {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 400) return null;
  // A restart changes the queue, so it must be asked for: not "do not restart the failed worker", not a quoted line and
  // not a question about whether to (Codex review on #913).
  const unquoted = text.replace(/["“][^"”]*["”]|'[^']{3,}'/g, ' ');
  const negated = /\b(?:do\s+not|don['’]t|never|no\s+need\s+to|stop|without|instead\s+of|rather\s+than)\b[^.?!]{0,40}\b(?:restart|retry|re-?run|resume|relaunch)/i.test(unquoted);
  const advice = /^(?:should|why|how|when|what\s+happens|is\s+it|would\s+it)\b/i.test(unquoted);
  if (RESTART.test(unquoted) && !negated && !advice) return { action: 'restart' };
  if (QUEUE_READ.test(text)) {
    const asked = Number(COUNT.exec(text)?.[1] || 0);
    return { action: 'read', limit: Math.max(1, Math.min(READ_LIMIT, asked || 20)), asked: asked || null };
  }
  return null;
}

const failed = (job) => job?.status === 'failed' || job?.dead_letter === true;
const newest = (jobs) => [...jobs].sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0));

/** The newest [limit] jobs, as the owner hears them, and a receipt naming every id returned. */
export function readQueue(data, { limit = 20, asked = null, now = Date.now() } = {}) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const shown = newest(jobs).slice(0, limit);
  const counts = jobs.reduce((c, j) => ({ ...c, [j.status || 'unknown']: (c[j.status || 'unknown'] || 0) + 1 }), {});
  const dead = jobs.filter((j) => j.dead_letter === true).length;
  const ids = shown.map((j) => j.id);
  const r = receipt('read', 'success', { total: jobs.length, returned: ids.length, ids, verified: 'read_back' }, now);
  if (!jobs.length) return { text: 'My background job queue is empty, sir: there are no messages in it to recover or list. I read it just now.', receipt: r };
  const lines = shown.map((j, i) => `${i + 1}. ${j.id} · ${j.kind || 'job'} · ${j.dead_letter ? 'dead-lettered' : j.status}${j.title ? ` · ${String(j.title).slice(0, 60)}` : ''}`);
  const head = asked && asked > jobs.length
    ? `You asked for the last ${asked}; my background job queue holds ${jobs.length} messages, so here are all of them, newest first`
    : `Here are the last ${shown.length} of the ${jobs.length} messages in my background job queue, newest first`;
  const tally = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ');
  return {
    text: `${head} (${tally}${dead ? `; ${dead} dead-lettered` : ''}), with their IDs:\n${lines.join('\n')}\nNothing was changed: this was a read. Receipt ${r.id}.`,
    receipt: r,
  };
}

/**
 * Restarts the newest failed or dead-lettered job as a new job (the same fields the Cloud Computer's retry keeps). A
 * Worker has no process ID, so the new job's ID is what identifies the restart. A probe turn never changes the queue.
 */
export function restartFailedJob(data, { probe = false, now = Date.now() } = {}) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const job = newest(jobs).find(failed);
  if (!job) {
    const r = receipt('restart', 'success', { total: jobs.length, restarted: null, verified: 'read_back' }, now);
    return { text: `No job in my background queue has failed, sir, so nothing was restarted: I checked all ${jobs.length}. A Worker has no process ID (PID) to report; a restarted job would get a new job ID. Receipt ${r.id}.`, receipt: r, changed: false };
  }
  if (probe) {
    const r = receipt('restart', 'not_run', { failed_job: job.id, reason: 'certification probe: the owner\'s queue is not changed' }, now);
    return { text: `The newest failed job is ${job.id} (${job.kind || 'job'}). This is a test turn, so I did not restart it. Receipt ${r.id}.`, receipt: r, changed: false };
  }
  // The Cloud Computer's retry: it keeps the job's work and resets what must start over, a cloud task's GitHub run
  // included (Codex review on #913: copied dispatch state would poll the old failed run).
  const out = retryCloudJob(data, job.id, (store, fields) => {
    const iso = new Date(now).toISOString();
    const next = { ...fields, id: crypto.randomUUID(), kind: fields.kind || job.kind, status: 'queued', attempts: 0, retry_count: 0, retry_at: now, result: '', error: '', dead_letter: false, dead_letter_at: null, created_at: iso, updated_at: iso, activity: [] };
    store.jobs = [...(Array.isArray(store.jobs) ? store.jobs : []), next];
    return { job: next };
  });
  if (!out.ok) {
    const r = receipt('restart', 'failure', { failed_job: job.id, error: out.reason }, now);
    return { text: `I could not restart job ${job.id}, sir: ${out.reason} Receipt ${r.id}.`, receipt: r, changed: false };
  }
  const next = out.job;
  const r = receipt('restart', 'success', { failed_job: job.id, new_job: next.id, kind: next.kind, verified: 'queued' }, now);
  return {
    text: `Restarted, sir: failed job ${job.id} (${job.kind || 'job'}) is queued again as new job ${next.id}. A Worker has no process ID (PID); that new job ID is what to watch. Ask "what's in my job queue" to see it run. Receipt ${r.id}.`,
    receipt: r, changed: true,
  };
}

/** One chat turn for the job queue, or null when the message is not about it. */
export async function queueChatTurn(storage, message, { probe = false, owner = true, now = Date.now() } = {}) {
  const intent = queueIntent(message);
  if (!intent) return null;
  const meta = (extra = {}) => ({ source: 'che_job_queue', model_calls: 0, ...extra });
  if (!owner && !probe) return { text: 'My job queue is the owner\'s, sir. Nothing was read or changed.', meta: meta({ ok: false }) };
  let data;
  try { data = (await storage.get(DATA_KEY)) || {}; } catch (_) {
    const r = receipt(intent.action, 'failed', { error: 'read_failed' }, now);
    return { text: 'I could not read my job queue from CHE\'s storage just now, sir, so nothing was read or changed.', meta: meta({ ok: false, execution_receipt: r }) };
  }
  if (intent.action === 'read') {
    const out = readQueue(data, { ...intent, now });
    return { text: out.text, meta: meta({ ok: true, execution_receipt: out.receipt }) };
  }
  const out = restartFailedJob(data, { probe, now });
  if (out.changed) {
    await storage.put(DATA_KEY, data);
    // processJobs runs on the Durable Object alarm: wake it so the restarted job starts.
    try { if (typeof storage.setAlarm === 'function') await storage.setAlarm(now + 1000); } catch (_) {}
  }
  return { text: out.text, meta: meta({ ok: true, execution_receipt: out.receipt }) };
}

// ─── Search CHE's stored files and pictures by name or date ───
// Certification run 24: "Find the file named budget_2025 and open it" (ter-13) and "Show me the photos from last
// weekend" (ter-20) went to the model, which answered without looking: the media library could list everything or the
// latest item, but not search. The search reads CHE's own media index (media.js listMedia). The iPhone's Photos library
// stays on the phone, and Google Drive is a separate connector, so the answer says which store was searched.
const LAST_SEARCH_KEY = 'media_search_last';
const PICK_TTL_MS = 15 * 60_000;
const ORDINALS = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10 };
// "Open number 2", "number two", "2", "the second one", after a search that listed several files (AGENTS.md: spoken
// numbered choices).
const PICK = /^(?:(?:please\s+)?(?:open|show(?:\s+me)?|pull\s+up|bring\s+up)\s+)?(?:(?:number|no\.?|#)\s*|the\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+one)?\s*[.!]?$/i;

/** The list position a reply picks ("open number 2" -> 2), or 0. */
export function pickIntent(message = '') {
  const m = PICK.exec(String(message || '').replace(/\s+/g, ' ').trim());
  if (!m) return 0;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : ORDINALS[m[1].toLowerCase()] || 0;
}

// Opens one stored record: pictures and videos as chat media, a text file as its text, a PDF reported as found and
// read back (the chat cannot show a PDF, so it is not called opened; Codex review on #915).
async function openFound(row, { storage, env, request, items, receipt, where }) {
  const check = await verifyMediaFile(env, storage, row).catch(() => ({ ok: false, reason: 'its file could not be read' }));
  if (!check.ok) return { text: `I found ${String(row.title || 'it')} (ID ${row.id}) but could not open it, sir: ${check.reason || 'its file was not checked'}. Receipt ${receipt.id}.`, meta: { ok: false, execution_receipt: { ...receipt, status: 'failure', error: check.reason || 'not_verified' } } };
  const type = String(row.mime_type || '');
  const title = String(row.title || 'Untitled').slice(0, 80);
  if (/^image\//.test(type) || row.kind === 'video' || /^video\//.test(type)) {
    const fields = mediaChatFields(row, { origin: new URL(request.url).origin, items });
    return { text: `Found and opened ${fields.media_title}, sir (ID ${row.id}, saved ${String(row.created_at || '').slice(0, 10)}). ${where}. Receipt ${receipt.id}.`, meta: { ok: true, ...fields, media_retrieval: 'verified', execution_receipt: { ...receipt, opened: row.id } } };
  }
  if (/^text\//.test(type)) {
    let body = '';
    try { const bytes = await readBlob(env, storage, row); if (bytes) body = new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); } catch (_) { body = ''; }
    if (body) return { text: `${title} (ID ${row.id}, saved ${String(row.created_at || '').slice(0, 10)}), read from storage, sir:\n${body.slice(0, 1500)}${body.length > 1500 ? '\n…' : ''}\nReceipt ${receipt.id}.`, meta: { ok: true, media_retrieval: 'verified', execution_receipt: { ...receipt, opened: row.id } } };
  }
  return { text: `I found ${title} (ID ${row.id}, saved ${String(row.created_at || '').slice(0, 10)}, ${type || 'unknown type'}) and read its file back, sir, but I can't show a ${/pdf/.test(type) ? 'PDF' : 'file of that type'} inside chat yet, so it is not open. ${where}. Receipt ${receipt.id}.`, meta: { ok: true, media_retrieval: 'verified', execution_receipt: { ...receipt, verified_file: row.id } } };
}

/** One chat turn for a file or picture search, or a numbered pick from the last one; null when the message is neither. */
export async function mediaSearchTurn(storage, message, { owner = true, probe = false, env = {}, request = null, now = Date.now() } = {}) {
  const meta = (extra = {}) => ({ source: 'che_media_search', model_calls: 0, ...extra });
  const intent = mediaSearchIntent(message);
  const pick = intent ? 0 : pickIntent(message);
  if (!intent && !pick) return null;
  if (!owner && !probe) return intent ? { text: 'Stored files are the owner\'s, sir. Nothing was searched.', meta: meta({ ok: false }) } : null;
  if (pick) {
    const last = await storage.get(LAST_SEARCH_KEY).catch(() => null);
    if (!last?.ids?.length || now - Number(last.at || 0) > PICK_TTL_MS) return null;
    if (pick > last.ids.length) return { text: `That list had ${last.ids.length} files, sir, so there is no number ${pick}. Say a number from 1 to ${last.ids.length}.`, meta: meta({ ok: false }) };
    const items = await listMedia(storage).catch(() => []);
    const row = items.find((i) => i.id === last.ids[pick - 1]);
    const receipt = { tool: 'che_media_search', operation: 'open', status: 'success', at: new Date(now).toISOString(), id: `media_search:${now}`, picked: pick, verified: 'read_back' };
    if (!row) return { text: `Number ${pick} is no longer in my stored files, sir, so nothing was opened.`, meta: meta({ ok: false, execution_receipt: { ...receipt, status: 'failure', error: 'not_found' } }) };
    if (!request) return null;
    const out = await openFound(row, { storage, env, request, items, receipt, where: 'From your last search' });
    return { text: out.text, meta: meta(out.meta) };
  }
  const timeZone = env?.CHE_TIMEZONE || 'UTC';
  const range = intent.range ? dayRange(intent.range, { now, timeZone }) : null;
  let items;
  try { items = await listMedia(storage); } catch (_) {
    return { text: 'I could not read my stored files just now, sir, so nothing was searched.', meta: meta({ ok: false, execution_receipt: { tool: 'che_media_search', operation: 'search', status: 'failed', error: 'read_failed', at: new Date(now).toISOString(), id: `media_search:${now}` } }) };
  }
  const found = searchMedia(items, { ...intent, range, timeZone });
  const what = intent.kind === 'image' ? 'pictures' : intent.kind === 'video' ? 'videos' : 'files';
  const asked = [intent.name ? `named "${intent.name}"` : '', range ? `from ${intent.range} (${range.from === range.to ? range.from : `${range.from} to ${range.to}`})` : ''].filter(Boolean).join(' ');
  const where = `I searched the ${items.length} ${items.length === 1 ? 'file' : 'files'} stored in CHE${intent.kind === 'image' ? '; your iPhone Photos library stays on the phone, so it was not searched' : '; Google Drive is a separate connection and was not searched'}`;
  const receipt = { tool: 'che_media_search', operation: 'search', status: 'success', at: new Date(now).toISOString(), id: `media_search:${now}`, query: { name: intent.name || null, range, kind: intent.kind || null }, searched: items.length, matched: found.map((r) => r.id).slice(0, 50), verified: 'read_back' };
  if (!found.length) return { text: `I found no ${what} ${asked}, sir. ${where}. Receipt ${receipt.id}.`, meta: meta({ ok: true, execution_receipt: receipt }) };
  if (intent.open && found.length === 1 && request) {
    const out = await openFound(found[0], { storage, env, request, items, receipt, where });
    return { text: out.text, meta: meta(out.meta) };
  }
  const shown = found.slice(0, 10);
  // The numbered list is kept for 15 minutes so "open number 2" opens that file (a probe turn keeps nothing).
  if (!probe) await storage.put(LAST_SEARCH_KEY, { ids: shown.map((r) => r.id), at: now }).catch(() => null);
  const list = shown.map((r, i) => `${i + 1}. ${String(r.title || 'Untitled').slice(0, 60)} · ${String(r.created_at || '').slice(0, 10)} · ID ${r.id}`).join('\n');
  const choose = shown.length > 1 && !probe ? ' Say "open number" and the number to open one.' : '';
  return { text: `I found ${found.length} ${found.length === 1 ? what.replace(/s$/, '') : what} ${asked}, sir:\n${list}\n${where}.${choose} Receipt ${receipt.id}.`, meta: meta({ ok: true, execution_receipt: receipt }) };
}

// ─── Animated GIFs made in the Worker (gif_encoder.js; certification run 24, ivg-35) ───
const MAKE_VERB = /\b(?:make|produce|create|generate|draw|render|build|give\s+me|send\s+me)\b/i;

/** One chat turn that makes an animated GIF, or null when the message does not ask for one this can draw. */
export async function gifTurn(storage, message, { owner = true, probe = false, env = {}, request = null, now = Date.now() } = {}) {
  const text = String(message || '');
  if (text.length > 300 || !MAKE_VERB.test(text)) return null;
  const spec = animationSpec(text);
  if (!spec) return null;
  const meta = (extra = {}) => ({ source: 'che_gif', model_calls: 0, ...extra });
  if (!owner && !probe) return { text: 'Making pictures is for the owner, sir. Nothing was made.', meta: meta({ ok: false }) };
  const made = makeAnimation(spec);
  const check = inspectGif(made.bytes);
  const what = `a ${made.seconds.toFixed(1)}-second looping GIF of a ${spec.colour} ${spec.shape === 'ball' ? 'ball' : 'square'} ${spec.motion === 'bounce' ? 'bouncing' : spec.motion === 'slide' ? 'sliding' : spec.motion === 'pulse' ? 'pulsing' : 'spinning'}`;
  const receipt = { tool: 'che_gif', operation: 'make', status: check.ok ? 'success' : 'failure', at: new Date(now).toISOString(), id: `gif:${now}`, spec, width: check.width, height: check.height, frames: check.frames, bytes: check.bytes, verified: check.ok ? 'decoded' : check.reason };
  if (!check.ok) return { text: `I could not make that GIF, sir: the file did not read back as a GIF (${check.reason}). Nothing was saved.`, meta: meta({ ok: false, execution_receipt: receipt }) };
  const how = `${made.width} by ${made.height} pixels, ${check.frames} frames, ${check.bytes} bytes, drawn by CHE's own code in the Worker with no model or outside service. I can draw a ${ANIMATION_SHAPES.join(' or ')} that will ${ANIMATION_MOTIONS.join(', ')}`;
  // A certification probe turn makes and checks the file but does not fill the owner's media store with test files.
  if (probe || !request) return { text: `I made ${what} and read it back as a valid GIF, sir: ${how}. This is a test turn, so it was not saved or attached. Receipt ${receipt.id}.`, meta: meta({ ok: true, execution_receipt: { ...receipt, stored: false } }) };
  const item = await saveMadeImage(env, storage, { bytes: made.bytes, mime: 'image/gif', title: `${spec.colour} ${spec.shape} ${spec.motion} GIF`, prompt: text.slice(0, 300), width: made.width, height: made.height, recipe: spec });
  const stored = await verifyMediaFile(env, storage, item).catch(() => ({ ok: false, reason: 'its file could not be read' }));
  if (!stored.ok) return { text: `I made the GIF, sir, but it did not read back from storage (${stored.reason}), so it is not attached. Receipt ${receipt.id}.`, meta: meta({ ok: false, execution_receipt: { ...receipt, status: 'failure', stored: false, error: stored.reason } }) };
  const fields = mediaChatFields(item, { origin: new URL(request.url).origin, items: [item] });
  return {
    text: `Here it is, sir: ${what}, attached. ${how}. It is saved as picture ${item.id}. Receipt ${receipt.id}.`,
    meta: meta({ ok: true, ...fields, media_retrieval: 'verified', execution_receipt: { ...receipt, stored: true, media_id: item.id } }),
  };
}

// The deterministic owner tools, in the order they are tried. Each turn(storage, message, opts) returns a chat answer
// with its receipt, or null when the message is not for it.
export const OWNER_TOOLS = [
  { id: 'che_lists', turn: (storage, message, opts) => listChatTurn(storage, message, opts) },
  { id: 'che_job_queue', turn: (storage, message, opts) => queueChatTurn(storage, message, opts) },
  { id: 'che_media_search', turn: (storage, message, opts) => mediaSearchTurn(storage, message, opts) },
  { id: 'che_gif', turn: (storage, message, opts) => gifTurn(storage, message, opts) },
];

/** The first owner tool that answers [message], or null. */
export async function ownerToolTurn(storage, message, opts = {}) {
  for (const tool of OWNER_TOOLS) {
    const out = await tool.turn(storage, message, opts);
    if (out) return out;
  }
  return null;
}
