// Lists the Material icons compiled into a release build (owner, 2026-10-22: patched screens showed "?" boxes).
// A Flutter release keeps only the icon glyphs reachable from lib/main.dart, so this walks the import, export and part
// graph from lib/main.dart at the given commit and collects Icons.<name> from those files only. A file nothing imports
// (dead code) contributes nothing, so an icon used only there is never treated as shipped.
// A whole imported file still counts here even where the tree shaker drops some of its classes, so the list is narrowed
// to the glyphs a real build of the same commit compiled (tool/compiled_icons.py on a web release build, which uses the
// same icon tree shaking). An icon must be in both lists.
// Usage: node tool/release_icons.mjs <ipa-commit> <compiled-names.txt> > test/fixtures/release_icons.txt
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const commit = process.argv[2];
const compiledFile = process.argv[3];
if (!commit || !compiledFile) {
  console.error('usage: node tool/release_icons.mjs <commit> <compiled-names.txt>');
  process.exit(2);
}
const show = (file) => {
  try { return execFileSync('git', ['show', `${commit}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { return null; }
};
const seen = new Set();
const icons = new Set();
const queue = ['lib/main.dart'];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = show(file);
  if (source == null) continue;
  for (const m of source.matchAll(/\bIcons\.([a-z0-9_]+)\b/g)) icons.add(m[1]);
  for (const m of source.matchAll(/^\s*(?:import|export|part)\s+'([^']+)'/gm)) {
    const uri = m[1];
    if (uri.startsWith('package:chey/')) queue.push(`lib/${uri.slice('package:chey/'.length)}`);
    else if (!uri.includes(':')) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), uri)));
  }
}
const compiled = new Set(readFileSync(compiledFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
process.stdout.write([...icons].filter((i) => compiled.has(i)).sort().join('\n') + '\n');
