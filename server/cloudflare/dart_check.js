// Pre-flight static checks for CHE's crew: catch the analyze-class mistakes
// (unbalanced delimiters, leftover placeholders, unused imports, undefined
// obvious refs) BEFORE a change is ever proposed — not after a failed build.
// This is not a full Dart analyzer, but it blocks the errors that actually
// break builds most often.

// Strip strings and comments so brace/paren counting isn't fooled by them.
function stripStringsAndComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"') {
      const triple = src.slice(i, i + 3) === c + c + c;
      const q = triple ? c + c + c : c;
      i += q.length;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src.slice(i, i + q.length) === q) { i += q.length; break; }
        i++;
      }
      out += '""';
      continue;
    }
    out += c; i++;
  }
  return out;
}

function balanced(code, path) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const stack = [];
  for (const ch of code) {
    if (opens.has(ch)) stack.push(ch);
    else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) return `${path}: mismatched '${ch}'.`;
    }
  }
  if (stack.length) return `${path}: ${stack.length} unclosed '${stack[stack.length - 1]}' — check braces/parentheses.`;
  return null;
}

// Imported symbols that are never referenced → Dart 'unused_import' warning,
// which fails `flutter analyze`. Checks local part-imports only (package/dart
// imports are too dynamic to judge safely).
function unusedLocalImports(src, stripped, path) {
  const importRe = /import\s+'([^']+)'(?:\s+as\s+(\w+))?(?:\s+show\s+([^;]+))?;/g;
  let m;
  while ((m = importRe.exec(src))) {
    const uri = m[1];
    const alias = m[2];
    const shown = m[3];
    if (alias) {
      const used = new RegExp(`\\b${alias}\\.`).test(stripped);
      if (!used) return `${path}: import '${uri}' as ${alias} is unused (would fail analyze).`;
    } else if (shown) {
      for (const name of shown.split(',').map((s) => s.trim()).filter(Boolean)) {
        const bare = name.replace(/\s+as\s+\w+/, '').trim();
        if (bare && !new RegExp(`\\b${bare.replace(/[^\\w]/g, '')}\\b`).test(stripped.replace(m[0], ''))) {
          return `${path}: import '${uri}' shows ${bare}, which is unused.`;
        }
      }
    }
  }
  return null;
}

export function dartStaticCheck(path, content) {
  const src = String(content || '');
  if (!src.trim()) return `${path}: empty file.`;
  // Leftover model placeholders that mean the patch is incomplete.
  const placeholder = /(\.\.\.\s*rest\s+unchanged|\/\/\s*(?:TODO|FIXME|\.\.\.|rest of|unchanged|your code here)|<placeholder>|INSERT[_ ]HERE)/i;
  if (placeholder.test(src)) return `${path}: contains a placeholder / "rest unchanged" — the file must be complete.`;
  const stripped = stripStringsAndComments(src);
  return balanced(stripped, path) || unusedLocalImports(src, stripped, path) || null;
}

export function checkDartFiles(files) {
  for (const f of files) {
    if (!/\.dart$/.test(f.path)) continue;
    const err = dartStaticCheck(f.path, f.content);
    if (err) return err;
  }
  return null;
}
