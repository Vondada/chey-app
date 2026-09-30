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

async function readSources(env, base, paths, fetcher) {
  const out = [];
  let total = 0;
  for (const path of [...new Set(paths)].slice(0, 6)) {
    if (!/^lib\/[A-Za-z0-9_\/]+\.dart$/.test(path)) continue;
    const found = await gh(env, 'GET', `/contents/${path}?ref=${encodeURIComponent(base)}`, null, fetcher);
    if (!found.ok || !found.data?.content) {
      out.push({ path, missing: true, content: '' });
      continue;
    }
    let source = '';
    try { source = decodeBase64Utf8(found.data.content); } catch (_) {}
    if (!source) continue;
    const clipped = source.slice(0, 30000);
    total += clipped.length;
    if (total > 110000) break;
    out.push({ path, missing: false, content: clipped });
  }
  return out;
}

function proposalFrom(text) {
  const value = jsonObject(text);
  if (!value || !Array.isArray(value.files)) return null;
  return {
    summary: String(value.summary || 'CHE update').trim().slice(0, 1800),
    files: value.files.map((file) => ({
      path: String(file?.path || '').trim(),
      content: typeof file?.content === 'string' ? file.content : '',
    })),
  };
}

function isUiTask(request) {
  return /\b(ui|ux|screen|page|layout|button|card|navigation|nav|color|theme|font|spacing|menu|panel|interface|visual|design|redesign)\b/i.test(request);
}

async function reviewProposal(env, request, architecture, proposal, uiTask) {
  const text = await runAgent(
    env,
    uiTask ? 'CHE UI/UX + Code Review Agent' : 'CHE Code Review + QA Agent',
    [
      'Independently proofread the proposal for Dart syntax problems, missing imports, regressions, incorrect assumptions and failure to meet the request.',
      uiTask
        ? 'Also verify navigation clarity, readable hierarchy, responsive layout, VoiceOver semantics, voice-first operation, and that large text does not destroy the layout.'
        : 'Also verify maintainability and whether existing behavior is preserved.',
      'Return ONLY JSON: {"approved":true|false,"notes":["..."],"repair_instructions":"..."}.',
      'Do not rewrite the patch yourself.',
    ].join('\n'),
    { request, architecture, proposal },
    1800,
  );
  return jsonObject(text) || { approved: false, notes: ['Review agent returned invalid JSON.'], repair_instructions: 'Re-check the full patch.' };
}

export async function prepareSelfUpdate(env, request, fetcher = fetch) {
  if (!repoOf(env)) {
    return { status: 503, detail: 'Self-development needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the server.' };
  }
  const task = String(request || '').trim().slice(0, 6000);
  if (!task) return { status: 400, detail: 'Describe the requested app change.' };

  try {
    const index = await sourceIndex(env, fetcher);
    if (index.error || !index.paths?.length) {
      return { status: 502, detail: index.error || 'CHE could not inspect its Flutter source.' };
    }
    const uiTask = isUiTask(task);

    const architectRole = uiTask ? 'CHE UI/UX Architect' : 'CHE Software Architect';
    const architectText = await runAgent(
      env,
      architectRole,
      [
        'Inspect the available Flutter/Dart file index and choose the smallest existing source set required.',
        uiTask
          ? 'Treat direct owner UI commands as real app-change requests. Plan the requested screen/layout/navigation/style change while preserving voice-first accessibility.'
          : 'Plan the requested code change with the smallest safe scope.',
        'Prefer a focused helper/widget file over bloating lib/main.dart when possible.',
        'Return ONLY JSON: {"plan":"...","paths":["lib/a.dart"],"new_files":["lib/new.dart"]}.',
        'At most 6 existing files and 3 new Dart files under lib/.',
      ].join('\n'),
      { request: task, dart_files: index.paths },
      1500,
    );
    const architecture = jsonObject(architectText) || {};
    const chosen = Array.isArray(architecture.paths)
      ? architecture.paths.map(String).filter((path) => index.paths.includes(path)).slice(0, 6)
      : [];
    const inspected = await readSources(env, index.base, chosen, fetcher);

    const implementerText = await runAgent(
      env,
      uiTask ? 'CHE Flutter UI Engineer' : 'CHE Flutter Implementation Agent',
      [
        'Implement the change. CHE itself is not the coder; you own the patch.',
        'Use the actual inspected source and architect plan. Preserve unrelated behavior.',
        uiTask
          ? 'For UI work, make every interactive control VoiceOver-labeled, usable by voice, and robust at large iOS text sizes. Never require sight-only instructions.'
          : 'Keep behavior testable and scoped.',
        'Return ONLY strict JSON: {"summary":"1-3 sentences","files":[{"path":"lib/x.dart","content":"COMPLETE FILE CONTENT"}]}.',
        'Every changed file must be COMPLETE. Never return a diff, omitted section, placeholder, or "rest unchanged".',
        'Only Dart files under lib/. Maximum 10 files.',
      ].join('\n'),
      { request: task, architecture, inspected_files: inspected },
      7800,
    );

    let proposal = proposalFrom(implementerText);
    let checked = proposal ? validateUpdateFiles(proposal.files) : { error: 'Implementation agent returned invalid patch JSON.' };
    if (!proposal || checked.error) {
      return { status: 422, detail: checked.error || 'Implementation agent did not return a usable patch.' };
    }
    proposal.files = checked.files;

    let review = await reviewProposal(env, task, architecture, proposal, uiTask);
    if (review.approved !== true) {
      const repairText = await runAgent(
        env,
        uiTask ? 'CHE Flutter UI Repair Agent' : 'CHE Flutter Repair Agent',
        [
          'Repair the implementation using the independent review notes.',
          uiTask
            ? 'Keep the requested visual/navigation change and fix accessibility/layout regressions.'
            : 'Fix every concrete review issue without expanding scope unnecessarily.',
          'Return ONLY strict JSON: {"summary":"...","files":[{"path":"lib/x.dart","content":"COMPLETE FILE CONTENT"}]}.',
          'Only complete Dart files under lib/.',
        ].join('\n'),
        { request: task, architecture, proposal, review },
        7800,
      );
      const repaired = proposalFrom(repairText);
      checked = repaired ? validateUpdateFiles(repaired.files) : { error: 'Repair agent returned invalid patch JSON.' };
      if (!repaired || checked.error) {
        return { status: 422, detail: checked.error || 'Repair agent could not produce a valid patch.' };
      }
      repaired.files = checked.files;
      proposal = repaired;
      review = await reviewProposal(env, task, architecture, proposal, uiTask);
      if (review.approved !== true) {
        return {
          status: 422,
          detail: 'The coding team did not pass independent review, so CHE did not offer the update for installation.',
          review,
        };
      }
    }

    return {
      status: 200,
      proposal,
      review,
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
