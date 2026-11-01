// The chat's streamed reply: one delta line with the words, then the done line with the route's facts. A done line whose
// facts show a real action gets its execution receipt here (action_receipts.js derivedReceipt), so routes stay small.
import { derivedReceipt } from './action_receipts.js';

export function ndjsonReply(reply, meta = {}) {
  const receipt = derivedReceipt(meta);
  return new Response(
    JSON.stringify({ type: 'delta', delta: reply }) + '\n' +
      JSON.stringify({ type: 'done', ...meta, ...(receipt ? { execution_receipts: [receipt] } : {}) }) + '\n',
    { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}
