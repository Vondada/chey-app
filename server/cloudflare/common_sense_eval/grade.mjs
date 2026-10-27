// Grades one CHE reply against one case (owner, 2026-10-26: a good answer is one that is not misleading and can be checked).
// A reply passes when it states one of the required facts and none of the known wrong ones. Matching is on whole words, lowercased,
// so "8" does not match inside "18". It does not judge tone or length; the owner checks anything marginal by hand.

// Full stops are kept only inside numbers (2.5), so "30." at the end of a sentence still matches "30".
const words = (text) => ` ${String(text).toLowerCase().replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/[^a-z0-9%.]+/g, ' ').trim()} `;

export function grade(testCase, reply) {
  const text = words(reply);
  const has = (phrase) => text.includes(` ${phrase.toLowerCase()} `);
  // must_include lists alternatives: one of them must appear ("eight" or "8"), not all of them.
  const missing = testCase.must_include.some((p) => has(p)) ? [] : testCase.must_include;
  const forbidden = testCase.must_not_include.filter((p) => has(p));
  const empty = String(reply).trim() === '';
  return { id: testCase.id, pass: !empty && missing.length === 0 && forbidden.length === 0, missing, forbidden, empty };
}

// /api/chat streams newline-delimited JSON ({type:'delta',delta} records, then {type:'done'}); a plain JSON body with
// `reply` or `text` is also accepted. Returns the joined reply text, or null when the body cannot be decoded at all.
export function replyText(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { return null; }
  }
  if (records.length === 1 && records[0] && records[0].type == null) return String(records[0].reply ?? records[0].text ?? '');
  return records.filter((r) => r && r.type === 'delta').map((r) => String(r.delta ?? '')).join('');
}
