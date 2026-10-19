#!/usr/bin/env node
// CHE coding benchmark driver. Owner-approved, runs only from the workflow_dispatch job
// `.github/workflows/che-coding-benchmark.yml`. Each task runs in a fixture repo under the
// runner's temp directory, never in this checkout. The steps are the owner-request runtime's
// own run blocks, extracted from `che-opencode-runtime.yml`, so the benchmark runs the same
// code. Nothing is pushed, no pull request is opened or merged, and no branch is touched.
// Provider requests pass a counting proxy; the cap (default 60) refuses the 61st.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { TASKS, BENCHMARK_CALL_CAP, gradeTask, parseNameStatus, finalTextFromEvents } from './che_coding_benchmark_tasks.mjs';
import { createCallProxy, PROVIDER_UPSTREAMS, PROXY_PORT } from './che_coding_benchmark_proxy.mjs';

// Stands in for every provider key inside OpenCode and the steps. The real keys are given only
// to the call proxy, which injects them, so nothing the agent can read holds a working key.
const PLACEHOLDER = 'benchmark-placeholder-not-a-key';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_WORKFLOW = join(ROOT, '.github/workflows/che-opencode-runtime.yml');
// The runtime job writes its scratch files under RUNNER_TEMP, so each task's files live in that
// task's own runner_temp directory. Nothing is shared between tasks.
const RUNTIME_FILES = [
  'che-runtime-prompt.txt', 'che-opencode-config.json', 'che-runtime-result.json', 'che-runtime.patch',
  'opencode-events.jsonl', 'opencode-stderr.log', 'opencode-failure.txt', 'checkpoint-verdict.json', 'checkpoint-restore.json',
];
const runtimeFile = (dir, name) => join(dir, name);
const KEY_SHAPE = /(AIza|sk-|gsk_|csk-|hf_|sk-or-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g;
const KEY_NAMES = ['K_GOOGLE', 'K_OPENROUTER', 'K_GROQ', 'K_MISTRAL', 'K_CEREBRAS', 'K_OPENAI', 'K_ANTHROPIC'];

export function redact(text) {
  return String(text || '').replace(KEY_SHAPE, '[key]');
}

// The run block of a named step in the runtime workflow, with its 10-space indent removed.
export function extractStep(workflowText, name) {
  const header = workflowText.split('\n').findIndex((line) => line.trim() === `- name: ${name}`);
  if (header < 0) throw new Error(`runtime step not found: ${name}`);
  const lines = workflowText.split('\n');
  let run = -1;
  for (let i = header + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('- name:')) break;
    if (lines[i].trim() === 'run: |') { run = i; break; }
  }
  if (run < 0) throw new Error(`runtime step has no run block: ${name}`);
  const out = [];
  for (let i = run + 1; i < lines.length; i += 1) {
    if (lines[i].trim() && !lines[i].startsWith('          ')) break;
    out.push(lines[i].slice(10));
  }
  return `${out.join('\n')}\n`;
}

export function parseKeyValues(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

export function resolveCap(raw) {
  if (raw === undefined || raw === '') return BENCHMARK_CALL_CAP;
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 0 || cap > BENCHMARK_CALL_CAP) throw new Error(`BENCH_CALL_CAP must be 0 to ${BENCHMARK_CALL_CAP}`);
  return cap;
}

// Local runs only: point providers at a fake upstream. Refused inside GitHub Actions.
export function upstreamsFor(env) {
  if (env.GITHUB_ACTIONS === 'true' || !env.BENCH_UPSTREAM_OVERRIDE) return PROVIDER_UPSTREAMS;
  return { ...PROVIDER_UPSTREAMS, ...JSON.parse(env.BENCH_UPSTREAM_OVERRIDE) };
}

function git(cwd, args) {
  const res = spawnSync('git', ['-c', 'user.name=che-bench', '-c', 'user.email=che-bench@users.noreply.github.com', ...args], { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args[0]} failed`);
  return res.stdout;
}

function createFixture(repo, spec) {
  mkdirSync(repo, { recursive: true });
  for (const [path, content] of Object.entries({ ...spec.files, ...spec.tests })) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', `benchmark fixture: ${spec.id}`]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

// Network settings pass through when a runner sets them (a proxy, or no_proxy). OpenCode's
// startup fetch stalls without them where a proxy is required. GitHub-hosted runners set none.
function networkEnv() {
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  return Object.fromEntries(names.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
}

async function runStep(name, { cwd, env, outDir }) {
  const script = extractStep(readFileSync(RUNTIME_WORKFLOW, 'utf8'), name);
  mkdirSync(outDir, { recursive: true });
  const slug = name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  const scriptPath = join(outDir, `${slug}.sh`);
  writeFileSync(scriptPath, script, { mode: 0o700 });
  const files = { GITHUB_OUTPUT: join(outDir, `${slug}.output`), GITHUB_ENV: join(outDir, `${slug}.env`), GITHUB_STEP_SUMMARY: join(outDir, `${slug}.summary`) };
  for (const file of Object.values(files)) writeFileSync(file, '');
  // Asynchronous on purpose: the call proxy runs in this process, so a synchronous spawn would
  // stop the proxy answering OpenCode while a step runs. The steps then stall until their timeout.
  return new Promise((resolve) => {
    const child = spawn('bash', [scriptPath], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME || '/root', LANG: 'C.UTF-8', ...networkEnv(), ...env, ...files },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const limit = setTimeout(() => child.kill('SIGKILL'), 45 * 60_000);
    child.on('close', (code) => {
      clearTimeout(limit);
      resolve({
        status: code ?? 1,
        stdout: redact(stdout).slice(-1500),
        stderr: redact(stderr).slice(-1500),
        outputs: parseKeyValues(readFileSync(files.GITHUB_OUTPUT, 'utf8')),
        envs: parseKeyValues(readFileSync(files.GITHUB_ENV, 'utf8')),
      });
    });
  });
}

function providerConfig(proxyBase) {
  return {
    openrouter: { options: { baseURL: `${proxyBase}/openrouter/api/v1` } },
    groq: { options: { baseURL: `${proxyBase}/groq/openai/v1` } },
    google: { options: { baseURL: `${proxyBase}/google/v1beta` } },
  };
}

function runPristineTests(repo, files) {
  if (!files.length) return null;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ['--test', ...files], { cwd: repo, encoding: 'utf8', timeout: 120_000, env });
  return res.status === 0;
}

function summarize(rows, proxy, cap) {
  const graded = rows.filter((row) => row.status === 'graded');
  const notRun = rows.filter((row) => row.status !== 'graded').map((row) => row.id);
  return {
    cap,
    model_calls_used: proxy.state.count,
    model_calls_refused: proxy.state.refused,
    model_calls_by_provider: proxy.state.byProvider,
    passed: graded.filter((row) => row.pass).length,
    graded: graded.length,
    total_tasks: TASKS.length,
    not_run: notRun,
    rows,
  };
}

function markdown(summary) {
  const lines = [
    '## CHE coding benchmark (fixture copies)',
    '',
    `Model calls: ${summary.model_calls_used} of ${summary.cap} cap (refused after cap: ${summary.model_calls_refused}). Passed: ${summary.passed} of ${summary.graded} graded; not run: ${summary.not_run.length ? summary.not_run.join(', ') : 'none'}.`,
    '',
    '| Task | Result | Files touched | Attempts | Model calls | Seconds | Failure class | Provider failures |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const row of summary.rows) {
    if (row.status !== 'graded') {
      lines.push(`| ${row.id} | not run | - | - | - | - | - | ${row.reason} |`);
      continue;
    }
    lines.push(`| ${row.id} | ${row.pass ? 'pass' : 'fail'} | ${row.changed.join(', ') || 'none'} | ${row.attempts} | ${row.model_calls} | ${row.seconds} | ${row.failure_class} | ${row.provider_failures || '-'} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const cap = resolveCap(process.env.BENCH_CALL_CAP);
  const work = join(process.env.RUNNER_TEMP || tmpdir(), 'che-bench');
  const results = join(work, 'results');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(results, { recursive: true });
  const real = Object.fromEntries(KEY_NAMES.map((name) => [name, process.env[name] || '']));
  const has = (name) => (real[name] ? 'true' : 'false');
  const commonEnv = Object.fromEntries(KEY_NAMES.map((name) => [name, real[name] ? PLACEHOLDER : '']));
  const credentials = { groq: real.K_GROQ, openrouter: real.K_OPENROUTER, google: real.K_GOOGLE };
  const proxy = createCallProxy({ cap, upstreams: upstreamsFor(process.env), credentials });
  const proxyBase = await proxy.listen(PROXY_PORT);

  const trust = await runStep('Stage trusted coding tools', { cwd: ROOT, env: {}, outDir: join(work, 'stage') });
  if (trust.status !== 0 || !trust.envs.CHE_TRUSTED_TOOLS) throw new Error(`could not stage trusted tools: ${trust.stderr}`);
  const trusted = trust.envs.CHE_TRUSTED_TOOLS;

  const rows = [];
  let stopReason = null;
  const persist = () => {
    const summary = summarize(rows, proxy, cap);
    writeFileSync(join(results, 'summary.json'), JSON.stringify(summary, null, 2));
    writeFileSync(join(results, 'summary.md'), markdown(summary));
  };
  for (const spec of TASKS) {
    const row = { id: spec.id, kind: spec.kind, status: 'pending' };
    rows.push(row);
    if (proxy.state.count >= cap) {
      Object.assign(row, { status: 'not_run', reason: 'cap reached before this task' });
      continue;
    }
    const taskDir = join(work, spec.id);
    const outDir = join(taskDir, 'steps');
    const repo = join(taskDir, 'repo');
    const runnerTemp = join(taskDir, 'runner_temp');
    mkdirSync(runnerTemp, { recursive: true });
    for (const file of RUNTIME_FILES) rmSync(join(runnerTemp, file), { force: true });
    const base = createFixture(repo, spec);
    const jobId = `ocr-${randomBytes(4).toString('hex')}`;
    const common = { RUNNER_TEMP: runnerTemp, CHE_TRUSTED_TOOLS: trusted, BASE_SHA: base };
    const callsBefore = proxy.state.count;
    const refusedBefore = proxy.state.refused;
    const started = Date.now();
    try {
      const decode = await runStep('Decode and guard task', {
        cwd: repo,
        env: {
          REQUEST_B64: Buffer.from(spec.request, 'utf8').toString('base64'),
          JOB_ID: jobId,
          BASE_SHA: base,
          TARGET_BRANCH: `bench/${spec.id}`,
          MODEL: 'auto',
          ...common,
        },
        outDir,
      });
      if (decode.status !== 0) throw new Error(`decode failed: ${(decode.stderr + decode.stdout).trim().slice(-300)}`);
      const configPath = runtimeFile(runnerTemp, 'che-opencode-config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.provider = providerConfig(proxyBase);
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      const optionsEnv = { OPENCODE_CONFIG: configPath };
      const resolved = await runStep('Resolve model', {
        cwd: repo,
        env: {
          ...optionsEnv,
          REQUESTED: 'auto',
          CHE_CODING_PAID_FALLBACK: 'false',
          CHE_CODING_FREE_PROVIDERS: process.env.CHE_CODING_FREE_PROVIDERS || '',
          HAS_GOOGLE: has('K_GOOGLE'),
          HAS_OPENROUTER: has('K_OPENROUTER'),
          HAS_GROQ: has('K_GROQ'),
          HAS_OPENAI: has('K_OPENAI'),
          HAS_ANTHROPIC: has('K_ANTHROPIC'),
          HAS_MISTRAL: has('K_MISTRAL'),
          HAS_CEREBRAS: has('K_CEREBRAS'),
          K_PAID_OPENROUTER: '',
          ...commonEnv,
          ...common,
        },
        outDir,
      });
      if (resolved.status !== 0) throw new Error(`no eligible model: ${(resolved.stderr + resolved.stdout).trim().slice(-300)}`);
      const run = await runStep('Run OpenCode in the isolated checkout', {
        cwd: repo,
        env: {
          ...optionsEnv,
          FREE_CANDIDATES: resolved.outputs.free_candidates || '',
          PAID_CANDIDATES: '',
          CHE_CODING_PAID_FALLBACK: 'false',
          ...commonEnv,
          ...common,
        },
        outDir,
      });
      const built = await runStep('Build compact result and patch', {
        cwd: repo,
        env: {
          EXIT_CODE: run.outputs.exit_code || '1',
          OPENCODE_OUTCOME: run.status === 0 ? 'success' : 'failure',
          PREFLIGHT_FAILURE: '',
          JOB_ID: jobId,
          BASE_SHA: base,
          TARGET_BRANCH: `bench/${spec.id}`,
          MODEL: run.outputs.model || 'auto',
          TRIED: run.outputs.tried || '',
          OPENCODE_ERROR: run.outputs.error || '',
          FAILURE_KIND: run.outputs.failure_kind || '',
          RESUMABLE: run.outputs.resumable || 'false',
          RESUME_COUNT: '0',
          RUN_ID: process.env.GITHUB_RUN_ID || '0',
          ...common,
        },
        outDir,
      });
      if (built.status !== 0) throw new Error(`result step failed: ${(built.stderr + built.stdout).trim().slice(-300)}`);
      const resultPath = runtimeFile(runnerTemp, 'che-runtime-result.json');
      const record = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : {};
      // Guard: a run that made attempts but reached no counted request means the calls bypassed
      // the proxy. The cap could not be enforced, so no further task runs.
      if (proxy.state.count === callsBefore && Array.isArray(record.attempts) && record.attempts.length > 0) {
        stopReason = 'model requests did not pass the call proxy; the cap cannot be enforced, so the run stopped';
        throw new Error(stopReason);
      }
      const eventsPath = runtimeFile(runnerTemp, 'opencode-events.jsonl');
      const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '';
      writeFileSync(join(results, `${spec.id}.record.json`), JSON.stringify(record, null, 2));
      const { changed, added } = parseNameStatus(git(repo, ['diff', '--name-status', '--no-renames', base]));
      const addedTests = added.filter((path) => /^test\/[^/]+\.test\.mjs$/.test(path));
      let testsOk = null;
      if (spec.mode === 'tests' && spec.restoreTests) {
        for (const [path, content] of Object.entries(spec.tests)) writeFileSync(join(repo, path), content);
        testsOk = runPristineTests(repo, spec.testFiles);
      } else if (spec.mode === 'add_test') {
        testsOk = addedTests.length ? runPristineTests(repo, addedTests) : false;
      }
      const newTestSource = addedTests.map((path) => readFileSync(join(repo, path), 'utf8')).join('\n');
      const verdict = gradeTask(spec, { changed, added, testsOk, finalText: finalTextFromEvents(events), newTestSource });
      const attempts = Array.isArray(record.attempts) ? record.attempts : [];
      const refused = proxy.state.refused - refusedBefore;
      Object.assign(row, {
        status: 'graded',
        pass: verdict.pass,
        failure_class: verdict.failureClass,
        reasons: verdict.reasons,
        changed,
        attempts: attempts.length,
        provider_failures: attempts.filter((a) => a.kind && a.kind !== 'success').map((a) => `${a.model.split('/').slice(-1)[0]}:${a.kind}`).join(' > '),
        model_calls: proxy.state.count - callsBefore,
        seconds: Math.round((Date.now() - started) / 1000),
        record_state: record.state || null,
        opencode_exit: run.outputs.exit_code || null,
      });
      writeFileSync(join(results, `${spec.id}.reply.txt`), finalTextFromEvents(events).slice(0, 4000));
      if (refused > 0) break;
    } catch (error) {
      Object.assign(row, { status: 'error', reason: redact(String(error?.message || error)).slice(0, 300), model_calls: proxy.state.count - callsBefore, seconds: Math.round((Date.now() - started) / 1000) });
    } finally {
      for (const file of RUNTIME_FILES) rmSync(join(runnerTemp, file), { force: true });
      persist();
    }
    if (stopReason) break;
  }
  for (const spec of TASKS) {
    if (!rows.some((row) => row.id === spec.id)) rows.push({ id: spec.id, kind: spec.kind, status: 'not_run', reason: stopReason || 'stopped at the call cap' });
  }
  for (const row of rows) if (row.status === 'pending') Object.assign(row, { status: 'not_run', reason: stopReason || 'stopped at the call cap' });
  rows.sort((a, b) => TASKS.findIndex((t) => t.id === a.id) - TASKS.findIndex((t) => t.id === b.id));
  const summary = summarize(rows, proxy, cap);
  writeFileSync(join(results, 'summary.json'), JSON.stringify(summary, null, 2));
  const md = markdown(summary);
  writeFileSync(join(results, 'summary.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  console.log(JSON.stringify({ cap, model_calls_used: summary.model_calls_used, refused: summary.model_calls_refused, passed: summary.passed, graded: summary.graded, not_run: summary.not_run }));
  await proxy.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`::error::benchmark stopped: ${redact(String(error?.message || error)).slice(0, 400)}`);
    process.exitCode = 1;
  });
}
