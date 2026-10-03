// CHE self-development team.
//
// CHE manages the work; internal engineering sub-agents inspect, implement,
// proofread and repair code. The result is only a proposal. The existing
// che-update approval card must still be approved by the owner before a PR is
// opened, and CI still has to pass before merge/deploy.

import { isSelfUpdateEditablePath, isSelfUpdateReadablePath, validateUpdateFiles } from './self_update.js';

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

export function jsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [raw];
  const fenced = /^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i.exec(raw);
  if (fenced) candidates.push(fenced[1].trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return null;
}

async function runAgent(env, role, assignment, payload, maxTokens = 2200, provider = '') {
  const answer = await env.AI.run(
    env.CHE_STRONG_MODEL || env.CHE_FAST_MODEL || '@cf/meta/llama-3.1-8b-instruct-fp8',
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
        { role: 'user', content: JSON.stringify(payload).slice(0, 48000) },
      ],
      max_tokens: maxTokens,
      che_route: 'quality',
      // Ask engines for strict JSON so patches parse ("not valid JSON" failures).
      response_format: { type: 'json_object' },
      ...(provider ? { che_provider: provider } : {}),
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
    .filter((item) => item?.type === 'blob' && isSelfUpdateReadablePath(String(item.path || '')))
    .map((item) => String(item.path))
    .slice(0, 4000);
  return { base, head_sha: String(ref.data.object.sha), paths, editable_paths: paths.filter(isSelfUpdateEditablePath) };
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


// ─── The crew: existing Office staff, paired, each pair on different engines ───
// Different engines = different blind spots. Pairs run at the same time.
// Engine choice is a preference; the router falls back if one is resting.
export const CREW = {
  planners: [
    { name: 'Atlas', title: 'Architect (research)', provider: 'gemini' },
    { name: 'Iris', title: 'Architect (visual/UI)', provider: 'mistral' },
  ],
  engineers: [
    { name: 'Knox', title: 'Engineer', provider: 'groq' },
    { name: 'Nova', title: 'Engineer', provider: 'cerebras' },
  ],
  reviewers: [
    { name: 'Sage', title: 'Reviewer (correctness)', provider: 'gemini' },
    { name: 'Mira', title: 'Reviewer (target + accessibility)', provider: 'github' },
  ],
};
const who = (member, role) => `${member.name}, CHE Office ${member.title}, acting as ${role}`;

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
  const batches = await Promise.all(terms.slice(0, 5).map(async (term) => {
    const q = `"${String(term).replace(/"/g, '').slice(0, 80)}" repo:${repo}`;
    try {
      const response = await fetcher(`https://api.github.com/search/code?per_page=10&q=${encodeURIComponent(q)}`, {
        headers: {
          Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CHE-Agent',
        },
      });
      if (!response.ok) return [];
      const data = await response.json();
      return (data?.items || [])
        .map((item) => String(item?.path || ''))
        .filter((path) => isSelfUpdateReadablePath(path));
    } catch (_) {
      return [];
    }
  }));
  for (const paths of batches) {
    for (const path of paths) hits.set(path, (hits.get(path) || 0) + 1);
  }
  return hits;
}

export function fallbackTreeCandidates(request, index, terms = [], limit = 6) {
  const task = String(request || '').toLowerCase();
  const words = [...new Set([
    ...(String(request || '').toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []),
    ...terms.flatMap((term) => String(term).toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []),
  ])].filter((word) => !['the', 'and', 'for', 'with', 'this', 'that', 'make', 'change', 'code', 'app'].includes(word));

  const scored = (index?.editable_paths || []).map((path) => {
    const lower = path.toLowerCase();
    let score = 0;
    for (const word of words) if (lower.includes(word)) score += 8;
    if (/\b(ui|screen|page|button|layout|visual|interface|home|chat|voice)\b/.test(task) && lower.startsWith('lib/')) score += 10;
    if (/\b(worker|server|api|route|cloudflare|backend)\b/.test(task) && lower.startsWith('server/cloudflare/')) score += 10;
    if (lower === 'lib/main.dart') score += 4;
    if (lower === 'server/cloudflare/worker.js') score += 3;
    if (/\/(main|home|chat|app|worker|router|service)[._/-]/.test(lower)) score += 2;
    return { path, score };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, limit))
    .map((item) => item.path);
}

async function readFull(env, base, path, fetcher) {
  if (!isSelfUpdateReadablePath(path)) return null;
  const found = await gh(env, 'GET', `/contents/${path}?ref=${encodeURIComponent(base)}`, null, fetcher);
  if (!found.ok || !found.data?.content) return null;
  try { return decodeBase64Utf8(found.data.content); } catch (_) { return null; }
}

// Big files are shown as numbered windows around the lines that matter, so the
// model sees the real code without the file being truncated or rewritten.
export function focusView(source, terms, maxChars = 14000) {
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
    const requestedFind = typeof edit?.find === 'string' ? edit.find : '';
    const replace = typeof edit?.replace === 'string' ? edit.replace : null;
    if (!next.has(path)) return { error: `Edit targets ${path || 'a missing path'}, which was not inspected.` };
    if (!requestedFind || replace === null) return { error: `An edit for ${path} is missing find/replace text.` };
    const current = next.get(path);
    const unnumbered = requestedFind.split('\n')
      .map((line) => line.replace(/^\s*\d+\|\s?/, ''))
      .join('\n');
    const find = current.includes(requestedFind)
      ? requestedFind
      : (unnumbered !== requestedFind && current.includes(unnumbered) ? unnumbered : requestedFind);
    const first = current.indexOf(find);
    if (first < 0) return { error: `In ${path}, the "find" text does not exist exactly in current source. Re-read this file and regenerate the edit from the inspected source; do not ask the owner to copy source text.` };
    if (current.indexOf(find, first + find.length) >= 0) return { error: `In ${path}, the proposed edit is ambiguous because it matches more than once. Re-read the surrounding function or widget and regenerate a uniquely anchored edit.` };
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

export function attemptFingerprint(answer) {
  const edits = (Array.isArray(answer?.edits) ? answer.edits : []).map((edit) => ({
    path: String(edit?.path || '').trim(),
    find: String(edit?.find || ''),
    replace: String(edit?.replace ?? ''),
  }));
  const newFiles = (Array.isArray(answer?.new_files) ? answer.new_files : []).map((file) => ({
    path: String(file?.path || '').trim(),
    content: String(file?.content || ''),
  }));
  return JSON.stringify({
    no_change: answer?.no_change === true,
    edits,
    new_files: newFiles,
  });
}

export function diagnoseNoOp(sources, answer) {
  const edits = Array.isArray(answer?.edits) ? answer.edits : [];
  const newFiles = Array.isArray(answer?.new_files) ? answer.new_files : [];

  if (!edits.length && !newFiles.length)
    return 'The implementation proposed no file changes.';

  const same = edits.filter(
    (edit) => String(edit?.find || '') === String(edit?.replace ?? ''),
  );
  if (same.length)
    return `The proposed replacement is identical to the existing text in ${
      same.map((edit) => edit.path).join(', ')
    }.`;

  return 'The proposed edits produced an empty diff. Re-read the target and choose a different edit strategy.';
}

async function reviewProposal(env, request, architecture, diff, uiTask, lessons, member, chat = []) {
  const text = await runAgent(
    env,
    who(member, uiTask ? 'CHE UI/UX + Code Review Agent' : 'CHE Code Review + QA Agent'),
    [
      'Independently review this change against the owner request.',
      'FIRST check TARGET CORRECTNESS: does the diff change exactly the thing the owner referred to (same visible text, same screen, same widget)? If it edits a different element with a similar name, reject.',
      'Then check Dart or JavaScript syntax, missing imports, regressions and whether the request is fully met.',
      uiTask ? 'For UI, also check VoiceOver labels and voice-first use are preserved.' : 'Check existing behavior is preserved.',
      'Apply every team lesson; a change that repeats a listed mistake must be rejected.',
      'Read team_chat (planners, engineers and the other reviewer). If a teammate raised a point, address it explicitly in notes.',
      'Return ONLY JSON: {"approved":true|false,"target_correct":true|false,"notes":["..."],"repair_instructions":"...","lesson":"one-sentence rule to prevent this mistake next time, or empty"}.',
    ].join('\n'),
    { request, architecture, diff, team_lessons: lessonText(lessons), team_chat: chat.slice(-20) },
    1500,
    member.provider,
  );
  return jsonObject(text) || { approved: false, notes: ['Review agent returned invalid JSON.'], repair_instructions: 'Re-check the change.' };
}

async function implement(env, role, task, architecture, views, lessons, feedback, member, chat = []) {
  const text = await runAgent(
    env,
    who(member, role),
    [
      'Implement the change as exact search-and-replace edits on the inspected source.',
      'Return ONLY strict JSON. Normal change: {"summary":"1-2 sentences","edits":[{"path":"existing/source.file","find":"exact existing text","replace":"new text"}],"new_files":[{"path":"allowed/new.file","content":"COMPLETE FILE"}]}.',
      'If and only if the inspected code already satisfies the owner request and a real change would be duplicate, worse, unsafe, or unnecessary, return {"no_change":true,"summary":"why no delta is justified","evidence":["concrete file/function/capability evidence"]}. Never manufacture a no-op edit just to create a diff.',
      '"find" must be copied character-for-character from the source, WITHOUT the "123| " line-number prefixes, and must be unique in its file. Keep each find small (1-15 lines).',
      'Only edit files CHE is allowed to write. Read-only workflow/signing/dependency/config files may be inspected for context but must never appear in edits/new_files.',
      'Change only what the request needs. Preserve VoiceOver labels and voice-first behavior.',
      'Obey every team lesson. Read team_chat: build on teammates\' good ideas and avoid what reviewers rejected in their work.',
    ].join('\n'),
    { request: task, architecture, inspected: views, team_lessons: lessonText(lessons), previous_attempt_problem: feedback || '', team_chat: chat.slice(-20) },
    6000,
    member.provider,
  );
  return jsonObject(text);
}


const ENGINEER_PROVIDER_ROUNDS = [
  ['groq', 'cerebras'],
  ['gemini', 'mistral'],
  ['github', 'huggingface'],
];

function engineerForRound(member, index, round) {
  const provider = ENGINEER_PROVIDER_ROUNDS[round]?.[index] || member.provider;
  return { ...member, provider };
}

async function recoveryPlan(env, task, architecture, feedback, index, lessons, member, chat) {
  const text = await runAgent(
    env,
    who(member, 'CHE Source Recovery Architect'),
    [
      'The previous implementation pass failed or produced no real diff. Do not repeat the same edit.',
      'Re-locate the actual source for the owner request using the failure feedback and repository file list.',
      'Prefer exact visible text for UI requests; for architecture/repository work, use module names, exported functions and likely server or Flutter files. Name new files to inspect when the previous set was wrong or incomplete.',
      'Return ONLY JSON: {"plan":"...","search_terms":["exact text or identifier"],"paths":["an actual repository path"]}.',
    ].join('\n'),
    {
      request: task,
      previous_architecture: architecture,
      previous_failure: feedback,
      editable_source_files: index.editable_paths,
      readable_source_files: index.paths,
      team_lessons: lessonText(lessons),
      team_chat: chat.slice(-24),
    },
    1600,
    member.provider,
  );
  return jsonObject(text);
}

// When the two reviewers disagree, they talk it out once: each sees the
// other's verdict and reasoning, then gives a final answer. Both must pass.
async function settleReviews(env, task, architecture, diff, uiTask, lessons, reviews, chat) {
  const pass = (r) => r?.approved === true && r?.target_correct !== false;
  if (reviews.every(pass) || !reviews.some(pass)) return reviews;
  const talk = [...chat, ...reviews.map((r, i) => ({
    from: CREW.reviewers[i].name,
    msg: `${pass(r) ? 'APPROVE' : 'REJECT'}: ${[...(r.notes || []), r.repair_instructions].filter(Boolean).join(' ')}`.slice(0, 700),
  }))];
  return Promise.all(CREW.reviewers.map((reviewer) => reviewProposal(
    env, `${task}\n\nYou and the other reviewer disagreed. Read team_chat, weigh their argument honestly, and give your final verdict.`,
    architecture, diff, uiTask, lessons, reviewer, talk,
  ).catch(() => ({ approved: false, notes: ['Reviewer unavailable.'] }))));
}

async function reviewNoChange(env, request, architecture, claims, lessons, member, chat = []) {
  const text = await runAgent(
    env,
    who(member, 'CHE No-Change Verification Agent'),
    [
      'Independently verify the engineers\' claim that no code delta is justified.',
      'Approve ONLY if the inspected source already satisfies the owner request or the referenced capability would be duplicate, worse, unsafe, incompatible, or unnecessary.',
      'Reject if there is still a concrete missing capability or if the evidence is vague.',
      'A no-change approval is a reviewed engineering conclusion, not permission to skip requested work.',
      'Return ONLY JSON: {"approved":true|false,"notes":["..."],"repair_instructions":"..."}.',
    ].join('\n'),
    {
      request,
      architecture,
      no_change_claims: claims,
      team_lessons: lessonText(lessons),
      team_chat: chat.slice(-20),
    },
    1200,
    member.provider,
  );
  return jsonObject(text) || { approved: false, notes: ['No-change reviewer returned invalid JSON.'] };
}

export async function prepareSelfUpdate(env, request, fetcher = fetch, memory = null) {
  if (!repoOf(env)) {
    return { status: 503, detail: 'Self-development needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the server.' };
  }
  const task = String(request || '').trim().slice(0, 16000);
  if (!task) return { status: 400, detail: 'Describe the requested app change.' };

  try {
    const lessons = await loadLessons(memory);
    const index = await sourceIndex(env, fetcher);
    if (index.error || !index.paths?.length) {
      return { status: 502, detail: index.error || 'CHE could not inspect its source.' };
    }
    const uiTask = isUiTask(task);

    // 1. Two architects in parallel on different engines; plans are merged.
    const plans = await Promise.all(CREW.planners.map((member) => runAgent(
      env,
      who(member, uiTask ? 'CHE UI/UX Architect' : 'CHE Software Architect'),
      [
        'Plan the smallest change that does exactly what the owner asked.',
        'For UI requests, name exact visible text or widget identifiers. For architecture/repository work, name concrete modules, functions, routes or server files that implement the capability.',
        'Use the team lessons (they include known file locations). You may inspect read-only control files for context, but edits must stay inside editable_source_files. Pick at most 6 existing files.',
        'Return ONLY JSON: {"plan":"...","search_terms":["exact text or identifier"],"paths":["an actual repository path"]}.',
      ].join('\n'),
      { request: task, editable_source_files: index.editable_paths, readable_source_files: index.paths, team_lessons: lessonText(lessons) },
      1200,
      member.provider,
    ).then(jsonObject).catch(() => null)));
    const chat = [];
    plans.forEach((p, i) => { if (p) chat.push({ from: CREW.planners[i].name, msg: `Plan: ${String(p.plan || '').slice(0, 600)} Look for: ${(p.search_terms || []).slice(0, 5).join(' / ')}` }); });
    const good = plans.filter(Boolean);
    const architecture = {
      plan: good.map((p, i) => `${CREW.planners[i]?.name || 'Architect'}: ${p.plan || ''}`).join('\n'),
      search_terms: good.flatMap((p) => (Array.isArray(p.search_terms) ? p.search_terms : [])),
      paths: good.flatMap((p) => (Array.isArray(p.paths) ? p.paths : [])),
    };
    const terms = [...new Set([
      ...literalTerms(task),
      ...(Array.isArray(architecture.search_terms) ? architecture.search_terms.map(String) : []),
    ])].filter((t) => t.trim().length > 2).slice(0, 8);

    // 2. Locate: real code search beats guessing from file names.
    const hits = await searchCode(env, terms, fetcher);
    const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
    const planned = Array.isArray(architecture.paths) ? architecture.paths.map(String).filter((p) => index.paths.includes(p)) : [];
    let chosen = [...new Set([...ranked, ...planned])].slice(0, 5);
    if (!chosen.length) {
      const recoveryMember = CREW.planners[1];
      const recovery = await recoveryPlan(
        env,
        task,
        architecture,
        'Initial discovery returned no verified source paths. Broaden discovery from the repository tree; use visible text, identifiers, widgets/classes/functions, routes, imports, callers/callees and likely feature directories.',
        index,
        lessons,
        recoveryMember,
        chat,
      ).catch(() => null);
      if (recovery) {
        const recoveryTerms = (Array.isArray(recovery.search_terms) ? recovery.search_terms : [])
          .map(String).filter((item) => item.trim().length > 2);
        for (const term of recoveryTerms) if (!terms.includes(term)) terms.push(term);
        const recoveryPaths = (Array.isArray(recovery.paths) ? recovery.paths : [])
          .map(String).filter((path) => index.paths.includes(path));
        const moreHits = await searchCode(env, recoveryTerms, fetcher);
        for (const [path, count] of moreHits.entries()) hits.set(path, (hits.get(path) || 0) + count);
        const reranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
        chosen = [...new Set([...recoveryPaths, ...reranked])].filter((path) => index.paths.includes(path)).slice(0, 5);
        architecture.plan = [architecture.plan, `Initial recovery: ${String(recovery.plan || '')}`].filter(Boolean).join('\n');
        architecture.search_terms = [...new Set([...(architecture.search_terms || []), ...recoveryTerms])];
        architecture.paths = [...new Set([...(architecture.paths || []), ...recoveryPaths])];
        chat.push({ from: recoveryMember.name, msg: `Initial recovery locate: ${String(recovery.plan || '').slice(0, 500)} Paths: ${recoveryPaths.join(', ') || 'search again'}` });
      }
    }
    if (!chosen.length) {
      chosen = fallbackTreeCandidates(task, index, terms, 6);
      if (chosen.length) {
        architecture.plan = [
          architecture.plan,
          'Deterministic tree fallback: inspect the highest-signal editable source candidates directly because model/search discovery returned no verified path.',
        ].filter(Boolean).join('\n');
        architecture.paths = [...new Set([...(architecture.paths || []), ...chosen])];
        chat.push({
          from: 'CHE',
          msg: `Deterministic repository fallback selected: ${chosen.join(', ')}`,
        });
      }
    }
    if (!chosen.length) {
      return {
        status: 422,
        detail: 'CHE inspected the repository tree but it contains no editable source paths. This is a repository or permissions limitation, not an owner source-text request.',
      };
    }

    const sources = new Map();
    const views = [];
    const initialReads = await Promise.all(chosen.map(async (path) => ({
      path,
      full: await readFull(env, index.base, path, fetcher),
    })));
    for (const { path, full } of initialReads) {
      if (full === null) continue;
      sources.set(path, full);
      const view = focusView(full, terms);
      views.push({ path, search_hits: hits.get(path) || 0, whole_file: view.whole, source: view.text });
    }
    if (!sources.size) return { status: 502, detail: 'The team could not read the located files.' };

    // 3. Engineers build in parallel. If a pass fails, CHE re-inspects the
    //    repository and changes provider pair before trying again. This prevents
    //    a no-op or wrong-file attempt from being repeated back to the owner.
    const role = uiTask ? 'CHE Flutter UI Engineer' : 'CHE Flutter Implementation Agent';
    const feedbacks = CREW.engineers.map(() => '');
    let feedback = '';
    let result = null;
    let summary = '';
    const maxRounds = ENGINEER_PROVIDER_ROUNDS.length;
    const seenAttempts = new Set();
    const attemptHistory = [];

    const refreshViews = () => {
      views.length = 0;
      for (const [path, full] of sources.entries()) {
        const view = focusView(full, terms);
        views.push({ path, search_hits: hits.get(path) || 0, whole_file: view.whole, source: view.text });
      }
    };

    for (let round = 0; round < maxRounds && !result; round++) {
      const roundEngineers = CREW.engineers.map((member, i) => engineerForRound(member, i, round));
      const attempts = await Promise.all(roundEngineers.map(async (member, i) => {
        const answer = await implement(env, role, task, architecture, views, lessons, feedbacks[i], member, chat).catch(() => null);
        if (!answer) { feedbacks[i] = 'Your last answer was not valid JSON.'; return null; }
        if (answer.no_change === true) {
          const evidence = (Array.isArray(answer.evidence) ? answer.evidence : [])
            .map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8);
          if (!evidence.length) {
            feedbacks[i] = 'A no-change conclusion needs concrete file/function/capability evidence from the inspected source.';
            return null;
          }
          const noChangeSummary = String(answer.summary || 'No code delta is justified.').trim().slice(0, 1200);
          chat.push({
            from: member.name,
            msg: `Round ${round + 1} via ${member.provider}. NO CHANGE: ${noChangeSummary} Evidence: ${evidence.join(' | ').slice(0, 1200)}`,
          });
          return { no_change: true, summary: noChangeSummary, evidence, engineer: member.name, provider: member.provider };
        }
        const fingerprint = attemptFingerprint(answer);
        if (seenAttempts.has(fingerprint)) {
          feedbacks[i] =
            'This exact implementation strategy was already attempted. ' +
            'Re-read current source and choose a materially different path, anchor, or implementation.';
          attemptHistory.push({
            round: round + 1,
            engineer: member.name,
            provider: member.provider,
            outcome: 'duplicate_strategy',
          });
          return null;
        }
        seenAttempts.add(fingerprint);
        const requestedEdits = Array.isArray(answer.edits) ? answer.edits : [];
        const protectedEdit = requestedEdits.find((edit) => !isSelfUpdateEditablePath(String(edit?.path || '')));
        if (protectedEdit) {
          feedbacks[i] = `That edit targets a protected/read-only path: ${String(protectedEdit?.path || 'missing path')}. Keep the control plane read-only and implement through normal source instead.`;
          return null;
        }
        const applied = applyEdits(sources, requestedEdits);
        if (applied.error) { feedbacks[i] = applied.error; return null; }
        for (const file of Array.isArray(answer.new_files) ? answer.new_files.slice(0, 4) : []) {
          const path = String(file?.path || '');
          if (isSelfUpdateEditablePath(path) && !sources.has(path) && typeof file.content === 'string') applied.sources.set(path, file.content);
        }
        const diff = diffView(sources, applied.sources);
        if (!diff) {
          const diagnosis = diagnoseNoOp(sources, answer);
          feedbacks[i] =
            `${diagnosis} Re-inspect the source and make a real change that satisfies the owner request. ` +
            'Do not repeat this strategy.';
          attemptHistory.push({
            round: round + 1,
            engineer: member.name,
            provider: member.provider,
            outcome: 'no_diff',
            detail: diagnosis,
          });
          return null;
        }
        chat.push({ from: member.name, msg: `Round ${round + 1} via ${member.provider}. My change: ${String(answer.summary || '').slice(0, 300)}\n${diff.slice(0, 1500)}` });
        const first = await Promise.all(CREW.reviewers.map((reviewer) =>
          reviewProposal(env, task, architecture, diff, uiTask, lessons, reviewer, chat).catch(() => ({ approved: false, notes: ['Reviewer unavailable.'] }))));
        const reviews = await settleReviews(env, task, architecture, diff, uiTask, lessons, first, chat);
        reviews.forEach((r, k) => chat.push({ from: CREW.reviewers[k].name, msg: `On ${member.name}'s change: ${r.approved === true ? 'APPROVE' : 'REJECT'} ${[...(r.notes || []), r.repair_instructions].filter(Boolean).join(' ').slice(0, 500)}` }));
        const passed = reviews.every((r) => r.approved === true && r.target_correct !== false);
        if (!passed) {
          const why = reviews.filter((r) => r.approved !== true || r.target_correct === false)
            .map((r) => [r.repair_instructions, ...(r.notes || [])].filter(Boolean).join(' ')).join(' | ');
          feedbacks[i] = `Independent review rejected it: ${why}`.slice(0, 1500);
          for (const r of reviews) if (r.lesson) await recordLesson(memory, 'mistake', r.lesson);
          if (!reviews.some((r) => r.lesson)) await recordLesson(memory, 'mistake', `For "${task.slice(0, 80)}": ${why}`);
          return null;
        }
        return { next: applied.sources, review: reviews, diff, discussion: chat.slice(-30), summary: String(answer.summary || 'CHE update').slice(0, 1800), engineer: member.name };
      }));

      const winner = attempts.find((attempt) => attempt && !attempt.no_change);
      if (winner) {
        result = winner;
        summary = `${winner.summary} (built by ${winner.engineer}, approved by ${CREW.reviewers.map((r) => r.name).join(' and ')})`;
        break;
      }

      const noChangeClaims = attempts.filter((attempt) => attempt?.no_change);
      if (noChangeClaims.length === roundEngineers.length) {
        const noChangeReviews = await Promise.all(CREW.reviewers.map((reviewer) =>
          reviewNoChange(env, task, architecture, noChangeClaims, lessons, reviewer, chat)
            .catch(() => ({ approved: false, notes: ['Reviewer unavailable.'] }))));
        noChangeReviews.forEach((review, k) => chat.push({
          from: CREW.reviewers[k].name,
          msg: `On no-change conclusion: ${review.approved === true ? 'APPROVE' : 'REJECT'} ${[...(review.notes || []), review.repair_instructions].filter(Boolean).join(' ').slice(0, 500)}`,
        }));
        if (noChangeReviews.every((review) => review.approved === true)) {
          const evidence = [...new Set(noChangeClaims.flatMap((claim) => claim.evidence))].slice(0, 12);
          return {
            status: 200,
            already_satisfied: true,
            summary: noChangeClaims.map((claim) => claim.summary).join(' | ').slice(0, 1800),
            evidence,
            review: noChangeReviews,
            discussion: chat.slice(-30),
            team: [...CREW.planners, ...CREW.engineers, ...CREW.reviewers].map((m) => m.name),
            approval_required: false,
            next: 'No PR is needed because both engineers and both independent reviewers verified that no useful code delta is justified.',
          };
        }
        const rejection = noChangeReviews
          .flatMap((review) => [...(review.notes || []), review.repair_instructions])
          .filter(Boolean).join(' | ').slice(0, 1200);
        feedbacks[0] = `No-change review rejected: ${rejection || 'insufficient evidence'}`;
        feedbacks[1] = feedbacks[0];
      }

      feedback = [...new Set(feedbacks.filter(Boolean))].join(' || ');
      if (round >= maxRounds - 1) break;

      // Failed pass: ask a different architect to re-locate the real source,
      // then fetch newly suggested files before the next provider pair runs.
      const recoveryMember = CREW.planners[(round + 1) % CREW.planners.length];
      const recovery = await recoveryPlan(
        env, task, architecture, feedback, index, lessons, recoveryMember, chat,
      ).catch(() => null);

      if (recovery) {
        const recoveryTerms = [
          ...(Array.isArray(recovery.search_terms) ? recovery.search_terms.map(String) : []),
          ...literalTerms(task),
        ].filter((item) => item.trim().length > 2);
        for (const term of recoveryTerms) if (!terms.includes(term)) terms.push(term);

        const recoveryPaths = Array.isArray(recovery.paths)
          ? recovery.paths.map(String).filter((path) => index.paths.includes(path))
          : [];
        architecture.plan = [architecture.plan, `Recovery ${round + 1}: ${String(recovery.plan || '')}`].filter(Boolean).join('\n');
        architecture.search_terms = [...new Set([...(architecture.search_terms || []), ...recoveryTerms])];
        architecture.paths = [...new Set([...(architecture.paths || []), ...recoveryPaths])];
        chat.push({
          from: recoveryMember.name,
          msg: `Recovery locate: ${String(recovery.plan || '').slice(0, 500)} Paths: ${recoveryPaths.join(', ') || 'search again'}`,
        });

        const moreHits = await searchCode(env, recoveryTerms, fetcher);
        for (const [path, count] of moreHits.entries()) hits.set(path, (hits.get(path) || 0) + count);
        const reranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
        const candidates = [...new Set([...recoveryPaths, ...reranked, ...(architecture.paths || [])])]
          .filter((path) => index.paths.includes(path))
          .slice(0, 8);

        const recoveryReads = await Promise.all(candidates.map(async (path) => ({
          path,
          full: await readFull(env, index.base, path, fetcher),
        })));
        for (const { path, full } of recoveryReads) {
          if (full !== null) sources.set(path, full);
        }
        refreshViews();
      }
    }

    if (!result) {
      if (/does not exist exactly|more than once/.test(feedback)) await recordLesson(memory, 'mistake', 'Edit "find" text must be copied exactly from the source without line-number prefixes and include enough lines to be unique.');
      const blocker = [...new Set(feedbacks.filter(Boolean))].join(' | ');
      return {
        status: 422,
        detail: `The coding team exhausted ${maxRounds} implementation passes and re-inspected the source but could not produce a safe reviewed change. ${blocker || 'No safe diff passed review.'}`.slice(0, 800),
      };
    }

    const files = [...result.next.entries()]
      .filter(([path, content]) => sources.get(path) !== content)
      .map(([path, content]) => ({ path, content }));
    const checked = validateUpdateFiles(files);
    if (checked.error) return { status: 422, detail: checked.error };
    await recordLesson(memory, 'location', `"${task.slice(0, 90)}" was done by editing ${files.map((f) => f.path).join(', ')}.`);

    return {
      status: 200,
      proposal: { summary, files: checked.files, expected_base_sha: index.head_sha || '' },
      review: result.review,
      diff: result.diff,
      discussion: result.discussion,
      team: [...CREW.planners, ...CREW.engineers, ...CREW.reviewers].map((m) => m.name),
      approval_required: true,
      next: 'Present the che-update proposal to the owner. Do not write or merge anything until owner approval.',
    };
  } catch (error) {
    return { status: 502, detail: String(error?.message || error).slice(0, 1000) };
  }
}
