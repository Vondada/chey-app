// Worker request and reply plumbing, kept out of worker.js (its byte budget).
//
// Request intake for every Worker route: the JSON body, parsed once, with Social Security numbers removed before
// any route, memory, log or model sees it (owner rule, Privacy Center: docs/CHE_PRIVACY_CENTER.md). A chat body
// whose message itself carried one is marked, so /api/chat answers it with the fixed SSN reply and nothing else.
import { guardSsnBody } from './privacy_center.js';

// Adds fields to a chat answer's done event (or to a one-line JSON answer such as a hold), so the phone
// gets them with the reply itself. Chat answers are built whole before they are returned.
export async function withDoneFields(response, fields) {
  const raw = await response.text();
  const lines = raw.split('\n');
  const at = lines.map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).findLastIndex((e) => e && (e.type === 'done' || (lines.filter(Boolean).length === 1 && !e.type)));
  if (at >= 0) lines[at] = JSON.stringify({ ...JSON.parse(lines[at]), ...fields });
  return new Response(lines.join('\n'), { status: response.status, headers: response.headers });
}

const SSN_TURNS = new WeakSet();

export async function bodyOf(request) {
  if (Number(request.headers.get('content-length') || 0) > 20_000_000) throw new Error('too_large');
  const raw = await request.text();
  if (raw.length > 20_000_000) throw new Error('too_large');
  // An empty body is an empty request (the phone's "clear all" sends none), not a malformed one.
  const body = raw.trim() ? JSON.parse(raw) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_json');
  const guarded = guardSsnBody(body);
  if (guarded.inMessage) SSN_TURNS.add(guarded.body);
  return guarded.body;
}

/** True when this parsed body's chat message carried an SSN (already removed). */
export const ssnTurn = (body) => SSN_TURNS.has(body);

/** A parsed body (the post-reply copy of a chat request) with SSNs removed. */
export const ssnFree = (body) => guardSsnBody(body).body;
