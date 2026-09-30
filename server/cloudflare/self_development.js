// CHE self-development team.
//
// CHE manages the work; internal engineering sub-agents inspect, implement,
// proofread and repair code. The result is only a proposal. The existing
// che-update approval card must still be approved by the owner before a PR is
// opened, and CI still has to pass before merge/deploy.

import { validateUpdateFiles } from './self_update.js';

function repoOf(env) {
  const repo = String(env.CHE_GITHUB_REPO || '').trim();
  if (!env.CHE_GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return repo;
}

async function gh(env, method, path, body, fetcher = fetch) {
  const repo = repoOf(env);
  if (!repo) return { ok: false, status: 503, data: null };
  const response = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CHE-Agent',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  return { ok: response.ok, status: response.status, data };
}

function decodeBase64Utf8(value) {
  const binary = atob(String(value || '').replace(/\s+/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

function modelText(answer) {
  return String(answer?.response || answer?.choices?.[0]?.message?.content || '').trim();
}

function jsonObject(text) {
  const match = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}

async function runAgent(env, role, assignment, payload, maxTokens = 2200) {
  const answer = await env.AI.run(
    env.CHE_STRONG_MODEL || env.CHE_FAST_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    {
      messages: [
        {
          role: 'system',
          content: [
            `You are ${role}, an internal CHE software-engineering sub-agent.`,
            'CHE is the manager. You do the engineering work and report back to CHE; do not address the owner.',
            assignment,
            'Never expose or place credentials, tokens, private keys, passwords, or signing material in code.',
            'Never claim you inspected a file unless its actual source is included in your task.',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify(payload).slice(0, 120000) },
      ],
      max_tokens: maxTokens,
      che_route: 'quality',
    },
  );
  const text = modelText(answer);
  if (!text) throw new Error(`${role} returned no work.`);
  return text;
}

async function sourceIndex(env, fetcher) {
  const repo = await gh(env, 'GET', '', null, fetcher);
  if (!repo.ok) return { error: `Could not read repository metadata (${repo.status}).` };
  const base = String(repo.data?.default_branch || 'main');
  const ref = await gh(env, 'GET', `/git/ref/heads/${encodeURIComponent(base)}`, null, fetcher);
  if (!ref.ok || !ref.data?.object?.sha) return { error: `Could not read ${base}.` };
  const tree = await gh(
    env,
    'GET',
    `/git/trees/${encodeURIComponent(ref.data.object.sha)}?recursive=1`,
    null,
    fetcher,
  );
  if (!tree.ok) return { error: `Could not inspect source tree (${tree.status}).` };
  const paths = (Array.isArray(tree.data?.tree) ? tree.data.tree : [])
    .filter((item) => item?.type === 'blob' && /^lib\/[A-Za-z0-9_\/]+\.dart$/.test(String(item.path || '')))
    .map((item) => String(item.path))
    .slice(0, 1600);
  return { base, paths };
}

function isUiTask(request) {
  return /\b(ui|ux|screen|page|layout|button|card|navigation|nav|color|theme|font|spacing|menu|panel|interface|visual|design|redesign|banner|label|text|title)\b/i.test(request);
}

// ─── Team memory: every mistake becomes a rule, every find becomes a shortcut ───
// Stored in the Durable Object (key below). Seeded with lessons learned by hand.
const LESSONS_KEY = 'che_team_lessons';
const SEED_LESSONS = [
  { kind: 'mistake', text: 'When the owner names on-screen text (e.g. "the Ready banner"), edit the widget that shows THAT exact text. Never edit a different banner/label that merely has a similar name. PR #73 wrongly changed the Shorebird "CHE updated. Restart to apply." banner instead of the status banner.' },
  { kind: 'location', text: 'The home status banner text ("Ready. Type or speak a request." / "Voice standby...") lives in lib/main.dart (_statusBanner and the status getter).' },
  { kind: 'location', text: 'lib/self_update/che_patch_banner.dart is ONLY the Shorebird over-the-air update notice. Do not touch it unless the request is about update/restart notices.' },
];

export async function loadLessons(memory) {
  let saved = [];
  try { saved = (await memory?.get?.(LESSONS_KEY)) || []; } catch (_) {}
  return [...SEED_LESSONS, ...(Array.isArray(saved) ? saved : [])].slice(-60);
}

export async function recordLesson(memory, kind, text) {
  if (!memory?.get || !memory?.put) return;
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!clean) return;
  try {
    const saved = (await memory.get(LESSONS_KEY)) || [];
    const list = Array.isArray(saved) ? saved : [];
    if (list.some((item) => item.text === clean)) return;
    list.push({ kind, text: clean, at: new Date().toISOString() });
    await memory.put(LESSONS_KEY, list.slice(-50));
  } catch (_) {}
}

function lessonText(lessons) {
  return lessons.map((item, i) => `${i + 1}. [${item.kind}] ${item.text}`).join('\n');
}

// Literal phrases the owner quoted or clearly named, used to find the real code.
export function literalTerms(request) {
  const terms = new Set();
  for (const m of String(request).matchAll(/["“']([^"”']{3,80})["”']/g)) terms.add(m[1].trim());
  for (const m of String(request).matchAll(/\b(?:say|says|read|reads|show|shows|text|label(?:ed)?|titled?)\s+([A-Z][^.,;:!?\n]{2,60})/g)) terms.add(m[1].trim());
  return [...terms].slice(0, 6);
}

async function searchCode(env, terms, fetcher) {
  const repo = repoOf(env);
  const hits = new Map();
  if (!repo) return hits;
  for (const term of terms.slice(0, 5)) {
    const q = `"${String(term).replace(/"/g, '').slice(0, 80)}" repo:${repo} path:lib extension:dart`;
    try {
      const response = await fetcher(`https://api.github.com/search/code?per_page=10&q=${encodeURIComponent(q)}`, {
        headers: {
          Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CHE-Agent',
        },
      });
      if (!response.ok) continue;
      const data = await response.json();
      for (const item of data?.items || []) {
        const path = String(item?.path || '');
        if (/^lib\/[A-Za-z0-9_\/]+\.dart$/.test(path)) hits.set(path, (hits.get(path) || 0) + 1);
      }
    } catch (_) {}
  }
  return hits;
}

async function readFull(env, base, path, fetcher) {
  if (!/^lib\/[A-Za-z0-9_\/]+\.dart$/.test(path)) return null;
  const found = await gh(env, 'GET', `/contents/${path}?ref=${encodeURIComponent(base)}`, null, fetcher);
  if (!found.ok || !found.data?.content) return null;
  try { return decodeBase64Utf8(found.data.content); } catch (_) { return null; }
}

// Big files are shown as numbered windows around the lines that matter, so the
// model sees the real code without the file being truncated or rewritten.
export function focusView(source, terms, maxChars = 30000) {
  if (source.length <= maxChars) return { whole: true, text: source };
  const lines = source.split('\n');
  const wanted = new Set();
  const lowered = terms.map((t) => String(t).toLowerCase()).filter((t) => t.length > 2);
  lines.forEach((line, i) => {
    const l = line.toLowerCase();
    if (lowered.some((t) => l.includes(t))) for (let j = Math.max(0, i - 25); j <= Math.min(lines.length - 1, i + 25); j++) wanted.add(j);
  });
  if (!wanted.size) for (let j = 0; j < Math.min(lines.length, 400); j++) wanted.add(j);
  const out = [];
  let prev = -2;
  for (const i of [...wanted].sort((a, b) => a - b)) {
    if (i !== prev + 1) out.push('… (lines omitted) …');
    out.push(`${i + 1}| ${lines[i]}`);
    prev = i;
    if (out.join('\n').length > maxChars) break;
  }
  return { whole: false, text: out.join('\n') };
}

export function applyEdits(sources, edits) {
  const next = new Map(sources);
  for (const edit of Array.isArray(edits) ? edits : []) {
    const path = String(edit?.path || '').trim();
    const find = typeof edit?.find === 'string' ? edit.find : '';
    const replace = typeof edit?.replace === 'string' ? edit.replace : null;
    if (!next.has(path)) return { error: `Edit targets ${path || 'a missing path'}, which was not inspected.` };
    if (!find || replace === null) return { error: `An edit for ${path} is missing find/replace text.` };
    const current = next.get(path);
    const first = current.indexOf(find);
    if (first < 0) return { error: `In ${path}, the "find" text does not exist exactly: ${JSON.stringify(find.slice(0, 120))}. Copy it character-for-character from the source (no line-number prefixes).` };
    if (current.indexOf(find, first + find.length) >= 0) return { error: `In ${path}, the "find" text appears more than once: ${JSON.stringify(find.slice(0, 120))}. Include more surrounding lines so it is unique.` };
    next.set(path, current.slice(0, first) + replace + current.slice(first + find.length));
  }
  return { sources: next };
}

function diffView(before, after) {
  const out = [];
  for (const [path, text] of after) {
    const old = before.get(path) ?? '';
    if (old === text) continue;
    const a = old.split('\n');
    const b = text.split('\n');
    let top = 0;
    while (top < a.length && top < b.length && a[top] === b[top]) top++;
    let ea = a.length - 1;
    let eb = b.length - 1;
    while (ea >= top && eb >= top && a[ea] === b[eb]) { ea--; eb--; }
    const from = Math.max(0, top - 6);
    out.push(`--- ${path} (around line ${top + 1})`);
    for (let i = from; i < top; i++) out.push(`  ${a[i]}`);
    for (let i = top; i <= ea; i++) out.push(`- ${a[i]}`);
    for (let i = top; i <= eb; i++) out.push(`+ ${b[i]}`);
    for (let i = eb + 1; i < Math.min(b.length, eb + 7); i++) out.push(`  ${b[i]}`);
  }
  return out.join('\n').slice(0, 40000);
}

async function reviewProposal(env, request, architecture, diff, uiTask, lessons) {
  const text = await runAgent(
    env,
    uiTask ? 'CHE UI/UX + Code Review Agent' : 'CHE Code Review + QA Agent',
    [
      'Independently review this change against the owner request.',
      'FIRST check TARGET CORRECTNESS: does the diff change exactly the thing the owner referred to (same visible text, same screen, same widget)? If it edits a different element with a similar name, reject.',
      'Then check Dart syntax, missing imports, regressions and whether the request is fully met.',
      uiTask ? 'For UI, also check VoiceOver labels and voice-first use are preserved.' : 'Check existing behavior is preserved.',
      'Apply every team lesson; a change that repeats a listed mistake must be rejected.',
      'Return ONLY JSON: {"approved":true|false,"target_correct":true|false,"notes":["..."],"repair_instructions":"...","lesson":"one-sentence rule to prevent this mistake next time, or empty"}.',
    ].join('\n'),
    { request, architecture, diff, team_lessons: lessonText(lessons) },
    1500,
  );
  return jsonObject(text) || { approved: false, notes: ['Review agent returned invalid JSON.'], repair_instructions: 'Re-check the change.' };
}

async function implement(env, role, task, architecture, views, lessons, feedback) {
  const text = await runAgent(
    env,
    role,
    [
      'Implement the change as exact search-and-replace edits on the inspected source.',
      'Return ONLY strict JSON: {"summary":"1-2 sentences","edits":[{"path":"lib/x.dart","find":"exact existing text","replace":"new text"}],"new_files":[{"path":"lib/new.dart","content":"COMPLETE FILE"}]}.',
      '"find" must be copied character-for-character from the source, WITHOUT the "123| " line-number prefixes, and must be unique in its file. Keep each find small (1-15 lines).',
      'Change only what the request needs. Preserve VoiceOver labels and voice-first behavior.',
      'Obey every team lesson.',
    ].join('\n'),
    { request: task, architecture, inspected: views, team_lessons: lessonText(lessons), previous_attempt_problem: feedback || '' },
    6000,
  );
  return jsonObject(text);
}

export async function prepareSelfUpdate(env, request, fetcher = fetch, memory = null) {
  if (!repoOf(env)) {
    return { status: 503, detail: 'Self-development needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the server.' };
  }
  const task = String(request || '').trim().slice(0, 6000);
  if (!task) return { status: 400, detail: 'Describe the requested app change.' };

  try {
    const lessons = await loadLessons(memory);
    const index = await sourceIndex(env, fetcher);
    if (index.error || !index.paths?.length) {
      return { status: 502, detail: index.error || 'CHE could not inspect its Flutter source.' };
    }
    const uiTask = isUiTask(task);

    // 1. Architect: plan + the exact strings/identifiers to hunt for.
    const architectText = await runAgent(
      env,
      uiTask ? 'CHE UI/UX Architect' : 'CHE Software Architect',
      [
        'Plan the smallest change that does exactly what the owner asked.',
        'Name the exact visible text, identifiers or widget names that the code for this request must contain, so the team can search for them.',
        'Use the team lessons (they include known file locations). Pick at most 5 existing files.',
        'Return ONLY JSON: {"plan":"...","search_terms":["exact text or identifier"],"paths":["lib/a.dart"]}.',
      ].join('\n'),
      { request: task, dart_files: index.paths, team_lessons: lessonText(lessons) },
      1200,
    );
    const architecture = jsonObject(architectText) || {};
    const terms = [...new Set([
      ...literalTerms(task),
      ...(Array.isArray(architecture.search_terms) ? architecture.search_terms.map(String) : []),
    ])].filter((t) => t.trim().length > 2).slice(0, 8);

    // 2. Locate: real code search beats guessing from file names.
    const hits = await searchCode(env, terms, fetcher);
    const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
    const planned = Array.isArray(architecture.paths) ? architecture.paths.map(String).filter((p) => index.paths.includes(p)) : [];
    const chosen = [...new Set([...ranked, ...planned])].slice(0, 5);
    if (!chosen.length) return { status: 422, detail: 'The team could not locate the code for that request. Try naming the exact on-screen text.' };

    const sources = new Map();
    const views = [];
    for (const path of chosen) {
      const full = await readFull(env, index.base, path, fetcher);
      if (full === null) continue;
      sources.set(path, full);
      const view = focusView(full, terms);
      views.push({ path, search_hits: hits.get(path) || 0, whole_file: view.whole, source: view.text });
    }
    if (!sources.size) return { status: 502, detail: 'The team could not read the located files.' };

    // 3. Implement with exact edits; one retry with the concrete error.
    const role = uiTask ? 'CHE Flutter UI Engineer' : 'CHE Flutter Implementation Agent';
    let feedback = '';
    let result = null;
    let summary = '';
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      const answer = await implement(env, role, task, architecture, views, lessons, feedback);
      if (!answer) { feedback = 'Your last answer was not valid JSON.'; continue; }
      const applied = applyEdits(sources, answer.edits);
      if (applied.error) { feedback = applied.error; continue; }
      for (const file of Array.isArray(answer.new_files) ? answer.new_files.slice(0, 3) : []) {
        const path = String(file?.path || '');
        if (/^lib\/[A-Za-z0-9_\/]+\.dart$/.test(path) && !sources.has(path) && typeof file.content === 'string') applied.sources.set(path, file.content);
      }
      const diff = diffView(sources, applied.sources);
      if (!diff) { feedback = 'Your edits changed nothing.'; continue; }
      const review = await reviewProposal(env, task, architecture, diff, uiTask, lessons);
      if (review.approved === true && review.target_correct !== false) {
        result = { next: applied.sources, review, diff };
        summary = String(answer.summary || 'CHE update').slice(0, 1800);
        break;
      }
      const why = [review.repair_instructions, ...(review.notes || [])].filter(Boolean).join(' ');
      feedback = `Independent review rejected it: ${why}`.slice(0, 1500);
      await recordLesson(memory, 'mistake', review.lesson || `For "${task.slice(0, 80)}": ${why}`);
    }
    if (!result) {
      if (/does not exist exactly|more than once/.test(feedback)) await recordLesson(memory, 'mistake', 'Edit "find" text must be copied exactly from the source without line-number prefixes and include enough lines to be unique.');
      return { status: 422, detail: `The coding team could not produce a correct change. ${feedback}`.slice(0, 600) };
    }

    const files = [...result.next.entries()]
      .filter(([path, content]) => sources.get(path) !== content)
      .map(([path, content]) => ({ path, content }));
    const checked = validateUpdateFiles(files);
    if (checked.error) return { status: 422, detail: checked.error };
    await recordLesson(memory, 'location', `"${task.slice(0, 90)}" was done by editing ${files.map((f) => f.path).join(', ')}.`);

    return {
      status: 200,
      proposal: { summary, files: checked.files },
      review: result.review,
      diff: result.diff,
      team: uiTask
        ? ['CHE UI/UX Architect', 'CHE Flutter UI Engineer', 'CHE UI/UX + Code Review Agent']
        : ['CHE Software Architect', 'CHE Flutter Implementation Agent', 'CHE Code Review + QA Agent'],
      approval_required: true,
      next: 'Present the che-update proposal to the owner. Do not write or merge anything until owner approval.',
    };
  } catch (error) {
    return { status: 502, detail: String(error?.message || error).slice(0, 1000) };
  }
}
