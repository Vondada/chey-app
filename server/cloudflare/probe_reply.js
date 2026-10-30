// Reads one owner chat turn's raw body for the certification probe (POST /api/probe/chat). The chat answers an NDJSON
// stream (delta, error and done frames), or a single JSON body when it refuses or queues the turn (a 503 with a detail,
// such as "saved, I will finish it when you say resume"). The single JSON body is the owner's visible reply, so it is
// read as the reply rather than parsed as a frame and dropped.
export function parseProbeChatBody(raw) {
  const text = String(raw || '');
  const events = text.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter((event) => event && typeof event === 'object');
  if (events.length === 1 && events[0].type === undefined) {
    const body = events[0];
    const reply = String(body.reply ?? body.message ?? body.detail ?? '').trim();
    return {
      reply,
      done: {},
      receipts: Array.isArray(body.execution_receipts) ? body.execution_receipts : [],
      error: body.category ? { category: body.category, rules: [] } : null,
    };
  }
  const reply = events
    .filter((event) => event.type === 'delta' && typeof event.delta === 'string')
    .map((event) => event.delta)
    .join('')
    .trim();
  const done = [...events].reverse().find((event) => event.type === 'done') || {};
  const receipts = Array.isArray(done.execution_receipts) ? done.execution_receipts : [];
  const frame = events.find((event) => event.type === 'error') || null;
  const error = frame ? { category: frame.category || null, rules: Array.isArray(frame.rules) ? frame.rules : [] } : null;
  return { reply, done, receipts, error };
}
