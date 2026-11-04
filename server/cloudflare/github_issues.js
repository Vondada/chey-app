// "Create a GitHub issue titled 'Flaky login test' with reproduction steps" (certification run 24, csd-38): CHE files
// the issue in her own repository (CHE_GITHUB_REPO, with CHE_GITHUB_TOKEN) and answers with its number and link as the
// receipt. It is not spending, deletion or a message to another person, so it needs no hold. She never invents what she
// does not know: reproduction steps the owner did not give are left as a section to fill in, and she says so. An open
// issue with the same title is reported, not filed twice. A certification probe turn files nothing.

const ASK = /\b(?:create|open|file|make|raise|log|add|submit|start)\s+(?:a\s+|an\s+|one\s+)?(?:new\s+)?(?:github\s+|git\s*hub\s+)?(?:issue|bug\s+report|ticket)\b/i;
const GITHUB = /\bgit\s*hub\b|\bissue\b/i;
const NOT_A_REQUEST = /\b(?:do\s+not|don['’]t|never|no\s+need\s+to)\b[^.?!]{0,30}\b(?:create|open|file|make|raise|log|submit)\b|^(?:how\s+(?:do|can|would|should)\s+(?:i|we|you|one)|how\s+to|what\s+(?:is|are)|why|should\s+i|can\s+i)\b|\b(?:explain|describe|teach|tell\s+me)\s+how\b/i;
const TITLE = /\b(?:titled|title(?:d)?\s*:|called|named|with\s+(?:the\s+)?title)\s*["“'‘]([^"”'’]{2,200})["”'’]|\b(?:titled|called|named)\s+([^,.;]{2,120}?)(?=\s+(?:with|and|about|for)\b|[,.;]|$)/i;
const STEPS = /\b(?:steps?(?:\s+to\s+reproduce)?|repro(?:duction)?(?:\s+steps)?)\s*:\s*([\s\S]{3,3000})$/i;
const WANTS_STEPS = /\brepro(?:duction|duce)?\b|\bsteps\b/i;

/** {title, steps, wantsSteps} when the message asks CHE to file a GitHub issue; {title: ''} when it gives no title. */
export function issueRequest(message = '') {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 4000 || !ASK.test(text) || !GITHUB.test(text) || NOT_A_REQUEST.test(text)) return null;
  const m = TITLE.exec(text);
  const title = String((m && (m[1] || m[2])) || '').trim().replace(/[.!?]+$/, '');
  const steps = (STEPS.exec(text)?.[1] || '').trim();
  return { title: title.slice(0, 200), steps, wantsSteps: WANTS_STEPS.test(text) };
}

/** The issue body: the owner's request, his steps when he gave them, otherwise a section marked to fill in. */
export function issueBody(ask, message, now = Date.now()) {
  const steps = ask.steps
    ? ask.steps
    : '_Not provided yet. Add the exact steps, the expected result and the actual result before this is worked on._\n\n1. \n2. \n3. ';
  return [
    `Filed by CHE from the owner's chat request on ${new Date(now).toISOString().slice(0, 10)}.`,
    '',
    `> ${String(message || '').replace(/\s+/g, ' ').trim().slice(0, 600)}`,
    '',
    '## Reproduction steps',
    steps,
    '',
    '## Expected',
    '',
    '## Actual',
    '',
  ].join('\n');
}

function gh(env, fetcher, method, path, body) {
  return fetcher(`https://api.github.com/repos/${env.CHE_GITHUB_REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'CHE-Agent', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** One chat turn that files a GitHub issue, or null when the message does not ask for one. */
export async function issueTurn(storage, message, { owner = true, probe = false, env = {}, fetcher = fetch, now = Date.now() } = {}) {
  const ask = issueRequest(message);
  if (!ask) return null;
  const meta = (extra = {}) => ({ source: 'che_github_issue', model_calls: 0, ...extra });
  const receipt = { tool: 'github_issues', operation: 'create', at: new Date(now).toISOString(), id: `github_issue:${now}`, title: ask.title };
  if (!owner && !probe) return { text: 'Filing issues in my repository is for the owner, sir. Nothing was filed.', meta: meta({ ok: false }) };
  if (!ask.title) return { text: 'What should the issue be titled, sir? Say, for example, "create a GitHub issue titled Flaky login test". Nothing was filed.', meta: meta({ ok: false, execution_receipt: { ...receipt, status: 'not_run', reason: 'no title' } }) };
  const repo = String(env.CHE_GITHUB_REPO || '');
  if (!repo || !env.CHE_GITHUB_TOKEN) return { text: 'My GitHub connection is not set on the server (the CHE GitHub token or repository), so I could not file the issue, sir. Nothing was filed.', meta: meta({ ok: false, execution_receipt: { ...receipt, status: 'failure', error: 'github not configured' } }) };
  const stepsNote = ask.steps ? ' It includes the reproduction steps you gave.' : ask.wantsSteps ? ' You did not give the reproduction steps, so I left that section marked to fill in rather than invent them.' : '';
  if (probe) {
    return { text: `I would file the issue "${ask.title}" in ${repo} and give you its number and link, sir.${stepsNote} This is a test turn, so nothing was filed. Receipt ${receipt.id}.`, meta: meta({ ok: true, execution_receipt: { ...receipt, status: 'not_run', repo } }) };
  }
  try {
    // An open issue with the same title is the same request: report it instead of filing a duplicate.
    const open = await gh(env, fetcher, 'GET', '/issues?state=open&per_page=100');
    if (open.ok) {
      const same = (await open.json()).find((i) => !i.pull_request && String(i.title || '').trim().toLowerCase() === ask.title.toLowerCase());
      if (same) return { text: `Issue #${same.number} "${same.title}" is already open in ${repo}, sir, so I did not file a duplicate: ${same.html_url}`, meta: meta({ ok: true, issue_number: same.number, issue_url: same.html_url, execution_receipt: { ...receipt, status: 'success', repo, issue_number: same.number, url: same.html_url, deduplicated: true } }) };
    }
    const res = await gh(env, fetcher, 'POST', '/issues', { title: ask.title, body: issueBody(ask, message, now) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.number) {
      const why = res.status === 403 || res.status === 404 ? 'my GitHub token is not allowed to create issues in that repository' : `GitHub answered ${res.status}${data.message ? ` (${String(data.message).slice(0, 120)})` : ''}`;
      return { text: `I could not file the issue, sir: ${why}. Nothing was filed.`, meta: meta({ ok: false, execution_receipt: { ...receipt, status: 'failure', repo, error: why } }) };
    }
    return {
      text: `I filed issue #${data.number} "${data.title}" in ${repo}, sir: ${data.html_url}.${stepsNote} Receipt ${receipt.id}.`,
      meta: meta({ ok: true, issue_number: data.number, issue_url: data.html_url, execution_receipt: { ...receipt, status: 'success', repo, issue_number: data.number, url: data.html_url } }),
    };
  } catch (error) {
    return { text: `I could not reach GitHub to file the issue, sir (${String(error?.message || error).slice(0, 120)}). Nothing was filed.`, meta: meta({ ok: false, execution_receipt: { ...receipt, status: 'failure', repo, error: 'network' } }) };
  }
}
