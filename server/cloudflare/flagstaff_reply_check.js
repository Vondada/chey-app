// Reply check for Flagstaff: CHE's own tools need no owner yes. A reply that lists the
// free renderer under "needs the owner's yes" gets one corrective pass before it is sent.
// Publishing and spending keep the owner's direct yes, so a line that names them is not flagged.
const OWNER_YES = /needs? (?:the )?owner[’']s (?:direct )?(?:yes|ok|go-ahead|approval)|owner[’']s (?:yes|ok|go-ahead)/i;
const RENDER = /\brender/i;
const OWNER_GATED = /upload|publish|youtube|spend|paid|cost|\bpay\b/i;
const PROBLEM = 'the free renderer is listed as needing the owner\'s yes';

export function ownToolPermissionProblems(text) {
  const problems = new Set();
  let inOwnerList = false;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) {
      inOwnerList = false;
      continue;
    }
    if (OWNER_YES.test(line)) inOwnerList = true;
    if ((inOwnerList || OWNER_YES.test(line)) && RENDER.test(line) && !OWNER_GATED.test(line)) problems.add(PROBLEM);
  }
  return [...problems];
}
