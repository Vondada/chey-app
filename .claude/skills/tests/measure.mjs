#!/usr/bin/env node
// Reproducible "with vs without" context measurements for the skills: bytes
// an agent would have to read or receive to answer the same question by hand,
// against the skill's script output. Tokens are estimated as bytes / 4 and
// labelled as an estimate; the A/B agent runs in the skill notes are the real
// token counts.
//   node .claude/skills/tests/measure.mjs [--no-network] [--no-suite]
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skills = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(skills, '../..');
const flag = (f) => process.argv.includes(f);
const size = (rel) => statSync(join(repo, rel)).size;
const run = (args, opts = {}) => spawnSync(process.execPath, ['--no-warnings', ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
const rows = [];
const row = (skill, question, without, withSkill, note = '') => rows.push({ skill, question, without, with: withSkill, note });

// Always-loaded vs on-demand: only name + description sit in context up front.
for (const dir of ['che-debug', 'che-fact-check', 'che-release', 'che-youtube']) {
  const text = readFileSync(join(skills, dir, 'SKILL.md'), 'utf8');
  const meta = /^---\n([\s\S]*?)\n---/.exec(text)[1];
  row(dir, 'instructions in context before the skill is needed', text.length, meta.length, 'body loads only on use');
}

// che-fact-check: read the guard code yourself vs run it.
const claim = run([join(skills, 'che-fact-check/scripts/claim_check.mjs'), '--reply',
  'You confirmed last week that your favorite drink is Sprite, and you personally tested the new garage door code on Tuesday. I searched three websites and they all agree the code format is secure.',
  '--owner', 'my favorite drink is Sprite']);
row('che-fact-check', 'what does the owner see for this draft reply?',
  size('server/cloudflare/memory_provenance.js') + size('server/cloudflare/truth_layer.js'), claim.stdout.length, 'guard source vs claim_check output');

// che-youtube: read the uploader and pipeline limits yourself vs validate.
const pkg = run([join(skills, 'che-youtube/scripts/check_package.mjs'), join(skills, 'tests/fixtures/bad_package.json')]);
row('che-youtube', 'is this package ready to render/publish?',
  ['youtube_upload.js', 'video_line.js', 'faceless_video.js'].reduce((n, f) => n + size(`server/cloudflare/${f}`), 0), pkg.stdout.length, 'pipeline source vs check_package output');

// che-debug: the full Worker suite's raw output vs the summary.
if (!flag('--no-suite')) {
  const raw = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...readdirTests()], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
  const sum = spawnSync(process.execPath, [join(skills, 'che-debug/scripts/summarize_tap.mjs')], { input: raw.stdout, encoding: 'utf8' });
  row('che-debug', 'did the Worker suite pass?', raw.stdout.length, sum.stdout.length, 'raw TAP vs run_checks summary');
}

// che-release: the raw GitHub API JSON behind one answer vs the status script.
if (!flag('--no-network')) {
  const env = { ...process.env, NODE_USE_ENV_PROXY: process.env.HTTPS_PROXY ? '1' : (process.env.NODE_USE_ENV_PROXY || '') };
  const status = run([join(skills, 'che-release/scripts/release_status.mjs'), '--pr', '300'], { env });
  const api = 'https://api.github.com/repos/Vondada/chey-app';
  const probe = run(['--input-type=module', '-e', `
    const urls = ${JSON.stringify([`${api}/pulls/300`, `${api}/commits/main`, `${api}/releases?per_page=30`])};
    let total = 0;
    for (const u of urls) total += (await (await fetch(u, { headers: { Accept: 'application/vnd.github+json' } })).text()).length;
    const pr = await (await fetch(urls[0])).json();
    for (const u of [\`${api}/commits/\${pr.head.sha}/check-runs?per_page=100\`, \`${api}/actions/runs?head_sha=\${pr.merge_commit_sha}&per_page=50\`]) total += (await (await fetch(u)).text()).length;
    console.log(total);`], { env });
  const rawBytes = Number(probe.stdout.trim()) || 0;
  row('che-release', 'is PR #300 merged and live?', rawBytes, status.stdout.length, rawBytes ? 'five raw API responses vs release_status' : 'raw API not reachable');
}

function readdirTests() {
  return spawnSync('bash', ['-c', 'ls server/cloudflare/*.test.mjs'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
}

const fmt = (n) => n.toLocaleString('en-US');
console.log('| Skill | Question | Without (bytes ≈ tokens) | With (bytes ≈ tokens) | Note |');
console.log('|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.skill} | ${r.question} | ${fmt(r.without)} ≈ ${fmt(Math.round(r.without / 4))} | ${fmt(r.with)} ≈ ${fmt(Math.round(r.with / 4))} | ${r.note} |`);
console.log('\nTokens ≈ bytes/4 (estimate, not a tokenizer).');
