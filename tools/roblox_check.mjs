// Structural check of a Rojo project (roblox/<game>): the project file parses, every $path exists, every .model.json
// and .meta.json parses, and every .luau file has balanced blocks (function/if/do/repeat ... end/until) once comments
// and strings are skipped. It is not a compiler: .github/workflows/che-roblox-build.yml also compiles every script with
// luau-compile and builds the .rbxlx with Rojo. Usage: node tools/roblox_check.mjs roblox/che-blade-arena
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Problems in one Luau source (empty when its blocks balance). */
export function luauBlockProblems(source) {
  const s = String(source); const problems = []; const stack = [];
  let i = 0; let line = 1;
  const longClose = (at) => { const m = /^\[(=*)\[/.exec(s.slice(at)); return m ? { open: m[0].length, close: `]${m[1]}]` } : null; };
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { line++; i++; continue; }
    if (s.startsWith('--', i)) {
      const long = longClose(i + 2);
      const end = long ? s.indexOf(long.close, i + 2 + long.open) : s.indexOf('\n', i);
      const stop = end < 0 ? s.length : long ? end + long.close.length : end;
      line += (s.slice(i, stop).match(/\n/g) || []).length; i = stop; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      if (s[j] !== c) problems.push(`line ${line}: unterminated string`);
      i = j + 1; continue;
    }
    if (c === '[') {
      const long = longClose(i);
      if (long) {
        const end = s.indexOf(long.close, i + long.open);
        if (end < 0) { problems.push(`line ${line}: unterminated long string`); break; }
        line += (s.slice(i, end).match(/\n/g) || []).length; i = end + long.close.length; continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))[0];
      const prev = s[i - 1];
      if (prev !== '.' && prev !== ':') {
        if (['function', 'if', 'do', 'repeat'].includes(word)) stack.push({ word, line });
        else if (word === 'end') { const top = stack.pop(); if (!top || top.word === 'repeat') problems.push(`line ${line}: 'end' without an open block`); }
        else if (word === 'until') { const top = stack.pop(); if (top?.word !== 'repeat') problems.push(`line ${line}: 'until' without 'repeat'`); }
      }
      i += word.length; continue;
    }
    i++;
  }
  for (const open of stack) problems.push(`line ${open.line}: '${open.word}' is never closed`);
  return problems;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/** { ok, files, scripts, problems } for the Rojo project in [root]. */
export function checkRojoProject(root) {
  const problems = []; let project = null;
  try { project = JSON.parse(readFileSync(join(root, 'default.project.json'), 'utf8')); } catch (e) { return { ok: false, files: 0, scripts: 0, problems: [`default.project.json: ${e.message}`] }; }
  const paths = [];
  const visit = (node) => { if (node && typeof node === 'object') { if (node.$path) paths.push(node.$path); for (const [k, v] of Object.entries(node)) if (!k.startsWith('$')) visit(v); } };
  visit(project.tree);
  let files = 0; let scripts = 0;
  for (const rel of paths) {
    const at = join(root, rel);
    if (!existsSync(at)) { problems.push(`$path ${rel} does not exist`); continue; }
    for (const f of statSync(at).isDirectory() ? walk(at) : [at]) {
      files++;
      if (/\.json$/.test(f)) { try { JSON.parse(readFileSync(f, 'utf8')); } catch (e) { problems.push(`${f}: ${e.message}`); } }
      if (/\.luau?$/.test(f)) { scripts++; for (const p of luauBlockProblems(readFileSync(f, 'utf8'))) problems.push(`${f} ${p}`); }
    }
  }
  if (!scripts) problems.push('no Luau scripts in the project');
  return { ok: problems.length === 0, files, scripts, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = checkRojoProject(process.argv[2] || 'roblox/che-blade-arena');
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
