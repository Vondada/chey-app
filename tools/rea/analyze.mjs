#!/usr/bin/env node
// Helper for .github/workflows/che-rea-analysis.yml. Each subcommand does one
// check or one reduction, and fails closed. The reduction reuses the Worker's
// reducer (server/cloudflare/rea_evidence.js), so the runner and CHE agree on
// one summary format.
//
//   validate                         check the job inputs from the environment
//   check-archive <tgz> <integrity>  verify the tarball's sha512, then its entries
//   reduce [--flags]                 REA Evidence -> bounded summary JSON

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { reduceEvidence, NPM_INTEGRITY, REA_JOB_ID } from '../../server/cloudflare/rea_evidence.js';

const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const TARGET = /^npm:((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function validate() {
  const jobId = process.env.JOB_ID || '';
  const target = process.env.TARGET || '';
  const integrity = process.env.EXPECTED_INTEGRITY || '';
  if (!REA_JOB_ID.test(jobId)) fail('Invalid REA job id.');
  const found = target.match(TARGET);
  if (!found) fail('Target must be a public npm package at one exact version, for example npm:semver@7.7.2.');
  if (!NPM_INTEGRITY.test(integrity)) fail('The expected sha512 integrity is missing or malformed.');
  // GITHUB_ENV lines, read by the later steps of the same job.
  console.log(`PKG_NAME=${found[1]}`);
  console.log(`PKG_VERSION=${found[2]}`);
}

function checkArchive(file, expected) {
  if (!existsSync(file)) fail('The npm tarball was not downloaded.');
  const bytes = readFileSync(file);
  if (bytes.length > MAX_TARBALL_BYTES) fail(`The tarball is larger than ${MAX_TARBALL_BYTES} bytes.`);
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== expected) fail('The downloaded tarball does not match the registry checksum. Nothing was analyzed.');
  const listing = spawnSync('tar', ['-tvzf', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (listing.status !== 0) fail('The tarball could not be listed.');
  const lines = listing.stdout.split('\n').filter(Boolean);
  if (lines.length > MAX_ENTRIES) fail(`The tarball has more than ${MAX_ENTRIES} entries.`);
  let unpacked = 0;
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    const type = fields[0]?.[0];
    const size = Number(fields[2]);
    const entry = fields.slice(5).join(' ');
    if (type !== '-' && type !== 'd') fail(`The tarball has a ${type === 'l' ? 'symbolic link' : 'non-file entry'}: ${entry.slice(0, 120)}`);
    if (entry.startsWith('/') || entry.split('/').includes('..')) fail('The tarball has a path that leaves its folder.');
    if (Number.isFinite(size)) unpacked += size;
  }
  if (unpacked > MAX_UNPACKED_BYTES) fail(`The package unpacks to more than ${MAX_UNPACKED_BYTES} bytes.`);
  console.log(`archive ok: ${lines.length} entries, ${unpacked} bytes unpacked`);
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1] ?? '';
  return out;
}

function reduce(argv) {
  const f = flags(argv);
  const evidenceText = f.evidence && existsSync(f.evidence) ? readFileSync(f.evidence, 'utf8') : '';
  const stderr = f.stderr && existsSync(f.stderr) ? readFileSync(f.stderr, 'utf8') : '';
  const summary = f.reason
    ? { ...reduceEvidence('', { jobId: f.job, name: f.name, version: f.version, integrity: f.integrity, exitCode: 1, stderr }), error: f.reason }
    : reduceEvidence(evidenceText, { jobId: f.job, name: f.name, version: f.version, integrity: f.integrity, exitCode: Number(f.exit || 0), stderr });
  const text = JSON.stringify(summary, null, 1);
  if (text.length > 65536) fail('The summary is larger than 64 KB.');
  writeFileSync(f.out, `${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `REA ${summary.state}: ${summary.target.name}@${summary.target.version}\n`);
  console.log(`summary ${summary.state}: ${summary.target.name}@${summary.target.version} (${text.length} bytes)`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'validate') validate();
else if (command === 'check-archive') checkArchive(rest[0], rest[1]);
else if (command === 'reduce') reduce(rest);
else fail(`Unknown command: ${command || '(none)'}`);
